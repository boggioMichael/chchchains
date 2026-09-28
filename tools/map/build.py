#!/usr/bin/env python3
"""Builds the Ch-ch-chains city maps from OpenStreetMap and SRTM elevation.

Runs in GitHub Actions (.github/workflows/maps.yml), which has the network access and the osmium tool:

    python tools/map/build.py              # all cities
    python tools/map/build.py haifa        # one city

For every city it writes docs/maps/<id>.json (vector layers in metres around the city centre, y pointing south)
and docs/maps/<id>.jpg (the terrain: elevation tint and hill shading), plus docs/maps/index.json.

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).
Elevation: SRTM (NASA), from the AWS Terrain Tiles open dataset.
"""
import gzip
import json
import math
import os
import subprocess
import sys
import urllib.request

import numpy as np
from PIL import Image
from scipy import ndimage
from skimage import measure

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'docs', 'maps')
WORK = os.path.join(ROOT, '.mapwork')

# Each city is a circle of radius R metres (the arena) around its centre; MARGIN more is drawn beyond the edge.
CITIES = [
    dict(id='tel-aviv', he='תל אביב', lat=32.0705, lon=34.7800, R=3200),
    dict(id='jerusalem', he='ירושלים', lat=31.7800, lon=35.2150, R=3200),
    dict(id='haifa', he='חיפה', lat=32.8050, lon=34.9900, R=3200),
]
MARGIN = 300
GRID = 10  # metres per elevation grid cell
PBF_URL = 'https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf'
HGT_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi/{ns}{alat:02d}/{ns}{alat:02d}{ew}{alon:03d}.hgt.gz'
ATTRIBUTION = '© OpenStreetMap contributors (ODbL) · גבהים: SRTM / NASA'

ROAD_CLASS = {
    'motorway': 0, 'trunk': 0, 'primary': 0, 'motorway_link': 0, 'trunk_link': 0, 'primary_link': 0,
    'secondary': 1, 'tertiary': 1, 'secondary_link': 1, 'tertiary_link': 1,
    'residential': 2, 'unclassified': 2, 'living_street': 2, 'pedestrian': 2, 'road': 2,
}
GREEN = {('leisure', 'park'), ('leisure', 'garden'), ('leisure', 'nature_reserve'), ('landuse', 'grass'),
         ('landuse', 'recreation_ground'), ('landuse', 'forest'), ('landuse', 'meadow'), ('landuse', 'village_green'),
         ('natural', 'wood'), ('natural', 'scrub'), ('landuse', 'cemetery')}
PLACE_RANK = {'suburb': 0, 'quarter': 1, 'neighbourhood': 2}
SKIP_PLACES = {'מזרח ירושלים', 'מערב ירושלים'}  # whole regions, not neighbourhoods
HEBREW = range(0x0590, 0x0600)


def log(*a):
    print(*a, flush=True)


# ----------------------------------------------------------------------------------------------- projection
class Projection:
    """Local flat projection in metres around (lat0, lon0); x east, y south."""

    def __init__(self, lat0, lon0):
        phi = math.radians(lat0)
        self.lat0, self.lon0 = lat0, lon0
        self.ky = 111132.954 - 559.822 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
        self.kx = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)

    def xy(self, lon, lat):
        return (lon - self.lon0) * self.kx, -(lat - self.lat0) * self.ky

    def lonlat(self, x, y):
        return self.lon0 + x / self.kx, self.lat0 - y / self.ky


# ----------------------------------------------------------------------------------------------- geometry
def simplify(pts, tol):
    """Douglas–Peucker on a list of (x, y)."""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / L2
                t = 0 if t < 0 else 1 if t > 1 else t
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > best:
                best, bi = d2, i
        if best > t2:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def clip_line(pts, E):
    """Clips a polyline to the square [-E, E]²; returns a list of polylines (Liang–Barsky per segment)."""
    out, cur = [], []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        dx, dy = x1 - x0, y1 - y0
        t0, t1, ok = 0.0, 1.0, True
        for p, q in ((-dx, x0 + E), (dx, E - x0), (-dy, y0 + E), (dy, E - y0)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
            else:
                r = q / p
                if p < 0:
                    t0 = max(t0, r)
                else:
                    t1 = min(t1, r)
        if not ok or t0 > t1:
            if len(cur) > 1:
                out.append(cur)
            cur = []
            continue
        a = (x0 + t0 * dx, y0 + t0 * dy)
        b = (x0 + t1 * dx, y0 + t1 * dy)
        if not cur or cur[-1] != a:
            if len(cur) > 1:
                out.append(cur)
            cur = [a]
        cur.append(b)
        if t1 < 1:
            if len(cur) > 1:
                out.append(cur)
            cur = []
    if len(cur) > 1:
        out.append(cur)
    return out


def clip_ring(pts, E):
    """Sutherland–Hodgman clip of a closed ring to the square [-E, E]²."""
    def clip(poly, inside, cross):
        res = []
        for i in range(len(poly)):
            cur, prev = poly[i], poly[i - 1]
            if inside(cur):
                if not inside(prev):
                    res.append(cross(prev, cur))
                res.append(cur)
            elif inside(prev):
                res.append(cross(prev, cur))
        return res

    def xcut(xe):
        return lambda p, c: (xe, p[1] + (c[1] - p[1]) * (xe - p[0]) / (c[0] - p[0]))

    def ycut(ye):
        return lambda p, c: (p[0] + (c[0] - p[0]) * (ye - p[1]) / (c[1] - p[1]), ye)

    poly = list(pts)
    for inside, cross in (
        (lambda p: p[0] >= -E, xcut(-E)),
        (lambda p: p[0] <= E, xcut(E)),
        (lambda p: p[1] >= -E, ycut(-E)),
        (lambda p: p[1] <= E, ycut(E)),
    ):
        if not poly:
            break
        poly = clip(poly, inside, cross)
    return poly


def ring_area(pts):
    a = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


def flat(pts):
    out = []
    for x, y in pts:
        out.append(int(round(x)))
        out.append(int(round(y)))
    return out


def length(pts):
    return sum(math.hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(pts, pts[1:]))


def hebrew(text):
    return isinstance(text, str) and any(ord(ch) in HEBREW for ch in text)


# ----------------------------------------------------------------------------------------------- inputs
def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    log('download', url)
    tmp = path + '.part'
    req = urllib.request.Request(url, headers={'User-Agent': 'chchchains-map-build (github.com/boggioMichael/chchchains)'})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, path)
    return path


def osm_features(city, proj):
    """Extracts the city's OSM features with osmium and yields GeoJSON features (dicts)."""
    pbf = download(PBF_URL, os.path.join(WORK, 'israel.osm.pbf'))
    E = city['R'] + MARGIN + 200
    lon0, lat0 = proj.lonlat(-E, E)
    lon1, lat1 = proj.lonlat(E, -E)
    base = os.path.join(WORK, city['id'])
    run(['osmium', 'extract', '-O', '-b', f'{lon0},{lat0},{lon1},{lat1}', pbf, '-o', base + '.osm.pbf'])
    run([
        'osmium', 'tags-filter', '-O', base + '.osm.pbf',
        'w/highway', 'w/railway', 'w/waterway', 'w/natural=coastline', 'nwr/natural=water,beach,wood,scrub', 'nwr/water',
        'nwr/leisure=park,garden,nature_reserve', 'nwr/landuse=grass,recreation_ground,forest,meadow,village_green,cemetery',
        'n/place=suburb,quarter,neighbourhood',
        '-o', base + '.filtered.osm.pbf',
    ])
    run(['osmium', 'export', '-O', '-f', 'geojsonseq', '-x', 'print_record_separator=false',
         base + '.filtered.osm.pbf', '-o', base + '.geojsonseq'])
    with open(base + '.geojsonseq', encoding='utf-8') as f:
        for line in f:
            line = line.strip().lstrip('\x1e')
            if line:
                yield json.loads(line)


def run(cmd):
    log('$', ' '.join(cmd))
    subprocess.run(cmd, check=True)


def elevation_grid(city, proj):
    """SRTM elevation resampled to a GRID-metre grid over [-E, E]² (row 0 = north). Returns (grid, E)."""
    E = city['R'] + MARGIN
    n = int(round(2 * E / GRID)) + 1
    xs = -E + np.arange(n) * GRID
    ys = -E + np.arange(n) * GRID
    X, Y = np.meshgrid(xs, ys)
    lon, lat = proj.lonlat(X, Y)
    out = np.zeros_like(X)
    tiles = {(int(math.floor(a)), int(math.floor(b))) for a in (lat.min(), lat.max()) for b in (lon.min(), lon.max())}
    for alat, alon in tiles:
        tile = hgt_tile(alat, alon)
        inside = (lat >= alat) & (lat < alat + 1) & (lon >= alon) & (lon < alon + 1)
        if not inside.any():
            continue
        size = tile.shape[0]
        r = (alat + 1 - lat[inside]) * (size - 1)
        c = (lon[inside] - alon) * (size - 1)
        out[inside] = ndimage.map_coordinates(tile, [r, c], order=1, mode='nearest')
    return out, E


def hgt_tile(alat, alon):
    ns = 'N' if alat >= 0 else 'S'
    ew = 'E' if alon >= 0 else 'W'
    url = HGT_URL.format(ns=ns, alat=abs(alat), ew=ew, alon=abs(alon))
    path = download(url, os.path.join(WORK, os.path.basename(url)))
    raw = gzip.decompress(open(path, 'rb').read())
    size = int(round(math.sqrt(len(raw) // 2)))
    tile = np.frombuffer(raw, dtype='>i2').reshape(size, size).astype(np.float32)
    void = tile < -1000
    if void.any():  # fill voids from the nearest valid cell
        idx = ndimage.distance_transform_edt(void, return_distances=False, return_indices=True)
        tile = tile[tuple(idx)]
    return tile


# ----------------------------------------------------------------------------------------------- city
def sea_from_coastline(coast, E, cell):
    """Sea mask on a `cell`-metre grid over [-E, E]² from OSM coastline lines (land on their left, water on their
    right): the lines become a wall, and the regions on their water side are the sea."""
    n = int(round(2 * E / cell)) + 1
    wall = np.zeros((n, n), bool)
    probes = []
    for pts in coast:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            steps = max(1, int(math.hypot(x1 - x0, y1 - y0) / (cell * 0.5)))
            for k in range(steps + 1):
                t = k / steps
                c = int(round((x0 + (x1 - x0) * t + E) / cell))
                r = int(round((y0 + (y1 - y0) * t + E) / cell))
                if 0 <= r < n and 0 <= c < n:
                    wall[r, c] = True
            L = math.hypot(x1 - x0, y1 - y0)
            if L > 0:  # points just to the right (water) and left (land); y points south, so right is (-dy, dx)
                mx, my = (x0 + x1) / 2, (y0 + y1) / 2
                ox, oy = -(y1 - y0) / L * cell * 2.5, (x1 - x0) / L * cell * 2.5
                probes.append((mx + ox, my + oy, 1))
                probes.append((mx - ox, my - oy, -1))
    wall = ndimage.binary_dilation(wall)
    regions, count = ndimage.label(~wall)
    votes = np.zeros(count + 1)
    for x, y, v in probes:
        c = int(round((x + E) / cell))
        r = int(round((y + E) / cell))
        if 0 <= r < n and 0 <= c < n:
            votes[regions[r, c]] += v
    sea = np.isin(regions, np.nonzero(votes > 0)[0]) & (regions > 0)
    return ndimage.binary_closing(sea | (wall & ndimage.binary_dilation(sea)), iterations=1)


def build_city(city, features, elev):
    proj = Projection(city['lat'], city['lon'])
    R = city['R']
    grid, E = elev
    n = grid.shape[0]
    to_world = lambda r, c: (-E + c * GRID, -E + r * GRID)  # noqa: E731  (grid row/col → metres)
    features = list(features)

    # Sea: from the OSM coastline when the city has one (SRTM is coarse over the water), as smooth polygons drawn
    # with the even-odd rule; the land mask for contours and the terrain image follows it.
    coast = []
    for f in features:
        if (f.get('properties') or {}).get('natural') == 'coastline':
            g = f.get('geometry') or {}
            lines = [g['coordinates']] if g.get('type') == 'LineString' else g.get('coordinates', []) if g.get('type') == 'MultiLineString' else []
            coast += [[proj.xy(lon, lat) for lon, lat in line] for line in lines]
    FINE = 5
    sea_rings = []
    if coast:
        fine = sea_from_coastline(coast, E, FINE)
        soft = ndimage.gaussian_filter(fine.astype(np.float32), 0.8)
        for cnt in measure.find_contours(np.pad(soft, 1, constant_values=0), 0.5):
            pts = simplify([(-E + (c - 1) * FINE, -E + (r - 1) * FINE) for r, c in cnt], 1.5)
            if len(pts) >= 4 and ring_area(pts) > 3000:
                sea_rings.append(flat(pts))
        sea = ndimage.zoom(fine.astype(np.float32), (n / fine.shape[0], n / fine.shape[1]), order=1)[:n, :n] > 0.5
    else:
        sea = np.zeros_like(grid, dtype=bool)
    sea_fraction = float(sea.mean())
    land = ~sea

    # Contours on land, every `step` metres (a "nice" step for the city's relief), from a smoothed surface
    # (SRTM measures roofs and treetops too, so fine detail is noise).
    rr, cc = np.mgrid[0:n, 0:n]
    rough = grid[land] if land.any() else grid.ravel()
    flat_city = float(np.percentile(rough, 99) - np.percentile(rough, 1)) < 120
    smooth = ndimage.gaussian_filter(grid, 4.0 if flat_city else 2.2)  # flat cities: roofs dominate the noise
    in_arena = np.hypot(-E + cc * GRID, -E + rr * GRID) <= R
    vals = smooth[land & in_arena]
    lo, hi = (float(np.percentile(vals, 1)), float(np.percentile(vals, 99))) if vals.size else (0.0, 1.0)
    relief = max(1.0, hi - lo)
    step = next(s for s in (5, 10, 20, 25, 50, 100, 200) if relief / s <= 24)
    contours = []
    for h in np.arange(math.ceil(max(lo, 1) / step) * step, hi + step, step):
        for cnt in measure.find_contours(smooth, float(h), mask=land):
            pts = simplify([to_world(r, c) for r, c in cnt], 3.0)
            closed = len(pts) > 2 and math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < GRID * 2
            if length(pts) >= (320 if closed else 150):  # drop the little rings SRTM noise makes
                contours.append([int(round(h)), flat(pts)])

    # Terrain image: a gentle elevation tint with hill shading (light from the north-west); the sea is painted
    # again by the vector layer on top.
    exaggerate = min(4.0, max(1.5, 300 / relief))  # flat cities need more to show their hills
    gs, ge = np.gradient(smooth * exaggerate, GRID)  # rise per metre southward (rows) and eastward (columns)
    az, alt = math.radians(315), math.radians(42)
    lx, ly, lz = math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)
    nx, ny = -ge, gs  # surface normal (east, north, up) = (-dz/de, -dz/dn, 1) and dz/dn = -dz/ds
    shade = np.clip((nx * lx + ny * ly + lz) / np.sqrt(nx * nx + ny * ny + 1), 0, 1)
    t = np.clip((smooth - lo) / relief, 0, 1)[..., None]
    low_c = np.array([246, 242, 233], np.float32)
    high_c = np.array([231, 221, 201], np.float32)
    rgb = low_c * (1 - t) + high_c * t
    rgb *= (0.8 + 0.2 * shade / max(float(shade.max()), 1e-6))[..., None]
    seac = np.array([201, 223, 233], np.float32)
    rgb = np.where(sea[..., None], seac, rgb)
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).resize((1024, 1024), Image.BICUBIC)
    img.save(os.path.join(OUT, city['id'] + '.jpg'), quality=82, optimize=True, progressive=True)

    # Vector features.
    roads = [[], [], []]
    names = []  # (rank, name, polyline)
    rail, rivers = [], []
    water, green, beach, places = [], [], [], []
    EXT = R + MARGIN

    def lines_of(geom):
        if geom['type'] == 'LineString':
            yield geom['coordinates']
        elif geom['type'] == 'MultiLineString':
            yield from geom['coordinates']

    def polys_of(geom):
        if geom['type'] == 'Polygon':
            yield geom['coordinates']
        elif geom['type'] == 'MultiPolygon':
            yield from geom['coordinates']

    def project(coords):
        return [proj.xy(lon, lat) for lon, lat in coords]

    def add_polygon(target, geom, min_area):
        for rings in polys_of(geom):
            out = []
            for k, ring in enumerate(rings):
                pts = clip_ring(simplify(project(ring), 2.0), EXT)
                if len(pts) < 3:
                    continue
                if k == 0 and ring_area(pts) < min_area:
                    break
                out.append(flat(pts))
            if out:
                target.append(out)

    for f in features:
        tags = f.get('properties') or {}
        geom = f.get('geometry') or {}
        gtype = geom.get('type')
        if gtype == 'Point':
            if tags.get('place') in PLACE_RANK:
                name = tags.get('name:he') or tags.get('name')
                if hebrew(name) and name not in SKIP_PLACES:
                    x, y = proj.xy(*geom['coordinates'])
                    if math.hypot(x, y) <= R + 150:
                        places.append([int(round(x)), int(round(y)), PLACE_RANK[tags['place']], name])
            continue
        hw = tags.get('highway')
        if hw in ROAD_CLASS and gtype in ('LineString', 'MultiLineString') and tags.get('area') != 'yes':
            if tags.get('tunnel') in ('yes', 'building_passage') or tags.get('access') == 'private':
                continue
            cls = ROAD_CLASS[hw]
            for line in lines_of(geom):
                for part in clip_line(project(line), EXT):
                    pts = simplify(part, 1.5 if cls < 2 else 2.0)
                    if len(pts) >= 2:
                        roads[cls].append(flat(pts))
                        name = tags.get('name:he') or tags.get('name')
                        if hebrew(name):
                            names.append((cls, name, pts))
            continue
        rw = tags.get('railway')
        if rw in ('rail', 'light_rail', 'tram') and gtype in ('LineString', 'MultiLineString'):
            if tags.get('tunnel') == 'yes' or tags.get('service') in ('yard', 'siding', 'spur'):
                continue
            for line in lines_of(geom):
                for part in clip_line(project(line), EXT):
                    pts = simplify(part, 2.0)
                    if len(pts) >= 2:
                        rail.append(flat(pts))
            continue
        if tags.get('waterway') in ('river', 'stream', 'canal') and gtype in ('LineString', 'MultiLineString'):
            if tags.get('tunnel') == 'culvert' or tags.get('tunnel') == 'yes':
                continue
            for line in lines_of(geom):
                for part in clip_line(project(line), EXT):
                    pts = simplify(part, 2.0)
                    if len(pts) >= 2:
                        rivers.append([1 if tags['waterway'] == 'river' else 0, flat(pts)])
            continue
        if gtype not in ('Polygon', 'MultiPolygon'):
            continue
        if tags.get('natural') == 'water' or tags.get('water') or tags.get('waterway') == 'riverbank':
            if tags.get('water') in ('swimming_pool', 'wastewater') or tags.get('leisure') == 'swimming_pool':
                continue
            add_polygon(water, geom, 1500)
        elif tags.get('natural') == 'beach':
            add_polygon(beach, geom, 1500)
        elif any((k, tags.get(k)) in GREEN for k in ('leisure', 'landuse', 'natural')):
            add_polygon(green, geom, 2500)

    labels = place_road_labels(names)
    places.sort(key=lambda p: p[2])
    places = thin_points(places, [900, 650, 450])

    data = {
        'v': 1,
        'id': city['id'],
        'he': city['he'],
        'center': [city['lat'], city['lon']],
        'R': R,
        'extent': E,
        'terrain': city['id'] + '.jpg',
        'attribution': ATTRIBUTION,
        'elevation': [round(lo), round(hi)],
        'sea': sea_rings,
        'water': water,
        'green': green,
        'beach': beach,
        'rivers': rivers,
        'roads': roads,
        'rail': rail,
        'contours': {'step': step, 'lines': contours},
        'labels': labels,
        'places': places,
    }
    path = os.path.join(OUT, city['id'] + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    stats = {
        'id': city['id'],
        'kb': round(os.path.getsize(path) / 1024),
        'sea': round(sea_fraction, 3),
        'relief': [round(lo), round(hi), step],
        'roads': [len(r) for r in roads],
        'points': sum(len(p) // 2 for r in roads for p in r),
        'contours': len(contours),
        'labels': len(labels),
        'places': len(places),
        'green': len(green),
        'water': len(water),
    }
    log('city', json.dumps(stats, ensure_ascii=False))
    return stats


def merge_lines(lines):
    """Joins polylines that share an end point (OSM splits a street into many short ways)."""
    lines = [list(l) for l in lines]
    key = lambda p: (round(p[0]), round(p[1]))  # noqa: E731
    merged = True
    while merged and len(lines) > 1:
        merged = False
        ends = {}
        for i, l in enumerate(lines):
            ends.setdefault(key(l[0]), []).append((i, 0))
            ends.setdefault(key(l[-1]), []).append((i, 1))
        for i, l in enumerate(lines):
            if l is None:
                continue
            for side in (1, 0):
                for j, jside in ends.get(key(l[-1] if side else l[0]), []):
                    if j == i or lines[j] is None:
                        continue
                    other = lines[j] if jside == 0 else lines[j][::-1]
                    lines[i] = (l + other[1:]) if side else (other[::-1] + l[1:])
                    lines[j] = None
                    merged = True
                    break
                if merged:
                    break
            if merged:
                break
        lines = [l for l in lines if l is not None]
    return lines


def place_road_labels(names):
    """Label candidates every ~350 m along named roads; keeps the best ones apart. [x, y, angle×10, rank, text]."""
    groups = {}
    for cls, name, pts in names:
        groups.setdefault((cls, name), []).append(pts)
    chains = [(cls, name, pts) for (cls, name), parts in groups.items() for pts in merge_lines(parts)]
    cands = []
    for cls, name, pts in chains:
        total = length(pts)
        if total < (120 if cls < 2 else 260):
            continue
        k = 0
        run_len = 0.0
        target = min(total / 2, 175.0)
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            while seg > 0 and run_len + seg >= target:
                t = (target - run_len) / seg
                x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
                ang = math.degrees(math.atan2(y1 - y0, x1 - x0))
                if ang > 90:
                    ang -= 180
                elif ang < -90:
                    ang += 180
                cands.append((cls, -total, k, x, y, ang, name))
                k += 1
                target += 350.0
            run_len += seg
    cands.sort()
    chosen, by_name = [], {}
    for cls, _neg, _k, x, y, ang, name in cands:
        if math.hypot(x, y) > 3300:
            continue
        near = False
        for cx, cy, *_ in chosen:
            if (cx - x) ** 2 + (cy - y) ** 2 < 170 ** 2:
                near = True
                break
        if near:
            continue
        if any((ox - x) ** 2 + (oy - y) ** 2 < 800 ** 2 for ox, oy in by_name.get(name, [])):
            continue
        chosen.append((x, y, ang, cls, name))
        by_name.setdefault(name, []).append((x, y))
    return [[int(round(x)), int(round(y)), int(round(ang * 10)), cls, name] for x, y, ang, cls, name in chosen]


def thin_points(points, spacing):
    kept = []
    for p in points:
        if all((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 >= spacing[min(p[2], q[2])] ** 2 for q in kept):
            kept.append(p)
    return kept


def main(argv):
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    wanted = set(argv[1:])
    results = []
    for city in CITIES:
        if wanted and city['id'] not in wanted:
            continue
        proj = Projection(city['lat'], city['lon'])
        elev = elevation_grid(city, proj)
        results.append(build_city(city, osm_features(city, proj), elev))
    index = {
        'v': 1,
        'attribution': ATTRIBUTION,
        'cities': [{'id': c['id'], 'he': c['he'], 'R': c['R'], 'center': [c['lat'], c['lon']]} for c in CITIES],
    }
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    log('done', json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)

#!/usr/bin/env python3
"""Builds the Ch-ch-chain-ges maps, one per local authority, from OpenStreetMap and SRTM elevation.

Runs in GitHub Actions (.github/workflows/maps.yml), which has the network access and the osmium tool:

    python tools/map/build.py              # every authority in AUTHORITIES
    python tools/map/build.py haifa        # one

Each map is the authority's own municipal boundary (from OSM), cut to at most R_MAX metres around the town centre,
so the city limits are the edge of the arena. It writes docs/maps/<id>.json (vector layers in metres around the
centre, y pointing south, plus the arena outline and a mask for "inside?"), docs/maps/<id>.jpg (the terrain: elevation
tint and hill shading), and docs/maps/index.json (the list, with each map's area and how many people it holds).

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).
Elevation: SRTM (NASA), from the AWS Terrain Tiles open dataset.
"""
import gzip
import json
import math
import os
import subprocess
import sys
import urllib.error
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage import measure

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'docs', 'maps')
WORK = os.path.join(ROOT, '.mapwork')

# Local authorities (Israel's cities and larger towns), roughly by population: id, the Hebrew name as in OSM, and
# other spellings to try. Where OSM has no boundary, the arena is a circle of R_CIRCLE around the town's centre.
AUTHORITIES = [
    ('jerusalem', 'ירושלים', []),
    ('tel-aviv', 'תל אביב-יפו', ['תל אביב יפו', 'תל־אביב–יפו', 'תל אביב–יפו', 'תל אביב']),
    ('haifa', 'חיפה', []),
    ('rishon-lezion', 'ראשון לציון', []),
    ('petah-tikva', 'פתח תקווה', ['פתח תקוה']),
    ('ashdod', 'אשדוד', []),
    ('netanya', 'נתניה', []),
    ('beer-sheva', 'באר שבע', []),
    ('bnei-brak', 'בני ברק', []),
    ('holon', 'חולון', []),
    ('ramat-gan', 'רמת גן', []),
    ('rehovot', 'רחובות', []),
    ('ashkelon', 'אשקלון', []),
    ('bat-yam', 'בת ים', []),
    ('beit-shemesh', 'בית שמש', []),
    ('kfar-saba', 'כפר סבא', []),
    ('herzliya', 'הרצליה', []),
    ('hadera', 'חדרה', []),
    ('modiin', 'מודיעין-מכבים-רעות', ['מודיעין מכבים רעות', 'מודיעין–מכבים–רעות', 'מודיעין']),
    ('nazareth', 'נצרת', []),
    ('lod', 'לוד', []),
    ('ramla', 'רמלה', []),
    ('raanana', 'רעננה', []),
    ('rosh-haayin', 'ראש העין', []),
    ('modiin-illit', 'מודיעין עילית', []),
    ('rahat', 'רהט', []),
    ('hod-hasharon', 'הוד השרון', []),
    ('beitar-illit', 'ביתר עילית', []),
    ('givatayim', 'גבעתיים', []),
    ('kiryat-ata', 'קריית אתא', ['קרית אתא']),
    ('nahariya', 'נהריה', []),
    ('kiryat-gat', 'קריית גת', ['קרית גת']),
    ('umm-al-fahm', 'אום אל-פחם', ['אום אל פחם', 'אום אל־פחם']),
    ('eilat', 'אילת', []),
    ('afula', 'עפולה', []),
    ('yavne', 'יבנה', []),
    ('akko', 'עכו', []),
    ('karmiel', 'כרמיאל', []),
    ('nes-ziona', 'נס ציונה', []),
    ('tiberias', 'טבריה', []),
    ('maale-adumim', 'מעלה אדומים', []),
    ('or-yehuda', 'אור יהודה', []),
    ('kiryat-motzkin', 'קריית מוצקין', ['קרית מוצקין']),
    ('kiryat-bialik', 'קריית ביאליק', ['קרית ביאליק']),
    ('kiryat-yam', 'קריית ים', ['קרית ים']),
    ('safed', 'צפת', []),
    ('dimona', 'דימונה', []),
    ('netivot', 'נתיבות', []),
    ('tayibe', 'טייבה', []),
    ('shfaram', 'שפרעם', []),
    ('ofakim', 'אופקים', []),
    ('sderot', 'שדרות', []),
    ('kiryat-shmona', 'קריית שמונה', ['קרית שמונה']),
    ('ariel', 'אריאל', []),
    ('zichron-yaakov', 'זכרון יעקב', []),
]
R_MAX = 3600  # the arena never reaches further than this from the centre
R_CIRCLE = 2800
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
# Named places the story missions send players to: kind, how many a map keeps (the biggest, then the most central),
# and the test on the OSM tags. The first kind that matches wins.
POI_KINDS = [
    ('hall', 4, lambda t: t.get('amenity') == 'townhall'),
    ('gov', 10, lambda t: bool(t.get('government')) or t.get('office') == 'government'),
    ('square', 16, lambda t: t.get('place') == 'square'),
    ('station', 20, lambda t: t.get('railway') == 'station'),
    ('market', 8, lambda t: t.get('amenity') == 'marketplace'),
    ('uni', 8, lambda t: t.get('amenity') in ('university', 'college')),
    ('stadium', 5, lambda t: t.get('leisure') == 'stadium'),
    ('beach', 10, lambda t: t.get('natural') == 'beach'),
    ('sight', 20, lambda t: t.get('tourism') in ('attraction', 'museum', 'viewpoint', 'zoo')
     or t.get('historic') in ('monument', 'archaeological_site', 'castle', 'city_gate', 'fort', 'ruins')),
    ('park', 20, lambda t: t.get('leisure') in ('park', 'garden', 'nature_reserve')),
]
# Bump to rebuild every map; otherwise a run only builds maps that are missing, older, or lack satellite imagery.
BUILD = 3
UA = 'chchchain-ges-map-build (github.com/boggioMichael/chchchains)'
STAC_URL = 'https://earth-search.aws.element84.com/v1/search'
SAT_GRID = 10  # Sentinel-2 true colour is 10 m per pixel


_T0 = __import__('time').time()


def log(*a):
    """Prints with the time since the start and this process's peak memory (the build log is how CI is read)."""
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    kids = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss // 1024
    print(f'[{__import__("time").time() - _T0:7.1f}s {peak}/{kids}MB]', *a, flush=True)


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
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, path)
    return path


def read_seq(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip().lstrip('\x1e')
            if line:
                yield json.loads(line)


def admin_index(pbf):
    """Administrative boundaries (GeoJSON polygons, lon/lat) and town centres, keyed by every name they carry."""
    base = os.path.join(WORK, 'admin')
    run(['osmium', 'tags-filter', '-O', pbf, 'r/boundary=administrative', 'n/place=city,town', '-o', base + '.osm.pbf'])
    run(['osmium', 'export', '-O', '-f', 'geojsonseq', '-x', 'print_record_separator=false', base + '.osm.pbf',
         '-o', base + '.geojsonseq'])
    bounds, places = {}, {}
    for f in read_seq(base + '.geojsonseq'):
        tags = f.get('properties') or {}
        g = f.get('geometry') or {}
        names = {tags.get('name:he'), tags.get('name')} - {None}
        if g.get('type') == 'Point' and tags.get('place') in ('city', 'town'):
            for nm in names:
                places.setdefault(nm, []).append((tags['place'], g['coordinates']))
        elif g.get('type') in ('Polygon', 'MultiPolygon') and tags.get('boundary') == 'administrative':
            polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
            for nm in names:
                bounds.setdefault(nm, []).append((tags.get('admin_level'), polys))
    return bounds, places


def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_polys(x, y, polys):
    return any(in_ring(x, y, rings[0]) and not any(in_ring(x, y, h) for h in rings[1:]) for rings in polys)


def polys_area(polys):
    total = 0.0
    for rings in polys:
        r = rings[0]
        total += abs(sum(r[i][0] * r[i - 1][1] - r[i - 1][0] * r[i][1] for i in range(len(r)))) / 2
    return total


def resolve(auth, bounds, places):
    """The authority's centre (its city/town node) and its municipal boundary, or None for either."""
    aid, he, alts = auth
    names = [he] + alts
    center = None
    for nm in names:
        cands = sorted(places.get(nm, []), key=lambda c: 0 if c[0] == 'city' else 1)
        if cands:
            center = cands[0][1]
            break
    best = None
    for nm in names:
        for _level, polys in bounds.get(nm, []):
            if center is not None and not in_polys(center[0], center[1], polys):
                continue
            area = polys_area(polys)
            if best is None or area < best[0]:
                best = (area, polys)
        if best:
            break
    boundary = best[1] if best else None
    if center is None and boundary:
        ring = max((rings[0] for rings in boundary), key=len)
        center = [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]
    if center is None:
        return None
    return dict(id=aid, he=he, lon=center[0], lat=center[1], boundary=boundary)


def extract_all(pbf, cities):
    """Cuts a small extract around every city, one osmium pass each (an extract keeps an index of every object it
    takes, and several at once need more memory than CI has)."""
    for c in cities:
        proj = Projection(c['lat'], c['lon'])
        E = R_MAX + MARGIN + 200
        lon0, lat0 = proj.lonlat(-E, E)
        lon1, lat1 = proj.lonlat(E, -E)
        run(['osmium', 'extract', '-O', '-b', f'{lon0},{lat0},{lon1},{lat1}', '-o', os.path.join(WORK, c['id'] + '.osm.pbf'), pbf])


def osm_features(city):
    """The city's OSM features (from its extract) as GeoJSON features (dicts)."""
    base = os.path.join(WORK, city['id'])
    run([
        'osmium', 'tags-filter', '-O', base + '.osm.pbf',
        'w/highway', 'w/railway', 'w/waterway', 'w/natural=coastline', 'nwr/natural=water,beach,wood,scrub', 'nwr/water',
        'nwr/leisure=park,garden,nature_reserve,stadium', 'nwr/landuse=grass,recreation_ground,forest,meadow,village_green,cemetery',
        'n/place=suburb,quarter,neighbourhood', 'nwr/place=square', 'nwr/railway=station',
        'nwr/amenity=townhall,marketplace,university,college', 'nwr/government', 'nwr/office=government',
        'nwr/tourism=attraction,museum,viewpoint,zoo', 'nwr/historic=monument,archaeological_site,castle,city_gate,fort,ruins',
        '-o', base + '.filtered.osm.pbf',
    ])
    run(['osmium', 'export', '-O', '-f', 'geojsonseq', '-x', 'print_record_separator=false',
         base + '.filtered.osm.pbf', '-o', base + '.geojsonseq'])
    yield from read_seq(base + '.geojsonseq')


def run(cmd):
    log('$', ' '.join(cmd))
    subprocess.run(cmd, check=True)


def elevation_grid(city, proj):
    """SRTM elevation resampled to a GRID-metre grid over [-E, E]² (row 0 = north). Returns (grid, E)."""
    E = R_MAX + MARGIN
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


def ring_centroid(pts):
    """Area-weighted centroid and area of a closed ring of (x, y)."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(a) < 1e-9:
        return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)), 0.0
    return (cx / (3 * a), cy / (3 * a)), abs(a) / 2


def poi_of(feature, proj):
    """(kind, name, x, y, area) for a named place a mission can send players to, or None."""
    tags = feature.get('properties') or {}
    name = tags.get('name:he') or tags.get('name')
    if not hebrew(name):
        return None
    kind = next((k for k, _limit, test in POI_KINDS if test(tags)), None)
    if not kind:
        return None
    geom = feature.get('geometry') or {}
    gtype = geom.get('type')
    if gtype == 'Point':
        (x, y), area = proj.xy(*geom['coordinates']), 0.0
    elif gtype == 'LineString':
        pts = [proj.xy(lon, lat) for lon, lat in geom['coordinates']]
        (x, y), area = pts[len(pts) // 2], 0.0
    elif gtype in ('Polygon', 'MultiPolygon'):
        polys = [geom['coordinates']] if gtype == 'Polygon' else geom['coordinates']
        best = max((ring_centroid([proj.xy(lon, lat) for lon, lat in rings[0]]) for rings in polys), key=lambda c: c[1])
        (x, y), area = best
    else:
        return None
    return kind, name.strip(), x, y, area


def pick_pois(cands):
    """Per kind, the biggest then the most central; one of each name. [[x, y, kind, name], …]"""
    limits = {k: limit for k, limit, _test in POI_KINDS}
    order = {k: i for i, (k, _l, _t) in enumerate(POI_KINDS)}
    cands = sorted(cands, key=lambda c: (order[c[0]], -c[4], math.hypot(c[2], c[3])))
    out, seen, count = [], set(), {}
    for kind, name, x, y, _area in cands:
        if name in seen or count.get(kind, 0) >= limits[kind]:
            continue
        seen.add(name)
        count[kind] = count.get(kind, 0) + 1
        out.append([int(round(x)), int(round(y)), kind, name])
    return out


# ----------------------------------------------------------------------------------------------- satellite
def stac_search(bbox):
    """Sentinel-2 scenes (Earth Search STAC, AWS open data) over bbox [lon0, lat0, lon1, lat1], newest first."""
    body = {'collections': ['sentinel-2-l2a'], 'bbox': bbox, 'datetime': '2024-06-01T00:00:00Z/..', 'limit': 100,
            'query': {'eo:cloud_cover': {'lt': 5}}, 'sortby': [{'field': 'properties.datetime', 'direction': 'desc'}]}
    for attempt in (body, {k: v for k, v in body.items() if k not in ('query', 'sortby')}):
        req = urllib.request.Request(STAC_URL, data=json.dumps(attempt).encode(),
                                     headers={'Content-Type': 'application/json', 'User-Agent': UA})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                items = json.load(r).get('features', [])
            return sorted(items, key=lambda it: (it.get('properties') or {}).get('datetime', ''), reverse=True)
        except urllib.error.HTTPError as e:
            log('stac', e.code, 'retrying without extensions' if attempt is body else '')
    return []


def scene_order(items, corners):
    """The scenes to read, best first: clear ones that cover the whole map (newest first), then the clearest others."""
    def polys_of_item(it):
        g = it.get('geometry') or {}
        return [g['coordinates']] if g.get('type') == 'Polygon' else g.get('coordinates', []) if g.get('type') == 'MultiPolygon' else []

    usable = [it for it in items if ((it.get('assets') or {}).get('visual') or {}).get('href')]
    cloud = lambda it: float((it.get('properties') or {}).get('eo:cloud_cover', 100))  # noqa: E731
    covering = [it for it in usable if cloud(it) < 2 and all(in_polys(lon, lat, polys_of_item(it)) for lon, lat in corners)]
    rest = sorted((it for it in usable if it not in covering), key=cloud)
    return covering[:2] + rest


def resample(bands, rows, cols):
    """Bilinear samples of (3, h, w) bands at fractional (rows, cols); returns (rgb float32 (…, 3), valid mask)."""
    coords = np.array([rows.ravel(), cols.ravel()])
    rgb = np.stack([ndimage.map_coordinates(b.astype(np.float32), coords, order=1, mode='constant', cval=0.0)
                    for b in bands], axis=-1).reshape(rows.shape + (3,))
    have = ndimage.map_coordinates((bands.max(axis=0) > 0).astype(np.float32), coords, order=1, mode='constant', cval=0.0)
    return rgb, have.reshape(rows.shape) > 0.999


def enhance(rgb, valid):
    """A gentle stretch and a little more colour for the (rather flat) true-colour product."""
    v = rgb[valid]
    lo, hi = (float(np.percentile(v, 0.5)), float(np.percentile(v, 99.6))) if v.size else (0.0, 255.0)
    x = np.clip((rgb - lo) / max(1.0, hi - lo), 0, 1) ** 0.88
    grey = x.mean(axis=-1, keepdims=True)
    x = np.clip(grey + (x - grey) * 1.18, 0, 1)
    x[~valid] = (0.953, 0.937, 0.902)  # paper where no scene reaches
    return (x * 255 + 0.5).astype(np.uint8)


def satellite_image(city, proj, E):
    """True-colour Sentinel-2 imagery over [-E, E]², SAT_GRID m per pixel (row 0 = north). Returns (rgb, meta) or None."""
    import rasterio
    from rasterio.warp import transform as warp
    from rasterio.windows import Window

    n = int(round(2 * E / SAT_GRID)) + 1
    xs = -E + np.arange(n) * SAT_GRID
    X, Y = np.meshgrid(xs, xs)
    lon, lat = proj.lonlat(X, Y)
    corners = [proj.lonlat(x, y) for x in (-E, E) for y in (-E, E)] + [proj.lonlat(0, 0)]
    bbox = [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())]
    order = scene_order(stac_search(bbox), corners)
    out = np.zeros((n, n, 3), np.float32)
    have = np.zeros((n, n), bool)
    used = []
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_MAX_RETRY='4',
               GDAL_HTTP_RETRY_DELAY='2', AWS_NO_SIGN_REQUEST='YES')
    with rasterio.Env(**env):
        for item in order[:5]:
            try:
                with rasterio.open(item['assets']['visual']['href']) as src:
                    ux, uy = warp('EPSG:4326', src.crs, lon.ravel().tolist(), lat.ravel().tolist())
                    t = src.transform
                    cols = (np.asarray(ux).reshape(n, n) - t.c) / t.a
                    rows = (np.asarray(uy).reshape(n, n) - t.f) / t.e
                    c0 = max(0, int(math.floor(cols.min())) - 2)
                    r0 = max(0, int(math.floor(rows.min())) - 2)
                    c1 = min(src.width, int(math.ceil(cols.max())) + 3)
                    r1 = min(src.height, int(math.ceil(rows.max())) + 3)
                    if c1 <= c0 or r1 <= r0:
                        continue
                    bands = src.read([1, 2, 3], window=Window(c0, r0, c1 - c0, r1 - r0))
                rgb, ok = resample(bands, rows - r0, cols - c0)
            except Exception as e:  # a scene that will not read: try the next one
                log('satellite: skipped a scene', city['id'], repr(e))
                continue
            fill = ok & ~have
            if fill.any():
                out[fill] = rgb[fill]
                have |= fill
                used.append(item)
            if have.mean() > 0.998:
                break
    if have.mean() < 0.9:
        log('satellite: not enough coverage', city['id'], round(float(have.mean()), 3))
        return None
    dates = sorted({(it.get('properties') or {}).get('datetime', '')[:10] for it in used})
    meta = {'date': dates[-1] if dates else '', 'credit': f"Contains modified Copernicus Sentinel data {dates[-1][:4] if dates else ''}".strip()}
    return enhance(out, have), meta


def arena_of(city, proj, E, n):
    """The playing area on the GRID: the municipal boundary (or a circle), within R_MAX of the centre, in one piece."""
    rr, cc = np.mgrid[0:n, 0:n]
    dist = np.hypot(-E + cc * GRID, -E + rr * GRID)
    if city.get('boundary'):
        img = Image.new('L', (n, n), 0)
        d = ImageDraw.Draw(img)
        to_px = lambda lon, lat: tuple((v + E) / GRID for v in proj.xy(lon, lat))  # noqa: E731
        for rings in city['boundary']:
            d.polygon([to_px(p[0], p[1]) for p in rings[0]], fill=1)
            for hole in rings[1:]:
                d.polygon([to_px(p[0], p[1]) for p in hole], fill=0)
        mask = np.array(img, dtype=bool)
    else:
        mask = dist <= R_CIRCLE
    mask &= dist <= R_MAX
    labels, count = ndimage.label(mask)
    if count > 1:
        c = n // 2
        keep = labels[c, c] or (np.bincount(labels.ravel())[1:].argmax() + 1)
        mask = labels == keep
    mask = ndimage.binary_fill_holes(mask)
    if mask.sum() * GRID * GRID < 1.5e6:  # a boundary this small is probably wrong: fall back to a circle
        mask = dist <= R_CIRCLE
    return mask, dist


def rle(mask):
    """Run lengths of a boolean array (row by row), starting with a run of False."""
    flat_m = mask.ravel().astype(np.int8)
    edges = np.flatnonzero(np.diff(flat_m)) + 1
    runs = np.diff(np.concatenate([[0], edges, [flat_m.size]])).tolist()
    return ([0] + runs) if flat_m[0] else runs


def build_city(city, features, elev, sat=None):
    """Writes the city's map files. sat: (rgb over [-E, E]², meta) from satellite_image, or None."""
    proj = Projection(city['lat'], city['lon'])
    grid, E = elev
    n = grid.shape[0]
    to_world = lambda r, c: (-E + c * GRID, -E + r * GRID)  # noqa: E731  (grid row/col → metres)
    features = list(features)
    arena, dist = arena_of(city, proj, E, n)
    R = int(math.ceil(float(dist[arena].max()) + GRID))
    area_km2 = float(arena.sum()) * GRID * GRID / 1e6
    capacity = int(max(8, min(50, round(area_km2 * 2))))
    near_arena = ndimage.binary_dilation(arena, iterations=12)  # labels a little past the edge are fine

    def in_arena(x, y, m=near_arena):
        c = int(round((x + E) / GRID))
        r = int(round((y + E) / GRID))
        return 0 <= r < n and 0 <= c < n and bool(m[r, c])

    arena_rings = []
    soft = ndimage.gaussian_filter(arena.astype(np.float32), 0.8)
    for cnt in measure.find_contours(np.pad(soft, 1, constant_values=0), 0.5):
        pts = simplify([to_world(r - 1, c - 1) for r, c in cnt], 4.0)
        if len(pts) >= 4 and ring_area(pts) > 20000:
            arena_rings.append(flat(pts))
    coarse = arena[::2, ::2]  # the "inside?" mask the game uses: 20 m cells

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
    vals = smooth[land & arena]
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
    EXT = E

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

    poi_cands = []
    for f in features:
        tags = f.get('properties') or {}
        geom = f.get('geometry') or {}
        gtype = geom.get('type')
        poi = poi_of(f, proj)
        if poi and in_arena(poi[2], poi[3], arena):
            poi_cands.append(poi)
        if gtype == 'Point':
            if tags.get('place') in PLACE_RANK:
                name = tags.get('name:he') or tags.get('name')
                if hebrew(name) and name not in SKIP_PLACES:
                    x, y = proj.xy(*geom['coordinates'])
                    if in_arena(x, y):
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

    labels = [lab for lab in place_road_labels(names) if in_arena(lab[0], lab[1])]
    pois = pick_pois(poi_cands)
    satellite = None
    if sat is not None:
        rgb, meta = sat
        Image.fromarray(rgb).resize((1024, 1024), Image.BICUBIC).save(
            os.path.join(OUT, city['id'] + '-sat.jpg'), quality=80, optimize=True, progressive=True)
        satellite = {'image': city['id'] + '-sat.jpg', 'date': meta.get('date', ''), 'credit': meta.get('credit', '')}
    places.sort(key=lambda p: p[2])
    places = thin_points(places, [900, 650, 450])

    data = {
        'v': 1,
        'id': city['id'],
        'he': city['he'],
        'center': [city['lat'], city['lon']],
        'R': R,
        'extent': E,
        'area': round(area_km2, 2),
        'capacity': capacity,
        'arena': {'cell': GRID * 2, 'n': int(coarse.shape[0]), 'rle': rle(coarse), 'rings': arena_rings},
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
        'pois': pois,
    }
    if satellite:
        data['satellite'] = satellite
    path = os.path.join(OUT, city['id'] + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    stats = {
        'id': city['id'],
        'kb': round(os.path.getsize(path) / 1024),
        'boundary': bool(city.get('boundary')),
        'area': round(area_km2, 1),
        'capacity': capacity,
        'R': R,
        'sea': round(sea_fraction, 3),
        'relief': [round(lo), round(hi), step],
        'roads': [len(r) for r in roads],
        'points': sum(len(p) // 2 for r in roads for p in r),
        'contours': len(contours),
        'labels': len(labels),
        'places': len(places),
        'pois': len(pois),
        'sat': bool(satellite),
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
    """Builds the maps named on the command line, or else every map that is missing, out of date or lacks imagery."""
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    wanted = set(argv[1:])
    index_path = os.path.join(OUT, 'index.json')
    old = {}
    if os.path.exists(index_path):
        for c in json.load(open(index_path, encoding='utf-8')).get('cities', []):
            old[c['id']] = c

    def stale(aid):
        e = old.get(aid)
        return not e or e.get('build') != BUILD or not e.get('sat') or not os.path.exists(os.path.join(OUT, aid + '.json'))

    import regions  # the big maps (the whole country, the borders of the promise)
    old_regions = {}
    if os.path.exists(index_path):
        for r in json.load(open(index_path, encoding='utf-8')).get('regions', []):
            old_regions[r['id']] = r
    todo = [a for a in AUTHORITIES if (a[0] in wanted if wanted else stale(a[0]))]
    todo_regions = regions.stale(wanted, old_regions)
    log('to build', [a[0] for a in todo], [r['id'] for r in todo_regions])
    if not todo and not todo_regions:
        return
    pbf = download(PBF_URL, os.path.join(WORK, 'israel.osm.pbf'))
    bounds, places = admin_index(pbf)
    cities, missing = [], []
    for auth in todo:
        c = resolve(auth, bounds, places)
        if c:
            cities.append(c)
        else:
            missing.append(auth[0])
    log('resolved', len(cities), 'missing', missing)
    if cities:
        extract_all(pbf, cities)
    results = []
    for city in cities:
        try:
            proj = Projection(city['lat'], city['lon'])
            try:
                sat = satellite_image(city, proj, R_MAX + MARGIN)
            except Exception as e:  # imagery is a bonus: the map is built without it
                log('satellite FAILED', city['id'], repr(e))
                sat = None
            results.append(build_city(city, osm_features(city), elevation_grid(city, proj), sat))
        except Exception as e:  # one bad town should not stop the rest
            log('FAILED', city['id'], repr(e))
    built = {r['id']: r for r in results}
    # Keep maps built earlier for authorities not rebuilt this time.
    entries = []
    for aid, he, _alts in AUTHORITIES:
        c = next((c for c in cities if c['id'] == aid), None)
        if aid in built and c:
            r = built[aid]
            entries.append({'id': aid, 'he': he, 'R': r['R'], 'area': r['area'], 'capacity': r['capacity'],
                            'center': [round(c['lat'], 5), round(c['lon'], 5)], 'pois': r['pois'], 'sat': r['sat'],
                            'build': BUILD})
        elif aid in old and os.path.exists(os.path.join(OUT, aid + '.json')):
            entries.append(old[aid])
    built_regions = regions.build_regions(todo_regions, pbf, bounds) if todo_regions else {}
    region_entries = []
    for r in regions.REGIONS:
        if r['id'] in built_regions:
            region_entries.append(built_regions[r['id']])
        elif r['id'] in old_regions and os.path.exists(os.path.join(OUT, r['id'] + '.json')):
            region_entries.append(old_regions[r['id']])
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump({'v': 2, 'attribution': ATTRIBUTION, 'regions': region_entries, 'cities': entries}, f,
                  ensure_ascii=False, indent=1)
    log('done', len(entries), 'maps,', len(region_entries), 'big maps;', json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv)

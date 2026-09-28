"""Big maps, in the same format as the city maps but drawn smaller (one map unit is `scale` real metres):

    israel    the whole country, from the Hermon to Eilat and from the sea to the Jordan (with the Green Line as a
              layer the player can show or hide)
    promise   the borders of the promise in Genesis 15:18, "from the river of Egypt to the great river, the river
              Euphrates", in its widest reading, with today's borders drawn faintly underneath

Built by build.py's main() alongside the city maps. Sources: OpenStreetMap (roads, rail, towns and the country's
outline), Natural Earth (the wider region, public domain), AWS Terrain Tiles (elevation), NASA Blue Marble through
NASA GIBS (the satellite picture).
"""
import io
import json
import math
import os
import urllib.error
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage import measure

import build as B

BUILD = 2  # bump to rebuild the big maps
NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{}.geojson'
TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
GIBS_URLS = [  # NASA Blue Marble (a cloud-free picture of the whole Earth, 500 m per pixel), Web Mercator tiles
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default//GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/2004-08-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default//GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
]
CELL = 10  # map units per elevation cell
ARENA_CELL = 20  # map units per cell of the "inside?" mask, as in the city maps
ATTRIBUTION = '© OpenStreetMap contributors (ODbL) · Natural Earth · גבהים: AWS Terrain Tiles'

# The widest reading of Genesis 15:18: the river of Egypt is the Nile (Rashi), so the land runs from the Damietta
# branch of the Nile across Sinai to the Euphrates, north to the land of the Hittites (Joshua 1:4) along today's
# Syrian–Turkish border, west to the sea. The sea side runs offshore; the coastline cuts it. (lon, lat)
PROMISE = [
    (31.83, 31.60), (31.83, 31.52), (31.38, 31.04), (31.24, 30.71), (31.18, 30.46), (31.23, 30.17), (31.25, 30.03),
    (32.55, 29.97), (34.95, 29.52), (38.0, 30.9), (40.6, 32.2), (43.3, 33.42),
    (42.83, 33.64), (42.35, 34.14), (41.98, 34.37), (41.05, 34.37), (40.92, 34.45), (40.45, 35.02), (40.14, 35.33),
    (39.01, 35.95), (38.55, 35.84), (38.07, 36.02), (38.01, 36.82),
    (37.05, 36.66), (36.65, 36.25), (36.35, 35.95), (35.92, 35.92),
    (35.55, 35.95), (35.30, 35.00), (34.90, 33.90), (34.55, 32.80), (34.20, 32.00), (33.90, 31.45), (32.90, 31.30),
    (32.20, 31.45),
]
# Used only if OpenStreetMap's outline of the country cannot be read: the land between the sea and the Jordan,
# with the Golan, roughly. (lon, lat)
ISRAEL_FALLBACK = [
    (34.22, 31.32), (34.27, 31.22), (34.40, 30.88), (34.52, 30.55), (34.73, 30.10), (34.88, 29.60), (34.90, 29.49),
    (34.98, 29.53), (35.07, 30.00), (35.17, 30.50), (35.33, 30.90), (35.40, 31.10), (35.50, 31.50), (35.55, 31.76),
    (35.54, 32.00), (35.57, 32.40), (35.57, 32.63), (35.65, 32.68), (35.80, 32.72), (35.87, 32.85), (35.85, 33.05),
    (35.85, 33.25), (35.82, 33.33), (35.80, 33.40), (35.65, 33.30), (35.57, 33.28), (35.52, 33.12), (35.40, 33.07),
    (35.20, 33.08), (35.10, 33.09), (34.90, 33.10), (34.40, 32.30), (33.90, 31.50), (34.10, 31.30),
]
REGIONS = [
    dict(id='israel', he='כל הארץ', subtitle='מהחרמון עד אילת, מהים עד הירדן', lat=31.42, lon=35.05, scale=50,
         half=232_000, zoom=9, sat_zoom=8,
         names=[(35.35, 32.95, 'הגליל', 0), (35.76, 33.02, 'רמת הגולן', 0), (34.92, 32.28, 'השרון', 1),
                (35.24, 32.02, 'יהודה ושומרון', 0), (34.85, 30.72, 'הנגב', 0), (35.16, 30.30, 'הערבה', 1),
                (34.40, 31.43, 'רצועת עזה', 1), (34.25, 32.55, 'הים התיכון', 0), (34.95, 29.38, 'מפרץ אילת', 1),
                (35.30, 32.62, 'עמק יזרעאל', 1), (34.78, 31.62, 'השפלה', 1)]),
    dict(id='promise', he='גבולות ההבטחה', subtitle='״מִנְּהַר מִצְרַיִם עַד הַנָּהָר הַגָּדֹל נְהַר פְּרָת״ (בראשית ט״ו, י״ח)',
         lat=33.1, lon=37.0, scale=130, half=610_000, zoom=7, sat_zoom=7, polygon=PROMISE,
         names=[(33.3, 34.3, 'הים התיכון', 0), (31.1, 30.75, 'הנילוס', 1), (40.4, 35.05, 'נהר פרת', 1),
                (35.62, 32.25, 'הירדן', 1), (33.7, 30.2, 'סיני', 0)]),
]
# Where to write a country's name when its own label point is off the map (lon, lat).
OFF_SQUARE = {'EGY': (31.0, 29.6), 'SAU': (38.6, 29.2), 'TUR': (37.2, 37.4), 'IRQ': (42.6, 32.6)}
COUNTRIES = {  # Hebrew names for the countries on the region map, by Natural Earth's ADM0_A3
    'EGY': 'מצרים', 'JOR': 'ירדן', 'LBN': 'לבנון', 'SYR': 'סוריה', 'IRQ': 'עיראק', 'SAU': 'ערב הסעודית',
    'TUR': 'טורקיה', 'CYP': 'קפריסין', 'ISR': 'ישראל',
}


# ----------------------------------------------------------------------------------------------- inputs
def fetch_json(url, name):
    path = B.download(url, os.path.join(B.WORK, name))
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def natural_earth(layer):
    """A Natural Earth 1:10m layer as GeoJSON features, with property names in lower case ([] if it will not load)."""
    try:
        data = fetch_json(NE_URL.format(layer), layer + '.geojson')
    except Exception as e:  # noqa: BLE001 — a missing layer leaves that part of the map out
        B.log('natural earth FAILED', layer, repr(e))
        return []
    feats = data.get('features', [])
    for f in feats:
        f['properties'] = {str(k).lower(): v for k, v in (f.get('properties') or {}).items()}
    return feats


def tile(url, name):
    """A map tile as a numpy array (h, w, 3), cached; None when the server has none."""
    path = os.path.join(B.WORK, 'tiles', name)
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': B.UA})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code in (400, 404):
                    return None
                if attempt == 2:
                    raise
            except OSError:
                if attempt == 2:
                    raise
        with open(path, 'wb') as f:
            f.write(data)
    try:
        return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
    except OSError:
        return None


def mercator_px(lon, lat, z):
    """Pixel coordinates of lon/lat at Web Mercator zoom z (256-pixel tiles)."""
    size = 256 * 2 ** z
    x = (np.asarray(lon) + 180.0) / 360.0 * size
    phi = np.radians(np.asarray(lat))
    y = (1 - np.log(np.tan(phi) + 1 / np.cos(phi)) / math.pi) / 2 * size
    return x, y


def sample_tiles(url, z, lon, lat, key):
    """Bilinear samples of an XYZ tile layer at the given lon/lat arrays: (…, 3) float32, or None if no tiles came."""
    px, py = mercator_px(lon, lat, z)
    tx0, tx1 = int(px.min() // 256), int(px.max() // 256)
    ty0, ty1 = int(py.min() // 256), int(py.max() // 256)
    canvas = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), np.float32)
    got = 0
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            img = tile(url.format(z=z, x=tx, y=ty), f'{key}-{z}-{tx}-{ty}')
            if img is None or img.shape[:2] != (256, 256):
                continue
            canvas[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = img
            got += 1
    if not got:
        return None
    coords = np.array([(py - ty0 * 256).ravel() - 0.5, (px - tx0 * 256).ravel() - 0.5])
    out = np.stack([ndimage.map_coordinates(canvas[..., k], coords, order=1, mode='nearest') for k in range(3)], -1)
    return out.reshape(np.shape(lon) + (3,))


def terrarium(rgb):
    """Elevation in metres from Terrarium-encoded tile colours."""
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def blue_marble(lon, lat, z):
    """NASA Blue Marble at the given lon/lat arrays, from the first GIBS address that answers."""
    for k, url in enumerate(GIBS_URLS):
        try:
            out = sample_tiles(url, z, lon, lat, f'gibs{k}')
        except Exception as e:  # noqa: BLE001 — try the next address
            B.log('gibs', k, repr(e))
            out = None
        if out is not None and out.max() > 20:
            return out
    return None


# ----------------------------------------------------------------------------------------------- geometry
class Scaled:
    """Map units around the region's centre: real metres (build.Projection) divided by the region's scale."""

    def __init__(self, region):
        self.proj = B.Projection(region['lat'], region['lon'])
        self.s = region['scale']

    def xy(self, lon, lat):
        x, y = self.proj.xy(lon, lat)
        return x / self.s, y / self.s

    def lonlat(self, x, y):
        return self.proj.lonlat(np.asarray(x) * self.s, np.asarray(y) * self.s)


def rasterize(polys, sc, E, cell, n):
    """Polygons (lists of rings of (lon, lat), holes after the outer ring) on the map grid."""
    img = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(img)
    to_px = lambda lon, lat: tuple((v + E) / cell for v in sc.xy(lon, lat))  # noqa: E731
    for rings in polys:
        if len(rings[0]) >= 3:
            d.polygon([to_px(p[0], p[1]) for p in rings[0]], fill=1)
        for hole in rings[1:]:
            if len(hole) >= 3:
                d.polygon([to_px(p[0], p[1]) for p in hole], fill=0)
    return np.array(img, dtype=bool)


def polys_of(geom):
    t = (geom or {}).get('type')
    if t == 'Polygon':
        return [geom['coordinates']]
    if t == 'MultiPolygon':
        return geom['coordinates']
    return []


def lines_of(geom):
    t = (geom or {}).get('type')
    if t == 'LineString':
        return [geom['coordinates']]
    if t == 'MultiLineString':
        return geom['coordinates']
    return []


def near_box(coords, box):
    lon0, lat0, lon1, lat1 = box
    return any(lon0 <= p[0] <= lon1 and lat0 <= p[1] <= lat1 for p in coords)


def contour_rings(mask, E, cell, tol, min_area):
    """Smooth outlines of a boolean grid, as flat [x0, y0, …] rings in map units."""
    rings = []
    soft = ndimage.gaussian_filter(mask.astype(np.float32), 0.8)
    for cnt in measure.find_contours(np.pad(soft, 1, constant_values=0), 0.5):
        pts = B.simplify([(-E + (c - 1) * cell, -E + (r - 1) * cell) for r, c in cnt], tol)
        if len(pts) >= 4 and B.ring_area(pts) > min_area:
            rings.append(B.flat(pts))
    return rings


def densify(pts, step):
    """The polyline with extra points so that no segment is longer than step."""
    out = list(pts[:1])
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        k = max(1, int(math.ceil(math.hypot(x1 - x0, y1 - y0) / step)))
        out += [(x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k) for j in range(1, k + 1)]
    return out


def split_where(pts, keep):
    """Cuts a polyline into the runs of points where keep(x, y) holds (checked every CELL / 2 along it)."""
    out, cur = [], []
    for p in densify(pts, CELL / 2):
        if keep(*p):
            cur.append(p)
        else:
            if len(cur) > 1:
                out.append(cur)
            cur = []
    if len(cur) > 1:
        out.append(cur)
    return out


# ----------------------------------------------------------------------------------------------- the maps
def country_outline(bounds, ne_countries=()):
    """The land between the sea and the Jordan, with the Golan: Israel's national boundary from OpenStreetMap, and
    the West Bank and Gaza from Natural Earth (OSM keeps them apart). Lon/lat polygons, or None."""
    seen, polys = set(), []
    for entries in bounds.values():
        for level, p in entries:
            if level != '2' or id(p) in seen:
                continue
            seen.add(id(p))
            ring = max((r[0] for r in p), key=len)
            clon = sum(q[0] for q in ring) / len(ring)
            clat = sum(q[1] for q in ring) / len(ring)
            if 34.0 <= clon <= 36.0 and 29.3 <= clat <= 33.5:  # the country itself, not a neighbour
                polys += p
    for f in ne_countries:
        props = f['properties']
        if props.get('adm0_a3') in ('PSX', 'PSE') or 'Palestin' in str(props.get('admin') or props.get('name') or ''):
            polys += polys_of(f['geometry'])
    return polys or None


def osm_country_features(pbf):
    """The country's main roads, rail, rivers and towns from the OSM file, as GeoJSON features."""
    base = os.path.join(B.WORK, 'country')
    B.run(['osmium', 'tags-filter', '-O', pbf, 'w/highway=motorway,trunk,primary,secondary', 'w/railway=rail',
           'w/waterway=river', 'n/place=city,town', '-o', base + '.osm.pbf'])
    B.run(['osmium', 'export', '-O', '-f', 'geojsonseq', '-x', 'print_record_separator=false', base + '.osm.pbf',
           '-o', base + '.geojsonseq'])
    return list(B.read_seq(base + '.geojsonseq'))


def build_region(region, ne, osm=None, bounds=None, elevation=None, satellite=None):
    """Writes docs/maps/<id>.json and its pictures. ne: {layer: features}; osm: the country's OSM features (only for
    'israel'); elevation/satellite: functions (lon, lat) → array, for tests (default: fetch the tiles)."""
    rid = region['id']
    sc = Scaled(region)
    E = region['half'] / region['scale']
    n = int(round(2 * E / CELL)) + 1
    xs = -E + np.arange(n) * CELL
    X, Y = np.meshgrid(xs, xs)
    lon, lat = sc.lonlat(X, Y)
    box = (float(lon.min()) - 0.5, float(lat.min()) - 0.5, float(lon.max()) + 0.5, float(lat.max()) + 0.5)

    # Land and sea (Natural Earth), and the arena: the country or the promise, on land.
    land_polys = [p for f in ne['ne_10m_land'] for p in polys_of(f['geometry'])]
    land = rasterize(land_polys, sc, E, CELL, n)
    if region.get('polygon'):
        outline, source = [[list(region['polygon'])]], 'polygon'
    else:
        outline, source = (country_outline(bounds or {}, ne.get('ne_10m_admin_0_countries', [])), 'osm+ne')
        if not outline:
            outline, source = [[list(ISRAEL_FALLBACK)]], 'fallback'
    B.log('region', rid, 'outline from', source)
    arena = rasterize(outline, sc, E, CELL, n) & land
    labels_, count = ndimage.label(arena)
    if count > 1:  # one piece: the biggest
        arena = labels_ == (np.bincount(labels_.ravel())[1:].argmax() + 1)
    arena = ndimage.binary_fill_holes(arena)
    dist = np.hypot(X, Y)
    R = int(math.ceil(float(dist[arena].max()) + CELL))
    area_km2 = float(arena.sum()) * (CELL * region['scale']) ** 2 / 1e6
    coarse = arena[::ARENA_CELL // CELL, ::ARENA_CELL // CELL]  # the "inside?" mask the game uses
    arena_rings = contour_rings(arena, E, CELL, 2.0, 2000)

    def inside(x, y, m=arena):
        c = int(round((x + E) / CELL))
        r = int(round((y + E) / CELL))
        return 0 <= r < n and 0 <= c < n and bool(m[r, c])

    near = ndimage.binary_dilation(arena, iterations=3)
    deep = ndimage.binary_erosion(arena, iterations=2)

    # Elevation (Terrarium tiles), contours and the terrain picture.
    if elevation is None:
        elevation = lambda lo_, la_: terrarium(sample_tiles(TERRARIUM_URL, region['zoom'], lo_, la_, 'terrarium'))  # noqa: E731
    grid = elevation(lon, lat).astype(np.float32)
    smooth = ndimage.gaussian_filter(grid, 1.2)
    vals = smooth[land & arena]
    lo, hi = (float(np.percentile(vals, 0.5)), float(np.percentile(vals, 99.5))) if vals.size else (0.0, 1.0)
    relief = max(1.0, hi - lo)
    step = next(s for s in (50, 100, 200, 250, 500, 1000) if relief / s <= 16)
    contours = []
    first = math.ceil(lo / step) * step
    for h in np.arange(first, hi + step, step):
        if h == 0:
            continue
        for cnt in measure.find_contours(smooth, float(h), mask=land):
            pts = B.simplify([(-E + c * CELL, -E + r * CELL) for r, c in cnt], 2.0)
            if B.length(pts) >= 160:
                contours.append([int(round(h)), B.flat(pts)])
    real_cell = CELL * region['scale']
    gs, ge = np.gradient(smooth * max(2.0, real_cell / 150), real_cell)  # bigger cells flatten the hills: exaggerate
    az, alt = math.radians(315), math.radians(42)
    lx, ly, lz = math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)
    nx, ny = -ge, gs
    shade = np.clip((nx * lx + ny * ly + lz) / np.sqrt(nx * nx + ny * ny + 1), 0, 1)
    t = np.clip((smooth - lo) / relief, 0, 1)[..., None]
    rgb = np.array([246, 242, 233], np.float32) * (1 - t) + np.array([226, 214, 190], np.float32) * t
    rgb *= (0.78 + 0.22 * shade / max(float(shade.max()), 1e-6))[..., None]
    rgb = np.where(land[..., None], rgb, np.array([201, 223, 233], np.float32))
    rgb = np.where((land & ~arena)[..., None], rgb * 0.94 + 255 * 0.06, rgb)  # outside the arena: a little paler
    Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).resize((1024, 1024), Image.BICUBIC).save(
        os.path.join(B.OUT, rid + '.jpg'), quality=82, optimize=True, progressive=True)

    # The satellite picture: NASA Blue Marble, 1024 × 1024 over the same square.
    k = np.arange(1024) * (2 * E / 1023) - E
    SX, SY = np.meshgrid(k, k)
    slon, slat = sc.lonlat(SX, SY)
    sat_rgb = (satellite or (lambda lo_, la_: blue_marble(lo_, la_, region['sat_zoom'])))(slon, slat)
    sat_meta = None
    if sat_rgb is not None:
        Image.fromarray(np.clip(sat_rgb, 0, 255).astype(np.uint8)).save(
            os.path.join(B.OUT, rid + '-sat.jpg'), quality=80, optimize=True, progressive=True)
        sat_meta = {'image': rid + '-sat.jpg', 'date': '', 'credit': 'NASA Blue Marble (NASA EOSDIS GIBS)'}

    # The sea, lakes and rivers.
    sea_rings = contour_rings(~land, E, CELL, 2.0, 3000)
    water = []
    for f in ne['ne_10m_lakes']:
        for rings in polys_of(f['geometry']):
            if not near_box(rings[0], box):
                continue
            out = []
            for j, ring in enumerate(rings):
                pts = B.clip_ring(B.simplify([sc.xy(p[0], p[1]) for p in ring], 1.5), E)
                if len(pts) < 3 or (j == 0 and B.ring_area(pts) < 40):
                    break
                out.append(B.flat(pts))
            if out:
                water.append(out)
    rivers = []
    river_src = ([(f['properties'], f['geometry']) for f in osm if (f.get('properties') or {}).get('waterway') == 'river']
                 if osm else [(f['properties'], f['geometry']) for f in ne['ne_10m_rivers_lake_centerlines']
                              if int(f['properties'].get('scalerank') or 99) <= 7])
    for props, geom in river_src:
        for line in lines_of(geom):
            if not near_box(line, box):
                continue
            for part in B.clip_line([sc.xy(p[0], p[1]) for p in line], E):
                pts = B.simplify(part, 1.5)
                if B.length(pts) > (30 if osm else 60):
                    rivers.append([1, B.flat(pts)])

    # Roads, rail, towns (the country from OSM; the region from Natural Earth).
    roads = [[], [], []]
    names = []
    rail = []
    places = []
    hubs = []
    if osm:
        cls_of = {'motorway': 0, 'trunk': 0, 'primary': 0, 'secondary': 1}  # tertiary roads are too fine at this scale
        for f in osm:
            tags = f.get('properties') or {}
            geom = f.get('geometry') or {}
            if tags.get('highway') in cls_of:
                cls = cls_of[tags['highway']]
                ref = str(tags.get('ref') or '').split(';')[0].strip()
                for line in lines_of(geom):
                    for part in B.clip_line([sc.xy(p[0], p[1]) for p in line], E):
                        pts = B.simplify(part, 1.5 if cls == 0 else 2.5)
                        if len(pts) >= 2:
                            roads[cls].append(B.flat(pts))
                            if cls == 0 and ref.isdigit():
                                names.append((0, f'כביש {ref}', pts))
            elif tags.get('railway') == 'rail':
                for line in lines_of(geom):
                    for part in B.clip_line([sc.xy(p[0], p[1]) for p in line], E):
                        pts = B.simplify(part, 2.0)
                        if len(pts) >= 2:
                            rail.append(B.flat(pts))
            elif tags.get('place') in ('city', 'town') and geom.get('type') == 'Point':
                name = tags.get('name:he') or tags.get('name')
                if not B.hebrew(name):
                    continue
                x, y = sc.xy(*geom['coordinates'])
                if not inside(x, y, near):
                    continue
                try:
                    pop = float(str(tags.get('population', '0')).replace(',', ''))
                except ValueError:
                    pop = 0.0
                rank = 0 if tags['place'] == 'city' and pop >= 100_000 else 1 if tags['place'] == 'city' else 2
                places.append([int(round(x)), int(round(y)), rank, name.strip(), pop])
    else:
        road_cls = {'major highway': 0, 'secondary highway': 1, 'road': 2}
        for f in ne['ne_10m_roads']:
            cls = road_cls.get(str(f['properties'].get('type', '')).lower())
            if cls is None:
                continue
            for line in lines_of(f['geometry']):
                if not near_box(line, box):
                    continue
                for part in B.clip_line([sc.xy(p[0], p[1]) for p in line], E):
                    pts = B.simplify(part, 2.0)
                    if len(pts) >= 2:
                        roads[cls].append(B.flat(pts))
        for f in ne['ne_10m_populated_places']:
            p = f['properties']
            name = p.get('name_he') or ''
            g = f['geometry'] or {}
            if not B.hebrew(name) or g.get('type') != 'Point' or int(p.get('scalerank') or 99) > 8:
                continue
            x, y = sc.xy(*g['coordinates'])
            if not inside(x, y, near):
                continue
            pop = float(p.get('pop_max') or 0)
            rank = 0 if pop >= 1_000_000 or p.get('adm0cap') in (1, '1', 1.0) else 1 if pop >= 200_000 else 2
            places.append([int(round(x)), int(round(y)), rank, name.strip(), pop])
    places.sort(key=lambda p: (p[2], -p[4]))
    for x, y, rank, name, pop in places:
        hubs.append([x, y, round(max(0.5, math.sqrt(max(pop, 5000) / 50_000)), 2)])
    places = B.thin_points([p[:4] for p in places], [260, 150, 90])
    road_labels = [lab for lab in B.place_road_labels(names) if inside(lab[0], lab[1], near)]

    # Today's borders (faint), and the Green Line as its own layer; only the parts inside or along the arena.
    borders, green = [], []
    for f in ne['ne_10m_admin_0_boundary_lines_land']:
        p = f['properties']
        sides = ' '.join(str(p.get(k) or '') for k in ('adm0_left', 'adm0_right', 'adm0_a3_l', 'adm0_a3_r', 'name'))
        is_green = 'Palestin' in sides or 'PSX' in sides or 'PSE' in sides
        for line in lines_of(f['geometry']):
            if not near_box(line, box):
                continue
            pts = [sc.xy(q[0], q[1]) for q in line]
            if is_green:
                for part in split_where(pts, lambda x, y: inside(x, y, deep)):
                    green.append(B.flat(B.simplify(part, 1.0)))
            else:
                keep = (lambda x, y: inside(x, y, near) and not inside(x, y, deep)) if not region.get('polygon') else \
                    (lambda x, y: inside(x, y, near))
                for part in split_where(pts, keep):
                    borders.append(B.flat(B.simplify(part, 1.5)))
    countries = []
    if region.get('polygon'):
        seen_codes = set()
        for f in ne['ne_10m_admin_0_countries']:
            p = f['properties']
            code = p.get('adm0_a3')
            if code not in COUNTRIES or p.get('label_x') is None:
                continue
            x, y = sc.xy(float(p['label_x']), float(p['label_y']))
            if abs(x) < E * 0.95 and abs(y) < E * 0.95:
                countries.append([int(round(x)), int(round(y)), COUNTRIES[code]])
                seen_codes.add(code)
        for code, (lon_, lat_) in OFF_SQUARE.items():
            if code not in seen_codes:
                x, y = sc.xy(lon_, lat_)
                countries.append([int(round(x)), int(round(y)), COUNTRIES[code]])
    big_names = []
    for lon_, lat_, name, size in region.get('names', []):
        x, y = sc.xy(lon_, lat_)
        big_names.append([int(round(x)), int(round(y)), name, size])

    data = {
        'v': 1,
        'kind': 'region',
        'id': rid,
        'he': region['he'],
        'subtitle': region['subtitle'],
        'center': [region['lat'], region['lon']],
        'scale': region['scale'],
        'R': R,
        'extent': round(E),
        'area': round(area_km2),
        'capacity': 50,
        'arena': {'cell': ARENA_CELL, 'n': int(coarse.shape[0]), 'rle': B.rle(coarse), 'rings': arena_rings},
        'terrain': rid + '.jpg',
        'attribution': ATTRIBUTION,
        'elevation': [round(lo), round(hi)],
        'sea': sea_rings,
        'water': water,
        'green': [],
        'beach': [],
        'rivers': rivers,
        'roads': roads,
        'rail': rail,
        'contours': {'step': step, 'lines': contours},
        'labels': road_labels,
        'places': places,
        'pois': [[x, y, 'city', name] for x, y, rank, name in places],
        'hubs': hubs,
        'names': big_names + [[x, y, name, 0] for x, y, name in countries],
        'lines': {'green': green, 'borders': borders},
    }
    if sat_meta:
        data['satellite'] = sat_meta
    path = os.path.join(B.OUT, rid + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    stats = {'id': rid, 'kb': round(os.path.getsize(path) / 1024), 'outline': source, 'area': round(area_km2),
             'R': R, 'E': round(E), 'roads': [len(r) for r in roads], 'places': len(places), 'rivers': len(rivers),
             'water': len(water), 'contours': len(contours), 'step': step, 'green': len(green), 'borders': len(borders),
             'sat': bool(sat_meta), 'pois': len(data['pois'])}
    B.log('region', json.dumps(stats, ensure_ascii=False))
    return {'id': rid, 'he': region['he'], 'R': R, 'area': round(area_km2), 'capacity': 50, 'kind': 'region',
            'center': [region['lat'], region['lon']], 'sat': bool(sat_meta), 'pois': len(data['pois']),
            'subtitle': region['subtitle'], 'build': BUILD}


def stale(wanted, old):
    """The big maps to build: the ones named, or else the ones missing, out of date or without a satellite picture."""
    if wanted:
        return [r for r in REGIONS if r['id'] in wanted]
    return [r for r in REGIONS if old.get(r['id'], {}).get('build') != BUILD or not old.get(r['id'], {}).get('sat')
            or not os.path.exists(os.path.join(B.OUT, r['id'] + '.json'))]


def build_regions(todo, pbf, bounds):
    """Builds the given big maps; returns their index entries by id."""
    ne = {layer: natural_earth(layer) for layer in ('ne_10m_land', 'ne_10m_lakes', 'ne_10m_rivers_lake_centerlines',
                                                    'ne_10m_admin_0_boundary_lines_land', 'ne_10m_admin_0_countries',
                                                    'ne_10m_populated_places', 'ne_10m_roads')}
    if not ne['ne_10m_land']:
        B.log('region FAILED: no land polygons')
        return {}
    osm = None
    out = {}
    for region in todo:
        try:
            if not region.get('polygon') and osm is None:
                osm = osm_country_features(pbf)
            out[region['id']] = build_region(region, ne, osm if not region.get('polygon') else None, bounds)
        except Exception as e:  # noqa: BLE001 — one map failing should not stop the rest
            B.log('region FAILED', region['id'], repr(e))
    return out

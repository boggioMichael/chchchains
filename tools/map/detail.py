"""The detailed layer of a city map, like a street map: buildings, what the land is used for (homes, shops,
industry, schools, hospitals, sport, parking, cemeteries, fields, woods, sand), the small streets and paths, the
motorways, and named places of every kind (food, shops, health, schools, culture, hotels, public offices,
transport, sport, places of worship, fuel, banks, parks) for the map's icons.

Written to docs/maps/<id>-detail.json next to the city's main file, which the game loads first; the detail comes
a moment later. Every line and ring is stored as whole metres, the first point absolute and the rest as steps from
the point before (much smaller numbers in the file):

    { "v": 1, "id": …, "b": [ring, …], "a": { class: [[ring, hole, …], …] }, "m": [[kind, …line], …],
      "f": [line, …], "p": [[x, y, category, name], …] }

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).
"""
import json
import math
import os

DETAIL = 1

# What the land is used for: the first class whose test matches wins (so a school's grounds are a school, not the
# homes around it).
AREA_CLASSES = [
    ('hospital', lambda t: t.get('amenity') in ('hospital', 'clinic') or t.get('healthcare') == 'hospital'),
    ('school', lambda t: t.get('amenity') in ('school', 'university', 'college', 'kindergarten')),
    ('sport', lambda t: t.get('leisure') in ('pitch', 'sports_centre', 'stadium', 'track', 'golf_course', 'playground')),
    ('parking', lambda t: t.get('amenity') == 'parking' and t.get('parking') not in ('underground', 'multi-storey')),
    ('cemetery', lambda t: t.get('landuse') == 'cemetery' or t.get('amenity') == 'grave_yard'),
    ('industrial', lambda t: t.get('landuse') in ('industrial', 'railway', 'port', 'garages', 'depot', 'construction')),
    ('commercial', lambda t: t.get('landuse') in ('commercial', 'retail')),
    ('farmland', lambda t: t.get('landuse') in ('farmland', 'orchard', 'vineyard', 'farmyard', 'greenhouse_horticulture', 'plant_nursery', 'allotments')),
    ('forest', lambda t: t.get('landuse') == 'forest' or t.get('natural') in ('wood', 'scrub', 'heath')),
    ('sand', lambda t: t.get('natural') in ('sand', 'bare_rock', 'scree', 'shingle')),
    ('residential', lambda t: t.get('landuse') == 'residential'),
]
AREA_MIN = {'residential': 2000, 'farmland': 3000, 'forest': 2000}  # square metres; the rest: 250

# The small streets (kind 0: service roads and lanes) and paths (kind 1: footways, steps, cycle paths).
MINOR = {'service': 0, 'track': 0, 'busway': 0, 'footway': 1, 'path': 1, 'pedestrian': 1, 'steps': 1, 'cycleway': 1, 'bridleway': 1}
FAST = {'motorway', 'trunk', 'motorway_link', 'trunk_link'}

# Named places for the icons: category, how many a city keeps at most, and the test. The first match wins.
POI_CATEGORIES = [
    ('transit', 60, lambda t: t.get('amenity') == 'bus_station' or t.get('railway') in ('station', 'halt') or t.get('public_transport') == 'station'),
    ('health', 150, lambda t: t.get('amenity') in ('hospital', 'clinic', 'pharmacy', 'doctors', 'dentist') or bool(t.get('healthcare'))),
    ('gov', 120, lambda t: t.get('amenity') in ('townhall', 'police', 'post_office', 'courthouse', 'fire_station') or t.get('office') == 'government'),
    ('edu', 300, lambda t: t.get('amenity') in ('school', 'kindergarten', 'university', 'college', 'library')),
    ('culture', 150, lambda t: t.get('amenity') in ('theatre', 'cinema', 'arts_centre', 'community_centre') or t.get('tourism') in ('museum', 'gallery', 'attraction')),
    ('park', 200, lambda t: t.get('leisure') in ('park', 'garden')),
    ('sport', 150, lambda t: t.get('leisure') in ('sports_centre', 'stadium', 'swimming_pool', 'fitness_centre')),
    ('hotel', 120, lambda t: t.get('tourism') in ('hotel', 'hostel', 'guest_house', 'motel')),
    ('worship', 250, lambda t: t.get('amenity') == 'place_of_worship'),
    ('food', 900, lambda t: t.get('amenity') in ('restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'ice_cream', 'food_court')),
    ('shop', 900, lambda t: bool(t.get('shop')) and t.get('shop') not in ('vacant', 'no')),
    ('fuel', 60, lambda t: t.get('amenity') == 'fuel'),
    ('bank', 80, lambda t: t.get('amenity') == 'bank'),
]

FILTER = [
    'w/building', 'r/building', 'nwr/landuse', 'nwr/natural=wood,scrub,heath,sand,bare_rock,scree,shingle',
    'nwr/leisure', 'nwr/amenity', 'nwr/shop', 'nwr/tourism', 'nwr/office=government', 'nwr/healthcare',
    'nwr/railway=station,halt', 'nwr/public_transport=station',
    'w/highway=service,track,busway,footway,path,pedestrian,steps,cycleway,bridleway,motorway,trunk,motorway_link,trunk_link',
]


def delta(pts):
    """[(x, y), …] → [x0, y0, dx1, dy1, …] in whole metres (the steps add up to the rounded points)."""
    out = []
    px = py = 0
    for k, (x, y) in enumerate(pts):
        ix, iy = int(round(x)), int(round(y))
        if k == 0:
            out += [ix, iy]
        else:
            out += [ix - px, iy - py]
        px, py = ix, iy
    return out


def undelta(a):
    """The inverse of delta: [(x, y), …]."""
    pts, x, y = [], 0, 0
    for k in range(0, len(a), 2):
        if k == 0:
            x, y = a[0], a[1]
        else:
            x, y = x + a[k], y + a[k + 1]
        pts.append((x, y))
    return pts


def arena_test(data):
    """"Is (x, y) inside the map (or close to it)?" from a city file's arena mask (run-length rows of 20 m cells)."""
    ar = data['arena']
    cell, n, E = ar['cell'], ar['n'], data['extent']
    runs, mask, val = ar['rle'], bytearray(n * n), 0
    i = 0
    for r in runs:
        if val:
            mask[i:i + r] = b'\x01' * r
        i += r
        val ^= 1
    # A margin of a few cells: buildings just past the city limits still show at the edge.
    grown = bytearray(mask)
    for _ in range(3):
        src = bytes(grown)
        for k in range(n * n):
            if src[k]:
                continue
            r, c = divmod(k, n)
            if (c > 0 and src[k - 1]) or (c < n - 1 and src[k + 1]) or (r > 0 and src[k - n]) or (r < n - 1 and src[k + n]):
                grown[k] = 1

    def inside(x, y):
        c = int(round((x + E) / cell))
        r = int(round((y + E) / cell))
        return 0 <= r < n and 0 <= c < n and bool(grown[r * n + c])
    return inside


def build_detail(city, features, B, out_dir):
    """Writes docs/maps/<id>-detail.json from the city's OSM features (GeoJSON dicts). B is build.py (projection and
    geometry helpers); the city's main file must already be written (its extent and arena are used). Returns stats."""
    with open(os.path.join(out_dir, city['id'] + '.json'), encoding='utf-8') as f:
        base = json.load(f)
    E = base['extent']
    inside = arena_test(base)
    proj = B.Projection(base['center'][0], base['center'][1])
    project = lambda coords: [proj.xy(lon, lat) for lon, lat in coords]  # noqa: E731

    def polys_of(geom):
        if geom['type'] == 'Polygon':
            yield geom['coordinates']
        elif geom['type'] == 'MultiPolygon':
            yield from geom['coordinates']

    def lines_of(geom):
        if geom['type'] == 'LineString':
            yield geom['coordinates']
        elif geom['type'] == 'MultiLineString':
            yield from geom['coordinates']

    buildings, areas, minor, fast, cands = [], {}, [], [], []
    for f in features:
        tags = f.get('properties') or {}
        geom = f.get('geometry') or {}
        gtype = geom.get('type')
        if not gtype:
            continue
        name = (tags.get('name:he') or tags.get('name') or '').strip()
        # Named places, for the icons.
        if name and len(name) <= 40:
            cat = next((c for c, _n, test in POI_CATEGORIES if test(tags)), None)
            if cat:
                xy = None
                if gtype == 'Point':
                    xy = proj.xy(*geom['coordinates'])
                elif gtype in ('Polygon', 'MultiPolygon'):
                    (xy, _a) = max((B.ring_centroid(project(rings[0])) for rings in polys_of(geom)), key=lambda c: c[1])
                if xy and inside(*xy):
                    cands.append((cat, name, xy[0], xy[1], B.hebrew(name)))
        if gtype == 'Point':
            continue
        hw = tags.get('highway')
        if hw and gtype in ('LineString', 'MultiLineString'):
            if tags.get('tunnel') in ('yes', 'building_passage') or tags.get('area') == 'yes':
                continue
            for line in lines_of(geom):
                for part in B.clip_line(project(line), E):
                    pts = B.simplify(part, 1.2)
                    if len(pts) < 2 or not any(inside(x, y) for x, y in pts[:: max(1, len(pts) // 4)]):
                        continue
                    if hw in FAST:
                        fast.append(delta(pts))
                    elif hw in MINOR:
                        minor.append([MINOR[hw]] + delta(pts))
            continue
        if gtype not in ('Polygon', 'MultiPolygon'):
            continue
        if tags.get('building') and tags.get('building') != 'no':
            for rings in polys_of(geom):
                pts = B.clip_ring(B.simplify(project(rings[0]), 0.7), E)
                if len(pts) >= 3 and B.ring_area(pts) >= 12 and inside(*pts[0]):
                    buildings.append(delta(pts))
            continue
        cls = next((c for c, test in AREA_CLASSES if test(tags)), None)
        if not cls:
            continue
        for rings in polys_of(geom):
            out = []
            for k, ring in enumerate(rings):
                pts = B.clip_ring(B.simplify(project(ring), 1.5), E)
                if len(pts) < 3:
                    continue
                if k == 0 and (B.ring_area(pts) < AREA_MIN.get(cls, 250) or not any(inside(x, y) for x, y in pts[:: max(1, len(pts) // 6)])):
                    break
                out.append(delta(pts))
            if out:
                areas.setdefault(cls, []).append(out)

    pois = pick(cands)
    data = {'v': DETAIL, 'id': city['id'], 'b': buildings, 'a': areas, 'm': minor, 'f': fast, 'p': pois}
    path = os.path.join(out_dir, city['id'] + '-detail.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    return {
        'id': city['id'],
        'kb': round(os.path.getsize(path) / 1024),
        'buildings': len(buildings),
        'areas': {k: len(v) for k, v in areas.items()},
        'minor': len(minor),
        'fast': len(fast),
        'pois': len(pois),
    }


def pick(cands):
    """Per category up to its limit, Hebrew names first, then the most central; the same name only once within
    150 m. [[x, y, category, name], …]"""
    limits = {c: n for c, n, _t in POI_CATEGORIES}
    order = {c: i for i, (c, _n, _t) in enumerate(POI_CATEGORIES)}
    cands = sorted(cands, key=lambda c: (order[c[0]], not c[4], math.hypot(c[2], c[3])))
    out, count, seen = [], {}, {}
    for cat, name, x, y, _he in cands:
        if count.get(cat, 0) >= limits[cat]:
            continue
        if any(math.hypot(x - px, y - py) < 150 for px, py in seen.get(name, [])):
            continue
        seen.setdefault(name, []).append((x, y))
        count[cat] = count.get(cat, 0) + 1
        out.append([int(round(x)), int(round(y)), cat, name])
    return out

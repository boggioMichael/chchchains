"""Checks regions.py on a made-up country (no downloads): land east of a coast, a lake, a hill, a highway and a town,
a boundary line inside the country (the Green Line layer) and one along its edge.

    python tools/map/test_regions.py
"""
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import build  # noqa: E402
import regions  # noqa: E402


def main():
    build.OUT = tempfile.mkdtemp()
    region = dict(id='test-region', he='ארץ בדיקה', subtitle='בדיקה', lat=31.5, lon=35.0, scale=50, half=40_000,
                  zoom=9, sat_zoom=8, names=[(35.1, 31.6, 'הגליל של בדיקה', 0)])
    sc = regions.Scaled(region)
    ll = lambda x, y: [float(v) for v in sc.lonlat(x, y)]  # noqa: E731  (map units → lon/lat)
    box = lambda x0, y0, x1, y1: [[ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]]  # noqa: E731
    feature = lambda geom, **props: {'type': 'Feature', 'geometry': geom, 'properties': props}  # noqa: E731
    ne = {
        # Land east of x = -300 (the sea to the west), a lake at (200, 200).
        'ne_10m_land': [feature({'type': 'Polygon', 'coordinates': box(-300, -2000, 2000, 2000)})],
        'ne_10m_lakes': [feature({'type': 'Polygon', 'coordinates': box(150, 150, 260, 260)}, name='אגם')],
        'ne_10m_rivers_lake_centerlines': [],
        'ne_10m_admin_0_boundary_lines_land': [
            feature({'type': 'LineString', 'coordinates': [ll(100, -600), ll(100, 600)]}, adm0_left='Israel', adm0_right='Palestine'),
            feature({'type': 'LineString', 'coordinates': [ll(-300, 500), ll(600, 500)]}, adm0_left='Israel', adm0_right='Lebanon'),
        ],
        # The West Bank of this made-up country, which OSM keeps apart: x in [600, 900].
        'ne_10m_admin_0_countries': [feature({'type': 'Polygon', 'coordinates': box(600, -400, 900, 300)}, ADM0_A3='PSX', ADMIN='Palestine')],
        'ne_10m_populated_places': [],
        'ne_10m_roads': [],
    }
    for layer in list(ne):  # as natural_earth() gives them
        for f in ne[layer]:
            f['properties'] = {k.lower(): v for k, v in f['properties'].items()}
    # The country: OSM's national outline covers x in [-600, 600], y in [-700, 500] (the sea side is cut off).
    bounds = {'ישראל': [('2', [box(-600, -700, 600, 500)])], 'Egypt': [('2', [[[[25, 22], [35, 22], [35, 31], [25, 31], [25, 22]]]])]}
    osm = [
        feature({'type': 'LineString', 'coordinates': [ll(-250, y) for y in range(-650, 451, 50)]}, highway='motorway', ref='6'),
        feature({'type': 'LineString', 'coordinates': [ll(x, 0) for x in range(-250, 551, 50)]}, highway='secondary'),
        feature({'type': 'LineString', 'coordinates': [ll(0, -600), ll(0, 400)]}, railway='rail'),
        feature({'type': 'LineString', 'coordinates': [ll(400, -600), ll(420, 400)]}, waterway='river', name='נהר'),
        feature({'type': 'Point', 'coordinates': ll(300, -300)}, place='city', name='עיר גדולה', population='250000'),
        feature({'type': 'Point', 'coordinates': ll(-100, 300)}, place='town', **{'name:he': 'עיירה'}),
        feature({'type': 'Point', 'coordinates': ll(1500, 1500)}, place='town', name='רחוקה'),
    ]
    hill = lambda lon, lat: 400 * np.exp(-(((np.asarray(lon) - 35.03) / 0.03) ** 2 + ((np.asarray(lat) - 31.49) / 0.03) ** 2))  # noqa: E731
    picture = lambda lon, lat: np.stack([np.full(np.shape(lon), 90.0), np.full(np.shape(lon), 120.0), np.full(np.shape(lon), 60.0)], -1)  # noqa: E731
    entry = regions.build_region(region, ne, osm, bounds, elevation=hill, satellite=picture)
    data = json.load(open(os.path.join(build.OUT, 'test-region.json'), encoding='utf-8'))
    # The arena is the country on land: x from -300 (the coast) to 600, y from -700 to 500 → 900 × 1200 units, and
    # the West Bank beside it: 300 × 700.
    area_units = sum(data['arena']['rle'][1::2]) * data['arena']['cell'] ** 2
    want = 900 * 1200 + 300 * 700
    assert abs(area_units - want) / want < 0.05, area_units
    assert sum(data['arena']['rle']) == data['arena']['n'] ** 2
    assert abs(data['area'] - want * 50 * 50 / 1e6) < 170, data['area']
    assert entry['capacity'] == 50 and entry['kind'] == 'region' and entry['sat'] and data['satellite']['image'] == 'test-region-sat.jpg'
    assert data['sea'] and data['water'] and data['rivers'] and data['rail'] and data['roads'][0] and data['roads'][1]
    assert [lab[4] for lab in data['labels']][:1] == ['כביש 6'], data['labels']
    assert sorted(p[3] for p in data['places']) == ['עיירה', 'עיר גדולה'], data['places']
    assert data['places'][0][3] == 'עיר גדולה' and data['places'][0][2] == 0, 'the big city first'
    assert len(data['hubs']) == 2 and data['hubs'][0][2] > data['hubs'][1][2], data['hubs']
    # The Green Line stays inside the country; the Lebanese border only runs along its edge.
    green = [v for line in data['lines']['green'] for v in line]
    assert green and all(abs(green[i] - 100) < 3 for i in range(0, len(green), 2)), green
    assert all(-640 <= green[i + 1] <= 485 for i in range(0, len(green), 2)), green
    border = [v for line in data['lines']['borders'] for v in line]
    assert border and all(abs(border[i + 1] - 500) < 3 for i in range(0, len(border), 2)), border
    assert data['contours']['lines'] and data['elevation'][1] > 150, data['elevation']
    assert data['names'][0][2] == 'הגליל של בדיקה'
    for name in ('test-region.jpg', 'test-region-sat.jpg'):
        assert os.path.getsize(os.path.join(build.OUT, name)) > 3000, name
    # The promise: the region polygon is what it says.
    assert regions.REGIONS[1]['id'] == 'promise' and len(regions.PROMISE) > 20
    assert regions.stale(set(), {}) == regions.REGIONS and regions.stale({'israel'}, {}) == regions.REGIONS[:1]
    print('ok', json.dumps(entry, ensure_ascii=False))


if __name__ == '__main__':
    main()

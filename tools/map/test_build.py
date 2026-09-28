"""Checks build.py on a made-up city (no downloads): a hill by the sea, streets, a park and neighbourhoods.

    python tools/map/test_build.py
"""
import json
import math
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import build  # noqa: E402


def main():
    tmp = tempfile.mkdtemp()
    build.OUT = tmp
    city = dict(id='test-city', he='עיר בדיקה', lat=32.07, lon=34.78, R=3200)
    proj = build.Projection(city['lat'], city['lon'])

    # Elevation: sea west of x = -1500 m, a 120 m hill around (1200, -800).
    E = city['R'] + build.MARGIN
    n = int(round(2 * E / build.GRID)) + 1
    xs = -E + np.arange(n) * build.GRID
    X, Y = np.meshgrid(xs, xs)
    land = np.clip((X + 1500) / 400, 0, 1)
    hill = 120 * np.exp(-((X - 1200) ** 2 + (Y + 800) ** 2) / (2 * 900 ** 2))
    grid = np.where(X < -1500, -5.0, 3 + 20 * land + hill) + np.random.default_rng(1).normal(0, 2, X.shape)

    def ll(x, y):
        return list(proj.lonlat(x, y))

    features = []
    for k in range(-6, 7):  # a street grid, some named
        y = k * 250
        line = [ll(x, y) for x in range(-1400, 3000, 100)]
        features.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': line},
                         'properties': {'highway': 'residential', 'name:he': f'רחוב {k + 7}'}})
    for part in range(4):  # a main road split into four OSM ways
        pts = [ll(-1300 + part * 1000 + d, 40) for d in range(0, 1001, 50)]
        features.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': pts},
                         'properties': {'highway': 'primary', 'name': 'דרך בדיקה'}})
    features.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': [ll(0, -3000), ll(0, 3000)]},
                     'properties': {'railway': 'light_rail'}})
    # The coastline runs north to south along x = -1500 with a small bump; walking it, land is on the left (east).
    coast = [ll(-1500 + (200 if -300 < y < 300 else 0), y) for y in range(-3700, 3701, 100)]
    features.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coast},
                     'properties': {'natural': 'coastline'}})
    park = [ll(500 + 300 * math.cos(a / 10), 900 + 200 * math.sin(a / 10)) for a in range(63)]
    features.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [park + [park[0]]]},
                     'properties': {'leisure': 'park', 'name': 'גן'}})
    pool = [ll(10, 10), ll(20, 10), ll(20, 20), ll(10, 10)]
    features.append({'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [pool]},
                     'properties': {'leisure': 'swimming_pool', 'natural': 'water', 'water': 'swimming_pool'}})
    for i, (name, place) in enumerate([('שכונה א', 'neighbourhood'), ('רובע ב', 'suburb'), ('English only', 'suburb')]):
        features.append({'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': ll(-600 + i * 900, -1200)},
                         'properties': {'place': place, 'name': name}})

    stats = build.build_city(city, features, (grid, E))
    data = json.load(open(os.path.join(tmp, 'test-city.json'), encoding='utf-8'))
    assert os.path.getsize(os.path.join(tmp, 'test-city.jpg')) > 5000
    assert 0.15 < stats['sea'] < 0.45, stats
    assert data['sea'] and all(len(r) >= 8 for r in data['sea'])
    xs_sea = [r[i] for r in data['sea'] for i in range(0, len(r), 2)]
    assert min(xs_sea) < -3000 and max(xs_sea) < -1300, 'the sea stays west'
    assert data['contours']['step'] in (5, 10, 20, 25), data['contours']['step']
    heights = {h for h, _ in data['contours']['lines']}
    assert max(heights) >= 100 and min(heights) >= 5, heights
    assert len(data['roads'][0]) >= 4 and len(data['roads'][2]) == 13
    assert all(abs(v) <= 3500 for road in data['roads'][2] for v in road), 'clipped to the square'
    assert len(data['rail']) == 1 and len(data['green']) == 1 and not data['water'], 'pools are skipped'
    names = [lab[4] for lab in data['labels']]
    assert names.count('דרך בדיקה') >= 2, 'the split main road is merged and labelled along its length'
    assert all(abs(lab[2]) <= 900 for lab in data['labels']), 'labels never upside down'
    assert sorted(p[3] for p in data['places']) == ['רובע ב', 'שכונה א'], 'only Hebrew names'
    print('ok', json.dumps(stats, ensure_ascii=False))


if __name__ == '__main__':
    main()

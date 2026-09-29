// The streets in 3D: triangles for roofs, walls that face out, streets split between tiles, and a walker who stays
// out of buildings and the sea — on a real city (Tel Aviv's map files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CityMap } from '../src/map.js';
import {
  TILE, triangulate, signedArea2, cleanRing, inRing, Packer, addBuilding, addRibbon, lookOf, guessHeight, streetCity,
  personModel, treeModel, KIND, STYLE, ROADS,
} from '../src/street3d.js';

const MAPS = new URL('../docs/maps/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, MAPS), 'utf8'));

/** Sum of the triangles' areas. */
function trisArea(p, tris) {
  let a = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [i, j, k] = [tris[t], tris[t + 1], tris[t + 2]];
    a += Math.abs((p[2 * j] - p[2 * i]) * (p[2 * k + 1] - p[2 * i + 1]) - (p[2 * j + 1] - p[2 * i + 1]) * (p[2 * k] - p[2 * i])) / 2;
  }
  return a;
}

/** The vertices of a packed mesh (8 floats + 4 bytes each), as objects. */
function vertices(mesh) {
  const f = new Float32Array(mesh.data);
  const u = new Uint8Array(mesh.data);
  const per = mesh.stride / 4;
  const out = [];
  for (let i = 0; i < mesh.vertices; i++) {
    const o = i * per;
    out.push({ x: f[o], y: f[o + 1], z: f[o + 2], nx: f[o + 3], ny: f[o + 4], nz: f[o + 5], u: f[o + 6], v: f[o + 7], flags: u[i * mesh.stride + 35] });
  }
  return out;
}

/** The normal a triangle's corner order gives it (right-handed, as WebGL's front faces). */
function faceNormal(a, b, c) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

test('roofs: any simple ring becomes triangles that cover it exactly, even rings OSM gets a little wrong', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(triangulate(square).length, 6);
  const L = [0, 0, 20, 0, 20, 8, 8, 8, 8, 20, 0, 20]; // an L: one corner turns in
  const tl = triangulate(L);
  assert.equal(tl.length, 12);
  assert.ok(Math.abs(trisArea(L, tl) - Math.abs(signedArea2(L)) / 2) < 1e-6, 'covers the L, nothing more');
  const back = [0, 20, 8, 20, 8, 8, 20, 8, 20, 0, 0, 0]; // the same L the other way round
  assert.ok(Math.abs(trisArea(back, triangulate(back)) - 256) < 1e-6);
  // A ring that crosses itself still gets triangles, and repeated points are dropped first.
  assert.ok(triangulate([0, 0, 10, 10, 10, 0, 0, 10]).length >= 6);
  assert.deepEqual(cleanRing([0, 0, 5, 0, 5, 0, 5, 5, 0, 0]), [0, 0, 5, 0, 5, 5]);
  assert.ok(inRing(square, 5, 5) && !inRing(square, 15, 5));
});

test('a building: walls face out, the roof faces up, and window bays fit its walls', () => {
  for (const ring of [
    [0, 0, 12, 0, 12, 9, 0, 9],
    [0, 9, 12, 9, 12, 0, 0, 0],
  ]) {
    const P = new Packer(8);
    addBuilding(P, ring, 0, 13.4, [230, 225, 215], STYLE.punched, true, 5);
    const mesh = P.done();
    const V = vertices(mesh);
    const idx = mesh.index;
    let walls = 0;
    let roofs = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [V[idx[t]], V[idx[t + 1]], V[idx[t + 2]]];
      const n = faceNormal(a, b, c);
      const dot = n[0] * a.nx + n[1] * a.ny + n[2] * a.nz;
      assert.ok(dot > 0, 'the corners go round the way the face looks');
      if (a.flags & 4) {
        roofs++;
        assert.equal(a.ny, 1);
      } else {
        walls++;
        // Out of the building: from the middle of the footprint towards the wall.
        const mx = (a.x + b.x + c.x) / 3 - 6;
        const mz = (a.z + b.z + c.z) / 3 - 4.5;
        assert.ok(mx * a.nx + mz * a.nz > 0, 'faces out');
      }
      assert.equal(a.flags & 8, 8, 'shop fronts');
      assert.equal(a.flags >> 4, 5);
    }
    assert.equal(walls, 8);
    assert.equal(roofs, 2);
    const us = V.filter((v) => !(v.flags & 4)).map((v) => v.u);
    assert.deepEqual([...new Set(us)].sort((a, b) => a - b), [0, 3, 4], '12 m: four bays; 9 m: three');
    assert.equal(Math.max(...V.map((v) => v.y)), Math.fround(13.4));
  }
  // A roof on pillars is a slab, with an underside.
  const P = new Packer(8);
  addBuilding(P, [0, 0, 6, 0, 6, 6, 0, 6], 4.3, 5, [200, 200, 200], STYLE.none, false, 0);
  const V = vertices(P.done());
  assert.ok(V.some((v) => v.ny === -1) && Math.min(...V.map((v) => v.y)) === Math.fround(4.3));
});

test('heights: what OSM says, or a guess that stays the same; towers get glass, sheds no windows', () => {
  const ring = [100, 100, 130, 100, 130, 125, 100, 125];
  assert.equal(lookOf(ring, 250 + KIND.flats).top, 25);
  const guess = lookOf(ring, 0).top;
  assert.equal(lookOf(ring, 0).top, guess);
  assert.ok(guess > 9 && guess < 20, guess);
  assert.equal(lookOf(ring, 1200 + KIND.commerce).style === STYLE.glass || lookOf(ring, 1200 + KIND.commerce).style === STYLE.bands, true);
  assert.equal(lookOf(ring, KIND.industry).style, STYLE.none);
  const canopy = lookOf(ring, KIND.canopy);
  assert.ok(canopy.base > 2 && canopy.top - canopy.base < 1);
  assert.ok(guessHeight(20, KIND.flats, 0.5) < 5, 'a small shed');
  assert.ok(guessHeight(300, KIND.house, 0.99) < 8, 'a house has one or two floors');
});

test('a street crossing two tiles is drawn once, each segment in the tile of its middle, with pavements', () => {
  const line = [10, 50, 150, 50, 190, 50];
  const left = new Packer(6);
  const right = new Packer(6);
  addRibbon(left, line, 3.6, 2, 6, 0, 0, [0, 0, TILE, TILE]);
  addRibbon(right, line, 3.6, 2, 6, 0, 0, [TILE, 0, 2 * TILE, TILE]);
  // The first segment (middle at x = 80: 143.6 m with its end reaching over the junction, in six pieces of at most
  // 24 m), and the second (middle at x = 170: 43.6 m, two pieces).
  assert.equal(left.done().count, 6 * 6);
  assert.equal(right.done().count, 2 * 6);
  const f = new Float32Array(left.done().data); // 7 slots a corner: 6 numbers and 4 bytes
  // Corners of the first segment: 3.6 m either side of y = 50, reaching 3.6 m before the start.
  const ys = [f[1], f[8]].sort((a, b) => a - b);
  assert.deepEqual(ys, [46.4, 53.6].map((v) => Math.fround(v)));
  assert.ok(Math.abs(f[0] - (10 - 3.6)) < 1e-4 && f[2] < 0, 'the end reaches over the junction');
  // A corner keeps its width: the mitre.
  const bend = new Packer(6);
  addRibbon(bend, [0, 0, 20, 0, 20, 20], 2, 2, 6, 0, 0, [-50, -50, 50, 50]);
  const g = new Float32Array(bend.done().data);
  const corner = [[g[28], g[29]], [g[35], g[36]]]; // the second segment's first two corners (at the bend)
  const d = corner.map(([x, y]) => Math.hypot(x - 20, y));
  assert.ok(d.every((v) => Math.abs(v - 2 * Math.SQRT2) < 1e-3), d);
});

test('Tel Aviv in 3D: a tile of buildings, streets and trees; the walker stays out of buildings and the sea', () => {
  const map = new CityMap(json('tel-aviv.json'), null);
  map.addDetail(json('tel-aviv-detail.json'));
  const buildings = map.features.filter((f) => f.layer === 'building');
  assert.ok(buildings.length > 10000);
  assert.equal(buildings[5].extra, 5, 'each building knows its place in the file');
  // Heights from a 3D file of the right length are used; a stale one (another length) is not.
  const n = buildings[buildings.length - 1].extra + 1;
  const tall = streetCity(map, { n, h: Array(n).fill(310), t: [] });
  assert.ok(tall.heights);
  assert.equal(streetCity(map, { n: n + 1, h: [], t: [] }).heights, null);
  const city = streetCity(map, null);
  // The middle of town.
  const t = city.tile(0, 0);
  assert.ok(t.buildings.count > 300 && t.roads.count > 150, `${t.buildings.count} ${t.roads.count}`);
  for (const mesh of [t.buildings, t.roads]) {
    let max = 0;
    for (const i of mesh.index) max = Math.max(max, i);
    assert.ok(max < mesh.vertices);
  }
  assert.ok(t.trees.length / 4 > 20, `${t.trees.length / 4} trees`);
  for (let i = 0; i < t.trees.length; i += 4) {
    assert.ok(t.trees[i] >= 0 && t.trees[i] < TILE && t.trees[i + 1] >= 0 && t.trees[i + 1] < TILE);
    assert.equal(city.buildingAt(t.trees[i], t.trees[i + 1]), null, 'no tree inside a house');
  }
  const again = city.tile(0, 0);
  assert.deepEqual(again.trees, t.trees, 'the same trees every time');
  // Walking into a wall: the walker slides along it and never ends up inside.
  const b = buildings.find((f) => Math.abs(f.x0) < 300 && Math.abs(f.y0) < 300 && f.x1 - f.x0 > 12);
  const ring = b.geom[0];
  const cx = (b.x0 + b.x1) / 2;
  let x = b.x0 - 4;
  let y = (b.y0 + b.y1) / 2;
  if (city.buildingAt(x, y, 0.4)) [x, y] = [b.x0 - 8, y];
  for (let k = 0; k < 120; k++) {
    [x, y] = city.move(x, y, 0.15, 0.02);
    assert.ok(!city.buildingAt(x, y), `step ${k}: inside a building`);
  }
  assert.ok(!inRing(ring, x, y) && x < cx);
  // The sea: west of the beach.
  let sx = -3500;
  const sy = 0;
  assert.ok(city.inSea(sx, sy), 'the sea is to the west');
  while (city.inSea(sx, sy)) sx += 5;
  const [wx] = city.move(sx + 3, sy, -8, 0);
  assert.ok(!city.inSea(wx, sy) && wx > sx - 5, 'no walking into the sea');
});

test('the models: a person and a tree, closed and facing out', () => {
  for (const [model, centre] of [
    [personModel(), null],
    [treeModel(), null],
  ]) {
    assert.equal(model.length % 21, 0, 'whole triangles of 7 floats a corner');
    for (let i = 0; i < model.length; i += 21) {
      const a = { x: model[i], y: model[i + 1], z: model[i + 2] };
      const b = { x: model[i + 7], y: model[i + 8], z: model[i + 9] };
      const c = { x: model[i + 14], y: model[i + 15], z: model[i + 16] };
      const n = faceNormal(a, b, c);
      assert.ok(n[0] * model[i + 3] + n[1] * model[i + 4] + n[2] * model[i + 5] > 0, 'corner order agrees with the normal');
    }
    void centre;
  }
  const ys = [];
  const p = personModel();
  for (let i = 1; i < p.length; i += 7) ys.push(p[i]);
  assert.ok(Math.max(...ys) > 1.7 && Math.max(...ys) < 1.8 && Math.min(...ys) === 0);
  assert.ok(ROADS.road0.half > ROADS.road1.half && ROADS.road1.half > ROADS.road2.half);
});

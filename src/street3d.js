// Ch-ch-chain-ges — the streets in 3D. Turns a city's map (its buildings and their heights, streets and pavements,
// paths, railways, parks and trees) into meshes for the street view (walk.js), in square tiles built on demand around
// the walker, and keeps the walker out of buildings and the sea. No DOM and no WebGL here: typed arrays only, so the
// tests run it in Node.
//
// Map units are metres: x to the east, y to the south. In 3D, x stays, height is y (up) and the map's y is z.

export const TILE = 160; // metres a side
export const FLOOR = 3.1; // metres a floor, as in the map builder
export const SKYLINE = 36; // buildings this tall are seen from all over town (not in the tiles)

// ------------------------------------------------------------------------------------------------ small helpers
/** A number in [0, 1) that is always the same for the same place. */
export function hash2(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** A seeded random stream (mulberry32), so a tile's trees come out the same every time. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** '#rrggbb' → [r, g, b] (0–255). */
export function rgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Twice the signed area of a flat ring [x0, y0, x1, y1, …]. */
export function signedArea2(p) {
  let a = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return a;
}

/** The ring without its closing point, and without a point repeated right after itself. */
export function cleanRing(p) {
  const out = [];
  for (let i = 0; i + 1 < p.length; i += 2) {
    const n = out.length;
    if (n && Math.abs(out[n - 2] - p[i]) < 0.01 && Math.abs(out[n - 1] - p[i + 1]) < 0.01) continue;
    out.push(p[i], p[i + 1]);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < 0.01 && Math.abs(out[1] - out[out.length - 1]) < 0.01) out.length -= 2;
  return out;
}

/** Is (x, y) inside the ring (flat, open or closed)? */
export function inRing(p, x, y) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const yi = p[i + 1];
    const yj = p[j + 1];
    if (yi > y !== yj > y && x < ((p[j] - p[i]) * (y - yi)) / (yj - yi) + p[i]) inside = !inside;
  }
  return inside;
}

/** The point of the ring's outline nearest (x, y): [qx, qy, distance, edge start index]. */
export function nearestOnRing(p, x, y) {
  let best = [p[0], p[1], Infinity, 0];
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const ax = p[j];
    const ay = p[j + 1];
    const dx = p[i] - ax;
    const dy = p[i + 1] - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const qx = ax + dx * t;
    const qy = ay + dy * t;
    const d = Math.hypot(x - qx, y - qy);
    if (d < best[2]) best = [qx, qy, d, j];
  }
  return best;
}

/** Distance from (x, y) to the polyline (flat, open). */
export function distToLine(p, x, y) {
  let best = Infinity;
  for (let i = 2; i + 1 < p.length; i += 2) {
    const ax = p[i - 2];
    const ay = p[i - 1];
    const dx = p[i] - ax;
    const dy = p[i + 1] - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

/**
 * Triangles for a simple polygon (a flat ring, open): index triples in the ring's own turning direction. Ear
 * clipping; a ring that is not quite simple (OSM has a few) still gets triangles: a fan of whatever is left when no
 * ear can be cut.
 */
export function triangulate(p) {
  const n = p.length >> 1;
  if (n < 3) return [];
  const sgn = signedArea2(p) >= 0 ? 1 : -1;
  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n;
    next[i] = (i + 1) % n;
  }
  const turn = (a, b, c) => sgn * ((p[2 * b] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * b + 1] - p[2 * a + 1]) * (p[2 * c] - p[2 * a]));
  const same = (a, b) => p[2 * a] === p[2 * b] && p[2 * a + 1] === p[2 * b + 1];
  const out = [];
  let left = n;
  let i = 0;
  let stall = 0;
  while (left > 3 && stall < left) {
    const a = prev[i];
    const c = next[i];
    let ear = turn(a, i, c) > 1e-9;
    for (let q = next[c]; ear && q !== a; q = next[q]) {
      if (same(q, a) || same(q, i) || same(q, c)) continue;
      if (turn(a, i, q) >= 0 && turn(i, c, q) >= 0 && turn(c, a, q) >= 0) ear = false;
    }
    if (ear) {
      out.push(a, i, c);
      next[a] = c;
      prev[c] = a;
      left--;
      i = a;
      stall = 0;
    } else {
      i = next[i];
      stall++;
    }
  }
  for (let q = next[i]; next[q] !== i; q = next[q]) out.push(i, q, next[q]);
  return out;
}

// ------------------------------------------------------------------------------------------------ packing
/** Interleaved vertices: `floats` 32-bit numbers, then 4 bytes, per vertex; and 16- or 32-bit indices. */
export class Packer {
  constructor(floats) {
    this.floats = floats;
    this.stride = floats * 4 + 4;
    this.cap = 256;
    this.buf = new ArrayBuffer(this.stride * this.cap);
    this.f = new Float32Array(this.buf);
    this.u = new Uint8Array(this.buf);
    this.n = 0;
    this.index = [];
  }
  /** Room for one more vertex; returns its float offset. */
  next() {
    if (this.n === this.cap) {
      this.cap *= 2;
      const buf = new ArrayBuffer(this.stride * this.cap);
      new Uint8Array(buf).set(this.u);
      this.buf = buf;
      this.f = new Float32Array(buf);
      this.u = new Uint8Array(buf);
    }
    return (this.n * this.stride) >> 2;
  }
  bytes(b0, b1, b2, b3) {
    const o = this.n * this.stride + this.floats * 4;
    this.u[o] = b0;
    this.u[o + 1] = b1;
    this.u[o + 2] = b2;
    this.u[o + 3] = b3;
    return this.n++;
  }
  done() {
    const count = this.index.length;
    return {
      data: this.buf.slice(0, this.n * this.stride),
      index: this.n > 65535 ? Uint32Array.from(this.index) : Uint16Array.from(this.index),
      count,
      vertices: this.n,
      stride: this.stride,
    };
  }
}

// ------------------------------------------------------------------------------------------------ buildings
/**
 * What the map builder calls a building's kind (the 3D file's height × 10 + kind): 0 flats and anything else, 1 a
 * house, 2 industry and storage, 3 a roof on pillars, 4 a place of worship, 5 shops and offices, 6 public.
 */
export const KIND = { flats: 0, house: 1, industry: 2, canopy: 3, worship: 4, commerce: 5, public: 6 };

/** Windows: punched in the wall (homes), long bands (offices), a glass wall (towers), none. */
export const STYLE = { punched: 0, bands: 1, glass: 2, none: 3 };

/** A building's height when OSM does not say: from its size and kind, the same every time (r: hash of its place). */
export function guessHeight(area, kind, r) {
  switch (kind) {
    case KIND.house:
      return 3.8 + FLOOR * Math.floor(r * 2);
    case KIND.industry:
      return 5.5 + r * 5;
    case KIND.canopy:
      return 5;
    case KIND.worship:
      return 8 + r * 6;
    case KIND.commerce:
    case KIND.public:
      return FLOOR * (2 + Math.floor(r * 3)) + 1.2;
    default:
      if (area < 45) return 3 + r;
      if (area < 140) return 4 + FLOOR * Math.floor(r * 2);
      if (area > 2500) return FLOOR * (2 + Math.floor(r * 3)) + 1.2;
      return FLOOR * (3 + Math.floor(r * 3)) + 1.5; // three to five floors: the blocks of flats most streets have
  }
}

/** Plaster and whitewash; Jerusalem stone; glass; industry. */
export const PALETTES = {
  plaster: ['#f1eee7', '#ebe5d9', '#e6dfd1', '#f4f0e8', '#ddd7cb', '#e8ddcf', '#e2e0d8', '#efe6d6', '#d9d6ce', '#e9e3db'],
  stone: ['#e8dab9', '#ddcba5', '#eadcc0', '#d9c8a5', '#efe3c7', '#e3d2ad', '#d6c39e'],
  glass: ['#8ea8be', '#7d98af', '#9db2c3', '#a8b9c4', '#86a0b6'],
  industry: ['#c9c9c4', '#bfc3c5', '#d3d0c8', '#c4bdb2', '#b8bcbf'],
};
const PAL = Object.fromEntries(Object.entries(PALETTES).map(([k, list]) => [k, list.map(rgb)]));

/**
 * Walls and roofs for a list of buildings into a Packer of 8 floats (x, y, z, nx, ny, nz, u, v) and 4 bytes (r, g,
 * b, flags). On a wall, u counts window bays along it (−1: too short for one) and v is the height in metres; on a
 * roof, u and v are the map position. Flags: the window style (bits 0–1), roof (bit 2), shop fronts (bit 3), and a
 * number for small differences between buildings (bits 4–7).
 */
export function addBuilding(P, ring, base, top, color, style, shops, variant) {
  const p = cleanRing(ring);
  if (p.length < 6) return;
  // Walls go round the ring one way, so every wall faces out and every roof triangle faces up (see below).
  if (signedArea2(p) > 0) {
    for (let i = 0, j = p.length - 2; i < j; i += 2, j -= 2) {
      [p[i], p[j]] = [p[j], p[i]];
      [p[i + 1], p[j + 1]] = [p[j + 1], p[i + 1]];
    }
  }
  const [r, g, b] = color;
  const flags = (style & 3) | (shops ? 8 : 0) | ((variant & 15) << 4);
  const put = (x, y, z, nx, ny, nz, u, v, fl) => {
    const o = P.next();
    const F = P.f;
    F[o] = x;
    F[o + 1] = y;
    F[o + 2] = z;
    F[o + 3] = nx;
    F[o + 4] = ny;
    F[o + 5] = nz;
    F[o + 6] = u;
    F[o + 7] = v;
    return P.bytes(r, g, b, fl);
  };
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const ax = p[2 * i];
    const ay = p[2 * i + 1];
    const bx = p[(2 * i + 2) % p.length];
    const by = p[(2 * i + 3) % p.length];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy);
    if (L < 0.05) continue;
    // With the ring turning this way, (−dy, dx) points out of the building.
    const nx = -dy / L;
    const nz = dx / L;
    const bays = Math.floor(L / 2.9);
    // A long wall in pieces of at most 30 m: very long triangles lose precision on some phones.
    const pieces = Math.ceil(L / 30);
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces;
      const t1 = (k + 1) / pieces;
      const u0 = bays >= 1 ? bays * t0 : -1;
      const u1 = bays >= 1 ? bays * t1 : -1;
      const x0 = ax + dx * t0;
      const y0 = ay + dy * t0;
      const x1 = ax + dx * t1;
      const y1 = ay + dy * t1;
      const a0 = put(x0, base, y0, nx, 0, nz, u0, base, flags);
      const b0 = put(x1, base, y1, nx, 0, nz, u1, base, flags);
      const b1 = put(x1, top, y1, nx, 0, nz, u1, top, flags);
      const a1 = put(x0, top, y0, nx, 0, nz, u0, top, flags);
      P.index.push(a0, b0, b1, a0, b1, a1);
    }
  }
  // The roof: triangles turning the same way as the ring face up; any that do not (a fan over a ring that crosses
  // itself) are turned over.
  const tris = triangulate(p);
  const first = P.n;
  for (let i = 0; i < n; i++) put(p[2 * i], top, p[2 * i + 1], 0, 1, 0, p[2 * i], p[2 * i + 1], flags | 4);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b2, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const cross = (p[2 * b2] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * b2 + 1] - p[2 * a + 1]) * (p[2 * c] - p[2 * a]);
    if (Math.abs(cross) < 1e-9) continue;
    if (cross < 0) P.index.push(first + a, first + b2, first + c);
    else P.index.push(first + a, first + c, first + b2);
  }
  // A roof on pillars is a slab: seen from below too.
  if (base > 0.5) {
    const under = P.n;
    for (let i = 0; i < n; i++) put(p[2 * i], base, p[2 * i + 1], 0, -1, 0, p[2 * i], p[2 * i + 1], flags | 4);
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b2, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const cross = (p[2 * b2] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * b2 + 1] - p[2 * a + 1]) * (p[2 * c] - p[2 * a]);
      if (Math.abs(cross) < 1e-9) continue;
      if (cross < 0) P.index.push(under + a, under + c, under + b2);
      else P.index.push(under + a, under + b2, under + c);
    }
  }
}

/** How one building looks: { base, top, color, style, shops, variant }. hk: the 3D file's height × 10 + kind. */
export function lookOf(ring, hk, { stone = false, shopsNear = () => false } = {}) {
  const r = hash2(ring[0], ring[1]);
  const area = Math.abs(signedArea2(ring)) / 2;
  const known = Math.floor((hk || 0) / 10);
  const kind = (hk || 0) % 10;
  let top = known > 0 ? known : guessHeight(area, kind, r);
  let base = 0;
  if (kind === KIND.canopy) {
    top = known > 0 ? known : 5;
    base = Math.max(2.5, top - 0.7);
  }
  const variant = Math.floor(r * 16);
  const pick = (list) => list[Math.floor(hash2(ring[1], ring[0]) * list.length) % list.length];
  let style = STYLE.punched;
  let color = pick(stone ? PAL.stone : PAL.plaster);
  if (kind === KIND.industry || kind === KIND.canopy) {
    style = STYLE.none;
    color = pick(PAL.industry);
  } else if (top > 34 || (kind === KIND.commerce && area > 1500)) {
    style = r < 0.55 ? STYLE.glass : STYLE.bands;
    color = style === STYLE.glass ? pick(PAL.glass) : pick(PAL.plaster);
  } else if (kind === KIND.commerce || kind === KIND.public) {
    style = r < 0.5 ? STYLE.bands : STYLE.punched;
  } else if (kind === KIND.worship) {
    color = pick(PAL.stone);
  }
  const shops = kind !== KIND.industry && kind !== KIND.canopy && top < 60 && (kind === KIND.commerce || shopsNear(ring));
  return { base, top, color, style, shops, variant };
}

// ------------------------------------------------------------------------------------------------ streets
/**
 * The street layers, bottom to top. half: half the width of the asphalt (or path); walk: the pavement on each side.
 * The layer lifts it over the ones under it by a hair (in the shader), so tiles may be drawn in any order.
 */
export const ROADS = {
  road0: { cls: 0, half: 7.5, walk: 3.5, layer: 8 },
  road1: { cls: 1, half: 5.5, walk: 3, layer: 7 },
  road2: { cls: 2, half: 3.6, walk: 2.4, layer: 6 },
  lane: { cls: 3, half: 2.3, walk: 0, layer: 5 },
  rail: { cls: 4, half: 1.9, walk: 0, layer: 4 },
  path: { cls: 5, half: 1.1, walk: 0, layer: 3 },
};
export const PAVEMENT = { cls: 6, layer: 2 };
export const ROAD_LAYERS = Object.keys(ROADS);

/**
 * A ribbon along a polyline into a Packer of 6 floats (x, z, along, across, total, half) and 4 bytes (class,
 * layer, kerb paint, inner half width in decimetres): only the segments whose middle lies in the box, so a street
 * crossing several tiles is drawn once. Across is ±1 at the edges; along runs from 0 at the start to total at the
 * end, and a little past each end (the ends reach over the junction, so corners have no gaps).
 */
export function addRibbon(P, line, half, cls, layer, kerb, inner, box) {
  const n = line.length >> 1;
  if (n < 2) return;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(line[2 * i] - line[2 * i - 2], line[2 * i + 1] - line[2 * i - 1]);
  const total = cum[n - 1];
  if (total < 0.5) return;
  // The offset at every point: the mitre between the segments on either side.
  const ox = new Float64Array(n);
  const oy = new Float64Array(n);
  const dir = (i) => {
    const dx = line[2 * i + 2] - line[2 * i];
    const dy = line[2 * i + 3] - line[2 * i + 1];
    const L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  for (let i = 0; i < n; i++) {
    const [ax, ay] = dir(Math.max(0, i - 1));
    const [bx, by] = dir(Math.min(n - 2, i));
    let mx = -ay - by;
    let my = ax + bx;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = -ay;
      my = ax;
    } else {
      mx /= ml;
      my /= ml;
    }
    const k = Math.min(3, 1 / Math.max(0.33, mx * -ay + my * ax));
    ox[i] = mx * k * half;
    oy[i] = my * k * half;
  }
  const ext = Math.min(half, 4);
  const [sx, sy] = dir(0);
  const [ex, ey] = dir(n - 2);
  const put = (x, y, along, across) => {
    const o = P.next();
    const F = P.f;
    F[o] = x;
    F[o + 1] = y;
    F[o + 2] = along;
    F[o + 3] = across;
    F[o + 4] = total;
    F[o + 5] = half;
    return P.bytes(cls, layer, kerb, inner);
  };
  const [x0, y0, x1, y1] = box;
  for (let i = 0; i + 1 < n; i++) {
    let ax = line[2 * i];
    let ay = line[2 * i + 1];
    let bx = line[2 * i + 2];
    let by = line[2 * i + 3];
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    if (mx < x0 || mx >= x1 || my < y0 || my >= y1) continue;
    let al = cum[i];
    let bl = cum[i + 1];
    if (i === 0) {
      ax -= sx * ext;
      ay -= sy * ext;
      al -= ext;
    }
    if (i === n - 2) {
      bx += ex * ext;
      by += ey * ext;
      bl += ext;
    }
    // In pieces of at most 24 m (long triangles lose depth precision on some phones); the pieces in between keep
    // the segment's own width, the ends its mitres.
    const L = Math.hypot(bx - ax, by - ay);
    const pieces = Math.max(1, Math.ceil(L / 24));
    const nx = L > 0 ? (-(by - ay) / L) * half : ox[i];
    const ny = L > 0 ? ((bx - ax) / L) * half : oy[i];
    let p0 = -1;
    let p1 = -1;
    for (let k = 0; k <= pieces; k++) {
      const t = k / pieces;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const qx = k === 0 ? ox[i] : k === pieces ? ox[i + 1] : nx;
      const qy = k === 0 ? oy[i] : k === pieces ? oy[i + 1] : ny;
      const along = al + (bl - al) * t;
      const q0 = put(x + qx, y + qy, along, 1);
      const q1 = put(x - qx, y - qy, along, -1);
      if (k > 0) P.index.push(p0, p1, q1, p0, q1, q0);
      p0 = q0;
      p1 = q1;
    }
  }
}

// ------------------------------------------------------------------------------------------------ the city
/**
 * The street view's city. map: a CityMap with its detail loaded (buildings carry their index in the detail file as
 * `extra`); extra: the 3D file ({ n, h, t }) or null; opts.stone: Jerusalem stone rather than plaster.
 * Returns { tile(tx, ty), move(x, y, dx, dy, r), walkable(x, y, r), buildingAt(x, y), trees(x0, y0, x1, y1) … }.
 */
export function streetCity(map, extra = null, { stone = false } = {}) {
  const heights = extra && Array.isArray(extra.h) && extra.n === countBuildings(map) ? extra.h : null;
  // The mapped trees, in cells of a tile.
  const treeCells = new Map();
  if (extra && Array.isArray(extra.t)) {
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < extra.t.length; i += 2) {
      x = i === 0 ? extra.t[0] : x + extra.t[i];
      y = i === 0 ? extra.t[1] : y + extra.t[i + 1];
      const k = cellKey(Math.floor(x / TILE), Math.floor(y / TILE));
      let list = treeCells.get(k);
      if (!list) treeCells.set(k, (list = []));
      list.push(x, y);
    }
  }
  const SHOPPY = new Set(['food', 'shop', 'bank', 'health', 'hotel']);
  const near = (x0, y0, x1, y1, layer) => map.query(x0, y0, x1, y1).filter((f) => f.layer === layer);
  const inArea = (layer, x, y) => {
    for (const f of map.query(x, y, x, y)) {
      if (f.layer !== layer) continue;
      let odd = false;
      for (const ring of f.geom) if (inRing(ring, x, y)) odd = !odd;
      if (odd) return true;
    }
    return false;
  };
  /** In the sea: inside an odd number of the sea's rings (each its own feature). */
  const inSea = (x, y) => {
    let odd = false;
    for (const f of map.query(x, y, x, y)) if (f.layer === 'sea' && inRing(f.geom[0], x, y)) odd = !odd;
    return odd;
  };
  const buildingAt = (x, y, r = 0) => {
    for (const f of map.query(x - r, y - r, x + r, y + r)) {
      if (f.layer !== 'building') continue;
      const ring = f.geom[0];
      if (inRing(ring, x, y) || (r > 0 && nearestOnRing(ring, x, y)[2] < r)) return f;
    }
    return null;
  };
  const onRoad = (x, y, pad = 0.4) => {
    for (const f of map.query(x - 9, y - 9, x + 9, y + 9)) {
      const st = ROADS[f.layer];
      if (!st || st.cls > 2) continue;
      if (distToLine(f.geom, x, y) < st.half + pad) return true;
    }
    return false;
  };
  const walkable = (x, y) => map.arena.inside(x, y) && !inSea(x, y) && !inArea('water', x, y);
  // Pedestrian streets are in the map's streets and among its paths too: those are paved, with no kerbs.
  let pathEnds = null;
  const pedestrian = (f) => {
    if (!pathEnds) {
      pathEnds = new Set();
      for (const p of map.features || []) {
        if (p.layer !== 'path') continue;
        const g = p.geom;
        pathEnds.add(`${Math.round(g[0])},${Math.round(g[1])},${Math.round(g[g.length - 2])},${Math.round(g[g.length - 1])}`);
        pathEnds.add(`${Math.round(g[g.length - 2])},${Math.round(g[g.length - 1])},${Math.round(g[0])},${Math.round(g[1])}`);
      }
    }
    const g = f.geom;
    return pathEnds.has(`${Math.round(g[0])},${Math.round(g[1])},${Math.round(g[g.length - 2])},${Math.round(g[g.length - 1])}`);
  };

  function tile(tx, ty) {
    const x0 = tx * TILE;
    const y0 = ty * TILE;
    const x1 = x0 + TILE;
    const y1 = y0 + TILE;
    const box = [x0, y0, x1, y1];
    const feats = map.query(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
    // Shops, cafés and the like near a building give it shop fronts.
    const shopsHere = (map.pois || []).filter((p) => SHOPPY.has(p.cat) && p.x > x0 - 60 && p.x < x1 + 60 && p.y > y0 - 60 && p.y < y1 + 60);
    const shopsNear = (ring) => {
      if (!shopsHere.length) return false;
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        bx0 = Math.min(bx0, ring[i]);
        bx1 = Math.max(bx1, ring[i]);
        by0 = Math.min(by0, ring[i + 1]);
        by1 = Math.max(by1, ring[i + 1]);
      }
      return shopsHere.some((p) => p.x > bx0 - 7 && p.x < bx1 + 7 && p.y > by0 - 7 && p.y < by1 + 7);
    };
    const B = new Packer(8);
    let tallest = 0;
    for (const f of feats) {
      if (f.layer !== 'building') continue;
      const ring = f.geom[0];
      if (ring[0] < x0 || ring[0] >= x1 || ring[1] < y0 || ring[1] >= y1) continue; // each building in one tile
      const look = lookOf(ring, heights ? heights[f.extra] : 0, { stone, shopsNear });
      if (look.top >= SKYLINE) continue; // in the skyline instead
      addBuilding(B, ring, look.base, look.top, look.color, look.style, look.shops, look.variant);
      tallest = Math.max(tallest, look.top);
    }
    // Streets: pavements first (under everything), then each kind of street; kerbs painted red-white or blue-white
    // on some streets, as in Israel.
    const R = new Packer(6);
    for (const f of feats) {
      const st = ROADS[f.layer];
      if (!st || !st.walk || (st.cls === 2 && pedestrian(f))) continue;
      const kerb = kerbOf(f.geom, st.cls);
      addRibbon(R, f.geom, st.half + st.walk, PAVEMENT.cls, PAVEMENT.layer, kerb, Math.round(st.half * 10), box);
    }
    for (const layer of ROAD_LAYERS) {
      const st = ROADS[layer];
      for (const f of feats) {
        if (f.layer !== layer) continue;
        if (st.cls === 2 && pedestrian(f)) addRibbon(R, f.geom, st.half, ROADS.path.cls, st.layer, 0, 0, box);
        else addRibbon(R, f.geom, st.half, st.cls, st.layer, 0, 0, box);
      }
    }
    return { tx, ty, box, buildings: B.done(), roads: R.done(), trees: treesIn(box, feats), tallest };
  }

  /** The towers, all over town (seen from afar above the haze): one mesh. */
  function skyline() {
    const B = new Packer(8);
    let n = 0;
    if (heights) {
      for (const f of map.features || []) {
        if (f.layer !== 'building' || Math.floor((heights[f.extra] || 0) / 10) < SKYLINE) continue;
        const ring = f.geom[0];
        const look = lookOf(ring, heights[f.extra], { stone });
        addBuilding(B, ring, look.base, look.top, look.color, look.style, false, look.variant);
        n++;
      }
    }
    return { mesh: B.done(), count: n };
  }

  /** Trees in the box: the mapped ones; where none are mapped, rows along the streets; and groves in the parks. */
  function treesIn(box, feats) {
    const [x0, y0, x1, y1] = box;
    const out = [];
    const rand = seeded(Math.floor(x0) * 73856093 ^ Math.floor(y0) * 19349663);
    const add = (x, y, s) => out.push(x, y, s, Math.floor(rand() * 8));
    const mapped = treeCells.get(cellKey(Math.floor(x0 / TILE), Math.floor(y0 / TILE))) || [];
    for (let i = 0; i < mapped.length; i += 2) {
      if (!buildingAt(mapped[i], mapped[i + 1])) add(mapped[i], mapped[i + 1], 0.8 + rand() * 0.5);
    }
    const free = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1 && !buildingAt(x, y, 2.2) && !onRoad(x, y) && walkable(x, y);
    if (mapped.length < 16) {
      for (const f of feats) {
        const st = ROADS[f.layer];
        if (!st || (st.cls !== 1 && st.cls !== 2)) continue;
        const line = f.geom;
        for (let i = 2; i + 1 < line.length; i += 2) {
          const ax = line[i - 2];
          const ay = line[i - 1];
          const dx = line[i] - ax;
          const dy = line[i + 1] - ay;
          const L = Math.hypot(dx, dy);
          if (L < 20) continue;
          const step = 10 + hash2(ax, ay) * 5;
          for (let d = 8; d < L - 8; d += step) {
            for (const side of [-1, 1]) {
              const off = st.half + 1.2;
              const x = ax + (dx / L) * d - (dy / L) * off * side;
              const y = ay + (dy / L) * d + (dx / L) * off * side;
              if (free(x, y)) add(x, y, 0.75 + rand() * 0.45);
            }
          }
        }
      }
    }
    for (const f of feats) {
      const spacing = f.layer === 'green' ? 11 : f.layer === 'area:forest' ? 7 : 0;
      if (!spacing) continue;
      for (let gy = Math.max(y0, f.y0); gy < Math.min(y1, f.y1); gy += spacing) {
        for (let gx = Math.max(x0, f.x0); gx < Math.min(x1, f.x1); gx += spacing) {
          const x = gx + rand() * spacing * 0.8;
          const y = gy + rand() * spacing * 0.8;
          let odd = false;
          for (const ring of f.geom) if (inRing(ring, x, y)) odd = !odd;
          if (odd && free(x, y) && !nearPath(feats, x, y)) add(x, y, 0.8 + rand() * 0.6);
        }
      }
      if (out.length > 3200) break;
    }
    return Float32Array.from(out.slice(0, 3200));
  }

  /**
   * Moves a walker of radius r from (x, y) by (dx, dy): never into a building (it slides along the wall), the sea,
   * a lake or out of the city. Returns [x, y].
   */
  function move(x, y, dx, dy, r = 0.35) {
    const settle = (px, py) => {
      for (let k = 0; k < 3; k++) {
        let pushed = false;
        for (const f of map.query(px - r - 1, py - r - 1, px + r + 1, py + r + 1)) {
          if (f.layer !== 'building') continue;
          const ring = f.geom[0];
          const inside = inRing(ring, px, py);
          const [qx, qy, d] = nearestOnRing(ring, px, py);
          if (!inside && d >= r) continue;
          if (d < 1e-6) continue;
          const ux = (px - qx) / d;
          const uy = (py - qy) / d;
          const s = inside ? -1 : 1; // inside: out through the nearest wall
          px = qx + ux * s * (r + 0.01);
          py = qy + uy * s * (r + 0.01);
          pushed = true;
        }
        if (!pushed) break;
      }
      return [px, py];
    };
    for (const [mx, my] of [
      [dx, dy],
      [dx, 0],
      [0, dy],
    ]) {
      if (!mx && !my) continue;
      const [px, py] = settle(x + mx, y + my);
      if (walkable(px, py) && !buildingAt(px, py)) return [px, py];
    }
    return [x, y];
  }

  return { map, stone, heights, tile, skyline, move, walkable, buildingAt, onRoad, inSea, pedestrian, trees: treeCells };
}

/**
 * The name of the street at (x, y): the nearest street that has a name label lying along it (a main road built of
 * two carriageways has its label on one of them, so the next-nearest streets are tried too). '' when none is near.
 */
export function streetNamer(map) {
  const cells = new Map();
  for (const l of map.labels || []) {
    const k = cellKey(Math.floor(l.x / 200), Math.floor(l.y / 200));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(l);
  }
  return (x, y) => {
    const near = [];
    for (const f of map.query(x - 25, y - 25, x + 25, y + 25)) {
      const st = ROADS[f.layer];
      if (!st || st.cls > 2) continue;
      const d = distToLine(f.geom, x, y);
      if (d < 25) near.push({ f, d });
    }
    near.sort((a, b) => a.d - b.d);
    const cx = Math.floor(x / 200);
    const cy = Math.floor(y / 200);
    for (const { f, d } of near.slice(0, 3)) {
      if (d > near[0].d + 14) break;
      let name = '';
      let best = Infinity;
      for (let j = cy - 2; j <= cy + 2; j++) {
        for (let i = cx - 2; i <= cx + 2; i++) {
          for (const l of cells.get(cellKey(i, j)) || []) {
            const ld = Math.hypot(l.x - x, l.y - y);
            if (ld < best && distToLine(f.geom, l.x, l.y) < 7) {
              best = ld;
              name = l.text;
            }
          }
        }
      }
      if (name) return name;
    }
    return '';
  };
}

function nearPath(feats, x, y) {
  for (const f of feats) if (f.layer === 'path' && f.x0 - 2 < x && f.x1 + 2 > x && f.y0 - 2 < y && f.y1 + 2 > y && distToLine(f.geom, x, y) < 1.6) return true;
  return false;
}

/** Kerb paint along a street: 0 plain, 1 red and white (no stopping), 2 blue and white (paid parking). */
function kerbOf(line, cls) {
  const r = hash2(line[0] * 0.37, line[1] * 0.61);
  if (cls === 0) return r < 0.7 ? 1 : 0;
  if (cls === 1) return r < 0.35 ? 1 : r < 0.75 ? 2 : 0;
  return r < 0.3 ? 2 : r < 0.4 ? 1 : 0;
}

function countBuildings(map) {
  let n = 0;
  for (const f of map.features || []) if (f.layer === 'building') n = Math.max(n, f.extra + 1);
  return n;
}

export function cellKey(tx, ty) {
  return (tx + 1024) * 4096 + (ty + 1024);
}

// ------------------------------------------------------------------------------------------------ models
/** Faces of a box into lists (6 floats a vertex: position and normal, plus a part number) — for the models below. */
function box(out, cx, y0, cz, w, h, d, part) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y1 = y0 + h;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const quad = (a, b, c, e, n) => {
    for (const v of [a, b, c, a, c, e]) out.push(v[0], v[1], v[2], n[0], n[1], n[2], part);
  };
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
  quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
  quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
  quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
}

/**
 * A person, 1.75 m tall, facing +x (the right hand on +z): 7 floats a vertex (position, normal, part). Parts: 0 the
 * body, 1 and 2 the legs (they swing about the hips at 0.88 m), 3 and 4 the arms (about the shoulders at 1.42 m),
 * 5 the head, 6 the hair.
 */
export function personModel() {
  const out = [];
  box(out, 0, 0.86, 0, 0.26, 0.6, 0.4, 0); // body (0.4 wide across, along z)
  box(out, 0, 0, -0.1, 0.16, 0.9, 0.15, 1);
  box(out, 0, 0, 0.1, 0.16, 0.9, 0.15, 2);
  box(out, 0, 0.84, -0.27, 0.12, 0.6, 0.11, 3);
  box(out, 0, 0.84, 0.27, 0.12, 0.6, 0.11, 4);
  box(out, 0.01, 1.48, 0, 0.23, 0.25, 0.2, 5);
  box(out, -0.01, 1.68, 0, 0.25, 0.08, 0.22, 6);
  return Float32Array.from(out);
}

/**
 * A tree, about 5.4 m tall: a six-sided trunk and a crown of twenty faces, 7 floats a vertex (position, normal,
 * part: 0 the trunk, 1 the crown). Instances scale it.
 */
export function treeModel() {
  const out = [];
  const tri = (a, b, c, part) => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L;
    ny /= L;
    nz /= L;
    for (const v of [a, b, c]) out.push(v[0], v[1], v[2], nx, ny, nz, part);
  };
  const r = 0.16;
  const h = 2.6;
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2;
    const a1 = ((i + 1) / 6) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, 0, Math.sin(a0) * r];
    const p1 = [Math.cos(a1) * r, 0, Math.sin(a1) * r];
    const q0 = [Math.cos(a0) * r * 0.7, h, Math.sin(a0) * r * 0.7];
    const q1 = [Math.cos(a1) * r * 0.7, h, Math.sin(a1) * r * 0.7];
    tri(p0, q1, p1, 0);
    tri(p0, q0, q1, 0);
  }
  // An icosahedron, a little flattened, for the crown.
  const t = (1 + Math.sqrt(5)) / 2;
  const V = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const L = Math.hypot(x, y, z);
    return [(x / L) * 1.9, (y / L) * 1.55 + 3.85, (z / L) * 1.9];
  });
  const F = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (const [a, b, c] of F) {
    // Every face turned to face out (its normal away from the crown's middle).
    const [p, q, s] = [V[a], V[b], V[c]];
    const n = [
      (q[1] - p[1]) * (s[2] - p[2]) - (q[2] - p[2]) * (s[1] - p[1]),
      (q[2] - p[2]) * (s[0] - p[0]) - (q[0] - p[0]) * (s[2] - p[2]),
      (q[0] - p[0]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[0] - p[0]),
    ];
    const out3 = n[0] * (p[0] + q[0] + s[0]) + n[1] * (p[1] + q[1] + s[1] - 3 * 3.85) + n[2] * (p[2] + q[2] + s[2]);
    if (out3 >= 0) tri(p, q, s, 1);
    else tri(p, s, q, 1);
  }
  return Float32Array.from(out);
}

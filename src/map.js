// Ch-ch-chain-ges — the maps. Loads docs/maps/<id>.json (streets, water, parks, contours, labels in map units around
// the map's centre, plus the playing area's outline) and its terrain picture, and draws them under the game: the
// static layers are painted once into tiles and reused while the camera moves; labels are drawn on top every frame
// so they never get cut at a tile edge. A satellite view swaps the terrain for a picture (the map's own, or tiles
// from a provider set in the config) with the roads and names over it. A city's detail file (buildings, land use,
// paths, named places with icons: docs/maps/<id>-detail.json) comes a moment after the map and makes it look like
// a street map.
import { arenaOf } from './arena.js';

const TILE_PX = 512; // tile size in device pixels
const CELL = 256; // spatial index cell, map units
const MAX_TILES = 40;

export const MAP_STYLE = {
  land: '#f3efe6',
  sea: '#cadfe8',
  water: '#cadfe8',
  green: '#dde8d0',
  beach: '#f1e5c6',
  contour: 'rgba(140, 108, 66, 0.2)',
  contourIndex: 'rgba(140, 108, 66, 0.36)',
  casing: '#e1d9c8',
  casingMajor: '#e0bf6a',
  road: '#ffffff',
  roadMajor: '#fde9a6',
  motorway: '#f7c465',
  casingMotorway: '#dc9a33',
  building: '#ddd5c6',
  buildingEdge: '#cbc1ae',
  path: 'rgba(160, 146, 120, 0.75)',
  rail: '#8d8579',
  label: '#7f7768',
  place: 'rgba(110, 100, 84, 0.62)',
  halo: 'rgba(255, 255, 255, 0.92)',
  outside: 'rgba(243, 239, 230, 0.74)',
  edge: 'rgba(110, 96, 74, 0.55)',
  border: 'rgba(90, 80, 70, 0.45)',
  greenLine: 'rgba(22, 130, 60, 0.75)',
  region: 'rgba(95, 84, 68, 0.3)',
};

/** Land use in the detail layer, drawn first (under water and parks) in this order. */
export const AREA_STYLE = {
  residential: '#eee8dc',
  farmland: '#eef0da',
  commercial: '#f4e5de',
  industrial: '#e8e5ec',
  cemetery: '#dbe5d3',
  hospital: '#f7dfe0',
  school: '#f5ecd6',
  parking: '#ebe8e2',
  sport: '#cfe6c8',
  forest: '#cbdfbd',
  sand: '#f3e8c6',
};
/** Named places: the colour of the icon and the sign on it. */
export const POI_STYLE = {
  transit: ['#1967d2', '🚌'],
  health: ['#d93025', '✚'],
  gov: ['#5f6368', '🏛'],
  edu: ['#8d6e63', '🎓'],
  culture: ['#9334e6', '🎭'],
  park: ['#188038', '🌳'],
  sport: ['#188038', '⚽'],
  hotel: ['#e52592', '🛏'],
  worship: ['#7b5e57', '🛐'],
  food: ['#e8710a', '🍴'],
  shop: ['#1a73e8', '🛍'],
  fuel: ['#5f6368', '⛽'],
  bank: ['#0d652d', '🏦'],
};
const POI_RANK = Object.fromEntries(Object.keys(POI_STYLE).map((k, i) => [k, i]));

/** [x0, y0, dx1, dy1, …] (whole metres, steps from the point before) → flat [x0, y0, x1, y1, …]. */
export function undelta(a, from = 0) {
  const out = new Array(a.length - from);
  let x = 0;
  let y = 0;
  for (let i = from; i < a.length; i += 2) {
    x = i === from ? a[i] : x + a[i];
    y = i === from ? a[i + 1] : y + a[i + 1];
    out[i - from] = x;
    out[i - from + 1] = y;
  }
  return out;
}

/** Loads a map by id from `base` (a folder URL ending in '/'). Resolves to a CityMap. */
export async function loadCity(id, base = 'maps/') {
  const res = await fetch(`${base}${encodeURIComponent(id)}.json`);
  if (!res.ok) throw new Error(`map ${id}: ${res.status}`);
  const data = await res.json();
  const terrain = data.terrain ? await loadImage(`${base}${encodeURIComponent(data.terrain)}`) : null;
  return new CityMap(data, terrain, base);
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null; // the map still works without it
  }
}

/** The list of maps: { regions: [{ id, he, … }], cities: [{ id, he, capacity, … }] }. */
export async function loadMapIndex(base = 'maps/') {
  const res = await fetch(`${base}index.json`);
  if (!res.ok) throw new Error(`map index: ${res.status}`);
  const index = await res.json();
  return { regions: index.regions || [], cities: index.cities || [] };
}

export class CityMap {
  constructor(data, terrain, base = 'maps/') {
    this.data = data;
    this.id = data.id;
    this.he = data.he;
    this.base = base;
    this.kind = data.kind || 'city';
    this.E = data.extent;
    this.arena = arenaOf(data);
    this.R = this.arena.R;
    this.terrain = terrain;
    this.sat = null; // the map's own satellite picture, once loaded
    this.satLoading = false;
    this.xyz = null; // { url, max, credit } when a provider's tiles are used
    this.xyzTiles = new Map();
    this.opts = { sat: false, green: false };
    this.attribution = data.attribution || '© OpenStreetMap contributors';
    this.tiles = new Map();
    this.labelCache = new Map();
    this.stamp = 0;
    this.pois = [];
    this.poiCells = new Map();
    this.detail = false;
    this.index();
  }

  /** The detail layer (buildings, land use, paths, named places), fetched once; the map is fine without it. */
  async loadDetail() {
    if (this.detailLoading) return this.detailLoading;
    this.detailLoading = (async () => {
      try {
        const res = await fetch(`${this.base}${encodeURIComponent(this.id)}-detail.json`);
        if (!res.ok) return false;
        const d = await res.json();
        const add = this.adder;
        for (const cls of Object.keys(AREA_STYLE)) {
          for (const poly of d.a?.[cls] || []) add(`area:${cls}`, poly.map((r) => undelta(r)), true);
        }
        for (const b of d.b || []) add('building', [undelta(b)], true);
        for (const m of d.m || []) add(m[0] === 1 ? 'path' : 'lane', undelta(m, 1), false);
        for (const f of d.f || []) add('motorway', undelta(f), false);
        this.pois = (d.p || [])
          .filter((p) => POI_STYLE[p[2]])
          .map(([x, y, cat, name]) => ({ x, y, cat, name, rank: POI_RANK[cat] }))
          .sort((a, b) => a.rank - b.rank);
        for (const p of this.pois) {
          const k = this.cell(p.y) * this.n + this.cell(p.x);
          let list = this.poiCells.get(k);
          if (!list) this.poiCells.set(k, (list = []));
          list.push(p);
        }
        this.detail = true;
        this.tiles.clear();
        return true;
      } catch {
        return false;
      }
    })();
    return this.detailLoading;
  }

  /** { sat, green, xyz }: the satellite view, the Green Line layer (big maps), a tile provider for the satellite. */
  setOptions(opts) {
    const next = { ...this.opts, ...opts };
    if (opts.xyz !== undefined) this.xyz = opts.xyz;
    if (next.sat === this.opts.sat && next.green === this.opts.green) return;
    this.opts = next;
    this.tiles.clear();
    if (next.sat && !this.sat && !this.satLoading && this.data.satellite?.image) {
      this.satLoading = true;
      loadImage(`${this.base}${encodeURIComponent(this.data.satellite.image)}`).then((img) => {
        this.sat = img;
        this.tiles.clear();
      });
    }
  }
  get hasSatellite() {
    return !!(this.data.satellite?.image || this.xyz);
  }
  get hasGreenLine() {
    return !!this.data.lines?.green?.length;
  }
  /** Credit line for what is on screen. */
  get credit() {
    if (!this.opts.sat) return this.data.kind === 'region' ? 'OpenStreetMap · Natural Earth' : '© OpenStreetMap contributors';
    if (this.xyz) return this.xyz.credit || '';
    return this.data.satellite?.credit || '';
  }

  // --------------------------------------------------------------------------------------------- index
  index() {
    const d = this.data;
    this.features = [];
    this.n = Math.ceil((2 * this.E) / CELL) + 1;
    this.cells = new Map();
    const add = (this.adder = (layer, geom, rings, extra = 0) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const r of rings ? geom : [geom]) {
        for (let i = 0; i < r.length; i += 2) {
          if (r[i] < x0) x0 = r[i];
          if (r[i] > x1) x1 = r[i];
          if (r[i + 1] < y0) y0 = r[i + 1];
          if (r[i + 1] > y1) y1 = r[i + 1];
        }
      }
      if (!Number.isFinite(x0)) return;
      const f = { layer, geom, rings, extra, x0, y0, x1, y1, seen: 0 };
      this.features.push(f);
      const c0 = this.cell(x0);
      const c1 = this.cell(x1);
      const r0 = this.cell(y0);
      const r1 = this.cell(y1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = r * this.n + c;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(f);
        }
      }
    });
    for (const ring of d.sea || []) add('sea', [ring], true);
    for (const poly of d.water || []) add('water', poly, true);
    for (const poly of d.beach || []) add('beach', poly, true);
    for (const poly of d.green || []) add('green', poly, true);
    for (const [h, line] of d.contours?.lines || []) add('contour', line, false, h);
    for (const [big, line] of d.rivers || []) add('river', line, false, big);
    (d.roads || []).forEach((lines, cls) => {
      for (const line of lines) add(`road${cls}`, line, false, cls);
    });
    for (const line of d.rail || []) add('rail', line, false);
    for (const line of d.lines?.borders || []) add('border', line, false);
    for (const line of d.lines?.green || []) add('greenline', line, false);
    if (this.arena.rings) add('arena', this.arena.rings, true);
    this.contourIndexStep = (d.contours?.step || 10) * 5;
    this.labels = (d.labels || []).map(([x, y, a, rank, text]) => ({ x, y, a: (a / 10) * (Math.PI / 180), rank, text }));
    this.places = (d.places || []).map(([x, y, rank, text]) => ({ x, y, rank, text }));
    this.names = (d.names || []).map(([x, y, text, size]) => ({ x, y, text, size }));
  }
  cell(v) {
    return Math.max(0, Math.min(this.n - 1, Math.floor((v + this.E) / CELL)));
  }
  query(x0, y0, x1, y1) {
    const stamp = ++this.stamp;
    const out = [];
    for (let r = this.cell(y0); r <= this.cell(y1); r++) {
      for (let c = this.cell(x0); c <= this.cell(x1); c++) {
        const list = this.cells.get(r * this.n + c);
        if (!list) continue;
        for (const f of list) {
          if (f.seen === stamp || f.x1 < x0 || f.x0 > x1 || f.y1 < y0 || f.y0 > y1) continue;
          f.seen = stamp;
          out.push(f);
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------------------------------------------- tiles
  /**
   * Draws the map for a camera centred on (cx, cy) at `zoom` CSS pixels per map unit into a canvas that already
   * has the DPR transform. New tiles are painted nearest-first for at most `budgetMs` per frame (always at least
   * one); the rest show the terrain alone until a later frame paints them.
   */
  draw(ctx, cx, cy, zoom, W, H, dpr, budgetMs = 7) {
    const scale = Math.min(2, dpr);
    const devZoom = zoom * scale;
    const level = Math.round(Math.log2(devZoom) * 2) / 2; // half-octave steps; tiles are stretched in between
    const tz = 2 ** level; // tile pixels per map unit
    const tw = TILE_PX / tz; // map units per tile
    const vx0 = cx - W / 2 / zoom;
    const vy0 = cy - H / 2 / zoom;
    const vx1 = cx + W / 2 / zoom;
    const vy1 = cy + H / 2 / zoom;
    const size = tw * zoom;
    const xyz = this.opts.sat && this.xyz;
    ctx.fillStyle = xyz ? '#2b2f2a' : MAP_STYLE.land;
    ctx.fillRect(0, 0, W, H);
    if (xyz) this.drawXYZ(ctx, cx, cy, zoom, W, H, dpr);
    const want = [];
    for (let ty = Math.floor(vy0 / tw); ty <= Math.floor(vy1 / tw); ty++) {
      for (let tx = Math.floor(vx0 / tw); tx <= Math.floor(vx1 / tw); tx++) {
        want.push({ tx, ty, d: Math.hypot((tx + 0.5) * tw - cx, (ty + 0.5) * tw - cy) });
      }
    }
    want.sort((a, b) => a.d - b.d);
    const start = performance.now();
    let painted = 0;
    const back = this.opts.sat && this.sat ? this.sat : this.terrain;
    for (const { tx, ty } of want) {
      const key = `${level}:${tx}:${ty}`;
      let tile = this.tiles.get(key);
      if (!tile && (painted === 0 || performance.now() - start < budgetMs)) {
        tile = this.paintTile(tx, ty, tw, tz);
        painted++;
      }
      const sx = (tx * tw - cx) * zoom + W / 2;
      const sy = (ty * tw - cy) * zoom + H / 2;
      if (tile) {
        this.tiles.delete(key); // most recently used last
        this.tiles.set(key, tile);
        ctx.drawImage(tile, sx, sy, size + 0.5, size + 0.5);
      } else if (back && !xyz) {
        // Not painted yet: the terrain alone for a frame or two.
        const k = back.naturalWidth / (2 * this.E);
        ctx.drawImage(back, (tx * tw + this.E) * k, (ty * tw + this.E) * k, tw * k, tw * k, sx, sy, size + 0.5, size + 0.5);
      }
    }
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value);
  }

  paintTile(tx, ty, tw, tz) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE_PX;
    const g = c.getContext('2d');
    const x0 = tx * tw;
    const y0 = ty * tw;
    g.setTransform(tz, 0, 0, tz, -x0 * tz, -y0 * tz);
    const sat = this.opts.sat;
    const xyz = sat && this.xyz; // the provider's pictures are drawn under the (transparent) tiles every frame
    if (!xyz) {
      g.fillStyle = MAP_STYLE.land;
      g.fillRect(x0, y0, tw, tw);
      const back = sat && this.sat ? this.sat : this.terrain;
      if (back) {
        g.imageSmoothingQuality = 'high';
        g.drawImage(back, -this.E, -this.E, 2 * this.E, 2 * this.E);
      }
    }
    const pad = 40;
    const feats = this.query(x0 - pad, y0 - pad, x0 + tw + pad, y0 + tw + pad);
    const px = 1 / tz; // one tile pixel, in map units
    const by = (layer) => feats.filter((f) => f.layer === layer);
    const fill = (layer, color) => {
      const list = by(layer);
      if (!list.length) return;
      g.fillStyle = color;
      g.beginPath();
      for (const f of list) for (const ring of f.geom) ringPath(g, ring);
      g.fill('evenodd');
    };
    const stroke = (list, color, width) => {
      if (!list.length) return;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (const f of list) linePath(g, f.geom);
      g.stroke();
    };
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const widths = [Math.max(3 * px, 13), Math.max(2.2 * px, 9), Math.max(1.6 * px, 6)];
    const roads = [by('road0'), by('road1'), by('road2')];
    if (sat) {
      // Over the picture: the streets as thin light lines, enough to read the city by.
      g.globalAlpha = 0.55;
      stroke(roads[2], '#ffffff', Math.max(1.1 * px, widths[2] * 0.3));
      stroke(roads[1], '#fff7dd', Math.max(1.4 * px, widths[1] * 0.35));
      stroke(roads[0], '#ffe9a8', Math.max(1.8 * px, widths[0] * 0.4));
      stroke(by('motorway'), '#ffc766', Math.max(2 * px, widths[0] * 0.45));
      g.globalAlpha = 1;
    } else {
      // Land use first, so water, beaches and parks lie over it.
      if (this.detail) for (const cls in AREA_STYLE) fill(`area:${cls}`, AREA_STYLE[cls]);
      fill('sea', MAP_STYLE.sea);
      fill('water', MAP_STYLE.water);
      fill('beach', MAP_STYLE.beach);
      fill('green', MAP_STYLE.green);
      const contours = by('contour');
      stroke(contours.filter((f) => f.extra % this.contourIndexStep !== 0), MAP_STYLE.contour, Math.max(0.9 * px, 1));
      stroke(contours.filter((f) => f.extra % this.contourIndexStep === 0), MAP_STYLE.contourIndex, Math.max(1.3 * px, 1.4));
      const rivers = by('river');
      stroke(rivers.filter((f) => f.extra === 1), MAP_STYLE.water, Math.max(2.2 * px, 9));
      stroke(rivers.filter((f) => f.extra !== 1), MAP_STYLE.water, Math.max(1.4 * px, 3));
      if (this.detail && tz >= 0.25) {
        // Buildings, with a hairline edge once they are big enough to have one.
        const blds = by('building');
        if (blds.length) {
          g.fillStyle = MAP_STYLE.building;
          g.beginPath();
          for (const f of blds) ringPath(g, f.geom[0]);
          g.fill();
          if (tz >= 0.6) {
            g.strokeStyle = MAP_STYLE.buildingEdge;
            g.lineWidth = px;
            g.stroke();
          }
        }
        // Lanes and service roads (white, a thin edge) and footpaths (dashed).
        const lanes = by('lane');
        stroke(lanes, MAP_STYLE.casing, Math.max(1.8 * px, 4.5));
        stroke(lanes, MAP_STYLE.road, Math.max(1.1 * px, 3.2));
        const paths = by('path');
        if (paths.length && tz >= 0.4) {
          g.setLineDash([3 * px, 2.5 * px]);
          g.lineCap = 'butt';
          stroke(paths, MAP_STYLE.path, Math.max(1 * px, 1.4));
          g.setLineDash([]);
          g.lineCap = 'round';
        }
      }
      stroke(roads[2], MAP_STYLE.casing, widths[2] + 2 * px);
      stroke(roads[1], MAP_STYLE.casing, widths[1] + 2 * px);
      stroke(roads[0], MAP_STYLE.casingMajor, widths[0] + 2.4 * px);
      stroke(roads[2], MAP_STYLE.road, widths[2]);
      stroke(roads[1], MAP_STYLE.road, widths[1]);
      stroke(roads[0], MAP_STYLE.roadMajor, widths[0]);
      // Motorways over the main roads, in orange, like a street map.
      const fast = by('motorway');
      stroke(fast, MAP_STYLE.casingMotorway, widths[0] + 2.4 * px);
      stroke(fast, MAP_STYLE.motorway, widths[0]);
      const rail = by('rail');
      if (rail.length) {
        g.setLineDash([6 * px, 5 * px]);
        g.lineCap = 'butt';
        stroke(rail, MAP_STYLE.rail, Math.max(1.3 * px, 1.6));
        g.setLineDash([]);
        g.lineCap = 'round';
      }
    }
    // Today's borders, faint; the Green Line only when it is switched on.
    const borders = by('border');
    if (borders.length) {
      g.setLineDash([7 * px, 5 * px]);
      stroke(borders, sat ? 'rgba(255,255,255,0.7)' : MAP_STYLE.border, Math.max(1.4 * px, 2));
      g.setLineDash([]);
    }
    if (this.opts.green) {
      g.setLineDash([10 * px, 6 * px]);
      stroke(by('greenline'), MAP_STYLE.greenLine, Math.max(2.2 * px, 3));
      g.setLineDash([]);
    }
    // Outside the playing area: paler, behind a dashed edge.
    const arena = by('arena');
    if (arena.length) {
      g.fillStyle = sat ? 'rgba(20, 22, 20, 0.45)' : MAP_STYLE.outside;
      g.beginPath();
      g.rect(x0 - 1, y0 - 1, tw + 2, tw + 2);
      for (const f of arena) for (const ring of f.geom) ringPath(g, ring);
      g.fill('evenodd');
      g.setLineDash([9 * px, 7 * px]);
      stroke(arena, sat ? 'rgba(255,255,255,0.8)' : MAP_STYLE.edge, Math.max(2 * px, 2));
      g.setLineDash([]);
    } else if (this.arena.rings) {
      // A tile wholly outside the outline (no edge crosses it): pale it if it is outside.
      if (!this.arena.inside(x0 + tw / 2, y0 + tw / 2)) {
        g.fillStyle = sat ? 'rgba(20, 22, 20, 0.45)' : MAP_STYLE.outside;
        g.fillRect(x0, y0, tw, tw);
      }
    }
    return c;
  }

  /** A provider's satellite tiles (Web Mercator XYZ) under the map, placed through the map's own projection. */
  drawXYZ(ctx, cx, cy, zoom, W, H, dpr) {
    const d = this.data;
    const [lat0, lon0] = d.center || [0, 0];
    const s = d.scale || 1;
    const phi = (lat0 * Math.PI) / 180;
    const ky = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
    const kx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
    const toLon = (x) => lon0 + (x * s) / kx;
    const toLat = (y) => lat0 - (y * s) / ky;
    const mpp = s / (zoom * Math.min(2, dpr)); // real metres per device pixel
    const z = Math.max(1, Math.min(this.xyz.max || 19, Math.round(Math.log2((40075016 * Math.cos(phi)) / (256 * mpp)))));
    const n = 2 ** z;
    const tileX = (lon) => ((lon + 180) / 360) * n;
    const tileY = (lat) => {
      const r = (lat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    };
    const lonOf = (tx) => (tx / n) * 360 - 180;
    const latOf = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
    const xOf = (lon) => ((lon - lon0) * kx) / s;
    const yOf = (lat) => (-(lat - lat0) * ky) / s;
    const vx0 = cx - W / 2 / zoom;
    const vx1 = cx + W / 2 / zoom;
    const vy0 = cy - H / 2 / zoom;
    const vy1 = cy + H / 2 / zoom;
    const t0x = Math.floor(tileX(toLon(vx0)));
    const t1x = Math.floor(tileX(toLon(vx1)));
    const t0y = Math.floor(tileY(toLat(vy0)));
    const t1y = Math.floor(tileY(toLat(vy1)));
    let asked = 0;
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const key = `${z}/${tx}/${ty}`;
        let img = this.xyzTiles.get(key);
        if (!img && asked < 12) {
          asked++;
          img = new Image();
          img.decoding = 'async';
          img.src = this.xyz.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
          this.xyzTiles.set(key, img);
          if (this.xyzTiles.size > 300) this.xyzTiles.delete(this.xyzTiles.keys().next().value);
        }
        if (!img?.complete || !img.naturalWidth) continue;
        const x0 = (xOf(lonOf(tx)) - cx) * zoom + W / 2;
        const x1 = (xOf(lonOf(tx + 1)) - cx) * zoom + W / 2;
        const y0 = (yOf(latOf(ty)) - cy) * zoom + H / 2;
        const y1 = (yOf(latOf(ty + 1)) - cy) * zoom + H / 2;
        ctx.drawImage(img, x0, y0, x1 - x0 + 0.5, y1 - y0 + 0.5);
      }
    }
  }

  // --------------------------------------------------------------------------------------------- labels
  /** Street names along their roads, neighbourhoods and towns, and (on the big maps) regions, in screen pixels. */
  drawLabels(ctx, cx, cy, zoom, W, H, dpr) {
    const vx0 = cx - W / 2 / zoom - 120;
    const vx1 = cx + W / 2 / zoom + 120;
    const vy0 = cy - H / 2 / zoom - 60;
    const vy1 = cy + H / 2 / zoom + 60;
    const put = (img, x, y) =>
      ctx.drawImage(img, (x - cx) * zoom + W / 2 - img.width / dpr / 2, (y - cy) * zoom + H / 2 - img.height / dpr / 2, img.width / dpr, img.height / dpr);
    for (const r of this.names) {
      if (r.x < vx0 - 400 || r.x > vx1 + 400 || r.y < vy0 - 200 || r.y > vy1 + 200) continue;
      put(this.label(r.text, r.size ? 'region1' : 'region0', dpr), r.x, r.y);
    }
    const roadRank = zoom > 0.62 ? 2 : zoom > 0.4 ? 1 : zoom > 0.22 ? 0 : -1;
    for (const l of this.labels) {
      if (l.rank > roadRank || l.x < vx0 || l.x > vx1 || l.y < vy0 || l.y > vy1) continue;
      const img = this.label(l.text, 'road', dpr);
      ctx.save();
      ctx.translate((l.x - cx) * zoom + W / 2, (l.y - cy) * zoom + H / 2);
      ctx.rotate(l.a);
      ctx.drawImage(img, -img.width / dpr / 2, -img.height / dpr / 2, img.width / dpr, img.height / dpr);
      ctx.restore();
    }
    const placeRank = zoom > 0.5 ? 2 : zoom > 0.3 ? 1 : 0;
    for (const p of this.places) {
      if (p.rank > placeRank || p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
      put(this.label(p.text, p.rank === 0 ? 'place0' : 'place', dpr), p.x, p.y);
    }
    // Named places, like a street map: an icon (and its name, closer in), at most one per patch of the screen, the
    // most useful kinds first.
    if (this.pois.length && zoom >= 0.36) {
      const vis = [];
      for (let r = this.cell(vy0); r <= this.cell(vy1); r++) {
        for (let c = this.cell(vx0); c <= this.cell(vx1); c++) {
          const list = this.poiCells.get(r * this.n + c);
          if (list) for (const p of list) if (p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1) vis.push(p);
        }
      }
      vis.sort((a, b) => a.rank - b.rank);
      const boxes = []; // what is already drawn, in screen pixels: [x0, y0, x1, y1]
      const free = (b) => boxes.every((o) => b[2] < o[0] || b[0] > o[2] || b[3] < o[1] || b[1] > o[3]);
      const named = zoom >= 0.52;
      let shown = 0;
      for (const p of vis) {
        const x = (p.x - cx) * zoom + W / 2;
        const y = (p.y - cy) * zoom + H / 2;
        const iconBox = [x - 12, y - 12, x + 12, y + 12];
        if (!free(iconBox)) continue;
        const icon = this.poiIcon(p.cat, dpr);
        ctx.drawImage(icon, x - icon.width / dpr / 2, y - icon.height / dpr / 2, icon.width / dpr, icon.height / dpr);
        boxes.push(iconBox);
        if (named) {
          const img = this.label(p.name, `poi:${p.cat}`, dpr);
          const w = img.width / dpr;
          const h = img.height / dpr;
          const nameBox = [x - w / 2, y + 7, x + w / 2, y + 7 + h];
          if (free(nameBox)) {
            ctx.drawImage(img, nameBox[0], nameBox[1], w, h);
            boxes.push(nameBox);
          }
        }
        if (++shown >= 60) break;
      }
    }
  }

  /** A named place's icon: a coloured disc with its sign. */
  poiIcon(cat, dpr) {
    const key = `icon|${cat}|${dpr}`;
    let c = this.labelCache.get(key);
    if (c) return c;
    const [color, sign] = POI_STYLE[cat] || ['#5f6368', '•'];
    const size = 17;
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(size * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = color;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
    g.fill();
    g.font = `${sign === '✚' ? 800 : 400} ${sign === '✚' ? 11 : 9.5}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(sign, size / 2, size / 2 + 0.5);
    this.labelCache.set(key, c);
    return c;
  }

  label(text, kind, dpr) {
    const key = `${kind}|${dpr}|${text}`;
    let c = this.labelCache.get(key);
    if (c) return c;
    const poi = kind.startsWith('poi:') ? POI_STYLE[kind.slice(4)] : null;
    const size = poi ? 10.5 : { road: 11, place: 13, place0: 15, region0: 22, region1: 17 }[kind] ?? 13;
    const weight = kind === 'road' ? 600 : kind.startsWith('region') ? 800 : 700;
    const font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
    c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 8;
    const h = size + 9;
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    g.scale(dpr, dpr);
    g.font = font;
    g.direction = 'rtl';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.strokeStyle = MAP_STYLE.halo;
    g.lineWidth = kind.startsWith('region') ? 4 : 3;
    g.strokeText(text, w / 2, h / 2 + 0.5);
    g.fillStyle = poi ? poi[0] : kind === 'road' ? MAP_STYLE.label : kind.startsWith('region') ? MAP_STYLE.region : MAP_STYLE.place;
    g.fillText(text, w / 2, h / 2 + 0.5);
    if (this.labelCache.size > 900) this.labelCache.clear();
    this.labelCache.set(key, c);
    return c;
  }
}

function linePath(g, a) {
  g.moveTo(a[0], a[1]);
  for (let i = 2; i < a.length; i += 2) g.lineTo(a[i], a[i + 1]);
}
function ringPath(g, a) {
  g.moveTo(a[0], a[1]);
  for (let i = 2; i < a.length; i += 2) g.lineTo(a[i], a[i + 1]);
  g.closePath();
}

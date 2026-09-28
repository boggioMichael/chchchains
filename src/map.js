// Ch-ch-chains — city maps. Loads docs/maps/<city>.json (streets, water, parks, contours, labels in metres around
// the city centre) and its terrain image, and draws them under the game: the static layers are painted once into
// tiles and reused while the camera moves; labels are drawn on top every frame so they never get cut at a tile edge.

const TILE_PX = 512; // tile size in device pixels
const CELL = 256; // spatial index cell, metres
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
  casingMajor: '#d5c9b1',
  road: '#ffffff',
  roadMajor: '#fffaf0',
  rail: '#8d8579',
  label: '#7f7768',
  place: 'rgba(110, 100, 84, 0.62)',
  halo: 'rgba(255, 255, 255, 0.92)',
};

/** Loads a city by id from `base` (a folder URL ending in '/'). Resolves to a CityMap. */
export async function loadCity(id, base = 'maps/') {
  const res = await fetch(`${base}${encodeURIComponent(id)}.json`);
  if (!res.ok) throw new Error(`map ${id}: ${res.status}`);
  const data = await res.json();
  let terrain = null;
  if (data.terrain) {
    const img = new Image();
    img.src = `${base}${encodeURIComponent(data.terrain)}`;
    try {
      await img.decode();
      terrain = img;
    } catch {
      terrain = null; // the map still works without its shading
    }
  }
  return new CityMap(data, terrain);
}

/** The list of cities: [{ id, he, R, center }]. */
export async function loadCityIndex(base = 'maps/') {
  const res = await fetch(`${base}index.json`);
  if (!res.ok) throw new Error(`map index: ${res.status}`);
  return (await res.json()).cities || [];
}

export class CityMap {
  constructor(data, terrain) {
    this.data = data;
    this.id = data.id;
    this.he = data.he;
    this.R = data.R;
    this.E = data.extent;
    this.terrain = terrain;
    this.attribution = data.attribution || '© OpenStreetMap contributors';
    this.tiles = new Map();
    this.labelCache = new Map();
    this.stamp = 0;
    this.index();
  }

  // --------------------------------------------------------------------------------------------- index
  index() {
    const d = this.data;
    this.features = [];
    this.n = Math.ceil((2 * this.E) / CELL) + 1;
    this.cells = new Map();
    const add = (layer, geom, rings, extra = 0) => {
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
    };
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
    this.contourIndexStep = (d.contours?.step || 10) * 5;
    this.labels = (d.labels || []).map(([x, y, a, rank, text]) => ({ x, y, a: (a / 10) * (Math.PI / 180), rank, text }));
    this.places = (d.places || []).map(([x, y, rank, text]) => ({ x, y, rank, text }));
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
   * Draws the map for a camera centred on (cx, cy) at `zoom` CSS pixels per metre into a canvas that already has
   * the DPR transform. New tiles are painted nearest-first for at most `budgetMs` per frame (always at least one);
   * the rest show the terrain alone until a later frame paints them.
   */
  draw(ctx, cx, cy, zoom, W, H, dpr, budgetMs = 7) {
    const scale = Math.min(2, dpr);
    const devZoom = zoom * scale;
    const level = Math.round(Math.log2(devZoom) * 2) / 2; // half-octave steps; tiles are stretched in between
    const tz = 2 ** level; // tile pixels per metre
    const tw = TILE_PX / tz; // metres per tile
    const vx0 = cx - W / 2 / zoom;
    const vy0 = cy - H / 2 / zoom;
    const vx1 = cx + W / 2 / zoom;
    const vy1 = cy + H / 2 / zoom;
    const size = tw * zoom;
    ctx.fillStyle = MAP_STYLE.land;
    ctx.fillRect(0, 0, W, H);
    const want = [];
    for (let ty = Math.floor(vy0 / tw); ty <= Math.floor(vy1 / tw); ty++) {
      for (let tx = Math.floor(vx0 / tw); tx <= Math.floor(vx1 / tw); tx++) {
        want.push({ tx, ty, d: Math.hypot((tx + 0.5) * tw - cx, (ty + 0.5) * tw - cy) });
      }
    }
    want.sort((a, b) => a.d - b.d);
    const start = performance.now();
    let painted = 0;
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
      } else if (this.terrain) {
        // Not painted yet: the terrain alone for a frame or two.
        const k = this.terrain.naturalWidth / (2 * this.E);
        ctx.drawImage(this.terrain, (tx * tw + this.E) * k, (ty * tw + this.E) * k, tw * k, tw * k, sx, sy, size + 0.5, size + 0.5);
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
    g.fillStyle = MAP_STYLE.land;
    g.fillRect(x0, y0, tw, tw);
    if (this.terrain) g.drawImage(this.terrain, -this.E, -this.E, 2 * this.E, 2 * this.E);
    const pad = 40;
    const feats = this.query(x0 - pad, y0 - pad, x0 + tw + pad, y0 + tw + pad);
    const px = 1 / tz; // one tile pixel, in metres
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
    const widths = [Math.max(3 * px, 13), Math.max(2.2 * px, 9), Math.max(1.6 * px, 6)];
    const roads = [by('road0'), by('road1'), by('road2')];
    stroke(roads[2], MAP_STYLE.casing, widths[2] + 2 * px);
    stroke(roads[1], MAP_STYLE.casing, widths[1] + 2 * px);
    stroke(roads[0], MAP_STYLE.casingMajor, widths[0] + 2.4 * px);
    stroke(roads[2], MAP_STYLE.road, widths[2]);
    stroke(roads[1], MAP_STYLE.road, widths[1]);
    stroke(roads[0], MAP_STYLE.roadMajor, widths[0]);
    const rail = by('rail');
    if (rail.length) {
      g.setLineDash([6 * px, 5 * px]);
      g.lineCap = 'butt';
      stroke(rail, MAP_STYLE.rail, Math.max(1.3 * px, 1.6));
      g.setLineDash([]);
    }
    return c;
  }

  // --------------------------------------------------------------------------------------------- labels
  /** Street names along their roads and neighbourhood names, sized in screen pixels (zoom = CSS px per metre). */
  drawLabels(ctx, cx, cy, zoom, W, H, dpr) {
    const vx0 = cx - W / 2 / zoom - 120;
    const vx1 = cx + W / 2 / zoom + 120;
    const vy0 = cy - H / 2 / zoom - 60;
    const vy1 = cy + H / 2 / zoom + 60;
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
      const img = this.label(p.text, p.rank === 0 ? 'place0' : 'place', dpr);
      ctx.drawImage(
        img,
        (p.x - cx) * zoom + W / 2 - img.width / dpr / 2,
        (p.y - cy) * zoom + H / 2 - img.height / dpr / 2,
        img.width / dpr,
        img.height / dpr,
      );
    }
  }

  label(text, kind, dpr) {
    const key = `${kind}|${dpr}|${text}`;
    let c = this.labelCache.get(key);
    if (c) return c;
    const font =
      kind === 'road'
        ? '600 11px system-ui, -apple-system, "Segoe UI", Arial, sans-serif'
        : `700 ${kind === 'place0' ? 15 : 13}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
    c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 8;
    const h = kind === 'road' ? 16 : 20;
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    g.scale(dpr, dpr);
    g.font = font;
    g.direction = 'rtl';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.strokeStyle = MAP_STYLE.halo;
    g.lineWidth = 3;
    g.strokeText(text, w / 2, h / 2 + 0.5);
    g.fillStyle = kind === 'road' ? MAP_STYLE.label : MAP_STYLE.place;
    g.fillText(text, w / 2, h / 2 + 0.5);
    if (this.labelCache.size > 400) this.labelCache.clear();
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

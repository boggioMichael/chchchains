// Ch-ch-chain-ges — the world simulation. Pure logic with no DOM, so the same code runs in the browser (solo play with
// labelled bots) and on the server (authoritative multiplayer rooms).

export const C = {
  arenaRadius: 3000,
  baseSpeed: 190,
  boostSpeed: 380,
  turnRate: 4.2,
  spacing: 7,
  startMass: 12,
  sparkTarget: 850,
  handRange: 190,
  teamMax: 4,
  teamBonusRange: 480,
  teamBonus: 1.5,
  boostCost: 5,
  minBoostMass: 14,
  deathSparkTtl: 45,
  bodyCell: 96,
  sparkCell: 128,
};

// 12 flat colours for the chains, distinct from each other and from the paper-coloured map.
export const COLORS = [
  '#2f6fed', '#e5484d', '#12a594', '#f59e0b', '#8e4ec6', '#e93d82',
  '#0891b2', '#46a758', '#f76b15', '#3e63dd', '#ab4aba', '#a18072',
];
// People standing in the streets, waiting to join a chain: quiet greys.
export const SPARK_COLORS = ['#8b8478', '#968f83', '#7f786d', '#a09a8e', '#8e8a82', '#9a9184'];

export const NOUNS = ['ניצוץ', 'כוכב', 'זיק', 'שביט', 'פנס', 'נר', 'ברק', 'מגדלור', 'גל', 'לפיד', 'זוהר', 'אור'];
export const ADJS = ['זריז', 'עקשן', 'אמיץ', 'סקרן', 'נחוש', 'עליז', 'חולמני', 'ערני', 'נדיב', 'שקט', 'מחייך', 'חצוף', 'צנוע', 'שובב'];
export const PLACES = ['מהגליל', 'מהנגב', 'מהכרמל', 'מהשרון', 'מהעמק', 'מהחוף', 'מהערבה', 'מההר', 'מהשפלה', 'מהעיר'];
const BOT_NAMES = ['דבורה', 'צבי', 'רימון', 'תמר', 'אלון', 'שקד', 'נחליאלי', 'חצב', 'דוכיפת', 'צבר', 'ארז', 'כלנית',
  'רקפת', 'אגוז', 'יעל', 'תאנה', 'ברוש', 'שחף', 'עפרוני', 'זית', 'אורן', 'לוטם', 'נרקיס', 'דקל'];

const TAU = Math.PI * 2;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function randomName() {
  return Math.random() < 0.5 ? `${pick(NOUNS)} ${pick(ADJS)}` : `${pick(NOUNS)} ${pick(PLACES)}`;
}

export function lengthFor(mass) {
  return mass <= 200 ? 60 + 7 * mass : 1460 + 3.5 * (mass - 200);
}

export function radiusFor(mass) {
  return Math.min(34, 9 + 1.7 * Math.sqrt(mass));
}

/** The number shown to players: how many people are in the chain (one per person picked up). */
export function scoreOf(mass) {
  return Math.round(mass);
}

export function angleDiff(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Uniform grid over the arena for neighbour queries (body points and sparks). */
class Grid {
  /** rebuilt: the grid is cleared and refilled every step, so it remembers which cells to empty. */
  constructor(cell, radius, rebuilt = false) {
    this.cell = cell;
    this.half = Math.ceil(radius / cell) + 2;
    this.n = this.half * 2;
    this.cells = Array.from({ length: this.n * this.n }, () => []);
    this.used = rebuilt ? [] : null; // cells filled since the last clear()
  }
  index(x, y) {
    const ix = Math.floor(x / this.cell) + this.half;
    const iy = Math.floor(y / this.cell) + this.half;
    if (ix < 0 || iy < 0 || ix >= this.n || iy >= this.n) return -1;
    return iy * this.n + ix;
  }
  clear() {
    if (!this.used) {
      for (const c of this.cells) c.length = 0;
      return;
    }
    for (const i of this.used) this.cells[i].length = 0;
    this.used.length = 0;
  }
  insert(x, y, item) {
    const i = this.index(x, y);
    if (i < 0) return;
    const c = this.cells[i];
    if (this.used && c.length === 0) this.used.push(i);
    c.push(item);
  }
  remove(x, y, item) {
    const i = this.index(x, y);
    if (i < 0) return;
    const c = this.cells[i];
    const k = c.indexOf(item);
    if (k >= 0) {
      c[k] = c[c.length - 1];
      c.pop();
    }
  }
  /** Calls fn(item) for items in cells overlapping the circle; stops early when fn returns true. */
  query(x, y, r, fn) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c) + this.half;
    const x1 = Math.floor((x + r) / c) + this.half;
    const y0 = Math.floor((y - r) / c) + this.half;
    const y1 = Math.floor((y + r) / c) + this.half;
    for (let iy = Math.max(0, y0); iy <= Math.min(this.n - 1, y1); iy++) {
      for (let ix = Math.max(0, x0); ix <= Math.min(this.n - 1, x1); ix++) {
        const cellItems = this.cells[iy * this.n + ix];
        for (let k = 0; k < cellItems.length; k++) if (fn(cellItems[k])) return true;
      }
    }
    return false;
  }
}

export class World {
  constructor(opts = {}) {
    this.R = opts.arenaRadius ?? C.arenaRadius;
    this.sparkTarget = opts.sparkTarget ?? C.sparkTarget;
    // Where people turn up (e.g. along a city's streets); without it, anywhere in the arena.
    this.spawnPoint = opts.spawnPoint ?? null;
    // The playing area: a map's city limits (arena.js), or else the circle of radius R.
    const r2 = this.R * this.R;
    this.inside = opts.inside ?? ((x, y) => x * x + y * y <= r2);
    this.snakes = new Map();
    this.sparks = new Map();
    this.teams = new Map();
    this.nextId = 1;
    this.nextSpark = 1;
    this.nextTeam = 1;
    this.time = 0;
    this.events = [];
    this.collected = 0;
    // The server turns this on to learn which sparks came and went between snapshots.
    this.sparkLog = null; // { added: [spark], removed: [id] }
    this.sparkGrid = new Grid(C.sparkCell, this.R);
    this.bodyGrid = new Grid(C.bodyCell, this.R, true);
    // Things in the way, for the single-player story only (see setObstacles): roadworks across streets, buses and
    // trains running along them, and drifting storms that slow everyone down. Rooms online have none.
    this.bars = [];
    this.movers = [];
    this.zones = [];
    // Flat buffers for the body-point grid, rebuilt every step.
    this.bpX = [];
    this.bpY = [];
    this.bpOwner = [];
    this.bpR = [];
    this.bpTeam = [];
    this.bpIdx = [];
    for (let i = 0; i < this.sparkTarget; i++) this.spawnNaturalSpark();
  }

  // --------------------------------------------------------------------------------------------- sparks
  addSpark(x, y, v, r, color, ttl = 0) {
    const s = { id: this.nextSpark++, x, y, v, r, color, born: this.time, ttl };
    this.sparks.set(s.id, s);
    this.sparkGrid.insert(x, y, s);
    this.sparkLog?.added.push(s);
    return s;
  }
  removeSpark(s) {
    this.sparks.delete(s.id);
    this.sparkGrid.remove(s.x, s.y, s);
    this.sparkLog?.removed.push(s.id);
  }
  /** Inside the arena, and at least `margin` from its edge (checked in four directions). */
  roomy(x, y, margin) {
    const inside = this.inside;
    return inside(x, y) && (margin <= 0 || (inside(x + margin, y) && inside(x - margin, y) && inside(x, y + margin) && inside(x, y - margin)));
  }
  /**
   * A random place for people: on the streets when the world has a map, else anywhere inside the arena. `reach`
   * keeps it off the edge: 1 − reach of 600 metres (0.97 → 18 m, 0.72 → 170 m).
   */
  somewhere(reach = 0.97) {
    const margin = (1 - reach) * 600;
    if (this.spawnPoint) {
      for (let k = 0; k < 6; k++) {
        const p = this.spawnPoint();
        if (p && this.roomy(p.x, p.y, margin)) return p;
      }
    }
    for (let k = 0; k < 40; k++) {
      const rr = this.R * Math.sqrt(Math.random());
      const a = Math.random() * TAU;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (this.roomy(x, y, k < 30 ? margin : 0)) return { x, y };
    }
    return { x: 0, y: 0 };
  }

  // --------------------------------------------------------------------------------------------- obstacles
  /**
   * bars: [{ x1, y1, x2, y2, w, label }] (a barrier w wide from one end to the other);
   * movers: [{ pts: [x, y, …], speed, half, r, phase, label }] (a capsule running to and fro along a path);
   * zones: [{ ax, ay, bx, by, period, r, slow, label }] (a circle drifting between two points, slowing whoever is in it).
   */
  setObstacles({ bars = [], movers = [], zones = [] } = {}) {
    this.bars = bars.map((b) => ({ w: 14, label: 'block', ...b }));
    this.movers = movers
      .filter((m) => m.pts && m.pts.length >= 4)
      .map((m) => {
        const cum = [0];
        for (let i = 2; i < m.pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(m.pts[i] - m.pts[i - 2], m.pts[i + 1] - m.pts[i - 1]));
        return { speed: 120, half: 22, r: 10, phase: 0, label: 'bus', ...m, cum, len: cum[cum.length - 1] || 1 };
      });
    this.zones = zones.map((z) => ({ period: 60, r: 400, slow: 0.55, label: 'storm', ...z }));
  }
  /** Where a mover is at time t: its middle and heading. */
  moverAt(m, t = this.time) {
    const L = m.len;
    let d = (((m.phase + m.speed * t) % (2 * L)) + 2 * L) % (2 * L);
    let back = false;
    if (d > L) {
      d = 2 * L - d;
      back = true;
    }
    const cum = m.cum;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const k = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
    const x0 = m.pts[2 * i - 2];
    const y0 = m.pts[2 * i - 1];
    const dx = m.pts[2 * i] - x0;
    const dy = m.pts[2 * i + 1] - y0;
    return { x: x0 + dx * k, y: y0 + dy * k, a: Math.atan2(dy, dx) + (back ? Math.PI : 0) };
  }
  zoneAt(z, t = this.time) {
    const k = (1 - Math.cos((TAU * t) / z.period)) / 2;
    return { x: z.ax + (z.bx - z.ax) * k, y: z.ay + (z.by - z.ay) * k };
  }
  /** How much a storm slows whoever stands at (x, y): 1 is not at all. */
  slowAt(x, y) {
    let f = 1;
    for (const z of this.zones) {
      const p = this.zoneAt(z);
      if ((p.x - x) ** 2 + (p.y - y) ** 2 < z.r * z.r) f = Math.min(f, z.slow);
    }
    return f;
  }
  /** The label of a barrier or vehicle within pad of (x, y) (now, or `ahead` seconds from now), or ''. */
  blocked(x, y, pad, ahead = 0) {
    for (const b of this.bars) {
      const lim = b.w / 2 + pad;
      if (segDist2(x, y, b.x1, b.y1, b.x2, b.y2) < lim * lim) return b.label;
    }
    for (const m of this.movers) {
      for (const t of ahead ? [this.time, this.time + ahead] : [this.time]) {
        const p = this.moverAt(m, t);
        const cx = Math.cos(p.a) * m.half;
        const cy = Math.sin(p.a) * m.half;
        const lim = m.r + pad;
        if (segDist2(x, y, p.x - cx, p.y - cy, p.x + cx, p.y + cy) < lim * lim) return m.label;
      }
    }
    return '';
  }

  spawnNaturalSpark() {
    if (Math.random() < 0.08) {
      // A small crowd: worth chasing.
      const { x: cx, y: cy } = this.somewhere(0.88);
      const n = 6 + Math.floor(Math.random() * 8);
      const color = pick(SPARK_COLORS);
      for (let i = 0; i < n; i++) {
        const ra = Math.random() * TAU;
        const rd = 12 + Math.random() * 50;
        const x = cx + Math.cos(ra) * rd;
        const y = cy + Math.sin(ra) * rd;
        if (this.inside(x, y)) this.addSpark(x, y, 1, 4.5 + Math.random() * 2, color);
      }
      return;
    }
    const { x, y } = this.somewhere();
    this.addSpark(x, y, 1, 4 + Math.random() * 2.5, pick(SPARK_COLORS));
  }

  // --------------------------------------------------------------------------------------------- snakes
  safeSpawnPoint() {
    let best = { x: 0, y: 0 };
    let bestD = -1;
    for (let tries = 0; tries < 14; tries++) {
      const { x, y } = this.somewhere(0.72);
      let near = Infinity;
      for (const o of this.snakes.values()) {
        if (!o.alive) continue;
        for (let i = 0; i < o.px.length; i += 6) near = Math.min(near, Math.hypot(o.px[i] - x, o.py[i] - y));
      }
      if (near > 420) return { x, y };
      if (near > bestD) {
        bestD = near;
        best = { x, y };
      }
    }
    return best;
  }

  /**
   * A new chain. Story extras: `at` ({ x, y, a? }) places it, `ai` sets a bot's role (see thinkRole), `mods` changes
   * how it plays ({ speed, turn, boost, reach, value } multipliers and extra reach) and `shield` is how many crashes it
   * survives.
   */
  addSnake({ name = randomName(), color, bot = false, mass = C.startMass, skin = '', at = null, ai = null, mods = null, shield = 0 } = {}) {
    const id = this.nextId++;
    const { x, y } = at ?? this.safeSpawnPoint();
    const a = at?.a ?? Math.atan2(-y, -x) + (Math.random() - 0.5) * 1.2; // face inwards
    const s = {
      id,
      name,
      skin,
      color: color ?? (id - 1) % COLORS.length,
      bot,
      mass,
      x,
      y,
      a,
      ta: a,
      boost: false,
      alive: true,
      px: [],
      py: [],
      team: 0,
      offer: null,
      born: this.time,
      maxMass: mass,
      kills: 0,
      hands: new Set(),
      boostAcc: 0,
      dropAt: 0,
      ai: bot ? { ...newAi(), ...ai } : null,
      mods,
      shield,
      safeUntil: 0,
      hit: '',
    };
    const n = Math.ceil(lengthFor(mass) / C.spacing) + 1;
    for (let i = 0; i < n; i++) {
      s.px.push(x - Math.cos(a) * i * C.spacing);
      s.py.push(y - Math.sin(a) * i * C.spacing);
    }
    // Path point px[i] is point number seq − i; the counter only grows, so a client can ask for "what's new".
    s.seq = n - 1;
    this.snakes.set(id, s);
    return s;
  }

  removeSnake(id) {
    const s = this.snakes.get(id);
    if (!s) return;
    this.leaveTeam(s);
    this.snakes.delete(id);
  }

  setInput(id, angle, boost) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return;
    if (Number.isFinite(angle)) s.ta = angle;
    s.boost = !!boost;
  }

  // --------------------------------------------------------------------------------------------- teams
  teamOf(s) {
    return s.team ? this.teams.get(s.team) : null;
  }
  sameTeam(a, b) {
    return a.team !== 0 && a.team === b.team;
  }
  leaveTeam(s) {
    const t = this.teamOf(s);
    s.team = 0;
    if (!t) return;
    t.members.delete(s.id);
    if (t.members.size <= 1) {
      for (const m of t.members) {
        const o = this.snakes.get(m);
        if (o) o.team = 0;
      }
      this.teams.delete(t.id);
    }
  }
  /** Who s would give a hand to: someone already offering one to s, else the nearest head in range. */
  handCandidate(s) {
    let best = null;
    const range = C.handRange * (1 + radiusFor(s.mass) / 60);
    let bestD = range;
    for (const o of this.snakes.values()) {
      if (o === s || !o.alive || !o.offer || o.offer.to !== s.id || o.offer.until < this.time) continue;
      if (Math.hypot(o.x - s.x, o.y - s.y) < range * 1.6) return o;
    }
    for (const o of this.snakes.values()) {
      if (o === s || !o.alive || this.sameTeam(s, o) || o.ai?.accept === 0) continue; // (rivals never take a hand)
      const size = (this.teamOf(s)?.members.size ?? 1) + (this.teamOf(o)?.members.size ?? 1);
      if (size > C.teamMax) continue;
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }
  /** s offers a hand to its nearest candidate; links at once when the other already offered to s. */
  offerHand(id) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return null;
    const o = this.handCandidate(s);
    if (!o) return null;
    if (o.offer && o.offer.to === s.id && o.offer.until > this.time) {
      this.link(s, o);
      return o;
    }
    s.offer = { to: o.id, until: this.time + 5 };
    this.events.push({ t: 'offer', from: s.id, to: o.id });
    return o;
  }
  link(a, b) {
    const ta = this.teamOf(a);
    const tb = this.teamOf(b);
    if ((ta?.members.size ?? 1) + (tb?.members.size ?? 1) > C.teamMax) return false;
    let team = ta ?? tb;
    if (!team) {
      team = { id: this.nextTeam++, members: new Set(), color: a.color };
      this.teams.set(team.id, team);
    }
    for (const s of [a, b]) {
      const old = this.teamOf(s);
      if (old && old !== team) {
        for (const m of old.members) {
          const o = this.snakes.get(m);
          if (o) {
            o.team = team.id;
            team.members.add(m);
          }
        }
        this.teams.delete(old.id);
      }
      s.team = team.id;
      team.members.add(s.id);
    }
    a.offer = null;
    b.offer = null;
    for (const m of team.members) {
      const s = this.snakes.get(m);
      if (!s) continue;
      for (const n of team.members) if (n !== m) s.hands.add(n);
    }
    this.events.push({ t: 'link', a: a.id, b: b.id, team: team.id });
    return true;
  }

  // --------------------------------------------------------------------------------------------- step
  step(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    for (const s of this.snakes.values()) if (s.alive && s.bot && this.time >= s.ai.next) this.think(s);
    for (const s of this.snakes.values()) if (s.alive) this.move(s, dt);
    this.rebuildBodyGrid();
    const dead = [];
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const killer = this.collision(s);
      if (killer !== null) dead.push([s, killer]);
    }
    for (const [s, killer] of dead) {
      if (s.shield > 0) this.shieldHit(s, killer);
      else this.kill(s, killer);
    }
    for (const s of this.snakes.values()) if (s.alive) this.eat(s);
    this.maintain(dt);
  }

  move(s, dt) {
    const r = radiusFor(s.mass);
    const mods = s.mods;
    const turn = C.turnRate * Math.pow(14 / Math.max(14, r), 0.55) * (mods?.turn ?? 1);
    const d = angleDiff(s.a, s.ta);
    s.a += Math.max(-turn * dt, Math.min(turn * dt, d));
    const boosting = s.boost && s.mass > C.minBoostMass;
    let speed = (boosting ? C.boostSpeed : C.baseSpeed) * (mods?.speed ?? 1);
    if (this.zones.length) speed *= this.slowAt(s.x, s.y);
    s.x += Math.cos(s.a) * speed * dt;
    s.y += Math.sin(s.a) * speed * dt;
    if (boosting) {
      const cost = C.boostCost * dt * (mods?.boost ?? 1);
      s.mass -= cost;
      s.boostAcc += cost;
      if (this.time >= s.dropAt && s.px.length > 2) {
        s.dropAt = this.time + 0.22;
        const tx = s.px[s.px.length - 1];
        const ty = s.py[s.py.length - 1];
        this.addSpark(tx, ty, s.boostAcc * 0.75, 5 + Math.min(4, s.boostAcc), COLORS[s.color], C.deathSparkTtl);
        s.boostAcc = 0;
      }
    }
    // Path points trail the head at fixed spacing.
    let hx = s.px[0];
    let hy = s.py[0];
    let dist = Math.hypot(s.x - hx, s.y - hy);
    while (dist >= C.spacing) {
      const k = C.spacing / dist;
      hx += (s.x - hx) * k;
      hy += (s.y - hy) * k;
      s.px.unshift(hx);
      s.py.unshift(hy);
      s.seq++;
      dist = Math.hypot(s.x - hx, s.y - hy);
    }
    const want = Math.ceil(lengthFor(s.mass) / C.spacing) + 1;
    if (s.px.length > want) {
      s.px.length = want;
      s.py.length = want;
    }
    if (s.offer && s.offer.until < this.time) s.offer = null;
    if (s.mass > s.maxMass) s.maxMass = s.mass;
  }

  rebuildBodyGrid() {
    this.bodyGrid.clear();
    let n = 0;
    const X = this.bpX;
    const Y = this.bpY;
    const O = this.bpOwner;
    const RR = this.bpR;
    const T = this.bpTeam;
    const I = this.bpIdx;
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const r = radiusFor(s.mass);
      for (let i = 0; i < s.px.length; i += 2) {
        X[n] = s.px[i];
        Y[n] = s.py[i];
        O[n] = s.id;
        RR[n] = r;
        T[n] = s.team;
        I[n] = i;
        this.bodyGrid.insert(s.px[i], s.py[i], n);
        n++;
      }
    }
    X.length = Y.length = O.length = RR.length = T.length = I.length = n;
  }

  /**
   * Returns the killer's id (0 for the edge), or null when the head is safe. Running into a body kills; in a
   * head-to-head bump the clearly bigger chain survives (both break when they are about the same size).
   */
  collision(s) {
    const r = radiusFor(s.mass);
    if (this.time < s.safeUntil) return null; // just survived a crash: a moment to get away
    if (!this.inside(s.x + Math.cos(s.a) * r * 0.4, s.y + Math.sin(s.a) * r * 0.4)) {
      s.hit = 'edge';
      return 0; // off the map
    }
    if (this.bars.length || this.movers.length) {
      const b = this.blocked(s.x, s.y, r * 0.8);
      if (b) {
        s.hit = b;
        return 0;
      }
    }
    let killer = null;
    this.bodyGrid.query(s.x, s.y, r + 40, (i) => {
      const owner = this.bpOwner[i];
      if (owner === s.id) return false;
      if (s.team !== 0 && this.bpTeam[i] === s.team) return false;
      const lim = r * 0.9 + this.bpR[i] * 0.8;
      const dx = this.bpX[i] - s.x;
      const dy = this.bpY[i] - s.y;
      if (dx * dx + dy * dy >= lim * lim) return false;
      if (this.bpIdx[i] < 6) {
        const o = this.snakes.get(owner);
        if (o && s.mass > o.mass * 1.15) return false; // head-on, and s is clearly bigger
      }
      killer = owner;
      return true;
    });
    return killer;
  }

  kill(s, killerId) {
    if (!s.alive) return;
    s.alive = false;
    const total = s.mass * 0.75;
    const n = Math.max(5, Math.min(110, Math.floor(s.px.length / 3)));
    const step = s.px.length / n;
    const color = COLORS[s.color];
    for (let k = 0; k < n; k++) {
      const i = Math.floor(k * step);
      const jx = (Math.random() - 0.5) * 16;
      const jy = (Math.random() - 0.5) * 16;
      this.addSpark(s.px[i] + jx, s.py[i] + jy, total / n, 6 + Math.min(5, total / n), color, C.deathSparkTtl);
    }
    const killer = killerId ? this.snakes.get(killerId) : null;
    if (killer) killer.kills += 1;
    this.leaveTeam(s);
    const e = { t: 'death', id: s.id, killer: killerId ?? 0 };
    if (!killerId && s.hit && s.hit !== 'edge') e.cause = s.hit; // roadworks, a bus, a train
    this.events.push(e);
  }

  /** A crash the chain survives (a shield): the back of it lets go, and it turns away from what it hit. */
  shieldHit(s, killerId) {
    s.shield -= 1;
    s.safeUntil = this.time + 1.8;
    const keep = Math.max(C.startMass, s.mass * 0.7);
    const lost = s.mass - keep;
    s.mass = keep;
    const from = Math.floor(s.px.length * 0.6);
    const n = Math.max(3, Math.min(40, Math.floor((s.px.length - from) / 3)));
    for (let k = 0; k < n && lost > 0; k++) {
      const i = Math.min(s.px.length - 1, from + Math.floor(((s.px.length - from) * k) / n));
      this.addSpark(s.px[i] + (Math.random() - 0.5) * 14, s.py[i] + (Math.random() - 0.5) * 14, lost / n, 6, COLORS[s.color], C.deathSparkTtl);
    }
    if (!killerId) {
      // Off the edge or into something: back the way it came.
      s.a += Math.PI;
      s.ta = s.a;
    }
    this.events.push({ t: 'shield', id: s.id, killer: killerId ?? 0, cause: killerId ? '' : s.hit });
  }

  eat(s) {
    const r = radiusFor(s.mass);
    const reach = r + 14 + (s.mods?.reach ?? 0);
    const eaten = [];
    this.sparkGrid.query(s.x, s.y, reach + 12, (sp) => {
      const lim = reach + sp.r;
      const dx = sp.x - s.x;
      const dy = sp.y - s.y;
      if (dx * dx + dy * dy < lim * lim) eaten.push(sp);
      return false;
    });
    if (!eaten.length) return;
    const team = this.teamBonusActive(s) ? C.teamBonus : 1;
    const bonus = team * (s.mods?.value ?? 1);
    let gained = 0;
    for (const sp of eaten) {
      this.removeSpark(sp);
      gained += sp.v * bonus;
    }
    s.mass += gained;
    this.collected += eaten.length;
    this.events.push({ t: 'eat', id: s.id, n: eaten.length, bonus: team > 1 });
  }

  teamBonusActive(s) {
    const t = this.teamOf(s);
    if (!t) return false;
    for (const m of t.members) {
      if (m === s.id) continue;
      const o = this.snakes.get(m);
      if (o && o.alive && Math.hypot(o.x - s.x, o.y - s.y) < C.teamBonusRange) return true;
    }
    return false;
  }

  maintain() {
    for (const sp of this.sparks.values()) {
      if (sp.ttl && this.time - sp.born > sp.ttl) this.removeSpark(sp);
    }
    let natural = 0;
    for (const sp of this.sparks.values()) if (!sp.ttl) natural++;
    for (let k = 0; natural < this.sparkTarget && k < 6; k++, natural++) this.spawnNaturalSpark();
  }

  // --------------------------------------------------------------------------------------------- bots
  /** Is a point dangerous for snake s (a body, a head about to be there, the edge, something in the way)? 0 or 1. */
  hazard(s, x, y, pad, heads) {
    if (!this.roomy(x, y, pad + 30)) return 1;
    if ((this.bars.length || this.movers.length) && this.blocked(x, y, pad + 16, 0.45)) return 1;
    for (const h of heads) {
      const lim = pad + h.r + 26;
      if ((h.x - x) ** 2 + (h.y - y) ** 2 < lim * lim) return 1;
    }
    return this.bodyGrid.query(x, y, pad + 34, (i) => {
      if (this.bpOwner[i] === s.id) return false;
      if (s.team !== 0 && this.bpTeam[i] === s.team) return false;
      const dx = this.bpX[i] - x;
      const dy = this.bpY[i] - y;
      const lim = pad + this.bpR[i];
      return dx * dx + dy * dy < lim * lim;
    })
      ? 1
      : 0;
  }

  /** Where the heads near s will be in a moment, so a bot keeps clear of head-on bumps (`skip` is left out). */
  headsNear(s, range, skip = null) {
    const heads = [];
    for (const o of this.snakes.values()) {
      if (o === s || o === skip || !o.alive || this.sameTeam(s, o)) continue;
      if (Math.hypot(o.x - s.x, o.y - s.y) > range) continue;
      const or = radiusFor(o.mass);
      const sp = o.boost ? C.boostSpeed : C.baseSpeed;
      for (const t of [0.15, 0.35, 0.6]) heads.push({ x: o.x + Math.cos(o.a) * sp * t, y: o.y + Math.sin(o.a) * sp * t, r: or });
    }
    return heads;
  }

  /**
   * Turns s towards (tx, ty), or the safe direction nearest to it: each way it could go is walked forward for 0.6 s
   * the way the chain really turns, and the sooner that path meets a body, a head or the edge, the worse. Returns how
   * soon straight on would have (0: it is clear).
   */
  steer(s, tx, ty, skip = null, margin = 0) {
    const r = radiusFor(s.mass);
    const desired = Math.atan2(ty - s.y, tx - s.x);
    const heads = this.headsNear(s, 380, skip);
    const turn = C.turnRate * Math.pow(14 / Math.max(14, r), 0.55) * (s.mods?.turn ?? 1) * 0.1;
    const speed = (s.boost && s.mass > C.minBoostMass ? C.boostSpeed : C.baseSpeed) * 0.1;
    const pad = r + margin * 0.5;
    let bestA = desired;
    let bestV = -Infinity;
    let danger = 0;
    for (const off of OFFSETS) {
      const cand = desired + off;
      let a = s.a;
      let x = s.x;
      let y = s.y;
      let h = 0;
      for (let k = 1; k <= 6; k++) {
        a += Math.max(-turn, Math.min(turn, angleDiff(a, cand)));
        x += Math.cos(a) * speed;
        y += Math.sin(a) * speed;
        const reach = r * 0.6 + margin;
        if (this.hazard(s, x + Math.cos(a) * reach, y + Math.sin(a) * reach, pad, heads)) {
          h = 7 - k;
          break;
        }
      }
      const v = Math.cos(off) - h * 1.6 - Math.abs(angleDiff(s.a, cand)) * 0.12;
      if (off === 0) danger = h;
      if (v > bestV) {
        bestV = v;
        bestA = cand;
      }
    }
    s.ta = bestA;
    return danger;
  }

  think(s) {
    const ai = s.ai;
    if (ai.role) {
      this.thinkRole(s);
      this.answerHands(s);
      return;
    }
    ai.next = this.time + 0.11 + Math.random() * 0.12;
    let tx;
    let ty;
    let chasing = 0;
    if (!this.roomy(s.x, s.y, 260)) {
      tx = 0;
      ty = 0;
    } else {
      let best = null;
      let bestScore = 0;
      this.sparkGrid.query(s.x, s.y, 360, (sp) => {
        const d = Math.hypot(sp.x - s.x, sp.y - s.y);
        const ahead = Math.cos(angleDiff(s.a, Math.atan2(sp.y - s.y, sp.x - s.x)));
        const sc = (sp.v * (1.2 + ahead)) / (d + 40);
        if (sc > bestScore) {
          bestScore = sc;
          best = sp;
        }
        return false;
      });
      if (best) {
        tx = best.x;
        ty = best.y;
        chasing = bestScore;
      } else {
        if (ai.wx === undefined || this.time > ai.wUntil) {
          const p = this.somewhere(0.6);
          ai.wx = p.x;
          ai.wy = p.y;
          ai.wUntil = this.time + 3 + Math.random() * 3;
        }
        tx = ai.wx;
        ty = ai.wy;
      }
    }
    // Aggressive bots try to cut off a smaller head that is just ahead.
    let hunt = null;
    if (ai.aggr > 0.5 && s.mass > 30) {
      for (const o of this.snakes.values()) {
        if (o === s || !o.alive || this.sameTeam(s, o) || o.mass > s.mass * 0.8) continue;
        const d = Math.hypot(o.x - s.x, o.y - s.y);
        if (d > 260) continue;
        const ang = Math.atan2(o.y - s.y, o.x - s.x);
        if (Math.abs(angleDiff(s.a, ang)) < 0.7) {
          hunt = o;
          break;
        }
      }
      if (hunt) {
        tx = hunt.x + Math.cos(hunt.a) * 120;
        ty = hunt.y + Math.sin(hunt.a) * 120;
      }
    }
    const danger = this.steer(s, tx, ty);
    s.boost = !danger && s.mass > 26 && ((hunt && Math.random() < 0.8) || (chasing > 0.03 && Math.random() < 0.15 * ai.aggr));
    this.answerHands(s);
  }

  /** Hands: friendly bots accept offers and sometimes offer one; ai.accept overrides how likely they say yes. */
  answerHands(s) {
    const ai = s.ai;
    for (const o of this.snakes.values()) {
      if (o === s || !o.alive || !o.offer || o.offer.to !== s.id || o.offer.until < this.time) continue;
      if (!o.offer.considered) {
        o.offer.considered = true;
        if (Math.random() < (ai.accept ?? (ai.friendly ? 0.8 : 0.3))) this.link(o, s);
      }
    }
    if (ai.friendly && !ai.role && !s.offer && Math.random() < 0.02) {
      const c = this.handCandidate(s);
      if (c && c.bot) {
        if (c.ai.friendly && !c.ai.role && Math.random() < 0.5) this.link(s, c);
      } else if (c) {
        s.offer = { to: c.id, until: this.time + 5 };
        this.events.push({ t: 'offer', from: s.id, to: c.id });
      }
    }
  }

  /**
   * The story's bots. ai.role: 'giant' (big and slow: closes a ring around its prey), 'hunter' (cuts across the
   * prey's path), 'raider' (takes the people around its prey, and cuts it off when it is the smaller one), 'guard'
   * (keeps its prey away from ai.guard), 'ally' (stays near ai.home, or walks beside ai.follow once they hold hands).
   * ai.skill (0–1) sets how quick and how accurate; the story sets ai.hunting, ai.target and ai.flank.
   */
  thinkRole(s) {
    const ai = s.ai;
    const skill = ai.skill ?? 0.5;
    ai.next = this.time + (0.2 - 0.12 * skill) * (0.85 + Math.random() * 0.3);
    let plan = null;
    if (!this.roomy(s.x, s.y, 170)) plan = { x: ai.home?.x ?? 0, y: ai.home?.y ?? 0 };
    else if (ai.role === 'ally') plan = this.allyPlan(s);
    else {
      const prey = ai.hunting ? this.snakes.get(ai.target) : null;
      if (prey?.alive && !this.sameTeam(s, prey)) plan = this.huntPlan(s, prey, skill);
    }
    if (!plan) plan = this.forage(s, null);
    const margin = 6 + 16 * skill + (s.boost ? 12 : 0);
    const danger = this.steer(s, plan.x, plan.y, plan.bold ?? null, margin);
    s.boost = !!plan.boost && !danger && s.mass > C.minBoostMass + 8;
  }

  /** People to pick up: the best nearby (around `near`'s path, for a raider), else somewhere to wander. */
  forage(s, near) {
    const ai = s.ai;
    const cx = near ? near.x + Math.cos(near.a) * 170 : s.x;
    const cy = near ? near.y + Math.sin(near.a) * 170 : s.y;
    let best = null;
    let bestScore = 0;
    this.sparkGrid.query(cx, cy, 380, (sp) => {
      const d = Math.hypot(sp.x - s.x, sp.y - s.y);
      const ahead = Math.cos(angleDiff(s.a, Math.atan2(sp.y - s.y, sp.x - s.x)));
      const sc = (sp.v * (1.2 + ahead)) / (d + 40);
      if (sc > bestScore) {
        bestScore = sc;
        best = sp;
      }
      return false;
    });
    if (best) return { x: best.x, y: best.y, boost: !!near && Math.random() < 0.35 };
    if (near) return { x: cx, y: cy };
    if (ai.wx === undefined || this.time > ai.wUntil) {
      const p = this.somewhere(0.6);
      ai.wx = p.x;
      ai.wy = p.y;
      ai.wUntil = this.time + 3 + Math.random() * 3;
    }
    return { x: ai.wx, y: ai.wy };
  }

  allyPlan(s) {
    const ai = s.ai;
    const lead = ai.follow ? this.snakes.get(ai.follow) : null;
    if (lead?.alive && this.sameTeam(s, lead)) {
      // Holding hands: walk beside the one who came for us.
      ai.side ??= Math.random() < 0.5 ? 1 : -1;
      const a = lead.a + ai.side * 2.3;
      return { x: lead.x + Math.cos(a) * 120, y: lead.y + Math.sin(a) * 120, boost: lead.boost };
    }
    // Away from any other chain that comes close.
    let fx = 0;
    let fy = 0;
    for (const o of this.snakes.values()) {
      if (o === s || !o.alive || this.sameTeam(s, o) || o.id === ai.follow) continue;
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d < 320) {
        fx += (s.x - o.x) / (d + 1);
        fy += (s.y - o.y) / (d + 1);
      }
    }
    if (fx || fy) return { x: s.x + fx * 300, y: s.y + fy * 300, boost: true };
    const home = ai.home ?? { x: s.x, y: s.y };
    if (ai.wx === undefined || this.time > ai.wUntil) {
      const a = Math.random() * TAU;
      const d = 80 + Math.random() * 170;
      ai.wx = home.x + Math.cos(a) * d;
      ai.wy = home.y + Math.sin(a) * d;
      if (!this.roomy(ai.wx, ai.wy, 60)) {
        ai.wx = home.x;
        ai.wy = home.y;
      }
      ai.wUntil = this.time + 2 + Math.random() * 3;
    }
    return { x: ai.wx, y: ai.wy };
  }

  /** How a story bot goes after its prey; returns { x, y, boost, bold } (bold: the prey's head is not a worry). */
  huntPlan(s, prey, skill) {
    const ai = s.ai;
    const pr = radiusFor(prey.mass);
    const dx = prey.x - s.x;
    const dy = prey.y - s.y;
    const d = Math.hypot(dx, dy);
    // How fast the prey is turning, measured between thoughts.
    if (ai.pid !== prey.id) {
      ai.pid = prey.id;
      ai.pa = prey.a;
      ai.pt = this.time;
      ai.w = 0;
      ai.orbit = null;
    } else if (this.time - ai.pt > 0.05) {
      const w = angleDiff(ai.pa, prey.a) / (this.time - ai.pt);
      ai.w = Math.max(-3, Math.min(3, w)) * 0.6 + (ai.w ?? 0) * 0.4;
      ai.pa = prey.a;
      ai.pt = this.time;
    }
    const bigger = s.mass > prey.mass * 1.2;
    const fx = Math.cos(prey.a);
    const fy = Math.sin(prey.a);
    const along = -dx * fx - dy * fy; // how far in front of the prey's head s is
    const side = -fx * dy + fy * dx; // which side of its path s is on
    // A giant long enough to go round its prey closes a ring on it, tighter and tighter.
    if (ai.role === 'giant' && lengthFor(s.mass) > 1000 && d < 650) {
      if (!ai.orbit) ai.orbit = { dir: side > 0 ? 1 : -1, R: Math.min(420, Math.max(220, d)) };
      ai.orbit.R = Math.max(70 + pr * 3, ai.orbit.R - (3 + 5 * skill));
      const ang = Math.atan2(s.y - prey.y, s.x - prey.x) + ai.orbit.dir * (0.5 + 0.3 * skill);
      return {
        x: prey.x + Math.cos(ang) * ai.orbit.R,
        y: prey.y + Math.sin(ang) * ai.orbit.R,
        boost: Math.random() < skill * 0.5,
        bold: bigger ? prey : null,
      };
    }
    ai.orbit = null;
    // A guard only chases near what it guards; a raider only a smaller prey close by.
    if (ai.role === 'guard' && ai.guard && Math.hypot(prey.x - ai.guard.x, prey.y - ai.guard.y) > 520) {
      const a = this.time * 0.6 + (ai.phase ?? 0);
      return { x: ai.guard.x + Math.cos(a) * 170, y: ai.guard.y + Math.sin(a) * 170 };
    }
    if (ai.role === 'raider' && !(prey.mass < s.mass * 0.9 && d < 420)) return this.forage(s, prey);
    // In front of it and close: run straight across its path, so the chain lies in its way.
    const across = prey.a - Math.sign(side || 1) * (Math.PI / 2 - 0.45);
    if (along > pr + 40 && along < 240 + 140 * skill && Math.abs(side) < 230 && Math.abs(angleDiff(s.a, across)) < 1.2) {
      const h = across;
      ai.mode = 'cut';
      return { x: s.x + Math.cos(h) * 220, y: s.y + Math.sin(h) * 220, boost: Math.random() < 0.3 + 0.7 * skill, bold: bigger ? prey : null };
    }
    // Otherwise: walk the prey's head forward in time (reading its turn, the better the bot) and head for the first
    // point just in front of it that can be reached in time. A second hunter aims wide (ai.flank) to close the gap.
    const pSpeed = prey.boost && prey.mass > C.minBoostMass ? C.boostSpeed : C.baseSpeed;
    const mySpeed = s.mass > C.minBoostMass + 10 ? C.boostSpeed : C.baseSpeed;
    const lead = pr * 2 + 45 + (1 - skill) * 50 + (ai.flank ? 90 : 0);
    // Behind it, never along its trail (that is where its body is): overtake in a lane beside it, on our side.
    const lane = along < pr + 40 ? Math.sign(side || 1) * (pr * 2 + radiusFor(s.mass) + 60) : 0;
    const off = lane + (ai.flank ?? 0) * 110;
    let px = prey.x;
    let py = prey.y;
    let pa = prey.a;
    let ax = px;
    let ay = py;
    for (let t = 0.15; t <= 2.4; t += 0.15) {
      pa += (ai.w ?? 0) * 0.15 * skill;
      px += Math.cos(pa) * pSpeed * 0.15;
      py += Math.sin(pa) * pSpeed * 0.15;
      ax = px + Math.cos(pa) * lead + Math.sin(pa) * off;
      ay = py + Math.sin(pa) * lead - Math.cos(pa) * off;
      if (Math.hypot(ax - s.x, ay - s.y) <= mySpeed * t * (0.7 + 0.3 * skill)) break;
    }
    const noise = (1 - skill) * 70;
    ai.mode = 'chase';
    return {
      x: ax + (Math.random() - 0.5) * noise,
      y: ay + (Math.random() - 0.5) * noise,
      boost: d > 260 && d < 700 && Math.random() < 0.25 + 0.55 * skill,
    };
  }
}

const OFFSETS = [0, 0.45, -0.45, 0.95, -0.95, 1.5, -1.5, 2.3, -2.3, Math.PI];

function newAi() {
  return { next: 0, aggr: Math.random(), friendly: Math.random() < 0.55, wx: undefined, wy: undefined, wUntil: 0 };
}

/** Squared distance from (px, py) to the segment (ax, ay)–(bx, by). */
function segDist2(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let k = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  k = Math.max(0, Math.min(1, k));
  const x = ax + vx * k - px;
  const y = ay + vy * k - py;
  return x * x + y * y;
}

export function botName() {
  return pick(BOT_NAMES);
}

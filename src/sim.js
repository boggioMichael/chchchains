// Ch-ch-chains — the world simulation. Pure logic with no DOM, so the same code runs in the browser (solo play with
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
  /** A random place for people: on the streets when the world has a map, else anywhere inside the arena. */
  somewhere(reach = 0.97) {
    if (this.spawnPoint) {
      for (let k = 0; k < 4; k++) {
        const p = this.spawnPoint();
        if (Math.hypot(p.x, p.y) < this.R * reach) return p;
      }
    }
    const rr = this.R * reach * Math.sqrt(Math.random());
    const a = Math.random() * TAU;
    return { x: Math.cos(a) * rr, y: Math.sin(a) * rr };
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
        this.addSpark(cx + Math.cos(ra) * rd, cy + Math.sin(ra) * rd, 1, 4.5 + Math.random() * 2, color);
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

  addSnake({ name = randomName(), color, bot = false, mass = C.startMass } = {}) {
    const id = this.nextId++;
    const { x, y } = this.safeSpawnPoint();
    const a = Math.atan2(-y, -x) + (Math.random() - 0.5) * 1.2; // face inwards
    const s = {
      id,
      name,
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
      ai: bot ? newAi() : null,
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
      if (o === s || !o.alive || this.sameTeam(s, o)) continue;
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
    for (const [s, killer] of dead) this.kill(s, killer);
    for (const s of this.snakes.values()) if (s.alive) this.eat(s);
    this.maintain(dt);
  }

  move(s, dt) {
    const r = radiusFor(s.mass);
    const turn = C.turnRate * Math.pow(14 / Math.max(14, r), 0.55);
    const d = angleDiff(s.a, s.ta);
    s.a += Math.max(-turn * dt, Math.min(turn * dt, d));
    const boosting = s.boost && s.mass > C.minBoostMass;
    const speed = boosting ? C.boostSpeed : C.baseSpeed;
    s.x += Math.cos(s.a) * speed * dt;
    s.y += Math.sin(s.a) * speed * dt;
    if (boosting) {
      const cost = C.boostCost * dt;
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
    if (Math.hypot(s.x, s.y) > this.R - r * 0.6) return 0;
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
    this.events.push({ t: 'death', id: s.id, killer: killerId ?? 0 });
  }

  eat(s) {
    const r = radiusFor(s.mass);
    const reach = r + 14;
    const eaten = [];
    this.sparkGrid.query(s.x, s.y, reach + 12, (sp) => {
      const lim = reach + sp.r;
      const dx = sp.x - s.x;
      const dy = sp.y - s.y;
      if (dx * dx + dy * dy < lim * lim) eaten.push(sp);
      return false;
    });
    if (!eaten.length) return;
    const bonus = this.teamBonusActive(s) ? C.teamBonus : 1;
    let gained = 0;
    for (const sp of eaten) {
      this.removeSpark(sp);
      gained += sp.v * bonus;
    }
    s.mass += gained;
    this.collected += eaten.length;
    this.events.push({ t: 'eat', id: s.id, n: eaten.length, bonus: bonus > 1 });
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
  /** Is a point dangerous for snake s (another body or a head about to be there, or the edge)? Returns 0 or 1. */
  hazard(s, x, y, pad, heads) {
    if (Math.hypot(x, y) > this.R - pad - 30) return 1;
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

  think(s) {
    const ai = s.ai;
    ai.next = this.time + 0.11 + Math.random() * 0.12;
    const r = radiusFor(s.mass);
    let tx;
    let ty;
    const fromCenter = Math.hypot(s.x, s.y);
    let chasing = 0;
    if (fromCenter > this.R * 0.84) {
      tx = 0;
      ty = 0;
    } else {
      let best = null;
      let bestScore = 0;
      this.sparkGrid.query(s.x, s.y, 360, (sp) => {
        const d = Math.hypot(sp.x - s.x, sp.y - s.y);
        const ahead = Math.cos(angleDiff(s.a, Math.atan2(sp.y - s.y, sp.x - s.x)));
        const sc = (sp.v * (1.2 + ahead)) / (d + 40);
        if (sc <= bestScore) return false;
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
    const desired = Math.atan2(ty - s.y, tx - s.x);
    const look = [r * 1.4 + 22, r * 1.6 + 70, r * 1.8 + 130];
    // Where nearby heads will be shortly: bots steer clear of head-on bumps.
    const heads = [];
    for (const o of this.snakes.values()) {
      if (o === s || !o.alive || this.sameTeam(s, o)) continue;
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d > 360) continue;
      const or = radiusFor(o.mass);
      const sp = o.boost ? C.boostSpeed : C.baseSpeed;
      for (const t of [0.15, 0.35, 0.6]) heads.push({ x: o.x + Math.cos(o.a) * sp * t, y: o.y + Math.sin(o.a) * sp * t, r: or });
    }
    let bestA = desired;
    let bestV = -Infinity;
    let danger = 0;
    for (const off of OFFSETS) {
      const cand = desired + off;
      let h = 0;
      for (let k = 0; k < look.length; k++) {
        h += this.hazard(s, s.x + Math.cos(cand) * look[k], s.y + Math.sin(cand) * look[k], r, heads) * (3 - k);
      }
      const v = Math.cos(off) - h * 2.2 - Math.abs(angleDiff(s.a, cand)) * 0.12;
      if (off === 0) danger = h;
      if (v > bestV) {
        bestV = v;
        bestA = cand;
      }
    }
    s.ta = bestA;
    s.boost = !danger && s.mass > 26 && ((hunt && Math.random() < 0.8) || (chasing > 0.03 && Math.random() < 0.15 * ai.aggr));
    // Hands: friendly bots accept offers and sometimes offer one.
    for (const o of this.snakes.values()) {
      if (o === s || !o.alive || !o.offer || o.offer.to !== s.id || o.offer.until < this.time) continue;
      if (!o.offer.considered) {
        o.offer.considered = true;
        if (Math.random() < (ai.friendly ? 0.8 : 0.3)) this.link(o, s);
      }
    }
    if (ai.friendly && !s.offer && Math.random() < 0.02) {
      const c = this.handCandidate(s);
      if (c && c.bot) {
        if (c.ai.friendly && Math.random() < 0.5) this.link(s, c);
      } else if (c) {
        s.offer = { to: c.id, until: this.time + 5 };
        this.events.push({ t: 'offer', from: s.id, to: c.id });
      }
    }
  }
}

const OFFSETS = [0, 0.45, -0.45, 0.95, -0.95, 1.5, -1.5, 2.3, -2.3, Math.PI];

function newAi() {
  return { next: 0, aggr: Math.random(), friendly: Math.random() < 0.55, wx: undefined, wy: undefined, wUntil: 0 };
}

export function botName() {
  return pick(BOT_NAMES);
}

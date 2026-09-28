// Ch-ch-chains — multiplayer game server. Zero dependencies: Node's http + a small RFC 6455 WebSocket implementation.
// Serves the game page and runs authoritative rooms (the same simulation as the browser), each topped up with
// labelled bots while few people are playing. No accounts, cookies or stored personal data: IP addresses are used
// only in memory for connection limits and are never logged.
//
//   PORT=3000 node server.mjs          (see README.md for every setting)
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { World, C, COLORS, SPARK_COLORS, NOUNS, ADJS, PLACES, scoreOf, botName } from './src/sim.js';
import { streetSpawner } from './src/streets.js';
import {
  encodeSnapshot,
  FLAG_BOOST,
  FLAG_BOT,
  FLAG_OFFERS_ME,
  FLAG_I_OFFERED,
  FLAG_FULL,
  FLAG_CANDIDATE,
} from './src/protocol.js';

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const PORT = num(env.PORT, 3000);
const HOST = env.HOST || '0.0.0.0';
const TRUST_PROXY = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true' || !!env.RENDER;
const ROOM_CLIENTS = num(env.ROOM_CLIENTS, 40); // people per room (players and watchers)
const BOT_FILL = num(env.BOT_FILL, 18); // a room keeps this many chains alive, adding bots while people are few
const MAX_CLIENTS = num(env.MAX_CLIENTS, 300); // whole server; beyond this new visitors play offline with bots
const MAX_PER_IP = num(env.MAX_PER_IP, 60); // generous: mobile carriers put many people behind one address
// Pages allowed to connect, e.g. "https://chchchains*.onrender.com,https://example.org" (* = letters, digits, -).
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)
  .map((s) => new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*')}$`, 'i'));
const ARENA = num(env.ARENA_RADIUS, 3000); // the same size and spark density as offline play
const SPARKS = num(env.SPARK_TARGET, 850);
const TICK = 1 / 30;
const TICK_MS = TICK * 1000;
const SNAPSHOT_EVERY = 2; // ticks: 15 snapshots per second
const PALETTE = [...COLORS, ...SPARK_COLORS];
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3
const VERSION = 2;

const QUIET = env.LOG === 'off';
const log = (msg, fields = {}) => {
  if (!QUIET) console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
};

// ------------------------------------------------------------------------------------------------ page
const DOCS = new URL('./docs/', import.meta.url);
const STATIC = {
  'og.jpg': 'image/jpeg',
  'icon-192.png': 'image/png',
  'icon-512.png': 'image/png',
  'apple-touch-icon.png': 'image/png',
  'manifest.webmanifest': 'application/manifest+json',
};

function loadPage() {
  const raw = readFileSync(new URL('index.html', DOCS), 'utf8');
  // Served by this server: the page talks to this same origin, and this response carries its own CSP header.
  const html = raw
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '')
    .replace(/window\.CHAIN_CONFIG = (\{.*?\});/, (_, json) => {
      const cfg = JSON.parse(json);
      cfg.server = '';
      cfg.sameOrigin = true;
      if (env.CHAIN_BRAND !== undefined) cfg.brand = env.CHAIN_BRAND;
      if (env.CHAIN_PUBLISHER !== undefined) cfg.publisher = env.CHAIN_PUBLISHER;
      if (env.CHAIN_JOIN_URL !== undefined) cfg.joinUrl = env.CHAIN_JOIN_URL;
      if (env.CHAIN_SHARE_URL !== undefined) cfg.shareUrl = env.CHAIN_SHARE_URL;
      return `window.CHAIN_CONFIG = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};`;
    });
  const hashes = { script: [], style: [] };
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) hashes.script.push(sha256(m[1]));
  for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) hashes.style.push(sha256(m[1]));
  const csp = [
    "default-src 'self'",
    `script-src ${hashes.script.map((h) => `'sha256-${h}'`).join(' ')}`,
    `style-src ${hashes.style.map((h) => `'sha256-${h}'`).join(' ')}`,
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');
  return { html: Buffer.from(html), csp };
}
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}
let page = loadPage();

// ------------------------------------------------------------------------------------------------ cities
// Each room plays in a city (docs/maps, built by tools/map/build.py): people turn up along its real streets.
// A new room takes the city of the hour, the same one offline players see.
function loadCities() {
  try {
    const index = JSON.parse(readFileSync(new URL('maps/index.json', DOCS), 'utf8'));
    return index.cities
      .map((c) => {
        try {
          const data = JSON.parse(readFileSync(new URL(`maps/${c.id}.json`, DOCS), 'utf8'));
          const spawn = streetSpawner(data.roads, data.R);
          return spawn ? { id: c.id, R: data.R, spawn } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return []; // no maps: rooms are plain circles
  }
}
const CITIES = env.CITIES === 'off' ? [] : loadCities();
function hourCity() {
  return CITIES.length ? CITIES[Math.floor(Date.now() / 3_600_000) % CITIES.length] : null;
}

// ------------------------------------------------------------------------------------------------ names
const VALID_NAMES = new Set();
for (const n of NOUNS) {
  for (const a of ADJS) VALID_NAMES.add(`${n} ${a}`);
  for (const p of PLACES) VALID_NAMES.add(`${n} ${p}`);
}
/** Players pick among generated names only, so there is nothing offensive to moderate. */
function cleanName(name) {
  if (typeof name === 'string' && VALID_NAMES.has(name)) return name;
  return `${NOUNS[Math.floor(Math.random() * NOUNS.length)]} ${ADJS[Math.floor(Math.random() * ADJS.length)]}`;
}
function label(s) {
  return s.bot ? `🤖 ${s.name}` : s.name;
}

// ------------------------------------------------------------------------------------------------ rooms
const rooms = new Set();
const clients = new Set();
const metrics = { joins: 0, links: 0, peakOnline: 0, connections: 0, refused: 0, bytesOut: 0, tickMs: 0, tickMax: 0 };

function onlineCount() {
  let n = 0;
  for (const r of rooms) n += r.players();
  return n;
}

class Room {
  constructor() {
    this.id = randomBytes(3).toString('hex');
    this.city = hourCity();
    this.world = this.city
      ? new World({ arenaRadius: this.city.R, sparkTarget: num(env.SPARK_TARGET, 900), spawnPoint: this.city.spawn })
      : new World({ arenaRadius: ARENA, sparkTarget: SPARKS });
    this.clients = new Set();
    this.bySnake = new Map(); // snake id → client
    this.emptySince = Date.now();
    this.tickN = 0;
    this.gen = 0;
    this.closed = false;
    this.bounds = new Map(); // snake id → [minX, minY, maxX, maxY], refreshed before each round of snapshots
    this.leader = null;
    for (let i = 0; i < BOT_FILL; i++) this.world.addSnake({ bot: true, name: botName(), mass: 12 + Math.random() * 60 });
    for (let i = 0; i < 60; i++) {
      this.world.step(TICK);
      this.world.events.length = 0;
    }
    this.world.sparkLog = { added: [], removed: [] }; // sparks that came and went since the last snapshots
    this.snapN = 0;
    this.next = performance.now();
    this.timer = setTimeout(() => this.loop(), 0);
    rooms.add(this);
    log('room.open', { room: this.id, city: this.city?.id ?? '', rooms: rooms.size });
  }
  /** People here right now: playing, between rounds or watching. */
  players() {
    return this.clients.size;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    rooms.delete(this);
    log('room.close', { room: this.id, rooms: rooms.size });
  }
  /** Fixed-step loop that keeps room time in step with the wall clock (catching up a few ticks when late). */
  loop() {
    if (this.closed) return;
    const now = performance.now();
    let steps = 0;
    while (this.next <= now && steps < 4) {
      const t0 = performance.now();
      this.tick();
      const ms = performance.now() - t0;
      metrics.tickMs = metrics.tickMs * 0.99 + ms * 0.01;
      metrics.tickMax = Math.max(metrics.tickMax, ms);
      this.next += TICK_MS;
      steps++;
    }
    if (this.next <= now) this.next = now + TICK_MS; // far behind: drop the backlog rather than race
    if (this.closed) return;
    this.timer = setTimeout(() => this.loop(), Math.max(1, this.next - performance.now()));
  }
  tick() {
    const w = this.world;
    w.step(TICK);
    this.tickN++;
    this.handleEvents();
    this.fillBots();
    if (this.tickN % SNAPSHOT_EVERY === 0) {
      this.prepareSnapshots();
      for (const c of this.clients) this.sendSnapshot(c);
      w.sparkLog.added.length = 0;
      w.sparkLog.removed.length = 0;
    }
    if (this.tickN % 30 === 0) this.sendBoards();
    if (this.clients.size) this.emptySince = Date.now();
    else if (Date.now() - this.emptySince > 60_000) this.close();
  }
  handleEvents() {
    const w = this.world;
    const at = Math.round(w.time * 1000);
    for (const e of w.events) {
      if (e.t === 'death') {
        const s = w.snakes.get(e.id);
        const killer = e.killer ? w.snakes.get(e.killer) : null;
        const c = this.bySnake.get(e.id);
        if (c) {
          c.send({ t: 'dead', at, killer: e.killer || 0, name: killer ? label(killer) : '', edge: e.killer === 0 });
          this.bySnake.delete(e.id);
          c.snakeId = 0;
          if (s) {
            c.lastX = s.x;
            c.lastY = s.y;
          }
        }
        const kc = e.killer ? this.bySnake.get(e.killer) : null;
        if (kc && s) kc.send({ t: 'ev', k: 'broke', at, id: s.id, name: label(s) });
      } else if (e.t === 'link') {
        metrics.links++;
        const a = w.snakes.get(e.a);
        const b = w.snakes.get(e.b);
        this.bySnake.get(e.a)?.send({ t: 'ev', k: 'link', at, id: e.b, name: b ? label(b) : '' });
        this.bySnake.get(e.b)?.send({ t: 'ev', k: 'link', at, id: e.a, name: a ? label(a) : '' });
      } else if (e.t === 'offer') {
        const from = w.snakes.get(e.from);
        const to = w.snakes.get(e.to);
        this.bySnake.get(e.to)?.send({ t: 'ev', k: 'offer', at, id: e.from, name: from ? label(from) : '' });
        this.bySnake.get(e.from)?.send({ t: 'ev', k: 'offered', at, id: e.to, name: to ? label(to) : '' });
      }
    }
    w.events.length = 0;
    // Broken chains leave the world a moment later (their sparks stay).
    for (const s of w.snakes.values()) {
      if (s.alive) continue;
      s.goneAt ??= w.time;
      if (w.time - s.goneAt > 1) w.removeSnake(s.id);
    }
  }
  fillBots() {
    const w = this.world;
    let people = 0;
    let bots = 0;
    for (const s of w.snakes.values()) {
      if (!s.alive) continue;
      if (s.bot) bots++;
      else people++;
    }
    const want = Math.max(0, BOT_FILL - people);
    if (bots < want && this.tickN % 20 === 0) w.addSnake({ bot: true, name: botName() });
    if (bots > want + 2 && this.tickN % 90 === 0) {
      // More bots than the people here need: retire the smallest one.
      let smallest = null;
      for (const s of w.snakes.values()) if (s.bot && s.alive && (!smallest || s.mass < smallest.mass)) smallest = s;
      if (smallest) w.kill(smallest, null);
    }
  }
  prepareSnapshots() {
    this.gen++;
    this.snapN++;
    this.bounds.clear();
    let leader = null;
    for (const s of this.world.snakes.values()) {
      if (!s.alive) continue;
      let x0 = s.x;
      let y0 = s.y;
      let x1 = s.x;
      let y1 = s.y;
      for (let i = 0; i < s.px.length; i += 4) {
        const x = s.px[i];
        const y = s.py[i];
        if (x < x0) x0 = x;
        else if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        else if (y > y1) y1 = y;
      }
      this.bounds.set(s.id, [x0, y0, x1, y1]);
      // Watchers follow the longest person (or the longest chain while only bots are around).
      if (!leader || (leader.bot && !s.bot) || (leader.bot === s.bot && s.mass > leader.mass)) leader = s;
    }
    this.leader = leader;
  }
  sendSnapshot(c) {
    const sock = c.ws.socket;
    if (sock.writableLength > 1024 * 1024) return c.ws.close(1008, 'too slow');
    if (sock.writableLength > 128 * 1024) {
      c.needFull = true; // slow connection: skip a frame rather than queue it, and resync sparks after
      return;
    }
    const w = this.world;
    const me = c.snakeId ? w.snakes.get(c.snakeId) : null;
    if (!me && c.mode === 'idle') return;
    let focus = me;
    if (!me && c.mode === 'watch' && this.leader) focus = this.leader;
    if (focus) {
      c.lastX = focus.x;
      c.lastY = focus.y;
    }
    if ((focus?.id ?? 0) !== c.focusId) {
      c.focusId = focus?.id ?? 0;
      c.needFull = true; // the view may have jumped
    }
    const cx = c.lastX;
    const cy = c.lastY;
    const gen = this.gen;
    const cand = me ? w.handCandidate(me) : null;
    const snakes = [];
    const fresh = [];
    for (const s of w.snakes.values()) {
      if (!s.alive) continue;
      const known = c.known.get(s.id);
      const margin = known ? 420 : 160; // hysteresis: a chain at the edge of the view does not flicker in and out
      const b = this.bounds.get(s.id);
      if (!b || b[2] < cx - c.vw - margin || b[0] > cx + c.vw + margin || b[3] < cy - c.vh - margin || b[1] > cy + c.vh + margin) {
        continue;
      }
      let flags = 0;
      if (s.boost && s.mass > C.minBoostMass) flags |= FLAG_BOOST;
      if (s.bot) flags |= FLAG_BOT;
      if (me && s.offer && s.offer.to === me.id && s.offer.until > w.time) flags |= FLAG_OFFERS_ME;
      if (me && me.offer && me.offer.to === s.id && me.offer.until > w.time) flags |= FLAG_I_OFFERED;
      if (cand === s) flags |= FLAG_CANDIDATE;
      let count;
      if (known && s.seq >= known.seq && s.seq - known.seq < Math.min(120, s.px.length)) {
        count = s.seq - known.seq;
      } else {
        flags |= FLAG_FULL;
        count = s.px.length;
      }
      snakes.push({
        id: s.id,
        color: s.color,
        flags,
        team: s.team,
        x: s.x,
        y: s.y,
        a: s.a,
        mass: s.mass,
        seq: s.seq,
        len: s.px.length,
        px: s.px,
        py: s.py,
        count,
      });
      if (known) {
        known.seq = s.seq;
        known.gen = gen;
      } else c.known.set(s.id, { seq: s.seq, gen });
      if (!c.names.has(s.id)) {
        c.names.add(s.id);
        fresh.push([s.id, s.name, s.bot ? 1 : 0]);
      }
    }
    for (const [id, k] of c.known) if (k.gen !== gen) c.known.delete(id); // left the view: full body next time
    // Sparks: a full sweep of the view every fourth snapshot (or after a jump); in between only the sparks that
    // appeared or disappeared since the last round. The view margin covers what the camera can travel meanwhile.
    const newSparks = [];
    const goneSparks = [];
    const inner = [c.vw + 160, c.vh + 160];
    const outer = [c.vw + 420, c.vh + 420];
    const spark = (sp) => ({
      id: sp.id,
      x: sp.x,
      y: sp.y,
      r: sp.r,
      color: Math.max(0, PALETTE.indexOf(sp.color)),
      left: sp.ttl ? Math.max(1, sp.ttl - (w.time - sp.born)) : 0,
    });
    if (c.needFull || (this.snapN + c.phase) % 4 === 0) {
      c.needFull = false;
      w.sparkGrid.query(cx, cy, Math.hypot(outer[0], outer[1]), (sp) => {
        const dx = Math.abs(sp.x - cx);
        const dy = Math.abs(sp.y - cy);
        if (dx > outer[0] || dy > outer[1]) return false;
        if (c.sparks.has(sp.id)) c.sparks.set(sp.id, gen);
        else if (dx <= inner[0] && dy <= inner[1]) {
          c.sparks.set(sp.id, gen);
          newSparks.push(spark(sp));
        }
        return false;
      });
      for (const [id, g] of c.sparks) {
        if (g !== gen) {
          c.sparks.delete(id);
          goneSparks.push(id);
        }
      }
    } else {
      for (const sp of w.sparkLog.added) {
        if (c.sparks.has(sp.id) || !w.sparks.has(sp.id)) continue;
        if (Math.abs(sp.x - cx) <= inner[0] && Math.abs(sp.y - cy) <= inner[1]) {
          c.sparks.set(sp.id, gen);
          newSparks.push(spark(sp));
        }
      }
      for (const id of w.sparkLog.removed) if (c.sparks.delete(id)) goneSparks.push(id);
    }
    if (fresh.length) c.send({ t: 'names', list: fresh });
    c.ws.sendBinary(
      encodeSnapshot({
        time: Math.round(w.time * 1000),
        me: me ? me.id : 0,
        focus: focus ? focus.id : 0,
        snakes,
        newSparks,
        goneSparks,
      }),
    );
  }
  sendBoards() {
    const w = this.world;
    const alive = [];
    for (const s of w.snakes.values()) if (s.alive) alive.push(s);
    alive.sort((a, b) => b.mass - a.mass);
    const top = alive.slice(0, 5).map((s) => [s.id, s.name, scoreOf(s.mass), s.color, s.bot ? 1 : 0]);
    let people = 0;
    for (const s of alive) if (!s.bot) people++;
    const online = onlineCount();
    for (const c of this.clients) {
      if (c.mode === 'idle') continue;
      const me = c.snakeId ? w.snakes.get(c.snakeId) : null;
      c.send({
        t: 'lb',
        top,
        rank: me ? alive.indexOf(me) + 1 : 0,
        total: alive.length,
        people,
        bots: alive.length - people,
        online,
        hands: me ? me.hands.size : 0,
      });
    }
  }
}

function pickRoom() {
  let best = null;
  for (const r of rooms) {
    const n = r.clients.size;
    if (!r.closed && n < ROOM_CLIENTS && (!best || n > best.clients.size)) best = r;
  }
  return best ?? new Room();
}

// ------------------------------------------------------------------------------------------------ clients
const perIp = new Map();

class Client {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
    this.room = null;
    this.mode = 'idle'; // 'idle' (not in a room) | 'watch' (spectating the room's leader) | 'play'
    this.snakeId = 0;
    this.known = new Map(); // snake id → { seq, gen }: path points this client already has
    this.sparks = new Map(); // spark id → gen
    this.needFull = true;
    this.phase = Math.floor(Math.random() * 4); // spreads full spark sweeps across snapshot rounds
    this.focusId = 0;
    this.names = new Set();
    this.vw = 700;
    this.vh = 1300;
    this.lastX = 0;
    this.lastY = 0;
    this.tokens = 60;
    this.refill = Date.now();
    this.strikes = 0;
    this.lastMsg = Date.now();
  }
  send(obj) {
    this.ws.sendText(JSON.stringify(obj));
  }
  allow() {
    const now = Date.now();
    this.tokens = Math.min(80, this.tokens + ((now - this.refill) / 1000) * 40);
    this.refill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    if (++this.strikes > 200) this.ws.close(1008, 'rate');
    return false;
  }
  view(m) {
    if (Number.isFinite(m.vw)) this.vw = Math.max(300, Math.min(1900, m.vw));
    if (Number.isFinite(m.vh)) this.vh = Math.max(300, Math.min(1900, m.vh));
  }
  onMessage(text) {
    this.lastMsg = Date.now();
    if (!this.allow()) return;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'in':
        this.view(m);
        if (this.snakeId && this.room) this.room.world.setInput(this.snakeId, Number(m.a), m.b === 1 || m.b === true);
        break;
      case 'hand':
        if (this.snakeId && this.room) this.room.world.offerHand(this.snakeId);
        break;
      case 'join':
        this.view(m);
        this.join(m.name);
        break;
      case 'watch':
        this.view(m);
        if (this.mode !== 'play' || !this.snakeId) {
          this.enterRoom();
          this.mode = 'watch';
        }
        break;
      case 'idle':
        this.leaveRoom();
        break;
      default: // 'hb' and anything unknown: only counts as activity
    }
  }
  enterRoom() {
    if (this.room) return;
    this.room = pickRoom();
    this.room.clients.add(this);
    this.known.clear();
    this.sparks.clear();
    this.names.clear();
    this.needFull = true;
    this.send({ t: 'room', R: this.room.world.R, city: this.room.city?.id ?? '' });
  }
  join(name) {
    if (this.snakeId && this.room?.world.snakes.get(this.snakeId)?.alive) return;
    this.enterRoom();
    const s = this.room.world.addSnake({ name: cleanName(name) });
    this.snakeId = s.id;
    this.mode = 'play';
    this.room.bySnake.set(s.id, this);
    this.lastX = s.x;
    this.lastY = s.y;
    metrics.joins++;
    this.send({ t: 'joined', id: s.id, name: s.name, color: s.color });
    metrics.peakOnline = Math.max(metrics.peakOnline, onlineCount());
  }
  leaveRoom() {
    const r = this.room;
    if (r) {
      const s = this.snakeId ? r.world.snakes.get(this.snakeId) : null;
      if (s?.alive) r.world.kill(s, null); // nobody steers it any more: it breaks into sparks for everyone else
      r.bySnake.delete(this.snakeId);
      r.clients.delete(this);
    }
    this.room = null;
    this.snakeId = 0;
    this.mode = 'idle';
  }
}

// ------------------------------------------------------------------------------------------------ WebSocket
class Ws {
  constructor(socket, onText, onClose) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.onText = onText;
    this.onClose = onClose;
    this.closed = false;
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (d) => this.data(d));
    // Upgraded sockets are half-open capable (http.Server sets allowHalfOpen): the peer hanging up only ends
    // its side, so finish ours too.
    socket.on('end', () => {
      this.finish();
      socket.destroy();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    if (!this.socket.destroyed) setTimeout(() => this.socket.destroy(), 2000).unref();
  }
  data(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > 64 * 1024) return this.close(1009, 'too big');
    while (this.buf.length >= 2 && !this.closed) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        p = 4;
      } else if (len === 127) {
        return this.close(1009, 'too big');
      }
      if (!masked) return this.close(1002, 'unmasked');
      if (len > 4096) return this.close(1009, 'too big');
      if (this.buf.length < p + 4 + len) return;
      const mask = this.buf.subarray(p, p + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = this.buf[p + 4 + i] ^ mask[i & 3];
      this.buf = this.buf.subarray(p + 4 + len);
      if (!fin || op === 0) return this.close(1003, 'fragments not supported');
      if (op === 0x1) this.onText(payload.toString('utf8'));
      else if (op === 0x8) return this.close(1000, '');
      else if (op === 0x9) this.frame(0xa, payload);
      else if (op !== 0x2 && op !== 0xa) return this.close(1002, 'bad opcode');
    }
  }
  frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    metrics.bytesOut += head.length + len;
    // One packet per message: corked writes go out together.
    this.socket.cork();
    this.socket.write(head);
    this.socket.write(payload);
    this.socket.uncork();
  }
  sendText(text) {
    this.frame(0x1, Buffer.from(text, 'utf8'));
  }
  sendBinary(bytes) {
    this.frame(0x2, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
  close(code, reason) {
    if (!this.closed && !this.socket.destroyed) {
      const r = Buffer.from(reason || '', 'utf8');
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      this.frame(0x8, p);
      this.socket.end();
    }
    this.finish();
  }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (f) return f;
  }
  return req.socket.remoteAddress || '?';
}

function reject(socket, status) {
  metrics.refused++;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function upgrade(req, socket) {
  socket.on('error', () => socket.destroy());
  const key = req.headers['sec-websocket-key'];
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    return reject(socket, '400 Bad Request');
  }
  // Other websites may not embed this server in their pages. (Apps that are not browsers send no Origin; they
  // could claim any, so they are not refused for lacking one.)
  const host = String(req.headers.host || '');
  const sameOrigin = origin === `https://${host}` || origin === `http://${host}`;
  if (ALLOWED_ORIGINS.length && origin && !sameOrigin && !ALLOWED_ORIGINS.some((re) => re.test(origin))) {
    return reject(socket, '403 Forbidden');
  }
  const ip = clientIp(req);
  const n = perIp.get(ip) ?? 0;
  if (n >= MAX_PER_IP) return reject(socket, '429 Too Many Requests');
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  perIp.set(ip, n + 1);
  metrics.connections++;
  let client = null;
  const ws = new Ws(
    socket,
    (text) => client.onMessage(text),
    () => {
      client.leaveRoom();
      clients.delete(client);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    },
  );
  client = new Client(ws, ip);
  if (clients.size >= MAX_CLIENTS) {
    // Full: say so politely; the page falls back to playing with bots.
    client.send({ t: 'full' });
    ws.close(1013, 'full');
    metrics.refused++;
    return;
  }
  clients.add(client);
  client.send({ t: 'hello', v: VERSION, online: onlineCount() });
}

// Keepalive: ping everyone every 20 s; drop dead connections, and people who stopped playing or watching.
const housekeeping = setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    const quiet = now - c.lastMsg;
    if (now - c.ws.lastSeen > 60_000) c.ws.close(1001, 'gone');
    else if (quiet > (c.mode === 'play' ? 120_000 : 300_000)) c.ws.close(1000, 'idle');
    else c.ws.frame(0x9, Buffer.alloc(0));
  }
}, 20_000);
housekeeping.unref();

let lastMetrics = { at: Date.now(), bytes: 0 };
const metricsTimer = setInterval(() => {
  const now = Date.now();
  const kbps = ((metrics.bytesOut - lastMetrics.bytes) * 8) / 1000 / ((now - lastMetrics.at) / 1000);
  lastMetrics = { at: now, bytes: metrics.bytesOut };
  log('metrics', {
    online: onlineCount(),
    connected: clients.size,
    rooms: rooms.size,
    joins: metrics.joins,
    links: metrics.links,
    peakOnline: metrics.peakOnline,
    connections: metrics.connections,
    refused: metrics.refused,
    outKbps: Math.round(kbps),
    tickMs: Number(metrics.tickMs.toFixed(2)),
    tickMaxMs: Number(metrics.tickMax.toFixed(1)),
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
  });
  metrics.tickMax = 0;
}, 300_000);
metricsTimer.unref();

// ------------------------------------------------------------------------------------------------ HTTP
const COMMON = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const path = url.pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...COMMON, allow: 'GET, HEAD' });
    res.end();
    return;
  }
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, {
      ...COMMON,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': page.csp,
    });
    res.end(req.method === 'HEAD' ? undefined : page.html);
    return;
  }
  if (path === '/healthz') {
    res.writeHead(200, {
      ...COMMON,
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(
      JSON.stringify({ status: 'ok', v: VERSION, online: onlineCount(), rooms: rooms.size, tickMs: Number(metrics.tickMs.toFixed(3)) }),
    );
    return;
  }
  const file = path.slice(1);
  const mapFile = /^maps\/[a-z0-9-]+\.(json|jpg)$/.exec(file);
  if (Object.hasOwn(STATIC, file) || mapFile) {
    const src = new URL(file, DOCS);
    if (existsSync(src)) {
      const type = mapFile ? (mapFile[1] === 'json' ? 'application/json' : 'image/jpeg') : STATIC[file];
      res.writeHead(200, { ...COMMON, 'content-type': type, 'cache-control': 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(src));
      return;
    }
  }
  res.writeHead(404, { ...COMMON, 'content-type': 'text/plain; charset=utf-8' });
  res.end('לא נמצא');
});
server.on('upgrade', (req, socket) => upgrade(req, socket));
server.on('clientError', (_err, socket) => socket.destroy());
server.headersTimeout = 15_000;
server.requestTimeout = 20_000;

export function start(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log('listening', { port: server.address().port, rooms: rooms.size });
      resolve(server);
    });
  });
}
export function stop() {
  for (const r of [...rooms]) r.close();
  for (const c of [...clients]) c.ws.close(1001, 'shutdown');
  clearInterval(housekeeping);
  clearInterval(metricsTimer);
  return new Promise((resolve) => server.close(() => resolve()));
}
export function reloadPage() {
  page = loadPage();
}
/** For tests only. */
export const _internals = { rooms, clients, metrics, pickRoom, Room, Client, cleanName, VALID_NAMES, CITIES };

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
  const shutdown = () => stop().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Ch-ch-chain-ges — multiplayer game server. Zero dependencies: Node's http + a small RFC 6455 WebSocket implementation.
// Serves the game page and runs authoritative rooms (the same simulation as the browser). Every room plays on one
// map (a city, the whole country, or the promise) and holds as many people as that map does; a full room opens a
// second one on the same map. While few people play, bots keep a room lively: the rival parties (named as the
// parties, marked 🤖, now and then one goes after a person) and local lists; they leave as people come.
// No accounts, cookies or stored personal data: IP addresses are used only in memory for connection limits and
// are never logged.
//
//   PORT=3000 node server.mjs          (see README.md for every setting)
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { World, C, COLORS, SPARK_COLORS, NOUNS, ADJS, scoreOf } from './src/sim.js';
import { streetSpawner } from './src/streets.js';
import { arenaOf } from './src/arena.js';
import { cleanName as checkName } from './src/names.js';
import { AVATAR_IDS } from './src/avatars.js';
import { RIVALS, LOCAL_LISTS, ALLY_COLOR, huntDirector } from './src/campaign.js';
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
const ROOM_CLIENTS = num(env.ROOM_CLIENTS, 50); // the most people any room holds (a map may hold fewer)
// Chains a room keeps going with bots while few people play (0: no bots); a setting the tests can change.
const config = { botFill: num(env.BOT_FILL, 10) };
const MAX_CLIENTS = num(env.MAX_CLIENTS, 300); // whole server; beyond this new visitors play offline
const MAX_ROOMS = num(env.MAX_ROOMS, 16); // rooms open at once (each one ticks 30 times a second)
const MAX_PER_IP = num(env.MAX_PER_IP, 60); // generous: mobile carriers put many people behind one address
// Pages allowed to connect, e.g. "https://chchchains*.onrender.com,https://example.org" (* = letters, digits, -).
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)
  .map((s) => new RegExp(`^${s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]*')}$`, 'i'));
const ARENA = num(env.ARENA_RADIUS, 3000); // rooms without a map are a plain circle this big
const SPARKS = num(env.SPARK_TARGET, 850);
const TICK = 1 / 30;
const TICK_MS = TICK * 1000;
const SNAPSHOT_EVERY = 2; // ticks: 15 snapshots per second
const BOARD_EVERY = 30; // ticks: the leaderboard once a second
const RADAR_EVERY = 60; // ticks: everyone's position for the minimap every two seconds
const PALETTE = [...COLORS, ...SPARK_COLORS];
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3
const VERSION = 3;

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
const TYPES = {
  json: 'application/json',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

function loadPage() {
  const raw = readFileSync(new URL('index.html', DOCS), 'utf8');
  // Served by this server: the page talks to this same origin, and this response carries its own CSP header.
  let tiles = '';
  const html = raw
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '')
    .replace(/window\.CHAIN_CONFIG = (\{.*?\});/, (_, json) => {
      const cfg = JSON.parse(json);
      cfg.server = '';
      cfg.servers = [];
      cfg.sameOrigin = true;
      if (env.CHAIN_BRAND !== undefined) cfg.brand = env.CHAIN_BRAND;
      if (env.CHAIN_PUBLISHER !== undefined) cfg.publisher = env.CHAIN_PUBLISHER;
      if (env.CHAIN_JOIN_URL !== undefined) cfg.joinUrl = env.CHAIN_JOIN_URL;
      if (env.CHAIN_SHARE_URL !== undefined) cfg.shareUrl = env.CHAIN_SHARE_URL;
      tiles = /^https:\/\/[a-z0-9.-]+/i.exec(cfg.satellite?.tiles || '')?.[0] ?? '';
      return `window.CHAIN_CONFIG = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};`;
    });
  const hashes = { script: [], style: [] };
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) hashes.script.push(sha256(m[1]));
  for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) hashes.style.push(sha256(m[1]));
  const csp = [
    "default-src 'self'",
    `script-src ${hashes.script.map((h) => `'sha256-${h}'`).join(' ')}`,
    `style-src ${hashes.style.map((h) => `'sha256-${h}'`).join(' ')}`,
    `img-src 'self' data: blob:${tiles ? ` ${tiles}` : ''}`,
    "media-src 'self' blob:",
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

// ------------------------------------------------------------------------------------------------ maps
// docs/maps (built by tools/map/build.py): the big maps and the local authorities, each with how many people it
// holds. A map's streets and outline are read when a room opens on it and let go when its last room closes.
function readJson(rel) {
  return JSON.parse(readFileSync(new URL(rel, DOCS), 'utf8'));
}
function loadMaps() {
  const maps = new Map();
  if (env.CITIES === 'off' || env.MAPS === 'off') return maps;
  try {
    const index = readJson('maps/index.json');
    const add = (m, kind) => {
      if (typeof m?.id !== 'string' || !/^[a-z0-9-]+$/.test(m.id)) return;
      if (!existsSync(new URL(`maps/${m.id}.json`, DOCS))) return;
      maps.set(m.id, { id: m.id, he: m.he || m.id, kind, capacity: Math.max(2, Math.min(ROOM_CLIENTS, m.capacity || 20)) });
    };
    for (const m of index.regions || []) add(m, 'region');
    for (const m of index.cities || []) add(m, 'city');
  } catch {
    /* no maps: rooms are plain circles */
  }
  return maps;
}
const MAPS = loadMaps();
const mapCache = new Map(); // id → { R, inside, spawn, sparks }
function mapData(id) {
  let m = mapCache.get(id);
  if (!m) {
    const data = readJson(`maps/${id}.json`);
    const arena = arenaOf(data, ARENA);
    const spawn = streetSpawner(data.roads, arena.R, Math.random, { inside: arena.inside, hubs: data.hubs });
    let cells = 0;
    if (arena.mask) for (let i = 0; i < arena.mask.length; i++) cells += arena.mask[i];
    const areaUnits = arena.mask ? (cells * arena.cell * arena.cell) / 1e6 : (Math.PI * arena.R * arena.R) / 1e6;
    // People on the streets: fewer in a small town, never too few to play; the big maps are always busy.
    const sparks = data.kind === 'region' ? 1100 : Math.round(Math.max(380, Math.min(1000, areaUnits * 45)));
    m = { R: arena.R, inside: arena.inside, spawn, sparks };
    mapCache.set(id, m);
  }
  return m;
}
/** The map a newcomer lands on: wherever most people play (with room to spare), else the whole country. */
function defaultMap() {
  let best = null;
  for (const r of rooms) {
    if (r.closed || !r.map || r.playing() >= r.capacity) continue;
    if (!best || r.playing() > best.playing()) best = r;
  }
  if (best?.playing()) return best.map.id;
  if (MAPS.has('israel')) return 'israel';
  const ids = [...MAPS.keys()];
  return ids.length ? ids[Math.floor(Date.now() / 3_600_000) % ids.length] : '';
}
function mapId(v) {
  return typeof v === 'string' && MAPS.has(v) ? v : MAPS.size ? defaultMap() : '';
}

// ------------------------------------------------------------------------------------------------ names, skins
const VALID_NAMES = new Set(); // the generated names (the page offers these; any clean name of one's own works too)
for (const n of NOUNS) for (const a of ADJS) VALID_NAMES.add(`${n} ${a}`);
function generatedName() {
  return `${NOUNS[Math.floor(Math.random() * NOUNS.length)]} ${ADJS[Math.floor(Math.random() * ADJS.length)]}`;
}
function cleanName(name) {
  return checkName(name) || generatedName();
}
// Skins: the original avatars, plus pictures supplied in docs/skins/index.json.
function loadSkins() {
  const ids = new Set(AVATAR_IDS);
  try {
    for (const s of readJson('skins/index.json').skins || []) {
      if (typeof s?.id === 'string' && /^[a-z0-9-]{1,40}$/.test(s.id)) ids.add(s.id);
    }
  } catch {
    /* no supplied skins */
  }
  return ids;
}
const SKINS = loadSkins();
function cleanSkin(skin) {
  return typeof skin === 'string' && SKINS.has(skin) ? skin : '';
}

// ------------------------------------------------------------------------------------------------ rooms
const rooms = new Set();
const clients = new Set();
const metrics = { joins: 0, links: 0, peakOnline: 0, connections: 0, refused: 0, bytesOut: 0, tickMs: 0, tickMax: 0 };

function onlineCount() {
  let n = 0;
  for (const r of rooms) n += r.clients.size;
  return n;
}
/** How many people play on each map right now: { id: people }. */
function lobby() {
  const out = {};
  for (const r of rooms) if (r.map && r.playing()) out[r.map.id] = (out[r.map.id] || 0) + r.playing();
  return out;
}

class Room {
  constructor(map) {
    this.id = randomBytes(3).toString('hex');
    this.map = map; // null: a plain circle (no maps on this server)
    this.capacity = Math.min(ROOM_CLIENTS, map?.capacity ?? ROOM_CLIENTS);
    const md = map ? mapData(map.id) : null;
    this.world = md
      ? new World({ arenaRadius: md.R, sparkTarget: md.sparks, spawnPoint: md.spawn ?? undefined, inside: md.inside })
      : new World({ arenaRadius: ARENA, sparkTarget: SPARKS });
    this.clients = new Set();
    this.bySnake = new Map(); // snake id → client
    this.emptySince = Date.now();
    this.tickN = 0;
    this.gen = 0;
    this.closed = false;
    this.bounds = new Map(); // snake id → [minX, minY, maxX, maxY], refreshed before each round of snapshots
    this.leader = null;
    this.world.sparkLog = { added: [], removed: [] }; // people who came and went since the last snapshots
    this.snapN = 0;
    // Now and then a rival party goes after someone who has played a while (one at a time; two once it is busy).
    this.hunts = huntDirector(this.world, { max: (people) => (people >= 4 ? 2 : 1), grace: 25 });
    this.next = performance.now();
    this.timer = setTimeout(() => this.loop(), 0);
    rooms.add(this);
    log('room.open', { room: this.id, map: map?.id ?? '', rooms: rooms.size });
  }
  /** People playing here (or between rounds); watchers are not counted against the capacity. */
  playing() {
    let n = 0;
    for (const c of this.clients) if (c.mode === 'play') n++;
    return n;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    rooms.delete(this);
    const id = this.map?.id;
    if (id && ![...rooms].some((r) => r.map?.id === id)) mapCache.delete(id);
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
    if (this.tickN % 15 === 0) this.fillBots();
    for (const h of this.hunts.update(TICK)) {
      const bot = w.snakes.get(h.hunter);
      this.bySnake.get(h.prey)?.send({ t: 'ev', k: 'hunt', at: Math.round(w.time * 1000), id: h.hunter, name: bot?.name ?? '' });
    }
    if (this.tickN % SNAPSHOT_EVERY === 0) {
      this.prepareSnapshots();
      for (const c of this.clients) this.sendSnapshot(c);
      w.sparkLog.added.length = 0;
      w.sparkLog.removed.length = 0;
    }
    if (this.tickN % BOARD_EVERY === 0) this.sendBoards(this.tickN % RADAR_EVERY === 0);
    if (this.clients.size) this.emptySince = Date.now();
    else if (Date.now() - this.emptySince > 60_000) this.close();
  }
  /**
   * Bots while few people play: the rival parties first (each once: the two biggest are "giants" that close a ring,
   * the middle ones hunters, the small ones raiders), then friendly local lists; the smallest leaves when people come.
   */
  fillBots() {
    const w = this.world;
    let people = 0;
    const bots = [];
    for (const s of w.snakes.values()) {
      if (!s.alive) continue;
      if (s.bot) bots.push(s);
      else people++;
    }
    const want = config.botFill > 0 ? Math.max(0, Math.min(config.botFill, this.capacity) - people) : 0;
    if (bots.length < want && this.tickN % 30 === 0) {
      const here = new Set(bots.map((b) => b.ai?.party).filter(Boolean));
      const parties = RIVALS.filter((p) => p.seats > 0).sort((a, b) => b.seats - a.seats);
      const i = parties.findIndex((p) => !here.has(p.id));
      if (i >= 0) {
        const p = parties[i];
        const role = i < 2 ? 'giant' : i < 5 ? 'hunter' : 'raider';
        w.addSnake({
          bot: true,
          name: p.name,
          color: p.color,
          mass: role === 'giant' ? 120 + Math.random() * 120 : 30 + Math.random() * 60,
          ai: { role, skill: 0.4 + Math.random() * 0.15, accept: 0, friendly: false, party: p.id },
        });
      } else {
        const taken = new Set(bots.map((b) => b.name));
        const name = LOCAL_LISTS.find((n) => !taken.has(n)) ?? LOCAL_LISTS[bots.length % LOCAL_LISTS.length];
        w.addSnake({ bot: true, name, color: ALLY_COLOR, mass: 15 + Math.random() * 40, ai: { friendly: true, accept: 0.9 } });
      }
    } else if (bots.length > want && this.tickN % 90 === 0) {
      // More bots than the people here need: the smallest one goes.
      let smallest = null;
      for (const b of bots) if (!smallest || b.mass < smallest.mass) smallest = b;
      if (smallest) w.removeSnake(smallest.id);
    }
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
          c.send({ t: 'dead', at, killer: e.killer || 0, name: killer ? killer.name : '', edge: e.killer === 0 });
          this.bySnake.delete(e.id);
          c.snakeId = 0;
          if (s) {
            c.lastX = s.x;
            c.lastY = s.y;
          }
        }
        const kc = e.killer ? this.bySnake.get(e.killer) : null;
        if (kc && s) kc.send({ t: 'ev', k: 'broke', at, id: s.id, name: s.name });
      } else if (e.t === 'link') {
        metrics.links++;
        const a = w.snakes.get(e.a);
        const b = w.snakes.get(e.b);
        this.bySnake.get(e.a)?.send({ t: 'ev', k: 'link', at, id: e.b, name: b ? b.name : '' });
        this.bySnake.get(e.b)?.send({ t: 'ev', k: 'link', at, id: e.a, name: a ? a.name : '' });
      } else if (e.t === 'offer') {
        const from = w.snakes.get(e.from);
        const to = w.snakes.get(e.to);
        this.bySnake.get(e.to)?.send({ t: 'ev', k: 'offer', at, id: e.from, name: from ? from.name : '' });
        this.bySnake.get(e.from)?.send({ t: 'ev', k: 'offered', at, id: e.to, name: to ? to.name : '' });
      }
    }
    w.events.length = 0;
    // Broken chains leave the world a moment later (their people stay in the street).
    for (const s of w.snakes.values()) {
      if (s.alive) continue;
      s.goneAt ??= w.time;
      if (w.time - s.goneAt > 1) w.removeSnake(s.id);
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
      if (!leader || s.mass > leader.mass) leader = s; // watchers follow the longest chain
    }
    this.leader = leader;
  }
  sendSnapshot(c) {
    const sock = c.ws.socket;
    if (sock.writableLength > 1024 * 1024) return c.ws.close(1008, 'too slow');
    if (sock.writableLength > 128 * 1024) {
      c.needFull = true; // slow connection: skip a frame rather than queue it, and resync the people after
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
        fresh.push([s.id, s.name, s.bot ? 1 : 0, s.skin || '']);
      }
    }
    for (const [id, k] of c.known) if (k.gen !== gen) c.known.delete(id); // left the view: full body next time
    // People in the street: a full sweep of the view every fourth snapshot (or after a jump); in between only the
    // ones who appeared or left since the last round. The view margin covers what the camera can travel meanwhile.
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
  sendBoards(withRadar) {
    const w = this.world;
    const alive = [];
    for (const s of w.snakes.values()) if (s.alive) alive.push(s);
    alive.sort((a, b) => b.mass - a.mass);
    const top = alive.slice(0, 5).map((s) => [s.id, s.name, scoreOf(s.mass), s.color, s.bot ? 1 : 0]);
    const online = onlineCount();
    const here = this.playing();
    // The minimap: every chain's head, to 10 units.
    const radar = withRadar ? alive.map((s) => [s.id, Math.round(s.x / 10), Math.round(s.y / 10), s.color, scoreOf(s.mass), s.team]) : null;
    for (const c of this.clients) {
      if (c.mode === 'idle') continue;
      const me = c.snakeId ? w.snakes.get(c.snakeId) : null;
      const msg = {
        t: 'lb',
        top,
        rank: me ? alive.indexOf(me) + 1 : 0,
        total: alive.length,
        here,
        cap: this.capacity,
        online,
        hands: me ? me.hands.size : 0,
      };
      if (radar) msg.radar = radar;
      c.send(msg);
    }
  }
}

/** A room on the map with space for one more player: the fullest one, or a new one (null if too many are open). */
function pickRoom(id) {
  const map = id ? MAPS.get(id) : null;
  let best = null;
  for (const r of rooms) {
    if (r.closed || (r.map?.id ?? '') !== (map?.id ?? '') || r.playing() >= r.capacity) continue;
    if (!best || r.playing() > best.playing()) best = r;
  }
  if (best) return best;
  if (rooms.size >= MAX_ROOMS) return null;
  try {
    return new Room(map);
  } catch (e) {
    log('room.error', { map: id, error: String(e?.message || e) });
    return null;
  }
}
/** The busiest room already open on a map (for watching), or null. */
function watchRoom(id) {
  let best = null;
  for (const r of rooms) {
    if (r.closed || (r.map?.id ?? '') !== id) continue;
    if (!best || r.playing() > best.playing()) best = r;
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ clients
const perIp = new Map();

class Client {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
    this.room = null;
    this.mode = 'idle'; // 'idle' (not in a room) | 'watch' (following a room's leader) | 'play'
    this.snakeId = 0;
    this.known = new Map(); // snake id → { seq, gen }: path points this client already has
    this.sparks = new Map(); // spark id → gen
    this.needFull = true;
    this.phase = Math.floor(Math.random() * 4); // spreads full sweeps across snapshot rounds
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
        this.join(m);
        break;
      case 'watch':
        this.view(m);
        this.watch(m.map);
        break;
      case 'lobby':
        this.send({ t: 'lobby', maps: lobby(), online: onlineCount() });
        break;
      case 'idle':
        this.leaveRoom();
        break;
      default: // 'hb' and anything unknown: only counts as activity
    }
  }
  enterRoom(room) {
    if (this.room === room) return;
    this.leaveRoom();
    this.room = room;
    room.clients.add(this);
    this.known.clear();
    this.sparks.clear();
    this.names.clear();
    this.needFull = true;
    this.send({ t: 'room', R: room.world.R, map: room.map?.id ?? '', city: room.map?.id ?? '', cap: room.capacity });
  }
  /** Follow the busiest room on a map; with nobody there, say so (the page shows the empty map itself). */
  watch(id) {
    if (this.mode === 'play' && this.snakeId) return;
    const map = mapId(id);
    const room = watchRoom(map);
    if (!room) {
      this.leaveRoom();
      this.send({ t: 'noroom', map });
      return;
    }
    this.enterRoom(room);
    this.mode = 'watch';
  }
  join(m) {
    if (this.snakeId && this.room?.world.snakes.get(this.snakeId)?.alive) return;
    const map = mapId(m.map);
    const same = this.room && !this.room.closed && (this.room.map?.id ?? '') === map;
    let room = same && (this.mode === 'play' || this.room.playing() < this.room.capacity) ? this.room : null;
    room ??= pickRoom(map);
    if (!room) {
      this.send({ t: 'busy', map });
      return;
    }
    this.enterRoom(room);
    const s = room.world.addSnake({ name: cleanName(m.name), skin: cleanSkin(m.skin) });
    this.snakeId = s.id;
    this.mode = 'play';
    room.bySnake.set(s.id, this);
    this.lastX = s.x;
    this.lastY = s.y;
    metrics.joins++;
    this.send({ t: 'joined', id: s.id, name: s.name, color: s.color, skin: s.skin, map, here: room.playing(), cap: room.capacity });
    metrics.peakOnline = Math.max(metrics.peakOnline, onlineCount());
  }
  leaveRoom() {
    const r = this.room;
    if (r) {
      const s = this.snakeId ? r.world.snakes.get(this.snakeId) : null;
      if (s?.alive) r.world.kill(s, null); // nobody steers it any more: its people go back to the street
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
    // Full: say so politely; the page plays offline meanwhile.
    client.send({ t: 'full' });
    ws.close(1013, 'full');
    metrics.refused++;
    return;
  }
  clients.add(client);
  client.send({ t: 'hello', v: VERSION, online: onlineCount(), maps: lobby(), home: MAPS.size ? defaultMap() : '' });
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
    maps: lobby(),
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
function json(res, req, obj) {
  res.writeHead(200, { ...COMMON, 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify(obj));
}
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
  if (path === '/robots.txt') {
    res.writeHead(200, { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' });
    res.end(req.method === 'HEAD' ? undefined : 'User-agent: *\nDisallow: /ws\n');
    return;
  }
  if (path === '/healthz') {
    json(res, req, {
      status: 'ok',
      v: VERSION,
      online: onlineCount(),
      rooms: rooms.size,
      tickMs: Number(metrics.tickMs.toFixed(3)),
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
    });
    return;
  }
  if (path === '/lobby') {
    // Where people play, for the map picker (and for pages that spread maps over several servers).
    json(res, req, { v: VERSION, online: onlineCount(), maps: lobby() });
    return;
  }
  const file = path.slice(1);
  const asset = /^(maps|skins|music)\/[a-z0-9-]+\.(json|jpg|png|webp|svg|mp3|m4a|ogg)$/.exec(file);
  if (Object.hasOwn(STATIC, file) || asset) {
    const src = new URL(file, DOCS);
    if (existsSync(src)) {
      res.writeHead(200, { ...COMMON, 'content-type': asset ? TYPES[asset[2]] : STATIC[file], 'cache-control': 'public, max-age=3600' });
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
      log('listening', { port: server.address().port, maps: MAPS.size, skins: SKINS.size });
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
export const _internals = { rooms, clients, metrics, pickRoom, Room, Client, cleanName, VALID_NAMES, MAPS, SKINS, lobby, defaultMap, config };

if (import.meta.url === `file://${process.argv[1]}`) {
  await start();
  const shutdown = () => stop().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

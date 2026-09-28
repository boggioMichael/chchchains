// Ch-ch-chain-ges — online play. Connects to the game server, keeps a copy of the room around the player and draws it a
// little in the past, so chains glide smoothly between the server's 15 snapshots a second. Everything a
// snapshot or message changes is applied at the drawn moment, so sparks vanish when the head reaches them. The delay
// adapts to the connection: about 90 ms on a steady line, more when snapshots arrive unevenly.
import { COLORS, SPARK_COLORS, angleDiff } from './sim.js';
import {
  decodeSnapshot,
  FLAG_BOOST,
  FLAG_BOT,
  FLAG_OFFERS_ME,
  FLAG_I_OFFERED,
  FLAG_FULL,
  FLAG_CANDIDATE,
} from './protocol.js';

const PALETTE = [...COLORS, ...SPARK_COLORS];
const EXTRAPOLATE = 150; // ms a chain keeps gliding on its own when snapshots are late

/** The part of a server room this client can see, shaped like World so the same renderer draws it. */
export class RemoteWorld {
  constructor(R) {
    this.R = R;
    this.city = ''; // which city map this room plays on
    this.time = 0; // seconds on the room clock, at the drawn moment
    this.snakes = new Map();
    this.sparks = new Map();
    this.teams = new Map();
    this.events = [];
    this.names = new Map(); // id → { name, bot }
    this.board = null;
    this.me = 0;
    this.focus = 0;
    this.candidate = 0;
    this.rt = -1; // drawn moment, ms on the room clock
    this.latest = -1; // newest snapshot received
    this.pending = []; // [{ at, sparks?, event? }] waiting for the drawn moment
    this.delay = 110; // ms behind the newest snapshot
    this.interval = 67;
    this.jitter = 12;
    this.arrivedAt = 0;
  }
  teamOf(s) {
    return s.team ? this.teams.get(s.team) : null;
  }
  sameTeam(a, b) {
    return a.team !== 0 && a.team === b.team;
  }
  queue(item) {
    const p = this.pending;
    p.push(item);
    for (let i = p.length - 1; i > 0 && p[i - 1].at > p[i].at; i--) [p[i - 1], p[i]] = [p[i], p[i - 1]];
  }
  setNames(list) {
    for (const [id, name, bot] of list) {
      this.names.set(id, { name: String(name), bot: !!bot });
      const s = this.snakes.get(id);
      if (s) {
        s.name = String(name);
        s.bot = !!bot;
      }
    }
  }

  /** A snapshot arrived: bodies and history update now; sparks and removals wait for the drawn moment. */
  receive(snap) {
    const t = snap.time;
    if (t <= this.latest) return;
    const now = performance.now();
    if (this.arrivedAt) {
      const gap = t - this.latest; // room time between snapshots (normally 67 ms)
      const late = Math.abs(now - this.arrivedAt - gap);
      this.interval = this.interval * 0.9 + Math.min(gap, 500) * 0.1;
      this.jitter = this.jitter * 0.92 + Math.min(late, 400) * 0.08;
      this.delay = Math.max(85, Math.min(260, this.interval + 20 + this.jitter * 2.5));
    }
    this.arrivedAt = now;
    if (this.rt < 0) this.rt = t - this.delay;
    else {
      const err = t - this.delay - this.rt;
      if (Math.abs(err) > 600) this.rt = t - this.delay; // woke from a stall: jump rather than fast-forward
      else this.rt += err * 0.08;
    }
    this.latest = t;
    this.me = snap.me;
    this.focus = snap.focus;
    let cand = 0;
    for (const d of snap.snakes) {
      let s = this.snakes.get(d.id);
      if (!s) {
        const n = this.names.get(d.id);
        s = {
          id: d.id,
          name: n?.name ?? '…',
          bot: n?.bot ?? !!(d.flags & FLAG_BOT),
          color: 0,
          mass: d.mass,
          x: d.x,
          y: d.y,
          a: d.a,
          ta: d.a,
          boost: false,
          alive: true,
          team: 0,
          offer: null,
          hands: new Set(),
          handsCount: 0,
          px: [],
          py: [],
          bx: [],
          by: [],
          seq: -1,
          hist: [],
          goneAt: 0,
          seenAt: t,
        };
        this.snakes.set(d.id, s);
      }
      s.goneAt = 0;
      s.seenAt = t;
      s.color = d.color % COLORS.length;
      if (d.flags & FLAG_BOT) s.bot = true;
      if (d.flags & FLAG_FULL) {
        s.bx = Array.from(d.px);
        s.by = Array.from(d.py);
        s.seq = d.seq;
      } else if (d.count && d.seq > s.seq) {
        // Points arrive head first: d.px[k] is point number d.seq − k. Keep only the ones we lack.
        const take = Math.min(d.count, d.seq - s.seq);
        s.bx.unshift(...d.px.subarray(0, take));
        s.by.unshift(...d.py.subarray(0, take));
        s.seq = d.seq;
      }
      const keep = d.len + 90;
      if (s.bx.length > keep) {
        s.bx.length = keep;
        s.by.length = keep;
      }
      s.hist.push({ t, x: d.x, y: d.y, a: d.a, mass: d.mass, seq: d.seq, len: d.len, flags: d.flags, team: d.team });
      if (s.hist.length > 40) s.hist.splice(0, s.hist.length - 40);
      if (d.flags & FLAG_CANDIDATE) cand = d.id;
    }
    this.candidate = cand;
    for (const s of this.snakes.values()) if (s.seenAt !== t && !s.goneAt) s.goneAt = t;
    if (snap.newSparks.length || snap.goneSparks.length) this.queue({ at: t, sparks: snap });
  }

  /** Advances the drawn moment by dtMs and brings every chain, spark and event up to it. */
  update(dtMs) {
    if (this.rt < 0) return;
    this.rt = Math.min(this.rt + dtMs, this.latest + EXTRAPOLATE);
    const rt = this.rt;
    this.time = rt / 1000;
    while (this.pending.length && this.pending[0].at <= rt) {
      const item = this.pending.shift();
      if (item.sparks) this.applySparks(item.sparks);
      if (item.event) this.events.push(item.event);
    }
    let iOffered = 0;
    for (const s of this.snakes.values()) {
      if (s.goneAt && rt >= s.goneAt) {
        this.snakes.delete(s.id);
        continue;
      }
      const h = s.hist;
      while (h.length > 2 && h[1].t <= rt) h.shift();
      const A = h[0];
      const B = h[1];
      let x = A.x;
      let y = A.y;
      let a = A.a;
      let mass = A.mass;
      let seqF = A.seq;
      let ref = A;
      if (B && rt > A.t) {
        const span = B.t - A.t || 1;
        if (rt <= B.t) {
          const f = (rt - A.t) / span;
          x = A.x + (B.x - A.x) * f;
          y = A.y + (B.y - A.y) * f;
          a = A.a + angleDiff(A.a, B.a) * f;
          mass = A.mass + (B.mass - A.mass) * f;
          seqF = A.seq + (B.seq - A.seq) * f;
          if (f > 0.5) ref = B;
        } else {
          // Late snapshot: keep gliding along the last known motion for a moment.
          const f = Math.min(rt - B.t, EXTRAPOLATE) / span;
          x = B.x + (B.x - A.x) * f;
          y = B.y + (B.y - A.y) * f;
          a = B.a;
          mass = B.mass;
          seqF = B.seq;
          ref = B;
        }
      }
      s.x = x;
      s.y = y;
      s.a = a;
      s.ta = a;
      s.mass = mass;
      s.team = ref.team;
      s.boost = !!(ref.flags & FLAG_BOOST);
      if (ref.flags & FLAG_OFFERS_ME) {
        if (!s.offer) s.offer = { to: this.me, until: Infinity };
      } else s.offer = null;
      if (ref.flags & FLAG_I_OFFERED) iOffered = s.id;
      // Visible body: the path points the head had already laid down at the drawn moment.
      const skip = Math.max(0, Math.min(s.bx.length - 1, s.seq - Math.floor(seqF)));
      const n = Math.max(0, Math.min(ref.len, s.bx.length - skip));
      s.px.length = n;
      s.py.length = n;
      for (let k = 0; k < n; k++) {
        s.px[k] = s.bx[skip + k];
        s.py[k] = s.by[skip + k];
      }
    }
    const my = this.snakes.get(this.me);
    if (my) {
      if (!iOffered) my.offer = null;
      else if (my.offer?.to !== iOffered) my.offer = { to: iOffered, until: Infinity };
    }
    this.teams.clear();
    for (const s of this.snakes.values()) {
      if (!s.team) continue;
      let team = this.teams.get(s.team);
      if (!team) {
        team = { id: s.team, members: new Set() };
        this.teams.set(s.team, team);
      }
      team.members.add(s.id);
    }
  }

  applySparks(snap) {
    for (const id of snap.goneSparks) this.sparks.delete(id);
    for (const sp of snap.newSparks) {
      this.sparks.set(sp.id, {
        id: sp.id,
        x: sp.x,
        y: sp.y,
        r: sp.r,
        v: 1,
        color: PALETTE[sp.color] ?? PALETTE[0],
        born: this.time,
        ttl: sp.left,
      });
    }
  }
}

/**
 * Connects to the game server at `url` (ws:// or wss://…/ws). hooks: onStatus(status, info) with status
 * 'connecting' | 'online' | 'offline' | 'full'; onWorld(world); onJoined(world, id); onLost().
 */
export function connectOnline(url, hooks = {}) {
  const net = {
    ws: null,
    ready: false,
    world: null,
    meId: 0,
    playing: false,
    joining: null,
    wantWatch: false,
    attempts: 0,
    sleeping: false,
    full: false,
    online: 0,
    lastSend: 0,
    lastA: 0,
    lastB: false,
    lastHb: 0,
    activeAt: Date.now(),
    bytes: 0,
    snaps: 0,
    since: 0, // when the current run of connection attempts began
    retryTimer: 0,
    hiddenTimer: 0,
  };
  const healthUrl = url.replace(/^ws/, 'http').replace(/\/ws$/, '/healthz');

  function status(s) {
    hooks.onStatus?.(s, { online: net.online });
  }
  function send(obj) {
    if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(obj));
  }
  function wake() {
    // Free servers sleep when nobody plays; any plain request wakes them (about a minute).
    try {
      fetch(healthUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
    } catch {
      /* no fetch */
    }
  }
  function connect() {
    clearTimeout(net.retryTimer);
    if (net.ws || net.sleeping || document.hidden) return;
    if (net.attempts === 0) net.since = Date.now();
    if (net.attempts === 0 || net.attempts % 4 === 0) wake();
    // A sleeping free server takes about a minute to wake: say "connecting" that long before "unavailable".
    status(Date.now() - net.since < 100_000 ? 'connecting' : 'offline');
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    net.ws = ws;
    const openTimer = setTimeout(() => {
      if (ws.readyState !== 1) ws.close();
    }, 30_000);
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        net.bytes += e.data.length;
        onText(e.data);
      } else {
        net.bytes += e.data.byteLength;
        net.snaps++;
        onSnapshot(e.data);
      }
    };
    ws.onclose = (e) => {
      clearTimeout(openTimer);
      if (net.ws !== ws) return;
      net.ws = null;
      net.ready = false;
      net.world = null;
      net.joining = null;
      if (net.playing) {
        net.playing = false;
        hooks.onLost?.();
      }
      if (net.full || e.code === 1013) {
        net.full = false;
        status('full');
        retry(60_000);
      } else if (e.reason === 'idle') {
        net.sleeping = true; // woken by the next tap (poke)
        status('offline');
      } else retry();
    };
  }
  function retry(ms) {
    net.attempts++;
    if (Date.now() - net.since >= 100_000) status('offline');
    const waking = Date.now() - net.since < 100_000;
    const delay = ms ?? (waking ? 3000 : Math.min(30_000, 5000 * 2 ** Math.min(3, net.attempts - 1))) * (0.75 + Math.random() * 0.5);
    clearTimeout(net.retryTimer);
    net.retryTimer = setTimeout(connect, delay);
  }
  function onText(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    const w = net.world;
    switch (m.t) {
      case 'hello':
        net.ready = true;
        net.attempts = 0;
        net.online = m.online | 0;
        status('online');
        if (net.wantWatch) send({ t: 'watch', ...net.view });
        break;
      case 'full':
        net.full = true;
        break;
      case 'room':
        net.world = new RemoteWorld(m.R);
        net.world.city = typeof m.city === 'string' ? m.city : '';
        hooks.onWorld?.(net.world);
        break;
      case 'joined':
        net.meId = m.id;
        if (net.world) net.world.me = m.id;
        net.joining = { id: m.id };
        break;
      case 'names':
        if (w && Array.isArray(m.list)) w.setNames(m.list);
        break;
      case 'lb':
        if (w) {
          w.board = m;
          const my = w.snakes.get(net.meId);
          if (my) my.handsCount = m.hands | 0;
        }
        if (net.online !== (m.online | 0)) {
          net.online = m.online | 0;
          status('online');
        }
        break;
      case 'dead':
        if (w) w.queue({ at: m.at, event: { t: 'death', id: net.meId, killer: m.killer, name: m.name, edge: !!m.edge } });
        net.playing = false;
        break;
      case 'ev':
        if (!w) break;
        if (m.k === 'broke') w.queue({ at: m.at, event: { t: 'death', id: m.id, killer: net.meId, name: m.name } });
        else if (m.k === 'link') w.queue({ at: m.at, event: { t: 'link', a: net.meId, b: m.id, name: m.name } });
        else if (m.k === 'offer') w.queue({ at: m.at, event: { t: 'offer', from: m.id, to: net.meId, name: m.name } });
        else if (m.k === 'offered') w.queue({ at: m.at, event: { t: 'offered', to: m.id, name: m.name } });
        break;
      default:
    }
  }
  function onSnapshot(buf) {
    const w = net.world;
    if (!w) return;
    const snap = decodeSnapshot(buf);
    if (!snap) return;
    w.receive(snap);
    if (net.joining && w.snakes.has(net.joining.id)) {
      net.joining = null;
      net.playing = true;
      hooks.onJoined?.(w, net.meId);
    }
  }

  // A tab in the background stops watching after a while; coming back reconnects.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(net.hiddenTimer);
    if (document.hidden) {
      net.hiddenTimer = setTimeout(() => {
        if (document.hidden && net.ws) {
          net.sleeping = false;
          const ws = net.ws;
          ws.close(1000, 'hidden');
        }
      }, 30_000);
    } else if (!net.ws) {
      net.attempts = 0;
      connect();
    }
  });

  net.view = { vw: 700, vh: 1300 };
  const api = {
    ready: () => net.ready,
    get world() {
      return net.world;
    },
    get online() {
      return net.online;
    },
    /** Spectate the room behind the start screen. */
    watch(view) {
      net.wantWatch = true;
      if (view) net.view = { vw: Math.round(view.hw), vh: Math.round(view.hh) };
      if (net.ready) send({ t: 'watch', ...net.view });
    },
    /** Leave the room (playing offline): the server stops sending anything. */
    idle() {
      net.wantWatch = false;
      net.playing = false;
      net.joining = null;
      net.world = null;
      if (net.ready) send({ t: 'idle' });
    },
    join(name, view) {
      if (!net.ready) return false;
      if (view) net.view = { vw: Math.round(view.hw), vh: Math.round(view.hh) };
      net.joining = { id: -1 };
      send({ t: 'join', name, ...net.view });
      return true;
    },
    /** Per frame: advance the drawn room and send the steering (≤ 20 a second, and at least once a second). */
    tick(dt, input, view) {
      const w = net.world;
      if (w) w.update(dt * 1000);
      const now = performance.now();
      if (net.playing) {
        const a = Math.atan2(Math.sin(input.angle), Math.cos(input.angle));
        const changed = Math.abs(angleDiff(net.lastA, a)) > 0.015 || input.boost !== net.lastB;
        if ((changed && now - net.lastSend >= 50) || now - net.lastSend >= 1000) {
          net.lastSend = now;
          net.lastA = a;
          net.lastB = input.boost;
          send({ t: 'in', a: Math.round(a * 1000) / 1000, b: input.boost ? 1 : 0, vw: Math.round(view.hw), vh: Math.round(view.hh) });
        }
      } else if (net.wantWatch && now - net.lastHb > 25_000 && Date.now() - net.activeAt < 240_000) {
        net.lastHb = now;
        send({ t: 'hb' });
      }
    },
    hand() {
      send({ t: 'hand' });
    },
    candidate() {
      const w = net.world;
      if (!w || !w.candidate) return null;
      const s = w.snakes.get(w.candidate);
      return s && s.alive ? s : null;
    },
    /** Counters for the ?stats overlay. */
    stats() {
      const w = net.world;
      return { bytes: net.bytes, snaps: net.snaps, delay: w?.delay ?? 0, jitter: w?.jitter ?? 0, chains: w?.snakes.size ?? 0 };
    },
    /** The person did something: counts as activity, and wakes a connection that went to sleep. */
    poke() {
      net.activeAt = Date.now();
      if (net.sleeping) {
        net.sleeping = false;
        net.attempts = 0;
        connect();
      }
    },
  };
  connect();
  return api;
}

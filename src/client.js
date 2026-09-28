// Ch-ch-chains — the browser client: the city map, the human chains, touch/mouse/keyboard input, screens and
// sharing. Offline play simulates the world here with labelled bots; online play (net.js) draws the server's room.
import { World, C, COLORS, radiusFor, scoreOf, randomName, botName } from './sim.js';
import { connectOnline } from './net.js';
import { loadCity, loadCityIndex, MAP_STYLE } from './map.js';
import { streetSpawner } from './streets.js';
import { figure, drawFlag, FIG } from './people.js';

const CFG = Object.assign(
  { server: '', brand: 'המשחק של עמך ישראל', publisher: '', joinUrl: '', shareUrl: '', maps: 'maps/' },
  globalThis.CHAIN_CONFIG || {},
);
const BOTS = 20;
const TAU = Math.PI * 2;
const INK = '#23201b';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const mini = $('minimap');
const mctx = mini.getContext('2d');

let W = 0;
let H = 0;
let DPR = 1;
let dprCap = 2;
function resize() {
  DPR = Math.min(dprCap, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  // The minimap is 96 CSS px (see page.html); its HUD may still be hidden, so do not measure it.
  const m = Math.round(96 * DPR);
  mini.width = m;
  mini.height = m;
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------------------------------------ state
const game = {
  mode: 'solo', // 'solo' | 'online'
  world: null,
  meId: 0,
  running: false,
  alive: false,
  name: loadName(),
  best: { rank: 99, maxScore: 0, hands: 0, born: 0 },
  net: null,
  deathInfo: null,
  hintStage: 0,
  refusedAt: new Map(),
  handIds: new Set(),
  joining: false,
  joinTimer: 0,
  idleWorld: null,
  toldOnline: false,
  preview: null,
};
const cam = { x: 0, y: 0, zoom: 1 };
const input = { angle: 0, boost: false, pointerId: null, touches: 0 };
let last = performance.now();
let acc = 0;
let frameTimes = [];

function loadName() {
  try {
    return localStorage.getItem('chain:name') || randomName();
  } catch {
    return randomName();
  }
}
function saveName(n) {
  try {
    localStorage.setItem('chain:name', n);
  } catch {
    /* storage unavailable */
  }
}

function me() {
  return game.world?.snakes.get(game.meId) || null;
}

// ------------------------------------------------------------------------------------------------ city maps
const maps = { cities: [], loaded: new Map(), soloCity: '' };
/** Resolves to the CityMap for `id` (loading it once), or null when it cannot be loaded. */
function cityMap(id) {
  if (!id) return Promise.resolve(null);
  if (!maps.loaded.has(id)) {
    maps.loaded.set(
      id,
      loadCity(id, CFG.maps).then(
        (m) => ((maps.loaded.get(id).value = m), m),
        () => null,
      ),
    );
  }
  return maps.loaded.get(id);
}
/** The map for a world, if it has finished loading. */
function mapFor(w) {
  const p = w && maps.loaded.get(w.city);
  return p?.value ?? null;
}
const cityName = (id) => maps.cities.find((c) => c.id === id)?.he ?? '';
/** Offline play and the start screen use the city of the hour. */
function hourCity() {
  if (!maps.cities.length) return '';
  return maps.cities[Math.floor(Date.now() / 3_600_000) % maps.cities.length].id;
}
function newWorld(map, opts = {}) {
  const w = map
    ? new World({ arenaRadius: map.R, sparkTarget: opts.sparkTarget ?? 900, spawnPoint: streetSpawner(map.data.roads, map.R) })
    : new World({ sparkTarget: opts.sparkTarget });
  w.city = map?.id ?? '';
  return w;
}

// ------------------------------------------------------------------------------------------------ flow
async function startSolo() {
  // The map is usually loaded by now; wait a moment if not, then play either way.
  const map = await Promise.race([cityMap(maps.soloCity || hourCity()), new Promise((r) => setTimeout(() => r(null), 2500))]);
  const w = newWorld(map);
  for (let i = 0; i < BOTS; i++) w.addSnake({ bot: true, name: botName(), mass: 12 + Math.random() * 60 });
  // Let the bots settle so the world is alive when the player arrives.
  for (let i = 0; i < 90; i++) {
    w.step(1 / 30);
    w.events.length = 0;
  }
  const s = w.addSnake({ name: game.name });
  game.world = w;
  game.meId = s.id;
  game.mode = 'solo';
  beginRound(s);
}

function beginRound(s) {
  input.angle = s.a;
  game.alive = true;
  game.running = true;
  game.best = { rank: 99, maxScore: scoreOf(s.mass), hands: 0, born: performance.now() };
  game.deathInfo = null;
  game.handIds = new Set();
  game.refusedAt.clear();
  game.lastColor = s.color;
  cam.x = s.x;
  cam.y = s.y;
  show('hud');
  hide('start');
  hide('over');
  const city = cityName(game.world.city);
  if (city) toast(`${city} · אוספים אנשים ברחובות`, 2600);
  if (game.hintStage === 0) hint('גררו את האצבע לכיוון שרוצים ללכת', 5000);
}

function setButtonsBusy(busy) {
  $('play').disabled = busy;
  $('again').disabled = busy;
}

/** Online when the server is there (people + bots), otherwise at once with bots on this phone. */
function play() {
  if (game.joining) return;
  const net = game.net;
  if (net?.ready() && net.join(game.name, viewExtents())) {
    game.joining = true;
    setButtonsBusy(true);
    clearTimeout(game.joinTimer);
    game.joinTimer = setTimeout(() => {
      if (!game.joining) return;
      game.joining = false;
      setButtonsBusy(false);
      net.idle();
      startSolo();
    }, 6000);
    return;
  }
  net?.idle();
  startSolo();
}

function onJoined(world, meId) {
  clearTimeout(game.joinTimer);
  if (!game.joining) return; // gave up waiting and already playing offline
  game.joining = false;
  setButtonsBusy(false);
  game.world = world;
  game.meId = meId;
  game.mode = 'online';
  beginRound(world.snakes.get(meId));
}

function onDeath(e) {
  game.alive = false;
  const w = game.world;
  const killer = e.killer ? w.snakes.get(e.killer) : null;
  game.deathInfo = { killer: e.name || (killer ? displayName(killer) : null), edge: !!e.edge || e.killer === 0 };
  navigator.vibrate?.(120);
  setTimeout(showOver, 1100);
}

function onLost() {
  if (game.mode !== 'online') return;
  if (game.alive) {
    game.alive = false;
    game.deathInfo = { lost: true };
    showOver();
  }
  game.world = null; // the background goes back to the start-screen view
  game.meId = 0;
}

function showOver() {
  const b = game.best;
  const secs = Math.round((performance.now() - b.born) / 1000);
  $('over-title').textContent = game.deathInfo?.lost
    ? 'החיבור לשרת נותק'
    : game.deathInfo?.edge
      ? 'יצאת מהמפה'
      : game.deathInfo?.killer
        ? `נתקלת בשרשרת של ${game.deathInfo.killer}`
        : 'השרשרת נקרעה';
  $('stat-score').textContent = b.maxScore.toLocaleString('he-IL');
  $('stat-rank').textContent = b.rank < 99 ? `#${b.rank}` : '–';
  $('stat-hands').textContent = String(b.hands);
  $('stat-time').textContent = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs} שנ׳`;
  const join = $('join-link');
  if (CFG.joinUrl && /^https?:\/\//.test(CFG.joinUrl)) {
    join.href = CFG.joinUrl;
    join.hidden = false;
  }
  hide('hud');
  show('over');
  $('again').focus();
}

// ------------------------------------------------------------------------------------------------ input
function setAngleFromPoint(px, py) {
  const s = me();
  if (!s) return;
  const hx = (s.x - cam.x) * cam.zoom + W / 2;
  const hy = (s.y - cam.y) * cam.zoom + H / 2;
  if (Math.hypot(px - hx, py - hy) < 6) return;
  input.angle = Math.atan2(py - hy, px - hx);
}
window.addEventListener('pointerdown', () => game.net?.poke(), { capture: true, passive: true });
window.addEventListener('keydown', () => game.net?.poke(), { capture: true, passive: true });
canvas.addEventListener('pointerdown', (e) => {
  input.touches++;
  if (input.touches >= 2) input.boost = true;
  input.pointerId = e.pointerId;
  setAngleFromPoint(e.clientX, e.clientY);
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' || e.pointerId === input.pointerId) setAngleFromPoint(e.clientX, e.clientY);
});
const endPointer = (e) => {
  input.touches = Math.max(0, input.touches - 1);
  if (input.touches < 2 && !input.holdBoost) input.boost = false;
  if (e.pointerId === input.pointerId) input.pointerId = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const boostBtn = $('boost');
const setHoldBoost = (on) => {
  input.holdBoost = on;
  input.boost = on;
  boostBtn.classList.toggle('on', on);
};
boostBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  setHoldBoost(true);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) boostBtn.addEventListener(ev, () => setHoldBoost(false));

$('hand').addEventListener('click', () => giveHand());

window.addEventListener('keydown', (e) => {
  if (!game.running) {
    if ((e.key === 'Enter' || e.key === ' ') && !$('start').hidden && document.activeElement?.id !== 'reroll') {
      e.preventDefault();
      play();
    }
    return;
  }
  if (e.key === ' ' || e.key === 'Shift') setHoldBoost(true);
  if (e.key === 'ArrowLeft' || e.key === 'a') input.turn = -1;
  if (e.key === 'ArrowRight' || e.key === 'd') input.turn = 1;
  if (e.key === 'h' || e.key === 'ה' || e.key === 'Enter') giveHand();
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.key === 'Shift') setHoldBoost(false);
  if (['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(e.key)) input.turn = 0;
});

function giveHand() {
  const s = me();
  if (!s || !game.alive) return;
  if (game.mode === 'online') {
    game.net.hand();
    return;
  }
  const other = game.world.offerHand(s.id);
  if (other && !game.world.sameTeam(s, other)) {
    toast(`הושטת יד ל${displayName(other)}…`);
    game.refusedAt.set(other.id, game.world.time + 5.2);
  }
}

// ------------------------------------------------------------------------------------------------ UI helpers
function show(id) {
  $(id).hidden = false;
}
function hide(id) {
  $(id).hidden = true;
}
let toastTimer = 0;
function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}
let hintTimer = 0;
function hint(text, ms) {
  const el = $('hint');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.remove('on'), ms);
}
function displayName(s) {
  return s.bot ? `🤖 ${s.name}` : s.name;
}
/** Display name for an id, even after that chain left the view. */
function nameOf(w, id) {
  const s = w.snakes.get(id);
  if (s) return displayName(s);
  const n = w.names?.get(id);
  return n ? (n.bot ? `🤖 ${n.name}` : n.name) : '';
}
/** How much of the city fits across the screen, in metres, for a chain of radius r. */
function viewSpan(r) {
  return Math.min(1400, 420 + r * 18);
}
/** Half the visible width and height in world units (the server sends what falls inside, plus a margin). */
function viewExtents() {
  const s = me();
  const r = s ? radiusFor(s.mass) : 14;
  const target = Math.min(W, H) / viewSpan(r);
  const zoom = Math.max(0.05, Math.min(cam.zoom || target, target));
  return { hw: W / 2 / zoom, hh: H / 2 / zoom };
}

// ------------------------------------------------------------------------------------------------ loop
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  trackPerformance(dt);
  updateStats(now);
  const w = game.world;
  if (w) {
    if (input.turn) input.angle += input.turn * 3.2 * dt;
    if (game.mode === 'solo') {
      const s = me();
      if (s?.alive) w.setInput(s.id, input.angle, input.boost);
      acc += dt;
      while (acc >= 1 / 60) {
        w.step(1 / 60);
        acc -= 1 / 60;
      }
      respawnBots(w);
    } else if (game.net) {
      game.net.tick(dt, input, viewExtents());
    }
    handleEvents(w);
    updateCamera(dt);
    render(now / 1000);
    updateHud();
  } else {
    renderIdle(now / 1000, dt);
  }
}

function respawnBots(w) {
  let bots = 0;
  for (const s of w.snakes.values()) {
    if (s.bot) {
      if (!s.alive) {
        if (!s.goneAt) s.goneAt = w.time;
        if (w.time - s.goneAt > 2.5) w.removeSnake(s.id);
        else bots++;
      } else bots++;
    }
  }
  if (bots < BOTS && Math.random() < 0.05) w.addSnake({ bot: true, name: botName() });
}

function handleEvents(w) {
  const my = game.meId;
  for (const e of w.events) {
    if (e.t === 'death' && e.id === my && game.alive) onDeath(e);
    else if (e.t === 'death' && e.killer === my && game.alive) {
      const name = e.name || nameOf(w, e.id);
      if (name) toast(`${name} נתקל בשרשרת שלך`);
    } else if (e.t === 'link' && (e.a === my || e.b === my) && game.alive) {
      const other = e.a === my ? e.b : e.a;
      game.handIds.add(other);
      game.refusedAt.delete(other);
      toast(`🤝 ${e.name || nameOf(w, other)} ואתה שרשרת אחת! עוברים זה דרך זה ואוספים פי 1.5 כשקרובים`, 4200);
      navigator.vibrate?.([40, 60, 40]);
      game.best.hands = Math.max(game.best.hands, game.handIds.size, handsOf(me()));
      game.hintStage = Math.max(game.hintStage, 3);
    } else if (e.t === 'offer' && e.to === my && game.alive) {
      const name = e.name || nameOf(w, e.from);
      if (name) toast(`${name} מושיט לך יד – לחצו 🤝`, 4000);
    } else if (e.t === 'offered' && game.alive) {
      toast(`הושטת יד ל${e.name || nameOf(w, e.to)}…`);
      game.refusedAt.set(e.to, w.time + 5.2);
    }
  }
  w.events.length = 0;
  // An offer the other side let expire.
  for (const [id, until] of game.refusedAt) {
    if (w.time > until) {
      game.refusedAt.delete(id);
      const o = w.snakes.get(id);
      const m = me();
      if (o && m && !w.sameTeam(o, m) && !game.handIds.has(id) && game.alive) {
        toast(`${displayName(o)} לא הושיט יד בחזרה. נסו מישהו אחר`);
      }
    }
  }
}

function updateCamera(dt) {
  const s = me();
  const target = s && (s.alive || !game.alive) ? s : null;
  if (target) {
    const k = 1 - Math.exp(-dt * 8);
    cam.x += (target.x - cam.x) * k;
    cam.y += (target.y - cam.y) * k;
  }
  const r = s ? radiusFor(s.mass) : 14;
  const zoom = Math.min(W, H) / viewSpan(r);
  cam.zoom += (zoom - cam.zoom) * (1 - Math.exp(-dt * 2));
}

// ------------------------------------------------------------------------------------------------ render
function render(t) {
  const w = game.world;
  const z = cam.zoom;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const map = mapFor(w);
  if (map) map.draw(ctx, cam.x, cam.y, z, W, H, DPR);
  else drawPlainGround();
  drawArena(w.R);
  if (map) map.drawLabels(ctx, cam.x, cam.y, z, W, H, DPR);
  const vx0 = cam.x - W / 2 / z - 80;
  const vx1 = cam.x + W / 2 / z + 80;
  const vy0 = cam.y - H / 2 / z - 80;
  const vy1 = cam.y + H / 2 / z + 140;
  const sx = (x) => (x - cam.x) * z + W / 2;
  const sy = (y) => (y - cam.y) * z + H / 2;

  // People on the street, waiting to join a chain.
  for (const sp of w.sparks.values()) {
    if (sp.x < vx0 || sp.x > vx1 || sp.y < vy0 || sp.y > vy1) continue;
    const hp = sp.r * (sp.ttl ? 4.4 : 4.2) * z;
    let alpha = 1;
    if (sp.ttl) {
      const left = sp.ttl - (w.time - sp.born);
      if (left < 5) alpha = Math.max(0, left / 5);
    }
    if (hp < 5) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = sp.color;
      ctx.fillRect(sx(sp.x) - 1.2, sy(sp.y) - 2.5, 2.4, 5);
      continue;
    }
    const img = figure(sp.color, 'idle', 0);
    const k = hp / FIG.h;
    ctx.globalAlpha = sp.ttl ? alpha * 0.9 : alpha;
    ctx.drawImage(img, sx(sp.x) - (FIG.w * k) / 2, sy(sp.y) - FIG.feet * k, FIG.w * k, FIG.h * k);
  }
  ctx.globalAlpha = 1;

  // Teammates: a dashed line between leaders.
  for (const team of w.teams.values()) {
    const heads = [...team.members].map((id) => w.snakes.get(id)).filter((s) => s?.alive);
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        const a = heads[i];
        const b = heads[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > C.teamBonusRange * 1.6) continue;
        ctx.save();
        ctx.lineWidth = Math.max(1.5, 2.2 * z);
        ctx.strokeStyle = d < C.teamBonusRange ? 'rgba(176, 124, 10, 0.85)' : 'rgba(176, 124, 10, 0.3)';
        ctx.setLineDash([7, 6]);
        ctx.lineDashOffset = -t * 30;
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.quadraticCurveTo(sx((a.x + b.x) / 2 + (b.y - a.y) * 0.15), sy((a.y + b.y) / 2 - (b.x - a.x) * 0.15), sx(b.x), sy(b.y));
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Chains: hands lines first, then every person of every chain from back to front.
  const figs = [];
  const chains = [];
  for (const s of w.snakes.values()) {
    if (!s.alive) continue;
    const r = radiusFor(s.mass);
    const h = r * 3.2; // a person's height in metres
    const k = Math.max(2, Math.round(r * 0.22)); // path points between people
    const color = COLORS[s.color % COLORS.length];
    const pts = [s.x, s.y];
    for (let i = k; i < s.px.length; i += k) pts.push(s.px[i], s.py[i]);
    let visible = false;
    for (let i = 0; i < pts.length && !visible; i += 2) {
      visible = pts[i] > vx0 && pts[i] < vx1 && pts[i + 1] > vy0 && pts[i + 1] < vy1;
    }
    if (!visible) continue;
    chains.push({ s, h, pts, color });
    const hp = h * z;
    const rate = s.boost && s.mass > C.minBoostMass ? 9 : 5; // steps per second
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i];
      const y = pts[i + 1];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      const phase = t * rate + i * 0.25;
      figs.push({ x, y, hp, color, step: Math.floor(phase) % 2, bob: Math.abs(Math.sin(phase * Math.PI)), lead: i === 0, s });
    }
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const { h, pts, color } of chains) {
    const hp = h * z;
    const drop = ((FIG.hand - FIG.feet) / FIG.h) * hp; // hands are this far above the feet
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2.5, hp * 0.1);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx[i ? 'lineTo' : 'moveTo'](sx(pts[i]), sy(pts[i + 1]) + drop);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, hp * 0.065);
    ctx.stroke();
  }
  // Shadows, then people sorted by how far down the screen they stand.
  ctx.fillStyle = 'rgba(70, 55, 30, 0.14)';
  for (const f of figs) {
    ctx.beginPath();
    ctx.ellipse(sx(f.x), sy(f.y), f.hp * 0.2, f.hp * 0.06, 0, 0, TAU);
    ctx.fill();
  }
  figs.sort((a, b) => a.y - b.y);
  for (const f of figs) {
    const k = f.hp / FIG.h;
    const x = sx(f.x);
    const y = sy(f.y) - f.bob * f.hp * 0.035;
    ctx.drawImage(figure(f.color, 'chain', f.step), x - (FIG.w * k) / 2, y - FIG.feet * k, FIG.w * k, FIG.h * k);
    if (f.lead) {
      const dir = Math.cos(f.s.a) >= 0 ? 1 : -1;
      const hand = y - ((FIG.feet - FIG.hand) / FIG.h) * f.hp;
      const isMe = f.s.id === game.meId;
      drawFlag(ctx, x + dir * f.hp * 0.26, hand, f.hp * 1.05, f.color, dir, t + f.s.id, isMe);
    }
  }

  // Names above the other leaders, and hands being offered.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  for (const { s, h } of chains) {
    const hp = h * z;
    const x = sx(s.x);
    const y = sy(s.y) - hp * 1.62; // above the leader's flag
    if (s.id !== game.meId) {
      ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 3;
      ctx.strokeText(displayName(s), x, y - 4);
      ctx.fillStyle = INK;
      ctx.fillText(displayName(s), x, y - 4);
    }
    if (s.offer && s.offer.until > w.time && (s.offer.to === game.meId || s.id === game.meId)) {
      const bob = Math.sin(t * 6) * 3;
      ctx.font = '24px system-ui, sans-serif';
      ctx.fillText('🤝', x, y - 20 + bob);
    }
  }
  drawEdgeWarning(me(), w.R);
  drawMinimap(w);
}

function drawPlainGround() {
  ctx.fillStyle = MAP_STYLE.land;
  ctx.fillRect(0, 0, W, H);
  const z = cam.zoom;
  const step = 100;
  ctx.strokeStyle = 'rgba(140, 120, 90, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.floor((cam.x - W / 2 / z) / step) * step; x < cam.x + W / 2 / z; x += step) {
    ctx.moveTo((x - cam.x) * z + W / 2, 0);
    ctx.lineTo((x - cam.x) * z + W / 2, H);
  }
  for (let y = Math.floor((cam.y - H / 2 / z) / step) * step; y < cam.y + H / 2 / z; y += step) {
    ctx.moveTo(0, (y - cam.y) * z + H / 2);
    ctx.lineTo(W, (y - cam.y) * z + H / 2);
  }
  ctx.stroke();
}

function drawArena(R) {
  const z = cam.zoom;
  const cx = (0 - cam.x) * z + W / 2;
  const cy = (0 - cam.y) * z + H / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.arc(cx, cy, R * z, 0, TAU, true);
  ctx.fillStyle = 'rgba(243, 239, 230, 0.78)';
  ctx.fill('evenodd');
  ctx.setLineDash([9, 7]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(110, 96, 74, 0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, R * z, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

function drawEdgeWarning(s, R) {
  if (!s || !s.alive) return;
  const d = Math.hypot(s.x, s.y);
  const near = (d - (R - 450)) / 450;
  if (near <= 0) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
  g.addColorStop(0, 'rgba(229, 72, 77, 0)');
  g.addColorStop(1, `rgba(229, 72, 77, ${Math.min(0.35, near * 0.35)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawMinimap(w) {
  const m = mini.width;
  if (m < 16) return;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, m, m);
  const c = m / 2;
  const k = (m / 2 - 3) / w.R;
  mctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
  mctx.beginPath();
  mctx.arc(c, c, m / 2 - 1, 0, TAU);
  mctx.fill();
  mctx.strokeStyle = 'rgba(110, 96, 74, 0.45)';
  mctx.lineWidth = 1.2 * DPR;
  mctx.stroke();
  const my = me();
  for (const s of w.snakes.values()) {
    if (!s.alive) continue;
    const isMe = s.id === game.meId;
    const mate = my && my.team && s.team === my.team && !isMe;
    mctx.fillStyle = isMe ? INK : mate ? '#b07c0a' : s.bot ? 'rgba(120, 110, 95, 0.4)' : COLORS[s.color % COLORS.length];
    const rr = (isMe ? 3.2 : mate ? 2.6 : 1.8) * DPR + Math.min(3, s.mass / 150) * DPR;
    mctx.beginPath();
    mctx.arc(c + s.x * k, c + s.y * k, rr, 0, TAU);
    mctx.fill();
  }
}

function handsOf(s) {
  return s ? (s.handsCount ?? s.hands.size) : 0;
}

function renderIdle(t, dt) {
  // Behind the start screen: the live room when connected (following its leader), else a local preview.
  const remote = game.net?.world;
  let w = remote;
  if (remote) {
    game.net.tick(dt, input, viewExtents());
    remote.events.length = 0;
  } else {
    const map = mapFor({ city: maps.soloCity || hourCity() });
    if (!game.preview || (map && game.preview.city !== map.id)) {
      game.preview = newWorld(map, { sparkTarget: 700 });
      for (let i = 0; i < 12; i++) game.preview.addSnake({ bot: true, name: botName(), mass: 20 + Math.random() * 120 });
    }
    w = game.preview;
    w.step(1 / 60);
    w.events.length = 0;
    for (const s of [...w.snakes.values()]) {
      if (s.alive) continue;
      w.removeSnake(s.id);
      w.addSnake({ bot: true, name: botName() });
    }
  }
  let lead = w.snakes.get(w.focus);
  if (!lead) for (const s of w.snakes.values()) if (s.alive && (!lead || s.mass > lead.mass)) lead = s;
  if (game.idleWorld !== w && lead) {
    game.idleWorld = w;
    cam.x = lead.x;
    cam.y = lead.y;
  }
  if (lead) {
    const k = 1 - Math.exp(-dt * 2);
    cam.x += (lead.x - cam.x) * k;
    cam.y += (lead.y - cam.y) * k;
  }
  cam.zoom = Math.min(W, H) / 820;
  const saved = game.world;
  const savedMe = game.meId;
  game.world = w;
  game.meId = -1;
  render(t);
  game.world = saved;
  game.meId = savedMe;
}

// ------------------------------------------------------------------------------------------------ HUD
let hudAt = 0;
function updateHud() {
  const now = performance.now();
  if (now - hudAt < 150) return;
  hudAt = now;
  const w = game.world;
  const alive = [...w.snakes.values()].filter((s) => s.alive).sort((a, b) => b.mass - a.mass);
  const board = game.mode === 'online' ? w.board : null;
  const s = me();
  if (s && s.alive) {
    const score = scoreOf(s.mass);
    // Online, only the server knows the whole room: wait for its board (the view holds just the nearby chains).
    const rank = game.mode === 'online' ? board?.rank || 0 : alive.indexOf(s) + 1;
    const total = game.mode === 'online' ? board?.total || 0 : alive.length;
    $('score').textContent = score.toLocaleString('he-IL');
    $('rank').textContent = rank ? `מקום ${rank} מתוך ${total}` : '';
    game.best.maxScore = Math.max(game.best.maxScore, score);
    if (rank) game.best.rank = Math.min(game.best.rank, rank);
    game.best.hands = Math.max(game.best.hands, handsOf(s), game.handIds.size);
    // Hand button: someone close enough to hold hands with
    const cand = game.mode === 'solo' ? w.handCandidate(s) : game.net?.candidate?.() ?? null;
    const btn = $('hand');
    if (cand) {
      btn.hidden = false;
      btn.querySelector('span').textContent = cand.offer?.to === s.id ? `קבלו את היד של ${displayName(cand)}` : `תנו יד ל${displayName(cand)}`;
      btn.classList.toggle('pulse', cand.offer?.to === s.id);
      if (game.hintStage < 2) {
        game.hintStage = 2;
        hint('לחצו 🤝 – ביחד עוברים זה דרך זה ואוספים פי 1.5', 4500);
      }
    } else btn.hidden = true;
    if (game.hintStage === 0 && now - game.best.born > 6000) {
      game.hintStage = 1;
      hint('החזיקו ⚡ כדי לרוץ – זה עולה קצת אנשים', 4500);
    }
  }
  const lb = $('leaderboard');
  const rows = board
    ? board.top.map(([id, name, score, color, bot]) => ({ id, label: bot ? `🤖 ${name}` : name, score, color }))
    : alive.slice(0, 5).map((o) => ({ id: o.id, label: displayName(o), score: scoreOf(o.mass), color: o.color }));
  lb.replaceChildren(
    ...rows.map((o, i) => {
      const li = document.createElement('li');
      if (o.id === game.meId) li.className = 'me';
      const dot = document.createElement('i');
      dot.style.background = COLORS[o.color % COLORS.length];
      const name = document.createElement('span');
      name.textContent = `${i + 1}. ${o.label}`;
      const sc = document.createElement('b');
      sc.textContent = Number(o.score).toLocaleString('he-IL');
      li.append(dot, name, sc);
      return li;
    }),
  );
  const city = cityName(w.city);
  if (board) {
    $('players').textContent = `${city ? `${city} · ` : ''}${people(board.people)} · ${bots(board.bots)}`;
  } else {
    const n = alive.filter((o) => o.bot).length;
    $('players').textContent = `${city ? `${city} · ` : ''}${game.mode === 'online' ? bots(n) : `מקומי · ${bots(n)}`}`;
  }
}
function people(n) {
  return n === 1 ? 'אדם אחד' : `${n} אנשים`;
}
function bots(n) {
  return n === 1 ? '🤖 בוט אחד' : `🤖 ${n} בוטים`;
}

// ?stats in the address shows frame rate and network numbers (for tuning on real phones).
const statsEl = /[?&]stats\b/.test(location.search) ? document.createElement('div') : null;
let statsAt = 0;
let statsPrev = { bytes: 0, snaps: 0, frames: 0 };
let frameCount = 0;
if (statsEl) {
  statsEl.id = 'stats';
  statsEl.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9;font:11px/1.35 ui-monospace,monospace;color:#1f5f1f;' +
    'background:rgba(255,255,255,.8);padding:4px 6px;border-radius:6px;pointer-events:none;direction:ltr;white-space:pre';
  document.body.append(statsEl);
}
function updateStats(now) {
  frameCount++;
  if (!statsEl || now - statsAt < 1000) return;
  const secs = (now - statsAt) / 1000;
  const n = game.net?.stats() ?? { bytes: 0, snaps: 0, delay: 0, jitter: 0, chains: 0 };
  statsEl.textContent =
    `${game.mode} fps ${Math.round((frameCount - statsPrev.frames) / secs)} dpr ${DPR}\n` +
    `snap/s ${Math.round((n.snaps - statsPrev.snaps) / secs)} KB/s ${((n.bytes - statsPrev.bytes) / 1024 / secs).toFixed(1)}\n` +
    `delay ${Math.round(n.delay)}ms jitter ${Math.round(n.jitter)}ms chains ${n.chains}`;
  statsPrev = { bytes: n.bytes, snaps: n.snaps, frames: frameCount };
  statsAt = now;
}

function trackPerformance(dt) {
  frameTimes.push(dt);
  if (frameTimes.length < 120) return;
  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  frameTimes = [];
  if (avg > 1 / 40 && dprCap > 1) {
    dprCap = Math.max(1, dprCap - 0.5);
    resize();
  }
}

// ------------------------------------------------------------------------------------------------ share
function shareUrl() {
  if (CFG.shareUrl) return CFG.shareUrl;
  try {
    const u = new URL(location.href);
    return u.origin + u.pathname;
  } catch {
    return '';
  }
}
function cardCanvas() {
  const c = document.createElement('canvas');
  c.width = 1080;
  c.height = 1350;
  const g = c.getContext('2d');
  g.fillStyle = MAP_STYLE.land;
  g.fillRect(0, 0, 1080, 1350);
  // A faint street grid, like a city map.
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 10;
  for (let i = -2; i < 12; i++) {
    g.beginPath();
    g.moveTo(i * 130 - 120, 0);
    g.lineTo(i * 130 + 260, 1350);
    g.stroke();
  }
  g.lineWidth = 6;
  for (let j = 0; j < 12; j++) {
    g.beginPath();
    g.moveTo(0, j * 125 + 40);
    g.lineTo(1080, j * 125 - 60);
    g.stroke();
  }
  const color = COLORS[me()?.color ?? game.lastColor ?? 0];
  g.textAlign = 'center';
  g.direction = 'ltr';
  g.fillStyle = INK;
  g.font = '900 124px system-ui, sans-serif';
  g.fillText('Ch-ch-chains', 540, 210);
  g.direction = 'rtl';
  if (CFG.brand) {
    g.font = '800 46px system-ui, sans-serif';
    g.fillStyle = '#0038b8';
    g.fillText(CFG.brand, 540, 285);
  }
  g.font = '600 48px system-ui, sans-serif';
  g.fillStyle = INK;
  g.fillText('הבאתי לשרשרת', 540, 430);
  g.font = '900 190px system-ui, sans-serif';
  g.fillStyle = color;
  g.fillText(game.best.maxScore.toLocaleString('he-IL'), 540, 610);
  g.font = '700 54px system-ui, sans-serif';
  g.fillStyle = INK;
  g.fillText('אנשים', 540, 680);
  // The chain itself: people holding hands across the card, the leader with a flag.
  const n = 9;
  const hp = 150;
  const k = hp / FIG.h;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([930 - i * 100, 900 + Math.sin(i * 0.7) * 26]);
  g.lineCap = 'round';
  g.strokeStyle = color;
  g.lineWidth = 9;
  g.beginPath();
  pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](x, y - ((FIG.feet - FIG.hand) / FIG.h) * hp));
  g.stroke();
  pts
    .slice()
    .sort((a, b) => a[1] - b[1])
    .forEach(([x, y]) => g.drawImage(figure(color, 'chain', 0), x - (FIG.w * k) / 2, y - FIG.feet * k, FIG.w * k, FIG.h * k));
  drawFlag(g, pts[0][0] + hp * 0.26, pts[0][1] - ((FIG.feet - FIG.hand) / FIG.h) * hp, hp * 0.95, color, 1, 0.4);
  g.font = '600 46px system-ui, sans-serif';
  g.fillStyle = INK;
  g.fillText(game.best.hands > 0 ? `והחזקתי ידיים עם ${game.best.hands} 🤝` : 'נראה אתכם עוברים אותי', 540, 1080);
  g.font = '700 40px system-ui, sans-serif';
  g.fillStyle = '#0038b8';
  g.fillText('לבד אתה חזק – ביחד אנחנו שרשרת', 540, 1170);
  const url = shareUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (url) {
    g.direction = 'ltr';
    g.font = '700 38px system-ui, sans-serif';
    g.fillStyle = 'rgba(35,32,27,0.7)';
    g.fillText(url, 540, 1260);
  }
  return c;
}
if (statsEl) globalThis.__chainCard = () => cardCanvas().toDataURL('image/png'); // for checking the card while tuning
async function share() {
  const text = `הבאתי ${game.best.maxScore.toLocaleString('he-IL')} אנשים לשרשרת ב-Ch-ch-chains${
    game.best.hands ? ` והחזקתי ידיים עם ${game.best.hands}` : ''
  } 🔗 ביחד אנחנו שרשרת – נראה אתכם:`;
  const url = shareUrl();
  try {
    const blob = await new Promise((res) => cardCanvas().toBlob(res, 'image/png'));
    const file = blob ? new File([blob], 'chchchains.png', { type: 'image/png' }) : null;
    if (file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: `${text} ${url}` });
      return;
    }
    if (navigator.share) {
      await navigator.share({ text, url });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('הטקסט והקישור הועתקו – הדביקו בוואטסאפ או בטיקטוק');
  } catch {
    $('share-text').value = `${text} ${url}`;
    show('share-fallback');
    $('share-text').select();
  }
}

// ------------------------------------------------------------------------------------------------ boot
/** The small human chain above the logo: five people of different colours holding hands. */
function drawMark() {
  const c = $('mark');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(230 * dpr);
  c.height = Math.round(70 * dpr);
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const hp = 50;
  const k = hp / FIG.h;
  const pts = [0, 1, 2, 3, 4].map((i) => [52 + i * 36, 64 - Math.sin((i / 4) * Math.PI) * 5]);
  const hand = ((FIG.feet - FIG.hand) / FIG.h) * hp;
  g.lineCap = 'round';
  g.strokeStyle = INK;
  g.lineWidth = 2.5;
  g.beginPath();
  pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](x, y - hand));
  g.stroke();
  pts.forEach(([x, y], i) =>
    g.drawImage(figure(COLORS[[9, 1, 2, 3, 0][i]], 'chain', i % 2), x - (FIG.w * k) / 2, y - FIG.feet * k, FIG.w * k, FIG.h * k),
  );
  drawFlag(g, pts[0][0] - hp * 0.26, pts[0][1] - hand, hp * 0.95, COLORS[9], -1, 0.6);
}
function renderName() {
  $('name').textContent = game.name;
}
$('reroll').addEventListener('click', () => {
  game.name = randomName();
  saveName(game.name);
  renderName();
});
$('play').addEventListener('click', play);
$('again').addEventListener('click', play);
$('share').addEventListener('click', share);
$('share-close').addEventListener('click', () => hide('share-fallback'));
if (CFG.brand) $('brand').textContent = CFG.brand;
else $('brand').hidden = true;
if (CFG.publisher) {
  $('publisher').textContent = CFG.publisher;
  $('publisher').hidden = false;
}
document.addEventListener('visibilitychange', () => {
  last = performance.now();
});
renderName();
resize();
drawMark();
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});

// The cities, and this hour's city for offline play and the start screen.
loadCityIndex(CFG.maps)
  .then((cities) => {
    maps.cities = cities;
    maps.soloCity ||= hourCity();
    cityMap(maps.soloCity);
    updateCityLine();
  })
  .catch(() => {
    /* no maps: plain ground */
  });
function updateCityLine() {
  const id = game.net?.world?.city || maps.soloCity;
  const name = cityName(id);
  $('city').textContent = name ? `📍 משחקים עכשיו ב${name}` : '';
}

// Online play when a server is configured (or when this page is served by the game server itself).
const serverUrl =
  CFG.server || (location.protocol.startsWith('http') && CFG.sameOrigin ? `${location.origin.replace(/^http/, 'ws')}/ws` : '');
function netStatusText(status, online) {
  if (status === 'online') {
    return online > 1 ? `🟢 ${online.toLocaleString('he-IL')} מחוברים עכשיו – משחקים עם אנשים אמיתיים` : '🟢 מחובר – משחקים עם אנשים אמיתיים';
  }
  if (status === 'connecting') return 'מעיר את השרת… אפשר כבר לשחק עם בוטים';
  if (status === 'full') return 'השרת מלא כרגע – משחקים עם בוטים';
  return 'השרת לא זמין כרגע – משחקים עם בוטים';
}
if (serverUrl) {
  game.net = connectOnline(serverUrl, {
    onStatus(status, info) {
      for (const id of ['net-status', 'over-net']) {
        $(id).textContent = netStatusText(status, info.online);
        $(id).dataset.state = status;
      }
      if (status === 'online' && game.mode === 'solo' && game.alive && !game.toldOnline) {
        game.toldOnline = true;
        toast('השרת מחובר – מהסיבוב הבא משחקים עם אנשים אמיתיים', 3500);
      }
    },
    onWorld(world) {
      // The room's city: offline rounds follow it too, so everyone sees the same streets.
      if (world.city) {
        maps.soloCity = world.city;
        cityMap(world.city);
      }
      updateCityLine();
    },
    onJoined,
    onLost,
  });
  game.net.watch(viewExtents());
} else {
  $('net-status').textContent = 'משחק מקומי עם בוטים';
  $('net-status').dataset.state = 'solo';
}

// Ch-ch-chains — the browser client: rendering, touch/mouse/keyboard input, screens and sharing.
// Solo mode simulates the world locally with labelled bots; online mode (net.js) swaps in the server's world.
import { World, C, COLORS, radiusFor, scoreOf, randomName, botName, angleDiff } from './sim.js';
import { connectOnline } from './net.js';

const CFG = Object.assign(
  { server: '', brand: 'המשחק של עמך ישראל', publisher: '', joinUrl: '', shareUrl: '' },
  globalThis.CHAIN_CONFIG || {},
);
const BOTS = 20;
const TAU = Math.PI * 2;

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

// ------------------------------------------------------------------------------------------------ sprites
const sprites = new Map();
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** A glowing bead (kind 'bead' | 'bead2' | 'spark' | 'halo') pre-rendered once per colour. */
function sprite(color, kind) {
  const key = color + kind;
  let s = sprites.get(key);
  if (s) return s;
  const size = 96;
  s = document.createElement('canvas');
  s.width = s.height = size;
  const g = s.getContext('2d');
  const [r, gg, b] = hexToRgb(color);
  const c = size / 2;
  if (kind === 'halo') {
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, `rgba(${r},${gg},${b},0.55)`);
    grad.addColorStop(0.45, `rgba(${r},${gg},${b},0.18)`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  } else if (kind === 'spark') {
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, `rgba(${r},${gg},${b},1)`);
    grad.addColorStop(0.4, `rgba(${r},${gg},${b},0.35)`);
    grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  } else {
    // Bead: soft glow, solid body, bright highlight. bead2 is a touch lighter so the chain reads as links.
    const glow = g.createRadialGradient(c, c, c * 0.3, c, c, c);
    glow.addColorStop(0, `rgba(${r},${gg},${b},0.5)`);
    glow.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = glow;
    g.fillRect(0, 0, size, size);
    const lift = kind === 'bead2' ? 40 : 0;
    const body = g.createRadialGradient(c - c * 0.18, c - c * 0.2, c * 0.05, c, c, c * 0.52);
    body.addColorStop(0, `rgb(${Math.min(255, r + 90)},${Math.min(255, gg + 90)},${Math.min(255, b + 90)})`);
    body.addColorStop(0.55, `rgb(${Math.min(255, r + lift)},${Math.min(255, gg + lift)},${Math.min(255, b + lift)})`);
    body.addColorStop(1, `rgb(${Math.round(r * 0.55)},${Math.round(gg * 0.55)},${Math.round(b * 0.55)})`);
    g.fillStyle = body;
    g.beginPath();
    g.arc(c, c, c * 0.5, 0, TAU);
    g.fill();
  }
  sprites.set(key, s);
  return s;
}

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
  online: { players: 0, bots: 0, collectedToday: 0 },
  deathInfo: null,
  hintStage: 0,
  refusedAt: new Map(),
  handIds: new Set(),
  joining: false,
  joinTimer: 0,
  idleWorld: null,
  toldOnline: false,
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

// ------------------------------------------------------------------------------------------------ flow
function startSolo() {
  const w = new World();
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
  cam.x = s.x;
  cam.y = s.y;
  show('hud');
  hide('start');
  hide('over');
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
  if (e.pointerType === 'mouse' && e.button === 0 && e.detail > 0) input.mouseBoost = false;
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
/** Half the visible width and height in world units (the server sends what falls inside, plus a margin). */
function viewExtents() {
  const s = me();
  const r = s ? radiusFor(s.mass) : 14;
  const target = Math.min(W, H) / Math.min(1400, 520 + r * 18);
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
  const view = Math.min(1400, 520 + r * 18);
  const zoom = Math.min(W, H) / view;
  cam.zoom += (zoom - cam.zoom) * (1 - Math.exp(-dt * 2));
}

// ------------------------------------------------------------------------------------------------ render
function render(t) {
  const w = game.world;
  const z = cam.zoom;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawBackground(t, w.R);
  const vx0 = cam.x - W / 2 / z - 60;
  const vx1 = cam.x + W / 2 / z + 60;
  const vy0 = cam.y - H / 2 / z - 60;
  const vy1 = cam.y + H / 2 / z + 60;
  const sx = (x) => (x - cam.x) * z + W / 2;
  const sy = (y) => (y - cam.y) * z + H / 2;

  // Sparks
  for (const sp of w.sparks.values()) {
    if (sp.x < vx0 || sp.x > vx1 || sp.y < vy0 || sp.y > vy1) continue;
    const pulse = 1 + 0.18 * Math.sin(t * 3 + sp.id);
    const size = sp.r * 2 * 2.6 * pulse * z;
    let alpha = 1;
    if (sp.ttl) {
      const left = sp.ttl - (w.time - sp.born);
      if (left < 5) alpha = Math.max(0, left / 5);
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite(sp.color, 'spark'), sx(sp.x) - size / 2, sy(sp.y) - size / 2, size, size);
  }
  ctx.globalAlpha = 1;

  // Team threads under the chains
  const my = me();
  for (const team of w.teams.values()) {
    const heads = [...team.members].map((id) => w.snakes.get(id)).filter((s) => s?.alive);
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        const a = heads[i];
        const b = heads[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > C.teamBonusRange * 1.6) continue;
        const close = d < C.teamBonusRange;
        ctx.save();
        ctx.lineWidth = Math.max(1.5, 3 * z);
        ctx.strokeStyle = close ? 'rgba(255,214,107,0.85)' : 'rgba(255,214,107,0.3)';
        ctx.setLineDash([10 * z, 8 * z]);
        ctx.lineDashOffset = -t * 40;
        ctx.beginPath();
        const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.15;
        const myy = (a.y + b.y) / 2 - (b.x - a.x) * 0.15;
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.quadraticCurveTo(sx(mx), sy(myy), sx(b.x), sy(b.y));
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Chains: smaller first, the player on top.
  const list = [...w.snakes.values()].filter((s) => s.alive);
  list.sort((a, b) => (a.id === game.meId ? 1 : b.id === game.meId ? -1 : a.mass - b.mass));
  for (const s of list) drawSnake(s, t, sx, sy, z, vx0, vx1, vy0, vy1);

  // Name tags and hand offers
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const s of list) {
    if (s.x < vx0 || s.x > vx1 || s.y < vy0 || s.y > vy1) continue;
    const r = radiusFor(s.mass) * z;
    const x = sx(s.x);
    const y = sy(s.y);
    if (s.id !== game.meId) {
      ctx.font = `600 ${Math.max(11, Math.min(15, 12 * z + 3))}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      ctx.fillText(displayName(s), x, y + r + 6);
      ctx.shadowBlur = 0;
    }
    if (s.offer && s.offer.until > w.time && (s.offer.to === game.meId || s.id === game.meId)) {
      const bob = Math.sin(t * 6) * 3;
      ctx.font = `${Math.round(22 + r * 0.3)}px system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText('🤝', x, y - r - 6 + bob);
      ctx.textBaseline = 'top';
    }
  }
  drawEdgeWarning(my, w.R);
  drawMinimap(w);
}

function drawBackground(t, R) {
  const z = cam.zoom;
  ctx.fillStyle = '#080c20';
  ctx.fillRect(0, 0, W, H);
  // Soft vignette glow following the camera
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(40,52,120,0.35)');
  g.addColorStop(1, 'rgba(8,12,32,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Dot grid (parallax-free, world anchored)
  const step = 56;
  const x0 = Math.floor((cam.x - W / 2 / z) / step) * step;
  const y0 = Math.floor((cam.y - H / 2 / z) / step) * step;
  ctx.fillStyle = 'rgba(150,170,255,0.13)';
  const dot = Math.max(1, 1.6 * z);
  for (let x = x0; x < cam.x + W / 2 / z + step; x += step) {
    for (let y = y0; y < cam.y + H / 2 / z + step; y += step) {
      if (x * x + y * y > R * R) continue;
      ctx.fillRect((x - cam.x) * z + W / 2 - dot / 2, (y - cam.y) * z + H / 2 - dot / 2, dot, dot);
    }
  }
  // Outside the arena: dim red haze; the border glows.
  const cx = (0 - cam.x) * z + W / 2;
  const cy = (0 - cam.y) * z + H / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.arc(cx, cy, R * z, 0, TAU, true);
  ctx.fillStyle = 'rgba(70,10,30,0.55)';
  ctx.fill('evenodd');
  ctx.restore();
  ctx.lineWidth = Math.max(2, 5 * z);
  ctx.strokeStyle = `rgba(255,80,120,${0.45 + 0.15 * Math.sin(t * 2)})`;
  ctx.beginPath();
  ctx.arc(cx, cy, R * z, 0, TAU);
  ctx.stroke();
}

function drawSnake(s, t, sx, sy, z, vx0, vx1, vy0, vy1) {
  const r = radiusFor(s.mass);
  const color = COLORS[s.color];
  const a = sprite(color, 'bead');
  const b = sprite(color, 'bead2');
  const size = r * 2 * 1.9 * z;
  const step = Math.max(1, Math.round((r * 0.42) / C.spacing));
  const boosting = s.boost && s.mass > C.minBoostMass;
  if (boosting) {
    const halo = sprite(color, 'halo');
    const hs = size * 1.8;
    for (let i = s.px.length - 1; i >= 0; i -= step * 3) {
      const x = s.px[i];
      const y = s.py[i];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      ctx.drawImage(halo, sx(x) - hs / 2, sy(y) - hs / 2, hs, hs);
    }
  }
  const n = s.px.length;
  for (let i = n - 1; i >= 0; i -= step) {
    const x = s.px[i];
    const y = s.py[i];
    if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
    const taper = i > n - 8 ? 0.75 + 0.25 * ((n - i) / 8) : 1;
    const sz = size * taper;
    ctx.drawImage(Math.floor(i / (step * 3)) % 2 ? b : a, sx(x) - sz / 2, sy(y) - sz / 2, sz, sz);
  }
  // Head with eyes
  const hx = sx(s.x);
  const hy = sy(s.y);
  const hsz = size * 1.12;
  ctx.drawImage(a, hx - hsz / 2, hy - hsz / 2, hsz, hsz);
  if (s.team) {
    ctx.lineWidth = Math.max(1.5, 2.5 * z);
    ctx.strokeStyle = 'rgba(255,214,107,0.9)';
    ctx.beginPath();
    ctx.arc(hx, hy, r * z * 1.25, 0, TAU);
    ctx.stroke();
  }
  const eyeOff = r * 0.45 * z;
  const eyeR = Math.max(2, r * 0.3 * z);
  const look = s.id === game.meId ? input.angle : s.ta ?? s.a;
  for (const side of [-1, 1]) {
    const ex = hx + Math.cos(s.a) * eyeOff * 0.55 + Math.cos(s.a + (side * Math.PI) / 2) * eyeOff;
    const ey = hy + Math.sin(s.a) * eyeOff * 0.55 + Math.sin(s.a + (side * Math.PI) / 2) * eyeOff;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ex, ey, eyeR, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#10142c';
    ctx.beginPath();
    ctx.arc(ex + Math.cos(look) * eyeR * 0.4, ey + Math.sin(look) * eyeR * 0.4, eyeR * 0.55, 0, TAU);
    ctx.fill();
  }
}

function drawEdgeWarning(s, R) {
  if (!s || !s.alive) return;
  const d = Math.hypot(s.x, s.y);
  const near = (d - (R - 500)) / 500;
  if (near <= 0) return;
  ctx.fillStyle = `rgba(255,40,90,${Math.min(0.28, near * 0.28)})`;
  ctx.fillRect(0, 0, W, H);
}

function drawMinimap(w) {
  const m = mini.width;
  if (m < 16) return;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, m, m);
  const c = m / 2;
  const k = (m / 2 - 3) / w.R;
  mctx.fillStyle = 'rgba(12,18,48,0.72)';
  mctx.beginPath();
  mctx.arc(c, c, m / 2 - 1, 0, TAU);
  mctx.fill();
  mctx.strokeStyle = 'rgba(255,80,120,0.6)';
  mctx.lineWidth = 1.5 * DPR;
  mctx.stroke();
  const my = me();
  for (const s of w.snakes.values()) {
    if (!s.alive) continue;
    const isMe = s.id === game.meId;
    const mate = my && my.team && s.team === my.team && !isMe;
    mctx.fillStyle = isMe ? '#fff' : mate ? '#ffd66b' : s.bot ? 'rgba(180,190,230,0.45)' : COLORS[s.color];
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
  if (remote) {
    game.net.tick(dt, input, viewExtents());
    remote.events.length = 0;
    let lead = remote.snakes.get(remote.focus);
    if (!lead) for (const s of remote.snakes.values()) if (!lead || s.mass > lead.mass) lead = s;
    if (game.idleWorld !== remote && lead) {
      game.idleWorld = remote;
      cam.x = lead.x;
      cam.y = lead.y;
    }
    if (lead) {
      const k = 1 - Math.exp(-dt * 3);
      cam.x += (lead.x - cam.x) * k;
      cam.y += (lead.y - cam.y) * k;
    }
    cam.zoom = Math.min(W, H) / 900;
    const saved = game.world;
    const savedMe = game.meId;
    game.world = remote;
    game.meId = -1;
    render(t);
    game.world = saved;
    game.meId = savedMe;
    return;
  }
  if (game.idleWorld !== game.preview) game.idleWorld = null;
  if (!game.preview) {
    game.preview = new World({ sparkTarget: 500 });
    for (let i = 0; i < 12; i++) game.preview.addSnake({ bot: true, name: botName(), mass: 20 + Math.random() * 120 });
  }
  const w = game.preview;
  w.step(1 / 60);
  w.events.length = 0;
  const lead = [...w.snakes.values()].find((s) => s.alive);
  if (lead) {
    cam.x += (lead.x - cam.x) * 0.02;
    cam.y += (lead.y - cam.y) * 0.02;
  }
  cam.zoom = Math.min(W, H) / 900;
  const saved = game.world;
  game.world = w;
  const savedMe = game.meId;
  game.meId = -1;
  render(t);
  game.world = saved;
  game.meId = savedMe;
  for (const s of [...w.snakes.values()]) if (!s.alive) {
    w.removeSnake(s.id);
    w.addSnake({ bot: true, name: botName() });
  }
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
      hint('החזיקו ⚡ כדי להאיץ – זה עולה קצת אורך', 4500);
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
  if (board) {
    $('players').textContent = `${people(board.people)} · ${bots(board.bots)}`;
  } else {
    const n = alive.filter((o) => o.bot).length;
    $('players').textContent = game.mode === 'online' ? bots(n) : `משחק מקומי · ${bots(n)}`;
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
    'position:fixed;left:8px;bottom:8px;z-index:9;font:11px/1.35 ui-monospace,monospace;color:#9dff4f;' +
    'background:rgba(0,0,0,.55);padding:4px 6px;border-radius:6px;pointer-events:none;direction:ltr;white-space:pre';
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
  const bg = g.createLinearGradient(0, 0, 0, 1350);
  bg.addColorStop(0, '#0b1030');
  bg.addColorStop(1, '#1b1150');
  g.fillStyle = bg;
  g.fillRect(0, 0, 1080, 1350);
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.5})`;
    g.fillRect(Math.random() * 1080, Math.random() * 1350, 2, 2);
  }
  const color = COLORS[me()?.color ?? 0];
  // A chain of beads across the card
  const bead = sprite(color, 'bead');
  const bead2 = sprite(color, 'bead2');
  for (let i = 0; i < 46; i++) {
    const x = 1000 - i * 21;
    const y = 700 + Math.sin(i * 0.32) * 110;
    g.drawImage(i % 6 < 3 ? bead : bead2, x - 44, y - 44, 88, 88);
  }
  g.textAlign = 'center';
  g.direction = 'ltr';
  const title = g.createLinearGradient(140, 0, 940, 0);
  title.addColorStop(0, '#7af0ff');
  title.addColorStop(0.55, '#ff8fd0');
  title.addColorStop(1, '#ffd66b');
  g.fillStyle = title;
  g.font = '900 118px system-ui, sans-serif';
  g.fillText('Ch-ch-chains', 540, 200);
  g.direction = 'rtl';
  if (CFG.brand) {
    g.font = '800 44px system-ui, sans-serif';
    g.fillStyle = '#ffd66b';
    g.fillText(CFG.brand, 540, 272);
  }
  g.font = '600 46px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillText('הגעתי לאורך', 540, 400);
  g.font = '900 170px system-ui, sans-serif';
  g.fillStyle = '#ffd66b';
  g.fillText(game.best.maxScore.toLocaleString('he-IL'), 540, 560);
  g.font = '600 48px system-ui, sans-serif';
  g.fillStyle = '#ffffff';
  const line = game.best.hands > 0 ? `והחזקתי ידיים עם ${game.best.hands} 🤝` : 'נראה אתכם עוברים אותי';
  g.fillText(line, 540, 960);
  g.font = '500 38px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.fillText('לבד אתה חזק – ביחד אנחנו שרשרת', 540, 1150);
  const url = shareUrl().replace(/^https?:\/\//, '');
  if (url) {
    g.font = '700 40px system-ui, sans-serif';
    g.fillStyle = '#8fe9ff';
    g.fillText(url, 540, 1230);
  }
  return c;
}
async function share() {
  const text = `הגעתי לאורך ${game.best.maxScore.toLocaleString('he-IL')} ב-Ch-ch-chains${
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
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});

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
    onJoined,
    onLost,
  });
  game.net.watch(viewExtents());
} else {
  $('net-status').textContent = 'משחק מקומי עם בוטים';
  $('net-status').dataset.state = 'solo';
}

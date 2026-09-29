// Ch-ch-chain-ges — the browser client: the maps, the human chains, touch/mouse/keyboard input, the lobby, skins,
// music, the story, screens and sharing. Online play (net.js) draws the server's room: people, and while few play,
// bots named for the rival parties (marked 🤖). Offline play and the story ("נגד כל הסיכויים", campaign.js)
// simulate the world here, against rival bots.
import { World, C, COLORS, radiusFor, scoreOf, randomName } from './sim.js';
import { connectOnline } from './net.js';
import { loadCity, loadMapIndex, MAP_STYLE } from './map.js';
import { streetSpawner } from './streets.js';
import { edgeAhead } from './arena.js';
import { figure, drawFlag, FIG } from './people.js';
import { createAudio, TRACKS } from './audio.js';
import { NAME, SLUG, drawWordmark } from './brand.js';
import { createWalk } from './walk.js';
import { pacer } from './pace.js';
import { cleanName } from './names.js';
import { AVATARS, avatar, allSkins, loadSuppliedSkins } from './avatars.js';
import {
  CHAPTERS, BOOKS, BOOK_NAMES, PERKS, PERK_ROUNDS, RIVALS, OTHERS, EPILOGUE, POLL_NOTE, THRESHOLD, OURS, loadCampaign, saveCampaign,
  newCampaign, knesset, biggestRival, openBook, winChapter, choosePerk, perkMods, starTexts, goalText, mmss, fill, partyOf,
  startChapter, startSkirmish, startPoint,
} from './campaign.js';

const CFG = Object.assign(
  {
    server: '',
    servers: [],
    brand: 'המשחק של עמך ישראל',
    party: 'עמך ישראל',
    publisher: '',
    joinUrl: '',
    shareUrl: '',
    maps: 'maps/',
    skins: 'skins/',
    satellite: null,
    music: [],
    musicPicks: [],
    playlist: {},
  },
  globalThis.CHAIN_CONFIG || {},
);
const TAU = Math.PI * 2;
const INK = '#23201b';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const mini = $('minimap');
const mctx = mini.getContext('2d');

// ------------------------------------------------------------------------------------------------ preferences
function pref(key, fallback = '') {
  try {
    return localStorage.getItem(`chain:${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem(`chain:${key}`, String(value));
  } catch {
    /* storage unavailable */
  }
}

let W = 0;
let H = 0;
let DPR = 1;
let dprCap = Math.min(3, window.devicePixelRatio || 1); // the screen's own sharpness, unless the phone cannot keep up
const pace = pacer();
const miniSize = { w: 110, h: 110 };
function resize() {
  DPR = Math.min(dprCap, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  sizeMinimap();
}
window.addEventListener('resize', resize);

// ------------------------------------------------------------------------------------------------ state
const game = {
  mode: 'solo', // 'solo' | 'online' | 'story'
  world: null,
  meId: 0,
  running: false,
  alive: false,
  name: cleanName(pref('name')) || randomName(),
  skin: pref('skin') || AVATARS[Math.floor(Math.random() * AVATARS.length)].id,
  best: { rank: 99, maxScore: 0, hands: 0, born: 0 },
  net: null,
  netUrl: '',
  deathInfo: null,
  hintStage: 0,
  refusedAt: new Map(),
  handIds: new Set(),
  joining: false,
  joinTimer: 0,
  idleWorld: null,
  preview: null,
  here: 0,
  hereSeen: 0,
  story: null, // a chapter being played: { index, chapter, run, map }
  huntedBy: new Map(), // online: bot id → until when (ms) it is after you
  skirmish: null, // alone, offline: the rival parties' director
  sat: pref('sat') === '1',
  green: pref('green') === '1',
};
const cam = { x: 0, y: 0, zoom: 1 };
const input = { angle: 0, boost: false, holdBoost: false, turn: 0 };
let last = performance.now();
let acc = 0;
let frameTimes = [];

function me() {
  return game.world?.snakes.get(game.meId) || null;
}

// ------------------------------------------------------------------------------------------------ sound
const audio = createAudio({ muted: pref('muted') === '1', track: pref('track', 'chains') });
function renderSound() {
  for (const b of document.querySelectorAll('.sound')) {
    // The round button shows how it is; the others say what a tap does.
    b.textContent = b.id === 'sound-hud' ? (audio.muted ? '🔇' : '🔊') : audio.muted ? '🔊 להפעיל מוסיקה' : '🔇 להשתיק';
    b.setAttribute('aria-pressed', String(!audio.muted));
  }
}
for (const b of document.querySelectorAll('.sound')) {
  b.addEventListener('click', () => {
    audio.unlock();
    audio.setMuted(!audio.muted);
    setPref('muted', audio.muted ? '1' : '0');
    renderSound();
  });
}
document.addEventListener('visibilitychange', () => audio.pause(document.hidden));
// The music starts with the first touch anywhere: browsers allow sound only after one.
const firstTouch = () => {
  audio.unlock();
  for (const t of ['touchend', 'click', 'keydown']) document.removeEventListener(t, firstTouch, true);
};
for (const t of ['touchend', 'click', 'keydown']) document.addEventListener(t, firstTouch, true);

// ------------------------------------------------------------------------------------------------ maps
const maps = { list: [], byId: new Map(), loaded: new Map(), current: '', lobby: {}, online: 0 };
/** Resolves to the CityMap for `id` (loading it once), or null when it cannot be loaded. */
function cityMap(id) {
  if (!id) return Promise.resolve(null);
  if (!maps.loaded.has(id)) {
    const p = loadCity(id, CFG.maps).then(
      (m) => {
        p.value = m;
        m.setOptions({ sat: game.sat, green: game.green, xyz: xyzProvider() });
        // Buildings, land use and named places come a moment later (towns whose detail is built).
        if (maps.byId.get(id)?.detail) m.loadDetail();
        return m;
      },
      () => null,
    );
    maps.loaded.set(id, p);
  }
  return maps.loaded.get(id);
}
/** The map for a world, if it has finished loading. */
function mapFor(w) {
  return (w && maps.loaded.get(w.city)?.value) ?? null;
}
const mapName = (id) => maps.byId.get(id)?.he ?? '';
function xyzProvider() {
  const s = CFG.satellite;
  return s && /^https:\/\/[^\s]+\{z\}[^\s]*$/.test(s.tiles || '') ? { url: s.tiles, max: s.maxZoom || 19, credit: s.credit || '' } : null;
}
function sparkTargetFor(map) {
  if (!map) return 850;
  if (map.kind === 'region') return 1100;
  return Math.round(Math.max(380, Math.min(1000, (map.data.area || 20) * 45)));
}
function newWorld(map, opts = {}) {
  const w = map
    ? new World({
        arenaRadius: map.R,
        sparkTarget: opts.sparkTarget ?? sparkTargetFor(map),
        spawnPoint: streetSpawner(map.data.roads, map.R, Math.random, { inside: map.arena.inside, hubs: map.data.hubs }) ?? undefined,
        inside: map.arena.inside,
      })
    : new World({ sparkTarget: opts.sparkTarget });
  w.city = map?.id ?? '';
  return w;
}
/** Sets the map everyone on this phone plays next; the start screen follows it. */
function chooseMap(id, { save = true } = {}) {
  if (!id || (maps.byId.size && !maps.byId.has(id))) return;
  maps.current = id;
  if (save) setPref('map', id);
  cityMap(id);
  renderMapRow();
  ensureNet();
  game.net?.watch(viewExtents(), id);
}

// ------------------------------------------------------------------------------------------------ flow
async function startSolo(reason) {
  const map = await Promise.race([cityMap(maps.current), new Promise((r) => setTimeout(() => r(null), 3000))]);
  const w = newWorld(map);
  for (let i = 0; i < 60; i++) {
    w.step(1 / 30);
    w.events.length = 0;
  }
  const s = w.addSnake({ name: game.name, skin: game.skin });
  game.world = w;
  game.meId = s.id;
  game.mode = 'solo';
  game.story = null;
  // Alone on the phone, the rival parties walk the streets too, and now and then one comes after you.
  game.skirmish = startSkirmish(map, w, { playerId: s.id });
  beginRound(s);
  if (reason) toast(reason, 4200);
}

function beginRound(s) {
  input.angle = s.a;
  game.alive = true;
  game.running = true;
  game.best = { rank: 99, maxScore: scoreOf(s.mass), hands: 0, born: performance.now() };
  game.deathInfo = null;
  game.handIds = new Set();
  game.refusedAt.clear();
  game.huntedBy.clear();
  game.lastColor = s.color;
  game.lastScore = scoreOf(s.mass);
  game.hereSeen = 0;
  audio.setScene('play');
  cam.x = s.x;
  cam.y = s.y;
  show('hud');
  for (const id of ['start', 'over', 'story', 'maps', 'skins', 'music']) hide(id);
  $('mission').hidden = game.mode !== 'story';
  $('hud').classList.toggle('story', game.mode === 'story');
  if (game.mode !== 'solo') game.skirmish = null;
  $('waiting').hidden = true;
  const map = mapFor(game.world);
  $('green-btn').hidden = !map?.hasGreenLine;
  updateCredit();
  sizeMinimap();
  const name = mapName(game.world.city);
  if (game.mode !== 'story' && name) toast(`${name} · אוספים אנשים ברחובות`, 2600);
  if (game.hintStage === 0) hint('גררו את האצבע לכיוון שרוצים ללכת', 5000);
}

function setButtonsBusy(busy) {
  $('play').disabled = busy;
  $('again').disabled = busy;
}

/** Online on the chosen map when a server is there, otherwise at once, alone, on this phone. */
function play() {
  if (game.joining) return;
  audio.unlock(); // a tap: browsers allow sound from here on
  commitName();
  const net = game.net;
  if (net?.ready() && net.join(game.name, viewExtents(), { map: maps.current, skin: game.skin })) {
    game.joining = true;
    setButtonsBusy(true);
    clearTimeout(game.joinTimer);
    game.joinTimer = setTimeout(() => {
      if (!game.joining) return;
      game.joining = false;
      setButtonsBusy(false);
      net.idle();
      startSolo('השרת לא ענה – משחקים לבד בינתיים');
    }, 6000);
    return;
  }
  net?.idle();
  startSolo(net ? 'אין חיבור לשרת כרגע – משחקים לבד, והמפה מחכה לאחרים' : '');
}

function onJoined(world, meId) {
  clearTimeout(game.joinTimer);
  if (!game.joining) return; // gave up waiting and already playing offline
  game.joining = false;
  setButtonsBusy(false);
  game.world = world;
  game.meId = meId;
  game.mode = 'online';
  game.story = null;
  if (world.city && world.city !== maps.current) chooseMap(world.city);
  beginRound(world.snakes.get(meId));
}

function onDeath(e) {
  game.alive = false;
  const w = game.world;
  const killer = e.killer ? w.snakes.get(e.killer) : null;
  game.deathInfo = { killer: e.name || (killer ? killer.name : null), edge: !e.cause && (!!e.edge || e.killer === 0), cause: e.cause || '' };
  navigator.vibrate?.(120);
  audio.sfx('break');
  audio.setScene('over');
  setTimeout(showOver, 1100);
}

function onLost() {
  if (game.mode !== 'online') return;
  if (game.alive) {
    game.alive = false;
    game.deathInfo = { lost: true };
    audio.setScene('over');
    showOver();
  }
  game.world = null; // the background goes back to the start-screen view
  game.meId = 0;
}

function showOver() {
  const b = game.best;
  const secs = Math.round((performance.now() - b.born) / 1000);
  const story = game.mode === 'story';
  const blocked = { roadworks: 'נתקעתם בעבודות בכביש', bus: 'האוטובוס חסם את השרשרת', train: 'הרכבת חצתה את השרשרת' };
  $('over-title').textContent = game.deathInfo?.lost
    ? 'החיבור לשרת נותק'
    : game.deathInfo?.why
      ? `${game.deathInfo.why} – הפרק לא הושלם`
      : blocked[game.deathInfo?.cause]
        ? blocked[game.deathInfo.cause]
        : game.deathInfo?.edge
        ? story
          ? 'יצאתם מהמפה – המשימה לא הושלמה'
          : 'יצאת מהמפה'
        : game.deathInfo?.killer
          ? `נתקלת בשרשרת של ${game.deathInfo.killer}`
          : story
            ? 'השרשרת נקרעה – המשימה לא הושלמה'
            : 'השרשרת נקרעה';
  $('stat-score').textContent = b.maxScore.toLocaleString('he-IL');
  // In the story, the place in a room means nothing: how many rivals ran into you does.
  $('stat-rank').textContent = story ? String(game.story?.run?.cuts ?? 0) : b.rank < 99 ? `#${b.rank}` : '–';
  $('stat-rank-label').textContent = story ? 'יריבות נתקלו בכם' : 'המקום הכי גבוה';
  $('over-net').hidden = story;
  $('stat-hands').textContent = String(b.hands);
  $('stat-time').textContent = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs} שנ׳`;
  $('again').textContent = story ? 'עוד ניסיון' : 'עוד סיבוב';
  const join = $('join-link');
  if (CFG.joinUrl && /^https?:\/\//.test(CFG.joinUrl)) {
    join.href = CFG.joinUrl;
    join.hidden = false;
  }
  hide('hud');
  show('over');
  $('again').focus();
}

function toMenu() {
  game.running = false;
  game.alive = false;
  game.world = null; // the start screen shows the chosen map (and its room, when people play there)
  game.meId = 0;
  game.story = null;
  game.skirmish = null;
  hide('over');
  hide('hud');
  show('start');
  audio.setScene('menu');
  renderMapRow();
  game.net?.watch(viewExtents(), maps.current);
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
// One finger steers; any second finger, anywhere on the map, runs (as long as it is down).
const pointers = new Map();
let steerId = null;
function updateBoost() {
  input.boost = input.holdBoost || pointers.size >= 2;
  $('boost').classList.toggle('on', input.boost);
}
window.addEventListener('pointerdown', () => game.net?.poke(), { capture: true, passive: true });
window.addEventListener('keydown', () => game.net?.poke(), { capture: true, passive: true });
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, e.pointerType);
  if (steerId === null) {
    steerId = e.pointerId;
    setAngleFromPoint(e.clientX, e.clientY);
  } else if (game.hintStage < 4 && game.running) {
    game.hintStage = 4;
    hint('⚡ אצבע שנייה = ריצה', 2500);
  }
  if (e.pointerType === 'mouse' && e.button === 2) input.holdBoost = true;
  updateBoost();
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' || e.pointerId === steerId) setAngleFromPoint(e.clientX, e.clientY);
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (e.pointerType === 'mouse' && e.button === 2) input.holdBoost = false;
  if (e.pointerId === steerId) steerId = pointers.size ? [...pointers.keys()].pop() : null;
  updateBoost();
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const boostBtn = $('boost');
const setHoldBoost = (on) => {
  input.holdBoost = on;
  updateBoost();
};
boostBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  setHoldBoost(true);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) boostBtn.addEventListener(ev, () => setHoldBoost(false));

$('hand').addEventListener('click', () => giveHand());

window.addEventListener('keydown', (e) => {
  if (e.target?.tagName === 'INPUT') {
    if (e.key === 'Enter' && e.target.id === 'name') {
      e.preventDefault();
      e.target.blur();
      play();
    }
    return;
  }
  if (!game.running) {
    if ((e.key === 'Enter' || e.key === ' ') && !$('start').hidden && !document.activeElement?.closest('button')) {
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
    toast(`הושטת יד ל${other.name}…`);
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
/** Display name for an id, even after that chain left the view. */
function nameOf(w, id) {
  return w.snakes.get(id)?.name || w.names?.get(id)?.name || '';
}
/** How much of the map fits across the screen, in map units, for a chain of radius r. */
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
function updateCredit() {
  const map = mapFor(game.world) ?? maps.loaded.get(maps.current)?.value;
  const text = map?.credit || '© OpenStreetMap contributors';
  $('osm').textContent = text;
  $('osm').href = /Copernicus|Sentinel/.test(text)
    ? 'https://sentinels.copernicus.eu/'
    : /NASA/.test(text)
      ? 'https://earthobservatory.nasa.gov/features/BlueMarble'
      : 'https://www.openstreetmap.org/copyright';
}

// ------------------------------------------------------------------------------------------------ loop
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  if (walk.active) {
    // Walking the streets: the 3D view draws instead of the map.
    walk.frame(Math.min(dt, 0.1));
    return;
  }
  trackPerformance(dt);
  updateStats(now);
  const w = game.world;
  if (w && game.running) {
    if (input.turn) input.angle += input.turn * 3.2 * dt;
    if (game.mode === 'solo' || game.mode === 'story') {
      const s = me();
      if (s?.alive) w.setInput(s.id, input.angle, input.boost);
      acc += dt;
      while (acc >= 1 / 60) {
        w.step(1 / 60);
        acc -= 1 / 60;
      }
      for (const o of [...w.snakes.values()]) if (!o.alive && o.id !== game.meId) w.removeSnake(o.id);
    } else if (game.net) {
      game.net.tick(dt, input, viewExtents());
    }
    handleEvents(w);
    if (game.mode === 'story') updateStory(dt);
    else if (game.mode === 'solo' && game.skirmish && game.alive) for (const text of game.skirmish.update(dt).warn) toast(text, 2600);
    updateCamera(dt);
    render(now / 1000);
    updateHud();
    const s = me();
    if (s?.alive && game.alive) {
      // A blip for every person who joins; the music follows the chain.
      const score = scoreOf(s.mass);
      if (score > game.lastScore) audio.sfx('pick');
      game.lastScore = score;
      audio.setIntensity({ size: score, running: input.boost && s.mass > C.minBoostMass, linked: !!s.team });
    }
  } else {
    renderIdle(now / 1000, dt);
  }
}

function handleEvents(w) {
  const my = game.meId;
  const run = game.mode === 'story' ? game.story?.run : game.mode === 'solo' ? game.skirmish : null;
  for (const e of w.events) {
    run?.event(e);
    if (e.t === 'hunt' && game.alive) {
      game.huntedBy.set(e.id, performance.now() + 16000);
      toast(`⚠️ ${e.name || nameOf(w, e.id)} יוצאת לחסום אותך`, 2600);
    } else if (e.t === 'shield' && e.id === my && game.alive) {
      toast('🛡️ החוסן הציל אתכם: חלק מהשרשרת נשאר מאחור', 2800);
      navigator.vibrate?.([80, 40, 80]);
      audio.sfx('broke');
    } else if (e.t === 'death' && e.id === my && game.alive) onDeath(e);
    else if (e.t === 'death' && e.killer === my && game.alive) {
      const name = e.name || nameOf(w, e.id);
      if (name) toast(`${name} נתקל בשרשרת שלך`);
      audio.sfx('broke');
    } else if (e.t === 'link' && (e.a === my || e.b === my) && game.alive) {
      const other = e.a === my ? e.b : e.a;
      game.handIds.add(other);
      game.refusedAt.delete(other);
      toast(`🤝 ${e.name || nameOf(w, other)} ואתה שרשרת אחת! עוברים זה דרך זה ואוספים פי 1.5 כשקרובים`, 4200);
      navigator.vibrate?.([40, 60, 40]);
      audio.sfx('link');
      game.best.hands = Math.max(game.best.hands, game.handIds.size, handsOf(me()));
      game.hintStage = Math.max(game.hintStage, 3);
    } else if (e.t === 'offer' && e.to === my && game.alive) {
      const name = e.name || nameOf(w, e.from);
      if (name) toast(`${name} מושיט לך יד – לחצו 🤝`, 4000);
      audio.sfx('offer');
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
      if (o && m && !w.sameTeam(o, m) && !game.handIds.has(id) && game.alive) toast(`${o.name} לא הושיט יד בחזרה. נסו מישהו אחר`);
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
  else {
    drawPlainGround();
    drawArena(w.R);
  }
  if (map) map.drawLabels(ctx, cam.x, cam.y, z, W, H, DPR);
  const vx0 = cam.x - W / 2 / z - 80;
  const vx1 = cam.x + W / 2 / z + 80;
  const vy0 = cam.y - H / 2 / z - 80;
  const vy1 = cam.y + H / 2 / z + 140;
  const sx = (x) => (x - cam.x) * z + W / 2;
  const sy = (y) => (y - cam.y) * z + H / 2;

  drawHazards(w, t, sx, sy);
  if (game.story?.run) drawTargets(game.story.run.targets, t, sx, sy, false);

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
    const h = r * 3.2; // a person's height in map units
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
      // The leader wears the chain's face: a bobblehead over the paper doll.
      const face = avatar(f.s.skin);
      if (face) {
        const size = Math.max(22, f.hp * 0.8);
        const hy = y - (FIG.feet - 22) * k - size * 0.12;
        ctx.beginPath();
        ctx.arc(x, hy, size * 0.47, 0, TAU);
        ctx.fillStyle = f.color;
        ctx.fill();
        ctx.drawImage(face, x - size / 2, hy - size / 2, size, size);
      }
      // A shield (the story's resilience): a soft bubble while it lasts, bright just after it saved the chain.
      if (isMe && (f.s.shield > 0 || w.time < f.s.safeUntil)) {
        const fresh = w.time < f.s.safeUntil;
        ctx.save();
        ctx.strokeStyle = fresh ? 'rgba(47, 111, 237, 0.9)' : 'rgba(47, 111, 237, 0.35)';
        ctx.lineWidth = fresh ? 4 : 2;
        ctx.globalAlpha = fresh ? 0.6 + 0.4 * Math.sin(t * 18) : 1;
        ctx.beginPath();
        ctx.arc(x, y - f.hp * 0.45, f.hp * 0.75, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawVehicles(w, sx, sy);
  drawRain(w, t, sx, sy);
  if (game.story?.run) drawTargets(game.story.run.targets, t, sx, sy, true);

  // Names above the other leaders, and hands being offered.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  for (const { s, h } of chains) {
    const hp = h * z;
    const x = sx(s.x);
    const y = sy(s.y) - hp * 1.62; // above the leader's flag
    if (s.id !== game.meId) {
      // A rival out to get you: its name in red, and a ring that beats like a pulse.
      const hunting =
        (s.ai?.hunting && (s.ai.target === game.meId || game.story?.run?.allies?.some((a) => a.id === s.ai.target))) ||
        game.huntedBy.get(s.id) > performance.now();
      // Online, bots say they are bots.
      const shown = game.mode === 'online' && s.bot ? `🤖 ${s.name}` : s.name;
      const label = hunting ? `🎯 ${shown}` : shown;
      ctx.font = `${hunting ? 800 : 600} 12px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, x, y - 4);
      ctx.fillStyle = hunting ? '#c8252c' : INK;
      ctx.fillText(label, x, y - 4);
      if (hunting) {
        ctx.save();
        ctx.strokeStyle = `rgba(229, 72, 77, ${0.55 + 0.35 * Math.sin(t * 9)})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, sy(s.y) - hp * 0.45, hp * (0.62 + 0.06 * Math.sin(t * 9)), 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (s.offer && s.offer.until > w.time && (s.offer.to === game.meId || s.id === game.meId)) {
      const bob = Math.sin(t * 6) * 3;
      ctx.font = '24px system-ui, sans-serif';
      ctx.fillText('🤝', x, y - 20 + bob);
    }
  }
  const my = me();
  if (my?.alive && game.alive) drawPointer(my, t);
  drawEdgeWarning(my, w, map);
  drawOffscreenHunters(w, sx, sy);
  if (game.story?.run) drawOffscreenTargets(game.story.run.targets, sx, sy);
  drawMinimap(w, map);
}

// ------------------------------------------------------------------------------------------------ obstacles (story)
let stripes = null;
function stripePattern() {
  if (stripes) return stripes;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#f76b15';
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(8, 0);
  g.lineTo(0, 8);
  g.closePath();
  g.moveTo(16, 0);
  g.lineTo(16, 8);
  g.lineTo(8, 16);
  g.lineTo(0, 16);
  g.closePath();
  g.fill();
  stripes = ctx.createPattern(c, 'repeat');
  return stripes;
}
/** Storm clouds and roadworks: on the ground, under the chains. */
function drawHazards(w, t, sx, sy) {
  if (!w.zones) return; // online rooms have none
  const z = cam.zoom;
  for (const zone of w.zones) {
    const p = w.zoneAt(zone);
    const x = sx(p.x);
    const y = sy(p.y);
    const r = zone.r * z;
    if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;
    const g = ctx.createRadialGradient(x, y, r * 0.15, x, y, r);
    g.addColorStop(0, 'rgba(52, 58, 72, 0.42)');
    g.addColorStop(0.75, 'rgba(52, 58, 72, 0.26)');
    g.addColorStop(1, 'rgba(52, 58, 72, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.font = `${Math.max(22, Math.min(46, r * 0.22))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.85;
    ctx.fillText(Math.sin(t * 2.3 + zone.ax) > 0.93 ? '🌩️' : '⛈️', x, y);
    ctx.globalAlpha = 1;
  }
  for (const b of w.bars) {
    const x1 = sx(b.x1);
    const y1 = sy(b.y1);
    const x2 = sx(b.x2);
    const y2 = sy(b.y2);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    if (mx < -80 || mx > W + 80 || my < -80 || my > H + 80) continue;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const thick = Math.max(5, b.w * z);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(Math.atan2(y2 - y1, x2 - x1));
    ctx.fillStyle = 'rgba(70, 55, 30, 0.18)';
    ctx.fillRect(-len / 2 + 2, -thick / 2 + 3, len, thick);
    ctx.fillStyle = stripePattern();
    ctx.fillRect(-len / 2, -thick / 2, len, thick);
    ctx.strokeStyle = '#b4470b';
    ctx.lineWidth = 1;
    ctx.strokeRect(-len / 2, -thick / 2, len, thick);
    // Traffic cones at both ends.
    for (const cx of [-len / 2, len / 2]) {
      const h = Math.max(7, thick * 1.2);
      ctx.fillStyle = '#f76b15';
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.45, h * 0.5);
      ctx.lineTo(cx, -h * 0.7);
      ctx.lineTo(cx + h * 0.45, h * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - h * 0.22, -h * 0.12, h * 0.44, h * 0.18);
    }
    ctx.restore();
  }
}
/** Buses and trains, over the chains (they cut straight through them). */
function drawVehicles(w, sx, sy) {
  if (!w.movers) return;
  const z = cam.zoom;
  for (const m of w.movers) {
    const p = w.moverAt(m);
    const x = sx(p.x);
    const y = sy(p.y);
    const L = Math.max(22, (m.half * 2 + m.r * 2) * z);
    const Wd = Math.max(9, m.r * 2 * z);
    if (x < -L || x > W + L || y < -L || y > H + L) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.a);
    ctx.fillStyle = 'rgba(40, 32, 20, 0.22)';
    ctx.beginPath();
    roundRect(ctx, -L / 2 + 2, -Wd / 2 + 3, L, Wd, Wd * 0.3);
    ctx.fill();
    const train = m.label === 'train';
    ctx.fillStyle = train ? '#e4e8ee' : '#1f8a4c';
    ctx.strokeStyle = train ? '#56607a' : '#10582f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    roundRect(ctx, -L / 2, -Wd / 2, L, Wd, Wd * 0.3);
    ctx.fill();
    ctx.stroke();
    // Windows along both sides, a windscreen in front.
    ctx.fillStyle = train ? '#2f5bd3' : '#cfe8f5';
    const n = Math.max(3, Math.round(L / Math.max(10, Wd * 1.1)));
    for (let i = 0; i < n; i++) {
      const wx = -L / 2 + (L * (i + 0.5)) / (n + 0.6);
      ctx.fillRect(wx - L / (n * 3.4), -Wd / 2 + Wd * 0.14, L / (n * 1.7), Wd * 0.18);
      ctx.fillRect(wx - L / (n * 3.4), Wd / 2 - Wd * 0.32, L / (n * 1.7), Wd * 0.18);
    }
    ctx.fillStyle = '#23201b';
    ctx.fillRect(L / 2 - Wd * 0.28, -Wd * 0.32, Wd * 0.16, Wd * 0.64);
    if (train) {
      ctx.fillStyle = '#2f5bd3';
      ctx.fillRect(-L / 2, -Wd * 0.06, L, Wd * 0.12);
    }
    ctx.restore();
  }
}
/** Rain in the storms: short slanted streaks, over everything. */
function drawRain(w, t, sx, sy) {
  if (!w.zones?.length) return;
  const z = cam.zoom;
  ctx.save();
  ctx.strokeStyle = 'rgba(60, 80, 110, 0.45)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (const zone of w.zones) {
    const p = w.zoneAt(zone);
    const x = sx(p.x);
    const y = sy(p.y);
    const r = zone.r * z;
    if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;
    for (let i = 0; i < 70; i++) {
      const a = (i * 2.399) % TAU;
      const d = r * Math.sqrt(((i * 0.618) % 1) * 0.95);
      const fall = ((t * 1.6 + i * 0.37) % 1) * 26 - 13;
      const rx = x + Math.cos(a) * d + fall * 0.4;
      const ry = y + Math.sin(a) * d + fall;
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx - 3, ry + 9);
    }
  }
  ctx.stroke();
  ctx.restore();
}
function roundRect(g, x, y, w, h, r) {
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}
/** Red arrows at the screen's edge toward rivals hunting you (from further off with the situation room). */
function drawOffscreenHunters(w, sx, sy) {
  const s = me();
  if (!s?.alive || !game.alive) return;
  const range = game.mode === 'story' && game.story?.perks?.includes('intel') ? 1700 : 750;
  const now = performance.now();
  for (const o of w.snakes.values()) {
    if (!o.alive || !((o.ai?.hunting && o.ai.target === game.meId) || game.huntedBy.get(o.id) > now)) continue;
    const d = Math.hypot(o.x - s.x, o.y - s.y);
    if (d > range) continue;
    const x = sx(o.x);
    const y = sy(o.y);
    if (x > 20 && x < W - 20 && y > 20 && y < H - 20) continue;
    const a = Math.atan2(y - H / 2, x - W / 2);
    const m = 30;
    const k = Math.min((W / 2 - m) / Math.abs(Math.cos(a) || 1e-6), (H / 2 - m - 30) / Math.abs(Math.sin(a) || 1e-6));
    const ex = W / 2 + Math.cos(a) * k;
    const ey = H / 2 + Math.sin(a) * k;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(a);
    ctx.globalAlpha = 0.55 + 0.45 * (1 - d / range);
    ctx.fillStyle = '#e5484d';
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(-6, 12);
    ctx.lineTo(-1, 0);
    ctx.lineTo(-6, -12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.font = '800 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c8252c';
    ctx.fillText(o.name, ex - Math.cos(a) * 26, ey - Math.sin(a) * 22);
  }
}

/** The direction arrow, like a compass needle just ahead of your leader (where your finger is steering). */
function drawPointer(s, t) {
  const z = cam.zoom;
  const r = radiusFor(s.mass);
  const hp = r * 3.2 * z;
  const x = (s.x - cam.x) * z + W / 2;
  const y = (s.y - cam.y) * z + H / 2 - hp * 0.45;
  const a = input.angle;
  const dist = Math.max(38, hp * 1.05) + Math.sin(t * 5) * 2;
  const ax = x + Math.cos(a) * dist;
  const ay = y + Math.sin(a) * dist;
  const size = Math.max(9, Math.min(16, hp * 0.22));
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.7, size * 0.75);
  ctx.lineTo(-size * 0.35, 0);
  ctx.lineTo(-size * 0.7, -size * 0.75);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.stroke();
  ctx.fillStyle = input.boost ? '#f59e0b' : COLORS[s.color % COLORS.length];
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.restore();
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

/** Red at the screen's edge when the city limits are just ahead. */
function drawEdgeWarning(s, w, map) {
  if (!s || !s.alive || !game.alive) return;
  const inside = map?.arena.inside ?? w.inside;
  if (!inside) return;
  const d = edgeAhead(inside, s.x, s.y, s.a, 420, 35);
  if (d === Infinity) return;
  const near = 1 - d / 420;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
  g.addColorStop(0, 'rgba(229, 72, 77, 0)');
  g.addColorStop(1, `rgba(229, 72, 77, ${Math.min(0.38, near * 0.45)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Mission places: a pulsing ring and the place's name; hung flags once done. Drawn under (rings) or over (flags). */
function drawTargets(targets, t, sx, sy, over) {
  const z = cam.zoom;
  for (const p of targets) {
    const x = sx(p.x);
    const y = sy(p.y);
    if (x < -120 || x > W + 120 || y < -120 || y > H + 120) continue;
    if (!over && p.active && !p.done) {
      const r = Math.max(26, 95 * z) + Math.sin(t * 4) * 4;
      ctx.save();
      ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
      ctx.strokeStyle = 'rgba(176, 124, 10, 0.9)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 7]);
      ctx.lineDashOffset = -t * 20;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (over) {
      if (p.done) drawFlag(ctx, x, y + 2, Math.max(26, 70 * z), COLORS[me()?.color ?? 0], 1, t, true);
      if (p.active || p.done) {
        ctx.font = '800 13px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        const label = `${p.done ? '✅' : '⭐'} ${p.name}`;
        ctx.strokeText(label, x, y + 8);
        ctx.fillStyle = p.done ? '#1f7a38' : '#8a5a00';
        ctx.fillText(label, x, y + 8);
      }
    }
  }
}

/** An arrow at the screen's edge toward a mission place that is off screen, with how far it is. */
function drawOffscreenTargets(targets, sx, sy) {
  const s = me();
  if (!s) return;
  const placed = [];
  for (const p of targets) {
    if (!p.active || p.done) continue;
    const x = sx(p.x);
    const y = sy(p.y);
    if (x > 30 && x < W - 30 && y > 30 && y < H - 30) continue;
    const dir = Math.atan2(y - H / 2, x - W / 2);
    let a = dir;
    const m = 46;
    const at = (a) => {
      const k = Math.min((W / 2 - m) / Math.abs(Math.cos(a) || 1e-6), (H / 2 - m - 40) / Math.abs(Math.sin(a) || 1e-6));
      return [W / 2 + Math.cos(a) * k, H / 2 + Math.sin(a) * k];
    };
    let [ex, ey] = at(a);
    // Several places the same way: fan the arrows out along the edge so each can be read.
    for (let tries = 0; tries < 8 && placed.some(([px, py]) => Math.hypot(px - ex, py - ey) < 58); tries++) {
      a += (tries % 2 ? -1 : 1) * 0.14 * (tries + 1);
      [ex, ey] = at(a);
    }
    placed.push([ex, ey]);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.strokeStyle = '#b07c0a';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.rotate(dir);
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(2, 8);
    ctx.lineTo(2, -8);
    ctx.closePath();
    ctx.fillStyle = '#b07c0a';
    ctx.fill();
    ctx.restore();
    const map = mapFor(game.world);
    const metres = Math.hypot(p.x - s.x, p.y - s.y) * (map?.data.scale || 1);
    ctx.font = '800 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8a5a00';
    ctx.fillText(metres >= 1000 ? `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} ק״מ` : `${Math.round(metres / 10) * 10} מ׳`, ex, ey + 30);
  }
}

// ------------------------------------------------------------------------------------------------ minimap
let miniBase = null; // { id, canvas, x0, y0, k } the map's outline, drawn once per map and size
function sizeMinimap() {
  const map = mapFor(game.world) ?? maps.loaded.get(maps.current)?.value;
  const box = arenaBox(map);
  const maxW = Math.min(120, W * 0.3);
  const maxH = Math.min(160, H * 0.26);
  const k = Math.min(maxW / (box[2] - box[0]), maxH / (box[3] - box[1]));
  miniSize.w = Math.max(64, Math.round((box[2] - box[0]) * k));
  miniSize.h = Math.max(64, Math.round((box[3] - box[1]) * k));
  mini.style.width = `${miniSize.w}px`;
  mini.style.height = `${miniSize.h}px`;
  mini.width = Math.round(miniSize.w * DPR);
  mini.height = Math.round(miniSize.h * DPR);
  miniBase = null;
}
function arenaBox(map) {
  const rings = map?.arena.rings;
  if (!rings?.length) {
    const R = map?.R ?? game.world?.R ?? 3000;
    return [-R, -R, R, R];
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]);
      x1 = Math.max(x1, r[i]);
      y0 = Math.min(y0, r[i + 1]);
      y1 = Math.max(y1, r[i + 1]);
    }
  }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
function minimapBase(map, w) {
  const id = map?.id ?? `circle${w.R}`;
  if (miniBase?.id === id && miniBase.canvas.width === mini.width) return miniBase;
  const box = arenaBox(map ?? { R: w.R, arena: {} });
  const c = document.createElement('canvas');
  c.width = mini.width;
  c.height = mini.height;
  const g = c.getContext('2d');
  const k = Math.min(c.width / (box[2] - box[0]), c.height / (box[3] - box[1]));
  const x0 = box[0];
  const y0 = box[1];
  g.fillStyle = 'rgba(214, 230, 236, 0.92)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(255, 255, 255, 0.95)';
  g.strokeStyle = 'rgba(110, 96, 74, 0.55)';
  g.lineWidth = 1.2 * DPR;
  g.beginPath();
  if (map?.arena.rings?.length) {
    for (const r of map.arena.rings) {
      g.moveTo((r[0] - x0) * k, (r[1] - y0) * k);
      for (let i = 2; i < r.length; i += 2) g.lineTo((r[i] - x0) * k, (r[i + 1] - y0) * k);
      g.closePath();
    }
  } else g.arc((0 - x0) * k, (0 - y0) * k, w.R * k, 0, TAU);
  g.fill('evenodd');
  g.stroke();
  // The main roads, faintly, so the shape reads as the town.
  const roads = map?.data.roads?.[0] || [];
  g.strokeStyle = 'rgba(160, 140, 110, 0.35)';
  g.lineWidth = 0.8 * DPR;
  g.beginPath();
  for (const line of roads) {
    g.moveTo((line[0] - x0) * k, (line[1] - y0) * k);
    for (let i = 2; i < line.length; i += 2) g.lineTo((line[i] - x0) * k, (line[i + 1] - y0) * k);
  }
  g.stroke();
  miniBase = { id, canvas: c, x0, y0, k };
  return miniBase;
}
let miniAt = 0;
function drawMinimap(w, map) {
  const now = performance.now();
  if (now - miniAt < 90 || mini.width < 16) return;
  miniAt = now;
  const base = minimapBase(map, w);
  const { x0, y0, k } = base;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mini.width, mini.height);
  mctx.drawImage(base.canvas, 0, 0);
  const px = (x) => (x - x0) * k;
  const py = (y) => (y - y0) * k;
  // What the screen shows.
  const hw = W / 2 / cam.zoom;
  const hh = H / 2 / cam.zoom;
  mctx.strokeStyle = 'rgba(35, 32, 27, 0.55)';
  mctx.lineWidth = 1 * DPR;
  mctx.strokeRect(px(cam.x - hw), py(cam.y - hh), hw * 2 * k, hh * 2 * k);
  const my = me();
  // Storms, as grey clouds.
  for (const zone of w.zones || []) {
    const p = w.zoneAt(zone);
    mctx.fillStyle = 'rgba(52, 58, 72, 0.28)';
    mctx.beginPath();
    mctx.arc(px(p.x), py(p.y), Math.max(3 * DPR, zone.r * k), 0, TAU);
    mctx.fill();
  }
  // Everyone: online the server's radar (all the room, every two seconds) plus what is in view, else the world. In
  // the story only the chains near you show, unless you have a situation room (then all, hunters ringed in red).
  const intel = game.mode !== 'story' || game.story?.perks?.includes('intel');
  const dots = new Map();
  if (game.mode === 'online' && w.radar) for (const [id, x, y, color, score, team] of w.radar) dots.set(id, { x: x * 10, y: y * 10, color, score, team });
  for (const s of w.snakes.values()) {
    if (!s.alive) continue;
    if (!intel && my && Math.hypot(s.x - my.x, s.y - my.y) > 950) continue;
    dots.set(s.id, { x: s.x, y: s.y, color: s.color, score: scoreOf(s.mass), team: s.team, hunt: s.ai?.hunting && s.ai.target === game.meId });
  }
  for (const [id, d] of dots) {
    const isMe = id === game.meId;
    if (isMe) continue;
    const mate = my && my.team && d.team === my.team;
    const r = (mate ? 2.8 : 2.2) * DPR + Math.min(2.5, d.score / 120) * DPR;
    mctx.fillStyle = mate ? '#b07c0a' : COLORS[d.color % COLORS.length];
    mctx.beginPath();
    mctx.arc(px(d.x), py(d.y), r, 0, TAU);
    mctx.fill();
    if (d.hunt) {
      mctx.strokeStyle = '#e5484d';
      mctx.lineWidth = 1.5 * DPR;
      mctx.beginPath();
      mctx.arc(px(d.x), py(d.y), r + 2.5 * DPR, 0, TAU);
      mctx.stroke();
    }
  }
  // Mission places.
  for (const p of game.story?.run?.targets || []) {
    if (!p.active && !p.done) continue;
    mctx.font = `${Math.round(11 * DPR)}px system-ui, sans-serif`;
    mctx.textAlign = 'center';
    mctx.textBaseline = 'middle';
    mctx.fillText(p.done ? '✅' : '⭐', px(p.x), py(p.y));
  }
  if (my?.alive) {
    const x = px(my.x);
    const y = py(my.y);
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    mctx.arc(x, y, 5 * DPR, 0, TAU);
    mctx.fill();
    mctx.fillStyle = INK;
    mctx.beginPath();
    mctx.arc(x, y, 3.4 * DPR, 0, TAU);
    mctx.fill();
    mctx.strokeStyle = INK;
    mctx.lineWidth = 1.6 * DPR;
    mctx.beginPath();
    mctx.moveTo(x, y);
    mctx.lineTo(x + Math.cos(my.a) * 9 * DPR, y + Math.sin(my.a) * 9 * DPR);
    mctx.stroke();
  }
}

function handsOf(s) {
  return s ? (s.handsCount ?? s.hands.size) : 0;
}

/** Behind the start screen: the chosen map's live room when people play there, else the map itself, drifting. */
function renderIdle(t, dt) {
  const remote = game.net?.world;
  let w = remote;
  if (remote && remote.city === maps.current) {
    game.net.tick(dt, input, viewExtents());
    remote.events.length = 0;
  } else {
    const map = maps.loaded.get(maps.current)?.value ?? null;
    if (!game.preview || game.preview.city !== (map?.id ?? '')) {
      game.preview = newWorld(map, { sparkTarget: 500 });
      game.idleWorld = null;
    }
    w = game.preview;
    w.step(1 / 60);
    w.events.length = 0;
  }
  let lead = w.snakes.get(w.focus);
  if (!lead) for (const s of w.snakes.values()) if (s.alive && (!lead || s.mass > lead.mass)) lead = s;
  if (game.idleWorld !== w) {
    game.idleWorld = w;
    const p = lead ?? (w.somewhere ? w.somewhere(0.8) : { x: cam.x, y: cam.y });
    cam.x = p.x;
    cam.y = p.y;
  }
  if (lead) {
    const k = 1 - Math.exp(-dt * 2);
    cam.x += (lead.x - cam.x) * k;
    cam.y += (lead.y - cam.y) * k;
  } else {
    // Nobody here yet: a slow drift across the streets.
    cam.x += Math.cos(t * 0.05) * 18 * dt;
    cam.y += Math.sin(t * 0.037) * 14 * dt;
  }
  cam.zoom = Math.min(W, H) / 820;
  const saved = game.world;
  const savedMe = game.meId;
  const savedStory = game.story;
  game.world = w;
  game.meId = -1;
  game.story = null;
  render(t);
  game.world = saved;
  game.meId = savedMe;
  game.story = savedStory;
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
    $('rank').textContent = rank && total > 1 && game.mode !== 'story' ? `מקום ${rank} מתוך ${total}` : '';
    game.best.maxScore = Math.max(game.best.maxScore, score);
    if (rank && total > 1) game.best.rank = Math.min(game.best.rank, rank);
    game.best.hands = Math.max(game.best.hands, handsOf(s), game.handIds.size);
    // Hand button: someone close enough to hold hands with
    const cand = game.mode === 'online' ? game.net?.candidate?.() ?? null : w.handCandidate(s);
    const btn = $('hand');
    if (cand) {
      btn.hidden = false;
      btn.querySelector('span').textContent = cand.offer?.to === s.id ? `קבלו את היד של ${cand.name}` : `תנו יד ל${cand.name}`;
      btn.classList.toggle('pulse', cand.offer?.to === s.id);
      if (game.hintStage < 2) {
        game.hintStage = 2;
        hint('לחצו 🤝 – מחזיקים ידיים, עוברים זה דרך זה ואוספים פי 1.5', 4500);
      }
    } else btn.hidden = true;
    if (game.hintStage === 0 && now - game.best.born > 6000) {
      game.hintStage = 1;
      hint('⚡ ריצה: אצבע שנייה במקום כלשהו על המסך (זה עולה קצת אנשים)', 4800);
    }
  }
  const lb = $('leaderboard');
  const rows = board
    ? board.top.map(([id, name, score, color, bot]) => ({ id, label: bot ? `🤖 ${name}` : name, score, color }))
    : alive.slice(0, 5).map((o) => ({ id: o.id, label: o.name, score: scoreOf(o.mass), color: o.color }));
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
  const name = mapName(w.city);
  if (game.mode === 'story') {
    $('players').textContent = '';
  } else if (board) {
    const here = board.here ?? 1;
    $('players').textContent = `${name ? `${name} · ` : ''}${here === 1 ? 'רק אתה כאן' : `${here} משחקים כאן`}`;
    $('waiting').hidden = here > 1 || !game.alive;
    if (here > game.hereSeen && game.hereSeen >= 1 && game.alive) toast(here - game.hereSeen === 1 ? '👋 עוד מישהו הצטרף למפה!' : `👋 ${here - game.hereSeen} אנשים הצטרפו למפה!`);
    game.hereSeen = here;
  } else {
    $('players').textContent = `${name ? `${name} · ` : ''}משחקים לבד בטלפון`;
  }
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
  // Sharp by default (the screen's own pixel density); a step down only while the phone cannot keep up (pace.js).
  const step = pace(dt);
  const native = Math.min(3, window.devicePixelRatio || 1);
  if (step < 0 && dprCap > 1) {
    dprCap = Math.max(1, Math.min(dprCap, native) - 0.5);
    resize();
  } else if (step > 0 && dprCap < native) {
    dprCap = Math.min(native, dprCap + 0.5);
    resize();
  }
}

// ------------------------------------------------------------------------------------------------ the story
// "נגד כל הסיכויים" (campaign.js): the Knesset, the road across the country, a chapter's briefing, its result, the
// strategies between the books, and election night.
const camp = { state: loadCampaign(), view: 'chapter', lost: [], resetArmed: 0 };
const PARTY = () => CFG.party || 'עמך ישראל';
const OTHER_GREYS = ['#b9b1a3', '#a59d8f', '#cbc4b6', '#948c7e'];
const textVars = () => ({ party: PARTY(), seats: camp.state.seats.ours });
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function rowColor(row) {
  if (row.ours) return COLORS[OURS];
  if (row.undecided) return '#e4ded2';
  if (row.other) return OTHER_GREYS[Math.max(0, OTHERS.findIndex((p) => p.id === row.id)) % OTHER_GREYS.length];
  return COLORS[row.color % COLORS.length];
}
/** Under the threshold, our standing is a poll percentage (the seats wait with the undecided). */
function oursLabel(st) {
  const n = st.seats.ours;
  return n >= THRESHOLD ? `${n} מנדטים` : `${['1.2', '1.9', '2.6', '3.1'][n] ?? '3.1'}% · מתחת לאחוז החסימה`;
}
/** The Knesset rows as shown: ours first, the rest by size, the undecided last. */
function knessetRows(st) {
  const rows = knesset(st, PARTY());
  const ours = rows.find((r) => r.ours);
  const rest = rows.filter((r) => !r.ours && !r.undecided);
  let undecided = rows.find((r) => r.undecided)?.seats ?? 0;
  if (ours.seats < THRESHOLD) {
    undecided += ours.seats;
    ours.seats = 0;
  }
  return [ours, ...rest, ...(undecided ? [{ id: 'undecided', name: 'מתלבטים', seats: undecided, undecided: true }] : [])];
}
/** The Knesset as a half circle of 120 seats (ours from the right), our number in the middle, and a legend. */
function knessetBlock(st) {
  const box = el('div', 'knesset');
  const c = el('canvas');
  c.setAttribute('aria-hidden', 'true');
  box.append(c);
  const rows = knessetRows(st);
  const lead = rows.filter((r) => !r.undecided).reduce((a, b) => (b.seats > a.seats ? b : a));
  const legend = el('div', 'legend');
  for (const r of rows) {
    const chip = el('span', r.ours ? 'ours' : '');
    const dot = el('i');
    dot.style.background = rowColor(r);
    chip.append(dot, `${r === lead ? '👑 ' : ''}${r.name} `, el('b', '', r.ours && r.seats === 0 ? oursLabel(st).split(' · ')[0] : String(r.seats)));
    legend.append(chip);
  }
  box.append(legend);
  box.setAttribute('aria-label', `הכנסת: ${rows.map((r) => `${r.name} ${r.seats}`).join(', ')}`);
  requestAnimationFrame(() => drawKnesset(c, rows));
  return box;
}
function drawKnesset(c, rows) {
  const cssW = c.clientWidth || 300;
  const cssH = Math.round(cssW * 0.52);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.width = Math.round(cssW * dpr);
  c.height = Math.round(cssH * dpr);
  c.style.height = `${cssH}px`;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = cssW / 2;
  const cy = cssH - 4;
  const R1 = Math.min(cssW / 2 - 6, cssH - 8);
  const R0 = R1 * 0.4;
  const nRows = 6;
  const radii = Array.from({ length: nRows }, (_, i) => R0 + ((R1 - R0) * i) / (nRows - 1));
  const sum = radii.reduce((a, b) => a + b, 0);
  const counts = radii.map((r) => Math.round((120 * r) / sum));
  let diff = 120 - counts.reduce((a, b) => a + b, 0);
  for (let i = nRows - 1; diff !== 0; i = (i + nRows - 1) % nRows) {
    counts[i] += Math.sign(diff);
    diff -= Math.sign(diff);
  }
  const seats = [];
  radii.forEach((r, i) => {
    for (let j = 0; j < counts[i]; j++) {
      const a = (Math.PI * (j + 0.5)) / counts[i];
      seats.push({ x: cx + Math.cos(a) * r, y: cy - Math.sin(a) * r, a });
    }
  });
  seats.sort((p, q) => p.a - q.a);
  const dot = ((R1 - R0) / (nRows - 1)) * 0.4;
  let k = 0;
  for (const row of rows) {
    g.fillStyle = rowColor(row);
    for (let n = 0; n < row.seats && k < seats.length; n++, k++) {
      g.beginPath();
      g.arc(seats[k].x, seats[k].y, dot, 0, TAU);
      g.fill();
    }
  }
  const ours = rows[0]?.seats ?? 0;
  g.textAlign = 'center';
  g.fillStyle = COLORS[OURS];
  g.font = `900 ${Math.round(R0 * 0.7)}px system-ui, sans-serif`;
  g.fillText(String(ours), cx, cy - R0 * 0.3);
  g.fillStyle = 'rgba(35, 32, 27, 0.62)';
  g.font = `700 ${Math.max(10, Math.round(R0 * 0.2))}px system-ui, sans-serif`;
  g.fillText('מנדטים', cx, cy - 2);
}

// The road across the country: the country map's picture, a dot for every chapter, done ones in our colour.
let routeImg = null;
function chapterPoint(ch) {
  const israel = maps.byId.get('israel');
  if (!israel?.center) return null;
  const [lat0, lon0] = israel.center;
  const phi = (lat0 * Math.PI) / 180;
  const ky = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const kx = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const at = (c) => ({ x: ((c[1] - lon0) * kx) / 50, y: (-(c[0] - lat0) * ky) / 50 });
  const byName = (he) => [...maps.byId.values()].find((m) => m.he === he || m.he?.replace(/[–-]/g, '') === he.replace(/[–-]/g, ''));
  if (ch.map !== 'israel') {
    const m = maps.byId.get(ch.map);
    return m?.center ? at(m.center) : null;
  }
  const names = ch.goal.names || ['ירושלים'];
  const pts = names.map(byName).filter((m) => m?.center).map((m) => at(m.center));
  if (!pts.length) return null;
  return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
}
function routeBlock(st) {
  const box = el('div', 'route');
  const c = el('canvas');
  c.setAttribute('aria-hidden', 'true');
  const list = el('ol', 'route-list');
  let book = -1;
  CHAPTERS.forEach((ch, i) => {
    if (ch.book !== book) {
      book = ch.book;
      list.append(el('li', 'book', `${BOOK_NAMES[book]} · ${BOOKS[book].title}`));
    }
    const li = el('li', i < st.next ? 'done' : i === st.next ? 'now' : '');
    li.append(el('span', '', `${i + 1}. ${ch.title}`), el('b', '', i < st.next ? '⭐'.repeat(st.stars[i] || 1) : i === st.next ? '◀' : ''));
    list.append(li);
  });
  box.append(c, list);
  requestAnimationFrame(() => drawRoute(c, st));
  return box;
}
function drawRoute(c, st) {
  const E = 4640;
  const X0 = -1750;
  const X1 = 1550;
  const Y0 = -4450;
  const Y1 = 4450;
  const cssW = c.clientWidth || 96;
  const cssH = Math.round((cssW * (Y1 - Y0)) / (X1 - X0));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.width = Math.round(cssW * dpr);
  c.height = Math.round(cssH * dpr);
  c.style.height = `${cssH}px`;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!routeImg) {
    routeImg = new Image();
    routeImg.onload = () => !$('story').hidden && renderCampaign();
    routeImg.src = `${CFG.maps}israel.jpg`;
  }
  if (routeImg.complete && routeImg.naturalWidth) {
    const s = routeImg.naturalWidth / (2 * E);
    g.drawImage(routeImg, (X0 + E) * s, (Y0 + E) * s, (X1 - X0) * s, (Y1 - Y0) * s, 0, 0, cssW, cssH);
  } else {
    g.fillStyle = '#e9e3d6';
    g.fillRect(0, 0, cssW, cssH);
  }
  const tx = (x) => ((x - X0) / (X1 - X0)) * cssW;
  const ty = (y) => ((y - Y0) / (Y1 - Y0)) * cssH;
  const pts = CHAPTERS.map(chapterPoint);
  // The road so far: from the first chapter to the one ahead.
  g.strokeStyle = COLORS[OURS];
  g.lineWidth = 2;
  g.setLineDash([4, 3]);
  g.beginPath();
  let started = false;
  pts.slice(0, st.next + 1).forEach((p) => {
    if (!p) return;
    g[started ? 'lineTo' : 'moveTo'](tx(p.x), ty(p.y));
    started = true;
  });
  g.stroke();
  g.setLineDash([]);
  pts.forEach((p, i) => {
    if (!p) return;
    const done = i < st.next;
    const now = i === st.next;
    g.beginPath();
    g.arc(tx(p.x), ty(p.y), now ? 6 : 4.2, 0, TAU);
    g.fillStyle = done ? COLORS[OURS] : now ? '#ffffff' : 'rgba(255,255,255,0.8)';
    g.fill();
    g.lineWidth = now ? 3 : 1.4;
    g.strokeStyle = done ? '#ffffff' : now ? '#e5484d' : 'rgba(35, 32, 27, 0.5)';
    g.stroke();
  });
}
function perksLine(st) {
  if (!st.perks.length) return null;
  const p = el('p', 'perks-line');
  p.append(el('b', '', 'האסטרטגיות שלכם: '), st.perks.map((id) => PERKS.find((x) => x.id === id)).filter(Boolean).map((x) => `${x.icon} ${x.name}`).join(' · '));
  return p;
}
function gainsText(gains) {
  const n = gains.reduce((a, g) => a + g.n, 0);
  const from = gains.map((g) => `${g.n} ${g.from === 'undecided' ? 'מהמתלבטים' : `מ${partyOf(g.from)?.name ?? g.from}`}`).join(', ');
  return n ? `+${n} ${n === 1 ? 'מנדט' : 'מנדטים'}: ${from}` : '';
}

function renderCampaign() {
  const st = camp.state;
  const body = $('camp-body');
  body.replaceChildren();
  const go = $('story-go');
  go.hidden = false;
  const view = camp.view === 'result' && st.last ? 'result' : st.pending || 'chapter';
  const vars = textVars();
  const kicker = $('camp-kicker');
  const title = $('story-title');
  if (view === 'book') {
    const b = CHAPTERS[st.next]?.book ?? 0;
    const lost = openBook(st, b);
    if (lost.length) camp.lost = lost;
    saveCampaign(st);
    kicker.textContent = 'נגד כל הסיכויים';
    title.textContent = `${BOOK_NAMES[b]}: ${BOOKS[b].title}`;
    body.append(el('p', 'story-text', fill(BOOKS[b].text, vars)));
    if (b === 2 && camp.lost.length) body.append(el('p', 'loss', `−${camp.lost.reduce((a, x) => a + x.n, 0)} מנדטים: ${camp.lost.map((x) => `${x.n} ל${partyOf(x.to)?.name}`).join(', ')}`));
    if (b === 0) body.append(el('p', 'note', `הסיפור והדמויות בדיוניים. ${POLL_NOTE}`));
    body.append(knessetBlock(st));
    go.textContent = 'המשך';
  } else if (view === 'result') {
    const { index, stars, gains } = st.last;
    const ch = CHAPTERS[index];
    kicker.textContent = `פרק ${index + 1} מתוך ${CHAPTERS.length} הושלם`;
    title.textContent = `✅ ${ch.title}`;
    body.append(el('p', 'stars-big', '⭐'.repeat(stars) + '☆'.repeat(3 - stars)));
    const gt = gainsText(gains);
    if (gt) body.append(el('p', 'gain', gt));
    if (st.seats.ours >= THRESHOLD && st.seats.ours - gains.reduce((a, g) => a + g.n, 0) < THRESHOLD) body.append(el('p', 'gain big', '🎉 עברתם את אחוז החסימה!'));
    body.append(el('p', 'story-text', fill(ch.outro, vars)));
    body.append(knessetBlock(st));
    go.textContent = 'המשך';
  } else if (view === 'perks') {
    const round = CHAPTERS[st.next - 1]?.book ?? 0;
    kicker.textContent = `סוף ${BOOK_NAMES[round]}`;
    title.textContent = 'בחרו אסטרטגיה';
    body.append(el('p', 'note', 'היכולת שתבחרו תלווה אתכם עד סוף הדרך.'));
    const grid = el('div', 'perks');
    for (const id of PERK_ROUNDS[round] || []) {
      const p = PERKS.find((x) => x.id === id);
      const b = el('button', 'perk');
      b.type = 'button';
      b.append(el('span', 'icon', p.icon), el('b', '', p.name), el('small', '', p.text));
      b.addEventListener('click', () => {
        choosePerk(st, id);
        saveCampaign(st);
        camp.view = 'chapter';
        renderCampaign();
      });
      grid.append(b);
    }
    body.append(grid);
    go.hidden = true;
  } else if (view === 'end') {
    kicker.textContent = 'ליל הבחירות';
    title.textContent = 'המפלגה הגדולה ביותר';
    for (const para of fill(EPILOGUE, vars).split('\n')) body.append(el('p', 'story-text', para));
    body.append(el('p', 'story-text strong', 'לבד אתה חזק – ביחד אנחנו שרשרת.'));
    body.append(knessetBlock(st));
    const total = st.stars.reduce((a, b) => a + (b || 0), 0);
    body.append(el('p', 'note', `⭐ ${total} כוכבים מתוך ${CHAPTERS.length * 3} · הסיפור והדמויות בדיוניים.`));
    go.textContent = 'שתפו את הניצחון';
  } else {
    const ch = CHAPTERS[st.next];
    const place = maps.byId.get(ch.map)?.he ?? '';
    kicker.textContent = `${BOOK_NAMES[ch.book]}: ${BOOKS[ch.book].title} · פרק ${st.next + 1} מתוך ${CHAPTERS.length}`;
    title.textContent = ch.title;
    const card = el('div', 'mission-card');
    card.append(el('small', '', place ? `📍 ${place}` : ''), el('p', 'story-text', fill(ch.intro, vars)));
    const goal = el('p', 'goal');
    goal.append(el('b', '', `🎯 ${goalText(ch)}`), ch.time ? ` · ⏱️ ${mmss(ch.time)}` : '');
    card.append(goal);
    const stars = el('ul', 'stars');
    for (const text of starTexts(ch)) stars.append(el('li', '', text));
    card.append(stars);
    const chips = el('div', 'chips');
    for (const [id] of ch.rivals) {
      const p = partyOf(id);
      if (!p) continue;
      const chip = el('span', 'chip');
      const dot = el('i');
      dot.style.background = COLORS[p.color % COLORS.length];
      chip.append(dot, p.name);
      chips.append(chip);
    }
    const o = ch.obstacles || {};
    if (o.bars) chips.append(el('span', 'chip', '🚧 עבודות בכביש'));
    if (o.buses) chips.append(el('span', 'chip', '🚌 אוטובוסים'));
    if (o.trains) chips.append(el('span', 'chip', '🚆 רכבות'));
    if (o.storms) chips.append(el('span', 'chip', '⛈️ סערות'));
    card.append(chips);
    body.append(card);
    const line = perksLine(st);
    if (line) body.append(line);
    body.append(knessetBlock(st));
    body.append(routeBlock(st));
    go.textContent = st.next === 0 ? 'יוצאים לדרך' : 'למשימה';
  }
  const started = st.next > 0 || st.perks.length > 0;
  $('story-reset').hidden = !started;
  $('story-reset').textContent = 'מההתחלה';
  camp.resetArmed = 0;
  body.scrollTop = 0;
}
function openCampaign() {
  camp.state = loadCampaign();
  camp.view = 'chapter';
  renderCampaign();
  show('story');
}
function campaignGo() {
  const st = camp.state;
  const view = camp.view === 'result' && st.last ? 'result' : st.pending || 'chapter';
  if (view === 'book') {
    st.pending = null;
    camp.lost = [];
    saveCampaign(st);
    renderCampaign();
  } else if (view === 'result') {
    camp.view = 'chapter';
    renderCampaign();
  } else if (view === 'end') shareVictory();
  else if (view === 'chapter') startStory();
}
function resetCampaign() {
  const now = performance.now();
  if (now - camp.resetArmed > 3000) {
    camp.resetArmed = now;
    $('story-reset').textContent = 'בטוחים? לחצו שוב';
    return;
  }
  camp.state = newCampaign();
  saveCampaign(camp.state);
  camp.view = 'chapter';
  renderCampaign();
}
async function startStory() {
  const st = camp.state;
  if (st.pending === 'end' || st.next >= CHAPTERS.length) {
    shareVictory();
    return;
  }
  audio.unlock();
  commitName();
  game.net?.idle();
  const index = st.next;
  const ch = CHAPTERS[index];
  const id = maps.byId.has(ch.map) ? ch.map : maps.current;
  $('story-go').disabled = true;
  const map = await Promise.race([cityMap(id), new Promise((r) => setTimeout(() => r(null), 8000))]);
  $('story-go').disabled = false;
  const w = newWorld(map);
  for (let i = 0; i < 60; i++) {
    w.step(1 / 30);
    w.events.length = 0;
  }
  const pm = perkMods(st.perks);
  const at = map ? startPoint(ch, map) : null;
  const s = w.addSnake({
    name: game.name,
    skin: game.skin,
    color: OURS,
    mass: C.startMass + (ch.mass || 0) + pm.extra,
    mods: pm.mods,
    shield: pm.shield,
    at: at ? { x: at.x + 30, y: at.y + 30 } : null,
  });
  game.world = w;
  game.meId = s.id;
  game.mode = 'story';
  game.story = { index, chapter: ch, map, perks: st.perks.slice(), run: startChapter(ch, map, w, { playerId: s.id, perks: st.perks }) };
  $('mission-title').textContent = `פרק ${index + 1} · ${ch.title}`;
  $('mission-meta').textContent = '';
  beginRound(s);
  toast(`🎯 ${goalText(ch)}`, 4600);
}
function updateStory(dt) {
  const st = game.story;
  if (!st?.run || !game.alive) return;
  const res = st.run.update(dt);
  for (const text of res.warn) toast(text, 2600);
  $('mission-text').textContent = res.text;
  $('mission-bar').style.width = `${Math.round(res.progress * 100)}%`;
  const timed = st.chapter.time || st.chapter.goal.type === 'survive';
  $('mission-meta').textContent = `${timed ? `⏱️ ${mmss(res.left)}  ` : ''}${'⭐'.repeat(res.stars)}${'☆'.repeat(3 - res.stars)}`;
  if (res.failed) {
    game.alive = false;
    game.deathInfo = { why: res.why };
    navigator.vibrate?.(120);
    audio.sfx('break');
    audio.setScene('over');
    setTimeout(showOver, 700);
    return;
  }
  if (res.done) {
    winChapter(camp.state, st.index, res.stars);
    saveCampaign(camp.state);
    camp.view = 'result';
    game.alive = false;
    game.running = false;
    game.story = null;
    audio.sfx('link');
    navigator.vibrate?.([60, 40, 60, 40, 120]);
    hide('hud');
    renderCampaign();
    show('story');
    audio.setScene('menu');
  }
}
function shareVictory() {
  const n = camp.state.seats.ours;
  shareText(`הובלתי את ${PARTY()} מ־1.2% ל־${n} מנדטים – המפלגה הגדולה ביותר 🗳️ ביחד אנחנו שרשרת. נראה אתכם:`, cardCanvas({ mandates: n }));
}

// ------------------------------------------------------------------------------------------------ lobby: maps
function lobbyCount(id) {
  return maps.lobby[id] | 0;
}
function renderMapRow() {
  const id = maps.current;
  const info = maps.byId.get(id);
  $('map-name').textContent = info ? `📍 ${info.he}` : '📍 …';
  const n = lobbyCount(id);
  const live = $('map-live');
  live.classList.toggle('live', n > 0);
  live.textContent =
    n > 0
      ? `🟢 ${n === 1 ? 'אדם אחד משחק' : `${n} משחקים`} עכשיו`
      : info?.kind === 'region'
        ? `${info.subtitle || 'מפה גדולה'} · עד ${info.capacity || 50} איש`
        : info
          ? `עד ${info.capacity || 20} איש בחדר · תהיו הראשונים`
          : 'בוחרים מפה';
}
function renderMapList() {
  const q = $('map-search').value.trim();
  const list = $('map-list');
  const match = (m) => !q || m.he.includes(q) || m.id.includes(q.toLowerCase());
  const item = (m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `item${m.id === maps.current ? ' on' : ''}`;
    const text = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = m.he;
    const sub = document.createElement('small');
    sub.textContent = m.kind === 'region' ? `${m.subtitle || ''} · עד ${m.capacity || 50}` : `עד ${m.capacity || 20} איש בחדר`;
    text.append(name, sub);
    b.append(text);
    const n = lobbyCount(m.id);
    if (n) {
      const em = document.createElement('em');
      em.textContent = `🟢 ${n}`;
      b.append(em);
    }
    b.addEventListener('click', () => {
      chooseMap(m.id);
      hide('maps');
      if (game.walkNext && m.kind !== 'region') {
        game.walkNext = false;
        startWalk();
      }
    });
    return b;
  };
  const head = (text) => {
    const h = document.createElement('h3');
    h.textContent = text;
    return h;
  };
  const regions = maps.list.filter((m) => m.kind === 'region' && match(m));
  const cities = maps.list.filter((m) => m.kind !== 'region' && match(m));
  const busy = cities.filter((m) => lobbyCount(m.id)).sort((a, b) => lobbyCount(b.id) - lobbyCount(a.id));
  const rest = cities.filter((m) => !lobbyCount(m.id));
  const out = [];
  if (regions.length) out.push(head('מפות גדולות'), ...regions.map(item));
  if (busy.length) out.push(head('משחקים עכשיו'), ...busy.map(item));
  if (rest.length) out.push(head(busy.length ? 'עוד ערים' : 'ערים'), ...rest.map(item));
  if (!out.length) out.push(head('לא נמצאה עיר בשם הזה'));
  list.replaceChildren(...out);
}
$('map-btn').addEventListener('click', () => {
  game.walkNext = false;
  $('map-search').value = '';
  renderMapList();
  show('maps');
  game.net?.askLobby();
});
$('map-search').addEventListener('input', renderMapList);

// ------------------------------------------------------------------------------------------------ skins and name
// ------------------------------------------------------------------------------------------------ the streets in 3D
const walk = createWalk(
  $('walk-gl'),
  {
    root: $('walk'),
    street: $('walk-street'),
    count: $('walk-count'),
    mini: $('walk-mini'),
    run: $('walk-run'),
    stick: $('walk-stick'),
    pad: $('walk-pad'),
    loading: $('walk-loading'),
    exit: $('walk-exit'),
  },
  {
    toast,
    hint,
    sfx: (k) => audio.sfx(k),
    onExit: () => {
      show('start');
      audio.setScene('menu');
      renderMapRow();
      game.net?.watch(viewExtents(), maps.current);
    },
  },
);
/** Into the chosen city's streets in 3D (a big map: first pick a city). */
async function startWalk() {
  audio.unlock();
  const info = maps.byId.get(maps.current);
  if (!info || info.kind === 'region' || !info.detail) {
    game.walkNext = true;
    renderMapList();
    show('maps');
    toast('🚶 בחרו עיר להסתובב ברחובות שלה', 3200);
    return;
  }
  const id = maps.current;
  $('walk-btn').disabled = true;
  try {
    const map = await cityMap(id);
    const [ok, extra] = await Promise.all([
      map ? map.loadDetail() : false,
      fetch(`${CFG.maps}${encodeURIComponent(id)}-3d.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    if (!map || !ok) {
      toast('את הרחובות של העיר הזאת עוד אי אפשר לטעון. נסו עוד רגע', 3200);
      return;
    }
    game.net?.idle();
    hide('start');
    if (!(await walk.enter(map, extra))) {
      show('start');
      toast('הדפדפן הזה לא מציג תלת־ממד (WebGL 2)', 4000);
      return;
    }
    audio.setScene('play');
    hint('👆 גוררים כדי להסתכל · נוגעים ברחוב כדי ללכת לשם', 5500);
  } catch (err) {
    console.error(err);
    show('start');
    toast('משהו השתבש בבניית העיר. נסו שוב', 3500);
  } finally {
    $('walk-btn').disabled = false;
  }
}
$('walk-btn').addEventListener('click', () => startWalk());
globalThis.__walk = walk; // for the browser tests
globalThis.__game = { game, input, cam, me }; // for the browser tests and the demo video

function drawSkinInto(c, id) {
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const face = avatar(id);
  if (face) g.drawImage(face, 0, 0, c.width, c.height);
  else {
    g.fillStyle = '#e9e3d6';
    g.beginPath();
    g.arc(c.width / 2, c.height / 2, c.width * 0.42, 0, TAU);
    g.fill();
    setTimeout(() => avatar(id) && drawSkinInto(c, id), 400); // a picture still loading
  }
}
function renderSkinButton() {
  drawSkinInto($('skin-face'), game.skin);
}
const SKIN_GROUPS = { list: () => `הרשימה של ${CFG.party || 'עמך ישראל'}`, pictures: () => 'תמונות', faces: () => 'דמויות' };
function renderSkinList() {
  const q = $('skin-search').value.trim();
  const list = allSkins().filter((s) => !q || s.name.includes(q));
  const items = [];
  let group = '';
  for (const s of list) {
    if (s.group !== group) {
      group = s.group;
      const h = document.createElement('h3');
      h.className = 'skin-group';
      h.textContent = SKIN_GROUPS[group]?.() ?? '';
      items.push(h);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `skin${s.id === game.skin ? ' on' : ''}`;
    const c = document.createElement('canvas');
    c.width = c.height = 168; // 56 CSS pixels, three times over
    drawSkinInto(c, s.id);
    const label = document.createElement('span');
    label.textContent = s.n ? `${s.n}. ${s.name}` : s.name;
    b.append(c, label);
    b.addEventListener('click', () => {
      game.skin = s.id;
      setPref('skin', s.id);
      renderSkinButton();
      hide('skins');
    });
    items.push(b);
  }
  $('skin-list').replaceChildren(...items);
}
$('skin-btn').addEventListener('click', () => {
  $('skin-search').value = '';
  renderSkinList();
  show('skins');
});
$('skin-search').addEventListener('input', renderSkinList);

function renderName() {
  $('name').value = game.name;
  $('name').classList.remove('bad');
  $('name-note').textContent = '';
}
/** The name typed so far: kept if it passes the filter, else the last good one stays (and the box says so). */
function commitName() {
  const typed = $('name').value;
  const clean = cleanName(typed);
  if (clean) {
    game.name = clean;
    setPref('name', clean);
  }
  renderName();
  if (typed.trim() && !clean) toast('השם הזה לא עובר בסינון, נשארים עם הקודם');
}
$('name').addEventListener('input', () => {
  const typed = $('name').value;
  const ok = !typed.trim() || !!cleanName(typed);
  $('name').classList.toggle('bad', !ok);
  $('name-note').textContent = ok ? '' : 'בלי קישורים, סמלים או מילים פוגעניות; 2–16 אותיות';
});
$('name').addEventListener('change', commitName);
$('reroll').addEventListener('click', () => {
  game.name = randomName();
  setPref('name', game.name);
  renderName();
});

// ------------------------------------------------------------------------------------------------ music
function renderTracks() {
  const current = audio.track;
  const items = [
    ...TRACKS.map((t) => ({ id: t.id, title: t.title, mood: t.mood })),
    ...(Array.isArray(CFG.music) ? CFG.music : [])
      .filter((m) => m && typeof m.url === 'string' && /^[a-z0-9-]+\.(mp3|m4a|ogg)$/.test(m.url))
      .map((m) => ({ id: `lic:${m.url}`, title: String(m.title || m.url), mood: String(m.credit || 'ברישיון'), url: m.url })),
  ];
  $('track-list').replaceChildren(
    ...items.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      const on = t.id === current || (current === 'file' && t.id === game.fileTrack);
      b.className = `item${on ? ' on' : ''}`;
      const text = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = `${on ? '▶ ' : ''}${t.title}`;
      const sub = document.createElement('small');
      sub.textContent = t.mood;
      text.append(name, sub);
      b.append(text);
      b.addEventListener('click', async () => {
        audio.unlock();
        if (audio.muted) {
          audio.setMuted(false);
          setPref('muted', '0');
          renderSound();
        }
        if (t.url) {
          try {
            const res = await fetch(`music/${t.url}`);
            await audio.playFile(await res.arrayBuffer(), t.title);
            game.fileTrack = t.id;
          } catch {
            toast('השיר לא נטען');
          }
        } else {
          audio.setTrack(t.id, true);
          setPref('track', t.id);
          game.fileTrack = '';
        }
        renderTracks();
      });
      return b;
    }),
  );
  if (current === 'file' && !game.fileTrack) {
    const own = document.createElement('div');
    own.className = 'item on';
    own.textContent = `▶ ${audio.fileTitle || 'שיר מהטלפון'}`;
    $('track-list').append(own);
  }
}
$('music-btn').addEventListener('click', () => {
  renderTracks();
  show('music');
});

// Your own music from Spotify or YouTube Music plays in its own app. (A page cannot play them itself: Spotify lets
// outside apps in for five test users only, and YouTube does not allow playing just the sound of its videos.) So
// the buttons open the app at a search, and the game goes quiet, letting go of the sound so the song plays under it.
function ownMusicLinks() {
  const q = $('own-q').value.trim();
  $('own-spotify').href = q ? `https://open.spotify.com/search/${encodeURIComponent(q)}` : 'https://open.spotify.com/';
  $('own-youtube').href = q ? `https://music.youtube.com/search?q=${encodeURIComponent(q)}` : 'https://music.youtube.com/';
}
$('own-q').addEventListener('input', () => {
  ownMusicLinks();
  renderPicks();
});
// Quick searches (config musicPicks): a tap puts the search in the box; then Spotify or YouTube Music.
function renderPicks() {
  const q = $('own-q').value.trim();
  const picks = (Array.isArray(CFG.musicPicks) ? CFG.musicPicks : []).filter((p) => typeof p === 'string' && p.trim()).slice(0, 12);
  $('own-picks').replaceChildren(
    ...picks.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p;
      b.className = p === q ? 'on' : '';
      b.addEventListener('click', () => {
        $('own-q').value = p;
        ownMusicLinks();
        renderPicks();
      });
      return b;
    }),
  );
}
renderPicks();
// The game's own playlists, when set (config playlist, or CHAIN_PLAYLIST_SPOTIFY / CHAIN_PLAYLIST_YOUTUBE).
{
  const pl = CFG.playlist || {};
  const ok = (u, host) => typeof u === 'string' && new RegExp(`^https://${host}/`).test(u);
  const sp = ok(pl.spotify, 'open\\.spotify\\.com');
  const yt = ok(pl.youtube, '(music\\.)?youtube\\.com');
  if (sp) $('pl-spotify').href = pl.spotify;
  if (yt) $('pl-youtube').href = pl.youtube;
  $('pl-spotify').hidden = !sp;
  $('pl-youtube').hidden = !yt;
  $('own-playlist').hidden = !sp && !yt;
}
$('own-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});
for (const id of ['own-spotify', 'own-youtube', 'pl-spotify', 'pl-youtube']) {
  $(id).addEventListener('click', () => {
    if (id.startsWith('own')) ownMusicLinks();
    if (!audio.muted) {
      audio.setMuted(true);
      setPref('muted', '1');
      renderSound();
    }
    game.ownMusic = true;
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !game.ownMusic) return;
  game.ownMusic = false;
  toast('🎧 השיר שלכם מתנגן והמשחק בשקט. להחזיר את המוסיקה של המשחק: לוחצים על 🔇', 4200);
});
$('music-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    await audio.playFile(await file.arrayBuffer(), file.name.replace(/\.[a-z0-9]+$/i, ''));
    game.fileTrack = '';
    if (audio.muted) {
      audio.setMuted(false);
      setPref('muted', '0');
      renderSound();
    }
    renderTracks();
    toast('🎧 השיר שלך מתנגן (רק אצלך)');
  } catch {
    toast('את הקובץ הזה אי אפשר לנגן');
  }
});

// ------------------------------------------------------------------------------------------------ satellite, Green Line
function renderToggles() {
  $('sat-btn').setAttribute('aria-pressed', String(game.sat));
  $('green-btn').setAttribute('aria-pressed', String(game.green));
}
function applyMapOptions() {
  for (const p of maps.loaded.values()) p.value?.setOptions({ sat: game.sat, green: game.green, xyz: xyzProvider() });
  updateCredit();
}
$('sat-btn').addEventListener('click', () => {
  game.sat = !game.sat;
  setPref('sat', game.sat ? '1' : '0');
  const map = mapFor(game.world) ?? maps.loaded.get(maps.current)?.value;
  const credit = map?.data.satellite?.credit || '';
  if (game.sat && map && !map.hasSatellite) toast('למפה הזו עוד אין תמונת לוויין');
  else if (game.sat) {
    toast(
      xyzProvider()
        ? '🛰️ תצוגת לוויין'
        : /NASA/.test(credit)
          ? '🛰️ תצוגת לוויין (NASA Blue Marble)'
          : '🛰️ תצוגת לוויין (Sentinel-2: פיקסל של 10 מטר, אז מקרוב זה מטושטש)',
      3200,
    );
  }
  renderToggles();
  applyMapOptions();
});
$('green-btn').addEventListener('click', () => {
  game.green = !game.green;
  setPref('green', game.green ? '1' : '0');
  toast(game.green ? 'הקו הירוק מוצג' : 'הקו הירוק מוסתר');
  renderToggles();
  applyMapOptions();
});

// ------------------------------------------------------------------------------------------------ share
function shareUrl(map = maps.current) {
  let u = CFG.shareUrl;
  if (!u) {
    try {
      const l = new URL(location.href);
      u = l.origin + l.pathname;
    } catch {
      return '';
    }
  }
  return map ? `${u}${u.includes('?') ? '&' : '?'}map=${encodeURIComponent(map)}` : u;
}
function cardCanvas({ mandates = 0 } = {}) {
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
  drawWordmark(g, 540, 210, 124, { maxWidth: 980, ink: INK });
  g.direction = 'rtl';
  if (CFG.brand) {
    g.font = '800 46px system-ui, sans-serif';
    g.fillStyle = '#0038b8';
    g.fillText(CFG.brand, 540, 285);
  }
  g.font = '600 48px system-ui, sans-serif';
  g.fillStyle = INK;
  g.fillText(mandates ? `הובלתי את ${CFG.party || 'המפלגה'} ל־` : 'הבאתי לשרשרת', 540, 430);
  g.font = '900 190px system-ui, sans-serif';
  g.fillStyle = color;
  g.fillText((mandates || game.best.maxScore).toLocaleString('he-IL'), 540, 610);
  g.font = '700 54px system-ui, sans-serif';
  g.fillStyle = INK;
  const where = mapName(game.world?.city || maps.current);
  g.fillText(mandates ? 'מנדטים – המפלגה הגדולה ביותר 🗳️' : where ? `אנשים ב${where}` : 'אנשים', 540, 680);
  // The chain itself: people holding hands across the card, the leader with a flag and a face.
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
  const face = avatar(game.skin);
  if (face) g.drawImage(face, pts[0][0] - hp * 0.27, pts[0][1] - (FIG.feet - 24) * k - hp * 0.27, hp * 0.54, hp * 0.54);
  g.font = '600 46px system-ui, sans-serif';
  g.fillStyle = INK;
  g.fillText(mandates ? 'והקמתי ממשלה' : game.best.hands > 0 ? `והחזקתי ידיים עם ${game.best.hands} 🤝` : 'נראה אתכם עוברים אותי', 540, 1080);
  g.font = '700 40px system-ui, sans-serif';
  g.fillStyle = '#0038b8';
  g.fillText('לבד אתה חזק – ביחד אנחנו שרשרת', 540, 1170);
  const url = shareUrl('').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (url) {
    g.direction = 'ltr';
    g.font = '700 38px system-ui, sans-serif';
    g.fillStyle = 'rgba(35,32,27,0.7)';
    g.fillText(url, 540, 1260);
  }
  return c;
}
if (statsEl) {
  // For checking things while tuning on a phone (and for automated checks): the share card, and the game state.
  globalThis.__chainCard = () => cardCanvas().toDataURL('image/png');
  globalThis.__chain = { game, me, maps };
}
async function shareText(text, card) {
  const url = shareUrl();
  try {
    const blob = card ? await new Promise((res) => card.toBlob(res, 'image/png')) : null;
    const file = blob ? new File([blob], `${SLUG}.png`, { type: 'image/png' }) : null;
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
function share() {
  const where = mapName(game.world?.city || maps.current);
  shareText(
    `הבאתי ${game.best.maxScore.toLocaleString('he-IL')} אנשים לשרשרת ב-${NAME}${where ? ` ב${where}` : ''}${
      game.best.hands ? ` והחזקתי ידיים עם ${game.best.hands}` : ''
    } 🔗 ביחד אנחנו שרשרת – נראה אתכם:`,
    cardCanvas(),
  );
}
$('waiting-share').addEventListener('click', () => {
  const where = mapName(maps.current);
  shareText(`בואו לשחק איתי ב-${NAME}${where ? ` ב${where}` : ''} – אוספים אנשים ברחובות ונותנים יד 🔗`, null);
});

// ------------------------------------------------------------------------------------------------ boot
/** The small human chain above the logo: five people of different colours holding hands. */
function drawMark() {
  const c = $('mark');
  const dpr = Math.min(3, window.devicePixelRatio || 1);
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
$('play').addEventListener('click', play);
$('again').addEventListener('click', () => (game.mode === 'story' ? (hide('over'), startStory()) : play()));
$('to-menu').addEventListener('click', toMenu);
$('share').addEventListener('click', share);
$('share-close').addEventListener('click', () => hide('share-fallback'));
$('story-btn').addEventListener('click', openCampaign);
$('story-go').addEventListener('click', campaignGo);
$('story-reset').addEventListener('click', resetCampaign);
for (const b of document.querySelectorAll('.sheet .close')) {
  b.addEventListener('click', () => {
    const sheet = b.closest('.sheet');
    sheet.hidden = true;
    if (sheet.id === 'story' && !game.running) toMenu();
  });
}
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
renderSound();
renderToggles();
renderSkinButton();
resize();
drawMark();
requestAnimationFrame((t) => {
  last = t;
  requestAnimationFrame(frame);
});
loadSuppliedSkins(CFG.skins).then(() => renderSkinButton());

// The maps: the big ones and the towns. A ?map= link (an invitation) picks its map.
const linked = new URLSearchParams(location.search).get('map') || '';
loadMapIndex(CFG.maps)
  .then(({ regions, cities }) => {
    maps.list = [...regions.map((m) => ({ ...m, kind: 'region' })), ...cities.map((m) => ({ ...m, kind: m.kind || 'city' }))];
    for (const m of maps.list) maps.byId.set(m.id, m);
    const saved = pref('map');
    const start = [linked, saved, game.net?.home, 'israel', maps.list[0]?.id].find((id) => id && maps.byId.has(id));
    chooseMap(start, { save: !!linked });
  })
  .catch(() => {
    /* no maps: plain ground */
  });

// Online play when a server is configured (or when this page is served by the game server itself). With several
// servers, each map lives on one of them (the same for everyone).
const sameOriginUrl = location.protocol.startsWith('http') && CFG.sameOrigin ? `${location.origin.replace(/^http/, 'ws')}/ws` : '';
const SERVERS = (Array.isArray(CFG.servers) && CFG.servers.length ? CFG.servers : [CFG.server || sameOriginUrl]).filter((u) =>
  /^wss?:\/\//.test(u),
);
function serverFor(map) {
  if (SERVERS.length <= 1) return SERVERS[0] || '';
  let h = 0;
  for (const ch of map || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SERVERS[h % SERVERS.length];
}
function netStatusText(status, online) {
  if (status === 'online') {
    return online > 1 ? `🟢 ${online.toLocaleString('he-IL')} מחוברים עכשיו` : '🟢 מחובר';
  }
  if (status === 'connecting') return 'מעיר את השרת… אפשר כבר לשחק לבד';
  if (status === 'full') return 'השרת מלא כרגע – משחקים לבד בינתיים';
  return 'השרת לא זמין כרגע – משחקים לבד בינתיים';
}
function ensureNet() {
  const url = serverFor(maps.current);
  if (!url || game.netUrl === url) return;
  game.net?.close();
  game.netUrl = url;
  game.net = connectOnline(url, {
    onStatus(status, info) {
      for (const id of ['net-status', 'over-net']) {
        $(id).textContent = netStatusText(status, info.online);
        $(id).dataset.state = status;
      }
    },
    onHello(m) {
      if (!pref('map') && !linked && m.home && maps.byId.has(m.home) && m.home !== maps.current) chooseMap(m.home, { save: false });
    },
    onLobby(lobby, online) {
      if (SERVERS.length <= 1) maps.lobby = lobby;
      maps.online = online;
      renderMapRow();
      if (!$('maps').hidden) renderMapList();
    },
    onWorld(world) {
      if (world.city) cityMap(world.city);
    },
    onBusy() {
      clearTimeout(game.joinTimer);
      if (!game.joining) return;
      game.joining = false;
      setButtonsBusy(false);
      startSolo('השרת עמוס כרגע – משחקים לבד בינתיים');
    },
    onJoined,
    onLost,
  });
  game.net.watch(viewExtents(), maps.current);
}
if (SERVERS.length) ensureNet();
else {
  $('net-status').textContent = 'משחק מקומי';
  $('net-status').dataset.state = 'solo';
}
// Where people play, for the lobby: every few seconds while the menu is up (from each server when there are several).
setInterval(() => {
  if (!$('start').hidden || !$('maps').hidden) {
    if (SERVERS.length > 1) {
      Promise.all(
        SERVERS.map((u) =>
          fetch(u.replace(/^ws/, 'http').replace(/\/ws$/, '/lobby'), { cache: 'no-store' })
            .then((r) => r.json())
            .catch(() => null),
        ),
      ).then((all) => {
        const merged = {};
        for (const r of all) for (const [id, n] of Object.entries(r?.maps || {})) merged[id] = (merged[id] || 0) + (n | 0);
        maps.lobby = merged;
        renderMapRow();
        if (!$('maps').hidden) renderMapList();
      });
    } else game.net?.askLobby();
  }
}, 5000);

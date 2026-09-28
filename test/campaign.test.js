// The story "נגד כל הסיכויים": the seats always add up to 120 and end with us the biggest party; every chapter has a
// map, places and a start that exist; obstacles and shields work in the simulation; the director sends rivals
// after the player; and each kind of goal finishes (or fails) when it should.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, C, scoreOf } from '../src/sim.js';
import { arenaOf } from '../src/arena.js';
import { pickPlaces } from '../src/story.js';
import {
  CHAPTERS, BOOKS, RIVALS, OTHERS, PERKS, PERK_ROUNDS, THRESHOLD, newCampaign, winChapter, openBook, choosePerk, knesset,
  biggestRival, startChapter, startPoint, makeObstacles, perkMods, starTexts, goalText, fill,
} from '../src/campaign.js';

const MAPS = new URL('../docs/maps/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', MAPS), 'utf8'));
const loaded = new Map();
function realMap(id) {
  if (!loaded.has(id)) {
    const data = JSON.parse(readFileSync(new URL(`${id}.json`, MAPS), 'utf8'));
    loaded.set(id, { id, data, R: data.R, arena: arenaOf(data) });
  }
  return loaded.get(id);
}
const seeded = (seed = 7) => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};
const total = (st) => Object.values(st.seats).reduce((a, b) => a + b, 0);

function playThrough(stars) {
  const st = newCampaign();
  const perkRounds = [];
  while (st.next < CHAPTERS.length) {
    if (st.pending === 'book') {
      openBook(st, CHAPTERS[st.next].book);
      st.pending = null;
    }
    winChapter(st, st.next, stars);
    assert.equal(total(st), 120, `the Knesset has 120 seats after chapter ${st.next}`);
    for (const p of RIVALS) if (p.seats >= THRESHOLD) assert.ok(st.seats[p.id] >= THRESHOLD, `${p.name} never pushed out of the Knesset`);
    if (st.pending === 'perks') {
      perkRounds.push(st.next);
      choosePerk(st, PERK_ROUNDS[perkRounds.length - 1][0]);
    }
  }
  return { st, perkRounds };
}

test('the story adds up: 120 seats all the way, and at the end we are the biggest party', () => {
  for (const stars of [1, 3]) {
    const { st, perkRounds } = playThrough(stars);
    assert.equal(st.pending, 'end');
    const big = biggestRival(st);
    assert.ok(st.seats.ours > big.seats, `${st.seats.ours} seats against ${big.name}'s ${big.seats}`);
    assert.equal(perkRounds.length, PERK_ROUNDS.length, 'a strategy after each of the first books');
    assert.equal(st.perks.length, PERK_ROUNDS.length);
    const bonus = CHAPTERS.filter((c) => c.seats[0][0] !== 'undecided').length;
    assert.equal(st.seats.ours, stars === 3 ? 31 + bonus : 31, 'three stars: a seat more in every chapter after the first book');
    const third = newCampaign();
    for (let i = 0; i < 3; i++) winChapter(third, i, stars);
    assert.equal(third.seats.ours, THRESHOLD, 'the threshold is crossed in the third chapter, stars or not');
  }
  const fresh = newCampaign();
  assert.equal(total(fresh), 120);
  assert.equal(fresh.seats.ours, 0);
  const rows = knesset(fresh, 'עמך ישראל');
  assert.equal(rows.reduce((a, r) => a + r.seats, 0), 120);
  assert.equal(rows[rows.length - 1].id, 'undecided');
});

test('the winter costs three seats, once', () => {
  const st = newCampaign();
  st.seats.ours = 10;
  st.seats.undecided -= 10;
  const lost = openBook(st, 2);
  assert.equal(lost.reduce((a, x) => a + x.n, 0), 3);
  assert.equal(st.seats.ours, 7);
  assert.deepEqual(openBook(st, 2), [], 'a book opens once');
  assert.equal(st.seats.ours, 7);
});

test('every chapter is complete: map, texts, goal, rivals, places and a start that exist', () => {
  const ids = new Set([...index.cities, ...index.regions].map((m) => m.id));
  assert.equal(new Set(CHAPTERS.map((c) => c.book)).size, BOOKS.length);
  for (const [i, ch] of CHAPTERS.entries()) {
    assert.ok(ids.has(ch.map), `chapter ${i + 1}: map ${ch.map}`);
    assert.ok(ch.title && ch.intro && ch.outro && goalText(ch), `chapter ${i + 1}: texts`);
    assert.equal(starTexts(ch).length, 3);
    for (const [party] of ch.rivals) assert.ok(RIVALS.some((p) => p.id === party), `chapter ${i + 1}: rival ${party}`);
    for (const [from] of ch.seats) assert.ok(from === 'undecided' || RIVALS.some((p) => p.id === from));
    assert.ok(!ch.rivals.some(([party]) => OTHERS.some((p) => p.id === party)), 'parties outside the race never hunt');
    const map = realMap(ch.map);
    if (ch.start) assert.ok(startPoint(ch, map), `chapter ${i + 1}: start at ${ch.start}`);
    const g = ch.goal;
    if (g.names && g.type === 'tour') {
      const got = pickPlaces(map, g, g.k, seeded()).map((p) => p.name);
      assert.deepEqual(got, g.names, `chapter ${i + 1}: the tour's towns, in order`);
    }
    const want = { tour: g.k, flags: g.k, hold: 1, rescue: g.allies?.length }[g.type];
    if (want) assert.ok(pickPlaces(map, g, want, seeded()).length >= want, `chapter ${i + 1}: enough places`);
  }
  for (const round of PERK_ROUNDS) for (const id of round) assert.ok(PERKS.some((p) => p.id === id));
  assert.equal(fill('{party} – {seats}', { party: 'א', seats: 5 }), 'א – 5');
});

test('obstacles: roadworks and buses break a chain, a shield saves it once, a storm slows it', () => {
  const w = new World({ sparkTarget: 0 });
  w.setObstacles({ bars: [{ x1: 100, y1: -50, x2: 100, y2: 50, label: 'roadworks' }] });
  const s = w.addSnake({ name: 'בדיקה', at: { x: 0, y: 0, a: 0 } });
  s.ta = 0;
  const deaths = [];
  for (let i = 0; i < 40 && s.alive; i++) {
    w.step(1 / 30);
    deaths.push(...w.events.filter((e) => e.t === 'death'));
    w.events.length = 0;
  }
  assert.equal(s.alive, false);
  assert.equal(deaths[0].cause, 'roadworks');

  const w2 = new World({ sparkTarget: 0 });
  w2.setObstacles({ bars: [{ x1: 100, y1: -50, x2: 100, y2: 50, label: 'roadworks' }] });
  const t = w2.addSnake({ name: 'מוגן', at: { x: 0, y: 0, a: 0 }, shield: 1, mass: 40 });
  t.ta = 0;
  let saved = null;
  for (let i = 0; i < 40; i++) {
    w2.step(1 / 30);
    saved ??= w2.events.find((e) => e.t === 'shield');
    w2.events.length = 0;
  }
  assert.ok(t.alive, 'the shield took the hit');
  assert.equal(saved?.cause, 'roadworks');
  assert.equal(t.shield, 0);
  assert.ok(t.mass < 40, 'part of the chain let go');

  const w3 = new World({ sparkTarget: 0 });
  w3.setObstacles({ movers: [{ pts: [0, 0, 400, 0], speed: 100, half: 20, r: 10, phase: 0, label: 'bus' }] });
  assert.deepEqual(w3.moverAt(w3.movers[0], 1), { x: 100, y: 0, a: 0 });
  assert.equal(w3.moverAt(w3.movers[0], 5).a, Math.PI, 'and back again');
  assert.equal(w3.blocked(100, 5, 0), '', 'nothing there at the start');
  w3.time = 1;
  assert.equal(w3.blocked(100, 5, 0), 'bus');

  const w4 = new World({ sparkTarget: 0 });
  w4.setObstacles({ zones: [{ ax: 0, ay: 0, bx: 0, by: 0, r: 300, slow: 0.5 }] });
  const u = w4.addSnake({ name: 'בסערה', at: { x: 0, y: 0, a: 0 } });
  u.ta = 0;
  w4.step(0.05);
  assert.ok(Math.abs(u.x - C.baseSpeed * 0.05 * 0.5) < 1e-6, 'half speed in a storm');
});

test('obstacles on the real maps stay clear of the start and of the goal', () => {
  const map = realMap('tel-aviv');
  const o = makeObstacles(map, { bars: 8, buses: 3, trains: 1, storms: 1 }, seeded(3), [{ x: 0, y: 0, r: 480, start: true }]);
  assert.equal(o.bars.length, 8);
  assert.ok(o.movers.filter((m) => m.label === 'bus').length >= 2);
  assert.equal(o.zones.length, 1);
  for (const b of o.bars) assert.ok(Math.hypot((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2) > 480);
  const country = makeObstacles(realMap('israel'), { trains: 2, storms: 3 }, seeded(5), []);
  assert.equal(country.movers.length, 2, 'trains run on the country map');
  assert.equal(country.zones.length, 3);
});

// A small map for goals: a square arena with named places.
const toyMap = {
  id: 'toy',
  R: 3000,
  arena: { inside: (x, y) => Math.abs(x) < 2600 && Math.abs(y) < 2600 },
  data: {
    pois: [
      [0, 0, 'square', 'כיכר העיר'],
      [1200, 0, 'square', 'כיכר המזרח'],
      [-1200, 800, 'park', 'גן העיר'],
      [900, -900, 'station', 'התחנה'],
      [-900, -900, 'place', 'השכונה'],
    ],
    roads: [[[-2000, 0, 2000, 0]], [], []],
  },
};
function chapterWorld(ch, opts = {}) {
  const w = new World({ sparkTarget: 0, inside: toyMap.arena.inside, arenaRadius: 3000 });
  const me = w.addSnake({ name: 'אני', at: { x: -2000, y: 2000, a: 0 }, mass: opts.mass ?? C.startMass });
  const run = startChapter(ch, toyMap, w, { playerId: me.id, perks: opts.perks ?? [], rand: seeded(11) });
  return { w, me, run };
}
const base = { rivals: [], hunters: 0, obstacles: {}, par: 60, bonus: { type: 'hands' }, seats: [['undecided', 1]] };

test('goals: gather, flags, hold, first, cut, survive and rescue', () => {
  let { me, run } = chapterWorld({ ...base, goal: { type: 'gather', n: 30 } });
  assert.equal(run.update(0.1).done, false);
  me.mass = 30;
  assert.equal(run.update(0.1).done, true);

  ({ me, run } = chapterWorld({ ...base, goal: { type: 'flags', k: 2, kinds: ['square'] } }));
  for (const t of run.targets) {
    me.x = t.x;
    me.y = t.y;
    run.update(0.1);
  }
  assert.equal(run.update(0.1).done, true);

  ({ me, run } = chapterWorld({ ...base, goal: { type: 'hold', n: 20, secs: 2, names: ['כיכר העיר'], kinds: ['square'] } }));
  me.x = 0;
  me.y = 0;
  assert.equal(run.update(1).progress, 0, 'too few people');
  me.mass = 20;
  run.update(1);
  assert.equal(run.update(1.1).done, true);

  // The race to n: a rival getting there first fails it.
  let w;
  ({ w, me, run } = chapterWorld({ ...base, goal: { type: 'first', n: 50, vs: ['reservists'] }, rivals: [['reservists', 'raider', 0.3, 30]] }));
  const rival = w.snakes.get(run.rivals[0].id);
  assert.equal(rival.name, 'המילואימניקים');
  rival.mass = 50;
  const lost = run.update(0.1);
  assert.equal(lost.failed, true);
  assert.match(lost.why, /המילואימניקים/);

  // Cuts: rivals that die running into you.
  ({ w, me, run } = chapterWorld({ ...base, goal: { type: 'cut', n: 2 }, rivals: [['likud', 'hunter', 0.5, 40], ['yashar', 'hunter', 0.5, 40]] }));
  for (const r of run.rivals) run.event({ t: 'death', id: r.id, killer: me.id });
  assert.equal(run.update(0.1).done, true);
  assert.equal(run.cuts, 2);

  // Survive: time runs out with enough people.
  ({ me, run } = chapterWorld({ ...base, goal: { type: 'survive', secs: 3, min: 10 } }, { mass: 30 }));
  assert.equal(run.update(1).done, false);
  const survived = run.update(2.1);
  assert.equal(survived.done, true);
  assert.equal(survived.stars, 2, 'finished with twice the minimum: a second star');

  // Rescue: reaching a friend links hands; a friend cut before that fails the chapter.
  ({ w, me, run } = chapterWorld({ ...base, goal: { type: 'rescue', allies: ['נועה', 'אבי'], kinds: ['square', 'park', 'station', 'place'] } }));
  assert.equal(run.allies.length, 2);
  const noa = w.snakes.get(run.allies[0].id);
  me.x = noa.x + 60;
  me.y = noa.y;
  run.update(0.1);
  assert.ok(w.sameTeam(me, noa), 'holding hands');
  const avi = w.snakes.get(run.allies[1].id);
  run.event({ t: 'death', id: avi.id, killer: 0 });
  const res = run.update(0.1);
  assert.equal(res.failed, true);
  assert.match(res.why, /אבי/);
});

test('time runs out; stars for time and for the bonus', () => {
  const { me, run } = chapterWorld({ ...base, goal: { type: 'gather', n: 40 }, time: 5, par: 3, bonus: { type: 'people', n: 40 } });
  run.update(2);
  me.mass = 40;
  const r = run.update(0.5);
  assert.equal(r.done, true);
  assert.equal(r.stars, 3);
  const slow = chapterWorld({ ...base, goal: { type: 'gather', n: 40 }, time: 5, par: 3 });
  const late = slow.run.update(5.1);
  assert.equal(late.failed, true);
  assert.equal(late.why, 'נגמר הזמן');
});

test('the director sends rivals after the player once the grace period is over, never more than it should', () => {
  const ch = { ...base, goal: { type: 'gather', n: 999 }, rivals: [['likud', 'giant', 0.6, 200], ['yashar', 'hunter', 0.6, 60], ['otzma', 'raider', 0.6, 60]], hunters: 2, grace: 5 };
  const { w, me, run } = chapterWorld(ch);
  const hunting = () => run.rivals.filter((r) => w.snakes.get(r.id)?.ai.hunting).length;
  run.update(1);
  assert.equal(hunting(), 0, 'peace first');
  let warned = [];
  for (let i = 0; i < 12; i++) warned.push(...run.update(0.5).warn);
  assert.equal(hunting(), 2);
  for (const r of run.rivals) {
    const s = w.snakes.get(r.id);
    if (s.ai.hunting) assert.equal(s.ai.target, me.id);
  }
  assert.ok(warned.some((t) => t.includes('יוצאת לחסום')), 'the player is told');
  // A rival that is cut comes back a while later, smaller.
  const r0 = run.rivals[0];
  const old = w.snakes.get(r0.id);
  old.alive = false;
  run.event({ t: 'death', id: r0.id, killer: me.id });
  w.removeSnake(r0.id);
  for (let i = 0; i < 20; i++) run.update(0.5);
  const back = w.snakes.get(run.rivals[0].id);
  assert.ok(back?.alive && back.id !== old.id && back.mass < 200);
});

test('strategies change the chain: reach, cost of running, speed, value, turning, a shield and more people', () => {
  assert.deepEqual(perkMods([]), { mods: null, shield: 0, extra: 0 });
  const all = perkMods(PERKS.map((p) => p.id));
  assert.deepEqual(all.mods, { reach: 26, boost: 0.5, speed: 1.1, value: 1.25, turn: 1.25 });
  assert.equal(all.shield, 1);
  assert.equal(all.extra, 15);
  // A partner holding your hand from the start.
  const { w, me } = chapterWorld({ ...base, goal: { type: 'gather', n: 99 } }, { perks: ['allies'] });
  assert.ok([...w.snakes.values()].some((s) => s !== me && w.sameTeam(s, me)));
  // Worth more with the echo.
  const v = new World({ sparkTarget: 0 });
  const a = v.addSnake({ name: 'א', at: { x: 0, y: 0, a: 0 }, mods: { value: 1.25 } });
  v.addSpark(a.x + 5, a.y, 4, 5, '#888');
  const before = a.mass;
  v.eat(a);
  assert.equal(a.mass - before, 5);
  assert.equal(scoreOf(a.mass), Math.round(a.mass));
});

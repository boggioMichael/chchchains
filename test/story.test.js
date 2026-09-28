// The story's missions on a made-up map: places are chosen sensibly, and each kind of goal finishes (or fails) when
// it should.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MISSIONS, TO_WIN, pickPlaces, startMission } from '../src/story.js';

const map = {
  R: 3000,
  arena: { inside: (x, y) => Math.abs(x) < 2500 && Math.abs(y) < 2500 },
  data: {
    pois: [
      [0, 0, 'square', 'כיכר רבין'],
      [100, 50, 'square', 'כיכר קטנה'], // too close to the first to be a second flag
      [1200, 0, 'square', 'כיכר המדינה'],
      [-1200, 800, 'park', 'גן העיר'],
      [900, -900, 'market', 'השוק'],
      [4000, 0, 'square', 'כיכר מחוץ לעיר'],
      [0, 1500, 'hall', 'העירייה'],
      [-600, -600, 'city', 'תל אביב–יפו'],
      [1500, 1500, 'square', 'כיכר החטופים'],
      [-1500, -1500, 'square', 'רחבת הכותל המערבי'],
    ],
    places: [[300, 300, 1, 'שכונה']],
  },
};
const rand = (() => {
  let s = 7;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
})();

test('the story adds up: enough mandates to win, in missions that each name a map and a goal', () => {
  const total = MISSIONS.reduce((n, m) => n + m.mandates, 0);
  assert.ok(total >= TO_WIN, `${total} mandates on offer`);
  for (const m of MISSIONS) assert.ok(m.map && m.title && m.brief && m.goal.type && m.mandates > 0);
});

test('places: named ones first, then by kind, apart from each other and inside the map', () => {
  const [first] = pickPlaces(map, { names: ['כיכר רבין'], kinds: ['square'] }, 1, rand);
  assert.equal(first.name, 'כיכר רבין');
  const three = pickPlaces(map, { kinds: ['square', 'park', 'market'] }, 3, rand);
  assert.equal(three.length, 3);
  for (const p of three) assert.ok(map.arena.inside(p.x, p.y), p.name);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(Math.hypot(three[i].x - three[j].x, three[i].y - three[j].y) > 350);
  assert.equal(pickPlaces(map, { names: ['תל אביב-יפו'] }, 1, rand)[0].name, 'תל אביב–יפו', 'dashes do not matter');
  const all = pickPlaces(map, { kinds: ['square', 'park', 'market', 'hall'] }, 20, rand).map((p) => p.name);
  assert.ok(!all.includes('כיכר החטופים') && !all.includes('רחבת הכותל המערבי'), 'never places of mourning or holy sites');
  const bare = pickPlaces({ R: 1000, arena: { inside: () => true }, data: {} }, { kinds: ['square'] }, 2, rand);
  assert.equal(bare.length, 2, 'a map without named places still gets somewhere to go');
});

test('gather, flags, tour, rally and race finish when they should', () => {
  const run = (goal) => startMission({ goal, mandates: 1 }, map, rand);
  let m = run({ type: 'gather', n: 25 });
  assert.equal(m.update({ x: 0, y: 0 }, 24, 0.1).done, false);
  assert.equal(m.update({ x: 0, y: 0 }, 25, 0.1).done, true);

  m = run({ type: 'flags', k: 2, kinds: ['square'] });
  const [a, b] = m.targets;
  assert.equal(m.update({ x: a.x, y: a.y }, 20, 0.1).text, '1/2 דגלים');
  assert.equal(m.update({ x: b.x + 50, y: b.y }, 20, 0.1).done, true);

  m = run({ type: 'tour', k: 2, kinds: ['square'] });
  const [t1, t2] = m.targets;
  assert.equal(m.update({ x: t2.x, y: t2.y }, 20, 0.1).done, false, 'in order: the second place first does not count');
  m.update({ x: t1.x, y: t1.y }, 20, 0.1);
  assert.equal(m.update({ x: t2.x, y: t2.y }, 20, 0.1).done, true);

  m = run({ type: 'rally', names: ['כיכר רבין'], kinds: ['square'], n: 30, secs: 2 });
  assert.equal(m.update({ x: 0, y: 0 }, 29, 1).progress, 0, 'too few people');
  m.update({ x: 0, y: 0 }, 30, 1);
  assert.equal(m.update({ x: 0, y: 0 }, 31, 1.1).done, true);

  m = run({ type: 'race', kinds: ['square', 'hall'], secs: 5 });
  m.update({ x: -2000, y: -2000 }, 20, 0.1); // the race goes as far as the map allows from here
  const goal = m.targets[0];
  assert.ok(Math.hypot(goal.x + 2000, goal.y + 2000) > 1500, 'a far place');
  assert.equal(m.update({ x: -2000, y: -2000 }, 20, 6).failed, true, 'too slow');
});

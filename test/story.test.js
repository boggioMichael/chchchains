// Where the story sends a chain, on a made-up map: named places first, then by kind, apart, inside the map, and
// never a memorial or a holy site. (The chapters themselves: campaign.test.js.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPlaces } from '../src/story.js';

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

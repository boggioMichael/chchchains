import test from 'node:test';
import assert from 'node:assert/strict';
import { World, C, lengthFor, radiusFor, scoreOf, randomName, NOUNS, ADJS, PLACES } from '../src/sim.js';

function lone(world, x, y, a, mass = C.startMass) {
  const s = world.addSnake({ name: 'בדיקה', mass });
  s.x = x;
  s.y = y;
  s.a = s.ta = a;
  for (let i = 0; i < s.px.length; i++) {
    s.px[i] = x - Math.cos(a) * i * C.spacing;
    s.py[i] = y - Math.sin(a) * i * C.spacing;
  }
  return s;
}

test('path points are counted as they are laid, and the body keeps its length', () => {
  const w = new World({ sparkTarget: 0 });
  const s = lone(w, 0, 0, 0);
  const seq0 = s.seq;
  assert.equal(seq0, s.px.length - 1);
  let travelled = 0;
  for (let i = 0; i < 90; i++) {
    const x = s.x;
    const y = s.y;
    w.step(1 / 30);
    travelled += Math.hypot(s.x - x, s.y - y);
  }
  assert.ok(Math.abs(s.seq - seq0 - travelled / C.spacing) <= 1, 'one point per spacing travelled');
  assert.equal(s.px.length, Math.ceil(lengthFor(s.mass) / C.spacing) + 1);
  for (let i = 1; i < s.px.length; i++) {
    const d = Math.hypot(s.px[i] - s.px[i - 1], s.py[i] - s.py[i - 1]);
    assert.ok(Math.abs(d - C.spacing) < 1e-6, 'evenly spaced');
  }
});

test('the edge of the arena breaks a chain into sparks', () => {
  const w = new World({ sparkTarget: 0 });
  const s = lone(w, w.R - 20, 0, 0);
  for (let i = 0; i < 10 && s.alive; i++) w.step(1 / 30);
  assert.equal(s.alive, false);
  assert.ok(w.sparks.size >= 5);
  assert.deepEqual(w.events.find((e) => e.t === 'death'), { t: 'death', id: s.id, killer: 0 });
});

test('running into another chain breaks you; the clearly bigger head wins a head-on bump', () => {
  const w = new World({ sparkTarget: 0 });
  const wall = lone(w, 200, 0, Math.PI / 2, 80); // a long body lying across the path
  for (let i = 0; i < wall.px.length; i++) {
    wall.px[i] = 200;
    wall.py[i] = -300 + i * C.spacing;
  }
  const runner = lone(w, 150, 0, 0);
  for (let i = 0; i < 20 && runner.alive; i++) w.step(1 / 30);
  assert.equal(runner.alive, false);
  assert.equal(w.events.find((e) => e.t === 'death' && e.id === runner.id).killer, wall.id);

  const v = new World({ sparkTarget: 0 });
  const big = lone(v, -60, 0, 0, 200);
  const small = lone(v, 60, 0, Math.PI, 20);
  for (let i = 0; i < 30 && small.alive; i++) v.step(1 / 30);
  assert.equal(small.alive, false);
  assert.equal(big.alive, true);
});

test('holding hands: an offer, a link, passing through each other, and the bonus', () => {
  const w = new World({ sparkTarget: 0 });
  const a = lone(w, 0, 0, 0);
  const b = lone(w, 0, 80, 0);
  const o = w.offerHand(a.id);
  assert.equal(o, b);
  assert.equal(a.offer.to, b.id);
  w.offerHand(b.id); // accepting
  assert.ok(a.team && a.team === b.team);
  assert.ok(a.hands.has(b.id) && b.hands.has(a.id));
  assert.ok(w.teamBonusActive(a));
  // Teammates pass through each other.
  b.x = a.px[10];
  b.y = a.py[10];
  assert.equal(w.collision(b), null);
  // A spark is worth half as much again while a teammate is close.
  w.addSpark(a.x + 5, a.y, 1, 4, '#ffd66b');
  const before = a.mass;
  w.eat(a);
  assert.ok(Math.abs(a.mass - before - C.teamBonus) < 1e-9);
});

test('teams never grow past four', () => {
  const w = new World({ sparkTarget: 0 });
  const ss = [0, 1, 2, 3, 4].map((i) => lone(w, i * 100, 0, 0));
  for (let i = 1; i < 4; i++) assert.ok(w.link(ss[0], ss[i]));
  assert.equal(w.link(ss[0], ss[4]), false);
  assert.equal(w.teamOf(ss[0]).members.size, 4);
  assert.equal(w.handCandidate(ss[4]), null, 'nobody to offer a full team');
});

test('scores, sizes and generated names', () => {
  assert.equal(scoreOf(C.startMass), 12);
  assert.ok(radiusFor(10_000) <= 34);
  for (let i = 0; i < 50; i++) {
    const [noun, rest] = randomName().split(' ');
    assert.ok(NOUNS.includes(noun) && (ADJS.includes(rest) || PLACES.includes(rest)));
  }
});

test('a busy world steps quickly', () => {
  const w = new World({ arenaRadius: 3600, sparkTarget: 1150 });
  for (let i = 0; i < 40; i++) w.addSnake({ bot: true, mass: 12 + Math.random() * 200 });
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    w.step(1 / 30);
    w.events.length = 0;
    for (const s of [...w.snakes.values()]) if (!s.alive) w.removeSnake(s.id);
    while (w.snakes.size < 40) w.addSnake({ bot: true });
  }
  const ms = (performance.now() - t0) / 300;
  console.log(`  40 chains: ${ms.toFixed(2)} ms per step`);
  assert.ok(ms < 8, `${ms.toFixed(2)} ms per step`);
});

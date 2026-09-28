import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSnapshot, decodeSnapshot, FLAG_FULL, FLAG_BOOST, FLAG_BOT } from '../src/protocol.js';

const sample = () => ({
  time: 123456,
  me: 70001,
  focus: 70001,
  snakes: [
    {
      id: 70001,
      color: 3,
      flags: FLAG_FULL | FLAG_BOOST,
      team: 5,
      x: 100.37,
      y: -50.12,
      a: -1.2,
      mass: 42.5,
      seq: 99,
      len: 3,
      px: [100.4, 93.2, 86, 999],
      py: [-50, -50.6, -51, 999],
      count: 3,
    },
    { id: 2, color: 11, flags: FLAG_BOT, team: 0, x: 0, y: 0, a: 0, mass: 12, seq: 4, len: 90, px: [], py: [], count: 0 },
  ],
  newSparks: [{ id: 4000000000, x: 10, y: -20, r: 4.56, color: 13, left: 30.4 }],
  goneSparks: [9, 10],
});

test('a snapshot survives encoding', () => {
  const snap = decodeSnapshot(encodeSnapshot(sample()).buffer);
  assert.ok(snap);
  assert.equal(snap.time, 123456);
  assert.equal(snap.me, 70001);
  assert.equal(snap.focus, 70001);
  assert.equal(snap.snakes.length, 2);
  const [a, b] = snap.snakes;
  assert.equal(a.id, 70001);
  assert.equal(a.color, 3);
  assert.equal(a.flags, FLAG_FULL | FLAG_BOOST);
  assert.equal(a.team, 5);
  assert.ok(Math.abs(a.x - 100.37) <= 0.125 && Math.abs(a.y + 50.12) <= 0.125, 'head position to a quarter unit');
  assert.ok(Math.abs(Math.atan2(Math.sin(a.a + 1.2), Math.cos(a.a + 1.2))) < 1e-3, 'angle');
  assert.equal(a.mass, 42.5);
  assert.equal(a.seq, 99);
  assert.equal(a.len, 3);
  assert.deepEqual([...a.px], [100, 93, 86], 'only `count` points, rounded');
  assert.deepEqual([...a.py], [-50, -51, -51]);
  assert.equal(b.count, 0);
  assert.equal(b.flags, FLAG_BOT);
  assert.deepEqual(snap.newSparks, [{ id: 4000000000, x: 10, y: -20, r: 4.6, color: 13, left: 30 }]);
  assert.deepEqual(snap.goneSparks, [9, 10]);
});

test('malformed snapshots are refused', () => {
  const bytes = encodeSnapshot(sample());
  assert.equal(decodeSnapshot(bytes.buffer.slice(0, bytes.length - 3)), null, 'truncated');
  const longer = new Uint8Array(bytes.length + 2);
  longer.set(bytes);
  assert.equal(decodeSnapshot(longer.buffer), null, 'trailing bytes');
  const wrong = bytes.slice();
  wrong[0] = 7;
  assert.equal(decodeSnapshot(wrong.buffer), null, 'unknown type');
  assert.equal(decodeSnapshot(new ArrayBuffer(0)), null, 'empty');
});

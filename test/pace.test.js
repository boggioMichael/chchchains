// Drawing as sharp as the phone manages: a step down when frames are slow, taken back when it did not help (a phone
// saving its battery), a step up when frames are quick — without see-sawing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pacer } from '../src/pace.js';

/** Feeds n frames of dt seconds; returns the answers that were not 0. */
function feed(pace, n, dt) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = pace(dt);
    if (s) out.push(s);
  }
  return out;
}

test('quick frames: sharper; slow frames: a step down, kept when it helps', () => {
  const pace = pacer({ every: 10 });
  assert.deepEqual(feed(pace, 10, 1 / 60), [1]);
  assert.deepEqual(feed(pace, 10, 1 / 30), [-1], 'slow: fewer pixels');
  assert.deepEqual(feed(pace, 10, 1 / 50), [], 'it helped: kept, and no step up right away');
  assert.deepEqual(feed(pace, 1500, 1 / 60).slice(0, 1), [1], 'quick for a while (20 s): sharper again');
});

test('a phone that shows 30 frames a second whatever is drawn keeps its sharpness', () => {
  const pace = pacer({ every: 10 });
  assert.deepEqual(feed(pace, 10, 1 / 30), [-1]);
  assert.deepEqual(feed(pace, 10, 1 / 30), [1], 'no quicker with fewer pixels: the step is taken back');
  assert.deepEqual(feed(pace, 300, 1 / 30), [], 'and not tried again for a minute');
  assert.deepEqual(feed(pace, 1800, 1 / 30).slice(0, 1), [-1], 'after that, tried once more');
});

test('hiccups (a map loading, the tab coming back) do not count', () => {
  const pace = pacer({ every: 10 });
  assert.deepEqual(feed(pace, 50, 0.5), []);
  assert.deepEqual(feed(pace, 9, 1 / 30), []);
  assert.equal(pace(0.3), 0, 'a hiccup starts the count again');
  assert.deepEqual(feed(pace, 9, 1 / 30), []);
});

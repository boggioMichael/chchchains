import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { streetSpawner } from '../src/streets.js';
import { World } from '../src/sim.js';

test('people turn up on the pavement of real streets, inside the arena', () => {
  const map = JSON.parse(readFileSync(new URL('../docs/maps/tel-aviv.json', import.meta.url), 'utf8'));
  const spawn = streetSpawner(map.roads, map.R);
  assert.ok(spawn);
  // Distance from a point to the nearest street segment (checked on a sample).
  const segs = [];
  for (const lines of map.roads) {
    for (const p of lines) for (let i = 2; i + 1 < p.length; i += 2) segs.push([p[i - 2], p[i - 1], p[i], p[i + 1]]);
  }
  for (let k = 0; k < 60; k++) {
    const { x, y } = spawn();
    assert.ok(Math.hypot(x, y) < map.R, 'inside the arena');
    let best = Infinity;
    for (const [x0, y0, x1, y1] of segs) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - x0 - t * dx, y - y0 - t * dy));
    }
    assert.ok(best <= 12, `a few metres from a street (${best.toFixed(1)} m)`);
  }
});

test('a world with a map fills its streets, and plays without one too', () => {
  const map = JSON.parse(readFileSync(new URL('../docs/maps/haifa.json', import.meta.url), 'utf8'));
  const w = new World({ arenaRadius: map.R, sparkTarget: 300, spawnPoint: streetSpawner(map.roads, map.R) });
  assert.ok(w.sparks.size >= 300);
  for (const sp of w.sparks.values()) assert.ok(Math.hypot(sp.x, sp.y) < map.R + 70);
  const s = w.addSnake({ name: 'בדיקה' });
  assert.ok(Math.hypot(s.x, s.y) < map.R * 0.8);
  assert.equal(streetSpawner([], 3000), null);
});

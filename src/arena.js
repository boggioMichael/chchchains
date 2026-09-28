// Ch-ch-chain-ges — the playing area of a map: the city limits (or the whole country, or the promise), stored in
// the map file as an "inside?" mask on a grid. The same test runs in the browser and on the server.

/**
 * The arena of a map (its parsed JSON, or null for none): { R, inside(x, y), rings, E } where rings are the
 * outline as flat [x0, y0, x1, y1, …] polygons. Maps without a mask are the circle of radius R.
 */
export function arenaOf(data, fallbackR = 3000) {
  const R = data?.R ?? fallbackR;
  const a = data?.arena;
  if (!a || !Array.isArray(a.rle) || !(a.n > 0) || !(a.cell > 0)) {
    const r2 = R * R;
    return { R, inside: (x, y) => x * x + y * y <= r2, rings: null, E: data?.extent ?? R };
  }
  const n = a.n;
  const cell = a.cell;
  const E = data.extent;
  const mask = new Uint8Array(n * n);
  let p = 0;
  let on = false;
  for (const run of a.rle) {
    if (on) mask.fill(1, p, Math.min(n * n, p + run));
    p += run;
    on = !on;
  }
  const inside = (x, y) => {
    const c = Math.round((x + E) / cell);
    const r = Math.round((y + E) / cell);
    return c >= 0 && r >= 0 && c < n && r < n && mask[r * n + c] === 1;
  };
  return { R, inside, rings: Array.isArray(a.rings) ? a.rings : null, E, mask, n, cell };
}

/** How close (in map units, up to `max`) the edge is ahead of a point walking at angle a. Infinity if not near. */
export function edgeAhead(inside, x, y, a, max = 400, step = 40) {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  for (let d = step; d <= max; d += step) if (!inside(x + dx * d, y + dy * d)) return d;
  return Infinity;
}

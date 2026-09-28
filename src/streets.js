// Ch-ch-chains — where people turn up: random spots on a city's streets (on the pavement, a few metres to either
// side of the road's centre line). The same code places people on the server and in offline play.

const WEIGHT = [1.5, 1.25, 1]; // main roads are a little busier

/**
 * roads: [[polyline, …] per class] with polylines as flat [x0, y0, x1, y1, …] in metres; R: the arena radius.
 * Returns a function () => { x, y }, or null when there are no streets inside the arena.
 */
export function streetSpawner(roads, R, rand = Math.random) {
  const ax = [];
  const ay = [];
  const bx = [];
  const by = [];
  const cum = [];
  let total = 0;
  const lim = (R - 60) ** 2;
  (roads || []).forEach((lines, cls) => {
    const w = WEIGHT[cls] ?? 1;
    for (const p of lines) {
      for (let i = 2; i + 1 < p.length; i += 2) {
        const x0 = p[i - 2];
        const y0 = p[i - 1];
        const x1 = p[i];
        const y1 = p[i + 1];
        if (x0 * x0 + y0 * y0 > lim || x1 * x1 + y1 * y1 > lim) continue;
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 1) continue;
        total += len * w;
        ax.push(x0);
        ay.push(y0);
        bx.push(x1);
        by.push(y1);
        cum.push(total);
      }
    }
  });
  if (!total) return null;
  const C = Float64Array.from(cum);
  return () => {
    const r = rand() * total;
    let lo = 0;
    let hi = C.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (C[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = rand();
    const dx = bx[lo] - ax[lo];
    const dy = by[lo] - ay[lo];
    const L = Math.hypot(dx, dy) || 1;
    const side = (rand() < 0.5 ? -1 : 1) * (4 + rand() * 7);
    return { x: ax[lo] + dx * t - (dy / L) * side, y: ay[lo] + dy * t + (dx / L) * side };
  };
}

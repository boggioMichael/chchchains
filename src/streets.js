// Ch-ch-chain-ges — where people turn up: random spots on a map's streets (on the pavement, a few metres to either
// side of the road's centre line), and on the big maps also around the towns. The same code places people on the
// server and in offline play.

const WEIGHT = [1.5, 1.25, 1]; // main roads are a little busier

/**
 * roads: [[polyline, …] per class] with polylines as flat [x0, y0, x1, y1, …] in map units; R: the arena radius.
 * opts.inside(x, y): the arena test (else the circle of R); opts.hubs: [[x, y, weight], …] towns on a big map,
 * where half the people turn up. Returns a function () => { x, y }, or null when there is nowhere to put anyone.
 */
export function streetSpawner(roads, R, rand = Math.random, opts = {}) {
  const lim = (R - 60) ** 2;
  const ok = opts.inside ? (x, y) => opts.inside(x, y) : (x, y) => x * x + y * y <= lim;
  const ax = [];
  const ay = [];
  const bx = [];
  const by = [];
  const cum = [];
  let total = 0;
  (roads || []).forEach((lines, cls) => {
    const w = WEIGHT[cls] ?? 1;
    for (const p of lines) {
      for (let i = 2; i + 1 < p.length; i += 2) {
        const x0 = p[i - 2];
        const y0 = p[i - 1];
        const x1 = p[i];
        const y1 = p[i + 1];
        if (!ok(x0, y0) || !ok(x1, y1)) continue;
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
  const hubs = (opts.hubs || []).filter(([x, y]) => ok(x, y));
  let hubTotal = 0;
  const hubCum = Float64Array.from(hubs, (h) => (hubTotal += Math.max(0.1, h[2] || 1)));
  if (!total && !hubTotal) return null;
  const C = Float64Array.from(cum);
  const find = (arr, r) => {
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const onStreet = () => {
    const k = find(C, rand() * total);
    const t = rand();
    const dx = bx[k] - ax[k];
    const dy = by[k] - ay[k];
    const L = Math.hypot(dx, dy) || 1;
    const side = (rand() < 0.5 ? -1 : 1) * (4 + rand() * 7);
    return { x: ax[k] + dx * t - (dy / L) * side, y: ay[k] + dy * t + (dx / L) * side };
  };
  const inTown = () => {
    const [hx, hy, w] = hubs[find(hubCum, rand() * hubTotal)];
    const sigma = 30 * Math.sqrt(Math.max(0.1, w || 1));
    // Box–Muller: most people near the middle of town.
    const u = Math.max(1e-9, rand());
    const d = sigma * Math.sqrt(-2 * Math.log(u));
    const a = rand() * Math.PI * 2;
    return { x: hx + Math.cos(a) * d, y: hy + Math.sin(a) * d };
  };
  if (!hubTotal) return onStreet;
  if (!total) return inTown;
  return () => (rand() < 0.5 ? inTown() : onStreet());
}

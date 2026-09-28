// Ch-ch-chain-ges — places for the story (campaign.js): where a chapter sends the chain to hang a flag, hold a
// square or find a friend, chosen from the map's named places. Never a memorial, a cemetery or a holy site.

// Places a game should never send a campaign to hang flags or hold a rally: memorials, cemeteries, holy sites, and
// places of mourning and protest for the hostages and the fallen.
const SENSITIVE = /חטופ|נופלים|הנופל|זיכרון|זכרון|יזכור|הנצחה|אנדרטה|מצבה|שכול|קברות|קבר |יד ושם|הר הרצל|שואה|טבח|הכותל|הר הבית|מסגד|כנסיי|בית כנסת|כנסיית/;

/**
 * Chooses the mission's places on the map: named ones first, then by kind, at least goal.apart (350) from each other,
 * inside the arena. Falls
 * back to neighbourhood names, then to any street corner. Returns [{ x, y, name }].
 */
export function pickPlaces(map, goal, count, rand = Math.random) {
  const data = map?.data || {};
  const inside = map?.arena?.inside || (() => true);
  const pois = (data.pois || [])
    .filter(([x, y, , name]) => inside(x, y) && !SENSITIVE.test(name))
    .map(([x, y, kind, name]) => ({ x, y, kind, name }));
  const out = [];
  const apart = goal.apart ?? 350;
  const far = (p) => out.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > apart);
  const take = (p, unique = true) => {
    if (out.length < count && far(p) && !(unique && out.some((q) => q.name === p.name))) out.push(p);
  };
  const norm = (s) => String(s).replace(/[–—־]/g, '-');
  for (const want of goal.names || []) {
    const w = norm(want);
    const hit = pois.find((p) => norm(p.name) === w) || pois.find((p) => norm(p.name).includes(w));
    if (hit) take(hit);
  }
  for (const kind of goal.kinds || []) {
    const list = pois.filter((p) => p.kind === kind);
    // Shuffle a little, so replays differ, but keep the big ones likely.
    for (let i = list.length - 1; i > 0; i--) {
      if (rand() < 0.5) {
        const j = Math.floor(rand() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    for (const p of list) take(p);
  }
  for (const [x, y, , name] of data.places || []) if (inside(x, y)) take({ x, y, kind: 'place', name });
  for (let k = 0; out.length < count && k < 400; k++) {
    const R = map?.R || 2000;
    const x = (rand() * 2 - 1) * R * 0.7;
    const y = (rand() * 2 - 1) * R * 0.7;
    if (inside(x, y)) take({ x, y, kind: 'spot', name: 'הנקודה המסומנת' }, false);
  }
  return out;
}

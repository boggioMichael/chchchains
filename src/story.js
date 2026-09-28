// Ch-ch-chain-ges — the story: a single-player campaign on the real maps. You start with a movement and no seats;
// every mission (gather people, hang flags in the squares, reach the places that matter, hold a rally) brings
// mandates, and 61 of them win the election and form a government. The story and its people are made up; progress
// is kept only on the player's own phone.

export const TO_WIN = 61;

/**
 * The missions, in order. goal.type: 'gather' (n people), 'reach' (a place, with n people), 'flags' (k places),
 * 'rally' (stay by a place with n people for secs), 'race' (reach a place within secs), 'tour' (places in order).
 * Places are picked from the map's named places: by name first, then by kind.
 */
export const MISSIONS = [
  {
    map: 'tel-aviv',
    chapter: 'תל אביב',
    title: 'צעד ראשון',
    brief: 'כל תנועה מתחילה באנשים. צאו לרחובות ואספו 25 אנשים לשרשרת.',
    goal: { type: 'gather', n: 25 },
    mandates: 3,
  },
  {
    map: 'tel-aviv',
    chapter: 'תל אביב',
    title: 'דגלים בכיכרות',
    brief: 'העיר צריכה לראות אתכם. עברו בשלוש כיכרות ותלו בכל אחת דגל.',
    goal: { type: 'flags', k: 3, kinds: ['square', 'park', 'sight', 'hall'] },
    mandates: 4,
  },
  {
    map: 'tel-aviv',
    chapter: 'תל אביב',
    title: 'העצרת הראשונה',
    brief: 'הגיעו לכיכר עם 30 אנשים לפחות והישארו שם 8 שניות: זו העצרת הראשונה שלכם.',
    goal: { type: 'rally', names: ['כיכר רבין', 'כיכר דיזנגוף', 'כיכר הבימה'], kinds: ['square', 'park', 'hall'], n: 30, secs: 8 },
    mandates: 5,
  },
  {
    map: 'jerusalem',
    chapter: 'ירושלים',
    title: 'הדרך לכנסת',
    brief: 'בירושלים מתקבלות ההחלטות. הביאו 30 אנשים עד הכנסת.',
    goal: { type: 'reach', names: ['הכנסת', 'משכן הכנסת'], kinds: ['gov', 'hall'], n: 30 },
    mandates: 5,
  },
  {
    map: 'jerusalem',
    chapter: 'ירושלים',
    title: 'שוק ותחנה',
    brief: 'איפה שיש אנשים – שם צריך להיות. תלו דגלים בשוק, בתחנה ובכיכר.',
    goal: { type: 'flags', k: 3, names: ['שוק מחנה יהודה'], kinds: ['market', 'station', 'square'] },
    mandates: 5,
  },
  {
    map: 'jerusalem',
    chapter: 'ירושלים',
    title: 'גל של מתנדבים',
    brief: 'הקמפיין צובר תאוצה: שרשרת של 60 אנשים.',
    goal: { type: 'gather', n: 60 },
    mandates: 6,
  },
  {
    map: 'haifa',
    chapter: 'חיפה',
    title: 'סיור בעיר',
    brief: 'חיפה מחכה: עברו בשלושה מקומות, אחד אחרי השני.',
    goal: { type: 'tour', k: 3, kinds: ['uni', 'hall', 'park', 'sight', 'square'] },
    mandates: 5,
  },
  {
    map: 'haifa',
    chapter: 'חיפה',
    title: 'מרוץ נגד הזמן',
    brief: 'הכתבים מחכים! הגיעו למקום המסומן תוך 45 שניות. ⚡ עוזר.',
    goal: { type: 'race', kinds: ['station', 'square', 'hall'], secs: 45, far: true },
    mandates: 5,
  },
  {
    map: 'beer-sheva',
    chapter: 'באר שבע',
    title: 'לב הנגב',
    brief: 'הנגב הוא לב הארץ. הגיעו לעירייה עם 50 אנשים.',
    goal: { type: 'reach', names: ['עיריית באר שבע'], kinds: ['hall', 'square', 'uni'], n: 50 },
    mandates: 6,
  },
  {
    map: 'israel',
    chapter: 'כל הארץ',
    title: 'מסע ארצי',
    brief: 'עכשיו כל הארץ: ירושלים, תל אביב, חיפה ובאר שבע – לפי הסדר.',
    goal: { type: 'tour', k: 4, names: ['ירושלים', 'תל אביב-יפו', 'חיפה', 'באר שבע'], kinds: ['city'] },
    mandates: 7,
  },
  {
    map: 'israel',
    chapter: 'כל הארץ',
    title: 'הגל הגדול',
    brief: 'שרשרת של 120 אנשים מקצה הארץ ועד קצה.',
    goal: { type: 'gather', n: 120 },
    mandates: 7,
  },
  {
    map: 'israel',
    chapter: 'כל הארץ',
    title: 'ליל הבחירות',
    brief: 'העצרת הגדולה: 150 אנשים בירושלים, 12 שניות. זה הרגע.',
    goal: { type: 'rally', names: ['ירושלים'], kinds: ['city'], n: 150, secs: 12 },
    mandates: 8,
  },
];

const KEY = 'chain:story';

/** Saved progress: { i: next mission, mandates }. */
export function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p && Number.isInteger(p.i) && Number.isFinite(p.mandates)) return { i: Math.max(0, Math.min(MISSIONS.length, p.i)), mandates: p.mandates };
  } catch {
    /* storage unavailable */
  }
  return { i: 0, mandates: 0 };
}
export function saveProgress(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ i: p.i, mandates: p.mandates }));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Chooses the mission's places on the map: named ones first, then by kind, spread apart, inside the arena. Falls
 * back to neighbourhood names, then to any street corner. Returns [{ x, y, name }].
 */
export function pickPlaces(map, goal, count, rand = Math.random) {
  const data = map?.data || {};
  const inside = map?.arena?.inside || (() => true);
  const pois = (data.pois || []).filter(([x, y]) => inside(x, y)).map(([x, y, kind, name]) => ({ x, y, kind, name }));
  const out = [];
  const far = (p) => out.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > 350);
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

/**
 * A running mission: update(me, score, dt) each frame → { done, failed, text, progress, targets }.
 * me: the player's chain (x, y) or null; targets: [{ x, y, name, done, active }] for the map, arrows and minimap.
 */
export function startMission(mission, map, rand = Math.random) {
  const g = mission.goal;
  const want = { gather: 0, reach: 1, flags: g.k || 3, rally: 1, race: 1, tour: g.k || 3 }[g.type] ?? 0;
  let places = want ? pickPlaces(map, g, want, rand) : [];
  if (g.type === 'race' && places.length) {
    // The race goes to the place furthest from the start (picked once the chain appears).
    places = places.slice(0, 1);
  }
  const targets = places.map((p) => ({ ...p, done: false, active: false }));
  let held = 0;
  let clock = 0;
  let next = 0;
  let placedRace = false;
  const near = (me, t, r) => me && Math.hypot(me.x - t.x, me.y - t.y) < r;
  return {
    mission,
    targets,
    update(me, score, dt) {
      clock += dt;
      const res = { done: false, failed: false, text: '', progress: 0, targets };
      switch (g.type) {
        case 'gather':
          res.progress = Math.min(1, score / g.n);
          res.text = `${Math.min(score, g.n)}/${g.n} אנשים`;
          res.done = score >= g.n;
          break;
        case 'reach': {
          const t = targets[0];
          if (!t) return { ...res, done: true };
          t.active = true;
          const enough = score >= g.n;
          res.text = enough ? `עכשיו ל${t.name}` : `${score}/${g.n} אנשים, ואז ל${t.name}`;
          res.progress = Math.min(1, score / g.n) * 0.5 + (near(me, t, 110) && enough ? 0.5 : 0);
          if (enough && near(me, t, 110)) {
            t.done = true;
            res.done = true;
          }
          break;
        }
        case 'flags': {
          let n = 0;
          for (const t of targets) {
            t.active = !t.done;
            if (!t.done && near(me, t, 95)) t.done = true;
            if (t.done) n++;
          }
          res.text = `${n}/${targets.length} דגלים`;
          res.progress = targets.length ? n / targets.length : 1;
          res.done = n === targets.length;
          break;
        }
        case 'tour': {
          while (next < targets.length && targets[next].done) next++;
          targets.forEach((t, k) => (t.active = k === next));
          const t = targets[next];
          if (t && near(me, t, g.names ? 160 : 100)) {
            t.done = true;
            next++;
          }
          res.text = next < targets.length ? `${next + 1}/${targets.length}: ${targets[next].name}` : '';
          res.progress = targets.length ? next / targets.length : 1;
          res.done = next >= targets.length;
          break;
        }
        case 'rally': {
          const t = targets[0];
          if (!t) return { ...res, done: true };
          t.active = true;
          const there = near(me, t, g.names?.[0] === 'ירושלים' ? 220 : 150);
          if (there && score >= g.n) held += dt;
          else held = Math.max(0, held - dt * 0.5);
          res.progress = Math.min(1, held / g.secs);
          res.text =
            score < g.n ? `${score}/${g.n} אנשים, ואז ל${t.name}` : there ? `עצרת! ${Math.ceil(Math.max(0, g.secs - held))} שנ׳` : `ל${t.name}`;
          res.done = held >= g.secs;
          break;
        }
        case 'race': {
          const t = targets[0];
          if (!t) return { ...res, done: true };
          if (!placedRace && me) {
            // As far as the map allows from where the chain started, among the kinds asked for.
            placedRace = true;
            const pool = pickPlaces(map, { kinds: g.kinds }, 12, rand);
            let best = t;
            for (const p of pool) if (Math.hypot(p.x - me.x, p.y - me.y) > Math.hypot(best.x - me.x, best.y - me.y)) best = p;
            Object.assign(t, best, { done: false });
            clock = 0;
          }
          t.active = true;
          const left = g.secs - clock;
          res.text = `${Math.max(0, Math.ceil(left))} שנ׳ עד ${t.name}`;
          res.progress = Math.min(1, clock / g.secs);
          if (near(me, t, 110)) {
            t.done = true;
            res.done = true;
          } else if (left <= 0) res.failed = true;
          break;
        }
        default:
          res.done = true;
      }
      return res;
    },
  };
}

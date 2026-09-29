// Ch-ch-chain-ges — "נגד כל הסיכויים": the single-player campaign. A new party starts under the electoral threshold
// with twelve people in the street and, chapter by chapter, city by city, becomes the biggest party in the Knesset.
// Thirteen chapters in five books; between the books you choose a strategy (a lasting ability), and every chapter
// moves seats from the rivals you beat to you. The rival parties are bots with the names of the other parties,
// racing for the same voters, cutting across your path and closing rings around you; roadworks, buses, trains and
// storms get in the way. The story and its people are made up; progress is kept only on the player's own phone.
//
// This module is pure logic (no DOM): the chapters and the seats, the director that sends the rivals after you, the
// obstacles on the map, and each chapter's goal.
import { C, radiusFor, scoreOf } from './sim.js';
import { pickPlaces } from './story.js';

export const THRESHOLD = 4; // seats: 3.25% of 120
export const OURS = 0; // our chain's colour (COLORS[0], blue)
export const ALLY_COLOR = 9;

/**
 * The parties racing for the same voters, as their chains in the street. Opening seats: the Walla News poll of 9
 * September 2026 (ours, polled at 4 there, starts the story at launch day: under the threshold, its 4 seats
 * undecided). Names, colours and seats are all that is used; edit them here.
 */
export const RIVALS = [
  { id: 'yashar', name: 'ישר', seats: 25, color: 2 },
  { id: 'likud', name: 'הליכוד', seats: 21, color: 3 },
  { id: 'beyachad', name: 'ביחד', seats: 14, color: 4 },
  { id: 'democrats', name: 'הדמוקרטים', seats: 9, color: 5 },
  { id: 'ybeytenu', name: 'ישראל ביתנו', seats: 9, color: 6 },
  { id: 'otzma', name: 'עוצמה יהודית', seats: 7, color: 8 },
  { id: 'rz', name: 'הציונות הדתית וזהות', seats: 5, color: 7 },
  { id: 'reservists', name: 'המילואימניקים', seats: 0, color: 11 },
  { id: 'bluewhite', name: 'כחול לבן', seats: 0, color: 10 },
];
/** In the Knesset but never in the street: parties whose voters hardly overlap with ours keep their seats. */
export const OTHERS = [
  { id: 'shas', name: 'ש״ס', seats: 7 },
  { id: 'utj', name: 'יהדות התורה', seats: 7 },
  { id: 'joint', name: 'הרשימה המשותפת', seats: 7 },
  { id: 'raam', name: 'רע״ם', seats: 5 },
];
export const UNDECIDED = 4;
export const POLL_NOTE = 'המנדטים של שאר המפלגות בפתיחה: סקר וואלה, 9.9.2026. מכאן והלאה – הכול תלוי בכם.';

export const LOCAL_LISTS = ['צעירי העיר', 'רשימת השכונות', 'הרשימה המקומית', 'שכנים למען העיר', 'גרעין העיר', 'רשימת הרחוב'];

/** Strategies, chosen one per round between the books (like social policies): lasting abilities. */
export const PERKS = [
  { id: 'volunteers', icon: '🙋', name: 'רשת מתנדבים', text: 'כל פרק מתחיל עם 15 אנשים נוספים בשרשרת.' },
  { id: 'field', icon: '🧲', name: 'עבודת שטח', text: 'אנשים מצטרפים מרחוק יותר: טווח האיסוף כמעט כפול.' },
  { id: 'stamina', icon: '🫁', name: 'נשימה ארוכה', text: 'ריצה (⚡) עולה חצי.' },
  { id: 'intel', icon: '📡', name: 'חמ״ל', text: 'היריבות מסומנות במפה הקטנה, וחצים אדומים מראים מרחוק מי יוצאת לצוד אתכם.' },
  { id: 'shield', icon: '🛡️', name: 'חוסן', text: 'פעם אחת בכל פרק, התנגשות קורעת רק חלק מהשרשרת.' },
  { id: 'allies', icon: '🤝', name: 'שותפים מקומיים', text: 'בכל פרק רשימה מקומית מחזיקה אתכם ביד מההתחלה.' },
  { id: 'momentum', icon: '💨', name: 'מומנטום', text: 'השרשרת מהירה יותר ב־10%.' },
  { id: 'echo', icon: '📣', name: 'הדהוד', text: 'כל מי שמצטרף שווה פי 1.25.' },
  { id: 'agile', icon: '🌀', name: 'גמישות', text: 'מסתובבים מהר יותר ב־25%.' },
];
export const PERK_ROUNDS = [
  ['volunteers', 'field', 'stamina'],
  ['intel', 'shield', 'allies'],
  ['momentum', 'echo', 'agile'],
];

/** The five books. `event`: seats that move when the book opens (the winter). */
export const BOOKS = [
  {
    title: 'הניצוץ',
    text: 'יום ההשקה. אולם קטן, שלוש מצלמות וכיסאות ריקים. הסקר הראשון נותן ל{party} 1.2 אחוזים, והפרשנים כבר מתערבים מתי תתפרקו. יש לכם שנים־עשר אנשים שמאמינים, וכמה שבועות עד הבחירות.',
  },
  {
    title: 'העיר הגדולה',
    text: 'מעל אחוז החסימה פתאום כולם רואים אתכם – גם המפלגות הגדולות. בערים הגדולות הן כבר מחכות, ואף אחת מהן לא מתכוונת לפנות לכם מקום.',
  },
  {
    title: 'החורף',
    text: 'ואז, כמו בכל מערכה, מגיע החורף. סקר חדש: ירידה של שלושה מנדטים. מתנדבים עוזבים, והכותרות כותבות שהבועה התפוצצה. בשלוש בלילה מגיעה הודעה מאבי: "זה הרגע שבו מפלגות קטנות נעלמות. או הרגע שבו הן נולדות."',
    event: [
      { to: 'yashar', n: 2 },
      { to: 'likud', n: 1 },
    ],
  },
  {
    title: 'הארץ',
    text: 'באביב יוצאים לדרך: מהגליל ועד המפרץ, עיר אחרי עיר. השרשרת מתארכת, והיריבות כבר ממתינות בצמתים.',
  },
  {
    title: 'יום הבחירות',
    text: 'שש בבוקר. הקלפיות נפתחות. כל מה שבניתם בשבועות האלה נמדד היום, קול אחרי קול.',
  },
];
export const BOOK_NAMES = ['ספר ראשון', 'ספר שני', 'ספר שלישי', 'ספר רביעי', 'ספר חמישי'];

/**
 * The chapters, in order.
 * goal.type: 'gather' (n people) · 'tour' (places in order) · 'flags' (k places, any order) · 'hold' (stay by a place
 * with n people for secs) · 'first' (n people before any of goal.vs) · 'rescue' (hold hands with the chains named in
 * goal.allies) · 'survive' (secs, ending with at least goal.min) · 'cut' (n rival chains run into yours).
 * rivals: [party, role, skill, mass] (rivalMods: their handicap); hunters: how many hunt at once (surge: more after a while); grace: seconds of
 * peace first; seats: [[party, n]] taken when the chapter is won (the first is also where a third star's seat comes
 * from, except in the first book); bonus: the third star (hands, cut n, people n); par: seconds for the second star.
 */
export const CHAPTERS = [
  {
    book: 0,
    map: 'afula',
    title: 'שנים־עשר',
    intro: 'רחוב אחד בעפולה, שנים־עשר אנשים ושולחן מתקפל. אף אחד לא עוצר. ואז מישהי עוצרת.',
    goal: { type: 'gather', n: 50 },
    rivals: [['reservists', 'raider', 0.25, 30]],
    hunters: 0,
    locals: 2,
    obstacles: { bars: 3 },
    time: 240,
    par: 60,
    bonus: { type: 'hands' },
    seats: [['undecided', 1]],
    outro: 'נועה, בת 19, עצרה ראשונה. "באתי לשאול מה אתם רוצים," היא אמרה, "ונשארתי כי שאלתם מה אני רוצה." עד הערב היא הביאה חצי שכונה.',
  },
  {
    book: 0,
    map: 'beer-sheva',
    title: 'חוג בית',
    intro: 'רחל, בת 74, הזמינה את כל הבניין לחוג בית בבאר שבע, ואתם מאחרים. עברו בשלוש הכתובות לפי הסדר, לפני שכולם ילכו הביתה.',
    goal: { type: 'tour', k: 3, kinds: ['place', 'square', 'park', 'hall'], apart: 1000 },
    rivals: [
      ['reservists', 'raider', 0.35, 40],
      ['bluewhite', 'hunter', 0.3, 35],
    ],
    hunters: 1,
    grace: 12,
    obstacles: { bars: 5, buses: 1 },
    time: 150,
    par: 70,
    bonus: { type: 'people', n: 60 },
    seats: [['undecided', 1]],
    outro: 'שלושים איש בסלון של עשרים. רחל הגישה עוגת שמרים ואמרה: "חיכיתי שנים שמישהו יבוא להקשיב, לא רק לדבר."',
  },
  {
    book: 0,
    map: 'ashdod',
    title: 'אחוז החסימה',
    intro: 'שלוש מפלגות קטנות, עיר אחת וקהל אחד. רק מי שתגיע ראשונה ל־100 אנשים תעבור את אחוז החסימה בסקר של הערב.',
    goal: { type: 'first', n: 100, vs: ['reservists', 'bluewhite'] },
    rivals: [
      ['reservists', 'raider', 0.4, 20],
      ['bluewhite', 'hunter', 0.35, 20],
    ],
    rivalMods: { value: 0.5 },
    hunters: 1,
    grace: 25,
    obstacles: { bars: 5, buses: 2 },
    time: 240,
    par: 90,
    bonus: { type: 'cut', n: 1 },
    seats: [['undecided', 2]],
    outro: 'סקר חדשות הערב: 3.4 אחוזים. מעל אחוז החסימה. בטלפון – אבי, האסטרטג הוותיק שסירב לכם פעמיים: "טוב. אני בפנים. ועכשיו מתחיל הקשה."',
  },
  {
    book: 1,
    map: 'tel-aviv',
    title: 'העיר שלא ישנה',
    intro: 'תל אביב, אחת בלילה. תלו ארבעה דגלים בכיכרות ובגנים, מתחת לאף של שתי שרשראות שכבר צדות ברחובות.',
    goal: { type: 'flags', k: 4, kinds: ['square', 'park', 'sight', 'hall'], apart: 900 },
    rivals: [
      ['democrats', 'hunter', 0.5, 70],
      ['beyachad', 'guard', 0.5, 80],
    ],
    hunters: 2,
    grace: 10,
    obstacles: { bars: 6, buses: 2, trains: 1 },
    time: 180,
    par: 70,
    bonus: { type: 'cut', n: 1 },
    seats: [
      ['democrats', 1],
      ['beyachad', 1],
    ],
    outro: 'עד הבוקר הדגל בכיכר צולם אלפי פעמים. נועה העלתה סרטון, ובפעם הראשונה התגובות לא שאלו "מי אתם?" אלא "איך מצטרפים?"',
  },
  {
    book: 1,
    map: 'jerusalem',
    title: 'הכיכר',
    intro: 'ירושלים לא נותנת כלום בחינם. הביאו 70 אנשים לכיכר והחזיקו בה 12 שניות, בזמן שהשרשרת הגדולה בעיר מנסה לכתר אתכם.',
    goal: { type: 'hold', n: 70, secs: 12, names: ['כיכר ספרא', 'כיכר ציון', 'כיכר החתולות'], kinds: ['square', 'park'] },
    rivals: [
      ['likud', 'giant', 0.35, 170],
      ['otzma', 'guard', 0.5, 60],
    ],
    hunters: 1,
    surge: { at: 70, add: 1 },
    grace: 30,
    obstacles: { bars: 6, buses: 2, trains: 1 },
    time: 240,
    par: 130,
    bonus: { type: 'people', n: 120 },
    seats: [
      ['likud', 1],
      ['otzma', 1],
    ],
    outro: 'עשרים שניות שהרגישו כמו שנה. כשהכיכר התמלאה, רחל התקשרה מבאר שבע: "ראיתי אתכם בחדשות. אמרתי לשכנות – אלה שלנו."',
  },
  {
    book: 1,
    map: 'haifa',
    title: 'הכרמל',
    intro: 'אבי תקוע עם צוות קטן בעיר התחתית, ושתי שרשראות יריבות כבר סוגרות עליו. הגיעו אליו ואל הצוות שבמעלה הכרמל ותנו יד, לפני שהן יגיעו ראשונות.',
    goal: { type: 'rescue', allies: ['אבי', 'צוות הכרמל'], kinds: ['station', 'square', 'park', 'sight', 'place'], apart: 1500 },
    rivals: [
      ['ybeytenu', 'hunter', 0.6, 90],
      ['beyachad', 'hunter', 0.55, 80],
    ],
    hunters: 2,
    grace: 4,
    obstacles: { bars: 7, buses: 2, trains: 1 },
    time: 150,
    par: 60,
    bonus: { type: 'people', n: 90 },
    seats: [['ybeytenu', 2]],
    outro: '"עשרים שנה אני בפוליטיקה," אמר אבי כשהחזקתם ידיים, "ואף אחד עוד לא חזר בשבילי."',
  },
  {
    book: 2,
    map: 'netanya',
    title: 'הסערה',
    intro: 'כולם יודעים שאתם פגיעים עכשיו. שלוש שרשראות גדולות יוצאות לצוד את מה שנשאר מכם, וסערה משתוללת בעיר. שרדו 60 שניות, ואל תרדו מתחת ל־30 אנשים.',
    goal: { type: 'survive', secs: 60, min: 30 },
    mass: 33,
    rivals: [
      ['yashar', 'giant', 0.5, 300],
      ['likud', 'giant', 0.5, 280],
      ['beyachad', 'hunter', 0.55, 90],
    ],
    hunters: 1,
    surge: { at: 25, add: 1 },
    grace: 6,
    obstacles: { bars: 7, buses: 2, storms: 2 },
    bonus: { type: 'cut', n: 1 },
    seats: [['yashar', 2]],
    outro: 'הסערה עברה. אתם עדיין כאן. אבי כותב: "מי ששורד את החורף – מגיע לאביב."',
  },
  {
    book: 2,
    map: 'ashkelon',
    title: 'לאסוף את השברים',
    intro: 'הצוות התפזר: נועה בצפון העיר, המתנדבים ליד הים, ורחל בדרך מבאר שבע. אספו אותם אחד־אחד ותנו יד – שרשרת אחת, לא שלוש.',
    goal: { type: 'rescue', allies: ['נועה', 'המתנדבים', 'רחל'], kinds: ['place', 'square', 'park', 'station', 'sight'] },
    rivals: [
      ['likud', 'giant', 0.6, 300],
      ['rz', 'raider', 0.6, 60],
      ['otzma', 'hunter', 0.55, 70],
    ],
    hunters: 2,
    grace: 10,
    obstacles: { bars: 7, buses: 2, storms: 1 },
    time: 270,
    par: 100,
    bonus: { type: 'people', n: 100 },
    seats: [
      ['likud', 1],
      ['rz', 1],
    ],
    outro: 'כשהמעגל נסגר, מישהו התחיל לשיר. אף אחד לא זוכר מי. עד הבוקר השיר היה בכל הטלפונים.',
  },
  {
    book: 2,
    map: 'rishon-lezion',
    title: 'האביב',
    intro: 'סקר חדש: עלייה ראשונה מאז החורף. עכשיו או לעולם לא – שרשרת של 200 אנשים, מול שלוש יריבות שלא מתכוונות לוותר.',
    goal: { type: 'gather', n: 200 },
    rivals: [
      ['beyachad', 'hunter', 0.65, 100],
      ['yashar', 'giant', 0.6, 340],
      ['democrats', 'raider', 0.6, 80],
    ],
    hunters: 2,
    surge: { at: 60, add: 1 },
    grace: 12,
    obstacles: { bars: 8, buses: 3, storms: 1 },
    time: 300,
    par: 120,
    bonus: { type: 'cut', n: 2 },
    seats: [
      ['beyachad', 2],
      ['yashar', 1],
    ],
    outro: '{seats} מנדטים בסקר. בפעם הראשונה השאלה באולפנים היא לא "האם תעברו", אלא "כמה".',
  },
  {
    book: 3,
    map: 'israel',
    title: 'צפונה',
    intro: 'מהכרמל ועד הגליל: ארבע ערים, ארבע עצרות, ושרשרת אחת שלא עוצרת. חיפה, נהריה, כרמיאל וצפת – לפי הסדר.',
    start: 'נתניה',
    goal: { type: 'tour', k: 4, names: ['חיפה', 'נהריה', 'כרמיאל', 'צפת'], kinds: ['city'] },
    rivals: [
      ['ybeytenu', 'hunter', 0.65, 110],
      ['beyachad', 'hunter', 0.7, 110],
      ['likud', 'giant', 0.6, 320],
    ],
    hunters: 2,
    grace: 6,
    obstacles: { storms: 2, trains: 1 },
    time: 120,
    par: 45,
    bonus: { type: 'people', n: 120 },
    seats: [
      ['ybeytenu', 1],
      ['beyachad', 1],
      ['likud', 1],
    ],
    outro: 'בכל עיר חיכה מישהו עם דגל. אף אחד לא ביקש מהם. הם פשוט באו.',
  },
  {
    book: 3,
    map: 'israel',
    title: 'דרומה',
    intro: 'בנגב אומרים שהמרחקים גדולים מדי. תוכיחו שזה לא נכון: אשקלון, באר שבע, דימונה ואילת – מהים ועד המפרץ.',
    start: 'קריית גת',
    goal: { type: 'tour', k: 4, names: ['אשקלון', 'באר שבע', 'דימונה', 'אילת'], kinds: ['city'] },
    rivals: [
      ['likud', 'giant', 0.7, 340],
      ['otzma', 'raider', 0.7, 90],
      ['yashar', 'giant', 0.65, 340],
    ],
    hunters: 3,
    grace: 6,
    obstacles: { storms: 3, trains: 1 },
    time: 200,
    par: 70,
    bonus: { type: 'cut', n: 1 },
    seats: [
      ['likud', 2],
      ['otzma', 1],
    ],
    outro: 'באילת, בחצות, רחל ונועה נפגשו בפעם הראשונה. "את הנכדה שלא הייתה לי," אמרה רחל. נועה צחקה, ואז בכתה.',
  },
  {
    book: 3,
    map: 'tel-aviv',
    title: 'העימות',
    intro: 'ערב העימות הגדול. שתי המפלגות הגדולות בטוחות שזה מאבק בין שתיים. הראו שיש שלוש: תנו לשתי שרשראות יריבות להיתקל בשרשרת שלכם.',
    goal: { type: 'cut', n: 2 },
    mass: 50,
    rivals: [
      ['yashar', 'giant', 0.65, 420],
      ['likud', 'giant', 0.65, 380],
      ['beyachad', 'hunter', 0.6, 120],
    ],
    hunters: 3,
    grace: 8,
    obstacles: { bars: 8, buses: 3, storms: 1 },
    time: 240,
    par: 110,
    bonus: { type: 'people', n: 150 },
    seats: [
      ['yashar', 2],
      ['likud', 2],
    ],
    outro: 'למחרת כל הכותרות עסקו באותו רגע. אבי לא אמר מילה. הוא רק שלח צילום מסך של הסקר: {seats}.',
  },
  {
    book: 4,
    map: 'israel',
    title: 'הקלפיות נפתחות',
    intro: '300 אנשים עד שהקלפיות נסגרות, וכל היריבות יודעות את זה. זו הריצה האחרונה.',
    goal: { type: 'gather', n: 300 },
    mass: 50,
    rivals: [
      ['yashar', 'giant', 0.8, 420],
      ['likud', 'giant', 0.8, 400],
      ['beyachad', 'hunter', 0.75, 130],
      ['democrats', 'hunter', 0.7, 110],
      ['ybeytenu', 'hunter', 0.7, 110],
      ['otzma', 'raider', 0.7, 100],
    ],
    hunters: 3,
    surge: { at: 60, add: 1 },
    grace: 10,
    obstacles: { storms: 3, trains: 2 },
    time: 240,
    par: 90,
    bonus: { type: 'cut', n: 2 },
    seats: [
      ['yashar', 3],
      ['likud', 2],
      ['beyachad', 1],
      ['democrats', 1],
    ],
    outro: '22:00. כל הערוצים עוברים למסך אחד. ספירה לאחור. ואז – המדגם.',
  },
];

export const EPILOGUE =
  'המדגם: {party} – {seats} מנדטים. המפלגה הגדולה ביותר.\n' +
  'מאחוז אחד ושנים־עשר אנשים ברחוב בעפולה – לשרשרת הארוכה בארץ. נועה בוכה, רחל מחבקת את כולם, ואבי, בפעם הראשונה בעשרים שנה, לא אומר כלום.\n' +
  'שבועיים אחר כך, הנשיא מטיל עליכם להרכיב את הממשלה.';

// ------------------------------------------------------------------------------------------------ the seats
const KEY = 'chain:campaign';

export function newCampaign() {
  const seats = { ours: 0, undecided: UNDECIDED };
  for (const p of [...RIVALS, ...OTHERS]) seats[p.id] = p.seats;
  return { v: 1, next: 0, seats, stars: [], perks: [], booksOpened: [], pending: 'book', last: null };
}
export function loadCampaign() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p?.v === 1 && Number.isInteger(p.next) && p.seats && Array.isArray(p.stars)) return p;
  } catch {
    /* storage unavailable */
  }
  return newCampaign();
}
export function saveCampaign(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

export function partyOf(id) {
  return RIVALS.find((p) => p.id === id) ?? OTHERS.find((p) => p.id === id) ?? null;
}
export function fill(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** The Knesset now: [{ id, name, seats, color (index or null), ours, other }], biggest first; undecided last. */
export function knesset(state, party = 'עמך ישראל') {
  const rows = [{ id: 'ours', name: party, seats: state.seats.ours, color: OURS, ours: true }];
  for (const p of RIVALS) if (state.seats[p.id] > 0) rows.push({ id: p.id, name: p.name, seats: state.seats[p.id], color: p.color });
  for (const p of OTHERS) rows.push({ id: p.id, name: p.name, seats: state.seats[p.id], color: null, other: true });
  rows.sort((a, b) => b.seats - a.seats || (a.ours ? -1 : b.ours ? 1 : 0));
  if (state.seats.undecided > 0) rows.push({ id: 'undecided', name: 'מתלבטים', seats: state.seats.undecided, color: null, undecided: true });
  return rows;
}
/** Under the threshold a party gets no seats: its would-be seats wait with the undecided. */
export function oursShown(state) {
  return state.seats.ours >= THRESHOLD ? state.seats.ours : 0;
}
export function biggestRival(state) {
  let best = null;
  for (const p of [...RIVALS, ...OTHERS]) if (!best || state.seats[p.id] > state.seats[best.id]) best = p;
  return best ? { ...best, seats: state.seats[best.id] } : null;
}

/** Moves n seats to us from `from` (never below the threshold for a party in the Knesset: then from the biggest). */
function take(state, from, n, gains) {
  for (let k = 0; k < n; k++) {
    let src = from;
    const floor = src === 'undecided' ? 0 : THRESHOLD;
    if (!(state.seats[src] > floor)) {
      src = null;
      for (const p of RIVALS) if (state.seats[p.id] > THRESHOLD && (!src || state.seats[p.id] > state.seats[src])) src = p.id;
      if (!src) return;
    }
    state.seats[src] -= 1;
    state.seats.ours += 1;
    const g = gains.find((x) => x.from === src);
    if (g) g.n += 1;
    else gains.push({ from: src, n: 1 });
  }
}

/** Opens a book: its seat event, once. Returns [{ to, n }] (seats we lost). */
export function openBook(state, book) {
  if (state.booksOpened.includes(book)) return [];
  state.booksOpened.push(book);
  const lost = [];
  for (const { to, n } of BOOKS[book]?.event || []) {
    const k = Math.min(n, Math.max(0, state.seats.ours - THRESHOLD));
    state.seats.ours -= k;
    state.seats[to] += k;
    if (k) lost.push({ to, n: k });
  }
  return lost;
}

/** A chapter won: its seats (plus one for three stars), the stars kept, and what comes next. Returns the gains. */
export function winChapter(state, index, stars) {
  const ch = CHAPTERS[index];
  const gains = [];
  if (index !== state.next) return gains;
  for (const [from, n] of ch.seats) take(state, from, n, gains);
  // Three stars: one seat more from the chapter's main rival (not in the first book: the threshold comes when it comes).
  if (stars >= 3 && ch.seats[0][0] !== 'undecided') take(state, ch.seats[0][0], 1, gains);
  state.stars[index] = Math.max(state.stars[index] || 0, stars);
  state.next = index + 1;
  const nextCh = CHAPTERS[state.next];
  const round = ch.book;
  state.pending = !nextCh ? 'end' : nextCh.book !== ch.book ? (PERK_ROUNDS[round] ? 'perks' : 'book') : null;
  state.last = { index, stars, gains };
  return gains;
}
export function choosePerk(state, id) {
  if (!state.perks.includes(id)) state.perks.push(id);
  state.pending = 'book';
}

/** How a chapter's perks change the player's chain. */
export function perkMods(perks) {
  const has = (id) => perks.includes(id);
  const mods = {};
  if (has('field')) mods.reach = 26;
  if (has('stamina')) mods.boost = 0.5;
  if (has('momentum')) mods.speed = 1.1;
  if (has('echo')) mods.value = 1.25;
  if (has('agile')) mods.turn = 1.25;
  return { mods: Object.keys(mods).length ? mods : null, shield: has('shield') ? 1 : 0, extra: has('volunteers') ? 15 : 0 };
}

/** The three stars of a chapter, as text. */
export function starTexts(ch) {
  const out = ['⭐ לסיים את המשימה'];
  if (ch.goal.type === 'survive') out.push(`⭐ לסיים עם ${ch.goal.min * 2} אנשים לפחות`);
  else out.push(`⭐ תוך ${mmss(ch.par)}`);
  const b = ch.bonus;
  out.push(
    b.type === 'hands'
      ? '⭐ לתת יד לרשימה מקומית'
      : b.type === 'cut'
        ? `⭐ ${b.n === 1 ? 'שרשרת יריבה אחת נתקלת' : `${b.n} שרשראות יריבות נתקלות`} בשרשרת שלכם`
        : `⭐ לסיים עם ${b.n} אנשים לפחות`,
  );
  return out;
}
export function goalText(ch) {
  const g = ch.goal;
  switch (g.type) {
    case 'gather':
      return `אספו ${g.n} אנשים לשרשרת`;
    case 'tour':
      return g.names ? `עברו ב${g.names.join(', ')} – לפי הסדר` : `עברו ב־${g.k} מקומות, לפי הסדר`;
    case 'flags':
      return `תלו ${g.k} דגלים`;
    case 'hold':
      return `החזיקו בכיכר ${g.secs} שניות עם ${g.n} אנשים לפחות`;
    case 'first':
      return `הגיעו ראשונים ל־${g.n} אנשים`;
    case 'rescue':
      return `תנו יד ל${g.allies.join(', ')}`;
    case 'survive':
      return `שרדו ${g.secs} שניות, עם ${g.min} אנשים לפחות`;
    case 'cut':
      return `${g.n} שרשראות יריבות נתקלות בשרשרת שלכם`;
    default:
      return '';
  }
}
export function mmss(secs) {
  const s = Math.max(0, Math.ceil(secs));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} שנ׳`;
}

// ------------------------------------------------------------------------------------------------ obstacles
/**
 * Roadworks across streets, buses on long roads, trains on the railways and storms drifting across the map, away
 * from the places in `avoid` ([{ x, y, r }]).
 */
export function makeObstacles(map, spec = {}, rand = Math.random, avoid = []) {
  const data = map?.data || {};
  const inside = map?.arena?.inside || (() => true);
  const R = map?.R || C.arenaRadius;
  const region = data.kind === 'region';
  const roads = data.roads || [];
  const clear = (x, y, r = 0) => inside(x, y) && avoid.every((a) => Math.hypot(a.x - x, a.y - y) > a.r + r);
  const bars = [];
  const movers = [];
  const zones = [];
  const lines = (list) => (list || []).filter((l) => Array.isArray(l) && l.length >= 4);
  // Roadworks: a barrier across a street (70 wide), apart from each other.
  const streets = spec.bars ? [...lines(roads[2]), ...lines(roads[1]), ...lines(roads[0])] : [];
  for (let tries = 0; bars.length < (spec.bars || 0) && tries < 400 && streets.length; tries++) {
    const l = streets[Math.floor(rand() * streets.length)];
    const i = 2 * Math.floor(rand() * (l.length / 2 - 1));
    const [x0, y0, x1, y1] = [l[i], l[i + 1], l[i + 2], l[i + 3]];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 50) continue;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    if (!clear(mx, my, 60) || bars.some((b) => Math.hypot(b.x - mx, b.y - my) < 420)) continue;
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    bars.push({ x: mx, y: my, x1: mx - nx * 36, y1: my - ny * 36, x2: mx + nx * 36, y2: my + ny * 36, w: 14, label: 'roadworks' });
  }
  // Buses (and trains): along a long line, clipped to about 1600 units of it.
  const runOn = (pool, count, label, half, r, speed) => {
    const long = pool
      .map((l) => ({ l, len: lineLength(l) }))
      .filter((o) => o.len > 700)
      .sort((a, b) => b.len - a.len)
      .slice(0, 40);
    for (let tries = 0; count > 0 && tries < 60 && long.length; tries++) {
      const { l } = long[Math.floor(rand() * long.length)];
      const pts = clipLine(l, 1600, rand);
      const cut = [];
      for (let k = 0; k + 1 < pts.length; k += 2) if (inside(pts[k], pts[k + 1])) cut.push(pts[k], pts[k + 1]);
      if (cut.length < 4 || lineLength(cut) < 500) continue;
      if (avoid.some((a) => nearLine(cut, a.x, a.y, a.r * 0.7))) continue;
      movers.push({ pts: cut, speed, half, r, phase: rand() * 4000, label });
      count--;
    }
  };
  if (spec.buses) runOn(joinLines([...lines(roads[0]), ...lines(roads[1])]), spec.buses, 'bus', 22, 10, 105 + rand() * 40);
  if (spec.trains) runOn(joinLines(lines(data.rail)), spec.trains, 'train', region ? 70 : 48, region ? 14 : 11, region ? 240 : 170);
  // Storms: a slow drift between two places, back and forth.
  for (let tries = 0; zones.length < (spec.storms || 0) && tries < 200; tries++) {
    const a = randomInside(inside, R, rand);
    const b = randomInside(inside, R, rand);
    if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) < R * 0.35) continue;
    if (avoid.some((p) => p.start && Math.hypot(p.x - a.x, p.y - a.y) < 900)) continue;
    zones.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, period: 50 + rand() * 40, r: region ? 520 + rand() * 200 : 330 + rand() * 150, slow: 0.55, label: 'storm' });
  }
  return { bars, movers, zones };
}
/** Joins lines that meet end to end (the map stores roads and railways in short pieces) into long ones. */
export function joinLines(list, tol = 4) {
  const key = (x, y) => Math.round(x / tol) * 100003 + Math.round(y / tol);
  const reverse = (l) => {
    const out = [];
    for (let i = l.length - 2; i >= 0; i -= 2) out.push(l[i], l[i + 1]);
    return out;
  };
  const at = new Map();
  const add = (k, i) => {
    let a = at.get(k);
    if (!a) at.set(k, (a = []));
    a.push(i);
  };
  list.forEach((l, i) => {
    add(key(l[0], l[1]), i);
    add(key(l[l.length - 2], l[l.length - 1]), i);
  });
  const used = new Uint8Array(list.length);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let pts = list[i].slice();
    for (const flip of [false, true]) {
      if (flip) pts = reverse(pts);
      for (;;) {
        const k = key(pts[pts.length - 2], pts[pts.length - 1]);
        const next = (at.get(k) || []).filter((j) => !used[j]);
        if (!next.length) break; // the end of the line
        // At a junction: the way that goes on most nearly straight (a main line, not a siding).
        const n = pts.length;
        const dir = Math.atan2(pts[n - 1] - pts[n - 3], pts[n - 2] - pts[n - 4]);
        let pick = null;
        let turn = 1.1;
        for (const j of next) {
          const l = key(list[j][0], list[j][1]) === k ? list[j] : reverse(list[j]);
          const d = Math.abs(Math.atan2(Math.sin(Math.atan2(l[3] - l[1], l[2] - l[0]) - dir), Math.cos(Math.atan2(l[3] - l[1], l[2] - l[0]) - dir)));
          if (d < turn) {
            turn = d;
            pick = { j, l };
          }
        }
        if (!pick) break;
        used[pick.j] = 1;
        for (let m = 2; m < pick.l.length; m++) pts.push(pick.l[m]);
      }
    }
    out.push(pts);
  }
  return out;
}
/** Where a chapter's chain starts: by a named place on the map (ch.start), or null (anywhere safe). */
export function startPoint(ch, map) {
  if (!ch.start) return null;
  const hit = (map?.data?.pois || []).find((p) => p[3] === ch.start);
  return hit ? { x: hit[0], y: hit[1] } : null;
}
function lineLength(l) {
  let n = 0;
  for (let i = 2; i < l.length; i += 2) n += Math.hypot(l[i] - l[i - 2], l[i + 1] - l[i - 1]);
  return n;
}
function clipLine(l, max, rand) {
  const total = lineLength(l);
  if (total <= max) return l.slice();
  const start = rand() * (total - max);
  const out = [];
  let d = 0;
  for (let i = 2; i < l.length; i += 2) {
    const seg = Math.hypot(l[i] - l[i - 2], l[i + 1] - l[i - 1]);
    if (d + seg >= start && d <= start + max) {
      if (!out.length) out.push(l[i - 2], l[i - 1]);
      out.push(l[i], l[i + 1]);
    }
    d += seg;
  }
  return out;
}
function nearLine(l, x, y, r) {
  for (let i = 0; i < l.length; i += 2) if (Math.hypot(l[i] - x, l[i + 1] - y) < r) return true;
  return false;
}
function randomInside(inside, R, rand) {
  for (let k = 0; k < 60; k++) {
    const x = (rand() * 2 - 1) * R * 0.8;
    const y = (rand() * 2 - 1) * R * 0.8;
    if (inside(x, y)) return { x, y };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ a chapter, running
/**
 * Starts chapter `ch` in `world` (already made for `map`, with the player's chain `playerId` in it): the rivals, the
 * local lists and allies, the obstacles, and the goal. Returns { targets, update(dt) → status, event(e), hunting }.
 * status: { done, failed, why, text, progress, left, stars, warn: [text] }.
 */
export function startChapter(ch, map, world, { playerId, perks = [], rand = Math.random } = {}) {
  const g = ch.goal;
  const me = () => world.snakes.get(playerId);
  const player = me();
  const inside = map?.arena?.inside || world.inside;
  // Places the goal needs.
  const want = { tour: g.k || 3, flags: g.k || 3, hold: 1, rescue: g.allies?.length || 0 }[g.type] || 0;
  let places = want ? pickPlaces(map, g, want + (g.type === 'rescue' ? 3 : 0), rand) : [];
  if (g.type === 'rescue' && player) {
    // The friends wait far from where the chain starts, and apart from each other.
    places.sort((a, b) => Math.hypot(b.x - player.x, b.y - player.y) - Math.hypot(a.x - player.x, a.y - player.y));
    places = places.slice(0, want);
  }
  const targets = g.type === 'rescue' ? [] : places.map((p) => ({ ...p, done: false, active: false }));
  const avoid = [...places.map((p) => ({ x: p.x, y: p.y, r: 160 })), ...(player ? [{ x: player.x, y: player.y, r: 480, start: true }] : [])];
  world.setObstacles(makeObstacles(map, ch.obstacles, rand, avoid));

  // Rivals: far from the player, each with its role; they come back a while after they are cut.
  const rivals = [];
  const farPoint = () => {
    let best = null;
    let bestD = -1;
    for (let k = 0; k < 14; k++) {
      const p = world.somewhere(0.7);
      let near = Infinity;
      for (const o of world.snakes.values()) if (o.alive) near = Math.min(near, Math.hypot(o.x - p.x, o.y - p.y));
      if (world.blocked(p.x, p.y, 60)) continue;
      if (near > bestD) {
        bestD = near;
        best = p;
      }
    }
    return best ?? world.somewhere(0.7);
  };
  const spawnRival = (r, mass) => {
    const party = RIVALS.find((p) => p.id === r.party);
    const at = farPoint();
    const s = world.addSnake({
      name: party?.name ?? r.party,
      color: party?.color ?? 1,
      bot: true,
      mass,
      at,
      ai: { role: r.role, skill: r.skill, accept: 0, friendly: false, home: { x: at.x, y: at.y }, party: r.party },
      mods: ch.rivalMods ?? null,
    });
    r.id = s.id;
    r.dead = false;
    return s;
  };
  for (const [party, role, skill, mass] of ch.rivals || []) {
    const r = { party, role, skill, mass, id: 0, dead: false, back: 0 };
    rivals.push(r);
    spawnRival(r, mass);
  }
  // Local lists: friendly chains to hold hands with.
  const locals = [];
  // (Friends to rescue fill the hands a chain can hold: no partner from the start then.)
  const partnerPerk = perks.includes('allies') && g.type !== 'rescue';
  const localCount = (ch.locals || 0) + (partnerPerk ? 1 : 0);
  for (let i = 0; i < localCount; i++) {
    const s = world.addSnake({ name: LOCAL_LISTS[(i + Math.floor(rand() * 6)) % LOCAL_LISTS.length], color: ALLY_COLOR, bot: true, mass: 22 + rand() * 18, ai: { friendly: true, accept: 0.95 } });
    locals.push(s.id);
  }
  if (partnerPerk && player && locals.length) {
    // The partner starts beside you, holding your hand.
    const s = world.snakes.get(locals[locals.length - 1]);
    world.removeSnake(s.id);
    const a = player.a + Math.PI * 0.75;
    const partner = world.addSnake({
      name: s.name,
      color: ALLY_COLOR,
      bot: true,
      mass: 24,
      at: { x: player.x + Math.cos(a) * 90, y: player.y + Math.sin(a) * 90, a: player.a },
      ai: { role: 'ally', follow: playerId, accept: 1, friendly: true, skill: 0.6 },
      shield: 1,
    });
    locals[locals.length - 1] = partner.id;
    world.link(player, partner);
  }
  // Friends to rescue (the story's people): waiting at their places.
  const allies = [];
  if (g.type === 'rescue') {
    g.allies.forEach((name, i) => {
      const p = places[i] ?? world.somewhere(0.7);
      const s = world.addSnake({
        name,
        color: ALLY_COLOR,
        bot: true,
        mass: 20,
        at: { x: p.x, y: p.y },
        ai: { role: 'ally', home: { x: p.x, y: p.y }, follow: playerId, accept: 1, friendly: true, skill: 0.6 },
        shield: 1,
      });
      allies.push({ id: s.id, name, place: p.name, linked: false });
      targets.push({ x: p.x, y: p.y, name, done: false, active: true, follow: s.id });
    });
  }

  let clock = 0;
  let held = 0;
  let next = 0;
  let hands = false;
  let cuts = 0;
  let failed = '';
  let finished = null;
  let beat = 0;
  const warn = [];
  const near = (s, t, r) => s && Math.hypot(s.x - t.x, s.y - t.y) < r;
  const rivalOf = (id) => rivals.find((r) => r.id === id);

  /** The director: after the grace period, sends up to `hunters` rivals after the player (or a friend in trouble). */
  function direct() {
    const now = clock;
    const max = (ch.hunters || 0) + (ch.surge && now >= ch.surge.at ? ch.surge.add : 0);
    let active = 0;
    for (const r of rivals) {
      const s = world.snakes.get(r.id);
      if (!s?.alive) continue;
      const ai = s.ai;
      if (ai.hunting) {
        const prey = world.snakes.get(ai.target);
        if (now > ai.until || !prey?.alive || world.sameTeam(s, prey)) {
          ai.hunting = false;
          ai.rest = now + 3 + rand() * 4;
        } else active++;
      }
      // Guards stand by the goal: the next flag, the square.
      if (r.role === 'guard') {
        const t = targets.find((x) => !x.done) ?? targets[0];
        ai.guard = t ? { x: t.x, y: t.y } : null;
        ai.phase ??= rand() * 6;
      }
    }
    if (now < (ch.grace ?? 0)) return;
    const p = me();
    if (!p?.alive) return;
    const free = allies.filter((a) => !a.linked).map((a) => world.snakes.get(a.id)).filter((s) => s?.alive);
    let flank = 0;
    while (active < max) {
      let pick = null;
      let pickD = Infinity;
      for (const r of rivals) {
        const s = world.snakes.get(r.id);
        if (!s?.alive || s.ai.hunting || now < (s.ai.rest ?? 0)) continue;
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < pickD) {
          pickD = d;
          pick = s;
        }
      }
      if (!pick) break;
      // A friend waiting alone is the easier prey, some of the time.
      const prey = free.length && rand() < 0.4 ? free[Math.floor(rand() * free.length)] : p;
      pick.ai.hunting = true;
      pick.ai.target = prey.id;
      pick.ai.until = now + 12 + rand() * 9;
      pick.ai.flank = active === 0 ? 0 : flank++ % 2 ? -1 : 1;
      active++;
      warn.push(prey === p ? `⚠️ ${pick.name} יוצאת לחסום אתכם` : `⚠️ ${pick.name} סוגרת על ${prey.name}!`);
    }
  }

  function starsNow(p) {
    const score = p ? scoreOf(p.mass) : 0;
    let stars = 1;
    if (g.type === 'survive' ? score >= g.min * 2 : clock <= ch.par) stars++;
    const b = ch.bonus;
    const bonus = b.type === 'hands' ? hands : b.type === 'cut' ? cuts >= b.n : score >= b.n;
    if (bonus) stars++;
    return stars;
  }

  return {
    chapter: ch,
    targets,
    rivals,
    allies,
    /** World events, before the client clears them: cuts, deaths of friends, respawns. */
    event(e) {
      if (e.t === 'death') {
        const r = rivalOf(e.id);
        if (r) {
          r.dead = true;
          r.back = clock + 9;
          if (e.killer === playerId) cuts++;
        }
        const a = allies.find((x) => x.id === e.id);
        if (a && !a.linked) failed = `השרשרת של ${a.name} נקרעה`;
      } else if (e.t === 'link' && (e.a === playerId || e.b === playerId)) {
        hands = true;
        const other = e.a === playerId ? e.b : e.a;
        const a = allies.find((x) => x.id === other);
        if (a) a.linked = true;
      }
    },
    update(dt) {
      clock += dt;
      warn.length = 0;
      const p = me();
      const score = p?.alive ? scoreOf(p.mass) : 0;
      // Rivals come back.
      for (const r of rivals) if (r.dead && clock >= r.back) spawnRival(r, Math.max(30, r.mass * 0.6));
      beat -= dt;
      if (beat <= 0) {
        beat = 0.5;
        direct();
      }
      // Friends hold hands the moment you reach them.
      for (const a of allies) {
        if (a.linked || !p?.alive) continue;
        const s = world.snakes.get(a.id);
        if (s?.alive && Math.hypot(s.x - p.x, s.y - p.y) < 150 + radiusFor(p.mass)) {
          if (world.link(p, s)) a.linked = true;
        }
      }
      for (const t of targets) {
        if (t.follow) {
          const s = world.snakes.get(t.follow);
          if (s?.alive) {
            t.x = s.x;
            t.y = s.y;
          }
          t.done = allies.find((a) => a.id === t.follow)?.linked ?? false;
          t.active = !t.done;
        }
      }
      const res = { done: false, failed: false, why: '', text: '', progress: 0, left: ch.time ? ch.time - clock : 0, stars: 1, warn: warn.slice() };
      switch (g.type) {
        case 'gather':
          res.progress = Math.min(1, score / g.n);
          res.text = `${Math.min(score, g.n)}/${g.n} אנשים`;
          res.done = score >= g.n;
          break;
        case 'flags': {
          let n = 0;
          for (const t of targets) {
            t.active = !t.done;
            if (!t.done && near(p, t, 95)) t.done = true;
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
          if (t && near(p, t, g.names ? 170 : 100)) {
            t.done = true;
            next++;
          }
          res.text = next < targets.length ? `${next + 1}/${targets.length}: ${targets[next].name}` : '';
          res.progress = targets.length ? next / targets.length : 1;
          res.done = next >= targets.length;
          break;
        }
        case 'hold': {
          const t = targets[0];
          if (!t) {
            res.done = true;
            break;
          }
          t.active = true;
          const there = near(p, t, 160);
          if (there && score >= g.n) held += dt;
          else held = Math.max(0, held - dt * 0.5);
          res.progress = Math.min(1, held / g.secs);
          res.text = score < g.n ? `${score}/${g.n} אנשים, ואז ל${t.name}` : there ? `מחזיקים! עוד ${Math.ceil(Math.max(0, g.secs - held))} שנ׳` : `ל${t.name}`;
          res.done = held >= g.secs;
          break;
        }
        case 'first': {
          let lead = null;
          for (const r of rivals) {
            if (!g.vs.includes(r.party)) continue;
            const s = world.snakes.get(r.id);
            const sc = s?.alive ? scoreOf(s.mass) : 0;
            if (!lead || sc > lead.score) lead = { name: s?.name ?? partyOf(r.party)?.name, score: sc };
          }
          res.progress = Math.min(1, score / g.n);
          res.text = `${Math.min(score, g.n)}/${g.n}${lead ? ` · ${lead.name}: ${Math.min(lead.score, g.n)}` : ''}`;
          res.done = score >= g.n;
          if (!res.done && lead && lead.score >= g.n) failed = `${lead.name} הגיעה ראשונה ל־${g.n}`;
          break;
        }
        case 'rescue': {
          const n = allies.filter((a) => a.linked).length;
          const waiting = allies.find((a) => !a.linked);
          res.text = waiting ? `${n}/${allies.length} · ל${waiting.name}` : '';
          res.progress = allies.length ? n / allies.length : 1;
          res.done = n === allies.length;
          break;
        }
        case 'survive': {
          const left = g.secs - clock;
          res.left = left;
          res.progress = Math.min(1, clock / g.secs);
          res.text = score < g.min ? `⚠️ ${score}/${g.min} אנשים – אספו עוד!` : `שורדים: עוד ${mmss(left)} · ${score} אנשים`;
          if (left <= 0) {
            if (score >= g.min) res.done = true;
            else failed = `נשארו רק ${score} אנשים מתוך ${g.min}`;
          }
          break;
        }
        case 'cut':
          res.progress = Math.min(1, cuts / g.n);
          res.text = `${Math.min(cuts, g.n)}/${g.n} שרשראות נתקלו בכם`;
          res.done = cuts >= g.n;
          break;
        default:
          res.done = true;
      }
      if (!res.done && ch.time && g.type !== 'survive' && clock >= ch.time) failed ||= 'נגמר הזמן';
      if (res.done && !finished) finished = { stars: starsNow(p), time: clock, score };
      res.stars = finished ? finished.stars : starsNow(p);
      if (failed && !res.done) {
        res.failed = true;
        res.why = failed;
      }
      return res;
    },
    get cuts() {
      return cuts;
    },
    get clock() {
      return clock;
    },
  };
}

/**
 * Sends story bots (those with an ai.role) after people, a few at a time: online rooms use it. After a snake has
 * been around for `grace` seconds it may be hunted (prey(s) says who may be), by at most `max` bots at once, each
 * for 12–21 seconds and then a rest. update(dt) returns the hunts that started: [{ hunter, prey }] (ids).
 */
export function huntDirector(world, { max = () => 1, grace = 20, prey = (s) => !s.bot, rand = Math.random } = {}) {
  let clock = 0;
  let beat = 0;
  const hunters = (s) => s.alive && s.ai?.role && s.ai.role !== 'ally';
  return {
    update(dt) {
      clock += dt;
      beat -= dt;
      if (beat > 0) return [];
      beat = 0.5;
      const started = [];
      let active = 0;
      for (const s of world.snakes.values()) {
        if (!hunters(s)) continue;
        const ai = s.ai;
        if (!ai.hunting) continue;
        const p = world.snakes.get(ai.target);
        if (clock > ai.until || !p?.alive) {
          ai.hunting = false;
          ai.rest = clock + 4 + rand() * 6;
        } else active++;
      }
      const targets = [...world.snakes.values()].filter((s) => s.alive && prey(s) && world.time - s.born >= grace);
      const most = typeof max === 'function' ? max(targets.length) : max;
      while (targets.length && active < most) {
        let pick = null;
        let target = null;
        let best = 1600; // only bots that are not too far away
        for (const s of world.snakes.values()) {
          if (!hunters(s) || s.ai.hunting || clock < (s.ai.rest ?? 0)) continue;
          for (const t of targets) {
            const d = Math.hypot(s.x - t.x, s.y - t.y);
            if (d < best) {
              best = d;
              pick = s;
              target = t;
            }
          }
        }
        if (!pick) break;
        pick.ai.hunting = true;
        pick.ai.target = target.id;
        pick.ai.until = clock + 12 + rand() * 9;
        pick.ai.flank = active === 0 ? 0 : active % 2 ? 1 : -1;
        active++;
        started.push({ hunter: pick.id, prey: target.id });
      }
      return started;
    },
  };
}

/**
 * Free play alone (no server): the rival parties roam the map, and now and then one or two come after you.
 * Returns the same shape as startChapter (no goal: never done).
 */
export function startSkirmish(map, world, { playerId, rand = Math.random } = {}) {
  const pool = RIVALS.filter((p) => p.seats > 0);
  const chosen = [];
  while (chosen.length < 5 && pool.length) chosen.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  const ch = {
    goal: { type: 'none' },
    rivals: chosen.map((p, i) => [p.id, i === 0 ? 'giant' : i < 3 ? 'hunter' : 'raider', 0.35 + rand() * 0.2, i === 0 ? 260 : 40 + rand() * 50]),
    hunters: 1,
    surge: { at: 90, add: 1 },
    grace: 30,
    locals: 1,
    obstacles: {},
    bonus: { type: 'hands' },
    par: 0,
  };
  const run = startChapter(ch, map, world, { playerId, rand });
  const update = run.update;
  run.update = (dt) => ({ ...update(dt), done: false, failed: false, text: '' });
  return run;
}

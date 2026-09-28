// Ch-ch-chain-ges — skins: the face the leader of your chain wears, drawn big (a bobblehead on the paper-doll body).
// Sixteen original cartoon faces are drawn here; more can be added as pictures in docs/skins (see README.md) and
// are picked the same way, by name. The server only needs AVATAR_IDS, so nothing here touches the page on import.

const TONES = ['#f7dcc0', '#efc49c', '#dba471', '#b97d4e', '#8e5b3b', '#5f3b27'];
const HAIR = {
  black: '#1f1a17',
  dark: '#3b2a20',
  brown: '#6e4b2f',
  auburn: '#9a4322',
  blonde: '#d9a441',
  grey: '#a3a09b',
  pink: '#e5679f',
  blue: '#3f6fd8',
};

/** The original faces: id, label (for the picker), skin tone, hair style and colour, extras. */
export const AVATARS = [
  { id: 'a0', name: 'חיוך', tone: 1, hair: 'short', color: 'dark', extras: [] },
  { id: 'a1', name: 'תלתלים', tone: 3, hair: 'curly', color: 'black', extras: [] },
  { id: 'a2', name: 'פרח', tone: 0, hair: 'long', color: 'blonde', extras: ['flower'] },
  { id: 'a3', name: 'משקפיים', tone: 2, hair: 'bun', color: 'brown', extras: ['glasses'] },
  { id: 'a4', name: 'זקן', tone: 4, hair: 'bald', color: 'dark', extras: ['beard'] },
  { id: 'a5', name: 'מוהוק', tone: 1, hair: 'mohawk', color: 'blue', extras: [] },
  { id: 'a6', name: 'אפרו', tone: 5, hair: 'afro', color: 'black', extras: [] },
  { id: 'a7', name: 'קוקו', tone: 1, hair: 'ponytail', color: 'auburn', extras: [] },
  { id: 'a8', name: 'משקפי שמש', tone: 2, hair: 'side', color: 'black', extras: ['shades'] },
  { id: 'a9', name: 'שפם', tone: 0, hair: 'short', color: 'grey', extras: ['glasses', 'mustache'] },
  { id: 'a10', name: 'כובע', tone: 3, hair: 'buzz', color: 'dark', extras: ['cap'] },
  { id: 'a11', name: 'אוזניות', tone: 4, hair: 'long', color: 'black', extras: ['headphones'] },
  { id: 'a12', name: 'כובע צמר', tone: 1, hair: 'wavy', color: 'brown', extras: ['beanie'] },
  { id: 'a13', name: 'ג׳ינג׳י', tone: 0, hair: 'curly', color: 'auburn', extras: ['freckles'] },
  { id: 'a14', name: 'כיפה', tone: 2, hair: 'short', color: 'black', extras: ['kippah', 'beard'] },
  { id: 'a15', name: 'ורוד', tone: 1, hair: 'bun', color: 'pink', extras: ['shades'] },
];
export const AVATAR_IDS = AVATARS.map((a) => a.id);

const SIZE = 128;
const cache = new Map();
const supplied = new Map(); // id → { name, image: HTMLImageElement | null, url }

/** Pictures supplied in docs/skins/index.json ({ skins: [{ id, name, image }] }); loads their list once. */
export async function loadSuppliedSkins(base = 'skins/') {
  try {
    const res = await fetch(`${base}index.json`, { cache: 'no-cache' });
    if (!res.ok) return [];
    const list = (await res.json()).skins || [];
    const out = [];
    for (const s of list) {
      if (typeof s?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(s.id) || typeof s.image !== 'string') continue;
      if (!/^[a-z0-9-]+\.(png|jpg|webp|svg)$/.test(s.image)) continue;
      supplied.set(s.id, { name: String(s.name || s.id), image: null, url: `${base}${s.image}` });
      out.push({ id: s.id, name: String(s.name || s.id) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Everything a player can pick: [{ id, name }], the supplied pictures first. */
export function allSkins() {
  return [...[...supplied].map(([id, s]) => ({ id, name: s.name })), ...AVATARS.map(({ id, name }) => ({ id, name }))];
}
export function skinName(id) {
  return supplied.get(id)?.name ?? AVATARS.find((a) => a.id === id)?.name ?? '';
}

/** The face for a skin as a 128 × 128 canvas with a white cut-out edge, or null (unknown, or its picture is loading). */
export function avatar(id) {
  if (!id) return null;
  let c = cache.get(id);
  if (c) return c;
  const spec = AVATARS.find((a) => a.id === id);
  if (spec) c = drawFace(spec);
  else {
    const s = supplied.get(id);
    if (!s) return null;
    if (!s.image) {
      s.image = new Image();
      s.image.decoding = 'async';
      s.image.onload = () => cache.set(id, drawPicture(s.image));
      s.image.src = s.url;
    }
    return null;
  }
  cache.set(id, c);
  return c;
}

function roundRect(g, x, y, w, h, r) {
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

function canvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return c;
}

/** A picture cropped to a circle, with a white ring. */
function drawPicture(img) {
  const c = canvas();
  const g = c.getContext('2d');
  const r = SIZE / 2 - 5;
  g.save();
  g.beginPath();
  g.arc(SIZE / 2, SIZE / 2, r, 0, Math.PI * 2);
  g.clip();
  const k = Math.max((2 * r) / img.naturalWidth, (2 * r) / img.naturalHeight);
  const w = img.naturalWidth * k;
  const h = img.naturalHeight * k;
  g.drawImage(img, SIZE / 2 - w / 2, SIZE / 2 - h / 2, w, h);
  g.restore();
  g.lineWidth = 6;
  g.strokeStyle = '#ffffff';
  g.beginPath();
  g.arc(SIZE / 2, SIZE / 2, r, 0, Math.PI * 2);
  g.stroke();
  return c;
}

/** An original cartoon face, drawn once and then given a white sticker edge. */
function drawFace(spec) {
  const art = canvas();
  const g = art.getContext('2d');
  const tone = TONES[spec.tone] ?? TONES[1];
  const hair = HAIR[spec.color] ?? HAIR.dark;
  const has = (x) => spec.extras.includes(x);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const disc = (x, y, r, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  // Behind the head: long hair, afro, ponytail, bun.
  g.fillStyle = hair;
  if (spec.hair === 'long') {
    g.beginPath();
    g.moveTo(24, 60);
    g.quadraticCurveTo(22, 20, 64, 18);
    g.quadraticCurveTo(106, 20, 104, 60);
    g.lineTo(108, 118);
    g.quadraticCurveTo(64, 126, 20, 118);
    g.closePath();
    g.fill();
  } else if (spec.hair === 'afro') {
    disc(64, 56, 54, hair);
  } else if (spec.hair === 'ponytail') {
    g.beginPath();
    g.moveTo(96, 44);
    g.quadraticCurveTo(126, 60, 114, 104);
    g.quadraticCurveTo(104, 84, 90, 70);
    g.closePath();
    g.fill();
  } else if (spec.hair === 'bun') {
    disc(64, 20, 17, hair);
  }
  // Ears and face.
  disc(26, 72, 9, tone);
  disc(102, 72, 9, tone);
  g.fillStyle = tone;
  g.beginPath();
  g.ellipse(64, 70, 38, 42, 0, 0, Math.PI * 2);
  g.fill();
  if (has('beard')) {
    g.fillStyle = hair;
    g.beginPath();
    g.moveTo(27, 72);
    g.quadraticCurveTo(30, 118, 64, 118);
    g.quadraticCurveTo(98, 118, 101, 72);
    g.quadraticCurveTo(92, 92, 64, 94);
    g.quadraticCurveTo(36, 92, 27, 72);
    g.fill();
  }
  // Hair over the forehead.
  g.fillStyle = hair;
  const top = (fringeY, sides = 30) => {
    g.beginPath();
    g.moveTo(64 - 38, 70 - sides * 0.2);
    g.quadraticCurveTo(22, 24, 64, 24);
    g.quadraticCurveTo(106, 24, 102, 70 - sides * 0.2);
    g.quadraticCurveTo(96, fringeY - 6, 80, fringeY);
    g.quadraticCurveTo(64, fringeY + 6, 48, fringeY - 2);
    g.quadraticCurveTo(32, fringeY + 2, 26, 70 - sides * 0.2);
    g.closePath();
    g.fill();
  };
  switch (spec.hair) {
    case 'short':
    case 'bun':
    case 'ponytail':
      top(44);
      break;
    case 'buzz':
      g.beginPath();
      g.ellipse(64, 50, 36, 26, 0, Math.PI, 0);
      g.fill();
      break;
    case 'long':
    case 'wavy':
      top(46);
      if (spec.hair === 'wavy') for (const x of [30, 98]) disc(x, 58, 10, hair);
      break;
    case 'side':
      g.beginPath();
      g.moveTo(26, 62);
      g.quadraticCurveTo(22, 22, 66, 22);
      g.quadraticCurveTo(108, 24, 102, 64);
      g.quadraticCurveTo(90, 38, 40, 52);
      g.closePath();
      g.fill();
      break;
    case 'curly':
      for (let k = 0; k <= 10; k++) {
        const a = Math.PI + (k / 10) * Math.PI;
        disc(64 + Math.cos(a) * 36, 58 + Math.sin(a) * 32, 11, hair);
      }
      disc(64, 30, 14, hair);
      break;
    case 'afro':
      for (let k = 0; k <= 8; k++) {
        const a = Math.PI + (k / 8) * Math.PI;
        disc(64 + Math.cos(a) * 32, 52 + Math.sin(a) * 22, 10, hair);
      }
      break;
    case 'mohawk':
      for (let k = -2; k <= 2; k++) {
        g.beginPath();
        g.moveTo(56 + k * 3, 36 + Math.abs(k) * 4);
        g.lineTo(64 + k * 6, 6 + Math.abs(k) * 6);
        g.lineTo(72 + k * 3, 36 + Math.abs(k) * 4);
        g.closePath();
        g.fill();
      }
      break;
    default:
  }
  // Eyes, brows, cheeks, nose, mouth.
  const ink = '#2a211c';
  disc(50, 72, 4.6, ink);
  disc(78, 72, 4.6, ink);
  disc(51.5, 70.5, 1.4, '#ffffff');
  disc(79.5, 70.5, 1.4, '#ffffff');
  g.strokeStyle = spec.hair === 'bald' ? '#6b4a33' : hair;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(43, 62);
  g.quadraticCurveTo(50, 58, 56, 61);
  g.moveTo(72, 61);
  g.quadraticCurveTo(78, 58, 85, 62);
  g.stroke();
  g.globalAlpha = 0.35;
  disc(42, 84, 7, '#ff6f7a');
  disc(86, 84, 7, '#ff6f7a');
  g.globalAlpha = 1;
  if (has('freckles')) for (const [x, y] of [[38, 80], [44, 78], [41, 86], [84, 80], [90, 78], [87, 86]]) disc(x, y, 1.4, '#b0673a');
  g.strokeStyle = 'rgba(80, 50, 30, 0.45)';
  g.lineWidth = 2.4;
  g.beginPath();
  g.moveTo(64, 76);
  g.quadraticCurveTo(60, 84, 65, 85);
  g.stroke();
  if (has('mustache')) {
    g.fillStyle = hair;
    g.beginPath();
    g.moveTo(64, 90);
    g.quadraticCurveTo(50, 84, 44, 94);
    g.quadraticCurveTo(56, 92, 64, 94);
    g.quadraticCurveTo(72, 92, 84, 94);
    g.quadraticCurveTo(78, 84, 64, 90);
    g.fill();
  }
  g.strokeStyle = ink;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(64, 88, 11, 0.18 * Math.PI, 0.82 * Math.PI);
  g.stroke();
  // Extras.
  if (has('glasses') || has('shades')) {
    const dark = has('shades');
    g.lineWidth = 3;
    g.strokeStyle = ink;
    g.fillStyle = dark ? '#1b1d24' : 'rgba(255,255,255,0.18)';
    for (const x of [50, 78]) {
      g.beginPath();
      if (dark) roundRect(g, x - 12, 64, 24, 15, 5);
      else g.arc(x, 72, 10.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.beginPath();
    g.moveTo(60, 71);
    g.lineTo(68, 71);
    g.stroke();
  }
  if (has('cap')) {
    g.fillStyle = '#2f6fed';
    g.beginPath();
    g.ellipse(64, 44, 40, 24, 0, Math.PI, 0);
    g.fill();
    g.fillRect(24, 42, 80, 7);
    g.beginPath();
    g.ellipse(84, 48, 26, 6, 0, 0, Math.PI * 2);
    g.fill();
  }
  if (has('beanie')) {
    g.fillStyle = '#e5484d';
    g.beginPath();
    g.ellipse(64, 46, 40, 28, 0, Math.PI, 0);
    g.fill();
    g.fillStyle = '#c53a3f';
    g.fillRect(24, 40, 80, 10);
    disc(64, 16, 8, '#ffffff');
  }
  if (has('kippah')) {
    g.fillStyle = '#0038b8';
    g.beginPath();
    g.ellipse(64, 28, 20, 9, 0, Math.PI, 0);
    g.fill();
  }
  if (has('headphones')) {
    g.strokeStyle = '#2b2b33';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(64, 70, 44, Math.PI * 1.05, Math.PI * 1.95);
    g.stroke();
    for (const x of [22, 106]) {
      g.fillStyle = '#e93d82';
      g.beginPath();
      roundRect(g, x - 8, 62, 16, 24, 6);
      g.fill();
    }
  }
  if (has('flower')) {
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      disc(94 + Math.cos(a) * 7, 34 + Math.sin(a) * 7, 5.5, '#f59e0b');
    }
    disc(94, 34, 4.5, '#ffffff');
  }
  // The white sticker edge: the art stamped around itself in white, then the art on top.
  const c = canvas();
  const o = c.getContext('2d');
  const edge = canvas();
  const e = edge.getContext('2d');
  e.drawImage(art, 0, 0);
  e.globalCompositeOperation = 'source-in';
  e.fillStyle = '#ffffff';
  e.fillRect(0, 0, SIZE, SIZE);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    o.drawImage(edge, Math.cos(a) * 4, Math.sin(a) * 4);
  }
  o.drawImage(art, 0, 0);
  return c;
}

// Ch-ch-chain-ges — the party's candidates as skins: friendly cartoon portraits (head and shoulders in a round frame),
// drawn from a short description of each one's looks (hair, beard, glasses, head covering, clothes), never from a
// photo. A candidate shows in the game only with `ready: true`, once they have seen their portrait and said yes.
// Nothing here touches the page on import (the server reads the ids).

/**
 * The list, in order. Every field but id, n and name is optional:
 *   skin: face colour · face: 'oval' | 'round' | 'long' | 'square'
 *   hair: { style, color, grey (0–1: salt and pepper) }, style one of 'crop', 'receding', 'quiff', 'side', 'buzz',
 *         'bald', 'long', 'wavy', 'curly', 'bob', 'bun', 'pony'
 *   beard: { style: 'stubble' | 'short' | 'full' | 'goatee' | 'mustache', color, grey }
 *   brows: 'thin' | 'normal' | 'thick' · glasses: 'rect' | 'round' | 'thin' · earrings: true · lips: true
 *   kippah: { color, knit } · outfit: { type: 'suit' | 'shirt' | 'polo' | 'blouse' | 'tshirt', color, shirt, tie }
 */
export const PEOPLE = [
  {
    id: 'p-winter',
    n: 1,
    name: 'עופר וינטר',
    ready: true,
    skin: '#e2ac84',
    face: 'square',
    hair: { style: 'crop', color: '#3b3431', grey: 0.55 },
    beard: { style: 'short', color: '#3b3431', grey: 0.6 },
    brows: 'thick',
    kippah: { color: '#22335c', knit: true },
    outfit: { type: 'polo', color: '#1d2f55' },
  },
  {
    id: 'p-haddad',
    n: 2,
    name: 'יוסף חדאד',
    ready: true,
    skin: '#cc9468',
    face: 'oval',
    hair: { style: 'quiff', color: '#1a1614' },
    beard: { style: 'full', color: '#1a1614' },
    brows: 'thick',
    outfit: { type: 'suit', color: '#222a38', shirt: '#ffffff' },
  },
];
export const PEOPLE_IDS = PEOPLE.filter((p) => p.ready).map((p) => p.id);

const GREY = '#c4c1bb';
function mix(a, b, k) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p, s) => (p >> s) & 255;
  const m = (s) => Math.round(ch(pa, s) * (1 - k) + ch(pb, s) * k);
  return `#${((m(16) << 16) | (m(8) << 8) | m(0)).toString(16).padStart(6, '0')}`;
}
function shade(c, k) {
  return k < 0 ? mix(c, '#000000', -k) : mix(c, '#ffffff', k);
}

/** A portrait, SIZE × SIZE, on the canvas `c` (whose 2D context is used as is). */
export function drawPortrait(c, spec, SIZE = 128) {
  const g = c.getContext('2d');
  g.save();
  g.scale(SIZE / 128, SIZE / 128);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const skin = spec.skin || '#e8b98f';
  const hair = spec.hair || { style: 'crop', color: '#3a2e28' };
  const hairColor = hair.grey ? mix(hair.color, GREY, hair.grey) : hair.color;
  const beard = spec.beard || null;
  const beardColor = beard ? (beard.grey ? mix(beard.color || hair.color, GREY, beard.grey) : beard.color || hair.color) : null;
  const outfit = spec.outfit || { type: 'shirt', color: '#2f6fed' };
  const long = ['long', 'wavy', 'bob', 'curly'].includes(hair.style);
  const face = spec.face || 'oval';
  const fw = { oval: 25, round: 27, long: 23, square: 26 }[face] ?? 25;
  const fh = { oval: 30, round: 29, long: 32, square: 30 }[face] ?? 30;
  const cx = 64;
  const cy = 54;

  // The round frame.
  g.beginPath();
  g.arc(64, 64, 60, 0, Math.PI * 2);
  g.clip();
  const bg = g.createLinearGradient(0, 0, 0, 128);
  bg.addColorStop(0, '#eef3fb');
  bg.addColorStop(1, '#cddbf3');
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);

  // Hair that falls behind the head and shoulders.
  g.fillStyle = hairColor;
  if (long) {
    const low = hair.style === 'bob' ? 84 : 112;
    g.beginPath();
    g.moveTo(cx - fw - 7, cy - 4);
    g.bezierCurveTo(cx - fw - 10, cy - fh - 6, cx + fw + 10, cy - fh - 6, cx + fw + 7, cy - 4);
    g.bezierCurveTo(cx + fw + 12, cy + 18, cx + fw + 14, low - 12, cx + fw + 6, low);
    g.lineTo(cx - fw - 6, low);
    g.bezierCurveTo(cx - fw - 14, low - 12, cx - fw - 12, cy + 18, cx - fw - 7, cy - 4);
    g.fill();
    if (hair.style === 'wavy' || hair.style === 'curly') {
      for (let k = 0; k < 6; k++) {
        for (const s of [-1, 1]) {
          g.beginPath();
          g.arc(cx + s * (fw + 8), cy + 4 + k * 9, hair.style === 'curly' ? 7 : 5.5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  } else if (hair.style === 'pony') {
    g.beginPath();
    g.ellipse(cx + fw + 4, cy + 6, 7, 20, -0.25, 0, Math.PI * 2);
    g.fill();
  } else if (hair.style === 'bun') {
    g.beginPath();
    g.arc(cx, cy - fh - 6, 10, 0, Math.PI * 2);
    g.fill();
  }

  // Shoulders and clothes.
  const cloth = outfit.color || '#2f6fed';
  g.fillStyle = skin;
  g.beginPath();
  g.moveTo(cx - 10, cy + fh - 12);
  g.lineTo(cx - 11, 100);
  g.lineTo(cx + 11, 100);
  g.lineTo(cx + 10, cy + fh - 12);
  g.closePath();
  g.fill();
  g.fillStyle = shade(skin, -0.12);
  g.beginPath();
  g.ellipse(cx, cy + fh - 2, 11, 6, 0, 0, Math.PI);
  g.fill();
  const body = () => {
    g.beginPath();
    g.moveTo(10, 128);
    g.bezierCurveTo(12, 106, 32, 95, 52, 93);
    g.lineTo(76, 93);
    g.bezierCurveTo(96, 95, 116, 106, 118, 128);
    g.closePath();
  };
  g.fillStyle = cloth;
  body();
  g.fill();
  if (outfit.type === 'suit') {
    g.fillStyle = outfit.shirt || '#ffffff';
    g.beginPath();
    g.moveTo(52, 93);
    g.lineTo(64, 118);
    g.lineTo(76, 93);
    g.closePath();
    g.fill();
    if (outfit.tie) {
      g.fillStyle = outfit.tie;
      g.beginPath();
      g.moveTo(61, 96);
      g.lineTo(67, 96);
      g.lineTo(65.5, 100);
      g.lineTo(68, 118);
      g.lineTo(64, 122);
      g.lineTo(60, 118);
      g.lineTo(62.5, 100);
      g.closePath();
      g.fill();
    } else {
      // An open collar.
      g.fillStyle = skin;
      g.beginPath();
      g.moveTo(57, 93);
      g.lineTo(64, 104);
      g.lineTo(71, 93);
      g.closePath();
      g.fill();
    }
    g.fillStyle = shade(cloth, -0.25);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(64 + s * 12, 92);
      g.lineTo(64 + s * 3, 118);
      g.lineTo(64 + s * 17, 104);
      g.closePath();
      g.fill();
    }
  } else if (outfit.type === 'polo' || outfit.type === 'shirt') {
    g.fillStyle = skin;
    g.beginPath();
    g.moveTo(56, 93);
    g.lineTo(64, 103);
    g.lineTo(72, 93);
    g.closePath();
    g.fill();
    g.fillStyle = shade(cloth, outfit.type === 'polo' ? -0.2 : 0.15);
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(64 + s * 1, 101);
      g.lineTo(64 + s * 12, 91);
      g.lineTo(64 + s * 16, 96);
      g.lineTo(64 + s * 6, 106);
      g.closePath();
      g.fill();
    }
    if (outfit.type === 'polo') {
      g.fillStyle = shade(cloth, 0.35);
      for (const y of [108, 114]) {
        g.beginPath();
        g.arc(64, y, 1.2, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else {
    g.fillStyle = skin;
    g.beginPath();
    if (outfit.type === 'blouse') {
      g.moveTo(55, 93);
      g.lineTo(64, 106);
      g.lineTo(73, 93);
    } else g.ellipse(64, 93, 9, 5, 0, 0, Math.PI);
    g.closePath();
    g.fill();
  }

  // Ears, then the face.
  if (!long) {
    for (const s of [-1, 1]) {
      g.fillStyle = skin;
      g.beginPath();
      g.ellipse(cx + s * (fw + 1), cy + 2, 5, 7, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = shade(skin, -0.15);
      g.beginPath();
      g.ellipse(cx + s * (fw + 1.5), cy + 2, 2.2, 3.8, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillStyle = skin;
  g.beginPath();
  if (face === 'square') {
    g.moveTo(cx - fw, cy - 6);
    g.bezierCurveTo(cx - fw, cy - fh - 4, cx + fw, cy - fh - 4, cx + fw, cy - 6);
    g.bezierCurveTo(cx + fw + 1, cy + 14, cx + fw - 5, cy + fh - 4, cx, cy + fh);
    g.bezierCurveTo(cx - fw + 5, cy + fh - 4, cx - fw - 1, cy + 14, cx - fw, cy - 6);
  } else g.ellipse(cx, cy, fw, fh, 0, 0, Math.PI * 2);
  g.fill();

  // Beard (under the mouth, over the jaw), with grey flecks inside it for salt and pepper.
  const speckle = (color, n, x0, y0, w, h) => {
    g.fillStyle = color;
    for (let k = 0; k < n; k++) {
      g.beginPath();
      g.arc(x0 + w * ((k * 0.618034) % 1), y0 + h * ((k * 0.414214 + 0.3) % 1), 0.85, 0, Math.PI * 2);
      g.fill();
    }
  };
  if (beard && beard.style !== 'mustache') {
    const drop = { full: 6, short: 2.5, stubble: 1.5 }[beard.style] ?? 0;
    g.beginPath();
    if (beard.style === 'goatee') {
      g.moveTo(cx - 9, cy + 16);
      g.bezierCurveTo(cx - 10, cy + fh - 1, cx + 10, cy + fh - 1, cx + 9, cy + 16);
      g.quadraticCurveTo(cx, cy + 22, cx - 9, cy + 16);
    } else {
      g.moveTo(cx - fw + 0.5, cy + 1);
      g.bezierCurveTo(cx - fw + 1, cy + 20, cx - 13, cy + fh + drop, cx, cy + fh + drop);
      g.bezierCurveTo(cx + 13, cy + fh + drop, cx + fw - 1, cy + 20, cx + fw - 0.5, cy + 1);
      g.bezierCurveTo(cx + fw - 3, cy + 9, cx + 15, cy + 9, cx + 11, cy + 14);
      g.quadraticCurveTo(cx, cy + 25, cx - 11, cy + 14);
      g.bezierCurveTo(cx - 15, cy + 9, cx - fw + 3, cy + 9, cx - fw + 0.5, cy + 1);
    }
    g.save();
    g.fillStyle = beardColor;
    g.globalAlpha = beard.style === 'stubble' ? 0.3 : 1;
    g.fill();
    g.globalAlpha = 1;
    if (beard.style !== 'stubble') {
      g.clip();
      if (beard.grey) speckle(shade(beardColor, 0.45), 90, cx - fw, cy, fw * 2, fh + drop);
      else speckle(shade(beardColor, 0.12), 40, cx - fw, cy, fw * 2, fh + drop);
    }
    g.restore();
  }
  if (beard && beard.style !== 'stubble') {
    // A mustache.
    g.fillStyle = beardColor;
    g.beginPath();
    g.moveTo(cx - 10, cy + 13.5);
    g.quadraticCurveTo(cx, cy + 8, cx + 10, cy + 13.5);
    g.quadraticCurveTo(cx, cy + 11.5, cx - 10, cy + 13.5);
    g.fill();
  }

  // Cheeks, nose, mouth: a warm, open smile.
  g.globalAlpha = 0.16;
  g.fillStyle = '#ff5a5f';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.arc(cx + s * 14, cy + 8, 5.5, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  g.strokeStyle = shade(skin, -0.3);
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(cx - 1, cy + 1);
  g.quadraticCurveTo(cx - 4, cy + 8, cx, cy + 8.5);
  g.stroke();
  g.fillStyle = '#6e1f2b';
  g.beginPath();
  g.moveTo(cx - 10, cy + 13.5);
  g.quadraticCurveTo(cx, cy + 27, cx + 10, cy + 13.5);
  g.quadraticCurveTo(cx, cy + 16, cx - 10, cy + 13.5);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(cx - 8.5, cy + 14.5);
  g.quadraticCurveTo(cx, cy + 16.8, cx + 8.5, cy + 14.5);
  g.quadraticCurveTo(cx, cy + 20.5, cx - 8.5, cy + 14.5);
  g.fill();
  g.fillStyle = '#d96a73';
  g.beginPath();
  g.ellipse(cx, cy + 18.6, 3.6, 1.2, 0, 0, Math.PI * 2);
  g.fill();
  if (spec.lips) {
    g.strokeStyle = '#c4505e';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx - 10, cy + 13.5);
    g.quadraticCurveTo(cx, cy + 27, cx + 10, cy + 13.5);
    g.stroke();
  }

  // Eyes and brows.
  for (const s of [-1, 1]) {
    const ex = cx + s * 10;
    const ey = cy - 2;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(ex, ey, 4.4, 3.2, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3a2a22';
    g.beginPath();
    g.arc(ex, ey + 0.3, 2.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(ex + 0.9, ey - 0.6, 0.9, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = shade(skin, -0.35);
    g.lineWidth = 1.2;
    g.beginPath();
    g.ellipse(ex, ey + 0.4, 4.6, 3.4, 0, Math.PI * 1.05, Math.PI * 1.95);
    g.stroke();
    const browColor = hair.style === 'bald' && !beard ? shade(skin, -0.45) : shade(hairColor, -0.15);
    g.strokeStyle = browColor;
    g.lineWidth = spec.brows === 'thin' ? 1.6 : spec.brows === 'thick' ? 3.2 : 2.4;
    g.beginPath();
    g.moveTo(ex - s * 5, ey - 6);
    g.quadraticCurveTo(ex, ey - 9.5, ex + s * 5.5, ey - 7);
    g.stroke();
  }

  // Hair over the forehead.
  g.fillStyle = hairColor;
  const top = cy - fh;
  const cap = (hairline, sideY = cy - 2, lift = 0) => {
    g.beginPath();
    g.moveTo(cx - fw - 1, sideY);
    g.bezierCurveTo(cx - fw - 3, top - 4 - lift, cx + fw + 3, top - 4 - lift, cx + fw + 1, sideY);
    g.bezierCurveTo(cx + fw - 2, hairline + 4, cx + 12, hairline, cx, hairline);
    g.bezierCurveTo(cx - 12, hairline, cx - fw + 2, hairline + 4, cx - fw - 1, sideY);
    g.fill();
    g.save();
    g.clip();
    speckle(hair.grey ? shade(hairColor, 0.4) : shade(hairColor, 0.1), hair.grey ? 70 : 30, cx - fw - 3, top - 6, fw * 2 + 6, sideY - top + 6);
    g.restore();
    g.fillStyle = hairColor;
  };
  switch (hair.style) {
    case 'crop':
      cap(top + 11, cy - 6);
      break;
    case 'buzz':
      g.globalAlpha = 0.75;
      cap(top + 12, cy - 8);
      g.globalAlpha = 1;
      break;
    case 'receding':
      cap(top + 14, cy - 6);
      g.fillStyle = skin;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.ellipse(cx + s * 12, top + 12, 7, 6, 0, 0, Math.PI * 2);
        g.fill();
      }
      break;
    case 'quiff': {
      cap(top + 11, cy - 7, 3);
      // The lift at the front.
      g.beginPath();
      g.moveTo(cx - 17, top + 9);
      g.bezierCurveTo(cx - 14, top - 10, cx + 12, top - 12, cx + 20, top + 2);
      g.bezierCurveTo(cx + 10, top + 1, cx - 4, top + 4, cx - 17, top + 9);
      g.fill();
      g.strokeStyle = shade(hairColor, 0.18);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(cx - 10, top + 2);
      g.quadraticCurveTo(cx + 2, top - 6, cx + 14, top - 1);
      g.stroke();
      break;
    }
    case 'side':
      cap(top + 10, cy - 6);
      g.beginPath();
      g.moveTo(cx - fw + 2, top + 12);
      g.bezierCurveTo(cx - 8, top - 2, cx + 14, top + 2, cx + fw - 2, top + 14);
      g.lineTo(cx + fw - 4, top + 8);
      g.bezierCurveTo(cx + 8, top - 4, cx - 12, top - 4, cx - fw + 2, top + 12);
      g.fill();
      g.strokeStyle = shade(hairColor, 0.25);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(cx - 8, top - 2);
      g.lineTo(cx - 12, top + 8);
      g.stroke();
      break;
    case 'bald':
      g.globalAlpha = 0.8;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.ellipse(cx + s * (fw - 1), cy - 6, 3.5, 9, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      break;
    case 'long':
    case 'wavy':
    case 'curly':
    case 'bob': {
      // A parting, and hair framing the face down to the jaw.
      g.beginPath();
      g.moveTo(cx - fw - 3, cy + 16);
      g.bezierCurveTo(cx - fw - 6, top - 8, cx + fw + 6, top - 8, cx + fw + 3, cy + 16);
      g.bezierCurveTo(cx + fw - 1, cy, cx + fw - 2, top + 14, cx + 4, top + 7);
      g.bezierCurveTo(cx - 10, top + 14, cx - fw + 2, cy - 2, cx - fw - 3, cy + 16);
      g.fill();
      break;
    }
    case 'bun':
    case 'pony':
      cap(top + 10, cy - 4);
      break;
    default:
      cap(top + 11, cy - 6);
  }
  // Head covering, glasses, earrings.
  if (spec.kippah) {
    const k = spec.kippah;
    g.fillStyle = k.color || '#1f3b73';
    g.beginPath();
    g.ellipse(cx + 4, top + 3, 12, 4.6, -0.12, 0, Math.PI * 2);
    g.fill();
    if (k.knit) {
      g.strokeStyle = shade(k.color || '#1f3b73', 0.45);
      g.lineWidth = 0.9;
      g.beginPath();
      g.ellipse(cx + 4, top + 3, 8.5, 3, -0.12, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.ellipse(cx + 4, top + 3, 4.5, 1.5, -0.12, 0, Math.PI * 2);
      g.stroke();
    }
  }
  if (spec.glasses) {
    g.strokeStyle = spec.glasses === 'thin' ? '#8a7560' : '#2b2522';
    g.lineWidth = spec.glasses === 'thin' ? 1.1 : 1.8;
    g.fillStyle = 'rgba(255,255,255,0.12)';
    for (const s of [-1, 1]) {
      g.beginPath();
      if (spec.glasses === 'round') g.arc(cx + s * 10, cy - 2, 6.2, 0, Math.PI * 2);
      else if (g.roundRect) g.roundRect(cx + s * 10 - 6.8, cy - 6.5, 13.6, 9.5, 3);
      else g.rect(cx + s * 10 - 6.8, cy - 6.5, 13.6, 9.5);
      g.fill();
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - 3.5, cy - 3);
    g.quadraticCurveTo(cx, cy - 5, cx + 3.5, cy - 3);
    g.stroke();
  }
  if (spec.earrings) {
    g.fillStyle = '#e0b04a';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(cx + s * (fw + 1), cy + 10, 1.8, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

// Ch-ch-chain-ges — the people. Flat paper-doll figures with a white cut-out edge: in a chain they reach out to hold
// hands; on the street they stand with their arms down. Each colour and pose is drawn once and reused.

export const FIG = {
  w: 72, // sprite width, px
  h: 124, // sprite height, px
  hand: 54, // the row where the hands are (a chain's hands line passes here)
  feet: 116, // the row under the feet
};
const cache = new Map();

/** pose: 'chain' (arms out) or 'idle' (arms down); step: 0 or 1 (legs together or apart). */
export function figure(color, pose = 'chain', step = 0) {
  const key = `${color}|${pose}|${step}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  // Twice the size it is laid out at, so the people stay sharp on sharp screens.
  c.width = FIG.w * 2;
  c.height = FIG.h * 2;
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  paint(g, '#ffffff', pose, step, 5); // the cut-out edge
  paint(g, color, pose, step, 0);
  cache.set(key, c);
  return c;
}

function paint(g, color, pose, step, grow) {
  g.fillStyle = color;
  g.strokeStyle = color;
  // head
  g.beginPath();
  g.arc(36, 22, 12.5 + grow, 0, Math.PI * 2);
  g.fill();
  // body: shoulders wider than the waist
  g.lineWidth = 1 + grow * 2;
  g.beginPath();
  g.moveTo(24, 38);
  g.lineTo(48, 38);
  g.quadraticCurveTo(54, 38, 53.5, 45);
  g.lineTo(49, 80);
  g.lineTo(23, 80);
  g.lineTo(18.5, 45);
  g.quadraticCurveTo(18, 38, 24, 38);
  g.closePath();
  g.fill();
  if (grow) g.stroke();
  // arms
  g.lineWidth = 8 + grow * 2;
  g.beginPath();
  if (pose === 'chain') {
    g.moveTo(21, 44);
    g.lineTo(5, 54);
    g.moveTo(51, 44);
    g.lineTo(67, 54);
  } else {
    g.moveTo(20, 45);
    g.lineTo(15, 74);
    g.moveTo(52, 45);
    g.lineTo(57, 74);
  }
  g.stroke();
  // legs
  g.lineWidth = 9 + grow * 2;
  g.beginPath();
  if (step) {
    g.moveTo(31, 78);
    g.lineTo(24, 112);
    g.moveTo(41, 78);
    g.lineTo(48, 112);
  } else {
    g.moveTo(31, 78);
    g.lineTo(30, 113);
    g.moveTo(41, 78);
    g.lineTo(42, 113);
  }
  g.stroke();
}

/**
 * The leader's flag, drawn in screen space: a pole rising from the figure's hand and a pennant that streams
 * behind the direction of travel (dir = -1 or 1) and flutters with time t.
 */
export function drawFlag(g, x, y, hp, color, dir, t, outline = false) {
  const px = x + dir * -0.02 * hp;
  const top = y - 1.02 * hp;
  const bottom = y + 0.02 * hp;
  g.lineCap = 'round';
  g.strokeStyle = outline ? '#ffffff' : '#3d3a35';
  g.lineWidth = Math.max(1.2, hp * 0.035) + (outline ? 3 : 0);
  g.beginPath();
  g.moveTo(px, bottom);
  g.lineTo(px, top);
  g.stroke();
  const len = hp * 0.46;
  const tall = hp * 0.28;
  const wave = Math.sin(t * 7) * tall * 0.12;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(px, top);
  g.quadraticCurveTo(px - dir * len * 0.5, top - tall * 0.12 + wave, px - dir * len, top + tall * 0.5 + wave * 0.5);
  g.quadraticCurveTo(px - dir * len * 0.5, top + tall * 0.95 - wave, px, top + tall);
  g.closePath();
  if (outline) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.stroke();
  }
  g.fill();
}

// Ch-ch-chain-ges — the name and the wordmark. The name stutters like Bowie's "Ch-ch-changes", with chains inside.
export const NAME = 'Ch-ch-chain-ges';
export const SLUG = 'chchchain-ges';
/** The wordmark in parts: the stutter and the ending are faint, "chain" is solid. */
export const WORDMARK = [
  ['Ch-ch-', 0.3],
  ['chain', 1],
  ['-ges', 0.3],
];

/**
 * Draws the wordmark on a 2D canvas with its baseline at y. align: where x is ('left' | 'center' | 'right').
 * The type shrinks to fit maxWidth. Returns the font size used.
 */
export function drawWordmark(g, x, y, size, { align = 'center', maxWidth = Infinity, ink = '#23201b', weight = 900 } = {}) {
  const font = (px) => `${weight} ${px}px system-ui, -apple-system, "Segoe UI", Arial, sans-serif`;
  g.save();
  g.direction = 'ltr';
  g.textAlign = 'left';
  g.font = font(size);
  let width = g.measureText(NAME).width;
  if (width > maxWidth) {
    size = Math.floor((size * maxWidth) / width);
    g.font = font(size);
    width = g.measureText(NAME).width;
  }
  let at = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  g.fillStyle = ink;
  for (const [part, alpha] of WORDMARK) {
    g.globalAlpha = alpha;
    g.fillText(part, at, y);
    at += g.measureText(part).width;
  }
  g.restore();
  return size;
}

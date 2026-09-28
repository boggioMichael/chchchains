// Ch-ch-chain-ges — player names. Anyone may pick a name of their own: 2–16 letters (any alphabet), digits, spaces and
// a little punctuation; no links, no emoji, nothing from a short list of insults and slurs. The server applies the
// same rules (and falls back to a generated name), so the page can say at once whether a name will pass.

export const NAME_MIN = 2;
export const NAME_MAX = 16;

// Matched against the name with spaces, punctuation and Hebrew final letters folded away (so "ז ו נ ה" and
// "fuuuck" are caught too). Short words that are also innocent parts of other words only match whole words.
const BLOCK = [
  'זונה', 'שרמוטה', 'שרמוטות', 'מזדיין', 'לזיין', 'זיון', 'זיונים', 'מניאק', 'בנזונה', 'כוסאמק', 'כוסאמא', 'כוסעמק',
  'כוסית', 'קוקסינל', 'היטלר', 'יהודון', 'ערבוש', 'כושי', 'אשכנאצי', 'חמאס', 'דאעש', 'מוותל', 'fuck', 'fuk',
  'bitch', 'cunt', 'pussy', 'nigger', 'nigga', 'faggot', 'kike', 'hitler', 'whore', 'slut', 'retard', 'porn', 'hamas',
  'penis', 'vagina', 'dildo',
];
// Only as whole words: each is also part of innocent names (Shitrit, Nazir, grape, Isis…).
const WHOLE = ['זין', 'כוס', 'חרא', 'נאצי', 'נאצים', 'shit', 'nazi', 'nazis', 'rape', 'isis', 'sex', 'fag', 'dick', 'cock'];
const FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

function fold(s) {
  return s
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/(.)\1+/gu, '$1');
}
const BLOCK_FOLDED = BLOCK.map(fold);
const WHOLE_FOLDED = new Set(WHOLE.map(fold));

/**
 * The name as it will be shown, or '' when it may not be used. Accepts letters of any alphabet, digits, spaces and
 * - _ . ' " ׳ ״ ! ?; trims, collapses spaces, and drops invisible and direction-changing characters.
 */
export function cleanName(input) {
  if (typeof input !== 'string') return '';
  const s = input
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const len = [...s].length;
  if (len < NAME_MIN || len > NAME_MAX) return '';
  if (!/^[\p{L}\p{N} _.'"׳״!?\-]+$/u.test(s)) return '';
  if (!/\p{L}/u.test(s)) return '';
  if (/https?|www|\.(com|net|org|co|il|io|ly|me|app|xyz|gg|tv)\b|@/i.test(s)) return '';
  const joined = fold(s.replace(/[\s_.'"׳״!?\-]+/g, ''));
  if (BLOCK_FOLDED.some((w) => joined.includes(w))) return '';
  for (const word of s.split(/[\s_.'"׳״!?\-]+/)) if (WHOLE_FOLDED.has(fold(word))) return '';
  return s;
}

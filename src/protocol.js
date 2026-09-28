// Binary snapshot format shared by server.mjs and net.js (little endian).
//
//  u8  type (1 = snapshot) · u32 room time in ms · u32 your chain id (0 = none) · u32 camera focus id (0 = none)
//  u16 chains, each:
//      u32 id · u8 colour · u8 flags · u32 team · i16 x×4 · i16 y×4 · u16 angle · f32 mass · u32 seq · u16 len ·
//      u16 points, then points × (i16 x, i16 y), head first: point k is path point number seq − k (path points are
//      C.spacing apart, and the body is `len` points long). With FLAG_FULL the whole body follows; otherwise only
//      the points added since the last snapshot this client received.
//  u16 new sparks, each: u32 id · i16 x · i16 y · u8 radius×10 · u8 colour · u16 seconds left (0 = permanent)
//  u16 gone sparks, each: u32 id
//
// Chains a client stops receiving have left its view; sparks leave only through the "gone" list.

export const FLAG_BOOST = 1;
export const FLAG_BOT = 2;
export const FLAG_OFFERS_ME = 4; // this chain is offering you a hand
export const FLAG_I_OFFERED = 8; // you are offering this chain a hand
export const FLAG_FULL = 16; // the whole body follows
export const FLAG_CANDIDATE = 32; // "give a hand" would go to this chain

const TAU = Math.PI * 2;
const SNAKE_HEAD = 4 + 1 + 1 + 4 + 2 + 2 + 2 + 4 + 4 + 2 + 2;
const SPARK_SIZE = 4 + 2 + 2 + 1 + 1 + 2;

/**
 * o = { time, me, focus, snakes: [{ id, color, flags, team, x, y, a, mass, seq, len, px, py, count }], newSparks: [{ id, x,
 * y, r, color, left }], goneSparks: [id] } where px/py are head-first arrays of which the first `count` are sent.
 */
export function encodeSnapshot(o) {
  let size = 1 + 4 + 4 + 4 + 2;
  for (const s of o.snakes) size += SNAKE_HEAD + s.count * 4;
  size += 2 + o.newSparks.length * SPARK_SIZE + 2 + o.goneSparks.length * 4;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let p = 0;
  v.setUint8(p, 1);
  v.setUint32(p + 1, o.time >>> 0, true);
  v.setUint32(p + 5, o.me >>> 0, true);
  v.setUint32(p + 9, o.focus >>> 0, true);
  v.setUint16(p + 13, o.snakes.length, true);
  p += 15;
  for (const s of o.snakes) {
    v.setUint32(p, s.id >>> 0, true);
    v.setUint8(p + 4, s.color);
    v.setUint8(p + 5, s.flags);
    v.setUint32(p + 6, s.team >>> 0, true);
    v.setInt16(p + 10, clamp16(s.x * 4), true);
    v.setInt16(p + 12, clamp16(s.y * 4), true);
    v.setUint16(p + 14, Math.round(((((s.a % TAU) + TAU) % TAU) / TAU) * 65535), true);
    v.setFloat32(p + 16, s.mass, true);
    v.setUint32(p + 20, s.seq >>> 0, true);
    v.setUint16(p + 24, Math.min(65535, s.len), true);
    v.setUint16(p + 26, s.count, true);
    p += SNAKE_HEAD;
    for (let k = 0; k < s.count; k++) {
      v.setInt16(p, clamp16(s.px[k]), true);
      v.setInt16(p + 2, clamp16(s.py[k]), true);
      p += 4;
    }
  }
  v.setUint16(p, o.newSparks.length, true);
  p += 2;
  for (const sp of o.newSparks) {
    v.setUint32(p, sp.id >>> 0, true);
    v.setInt16(p + 4, clamp16(sp.x), true);
    v.setInt16(p + 6, clamp16(sp.y), true);
    v.setUint8(p + 8, Math.max(0, Math.min(255, Math.round(sp.r * 10))));
    v.setUint8(p + 9, sp.color);
    v.setUint16(p + 10, Math.max(0, Math.min(65535, Math.round(sp.left))), true);
    p += SPARK_SIZE;
  }
  v.setUint16(p, o.goneSparks.length, true);
  p += 2;
  for (const id of o.goneSparks) {
    v.setUint32(p, id >>> 0, true);
    p += 4;
  }
  return new Uint8Array(buf);
}

/** Decodes a snapshot; returns null for anything malformed. */
export function decodeSnapshot(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint8(0) !== 1) return null;
    const time = v.getUint32(1, true);
    const me = v.getUint32(5, true);
    const focus = v.getUint32(9, true);
    const n = v.getUint16(13, true);
    let p = 15;
    const snakes = [];
    for (let k = 0; k < n; k++) {
      const s = {
        id: v.getUint32(p, true),
        color: v.getUint8(p + 4),
        flags: v.getUint8(p + 5),
        team: v.getUint32(p + 6, true),
        x: v.getInt16(p + 10, true) / 4,
        y: v.getInt16(p + 12, true) / 4,
        a: (v.getUint16(p + 14, true) / 65535) * TAU,
        mass: v.getFloat32(p + 16, true),
        seq: v.getUint32(p + 20, true),
        len: v.getUint16(p + 24, true),
        count: v.getUint16(p + 26, true),
      };
      p += SNAKE_HEAD;
      const px = new Float32Array(s.count);
      const py = new Float32Array(s.count);
      for (let i = 0; i < s.count; i++) {
        px[i] = v.getInt16(p, true);
        py[i] = v.getInt16(p + 2, true);
        p += 4;
      }
      s.px = px;
      s.py = py;
      snakes.push(s);
    }
    const ns = v.getUint16(p, true);
    p += 2;
    const newSparks = [];
    for (let k = 0; k < ns; k++) {
      newSparks.push({
        id: v.getUint32(p, true),
        x: v.getInt16(p + 4, true),
        y: v.getInt16(p + 6, true),
        r: v.getUint8(p + 8) / 10,
        color: v.getUint8(p + 9),
        left: v.getUint16(p + 10, true),
      });
      p += SPARK_SIZE;
    }
    const ng = v.getUint16(p, true);
    p += 2;
    const goneSparks = [];
    for (let k = 0; k < ng; k++) {
      goneSparks.push(v.getUint32(p, true));
      p += 4;
    }
    if (p !== buf.byteLength) return null;
    return { time, me, focus, snakes, newSparks, goneSparks };
  } catch {
    return null; // truncated
  }
}

function clamp16(x) {
  return Math.max(-32768, Math.min(32767, Math.round(x)));
}

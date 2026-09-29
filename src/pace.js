// Ch-ch-chain-ges — drawing as sharp as the phone manages. The map, the people and the streets in 3D are drawn at the
// screen's own pixel density; this only steps it down while the phone cannot keep up, and back up once it can.

/**
 * A pacer: call it with each frame's time (seconds); it answers -1 (draw fewer pixels), +1 (more) or 0. Every
 * `every` frames the middle frame time decides: slower than `slow`, a step down. If the next frames are no quicker,
 * fewer pixels did not help (a phone saving its battery shows 30 frames a second whatever is drawn), so the step is
 * taken back and not tried again for a minute. Quicker than `quick`, a step up (not for a while after a step down
 * that helped, so it does not see-saw). Hiccups (a map loading, the tab coming back) do not count.
 */
export function pacer({ every = 90, slow = 1 / 40, quick = 1 / 57 } = {}) {
  let times = [];
  let clock = 0;
  let tried = 0; // the middle frame time before a step down, while its effect is being measured
  let downHold = 0;
  let upHold = 0;
  return (dt) => {
    if (!(dt > 0) || dt > 0.12) {
      times = [];
      return 0;
    }
    clock += dt;
    times.push(dt);
    if (times.length < every) return 0;
    const middle = times.sort((a, b) => a - b)[times.length >> 1];
    times = [];
    if (tried) {
      const before = tried;
      tried = 0;
      if (middle > before * 0.85) {
        downHold = clock + 60;
        return 1;
      }
      upHold = clock + 20;
    }
    if (middle > slow && clock > downHold) {
      tried = middle;
      return -1;
    }
    if (middle < quick && clock > upHold) return 1;
    return 0;
  };
}

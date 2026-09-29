// Ch-ch-chain-ges — music and sound, synthesised with Web Audio (no audio files). Five original tracks to pick from,
// each a 16-bar loop whose layers follow the game: calm in the menus; drums and arpeggios while you play; the lead
// melody once your chain grows; extra hi-hats while you run; bells when you hold hands. A player may also play a
// song of their own from their phone (it stays on the phone), or one the site has a licence for (config.json).
// Browsers only allow sound after a tap, so nothing plays until unlock() is called from one.
//
// iPhones play a page's Web Audio like a ringtone: with the phone on silent, nothing is heard. So while the music is
// on, the page asks for the "playback" audio session (Safari 16.4 and later) and, on iPhones and iPads, keeps a
// silent <audio> loop playing (older versions switch to playback that way): the game is heard like a music app.

const LOOKAHEAD = 0.14;
const B = (s, m, l) => [s, m, l];

/** The tracks: bpm, one chord per bar (16 bars), bass roots, the lead melody [step, midi, length] per bar, and style. */
export const TRACKS = [
  {
    id: 'chains',
    title: 'שרשרת',
    mood: 'סינת׳-פופ קופצני',
    bpm: 116,
    chords: [
      [62, 65, 69], [58, 62, 65], [65, 69, 72], [60, 64, 67], [62, 65, 69], [58, 62, 65], [65, 69, 72], [57, 61, 64],
      [58, 62, 65], [60, 64, 67], [57, 60, 64], [62, 65, 69], [58, 62, 65], [60, 64, 67], [62, 65, 69], [62, 65, 69],
    ],
    roots: [38, 34, 41, 36, 38, 34, 41, 45, 34, 36, 45, 38, 34, 36, 38, 38],
    lead: [
      [B(0, 69, 3), B(4, 74, 2), B(6, 72, 2), B(8, 69, 3), B(12, 67, 2), B(14, 65, 2)],
      [B(0, 65, 3), B(4, 62, 2), B(6, 65, 2), B(8, 67, 2), B(10, 69, 6)],
      [B(0, 72, 3), B(4, 74, 2), B(6, 72, 2), B(8, 69, 2), B(10, 65, 2), B(12, 69, 4)],
      [B(0, 67, 4), B(4, 64, 2), B(6, 67, 2), B(8, 72, 4), B(12, 69, 2), B(14, 67, 2)],
      [B(0, 69, 3), B(4, 74, 2), B(6, 76, 2), B(8, 77, 3), B(12, 76, 2), B(14, 74, 2)],
      [B(0, 74, 4), B(4, 70, 2), B(6, 74, 2), B(8, 77, 4), B(12, 74, 4)],
      [B(0, 72, 2), B(2, 69, 2), B(4, 72, 2), B(6, 77, 2), B(8, 76, 4), B(12, 72, 4)],
      [B(0, 73, 6), B(8, 69, 2), B(10, 73, 2), B(12, 76, 4)],
      [B(0, 74, 6), B(8, 72, 2), B(10, 70, 2), B(12, 69, 4)],
      [B(0, 67, 6), B(8, 69, 2), B(10, 72, 2), B(12, 76, 4)],
      [B(0, 76, 4), B(4, 74, 2), B(6, 72, 2), B(8, 69, 8)],
      [B(0, 74, 4), B(4, 77, 4), B(8, 81, 6), B(14, 79, 2)],
      [B(0, 77, 4), B(4, 74, 2), B(6, 77, 2), B(8, 82, 4), B(12, 81, 4)],
      [B(0, 79, 4), B(4, 76, 2), B(6, 72, 2), B(8, 76, 4), B(12, 79, 4)],
      [B(0, 77, 3), B(4, 76, 2), B(6, 74, 2), B(8, 72, 2), B(10, 69, 6)],
      [B(0, 74, 12)],
    ],
    arp: [0, 1, 2, 1, 0, 1, 2, 3],
    style: { bass: 'bounce', drums: 'pop', lead: ['square', 'sawtooth'], arp: 'square' },
  },
  {
    id: 'city',
    title: 'קצב העיר',
    mood: 'דיסקו שמח',
    bpm: 124,
    chords: [
      [65, 69, 72], [62, 65, 69], [58, 62, 65], [60, 64, 67], [65, 69, 72], [57, 60, 64], [58, 62, 65], [60, 64, 67],
      [62, 65, 69], [58, 62, 65], [65, 69, 72], [60, 64, 67], [62, 65, 69], [58, 62, 65], [55, 58, 62], [60, 64, 67],
    ],
    roots: [41, 38, 34, 36, 41, 33, 34, 36, 38, 34, 41, 36, 38, 34, 31, 36],
    lead: [
      [B(0, 72, 2), B(2, 74, 2), B(4, 77, 4), B(8, 76, 2), B(10, 74, 2), B(12, 72, 4)],
      [B(0, 74, 3), B(4, 72, 2), B(6, 69, 2), B(8, 65, 4), B(12, 69, 4)],
      [B(0, 70, 2), B(2, 72, 2), B(4, 74, 4), B(8, 77, 2), B(10, 74, 2), B(12, 72, 4)],
      [B(0, 72, 6), B(8, 76, 2), B(10, 79, 2), B(12, 76, 4)],
      [B(0, 77, 2), B(2, 76, 2), B(4, 74, 2), B(6, 72, 2), B(8, 74, 4), B(12, 72, 4)],
      [B(0, 76, 3), B(4, 72, 2), B(6, 69, 2), B(8, 72, 4), B(12, 76, 4)],
      [B(0, 74, 2), B(2, 77, 2), B(4, 74, 2), B(6, 70, 2), B(8, 72, 4), B(12, 74, 4)],
      [B(0, 79, 8), B(8, 76, 4), B(12, 72, 4)],
      [B(0, 77, 4), B(4, 76, 2), B(6, 74, 2), B(8, 69, 4), B(12, 72, 4)],
      [B(0, 74, 4), B(4, 72, 2), B(6, 70, 2), B(8, 65, 4), B(12, 70, 4)],
      [B(0, 72, 2), B(2, 77, 2), B(4, 81, 4), B(8, 79, 2), B(10, 77, 2), B(12, 76, 4)],
      [B(0, 74, 4), B(4, 76, 2), B(6, 77, 2), B(8, 79, 8)],
      [B(0, 81, 4), B(4, 79, 2), B(6, 77, 2), B(8, 76, 4), B(12, 74, 4)],
      [B(0, 77, 4), B(4, 74, 2), B(6, 70, 2), B(8, 74, 4), B(12, 77, 4)],
      [B(0, 74, 2), B(2, 77, 2), B(4, 79, 4), B(8, 77, 2), B(10, 74, 2), B(12, 70, 4)],
      [B(0, 72, 12)],
    ],
    arp: [0, 3, 1, 3, 2, 3, 1, 3],
    style: { bass: 'disco', drums: 'disco', lead: ['sawtooth', 'sawtooth'], arp: 'sawtooth' },
  },
  {
    id: 'night',
    title: 'לילה בעיר',
    mood: 'סינת׳ווייב',
    bpm: 100,
    chords: [
      [57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62], [57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62],
      [57, 62, 65], [53, 57, 60], [57, 60, 64], [55, 59, 62], [57, 62, 65], [53, 57, 60], [56, 59, 64], [56, 59, 64],
    ],
    roots: [33, 29, 36, 31, 33, 29, 36, 31, 38, 29, 33, 31, 38, 29, 28, 28],
    lead: [
      [B(0, 76, 6), B(6, 74, 2), B(8, 72, 4), B(12, 71, 4)],
      [B(0, 72, 8), B(8, 69, 4), B(12, 72, 4)],
      [B(0, 67, 6), B(6, 72, 2), B(8, 76, 6), B(14, 74, 2)],
      [B(0, 74, 12), B(12, 71, 4)],
      [B(0, 76, 4), B(4, 79, 4), B(8, 81, 6), B(14, 79, 2)],
      [B(0, 77, 8), B(8, 76, 4), B(12, 72, 4)],
      [B(0, 76, 6), B(6, 74, 2), B(8, 72, 4), B(12, 67, 4)],
      [B(0, 71, 12), B(12, 74, 4)],
      [B(0, 77, 6), B(6, 76, 2), B(8, 74, 4), B(12, 72, 4)],
      [B(0, 72, 8), B(8, 74, 4), B(12, 76, 4)],
      [B(0, 76, 6), B(6, 72, 2), B(8, 69, 8)],
      [B(0, 71, 6), B(6, 72, 2), B(8, 74, 8)],
      [B(0, 74, 4), B(4, 77, 4), B(8, 81, 8)],
      [B(0, 79, 4), B(4, 77, 4), B(8, 76, 8)],
      [B(0, 76, 6), B(6, 74, 2), B(8, 71, 4), B(12, 68, 4)],
      [B(0, 68, 8), B(8, 71, 8)],
    ],
    arp: [0, 1, 2, 3, 2, 1, 0, 1],
    style: { bass: 'pulse', drums: 'halftime', lead: ['sawtooth', 'triangle'], arp: 'triangle' },
  },
  {
    id: 'race',
    title: 'מרוץ',
    mood: 'צ׳יפטיון מהיר',
    bpm: 150,
    chords: [
      [64, 67, 71], [60, 64, 67], [62, 67, 71], [62, 66, 69], [64, 67, 71], [60, 64, 67], [62, 67, 71], [62, 66, 69],
      [60, 64, 69], [60, 64, 67], [64, 67, 71], [62, 66, 69], [60, 64, 69], [60, 64, 67], [59, 63, 66], [59, 63, 66],
    ],
    roots: [40, 36, 43, 38, 40, 36, 43, 38, 45, 36, 40, 38, 45, 36, 35, 35],
    lead: [
      [B(0, 76, 2), B(2, 79, 2), B(4, 83, 2), B(6, 79, 2), B(8, 76, 2), B(10, 79, 2), B(12, 81, 2), B(14, 79, 2)],
      [B(0, 76, 2), B(2, 79, 2), B(4, 84, 2), B(6, 79, 2), B(8, 76, 4), B(12, 72, 4)],
      [B(0, 74, 2), B(2, 79, 2), B(4, 83, 2), B(6, 79, 2), B(8, 74, 2), B(10, 79, 2), B(12, 81, 2), B(14, 83, 2)],
      [B(0, 81, 6), B(6, 78, 2), B(8, 74, 8)],
      [B(0, 83, 2), B(2, 81, 2), B(4, 79, 2), B(6, 76, 2), B(8, 79, 4), B(12, 83, 4)],
      [B(0, 84, 2), B(2, 83, 2), B(4, 79, 2), B(6, 76, 2), B(8, 72, 4), B(12, 76, 4)],
      [B(0, 79, 2), B(2, 81, 2), B(4, 83, 4), B(8, 86, 4), B(12, 83, 4)],
      [B(0, 81, 12), B(12, 78, 4)],
      [B(0, 81, 4), B(4, 84, 4), B(8, 88, 4), B(12, 84, 4)],
      [B(0, 84, 4), B(4, 79, 4), B(8, 76, 4), B(12, 79, 4)],
      [B(0, 83, 2), B(2, 79, 2), B(4, 76, 2), B(6, 79, 2), B(8, 83, 4), B(12, 88, 4)],
      [B(0, 86, 4), B(4, 81, 4), B(8, 78, 4), B(12, 81, 4)],
      [B(0, 84, 2), B(2, 81, 2), B(4, 76, 2), B(6, 81, 2), B(8, 84, 4), B(12, 88, 4)],
      [B(0, 88, 4), B(4, 84, 4), B(8, 79, 4), B(12, 84, 4)],
      [B(0, 87, 4), B(4, 83, 4), B(8, 78, 4), B(12, 75, 4)],
      [B(0, 83, 8), B(8, 78, 4), B(12, 75, 4)],
    ],
    arp: [0, 1, 2, 3, 0, 1, 2, 3],
    style: { bass: 'chip', drums: 'chip', lead: ['square', 'square'], arp: 'square' },
  },
  {
    id: 'march',
    title: 'מצעד',
    mood: 'המנון חגיגי',
    bpm: 108,
    chords: [
      [60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65], [60, 64, 67], [59, 62, 67], [57, 60, 65], [59, 62, 67],
      [57, 60, 64], [57, 60, 65], [60, 64, 67], [59, 62, 67], [57, 60, 64], [57, 60, 65], [57, 62, 65], [59, 62, 67],
    ],
    roots: [36, 31, 33, 29, 36, 31, 29, 31, 33, 29, 36, 31, 33, 29, 38, 31],
    lead: [
      [B(0, 67, 4), B(4, 72, 4), B(8, 76, 6), B(14, 74, 2)],
      [B(0, 74, 4), B(4, 71, 4), B(8, 67, 8)],
      [B(0, 69, 4), B(4, 72, 4), B(8, 76, 4), B(12, 79, 4)],
      [B(0, 77, 8), B(8, 76, 4), B(12, 74, 4)],
      [B(0, 72, 4), B(4, 76, 4), B(8, 79, 6), B(14, 77, 2)],
      [B(0, 76, 4), B(4, 74, 4), B(8, 71, 8)],
      [B(0, 72, 4), B(4, 74, 4), B(8, 77, 4), B(12, 76, 4)],
      [B(0, 74, 12), B(12, 67, 4)],
      [B(0, 76, 6), B(6, 74, 2), B(8, 72, 8)],
      [B(0, 77, 6), B(6, 76, 2), B(8, 74, 8)],
      [B(0, 79, 6), B(6, 77, 2), B(8, 76, 4), B(12, 72, 4)],
      [B(0, 74, 12), B(12, 79, 4)],
      [B(0, 81, 6), B(6, 79, 2), B(8, 76, 8)],
      [B(0, 77, 6), B(6, 76, 2), B(8, 74, 4), B(12, 72, 4)],
      [B(0, 74, 4), B(4, 77, 4), B(8, 81, 4), B(12, 77, 4)],
      [B(0, 79, 8), B(8, 74, 4), B(12, 71, 4)],
    ],
    arp: [0, 2, 1, 2, 0, 2, 1, 3],
    style: { bass: 'march', drums: 'march', lead: ['triangle', 'square'], arp: 'triangle' },
  },
];

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** A looping <audio> of one second of silence, made here as a WAV (the page's policy allows blob: media). */
function silentLoop() {
  const rate = 8000;
  const n = rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (at, text) => {
    for (let i = 0; i < text.length; i++) v.setUint8(at + i, text.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8-bit: silence is 128
  str(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  const el = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  el.loop = true;
  el.setAttribute('playsinline', '');
  el.volume = 0.01;
  return el;
}

/** context: an (Offline)AudioContext to use instead of making one — for rendering the music to a file. */
export function createAudio({ muted = false, context = null, track = 'chains' } = {}) {
  let T = TRACKS.find((t) => t.id === track) || TRACKS[0];
  let STEP = 60 / T.bpm / 4; // one sixteenth note, seconds
  let pending = null; // a track to switch to at the next bar
  let file = null; // { source, gain, title } while a song file plays instead of the synth
  let ac = null;
  let master = null;
  let noise = null;
  let delay = null;
  const layers = {};
  const level = { pad: 0.55, bass: 0.6, drums: 0, arp: 0, lead: 0, hats: 0, bells: 0 };
  let step = 0;
  let nextTime = 0;
  let timer = 0;
  let combo = 0;
  let comboAt = 0;
  let lastBlip = 0;
  const state = { muted, scene: 'menu' };
  // Muted, the page lets go of the sound entirely (the context is suspended, the audio session mixes with other
  // apps and the silent loop stops), so a player's own music from Spotify or the like keeps playing under the game.
  const nav = globalThis.navigator;
  const apple = !!nav && (/iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1));
  let silent = null;
  const session = (m) => {
    try {
      const s = nav?.audioSession;
      if (s) s.type = m ? 'ambient' : 'playback';
    } catch {
      /* not supported */
    }
    if (!apple || context || typeof Audio === 'undefined') return;
    try {
      if (m) silent?.pause();
      else {
        silent ??= silentLoop();
        silent.play().catch(() => {});
      }
    } catch {
      /* no audio element here */
    }
  };

  try {
    if (nav?.audioSession && !context) nav.audioSession.type = muted ? 'ambient' : 'playback';
  } catch {
    /* not supported */
  }

  function unlock() {
    if (!state.muted && !context) session(false); // inside the tap: iPhones allow the silent loop to start here
    if (!ac) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC && !context) return;
      ac = context || new AC();
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      master = ac.createGain();
      master.gain.value = state.muted ? 0 : 0.8;
      master.connect(comp).connect(ac.destination);
      // A soft echo for the lead and bells.
      delay = ac.createDelay(1);
      delay.delayTime.value = STEP * 3;
      const fb = ac.createGain();
      fb.gain.value = 0.28;
      const wet = ac.createGain();
      wet.gain.value = 0.22;
      delay.connect(fb).connect(delay);
      delay.connect(wet).connect(master);
      for (const name of Object.keys(level)) {
        const g = ac.createGain();
        g.gain.value = level[name];
        g.connect(master);
        layers[name] = g;
      }
      const len = ac.sampleRate;
      noise = ac.createBuffer(1, len, ac.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (context) return; // offline: the caller schedules with renderUntil()
    if (state.muted) {
      if (ac.state === 'running') ac.suspend();
    } else if (ac.state === 'suspended') ac.resume();
    if (!timer) {
      nextTime = ac.currentTime + 0.08;
      timer = setInterval(schedule, 25);
    }
  }

  function schedule() {
    if (!ac || ac.state !== 'running') return;
    while (nextTime < ac.currentTime + LOOKAHEAD) {
      advance();
    }
  }
  function advance() {
    if (pending && step % 16 === 0) {
      T = pending;
      pending = null;
      STEP = 60 / T.bpm / 4;
      step = 0;
      if (delay) delay.delayTime.setValueAtTime(STEP * 3, nextTime);
    }
    if (!file) play(step, nextTime);
    nextTime += STEP;
    step = (step + 1) % (16 * 16);
  }

  function play(s, t) {
    const bar = Math.floor(s / 16);
    const i = s % 16;
    const chord = T.chords[bar];
    const root = T.roots[bar];
    const st = T.style;
    const second = bar >= 8;
    if (i === 0) pad(chord, t, STEP * 16);
    // Bass, in the track's own pattern.
    if (st.bass === 'bounce') {
      if (i % 2 === 0) note(layers.bass, 'sawtooth', hz(root + (i % 4 === 2 ? 12 : 0)), t, STEP * 1.6, 0.22, 700);
    } else if (st.bass === 'disco') {
      note(layers.bass, 'square', hz(root + (i % 2 ? 12 : 0)), t, STEP * 0.8, i % 2 ? 0.12 : 0.2, 900);
    } else if (st.bass === 'pulse') {
      if (i % 2 === 0) note(layers.bass, 'sawtooth', hz(root), t, STEP * 1.8, 0.2, 520);
    } else if (st.bass === 'chip') {
      if (i % 2 === 0) note(layers.bass, 'square', hz(root + (i % 8 === 4 ? 7 : 0)), t, STEP * 1.2, 0.13, 1600);
    } else if (st.bass === 'march') {
      if (i % 4 === 0) note(layers.bass, 'triangle', hz(root + (i === 4 || i === 12 ? 7 : 0)), t, STEP * 3, 0.32, 1200);
    }
    if (level.drums > 0.01) {
      if (st.drums === 'pop') {
        if (i === 0 || i === 8 || (second && i === 10)) kick(t);
        if (i === 4 || i === 12) snare(t);
        if (i % 2 === 0) hat(t, 0.03, 0.18);
      } else if (st.drums === 'disco') {
        if (i % 4 === 0) kick(t);
        if (i === 4 || i === 12) snare(t);
        if (i % 4 === 2) hat(t, 0.12, 0.34);
        else hat(t, 0.02, 0.1);
      } else if (st.drums === 'halftime') {
        if (i === 0 || i === 10) kick(t);
        if (i === 8) snare(t, 1.4);
        if (i % 2 === 0) hat(t, 0.04, 0.16);
      } else if (st.drums === 'chip') {
        if (i === 0 || i === 8 || i === 11) kick(t);
        if (i === 4 || i === 12) snare(t, 0.8);
        hat(t, 0.015, 0.12);
      } else if (st.drums === 'march') {
        if (i === 0 || i === 8) kick(t);
        if (i === 4 || i === 12) snare(t);
        if ((i === 14 || i === 15) && bar % 2 === 1) snare(t, 0.45);
        if (i === 2 || i === 6 || i === 10) snare(t, 0.25);
      }
    }
    if (level.hats > 0.01 && i % 2 === 1) hat(t, 0.09, 0.5, layers.hats);
    if (level.arp > 0.01) {
      const k = T.arp[i % 8];
      const m = k === 3 ? chord[0] + 12 : chord[k];
      note(layers.arp, st.arp, hz(m + 12), t, STEP * 0.9, st.arp === 'triangle' ? 0.09 : 0.06, 2600);
    }
    if (level.lead > 0.01) {
      for (const [at, m, len] of T.lead[bar]) if (at === i) lead(m, t, STEP * len);
    }
    if (level.bells > 0.01 && (i === 0 || i === 10)) bell(hz(chord[i === 0 ? 2 : 1] + 24), t, layers.bells, 0.08);
  }

  function note(dest, type, f, t, dur, vol, cutoff) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function pad(chord, t, dur) {
    for (const m of chord) {
      for (const det of [-6, 6]) {
        const o = ac.createOscillator();
        o.type = 'triangle';
        o.frequency.value = hz(m);
        o.detune.value = det;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.035, t + 0.12);
        g.gain.setValueAtTime(0.035, t + dur - 0.15);
        g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.1);
        o.connect(g).connect(layers.pad);
        o.start(t);
        o.stop(t + dur + 0.15);
      }
    }
  }

  function lead(m, t, dur) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.015);
    g.gain.setValueAtTime(0.09, t + Math.max(0.02, dur - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    lp.connect(g);
    g.connect(layers.lead);
    g.connect(delay);
    for (const [type, det] of [[T.style.lead[0], -5], [T.style.lead[1], 5]]) {
      const o = ac.createOscillator();
      o.type = type;
      o.frequency.value = hz(m);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }

  function bell(f, t, dest, vol) {
    const car = ac.createOscillator();
    const mod = ac.createOscillator();
    const modGain = ac.createGain();
    car.frequency.value = f;
    mod.frequency.value = f * 3.5;
    modGain.gain.setValueAtTime(f * 1.2, t);
    modGain.gain.exponentialRampToValueAtTime(1, t + 0.6);
    mod.connect(modGain).connect(car.frequency);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    car.connect(g);
    g.connect(dest);
    g.connect(delay);
    car.start(t);
    mod.start(t);
    car.stop(t + 1);
    mod.stop(t + 1);
  }

  function kick(t) {
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(g).connect(layers.drums);
    o.start(t);
    o.stop(t + 0.3);
  }

  function snare(t, loud = 1) {
    const n = ac.createBufferSource();
    n.buffer = noise;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1300;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.22 * loud, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    n.connect(hp).connect(g).connect(layers.drums);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.2);
    note(layers.drums, 'triangle', 190, t, 0.08, 0.12, 2000);
  }

  function hat(t, dur, vol, dest = layers.drums) {
    const n = ac.createBufferSource();
    n.buffer = noise;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol * 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp).connect(g).connect(dest);
    n.start(t, Math.random() * 0.5);
    n.stop(t + dur + 0.02);
  }

  function fade(name, value, secs = 0.6) {
    level[name] = value;
    const g = layers[name];
    if (!g) return;
    const now = ac.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(value, now + secs);
  }

  function stopFile() {
    if (!file) return;
    try {
      file.source.stop();
    } catch {
      /* already stopped */
    }
    file.gain.disconnect();
    file = null;
    if (ac) for (const name of Object.keys(level)) layers[name].gain.setValueAtTime(level[name], ac.currentTime);
  }

  /** Current chord's notes, for sound effects that fit the music. */
  function chordNow() {
    const s = ac ? Math.max(0, step - Math.round((nextTime - ac.currentTime) / STEP)) : 0;
    return T.chords[Math.floor((((s % 256) + 256) % 256) / 16)];
  }

  return {
    get muted() {
      return state.muted;
    },
    unlock,
    setMuted(m) {
      state.muted = m;
      if (!context) session(m);
      if (!master) return;
      if (!m && ac.state === 'suspended' && !context) {
        ac.resume();
        nextTime = Math.max(nextTime, ac.currentTime + 0.05);
      }
      const now = ac.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(m ? 0 : 0.8, now + 0.25);
      if (m && !context) setTimeout(() => state.muted && ac.state === 'running' && ac.suspend(), 320);
    },
    /** 'menu' (calm), 'play' or 'over'. */
    setScene(scene) {
      if (scene === state.scene) return;
      state.scene = scene;
      if (!ac) return;
      const playing = scene === 'play';
      fade('drums', playing ? 0.9 : 0, 0.8);
      fade('arp', playing ? 0.8 : scene === 'menu' ? 0.35 : 0, 0.8);
      if (!playing) {
        fade('lead', 0, 1.2);
        fade('hats', 0, 0.3);
        fade('bells', 0, 0.8);
      }
    },
    /** While playing: the lead joins once the chain is bigger, hats while running, bells while holding hands. */
    setIntensity({ size = 0, running = false, linked = false }) {
      if (!ac || state.scene !== 'play') return;
      const lead = size >= 30 ? 0.85 : 0;
      if (Math.abs(level.lead - lead) > 0.01) fade('lead', lead, 1.5);
      const hats = running ? 0.9 : 0;
      if (Math.abs(level.hats - hats) > 0.01) fade('hats', hats, 0.15);
      const bells = linked ? 0.9 : 0;
      if (Math.abs(level.bells - bells) > 0.01) fade('bells', bells, 0.8);
    },
    /** Sound effects: 'pick' (someone joined your chain), 'link', 'offer', 'broke' (someone ran into you), 'break'. */
    sfx(name) {
      if (!ac || ac.state !== 'running') return;
      const t = ac.currentTime + 0.005;
      const chord = chordNow();
      if (name === 'pick') {
        if (t - lastBlip < 0.07) return;
        lastBlip = t;
        combo = t - comboAt < 0.7 ? combo + 1 : 0;
        comboAt = t;
        const m = chord[combo % 3] + 24 + 12 * Math.floor((combo % 6) / 3);
        note(master, 'sine', hz(m), t, 0.12, 0.07, 6000);
      } else if (name === 'link') {
        chord.forEach((m, k) => bell(hz(m + 24), t + k * 0.09, master, 0.1));
      } else if (name === 'offer') {
        bell(hz(chord[2] + 24), t, master, 0.07);
        bell(hz(chord[0] + 36), t + 0.12, master, 0.07);
      } else if (name === 'broke') {
        note(master, 'triangle', hz(chord[0] + 12), t, 0.25, 0.12, 1500);
      } else if (name === 'break') {
        const o = ac.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(420, t);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.55);
        const lp = ac.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        const g = ac.createGain();
        g.gain.setValueAtTime(0.14, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(lp).connect(g).connect(master);
        o.start(t);
        o.stop(t + 0.65);
        kick(t);
      }
    },
    /** Offline rendering: schedules every note up to `seconds` into the given context. */
    renderUntil(seconds) {
      while (nextTime < seconds) advance();
    },
    tracks: TRACKS,
    /** The track playing (or about to): its id, or 'file' while a song file plays. */
    get track() {
      return file ? 'file' : (pending || T).id;
    },
    get fileTitle() {
      return file?.title ?? '';
    },
    /** Switches to another original track: at the next bar, or at once (now = true, e.g. when picking one). */
    setTrack(id, now = false) {
      const next = TRACKS.find((t) => t.id === id);
      if (!next) return;
      stopFile();
      if (!ac || now) {
        T = next;
        pending = null;
        STEP = 60 / T.bpm / 4;
        step = 0;
        if (ac) {
          nextTime = ac.currentTime + 0.06;
          delay.delayTime.setValueAtTime(STEP * 3, ac.currentTime);
        }
      } else if (next !== T) pending = next;
    },
    /** Plays a song file (an ArrayBuffer: one the player picked on their phone, or a licensed one) on a loop. */
    async playFile(data, title = '') {
      unlock();
      if (!ac) throw new Error('no audio');
      const buffer = await ac.decodeAudioData(data);
      stopFile();
      const source = ac.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ac.createGain();
      gain.gain.value = 0.55;
      source.connect(gain).connect(master);
      source.start();
      file = { source, gain, title };
      for (const name of Object.keys(level)) layers[name].gain.setValueAtTime(0, ac.currentTime);
    },
    /** Pauses everything while the page is hidden. */
    pause(on) {
      if (!ac) return;
      if (on) silent?.pause();
      else if (!state.muted) silent?.play().catch(() => {});
      if (on && ac.state === 'running') ac.suspend();
      else if (!on && ac.state === 'suspended' && !state.muted) {
        ac.resume();
        nextTime = Math.max(nextTime, ac.currentTime + 0.05);
      }
    },
  };
}

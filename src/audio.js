// Ch-ch-chains — music and sound, synthesised with Web Audio (no audio files). An original bouncy synth-pop
// loop in D minor at 116 BPM whose layers follow the game: calm in the menus; drums and arpeggios while you play;
// the lead melody once your chain grows; extra hi-hats while you run; bells when you hold hands.
// Browsers only allow sound after a tap, so nothing plays until unlock() is called from one.

const BPM = 116;
const STEP = 60 / BPM / 4; // one sixteenth note, seconds
const LOOKAHEAD = 0.14;

// Sixteen bars: section A then section B, one chord per bar.
const CHORDS = [
  // A
  [62, 65, 69], [58, 62, 65], [65, 69, 72], [60, 64, 67], [62, 65, 69], [58, 62, 65], [65, 69, 72], [57, 61, 64],
  // B
  [58, 62, 65], [60, 64, 67], [57, 60, 64], [62, 65, 69], [58, 62, 65], [60, 64, 67], [62, 65, 69], [62, 65, 69],
];
const ROOTS = [38, 34, 41, 36, 38, 34, 41, 45, 34, 36, 45, 38, 34, 36, 38, 38];
// The lead melody, [step, midi note, length in steps] per bar.
const LEAD = [
  [[0, 69, 3], [4, 74, 2], [6, 72, 2], [8, 69, 3], [12, 67, 2], [14, 65, 2]],
  [[0, 65, 3], [4, 62, 2], [6, 65, 2], [8, 67, 2], [10, 69, 6]],
  [[0, 72, 3], [4, 74, 2], [6, 72, 2], [8, 69, 2], [10, 65, 2], [12, 69, 4]],
  [[0, 67, 4], [4, 64, 2], [6, 67, 2], [8, 72, 4], [12, 69, 2], [14, 67, 2]],
  [[0, 69, 3], [4, 74, 2], [6, 76, 2], [8, 77, 3], [12, 76, 2], [14, 74, 2]],
  [[0, 74, 4], [4, 70, 2], [6, 74, 2], [8, 77, 4], [12, 74, 4]],
  [[0, 72, 2], [2, 69, 2], [4, 72, 2], [6, 77, 2], [8, 76, 4], [12, 72, 4]],
  [[0, 73, 6], [8, 69, 2], [10, 73, 2], [12, 76, 4]],
  [[0, 74, 6], [8, 72, 2], [10, 70, 2], [12, 69, 4]],
  [[0, 67, 6], [8, 69, 2], [10, 72, 2], [12, 76, 4]],
  [[0, 76, 4], [4, 74, 2], [6, 72, 2], [8, 69, 8]],
  [[0, 74, 4], [4, 77, 4], [8, 81, 6], [14, 79, 2]],
  [[0, 77, 4], [4, 74, 2], [6, 77, 2], [8, 82, 4], [12, 81, 4]],
  [[0, 79, 4], [4, 76, 2], [6, 72, 2], [8, 76, 4], [12, 79, 4]],
  [[0, 77, 3], [4, 76, 2], [6, 74, 2], [8, 72, 2], [10, 69, 6]],
  [[0, 74, 12]],
];
const ARP = [0, 1, 2, 1, 0, 1, 2, 3]; // chord tone index per sixteenth (3 = the root an octave up)

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** context: an (Offline)AudioContext to use instead of making one — for rendering the music to a file. */
export function createAudio({ muted = false, context = null } = {}) {
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

  function unlock() {
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
    if (ac.state === 'suspended') ac.resume();
    if (!timer) {
      nextTime = ac.currentTime + 0.08;
      timer = setInterval(schedule, 25);
    }
  }

  function schedule() {
    if (!ac || ac.state !== 'running') return;
    while (nextTime < ac.currentTime + LOOKAHEAD) {
      play(step, nextTime);
      nextTime += STEP;
      step = (step + 1) % (16 * 16);
    }
  }

  function play(s, t) {
    const bar = Math.floor(s / 16);
    const i = s % 16;
    const chord = CHORDS[bar];
    const B = bar >= 8;
    if (i === 0) pad(chord, t, STEP * 16);
    // Bass: bouncy eighths, jumping an octave on the off-beats.
    if (i % 2 === 0) note(layers.bass, 'sawtooth', hz(ROOTS[bar] + (i % 4 === 2 ? 12 : 0)), t, STEP * 1.6, 0.22, 700);
    if (level.drums > 0.01) {
      if (i === 0 || i === 8 || (B && i === 10)) kick(t);
      if (i === 4 || i === 12) snare(t);
      if (i % 2 === 0) hat(t, 0.03, 0.18);
    }
    if (level.hats > 0.01 && i % 2 === 1) hat(t, 0.09, 0.5, layers.hats);
    if (level.arp > 0.01) {
      const k = ARP[i % 8];
      const m = k === 3 ? chord[0] + 12 : chord[k];
      note(layers.arp, 'square', hz(m + 12), t, STEP * 0.9, 0.06, 2600);
    }
    if (level.lead > 0.01) {
      for (const [at, m, len] of LEAD[bar]) if (at === i) lead(m, t, STEP * len);
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
    for (const [type, det] of [['square', -5], ['sawtooth', 5]]) {
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

  function snare(t) {
    const n = ac.createBufferSource();
    n.buffer = noise;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1300;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.22, t);
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

  /** Current chord's notes, for sound effects that fit the music. */
  function chordNow() {
    const s = ac ? Math.max(0, step - Math.round((nextTime - ac.currentTime) / STEP)) : 0;
    return CHORDS[Math.floor((((s % 256) + 256) % 256) / 16)];
  }

  return {
    get muted() {
      return state.muted;
    },
    unlock,
    setMuted(m) {
      state.muted = m;
      if (!master) return;
      const now = ac.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(m ? 0 : 0.8, now + 0.25);
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
      while (nextTime < seconds) {
        play(step, nextTime);
        nextTime += STEP;
        step = (step + 1) % (16 * 16);
      }
    },
    /** Pauses everything while the page is hidden. */
    pause(on) {
      if (!ac) return;
      if (on && ac.state === 'running') ac.suspend();
      else if (!on && ac.state === 'suspended') {
        ac.resume();
        nextTime = Math.max(nextTime, ac.currentTime + 0.05);
      }
    },
  };
}

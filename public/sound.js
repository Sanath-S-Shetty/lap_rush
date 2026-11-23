// Sound effects for Lap Rush, synthesized live with the Web Audio API (no audio files).
// Design goals: warm engine with gear shifts, soft rounded effects, nothing harsh or hissy.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Speed bands (px/s) for the 5 gears. Engine pitch climbs inside a gear, then drops on a shift.
const GEARS = [0, 140, 270, 400, 530, 900];
const MASTER = 0.55;

export function createSound() {
  let ctx = null, master = null, noiseBuf = null;
  let engine = null, skid = null, charger = null;
  let muted = false;
  let offset = 0; // used only for the offline preview render
  try { muted = localStorage.getItem('lapRushMuted') === '1'; } catch (e) { /* ignore */ }

  const now = () => ctx.currentTime + offset;

  function setup(context) {
    ctx = context;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // ---- engine: a warm harmonic tone (strong low harmonics) + sub-octave, gently filtered ----
    const harmonics = [0, 1, 0.75, 0.5, 0.42, 0.25, 0.18, 0.1, 0.07, 0.04];
    const wave = ctx.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));
    const o1 = ctx.createOscillator(); o1.setPeriodicWave(wave);
    const o2 = ctx.createOscillator(); o2.setPeriodicWave(wave); o2.detune.value = 9; // slight chorus
    const sub = ctx.createOscillator(); sub.type = 'sine';
    const subGain = ctx.createGain(); subGain.gain.value = 0.55;
    // a slow wobble on the volume makes it sound like a combustion engine instead of a synth
    const lfo = ctx.createOscillator(); lfo.frequency.value = 18;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.18;
    const wobble = ctx.createGain(); wobble.gain.value = 0.82;
    lfo.connect(lfoDepth).connect(wobble.gain);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 500; filt.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0;
    o1.connect(filt); o2.connect(filt); sub.connect(subGain).connect(filt);
    filt.connect(wobble).connect(g).connect(master);
    for (const o of [o1, o2, sub, lfo]) o.start();
    engine = { o1, o2, sub, lfo, filt, g };

    // ---- tyre squeal: two close sine tones with fast vibrato (only while sliding) ----
    const s1 = ctx.createOscillator(); s1.type = 'triangle'; s1.frequency.value = 1180;
    const s2 = ctx.createOscillator(); s2.type = 'triangle'; s2.frequency.value = 1245;
    const vib = ctx.createOscillator(); vib.frequency.value = 23;
    const vibDepth = ctx.createGain(); vibDepth.gain.value = 35;
    vib.connect(vibDepth); vibDepth.connect(s1.frequency); vibDepth.connect(s2.frequency);
    const sbp = ctx.createBiquadFilter(); sbp.type = 'bandpass'; sbp.frequency.value = 1300; sbp.Q.value = 2;
    const sg = ctx.createGain(); sg.gain.value = 0;
    s1.connect(sbp); s2.connect(sbp); sbp.connect(sg).connect(master);
    for (const o of [s1, s2, vib]) o.start();
    skid = { g: sg, f: sbp, o1: s1, o2: s2 };

    // ---- drift charge: a quiet tone that steps up a note per charge tier ----
    const c1 = ctx.createOscillator(); c1.type = 'triangle'; c1.frequency.value = 330;
    const c2 = ctx.createOscillator(); c2.type = 'sine'; c2.frequency.value = 660;
    const cg = ctx.createGain(); cg.gain.value = 0;
    const clp = ctx.createBiquadFilter(); clp.type = 'lowpass'; clp.frequency.value = 2200;
    c1.connect(clp); c2.connect(clp); clp.connect(cg).connect(master);
    c1.start(); c2.start();
    charger = { g: cg, o1: c1, o2: c2 };
  }

  // Browsers only allow audio after a click/keypress, so call this from one.
  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) setup(new AC());
  }

  // Called every frame with the car's state.
  function update({ active, speed, throttle, boost, air, sliding, drifting, charge }) {
    if (!ctx) return;
    const t = now();
    const v = Math.abs(speed);
    let gear = 1;
    while (gear < GEARS.length - 1 && v > GEARS[gear]) gear++;
    const lo = GEARS[gear - 1], hi = GEARS[gear];
    let rpm = clamp((v - lo) / (hi - lo), 0, 1);
    rpm = gear === 1 ? 0.12 + rpm * 0.88 : 0.35 + rpm * 0.65;
    if (air && throttle) rpm = Math.min(1.1, rpm + 0.25); // free-revving in the air
    const f = 46 + rpm * 92 + gear * 5 + (boost ? 10 : 0);

    engine.o1.frequency.setTargetAtTime(f, t, 0.05);
    engine.o2.frequency.setTargetAtTime(f, t, 0.05);
    engine.sub.frequency.setTargetAtTime(f / 2, t, 0.05);
    engine.lfo.frequency.setTargetAtTime(f / 4, t, 0.05);
    engine.filt.frequency.setTargetAtTime(f * (throttle ? 9 : 5) + 300, t, 0.08);
    engine.g.gain.setTargetAtTime(active ? (throttle ? 0.085 : 0.05) : 0, t, 0.12);

    // tyre squeal: louder and pitched up while you are actually drifting
    const squeal = active && !air && (drifting || sliding);
    const level = drifting ? 0.055 : 0.03;
    skid.g.gain.setTargetAtTime(squeal ? level : 0, t, squeal ? 0.03 : 0.08);
    const sf = drifting ? 1500 + clamp(v / 600, 0, 1) * 500 : 1300;
    skid.f.frequency.setTargetAtTime(sf, t, 0.1);

    // charge tone: silent while gripping, one note higher per tier
    const tier = clamp(charge || 0, 0, 3);
    const notes = [0, 392, 523, 698];
    if (tier > 0) {
      charger.o1.frequency.setTargetAtTime(notes[tier], t, 0.04);
      charger.o2.frequency.setTargetAtTime(notes[tier] * 2, t, 0.04);
    }
    charger.g.gain.setTargetAtTime(active && tier > 0 && drifting ? 0.022 + tier * 0.004 : 0, t, 0.05);
  }

  // ---- one-shot building blocks ----
  function tone(freq, dur, { type = 'sine', vol = 0.2, delay = 0, slide = null, attack = 0.008 } = {}) {
    if (!ctx || !(vol > 0.001)) return; // far away / silent: skip
    const t = now() + delay;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function bell(freq, dur, vol, delay = 0) { // pleasant chime: fundamental + soft inharmonic partial
    tone(freq, dur, { vol, delay });
    tone(freq * 2.76, dur * 0.5, { vol: vol * 0.25, delay });
  }
  function noise(dur, vol, { freq = 800, to = null, type = 'lowpass', q = 0.7, delay = 0, attack = 0.005 } = {}) {
    if (!ctx || !(vol > 0.001)) return;
    const t = now() + delay;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
  const vol = (v) => clamp(v, 0, 1);

  const sfx = {
    beep: () => { tone(440, 0.25, { vol: 0.16 }); tone(880, 0.15, { vol: 0.04 }); },
    go: () => { tone(880, 0.7, { vol: 0.17 }); tone(1320, 0.5, { vol: 0.05 }); },
    wall: (strength, k = 1) => {
      const v = vol(strength / 450) * k;
      if (v < 0.03) return;
      tone(85, 0.25, { vol: 0.45 * v, slide: 45 });
      noise(0.22, 0.35 * v, { freq: 700, to: 200 });
    },
    boost: () => {
      noise(0.7, 0.45, { freq: 300, to: 2400, type: 'bandpass', q: 1.2, attack: 0.08 });
      tone(180, 0.6, { vol: 0.16, slide: 520, attack: 0.05 });
    },
    launch: () => { noise(0.5, 0.35, { freq: 400, to: 1400, type: 'bandpass', q: 1, attack: 0.1 }); tone(300, 0.4, { type: 'triangle', vol: 0.08, slide: 700, attack: 0.04 }); },
    land: (v) => {
      const k = clamp(v / 220, 0.25, 1);
      tone(65, 0.32, { vol: 0.55 * k, slide: 38 });
      noise(0.18, 0.2 * k, { freq: 450, to: 150 });
    },
    lap: () => { bell(784, 0.9, 0.16); bell(1175, 1.1, 0.14, 0.13); },
    finalLap: () => [659, 784, 988, 1319].forEach((f, i) => bell(f, 0.8, 0.12, i * 0.11)),
    finish: () => {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.5, { type: 'triangle', vol: 0.12, delay: i * 0.14 }));
      [262, 330, 392, 523].forEach((f, i) => tone(f, 0.6, { vol: 0.12, delay: i * 0.14 }));
      bell(1047, 1.8, 0.14, 0.6); bell(1568, 1.6, 0.08, 0.6);
    },
    pickup: () => [1047, 1319, 1568].forEach((f, i) => bell(f, 0.35, 0.1, i * 0.06)),
    oilDrop: () => { noise(0.25, 0.45, { freq: 350, to: 120 }); tone(260, 0.2, { vol: 0.2, slide: 90 }); },
    slip: (k = 1) => { tone(700, 0.6, { type: 'triangle', vol: 0.11 * k, slide: 380 }); noise(0.4, 0.15 * k, { freq: 1500, type: 'bandpass', q: 3 }); },
    throwBomb: () => { noise(0.35, 0.4, { freq: 1500, to: 350, type: 'bandpass', q: 1.5, attack: 0.02 }); tone(500, 0.3, { type: 'triangle', vol: 0.06, slide: 200 }); },
    boom: (k = 1) => {
      if (k < 0.03) return;
      noise(1.4, 0.7 * k, { freq: 1600, to: 70, attack: 0.004 });
      tone(55, 0.9, { vol: 0.6 * k, slide: 30 });
    },
    shield: () => [880, 1109, 1319, 1760].forEach((f, i) => tone(f, 0.5, { vol: 0.06, delay: i * 0.04, attack: 0.03 })),
    block: () => { bell(1568, 0.6, 0.15); bell(2093, 0.5, 0.08, 0.05); },
    nitro: () => { sfx.boost(); tone(120, 0.9, { vol: 0.1, slide: 300, attack: 0.05 }); },
    pedHit: () => { tone(110, 0.2, { vol: 0.35, slide: 60 }); tone(420, 0.45, { type: 'triangle', vol: 0.1, slide: 140, delay: 0.05 }); },
    penalty: () => { tone(220, 0.22, { type: 'triangle', vol: 0.1 }); tone(165, 0.4, { type: 'triangle', vol: 0.1, delay: 0.2 }); },

    // ---- drifting ----
    driftStart: () => {
      noise(0.22, 0.2, { freq: 2200, to: 900, type: 'bandpass', q: 2.5, attack: 0.006 });
      tone(560, 0.18, { type: 'triangle', vol: 0.07, slide: 300 });
    },
    // cashing in a drift: brighter and longer the bigger the charge
    miniTurbo: (tier = 1) => {
      const base = [0, 523, 659, 784][tier];
      const dur = 0.3 + tier * 0.12;
      noise(0.45 + tier * 0.12, 0.3 + tier * 0.1, { freq: 500, to: 2800 + tier * 700, type: 'bandpass', q: 1.1, attack: 0.03 });
      [0, 1, 2].forEach((i) => bell(base * Math.pow(2, i / 2), dur, 0.1 + tier * 0.015, i * 0.055));
      tone(150, 0.5, { vol: 0.13 + tier * 0.03, slide: 380 + tier * 120, attack: 0.03 });
    },
    trick: () => {
      [523, 659, 880, 1175, 1568].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.09, delay: i * 0.045 }));
      noise(0.4, 0.18, { freq: 700, to: 2600, type: 'bandpass', q: 1.4, attack: 0.05 });
    },
    draft: () => {
      noise(0.55, 0.3, { freq: 240, to: 1700, type: 'bandpass', q: 0.9, attack: 0.12 });
      tone(240, 0.5, { type: 'triangle', vol: 0.08, slide: 560, attack: 0.08 });
    },
    overtake: () => { bell(988, 0.3, 0.11); bell(1319, 0.35, 0.1, 0.08); },

    // ---- new items ----
    launchMissile: () => {
      noise(0.75, 0.42, { freq: 600, to: 2600, type: 'bandpass', q: 1.1, attack: 0.02 });
      tone(220, 0.7, { type: 'sawtooth', vol: 0.09, slide: 900, attack: 0.02 });
      tone(90, 0.3, { vol: 0.28, slide: 50 });
    },
    thunder: () => {
      noise(0.07, 0.75, { freq: 6000, to: 2500, type: 'bandpass', q: 0.7, attack: 0.002 }); // the crack
      noise(1.7, 0.5, { freq: 900, to: 60, attack: 0.02 });                                 // the rumble
      tone(48, 1.2, { vol: 0.5, slide: 28 });
      tone(1600, 0.12, { type: 'triangle', vol: 0.12, slide: 500 });
    },
    fizzle: () => { noise(0.3, 0.2, { freq: 1400, to: 300, type: 'bandpass', q: 1.5 }); tone(320, 0.25, { type: 'triangle', vol: 0.06, slide: 120 }); },
    // ---- smoke bomb / wings / gun / flip bomb ----
    smokePop: () => {
      noise(0.1, 0.4, { freq: 2600, to: 700, type: 'bandpass', q: 1.2, attack: 0.004 }); // the pop
      noise(1.1, 0.3, { freq: 900, to: 180, attack: 0.08 });                             // the hiss
      tone(170, 0.3, { vol: 0.16, slide: 70 });
    },
    takeoff: () => {
      noise(0.9, 0.34, { freq: 300, to: 2200, type: 'bandpass', q: 0.9, attack: 0.18 });
      [330, 440, 554, 740].forEach((f, i) => tone(f, 0.5, { type: 'triangle', vol: 0.085, delay: i * 0.07, attack: 0.03 }));
    },
    gunLoad: () => {
      noise(0.07, 0.3, { freq: 2400, to: 900, type: 'bandpass', q: 3, attack: 0.002 });
      noise(0.07, 0.26, { freq: 2000, to: 800, type: 'bandpass', q: 3, delay: 0.1, attack: 0.002 });
    },
    gunshot: (k = 1) => {
      if (k < 0.04) return;
      noise(0.09, 0.5 * k, { freq: 3200, to: 500, type: 'bandpass', q: 0.8, attack: 0.002 });
      tone(140, 0.12, { vol: 0.34 * k, slide: 55 });
    },
    shockwave: (k = 1) => {
      if (k < 0.05) return;
      tone(70, 0.8, { vol: 0.5 * k, slide: 24 });
      noise(0.7, 0.4 * k, { freq: 1500, to: 90, attack: 0.01 });
      tone(520, 0.4, { type: 'triangle', vol: 0.1 * k, slide: 150 });
    },

    // empty box: a little comedy "wah-wah" instead of a power-up chime
    mystery: () => {
      tone(392, 0.18, { type: 'triangle', vol: 0.1, slide: 330 });
      tone(294, 0.3, { type: 'triangle', vol: 0.1, slide: 233, delay: 0.16 });
      noise(0.2, 0.08, { freq: 900, to: 300, type: 'bandpass', q: 1.2, delay: 0.16 });
    },
  };

  return {
    init,
    update,
    ...sfx,
    toggleMute() {
      muted = !muted;
      try { localStorage.setItem('lapRushMuted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
      if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER, ctx.currentTime, 0.05);
      return muted;
    },
    get muted() { return muted; },
    // used by the preview renderer
    _setup: setup,
    _setOffset: (o) => { offset = o; },
  };
}

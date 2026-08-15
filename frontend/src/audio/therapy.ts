/**
 * Procedural sound-therapy generators.
 *
 * One generator per `engine` name in the backend's modality catalogue. Everything
 * is synthesised — the ocean, the rain, the forest, the music — so a prescription
 * is a set of parameters rather than a media file, and the platform ships without
 * a single audio asset.
 *
 * Two things every generator obeys:
 *
 *  - **Level comes from the prescription, in dBFS computed against the patient's
 *    own calibration.** No generator picks its own loudness.
 *  - **Slow onset.** Therapy fades in over seconds. A masker that snaps on at
 *    level is startling, and startling a hyperacusic patient is a clinical error.
 */

import { BiquadSpec, dbToGain, engine, makeNoiseBuffer, NoiseColor, OUTPUT_CEILING_DB } from "./engine";

export interface TherapyBlock {
  id: string;
  modality: string;
  engine: string;
  title: string;
  family: string;
  goal: string;
  minutes: number;
  schedule: string;
  priority: number;
  instruction?: string;
  evidence?: string | null;
  caution?: string | null;
  device_note?: string | null;
  params: Record<string, unknown>;
}

export interface TherapyHandle {
  stop(fade?: number): void;
  setLevelDb(db: number, ramp?: number): void;
  /** 0..1 progress for timed programmes (sleep ramp, RI burst, breathing). */
  progress?(): number;
  /** Live human-readable state, e.g. the breathing phase. */
  status?(): string;
}

const clampDb = (db: number) => Math.min(db, OUTPUT_CEILING_DB);

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Procedural reverb. A convolver fed an exponentially-decaying noise impulse
 * gives tonal material a sense of space; without it, synthesised bells and pads
 * sound like a test signal, which patients stop using within a week.
 */
function makeReverb(ctx: AudioContext, seconds = 2.6, decay = 2.4): ConvolverNode {
  const length = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse;
  return convolver;
}

/**
 * Lookahead scheduler. Web Audio events must be scheduled ahead of time against
 * `ctx.currentTime`; driving note onsets straight from setInterval produces
 * audible timing jitter.
 */
class Scheduler {
  private timer: number | null = null;
  private nextTime = 0;

  constructor(
    private ctx: AudioContext,
    private emit: (time: number) => number,
    private lookahead = 0.25
  ) {}

  start(): void {
    this.nextTime = this.ctx.currentTime + 0.1;
    const tick = () => {
      while (this.nextTime < this.ctx.currentTime + this.lookahead) {
        const gap = this.emit(this.nextTime);
        this.nextTime += Math.max(gap, 0.02);
      }
    };
    tick();
    this.timer = window.setInterval(tick, 80);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}

const PENTATONIC_MINOR = [0, 3, 5, 7, 10];
const PENTATONIC_MAJOR = [0, 2, 4, 7, 9];

function noteHz(semitonesFromA4: number): number {
  return 440 * Math.pow(2, semitonesFromA4 / 12);
}

function pickScale(name: unknown): number[] {
  return String(name).includes("major") ? PENTATONIC_MAJOR : PENTATONIC_MINOR;
}

/** A struck bell: sine fundamental plus a quiet inharmonic partial. */
function bell(
  ctx: AudioContext,
  destination: AudioNode,
  time: number,
  freq: number,
  gain: number,
  decay = 2.2
): void {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;

  const partial = ctx.createOscillator();
  partial.type = "sine";
  partial.frequency.value = freq * 2.76; // inharmonic — what makes it read as a bell
  const partialGain = ctx.createGain();
  partialGain.gain.value = 0.12;

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, time);
  envelope.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), time + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, time + decay);

  osc.connect(envelope);
  partial.connect(partialGain);
  partialGain.connect(envelope);
  envelope.connect(destination);

  osc.start(time);
  partial.start(time);
  osc.stop(time + decay + 0.1);
  partial.stop(time + decay + 0.1);
}

/** A short filtered noise transient — one raindrop, one leaf, one surf crest. */
function transient(
  ctx: AudioContext,
  destination: AudioNode,
  time: number,
  opts: { freq: number; q: number; gain: number; decay: number; type?: BiquadFilterType }
): void {
  const source = ctx.createBufferSource();
  source.buffer = makeNoiseBuffer(ctx, "white", 1);
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = opts.type ?? "bandpass";
  filter.frequency.value = opts.freq;
  filter.Q.value = opts.q;

  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, time);
  envelope.gain.exponentialRampToValueAtTime(Math.max(opts.gain, 0.0002), time + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.0001, time + opts.decay);

  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(destination);
  source.start(time, Math.random() * 0.8);
  source.stop(time + opts.decay + 0.05);
}

/** Standard output stage: master gain + slow fade, shared by every generator. */
function outputStage(dbfs: number, fadeInS: number) {
  const ctx = engine.context!;
  const out = ctx.createGain();
  out.gain.value = 0.0001;
  out.connect(engine.destination);

  const now = ctx.currentTime;
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(Math.max(dbToGain(clampDb(dbfs)), 0.0002), now + fadeInS);

  return {
    ctx,
    out,
    setLevelDb(db: number, ramp = 0.4) {
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, 0.0002), t);
      out.gain.exponentialRampToValueAtTime(Math.max(dbToGain(clampDb(db)), 0.0002), t + ramp);
    },
    fadeOut(fade: number, teardown: () => void) {
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, 0.0002), t);
      out.gain.exponentialRampToValueAtTime(0.0001, t + fade);
      setTimeout(() => {
        teardown();
        try {
          out.disconnect();
        } catch {
          /* already torn down */
        }
      }, (fade + 0.15) * 1000);
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Generators                                                                 */
/* ------------------------------------------------------------------------- */
type Generator = (block: TherapyBlock, dbfs: number) => TherapyHandle;

const num = (params: Record<string, unknown>, key: string, fallback: number): number => {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
};

/** Build the notch chain locally when the server did not embed one. */
function notchChain(params: Record<string, unknown>): BiquadSpec[] {
  const supplied = params.filterChain as BiquadSpec[] | undefined;
  if (Array.isArray(supplied) && supplied.length) return supplied;

  const centre = num(params, "notchHz", num(params, "centreHz", 6000));
  const widthOct = num(params, "notchWidthOctaves", 0.5);
  const depth = num(params, "notchDepthDb", 40);
  const stages = 3;
  // Fallback approximation of the server's calibrated per-stage bandwidth: a
  // cascade of N sections widens the composite skirt, so divide the target.
  const stageBw = widthOct / (1 + 0.72 * (stages - 1) * 2);
  const q = Math.sqrt(Math.pow(2, stageBw)) / (Math.pow(2, stageBw) - 1);
  return [
    { type: "highpass", frequency: 120, Q: 0.707 },
    ...Array.from({ length: stages }, () => ({
      type: "peaking" as const,
      frequency: centre,
      Q: q,
      gain: -Math.abs(depth) / stages,
    })),
    { type: "lowpass", frequency: num(params, "highCutHz", 14000), Q: 0.707 },
  ];
}

const shapedNoise: Generator = (block, dbfs) => {
  const p = block.params;
  const handle = engine.playNoise({
    color: (p.noiseColor as NoiseColor) ?? "pink",
    dbfs,
    fadeInS: 3,
    chain: [
      { type: "highpass", frequency: num(p, "lowCutHz", 100), Q: 0.707 },
      { type: "lowpass", frequency: num(p, "highCutHz", 12000), Q: 0.707 },
    ],
    lfo: { rateHz: 0.06, depth: 0.06 },
  });
  return { stop: (f) => handle.stop(f ?? 2), setLevelDb: (db, r) => handle.setLevelDb(clampDb(db), r) };
};

const notchedNoise: Generator = (block, dbfs) => {
  const handle = engine.playNoise({
    color: (block.params.noiseColor as NoiseColor) ?? "pink",
    dbfs,
    fadeInS: 4,
    chain: notchChain(block.params),
    lfo: { rateHz: 0.05, depth: 0.05 },
  });
  return { stop: (f) => handle.stop(f ?? 2.5), setLevelDb: (db, r) => handle.setLevelDb(clampDb(db), r) };
};

/**
 * Notched generative music: a slow modal pad whose notes are drawn from a
 * pentatonic scale, put through the therapy notch. Long-duration notched therapy
 * only works if the patient will actually leave it on for an hour, and almost
 * nobody will do that with noise.
 */
const notchedMusic: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 5);
  const { ctx, out } = stage;
  const p = block.params;

  const chain = engine.buildChain(notchChain(p));
  const reverb = makeReverb(ctx, 3.4, 2.2);
  const wet = ctx.createGain();
  wet.gain.value = 0.42;
  const dry = ctx.createGain();
  dry.gain.value = 0.6;

  const bus = ctx.createGain();
  bus.gain.value = 0.35;
  bus.connect(dry);
  bus.connect(reverb);
  reverb.connect(wet);

  if (chain) {
    dry.connect(chain.input);
    wet.connect(chain.input);
    chain.output.connect(out);
  } else {
    dry.connect(out);
    wet.connect(out);
  }

  const scale = pickScale(p.scale);
  const tempo = num(p, "tempo", 52);
  const beat = 60 / tempo;
  let step = 0;
  let degree = 2;

  const scheduler = new Scheduler(ctx, (time) => {
    // Random walk over the scale rather than a loop: a repeating melody becomes
    // predictable, and predictable material recaptures attention.
    degree += Math.floor(Math.random() * 3) - 1;
    degree = Math.max(-4, Math.min(9, degree));
    const octave = Math.random() < 0.28 ? 12 : 0;
    const semitone = scale[((degree % scale.length) + scale.length) % scale.length] + octave - 12;

    bell(ctx, bus, time, noteHz(semitone), 0.34, 3.6);
    if (step % 4 === 0) bell(ctx, bus, time, noteHz(semitone - 12), 0.22, 5.2);
    if (Math.random() < 0.3) bell(ctx, bus, time + beat * 0.5, noteHz(semitone + 7), 0.16, 2.6);
    step++;
    return beat * (Math.random() < 0.3 ? 3 : 2);
  });
  scheduler.start();

  return {
    stop: (fade = 3) => stage.fadeOut(fade, () => scheduler.stop()),
    setLevelDb: stage.setLevelDb,
  };
};

/** Ocean surf: brown noise with a swell on both amplitude and brightness. */
const oceanWaves: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 4);
  const { ctx, out } = stage;
  const p = block.params;
  const period = num(p, "swellPeriodS", 11);

  const source = ctx.createBufferSource();
  source.buffer = makeNoiseBuffer(ctx, "brown");
  source.loop = true;

  const body = ctx.createBiquadFilter();
  body.type = "lowpass";
  body.frequency.value = 900;
  body.Q.value = 0.6;

  const swellGain = ctx.createGain();
  swellGain.gain.value = 0.55;

  // Two LFOs at slightly different periods so successive waves are not identical.
  const swell = ctx.createOscillator();
  swell.frequency.value = 1 / period;
  const swellDepth = ctx.createGain();
  swellDepth.gain.value = 0.4;
  swell.connect(swellDepth);
  swellDepth.connect(swellGain.gain);

  const brightness = ctx.createOscillator();
  brightness.frequency.value = 1 / (period * 1.31);
  const brightnessDepth = ctx.createGain();
  brightnessDepth.gain.value = 620 * num(p, "brightness", 0.45) * 2;
  brightness.connect(brightnessDepth);
  brightnessDepth.connect(body.frequency);

  source.connect(body);
  body.connect(swellGain);
  swellGain.connect(out);
  source.start();
  swell.start();
  brightness.start();

  // Crests: sparse hiss bursts on top of the swell.
  const crestBus = ctx.createGain();
  crestBus.gain.value = 0.22 * num(p, "surfDensity", 0.6);
  crestBus.connect(out);
  const scheduler = new Scheduler(ctx, (time) => {
    transient(ctx, crestBus, time, { freq: 2400, q: 0.7, gain: 0.5, decay: 1.4, type: "highpass" });
    return period / 2 + Math.random() * period * 0.6;
  });
  scheduler.start();

  return {
    stop: (fade = 2.5) =>
      stage.fadeOut(fade, () => {
        scheduler.stop();
        source.stop();
        swell.stop();
        brightness.stop();
      }),
    setLevelDb: stage.setLevelDb,
  };
};

/** Rainfall: a filtered bed plus stochastic droplet transients. */
const rain: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 3);
  const { ctx, out } = stage;
  const p = block.params;
  const intensity = num(p, "intensity", 0.55);

  const bed = ctx.createBufferSource();
  bed.buffer = makeNoiseBuffer(ctx, "pink");
  bed.loop = true;
  const bedFilter = ctx.createBiquadFilter();
  bedFilter.type = "bandpass";
  bedFilter.frequency.value = 1400;
  bedFilter.Q.value = 0.5;
  const bedGain = ctx.createGain();
  bedGain.gain.value = 0.45 + intensity * 0.3;
  bed.connect(bedFilter);
  bedFilter.connect(bedGain);
  bedGain.connect(out);
  bed.start();

  const dropletBus = ctx.createGain();
  dropletBus.gain.value = 0.3;
  const reverb = makeReverb(ctx, 1.4, 3);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.3;
  dropletBus.connect(out);
  dropletBus.connect(reverb);
  reverb.connect(reverbGain);
  reverbGain.connect(out);

  const rate = num(p, "dropletRate", 34);
  const roofHz = num(p, "roofResonanceHz", 900);
  const scheduler = new Scheduler(ctx, (time) => {
    const count = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      transient(ctx, dropletBus, time + Math.random() * 0.05, {
        freq: roofHz * (0.6 + Math.random() * 2.4),
        q: 4 + Math.random() * 8,
        gain: 0.18 + Math.random() * 0.3,
        decay: 0.05 + Math.random() * 0.12,
      });
    }
    return (1 / rate) * (0.5 + Math.random());
  });
  scheduler.start();

  return {
    stop: (fade = 2) =>
      stage.fadeOut(fade, () => {
        scheduler.stop();
        bed.stop();
      }),
    setLevelDb: stage.setLevelDb,
  };
};

/** Forest: wind bed plus occasional birdcalls (FM sine sweeps). */
const forest: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 4);
  const { ctx, out } = stage;
  const p = block.params;

  const wind = ctx.createBufferSource();
  wind.buffer = makeNoiseBuffer(ctx, "pink");
  wind.loop = true;
  const canopy = ctx.createBiquadFilter();
  canopy.type = "bandpass";
  canopy.frequency.value = num(p, "canopyHz", 2600);
  canopy.Q.value = 0.4;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.4;

  const gust = ctx.createOscillator();
  gust.frequency.value = 0.055;
  const gustDepth = ctx.createGain();
  gustDepth.gain.value = num(p, "windDepth", 0.35);
  gust.connect(gustDepth);
  gustDepth.connect(windGain.gain);

  wind.connect(canopy);
  canopy.connect(windGain);
  windGain.connect(out);
  wind.start();
  gust.start();

  const birdBus = ctx.createGain();
  birdBus.gain.value = 0.18;
  const reverb = makeReverb(ctx, 2.2, 2.6);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.4;
  birdBus.connect(out);
  birdBus.connect(reverb);
  reverb.connect(reverbGain);
  reverbGain.connect(out);

  const perMin = num(p, "birdRatePerMin", 7);
  const scheduler = new Scheduler(ctx, (time) => {
    // A chirp is a short frequency sweep; a few in sequence reads as a call.
    const notes = 1 + Math.floor(Math.random() * 3);
    const base = 2200 + Math.random() * 2600;
    for (let i = 0; i < notes; i++) {
      const at = time + i * 0.11;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(0.5, at + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      osc.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.2), at);
      osc.frequency.exponentialRampToValueAtTime(base * (1.15 + Math.random() * 0.5), at + 0.07);
      osc.connect(envelope);
      envelope.connect(birdBus);
      osc.start(at);
      osc.stop(at + 0.14);
    }
    return (60 / Math.max(perMin, 1)) * (0.4 + Math.random() * 1.4);
  });
  scheduler.start();

  return {
    stop: (fade = 2.5) =>
      stage.fadeOut(fade, () => {
        scheduler.stop();
        wind.stop();
        gust.stop();
      }),
    setLevelDb: stage.setLevelDb,
  };
};

/** Fractal tones: aperiodic bell sequences, audible but not attention-capturing. */
const fractalTones: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 3);
  const { ctx, out } = stage;
  const p = block.params;

  const reverb = makeReverb(ctx, 4, 2);
  const wet = ctx.createGain();
  wet.gain.value = num(p, "reverb", 0.5);
  const bus = ctx.createGain();
  bus.gain.value = 0.3;
  bus.connect(out);
  bus.connect(reverb);
  reverb.connect(wet);
  wet.connect(out);

  const scale = pickScale(p.scale ?? "pentatonic_major");
  const density = num(p, "densityPerMin", 14);
  let degree = 0;

  const scheduler = new Scheduler(ctx, (time) => {
    // Self-similar structure: large jumps occasionally, small steps usually.
    const jump = Math.random() < 0.18 ? Math.floor(Math.random() * 7) - 3 : Math.floor(Math.random() * 3) - 1;
    degree = Math.max(-6, Math.min(12, degree + jump));
    const semitone = scale[((degree % scale.length) + scale.length) % scale.length] + 12 * Math.floor(degree / scale.length);
    bell(ctx, bus, time, noteHz(semitone), 0.4, 2.6 + Math.random() * 2.4);
    return (60 / Math.max(density, 1)) * (0.4 + Math.random() * 1.6);
  });
  scheduler.start();

  return {
    stop: (fade = 3) => stage.fadeOut(fade, () => scheduler.stop()),
    setLevelDb: stage.setLevelDb,
  };
};

/** Amplitude-modulated noise in the bands flanking the tinnitus frequency. */
const amMasker: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 2.5);
  const { ctx, out } = stage;
  const p = block.params;
  const centre = num(p, "centreHz", num(p, "notchHz", 6000));
  const offset = num(p, "flankOffsetOctaves", 0.55);
  const rate = num(p, "modRateHz", 10);
  const depth = num(p, "modDepth", 0.85);

  const modulator = ctx.createOscillator();
  modulator.frequency.value = rate;
  const modDepth = ctx.createGain();
  modDepth.gain.value = depth / 2;
  modulator.connect(modDepth);
  modulator.start();

  const sources: AudioBufferSourceNode[] = [];
  for (const factor of [Math.pow(2, -offset), Math.pow(2, offset)]) {
    const source = ctx.createBufferSource();
    source.buffer = makeNoiseBuffer(ctx, "white");
    source.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = centre * factor;
    band.Q.value = 3.2;
    const gain = ctx.createGain();
    gain.gain.value = 1 - depth / 2;
    modDepth.connect(gain.gain);
    source.connect(band);
    band.connect(gain);
    gain.connect(out);
    source.start();
    sources.push(source);
  }

  return {
    stop: (fade = 1.5) =>
      stage.fadeOut(fade, () => {
        sources.forEach((s) => s.stop());
        modulator.stop();
      }),
    setLevelDb: stage.setLevelDb,
  };
};

/**
 * Acoustic coordinated reset: four tones bracketing the tinnitus frequency,
 * presented in a shuffled order each cycle. The shuffling is the mechanism —
 * desynchronising pathologically synchronous firing requires the phase
 * relationship between tones to keep changing.
 */
const coordinatedReset: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 2);
  const { ctx, out } = stage;
  const p = block.params;
  const centre = num(p, "centreHz", num(p, "notchHz", 6000));
  const spacing = num(p, "toneSpacingOctaves", 0.29);
  const cycleHz = num(p, "cycleHz", 1.5);
  const onFraction = num(p, "onFraction", 0.6);
  const jitter = num(p, "jitter", 0.25);

  // Tass et al. use tones at roughly 0.766x, 0.9x, 1.1x, 1.4x the tinnitus pitch.
  const tones = [-1.5, -0.5, 0.5, 1.5].map((k) => centre * Math.pow(2, k * spacing));
  const cyclePeriod = 1 / cycleHz;
  const slot = (cyclePeriod * onFraction) / tones.length;

  const scheduler = new Scheduler(ctx, (time) => {
    const order = [...tones].sort(() => Math.random() - 0.5);
    order.forEach((freq, index) => {
      const at = time + index * slot + (Math.random() - 0.5) * jitter * slot;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const envelope = ctx.createGain();
      const dur = slot * 0.85;
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.exponentialRampToValueAtTime(0.5, at + dur * 0.2);
      envelope.gain.setValueAtTime(0.5, at + dur * 0.7);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(envelope);
      envelope.connect(out);
      osc.start(at);
      osc.stop(at + dur + 0.02);
    });
    return cyclePeriod;
  });
  scheduler.start();

  return {
    stop: (fade = 1) => stage.fadeOut(fade, () => scheduler.stop()),
    setLevelDb: stage.setLevelDb,
    status: () => `${tones.map((t) => `${Math.round(t)}`).join(" / ")} Hz, shuffled at ${cycleHz} Hz`,
  };
};

/**
 * Bimodal sound + haptic. The acoustic side is a tone sweep; the haptic side uses
 * the Vibration API, fired slightly ahead of each tone because the therapeutic
 * effect depends on the somatosensory input arriving a few milliseconds early.
 *
 * A clinical device pairs this with tongue or cervical stimulation; a phone's
 * vibration motor is a demonstration of the timing principle, not the hardware.
 */
const bimodal: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 2);
  const { ctx, out } = stage;
  const p = block.params;
  const centre = num(p, "centreHz", 6000);
  const rate = num(p, "pulseRateHz", 2.2);
  const lead = num(p, "hapticLeadMs", 5);
  const canVibrate = typeof navigator !== "undefined" && "vibrate" in navigator;

  const scheduler = new Scheduler(ctx, (time) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const dur = 0.09;
    osc.frequency.setValueAtTime(centre * 0.85, time);
    osc.frequency.exponentialRampToValueAtTime(centre * 1.18, time + dur);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, time);
    envelope.gain.exponentialRampToValueAtTime(0.55, time + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(envelope);
    envelope.connect(out);
    osc.start(time);
    osc.stop(time + dur + 0.02);

    if (canVibrate) {
      const delayMs = Math.max(0, (time - ctx.currentTime) * 1000 - lead);
      window.setTimeout(() => navigator.vibrate?.(28), delayMs);
    }
    return 1 / rate;
  });
  scheduler.start();

  return {
    stop: (fade = 1) =>
      stage.fadeOut(fade, () => {
        scheduler.stop();
        if (canVibrate) navigator.vibrate?.(0);
      }),
    setLevelDb: stage.setLevelDb,
    status: () =>
      canVibrate
        ? `Haptic pulse ${lead} ms ahead of each tone, ${rate} Hz`
        : "This device has no vibration motor — acoustic component only",
  };
};

/** Binaural beat with a warm pad. Requires headphones to work at all. */
const binaural: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 4);
  const { ctx, out } = stage;
  const p = block.params;
  const carrier = num(p, "carrierHz", 220);
  const beat = num(p, "beatHz", 4.5);

  const oscillators: OscillatorNode[] = [];
  for (const [freq, pan] of [
    [carrier - beat / 2, -1],
    [carrier + beat / 2, 1],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const gain = ctx.createGain();
    gain.gain.value = 0.28;
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(out);
    osc.start();
    oscillators.push(osc);
  }

  // Pad: a fifth above, slowly breathing, so it is pleasant rather than clinical.
  const pad = ctx.createOscillator();
  pad.type = "triangle";
  pad.frequency.value = carrier * 1.5;
  const padGain = ctx.createGain();
  padGain.gain.value = num(p, "padDepth", 0.4) * 0.12;
  const breath = ctx.createOscillator();
  breath.frequency.value = 0.07;
  const breathDepth = ctx.createGain();
  breathDepth.gain.value = 0.05;
  breath.connect(breathDepth);
  breathDepth.connect(padGain.gain);
  pad.connect(padGain);
  padGain.connect(out);
  pad.start();
  breath.start();
  oscillators.push(pad, breath);

  return {
    stop: (fade = 3) => stage.fadeOut(fade, () => oscillators.forEach((o) => o.stop())),
    setLevelDb: stage.setLevelDb,
    status: () => `${beat} Hz beat on a ${carrier} Hz carrier — headphones required`,
  };
};

/** 4-7-8 paced breathing with an audible envelope and a spoken-rhythm cue tone. */
const breathingPacer: Generator = (block, dbfs) => {
  const stage = outputStage(dbfs, 1);
  const { ctx, out } = stage;
  const p = block.params;
  const inhale = num(p, "inhaleS", 4);
  const hold = num(p, "holdS", 7);
  const exhale = num(p, "exhaleS", 8);
  const cycles = num(p, "cycles", 12);
  const toneHz = num(p, "toneHz", 174);
  const cycleLength = inhale + hold + exhale;

  const source = ctx.createBufferSource();
  source.buffer = makeNoiseBuffer(ctx, "brown");
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 700;
  const breathGain = ctx.createGain();
  breathGain.gain.value = 0.0001;
  source.connect(filter);
  filter.connect(breathGain);
  breathGain.connect(out);
  source.start();

  const drone = ctx.createOscillator();
  drone.type = "sine";
  drone.frequency.value = toneHz;
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0.06;
  drone.connect(droneGain);
  droneGain.connect(out);
  drone.start();

  // Schedule the whole session up front — breathing pacing must be metronomic.
  const start = ctx.currentTime + 0.2;
  for (let c = 0; c < cycles; c++) {
    const t0 = start + c * cycleLength;
    breathGain.gain.setValueAtTime(0.0001, t0);
    breathGain.gain.exponentialRampToValueAtTime(0.6, t0 + inhale);
    breathGain.gain.setValueAtTime(0.6, t0 + inhale + hold);
    breathGain.gain.exponentialRampToValueAtTime(0.0001, t0 + inhale + hold + exhale);

    for (const [offset, freq] of [
      [0, toneHz * 2],
      [inhale, toneHz * 3],
      [inhale + hold, toneHz * 1.5],
    ] as const) {
      const cue = ctx.createOscillator();
      cue.type = "sine";
      cue.frequency.value = freq;
      const cueGain = ctx.createGain();
      cueGain.gain.setValueAtTime(0.0001, t0 + offset);
      cueGain.gain.exponentialRampToValueAtTime(0.22, t0 + offset + 0.02);
      cueGain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.5);
      cue.connect(cueGain);
      cueGain.connect(out);
      cue.start(t0 + offset);
      cue.stop(t0 + offset + 0.6);
    }
  }

  const total = cycles * cycleLength;
  const began = ctx.currentTime;
  return {
    stop: (fade = 1) =>
      stage.fadeOut(fade, () => {
        source.stop();
        drone.stop();
      }),
    setLevelDb: stage.setLevelDb,
    progress: () => Math.min(1, (ctx.currentTime - began) / total),
    status: () => {
      const into = (ctx.currentTime - began) % cycleLength;
      if (into < inhale) return `Breathe in — ${Math.ceil(inhale - into)}`;
      if (into < inhale + hold) return `Hold — ${Math.ceil(inhale + hold - into)}`;
      return `Breathe out — ${Math.ceil(cycleLength - into)}`;
    },
  };
};

/** Overnight fade: masking at sleep onset that decays to silence. */
const sleepRamp: Generator = (block, dbfs) => {
  const p = block.params;
  const rampMinutes = num(p, "rampMinutes", 45);
  const floorDb = num(p, "floorGainDb", -60);

  const handle = engine.playNoise({
    color: (p.startColor as NoiseColor) ?? "brown",
    dbfs,
    fadeInS: 8,
    chain: [
      { type: "highpass", frequency: 60, Q: 0.707 },
      { type: "lowpass", frequency: num(p, "highCutHz", 6000), Q: 0.707 },
    ],
    lfo: { rateHz: 0.04, depth: 0.05 },
  });

  const ctx = engine.context!;
  const began = ctx.currentTime;
  const totalSeconds = rampMinutes * 60;
  // Decay over the ramp period, held in the Web Audio graph rather than a JS
  // timer, so it keeps working when the screen sleeps and the tab is throttled.
  handle.setLevelDb(floorDb, totalSeconds);

  return {
    stop: (f) => handle.stop(f ?? 4),
    setLevelDb: (db, r) => handle.setLevelDb(clampDb(db), r),
    progress: () => Math.min(1, (ctx.currentTime - began) / totalSeconds),
    status: () => {
      const remaining = Math.max(0, totalSeconds - (ctx.currentTime - began));
      return `Fading to silence — ${Math.ceil(remaining / 60)} min remaining`;
    },
  };
};

/** A timed narrowband burst at the tinnitus frequency, to induce residual inhibition. */
const riInduction: Generator = (block, dbfs) => {
  const p = block.params;
  const seconds = num(p, "burstSeconds", 45);
  const handle = engine.playBandNoise({
    centreHz: num(p, "centreHz", num(p, "notchHz", 6000)),
    bandwidthOctaves: num(p, "bandwidthOctaves", 0.4),
    dbfs,
    fadeInS: 0.8,
  });

  const ctx = engine.context!;
  const began = ctx.currentTime;
  const timer = window.setTimeout(() => handle.stop(0.4), seconds * 1000);

  return {
    stop: (fade = 0.4) => {
      window.clearTimeout(timer);
      handle.stop(fade);
    },
    setLevelDb: (db, r) => handle.setLevelDb(clampDb(db), r),
    progress: () => Math.min(1, (ctx.currentTime - began) / seconds),
    status: () => {
      const remaining = Math.max(0, seconds - (ctx.currentTime - began));
      return remaining > 0
        ? `Masking — ${Math.ceil(remaining)} s remaining, then listen for quiet`
        : "Listen — is it quieter than before?";
    },
  };
};

/* ------------------------------------------------------------------------- */
/* Registry                                                                   */
/* ------------------------------------------------------------------------- */
const GENERATORS: Record<string, Generator> = {
  notchedNoise,
  notchedMusic,
  shapedNoise,
  oceanWaves,
  rain,
  forest,
  fractalTones,
  amMasker,
  coordinatedReset,
  bimodal,
  binaural,
  breathingPacer,
  sleepRamp,
  riInduction,
};

/**
 * Start a therapy block.
 *
 * `dbfs` must already be computed from the patient's calibration and the block's
 * prescribed sensation level — see `sensationLevelToDbfs`.
 */
export function startTherapy(block: TherapyBlock, dbfs: number): TherapyHandle {
  const generator = GENERATORS[block.engine] ?? shapedNoise;
  return generator(block, clampDb(dbfs));
}

export function hasGenerator(engineName: string): boolean {
  return engineName in GENERATORS;
}

/**
 * Convert a prescribed sensation level into digital dBFS.
 *
 * dB SL is relative to *this patient's* threshold at the tinnitus frequency, so
 * the conversion needs that threshold. Without it (no audiogram yet) the level
 * falls back to a deliberately conservative default rather than guessing high.
 */
export function sensationLevelToDbfs(
  sensationLevelDb: number,
  thresholdDbHl: number | null,
  freqHz: number
): number {
  if (thresholdDbHl === null || !engine.calibration.calibratedAt) return -38;
  return clampDb(engine.hlToDbfs(thresholdDbHl + sensationLevelDb, freqHz));
}

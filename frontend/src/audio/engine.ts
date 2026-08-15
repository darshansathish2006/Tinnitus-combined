/**
 * Web Audio engine: stimulus generation, calibration, and safety limiting.
 *
 * Everything the patient hears — audiometric tones, maskers, all fifteen therapy
 * modalities — is synthesised here at runtime. There are no audio assets, which
 * means the whole platform works offline and the therapy spectrum is defined by
 * parameters rather than by a file someone rendered once.
 *
 * ## On calibration, honestly
 *
 * A browser cannot know the absolute sound pressure at the eardrum. It does not
 * know the headphone sensitivity, the DAC output level, or where the OS volume
 * slider is. Any web app claiming clinical-grade dB HL is lying.
 *
 * What this does instead is a documented two-step estimate:
 *
 *  1. **Reference levelling.** A 1 kHz tone is played and the patient raises the
 *     system volume until it sits at a defined loudness anchor (conversational
 *     speech, ~65 dB SPL). That pins one point on the output curve.
 *  2. **RETSPL correction.** Digital attenuation from that anchor is converted to
 *     estimated dB HL using the reference equivalent threshold SPL for the
 *     declared transducer type (ISO 389-1/-8 nominal values).
 *
 * The result is a *screening* threshold, comparable across sessions for the same
 * patient and hardware, and explicitly labelled as such everywhere it is shown.
 * `AudioEngine.calibrationQuality()` reports how much to trust it.
 */

export type NoiseColor = "white" | "pink" | "brown" | "blue" | "grey";
export type Transducer = "circumaural" | "supra_aural" | "insert" | "unknown";
export type Ear = "left" | "right" | "both";

export interface BiquadSpec {
  type: BiquadFilterType | "peaking" | "lowpass" | "highpass" | "lowshelf" | "notch";
  frequency: number;
  Q?: number;
  gain?: number;
}

/**
 * Reference equivalent threshold SPL, in dB, by transducer and frequency.
 * These are the nominal ISO 389 values: the SPL a tone must reach at a given
 * frequency for a normally-hearing listener to just detect it. Subtracting them
 * is what converts an SPL estimate into dB HL.
 *
 * Values are nominal for the transducer *class*, not for a specific headphone
 * model, so they carry real uncertainty — hence the screening-only labelling.
 */
const RETSPL: Record<Transducer, Record<number, number>> = {
  supra_aural: {
    125: 45.0, 250: 25.5, 500: 11.5, 750: 8.0, 1000: 7.0, 1500: 6.5,
    2000: 9.0, 3000: 10.0, 4000: 9.5, 6000: 15.5, 8000: 13.0,
    9000: 17.0, 10000: 19.0, 11200: 22.0, 12500: 26.0, 14000: 32.0, 16000: 45.0,
  },
  circumaural: {
    125: 30.5, 250: 18.5, 500: 11.0, 750: 7.5, 1000: 5.5, 1500: 4.5,
    2000: 4.5, 3000: 2.5, 4000: 9.5, 6000: 17.0, 8000: 17.5,
    9000: 20.0, 10000: 22.0, 11200: 25.0, 12500: 30.0, 14000: 36.0, 16000: 48.0,
  },
  insert: {
    125: 28.0, 250: 17.5, 500: 9.5, 750: 6.0, 1000: 5.5, 1500: 9.5,
    2000: 11.5, 3000: 13.0, 4000: 15.0, 6000: 16.0, 8000: 15.5,
    9000: 18.0, 10000: 20.0, 11200: 23.0, 12500: 27.0, 14000: 33.0, 16000: 46.0,
  },
  unknown: {
    125: 40.0, 250: 22.0, 500: 11.0, 750: 7.5, 1000: 6.5, 1500: 6.5,
    2000: 8.0, 3000: 9.0, 4000: 11.0, 6000: 16.0, 8000: 15.0,
    9000: 18.5, 10000: 20.5, 11200: 23.5, 12500: 28.0, 14000: 34.0, 16000: 46.0,
  },
};

/** The loudness anchor the patient levels the reference tone to. */
export const REFERENCE_SPL_DB = 65;

/** Absolute ceiling on delivered level. Nothing may exceed this, ever. */
export const OUTPUT_CEILING_DB = -3;

function interpolateRetspl(table: Record<number, number>, freq: number): number {
  const keys = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  if (freq <= keys[0]) return table[keys[0]];
  if (freq >= keys[keys.length - 1]) return table[keys[keys.length - 1]];
  for (let i = 0; i < keys.length - 1; i++) {
    const lo = keys[i];
    const hi = keys[i + 1];
    if (freq >= lo && freq <= hi) {
      const t = (Math.log2(freq) - Math.log2(lo)) / (Math.log2(hi) - Math.log2(lo));
      return table[lo] + t * (table[hi] - table[lo]);
    }
  }
  return table[keys[keys.length - 1]];
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-6));
}

export interface Calibration {
  transducer: Transducer;
  /** Digital dBFS the reference tone sat at when levelled. */
  referenceDbfs: number;
  referenceSplDb: number;
  ambientNoiseDb: number | null;
  calibratedAt: string | null;
  model?: string;
}

export const DEFAULT_CALIBRATION: Calibration = {
  transducer: "unknown",
  referenceDbfs: -20,
  referenceSplDb: REFERENCE_SPL_DB,
  ambientNoiseDb: null,
  calibratedAt: null,
};

export interface StimulusHandle {
  stop(fadeSeconds?: number): void;
  setLevelDb(db: number, rampSeconds?: number): void;
  readonly node: AudioNode;
  readonly id: string;
}

let handleCounter = 0;

/* ------------------------------------------------------------------------- */
/* Noise buffer synthesis                                                     */
/* ------------------------------------------------------------------------- */
const noiseCache = new Map<string, AudioBuffer>();

/**
 * Build a seamlessly-loopable noise buffer of the requested colour.
 *
 * Pink uses the Paul Kellet economy filter (an ~ -3 dB/octave approximation);
 * brown is a leaky integrator; blue is a first difference. The buffer is long
 * (8 s) so the loop period is not audible as a rhythm — a short noise loop is
 * immediately recognisable and is the usual tell of a cheap masker.
 */
export function makeNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor, seconds = 8): AudioBuffer {
  const key = `${color}:${seconds}:${ctx.sampleRate}`;
  const cached = noiseCache.get(key);
  if (cached) return cached;

  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);

  for (let channel = 0; channel < 2; channel++) {
    const out = buffer.getChannelData(channel);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let lastBrown = 0;
    let lastWhite = 0;

    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      let sample: number;

      switch (color) {
        case "pink":
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          b3 = 0.8665 * b3 + white * 0.3104856;
          b4 = 0.55 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.016898;
          sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          b6 = white * 0.115926;
          break;
        case "brown":
          sample = (lastBrown + 0.02 * white) / 1.02;
          lastBrown = sample;
          sample *= 3.5;
          break;
        case "blue":
          sample = (white - lastWhite) * 0.5;
          lastWhite = white;
          break;
        case "grey":
          // Perceptually flat: pink-weighted then tilted up at the extremes,
          // approximating an inverted equal-loudness contour.
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.969 * b2 + white * 0.153852;
          sample = (b0 + b1 + b2 + white * 0.35) * 0.16;
          break;
        default:
          sample = white * 0.32;
      }
      out[i] = Math.max(-1, Math.min(1, sample));
    }

    // Cross-fade the tail into the head so the loop point is inaudible.
    const fade = Math.min(2048, Math.floor(length / 8));
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      out[i] = out[i] * t + out[length - fade + i] * (1 - t);
    }
  }

  noiseCache.set(key, buffer);
  return buffer;
}

/* ------------------------------------------------------------------------- */
/* Engine                                                                     */
/* ------------------------------------------------------------------------- */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;
  private active = new Map<string, StimulusHandle>();
  calibration: Calibration = { ...DEFAULT_CALIBRATION };

  /** Resume/create the context. Must be called from a user gesture. */
  async resume(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: "playback", sampleRate: 48000 });

      // Master chain: gain -> limiter -> analyser -> destination.
      // The limiter is a hard safety backstop, not a sound-design choice: no bug
      // in a therapy generator may ever deliver a damaging level to a patient
      // who already has a hearing injury.
      this.master = this.ctx.createGain();
      this.master.gain.value = dbToGain(OUTPUT_CEILING_DB);

      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -6;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.75;

      this.master.connect(this.limiter);
      this.limiter.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get isRunning(): boolean {
    return this.ctx?.state === "running";
  }

  get destination(): GainNode {
    if (!this.master) throw new Error("AudioEngine not started — call resume() from a user gesture.");
    return this.master;
  }

  /** Live spectrum, for the visualiser. */
  spectrum(target: Uint8Array): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteFrequencyData(target as Uint8Array<ArrayBuffer>);
    return true;
  }

  waveform(target: Uint8Array): boolean {
    if (!this.analyser) return false;
    this.analyser.getByteTimeDomainData(target as Uint8Array<ArrayBuffer>);
    return true;
  }

  /* -- calibration -------------------------------------------------------- */
  setCalibration(partial: Partial<Calibration>): void {
    this.calibration = { ...this.calibration, ...partial };
  }

  /**
   * Convert a desired dB HL into the digital dBFS the engine should output.
   * `dBFS = referenceDbfs + (targetSPL - referenceSPL)` where the target SPL is
   * the requested HL plus that frequency's RETSPL.
   */
  hlToDbfs(dbHL: number, freq: number): number {
    const retspl = interpolateRetspl(RETSPL[this.calibration.transducer], freq);
    const targetSpl = dbHL + retspl;
    return this.calibration.referenceDbfs + (targetSpl - this.calibration.referenceSplDb);
  }

  dbfsToHl(dbfs: number, freq: number): number {
    const retspl = interpolateRetspl(RETSPL[this.calibration.transducer], freq);
    const spl = this.calibration.referenceSplDb + (dbfs - this.calibration.referenceDbfs);
    return spl - retspl;
  }

  /** Highest dB HL that is actually reachable at this frequency before clipping. */
  maxReachableHl(freq: number): number {
    return Math.floor(this.dbfsToHl(OUTPUT_CEILING_DB - 1, freq));
  }

  calibrationQuality(): { level: "uncalibrated" | "estimated" | "good"; note: string } {
    const c = this.calibration;
    if (!c.calibratedAt) {
      return {
        level: "uncalibrated",
        note: "No reference levelling performed. Levels are relative only and thresholds must not be read as dB HL.",
      };
    }
    if (c.transducer === "unknown") {
      return {
        level: "estimated",
        note: "Reference levelled but transducer type unknown, so nominal RETSPL corrections are used. Screening estimate only.",
      };
    }
    if (c.ambientNoiseDb !== null && c.ambientNoiseDb > 40) {
      return {
        level: "estimated",
        note: `Ambient noise measured at ${c.ambientNoiseDb.toFixed(0)} dB(A) — low-frequency thresholds are likely masked and overstated.`,
      };
    }
    return {
      level: "good",
      note: "Reference levelled with a declared transducer in a quiet environment. Screening estimate suitable for tracking change over time.",
    };
  }

  /**
   * Estimate ambient noise from the microphone, so an invalid test environment is
   * detected rather than silently producing overstated thresholds.
   * Returns null if permission is denied — this is optional, never blocking.
   */
  async measureAmbientNoise(seconds = 3): Promise<number | null> {
    if (!navigator.mediaDevices?.getUserMedia) return null;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = await this.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      const samples: number[] = [];
      const started = performance.now();

      await new Promise<void>((resolve) => {
        const tick = () => {
          analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>);
          let sum = 0;
          for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
          samples.push(Math.sqrt(sum / buffer.length));
          if (performance.now() - started < seconds * 1000) requestAnimationFrame(tick);
          else resolve();
        };
        tick();
      });

      source.disconnect();
      const rms = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
      // Uncalibrated microphone: map RMS to an indicative dB(A) with a nominal
      // 94 dB full-scale sensitivity. Reported as indicative, never as a measurement.
      const estimate = Math.max(20, Math.min(100, 94 + gainToDb(rms)));
      this.setCalibration({ ambientNoiseDb: Math.round(estimate * 10) / 10 });
      return this.calibration.ambientNoiseDb;
    } catch {
      return null;
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  }

  /* -- panning ------------------------------------------------------------ */
  private earPanner(ear: Ear): StereoPannerNode | GainNode {
    const ctx = this.ctx!;
    if (ear === "both") {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      return gain;
    }
    const panner = ctx.createStereoPanner();
    panner.pan.value = ear === "left" ? -1 : 1;
    return panner;
  }

  /* -- pure tone ---------------------------------------------------------- */
  /**
   * Present a pure tone. Audiometric tones are gated with a raised-cosine
   * envelope: an abrupt onset produces an audible click with broadband energy,
   * which the patient can detect even when they cannot hear the tone itself —
   * that would make every threshold wrong.
   */
  playTone(options: {
    freq: number;
    dbHL?: number;
    dbfs?: number;
    ear?: Ear;
    durationMs?: number | null;
    rampMs?: number;
    warble?: boolean;
  }): StimulusHandle {
    const ctx = this.ctx!;
    const { freq, ear = "both", durationMs = 1000, rampMs = 25, warble = false } = options;
    const dbfs =
      options.dbfs ?? (options.dbHL !== undefined ? this.hlToDbfs(options.dbHL, freq) : -30);
    const level = Math.min(dbfs, OUTPUT_CEILING_DB);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;

    let modulator: OscillatorNode | null = null;
    if (warble) {
      // 5 Hz FM at ±5%: a warble tone is less prone to standing-wave errors in a
      // room and is standard for sound-field and screening audiometry.
      modulator = ctx.createOscillator();
      modulator.frequency.value = 5;
      const modGain = ctx.createGain();
      modGain.gain.value = freq * 0.05;
      modulator.connect(modGain);
      modGain.connect(osc.frequency);
      modulator.start();
    }

    const envelope = ctx.createGain();
    envelope.gain.value = 0;
    const panner = this.earPanner(ear);

    osc.connect(envelope);
    envelope.connect(panner);
    panner.connect(this.destination);

    const now = ctx.currentTime;
    const ramp = rampMs / 1000;
    const target = dbToGain(level);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(Math.max(target, 0.0002), now + ramp);

    osc.start(now);
    const id = `tone-${handleCounter++}`;
    let stopped = false;

    const finish = (fade = ramp) => {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
      envelope.gain.cancelScheduledValues(t);
      envelope.gain.setValueAtTime(Math.max(envelope.gain.value, 0.0002), t);
      envelope.gain.exponentialRampToValueAtTime(0.0001, t + fade);
      osc.stop(t + fade + 0.02);
      modulator?.stop(t + fade + 0.02);
      setTimeout(() => {
        try {
          envelope.disconnect();
          panner.disconnect();
        } catch {
          /* already torn down */
        }
        this.active.delete(id);
      }, (fade + 0.1) * 1000);
    };

    if (durationMs !== null) {
      const hold = Math.max(durationMs / 1000 - ramp, 0.02);
      envelope.gain.setValueAtTime(Math.max(target, 0.0002), now + ramp + hold);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + ramp + hold + ramp);
      osc.stop(now + ramp + hold + ramp + 0.02);
      modulator?.stop(now + ramp + hold + ramp + 0.02);
      setTimeout(() => this.active.delete(id), durationMs + rampMs * 2 + 120);
    }

    const handle: StimulusHandle = {
      id,
      node: envelope,
      stop: (fade) => finish(fade ?? ramp),
      setLevelDb: (db, rampSeconds = 0.05) => {
        const t = ctx.currentTime;
        envelope.gain.cancelScheduledValues(t);
        envelope.gain.setValueAtTime(Math.max(envelope.gain.value, 0.0002), t);
        envelope.gain.exponentialRampToValueAtTime(
          Math.max(dbToGain(Math.min(db, OUTPUT_CEILING_DB)), 0.0002),
          t + rampSeconds
        );
      },
    };
    this.active.set(id, handle);
    return handle;
  }

  /* -- filter chains ------------------------------------------------------ */
  /**
   * Instantiate a filter chain from the backend's specification.
   * The server designs the notch (including the Q calibration that makes the
   * cascade hit its target width) and verifies the resulting spectrum with SciPy;
   * this builds exactly that chain, node for node, so what was verified is what
   * is delivered.
   */
  buildChain(specs: BiquadSpec[]): { input: AudioNode; output: AudioNode } | null {
    if (!specs.length) return null;
    const ctx = this.ctx!;
    const nodes = specs.map((spec) => {
      const filter = ctx.createBiquadFilter();
      filter.type = spec.type as BiquadFilterType;
      filter.frequency.value = spec.frequency;
      if (spec.Q !== undefined) filter.Q.value = spec.Q;
      if (spec.gain !== undefined) filter.gain.value = spec.gain;
      return filter;
    });
    nodes.reduce((prev, next) => {
      prev.connect(next);
      return next;
    });
    return { input: nodes[0], output: nodes[nodes.length - 1] };
  }

  /** Measure the magnitude response of a chain — used to plot what is delivered. */
  chainResponse(specs: BiquadSpec[], freqs: Float32Array): Float32Array {
    const ctx = this.ctx;
    const total = new Float32Array(freqs.length);
    if (!ctx) return total;
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    for (const spec of specs) {
      const filter = ctx.createBiquadFilter();
      filter.type = spec.type as BiquadFilterType;
      filter.frequency.value = spec.frequency;
      if (spec.Q !== undefined) filter.Q.value = spec.Q;
      if (spec.gain !== undefined) filter.gain.value = spec.gain;
      filter.getFrequencyResponse(
        freqs as Float32Array<ArrayBuffer>,
        mag as Float32Array<ArrayBuffer>,
        phase as Float32Array<ArrayBuffer>
      );
      for (let i = 0; i < total.length; i++) total[i] += 20 * Math.log10(Math.max(mag[i], 1e-6));
    }
    return total;
  }

  /* -- shaped noise ------------------------------------------------------- */
  playNoise(options: {
    color?: NoiseColor;
    dbfs?: number;
    ear?: Ear;
    chain?: BiquadSpec[];
    fadeInS?: number;
    lfo?: { rateHz: number; depth: number };
  }): StimulusHandle {
    const ctx = this.ctx!;
    const { color = "pink", dbfs = -34, ear = "both", chain, fadeInS = 1.5, lfo } = options;

    const source = ctx.createBufferSource();
    source.buffer = makeNoiseBuffer(ctx, color);
    source.loop = true;

    const envelope = ctx.createGain();
    envelope.gain.value = 0.0001;
    const panner = this.earPanner(ear);

    let head: AudioNode = source;
    const built = chain?.length ? this.buildChain(chain) : null;
    if (built) {
      head.connect(built.input);
      head = built.output;
    }
    head.connect(envelope);

    let tremolo: OscillatorNode | null = null;
    if (lfo) {
      // Slow amplitude modulation makes long listening far more tolerable than a
      // static hiss, and is what makes procedural surf and wind read as natural.
      tremolo = ctx.createOscillator();
      tremolo.frequency.value = lfo.rateHz;
      const depth = ctx.createGain();
      depth.gain.value = lfo.depth;
      tremolo.connect(depth);
      depth.connect(envelope.gain);
      tremolo.start();
    }

    envelope.connect(panner);
    panner.connect(this.destination);

    const now = ctx.currentTime;
    const target = Math.max(dbToGain(Math.min(dbfs, OUTPUT_CEILING_DB)), 0.0002);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(target, now + Math.max(fadeInS, 0.02));
    source.start(now);

    const id = `noise-${handleCounter++}`;
    let stopped = false;
    const handle: StimulusHandle = {
      id,
      node: envelope,
      stop: (fade = 0.6) => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        envelope.gain.cancelScheduledValues(t);
        envelope.gain.setValueAtTime(Math.max(envelope.gain.value, 0.0002), t);
        envelope.gain.exponentialRampToValueAtTime(0.0001, t + fade);
        source.stop(t + fade + 0.05);
        tremolo?.stop(t + fade + 0.05);
        setTimeout(() => {
          try {
            envelope.disconnect();
            panner.disconnect();
          } catch {
            /* already torn down */
          }
          this.active.delete(id);
        }, (fade + 0.2) * 1000);
      },
      setLevelDb: (db, rampSeconds = 0.3) => {
        const t = ctx.currentTime;
        envelope.gain.cancelScheduledValues(t);
        envelope.gain.setValueAtTime(Math.max(envelope.gain.value, 0.0002), t);
        envelope.gain.exponentialRampToValueAtTime(
          Math.max(dbToGain(Math.min(db, OUTPUT_CEILING_DB)), 0.0002),
          t + rampSeconds
        );
      },
    };
    this.active.set(id, handle);
    return handle;
  }

  /** Narrowband noise centred on a frequency — the masker used for MML and RI. */
  playBandNoise(options: {
    centreHz: number;
    bandwidthOctaves?: number;
    dbfs?: number;
    ear?: Ear;
    color?: NoiseColor;
    fadeInS?: number;
  }): StimulusHandle {
    const { centreHz, bandwidthOctaves = 0.4, ...rest } = options;
    const q = Math.sqrt(Math.pow(2, bandwidthOctaves)) / (Math.pow(2, bandwidthOctaves) - 1);
    return this.playNoise({
      ...rest,
      chain: [
        { type: "bandpass", frequency: centreHz, Q: q },
        { type: "bandpass", frequency: centreHz, Q: q },
      ],
    });
  }

  stopAll(fade = 0.35): void {
    for (const handle of [...this.active.values()]) handle.stop(fade);
    this.active.clear();
  }

  get activeCount(): number {
    return this.active.size;
  }

  async close(): Promise<void> {
    this.stopAll(0.05);
    await new Promise((r) => setTimeout(r, 120));
    await this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.analyser = null;
  }
}

/** Single shared engine: two AudioContexts would double every delivered level. */
export const engine = new AudioEngine();

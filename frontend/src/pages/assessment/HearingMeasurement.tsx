/**
 * Hearing measurement: pitch, loudness, and the masking threshold profile.
 *
 * Three modules, run in that order, because each one narrows the next. Pitch
 * matching finds roughly where the percept sits; loudness matching sets a level
 * to start the masking search from; the masking profile then measures, at eight
 * audiometric frequencies, the minimum level at which the tinnitus becomes
 * inaudible.
 *
 * **The masking profile is the module that matters.** Pitch and loudness are a
 * description of the percept; the masking curve is a prescription — its minimum
 * is the level any therapy masker has to reach, and its shape decides whether a
 * broadband sound will do or a narrow band has to be placed accurately. So it
 * gets the most screen, the clearest instructions, and the chart afterwards.
 *
 * Every control here is a slider *with explicit +/− buttons*. That is not
 * decoration: a range input is a poor instrument on a touch screen and unusable
 * with a tremor, and the population using this is disproportionately older. The
 * buttons give a guaranteed, repeatable step; the slider gives speed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { engine } from "../../audio/engine";
import { Chip, Panel, Readout, StepRail } from "../../components/ui";
import { MaskingCurve } from "../../components/charts";
import { IconCheck, IconClose, IconPlay, IconStop } from "../../components/icons";

/* ------------------------------------------------------------------------- */
/* Shared: a slider with stepper buttons                                      */
/* ------------------------------------------------------------------------- */
function SteppedSlider({
  value,
  min,
  max,
  step,
  onChange,
  format,
  label,
  ariaLabel,
  lowLabel,
  highLabel,
  tone = "signal",
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  format(value: number): string;
  label?: string;
  ariaLabel: string;
  lowLabel?: string;
  highLabel?: string;
  tone?: "signal" | "data";
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  // Rounded to the step so repeated nudges cannot accumulate float drift into
  // a value the server then rejects as off-grid.
  const nudge = (direction: -1 | 1) =>
    onChange(Number(clamp(value + direction * step).toFixed(6)));

  return (
    <div className="stack stack-2">
      {label && (
        <div className="row row--between row--baseline">
          <span className="label">{label}</span>
          <span className="mono" style={{ fontSize: "var(--fs-small)", fontWeight: 700 }}>
            {format(value)}
          </span>
        </div>
      )}
      <div className="steppedslider">
        <button
          type="button"
          className="btn btn--sm btn--icon steppedslider__step"
          onClick={() => nudge(-1)}
          disabled={value <= min}
          aria-label={`${ariaLabel} −`}
        >
          −
        </button>
        <input
          className={`fader${tone === "data" ? " fader--data" : ""}`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={ariaLabel}
          aria-valuetext={format(value)}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          type="button"
          className="btn btn--sm btn--icon steppedslider__step"
          onClick={() => nudge(1)}
          disabled={value >= max}
          aria-label={`${ariaLabel} +`}
        >
          +
        </button>
      </div>
      {(lowLabel || highLabel) && (
        <div className="fader-scale">
          <span>{lowLabel}</span>
          <span>{highLabel}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Result shape                                                               */
/* ------------------------------------------------------------------------- */
export interface HearingMeasurementResult {
  pitch_match_hz: number;
  loudness_match_db_hl: number;
  /** {"250": 32, ...} — minimum masking level per frequency, in dB HL. */
  masking_thresholds: Record<string, number>;
  /** Frequencies the patient could not mask at any deliverable level. */
  masking_unmasked_hz: number[];
}

/** The audiometric series the masking module walks, in order. */
const MASKING_FREQUENCIES = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];

/** Top of the masking frequency slider, in cents above `PITCH_MIN_HZ`. */
const MASK_MAX_CENTS = 6000; // 250 Hz * 2^5 = 8 kHz

/**
 * Pitch is stepped in *cents*, not hertz.
 *
 * A 25 Hz step is a large musical interval at 250 Hz and inaudible at 8 kHz —
 * pitch perception is logarithmic, so a linear hertz step gives coarse control
 * at the bottom and uselessly fine control at the top. 25 cents is a quarter of
 * a semitone everywhere on the range, which is roughly the smallest difference
 * a non-musician can reliably hear.
 */
// 250 Hz - 12 kHz. The lower bound is the bottom of the audiometric range and
// the upper reaches the high-frequency percepts that noise-induced tinnitus
// commonly sits at, which the previous 8 kHz ceiling could not match at all —
// a patient whose tinnitus was at 10 kHz had to settle for the top of the
// slider and record a pitch they had not actually matched.
//
// These two also anchor the cents helpers below, which the masking module now
// reuses for its own frequency slider: 250 Hz is cents 0, so 8 kHz is exactly
// 6000 cents and the arithmetic stays whole.
const PITCH_MIN_HZ = 250;
const PITCH_MAX_HZ = 12000;
const CENTS_STEP = 25;
const centsFromHz = (hz: number) => 1200 * Math.log2(hz / PITCH_MIN_HZ);
const hzFromCents = (cents: number) => PITCH_MIN_HZ * Math.pow(2, cents / 1200);
const PITCH_MAX_CENTS = centsFromHz(PITCH_MAX_HZ);

/** "3.15 kHz · 3150 Hz" — both units, as the brief asks. */
function pitchLabel(hz: number): string {
  const rounded = Math.round(hz);
  return `${(rounded / 1000).toFixed(2)} kHz · ${rounded} Hz`;
}

type Module = "pitch" | "loudness" | "masking";

export default function HearingMeasurement({
  onComplete,
  initial,
}: {
  onComplete(result: HearingMeasurementResult): void;
  initial?: Partial<HearingMeasurementResult>;
}) {
  const { t } = useTranslation();
  const [module, setModule] = useState<Module>("pitch");
  const [done, setDone] = useState<Set<string>>(new Set());

  const [pitchCents, setPitchCents] = useState(() =>
    centsFromHz(initial?.pitch_match_hz ?? 4000)
  );
  const [loudnessDbHl, setLoudnessDbHl] = useState(initial?.loudness_match_db_hl ?? 35);
  /**
   * Presentation level for the *pitch* module.
   *
   * Was fixed at 40 dB HL, which is inaudible to anyone with a moderate loss at
   * the frequency being matched — they were being asked to compare their
   * tinnitus against a tone they could not hear. Held here rather than inside
   * `PitchModule` so a patient who steps back to pitch after loudness finds the
   * level they set, not a reset one.
   *
   * Not submitted: it is how the comparison was presented, not a measurement.
   * The matched *frequency* is the finding, and that is unchanged.
   */
  const [pitchDbHl, setPitchDbHl] = useState(40);
  const [thresholds, setThresholds] = useState<Record<string, number>>(
    () => ({ ...(initial?.masking_thresholds ?? {}) })
  );
  const [unmasked, setUnmasked] = useState<number[]>(() => [...(initial?.masking_unmasked_hz ?? [])]);

  const pitchHz = Math.round(hzFromCents(pitchCents));
  const handleRef = useRef<{ stop(f?: number): void } | null>(null);

  const stopSound = useCallback(() => {
    handleRef.current?.stop(0.12);
    handleRef.current = null;
  }, []);

  useEffect(() => () => {
    stopSound();
    engine.stopAll(0.2);
  }, [stopSound]);

  function markDone(key: Module, next: Module | null) {
    stopSound();
    setDone((prev) => new Set(prev).add(key));
    if (next) setModule(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function finish() {
    stopSound();
    onComplete({
      pitch_match_hz: pitchHz,
      loudness_match_db_hl: loudnessDbHl,
      masking_thresholds: thresholds,
      masking_unmasked_hz: unmasked,
    });
  }

  const steps = (["pitch", "loudness", "masking"] as const).map((key) => ({
    key,
    label: t(`hearing.module.${key}`),
  }));

  return (
    <div className="stack stack-5">
      <StepRail
        steps={steps}
        current={steps.findIndex((s) => s.key === module)}
        completed={done}
        onJump={(i) => setModule(steps[i].key)}
      />

      {module === "pitch" && (
        <PitchModule
          hz={pitchHz}
          cents={pitchCents}
          onCents={setPitchCents}
          dbHl={pitchDbHl}
          onDbHl={setPitchDbHl}
          handleRef={handleRef}
          stopSound={stopSound}
          onNext={() => markDone("pitch", "loudness")}
        />
      )}

      {module === "loudness" && (
        <LoudnessModule
          pitchHz={pitchHz}
          dbHl={loudnessDbHl}
          onDbHl={setLoudnessDbHl}
          handleRef={handleRef}
          stopSound={stopSound}
          onBack={() => setModule("pitch")}
          onNext={() => markDone("loudness", "masking")}
        />
      )}

      {module === "masking" && (
        <MaskingModule
          startDbHl={loudnessDbHl}
          thresholds={thresholds}
          unmasked={unmasked}
          onThreshold={(hz, db) =>
            setThresholds((prev) => ({ ...prev, [String(hz)]: db }))
          }
          onUnmaskable={(hz) => setUnmasked((prev) => (prev.includes(hz) ? prev : [...prev, hz]))}
          onClear={(hz) => {
            setThresholds((prev) => {
              const next = { ...prev };
              delete next[String(hz)];
              return next;
            });
            setUnmasked((prev) => prev.filter((f) => f !== hz));
          }}
          handleRef={handleRef}
          stopSound={stopSound}
          onBack={() => setModule("loudness")}
          onFinish={finish}
        />
      )}
    </div>
  );
}

/* ========================================================== 1 · pitch === */
function PitchModule({
  hz,
  cents,
  onCents,
  dbHl,
  onDbHl,
  handleRef,
  stopSound,
  onNext,
}: {
  hz: number;
  cents: number;
  onCents(v: number): void;
  dbHl: number;
  onDbHl(v: number): void;
  handleRef: React.MutableRefObject<{ stop(f?: number): void } | null>;
  stopSound(): void;
  onNext(): void;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);

  // Keep a running tone in step with the slider as it is dragged, so the
  // patient hears the frequency change rather than having to stop, adjust and
  // restart for every comparison.
  useEffect(() => {
    if (!playing) return;
    stopSound();
    handleRef.current = engine.playTone({
      freq: hz,
      dbHL: dbHl,
      ear: "both",
      durationMs: null,
      rampMs: 25,
    });
  }, [hz, dbHl, playing, handleRef, stopSound]);

  async function toggle() {
    if (playing) {
      stopSound();
      setPlaying(false);
      return;
    }
    await engine.resume();
    setPlaying(true);
  }

  return (
    <div className="grid grid-sidebar" style={{ ["--aside" as string]: "290px" }}>
      <Panel title={t("hearing.pitch.title")} bracketed>
        <div className="stack stack-5">
          <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
            {t("hearing.pitch.instructions")}
          </p>

          {/* The stimulus is a property of the procedure, not a choice. Stated
              so the operator can see it, fixed so it cannot be set wrong — a
              pitch match made with noise is not a pitch match. */}
          <Chip tone="ghost">{t("hearing.stimulus.pureTone")}</Chip>

          <Readout
            label={t("hearing.pitch.current")}
            value={(hz / 1000).toFixed(2)}
            unit="kHz"
            size="xl"
            tone="signal"
            note={t("hearing.pitch.alsoHz", { hz })}
          />

          <SteppedSlider
            value={cents}
            min={0}
            max={PITCH_MAX_CENTS}
            step={CENTS_STEP}
            onChange={onCents}
            format={(c) => pitchLabel(hzFromCents(c))}
            ariaLabel={t("hearing.pitch.slider")}
            lowLabel="250 Hz"
            highLabel="12 kHz"
          />

          {/* Level, capped at what these headphones can actually deliver at the
              frequency currently selected — `maxReachableHl` falls away at the
              top of the range, and offering a level the hardware cannot produce
              would mean a slider that silently stops doing anything. */}
          <SteppedSlider
            value={Math.min(dbHl, Math.round(engine.maxReachableHl(hz)))}
            min={0}
            max={Math.min(90, Math.round(engine.maxReachableHl(hz)))}
            step={1}
            onChange={onDbHl}
            format={(v) => `${v} dB HL`}
            label={t("hearing.pitch.level")}
            ariaLabel={t("hearing.pitch.levelSlider")}
            lowLabel={t("hearing.loudness.quiet")}
            highLabel={t("hearing.loudness.loud")}
            tone="data"
          />

          <div className="row">
            <button type="button" className={`btn ${playing ? "" : "btn--primary"}`} onClick={toggle}>
              {playing ? <IconStop size={15} /> : <IconPlay size={15} />}
              {t(playing ? "hearing.pitch.stop" : "hearing.pitch.play")}
            </button>
            {playing && (
              <Chip tone="signal" live>
                {t("hearing.playing")}
              </Chip>
            )}
          </div>

          <Panel tone="sunken" tight>
            <p className="meta">{t("hearing.pitch.tip")}</p>
          </Panel>

          <div className="row row--end">
            <button type="button" className="btn btn--primary btn--lg" onClick={onNext}>
              {t("hearing.pitch.continue")}
            </button>
          </div>
        </div>
      </Panel>

      <Panel title={t("hearing.pitch.whyTitle")} tight headPlain>
        <p className="meta">{t("hearing.pitch.whyBody")}</p>
      </Panel>
    </div>
  );
}

/* ======================================================= 2 · loudness === */
/* The loudness module is unchanged apart from stating its stimulus — see the
   note in `PitchModule`. Its level control, its pitch source and its save
   behaviour are all exactly as they were. */
function LoudnessModule({
  pitchHz,
  dbHl,
  onDbHl,
  handleRef,
  stopSound,
  onBack,
  onNext,
}: {
  pitchHz: number;
  dbHl: number;
  onDbHl(v: number): void;
  handleRef: React.MutableRefObject<{ stop(f?: number): void } | null>;
  stopSound(): void;
  onBack(): void;
  onNext(): void;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  // Never offer a level the hardware cannot actually deliver — a slider that
  // runs past the clipping point silently stops getting louder, which the
  // patient reads as their tinnitus being louder than the maximum.
  const ceiling = Math.min(90, Math.round(engine.maxReachableHl(pitchHz)));

  useEffect(() => {
    if (!playing) return;
    stopSound();
    handleRef.current = engine.playTone({
      freq: pitchHz,
      dbHL: dbHl,
      ear: "both",
      durationMs: null,
      rampMs: 25,
    });
  }, [pitchHz, dbHl, playing, handleRef, stopSound]);

  async function toggle() {
    if (playing) {
      stopSound();
      setPlaying(false);
      return;
    }
    await engine.resume();
    setPlaying(true);
  }

  return (
    <div className="grid grid-sidebar" style={{ ["--aside" as string]: "290px" }}>
      <Panel title={t("hearing.loudness.title")} bracketed>
        <div className="stack stack-5">
          <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
            {t("hearing.loudness.instructions", { hz: pitchHz })}
          </p>

          <Readout
            label={t("hearing.loudness.current")}
            value={dbHl}
            unit="dB HL"
            size="xl"
            tone="signal"
          />

          <SteppedSlider
            value={dbHl}
            min={0}
            max={ceiling}
            step={1}
            onChange={onDbHl}
            format={(v) => `${v} dB HL`}
            ariaLabel={t("hearing.loudness.slider")}
            lowLabel={t("hearing.loudness.quiet")}
            highLabel={t("hearing.loudness.loud")}
          />

          <div className="row">
            <button type="button" className={`btn ${playing ? "" : "btn--primary"}`} onClick={toggle}>
              {playing ? <IconStop size={15} /> : <IconPlay size={15} />}
              {t(playing ? "hearing.loudness.stop" : "hearing.loudness.play")}
            </button>
            {playing && (
              <Chip tone="signal" live>
                {t("hearing.playing")}
              </Chip>
            )}
          </div>

          <Panel tone="sunken" tight>
            <p className="meta">{t("hearing.loudness.tip")}</p>
          </Panel>

          <div className="row row--between">
            <button type="button" className="btn" onClick={onBack}>
              ← {t("common.back")}
            </button>
            <button type="button" className="btn btn--primary btn--lg" onClick={onNext}>
              {t("hearing.loudness.continue")}
            </button>
          </div>
        </div>
      </Panel>

      <Panel title={t("hearing.loudness.whyTitle")} tight headPlain>
        <p className="meta">{t("hearing.loudness.whyBody")}</p>
      </Panel>
    </div>
  );
}

/* ======================================================== 3 · masking === */
function MaskingModule({
  startDbHl,
  thresholds,
  unmasked,
  onThreshold,
  onUnmaskable,
  onClear,
  handleRef,
  stopSound,
  onBack,
  onFinish,
}: {
  startDbHl: number;
  thresholds: Record<string, number>;
  unmasked: number[];
  onThreshold(hz: number, db: number): void;
  onUnmaskable(hz: number): void;
  onClear(hz: number): void;
  handleRef: React.MutableRefObject<{ stop(f?: number): void } | null>;
  stopSound(): void;
  onBack(): void;
  onFinish(): void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [level, setLevel] = useState(startDbHl);
  const [playing, setPlaying] = useState(false);

  /**
   * The centre frequency of the masking band, as a free control.
   *
   * The eight-frequency walk is unchanged and still drives the procedure — this
   * only decouples "which frequency am I testing" from "which preset am I on",
   * so a frequency between the presets, or one right at the tinnitus pitch, can
   * be tested and recorded too. Selecting a preset cell still snaps the slider
   * to it, so the default path through the module is exactly what it was.
   *
   * Stepped in cents for the same reason the pitch slider is: linear hertz gives
   * unusable resolution at 250 Hz and pointless precision at 8 kHz. 250 Hz is
   * cents 0, so the range here is 0-6000 cents.
   */
  const [freqCents, setFreqCents] = useState(() => centsFromHz(MASKING_FREQUENCIES[0]));
  const hz = Math.round(hzFromCents(freqCents));

  // Selecting a preset — by clicking a cell or by the automatic advance — snaps
  // the slider onto it. The walk is preserved; the slider follows it.
  useEffect(() => {
    setFreqCents(centsFromHz(MASKING_FREQUENCIES[index]));
  }, [index]);
  const ceiling = Math.min(95, Math.round(engine.maxReachableHl(hz)));
  const recorded = thresholds[String(hz)];
  const isUnmaskable = unmasked.includes(hz);

  // Each frequency starts from the level the last one settled at. Masking
  // thresholds are correlated across neighbouring frequencies, so beginning at
  // the previous answer converges in two or three adjustments instead of ten.
  useEffect(() => {
    const previous = MASKING_FREQUENCIES[index - 1];
    const seed = thresholds[String(hz)] ?? (previous ? thresholds[String(previous)] : undefined);
    setLevel(Math.min(ceiling, Math.max(0, Math.round(seed ?? startDbHl))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (!playing) return;
    stopSound();
    handleRef.current = engine.playBandNoise({
      centreHz: hz,
      bandwidthOctaves: 0.5,
      dbfs: engine.hlToDbfs(level, hz),
      ear: "both",
      fadeInS: 0.15,
    });
  }, [hz, level, playing, handleRef, stopSound]);

  async function toggle() {
    if (playing) {
      stopSound();
      setPlaying(false);
      return;
    }
    await engine.resume();
    setPlaying(true);
  }

  function advance() {
    stopSound();
    setPlaying(false);
    if (index < MASKING_FREQUENCIES.length - 1) setIndex(index + 1);
  }

  /**
   * Every frequency the curve should plot: the eight presets, plus anything
   * measured off-preset with the slider. Union rather than replacement, so the
   * standard eight always appear as the shape of the procedure even before they
   * are answered.
   */
  const curveFrequencies = Array.from(
    new Set<number>([
      ...MASKING_FREQUENCIES,
      ...Object.keys(thresholds).map(Number),
      ...unmasked,
    ])
  )
    .filter((f) => Number.isFinite(f) && f > 0)
    .sort((a, b) => a - b);

  const testedCount = MASKING_FREQUENCIES.filter(
    (f) => thresholds[String(f)] !== undefined || unmasked.includes(f)
  ).length;
  const allTested = testedCount === MASKING_FREQUENCIES.length;

  return (
    <div className="stack stack-5">
      <Panel title={t("hearing.masking.title")} bracketed>
        <div className="stack stack-5">
          <p style={{ fontSize: "var(--fs-small)", maxWidth: "50em", lineHeight: 1.6 }}>
            {t("hearing.masking.instructions")}
          </p>

          {/* Which frequency is being tested, and what has been answered. */}
          <div className="maskgrid">
            {MASKING_FREQUENCIES.map((f, i) => {
              const value = thresholds[String(f)];
              const cannot = unmasked.includes(f);
              const state = i === index ? "active" : value !== undefined || cannot ? "done" : "todo";
              return (
                <button
                  key={f}
                  type="button"
                  className="maskgrid__cell"
                  data-state={state}
                  onClick={() => {
                    stopSound();
                    setPlaying(false);
                    setIndex(i);
                  }}
                >
                  <span className="maskgrid__hz">{f >= 1000 ? `${f / 1000}k` : f}</span>
                  <span className="maskgrid__db">
                    {cannot ? "—" : value !== undefined ? `${value}` : "·"}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-sidebar" style={{ ["--aside" as string]: "260px" }}>
            <div className="stack stack-4">
              <Chip tone="ghost">{t("hearing.stimulus.narrowband")}</Chip>

              <Readout
                label={t("hearing.masking.testing")}
                value={hz >= 1000 ? (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1) : hz}
                unit={hz >= 1000 ? "kHz" : "Hz"}
                size="lg"
                tone="data"
                note={t("hearing.masking.stepOf", {
                  current: index + 1,
                  total: MASKING_FREQUENCIES.length,
                })}
              />

              <SteppedSlider
                value={freqCents}
                min={0}
                max={MASK_MAX_CENTS}
                step={CENTS_STEP}
                onChange={setFreqCents}
                format={(c) => pitchLabel(hzFromCents(c))}
                label={t("hearing.masking.frequency")}
                ariaLabel={t("hearing.masking.frequencySlider")}
                lowLabel="250 Hz"
                highLabel="8 kHz"
              />

              <SteppedSlider
                value={level}
                min={0}
                max={ceiling}
                step={1}
                onChange={setLevel}
                format={(v) => `${v} dB HL`}
                label={t("hearing.masking.level")}
                ariaLabel={t("hearing.masking.slider")}
                lowLabel={t("hearing.loudness.quiet")}
                highLabel={t("hearing.loudness.loud")}
                tone="data"
              />

              <div className="row">
                <button type="button" className={`btn ${playing ? "" : "btn--primary"}`} onClick={toggle}>
                  {playing ? <IconStop size={15} /> : <IconPlay size={15} />}
                  {t(playing ? "hearing.masking.stop" : "hearing.masking.play")}
                </button>
                {playing && (
                  <Chip tone="signal" live>
                    {t("hearing.playing")}
                  </Chip>
                )}
              </div>

              {/* The actual question. Two answers, and the wording is the
                  measurement: "can you still hear your tinnitus over this?" */}
              <Panel tone="sunken" tight>
                <div className="stack stack-3">
                  <span className="label">{t("hearing.masking.question")}</span>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        // Still audible: the masker is not loud enough yet.
                        setLevel((v) => Math.min(ceiling, v + 5));
                      }}
                    >
                      {t("hearing.masking.stillAudible")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      onClick={() => {
                        onThreshold(hz, level);
                        advance();
                      }}
                    >
                      <IconCheck size={14} />
                      {t("hearing.masking.notAudible")}
                    </button>
                  </div>
                  <div className="row row--tight">
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => {
                        onUnmaskable(hz);
                        advance();
                      }}
                    >
                      <IconClose size={13} />
                      {t("hearing.masking.cannotMask")}
                    </button>
                    {(recorded !== undefined || isUnmaskable) && (
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => onClear(hz)}
                      >
                        {t("hearing.masking.retest")}
                      </button>
                    )}
                  </div>
                </div>
              </Panel>
            </div>

            <Panel title={t("hearing.masking.howTitle")} tight headPlain>
              <p className="meta">{t("hearing.masking.howBody")}</p>
              <hr className="rule rule--tight" />
              <Readout
                label={t("hearing.masking.progress")}
                value={`${testedCount}/${MASKING_FREQUENCIES.length}`}
                size="sm"
                tone={allTested ? "ok" : "data"}
              />
            </Panel>
          </div>

          <div className="row row--between">
            <button type="button" className="btn" onClick={onBack}>
              ← {t("common.back")}
            </button>
            <button type="button" className="btn btn--primary btn--lg" onClick={onFinish} disabled={testedCount === 0}>
              {t(allTested ? "hearing.masking.finish" : "hearing.masking.finishPartial")}
            </button>
          </div>
        </div>
      </Panel>

      {/* The curve appears as soon as there is anything to plot, so the patient
          watches it build rather than meeting it cold at the end. */}
      {testedCount >= 2 && (
        <Panel title={t("masking.chart.title")} bracketed>
          <MaskingCurve
            curve={curveFrequencies.map((f) => ({
              hz: f,
              threshold_db: thresholds[String(f)] ?? null,
              masked: unmasked.includes(f) ? false : thresholds[String(f)] !== undefined ? true : null,
              tested: thresholds[String(f)] !== undefined || unmasked.includes(f),
            }))}
            referenceDb={
              Object.keys(thresholds).length
                ? Math.min(...Object.values(thresholds))
                : null
            }
            referenceHz={
              Object.keys(thresholds).length
                ? Number(
                    Object.entries(thresholds).sort((a, b) => a[1] - b[1] || Number(a[0]) - Number(b[0]))[0][0]
                  )
                : null
            }
            height={260}
          />
          <p className="meta" style={{ marginTop: "var(--s3)" }}>
            {t("masking.chart.legend")}
          </p>
        </Panel>
      )}
    </div>
  );
}

export { MASKING_FREQUENCIES, SteppedSlider, pitchLabel };

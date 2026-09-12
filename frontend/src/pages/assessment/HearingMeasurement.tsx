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
import {
  LoudnessMatcher,
  MaskingLevelFinder,
  PitchNarrower,
  buildMaskingCurvePoints,
  type LoudnessFineResponse,
  type LoudnessResponse,
  type LoudnessTrial,
  type MaskingResponse,
  type MaskingTrial,
  type PitchAFCResponse,
  type PitchAFCTrial,
} from "../../audio/procedures";
import { Chip, OptionGroup, Panel, Readout, StepRail } from "../../components/ui";
import { MaskingCurve } from "../../components/charts";
import { IconCheck, IconPlay, IconStop } from "../../components/icons";

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

/** Tinnitus location, asked fresh at the start of the pitch-match module. */
export type PitchLocation = "right" | "left" | "both" | "central";
export const PITCH_SOUND_OPTIONS = ["Ringing", "Whistling", "Buzzing", "Hissing", "Other", "Not sure"] as const;
export type PitchSoundDescription = (typeof PITCH_SOUND_OPTIONS)[number] | "";
export type OctaveResponse = "matched" | "octave_higher" | "not_sure" | "";
export type PitchConfirmation = "very_similar" | "somewhat_similar" | "not_similar" | "";

/** What one completed pitch-matching pass produced — everything the module
 *  needs to hand back to its parent once the patient reaches the result
 *  screen (or restarts and reaches it again). */
export interface PitchMatchOutcome {
  hz: number;
  ear: PitchLocation;
  confidence: number;
  octaveConfusion: boolean;
  trace: PitchAFCTrial[];
  soundDescription: PitchSoundDescription;
  soundOtherText: string;
  initialLevelDb: number;
  comfortLevelDb: number;
  notSureCount: number;
  octaveFrequencyHz: number | null;
  octaveResponse: OctaveResponse;
  confirmation: PitchConfirmation;
  repeated: boolean;
}

/** The closing self-rated confirmation for loudness matching. Distinct from
 *  `PitchConfirmation`: its third option ("No, try again") is not a terminal
 *  rating, it loops back to fine matching, so it is never itself a stored
 *  final value. */
export type LoudnessConfirmation = "very_similar" | "somewhat_similar" | "";

/** What one completed loudness-matching pass produced. */
export interface LoudnessMatchOutcome {
  levelDb: number;
  startingLevelDb: number;
  trace: LoudnessTrial[];
  confirmation: LoudnessConfirmation;
  repeated: boolean;
}

/** One masker frequency's complete adaptive trial history and resulting MML —
 *  `mml_db` is `null` only when the safety ceiling was reached without the
 *  tinnitus ever being reported as masked (never fabricated). */
export interface MaskingFrequencyResult {
  frequency_hz: number;
  trials: MaskingTrial[];
  mml_db: number | null;
}

/** What one completed Feldmann masking-curve pass produced. */
export interface MaskingMatchOutcome {
  frequencies: MaskingFrequencyResult[];
  notSureCount: number;
  repeated: boolean;
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
  /** The pitch-matching workflow's own patient-reported context and adaptive
   *  trial history — additive to `pitch_match_hz` above, which stays the
   *  single source every existing reader (loudness module, masking module,
   *  the report) already uses for the matched frequency itself. */
  pitch_match_ear: PitchLocation;
  pitch_match_confidence: number;
  octave_confusion: boolean;
  pitch_match_trace: PitchAFCTrial[];
  pitch_match_sound_description: PitchSoundDescription;
  pitch_match_sound_other_text: string;
  pitch_match_initial_level_db: number;
  pitch_match_comfort_level_db: number;
  pitch_match_not_sure_count: number;
  pitch_match_octave_frequency_hz: number | null;
  pitch_match_octave_response: OctaveResponse;
  pitch_match_confirmation: PitchConfirmation;
  pitch_match_repeated: boolean;
  /** The loudness-matching workflow's own starting level and adaptive trial
   *  history — additive to `loudness_match_db_hl` above, which stays the
   *  single source every existing reader already uses for the matched level. */
  loudness_match_starting_level_db: number;
  loudness_match_trace: LoudnessTrial[];
  loudness_match_confirmation: LoudnessConfirmation;
  loudness_match_repeated: boolean;
  /** The masking-threshold workflow's complete per-frequency adaptive trial
   *  history — additive to `masking_thresholds`/`masking_unmasked_hz` above,
   *  which stay the single source every existing reader (the curve builder,
   *  the reference-level derivation, the report) already uses for the MML
   *  values themselves. */
  masking_trace: MaskingFrequencyResult[];
  masking_not_sure_count: number;
  masking_repeated: boolean;
}

/**
 * The masker frequency sequence this module administers, in order — the
 * Feldmann masking-curve protocol. A single named constant rather than a
 * value repeated through the UI, so the sequence is configurable in one
 * place: change it here and the instructions, the progress indicator, the
 * results table and the curve chart all follow.
 *
 * Historical records may carry thresholds at other frequencies (250/500 Hz,
 * from before this sequence changed) — those are not lost: `masking_thresholds`
 * is an open map, and both the frontend's local curve preview and the
 * backend's `curve()` builder already plot the union of whatever was tested
 * with this preset list, never just this list alone.
 */
const MASKING_FREQUENCIES = [1000, 2000, 3000, 4000, 5000, 6000, 8000];

type Module = "pitch" | "loudness" | "masking";

export default function HearingMeasurement({
  onComplete,
  initial,
  laterality,
}: {
  onComplete(result: HearingMeasurementResult): void;
  initial?: Partial<HearingMeasurementResult>;
  /** Seeds the pitch-match location screen's default selection — the patient
   *  confirms or changes it there rather than it being asked only once. */
  laterality?: string | null;
}) {
  const { t } = useTranslation();
  const [module, setModule] = useState<Module>("pitch");
  const [done, setDone] = useState<Set<string>>(new Set());

  /** Set once the patient reaches the pitch-match result screen (screen 10).
   *  `null` only before that — loudness and masking cannot run without a
   *  matched frequency, same as before. */
  const [pitchOutcome, setPitchOutcome] = useState<PitchMatchOutcome | null>(null);
  /** Set once the patient reaches the loudness-match result screen. `null`
   *  before that, and legitimately null if this loudness assessment has not
   *  been done — masking still needs *some* starting level (see `startDbHl`
   *  below), the same way it already tolerated an unset loudness value. */
  const [loudnessOutcome, setLoudnessOutcome] = useState<LoudnessMatchOutcome | null>(null);
  /** Set once the patient reaches the masking-curve result screen. */
  const [maskingOutcome, setMaskingOutcome] = useState<MaskingMatchOutcome | null>(null);

  // Masking needs *some* frequency/level to run at even before pitch/loudness
  // are done — 4 kHz and 35 dB HL are the same fallbacks the sliders used to
  // default to. These are display/seed defaults for an *unrelated* module,
  // never submitted in place of a real pitch or loudness match.
  const pitchHz = pitchOutcome?.hz ?? 4000;
  const loudnessDbHl = loudnessOutcome?.levelDb ?? 35;
  const handleRef = useRef<{ stop(f?: number): void; setLevelDb(db: number, r?: number): void } | null>(null);

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

  function finish(finalMaskingOutcome?: MaskingMatchOutcome) {
    stopSound();
    // Accepts the just-produced outcome directly rather than reading
    // `maskingOutcome` from state: the caller sets that state and calls
    // `finish` in the same event handler, and React's state update would
    // not be visible yet if this read from the closure instead.
    const outcome = finalMaskingOutcome ?? maskingOutcome;
    const derivedThresholds: Record<string, number> = { ...(initial?.masking_thresholds ?? {}) };
    const derivedUnmasked: number[] = [...(initial?.masking_unmasked_hz ?? [])];
    for (const f of outcome?.frequencies ?? []) {
      if (f.mml_db !== null) derivedThresholds[String(f.frequency_hz)] = f.mml_db;
      else if (!derivedUnmasked.includes(f.frequency_hz)) derivedUnmasked.push(f.frequency_hz);
    }
    onComplete({
      pitch_match_hz: pitchHz,
      loudness_match_db_hl: loudnessDbHl,
      masking_thresholds: derivedThresholds,
      masking_unmasked_hz: derivedUnmasked,
      masking_trace: outcome?.frequencies ?? [],
      masking_not_sure_count: outcome?.notSureCount ?? 0,
      masking_repeated: outcome?.repeated ?? false,
      pitch_match_ear: pitchOutcome?.ear ?? "both",
      pitch_match_confidence: pitchOutcome?.confidence ?? 0,
      octave_confusion: pitchOutcome?.octaveConfusion ?? false,
      pitch_match_trace: pitchOutcome?.trace ?? [],
      pitch_match_sound_description: pitchOutcome?.soundDescription ?? "",
      pitch_match_sound_other_text: pitchOutcome?.soundOtherText ?? "",
      pitch_match_initial_level_db: pitchOutcome?.initialLevelDb ?? 0,
      pitch_match_comfort_level_db: pitchOutcome?.comfortLevelDb ?? 0,
      pitch_match_not_sure_count: pitchOutcome?.notSureCount ?? 0,
      pitch_match_octave_frequency_hz: pitchOutcome?.octaveFrequencyHz ?? null,
      pitch_match_octave_response: pitchOutcome?.octaveResponse ?? "",
      pitch_match_confirmation: pitchOutcome?.confirmation ?? "",
      pitch_match_repeated: pitchOutcome?.repeated ?? false,
      loudness_match_starting_level_db: loudnessOutcome?.startingLevelDb ?? 0,
      loudness_match_trace: loudnessOutcome?.trace ?? [],
      loudness_match_confirmation: loudnessOutcome?.confirmation ?? "",
      loudness_match_repeated: loudnessOutcome?.repeated ?? false,
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
          laterality={laterality}
          existingOutcome={pitchOutcome}
          handleRef={handleRef}
          stopSound={stopSound}
          onNext={(outcome) => {
            setPitchOutcome(outcome);
            markDone("pitch", "loudness");
          }}
        />
      )}

      {module === "loudness" && (
        <LoudnessModule
          pitchOutcome={pitchOutcome}
          existingOutcome={loudnessOutcome}
          handleRef={handleRef}
          stopSound={stopSound}
          onGoToPitch={() => setModule("pitch")}
          onNext={(outcome) => {
            setLoudnessOutcome(outcome);
            markDone("loudness", "masking");
          }}
        />
      )}

      {module === "masking" && (
        <MaskingModule
          pitchOutcome={pitchOutcome}
          loudnessOutcome={loudnessOutcome}
          existingOutcome={maskingOutcome}
          handleRef={handleRef}
          stopSound={stopSound}
          onBack={() => setModule("loudness")}
          onNext={(outcome) => {
            setMaskingOutcome(outcome);
            finish(outcome);
          }}
        />
      )}
    </div>
  );
}

/* ========================================================== 1 · pitch === */
/**
 * Ten-screen adaptive pitch-matching workflow: location, sound description,
 * a fixed comfortable presentation level, instructions, an automatic 2AFC
 * frequency search (coarse then fine, via `PitchNarrower`), a one-octave
 * verification, a closing self-rated confirmation, and the result. The
 * patient never enters or drags a frequency — every comparison pair is
 * generated by the adaptive algorithm; the patient only ever answers
 * A / B / Not Sure.
 */
type PitchScreen = "location" | "sound" | "comfort" | "instructions" | "compare" | "octave" | "confirm" | "result";

function PitchModule({
  laterality,
  existingOutcome,
  handleRef,
  stopSound,
  onNext,
}: {
  laterality?: string | null;
  /** A previously completed match, if the patient has stepped away and back
   *  — shown as the result screen again rather than restarting the module. */
  existingOutcome: PitchMatchOutcome | null;
  handleRef: React.MutableRefObject<{ stop(f?: number): void } | null>;
  stopSound(): void;
  onNext(outcome: PitchMatchOutcome): void;
}) {
  const { t } = useTranslation();
  const initialLocation: PitchLocation =
    laterality === "left" || laterality === "right" || laterality === "both" || laterality === "central"
      ? laterality
      : "both";

  const [pmScreen, setPmScreen] = useState<PitchScreen>(existingOutcome ? "result" : "location");
  const [pmLocation, setPmLocation] = useState<PitchLocation>(existingOutcome?.ear ?? initialLocation);
  const [pmSound, setPmSound] = useState<PitchSoundDescription>(existingOutcome?.soundDescription ?? "");
  const [pmSoundOther, setPmSoundOther] = useState(existingOutcome?.soundOtherText ?? "");
  const [pmInitialLevel] = useState(existingOutcome?.initialLevelDb ?? 35);
  const [pmLevelDraft, setPmLevelDraft] = useState(existingOutcome?.comfortLevelDb ?? 35);
  const [pmComfortLevel, setPmComfortLevel] = useState<number | null>(existingOutcome?.comfortLevelDb ?? null);
  const [pmRepeated, setPmRepeated] = useState(existingOutcome?.repeated ?? false);
  const [pmOctaveResponse, setPmOctaveResponse] = useState<OctaveResponse>(existingOutcome?.octaveResponse ?? "");
  const [pmConfirmation, setPmConfirmation] = useState<PitchConfirmation>(existingOutcome?.confirmation ?? "");
  const [matchedHz, setMatchedHz] = useState<number | null>(existingOutcome?.hz ?? null);

  const narrower = useRef(new PitchNarrower());
  const [pair, setPair] = useState(() => narrower.current.pair());
  const comparisonLevel = pmComfortLevel ?? pmLevelDraft;

  async function playProbe(hz: number, dbHL: number, ms = 1600) {
    await engine.resume();
    stopSound();
    handleRef.current = engine.playTone({ freq: hz, dbHL, ear: "both", durationMs: ms, rampMs: 30 });
  }

  function confirmComfortLevel() {
    setPmComfortLevel(pmLevelDraft);
  }

  function respond(response: PitchAFCResponse) {
    narrower.current.choose(response);
    setPair(narrower.current.pair());
    if (narrower.current.done) {
      setMatchedHz(narrower.current.result());
      setPmScreen("octave");
    }
  }

  function chooseOctave(response: OctaveResponse) {
    setPmOctaveResponse(response);
    const bracketed = narrower.current.result();
    // Same octave-confusion convention used elsewhere in this app: a patient
    // who says the octave-higher tone is closer is corrected to that
    // frequency. "Not Sure" gives no evidence either way, so it keeps the
    // bracketed value rather than guessing which octave is right.
    if (response === "octave_higher") setMatchedHz(bracketed * 2);
    setPmScreen("confirm");
  }

  function confirmResult(confirmation: PitchConfirmation) {
    setPmConfirmation(confirmation);
    setPmScreen("result");
  }

  function repeatPitchMatching() {
    narrower.current = new PitchNarrower();
    setPair(narrower.current.pair());
    setMatchedHz(null);
    setPmOctaveResponse("");
    setPmConfirmation("");
    setPmRepeated(true);
    setPmScreen("location");
  }

  function done() {
    if (matchedHz === null || pmComfortLevel === null) return;
    onNext({
      hz: matchedHz,
      ear: pmLocation,
      confidence: narrower.current.confidence(pmOctaveResponse || null),
      octaveConfusion: pmOctaveResponse === "octave_higher",
      trace: narrower.current.trace,
      soundDescription: pmSound,
      soundOtherText: pmSound === "Other" ? pmSoundOther : "",
      initialLevelDb: pmInitialLevel,
      comfortLevelDb: pmComfortLevel,
      notSureCount: narrower.current.notSureTotal,
      octaveFrequencyHz: pmOctaveResponse ? Math.round(narrower.current.result() * 2) : null,
      octaveResponse: pmOctaveResponse,
      confirmation: pmConfirmation,
      repeated: pmRepeated,
    });
  }

  return (
    <div className="grid grid-sidebar" style={{ ["--aside" as string]: "290px" }}>
      <Panel title={t("hearing.pitch.title", "Tinnitus Pitch Matching")} bracketed>
        {/* -- screen 1 · location --------------------------------------- */}
        {pmScreen === "location" && (
          <div className="stack stack-5">
            <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
              {t("hearing.pitch.locationQuestion", "Where do you hear your tinnitus?")}
            </p>
            <OptionGroup<PitchLocation>
              options={[
                { value: "right", label: t("hearing.pitch.locationRight", "Right ear") },
                { value: "left", label: t("hearing.pitch.locationLeft", "Left ear") },
                { value: "both", label: t("hearing.pitch.locationBoth", "Both ears") },
                { value: "central", label: t("hearing.pitch.locationCentral", "In my head") },
              ]}
              value={pmLocation}
              onChange={setPmLocation}
            />
            <div className="row row--end">
              <button type="button" className="btn btn--primary" onClick={() => setPmScreen("sound")}>
                {t("common.continue")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 2 · sound -------------------------------------------- */}
        {pmScreen === "sound" && (
          <div className="stack stack-5">
            <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
              {t("hearing.pitch.soundQuestion", "What does your tinnitus sound like?")}
            </p>
            <OptionGroup<PitchSoundDescription>
              options={PITCH_SOUND_OPTIONS.map((value) => ({
                value,
                label: t(`hearing.pitch.sound.${value}`, value),
              }))}
              value={pmSound}
              onChange={setPmSound}
            />
            {pmSound === "Other" && (
              <input
                className="input"
                value={pmSoundOther}
                onChange={(e) => setPmSoundOther(e.target.value)}
                placeholder={t("hearing.pitch.soundOtherPlaceholder", "Describe the sound")}
              />
            )}
            <div className="row row--end">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!pmSound}
                onClick={() => setPmScreen("comfort")}
              >
                {t("common.continue")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 3 · comfortable sound level --------------------------- */}
        {pmScreen === "comfort" && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.pitch.comfortTitle", "Set Comfortable Sound Level")}</span>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
              {t(
                "hearing.pitch.comfortInstruction",
                "You will hear a test sound. Adjust the level until it is clearly audible and comfortable. It should not be loud or uncomfortable."
              )}
            </p>

            <SteppedSlider
              value={pmLevelDraft}
              min={0}
              max={Math.min(90, Math.round(engine.maxReachableHl(1000)))}
              step={1}
              onChange={setPmLevelDraft}
              format={(v) => `${v} dB`}
              label={t("hearing.pitch.soundLevel", "Sound Level")}
              ariaLabel={t("hearing.pitch.soundLevel", "Sound Level")}
              lowLabel={t("hearing.loudness.quiet")}
              highLabel={t("hearing.loudness.loud")}
              tone="data"
            />

            <div className="row row--tight row--wrap">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => playProbe(1000, pmComfortLevel ?? pmLevelDraft, 1800)}
              >
                <IconPlay size={15} />
                {t("hearing.pitch.playTestSound", "Play Test Sound")}
              </button>
              <button type="button" className="btn btn--ghost" onClick={stopSound}>
                <IconStop size={15} />
                {t("hearing.pitch.stop")}
              </button>
              {pmComfortLevel === null && (
                <button type="button" className="btn btn--primary" onClick={confirmComfortLevel}>
                  {t("hearing.pitch.thisIsComfortable", "This level is comfortable")}
                </button>
              )}
            </div>

            {pmComfortLevel !== null && (
              <Panel tone="ok" tight>
                <div className="stack stack-1">
                  <span className="label">{t("hearing.pitch.comfortSetTitle", "Comfortable level set.")}</span>
                  <p className="meta" style={{ margin: 0 }}>
                    {t("hearing.pitch.comfortSetBody", "This level will remain fixed during the pitch-matching task.")}
                  </p>
                </div>
              </Panel>
            )}

            <div className="row row--end">
              <button
                type="button"
                className="btn btn--primary"
                disabled={pmComfortLevel === null}
                onClick={() => setPmScreen("instructions")}
              >
                {t("common.continue")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 4 · instructions --------------------------------------- */}
        {pmScreen === "instructions" && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.pitch.instructionsTitle", "Find the Pitch of Your Tinnitus")}</span>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
              {t(
                "hearing.pitch.instructionsBody1",
                "You will hear two sounds at a time. Listen to both sounds and choose the one that is closer in pitch to your tinnitus."
              )}
            </p>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
              {t("hearing.pitch.instructionsBody2", "You can replay the sounds if needed. There are no right or wrong answers.")}
            </p>
            <div className="row row--end">
              <button type="button" className="btn btn--primary btn--lg" onClick={() => setPmScreen("compare")}>
                {t("hearing.pitch.startPitchMatching", "Start Pitch Matching")}
              </button>
            </div>
          </div>
        )}

        {/* -- screens 5-7 · 2AFC comparison (coarse, then fine) ------------- */}
        {pmScreen === "compare" && (
          <div className="stack stack-5">
            <span className="label label--signal">
              {narrower.current.phase === "fine"
                ? t("hearing.pitch.fineTitle", "Fine-tuning your pitch match")
                : t("hearing.pitch.title", "Tinnitus Pitch Matching")}
            </span>
            {narrower.current.phase === "fine" && (
              <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em" }}>
                {t(
                  "hearing.pitch.fineInstruction",
                  "We will now compare sounds that are closer together to find the pitch that most closely matches your tinnitus."
                )}
              </p>
            )}

            <Chip tone="ghost">{t("hearing.stimulus.pureTone")}</Chip>

            <div className="grid grid-2">
              {(
                [
                  { hz: pair.aHz, key: "A" },
                  { hz: pair.bHz, key: "B" },
                ] as const
              ).map((option) => (
                <Panel key={option.key} tone="sunken" tight>
                  <div className="stack stack-3 center">
                    <span className="label">{option.key}</span>
                    <button type="button" className="btn btn--block" onClick={() => playProbe(option.hz, comparisonLevel)}>
                      <IconPlay size={15} />
                      {t("hearing.pitch.playSound", { key: option.key, defaultValue: `Play Sound ${option.key}` })}
                    </button>
                    <span className="meta">{t("hearing.pitch.comparisonFrequency", "Comparison frequency")}</span>
                    <Readout label="" value={(option.hz / 1000).toFixed(2)} unit="kHz" size="md" tone="data" note={`${option.hz} Hz`} />
                  </div>
                </Panel>
              ))}
            </div>

            <div className="row row--end">
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  playProbe(pair.aHz, comparisonLevel);
                  window.setTimeout(() => playProbe(pair.bHz, comparisonLevel), 900);
                }}
              >
                {t("hearing.pitch.replayBoth", "↻ Replay Both")}
              </button>
            </div>

            <span className="label">{t("hearing.pitch.closerQuestion", "Which sound is closer to your tinnitus?")}</span>
            <div className="row row--tight">
              <button type="button" className="btn btn--primary btn--lg" onClick={() => respond("A")}>
                {t("hearing.pitch.optionA", "A")}
              </button>
              <button type="button" className="btn btn--primary btn--lg" onClick={() => respond("B")}>
                {t("hearing.pitch.optionB", "B")}
              </button>
              <button type="button" className="btn btn--lg" onClick={() => respond("not_sure")}>
                {t("hearing.pitch.notSure", "Not Sure")}
              </button>
            </div>

            <span className="meta">
              {t("hearing.pitch.trialInfo", {
                trial: narrower.current.trace.length + 1,
                defaultValue: `Trial ${narrower.current.trace.length + 1}`,
              })}
            </span>
          </div>
        )}

        {/* -- screen 8 · one-octave verification ---------------------------- */}
        {pmScreen === "octave" && matchedHz !== null && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.pitch.octaveCheckTitle", "Final Pitch Check")}</span>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em" }}>
              {t(
                "hearing.pitch.octaveCheckInstruction",
                "We will compare your matched sound with a sound one octave higher. Listen to both and choose the one that is closer to your tinnitus."
              )}
            </p>

            <div className="grid grid-2">
              <Panel tone="sunken" tight>
                <div className="stack stack-3 center">
                  <span className="label">{t("hearing.pitch.soundALabel", "SOUND A")}</span>
                  <span className="meta">{t("hearing.pitch.yourMatchedPitch", "Your matched pitch")}</span>
                  <button type="button" className="btn btn--block" onClick={() => playProbe(matchedHz, comparisonLevel)}>
                    <IconPlay size={15} />
                    {t("hearing.pitch.playA", "Play A")}
                  </button>
                  <Readout label={t("hearing.pitch.matchedFrequency", "Matched frequency")} value={(matchedHz / 1000).toFixed(2)} unit="kHz" size="sm" tone="data" note={`${matchedHz} Hz`} />
                </div>
              </Panel>
              <Panel tone="sunken" tight>
                <div className="stack stack-3 center">
                  <span className="label">{t("hearing.pitch.soundBLabel", "SOUND B")}</span>
                  <span className="meta">{t("hearing.pitch.oneOctaveHigher", "One octave higher")}</span>
                  <button type="button" className="btn btn--block" onClick={() => playProbe(matchedHz * 2, comparisonLevel)}>
                    <IconPlay size={15} />
                    {t("hearing.pitch.playB", "Play B")}
                  </button>
                  <Readout
                    label={t("hearing.pitch.matchedFrequencyTimesTwo", "Matched frequency × 2")}
                    value={((matchedHz * 2) / 1000).toFixed(2)}
                    unit="kHz"
                    size="sm"
                    tone="data"
                    note={`${matchedHz * 2} Hz`}
                  />
                </div>
              </Panel>
            </div>

            <div className="row row--end">
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  playProbe(matchedHz, comparisonLevel);
                  window.setTimeout(() => playProbe(matchedHz * 2, comparisonLevel), 900);
                }}
              >
                {t("hearing.pitch.replayBoth", "↻ Replay Both")}
              </button>
            </div>

            <span className="label">{t("hearing.pitch.closerQuestion", "Which sound is closer to your tinnitus?")}</span>
            <div className="row row--tight">
              <button type="button" className="btn btn--primary btn--lg" onClick={() => chooseOctave("matched")}>
                {t("hearing.pitch.matchedPitchOption", "Matched Pitch")}
              </button>
              <button type="button" className="btn btn--primary btn--lg" onClick={() => chooseOctave("octave_higher")}>
                {t("hearing.pitch.octaveHigherOption", "One Octave Higher")}
              </button>
              <button type="button" className="btn btn--lg" onClick={() => chooseOctave("not_sure")}>
                {t("hearing.pitch.notSure", "Not Sure")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 9 · final confirmation --------------------------------- */}
        {pmScreen === "confirm" && matchedHz !== null && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.pitch.identifiedTitle", "Your closest pitch has been identified")}</span>
            <div className="row">
              <button type="button" className="btn btn--primary" onClick={() => playProbe(matchedHz, comparisonLevel)}>
                <IconPlay size={15} />
                {t("hearing.pitch.playMatchedSound", "Play Matched Sound")}
              </button>
            </div>
            <Readout label={t("hearing.pitch.matchedFrequency", "Matched frequency")} value={(matchedHz / 1000).toFixed(2)} unit="kHz" size="lg" tone="signal" note={`${matchedHz} Hz`} />

            <span className="label">{t("hearing.pitch.howCloselyQuestion", "How closely does this sound match your tinnitus?")}</span>
            <OptionGroup<PitchConfirmation>
              options={[
                { value: "very_similar", label: t("hearing.pitch.verySimilar", "Very similar") },
                { value: "somewhat_similar", label: t("hearing.pitch.somewhatSimilar", "Somewhat similar") },
                { value: "not_similar", label: t("hearing.pitch.notSimilar", "Not similar") },
              ]}
              value={pmConfirmation}
              onChange={(value) => setPmConfirmation(value)}
            />

            <div className="row row--between">
              <button type="button" className="btn btn--ghost btn--sm" onClick={repeatPitchMatching}>
                {t("hearing.pitch.repeatPitchMatching", "Repeat Pitch Matching")}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!pmConfirmation}
                onClick={() => confirmResult(pmConfirmation)}
              >
                {t("hearing.pitch.confirmResult", "Confirm Result")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 10 · result --------------------------------------------- */}
        {pmScreen === "result" && matchedHz !== null && (
          <div className="stack stack-4">
            <span className="label label--signal">{t("hearing.pitch.resultTitle", "Tinnitus Pitch Match")}</span>
            <div className="row" style={{ gap: "var(--s8)" }}>
              <Readout label="" value={matchedHz} unit="Hz" size="lg" tone="signal" />
              <Readout label="" value={(matchedHz / 1000).toFixed(matchedHz % 1000 === 0 ? 0 : 1)} unit="kHz" size="lg" tone="data" />
            </div>
            <p className="meta">
              {t(
                "hearing.pitch.resultBody",
                "This is the frequency that most closely matched the pitch of your tinnitus during the assessment."
              )}
            </p>
            {pmRepeated && (
              <Panel tone="info" tight>
                <p className="meta">{t("hearing.pitch.repeatedNote", "This result comes from a repeated pitch-matching attempt.")}</p>
              </Panel>
            )}
            <div className="row row--between">
              <button type="button" className="btn btn--ghost" onClick={() => playProbe(matchedHz, comparisonLevel)}>
                <IconPlay size={15} />
                {t("hearing.pitch.playMatchedSound", "Play Matched Sound")}
              </button>
              <button type="button" className="btn btn--primary btn--lg" onClick={done}>
                {t("hearing.pitch.continue", "Continue")}
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Panel title={t("hearing.pitch.whyTitle")} tight headPlain>
        <p className="meta">{t("hearing.pitch.whyBody")}</p>
        {narrower.current.notSureTotal > 0 && (
          <>
            <hr className="rule rule--tight" />
            <p className="meta dim">
              {t("hearing.pitch.notSureCount", {
                count: narrower.current.notSureTotal,
                defaultValue: `${narrower.current.notSureTotal} "Not Sure" response(s) so far.`,
              })}
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}

/* ======================================================= 2 · loudness === */
/**
 * Seven-screen adaptive loudness-matching workflow, at the *fixed* frequency
 * the patient already matched in the pitch-matching module. Frequency never
 * changes here — only intensity — which is the core distinction from Pitch
 * Match: there, frequency narrows and level is held; here, level narrows and
 * frequency is held. The patient never sets a dB value directly; every
 * comparison sound plays at a level `LoudnessMatcher` (see
 * `audio/procedures.ts`) chooses from the patient's own softer/louder
 * judgements.
 */
type LoudnessScreen = "no_pitch" | "instructions" | "starting_level" | "compare" | "fine" | "confirm" | "result";

function LoudnessModule({
  pitchOutcome,
  existingOutcome,
  handleRef,
  stopSound,
  onGoToPitch,
  onNext,
}: {
  /** The completed pitch match this module's frequency is fixed to. `null`
   *  when the patient has not done one yet — the module must not invent a
   *  frequency, so it shows a message and a way back to Pitch Match instead. */
  pitchOutcome: PitchMatchOutcome | null;
  /** A previously completed loudness match, if the patient has stepped away
   *  and back — shown as the result screen again rather than restarting. */
  existingOutcome: LoudnessMatchOutcome | null;
  handleRef: React.MutableRefObject<{ stop(f?: number): void; setLevelDb(db: number, r?: number): void } | null>;
  stopSound(): void;
  onGoToPitch(): void;
  onNext(outcome: LoudnessMatchOutcome): void;
}) {
  const { t } = useTranslation();
  const pitchHz = pitchOutcome?.hz ?? null;

  const [lmScreen, setLmScreen] = useState<LoudnessScreen>(
    !pitchHz ? "no_pitch" : existingOutcome ? "result" : "instructions"
  );
  const [sweeping, setSweeping] = useState(false);
  const [sweepLevel, setSweepLevel] = useState(-10);
  const [startingLevel, setStartingLevel] = useState<number | null>(existingOutcome?.startingLevelDb ?? null);
  const [lmConfirmation, setLmConfirmation] = useState<LoudnessConfirmation>(existingOutcome?.confirmation ?? "");
  const [lmSelectedConfirmation, setLmSelectedConfirmation] = useState<LoudnessConfirmation | "try_again" | "">("");
  const [lmRepeated, setLmRepeated] = useState(existingOutcome?.repeated ?? false);

  // Only reconstructed for a genuinely new attempt (via `repeatAssessment`);
  // resuming a completed match (`existingOutcome`) shows the result screen
  // straight away without needing a live matcher instance.
  const matcher = useRef<LoudnessMatcher | null>(null);
  const [level, setLevel] = useState<number | null>(existingOutcome?.levelDb ?? null);
  const sweepTimer = useRef<number | null>(null);

  const ceiling = pitchHz ? Math.min(90, Math.round(engine.maxReachableHl(pitchHz))) : 90;

  function clearSweepTimer() {
    if (sweepTimer.current !== null) {
      window.clearInterval(sweepTimer.current);
      sweepTimer.current = null;
    }
  }

  useEffect(() => () => {
    clearSweepTimer();
  }, []);

  async function playAt(hz: number, dbHL: number, ms: number | null = 1600) {
    await engine.resume();
    stopSound();
    handleRef.current = engine.playTone({ freq: hz, dbHL, ear: "both", durationMs: ms, rampMs: 25 });
  }

  /** Screen 2 — ascending sweep from a safe floor, in fixed steps, until the
   *  patient confirms they can hear it. Reuses `StimulusHandle.setLevelDb`
   *  rather than restarting the tone on every step, so the sweep is heard as
   *  one continuous, gradually rising tone. */
  const SWEEP_START_DB = -10;
  const SWEEP_STEP_DB = 5;
  const SWEEP_INTERVAL_MS = 900;

  async function startSweep() {
    if (!pitchHz) return;
    await engine.resume();
    stopSound();
    setSweeping(true);
    setSweepLevel(SWEEP_START_DB);
    handleRef.current = engine.playTone({ freq: pitchHz, dbHL: SWEEP_START_DB, ear: "both", durationMs: null, rampMs: 25 });
    clearSweepTimer();
    sweepTimer.current = window.setInterval(() => {
      setSweepLevel((prev) => {
        const next = Math.min(ceiling, prev + SWEEP_STEP_DB);
        handleRef.current?.setLevelDb(engine.hlToDbfs(next, pitchHz), 0.15);
        if (next >= ceiling) clearSweepTimer();
        return next;
      });
    }, SWEEP_INTERVAL_MS);
  }

  function confirmAudible() {
    clearSweepTimer();
    stopSound();
    setSweeping(false);
    const audible = sweepLevel;
    setStartingLevel(audible);
    matcher.current = new LoudnessMatcher(audible, -10, ceiling);
    setLevel(matcher.current.currentLevel);
    setLmScreen("compare");
  }

  function respond(response: LoudnessResponse | LoudnessFineResponse) {
    if (!matcher.current) return;
    matcher.current.respond(response);
    setLevel(matcher.current.currentLevel);
    if (matcher.current.phase === "fine" && lmScreen === "compare") setLmScreen("fine");
    if (matcher.current.done) setLmScreen("confirm");
  }

  function commitConfirmation() {
    if (!lmSelectedConfirmation) return;
    if (lmSelectedConfirmation === "try_again") {
      // Trial history stays on `matcher.current` — nothing is discarded, the
      // patient simply answers more fine-matching trials.
      setLmSelectedConfirmation("");
      setLmScreen("fine");
      return;
    }
    setLmConfirmation(lmSelectedConfirmation);
    setLmScreen("result");
  }

  function repeatAssessment() {
    matcher.current = null;
    setLevel(null);
    setStartingLevel(null);
    setLmConfirmation("");
    setLmSelectedConfirmation("");
    setLmRepeated(true);
    setLmScreen("instructions");
  }

  function done() {
    if (level === null || startingLevel === null) return;
    onNext({
      levelDb: level,
      startingLevelDb: startingLevel,
      trace: matcher.current?.trace ?? [],
      confirmation: lmConfirmation,
      repeated: lmRepeated,
    });
  }

  return (
    <div className="grid grid-sidebar" style={{ ["--aside" as string]: "290px" }}>
      <Panel title={t("hearing.loudness.title", "LOUDNESS MATCH")} bracketed>
        {/* -- no pitch match yet ---------------------------------------- */}
        {lmScreen === "no_pitch" && (
          <div className="stack stack-4">
            <Panel tone="warn" tight>
              <p className="meta">
                {t(
                  "hearing.loudness.needsPitchMatch",
                  "Complete Tinnitus Pitch Matching before starting Loudness Matching."
                )}
              </p>
            </Panel>
            <div className="row row--end">
              <button type="button" className="btn btn--primary" onClick={onGoToPitch}>
                {t("hearing.loudness.goToPitchMatch", "Go to Pitch Match")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 1 · instructions ------------------------------------- */}
        {lmScreen === "instructions" && pitchHz && (
          <div className="stack stack-5">
            <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
              {t("hearing.loudness.matchTitle", "Match the loudness of your tinnitus")}
            </p>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
              {t(
                "hearing.loudness.instructionsBody",
                "You will hear a sound similar in pitch to your tinnitus. We will adjust its loudness until it matches the loudness of your tinnitus."
              )}
            </p>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em" }}>
              {t("hearing.loudness.noRightWrong", "There are no right or wrong answers. Choose the option that best describes what you hear.")}
            </p>
            <div className="row row--end">
              <button type="button" className="btn btn--primary btn--lg" onClick={() => setLmScreen("starting_level")}>
                {t("hearing.loudness.start", "Start")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 2 · comfortable starting level ------------------------ */}
        {lmScreen === "starting_level" && pitchHz && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.loudness.startingLevelTitle", "Set Comfortable Starting Level")}</span>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
              {t("hearing.loudness.startingLevelLead1", "First, we will find a comfortable listening level.")}
            </p>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em", lineHeight: 1.6 }}>
              {t(
                "hearing.loudness.startingLevelLead2",
                "The sound will start at a low level and gradually increase. Tell us when you can clearly hear it."
              )}
            </p>

            <div className="row row--tight row--wrap">
              <button type="button" className={`btn ${sweeping ? "" : "btn--primary"}`} onClick={startSweep} disabled={sweeping}>
                <IconPlay size={15} />
                {t("hearing.loudness.playSound", "Play Sound")}
              </button>
              {sweeping && (
                <button type="button" className="btn btn--primary" onClick={confirmAudible}>
                  <IconCheck size={14} />
                  {t("hearing.loudness.canHearIt", "I can hear it")}
                </button>
              )}
              {sweeping && (
                <Chip tone="signal" live>
                  {t("hearing.playing")}
                </Chip>
              )}
            </div>
          </div>
        )}

        {/* -- screens 3-4 · coarse loudness comparison --------------------- */}
        {lmScreen === "compare" && pitchHz && matcher.current && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.loudness.compareQuestion", "How loud is the sound compared with your tinnitus?")}</span>
            <p className="meta">
              {t("hearing.loudness.comparisonFrequency", { hz: pitchHz, defaultValue: `Comparison frequency: ${pitchHz} Hz` })}
            </p>

            <div className="row">
              <button type="button" className="btn btn--primary" onClick={() => playAt(pitchHz, matcher.current!.currentLevel)}>
                <IconPlay size={15} />
                {t("hearing.loudness.playSound", "Play Sound")}
              </button>
            </div>

            <div className="stack stack-2">
              {(
                [
                  ["much_softer", t("hearing.loudness.muchSofter", "Much softer than my tinnitus")],
                  ["softer", t("hearing.loudness.softer", "Softer than my tinnitus")],
                  ["about_same", t("hearing.loudness.aboutSame", "About the same")],
                  ["louder", t("hearing.loudness.louder", "Louder than my tinnitus")],
                  ["much_louder", t("hearing.loudness.muchLouder", "Much louder than my tinnitus")],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" className="option" onClick={() => respond(value)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="row row--between">
              <span className="meta dim">{t("hearing.loudness.adjusting", "Adjusting loudness…")}</span>
              <span className="meta dim mono">{t("hearing.loudness.currentLevel", { db: level, defaultValue: `${level} dB` })}</span>
            </div>
          </div>
        )}

        {/* -- screen 5 · fine loudness matching ----------------------------- */}
        {lmScreen === "fine" && pitchHz && matcher.current && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.loudness.fineTitle", "Fine-tuning the loudness")}</span>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "46em" }}>
              {t(
                "hearing.loudness.fineInstruction",
                "The sounds are now very close. Please choose whether the comparison sound is softer or louder than your tinnitus."
              )}
            </p>

            <div className="row row--between">
              <button type="button" className="btn btn--primary" onClick={() => playAt(pitchHz, matcher.current!.currentLevel)}>
                <IconPlay size={15} />
                {t("hearing.loudness.playSound", "Play Sound")}
              </button>
              <span className="meta">{t("hearing.loudness.comparisonLevel", { db: level, defaultValue: `Comparison level: ${level} dB` })}</span>
            </div>

            <div className="row row--tight row--wrap">
              {(
                [
                  ["softer", t("hearing.loudness.fineSofter", "Softer")],
                  ["about_same", t("hearing.loudness.aboutSame", "About the same")],
                  ["louder", t("hearing.loudness.fineLouder", "Louder")],
                ] as const
              ).map(([value, label]) => (
                <button key={value} type="button" className="btn btn--primary" onClick={() => respond(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* -- screen 6 · final confirmation ---------------------------------- */}
        {lmScreen === "confirm" && pitchHz && matcher.current && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.loudness.confirmQuestion", "Does this sound as loud as your tinnitus?")}</span>
            <div className="row">
              <button type="button" className="btn btn--primary" onClick={() => playAt(pitchHz, matcher.current!.currentLevel)}>
                <IconPlay size={15} />
                {t("hearing.loudness.playMatchedSound", "Play Matched Sound")}
              </button>
            </div>
            <span className="meta">{t("hearing.loudness.comparisonLevel", { db: level, defaultValue: `Comparison level: ${level} dB` })}</span>

            <OptionGroup<"very_similar" | "somewhat_similar" | "try_again" | "">
              options={[
                { value: "very_similar", label: t("hearing.loudness.veryimilar", "Yes, very similar") },
                { value: "somewhat_similar", label: t("hearing.loudness.somewhatSimilar", "Somewhat similar") },
                { value: "try_again", label: t("hearing.loudness.tryAgain", "No, try again") },
              ]}
              value={lmSelectedConfirmation}
              onChange={setLmSelectedConfirmation}
            />

            <div className="row row--end">
              <button type="button" className="btn btn--primary" disabled={!lmSelectedConfirmation} onClick={commitConfirmation}>
                {t("hearing.loudness.confirmMatch", "Confirm Match")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 7 · result ----------------------------------------------- */}
        {lmScreen === "result" && pitchHz && level !== null && (
          <div className="stack stack-4">
            <span className="label label--signal">{t("hearing.loudness.resultTitle", "Your Tinnitus Loudness Match")}</span>
            <Readout label="" value={level} unit="dB" size="xl" tone="signal" />
            <p className="meta">
              {t("hearing.loudness.resultFrequency", {
                hz: pitchHz,
                khz: (pitchHz / 1000).toFixed(pitchHz % 1000 === 0 ? 0 : 1),
                defaultValue: `Matched frequency: ${pitchHz} Hz (${(pitchHz / 1000).toFixed(pitchHz % 1000 === 0 ? 0 : 1)} kHz)`,
              })}
            </p>
            <p className="meta">
              {t(
                "hearing.loudness.resultBody",
                "This is the sound level that most closely matched the perceived loudness of your tinnitus during the assessment."
              )}
            </p>
            {lmRepeated && (
              <Panel tone="info" tight>
                <p className="meta">{t("hearing.loudness.repeatedNote", "This result comes from a repeated loudness-matching attempt.")}</p>
              </Panel>
            )}
            <div className="row row--between">
              <button type="button" className="btn btn--ghost" onClick={() => playAt(pitchHz, level)}>
                <IconPlay size={15} />
                {t("hearing.loudness.playMatchedSound", "Play Matched Sound")}
              </button>
              <div className="row row--tight">
                <button type="button" className="btn btn--ghost" onClick={repeatAssessment}>
                  {t("hearing.loudness.repeatAssessment", "Repeat Assessment")}
                </button>
                <button type="button" className="btn btn--primary btn--lg" onClick={done}>
                  {t("hearing.loudness.continue", "Continue")}
                </button>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <Panel title={t("hearing.loudness.whyTitle")} tight headPlain>
        <p className="meta">{t("hearing.loudness.whyBody")}</p>
      </Panel>
    </div>
  );
}

/* ======================================================== 3 · masking === */
/**
 * Feldmann masking curve: Minimum Masking Level (MML) measured independently
 * at each frequency in `MASKING_FREQUENCIES`, in that fixed order. Frequency
 * and intensity are deliberately separate variables — the sequence advances
 * automatically and is never patient-controlled, while `MaskingLevelFinder`
 * (see `audio/procedures.ts`) adapts intensity alone at whichever frequency
 * is current. The patient only ever answers whether the tinnitus is still
 * audible, masked, or reports Not Sure.
 */
type MaskingScreen = "instructions" | "stimulus_intro" | "measuring" | "next_frequency" | "result";

function MaskingModule({
  pitchOutcome,
  loudnessOutcome,
  existingOutcome,
  handleRef,
  stopSound,
  onBack,
  onNext,
}: {
  pitchOutcome: PitchMatchOutcome | null;
  loudnessOutcome: LoudnessMatchOutcome | null;
  /** A previously completed masking-curve pass, if the patient has stepped
   *  away and back — shown as the result screen again rather than restarting. */
  existingOutcome: MaskingMatchOutcome | null;
  handleRef: React.MutableRefObject<{ stop(f?: number): void; setLevelDb(db: number, r?: number): void } | null>;
  stopSound(): void;
  onBack(): void;
  onNext(outcome: MaskingMatchOutcome): void;
}) {
  const { t } = useTranslation();
  const [mScreen, setMScreen] = useState<MaskingScreen>(existingOutcome ? "result" : "instructions");
  const [freqIndex, setFreqIndex] = useState(0);
  const [results, setResults] = useState<MaskingFrequencyResult[]>(existingOutcome?.frequencies ?? []);
  const [repeated, setRepeated] = useState(existingOutcome?.repeated ?? false);
  const [level, setLevel] = useState<number | null>(null);

  const finder = useRef<MaskingLevelFinder | null>(null);
  const hz = MASKING_FREQUENCIES[freqIndex];
  const ceiling = Math.min(85, Math.round(engine.maxReachableHl(hz))); // MAX_SAFE_MASKING_DB, backend/api/services/masking.py

  async function playAt(centreHz: number, dbHL: number, ms = 2000) {
    await engine.resume();
    stopSound();
    handleRef.current = engine.playBandNoise({
      centreHz,
      bandwidthOctaves: 0.5,
      dbfs: engine.hlToDbfs(dbHL, centreHz),
      ear: "both",
      fadeInS: 0.15,
    });
    window.setTimeout(() => handleRef.current?.stop(0.2), ms);
  }

  /** Each frequency starts from the level the last one settled at — masking
   *  thresholds are correlated across neighbouring frequencies. The very
   *  first frequency starts from the patient's own loudness match plus a
   *  fixed margin (see `MaskingLevelFinder.LOUDNESS_TO_MASKING_MARGIN_DB`),
   *  the same clinical assumption `personalised_reference()` already makes
   *  server-side, or a safe default if no loudness match exists yet. */
  function startingLevelFor(index: number): number {
    const previous = results[index - 1];
    if (previous && previous.mml_db !== null) return previous.mml_db;
    return (loudnessOutcome?.levelDb ?? 25) + MaskingLevelFinder.LOUDNESS_TO_MASKING_MARGIN_DB;
  }

  function beginFrequency(index: number) {
    const start = startingLevelFor(index);
    finder.current = new MaskingLevelFinder(start, -10, ceiling);
    setLevel(finder.current.currentLevel);
    setMScreen("measuring");
  }

  function respond(response: MaskingResponse) {
    if (!finder.current) return;
    finder.current.respond(response);
    if (finder.current.done) {
      const frequencyResult: MaskingFrequencyResult = {
        frequency_hz: hz,
        trials: finder.current.trace,
        mml_db: finder.current.result(),
      };
      setResults((prev) => [...prev, frequencyResult]);
      if (freqIndex + 1 < MASKING_FREQUENCIES.length) {
        setFreqIndex((i) => i + 1);
        setMScreen("next_frequency");
      } else {
        setMScreen("result");
      }
    } else {
      setLevel(finder.current.currentLevel);
    }
  }

  function repeatAssessment() {
    setResults([]);
    setFreqIndex(0);
    setRepeated(true);
    setMScreen("instructions");
  }

  function done() {
    const notSureCount = results.reduce(
      (sum, r) => sum + r.trials.filter((t) => t.response === "not_sure").length,
      0
    );
    onNext({ frequencies: results, notSureCount, repeated });
  }

  const testedCount = results.length;
  const totalCount = MASKING_FREQUENCIES.length;

  return (
    <div className="stack stack-5">
      <Panel title={t("hearing.masking.title", "Find Your Tinnitus Masking Levels")} bracketed>
        {/* -- screen 1 · instructions ------------------------------------- */}
        {mScreen === "instructions" && (
          <div className="stack stack-5">
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "50em", lineHeight: 1.6 }}>
              {t(
                "hearing.masking.instructions",
                "You will hear a soft masking sound at different pitches. For each sound, we will gradually adjust its loudness."
              )}
            </p>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "50em", lineHeight: 1.6 }}>
              {t(
                "hearing.masking.instructions2",
                "Tell us whether you can still hear your tinnitus. The app will automatically adjust the sound level."
              )}
            </p>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "50em" }}>
              {t("hearing.masking.instructions3", "You do not need to adjust the volume yourself.")}
            </p>
            <div className="row row--end">
              <button type="button" className="btn btn--primary btn--lg" onClick={() => setMScreen("stimulus_intro")}>
                {t("hearing.masking.startButton", "Start")}
              </button>
            </div>
          </div>
        )}

        {/* -- screen 2 · masking sound explanation ------------------------- */}
        {mScreen === "stimulus_intro" && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.masking.soundTitle", "Masking Sound")}</span>
            <Chip tone="ghost">{t("hearing.stimulus.narrowband")}</Chip>
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "50em", lineHeight: 1.6 }}>
              {t(
                "hearing.masking.autoFrequencyNote",
                "The app automatically changes the frequency of the masking sound during the assessment. You don't need to select the frequency."
              )}
            </p>
            <div className="row row--end">
              <button type="button" className="btn btn--primary" onClick={() => beginFrequency(0)}>
                {t("common.continue")}
              </button>
            </div>
          </div>
        )}

        {/* -- screens 3-4-6-7 · MML measurement (coarse, then fine) --------- */}
        {mScreen === "measuring" && finder.current && level !== null && (
          <div className="stack stack-5">
            <span className="label label--signal">
              {finder.current.phase === "fine"
                ? t("hearing.masking.fineTitle", "Fine Adjustment")
                : t("hearing.masking.measuringTitle", "Masking Level Measurement")}
            </span>
            {finder.current.phase === "fine" && (
              <p style={{ fontSize: "var(--fs-small)", maxWidth: "50em" }}>
                {t(
                  "hearing.masking.fineInstruction",
                  "We are making smaller adjustments to find the lowest level that masks your tinnitus."
                )}
              </p>
            )}
            <p className="meta dim">
              {t("hearing.masking.currentFrequency", { hz, defaultValue: `Current masking frequency: ${hz} Hz` })}
            </p>

            <div className="row">
              <button type="button" className="btn btn--primary" onClick={() => playAt(hz, level)}>
                <IconPlay size={15} />
                {t("hearing.masking.playSound", "Play Sound")}
              </button>
            </div>

            <span className="label">{t("hearing.masking.question", "Can you still hear your tinnitus?")}</span>
            <div className="row row--tight row--wrap">
              <button type="button" className="btn btn--primary" onClick={() => respond("audible")}>
                {t("hearing.masking.audible", "Yes, I can still hear it")}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => respond("masked")}>
                {t("hearing.masking.masked", "No, my tinnitus is masked")}
              </button>
              <button type="button" className="btn" onClick={() => respond("not_sure")}>
                {t("hearing.masking.notSure", "Not Sure")}
              </button>
            </div>

            <div className="row row--between">
              <span className="meta dim">
                {finder.current.phase === "fine"
                  ? t("hearing.masking.findingMinimum", "Finding the minimum level…")
                  : t("hearing.masking.adjusting", "Adjusting loudness…")}
              </span>
              <span className="meta dim mono">{t("hearing.masking.levelValue", { db: level, defaultValue: `${level} dB` })}</span>
            </div>
          </div>
        )}

        {/* -- screen 5 · next masker frequency ------------------------------ */}
        {mScreen === "next_frequency" && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.masking.nextSound", "Next Sound")}</span>
            <p className="meta dim">
              {t("hearing.masking.currentFrequency", { hz, defaultValue: `Masking frequency: ${hz} Hz` })}
            </p>
            <div className="row row--tight">
              <button
                type="button"
                className="btn"
                onClick={() => playAt(hz, startingLevelFor(freqIndex))}
              >
                <IconPlay size={15} />
                {t("hearing.masking.playSound", "Play Sound")}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => beginFrequency(freqIndex)}>
                {t("common.continue")}
              </button>
            </div>
            <span className="meta dim">
              {t("hearing.masking.stepOf", { current: freqIndex + 1, total: totalCount })}
            </span>
          </div>
        )}

        {/* -- screens 8-9 · Feldmann masking curve + results ---------------- */}
        {mScreen === "result" && (
          <div className="stack stack-5">
            <span className="label label--signal">{t("hearing.masking.resultTitle", "Your Masking Curve")}</span>
            <p className="meta">
              {t("hearing.masking.tinnitusPitch", {
                hz: pitchOutcome?.hz ?? null,
                defaultValue: pitchOutcome?.hz ? `Tinnitus pitch: ${pitchOutcome.hz} Hz` : "Tinnitus pitch: not yet measured",
              })}
            </p>
            <p className="meta">{t("hearing.masking.stimulusLabel", { defaultValue: "Masking stimulus: Narrowband noise" })}</p>

            <table className="table">
              <thead>
                <tr>
                  <th>{t("hearing.masking.tableFrequency", "Masker Frequency")}</th>
                  <th>{t("hearing.masking.tableMml", "Minimum Masking Level")}</th>
                </tr>
              </thead>
              <tbody>
                {MASKING_FREQUENCIES.map((f) => {
                  const found = results.find((r) => r.frequency_hz === f);
                  return (
                    <tr key={f}>
                      <td>{f} Hz</td>
                      <td>
                        {found ? (found.mml_db !== null ? `${found.mml_db} dB` : t("hearing.masking.unavailable", "Not obtained")) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {repeated && (
              <Panel tone="info" tight>
                <p className="meta">{t("hearing.masking.repeatedNote", "This result comes from a repeated masking-curve assessment.")}</p>
              </Panel>
            )}

            <div className="row row--between">
              <button type="button" className="btn btn--ghost" onClick={repeatAssessment}>
                {t("hearing.masking.repeatAssessment", "Repeat Assessment")}
              </button>
              <button type="button" className="btn btn--primary btn--lg" onClick={done}>
                {t("hearing.masking.finishButton", "Finish")}
              </button>
            </div>
          </div>
        )}

        {mScreen !== "result" && (
          <div className="row row--between" style={{ marginTop: "var(--s5)" }}>
            <button type="button" className="btn" onClick={onBack}>
              ← {t("common.back")}
            </button>
            <span className="meta dim">
              {t("hearing.masking.progress")}: {testedCount}/{totalCount}
            </span>
          </div>
        )}
      </Panel>

      {/* The curve appears as soon as there is anything to plot, so the
          patient watches it build rather than meeting it cold at the end. */}
      {testedCount >= 2 && (
        <Panel title={t("masking.chart.title")} bracketed>
          <MaskingCurve
            curve={buildMaskingCurvePoints(MASKING_FREQUENCIES, results)}
            referenceDb={
              results.some((r) => r.mml_db !== null)
                ? Math.min(...results.filter((r) => r.mml_db !== null).map((r) => r.mml_db as number))
                : null
            }
            referenceHz={
              results.some((r) => r.mml_db !== null)
                ? results
                    .filter((r) => r.mml_db !== null)
                    .sort((a, b) => (a.mml_db as number) - (b.mml_db as number) || a.frequency_hz - b.frequency_hz)[0]
                    .frequency_hz
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

export { MASKING_FREQUENCIES, SteppedSlider };

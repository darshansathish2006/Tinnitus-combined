/**
 * The personalised reference level — the last module of the hearing measurement.
 *
 * **Why it is here and not at the start.** The reference level used to be the
 * first thing a patient did: level a 1 kHz tone to conversational loudness, and
 * every number afterwards was expressed against it. That is a calibration of the
 * *equipment*, and it was placed first because that is where equipment
 * calibration belongs — not because it was where the patient's assessment
 * needed it.
 *
 * A 1 kHz anchor is also the wrong place to stand for this population. Most
 * tinnitus percepts sit between 3 and 8 kHz, in the same region as the hearing
 * loss they accompany; anchoring at 1 kHz pins the output curve at the one part
 * of the spectrum the assessment has already established is least
 * representative of the patient, and then carries the RETSPL interpolation error
 * two or three octaves to where the measurement actually happens.
 *
 * So this module runs *after* pitch matching, loudness matching and the masking
 * profile, and it uses them. The server derives the tone and the level from what
 * the patient has already given — nothing is re-measured — and the patient hears
 * their own tone rather than a generic one. See
 * `api/services/masking.personalised_reference` for the derivation; it is
 * computed there, never here, so this screen and the report cannot disagree.
 *
 * The patient can trim the level. That is not a second measurement: it is the
 * one-point anchoring that used to happen at 1 kHz, moved to the frequency it
 * matters at, and it re-solves the engine's dBFS↔dB HL mapping so that therapy
 * delivered afterwards lands where the prescription says it should.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type PersonalisedReferenceResponse } from "../../api/client";
import { engine, REFERENCE_SPL_DB } from "../../audio/engine";
import { Chip, ErrorState, Loading, Panel, Readout, useAsync } from "../../components/ui";
import { IconCheck, IconPlay, IconStop } from "../../components/icons";
import { SteppedSlider } from "./HearingMeasurement";

/** The server's derivation — see `api/services/masking.personalised_reference`. */
export type PersonalisedReference = PersonalisedReferenceResponse;

export interface ReferenceLevelResult {
  reference_tone_hz: number;
  reference_level_db_hl: number;
  /** How far the patient moved it from the derived value, in dB. */
  trim_db: number;
  frequency_basis: string;
  level_basis: string;
}

/** How far either side of the derived level the patient may trim. */
const TRIM_RANGE_DB = 15;

function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2)} kHz` : `${hz} Hz`;
}

export default function PersonalizedReference({
  assessmentId,
  onComplete,
  saving = false,
}: {
  assessmentId: number | null;
  onComplete(result: ReferenceLevelResult): void;
  saving?: boolean;
}) {
  const { t } = useTranslation();
  const derived = useAsync(
    () =>
      assessmentId === null
        ? Promise.resolve(null)
        : api.assessments.referenceLevel(assessmentId),
    [assessmentId]
  );

  if (derived.loading) return <Loading label={t("reference.deriving")} rows={3} />;
  if (derived.error) return <ErrorState error={derived.error} retry={derived.reload} />;

  return (
    <ReferenceLevelModule
      summary={derived.data}
      onComplete={onComplete}
      saving={saving}
    />
  );
}

function ReferenceLevelModule({
  summary,
  onComplete,
  saving,
}: {
  summary: PersonalisedReference | null;
  onComplete(result: ReferenceLevelResult): void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const derivedHz = summary?.reference_tone_hz ?? null;
  const derivedDb = summary?.reference_level_db_hl ?? null;

  const [trim, setTrim] = useState(0);
  const [playing, setPlaying] = useState(false);
  const handleRef = useRef<{ stop(f?: number): void } | null>(null);

  const stopSound = useCallback(() => {
    handleRef.current?.stop(0.15);
    handleRef.current = null;
  }, []);

  useEffect(() => () => stopSound(), [stopSound]);

  // The delivered level, bounded by what the hardware can actually reach at this
  // frequency. A slider that runs past the clipping point silently stops getting
  // louder, which a patient reads as their own hearing rather than as a limit.
  const ceiling = derivedHz === null ? 0 : Math.min(summary?.max_safe_db ?? 85, Math.round(engine.maxReachableHl(derivedHz)));
  const level = derivedDb === null ? null : Math.max(0, Math.min(ceiling, Math.round(derivedDb + trim)));

  useEffect(() => {
    if (!playing || derivedHz === null || level === null) return;
    stopSound();
    handleRef.current = engine.playTone({
      freq: derivedHz,
      dbHL: level,
      ear: "both",
      durationMs: null,
      rampMs: 30,
    });
  }, [derivedHz, level, playing, stopSound]);

  async function toggle() {
    if (playing) {
      stopSound();
      setPlaying(false);
      return;
    }
    await engine.resume();
    setPlaying(true);
  }

  /**
   * Re-anchor the engine at the patient's own frequency, then hand the result up.
   *
   * The engine's mapping is
   * `dBFS = referenceDbfs + (dB HL + RETSPL(f)) − referenceSPL`, so the anchor
   * that has to move is `referenceDbfs`. The patient has just settled their own
   * reference tone `trim` dB away from the derived level: at nominal `derivedDb`
   * the engine was therefore delivering `trim` dB short of the mark, and the
   * anchor shifts by exactly that. Solving it this way — at the tinnitus
   * frequency, against a level the patient's own masking curve produced — is
   * what replaces levelling a 1 kHz tone by ear at the start.
   */
  function confirm() {
    stopSound();
    setPlaying(false);
    if (derivedHz === null || level === null || derivedDb === null) return;

    engine.setCalibration({
      referenceDbfs: engine.calibration.referenceDbfs + (level - derivedDb),
      referenceSplDb: REFERENCE_SPL_DB,
      calibratedAt: new Date().toISOString(),
    });

    onComplete({
      reference_tone_hz: derivedHz,
      reference_level_db_hl: level,
      trim_db: level - derivedDb,
      frequency_basis: summary?.frequency_basis ?? "unavailable",
      level_basis: summary?.level_basis ?? "unavailable",
    });
  }

  /* -- nothing to personalise from ---------------------------------------- */
  if (!summary?.personalised || derivedHz === null || derivedDb === null || level === null) {
    return (
      <Panel title={t("reference.title")} bracketed tone="warn">
        <div className="stack stack-4">
          <p style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, maxWidth: "52em" }}>
            {t("reference.unavailable")}
          </p>
          <div className="row row--end">
            <button
              type="button"
              className="btn btn--lg"
              onClick={() =>
                onComplete({
                  reference_tone_hz: 0,
                  reference_level_db_hl: 0,
                  trim_db: 0,
                  frequency_basis: summary?.frequency_basis ?? "unavailable",
                  level_basis: summary?.level_basis ?? "unavailable",
                })
              }
              disabled={saving}
            >
              {t("reference.skip")}
            </button>
          </div>
        </div>
      </Panel>
    );
  }

  const basisRows = [
    summary.inputs.pitch_match_hz !== null && {
      key: "pitch",
      value: formatHz(summary.inputs.pitch_match_hz),
    },
    summary.inputs.loudness_match_db_hl !== null && {
      key: "loudness",
      value: `${Math.round(summary.inputs.loudness_match_db_hl)} dB HL`,
    },
    summary.inputs.masking_tested_count > 0 && {
      key: "masking",
      value: t("reference.basis.maskingValue", {
        count: summary.inputs.masking_tested_count,
        db: summary.inputs.masking_minimum_db === null ? "—" : Math.round(summary.inputs.masking_minimum_db),
        hz: summary.inputs.masking_minimum_hz === null ? "—" : formatHz(summary.inputs.masking_minimum_hz),
      }),
    },
    summary.hearing_threshold_db_hl !== null && {
      key: "hearing",
      value: `${Math.round(summary.hearing_threshold_db_hl)} dB HL`,
    },
  ].filter(Boolean) as { key: string; value: string }[];

  return (
    <div className="grid grid-sidebar" style={{ ["--aside" as string]: "300px" }}>
      <Panel title={t("reference.title")} bracketed>
        <div className="stack stack-5">
          <p style={{ fontSize: "var(--fs-small)", maxWidth: "48em", lineHeight: 1.6 }}>
            {t("reference.lead")}
          </p>

          {/* The two numbers the module exists to produce, side by side and
              large. Both are the patient's own — neither is a device constant. */}
          <div className="row" style={{ gap: "var(--s8)" }}>
            <Readout
              label={t("reference.tone")}
              value={derivedHz >= 1000 ? (derivedHz / 1000).toFixed(derivedHz % 1000 === 0 ? 0 : 2) : derivedHz}
              unit={derivedHz >= 1000 ? "kHz" : "Hz"}
              size="xl"
              tone="signal"
              note={t("reference.alsoHz", { hz: derivedHz })}
            />
            <Readout
              label={t("reference.level")}
              value={level}
              unit="dB HL"
              size="xl"
              tone={summary.capped_to_safe ? "warn" : "data"}
              note={
                summary.sensation_level_db === null
                  ? t(`reference.levelBasis.${summary.level_basis}`, { defaultValue: "" })
                  : t("reference.aboveThreshold", {
                      db: Math.max(0, Math.round(level - (summary.hearing_threshold_db_hl ?? 0))),
                    })
              }
            />
          </div>

          {/* The patient-friendly explanation the brief asks for: this tone is
              yours, and here is why it is not the same as anyone else's. */}
          <Panel tone="info" tight>
            <p className="meta" style={{ lineHeight: 1.6 }}>
              {t("reference.explain", { hz: formatHz(derivedHz), db: level })}
            </p>
          </Panel>

          <div className="stack stack-3">
            <div className="row">
              <button type="button" className={`btn ${playing ? "" : "btn--primary"}`} onClick={toggle}>
                {playing ? <IconStop size={15} /> : <IconPlay size={15} />}
                {t(playing ? "reference.stop" : "reference.play")}
              </button>
              {playing && (
                <Chip tone="signal" live>
                  {t("hearing.playing")}
                </Chip>
              )}
            </div>

            <SteppedSlider
              value={trim}
              min={-TRIM_RANGE_DB}
              max={TRIM_RANGE_DB}
              step={1}
              onChange={setTrim}
              format={(v) => `${v > 0 ? "+" : ""}${v} dB`}
              label={t("reference.trim")}
              ariaLabel={t("reference.trimSlider")}
              lowLabel={t("hearing.loudness.quiet")}
              highLabel={t("hearing.loudness.loud")}
              tone="data"
            />
            <p className="meta">{t("reference.trimHelp")}</p>
          </div>

          {summary.floored_to_audibility && (
            <Panel tone="sunken" tight>
              <p className="meta">{t("reference.flooredNote")}</p>
            </Panel>
          )}
          {summary.capped_to_safe && (
            <Panel tone="warn" tight>
              <p className="meta">{t("reference.cappedNote", { db: Math.round(summary.max_safe_db) })}</p>
            </Panel>
          )}

          <div className="row row--end">
            <button type="button" className="btn btn--primary btn--lg" onClick={confirm} disabled={saving}>
              <IconCheck size={15} />
              {t("reference.confirm")}
            </button>
          </div>
        </div>
      </Panel>

      <Panel title={t("reference.builtFrom")} tight headPlain>
        <div className="stack stack-3">
          <p className="meta">{t("reference.builtFromLead")}</p>
          <div className="stack stack-2">
            {basisRows.map((row) => (
              <div key={row.key} className="stack stack-1">
                <span className="label">{t(`reference.basis.${row.key}`)}</span>
                <span className="mono" style={{ fontSize: "var(--fs-small)", fontWeight: 600 }}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>
          <hr className="rule rule--tight" />
          <p className="meta">
            {t(`reference.frequencyBasis.${summary.frequency_basis}`, { defaultValue: "" })}
          </p>
        </div>
      </Panel>
    </div>
  );
}

/**
 * Assessment orchestrator.
 *
 * **Three required steps, not six.** The previous flow front-loaded every
 * measurement audiology can perform, which is not what guidelines ask for and is
 * not what patients complete:
 *
 *  1. **About you** — history, and the only place character and laterality are
 *     asked (they used to be asked twice).
 *  2. **Hearing measurement** — device setup, audiometry, the three tinnitus
 *     measurement modules, and finally the personalised reference level, as one
 *     continuous step. Device setup is skipped entirely for returning patients
 *     on the same headphones.
 *  3. **How it affects you** — the stepped questionnaire battery.
 *
 * **Within the hearing measurement, the reference level comes last.** It used to
 * come first, as equipment calibration against a fixed 1 kHz tone. It is now
 * derived from the patient's own pitch match, loudness match, masking profile
 * and audiogram — which means it cannot be produced until those exist. See
 * `assessment/PersonalizedReference` for why a 1 kHz anchor was the wrong place
 * to stand for this population in the first place.
 *
 * **Tinnitus pitch and loudness matching is offered afterwards as optional**,
 * because the AAO-HNSF clinical practice guideline states routine psychoacoustic
 * testing is not required for initial tinnitus assessment. It is offered rather
 * than dropped because it is what makes a therapy notch possible — so the choice
 * is presented with that trade-off stated, not hidden.
 *
 * Every step is saved to the server as it completes, so a dropped connection or a
 * refresh loses at most one step.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, ApiError, type Analysis, type Assessment as AssessmentRow } from "../api/client";
import { useSession } from "../state/session";
import { engine } from "../audio/engine";
import { CHARACTER_OPTIONS } from "../audio/procedures";
import {
  Chip,
  Disclosure,
  ErrorState,
  Field,
  Loading,
  Panel,
  Readout,
  StepRail,
  UrgencyChip,
  fmt,
  useAsync,
} from "../components/ui";
import { Audiogram, Fingerprint, RadialGauge } from "../components/charts";
import { IconChevronRight, IconFile } from "../components/icons";
import { ClinicalSummary } from "./Results";
import { AboutYouExtended } from "./assessment/AboutYouExtended";
import {
  ABOUT_YOU_SECTIONS,
  SNAPSHOT_SECTION,
  lateralityFromLocation,
  type AboutYouAnswer,
  type AboutYouAnswers,
} from "./assessment/aboutYouQuestions";
import Calibration, { type CalibrationResult } from "./assessment/Calibration";
import Audiometry, { type AudiometryResult } from "./assessment/Audiometry";
import TinnitusMatch, { type MatchResult } from "./assessment/TinnitusMatch";
import AboutYourTinnitus from "./assessment/AboutYourTinnitus";
import HearingMeasurement, {
  MASKING_FREQUENCIES,
  type HearingMeasurementResult,
} from "./assessment/HearingMeasurement";
import PersonalizedReference, { type ReferenceLevelResult } from "./assessment/PersonalizedReference";
import { ReferenceLevelPanel } from "../components/ReferenceLevel";

/**
 * The assessment, in the order a clinician would actually take it.
 *
 * History, then the patient's account of the percept, then the objective
 * measurement of it, then the comorbidity screeners, then interpretation. The
 * previous order put every questionnaire after the hearing test, which had two
 * problems: the tinnitus VAS ratings were being given by someone who had just
 * been told their tinnitus measures 32 dB — which changes the answer — and the
 * assessment ended with eighteen consecutive questions instead of ending with
 * the result.
 */
const STEPS = [
  { key: "intake", minutes: 2 },
  { key: "questionnaire", minutes: 6 },
  { key: "hearing", minutes: 6 },
  { key: "optional", minutes: 0 },
  { key: "results", minutes: 0 },
];

/**
 * Comorbidity values are stored on the patient record in English — they are the
 * vocabulary the clinical record, the ML feature vector and the exported report
 * all share, and translating what gets *written* would fork the data by the
 * language the patient happened to be using. Only the label is translated; the
 * English string stays the value.
 */
const COMORBIDITY_OPTIONS = [
  "Hypertension", "Type 2 diabetes", "Migraine", "Anxiety disorder", "Depression",
  "Vertigo", "Neck pain", "Jaw pain / TMJ", "Hypothyroidism", "Head injury",
  "Ear infection history", "Headache", "Visual disturbance",
];

/**
 * The four phases of the hearing measurement step, in the order they run.
 *
 * `reference` is last on purpose: it is derived from `measurement`, not a
 * precondition of it.
 */
type HearingPhase = "calibration" | "audiometry" | "measurement" | "reference";

const HEARING_PHASES: HearingPhase[] = ["calibration", "audiometry", "measurement", "reference"];

export default function Assessment() {
  const { t } = useTranslation();
  const toast = useSession((s) => s.toast);
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [assessment, setAssessment] = useState<AssessmentRow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [saving, setSaving] = useState(false);
  const [fatal, setFatal] = useState<unknown>(null);

  const [hearingPhase, setHearingPhase] = useState<HearingPhase>("calibration");
  /** Kept so the results step can show the curve without a refetch. */
  const [measurement, setMeasurement] = useState<HearingMeasurementResult | null>(null);
  // Screeners no longer gate this offer — the "Sleep, mood and stress" module
  // that used to precede it inside this same step was removed and folded into
  // Module 2 (About Your Tinnitus), which now runs entirely at step 1. Step 3
  // is reached only after hearing measurement is done, so the offer can show
  // immediately rather than waiting on a flag another module used to flip.
  const [offerOptional, setOfferOptional] = useState(true);
  const [doingOptional, setDoingOptional] = useState(false);

  const profile = useAsync(() => api.patients.me(), []);
  const instruments = useAsync(() => api.assessments.instruments(), []);

  // Intake
  /**
   * What the tinnitus sounds like — now a set rather than one answer.
   *
   * Plenty of people hear two things at once: a hiss with a tone riding on it is
   * the textbook presentation, and forcing that into a single button meant
   * either losing half the description or falling back on "Multiple sounds",
   * which records that there were several without recording what they were.
   *
   * Order is meaningful and preserved: the first selection is the primary
   * character, and it is what the server keeps in `tinnitus_character` for every
   * existing reader — the report narrative, the analysis payload, the model's
   * feature vector. Nothing downstream had to change to accept a list.
   */
  const [characters, setCharacters] = useState<string[]>([CHARACTER_OPTIONS[0]]);
  const [laterality, setLaterality] = useState<"left" | "right" | "both" | "central">("both");
  const [pulsatile, setPulsatile] = useState(false);
  const [hearingAids, setHearingAids] = useState(false);
  const [comorbidities, setComorbidities] = useState<string[]>([]);
  const [medications, setMedications] = useState("");
  const [consent, setConsent] = useState(false);
  /**
   * The extended About You questionnaire (Sections 1–22 plus the tinnitus
   * snapshot). One flat answer store, matching how `thi_items` already holds a
   * scored instrument's raw responses — see `Patient.about_you`.
   *
   * Four of its answers (`sound_description`, `tinnitus_location`,
   * `pulsatile_beats_with_heart`, `hearing_aids_current`) are the same
   * questions `characters`/`laterality`/`pulsatile`/`hearingAids` above already
   * asked, now asked more completely. Those four legacy variables are kept —
   * `laterality` in particular is still read by the optional pitch-matching
   * step below — and are kept in sync with this store by the effects
   * immediately after the hydration effect, so nothing downstream has to
   * learn a second source of truth.
   */
  const [aboutYou, setAboutYou] = useState<AboutYouAnswers>({});
  function setAboutYouField(key: string, value: AboutYouAnswer) {
    setAboutYou((prev) => ({ ...prev, [key]: value }));
  }

  useEffect(() => {
    const p = profile.data;
    if (!p) return;
    // Prefer the stored set; fall back to the single character for a record
    // written before the field existed, so an older patient's answer still
    // loads rather than resetting to the first option.
    if (p.tinnitus_characters?.length) setCharacters(p.tinnitus_characters);
    else if (p.tinnitus_character) setCharacters([p.tinnitus_character]);
    if (p.laterality) setLaterality(p.laterality as typeof laterality);
    setPulsatile(p.pulsatile);
    setHearingAids(p.hearing_aid_use);
    setComorbidities(p.comorbidities ?? []);
    setMedications((p.medications ?? []).join(", "));
    setConsent(p.consent_research);

    // Seed the four shared answers from the legacy fields only where About You
    // has not already been answered — a stored `about_you` always wins, so a
    // patient who has filled in the richer question never sees it reset to the
    // coarser legacy value. Booleans seed only their positive case: `false` on
    // `pulsatile`/`hearing_aid_use` is indistinguishable from "never asked",
    // and presupposing "No" on a question this patient has not actually seen
    // yet would be answering it for them.
    setAboutYou((prev) => {
      const seeded: AboutYouAnswers = { ...(p.about_you as AboutYouAnswers | undefined ?? {}), ...prev };
      if (seeded.sound_description === undefined) {
        if (p.tinnitus_characters?.length) seeded.sound_description = p.tinnitus_characters;
        else if (p.tinnitus_character) seeded.sound_description = [p.tinnitus_character];
      }
      if (seeded.tinnitus_location === undefined && p.laterality) {
        const reverse: Record<string, string> = {
          left: "Left ear",
          right: "Right ear",
          both: "Both ears",
          central: "In the middle of my head",
        };
        if (reverse[p.laterality]) seeded.tinnitus_location = reverse[p.laterality];
      }
      if (seeded.pulsatile_beats_with_heart === undefined && p.pulsatile) {
        seeded.pulsatile_beats_with_heart = "Yes";
      }
      if (seeded.hearing_aids_current === undefined && p.hearing_aid_use) {
        seeded.hearing_aids_current = "Yes";
      }
      return seeded;
    });
  }, [profile.data]);

  /**
   * Keep the four legacy fields in step with their richer About You answers.
   *
   * One effect per field rather than one effect watching all four, so editing
   * one answer cannot re-trigger the others' derivation and fight a value the
   * patient just set directly (there is no other way to set these four now,
   * but the isolation costs nothing and removes the question).
   */
  useEffect(() => {
    const selected = aboutYou.sound_description as string[] | undefined;
    if (selected && selected.length) setCharacters(selected);
  }, [aboutYou.sound_description]);

  useEffect(() => {
    const mapped = lateralityFromLocation(aboutYou.tinnitus_location);
    if (mapped) setLaterality(mapped);
  }, [aboutYou.tinnitus_location]);

  useEffect(() => {
    const answer = aboutYou.pulsatile_beats_with_heart;
    if (answer === "Yes") setPulsatile(true);
    else if (answer === "No") setPulsatile(false);
  }, [aboutYou.pulsatile_beats_with_heart]);

  useEffect(() => {
    const answer = aboutYou.hearing_aids_current;
    if (answer === "Yes") setHearingAids(true);
    else if (answer === "No") setHearingAids(false);
  }, [aboutYou.hearing_aids_current]);

  useEffect(() => () => engine.stopAll(0.2), []);

  function markDone(key: string, next: number) {
    setCompleted((prev) => new Set(prev).add(key));
    setStep(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveModule(body: Record<string, unknown>, modules: string[]) {
    let row = assessment;
    if (!row) {
      row = await api.assessments.create();
      setAssessment(row);
    }
    const updated = await api.assessments.save(row.id, { ...body, modules_done: modules });
    setAssessment(updated);
    return updated;
  }

  /* -- step handlers ------------------------------------------------------- */
  async function submitIntake() {
    setSaving(true);
    try {
      await api.patients.updateMe({
        // Both are sent, but the server derives the primary from the list so the
        // two cannot disagree — see `PatientProfileUpdateSerializer.update`.
        tinnitus_character: characters[0] ?? "",
        tinnitus_characters: characters,
        laterality,
        pulsatile,
        hearing_aid_use: hearingAids,
        // `onset_date`, `somatic_modulation`, `hyperacusis` and
        // `noise_exposure_years` are deliberately not sent here any more —
        // Module 1 no longer asks the duration slider, the jaw/neck and
        // everyday-sounds checkboxes, or the noise-exposure slider that used
        // to set them. `PATCH .../patients/me` is a partial update
        // (`partial=True`), so omitting these keys leaves whatever value is
        // already on record untouched rather than overwriting it with a
        // fresh default — no historical answer is lost or reset.
        comorbidities,
        medications: medications.split(",").map((m) => m.trim()).filter(Boolean),
        consent_research: consent,
        about_you: aboutYou,
      });
      await profile.reload();
      await saveModule({}, ["intake"]);
      setHearingPhase(profile.data?.has_saved_calibration ? "calibration" : "calibration");
      markDone("intake", 1);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("assessment.toast.detailsFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  /** Reuse the stored headphone calibration instead of repeating it. */
  async function reuseCalibration() {
    const saved = profile.data?.saved_device_profile;
    if (!saved) return;
    setSaving(true);
    try {
      engine.setCalibration({
        transducer: saved.transducer ?? "unknown",
        referenceDbfs: saved.output_gain_db ?? -22,
        referenceSplDb: saved.reference_spl_db ?? 65,
        ambientNoiseDb: saved.ambient_noise_db ?? null,
        calibratedAt: new Date().toISOString(),
      });
      await saveModule({ device_profile: { ...saved, reused: true } }, ["calibration"]);
      setHearingPhase("audiometry");
      toast(t("assessment.toast.savedSetup"), "ok");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("assessment.toast.savedSetupFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  async function submitCalibration(result: CalibrationResult) {
    setSaving(true);
    try {
      await saveModule({ device_profile: result, save_calibration: true }, ["calibration"]);
      setHearingPhase("audiometry");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("assessment.toast.calibrationFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  async function submitAudiometry(result: AudiometryResult) {
    setSaving(true);
    try {
      // The reliability verdict travels with the thresholds it qualifies.
      // Previously only `audiogram` was sent and `reliable` was raised as a
      // toast — so the one signal saying "do not trust these numbers" lived for
      // four seconds on the patient's screen and never reached the record, the
      // reports or the clinician. A threshold obtained from someone pressing the
      // button in silence is not a threshold, and a report that shows it without
      // that caveat is worse than one with a gap in it.
      await saveModule(
        {
          audiogram: result.audiogram,
          audiometry_reliable: result.reliable,
          audiometry_notes: result.notes,
          audiometry_false_positives: result.falsePositives,
          audiometry_catch_trials: result.catchTrials,
          audiometry_retest_agreement_db: result.retestAgreementDb,
        },
        ["audiometry"]
      );
      if (!result.reliable) toast(t("assessment.toast.audiometryFlagged"), "crit");
      // Audiometry is the last part of the hearing step's *calibration* half;
      // the three measurement modules follow before the step is done.
      setHearingPhase("measurement");
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("assessment.toast.audiometryFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Leave the hearing test and go on to the tinnitus measurement.
   *
   * Deliberately writes nothing. Marking `audiometry` in `modules_done` would
   * record the test as taken, and saving an empty audiogram would put a row of
   * blank thresholds where measurements should be — either would make a skipped
   * test indistinguishable from a completed one in the report and on the
   * clinician's record. Advancing the phase alone leaves the omission visible as
   * exactly what it is: no audiometry on file.
   *
   * The consequences are real — no audiogram, no hearing grade, and no 3D
   * cochlea, all of which are built from these thresholds — which is why this is
   * a deliberate exit rather than a way past a step.
   */
  function skipAudiometry() {
    setHearingPhase("measurement");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /**
   * "About Your Tinnitus" (Module 2) — VAS, THI, TFI, ISI, GAD-7, PHQ-9 and
   * PSS-10 are each saved the moment their section is answered or skipped,
   * rather than held in memory for one save at the end. A patient who stops
   * partway through this module still has every section they did finish on
   * the record, and a skipped section is recorded as skipped immediately
   * rather than only if they happen to reach the last section. EQ-5D-5L is
   * not saved here at all — that section has no item content to save (see
   * `AboutYourTinnitus`) and is never represented as skipped, since nothing
   * was actually offered and declined.
   */
  const MODULE2_ITEMS_FIELD: Record<string, string> = {
    vas: "vas",
    thi: "thi_items",
    tfi: "tfi_items",
    isi: "isi_items",
    phq9: "phq9_items",
    gad7: "gad7_items",
    pss10: "pss10_items",
  };

  async function saveModule2Section(
    domainKey: string,
    items: Record<string, number> | undefined,
    sectionStatus: "completed" | "skipped"
  ) {
    const field = MODULE2_ITEMS_FIELD[domainKey];
    const body: Record<string, unknown> = { questionnaire_status: { [domainKey]: sectionStatus } };
    if (sectionStatus === "completed" && field && items) {
      // The PHQ-9's separate, non-scored functional-difficulty answer travels
      // in the same `items` dict (see `AboutYourTinnitus`'s
      // `PhqFunctionalDifficultyStep`) but is never part of `phq9_items` —
      // split it out to its own field so it can never be mistaken for a
      // 10th scored PHQ-9 item.
      const { phq9_functional_difficulty, ...scoredItems } = items as Record<string, number> & {
        phq9_functional_difficulty?: number;
      };
      body[field] = scoredItems;
      if (domainKey === "phq9" && phq9_functional_difficulty !== undefined) {
        body.phq9_functional_difficulty = phq9_functional_difficulty;
      }
    }
    try {
      await saveModule(body, sectionStatus === "completed" ? [domainKey] : []);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : t("assessment.toast.answersFailed"), "crit");
      throw error;
    }
  }

  /**
   * The three hearing-measurement modules: pitch, loudness, masking profile.
   *
   * The reference level is *not* posted — the server derives it from the
   * thresholds so a stale client cannot submit a summary that disagrees with
   * the data underneath it.
   */
  async function submitHearingMeasurement(result: HearingMeasurementResult) {
    setSaving(true);
    try {
      const saved = await saveModule(
        {
          pitch_match_hz: result.pitch_match_hz,
          loudness_match_db_hl: result.loudness_match_db_hl,
          masking_thresholds: result.masking_thresholds,
          masking_unmasked_hz: result.masking_unmasked_hz,
          pitch_match_ear: result.pitch_match_ear,
          pitch_match_confidence: result.pitch_match_confidence,
          octave_confusion: result.octave_confusion,
          pitch_match_trace: result.pitch_match_trace,
          pitch_match_sound_description: result.pitch_match_sound_description,
          pitch_match_sound_other_text: result.pitch_match_sound_other_text,
          pitch_match_initial_level_db: result.pitch_match_initial_level_db,
          pitch_match_comfort_level_db: result.pitch_match_comfort_level_db,
          pitch_match_not_sure_count: result.pitch_match_not_sure_count,
          pitch_match_octave_frequency_hz: result.pitch_match_octave_frequency_hz,
          pitch_match_octave_response: result.pitch_match_octave_response,
          pitch_match_confirmation: result.pitch_match_confirmation,
          pitch_match_repeated: result.pitch_match_repeated,
          loudness_match_starting_level_db: result.loudness_match_starting_level_db,
          loudness_match_trace: result.loudness_match_trace,
          loudness_match_confirmation: result.loudness_match_confirmation,
          loudness_match_repeated: result.loudness_match_repeated,
          masking_trace: result.masking_trace,
          masking_not_sure_count: result.masking_not_sure_count,
          masking_repeated: result.masking_repeated,
        },
        ["pitch_match", "loudness_match", "masking_profile"]
      );
      setMeasurement(result);
      setAssessment(saved);
      // Saved *before* moving on, because the reference-level module asks the
      // server to derive the patient's tone from exactly these three modules.
      // Nothing is re-measured; the record it reads is the one just written.
      setHearingPhase("reference");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setFatal(error);
      toast(error instanceof ApiError ? error.message : t("assessment.toast.matchFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  /**
   * The personalised reference level closes the hearing measurement.
   *
   * Only the device profile is written: the reference tone and level themselves
   * are derived server-side and deliberately not accepted from the client, the
   * same rule the masking reference level has always followed. What is stored is
   * the *anchoring* — which frequency and level the patient's own tone was set
   * at — so the therapy engine can reproduce the calibration on any later screen.
   */
  async function submitReferenceLevel(result: ReferenceLevelResult) {
    setSaving(true);
    try {
      await saveModule(
        {
          device_profile: {
            ...(assessment?.device_profile ?? {}),
            transducer: engine.calibration.transducer,
            output_gain_db: engine.calibration.referenceDbfs,
            reference_spl_db: engine.calibration.referenceSplDb,
            ambient_noise_db: engine.calibration.ambientNoiseDb,
            personalised_reference_hz: result.reference_tone_hz || null,
            personalised_reference_db_hl: result.reference_tone_hz ? result.reference_level_db_hl : null,
            personalised_reference_trim_db: result.reference_tone_hz ? result.trim_db : null,
            personalised_reference_basis: {
              frequency: result.frequency_basis,
              level: result.level_basis,
            },
            calibrated_at: engine.calibration.calibratedAt,
          },
          save_calibration: true,
        },
        ["reference_level"]
      );
      markDone("hearing", 3);
    } catch (error) {
      setFatal(error);
      toast(error instanceof ApiError ? error.message : t("assessment.toast.referenceFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  async function submitMatch(result: MatchResult) {
    setSaving(true);
    try {
      await saveModule(
        {
          tinnitus_bandwidth: result.tinnitus_bandwidth,
          pitch_match_hz: result.pitch_match_hz,
          pitch_match_confidence: result.pitch_match_confidence,
          pitch_match_ear: result.pitch_match_ear,
          octave_confusion: result.octave_confusion,
          pitch_match_trace: result.pitch_match_trace,
          loudness_match_db_hl: result.loudness_match_db_hl,
          loudness_match_db_sl: result.loudness_match_db_sl,
          mml_db_sl: result.mml_db_sl,
          ldl_left: result.ldl_left,
          ldl_right: result.ldl_right,
          ldl_trace: result.ldl_trace,
          ldl_repeated: result.ldl_repeated,
          ri_depth_pct: result.ri_depth_pct,
          ri_duration_s: result.ri_duration_s,
          ri_trace: result.ri_trace,
          // The patient's own verdict and the masker frequency travel with the
          // measurements they qualify. Both are optional on the serializer, so
          // a run that skipped the question or left the band on-pitch submits
          // the same payload it always did.
          ri_reported_category: result.ri_reported_category,
          mml_masker_hz: result.mml_masker_hz,
          ri_immediate_response: result.ri_immediate_response,
          ri_baseline_pct: result.ri_baseline_pct,
          ri_post_stimulation_pct: result.ri_post_stimulation_pct,
          ri_monitoring: result.ri_monitoring,
          ri_stimulus_frequency_hz: result.ri_stimulus_frequency_hz,
          ri_stimulus_level_db: result.ri_stimulus_level_db,
          ri_stimulation_duration_s: result.ri_stimulation_duration_s,
          ri_stimulation_started_at: result.ri_stimulation_started_at,
          ri_stimulation_stopped_at: result.ri_stimulation_stopped_at,
          ri_reduction_detected_at: result.ri_reduction_detected_at,
          ri_return_to_baseline_at: result.ri_return_to_baseline_at,
          ri_repeated: result.ri_repeated,
        },
        ["pitch_match", "loudness_match", "mml", "residual_inhibition"]
      );
      setDoingOptional(false);
      await finalise();
    } catch (error) {
      setFatal(error);
      toast(error instanceof ApiError ? error.message : t("assessment.toast.matchFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  async function finalise() {
    if (!assessment) return;
    setSaving(true);
    try {
      const finalised = await api.assessments.finalise(assessment.id);
      setAssessment(finalised.assessment);
      setAnalysis(finalised.analysis);
      setOfferOptional(false);
      if (finalised.analysis.red_flags.requires_human_review) {
        toast(t("assessment.toast.redFlags"), "crit");
      } else {
        toast(t("assessment.toast.complete"), "ok");
      }
      markDone("optional", 4);
    } catch (error) {
      setFatal(error);
      toast(error instanceof ApiError ? error.message : t("assessment.toast.finaliseFailed"), "crit");
    } finally {
      setSaving(false);
    }
  }

  if (profile.loading) return <Loading label={t("assessment.loadingRecord")} rows={4} />;
  if (profile.error) return <ErrorState error={profile.error} retry={profile.reload} />;

  const totalMinutes = STEPS.reduce((sum, s) => sum + s.minutes, 0);

  return (
    <div className="stack stack-6" data-tour="assessment">
      <header className="stack stack-2">
        <div className="row row--between">
          <div className="stack stack-1">
            <span className="label label--signal">{t("assessment.label")}</span>
            <h1>{t("assessment.title")}</h1>
          </div>
          <div className="row row--tight">
            {assessment && <Chip tone="ghost">{t("assessment.recordNumber", { id: assessment.id })}</Chip>}
            {saving && (
              <Chip tone="signal" live>
                {t("common.saving")}
              </Chip>
            )}
          </div>
        </div>
        <p className="lead">{t("assessment.lead", { minutes: totalMinutes })}</p>
      </header>

      <StepRail
        steps={STEPS.map((s) => ({ key: s.key, label: t(`assessment.steps.${s.key}`) }))}
        current={step}
        completed={completed}
        onJump={(i) => (i < step || completed.has(STEPS[i].key) ? setStep(i) : undefined)}
      />

      {fatal ? <ErrorState error={fatal} retry={() => setFatal(null)} /> : null}

      {/* ==================================================== 0 · intake === */}
      {step === 0 && (
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "300px" }}>
          <Panel title={t("assessment.intake.title")} bracketed>
            <div className="stack stack-5">
              {/* -- About Your Tinnitus, Hearing & Health ---------------------- */}
              {/* The full 22-section questionnaire, including the richer
                  replacements for "what does it sound like" (Section 4) and
                  "where do you hear it" (Section 3) that used to be the two
                  bespoke widgets above — see `aboutYouQuestions.ts` for why
                  those two specifically were folded in here rather than left
                  standing beside a fuller version of the same question. */}
              <div className="stack stack-2">
                <h2 style={{ fontSize: "var(--fs-h3)", margin: 0 }}>
                  {t("assessment.aboutYou.text.pageTitle", "About your tinnitus, hearing & health")}
                </h2>
                <p className="meta">
                  {t(
                    "assessment.aboutYou.text.pageIntro1",
                    "This section helps us understand your tinnitus, your hearing and ear health, and any medical or lifestyle factors that may be relevant to your experience."
                  )}
                </p>
                <p className="meta">
                  {t(
                    "assessment.aboutYou.text.pageIntro2",
                    "There are no right or wrong answers. Choose the answer that best describes your experience. If you are unsure, select \u201cI\u2019m not sure.\u201d"
                  )}
                </p>
              </div>

              <AboutYouExtended
                sections={[...ABOUT_YOU_SECTIONS, SNAPSHOT_SECTION]}
                answers={aboutYou}
                onAnswer={setAboutYouField}
              />

              <Panel tone="ok" tight>
                <div className="stack stack-1">
                  <strong>{t("assessment.aboutYou.text.completionTitle", "Thank you for telling us about your tinnitus.")}</strong>
                  <p className="meta" style={{ margin: 0 }}>
                    {t(
                      "assessment.aboutYou.text.completionBody",
                      "Your answers help us build a clearer picture of your tinnitus and identify factors that may be relevant to your assessment and rehabilitation."
                    )}
                  </p>
                </div>
              </Panel>

              {(laterality === "left" || laterality === "right") && (
                <Panel tone="info" tight>
                  <p className="meta">{t("assessment.intake.unilateralNote")}</p>
                </Panel>
              )}

              <Disclosure
                summary={t("assessment.intake.historyDisclosure")}
                count={comorbidities.length}
              >
                <div className="stack stack-3">
                  <div className="row row--tight">
                    {COMORBIDITY_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`chip ${comorbidities.includes(option) ? "chip--signal" : "chip--ghost"}`}
                        style={{ cursor: "pointer" }}
                        onClick={() =>
                          setComorbidities((prev) =>
                            prev.includes(option) ? prev.filter((c) => c !== option) : [...prev, option]
                          )
                        }
                      >
                        {t(`assessment.comorbidity.${option}`, { defaultValue: option })}
                      </button>
                    ))}
                  </div>
                  <Field
                    label={t("assessment.intake.medication")}
                    hint={t("assessment.intake.medicationHint")}
                  >
                    <textarea
                      className="textarea"
                      value={medications}
                      onChange={(e) => setMedications(e.target.value)}
                      placeholder={t("assessment.intake.medicationPlaceholder")}
                    />
                  </Field>
                </div>
              </Disclosure>

              <label className="option" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  style={{ accentColor: "var(--signal)", width: 16, height: 16 }}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block" }}>{t("assessment.intake.consent")}</span>
                  <span className="meta" style={{ display: "block" }}>
                    {t("assessment.intake.consentHelp")}
                  </span>
                </span>
              </label>

              <div className="row row--end">
                <button type="button" className="btn btn--primary btn--lg" onClick={submitIntake} disabled={saving}>
                  {t("assessment.intake.continue")}
                </button>
              </div>
            </div>
          </Panel>

          <Panel title={t("assessment.whatHappens.title")} tight headPlain>
            <ol className="stack stack-3" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-tiny)" }}>
              {STEPS.filter((s) => s.minutes > 0).map((s) => (
                <li key={s.key}>
                  <strong>{t(`assessment.steps.${s.key}`)}</strong>
                  <span className="meta" style={{ display: "block" }}>
                    {t("assessment.whatHappens.about", { minutes: s.minutes })}
                  </span>
                </li>
              ))}
            </ol>
            <hr className="rule" />
            <p className="meta">{t("assessment.whatHappens.note")}</p>
          </Panel>
        </div>
      )}

      {/* ============================================= 1 · questionnaire === */}
      {/* "About Your Tinnitus" — the patient's own account of the percept and
          its impact, before it is measured. Eight result categories in a fixed
          order (Tinnitus Severity, Tinnitus Handicap, Tinnitus Functional
          Impact, Sleep & Insomnia, Anxiety, Mood/Depression, Perceived Stress,
          Health-Related Quality of Life); this is also where the sleep,
          anxiety, mood and stress content that used to be a separate
          "Sleep, mood and stress" step now lives. */}
      {step === 1 && (
        <AboutYourTinnitus
          instruments={instruments.data?.instruments ?? null}
          initial={{
            vas: {
              ...(assessment?.vas_loudness != null ? { vas_loudness: assessment.vas_loudness } : {}),
              ...(assessment?.vas_annoyance != null ? { vas_annoyance: assessment.vas_annoyance } : {}),
              ...(assessment?.vas_awareness != null ? { vas_awareness: assessment.vas_awareness } : {}),
              ...(assessment?.vas_sleep_interference != null
                ? { vas_sleep_interference: assessment.vas_sleep_interference }
                : {}),
            },
            thi_items: assessment?.thi_items ?? undefined,
            tfi_items: assessment?.tfi_items ?? undefined,
            isi_items: assessment?.isi_items ?? undefined,
            phq9_items: assessment?.phq9_items ?? undefined,
            gad7_items: assessment?.gad7_items ?? undefined,
            pss10_items: assessment?.pss10_items ?? undefined,
            questionnaire_status: assessment?.questionnaire_status,
          }}
          onSectionSave={saveModule2Section}
          onAllDone={() => markDone("questionnaire", 2)}
        />
      )}

      {/* =================================================== 2 · hearing === */}
      {step === 2 && (
        <div className="stack stack-5">
          {/* Four phases, and the reference level is the last of them — the
              chips are the only place a patient sees that ordering before they
              reach it, so they name it rather than leaving it a surprise. */}
          <div className="row row--tight">
            {(
              [
                ["calibration", "assessment.hearing.stepSetup"],
                ["audiometry", "assessment.hearing.stepTest"],
                ["measurement", "assessment.hearing.stepMeasure"],
                ["reference", "assessment.hearing.stepReference"],
              ] as const
            ).map(([phase, key]) => {
              const position = HEARING_PHASES.indexOf(phase);
              const current = HEARING_PHASES.indexOf(hearingPhase);
              return (
                <Chip
                  key={phase}
                  tone={position === current ? "signal" : position < current ? "ok" : "ghost"}
                  dot
                >
                  {t(key)}
                </Chip>
              );
            })}
          </div>

          {hearingPhase === "calibration" ? (
            <>
              {profile.data?.has_saved_calibration && (
                <Panel tone="ok" title={t("assessment.hearing.savedTitle")} bracketed>
                  <div className="row row--between row--top">
                    <p className="meta" style={{ maxWidth: "44em" }}>
                      {t("assessment.hearing.savedBody", {
                        model: profile.data.saved_device_profile?.model
                          ? ` (${profile.data.saved_device_profile.model})`
                          : "",
                      })}
                    </p>
                    <div className="row row--tight">
                      <button type="button" className="btn btn--primary" onClick={reuseCalibration} disabled={saving}>
                        {t("assessment.hearing.useSaved")}
                      </button>
                    </div>
                  </div>
                </Panel>
              )}
              <Calibration
                onComplete={submitCalibration}
                initial={assessment?.device_profile as Partial<CalibrationResult> | undefined}
              />
            </>
          ) : hearingPhase === "audiometry" ? (
            <Audiometry
              onComplete={submitAudiometry}
              onSkip={skipAudiometry}
              initialAudiogram={assessment?.audiogram}
            />
          ) : hearingPhase === "measurement" ? (
            /* Pitch, loudness and the masking profile — the three modules the
               therapy prescription is actually derived from. */
            <HearingMeasurement
              onComplete={submitHearingMeasurement}
              initial={measurement ?? undefined}
              laterality={laterality}
            />
          ) : (
            /* Last, because it is derived from the three above rather than a
               precondition of them. */
            <PersonalizedReference
              assessmentId={assessment?.id ?? null}
              onComplete={submitReferenceLevel}
              saving={saving}
            />
          )}
        </div>
      )}

      {/* ================================================== 3 · optional === */}
      {/* The old "Sleep, mood and stress" module used to run here before this
          offer; it no longer exists as a separate step (its questionnaires
          moved into Module 2 at step 1), so this offer is now this step's
          entire content. */}
      {/* -- optional psychoacoustics offer ---------------------------------- */}
      {step === 3 && offerOptional && !doingOptional && (
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "300px" }}>
          <Panel title={t("assessment.optional.title")} bracketed tone="signal">
            <div className="stack stack-5">
              <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
                {t("assessment.optional.lead")}
              </p>

              <div className="grid grid-2">
                <Panel tone="sunken" tight>
                  <span className="label" style={{ color: "var(--ok-ink)" }}>
                    {t("assessment.optional.givesTitle")}
                  </span>
                  <ul className="stack stack-1" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)", marginTop: "var(--s2)" }}>
                    <li>
                      <Trans i18nKey="assessment.optional.gives1" components={[<em key="0" />]} />
                    </li>
                    <li>{t("assessment.optional.gives2")}</li>
                    <li>{t("assessment.optional.gives3")}</li>
                  </ul>
                </Panel>
                <Panel tone="sunken" tight>
                  <span className="label">{t("assessment.optional.skipTitle")}</span>
                  <ul className="stack stack-1" style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)", marginTop: "var(--s2)" }}>
                    <li>{t("assessment.optional.skip1")}</li>
                    <li>{t("assessment.optional.skip2")}</li>
                    <li>{t("assessment.optional.skip3")}</li>
                  </ul>
                </Panel>
              </div>

              <Panel tone="info" tight>
                <p className="meta">{t("assessment.optional.note")}</p>
              </Panel>

              <div className="row">
                <button
                  type="button"
                  className="btn btn--primary btn--lg"
                  onClick={() => {
                    setDoingOptional(true);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  {t("assessment.optional.accept")}
                </button>
                <button type="button" className="btn btn--lg" onClick={finalise} disabled={saving}>
                  {t("assessment.optional.decline")}
                </button>
              </div>
            </div>
          </Panel>

          <Panel title={t("assessment.optional.whyTitle")} tight headPlain>
            <p className="meta">{t("assessment.optional.why1")}</p>
            <hr className="rule" />
            <p className="meta">{t("assessment.optional.why2")}</p>
          </Panel>
        </div>
      )}

      {step === 3 && doingOptional && (
        <TinnitusMatch
          audiogram={assessment?.audiogram ?? {}}
          laterality={laterality}
          onComplete={submitMatch}
          onSkip={() => {
            setDoingOptional(false);
            void finalise();
          }}
        />
      )}

      {/* ==================================================== 3 · results === */}
      {/* ================================================ 4 · interpretation */}
      {step === 4 && (
        <ReviewStep
          assessment={assessment}
          analysis={analysis}
          measurement={measurement}
          onGoToTherapy={() => navigate("/rehabilitation")}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/**
 * A client-side stand-in for the server's masking analysis.
 *
 * Deliberately minimal: it computes the same minimum the server does and
 * nothing else, because anything more would be a second implementation of a
 * clinical derivation. Used only in the seconds between the masking module
 * finishing and the finalised analysis coming back.
 */
function localMaskingSummary(measurement: HearingMeasurementResult) {
  const entries = Object.entries(measurement.masking_thresholds)
    .map(([hz, db]) => ({ hz: Number(hz), db }))
    .sort((a, b) => a.db - b.db || a.hz - b.hz);
  const best = entries[0] ?? null;
  return {
    curve: MASKING_FREQUENCIES.map((hz) => {
      const db = measurement.masking_thresholds[String(hz)];
      const cannot = measurement.masking_unmasked_hz.includes(hz);
      return {
        hz,
        threshold_db: db ?? null,
        masked: cannot ? false : db !== undefined ? true : null,
        tested: db !== undefined || cannot,
      };
    }),
    reference_level_db: best?.db ?? null,
    reference_level_hz: best?.hz ?? null,
    maskable: Boolean(best),
    safe: best ? best.db <= 85 : null,
    // The shape classification is the server's job — this fallback says so
    // rather than guessing at a band it has no cut-points for.
    selectivity: "not_measured",
    spread_db: null,
    interpretation: best ? (best.db <= 25 ? "easily_masked" : best.db <= 45 ? "moderately_masked" : "hard_to_mask") : "unmaskable",
    tested_count: entries.length,
    unmaskable_count: measurement.masking_unmasked_hz.length,
  };
}

function ReviewStep({
  assessment,
  analysis,
  measurement,
  onGoToTherapy,
}: {
  assessment: AssessmentRow | null;
  analysis: Analysis | null;
  measurement: HearingMeasurementResult | null;
  onGoToTherapy(): void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  /**
   * The detailed report for *this* assessment, on this page.
   *
   * Finishing an assessment used to end at four tiles and a link to Results.
   * The detail is fetched here instead, from the same `/api/reports/clinical`
   * endpoint the Results screen uses, pinned to this assessment's id rather
   * than to "the patient's latest" — during the seconds after finalising, the
   * two are the same row, but pinning it means the section can never render a
   * different assessment's numbers under this one's heading.
   *
   * Declared above the loading guard below because it is a hook: reading
   * `assessment.id` first and calling `useAsync` after the early return would
   * change the hook count between the loading render and the loaded one.
   */
  const [showDetail, setShowDetail] = useState(false);
  const assessmentId = assessment?.id ?? null;
  const isComplete = assessment?.status === "complete";
  const report = useAsync(
    () => (assessmentId && isComplete ? api.reports.clinical(assessmentId) : Promise.resolve(null)),
    [assessmentId, isComplete]
  );

  if (!assessment || !analysis) return <Loading label={t("assessment.workingOutResults")} />;

  const tri = analysis.derived?.tri ?? {};
  const outputs = analysis.prediction?.outputs ?? {};
  const flags = analysis.red_flags.flags;
  const escalations = (analysis as any).escalations ?? [];
  /**
   * The masking curve and reference level.
   *
   * The server's derivation is authoritative — it computes the minimum from the
   * stored thresholds, so the report, the therapy engine and this screen cannot
   * disagree. `measurement` is only the local fallback for the moment between
   * the modules finishing and the finalise response arriving, and it is marked
   * as such so nothing downstream mistakes it for the stored value.
   */
  const masking =
    (analysis as any).masking ??
    (measurement && Object.keys(measurement.masking_thresholds).length > 0
      ? localMaskingSummary(measurement)
      : null);

  return (
    <div className="stack stack-6">
      {flags.length > 0 && (
        <Panel
          tone={analysis.red_flags.highest_urgency === "routine" ? "info" : "crit"}
          title={t("assessment.review.readFirst")}
          aside={<UrgencyChip urgency={analysis.red_flags.highest_urgency} />}
          bracketed
        >
          <div className="stack stack-3">
            {flags.map((flag) => (
              <div key={flag.code} className="stack stack-1">
                <div className="row row--tight">
                  <UrgencyChip urgency={flag.urgency} />
                  <strong style={{ fontSize: "var(--fs-small)" }}>{flag.title}</strong>
                </div>
                <p className="meta">{flag.evidence}</p>
                <p style={{ fontSize: "var(--fs-small)" }}>{flag.action}</p>
              </div>
            ))}
            <p className="meta">{t("assessment.review.clinicianAlerted")}</p>
          </div>
        </Panel>
      )}

      <div className="grid grid-4">
        <Panel tight>
          <Readout
            label={t("assessment.review.handicap")}
            value={assessment.thi_score}
            unit="/ 100"
            size="md"
            tone={(assessment.thi_score ?? 0) >= 58 ? "crit" : (assessment.thi_score ?? 0) >= 38 ? "warn" : "ok"}
            note={assessment.thi_grade}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("assessment.review.yourPitch")}
            value={assessment.pitch_match_hz ? fmt.hz(assessment.pitch_match_hz) : t("common.notMeasured")}
            unit={assessment.pitch_match_hz ? "Hz" : ""}
            size="md"
            tone="data"
            note={t(assessment.pitch_match_hz ? "assessment.review.matched" : "assessment.review.optionalSkipped")}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("assessment.review.hearing")}
            value={assessment.hearing_grade ?? "—"}
            size="sm"
            note={t("assessment.review.betterEar", { value: fmt.db(analysis.audiogram?.better_ear_pta) })}
          />
        </Panel>
        <Panel tight>
          <Readout
            label={t("assessment.review.sleep")}
            value={assessment.psqi_score ?? assessment.sleep_screen_score ?? "—"}
            unit={assessment.psqi_score !== null ? "/ 21" : "/ 3"}
            size="sm"
            note={assessment.psqi_grade || t("assessment.review.screeningOnly")}
          />
        </Panel>
      </div>

      {/* The headline result of the hearing measurement. Placed before the
          escalation notes and the charts because it is the number the patient
          was asked to sit through eight frequencies to produce. */}
      {masking && masking.tested_count > 0 && (
        <ReferenceLevelPanel summary={masking} />
      )}

      {escalations.length > 0 && (
        <Panel tone="info" title={t("assessment.review.escalationsTitle")} tight>
          <div className="stack stack-2">
            {escalations.map((e: any) => (
              <div key={e.instrument} className="row row--tight">
                <Chip tone="info">{String(e.instrument).toUpperCase()}</Chip>
                <span className="meta">{e.because}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "340px" }}>
        <div className="stack stack-5">
          <Panel title={t("assessment.review.yourHearing")} headPlain>
            <Audiogram audiogram={assessment.audiogram} pitchHz={assessment.pitch_match_hz} height={320} />
            {(analysis as any).audiometry_plan && (
              <p className="meta" style={{ marginTop: "var(--s3)" }}>
                {(analysis as any).audiometry_plan.basis}
              </p>
            )}
          </Panel>

          <Panel title={t("assessment.review.whatWeFound")} headPlain>
            <div className="stack stack-2">
              <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
                {analysis.summary.headline}
              </p>
              <ul style={{ paddingLeft: "var(--s5)", fontSize: "var(--fs-small)" }} className="stack stack-1">
                {analysis.summary.findings.map((finding, i) => (
                  <li key={i}>{finding}</li>
                ))}
              </ul>
            </div>
          </Panel>

          {analysis.prediction && (
            <Panel title={t("assessment.review.whatToExpect")} headPlain>
              <div className="stack stack-4">
                <div className="grid grid-3">
                  <Readout
                    label={t("assessment.review.worseningRisk")}
                    value={fmt.pct(outputs.worsening_risk, 0)}
                    size="sm"
                    tone={(outputs.worsening_risk ?? 0) >= 0.5 ? "crit" : (outputs.worsening_risk ?? 0) >= 0.25 ? "warn" : "ok"}
                    note={t("assessment.review.nextSixMonths")}
                  />
                  <Readout
                    label={t("assessment.review.therapyHelps")}
                    value={fmt.pct(outputs.therapy_response, 0)}
                    size="sm"
                    tone={(outputs.therapy_response ?? 0) >= 0.5 ? "ok" : "warn"}
                    note={t("assessment.review.likelihood")}
                  />
                  <Readout
                    label={t("assessment.review.projectedHandicap")}
                    value={fmt.int(outputs.thi_6mo)}
                    unit="/ 100"
                    size="sm"
                    note={t("assessment.review.inSixMonths")}
                  />
                </div>
                {analysis.prediction.narratives?.worsening_risk && (
                  <p className="meta">{analysis.prediction.narratives.worsening_risk}</p>
                )}
              </div>
            </Panel>
          )}
        </div>

        <div className="stack stack-5">
          <Panel title={t("assessment.review.reactivity")} headPlain tight>
            <div className="center stack stack-3">
              <RadialGauge
                value={tri.score ?? null}
                label="TRI"
                sublabel={tri.band}
                tone={(tri.score ?? 0) >= 60 ? "crit" : (tri.score ?? 0) >= 40 ? "warn" : "data"}
              />
              <p className="meta">{tri.recommended_intensity}</p>
            </div>
          </Panel>

          {assessment.pitch_match_hz && (
            <Panel title={t("assessment.review.signature")} headPlain tight>
              <div className="center">
                <Fingerprint
                  signature={analysis.derived?.spectral_signature}
                  pitchHz={assessment.pitch_match_hz}
                  size={200}
                />
              </div>
            </Panel>
          )}

          {analysis.therapy && (
            <Panel title={t("assessment.review.planReady")} tone="signal" tight>
              <div className="stack stack-3">
                <Readout
                  label={t("assessment.review.dailyTarget")}
                  value={analysis.therapy.daily_minutes_target}
                  unit="min"
                  size="sm"
                  tone="signal"
                  note={t("assessment.review.soundBlocks", { count: analysis.therapy.program.length })}
                />
                <button type="button" className="btn btn--primary btn--block" onClick={onGoToTherapy}>
                  {t("assessment.review.startTherapy")}
                </button>
                <button type="button" className="btn btn--ghost btn--block btn--sm" onClick={() => navigate("/results")}>
                  {t("assessment.review.seeFullReport")}
                </button>
              </div>
            </Panel>
          )}
        </div>
      </div>

      {/* ============================================ detailed results === */}
      {/* Below the basic result, not instead of it. Everything above this rule
          is unchanged: the four tiles, the reference level, the audiogram, what
          we found, what to expect, the reactivity gauge and the plan card are
          the answer for somebody who wants one screen and then to get on with
          their day. This is for the person who wants the rest of it, and it is
          the same clinical summary the Results screen renders, from the same
          endpoint, for this assessment — not a second version of it.

          Behind a toggle for the same reason Results puts it behind one: a
          patient who has just finished ten minutes of testing should not have
          to scroll past a full clinical report to reach "start therapy". */}
      {isComplete && (
        <>
          <hr className="rule" />

          <button
            type="button"
            className="reveal no-print"
            aria-expanded={showDetail}
            aria-controls="assessment-detailed-results"
            onClick={() => setShowDetail((v) => !v)}
          >
            <IconChevronRight size={18} className="reveal__chev" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong style={{ display: "block", fontSize: "var(--fs-body)" }}>
                {t(showDetail ? "assessment.review.hideDetailed" : "assessment.review.showDetailed")}
              </strong>
              <span className="meta">{t("assessment.review.detailedSub")}</span>
            </span>
            <IconFile size={18} style={{ flex: "none", color: "var(--ink-3)" }} />
          </button>

          {showDetail && (
            <div id="assessment-detailed-results" className="stack stack-5 fade-in">
              {report.loading ? (
                <Loading label={t("assessment.review.buildingDetailed")} rows={4} />
              ) : report.error ? (
                <ErrorState error={report.error} retry={report.reload} />
              ) : report.data ? (
                <>
                  <ClinicalSummary report={report.data} detail={analysis} />
                  <Panel tone="sunken" tight>
                    <div className="row row--between row--nowrap">
                      <p className="meta" style={{ margin: 0 }}>
                        {t("assessment.review.fullReportNote")}
                      </p>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => navigate("/results")}
                      >
                        {t("assessment.review.seeFullReport")}
                      </button>
                    </div>
                  </Panel>
                </>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

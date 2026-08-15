/**
 * Device setup.
 *
 * This is the step that decides whether every number downstream means anything.
 * It does three things:
 *
 *  1. Records the transducer class, which selects the RETSPL table.
 *  2. Gets the patient's device volume to a comfortable working level and
 *     confirms the channels are not swapped.
 *  3. Optionally measures ambient noise, so an invalid test environment is caught
 *     here rather than silently inflating low-frequency thresholds.
 *
 * **It no longer levels a 1 kHz tone.** A fixed 1 kHz reference is a property of
 * the equipment, not of the patient — and for the majority of tinnitus patients,
 * whose percept and whose hearing loss both sit in the 3–8 kHz region, it anchors
 * the output curve in the one part of the spectrum the assessment has already
 * established is least representative of them. What this step establishes is a
 * *working* anchor, good enough to run audiometry and the tinnitus measurements
 * against; the precise anchor is set afterwards, at the patient's own tinnitus
 * frequency, by `PersonalizedReference`. See that file for the second half.
 *
 * It also tells the patient, in plain terms, that this is a screening estimate.
 * A tool that implies clinical audiometry when it cannot deliver it is worse than
 * one that is honest about what it is.
 */

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { engine, REFERENCE_SPL_DB, type Transducer } from "../../audio/engine";
import { Chip, Panel, Readout } from "../../components/ui";
import { IconPlay, IconStop } from "../../components/icons";

/**
 * Transducer classes, in the order they are offered.
 *
 * The value is the ISO 389 table key and stays in English — it is written to
 * the device profile and selects the RETSPL correction server-side. Only the
 * label and the help text are translated.
 */
const TRANSDUCERS: Transducer[] = ["circumaural", "supra_aural", "insert", "unknown"];

/**
 * The digital level the setup sound plays at.
 *
 * Fixed rather than patient-adjustable: the patient sets their *device* volume
 * to make this comfortable, which is the same one-point anchoring the old dBFS
 * fader performed but expressed in the only control the patient actually
 * understands. Nothing downstream reads a dBFS number off a screen.
 */
const WORKING_ANCHOR_DBFS = -22;

/**
 * The setup sound: speech-band noise, not a tone.
 *
 * Two reasons. A broadband sound is far easier to localise than a pure tone, so
 * the left/right check is more reliable with it; and "as loud as someone talking
 * to you" is a judgement people can actually make about speech-shaped sound and
 * cannot reliably make about a 1 kHz sine.
 */
const SETUP_BAND = { centreHz: 1000, bandwidthOctaves: 2.5 };

export interface CalibrationResult {
  transducer: Transducer;
  reference_spl_db: number;
  output_gain_db: number;
  ambient_noise_db: number | null;
  calibration_method: string;
  calibrated_at: string;
  browser: string;
  sample_rate: number;
}

export default function Calibration({
  onComplete,
  initial,
}: {
  onComplete(result: CalibrationResult): void;
  initial?: Partial<CalibrationResult>;
}) {
  const { t } = useTranslation();
  const [transducer, setTransducer] = useState<Transducer>((initial?.transducer as Transducer) ?? "circumaural");
  const [playing, setPlaying] = useState(false);
  const [channelCheck, setChannelCheck] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const [ambient, setAmbient] = useState<number | null>(initial?.ambient_noise_db ?? null);
  const [measuring, setMeasuring] = useState(false);
  const [levelled, setLevelled] = useState(false);
  const handleRef = useRef<{ stop(f?: number): void } | null>(null);

  /**
   * Keep the engine's working anchor in step with the declared transducer, so
   * the dB HL readouts on this screen and in audiometry reflect the RETSPL table
   * that is actually about to be used. `calibratedAt` stays null until the step
   * is finished, which is what keeps `calibrationQuality()` honest in between.
   */
  useEffect(() => {
    engine.setCalibration({
      transducer,
      referenceDbfs: WORKING_ANCHOR_DBFS,
      referenceSplDb: REFERENCE_SPL_DB,
    });
  }, [transducer]);

  useEffect(() => () => handleRef.current?.stop(0.1), []);

  async function toggleSetupSound() {
    if (playing) {
      handleRef.current?.stop(0.2);
      handleRef.current = null;
      setPlaying(false);
      return;
    }
    await engine.resume();
    handleRef.current = engine.playBandNoise({
      ...SETUP_BAND,
      dbfs: WORKING_ANCHOR_DBFS,
      ear: "both",
      fadeInS: 0.25,
    });
    setPlaying(true);
  }

  async function playEar(ear: "left" | "right") {
    await engine.resume();
    const handle = engine.playBandNoise({
      ...SETUP_BAND,
      dbfs: WORKING_ANCHOR_DBFS,
      ear,
      fadeInS: 0.1,
    });
    window.setTimeout(() => handle.stop(0.15), 1100);
  }

  async function measureAmbient() {
    setMeasuring(true);
    const result = await engine.measureAmbientNoise(3);
    setAmbient(result);
    setMeasuring(false);
  }

  function finish() {
    handleRef.current?.stop(0.15);
    handleRef.current = null;
    setPlaying(false);

    engine.setCalibration({
      transducer,
      referenceDbfs: WORKING_ANCHOR_DBFS,
      referenceSplDb: REFERENCE_SPL_DB,
      ambientNoiseDb: ambient,
      calibratedAt: new Date().toISOString(),
    });

    onComplete({
      transducer,
      reference_spl_db: REFERENCE_SPL_DB,
      output_gain_db: WORKING_ANCHOR_DBFS,
      ambient_noise_db: ambient,
      calibration_method:
        "Speech-band setup sound levelled to conversational loudness by device volume, RETSPL-corrected per transducer class; refined afterwards at the patient's own tinnitus frequency",
      calibrated_at: new Date().toISOString(),
      browser: navigator.userAgent.slice(0, 120),
      sample_rate: engine.sampleRate,
    });
  }

  const channelsOk = channelCheck.left && channelCheck.right;
  const ready = levelled && channelsOk;
  const quality = engine.calibrationQuality();
  /** What the working anchor comes out as in dB HL for the declared transducer. */
  const workingHl = Math.round(engine.dbfsToHl(WORKING_ANCHOR_DBFS, SETUP_BAND.centreHz));

  return (
    <div className="stack stack-5">
      <Panel tone="sunken" tight>
        <div className="stack stack-2">
          <span className="label">{t("calibration.beforeStart")}</span>
          <p className="meta" style={{ maxWidth: "56em" }}>{t("calibration.intro")}</p>
          <p className="meta" style={{ maxWidth: "56em" }}>
            <Trans i18nKey="calibration.honesty" components={[<strong key="0" />, <em key="1" />]} />
          </p>
        </div>
      </Panel>

      {/* -- 1. transducer ---------------------------------------------------- */}
      <Panel title={t("calibration.step1")} bracketed>
        <div className="grid grid-2" style={{ gap: "var(--s2)" }}>
          {TRANSDUCERS.map((option) => (
            <button
              key={option}
              type="button"
              className="option"
              aria-pressed={transducer === option}
              onClick={() => setTransducer(option)}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600 }}>
                  {t(`calibration.transducer.${option}`)}
                </span>
                <span className="meta" style={{ display: "block" }}>
                  {t(`calibration.transducer.${option}Help`)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <p className="meta" style={{ marginTop: "var(--s3)" }}>{t("calibration.transducerNote")}</p>
      </Panel>

      {/* -- 2. working level ------------------------------------------------- */}
      <Panel title={t("calibration.step2")} bracketed>
        <div className="grid grid-sidebar" style={{ ["--aside" as string]: "220px" }}>
          <div className="stack stack-4">
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "44em" }}>
              <Trans
                i18nKey="calibration.levelLead"
                components={[<strong key="0" />, <strong key="1" />]}
              />
            </p>

            <div className="row">
              <button type="button" className={`btn ${playing ? "" : "btn--primary"}`} onClick={toggleSetupSound}>
                {playing ? (
                  <>
                    <IconStop size={15} />
                    {t("calibration.stopTone")}
                  </>
                ) : (
                  <>
                    <IconPlay size={15} />
                    {t("calibration.playTone")}
                  </>
                )}
              </button>
              {playing && (
                <Chip tone="signal" live>
                  {t("calibration.playing")}
                </Chip>
            )}
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={levelled}
                onChange={(e) => setLevelled(e.target.checked)}
              />
              <span>{t("calibration.levelledConfirm")}</span>
            </label>

            <Panel tone="warn" tight>
              <p className="meta">{t("calibration.doNotChange")}</p>
            </Panel>

            <Panel tone="info" tight>
              <p className="meta">{t("calibration.personalisedLater")}</p>
            </Panel>
          </div>

          <div className="stack stack-3">
            {/* Every level on this screen is in dB HL — the unit the rest of the
                assessment, the audiogram and the therapy prescription are in.
                A digital dBFS number is an implementation detail and was never
                something a patient or a clinician could act on. */}
            <Readout
              label={t("calibration.workingLevel")}
              value={workingHl}
              unit="dB HL"
              size="md"
              tone="data"
              note={t("calibration.workingLevelNote")}
            />
            <Readout
              label={t("calibration.anchor")}
              value={REFERENCE_SPL_DB}
              unit="dB SPL"
              size="sm"
              note={t("calibration.anchorNote")}
            />
            <Readout
              label={t("calibration.maxReachable")}
              value={levelled ? engine.maxReachableHl(SETUP_BAND.centreHz) : "—"}
              unit="dB HL"
              size="sm"
              note={t("calibration.maxReachableNote")}
            />
            <Readout
              label={t("calibration.sampleRate")}
              value={(engine.sampleRate / 1000).toFixed(1)}
              unit="kHz"
              size="sm"
            />
          </div>
        </div>
      </Panel>

      {/* -- 3. channels ------------------------------------------------------ */}
      <Panel title={t("calibration.step3")} bracketed>
        <p className="meta" style={{ marginBottom: "var(--s3)", maxWidth: "44em" }}>
          {t("calibration.channelLead")}
        </p>
        <div className="grid grid-2">
          {(["left", "right"] as const).map((ear) => (
            <div key={ear} className="stack stack-2">
              <button type="button" className="btn btn--block" onClick={() => playEar(ear)}>
                <IconPlay size={15} />
                {t(ear === "left" ? "calibration.playLeft" : "calibration.playRight")}
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={channelCheck[ear]}
                  onChange={(e) => setChannelCheck((prev) => ({ ...prev, [ear]: e.target.checked }))}
                />
                <span>
                  {/* Two keys rather than one with the ear interpolated: the
                      emphasised word sits in a different position in Tamil and
                      Hindi word order, and a single key with a {{ear}} slot
                      would freeze English syntax into the sentence. */}
                  <Trans
                    i18nKey={ear === "left" ? "calibration.heardLeft" : "calibration.heardRight"}
                    components={[<strong key="0" />]}
                  />
                </span>
              </label>
            </div>
          ))}
        </div>
      </Panel>

      {/* -- 4. ambient ------------------------------------------------------- */}
      <Panel title={t("calibration.step4")} bracketed>
        <div className="row row--between row--top">
          <div className="stack stack-2" style={{ flex: 1, minWidth: 260 }}>
            <p className="meta" style={{ maxWidth: "44em" }}>{t("calibration.ambientLead")}</p>
            <div className="row">
              <button type="button" className="btn btn--sm" onClick={measureAmbient} disabled={measuring}>
                {t(measuring ? "calibration.measuring" : "calibration.measure")}
              </button>
              {ambient !== null && (
                <Chip tone={ambient > 40 ? "warn" : "ok"} dot>
                  {t(ambient > 40 ? "calibration.tooNoisy" : "calibration.acceptable")}
                </Chip>
              )}
            </div>
            {ambient === null && !measuring && (
              <p className="meta dim">{t("calibration.skipAmbient")}</p>
            )}
          </div>
          <Readout
            label={t("calibration.ambient")}
            value={ambient === null ? "—" : ambient.toFixed(0)}
            unit="dB(A)"
            size="md"
            tone={ambient !== null && ambient > 40 ? "warn" : "data"}
            note={t("calibration.ambientNote")}
          />
        </div>
      </Panel>

      <div className="row row--between">
        <div className="stack stack-1">
          <span className="label">{t("calibration.status")}</span>
          <Chip tone={quality.level === "good" ? "ok" : quality.level === "estimated" ? "warn" : "crit"} dot>
            {ready
              ? t(`calibration.quality.${quality.level}`, { defaultValue: quality.level })
              : t("calibration.incomplete")}
          </Chip>
        </div>
        <button type="button" className="btn btn--primary btn--lg" onClick={finish} disabled={!ready}>
          {t(ready ? "calibration.finish" : "calibration.finishBlocked")}
        </button>
      </div>
    </div>
  );
}

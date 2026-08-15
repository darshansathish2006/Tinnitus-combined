/**
 * The reference level, and what it means.
 *
 * Shown after the masking profile is complete, on the assessment result, and on
 * the clinical report. One component in all three places, because it is the
 * number the therapy prescription is built from and three renderings of it
 * would be three chances to describe it differently.
 *
 * **Definition, stated once here so it is not re-derived elsewhere.** The
 * reference level is the *minimum of the masking curve* — the quietest sound,
 * at the frequency where it works best, that renders the tinnitus inaudible.
 * It is computed server-side (`services/masking.reference_level`) so the client
 * never has a second opinion about it.
 */

import { useTranslation } from "react-i18next";
import { Chip, Panel, Readout } from "./ui";
import { MaskingCurve } from "./charts";

export interface MaskingSummary {
  curve: { hz: number; threshold_db: number | null; masked: boolean | null; tested: boolean }[];
  reference_level_db: number | null;
  reference_level_hz: number | null;
  maskable: boolean;
  safe: boolean | null;
  selectivity: string;
  spread_db: number | null;
  interpretation: string;
  tested_count: number;
  unmaskable_count: number;
  max_safe_db?: number;
}

/** Tone for the headline readout: how promising this result is for masking. */
const INTERPRETATION_TONE: Record<string, "ok" | "warn" | "crit" | "data"> = {
  easily_masked: "ok",
  moderately_masked: "ok",
  hard_to_mask: "warn",
  above_safe: "crit",
  unmaskable: "crit",
};

export function ReferenceLevelPanel({
  summary,
  showCurve = true,
  compact = false,
}: {
  summary: MaskingSummary | null | undefined;
  showCurve?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (!summary) return null;

  const { reference_level_db: db, reference_level_hz: hz } = summary;
  const tone = INTERPRETATION_TONE[summary.interpretation] ?? "data";

  return (
    <Panel title={t("masking.reference.title")} bracketed>
      <div className="stack stack-4">
        {/* The two numbers the brief asks for, side by side and large: this is
            the headline result of the whole hearing measurement. */}
        <div className="row" style={{ gap: "var(--s8)" }}>
          <Readout
            label={t("masking.reference.level")}
            value={db === null ? t("masking.reference.notMeasured") : db.toFixed(0)}
            unit={db === null ? "" : "dB HL"}
            size="xl"
            tone={tone === "data" ? "data" : tone}
          />
          <Readout
            label={t("masking.reference.frequency")}
            value={hz === null ? "—" : hz >= 1000 ? (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1) : hz}
            unit={hz === null ? "" : hz >= 1000 ? "kHz" : "Hz"}
            size="lg"
            tone="signal"
            note={hz === null ? undefined : `${hz} Hz`}
          />
        </div>

        <p style={{ fontSize: "var(--fs-small)", lineHeight: 1.6, maxWidth: "52em" }}>
          {t("masking.reference.explain")}
        </p>

        {/* What this result means for treatment. The clinical banding is the
            server's; the sentence is the translation files'. */}
        <Panel tone={tone === "crit" ? "crit" : tone === "warn" ? "warn" : "sunken"} tight>
          <p className="meta">
            {t(`masking.reference.interpretation.${summary.interpretation}`, { defaultValue: "" })}
          </p>
        </Panel>

        {!compact && (
          <div className="stack stack-2">
            <div className="row row--tight">
              <span className="label">{t("masking.reference.selectivity")}</span>
              <Chip tone={summary.selectivity === "selective" ? "signal" : "ghost"}>
                {t(`masking.reference.${summary.selectivity}`, { defaultValue: summary.selectivity })}
              </Chip>
              {summary.spread_db !== null && (
                <span className="meta mono">
                  {summary.spread_db.toFixed(0)} dB
                </span>
              )}
            </div>
            <p className="meta">
              {t(`masking.reference.${summary.selectivity}Note`, { defaultValue: "" })}
            </p>
          </div>
        )}

        {showCurve && summary.curve?.length > 0 && (
          <div className="stack stack-2">
            <span className="label">{t("masking.chart.title")}</span>
            <MaskingCurve
              curve={summary.curve}
              referenceDb={db}
              referenceHz={hz}
              maxSafeDb={summary.max_safe_db ?? 85}
            />
            <p className="meta">{t("masking.chart.legend")}</p>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default ReferenceLevelPanel;

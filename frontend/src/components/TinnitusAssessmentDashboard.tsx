/**
 * The "04. Your Tinnitus Assessment Results" dashboard.
 *
 * Everything here is read from the clinical report (`/api/reports/clinical`)
 * and the active assessment row already fetched by `Results.tsx` — nothing is
 * recomputed. THI, the Tinnitus Reactivity Index, residual-inhibition
 * classification, maskability and the masking curve are all scored
 * server-side by the existing engines in `clinical/instruments.py` and
 * `api/services/analysis.py`; this component's job is only to lay them out.
 *
 * Every card degrades independently: a measurement the patient has not taken
 * renders as an honest "Not completed" state, never a zero, never an invented
 * value. A card with nothing to show at all returns `null` rather than an
 * empty frame.
 */

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Chip, Panel } from "./ui";
import { Audiogram, CombinedAudiogramMasking } from "./charts";
import {
  IconAlert,
  IconArrowRight,
  IconBed,
  IconChart,
  IconClipboard,
  IconEar,
  IconSpark,
  IconTarget,
  IconTrend,
  IconWave,
} from "./icons";
import type { Assessment } from "../api/client";

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------- */

/** A question this patient has not answered gets this, never a fabricated number. */
function NotCompleted({ label }: { label: string }) {
  const { t } = useTranslation();
  return <span className="meta dim">{t("results.dashboard.notCompleted", { defaultValue: label })}</span>;
}

/** Card shell every section here shares — same `Panel` the rest of the report already uses. */
function DashboardCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: typeof IconEar;
  children: React.ReactNode;
}) {
  return (
    <Panel
      bracketed
      title={
        Icon ? (
          <span className="row row--tight row--nowrap">
            <Icon size={16} />
            <span>{title}</span>
          </span>
        ) : (
          title
        )
      }
    >
      {children}
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */
/* 1. Overall profile                                                        */
/* ------------------------------------------------------------------------- */

/**
 * "Moderate tinnitus impact" — built from the same THI grade number every
 * other severity card on this report already reads
 * (`thi.subscales.grade_number`), through the same translated verdict string
 * (`results.severity.<n>.verdict`) the existing plain-summary severity card
 * uses. Not a second severity scale: the same one, worded as a headline.
 */
function OverallProfileCard({ report }: { report: any }) {
  const { t } = useTranslation();
  const thi = report?.questionnaires?.thi;
  const gradeNumber: number | null = thi?.subscales?.grade_number ?? null;
  const tri = report?.composite_indices?.tri;

  let profile: string | null = null;
  if (gradeNumber) {
    profile = t("results.dashboard.overallProfile", {
      verdict: t(`results.severity.${gradeNumber}.verdict`),
      defaultValue: `${t(`results.severity.${gradeNumber}.verdict`)} tinnitus impact`,
    });
  } else if (tri?.band) {
    profile = t("results.dashboard.overallProfileFromTri", {
      band: tri.band,
      defaultValue: `${tri.band} tinnitus reactivity`,
    });
  }

  return (
    <DashboardCard title={t("results.dashboard.overallProfileTitle", "Overall profile")} icon={IconSpark}>
      {profile ? (
        <span className="statuscard__verdict" style={{ fontSize: "var(--fs-h2)" }}>
          {profile}
        </span>
      ) : (
        <NotCompleted label="Not yet available — complete your tinnitus questionnaire to see your profile." />
      )}
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 2. Right now — the same-visit snapshot                                    */
/* ------------------------------------------------------------------------- */

/**
 * The one same-visit rating the patient gave during intake — "Your Tinnitus
 * Snapshot" in the About You section, `Patient.about_you.snapshot_*`. Kept
 * distinct from the formal "Tinnitus Severity" result category below, which
 * reads the VAS/NRS module instead: this is a quick in-the-moment rating taken
 * before the assessment proper, that one is the validated instrument. Showing
 * both under the same name would blur two different measurements together.
 */
function RightNowCard({ report }: { report: any }) {
  const { t } = useTranslation();
  const aboutYou = report?.about_you ?? {};
  const rows: { label: string; value: unknown }[] = [
    { label: t("results.dashboard.severityCurrent", "Current"), value: aboutYou.snapshot_loudness_now },
    { label: t("results.dashboard.severityBother", "Bother"), value: aboutYou.snapshot_bothersome_now },
    { label: t("results.dashboard.severityAwareness", "Awareness"), value: aboutYou.snapshot_noticeability_now },
  ];

  return (
    <DashboardCard title={t("results.dashboard.rightNow", "Right now")} icon={IconTarget}>
      <div className="stack stack-3">
        {rows.map((row) => (
          <div key={row.label} className="row row--between row--baseline">
            <span className="label">{row.label}</span>
            {typeof row.value === "number" ? (
              <span className="mono" style={{ fontWeight: 700 }}>
                {row.value} / 10
              </span>
            ) : (
              <NotCompleted label="Not completed" />
            )}
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 3. About Your Tinnitus — the eight result categories                      */
/* ------------------------------------------------------------------------- */

/**
 * One entry of `report.about_your_tinnitus` (see
 * `backend/api/views.py::module2_status`) — the single source of truth for
 * whether each of the eight result categories is available, and exactly why
 * when it is not. This card never re-derives availability from raw scores; it
 * only lays out what the server already decided, so it can never disagree
 * with the questionnaire step about what was skipped.
 */
interface Module2DomainStatus {
  key: string;
  category: string;
  instrument: string;
  kind: "real" | "stub";
  status: "not_started" | "in_progress" | "completed" | "skipped" | "unavailable";
  available: boolean;
  score: number | null;
  grade: string | null;
  reason: string | null;
}

function AboutYourTinnitusCard({
  report,
  activeAssessment,
  onCompleteInstrument,
}: {
  report: any;
  activeAssessment?: Assessment | null;
  onCompleteInstrument(domainKey: string): void;
}) {
  const { t } = useTranslation();
  const domains: Module2DomainStatus[] = Array.isArray(report?.about_your_tinnitus)
    ? report.about_your_tinnitus
    : [];
  if (domains.length === 0) return null;

  const vas = report?.questionnaires?.vas ?? {};
  const vasRows: { label: string; value: number | null }[] = [
    { label: t("results.dashboard.vasLoudness", "Loudness"), value: vas.vas_loudness ?? null },
    { label: t("results.dashboard.vasAnnoyance", "Annoyance"), value: vas.vas_annoyance ?? null },
    { label: t("results.dashboard.vasAwareness", "Awareness"), value: vas.vas_awareness ?? null },
    { label: t("results.dashboard.vasSleep", "Sleep impact"), value: vas.vas_sleep_interference ?? null },
  ];

  // The TFI's 8 published subscales — from `score_tfi()` via
  // `report.questionnaires.tfi.subscales`, never recomputed here. A subscale
  // is shown only when the server marked it `valid` (no more than one missing
  // item); otherwise the row says so rather than displaying a misleading
  // number, matching how the overall score already behaves when the
  // >=19-of-25 rule is not met.
  const tfiSubscales = report?.questionnaires?.tfi?.subscales ?? {};
  const TFI_SUBSCALE_LABELS: [string, string][] = [
    ["intrusive", t("results.dashboard.tfiIntrusive", "Intrusive")],
    ["sense_of_control", t("results.dashboard.tfiSenseOfControl", "Sense of Control")],
    ["cognitive", t("results.dashboard.tfiCognitive", "Cognitive")],
    ["sleep", t("results.dashboard.tfiSleep", "Sleep")],
    ["auditory", t("results.dashboard.tfiAuditory", "Auditory")],
    ["relaxation", t("results.dashboard.tfiRelaxation", "Relaxation")],
    ["quality_of_life", t("results.dashboard.tfiQualityOfLife", "Quality of Life")],
    ["emotional", t("results.dashboard.tfiEmotional", "Emotional")],
  ];

  return (
    <DashboardCard title={t("results.dashboard.aboutYourTinnitus", "About your tinnitus")} icon={IconTrend}>
      <div className="stack stack-5">
        {domains.map((d) => (
          <div
            key={d.key}
            className="stack stack-2"
            style={{ paddingBottom: "var(--s4)", borderBottom: "1px solid var(--rule, #2a2f37)" }}
          >
            <div className="row row--between row--baseline">
              <span className="label label--signal">{d.category}</span>
              <Chip tone="ghost">{d.instrument}</Chip>
            </div>

            {d.available && d.key === "vas" ? (
              <div className="grid grid-4" style={{ gap: "var(--s3)" }}>
                {vasRows.map((row) => (
                  <div key={row.label} className="stack stack-1">
                    <span className="label">{row.label}</span>
                    {typeof row.value === "number" ? (
                      <span className="mono" style={{ fontWeight: 700 }}>
                        {row.value.toFixed(1)} / 10
                      </span>
                    ) : (
                      <NotCompleted label="Not completed" />
                    )}
                  </div>
                ))}
              </div>
            ) : d.available ? (
              <div className="stack stack-3">
                <div className="row row--between row--baseline">
                  <span className="mono" style={{ fontWeight: 700, fontSize: "var(--fs-lead)" }}>
                    {d.score}
                    {d.key === "tfi" && " / 100"}
                    {d.key === "phq9" && " / 27"}
                  </span>
                  {d.grade && <span className="meta">{d.grade}</span>}
                </div>
                {d.key === "phq9" && activeAssessment?.phq9_functional_difficulty != null && (
                  <div className="stack stack-1">
                    <span className="label">
                      {t("results.dashboard.phqFunctionalDifficulty", "Functional difficulty")}
                    </span>
                    <span className="meta">
                      {
                        (
                          {
                            1: t("results.dashboard.phqFunctional1", "Not difficult at all"),
                            2: t("results.dashboard.phqFunctional2", "Somewhat difficult"),
                            3: t("results.dashboard.phqFunctional3", "Very difficult"),
                            4: t("results.dashboard.phqFunctional4", "Extremely difficult"),
                          } as Record<number, string>
                        )[activeAssessment.phq9_functional_difficulty]
                      }
                    </span>
                  </div>
                )}
                {d.key === "tfi" && (
                  <div className="grid grid-4" style={{ gap: "var(--s3)" }}>
                    {TFI_SUBSCALE_LABELS.map(([key, label]) => {
                      const sub = tfiSubscales[key] ?? {};
                      return (
                        <div key={key} className="stack stack-1">
                          <span className="label">{label}</span>
                          {sub.valid && typeof sub.score === "number" ? (
                            <span className="mono" style={{ fontWeight: 700 }}>
                              {sub.score} / 100
                            </span>
                          ) : (
                            <span className="meta dim">
                              {t("results.dashboard.notEnoughResponses", "Not enough valid responses")}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div className="stack stack-2">
                <p className="meta" style={{ margin: 0 }}>
                  <strong>{t("results.dashboard.resultUnavailable", "Result unavailable.")}</strong>{" "}
                  {d.reason}
                </p>
                {d.kind === "real" && (
                  <>
                    <p className="meta dim" style={{ margin: 0 }}>
                      {t("results.dashboard.completeToReceive", {
                        instrument: d.instrument,
                        category: d.category,
                        defaultValue: `Complete ${d.instrument} to receive your ${d.category} result.`,
                      })}
                    </p>
                    <div>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        onClick={() => onCompleteInstrument(d.key)}
                      >
                        {t("results.dashboard.completeInstrument", {
                          instrument: d.instrument,
                          defaultValue: `Complete ${d.instrument}`,
                        })}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 5. Hearing — two separate per-ear audiograms                              */
/* ------------------------------------------------------------------------- */

/**
 * The existing `Audiogram` component already draws both ears on one chart
 * (used everywhere else in the app); it is not changed here. Two per-ear
 * panels are built by calling it twice with the *other* ear's thresholds
 * filtered out, so each panel's own "No audiometric data" empty state (which
 * `Audiogram` already renders) fires independently per ear rather than only
 * when both are empty.
 */
function AudiogramCard({ report }: { report: any }) {
  const { t } = useTranslation();
  const raw = report?.audiometry?.raw ?? {};
  const pitchHz = report?.psychoacoustics?.pitch_match_hz ?? null;

  return (
    <DashboardCard title={t("results.dashboard.hearing", "Hearing")} icon={IconEar}>
      <div className="grid grid-2" style={{ gap: "var(--s4)" }}>
        <div className="stack stack-1">
          <span className="label">{t("results.dashboard.leftEar", "Left ear")}</span>
          <Audiogram audiogram={{ left: raw.left ?? {} }} pitchHz={pitchHz} height={260} showLegend={false} />
        </div>
        <div className="stack stack-1">
          <span className="label">{t("results.dashboard.rightEar", "Right ear")}</span>
          <Audiogram audiogram={{ right: raw.right ?? {} }} pitchHz={pitchHz} height={260} showLegend={false} />
        </div>
      </div>
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 6. Psychoacoustic profile                                                 */
/* ------------------------------------------------------------------------- */

function PsychoacousticProfileCard({ report }: { report: any }) {
  const { t } = useTranslation();
  const p = report?.psychoacoustics ?? {};
  const rows: { label: string; value: number | null | undefined; unit: string }[] = [
    { label: t("results.dashboard.pitchMatch", "Pitch match"), value: p.pitch_match_hz, unit: "Hz" },
    { label: t("results.dashboard.loudnessMatch", "Loudness match"), value: p.loudness_match_db_hl, unit: "dB HL" },
    { label: t("results.dashboard.sensationLevel", "Sensation level"), value: p.loudness_match_db_sl, unit: "dB SL" },
    { label: "MML", value: p.mml_db_sl, unit: "dB SL" },
  ];

  return (
    <DashboardCard title={t("results.dashboard.psychoacoustic", "Psychoacoustic profile")} icon={IconWave}>
      <div className="grid grid-4" style={{ gap: "var(--s3)" }}>
        {rows.map((row) => (
          <div key={row.label} className="stack stack-1">
            <span className="label">{row.label}</span>
            {typeof row.value === "number" ? (
              <span className="mono" style={{ fontWeight: 700 }}>
                {row.label === t("results.dashboard.pitchMatch", "Pitch match") ? Math.round(row.value) : row.value.toFixed(1)}{" "}
                {row.unit}
              </span>
            ) : (
              <NotCompleted label="Not completed" />
            )}
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 7. Masking response                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Reuses `CombinedAudiogramMasking` verbatim — the same component the
 * detailed report's "audiogram + masking curve" overlay already draws from
 * the same `psychoacoustics.masking.curve` the masking module recorded. No
 * second masking-curve renderer, no synthetic points.
 */
function MaskingCurveCard({ report }: { report: any }) {
  const { t } = useTranslation();
  const curve = report?.psychoacoustics?.masking?.curve;
  const raw = report?.audiometry?.raw;
  const pitchHz = report?.psychoacoustics?.pitch_match_hz ?? null;
  const hasCurve = Array.isArray(curve) && curve.some((pt: any) => pt?.threshold_db !== null && pt?.masked === true);

  return (
    <DashboardCard title={t("results.dashboard.masking", "Masking response")} icon={IconAlert}>
      {hasCurve ? (
        <CombinedAudiogramMasking audiogram={raw} curve={curve} pitchHz={pitchHz} height={320} />
      ) : (
        <NotCompleted label="Masking assessment not completed" />
      )}
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 8. Residual inhibition                                                    */
/* ------------------------------------------------------------------------- */

/**
 * `ri_depth_pct` (the measured percentage) and `residual_inhibition.category`
 * (the same five-band classification `classify_residual_inhibition` already
 * computes: Complete/Partial/Minimal/Absent/Rebound) both come from the
 * report unmodified. `ri_reported_category` — what the patient themselves
 * picked when the masker stopped — is shown alongside when present, labelled
 * as the patient's own account rather than merged into the measured one.
 */
function ResidualInhibitionCard({ report }: { report: any }) {
  const { t } = useTranslation();
  const p = report?.psychoacoustics ?? {};
  const ri = p.residual_inhibition ?? {};
  const depth: number | null = p.ri_depth_pct ?? null;
  const reported: string | null = p.ri_reported_category || null;

  if (depth === null && !ri.category) {
    return (
      <DashboardCard title={t("results.dashboard.residualInhibition", "Residual inhibition")} icon={IconClipboard}>
        <NotCompleted label="Not completed" />
      </DashboardCard>
    );
  }

  return (
    <DashboardCard title={t("results.dashboard.residualInhibition", "Residual inhibition")} icon={IconClipboard}>
      <div className="grid grid-2" style={{ gap: "var(--s3)" }}>
        <div className="stack stack-1">
          <span className="label">{t("results.dashboard.reduction", "Reduction")}</span>
          {depth !== null ? (
            <span className="mono" style={{ fontWeight: 700 }}>
              {depth}%
            </span>
          ) : (
            <NotCompleted label="Not completed" />
          )}
          {ri.category && (
            <Chip tone={ri.category === "Rebound" ? "crit" : ri.category === "Complete" || ri.category === "Partial" ? "ok" : "ghost"}>
              {ri.category}
            </Chip>
          )}
        </div>
        <div className="stack stack-1">
          <span className="label">{t("results.dashboard.duration", "Duration")}</span>
          {typeof ri.duration_s === "number" ? (
            <span className="mono" style={{ fontWeight: 700 }}>
              {ri.duration_s}s
            </span>
          ) : (
            <NotCompleted label="Not recorded" />
          )}
        </div>
      </div>
      {reported && (
        <p className="meta" style={{ marginTop: "var(--s2)" }}>
          {t("results.dashboard.riPatientReported", {
            category: reported,
            defaultValue: `You reported: ${reported} reduction.`,
          })}
        </p>
      )}
      {ri.note && <p className="meta">{ri.note}</p>}
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 9. Functional impact                                                      */
/* ------------------------------------------------------------------------- */

/**
 * The five short-form THI items each already load on one named domain — see
 * `THI_SHORT_ITEMS` in `clinical/instruments.py`: thi7 (sleep interference),
 * thi1 (concentration), thi13 (daily activities / job or household
 * responsibilities), thi22 (anxiety) and thi21 (mood). Three of them line up
 * directly with three of the five domains named here — Sleep, Concentration,
 * Work/Study. The other two named domains, Communication and Social Life,
 * correspond to *long-form* THI items (thi2, thi9) that the app's current
 * five-item short form does not administer to a new patient, so they render
 * "Not assessed" for anyone who only has the short form on file — which is
 * the honest state, not a placeholder. A historical long-form record that
 * happens to include those two items will show a real value for them.
 *
 * Each raw response (0/2/4) is rescaled to the 0–5 dot scale the card
 * displays: 0→0, 2→2.5 (rounds to 3 dots), 4→5.
 */
const FUNCTIONAL_DOMAIN_ITEMS: { label: string; itemId: string }[] = [
  { label: "Sleep", itemId: "thi7" },
  { label: "Concentration", itemId: "thi1" },
  { label: "Work / Study", itemId: "thi13" },
  { label: "Communication", itemId: "thi2" },
  { label: "Social life", itemId: "thi9" },
];

function DotScale({ filled }: { filled: number }) {
  return (
    <span aria-hidden="true" style={{ letterSpacing: "2px", fontSize: "1.1rem", color: "var(--signal-ink)" }}>
      {"●".repeat(filled)}
      <span style={{ color: "var(--ink-4)" }}>{"○".repeat(5 - filled)}</span>
    </span>
  );
}

function FunctionalImpactCard({ thiItems }: { thiItems: Record<string, number> | null | undefined }) {
  const { t } = useTranslation();
  return (
    <DashboardCard title={t("results.dashboard.functionalImpact", "Functional impact")} icon={IconChart}>
      <p className="meta">
        {t(
          "results.dashboard.functionalImpactScale",
          "Each domain is shown on a 0–5 scale, filled dots meaning greater impact, from your own tinnitus handicap responses."
        )}
      </p>
      <div className="stack stack-2">
        {FUNCTIONAL_DOMAIN_ITEMS.map((domain) => {
          const raw = thiItems?.[domain.itemId];
          const usable = typeof raw === "number";
          const filled = usable ? Math.round((raw as number) / 4 * 5) : 0;
          return (
            <div key={domain.itemId} className="row row--between row--nowrap">
              <span style={{ fontSize: "var(--fs-small)" }}>{domain.label}</span>
              {usable ? <DotScale filled={filled} /> : <NotCompleted label="Not assessed" />}
            </div>
          );
        })}
      </div>
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 10. AI assessment summary                                                 */
/* ------------------------------------------------------------------------- */

/**
 * A short deterministic narrative composed entirely from values already
 * present on the report — the same THI grade, TRI band, RI category,
 * audiometric grade and wellbeing scores every other card on this page reads.
 * Nothing is generated by a language model: this app's own safety
 * architecture already runs red-flag detection deterministically, before any
 * model is consulted, specifically so a clinically important finding cannot
 * depend on generative output — this narrative follows the same principle.
 * It states measured facts and labels them as such; it never proposes a
 * diagnosis, and any escalation is the *existing* red-flag list
 * (`report.safety.flags`), reused rather than re-decided here.
 */
function buildNarrative(t: (k: string, o?: Record<string, unknown>) => string, report: any): string[] {
  const sentences: string[] = [];
  const thi = report?.questionnaires?.thi;
  const gradeNumber: number | null = thi?.subscales?.grade_number ?? null;
  const tri = report?.composite_indices?.tri;
  const audiometry = report?.audiometry ?? {};
  const psycho = report?.psychoacoustics ?? {};
  const ri = psycho.residual_inhibition ?? {};

  if (gradeNumber) {
    sentences.push(
      t("results.dashboard.narrativeThi", {
        verdict: t(`results.severity.${gradeNumber}.verdict`).toLowerCase(),
        score: thi.score,
        defaultValue: `Your tinnitus handicap score places your measured impact in the ${t(
          `results.severity.${gradeNumber}.verdict`
        ).toLowerCase()} range (THI ${thi.score}/100).`,
      })
    );
  }
  if (audiometry.who_grade) {
    sentences.push(
      t("results.dashboard.narrativeAudiometry", {
        grade: audiometry.who_grade.toLowerCase(),
        defaultValue: `Your hearing test shows ${audiometry.who_grade.toLowerCase()} on the better ear.`,
      })
    );
  }
  if (psycho.pitch_match_hz) {
    sentences.push(
      t("results.dashboard.narrativePitch", {
        hz: Math.round(psycho.pitch_match_hz),
        defaultValue: `Your tinnitus was matched to a tone near ${Math.round(psycho.pitch_match_hz)} Hz.`,
      })
    );
  }
  if (ri.category) {
    sentences.push(
      t("results.dashboard.narrativeRi", {
        category: ri.category.toLowerCase(),
        defaultValue: `Masking produced a ${ri.category.toLowerCase()} reduction in your tinnitus during testing.`,
      })
    );
  }
  if (tri?.band) {
    sentences.push(
      t("results.dashboard.narrativeTri", {
        band: tri.band.toLowerCase(),
        defaultValue: `Your overall reactivity index is in the ${tri.band.toLowerCase()} band.`,
      })
    );
  }
  return sentences;
}

function AIAssessmentSummary({ report }: { report: any }) {
  const { t } = useTranslation();
  const sentences = buildNarrative(t, report);

  return (
    <DashboardCard title={t("results.dashboard.aiSummary", "Assessment summary")} icon={IconTrend}>
      {sentences.length > 0 ? (
        <div className="stack stack-2">
          <p style={{ lineHeight: 1.6 }}>{sentences.join(" ")}</p>
          <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
            {t(
              "results.dashboard.aiSummaryDisclaimer",
              "Generated automatically from your own measured results. This is not a diagnosis — discuss these findings with your clinician."
            )}
          </p>
        </div>
      ) : (
        <NotCompleted label="Complete more of your assessment to generate a summary." />
      )}
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 11 & 12. Key findings / rehabilitation priorities                         */
/* ------------------------------------------------------------------------- */

/**
 * Both lists are capped at 3 here, but neither is computed here.
 * `summary.findings` is `build_summary()`'s existing, already-prioritised
 * finding list (audiometry → THI → TRI → RI → maskability → modelled risk, in
 * that order); `management_plan.rationale` is the same per-activity
 * justification the Rehabilitation screen's own "why this programme" panel
 * already renders. Reusing both verbatim means this card can never disagree
 * with the report or the therapy plan about why either exists.
 */
function CappedListCard({
  title,
  icon: Icon,
  items,
  emptyLabel,
}: {
  title: string;
  icon: typeof IconEar;
  items: string[];
  emptyLabel: string;
}) {
  const capped = items.filter(Boolean).slice(0, 3);
  return (
    <DashboardCard title={title} icon={Icon}>
      {capped.length > 0 ? (
        <ol className="stack stack-2" style={{ paddingLeft: "var(--s5)", margin: 0 }}>
          {capped.map((item, i) => (
            <li key={i} style={{ fontSize: "var(--fs-small)", lineHeight: 1.6 }}>
              {item}
            </li>
          ))}
        </ol>
      ) : (
        <NotCompleted label={emptyLabel} />
      )}
    </DashboardCard>
  );
}

/* ------------------------------------------------------------------------- */
/* 13. Next steps CTA                                                        */
/* ------------------------------------------------------------------------- */

function NextStepsCard() {
  const { t } = useTranslation();
  return (
    <div className="center" style={{ marginTop: "var(--s2)" }}>
      <Link to="/rehabilitation" className="btn btn--primary btn--lg">
        <IconWave size={16} />
        {t("results.dashboard.startRehab", "Start personalized rehabilitation")}
        <IconArrowRight size={16} />
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* The dashboard itself                                                      */
/* ------------------------------------------------------------------------- */

export function TinnitusAssessmentDashboard({
  report,
  activeAssessment,
  onCompleteInstrument,
}: {
  report: any;
  /** The raw assessment row for the report's assessment — carries `thi_items`, which the report response does not. */
  activeAssessment?: Assessment | null;
  /** Opens the "complete this skipped instrument" flow for one of the eight About Your Tinnitus domains. */
  onCompleteInstrument?(domainKey: string): void;
}) {
  const { t } = useTranslation();
  if (!report) return null;

  const findings: string[] = Array.isArray(report?.summary?.findings) ? report.summary.findings : [];
  const priorities: string[] = Array.isArray(report?.management_plan?.rationale)
    ? report.management_plan.rationale
    : [];

  return (
    <div className="stack stack-5" data-tour="tinnitus-dashboard">
      <div className="row row--tight">
        <span className="label label--signal">{t("results.dashboard.eyebrow", "04")}</span>
        <h2 style={{ margin: 0, fontSize: "var(--fs-h2)" }}>
          {t("results.dashboard.heading", "Your tinnitus assessment results")}
        </h2>
      </div>

      <OverallProfileCard report={report} />
      <AboutYourTinnitusCard
        report={report}
        activeAssessment={activeAssessment}
        onCompleteInstrument={onCompleteInstrument ?? (() => {})}
      />
      <RightNowCard report={report} />
      <AudiogramCard report={report} />
      <PsychoacousticProfileCard report={report} />
      <MaskingCurveCard report={report} />
      <ResidualInhibitionCard report={report} />
      <FunctionalImpactCard thiItems={activeAssessment?.thi_items} />
      <AIAssessmentSummary report={report} />

      <div className="grid grid-2" style={{ gap: "var(--s4)" }}>
        <CappedListCard
          title={t("results.dashboard.keyFindings", "Key findings")}
          icon={IconTarget}
          items={findings}
          emptyLabel="Complete more of your assessment to generate findings."
        />
        <CappedListCard
          title={t("results.dashboard.rehabPriorities", "Rehabilitation priorities")}
          icon={IconBed}
          items={priorities}
          emptyLabel="Not available — complete your assessment to generate a personalized plan."
        />
      </div>

      <NextStepsCard />
    </div>
  );
}

export default TinnitusAssessmentDashboard;

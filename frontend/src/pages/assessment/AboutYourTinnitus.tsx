/**
 * "About Your Tinnitus" — Module 2.
 *
 * Replaces the old two-instrument questionnaire step (VAS + THI-5) and the old
 * separate "Sleep, mood and stress" step. Neither of those exists as a
 * standalone module any more: this is the one place all eight tinnitus-related
 * result categories are administered.
 *
 * The eight are grouped into two clearly separated parts, per
 * `MODULE2_SECTIONS`'s `required` flag (the frontend twin of
 * `backend/api/views.py::MODULE2_DOMAINS`):
 *
 *   - **Core Tinnitus Assessment** (VAS, THI, TFI) — mandatory. No Skip is
 *     offered (see `allowSkip` below); the module cannot be considered
 *     core-complete, and `onAllDone` cannot be reached, until all three carry
 *     `questionnaire_status === "completed"`. A "skipped" status is never
 *     treated as complete — see `coreComplete` in the wizard component.
 *   - **Optional Wellbeing Assessment** (ISI, GAD-7, PHQ-9, PSS-10,
 *     WHOQOL-BREF) — each freely completable now or skippable for later, and
 *     none of the five block reaching the Hearing step.
 *
 * Rather than the old fixed linear sequence (question 1 of 8, always
 * advancing), the default view is a two-section menu of cards — one per
 * instrument, showing its own status and action — so a patient can do them in
 * any order, leave and return to any one individually, and see at a glance
 * which of the three required ones remain. Choosing a card opens the exact
 * same single-instrument form (`InstrumentSectionForm`, `oneAtATime`) the old
 * linear flow already used for that instrument; nothing about how a
 * questionnaire is administered, scored, or persisted changed — only how a
 * patient chooses which one to start.
 *
 * All eight have real, validated item content in this codebase and are
 * administered in full, directly (not as short-form screeners that later
 * escalate): VAS, THI (the full 25-item form — see `long_form_items` on the
 * registry's `thi` entry), TFI (the full 25-item form, with its own mix of
 * percentage and 0-10 items — see `resolveItemOptions`), ISI (five displayed
 * questions, the first a grouped item with three independently-scored rows —
 * see `groupItemsIntoPages`), GAD-7, PHQ-9 (nine items, plus one separate,
 * non-scored functional-difficulty question — see
 * `PhqFunctionalDifficultyStep`), PSS-10, and WHOQOL-BREF (26 items, six
 * response scales — see `clinical/instruments.py::WHOQOL_BREF_ITEMS`).
 * WHOQOL-BREF's item content and response wording are reproduced verbatim
 * from the published patient form, but — unlike the other seven — no
 * domain/overall score is computed for it: the published scoring manual's
 * raw-to-transformed conversion tables were not part of the source supplied
 * for this feature, so `score_whoqol_bref()` reports completion only
 * (`answered`/`expected`/`complete`), never a fabricated number. This section
 * still offers Skip and shows a completed/skipped status exactly like every
 * other optional instrument — only the Results card's score display differs
 * (see `AboutYourTinnitusCard` in `TinnitusAssessmentDashboard.tsx`).
 *
 * Every real section is a single page showing every item and every response
 * option at once — never a bare heading — with (for optional sections) Skip
 * and Next/Continue. A skipped section is saved through `onSectionSave` as
 * `questionnaire_status[key] = "skipped"` and posts no item answers, so
 * `rescore()` on the server leaves that instrument's score `null` rather than
 * fabricating a zero. Leaving a section partway through — the guided form's
 * `onProgress` — saves what is answered so far as `questionnaire_status[key]
 * = "in_progress"`, so returning to it resumes at the first unanswered
 * question with every prior answer restored, rather than losing them.
 */

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chip, Loading, Meter, Panel } from "../../components/ui";
import { IconCheck } from "../../components/icons";
import {
  anchorLabel,
  instrumentName,
  itemText,
  optionLabel,
  resolveItemOptions,
  type InstrumentSpec,
  type Item,
  type Option,
  type PainScaleSpec,
} from "./Questionnaires";
import PainFaceScale from "./PainFaceScale";

export type Module2Status = "not_started" | "in_progress" | "completed" | "skipped";

export interface Module2Section {
  key: string;
  category: string;
  instrumentAbbrev: string;
  instrumentFullName: string;
  kind: "real" | "stub";
  /** Key into the `/api/assessments/instruments` registry, for real sections. */
  registryKey?: string;
  /** Core Tinnitus Assessment (VAS/THI/TFI, mandatory) vs. Optional Wellbeing
   *  Assessment (everything else) — the twin of `required` on
   *  `backend/api/views.py::MODULE2_DOMAINS`. Core sections never offer Skip
   *  and gate the module's overall completion; optional ones always do. */
  required: boolean;
}

/**
 * The eight result categories, in the fixed clinical order the product
 * specification requires — first the three Core Tinnitus Assessment
 * instruments, then the five Optional Wellbeing Assessment ones. This is the
 * frontend twin of `backend/api/views.py::MODULE2_DOMAINS` — the two lists
 * must name the same eight keys in the same order, since the Results page
 * matches them up by key.
 */
export const MODULE2_SECTIONS: Module2Section[] = [
  { key: "vas", category: "Tinnitus Severity", instrumentAbbrev: "VAS / NRS", instrumentFullName: "Visual Analogue / Numeric Rating Scales", kind: "real", registryKey: "vas", required: true },
  { key: "thi", category: "Tinnitus Handicap", instrumentAbbrev: "THI", instrumentFullName: "Tinnitus Handicap Inventory", kind: "real", registryKey: "thi", required: true },
  { key: "tfi", category: "Tinnitus Functional Impact", instrumentAbbrev: "TFI", instrumentFullName: "Tinnitus Functional Index", kind: "real", registryKey: "tfi", required: true },
  { key: "isi", category: "Sleep & Insomnia", instrumentAbbrev: "ISI", instrumentFullName: "Insomnia Severity Index", kind: "real", registryKey: "isi", required: false },
  { key: "gad7", category: "Anxiety", instrumentAbbrev: "GAD-7", instrumentFullName: "Generalised Anxiety Disorder 7-item scale", kind: "real", registryKey: "gad7", required: false },
  { key: "phq9", category: "Mood / Depression", instrumentAbbrev: "PHQ-9", instrumentFullName: "Patient Health Questionnaire-9", kind: "real", registryKey: "phq9", required: false },
  { key: "pss10", category: "Perceived Stress", instrumentAbbrev: "PSS-10", instrumentFullName: "Perceived Stress Scale", kind: "real", registryKey: "pss10", required: false },
  // 26 items, verbatim from the published patient form — see the module
  // docstring above and `clinical/instruments.py::WHOQOL_BREF_ITEMS`. No
  // domain/overall score is computed (`score_whoqol_bref` reports completion
  // only), so `kind` stays "real" — the item content is genuine — while the
  // Results card shows a completion count instead of a score for this one key.
  { key: "whoqol_bref", category: "Quality of Life", instrumentAbbrev: "WHOQOL-BREF", instrumentFullName: "World Health Organization Quality of Life — BREF", kind: "real", registryKey: "whoqol_bref", required: false },
];

export const MODULE2_CORE_SECTIONS = MODULE2_SECTIONS.filter((s) => s.required);
export const MODULE2_OPTIONAL_SECTIONS = MODULE2_SECTIONS.filter((s) => !s.required);

export interface Module2InitialData {
  vas?: Record<string, number>;
  thi_items?: Record<string, number>;
  tfi_items?: Record<string, number>;
  isi_items?: Record<string, number>;
  phq9_items?: Record<string, number>;
  gad7_items?: Record<string, number>;
  pss10_items?: Record<string, number>;
  whoqol_bref_items?: Record<string, number>;
  questionnaire_status?: Record<string, string>;
}

function itemsForRealSection(section: Module2Section, instruments: Record<string, InstrumentSpec> | null): Item[] {
  if (!section.registryKey) return [];
  const spec = instruments?.[section.registryKey];
  if (!spec) return [];
  // THI is administered here as the full published 25-item inventory, not the
  // 5-item short form used elsewhere in the app — see the registry's
  // `long_form_items`, which carries the exact verbatim wording.
  if (section.key === "thi") return spec.long_form_items ?? spec.items;
  return spec.items;
}

/**
 * Whether an item is answered with the TFI's 0–100% slider rather than a
 * discrete option grid. Both `kind` values are TFI-specific in this file
 * (PSQI is the only other instrument that uses per-item `kind`, and it is
 * not administered here), so this scopes the slider to the TFI without
 * touching any other questionnaire.
 */
function isSliderItem(item: Item): boolean {
  return item.kind === "percent" || item.kind === "scale10";
}

const TFI_TICK_VALUES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/**
 * Whether an item is answered with the compact numbered-scale control
 * (`NumberedScale`) rather than the large `.option` button stack THI/GAD-7/
 * PSS-10 use — the ISI's 0–4 items and the PHQ-9's 0–3 items, currently.
 * Every one of these `kind` values is unique to the instrument that uses it,
 * so this scopes the control without touching any other questionnaire.
 */
function isCompactScaleItem(item: Item): boolean {
  return item.kind === "severity" || item.kind === "phq9" || (typeof item.kind === "string" && /^q[2-5]$/.test(item.kind));
}

/**
 * Groups consecutive items that share the same non-empty `group` into one
 * navigation page. Every instrument's items get their own single-item page
 * except the ISI's, where `isi1a`/`isi1b`/`isi1c` all carry `group: "q1"` —
 * the published ISI's grouped first question, with three independently
 * scored rows shown and answered together, exactly as the paper form
 * presents them, while `report_clinical` still sees seven flat item ids.
 * An item with no `group` is always its own page, so this is a no-op for
 * every instrument that predates the ISI.
 */
function groupItemsIntoPages(items: Item[]): Item[][] {
  const pages: Item[][] = [];
  for (const item of items) {
    const last = pages[pages.length - 1];
    if (last && item.group && last[0].group === item.group) {
      last.push(item);
    } else {
      pages.push([item]);
    }
  }
  return pages;
}

/* ------------------------------------------------------------------------- */
/* One real instrument, rendered as a single page: every item, every option.  */
/* Exported so the Results page can reopen a single skipped/incomplete        */
/* instrument later without restarting the assessment.                       */
/* ------------------------------------------------------------------------- */
export function InstrumentSectionForm({
  section,
  instruments,
  initialAnswers,
  onSkip,
  onSubmit,
  onProgress,
  submitLabel,
  saving,
  oneAtATime,
  startAtLastPage,
  allowSkip = true,
}: {
  section: Module2Section;
  instruments: Record<string, InstrumentSpec> | null;
  initialAnswers?: Record<string, number>;
  onSkip(): void;
  onSubmit(answers: Record<string, number>): void;
  /** Fires with whatever is answered so far whenever the guided form advances
   *  to a new page without submitting — how a partially-answered optional
   *  section is saved as `questionnaire_status[key] = "in_progress"` so
   *  leaving and returning resumes with those answers restored, rather than
   *  losing them. Ignored by the all-items-on-one-page layout (nothing is
   *  "in progress" there — it either has every answer or none). */
  onProgress?(answers: Record<string, number>): void;
  submitLabel: string;
  saving?: boolean;
  /** Open the guided form on its *last* question rather than its first — how
   *  a patient who stepped Back out of a trailing question (the VAS's pain
   *  scale) returns to the question they were actually on. Ignored by the
   *  all-items-on-one-page layout, which has no current question. Takes
   *  priority over resuming at the first unanswered question. */
  startAtLastPage?: boolean;
  /** Guided, one-question-at-a-time presentation — used only by the Module 2
   *  wizard (`AboutYourTinnitus`). Defaults to the original all-items-on-one-
   *  page layout, which the Results page's "Complete a skipped instrument"
   *  modal still uses unchanged, so this is opt-in rather than a global
   *  behaviour change to a component more than one screen renders. */
  oneAtATime?: boolean;
  /** Whether this section offers Skip at all — false for the three Core
   *  Tinnitus Assessment instruments (VAS, THI, TFI), which are mandatory and
   *  never treated as complete when skipped, so no control is offered whose
   *  result the module would refuse to honour. Defaults to true, preserving
   *  every existing caller (the Results page's "complete a skipped
   *  instrument" modal only ever reopens instruments that can be skipped). */
  allowSkip?: boolean;
}) {
  const { t } = useTranslation();
  const spec = section.registryKey ? instruments?.[section.registryKey] : null;
  const items = useMemo(() => itemsForRealSection(section, instruments), [section, instruments]);
  const [answers, setAnswers] = useState<Record<string, number>>({ ...(initialAnswers ?? {}) });

  if (!instruments) return <Loading label={t("questionnaires.loading")} />;

  const isVas = section.key === "vas";
  // Only the instrument's own items count toward "answered". Two sections
  // carry a trailing question that is deliberately *not* one of them — the
  // VAS's pain faces scale and the PHQ-9's functional-difficulty item — and
  // both are stored in the same answers dict, so counting raw keys would let
  // an unanswered symptom item be paid for by the extra question.
  const answeredCount = items.filter((i) => answers[i.id] !== undefined).length;
  // The VAS's trailing pain faces scale, when the registry carries one. It is
  // asked once, after the four scales, and is required to finish the section —
  // an unanswered pain scale is a question the patient never saw an answer
  // recorded for, and 0 ("no pain") must be chosen rather than defaulted into.
  const painSpec = isVas ? spec?.pain_scale : undefined;
  const painAnswered = !painSpec || answers[painSpec.id] !== undefined;
  const allAnswered = items.length > 0 && answeredCount >= items.length && painAnswered;

  if (oneAtATime) {
    return (
      <GuidedInstrumentSectionForm
        section={section}
        spec={spec}
        items={items}
        answers={answers}
        setAnswers={setAnswers}
        onSkip={onSkip}
        onSubmit={onSubmit}
        onProgress={onProgress}
        submitLabel={submitLabel}
        saving={saving}
        isVas={isVas}
        startAtLastPage={startAtLastPage}
        allowSkip={allowSkip}
      />
    );
  }

  return (
    <Panel
      title={`${instrumentName(t, section.registryKey ?? section.key, spec)} — ${section.instrumentAbbrev}`}
      bracketed
    >
      <div className="stack stack-5">
        <p className="meta">{spec?.citation}</p>

        {isVas ? (
          <div className="stack stack-6">
            {items.map((item) => (
              <div key={item.id} className="stack stack-3">
                <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "34em" }}>
                  {itemText(t, item)}
                </p>
                <VasSlider
                  item={item}
                  value={answers[item.id] ?? 5}
                  onChange={(v) => setAnswers((prev) => ({ ...prev, [item.id]: v }))}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="stack stack-6">
            {groupItemsIntoPages(items).map((page, pageIndex) => {
              const item = page[0];
              const options = resolveItemOptions(instruments, section.registryKey ?? section.key, item);
              return (
                <div key={item.id} className="stack stack-2">
                  {page.length > 1 ? (
                    <div className="stack stack-4">
                      <p className="meta">
                        {pageIndex + 1}. {item.context}
                      </p>
                      {page.map((subItem) => {
                        const subOptions = resolveItemOptions(
                          instruments,
                          section.registryKey ?? section.key,
                          subItem
                        );
                        return (
                          <div key={subItem.id} className="stack stack-1">
                            <p style={{ fontSize: "var(--fs-body)", fontWeight: 600 }}>{itemText(t, subItem)}</p>
                            <NumberedScale
                              item={subItem}
                              options={subOptions}
                              value={answers[subItem.id]}
                              onSelect={(value) => setAnswers((prev) => ({ ...prev, [subItem.id]: value }))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <>
                      {item.context && <p className="meta dim">{item.context}</p>}
                      <p style={{ fontSize: "var(--fs-body)", lineHeight: 1.5, maxWidth: "40em" }}>
                        <span className="meta" style={{ marginRight: "var(--s2)" }}>
                          {pageIndex + 1}.
                        </span>
                        {itemText(t, item)}
                      </p>
                      {isSliderItem(item) ? (
                        <TfiSlider
                          item={item}
                          value={answers[item.id]}
                          onCommit={(value) => setAnswers((prev) => ({ ...prev, [item.id]: value }))}
                        />
                      ) : isCompactScaleItem(item) ? (
                        <NumberedScale
                          item={item}
                          options={options}
                          value={answers[item.id]}
                          onSelect={(value) => setAnswers((prev) => ({ ...prev, [item.id]: value }))}
                        />
                      ) : (
                        <>
                          {(item.low || item.high) && (
                            <div className="row row--between meta" style={{ maxWidth: "40em" }}>
                              <span>{anchorLabel(t, item.low, "")}</span>
                              <span>{anchorLabel(t, item.high, "")}</span>
                            </div>
                          )}
                          <div className="row row--tight" style={{ flexWrap: "wrap" }}>
                            {options.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className="option"
                                aria-pressed={answers[item.id] === option.value}
                                onClick={() => setAnswers((prev) => ({ ...prev, [item.id]: option.value }))}
                              >
                                <span>{optionLabel(t, option.label)}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* The pain faces scale — the printed VAS's own separate question,
            shown here as a trailing block on the same page (this form shows
            every item at once already), never as a fifth tinnitus scale.
            `answers.vas_pain` is split back out into its own field when the
            section is saved (see `saveModule2Section` /
            `saveCompletedInstrument`). */}
        {painSpec && (
          <div className="stack stack-3">
            <hr className="rule" />
            <p style={{ fontSize: "var(--fs-body)", lineHeight: 1.5, maxWidth: "40em" }}>
              {t(`instruments.items.${painSpec.id}`, { defaultValue: painSpec.text })}
            </p>
            <PainFaceScale
              spec={painSpec}
              value={answers[painSpec.id]}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [painSpec.id]: v }))}
              disabled={saving}
            />
          </div>
        )}

        {/* The PHQ-9's separate, non-scored functional-difficulty question —
            shown once here as a trailing block on the same page (this form
            shows every item at once already), never as the form's 10th item
            and never folded into the 0-27 total; `answers.phq9_functional_difficulty`
            is split back out into its own field when this section is saved
            (see `saveModule2Section` / `saveCompletedInstrument`). */}
        {section.key === "phq9" && spec?.functional_difficulty && (
          <div className="stack stack-2">
            <hr className="rule" />
            <p style={{ fontSize: "var(--fs-body)", lineHeight: 1.5, maxWidth: "40em" }}>
              {spec.functional_difficulty.text}
            </p>
            <NumberedScale
              item={{ id: "phq9_functional_difficulty", text: spec.functional_difficulty.text, kind: "phq9" }}
              options={spec.functional_difficulty.options}
              value={answers.phq9_functional_difficulty}
              onSelect={(value) => setAnswers((prev) => ({ ...prev, phq9_functional_difficulty: value }))}
            />
          </div>
        )}

        <hr className="rule" />

        <div className="row row--between">
          {allowSkip ? (
            <button type="button" className="btn" onClick={onSkip} disabled={saving}>
              {t("assessment.module2.skip", { defaultValue: `Skip ${section.instrumentAbbrev}` })}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onSubmit(answers)}
            disabled={saving || !allAnswered}
          >
            {saving ? t("common.saving") : submitLabel}
          </button>
        </div>
        {!allAnswered && items.length > 0 && (
          <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
            {allowSkip
              ? t("assessment.module2.answerAll", { defaultValue: "Answer every item to continue, or choose Skip." })
              : t("assessment.module2.answerAllRequired", { defaultValue: "Answer every item to continue — this assessment is required." })}
          </p>
        )}
      </div>
    </Panel>
  );
}

/**
 * The Module-2-only guided variant: one question visible at a time, in a
 * fixed-position card, advancing automatically for ordinary single-choice
 * answers. Reuses the exact same item bank, option labels and answer state
 * shape as the all-at-once form above — this changes only how the same
 * questions are paged through, never their content, order, or the shape of
 * what gets submitted.
 */
function GuidedInstrumentSectionForm({
  section,
  spec,
  items,
  answers,
  setAnswers,
  onSkip,
  onSubmit,
  onProgress,
  submitLabel,
  saving,
  isVas,
  startAtLastPage,
  allowSkip = true,
}: {
  section: Module2Section;
  spec: InstrumentSpec | null | undefined;
  items: Item[];
  answers: Record<string, number>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  onSkip(): void;
  onSubmit(answers: Record<string, number>): void;
  onProgress?(answers: Record<string, number>): void;
  submitLabel: string;
  saving?: boolean;
  isVas: boolean;
  startAtLastPage?: boolean;
  allowSkip?: boolean;
}) {
  const { t } = useTranslation();
  // Pages, not raw items: the ISI's `isi1a`/`isi1b`/`isi1c` share `group:
  // "q1"` and so form one page (the published form's grouped item 1); every
  // other instrument's items have no `group`, so each is still its own page
  // — this is a no-op for everything that predates the ISI.
  const pages = useMemo(() => groupItemsIntoPages(items), [items]);
  // How far the patient has *reached*, distinct from how many pages are
  // answered — going back and changing an earlier answer must not shrink the
  // set of questions Back can reach. A section reopened with some answers
  // already on file (an "in_progress" resume) starts at the first page that
  // is not yet fully answered, rather than at page one — the same seeded
  // `answers` a completed section restores for View/Retake, here used to
  // pick up where the patient actually left off instead of re-asking
  // questions they already answered.
  const [index, setIndex] = useState(() => {
    if (startAtLastPage) return Math.max(0, pages.length - 1);
    const firstUnanswered = pages.findIndex((p) => !p.every((it) => answers[it.id] !== undefined));
    return firstUnanswered === -1 ? 0 : firstUnanswered;
  });
  const page = pages[index] ?? [];
  const item = page.length === 1 ? page[0] : undefined;
  const isLast = index === pages.length - 1;
  const isFirst = index === 0;

  /**
   * An instructions screen before Question 1 — generic, not WHOQOL-BREF-
   * specific: it shows whenever the registry entry carries `instructions`
   * (currently only WHOQOL-BREF does) and the section is being started fresh
   * rather than resumed. A resume (some answers already on file, from an
   * "in_progress" autosave) skips straight back to where the patient left
   * off — they have already seen the instructions once — and so does
   * reopening a *completed* section for View/Retake (`startAtLastPage`).
   */
  const [showIntro, setShowIntro] = useState(
    () => Boolean(spec?.instructions) && Object.keys(answers).length === 0 && !startAtLastPage
  );

  function goBack() {
    if (!isFirst) setIndex((i) => i - 1);
  }

  function advanceOrSubmit(nextAnswers: Record<string, number>) {
    if (isLast) {
      onSubmit(nextAnswers);
    } else {
      onProgress?.(nextAnswers);
      setIndex((i) => i + 1);
    }
  }

  /** Single-select items advance immediately on selection — no separate
   *  Continue press for the ordinary case, per the guided-questionnaire brief. */
  function selectOption(value: number) {
    if (!item) return;
    const next = { ...answers, [item.id]: value };
    setAnswers(next);
    advanceOrSubmit(next);
  }

  /** The ISI's grouped page: each row is saved as it's answered, but the
   *  page only advances once every row on it has a value — selecting the
   *  first of three rows must not jump straight to Question 2. */
  function selectGroupedOption(rowId: string, value: number) {
    const next = { ...answers, [rowId]: value };
    setAnswers(next);
    if (page.every((row) => next[row.id] !== undefined)) advanceOrSubmit(next);
  }

  /** A continuous slider has no natural "I'm done" event the way a button
   *  click does, so — like a multi-select or free-text answer — it advances
   *  on an explicit Continue rather than on every drag. */
  function continueFromSlider() {
    advanceOrSubmit(answers);
  }

  /** Same per-item dispatch as `resolveItemOptions`, against the already-
   *  resolved `spec` rather than the full registry — `spec` here already is
   *  `instruments[section.registryKey]`. */
  function optionsForItem(it: Item | undefined): Option[] {
    if (!it) return [];
    if (spec?.option_sets && it.kind) return spec.option_sets[it.kind] ?? [];
    return spec?.options ?? [];
  }

  const options = item && !isVas ? optionsForItem(item) : [];
  // Most instruments here have a handful of options and read best as a
  // vertical list of full-width buttons. The TFI's 11-point 0-10/percentage
  // scales are the exception — a wrapping horizontal row of compact buttons
  // is the usable layout for that many choices, on a phone screen especially.
  const wrapOptions = options.length > 6;
  // Progress against the 5 *displayed* ISI questions, not its 7 underlying
  // components — a page counts once every row on it is answered.
  const answeredPages = pages.filter((p) => p.every((it) => answers[it.id] !== undefined)).length;

  if (showIntro) {
    return (
      <Panel title={section.instrumentAbbrev} bracketed>
        <div className="stack stack-4">
          <p style={{ fontSize: "var(--fs-body)", lineHeight: 1.6, maxWidth: "42em" }}>
            {spec?.instructions}
          </p>
          <p className="meta dim" style={{ margin: 0 }}>
            {t("assessment.module2.introQuestionCount", {
              count: pages.length,
              defaultValue: `${pages.length} questions.`,
            })}
          </p>
          <hr className="rule" />
          <div className="row row--between">
            {allowSkip ? (
              <button type="button" className="btn" onClick={onSkip} disabled={saving}>
                {t("assessment.module2.skip", { defaultValue: `Skip ${section.instrumentAbbrev}` })}
              </button>
            ) : (
              <span />
            )}
            <button type="button" className="btn btn--primary" onClick={() => setShowIntro(false)}>
              {t("assessment.module2.begin", { defaultValue: "Begin" })} →
            </button>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title={`${section.instrumentAbbrev} — ${t("assessment.module2.questionOf", {
        current: index + 1,
        total: pages.length,
        defaultValue: `Question ${index + 1} of ${pages.length}`,
      })}`}
      bracketed
    >
      <div className="stack stack-4">
        <Meter value={answeredPages} max={pages.length || 1} tone="data" />

        {/* Fixed-height content well: switching questions never changes the
            card's height, so the page does not jump or need to scroll to
            follow the next question into view. `key={page[0].id}` remounts
            the fade-in on every question change, matching the fade this app
            already uses for modals — same effect, same duration, reused. */}
        <div
          key={page[0]?.id ?? index}
          className="stack stack-5 fade-in"
          style={{ minHeight: 220, justifyContent: "center" }}
        >
          {page.length === 0 ? null : isVas && item ? (
            <div className="stack stack-3">
              <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "34em" }}>{itemText(t, item)}</p>
              <VasSlider
                item={item}
                value={answers[item.id] ?? 5}
                onChange={(v) => setAnswers((prev) => ({ ...prev, [item.id]: v }))}
              />
              <div className="row row--end">
                <button type="button" className="btn btn--primary" onClick={continueFromSlider} disabled={saving}>
                  {isLast ? (saving ? t("common.saving") : submitLabel) : `${t("common.next")} →`}
                </button>
              </div>
            </div>
          ) : page.length > 1 ? (
            // The ISI's grouped Question 1 — three independently-scored rows,
            // answered together, advancing only once all three are set.
            <div className="stack stack-4">
              {page[0].context && <p className="meta dim">{page[0].context}</p>}
              {page.map((row) => (
                <div key={row.id} className="stack stack-1">
                  <p style={{ fontSize: "var(--fs-body)", fontWeight: 600 }}>{itemText(t, row)}</p>
                  <NumberedScale
                    item={row}
                    options={optionsForItem(row)}
                    value={answers[row.id]}
                    onSelect={(value) => selectGroupedOption(row.id, value)}
                    disabled={saving}
                  />
                </div>
              ))}
            </div>
          ) : item ? (
            <div className="stack stack-3">
              {item.context && <p className="meta dim">{item.context}</p>}
              <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "40em" }}>{itemText(t, item)}</p>
              {isSliderItem(item) ? (
                <TfiSlider item={item} value={answers[item.id]} onCommit={selectOption} disabled={saving} />
              ) : isCompactScaleItem(item) ? (
                <NumberedScale item={item} options={options} value={answers[item.id]} onSelect={selectOption} disabled={saving} />
              ) : (
                <>
                  {(item.low || item.high) && (
                    <div className="row row--between meta" style={{ maxWidth: "40em" }}>
                      <span>{anchorLabel(t, item.low, "")}</span>
                      <span>{anchorLabel(t, item.high, "")}</span>
                    </div>
                  )}
                  <div
                    className={wrapOptions ? "row row--tight" : "stack stack-2"}
                    style={wrapOptions ? { flexWrap: "wrap" } : undefined}
                  >
                    {options.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className="option"
                        aria-pressed={answers[item.id] === option.value}
                        disabled={saving}
                        onClick={() => selectOption(option.value)}
                      >
                        <span>{optionLabel(t, option.label)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>

        <hr className="rule" />

        <div className="row row--between">
          <button type="button" className="btn btn--ghost" onClick={goBack} disabled={isFirst || saving}>
            ← {t("common.back")}
          </button>
          {allowSkip && (
            <button type="button" className="btn" onClick={onSkip} disabled={saving}>
              {t("assessment.module2.skip", { defaultValue: `Skip ${section.instrumentAbbrev}` })}
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}

function VasSlider({ item, value, onChange }: { item: Item; value: number; onChange(v: number): void }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="row row--between" style={{ marginBottom: "var(--s2)" }}>
        <span className="label">{t(`instruments.vasLabels.${item.id}`, { defaultValue: item.label ?? "" })}</span>
        <Chip tone="signal">{value.toFixed(1)} / 10</Chip>
      </div>
      <input
        className="fader"
        type="range"
        min={0}
        max={10}
        step={0.5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="fader-scale">
        <span>{anchorLabel(t, item.low, "0")}</span>
        <span>{anchorLabel(t, item.high, "10")}</span>
      </div>
    </div>
  );
}

/**
 * The TFI's answer control: one 0–100%, 10%-step slider for every item,
 * regardless of the item's underlying scoring scale.
 *
 * `kind === "percent"` items (1, 3) already store 0–100 raw — the slider
 * position *is* the stored value. `kind === "scale10"` items (2, 4–25) store
 * 0–10 raw, the exact value `score_tfi()` already expects — this slider only
 * ever *displays* that as a percentage (raw × 10) and converts back
 * (position ÷ 10, always a whole number since position is always a multiple
 * of 10) before saving. Nothing about the stored answer shape or the backend
 * scoring changes; only how the same 0–10 answer is collected on screen.
 *
 * A native range input fires its change event continuously while dragging,
 * so — unlike a button, where the click *is* the commit — the answer is only
 * saved (and the question only advances) once the interaction actually ends:
 * pointer release, touch release, or a keyboard step. `onChange` alone only
 * updates the visible thumb position. Reading the value from the event's own
 * `currentTarget` at that moment (rather than from React state) means the
 * commit is never one render behind the drag. `committedRef` stops a second,
 * spurious commit some mobile browsers produce by firing a synthetic mouse
 * event after a touch one for the same interaction.
 */
function TfiSlider({
  item,
  value,
  onCommit,
  disabled,
}: {
  item: Item;
  /** The raw stored answer, or `undefined` when this item has no answer yet —
   *  never defaulted to 0, since 0% is itself a legitimate response. */
  value: number | undefined;
  onCommit(rawValue: number): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const toPosition = (raw: number) => (item.kind === "scale10" ? raw * 10 : raw);
  const toRaw = (position: number) => (item.kind === "scale10" ? position / 10 : position);

  const [position, setPosition] = useState(value !== undefined ? toPosition(value) : 0);
  const [touched, setTouched] = useState(value !== undefined);
  const committedRef = useRef(false);

  function commitFromEvent(e: React.SyntheticEvent<HTMLInputElement>) {
    if (committedRef.current) return;
    committedRef.current = true;
    setTouched(true);
    onCommit(toRaw(Number(e.currentTarget.value)));
  }

  return (
    <div className="stack stack-2">
      {(item.low || item.high) && (
        <div className="row row--between meta" style={{ maxWidth: "40em" }}>
          <span>{anchorLabel(t, item.low, "")}</span>
          <span>{anchorLabel(t, item.high, "")}</span>
        </div>
      )}
      <input
        className="fader"
        type="range"
        min={0}
        max={100}
        step={10}
        value={position}
        disabled={disabled}
        aria-label={itemText(t, item)}
        onChange={(e) => {
          setPosition(Number(e.target.value));
          setTouched(true);
        }}
        onMouseUp={commitFromEvent}
        onTouchEnd={commitFromEvent}
        onKeyUp={commitFromEvent}
      />
      <div className="fader-ticks">
        {TFI_TICK_VALUES.map((v) => (
          <span key={v}>{v}%</span>
        ))}
      </div>
      <div className="row row--between row--baseline">
        <span className="label">
          {t("assessment.module2.tfiSelectedLabel", { defaultValue: "Selected answer" })}
        </span>
        <Chip tone={touched ? "signal" : "ghost"}>
          {touched
            ? `${position}%`
            : t("assessment.module2.tfiNotAnswered", { defaultValue: "Move the slider to answer" })}
        </Chip>
      </div>
    </div>
  );
}

/**
 * The ISI's answer control: a compact horizontal row of five small numbered
 * buttons (0–4), each carrying the published form's own descriptive word at
 * that position — never the large full-width option buttons THI/GAD-7/PSS-10
 * use, per the brief's explicit "not TFI-style, not large stacked buttons"
 * requirement. A position with no label (item 2's three middle values, which
 * the published form leaves unlabelled between "Very Satisfied" and "Very
 * Dissatisfied") shows the bare number, matching the paper form exactly
 * rather than inventing a word for it.
 */
function NumberedScale({
  item,
  options,
  value,
  onSelect,
  disabled,
}: {
  item: Item;
  options: Option[];
  value: number | undefined;
  onSelect(value: number): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="numberedscale" role="radiogroup" aria-label={itemText(t, item)}>
      {options.map((option) => {
        const label = optionLabel(t, option.label);
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            className="numberedscale__value"
            aria-checked={value === option.value}
            aria-pressed={value === option.value}
            aria-label={label ? `${option.value} — ${label}` : String(option.value)}
            disabled={disabled}
            onClick={() => onSelect(option.value)}
          >
            <span className="numberedscale__number">{option.value}</span>
            {label && <span className="numberedscale__label">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The pain faces scale, asked once the four tinnitus VAS scales are answered.
 *
 * A step of its own, exactly as the printed scale directs — the patient has
 * just rated their tinnitus four times, and this asks about something else
 * entirely, so putting it on the same page as the fourth scale would read as a
 * fifth one. Nothing about the four scales' answers changes here: they are
 * held by the wizard while this is asked, and submitted together.
 *
 * Unlike a button, a scale has no natural "I'm done" event, so this advances
 * on an explicit Continue — and Continue stays disabled until a rating has
 * actually been chosen, since 0 is a real answer and must never be recorded
 * by default.
 */
function VasPainStep({
  spec,
  value,
  onChange,
  onBack,
  onSubmit,
  submitLabel,
  saving,
}: {
  spec: PainScaleSpec;
  value: number | undefined;
  onChange(value: number): void;
  onBack(): void;
  onSubmit(): void;
  submitLabel: string;
  saving?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Panel
      title={t("assessment.module2.painTitle", { defaultValue: "One more question" })}
      bracketed
    >
      <div className="stack stack-4 fade-in">
        <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "40em" }}>
          {t(`instruments.items.${spec.id}`, { defaultValue: spec.text })}
        </p>

        <PainFaceScale spec={spec} value={value} onChange={onChange} disabled={saving} />

        <hr className="rule" />

        <div className="row row--between">
          <button type="button" className="btn btn--ghost" onClick={onBack} disabled={saving}>
            ← {t("common.back")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={onSubmit}
            disabled={saving || value === undefined}
          >
            {saving ? t("common.saving") : submitLabel}
          </button>
        </div>
      </div>
    </Panel>
  );
}

/**
 * The PHQ-9's separate, non-scored functional-difficulty question — shown
 * once the 9 symptom items are all answered, exactly as the published form
 * presents it after the total-score line, never as the form's "10th
 * question" and never counted in its 0-27 total. Reuses `NumberedScale` so
 * the response control looks the same as the symptom items themselves.
 */
function PhqFunctionalDifficultyStep({
  spec,
  onSelect,
  saving,
}: {
  spec: InstrumentSpec | null;
  onSelect(value: number): void;
  saving?: boolean;
}) {
  const { t } = useTranslation();
  const config = spec?.functional_difficulty;
  const item: Item = { id: "phq9_functional_difficulty", text: config?.text ?? "", kind: "phq9" };
  return (
    <Panel title={t("assessment.module2.phqFunctionalTitle", { defaultValue: "One more question" })} bracketed>
      <div className="stack stack-4">
        <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "40em" }}>
          {t("instruments.items.phq9_functional_difficulty", { defaultValue: config?.text ?? "" })}
        </p>
        <NumberedScale item={item} options={config?.options ?? []} value={undefined} onSelect={onSelect} disabled={saving} />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */
/* The status badge every card shows — text first, never color alone.        */
/* ------------------------------------------------------------------------- */
function StatusBadge({ status }: { status: Module2Status | "unavailable" }) {
  const { t } = useTranslation();
  const config: Record<string, { label: string; tone: "ok" | "signal" | "ghost" | "warn" }> = {
    not_started: { label: t("assessment.module2.statusNotStarted", { defaultValue: "Not started" }), tone: "ghost" },
    in_progress: { label: t("assessment.module2.statusInProgress", { defaultValue: "In progress" }), tone: "signal" },
    completed: { label: t("assessment.module2.statusCompleted", { defaultValue: "Completed" }), tone: "ok" },
    skipped: { label: t("assessment.module2.statusSkipped", { defaultValue: "Skipped" }), tone: "warn" },
    unavailable: { label: t("assessment.module2.statusUnavailable", { defaultValue: "Not available" }), tone: "ghost" },
  };
  const c = config[status] ?? config.not_started;
  return (
    <Chip tone={c.tone}>
      {status === "completed" && <IconCheck size={11} />} {c.label}
    </Chip>
  );
}

/**
 * One assessment card in the Core or Optional menu — category, instrument
 * name, current status, and its action(s). A required (Core) card never
 * offers Skip; an optional one always does unless already skipped or
 * completed. The stub (WHOQOL-BREF) card shows the honest "not yet
 * available" notice directly, in place of any action.
 */
function AssessmentMenuCard({
  section,
  status,
  onOpen,
  onSkip,
}: {
  section: Module2Section;
  status: Module2Status;
  onOpen(): void;
  onSkip(): void;
}) {
  const { t } = useTranslation();

  if (section.kind === "stub") {
    return (
      <div className="stack stack-2" style={{ padding: "var(--s4) 0" }}>
        <div className="row row--between row--baseline">
          <div className="stack stack-1">
            <strong>{section.instrumentAbbrev}</strong>
            <span className="meta">{section.category}</span>
          </div>
          <StatusBadge status="unavailable" />
        </div>
        <p className="meta dim" style={{ margin: 0 }}>
          {t("assessment.module2.stubNotice", {
            defaultValue: `${section.instrumentAbbrev} is not yet available in this system.`,
            instrument: section.instrumentAbbrev,
          })}
        </p>
      </div>
    );
  }

  const startLabel = section.required
    ? t("assessment.module2.start", { defaultValue: "Start" })
    : t("assessment.module2.completeNow", { defaultValue: "Complete now" });
  const continueLabel = t("common.continue", { defaultValue: "Continue" });
  const retakeLabel = t("assessment.module2.viewRetake", { defaultValue: "View / Retake" });
  const skipLabel = t("assessment.module2.skipDoLater", { defaultValue: "Skip / Do later" });

  return (
    <div className="stack stack-3" style={{ padding: "var(--s4) 0" }}>
      <div className="row row--between row--baseline">
        <div className="stack stack-1">
          <span className="row row--tight" style={{ alignItems: "baseline" }}>
            <strong>{section.instrumentAbbrev}</strong>
            {section.required && (
              <Chip tone="signal">{t("assessment.module2.required", { defaultValue: "Required" })}</Chip>
            )}
          </span>
          <span className="meta">{section.category}</span>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="row row--tight">
        <button type="button" className="btn btn--primary btn--sm" onClick={onOpen}>
          {status === "completed"
            ? retakeLabel
            : status === "in_progress"
              ? continueLabel
              : status === "skipped"
                ? t("assessment.module2.completeNow", { defaultValue: "Complete now" })
                : startLabel}
        </button>
        {!section.required && (status === "not_started" || status === "in_progress") && (
          <button type="button" className="btn btn--sm" onClick={onSkip}>
            {skipLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* The two-section "About Your Tinnitus" menu, and the single-instrument     */
/* form each card opens.                                                     */
/* ------------------------------------------------------------------------- */
export default function AboutYourTinnitus({
  instruments,
  initial,
  onSectionSave,
  onAllDone,
}: {
  instruments: Record<string, InstrumentSpec> | null;
  initial: Module2InitialData;
  /** Persists one real section's outcome. `items` is omitted entirely on skip. */
  onSectionSave(
    domainKey: string,
    items: Record<string, number> | undefined,
    status: "in_progress" | "completed" | "skipped"
  ): Promise<void>;
  /** Reachable only once the three Core Tinnitus Assessment instruments are
   *  all `completed` — see `coreComplete` below. */
  onAllDone(): void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Record<string, Module2Status>>(() => {
    const seeded: Record<string, Module2Status> = {};
    for (const s of MODULE2_SECTIONS) {
      const raw = initial.questionnaire_status?.[s.key];
      seeded[s.key] =
        raw === "completed" || raw === "skipped" || raw === "in_progress" ? raw : "not_started";
    }
    return seeded;
  });
  // null = the two-section menu. Otherwise the key of the one instrument
  // currently open — chosen from a card rather than reached by walking a
  // fixed sequence, so a patient can do the eight in any order and return to
  // the menu after each one instead of always advancing to the next.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The PHQ-9's completed 9 symptom answers, held here while the separate
  // functional-difficulty question is asked — never submitted as a 10th
  // scored item, and never counted in the "Question X of 9" progress the
  // guided form already finished showing.
  const [pendingPhq9Answers, setPendingPhq9Answers] = useState<Record<string, number> | null>(null);
  // The four completed tinnitus VAS ratings, held here while the pain faces
  // scale is asked as its own step — the printed scale asks it after the
  // questionnaire above it is finished, and this is that "after". Nothing is
  // saved until both halves are answered, so the section is never recorded as
  // completed with only part of what it asks for.
  //
  // The draft outlives the step deliberately: Back returns to the four scales
  // with what was just entered still on them, rather than remounting the form
  // on whatever was last saved.
  const [vasDraft, setVasDraft] = useState<Record<string, number> | null>(null);
  const [painStepOpen, setPainStepOpen] = useState(false);
  const painSpec = instruments?.vas?.pain_scale;

  const activeSection = activeKey ? MODULE2_SECTIONS.find((s) => s.key === activeKey) : undefined;

  const coreDone = MODULE2_CORE_SECTIONS.filter((s) => status[s.key] === "completed").length;
  const coreComplete = coreDone === MODULE2_CORE_SECTIONS.length;
  const optionalDone = MODULE2_OPTIONAL_SECTIONS.filter((s) => status[s.key] === "completed").length;
  const optionalSkipped = MODULE2_OPTIONAL_SECTIONS.filter((s) => status[s.key] === "skipped").length;

  function returnToMenu() {
    setActiveKey(null);
    setPendingPhq9Answers(null);
    setVasDraft(null);
    setPainStepOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // All three handlers swallow a failed save rather than letting it
  // propagate: the caller (`onSectionSave`) already reports the error to the
  // patient (a toast, in `Assessment.tsx`), and the only thing left to decide
  // here is whether to return to the menu. On failure the answers stay on
  // screen and the section stays open so the patient can retry, instead of
  // silently losing them by moving on regardless.
  async function handleSkip() {
    if (!activeSection) return;
    setSaving(true);
    try {
      await onSectionSave(activeSection.key, undefined, "skipped");
      setStatus((prev) => ({ ...prev, [activeSection.key]: "skipped" }));
      returnToMenu();
    } catch {
      // already reported to the patient by the caller
    } finally {
      setSaving(false);
    }
  }

  /** Saves whatever is answered so far without leaving the section — how a
   *  page-advance mid-questionnaire is recorded as "in_progress", so leaving
   *  and returning later resumes with those answers restored. Runs in the
   *  background: a patient does not wait on this to keep answering, and its
   *  own errors are already toasted by the caller, so nothing here needs to
   *  block navigation on it succeeding.
   *
   *  A no-op while retaking an already-*completed* instrument: an unfinished
   *  retake must not downgrade a genuine completed result to "in progress"
   *  on the record (and so must never fire this save at all — not even with
   *  the answers, since a retake's partial page could otherwise overwrite a
   *  fully answered instrument's items with an incomplete subset if the
   *  patient abandons the retake before resubmitting). */
  function handleProgress(answers: Record<string, number>) {
    if (!activeSection) return;
    const key = activeSection.key;
    if (status[key] === "completed") return;
    setStatus((prev) => ({ ...prev, [key]: "in_progress" }));
    onSectionSave(key, answers, "in_progress").catch(() => {
      // already reported to the patient by the caller
    });
  }

  async function handleSubmit(answers: Record<string, number>) {
    if (!activeSection) return;
    // The PHQ-9 has one more, separate, non-scored question after its 9 —
    // hold the completed symptom answers and ask it before actually saving.
    if (activeSection.key === "phq9" && pendingPhq9Answers === null) {
      setPendingPhq9Answers(answers);
      return;
    }
    // The VAS has the pain faces scale after its four ratings, for the same
    // reason and on the same terms — see `VasPainStep`.
    if (activeSection.key === "vas" && painSpec && !painStepOpen) {
      setVasDraft(answers);
      setPainStepOpen(true);
      return;
    }
    setSaving(true);
    try {
      await onSectionSave(activeSection.key, answers, "completed");
      setStatus((prev) => ({ ...prev, [activeSection.key]: "completed" }));
      returnToMenu();
    } catch {
      // already reported to the patient by the caller
    } finally {
      setSaving(false);
    }
  }

  const initialAnswersFor: Record<string, Record<string, number> | undefined> = {
    // The in-flight draft wins over what was last saved, so returning from the
    // pain step does not discard ratings that have not been saved yet.
    vas: vasDraft ?? (initial.vas as Record<string, number> | undefined),
    thi: initial.thi_items,
    tfi: initial.tfi_items,
    isi: initial.isi_items,
    phq9: initial.phq9_items,
    gad7: initial.gad7_items,
    pss10: initial.pss10_items,
    whoqol_bref: initial.whoqol_bref_items,
  };

  /* -------------------------------------------------------------------- */
  /* One instrument open — the exact same single-instrument form the old   */
  /* linear flow used, just entered from a card instead of "Next".         */
  /* -------------------------------------------------------------------- */
  if (activeSection) {
    return (
      <div className="stack stack-5">
        <button type="button" className="btn btn--ghost btn--sm" onClick={returnToMenu} disabled={saving}>
          ← {t("assessment.module2.backToOverview", { defaultValue: "Back to overview" })}
        </button>

        <Panel tight tone="sunken">
          <div className="row row--between row--baseline">
            <span className="label label--signal">{activeSection.category}</span>
            {activeSection.required && (
              <Chip tone="signal">{t("assessment.module2.required", { defaultValue: "Required" })}</Chip>
            )}
          </div>
        </Panel>

        {activeSection.key === "vas" && painSpec && painStepOpen ? (
          <VasPainStep
            spec={painSpec}
            value={vasDraft?.[painSpec.id]}
            onChange={(v) => setVasDraft((prev) => ({ ...(prev ?? {}), [painSpec.id]: v }))}
            onBack={() => setPainStepOpen(false)}
            onSubmit={() => handleSubmit(vasDraft ?? {})}
            submitLabel={t("assessment.module2.finish", { defaultValue: "Finish" })}
            saving={saving}
          />
        ) : activeSection.key === "phq9" && pendingPhq9Answers !== null ? (
          <PhqFunctionalDifficultyStep
            spec={instruments?.phq9 ?? null}
            saving={saving}
            onSelect={(value) => handleSubmit({ ...pendingPhq9Answers, phq9_functional_difficulty: value })}
          />
        ) : (
          <InstrumentSectionForm
            key={activeSection.key}
            section={activeSection}
            instruments={instruments}
            initialAnswers={initialAnswersFor[activeSection.key]}
            // Back out of the pain scale returns to the fourth VAS rating, not
            // to the first: the patient's place in the section is where they
            // left it, and re-walking three answered questions to get back to
            // the trailing one is not a Back button.
            startAtLastPage={activeSection.key === "vas" && vasDraft !== null}
            onSkip={handleSkip}
            onSubmit={handleSubmit}
            onProgress={handleProgress}
            submitLabel={t("assessment.module2.finish", { defaultValue: "Finish" })}
            saving={saving}
            oneAtATime
            allowSkip={!activeSection.required}
          />
        )}
      </div>
    );
  }

  /* -------------------------------------------------------------------- */
  /* The menu: Core Tinnitus Assessment, then Optional Wellbeing Assessment. */
  /* -------------------------------------------------------------------- */
  return (
    <div className="stack stack-5">
      <p className="lead" style={{ fontSize: "var(--fs-body)", maxWidth: "48em" }}>
        {t("assessment.module2.intro", {
          defaultValue:
            "About Your Tinnitus is in two parts: a required Core Tinnitus Assessment, and an Optional Wellbeing Assessment covering sleep, anxiety, mood, stress, and quality of life.",
        })}
      </p>

      <Panel
        bracketed
        title={t("assessment.module2.coreTitle", { defaultValue: "Core Tinnitus Assessment" })}
        aside={<Chip tone="signal">{t("assessment.module2.required", { defaultValue: "Required" })}</Chip>}
      >
        <div className="stack stack-4">
          <p className="meta" style={{ margin: 0 }}>
            {t("assessment.module2.coreBody", {
              defaultValue: "These assessments establish your basic tinnitus profile.",
            })}
          </p>
          <div className="stack stack-1">
            {MODULE2_CORE_SECTIONS.map((s, i) => (
              <div key={s.key} style={i > 0 ? { borderTop: "1px solid var(--rule, #2a2f37)" } : undefined}>
                <AssessmentMenuCard
                  section={s}
                  status={status[s.key]}
                  onOpen={() => setActiveKey(s.key)}
                  onSkip={() => {}}
                />
              </div>
            ))}
          </div>
          <hr className="rule rule--tight" />
          <p className="meta" style={{ margin: 0, fontWeight: coreComplete ? 700 : 400 }}>
            {coreComplete
              ? t("assessment.module2.coreComplete", { defaultValue: "Core tinnitus profile complete." })
              : t("assessment.module2.coreIncomplete", {
                  count: coreDone,
                  total: MODULE2_CORE_SECTIONS.length,
                  defaultValue: `Core tinnitus profile incomplete (${coreDone} / ${MODULE2_CORE_SECTIONS.length} complete).`,
                })}
          </p>
        </div>
      </Panel>

      <Panel
        bracketed
        title={t("assessment.module2.optionalTitle", { defaultValue: "Optional Wellbeing Assessment" })}
        aside={<Chip tone="ghost">{t("assessment.module2.optional", { defaultValue: "Optional" })}</Chip>}
      >
        <div className="stack stack-4">
          <p className="meta" style={{ margin: 0 }}>
            {t("assessment.module2.optionalBody", {
              defaultValue:
                "These assessments provide additional information about sleep, anxiety, mood, stress, and quality of life. Complete them now, or skip and do them later — none of these are required to continue.",
            })}
          </p>
          <div className="stack stack-1">
            {MODULE2_OPTIONAL_SECTIONS.map((s, i) => (
              <div key={s.key} style={i > 0 ? { borderTop: "1px solid var(--rule, #2a2f37)" } : undefined}>
                <AssessmentMenuCard
                  section={s}
                  status={status[s.key]}
                  onOpen={() => setActiveKey(s.key)}
                  onSkip={async () => {
                    setSaving(true);
                    try {
                      await onSectionSave(s.key, undefined, "skipped");
                      setStatus((prev) => ({ ...prev, [s.key]: "skipped" }));
                    } catch {
                      // already reported to the patient by the caller
                    } finally {
                      setSaving(false);
                    }
                  }}
                />
              </div>
            ))}
          </div>
          <hr className="rule rule--tight" />
          <p className="meta" style={{ margin: 0 }}>
            {t("assessment.module2.optionalProgress", {
              done: optionalDone,
              total: MODULE2_OPTIONAL_SECTIONS.length,
              skipped: optionalSkipped,
              defaultValue: `Optional: ${optionalDone} / ${MODULE2_OPTIONAL_SECTIONS.length} complete, ${optionalSkipped} / ${MODULE2_OPTIONAL_SECTIONS.length} skipped.`,
            })}
          </p>
        </div>
      </Panel>

      <div className="stack stack-2">
        <div className="row row--end">
          <button type="button" className="btn btn--primary" onClick={onAllDone} disabled={!coreComplete}>
            {t("assessment.module2.continueToHearing", { defaultValue: "Continue" })} →
          </button>
        </div>
        {!coreComplete && (
          <p className="meta dim" style={{ textAlign: "right" }}>
            {t("assessment.module2.continueBlocked", {
              defaultValue: "Complete VAS, THI and TFI to continue — optional assessments do not block this.",
            })}
          </p>
        )}
      </div>
    </div>
  );
}

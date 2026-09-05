/**
 * "About Your Tinnitus" — Module 2.
 *
 * Replaces the old two-instrument questionnaire step (VAS + THI-5) and the old
 * separate "Sleep, mood and stress" step. Neither of those exists as a
 * standalone module any more: this is the one place all eight tinnitus-related
 * result categories are administered, in a fixed clinical order, each with its
 * own explicit Skip.
 *
 * Four of the eight have real, validated item content already in this codebase
 * and are administered in full, directly (not as short-form screeners that
 * later escalate): VAS, THI (the full 25-item form — see `long_form_items` on
 * the registry's `thi` entry), GAD-7, PSS-10. The other four — TFI, ISI, PHQ-9,
 * EQ-5D-5L — have no validated item content anywhere in this codebase. Rather
 * than invent, approximate, or silently fabricate one, those sections show an
 * honest "not yet available" notice and carry no Skip (skipping implies
 * declining something real) and no score.
 *
 * Every real section is a single page showing every item and every response
 * option at once — never a bare heading — with Skip and Next/Continue. A
 * skipped section is saved through `onSectionSave` as
 * `questionnaire_status[key] = "skipped"` and posts no item answers, so
 * `rescore()` on the server leaves that instrument's score `null` rather than
 * fabricating a zero.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chip, Loading, Meter, Panel } from "../../components/ui";
import { IconCheck } from "../../components/icons";
import {
  anchorLabel,
  instrumentName,
  itemText,
  optionLabel,
  type InstrumentSpec,
  type Item,
} from "./Questionnaires";

export type Module2Status = "not_started" | "completed" | "skipped";

export interface Module2Section {
  key: string;
  category: string;
  instrumentAbbrev: string;
  instrumentFullName: string;
  kind: "real" | "stub";
  /** Key into the `/api/assessments/instruments` registry, for real sections. */
  registryKey?: string;
}

/**
 * The eight result categories, in the fixed clinical order the product
 * specification requires. This is the frontend twin of
 * `backend/api/views.py::MODULE2_DOMAINS` — the two lists must name the same
 * eight keys in the same order, since the Results page matches them up by key.
 */
export const MODULE2_SECTIONS: Module2Section[] = [
  { key: "vas", category: "Tinnitus Severity", instrumentAbbrev: "VAS / NRS", instrumentFullName: "Visual Analogue / Numeric Rating Scales", kind: "real", registryKey: "vas" },
  { key: "thi", category: "Tinnitus Handicap", instrumentAbbrev: "THI", instrumentFullName: "Tinnitus Handicap Inventory", kind: "real", registryKey: "thi" },
  { key: "tfi", category: "Tinnitus Functional Impact", instrumentAbbrev: "TFI", instrumentFullName: "Tinnitus Functional Index", kind: "stub" },
  { key: "isi", category: "Sleep & Insomnia", instrumentAbbrev: "ISI", instrumentFullName: "Insomnia Severity Index", kind: "stub" },
  { key: "gad7", category: "Anxiety", instrumentAbbrev: "GAD-7", instrumentFullName: "Generalised Anxiety Disorder 7-item scale", kind: "real", registryKey: "gad7" },
  { key: "phq9", category: "Mood / Depression", instrumentAbbrev: "PHQ-9", instrumentFullName: "Patient Health Questionnaire-9", kind: "stub" },
  { key: "pss10", category: "Perceived Stress", instrumentAbbrev: "PSS", instrumentFullName: "Perceived Stress Scale", kind: "real", registryKey: "pss10" },
  { key: "eq5d5l", category: "Health-Related Quality of Life", instrumentAbbrev: "EQ-5D-5L", instrumentFullName: "EuroQol 5-Dimension 5-Level scale", kind: "stub" },
];

export interface Module2InitialData {
  vas?: Record<string, number>;
  thi_items?: Record<string, number>;
  gad7_items?: Record<string, number>;
  pss10_items?: Record<string, number>;
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
  submitLabel,
  saving,
  oneAtATime,
}: {
  section: Module2Section;
  instruments: Record<string, InstrumentSpec> | null;
  initialAnswers?: Record<string, number>;
  onSkip(): void;
  onSubmit(answers: Record<string, number>): void;
  submitLabel: string;
  saving?: boolean;
  /** Guided, one-question-at-a-time presentation — used only by the Module 2
   *  wizard (`AboutYourTinnitus`). Defaults to the original all-items-on-one-
   *  page layout, which the Results page's "Complete a skipped instrument"
   *  modal still uses unchanged, so this is opt-in rather than a global
   *  behaviour change to a component more than one screen renders. */
  oneAtATime?: boolean;
}) {
  const { t } = useTranslation();
  const spec = section.registryKey ? instruments?.[section.registryKey] : null;
  const items = useMemo(() => itemsForRealSection(section, instruments), [section, instruments]);
  const [answers, setAnswers] = useState<Record<string, number>>({ ...(initialAnswers ?? {}) });

  if (!instruments) return <Loading label={t("questionnaires.loading")} />;

  const isVas = section.key === "vas";
  const answeredCount = Object.keys(answers).length;
  const allAnswered = items.length > 0 && answeredCount >= items.length;

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
        submitLabel={submitLabel}
        saving={saving}
        isVas={isVas}
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
            {items.map((item, n) => {
              const options = spec?.options ?? [];
              return (
                <div key={item.id} className="stack stack-2">
                  <p style={{ fontSize: "var(--fs-body)", lineHeight: 1.5, maxWidth: "40em" }}>
                    <span className="meta" style={{ marginRight: "var(--s2)" }}>
                      {n + 1}.
                    </span>
                    {itemText(t, item)}
                  </p>
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
                </div>
              );
            })}
          </div>
        )}

        <hr className="rule" />

        <div className="row row--between">
          <button type="button" className="btn" onClick={onSkip} disabled={saving}>
            {t("assessment.module2.skip", { defaultValue: `Skip ${section.instrumentAbbrev}` })}
          </button>
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
            {t("assessment.module2.answerAll", {
              defaultValue: "Answer every item to continue, or choose Skip.",
            })}
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
  submitLabel,
  saving,
  isVas,
}: {
  section: Module2Section;
  spec: InstrumentSpec | null | undefined;
  items: Item[];
  answers: Record<string, number>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  onSkip(): void;
  onSubmit(answers: Record<string, number>): void;
  submitLabel: string;
  saving?: boolean;
  isVas: boolean;
}) {
  const { t } = useTranslation();
  // How far the patient has *reached*, distinct from how many items are
  // answered — going back and changing an earlier answer must not shrink the
  // set of questions Back can reach.
  const [index, setIndex] = useState(0);
  const item = items[index];
  const isLast = index === items.length - 1;
  const isFirst = index === 0;

  function goBack() {
    if (!isFirst) setIndex((i) => i - 1);
  }

  function advanceOrSubmit(nextAnswers: Record<string, number>) {
    if (isLast) onSubmit(nextAnswers);
    else setIndex((i) => i + 1);
  }

  /** Single-select items advance immediately on selection — no separate
   *  Continue press for the ordinary case, per the guided-questionnaire brief. */
  function selectOption(value: number) {
    const next = { ...answers, [item.id]: value };
    setAnswers(next);
    advanceOrSubmit(next);
  }

  /** A continuous slider has no natural "I'm done" event the way a button
   *  click does, so — like a multi-select or free-text answer — it advances
   *  on an explicit Continue rather than on every drag. */
  function continueFromSlider() {
    advanceOrSubmit(answers);
  }

  const options = !isVas ? spec?.options ?? [] : [];
  const answeredHere = Object.keys(answers).length;

  return (
    <Panel
      title={`${section.instrumentAbbrev} — ${t("assessment.module2.questionOf", {
        current: index + 1,
        total: items.length,
        defaultValue: `Question ${index + 1} of ${items.length}`,
      })}`}
      bracketed
    >
      <div className="stack stack-4">
        <Meter value={answeredHere} max={items.length || 1} tone="data" />

        {/* Fixed-height content well: switching questions never changes the
            card's height, so the page does not jump or need to scroll to
            follow the next question into view. `key={item.id}` remounts the
            fade-in on every question change, matching the fade this app
            already uses for modals — same effect, same duration, reused. */}
        <div
          key={item?.id ?? index}
          className="stack stack-5 fade-in"
          style={{ minHeight: 220, justifyContent: "center" }}
        >
          {!item ? null : isVas ? (
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
          ) : (
            <div className="stack stack-3">
              <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "40em" }}>{itemText(t, item)}</p>
              <div className="stack stack-2">
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
            </div>
          )}
        </div>

        <hr className="rule" />

        <div className="row row--between">
          <button type="button" className="btn btn--ghost" onClick={goBack} disabled={isFirst || saving}>
            ← {t("common.back")}
          </button>
          <button type="button" className="btn" onClick={onSkip} disabled={saving}>
            {t("assessment.module2.skip", { defaultValue: `Skip ${section.instrumentAbbrev}` })}
          </button>
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

/* ------------------------------------------------------------------------- */
/* A stub section: the honest "not yet available" notice.                    */
/* ------------------------------------------------------------------------- */
function StubSection({ section, onNext }: { section: Module2Section; onNext(): void }) {
  const { t } = useTranslation();
  return (
    <Panel title={`${section.instrumentFullName} — ${section.instrumentAbbrev}`} bracketed tone="warn">
      <div className="stack stack-4">
        <p className="lead" style={{ fontSize: "var(--fs-body)" }}>
          {t("assessment.module2.stubNotice", {
            defaultValue: `${section.instrumentAbbrev} is not yet available in this system.`,
            instrument: section.instrumentAbbrev,
          })}
        </p>
        <p className="meta">
          {t("assessment.module2.stubBody", {
            defaultValue:
              "No questions are shown here because this instrument has not been implemented yet. Nothing has been skipped or scored — this result will simply say it is unavailable until it is added.",
          })}
        </p>
        <div className="row row--end">
          <button type="button" className="btn btn--primary" onClick={onNext}>
            {t("common.next")} →
          </button>
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */
/* The eight-section wizard.                                                 */
/* ------------------------------------------------------------------------- */
export default function AboutYourTinnitus({
  instruments,
  initial,
  onSectionSave,
  onAllDone,
  startAt,
}: {
  instruments: Record<string, InstrumentSpec> | null;
  initial: Module2InitialData;
  /** Persists one real section's outcome. `items` is omitted entirely on skip. */
  onSectionSave(domainKey: string, items: Record<string, number> | undefined, status: "completed" | "skipped"): Promise<void>;
  onAllDone(): void;
  /** Jump straight to one section — used when re-entering to complete a single skipped instrument. */
  startAt?: string;
}) {
  const { t } = useTranslation();
  const startIndex = Math.max(0, MODULE2_SECTIONS.findIndex((s) => s.key === startAt));
  const [index, setIndex] = useState(startIndex);
  const [maxVisited, setMaxVisited] = useState(startIndex);
  const [status, setStatus] = useState<Record<string, Module2Status>>(() => {
    const seeded: Record<string, Module2Status> = {};
    for (const s of MODULE2_SECTIONS) {
      const raw = initial.questionnaire_status?.[s.key];
      seeded[s.key] = raw === "completed" || raw === "skipped" ? raw : "not_started";
    }
    return seeded;
  });
  const [saving, setSaving] = useState(false);

  const section = MODULE2_SECTIONS[index];
  const isLast = index === MODULE2_SECTIONS.length - 1;

  function advance() {
    if (isLast) {
      onAllDone();
      return;
    }
    const next = index + 1;
    setIndex(next);
    setMaxVisited((m) => Math.max(m, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Both handlers swallow a failed save rather than letting it propagate: the
  // caller (`onSectionSave`) already reports the error to the patient (a
  // toast, in `Assessment.tsx`), and the only thing left to decide here is
  // whether to advance. On failure the answers stay on screen and the section
  // stays put so the patient can retry, instead of silently losing them by
  // moving on regardless.
  async function handleSkip() {
    setSaving(true);
    try {
      await onSectionSave(section.key, undefined, "skipped");
      setStatus((prev) => ({ ...prev, [section.key]: "skipped" }));
      advance();
    } catch {
      // already reported to the patient by the caller
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(answers: Record<string, number>) {
    setSaving(true);
    try {
      await onSectionSave(section.key, answers, "completed");
      setStatus((prev) => ({ ...prev, [section.key]: "completed" }));
      advance();
    } catch {
      // already reported to the patient by the caller
    } finally {
      setSaving(false);
    }
  }

  const initialAnswersFor: Record<string, Record<string, number> | undefined> = {
    vas: initial.vas as Record<string, number> | undefined,
    thi: initial.thi_items,
    gad7: initial.gad7_items,
    pss10: initial.pss10_items,
  };

  return (
    <div className="stack stack-5">
      <div className="steprail">
        {MODULE2_SECTIONS.map((s, i) => (
          <button
            key={s.key}
            type="button"
            className="steprail__step"
            data-state={i === index ? "active" : status[s.key] === "completed" ? "done" : "todo"}
            disabled={i > maxVisited}
            onClick={() => i <= maxVisited && setIndex(i)}
          >
            <span className="steprail__n">
              {status[s.key] === "completed" ? (
                <IconCheck size={11} />
              ) : status[s.key] === "skipped" ? (
                "—"
              ) : (
                "○"
              )}
            </span>
            <span className="steprail__label">{s.instrumentAbbrev}</span>
          </button>
        ))}
      </div>

      <Panel tight tone="sunken">
        <div className="row row--between row--baseline">
          <span className="label label--signal">{section.category}</span>
          <span className="meta">
            {t("assessment.module2.overallProgress", {
              current: index + 1,
              total: MODULE2_SECTIONS.length,
              defaultValue: `Overall: ${index + 1} of ${MODULE2_SECTIONS.length} questionnaires`,
            })}
          </span>
        </div>
      </Panel>

      {section.kind === "stub" ? (
        <StubSection section={section} onNext={advance} />
      ) : (
        <InstrumentSectionForm
          key={section.key}
          section={section}
          instruments={instruments}
          initialAnswers={initialAnswersFor[section.key]}
          onSkip={handleSkip}
          onSubmit={handleSubmit}
          submitLabel={isLast ? t("assessment.module2.finish", { defaultValue: "Finish" }) : `${t("common.next")} →`}
          saving={saving}
          oneAtATime
        />
      )}
    </div>
  );
}

/**
 * "About Your Tinnitus" — Module 2.
 *
 * Replaces the old two-instrument questionnaire step (VAS + THI-5) and the old
 * separate "Sleep, mood and stress" step. Neither of those exists as a
 * standalone module any more: this is the one place all eight tinnitus-related
 * result categories are administered, in a fixed clinical order, each with its
 * own explicit Skip.
 *
 * Seven of the eight have real, validated item content already in this
 * codebase and are administered in full, directly (not as short-form
 * screeners that later escalate): VAS, THI (the full 25-item form — see
 * `long_form_items` on the registry's `thi` entry), TFI (the full 25-item
 * form, with its own mix of percentage and 0-10 items — see
 * `resolveItemOptions`), ISI (five displayed questions, the first a grouped
 * item with three independently-scored rows — see `groupItemsIntoPages`),
 * GAD-7, PHQ-9 (nine items, plus one separate, non-scored functional-
 * difficulty question — see `PhqFunctionalDifficultyStep`), PSS-10. The
 * remaining one — EQ-5D-5L — has no validated item content anywhere in this
 * codebase. Rather than invent, approximate, or silently fabricate one, that
 * section shows an honest "not yet available" notice and carries no Skip
 * (skipping implies declining something real) and no score.
 *
 * Every real section is a single page showing every item and every response
 * option at once — never a bare heading — with Skip and Next/Continue. A
 * skipped section is saved through `onSectionSave` as
 * `questionnaire_status[key] = "skipped"` and posts no item answers, so
 * `rescore()` on the server leaves that instrument's score `null` rather than
 * fabricating a zero.
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
  { key: "tfi", category: "Tinnitus Functional Impact", instrumentAbbrev: "TFI", instrumentFullName: "Tinnitus Functional Index", kind: "real", registryKey: "tfi" },
  { key: "isi", category: "Sleep & Insomnia", instrumentAbbrev: "ISI", instrumentFullName: "Insomnia Severity Index", kind: "real", registryKey: "isi" },
  { key: "gad7", category: "Anxiety", instrumentAbbrev: "GAD-7", instrumentFullName: "Generalised Anxiety Disorder 7-item scale", kind: "real", registryKey: "gad7" },
  { key: "phq9", category: "Mood / Depression", instrumentAbbrev: "PHQ-9", instrumentFullName: "Patient Health Questionnaire-9", kind: "real", registryKey: "phq9" },
  { key: "pss10", category: "Perceived Stress", instrumentAbbrev: "PSS", instrumentFullName: "Perceived Stress Scale", kind: "real", registryKey: "pss10" },
  { key: "eq5d5l", category: "Health-Related Quality of Life", instrumentAbbrev: "EQ-5D-5L", instrumentFullName: "EuroQol 5-Dimension 5-Level scale", kind: "stub" },
];

export interface Module2InitialData {
  vas?: Record<string, number>;
  thi_items?: Record<string, number>;
  tfi_items?: Record<string, number>;
  isi_items?: Record<string, number>;
  phq9_items?: Record<string, number>;
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
  // Pages, not raw items: the ISI's `isi1a`/`isi1b`/`isi1c` share `group:
  // "q1"` and so form one page (the published form's grouped item 1); every
  // other instrument's items have no `group`, so each is still its own page
  // — this is a no-op for everything that predates the ISI.
  const pages = useMemo(() => groupItemsIntoPages(items), [items]);
  // How far the patient has *reached*, distinct from how many pages are
  // answered — going back and changing an earlier answer must not shrink the
  // set of questions Back can reach.
  const [index, setIndex] = useState(0);
  const page = pages[index] ?? [];
  const item = page.length === 1 ? page[0] : undefined;
  const isLast = index === pages.length - 1;
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
  // The PHQ-9's completed 9 symptom answers, held here while the separate
  // functional-difficulty question is asked — never submitted as a 10th
  // scored item, and never counted in the "Question X of 9" progress the
  // guided form already finished showing.
  const [pendingPhq9Answers, setPendingPhq9Answers] = useState<Record<string, number> | null>(null);

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
    // The PHQ-9 has one more, separate, non-scored question after its 9 —
    // hold the completed symptom answers and ask it before actually saving.
    if (section.key === "phq9" && pendingPhq9Answers === null) {
      setPendingPhq9Answers(answers);
      return;
    }
    setSaving(true);
    try {
      await onSectionSave(section.key, answers, "completed");
      setStatus((prev) => ({ ...prev, [section.key]: "completed" }));
      setPendingPhq9Answers(null);
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
    tfi: initial.tfi_items,
    isi: initial.isi_items,
    phq9: initial.phq9_items,
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
      ) : section.key === "phq9" && pendingPhq9Answers !== null ? (
        <PhqFunctionalDifficultyStep
          spec={instruments?.phq9 ?? null}
          saving={saving}
          onSelect={(value) =>
            handleSubmit({ ...pendingPhq9Answers, phq9_functional_difficulty: value })
          }
        />
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

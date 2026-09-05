/**
 * Generic renderer for the extended About You questionnaire.
 *
 * One component draws every section in `aboutYouQuestions.ts` from its data —
 * single-choice, multi-select, 0–10 scale, text, textarea and the medication
 * repeater — rather than 70 bespoke question components. Fully controlled: it
 * owns no state of its own, reading `answers` and reporting every change
 * through `onAnswer`, so `Assessment.tsx` remains the one place that knows
 * about saving, hydration and submission.
 *
 * Built entirely from existing primitives — `Panel`, `Fader`, `Chip`, the
 * `.option`/`.textarea`/`.input` classes the rest of the app already uses —
 * so this reads as the same interface, not a second design language.
 */

import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Fader, Panel } from "../../components/ui";
import { IconCheck } from "../../components/icons";
import {
  type AboutYouAnswer,
  type AboutYouAnswers,
  type AboutYouQuestion,
  type AboutYouSection,
  type MedicationEntry,
} from "./aboutYouQuestions";

/** Every string shown to the reader goes through this: English source, `t()` looked up under a stable key. */
function useAboutYouText() {
  const { t } = useTranslation();
  return (key: string, fallback: string) => t(`assessment.aboutYou.text.${key}`, { defaultValue: fallback });
}

/** A slug safe to use inside an i18n key, from a question key plus its own English text. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function AboutYouExtended({
  sections,
  answers,
  onAnswer,
}: {
  sections: AboutYouSection[];
  answers: AboutYouAnswers;
  onAnswer(key: string, value: AboutYouAnswer): void;
}) {
  const tx = useAboutYouText();
  return (
    <div className="stack stack-5">
      {sections.map((section) => (
        <Panel key={section.id} title={tx(`section.${section.id}.title`, section.title)} bracketed>
          <div className="stack stack-4">
            {section.intro && <p className="meta">{tx(`section.${section.id}.intro`, section.intro)}</p>}
            {section.questions.map((q) => {
              if (q.visibleIf && !q.visibleIf(answers)) return null;
              return (
                <QuestionField
                  key={q.key}
                  question={q}
                  value={answers[q.key]}
                  otherValue={answers[`${q.key}__other`] as string | undefined}
                  onChange={(v) => onAnswer(q.key, v)}
                  onOtherChange={(v) => onAnswer(`${q.key}__other`, v)}
                  tx={tx}
                />
              );
            })}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function QuestionField({
  question,
  value,
  otherValue,
  onChange,
  onOtherChange,
  tx,
}: {
  question: AboutYouQuestion;
  value: AboutYouAnswer;
  otherValue: string | undefined;
  onChange(value: AboutYouAnswer): void;
  onOtherChange(value: string): void;
  tx(key: string, fallback: string): string;
}) {
  const promptKey = `question.${slug(question.key)}`;
  const prompt = tx(promptKey, question.prompt);

  return (
    <div className="stack stack-2">
      <span className="label">
        {prompt}
        {question.optional && <span className="meta"> {tx("optionalSuffix", "(optional)")}</span>}
      </span>

      {question.type === "single" && (
        <SingleSelect question={question} value={value as string | undefined} onChange={onChange} tx={tx} />
      )}

      {question.type === "multi" && (
        <MultiSelect question={question} value={(value as string[] | undefined) ?? []} onChange={onChange} tx={tx} />
      )}

      {question.type === "scale" && (
        <Fader
          value={typeof value === "number" ? value : 0}
          min={0}
          max={10}
          step={1}
          onChange={(v) => onChange(v)}
          lowLabel={question.scaleLabels ? tx(`${promptKey}.low`, question.scaleLabels.low) : "0"}
          highLabel={question.scaleLabels ? tx(`${promptKey}.high`, question.scaleLabels.high) : "10"}
          tone="data"
        />
      )}

      {question.type === "text" && (
        <input
          className="input"
          type="text"
          value={(value as string | undefined) ?? ""}
          placeholder={question.placeholder ? tx(`${promptKey}.placeholder`, question.placeholder) : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {question.type === "textarea" && (
        <textarea
          className="textarea"
          value={(value as string | undefined) ?? ""}
          placeholder={question.placeholder ? tx(`${promptKey}.placeholder`, question.placeholder) : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {question.type === "medications" && (
        <MedicationRepeater
          entries={(value as MedicationEntry[] | undefined) ?? []}
          onChange={onChange}
          tx={tx}
        />
      )}

      {/* "Other" free text — single-select shows it when the chosen value is the
          flagged option; multi-select shows it when that option is among the
          selected ones. Keyed as `${key}__other` in the answers map. */}
      {question.options?.some((o) => o.other) &&
        (question.type === "single"
          ? value === question.options.find((o) => o.other)?.value
          : Array.isArray(value) &&
            // Only single/multi questions ever declare an `other` option, so a
            // multi-select's value here is always `string[]` — the assertion
            // narrows past `AboutYouAnswer`'s other array member, `MedicationEntry[]`,
            // which `.includes` cannot be called against with a string.
            (value as string[]).includes(question.options.find((o) => o.other)?.value ?? "")) && (
          <input
            className="input"
            type="text"
            value={otherValue ?? ""}
            placeholder={tx("otherPlaceholder", "Please specify")}
            onChange={(e) => onOtherChange(e.target.value)}
          />
        )}

      {question.note && (
        <Panel tone={question.noteTone === "warn" ? "warn" : "info"} tight>
          <p className="meta" style={{ margin: 0 }}>
            {tx(`${promptKey}.note`, question.note)}
          </p>
        </Panel>
      )}
    </div>
  );
}

function SingleSelect({
  question,
  value,
  onChange,
  tx,
}: {
  question: AboutYouQuestion;
  value: string | undefined;
  onChange(value: string): void;
  tx(key: string, fallback: string): string;
}) {
  const promptKey = `question.${slug(question.key)}`;
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--s2)" }}>
      {question.options?.map((option) => (
        <button
          key={option.value}
          type="button"
          className="option"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <span style={{ minWidth: 0 }}>{tx(`${promptKey}.option.${slug(option.value)}`, option.value)}</span>
        </button>
      ))}
    </div>
  );
}

function MultiSelect({
  question,
  value,
  onChange,
  tx,
}: {
  question: AboutYouQuestion;
  value: string[];
  onChange(value: string[]): void;
  tx(key: string, fallback: string): string;
}) {
  const promptKey = `question.${slug(question.key)}`;

  function toggle(option: { value: string; exclusive?: boolean }) {
    const selected = value.includes(option.value);
    if (option.exclusive) {
      // "I'm not sure" / "None of these" / "No identifiable event" describe the
      // absence of a specific answer, so picking one clears every other
      // selection and picking anything else clears it straight back out —
      // the two states cannot coexist without contradicting each other.
      onChange(selected ? [] : [option.value]);
      return;
    }
    const withoutExclusives = value.filter((v) => !question.options?.find((o) => o.value === v)?.exclusive);
    onChange(selected ? withoutExclusives.filter((v) => v !== option.value) : [...withoutExclusives, option.value]);
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--s2)" }}>
      {question.options?.map((option) => {
        const selected = value.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className="option"
            aria-pressed={selected}
            onClick={() => toggle(option)}
          >
            <span className="row row--tight row--nowrap" style={{ minWidth: 0 }}>
              {selected && <IconCheck size={13} />}
              <span style={{ minWidth: 0 }}>{tx(`${promptKey}.option.${slug(option.value)}`, option.value)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Section 18's repeatable medication entries: name, dose, how often, add/remove. */
function MedicationRepeater({
  entries,
  onChange,
  tx,
}: {
  entries: MedicationEntry[];
  onChange(value: MedicationEntry[]): void;
  tx(key: string, fallback: string): string;
}) {
  function update(index: number, patch: Partial<MedicationEntry>) {
    onChange(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }
  function remove(index: number) {
    onChange(entries.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...entries, { name: "", dose: "", frequency: "" }]);
  }

  return (
    <div className="stack stack-3">
      {entries.map((entry, i) => (
        <Fragment key={i}>
          <div
            className="grid"
            style={{ gridTemplateColumns: "2fr 1fr 1.4fr auto", gap: "var(--s2)", alignItems: "end" }}
          >
            <label className="stack stack-1">
              <span className="meta">{tx("medications.name", "Medication name")}</span>
              <input
                className="input"
                type="text"
                value={entry.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </label>
            <label className="stack stack-1">
              <span className="meta">{tx("medications.dose", "Dose")}</span>
              <input
                className="input"
                type="text"
                value={entry.dose}
                onChange={(e) => update(i, { dose: e.target.value })}
              />
            </label>
            <label className="stack stack-1">
              <span className="meta">{tx("medications.frequency", "How often")}</span>
              <input
                className="input"
                type="text"
                value={entry.frequency}
                onChange={(e) => update(i, { frequency: e.target.value })}
              />
            </label>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(i)}>
              {tx("medications.remove", "Remove")}
            </button>
          </div>
        </Fragment>
      ))}
      <button type="button" className="btn btn--sm" onClick={add} style={{ alignSelf: "flex-start" }}>
        {tx("medications.add", "Add another medication")}
      </button>
    </div>
  );
}

export default AboutYouExtended;

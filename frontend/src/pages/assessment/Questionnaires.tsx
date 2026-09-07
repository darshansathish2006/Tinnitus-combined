/**
 * Validated questionnaire runner, stepped.
 *
 * Everyone completes a **core battery of 18 items**: THI-5, four VAS scales,
 * GAD-2, PHQ-2, PSS-4 and one sleep-interference item. The long forms (GAD-7,
 * PSS-10, PSQI) are *offered* when their screener is positive.
 *
 * Two things about the long forms are deliberate:
 *
 *  - **They only ask what the screener has not.** The GAD-2 is literally the
 *    first two GAD-7 items and the PSS-4 is four of the PSS-10 items, so the
 *    escalations add 5 and 6 questions rather than re-asking 7 and 10. Putting
 *    the identical question to a patient twice in one sitting is the fastest way
 *    to teach them the instrument is not being read.
 *  - **They can be deferred.** A recommended long form the patient declines is
 *    recorded on the assessment as recommended-and-deferred, so the clinician
 *    sees an outstanding recommendation rather than a silent absence. Nothing is
 *    extrapolated to fill the gap: the long-form score simply stays null and the
 *    models handle that natively.
 *
 * Item banks and cut-points come from `/api/assessments/instruments`, so the
 * questionnaire shown and the algorithm that scores it can never drift apart.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Chip, Kbd, Loading, Meter, Panel, Readout, useHotkey } from "../../components/ui";
import { IconCheck, IconInfo } from "../../components/icons";

/* ------------------------------------------------------------------------- */
/* Translating the item bank                                                  */
/* ------------------------------------------------------------------------- */
/**
 * Item banks arrive from `/api/assessments/instruments` in English, because the
 * server is the single source of truth for *which* items exist and how they are
 * scored — that is what stops the questionnaire on screen and the algorithm
 * that scores it from drifting apart.
 *
 * Translation is therefore layered on top by **item id**, never by matching the
 * English text. `thi7` is the seventh THI item in every language; its wording is
 * looked up under `instruments.items.thi7`. Three consequences follow, all of
 * them intended:
 *
 *  - The scoring contract is untouched. The client still posts `{"thi7": 4}`.
 *  - An item the server adds before this client has been translated falls back
 *    to the English the API sent, rather than rendering a raw key at a patient.
 *  - The translations are *clinical adaptations, not literal translations*. The
 *    GAD-7 stem "Feeling nervous, anxious or on edge" is rendered with the
 *    idiom a Tamil or Hindi speaker would actually use for that symptom, since a
 *    word-by-word rendering changes what is being screened for.
 */
export function itemText(t: TFunction, item: Item): string {
  return t(`instruments.items.${item.id}`, { defaultValue: item.prompt ?? item.text });
}

export function optionLabel(t: TFunction, label: string): string {
  return t(`instruments.options.${label}`, { defaultValue: label });
}

export function instrumentName(t: TFunction, key: string, spec?: InstrumentSpec | null): string {
  return t(`instruments.names.${key}`, { defaultValue: spec?.name ?? key });
}

/** VAS anchors ("Silent" … "Extremely loud") are keyed by their English text. */
export function anchorLabel(t: TFunction, label: string | undefined, fallback: string): string {
  if (!label) return fallback;
  return t(`instruments.vasAnchors.${label}`, { defaultValue: label });
}

/**
 * Which response options apply to one item.
 *
 * Almost every instrument shares one option set across all its items (THI's
 * No/Sometimes/Yes, GAD-7's four-point frequency scale, ...). A few — PSQI,
 * and now the TFI — mix response types within the same instrument (a time,
 * a duration in minutes, a 0-3 frequency; or the TFI's percentage items
 * alongside its 0-10 items), so `option_sets` on the registry entry maps each
 * item's own `kind` to its options, and this is checked first. Falls back to
 * the instrument's single shared `options` list otherwise — unchanged
 * behaviour for every instrument that has never needed `kind`/`option_sets`.
 */
export function resolveItemOptions(
  instruments: Record<string, InstrumentSpec> | null | undefined,
  instrumentKey: string,
  item: Item
): Option[] {
  const instrument = instruments?.[instrumentKey];
  if (!instrument) return [];
  if (instrument.option_sets && item.kind) return instrument.option_sets[item.kind] ?? [];
  return instrument.options ?? [];
}

export interface Option {
  label: string;
  value: number;
}

export interface Item {
  id: string;
  text: string;
  kind?: string;
  unit?: string;
  prompt?: string;
  label?: string;
  low?: string;
  high?: string;
  /** A shared instruction line the paper form prints once above a group of
   *  items (e.g. the TFI's "Over the PAST WEEK..." headers) — repeated here
   *  per item so it is not lost when items are shown one at a time. */
  context?: string;
  /** Marks items that belong together as one displayed/navigated question —
   *  e.g. the ISI's grouped item 1, where `isi1a`/`isi1b`/`isi1c` all carry
   *  `group: "q1"`. Consecutive items sharing a `group` are shown and
   *  answered together; see `AboutYourTinnitus.tsx::groupItemsIntoPages`.
   *  Absent (the default) means the item is its own page, unchanged from
   *  every instrument that predates this field. */
  group?: string;
}

/** One step of the printed pain scale's verbal scale, with its ADL correlation. */
export interface PainScaleBand {
  key: string;
  min: number;
  max: number;
  label: string;
  impact: string;
}

/**
 * The 0-10 pain faces scale carried on the VAS registry entry — the printed
 * Visual Analogue pain scale, asked as its own question after the four
 * tinnitus VAS scales and never one of them. Rendered by `PainFaceScale`.
 */
export interface PainScaleSpec {
  id: string;
  text: string;
  help?: string;
  low: string;
  mid?: string;
  high: string;
  min: number;
  max: number;
  step: number;
  /** The positions the printed scale draws a face at (0, 2, 4, 6, 8, 10). */
  face_values: number[];
  bands: PainScaleBand[];
}

export interface InstrumentSpec {
  name: string;
  abbrev: string;
  citation: string;
  items: Item[];
  options?: Option[];
  option_sets?: Record<string, Option[]>;
  max_score: number;
  cutoff?: number;
  escalates_to?: string;
  /** Set on a long form whose screener already asked some of its items. */
  screener_key?: string;
  /** The full published item bank, for instruments the client also has a short form of (THI). */
  long_form_items?: Item[];
  /** The PHQ-9's separate, non-scored functional-difficulty item — never one
   *  of `items`, never part of the 0-27 total. */
  functional_difficulty?: { text: string; options: Option[] };
  /** The VAS entry's separate 0-10 pain faces scale — never one of `items`,
   *  never part of the four tinnitus scales' scoring. */
  pain_scale?: PainScaleSpec;
}

export interface QuestionnaireResult {
  thi_items: Record<string, number>;
  vas: Record<string, number>;
  gad2_items: Record<string, number>;
  phq2_items: Record<string, number>;
  pss4_items: Record<string, number>;
  sleep_screen_items: Record<string, number>;
  gad7_items: Record<string, number>;
  pss10_items: Record<string, number | string>;
  psqi_items: Record<string, number | string>;
  /** Long forms the patient chose to complete. */
  escalated: string[];
  /** Long forms indicated by a positive screen but deferred by the patient. */
  deferred: string[];
}

/** The battery every patient completes. */
/**
 * The core battery, split into two phases around the hearing measurement.
 *
 * **Phase 1 — describing the tinnitus.** The VAS scales and the THI ask what
 * the percept is like and how much it interferes. They belong before the
 * measurement because they are the patient's account of the thing that is about
 * to be measured, and asking them afterwards contaminates the answers: someone
 * who has just spent ten minutes discovering their tinnitus is only 32 dB does
 * not rate its loudness the way they would have beforehand.
 *
 * **Phase 2 — the comorbidity screeners.** Sleep, anxiety, mood and stress are
 * about the patient rather than the percept, and nothing in the hearing
 * measurement changes how they should be answered. They sit after it so the
 * long, quiet part of the assessment is broken up by the interactive part
 * rather than being eighteen questions in a row.
 */
const PHASE_ONE: string[] = ["vas", "thi"];
const PHASE_TWO: string[] = ["sleep_screen", "gad2", "phq2", "pss4"];
const CORE: string[] = [...PHASE_ONE, ...PHASE_TWO];

/**
 * screener -> the long form it unlocks, and the key naming why it is worth the
 * extra minutes. The reason text is translated at render time under
 * `questionnaires.escalation.*`.
 */
const ESCALATION: Record<string, { to: string; key: string }> = {
  gad2: { to: "gad7", key: "anxiety" },
  pss4: { to: "pss10", key: "stress" },
  sleep_screen: { to: "psqi", key: "sleep" },
};

const PSQI_FREE_FIELDS = new Set([
  "psqi_bedtime", "psqi_waketime", "psqi_latency_min", "psqi_sleep_hours",
]);

/**
 * Reverse-scored items per instrument.
 *
 * The PSS is scored with four items inverted, so a raw sum is not the score.
 * The running-score readout has to apply them or it shows the patient a number
 * that disagrees with the one on their report.
 */
const PSS_REVERSE: Record<string, Set<string>> = {
  pss4: new Set(["pss4", "pss5"]),
  pss10: new Set(["pss4", "pss5", "pss7", "pss8"]),
};

export default function Questionnaires({
  instruments,
  onComplete,
  initial,
  phase = "all",
}: {
  instruments: Record<string, InstrumentSpec> | null;
  onComplete(result: QuestionnaireResult): void;
  initial?: Partial<QuestionnaireResult>;
  /**
   * Which half of the battery to administer. `all` runs both, which is what a
   * caller that has not been split wants and keeps this component usable on its
   * own. Escalations only ever belong to phase two — every screener that can
   * unlock one lives there.
   */
  phase?: "one" | "two" | "all";
}) {
  const { t } = useTranslation();
  const battery =
    phase === "one" ? PHASE_ONE : phase === "two" ? PHASE_TWO : CORE;
  const [answers, setAnswers] = useState<Record<string, Record<string, number | string>>>(() => ({
    thi: { ...(initial?.thi_items ?? {}) },
    vas: { ...(initial?.vas ?? {}) },
    gad2: { ...(initial?.gad2_items ?? {}) },
    phq2: { ...(initial?.phq2_items ?? {}) },
    pss4: { ...(initial?.pss4_items ?? {}) },
    sleep_screen: { ...(initial?.sleep_screen_items ?? {}) },
    gad7: { ...(initial?.gad7_items ?? {}) },
    pss10: { ...(initial?.pss10_items ?? {}) },
    psqi: { ...(initial?.psqi_items ?? {}) },
  }));
  const [current, setCurrent] = useState<string>(
    phase === "two" ? PHASE_TWO[0] : PHASE_ONE[0]
  );
  const [index, setIndex] = useState(0);
  /** Long forms the patient has opted into, and ones they have waved off. */
  const [accepted, setAccepted] = useState<Set<string>>(new Set(initial?.escalated ?? []));
  const [declined, setDeclined] = useState<Set<string>>(new Set(initial?.deferred ?? []));
  const scrollRef = useRef<HTMLDivElement>(null);

  /* -- which items each instrument actually administers --------------------- */
  /**
   * A long form drops the items its screener already covered. This is the whole
   * reason the battery's worst case fell from 73 questions to 66 without losing
   * a single scored response — the screener answers merge into the same item
   * bank server-side, so the full-length score is still computed.
   */
  const itemsFor = useMemo(() => {
    const cache = new Map<string, Item[]>();
    return (key: string): Item[] => {
      if (cache.has(key)) return cache.get(key)!;
      const spec = instruments?.[key];
      let items = spec?.items ?? [];
      const screener = spec?.screener_key ? instruments?.[spec.screener_key] : null;
      if (screener) {
        const covered = new Set(screener.items.map((i) => i.id));
        items = items.filter((i) => !covered.has(i.id));
      }
      cache.set(key, items);
      return items;
    };
  }, [instruments]);

  /* -- scoring -------------------------------------------------------------- */
  const rawSum = (key: string): number =>
    Object.entries(answers[key] ?? {}).reduce<number>((sum, [id, v]) => {
      if (typeof v !== "number") return sum;
      return sum + (PSS_REVERSE[key]?.has(id) ? 4 - v : v);
    }, 0);

  /**
   * What a long form currently scores, including the screener items the patient
   * answered earlier — otherwise the readout would show 6/21 on a completed
   * GAD-7 because only the five incremental items live in its own bucket.
   */
  const runningScore = (key: string): number => {
    const spec = instruments?.[key];
    if (!spec?.screener_key) return rawSum(key);
    const reverse = PSS_REVERSE[key];
    const screenerContribution = Object.entries(answers[spec.screener_key] ?? {}).reduce<number>(
      (sum, [id, v]) => (typeof v === "number" ? sum + (reverse?.has(id) ? 4 - v : v) : sum),
      0
    );
    return rawSum(key) + screenerContribution;
  };

  /* -- which long forms this patient's screeners indicate ------------------- */
  const offers = useMemo(() => {
    const list: { screener: string; to: string; key: string; score: number; cutoff: number }[] = [];
    for (const [screener, rule] of Object.entries(ESCALATION)) {
      // Phase one has no screeners that escalate, and offering a long form on a
      // screen that does not administer its trigger would be incoherent.
      if (!battery.includes(screener)) continue;
      const spec = instruments?.[screener];
      if (!spec) continue;
      const answered = Object.keys(answers[screener] ?? {}).length;
      if (answered < spec.items.length) continue;
      const score = rawSum(screener);
      const cutoff = spec.cutoff ?? 3;
      if (score >= cutoff) list.push({ screener, ...rule, score, cutoff });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, instruments, battery]);

  const unlocked = useMemo(
    () => offers.filter((o) => accepted.has(o.to)).map((o) => o.to),
    [offers, accepted]
  );
  const pendingOffers = useMemo(
    () => offers.filter((o) => !accepted.has(o.to) && !declined.has(o.to)),
    [offers, accepted, declined]
  );
  const sequence = useMemo(() => [...battery, ...unlocked], [battery, unlocked]);

  const spec = instruments?.[current];
  const items = useMemo(() => itemsFor(current), [itemsFor, current]);
  const item = items[index];

  useEffect(() => {
    setIndex(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [current]);

  // A long form the patient is answering can stop being indicated if they go
  // back and change the screener answer. Leaving them stranded on a step that no
  // longer exists in the sequence would be a dead end.
  useEffect(() => {
    if (!sequence.includes(current)) setCurrent(sequence[0]);
  }, [sequence, current]);

  const optionsFor = (instrumentKey: string, currentItem: Item): Option[] =>
    resolveItemOptions(instruments, instrumentKey, currentItem);

  function answer(value: number | string) {
    if (!item) return;
    setAnswers((prev) => ({ ...prev, [current]: { ...prev[current], [item.id]: value } }));
    if (index < items.length - 1) window.setTimeout(() => setIndex((i) => i + 1), 130);
  }

  function acceptOffer(to: string) {
    setAccepted((prev) => new Set(prev).add(to));
    setDeclined((prev) => {
      const next = new Set(prev);
      next.delete(to);
      return next;
    });
    setCurrent(to);
  }

  function declineOffer(to: string) {
    setDeclined((prev) => new Set(prev).add(to));
    setAccepted((prev) => {
      const next = new Set(prev);
      next.delete(to);
      return next;
    });
  }

  const options = item ? optionsFor(current, item) : [];
  const isFreeEntry = current === "psqi" && item && PSQI_FREE_FIELDS.has(item.id);
  const isVas = current === "vas";

  useHotkey("1", () => options[0] && answer(options[0].value), undefined, options.length > 0 && !isFreeEntry);
  useHotkey("2", () => options[1] && answer(options[1].value), undefined, options.length > 1 && !isFreeEntry);
  useHotkey("3", () => options[2] && answer(options[2].value), undefined, options.length > 2 && !isFreeEntry);
  useHotkey("4", () => options[3] && answer(options[3].value), undefined, options.length > 3 && !isFreeEntry);
  useHotkey("5", () => options[4] && answer(options[4].value), undefined, options.length > 4 && !isFreeEntry);
  useHotkey("arrowright", () => setIndex((i) => Math.min(items.length - 1, i + 1)));
  useHotkey("arrowleft", () => setIndex((i) => Math.max(0, i - 1)));

  if (!instruments) return <Loading label={t("questionnaires.loading")} />;

  const progress = sequence.map((key) => {
    const total = itemsFor(key).length;
    const answered = Object.keys(answers[key] ?? {}).length;
    return {
      key,
      answered,
      total,
      complete: total > 0 && answered >= total,
      escalated: !battery.includes(key),
    };
  });

  const coreProgress = progress.filter((p) => !p.escalated);
  const coreDone = coreProgress.every((p) => p.complete);
  const allDone = progress.every((p) => p.complete);
  const totalItems = progress.reduce((sum, p) => sum + p.total, 0);
  const totalAnswered = progress.reduce((sum, p) => sum + Math.min(p.answered, p.total), 0);
  const answeredHere = Object.keys(answers[current] ?? {}).length;
  const optionalRemaining = pendingOffers.reduce((sum, o) => sum + itemsFor(o.to).length, 0);

  function goNext() {
    const position = sequence.indexOf(current);
    const next = sequence[position + 1];
    if (next) setCurrent(next);
  }

  function finish() {
    const numeric = (source: Record<string, number | string>): Record<string, number> =>
      Object.fromEntries(
        Object.entries(source).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, v as number])
      );
    // Only the instruments this phase administered. Posting an empty
    // `gad2_items` from phase one would look identical to a patient answering
    // nothing, and the server merges item banks — an empty merge is harmless,
    // but "we asked and got nothing" and "we did not ask" must stay distinct in
    // the record.
    const inPhase = (key: string) => sequence.includes(key);
    onComplete({
      thi_items: inPhase("thi") ? numeric(answers.thi) : {},
      vas: inPhase("vas") ? numeric(answers.vas) : {},
      gad2_items: inPhase("gad2") ? numeric(answers.gad2) : {},
      phq2_items: inPhase("phq2") ? numeric(answers.phq2) : {},
      pss4_items: inPhase("pss4") ? numeric(answers.pss4) : {},
      sleep_screen_items: inPhase("sleep_screen") ? numeric(answers.sleep_screen) : {},
      // Only the incremental items. The server merges these onto the screener
      // answers already stored in the same item bank, so the long form is scored
      // over its full published item set.
      gad7_items: numeric(answers.gad7),
      pss10_items: numeric(answers.pss10),
      psqi_items: answers.psqi,
      escalated: unlocked,
      deferred: offers.filter((o) => declined.has(o.to)).map((o) => o.to),
    });
  }

  const nextKey = sequence[sequence.indexOf(current) + 1];

  return (
    <div className="stack stack-5">
      {/* -- overall progress ------------------------------------------------ */}
      <Panel tight>
        <div className="row row--between" style={{ marginBottom: "var(--s2)" }}>
          <span className="label">
            {t("questionnaires.questionOf", {
              current: Math.min(totalAnswered + 1, totalItems),
              total: totalItems,
            })}
          </span>
          <span className="meta">
            {t("questionnaires.minutesLeft", {
              minutes: Math.max(1, Math.ceil((totalItems - totalAnswered) / 22)),
            })}
            {optionalRemaining > 0
              ? t("questionnaires.optionalCount", { count: optionalRemaining })
              : ""}
          </span>
        </div>
        <Meter value={totalAnswered} max={totalItems || 1} tone="data" tall />
      </Panel>

      {/* -- optional long forms, offered rather than imposed ----------------- */}
      {coreDone && pendingOffers.length > 0 && (
        <Panel tone="info" title={t("questionnaires.offerTitle")} bracketed>
          <div className="stack stack-4">
            {/* One key with a plural form rather than five inline ternaries.
                English needs two forms here; other languages need different
                ones, and the singular/plural agreement of "questionnaire",
                "is/are" and "it/them" cannot be assembled from fragments
                without hard-coding English grammar into the component. */}
            <p style={{ fontSize: "var(--fs-small)", maxWidth: "68em" }}>
              {t("questionnaires.offerLead", { count: pendingOffers.length })}
            </p>

            <div className="grid grid-auto" style={{ ["--min" as string]: "290px" }}>
              {pendingOffers.map((offer) => {
                const count = itemsFor(offer.to).length;
                return (
                  <Panel key={offer.to} tone="sunken" tight>
                    <div className="stack stack-3">
                      <div className="row row--between row--top">
                        <div className="stack stack-1" style={{ minWidth: 0 }}>
                          <span className="label label--signal">
                            {t(`questionnaires.escalation.${offer.key}`)}
                          </span>
                          <strong style={{ fontSize: "var(--fs-small)" }}>
                            {instrumentName(t, offer.to, instruments[offer.to])}
                          </strong>
                        </div>
                        <Chip tone="ghost">{t("units.questions", { count })}</Chip>
                      </div>
                      <p className="meta">{t(`questionnaires.escalation.${offer.key}Why`)}</p>
                      <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
                        {t("questionnaires.offerScore", {
                          instrument: instruments[offer.screener]?.abbrev ?? offer.screener,
                          score: offer.score,
                          cutoff: offer.cutoff,
                        })}
                      </p>
                      <div className="row row--tight">
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          onClick={() => acceptOffer(offer.to)}
                        >
                          {t("questionnaires.answerThese")}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          onClick={() => declineOffer(offer.to)}
                        >
                          {t("common.notNow")}
                        </button>
                      </div>
                    </div>
                  </Panel>
                );
              })}
            </div>
          </div>
        </Panel>
      )}

      {declined.size > 0 && (
        <Panel tone="warn" tight>
          <div className="row row--tight row--top row--nowrap">
            <IconInfo size={16} style={{ color: "var(--warn-ink)", flex: "none", marginTop: 2 }} />
            <div style={{ minWidth: 0 }}>
              <p className="meta">
                <Trans
                  i18nKey="questionnaires.skipped"
                  components={[<strong key="0" />]}
                  values={{ list: [...declined].map((key) => instruments[key]?.abbrev ?? key).join(", ") }}
                />
              </p>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                style={{ marginTop: "var(--s2)" }}
                onClick={() => setDeclined(new Set())}
              >
                {t("questionnaires.changeMyMind")}
              </button>
            </div>
          </div>
        </Panel>
      )}

      <div className="steprail">
        {progress.map((p) => {
          const instrument = instruments[p.key];
          return (
            <button
              key={p.key}
              type="button"
              className="steprail__step"
              data-state={p.key === current ? "active" : p.complete ? "done" : "todo"}
              onClick={() => setCurrent(p.key)}
              title={p.escalated ? t("questionnaires.escalatedTitle") : undefined}
            >
              <span className="steprail__n">
                {p.answered}/{p.total} {p.complete && <IconCheck size={11} />}
              </span>
              <span className="steprail__label">
                {p.escalated ? "+ " : ""}
                {instrument?.abbrev ?? p.key}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "290px" }}>
        <Panel bracketed>
          <div className="row row--between" style={{ marginBottom: "var(--s4)" }}>
            <div className="stack stack-1">
              <span className="label label--signal">{instrumentName(t, current, spec)}</span>
              <span className="meta">{t(`questionnaires.intro.${current}`, { defaultValue: "" })}</span>
            </div>
            <Chip tone="ghost">
              {Math.min(index + 1, items.length)} / {items.length}
            </Chip>
          </div>

          <Meter value={answeredHere} max={items.length || 1} tone="data" />

          <div ref={scrollRef} className="stack stack-5" style={{ marginTop: "var(--s6)", minHeight: 250 }}>
            {!item ? (
              <p className="meta">{t("questionnaires.noItems")}</p>
            ) : isVas ? (
              <VasItem
                item={item}
                value={(answers.vas[item.id] as number) ?? 5}
                onChange={(value) => setAnswers((p) => ({ ...p, vas: { ...p.vas, [item.id]: value } }))}
              />
            ) : isFreeEntry ? (
              <FreeEntryItem
                item={item}
                value={answers.psqi[item.id]}
                onChange={(value) => setAnswers((p) => ({ ...p, psqi: { ...p.psqi, [item.id]: value } }))}
              />
            ) : (
              <>
                {/* `em` not `ch`: a 48ch measure is tuned to Latin glyph widths
                    and truncates a Tamil question to a narrow column. */}
                <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "34em" }}>
                  {itemText(t, item)}
                </p>
                <div className="stack stack-2">
                  {options.map((option, i) => (
                    <button
                      key={option.value}
                      type="button"
                      className="option"
                      aria-pressed={answers[current]?.[item.id] === option.value}
                      onClick={() => answer(option.value)}
                    >
                      <span className="option__key">{i + 1}</span>
                      <span>{optionLabel(t, option.label)}</span>
                    </button>
                  ))}
                </div>
                <p className="meta dim">
                  <Trans
                    i18nKey="questionnaires.keyHint"
                    components={[<Kbd key="0" />, <Kbd key="1" />, <Kbd key="2" />, <Kbd key="3" />]}
                    values={{ max: options.length }}
                  />
                </p>
              </>
            )}
          </div>

          <hr className="rule" />

          <div className="row row--between">
            <div className="row row--tight">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
              >
                ← {t("common.back")}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
                disabled={index >= items.length - 1}
              >
                {t("common.next")} →
              </button>
            </div>

            {nextKey ? (
              <button type="button" className="btn btn--primary btn--sm" onClick={goNext}>
                {t("questionnaires.continueTo", {
                  instrument: instruments[nextKey]?.abbrev ?? nextKey,
                })}
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={finish} disabled={!allDone}>
                {t(allDone ? "questionnaires.finish" : "questionnaires.finishBlocked")}
              </button>
            )}
          </div>
        </Panel>

        <div className="stack stack-4">
          <Panel title={t("questionnaires.runningScore")} tight headPlain>
            <div className="stack stack-3">
              {current !== "vas" && current !== "psqi" ? (
                <Readout
                  label={t("questionnaires.soFar", { instrument: spec?.abbrev ?? current })}
                  value={runningScore(current)}
                  unit={`/ ${spec?.max_score}`}
                  size="md"
                  tone="data"
                  note={
                    answeredHere < items.length
                      ? t("questionnaires.leftCount", { count: items.length - answeredHere })
                      : spec?.escalates_to
                        ? accepted.has(spec.escalates_to)
                          ? t("questionnaires.aboveCutAdded", {
                              instrument: spec.escalates_to.toUpperCase(),
                            })
                          : declined.has(spec.escalates_to)
                            ? t("questionnaires.aboveCutDeferred", {
                                instrument: spec.escalates_to.toUpperCase(),
                              })
                            : t("questionnaires.belowCut")
                        : t("questionnaires.complete")
                  }
                />
              ) : (
                <p className="meta">
                  {t(current === "vas" ? "questionnaires.vasSeparate" : "questionnaires.psqiComponents")}
                </p>
              )}
              <div className="tickrule" />
              <p className="meta dim" style={{ fontSize: "var(--fs-micro)" }}>
                {spec?.citation}
              </p>
            </div>
          </Panel>

          {/* The "Why so few questions?" card was removed. It explained the
              stepped-screening design to the patient mid-questionnaire, which
              is a justification of the instrument rather than something they
              need in order to answer it. What it also carried — the list of
              long forms that had been added — is already visible in two places:
              the step rail prefixes escalated instruments with "+", and the
              offer panel above names each one as the patient accepts it. */}

          {current === "thi" && (
            <Panel tone="sunken" tight>
              <span className="label">{t("questionnaires.thiExplainTitle")}</span>
              <p className="meta" style={{ marginTop: "var(--s1)" }}>
                <Trans i18nKey="questionnaires.thiExplainBody" components={[<em key="0" />]} />
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
export function VasItem({
  item,
  value,
  onChange,
}: {
  item: Item;
  value: number;
  onChange(value: number): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="stack stack-5">
      <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "34em" }}>{itemText(t, item)}</p>
      <Readout
        label={t(`instruments.vasLabels.${item.id}`, { defaultValue: item.label ?? "" })}
        value={value.toFixed(1)}
        unit="/ 10"
        size="lg"
        tone="signal"
      />
      <div>
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
    </div>
  );
}

function FreeEntryItem({
  item,
  value,
  onChange,
}: {
  item: Item;
  value: number | string | undefined;
  onChange(value: number | string): void;
}) {
  const { t } = useTranslation();
  const isTime = item.kind === "time";
  return (
    <div className="stack stack-4">
      <p style={{ fontSize: "var(--fs-lead)", lineHeight: 1.5, maxWidth: "34em" }}>{itemText(t, item)}</p>
      <div className="row">
        <input
          className="input input--mono"
          style={{ maxWidth: 180 }}
          type={isTime ? "time" : "number"}
          step={isTime ? undefined : item.unit === "hours" ? 0.5 : 5}
          min={isTime ? undefined : 0}
          max={isTime ? undefined : item.unit === "hours" ? 24 : 600}
          value={value ?? ""}
          onChange={(e) => onChange(isTime ? e.target.value : Number(e.target.value))}
        />
        {item.unit && (
          <span className="meta">
            {t(`instruments.units.${item.unit}`, { defaultValue: item.unit })}
          </span>
        )}
      </div>
    </div>
  );
}

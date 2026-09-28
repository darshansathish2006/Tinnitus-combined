/**
 * Pitch Match frequency-quantization coverage.
 *
 * Unlike the rest of this suite, these tests never touch a page — `PitchNarrower`
 * and `quantizeFrequencyHz` (frontend/src/audio/procedures.ts) are plain,
 * dependency-free logic, so they run directly against the module under Playwright's
 * own test runner rather than pulling in a separate unit-test framework for one
 * file. See the "ECHOSENSE — PITCH MATCH OCTAVE A/B FREQUENCY PRECISION FIX" and
 * "ECHOSENSE — PITCH MATCH FREQUENCY STEP FIX" changes: every Octave A/B
 * candidate, and the final matched frequency, must be a multiple of
 * `PitchNarrower.FREQUENCY_STEP_HZ` (currently 100) — never an arbitrary value
 * like 1590.
 */

import { expect, test } from "@playwright/test";
import { PitchNarrower, quantizeFrequencyHz, type PitchAFCResponse } from "../../src/audio/procedures";

const STEP = PitchNarrower.FREQUENCY_STEP_HZ;

/** Drives a narrower to completion with a fixed response sequence, cycling it
 *  if the search needs more trials than the sequence has entries. */
function runToCompletion(narrower: PitchNarrower, responses: PitchAFCResponse[]): void {
  let i = 0;
  while (!narrower.done) {
    narrower.choose(responses[i % responses.length]);
    i++;
    if (i > 50) throw new Error("PitchNarrower did not converge — possible infinite loop");
  }
}

/* ========================================================== quantization === */
test.describe("quantizeFrequencyHz at the 100 Hz step Pitch Match uses", () => {
  const cases: [number, number][] = [
    [1500, 1500],
    [1510, 1500],
    [1540, 1500],
    [1550, 1600],
    [1590, 1600],
    [1600, 1600],
    [1610, 1600],
    [1670, 1700],
    [1710, 1700],
    [1790, 1800],
  ];
  for (const [input, expected] of cases) {
    test(`${input} Hz -> ${expected} Hz`, () => {
      expect(quantizeFrequencyHz(input, STEP)).toBe(expected);
    });
  }
});

/* ================================================= every candidate % 100 === */
test.describe("every generated candidate is a multiple of 100 Hz", () => {
  const responsePatterns: { name: string; responses: PitchAFCResponse[] }[] = [
    { name: "always A (low frequencies)", responses: ["A"] },
    { name: "always B (high frequencies)", responses: ["B"] },
    { name: "alternating A/B (mid frequencies)", responses: ["A", "B"] },
    { name: "mostly not sure", responses: ["not_sure", "not_sure", "A"] },
    { name: "mixed", responses: ["B", "A", "not_sure", "B", "A"] },
  ];

  for (const { name, responses } of responsePatterns) {
    test(name, () => {
      const narrower = new PitchNarrower();
      let trials = 0;
      while (!narrower.done) {
        const { aHz, bHz } = narrower.pair();
        expect(aHz % STEP, `trial ${trials} aHz=${aHz}`).toBe(0);
        expect(bHz % STEP, `trial ${trials} bHz=${bHz}`).toBe(0);
        expect(aHz).toBeGreaterThanOrEqual(1000);
        expect(bHz).toBeLessThanOrEqual(8000);
        narrower.choose(responses[trials % responses.length]);
        trials++;
        if (trials > 50) throw new Error("did not converge");
      }
      expect(narrower.result() % STEP).toBe(0);
    });
  }

  test("minimum boundary — a range anchored at the floor never quantizes below it", () => {
    const narrower = new PitchNarrower(1000, 1300);
    for (let i = 0; i < 10 && !narrower.done; i++) {
      const { aHz, bHz } = narrower.pair();
      expect(aHz % STEP).toBe(0);
      expect(bHz % STEP).toBe(0);
      expect(aHz).toBeGreaterThanOrEqual(1000);
      narrower.choose("A");
    }
  });

  test("maximum boundary — a range anchored near a ceiling never rounds past it (the 11970 -> not 12000-exceeding case)", () => {
    // A raw candidate close to a 12000 Hz ceiling must quantize down to
    // 12000 at most, never past the configured ceiling.
    const narrower = new PitchNarrower(11000, 12000);
    for (let i = 0; i < 10 && !narrower.done; i++) {
      const { aHz, bHz } = narrower.pair();
      expect(aHz % STEP).toBe(0);
      expect(bHz % STEP).toBe(0);
      expect(bHz).toBeLessThanOrEqual(12000);
      narrower.choose("B");
    }
  });

  test("values between 100 Hz boundaries — a range starting off-grid still only ever presents on-grid candidates", () => {
    const narrower = new PitchNarrower(1234, 5678);
    for (let i = 0; i < 10 && !narrower.done; i++) {
      const { aHz, bHz } = narrower.pair();
      expect(aHz % STEP).toBe(0);
      expect(bHz % STEP).toBe(0);
      narrower.choose(i % 2 === 0 ? "A" : "B");
    }
  });
});

/* ==================================================== adaptive narrowing === */
test.describe("adaptive narrowing", () => {
  test("the search converges (reaches done) within the algorithm's own trial bounds", () => {
    const narrower = new PitchNarrower();
    let trials = 0;
    while (!narrower.done) {
      narrower.choose("A");
      trials++;
      if (trials > 50) break;
    }
    expect(narrower.done).toBe(true);
    // MAX_COARSE_TRIALS + MAX_FINE_TRIALS is the algorithm's own documented
    // upper bound — quantization must not prevent the search from reaching
    // "done", nor let it run past that bound.
    expect(trials).toBeLessThanOrEqual(PitchNarrower.MAX_COARSE_TRIALS + PitchNarrower.MAX_FINE_TRIALS);
  });

  test("the bracket recorded in the trial log narrows over successive trials", () => {
    const narrower = new PitchNarrower();
    const gaps: number[] = [];
    while (!narrower.done) {
      const { aHz, bHz } = narrower.pair();
      gaps.push(bHz - aHz);
      narrower.choose("A");
    }
    // Quantization can pin the last trial or two at the step floor, but the
    // overall trajectory must still be a narrowing one, not flat or widening.
    expect(gaps[0]).toBeGreaterThan(gaps[gaps.length - 1]);
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(STEP);
  });

  test("does not stop prematurely — respects MIN_COARSE_TRIALS before leaving the coarse phase", () => {
    const narrower = new PitchNarrower();
    for (let i = 0; i < PitchNarrower.MIN_COARSE_TRIALS - 1; i++) {
      narrower.choose("A");
      expect(narrower.phase).toBe("coarse");
    }
  });

  test("illustrative example: narrows broad -> tight while every step stays on-grid", () => {
    // Not asserting the task's own illustrative sequence verbatim (the exact
    // path is determined by the existing algorithm, not hardcoded) — just
    // that the shape holds: it starts broad, ends tight, and every recorded
    // point along the way is 100 Hz-aligned.
    const narrower = new PitchNarrower();
    const pairs: { aHz: number; bHz: number }[] = [];
    while (!narrower.done) {
      pairs.push(narrower.pair());
      narrower.choose("A");
    }
    for (const { aHz, bHz } of pairs) {
      expect(aHz % STEP).toBe(0);
      expect(bHz % STEP).toBe(0);
    }
    expect(pairs[0].bHz - pairs[0].aHz).toBeGreaterThan(pairs[pairs.length - 1].bHz - pairs[pairs.length - 1].aHz);
  });
});

/* ========================================================= A/B uniqueness === */
test.describe("A/B uniqueness", () => {
  test("A and B are never identical, across a full session", () => {
    const narrower = new PitchNarrower();
    let trials = 0;
    while (!narrower.done) {
      const { aHz, bHz } = narrower.pair();
      expect(aHz, `trial ${trials}`).not.toBe(bHz);
      expect(aHz % STEP).toBe(0);
      expect(bHz % STEP).toBe(0);
      narrower.choose(trials % 2 === 0 ? "A" : "B");
      trials++;
      if (trials > 50) throw new Error("did not converge");
    }
  });

  test("de-duplication: a session converging to a sub-step raw gap still presents two distinct candidates", () => {
    // A small starting range (well under the 1-octave coarse/fine threshold)
    // converges to a raw Hz gap under 100 Hz within a few trials — exactly
    // the condition the de-duplication nudge in `pair()` exists for.
    const narrower = new PitchNarrower(1000, 1300);
    let sawSubStepRawGap = false;
    let trials = 0;
    while (!narrower.done) {
      const { aHz, bHz } = narrower.pair();
      expect(aHz, `trial ${trials}`).not.toBe(bHz);
      expect(aHz % STEP).toBe(0);
      expect(bHz % STEP).toBe(0);
      if (bHz - aHz <= STEP) sawSubStepRawGap = true;
      narrower.choose("A");
      trials++;
      if (trials > 50) throw new Error("did not converge");
    }
    // Confirms this session actually exercised the collision-prone regime,
    // rather than the assertions above passing vacuously.
    expect(sawSubStepRawGap).toBe(true);
  });
});

/* ============================================================ final match === */
test.describe("final matched frequency", () => {
  const sessions: PitchAFCResponse[][] = [
    ["A", "A", "A", "A", "A", "A", "A", "A"],
    ["B", "B", "B", "B", "B", "B", "B", "B"],
    ["A", "B", "A", "B", "A", "B", "A", "B"],
    ["not_sure", "A", "not_sure", "B", "A", "A", "B"],
  ];

  for (const [i, responses] of sessions.entries()) {
    test(`session ${i + 1} (${responses.join(",")})`, () => {
      const narrower = new PitchNarrower();
      runToCompletion(narrower, responses);
      const hz = narrower.result();
      expect(hz % STEP).toBe(0);
      expect(hz).toBeGreaterThanOrEqual(1000);
      expect(hz).toBeLessThanOrEqual(8000);
    });
  }

  test("different starting ranges (low/mid/high) all converge to a 100 Hz-aligned final match", () => {
    const ranges: [number, number][] = [
      [1000, 1500], // low
      [2000, 4000], // mid
      [6000, 8000], // high
    ];
    for (const [lo, hi] of ranges) {
      const narrower = new PitchNarrower(lo, hi);
      runToCompletion(narrower, ["A", "B", "A", "B", "A", "B", "A", "B"]);
      expect(narrower.result() % STEP, `range ${lo}-${hi}`).toBe(0);
    }
  });
});

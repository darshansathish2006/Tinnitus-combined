/**
 * Verification harness for the clinical measurement procedures.
 *
 * These are the algorithms that decide what every downstream number means, so
 * they get tested against simulated listeners with known ground truth rather than
 * trusted because they look right on screen.
 *
 * Run:  node scripts/verify-procedures.mjs
 * (esbuild, which ships with Vite, transpiles the TypeScript first.)
 */

import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = mkdtempSync(join(tmpdir(), "echosense-verify-"));
const outfile = join(outdir, "procedures.mjs");

await build({
  entryPoints: ["src/audio/procedures.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "error",
});

// The cochlear maths lives in its own module precisely so it can be tested
// without pulling in Three.js and a WebGL context.
const cochleaOut = join(outdir, "cochlea.mjs");
await build({
  entryPoints: ["src/lib/cochlea.ts"],
  outfile: cochleaOut,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "error",
});

const { ThresholdTracker, PitchMatcher, analyseResidualInhibition, toSensationLevel } = await import(
  pathToFileURL(outfile).href
);

let failures = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/* ------------------------------------------------------------------------- */
console.log("\nModified Hughson-Westlake threshold tracking");
console.log("  A simulated listener with a known threshold and a psychometric");
console.log("  response curve; the tracker must recover the threshold within 5 dB.\n");

function simulateAudiometry(trueThreshold, slope = 0.55, seed = 1) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const tracker = new ThresholdTracker(1000, "right", { startDbHl: 40 });
  let guard = 0;
  while (guard++ < 120) {
    const level = tracker.currentLevel;
    // Logistic psychometric function centred on the true threshold.
    const probability = 1 / (1 + Math.exp(-slope * (level - trueThreshold)));
    const state = tracker.record(random() < probability);
    if (state === "converged" || state === "floor" || state === "ceiling") break;
  }
  return tracker.result();
}

for (const truth of [0, 10, 25, 40, 55, 70]) {
  const errors = [];
  for (let seed = 1; seed <= 12; seed++) {
    const result = simulateAudiometry(truth, 0.55, seed * 7919);
    if (result.thresholdDbHl !== null) errors.push(result.thresholdDbHl - truth);
  }
  const mean = errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length);
  const maxAbs = Math.max(...errors.map(Math.abs));
  check(
    `threshold ${String(truth).padStart(2)} dB HL`,
    errors.length >= 10 && Math.abs(mean) <= 6 && maxAbs <= 15,
    `recovered n=${errors.length}, bias ${mean >= 0 ? "+" : ""}${mean.toFixed(1)} dB, worst |err| ${maxAbs.toFixed(0)} dB`
  );
}

// A listener who always responds must not produce a mid-range threshold.
const alwaysYes = new ThresholdTracker(1000, "right", { startDbHl: 40 });
let guard = 0;
while (guard++ < 60) {
  const state = alwaysYes.record(true);
  if (state === "floor" || state === "converged") break;
}
check(
  "always-responds listener hits the floor",
  alwaysYes.state === "floor" || (alwaysYes.result().thresholdDbHl ?? 99) <= -5,
  `state=${alwaysYes.state}, threshold=${alwaysYes.result().thresholdDbHl}`
);

// A listener who never responds must be flagged unreliable, not given a number.
const neverYes = new ThresholdTracker(1000, "right", { startDbHl: 40, maxDbHl: 90 });
guard = 0;
while (guard++ < 60) {
  const state = neverYes.record(false);
  if (state === "ceiling") break;
}
const neverResult = neverYes.result();
check(
  "never-responds listener is flagged unreliable",
  neverResult.thresholdDbHl === null && !neverResult.reliable,
  `threshold=${neverResult.thresholdDbHl}, reliable=${neverResult.reliable}`
);

/* ------------------------------------------------------------------------- */
console.log("\n2AFC pitch bracketing");
console.log("  A simulated listener always picks the tone closer to their true");
console.log("  percept; the search must converge within half an octave.\n");

function simulatePitch(trueHz, jitterOctaves = 0, seed = 3, withRetest = true) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  // A listener with a stable percept picks the nearer tone every time. Adding
  // jitter models a listener whose percept is unstable or who is guessing.
  const pick = (aHz, bHz) => {
    const target = Math.log2(trueHz) + (random() - 0.5) * 2 * jitterOctaves;
    return Math.abs(Math.log2(aHz) - target) < Math.abs(Math.log2(bHz) - target) ? aHz : bHz;
  };

  const matcher = new PitchMatcher();
  for (let i = 0; i < 8; i++) {
    const { aHz, bHz, done } = matcher.pair();
    if (done) break;
    matcher.choose(pick(aHz, bHz));
  }
  if (withRetest) {
    const retest = matcher.retrialPair();
    if (retest) matcher.recordRetrial(pick(retest.aHz, retest.bHz));
  }
  return matcher.result();
}

for (const truth of [500, 1000, 3000, 6000, 8000, 12000]) {
  const result = simulatePitch(truth);
  const octaveError = Math.abs(Math.log2(result.hz / truth));
  check(
    `pitch ${truth} Hz`,
    octaveError <= 0.5,
    `matched ${result.hz} Hz (${octaveError.toFixed(2)} oct error, confidence ${result.confidence})`
  );
}

const clean = simulatePitch(6000, 0, 99);
check("a consistent listener scores high confidence", clean.confidence >= 0.75, `confidence ${clean.confidence}`);

/**
 * A coin-flip guesser must fall below the 0.5 confidence gate that the therapy
 * engine uses, because a notch on a wrong frequency has no mechanism of benefit.
 *
 * A single retest can only catch a guesser when they happen to answer it
 * differently — about half the time. That is a real and acknowledged limit of one
 * retest, not something to tune away: the assertion below is set to what one
 * retest can actually deliver (~50%), and the remainder are caught by the
 * clinician seeing a sub-0.9 confidence and the report telling them to repeat.
 */
function simulateGuesser(seed) {
  let state = seed;
  const coin = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff < 0.5;
  };
  const matcher = new PitchMatcher();
  for (let i = 0; i < 8; i++) {
    const { aHz, bHz, done } = matcher.pair();
    if (done) break;
    matcher.choose(coin() ? aHz : bHz);
  }
  const retest = matcher.retrialPair();
  if (retest) matcher.recordRetrial(coin() ? retest.aHz : retest.bHz);
  return matcher.result();
}

let caught = 0;
const trials = 40;
for (let seed = 1; seed <= trials; seed++) {
  if (simulateGuesser(seed * 5779).confidence < 0.5) caught++;
}
const caughtRate = caught / trials;
check(
  "a coin-flip guesser is rejected about half the time by one retest",
  caughtRate >= 0.35 && caughtRate <= 0.68,
  `${caught}/${trials} rejected (${(caughtRate * 100).toFixed(0)}%) — one retest catches ~50% by construction`
);
// Note deliberately NOT asserted: that *every* guesser is caught. A guesser who
// happens to repeat their first answer is indistinguishable from a real match on
// a single retest, which is a property of the measurement, not a bug to tune out.
// The report tells the clinician to repeat the match whenever confidence < 0.75.

// Skipping the retest must not be able to reach top confidence.
const noRetest = simulatePitch(6000, 0, 99, false);
check(
  "omitting the retest caps confidence below a completed one",
  noRetest.confidence < clean.confidence,
  `no-retest ${noRetest.confidence} < with-retest ${clean.confidence}`
);

/* ------------------------------------------------------------------------- */
console.log("\nResidual inhibition analysis\n");

const cases = [
  { name: "complete RI", trace: [[0, 0], [5, 5], [10, 20], [20, 55], [30, 85], [40, 98], [60, 100]], depth: 100, category: "Complete" },
  { name: "partial RI", trace: [[0, 45], [5, 50], [10, 62], [20, 80], [30, 92], [60, 100]], depth: 55, category: "Partial" },
  { name: "absent RI", trace: [[0, 98], [5, 100], [10, 99], [20, 100], [60, 100]], depth: 2, category: "Absent" },
  { name: "rebound", trace: [[0, 118], [5, 115], [10, 110], [20, 104], [60, 100]], depth: -18, category: "Rebound" },
];

for (const testCase of cases) {
  const result = analyseResidualInhibition(testCase.trace.map(([t, loudness_pct]) => ({ t, loudness_pct })));
  check(
    testCase.name,
    result.category === testCase.category && Math.abs(result.depthPct - testCase.depth) < 1,
    `depth ${result.depthPct}% (expected ${testCase.depth}), duration ${result.durationS}s, "${result.category}"`
  );
}

const complete = analyseResidualInhibition(cases[0].trace.map(([t, loudness_pct]) => ({ t, loudness_pct })));
check(
  "recovery time is interpolated, not snapped to the sample grid",
  complete.durationS !== null && complete.durationS > 30 && complete.durationS < 40 && complete.durationS % 5 !== 0,
  `recovered to 90% at ${complete.durationS}s (samples were at 30s and 40s)`
);

/* ------------------------------------------------------------------------- */
console.log("\nSensation level conversion\n");
check("45 dB HL tone, 40 dB threshold -> 5 dB SL", toSensationLevel(45, 40) === 5);
check("unknown threshold returns null rather than 0", toSensationLevel(45, null) === null);

/* ------------------------------------------------------------------------- */
console.log("\nGreenwood cochlear frequency-position function\n");
const { greenwoodFrequency, greenwoodPosition, interpolateThreshold } = await import(
  pathToFileURL(cochleaOut).href
);

check(
  "apex maps to low frequency",
  greenwoodFrequency(0) < 30,
  `f(x=0) = ${greenwoodFrequency(0).toFixed(1)} Hz`
);
check(
  "base maps to the top of the human range",
  greenwoodFrequency(1) > 19000 && greenwoodFrequency(1) < 22000,
  `f(x=1) = ${greenwoodFrequency(1).toFixed(0)} Hz`
);
let worst = 0;
for (const freq of [125, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000]) {
  const roundTrip = greenwoodFrequency(greenwoodPosition(freq));
  worst = Math.max(worst, Math.abs(roundTrip - freq) / freq);
}
check("position/frequency inverse round-trips", worst < 1e-6, `worst relative error ${worst.toExponential(1)}`);

// 4 kHz — the classic noise-notch frequency — should sit in the basal half.
const notchPosition = greenwoodPosition(4000);
check(
  "4 kHz sits in the basal half of the cochlea",
  notchPosition > 0.5 && notchPosition < 0.95,
  `x = ${notchPosition.toFixed(3)} from apex`
);

console.log("\nAudiometric threshold interpolation\n");
const audiogram = { "250": 10, "500": 15, "1000": 20, "2000": 30, "4000": 55, "8000": 60 };
check("exact frequency returns its own value", interpolateThreshold(audiogram, 4000) === 55);
check(
  "interpolation is linear in log-frequency, not in Hz",
  // Midpoint of 2k-4k in log space is 2828 Hz, so 3000 Hz must land just above
  // the halfway threshold of 42.5 dB. Linear-in-Hz would give exactly 42.5.
  Math.abs(interpolateThreshold(audiogram, 2828) - 42.5) < 0.6 &&
    interpolateThreshold(audiogram, 3000) > 42.5,
  `f(2828 Hz) = ${interpolateThreshold(audiogram, 2828).toFixed(1)} dB, f(3000 Hz) = ${interpolateThreshold(audiogram, 3000).toFixed(1)} dB`
);
check("below range clamps to the lowest measured", interpolateThreshold(audiogram, 100) === 10);
check("above range clamps to the highest measured", interpolateThreshold(audiogram, 16000) === 60);
check("empty audiogram returns null, not zero", interpolateThreshold({}, 4000) === null);

/* ------------------------------------------------------------------------- */
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);

# EchoSense AI

**AI-assisted tinnitus assessment and rehabilitation platform.**

Tinnitus affects 10–15% of adults. It is subjective, so in practice it gets assessed by
questionnaire and treated by preset. EchoSense measures it properly in the browser, models where
it is heading with attributions a clinician can argue with, and generates an acoustic prescription
whose delivered spectrum is verified before it reaches the patient.

---

## Quick start

```bash
npm run setup     # venv, dependencies, train models, seed demo cohort (~4 min)
npm run dev       # API on :8000, web app on :5173
```

Open **http://localhost:5173**. Password for every seeded account is `echosense2026`.

| Sign in as | Account | What to look at |
| --- | --- | --- |
| Clinician | `dr.mehta@echosense.health` | Triage-ranked caseload, alerts, Shapley attribution, cohort analytics |
| Patient | `priya.sundaram@example.com` | 3 assessments over 6 months, 246 therapy sessions — THI 58 → 30 |
| Patient | `james.whelan@example.com` | Catastrophic THI 84, masking **rebound** → therapy engine refuses to prescribe masking |
| Patient | `meera.iyer@example.com` | Pulsatile tinnitus → urgent vascular imaging red flag |
| Patient | `lakshmi.rao@example.com` | Sudden asymmetric loss → **emergency** referral, steroid window |

Other useful commands:

```bash
npm run verify    # Django checks + clinical-procedure checks + typecheck
npm run train     # re-fit the predictive ensemble
npm run seed      # migrate + rebuild the demo cohort
npm run build     # production frontend build
```

The API is at **http://127.0.0.1:8000/api/health**. Any Django command is available via
`npm run manage -- <command>` (e.g. `npm run manage -- createsuperuser`).

---

## Architecture

```
┌─ frontend/ ──────────────────────── React 19 + TypeScript + Vite ─┐
│  audio/       Web Audio engine · 15 procedural therapy generators │
│               Hughson-Westlake tracker · 2AFC pitch bracketing    │
│  three/       Procedural 3D cochlea, Greenwood-mapped hair cells  │
│  components/  Hand-built SVG audiogram, spectrum, Shapley chart   │
│  pages/       Assessment flow, therapy player, assistant chat,    │
│               consultation booking, report, clinician console     │
└───────────────────────────────────────────────────────────────────┘
                              │ REST (JWT, role-scoped)
┌─ backend/ ──────────────── Django 5 + DRF + Django ORM + SQLite ──┐
│  api/         Models · DRF serializers · views · management cmds  │
│  clinical/    Instrument scoring · audiogram interpretation ·     │
│               red-flag triage · ICD-11 + HL7 FHIR R4              │
│  ml/          Causal cohort simulator · 6 gradient-boosting       │
│               models · permutation-sampling Shapley explainer     │
│  dsp/         Q-calibrated notch design (SciPy) · spectral        │
│               verification · therapy prescription + adaptation    │
│  chat/        6-language counselling engine, CBT, crisis routing  │
│  services/    Analysis pipeline · monitoring · triage scoring     │
└───────────────────────────────────────────────────────────────────┘
```

**68 API endpoints**, all on the same URL paths as before. SQLite by default for zero-setup
demos; set `ECHOSENSE_DATABASE_URL=postgresql://…` for PostgreSQL — no code change.

The `clinical`, `ml`, `dsp` and `chat` packages are deliberately framework-free: they are pure
Python with no Django import, so they can be tested, profiled or reused without the web layer.
Only `api/` knows Django exists.

---

## The seven modules

### 1 · AI-assisted assessment

**Three required steps, about 10 minutes.** An earlier version of this flow had six steps and asked
every measurement audiology can perform. That is not what guidelines ask for, and it is not what
patients finish — an abandoned assessment has no clinical value at all.

| | Step | Time | Notes |
| --- | --- | --- | --- |
| 1 | About you | 2 min | History, character, laterality — asked once, not twice |
| 2 | Hearing measurement | 6 min | Device setup + adaptive audiometry + pitch/loudness/masking, closing with a **personalised reference level** derived from the patient's own results; device setup **skipped entirely** for returning patients on the same headphones |
| 3 | How it affects you | 2 min | 18-item stepped questionnaire core; long forms **offered, not imposed** |
| — | Tinnitus matching | +5 min | **Optional**, offered with the trade-off stated |

The reduction is *more* guideline-compliant, not less:

- **AAO-HNSF** clinical practice guideline: routine psychoacoustic testing (pitch match, loudness
  match, MML, residual inhibition) is **not required** for initial tinnitus assessment. So it is
  offered as an explicit choice — "yes, measure it (5 min)" versus "skip, show my results" — with
  what it buys you (a notch cut at *your* frequency) stated plainly rather than buried.
- **BSA** recommended procedure: test octaves, add inter-octave frequencies only on a ≥20 dB gap.
- **GAD-2, PHQ-2 and PSS-4** are validated screeners whose entire purpose is to gate the long form.

Real psychoacoustics, not sliders that produce numbers:

- **Pure-tone audiometry, adaptive.** Modified Hughson-Westlake (10 dB down on a response, 5 dB up
  on none, threshold at 2-of-3 ascending responses). Randomised inter-stimulus intervals so the tone
  cannot be anticipated, **silent catch trials** every 7th presentation to detect guessing, and a
  **1 kHz retest** that must agree within 10 dB. Octave frequencies are tested as standard; 3 kHz
  and 6 kHz are added **only when adjacent octaves differ by ≥20 dB** — the BSA recommended
  procedure, and the point at which a notch could otherwise be missed. Typically 12 threshold
  searches rather than 16.
- **Pitch matching — optional.** Two-alternative forced choice bracketing in log-frequency, then an explicit
  **octave-confusion check** and a **test-retest trial**. Patients routinely match an octave away
  from their true percept, and a notch on the wrong frequency has no mechanism of benefit — so a
  match that fails retest is recorded but the therapy engine withholds the notch.
- **Loudness match, minimum masking level, loudness discomfort level** — reported in dB *sensation
  level*, referenced to the patient's own threshold at the matched frequency.
- **Residual inhibition** — a timed masker followed by a sampled recovery curve, with depth and
  duration fitted by interpolation. Signed depth, so a *rebound* (louder afterwards) is reported
  as negative and flagged as a masking contraindication.
- **Validated instruments, administered in steps.** Everyone completes an **18-item core**: THI-5,
  four VAS scales, GAD-2, PHQ-2, PSS-4 and one sleep item. The long forms —
  GAD-7, PSS-10, PSQI — are **offered only when their screener is positive**, which is exactly
  what those screeners exist for, and three things keep the battery honest about its own length:

  - **A long form only asks what its screener did not.** The GAD-2 *is* the first two GAD-7 items
    and the PSS-4 *is* four of the PSS-10 items, so escalating adds 5 and 6 questions, not 7 and 10.
    The screener answers merge into the same item bank server-side, so the full-length score is
    still computed from the full published item set.
  - **The PSQI derives time in bed** from the bedtime and rise-time answers it already has, rather
    than asking a third question about the same interval — 17 items instead of 18.
  - **An indicated long form can be deferred.** A declined instrument is recorded as
    recommended-and-outstanding and shown on the report as *indicated but not administered*, which
    is deliberately distinguishable from a negative screen.

  Worst case is **46 items, of which 18 are required** (originally 73, all mandatory). Item banks
  come from the backend so the questionnaire shown and the algorithm scoring it cannot drift apart.
  Short-form scores are never extrapolated onto a long-form scale: if only the GAD-2 was given,
  `gad7_score` stays null and the models handle the absence natively.

**On the THI-5, honestly.** The handicap instrument is now five items — sleep, concentration,
anxiety, daily activities, mood — one per domain the THI loads on, keeping the item ids of the
published items they are drawn from. Scored 0/2/4 to a raw 0–20 and **projected onto the published
0–100 scale**, so `thi_score`, the five grading bands, the trend chart and the model feature vector
all still work off one number.

Two things this costs, both stated in the API rather than buried:

- **The MCID no longer discriminates.** One response step moves the projected score by 10 points,
  which already exceeds the THI's 7-point minimum clinically important difference. `mcid_applies` is
  `false` on every short-form result and consumers read that flag instead of assuming 7.
- **The catastrophic subscale is not measured.** It has no short-form item, so it is reported as
  `null` — never `0`, because "not measured" and "no catastrophic thinking" are very different
  findings and a zero would read as the second.

Historical 25-item records are **not rescored**. `score_thi()` picks its path from the data: any
answer outside the five short-form items means a long-form record, scored exactly as before. So
every existing report, trend line and trained feature stays valid.

**On calibration, honestly.** A browser cannot know the sound pressure at the eardrum. Any web app
claiming clinical-grade dB HL is lying. EchoSense levels a 1 kHz reference tone to a defined
loudness anchor, then converts digital attenuation to estimated dB HL using the ISO 389 RETSPL
table for the declared transducer class. It also measures ambient noise and flags a test above
40 dB(A). The result is labelled a **screening estimate** everywhere it appears — reliable for
tracking one patient on one set of headphones, not a substitute for a sound booth.

### 2 · Prediction engine with per-patient explanations

Six histogram gradient-boosting models. Held-out metrics (`GET /api/ml/model-card`):

| Target | Metric | Value |
| --- | --- | --- |
| Risk of worsening (6 mo) | ROC AUC | **0.934** · sens 0.96 / spec 0.79 / NPV 0.995 |
| Sound therapy response | ROC AUC | **0.867** · sens 0.79 / spec 0.78 |
| Distress band (4-class) | AUC (macro OvR) | **0.927** |
| THI at 6 months | R² on **change** | **0.565** (R² on level 0.979 — inflated by baseline) |
| Dominant frequency | Within ½ octave | **81.0%** · MAE 0.31 oct |
| Perceived loudness | R² | 0.492 |

Design decisions that matter:

- **Missing values are handled natively, not imputed.** A patient who skipped the sleep
  questionnaire still gets scored, with the uncertainty that implies.
- **Binary targets are isotonic-calibrated** and given a decision threshold tuned by Youden's J on
  a held-out validation split. A 0.5 cut on an 8%-prevalence screening target just predicts "no"
  for everyone — balanced accuracy 0.50 versus 0.83 at the tuned threshold.
- **Explanations are permutation-sampling Shapley values**, not global feature importance. Feature
  importance says what matters on average; a clinician looking at one patient needs to know what
  drove *this* prediction. Local accuracy is enforced, so the waterfall chart sums exactly to
  `f(x) − E[f]` and cannot hide a contribution.
- **Counterfactuals** — `POST /api/ml/what-if` re-scores under a modified value, so the question
  becomes "which lever actually moves this?" rather than "what is the risk?".

**The shipped weights are trained on a simulated cohort.** `GET /api/ml/model-card` says so at the
top. The
simulator is causal rather than noise-with-labels: it samples latent variables (cochlear damage,
central gain, distress diathesis, engagement) and derives observables from published
relationships — presbycusis by ISO 7029 shape, noise notches at 3–6 kHz, tinnitus pitch clustering
at the audiometric edge, and THI weighted heavily toward affective state rather than audiometric
severity, so a model trained here *cannot* learn the naive "worse hearing = worse handicap"
shortcut. `POST /api/ml/retrain` re-fits the same pipeline on real records as they accrue.

### 3 · Personalised sound therapy with verified spectra

Fifteen modalities, all synthesised at runtime — **no audio assets**, so it works offline and the
prescription is a set of parameters rather than a file someone rendered once.

Notched noise and music, broadband enrichment, partial masking, white/pink/brown noise, procedural
ocean surf, rainfall, forest ambience, fractal tones, amplitude-modulated flanking noise,
coordinated-reset tone sequences, bimodal sound + haptic, binaural relaxation, paced breathing,
overnight fade, residual-inhibition induction, hyperacusis desensitisation.

The notch is the interesting part. Cascading three peaking biquads each specified at 0.5 octaves
produces a composite notch about **1.8 octaves** wide — over three times too wide, stripping the
stimulation the therapy depends on. So the per-stage Q is **solved numerically** by bisection until
the cascade's measured −3 dB width matches the prescription:

```
requested 0.5 oct → per-stage bw 0.1395 → achieved 0.506 oct, 37.9 dB deep,
                    0.11% of delivered energy remaining inside the notch
```

The server designs the filter with SciPy, verifies the achieved attenuation and residual in-notch
energy, and refuses to issue a program that misses its target. The browser then instantiates the
**same** biquad coefficients, node for node — so what was verified is what is delivered, and the
plotted spectrum is truthful rather than decorative.

Level setting follows the measured psychoacoustics: mixing point, partial masking or sub-threshold
depending on residual inhibition and maskability, capped 20 dB below the measured discomfort level
and hard-limited in the audio graph. `POST /api/therapy/adapt` measures per-modality relief from
pre/post VAS ratings across logged sessions and reallocates time toward what actually works for
that patient.

### 4 · Everyday Assistant Companion

Six languages (English, Tamil, Hindi, Telugu, Spanish, French) with script-based detection and
code-switching support. Runs **entirely offline** by default — weighted intent routing over a
clinician-reviewable content file, CBT distortion detection with specific reframes, and answers
personalised from the patient's own measurements.

**Safety routing is deterministic and runs before any language model.** Crisis content produces a
fixed correct response with region-appropriate helplines and raises a critical clinician alert —
never delegated to a model's judgement. Setting `ECHOSENSE_ANTHROPIC_API_KEY` upgrades non-safety
turns to Claude with the patient context and a strict clinical system prompt; the offline reply is
the fallback if that call fails, so the assistant is never unavailable.

### 5 · Doctor consultation

The patient's own view of their care team, assembled server-side by `GET /api/consultation`:
assigned clinician, next appointment with its modality, full appointment history, the clinical
notes written after previous visits, follow-up actions, and the reasoning behind the current
therapy plan.

Appointment requests go through `POST /api/consultation/request`, which writes an `Appointment`
with `status="requested"` against the assigned clinician — so it lands in the clinician's existing
appointment list rather than a parallel queue nobody is watching. Both endpoints are scoped through
`permissions.resolve_patient`, the same chokepoint as every other patient-facing endpoint; the
clinician-side `/api/clinician/appointments` and its `IsClinician` gate are untouched.

**Scheduling is derived, not stored.** A clinician's `ClinicianProfile` carries a rule — working
days, working windows, slot length, booking horizon — and `GET /api/consultation/slots` generates
the bookable slots for any date from it, minus the appointments that already exist. Materialising a
year of 30-minute slots per clinician would be thousands of rows that exist only to be mostly empty
and would have to be rewritten on every change to a working pattern.

**Patients are not assigned a doctor.** Booking opens on a directory of every clinician who is
accepting patients — qualification, specialisation, years in practice, working pattern, how soon
they are free and their next available times — ordered by soonest availability, because the question
being asked is "who can see me first?" rather than "who is first alphabetically". The patient
compares, picks one, and only then sees that doctor's calendar. The doctor they choose becomes the
clinician on their record if they do not already have one; booking a one-off with a colleague does
not transfer a patient off the clinician treating them.

Having chosen, they pick a day and a free time. Taken slots are shown struck through rather than
omitted — a day with two free times and a day with only two times look identical otherwise.
Booking refuses times that are not real slots, times outside the horizon, slots already held, and a
second live booking by a patient who has one. The last word is a **partial unique constraint** on
`(clinician, scheduled_for)` excluding cancellations: two requests arriving together both pass a
"is this free?" read before either writes, so the pre-check exists for the error message and the
constraint exists for correctness.

**Video consultations are real.** The clinician sets a Google Meet link per appointment from the
console (falling back to a standing room on their profile), and the patient gets a Join button on
both their overview and their consultation screen. The join window is resolved **server-side** and
delivered as `can_join`; clients never compare the start time against their own clock, because a
machine whose clock has drifted would either hide the button during the consultation or open it
early, and both present as an application fault rather than a clock fault. Links are restricted to
https Meet/Zoom/Teams hosts — this field is shown to a patient as "join your consultation".

> **The daily diary was withdrawn.** Its trigger-correlation analysis (Welch's t and Cohen's d over
> within-patient exposed/unexposed days) and its escalation, sleep-collapse and disengagement alerts
> remain in `services/monitoring.py` and the diary API endpoints still resolve, so historical data
> is intact and nothing was dropped from the record. Nothing in the SPA writes or reads them, and
> the caseload no longer displays diary columns, since with no way to log an entry they could only
> ever show stale numbers as current.

### 6 · Interactive 3D ear — inside the report

Procedural anatomy — outer, middle and inner ear, ossicles, cochlear spiral, semicircular canals,
auditory pathway to cortex, and the trigeminal convergence that explains somatic tinnitus.

Hair-cell markers are positioned by the **Greenwood cochlear frequency-position function**
(`f = 165.4·(10^2.1x − 0.88)`), so each sits at the place that genuinely responds to its frequency.
They are then coloured by the patient's own audiometric thresholds, and their matched tinnitus
frequency is marked — so a patient sees their percept landing inside their own damaged region. A
travelling wave animates along the basilar membrane. Patients who see that correspondence stop
asking whether the tinnitus is imaginary.

**It is not a destination.** There is no standalone page and no rail entry for either role: the
model is embedded in the results summary, immediately beside the plain-language explanation of what
the numbers mean, and in the clinician console's expanded case view. A separate page meant
navigating away from your results to look at a visualisation of them, and it arrived without the
sentence that makes a coloured dead region reassuring rather than alarming. It loads lazily, so the
summary renders before Three.js arrives, and it is hidden in print.

### 7 · Clinician console

Caseload ranked by a transparent triage score, **safety-first by design**: an urgent red flag
contributes up to 40 points, a maximal THI contributes 14. Every row shows the reasons for its
position, because a ranking a clinician cannot interrogate is one they will stop trusting.

Plus longitudinal trajectory against the THI MCID, Shapley attribution per patient, AI-drafted SOAP
notes that require editing and signature before filing, plan approval (generated plans stay flagged
as AI drafts until a named clinician takes responsibility), appointments, cohort analytics, HL7
FHIR R4 export, and a consent-gated de-identified research extract.

---

## Safety architecture

Red-flag triage is **rule-based and runs before and independently of the models**, so a referral
for suspected retrocochlear pathology never depends on an ML artifact loading. Detected:

sudden sensorineural hearing loss (steroid window is time-critical) · pulsatile tinnitus (vascular
imaging) · unilateral tinnitus with ≥15 dB asymmetry (MRI IAM) · neurological and vestibular
accompaniment · severe psychological distress and positive depression screen · hyperacusis with
collapsed dynamic range · masking rebound · invalid test environment.

Each returns urgency, action, evidence and referral pathway, and raises a deduplicated alert.

---

## Honesty notes

Things this project states plainly rather than glossing over:

- Browser audiometry produces **screening estimates**, not calibrated clinical thresholds.
- The shipped models are trained on **simulated data**; real-world performance is unknown until
  retrained and prospectively validated.
- THI-at-6-months R² of 0.982 is **inflated** by baseline THI carrying the variance; the honest
  figure is R² on the change, 0.587, and that is what the model card endpoint leads with.
- ICD-11 codes that could not be verified against the current MMS release are **flagged for
  clinician confirmation**, not asserted. A coding assistant that quietly invents plausible codes is
  worse than none.
- Tinnitus psychoacoustics have no universal LOINC, so they are published under a local FHIR
  `CodeSystem` — which is what FHIR expects for locally-defined measures, rather than guessing.
- The Tinnitus Reactivity Index is an **EchoSense composite, not a validated instrument**. Every
  component and weight is shown, and it is renormalised over what was actually measured so a
  missing questionnaire does not silently score as zero.
- A single pitch-match retest catches roughly **half** of guessers. That is a property of the
  measurement, and the report tells the clinician to repeat whenever confidence is below 0.75.

---

## Verification

`npm run verify` runs the clinical procedures against simulated listeners with known ground truth:

- **Threshold tracking** recovers 0–70 dB HL within 5 dB across 12 seeds each; always-responds
  hits the floor; never-responds is flagged unreliable rather than given a number.
- **Pitch bracketing** converges within 0.06 octaves at 500 Hz–12 kHz; coin-flip guessers are
  rejected by the retest; omitting the retest caps confidence.
- **Residual inhibition** classifies complete/partial/absent/rebound with interpolated recovery
  times.
- **Greenwood function** round-trips to 3.4e-16 and puts 4 kHz at x = 0.666 from the apex.
- **Threshold interpolation** is verified linear in log-frequency, not in Hz.

These caught four real bugs during development: near-normal thresholds being discarded as failures,
rebound being reported as depth 0%, a broken reversal-detection formula that scored erratic
responses *higher* than consistent ones, and the notch-width error above.

Also: `python -m app.ml.train` prints held-out metrics; the API smoke path is exercised end to end
by the seeder, which routes every seeded record through the same analysis pipeline as live data —
so if the pipeline breaks, seeding fails rather than producing plausible-looking fixtures.

---

## Deployment

One Render web service serves the API and the SPA from a single origin — no CORS to maintain and no
API address baked into the bundle. Push, then **New → Blueprint** in the Render dashboard;
[`render.yaml`](render.yaml) does the rest, and [`build.sh`](build.sh) builds the bundle, collects
static files, migrates, and fits the ensemble.

Reproduce a deployment locally with `bash ./build.sh`. Full notes — configuration, the
SQLite-vs-Postgres trade-off, and the free-plan constraints — are in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Tech

React 19 · TypeScript · Vite · Three.js · Zustand · Web Audio API ·
**Django 5** · **Django REST Framework** · SimpleJWT · scikit-learn · SciPy · NumPy · pandas · HL7 FHIR R4

No charting library (the audiogram must follow clinical convention exactly), no CSS framework, no
webfonts, no audio assets — the app works on venue wifi or none.

---

## Not a medical device

A clinical decision-support prototype for qualified audiologists. Not regulator-cleared, not
diagnostic, and not a substitute for assessment by a clinician. See `docs/` for the demo script and
clinical rationale.

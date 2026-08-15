# Demo script — 6 minutes

Password for every account: `echosense2026`

**Before you start:** `npm run dev`, open http://localhost:5173, have headphones plugged in.
Have a second browser tab ready on the clinician account so you can switch without re-logging in.

---

## 0 · Setup (15 s)

> "Tinnitus affects one in seven adults. Because it is subjective, it gets assessed by
> questionnaire and treated by preset. We measure it properly."

Point at the login page's honesty panel — *"Not calibrated clinical audiometry"*. Say it out loud.
Judges trust a project that states its limits more than one that claims everything.

---

## 1 · The clinician's morning (90 s) — **lead with this**

Sign in as `dr.mehta@echosense.health`.

The caseload is **ranked by clinical priority, not alphabetically**. Top of the list is Lakshmi Rao
at 87.5 with an **emergency** flag.

> "She has sudden asymmetric hearing loss three weeks in. Steroids work for that, and the benefit
> falls off sharply after two weeks — so days matter. The system found it from her audiogram
> asymmetry and her onset date, and flagged it before anyone read her file."

Scroll to **"Why this order"**.

> "The ranking is not a black box. An urgent red flag is worth up to 40 points; a maximal handicap
> score is worth 14. That ordering is a clinical judgement, and it is visible so you can disagree
> with it."

Note Meera Iyer second — pulsatile tinnitus, which is objective, not subjective, and needs vascular
imaging.

**Key line:** *"Red-flag triage is rule-based and runs before and independently of the models. A
referral for suspected pathology never depends on a machine-learning artifact loading."*

---

## 2 · Explainability (75 s)

Click **Priya Sundaram** → scroll to **Model attribution**.

> "This is not feature importance. Feature importance tells you what matters on average. This is a
> Shapley decomposition for *this* patient: the bars run from the cohort baseline to her prediction
> and they sum to it exactly, so nothing is hidden."

Point at a green (protective) bar and a red (adverse) one. Read the plain-language narrative
underneath.

Go to **Full report → Counterfactual**. Drag PSS-10 down.

> "Now the question stops being 'what is her risk' and becomes 'which lever moves it'. That is the
> question a clinician can actually act on."

---

## 3 · The measurement (90 s)

Switch to the patient tab, sign in as `priya.sundaram@example.com` → **Assessment**.

Step through **Calibration** — play the 1 kHz tone so it is audibly real.

> "A browser cannot know the sound pressure at your eardrum. Anything claiming clinical dB HL in a
> web app is lying. We level a reference tone to a defined loudness anchor, apply the ISO 389
> reference threshold table for the headphone class, and label the output a screening estimate
> everywhere it appears."

Jump to **Hearing test**. Let two or three tones present.

> "Modified Hughson-Westlake — 10 dB down on a response, 5 dB up on none, threshold at two of three
> ascending. Randomised intervals so you cannot anticipate the tone, and every seventh presentation
> is **silent**. If you respond to silence, the whole audiogram gets flagged."

Then **Tinnitus profile → pitch matching**. Play both tones, pick one, then show the **retest** step.

> "Patients routinely match an octave away from their real percept, so we check the octave
> explicitly. Then we ask the very first question again. If the answer changes, the match is not
> reproducible and the therapy engine refuses to place a notch on it — because a notch on the wrong
> frequency has no mechanism of benefit at all."

---

## 4 · Therapy that is verified, not asserted (90 s) — **the technical centrepiece**

Go to **Therapy** → click **Verify spectrum**.

> "Her tinnitus was matched at 5.8 kHz. The therapy removes energy exactly there. This curve is not
> decorative — the server designed the filter in SciPy, measured that it achieves 38 dB of
> attenuation with 0.11% of delivered energy left inside the notch, and the browser then builds the
> same biquads node for node."

Open the **Filter chain** disclosure.

> "Three cascaded peaking sections. Here is the part I like: if you naively set each stage to the
> target half-octave, the composite notch comes out **1.8 octaves** wide — three times too wide,
> stripping the stimulation the therapy depends on. So the per-stage Q is solved numerically until
> the cascade actually measures 0.5 octaves. We only found that because we measured it."

Close, then **start a block**. Give the pre-session loudness rating, let the audio play, show the
live spectrum bars.

> "Every sound in this app is synthesised at runtime — no audio files at all. The ocean, the rain,
> the notched music, all procedural. It works with no internet."

Finish the session, give the post rating.

> "That pre/post pair is what makes 'adaptive' mean something. The engine measures that notched
> noise moves her 1.2 points and ocean surf moves her 0.5, and reallocates her time accordingly."

Scroll to **What has worked for you** to show the real per-modality table.

---

## 5 · The cochlea (45 s) — **the one they will remember**

**Your ear** tab. Let it rotate, then click into the cochlea.

> "Each block is a group of hair cells, placed by the Greenwood function — the real
> frequency-position relationship for the human cochlea. So each one sits where it genuinely
> responds. They are coloured by *her* audiometric thresholds, and the orange marker is *her*
> matched tinnitus frequency."

Point at the marker sitting inside the damaged region.

> "Her percept lands exactly in the region where her hair cells have gone quiet. That is the
> mechanism, on her own data. Patients who see this stop asking whether it is imaginary."

---

## 6 · Safety and honesty (45 s) — **close here, not on features**

**Support** tab. Type: `I can't take this any more, I want to end it`.

> "Crisis routing is deterministic and runs *before* any language model is consulted. It always
> produces the correct response, always shows local helplines, and always raises a critical
> clinician alert. That is not something you leave to a model's judgement."

Switch to the clinician tab, refresh — the alert is there.

Finish on **Model card**.

> "Held-out AUC 0.91 for worsening risk. And at the top, in a warning panel: the shipped models are
> trained on **simulated** data. We also report R² on the *change* in handicap, 0.59, not the 0.98
> on the absolute level — because that number is inflated by baseline and quoting it would be
> misleading. ICD-11 codes we could not verify are flagged for confirmation rather than asserted."

**Closing line:**

> "Every number in this system can be traced to how it was measured, and every limit is stated on
> the screen where the number appears. That is what makes it usable in a clinic rather than a demo."

---

## If you have 60 extra seconds

- **`james.whelan@example.com`** — THI 84, and residual inhibition testing showed his tinnitus got
  *louder* after masking. The therapy engine detects the rebound and **refuses to prescribe
  masking**, switching to sub-threshold enrichment. A system that only knows how to turn sound up
  would have made him worse.
- **Diary → What actually affects you** — Welch's t on her own logged triggers. Jaw clenching,
  t = +3.08, from her data rather than a leaflet.
- **Report → FHIR export** — a real R4 bundle: one Observation per ear with a component per
  frequency, a RiskAssessment carrying the model rationale, a CarePlan of therapy blocks.

## Likely questions

**"Is the hearing test accurate?"** — It is a screening estimate and labelled as such. A browser
cannot know absolute SPL. It is reliable for tracking one patient on one set of headphones, which is
what longitudinal management needs; it is not a sound-booth replacement.

**"Where did the training data come from?"** — A causal simulator, stated at the top of the model
card. It encodes published epidemiology, and it deliberately gives THI a small audiometric weight so
the model cannot learn "worse hearing = worse handicap". `POST /api/ml/retrain` re-fits on real
records as they accrue.

**"How do you know the notch works?"** — Because the server measures it. `GET /api/therapy/spectrum`
returns achieved attenuation, achieved width and residual in-notch energy, and refuses a program
that misses target. `npm run verify` also tests the measurement procedures against simulated
listeners with known ground truth — that suite caught four real bugs.

**"What stops the AI giving harmful advice?"** — Safety routing is deterministic and precedes any
model call. The therapy engine has hard contraindications (rebound, hyperacusis) that override any
level it would otherwise choose, an output cap enforced in the audio graph itself, and generated
plans stay flagged as AI drafts until a named clinician approves them.

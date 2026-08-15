/**
 * The manual.
 *
 * Every screen, every measurement, every number — what it is, how it is
 * produced, and what it can and cannot tell you. Two audiences share the page
 * and it is honest with both: patients get plain language, clinicians get the
 * method, the cut-point and the guideline it comes from.
 *
 * Written here rather than in a README because the person who needs it is inside
 * the app, not in the repository.
 */

import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { useSession } from "../state/session";
import { Chip, Disclosure, Panel } from "../components/ui";
import { OnboardingVideo } from "../components/OnboardingVideo";
import { resetWalkthrough } from "../components/Walkthrough";
import {
  IconAlert,
  IconCalendar,
  IconChart,
  IconChat,
  IconClipboard,
  IconEar,
  IconShield,
  IconSpark,
  IconTrend,
  IconUser,
  IconWave,
} from "../components/icons";

type Audience = "patient" | "clinician";

interface Entry {
  /** Plain-language summary — always shown. */
  what: string;
  /** How it works. Shown to both, but written for the curious. */
  how?: string;
  /** Method detail, cut-points, guideline basis. Clinician view only. */
  clinical?: string;
  /** Honest limitation. Always shown, never hidden behind a disclosure. */
  limit?: string;
}

interface Section {
  id: string;
  icon: typeof IconEar;
  /**
   * The English source text, and the fallback when a translation is missing.
   *
   * The guide is the one screen whose body is *reference documentation* rather
   * than interface copy: 54 entries of method, cut-points and guideline basis.
   * It is wired for translation the same way as everything else — every string
   * is looked up by key — but the English literal stays here as the
   * `defaultValue`, so a language that has not yet had the reference text
   * translated shows accurate English rather than a blank card or a raw key.
   *
   * Section titles and intros *are* translated, so the page is navigable in
   * every language: a reader can find the section they want and read its
   * summary in their own language even where the deep method notes underneath
   * are still English. Completing a language means adding keys under
   * `guide.section.<id>.entries.<n>.*` — no code changes.
   */
  title: string;
  route?: string;
  audience: Audience | "both";
  intro: string;
  entries: { label: string; entry: Entry }[];
}

const SECTIONS: Section[] = [
  /* ===================================================== getting started === */
  {
    id: "start",
    icon: IconClipboard,
    title: "Where to start",
    audience: "both",
    intro:
      "Everything in the platform is derived from one assessment. Until that is done, most screens have nothing to show.",
    entries: [
      {
        label: "The order to do things in",
        entry: {
          what: "Assessment first, then your therapy plan appears automatically. After that it is the daily therapy blocks, rating your tinnitus before and after each one. The Everyday Assistant Companion and your Doctor consultation screen are there whenever you want them.",
          how: "Finishing an assessment triggers a single pipeline: instruments are scored, red flags are screened, the models predict, and a therapy prescription is generated and stored. Everything else reads from that.",
        },
      },
      {
        label: "Getting around",
        entry: {
          what: "Everything is in the rail down the left: Overview, Assessment, Therapy, Support, Doctor consultation, Results and this Guide. There is no separate 3D ear page — the model is inside your results, next to the audiogram it draws from. On a narrow screen the rail becomes a row of icons across the top.",
          how: "The theme switch and the ? that replays the tour for the current screen sit in the bar along the top. Both themes are fully supported — nothing is hidden or unreadable in either.",
          clinical:
            "Clinicians see Caseload and Guide. Opening a patient from the caseload scopes the session to them and adds Results — their clinical report — to the rail under their name, with a persistent banner and a one-click exit. Deliberately nothing else: Overview, Assessment, Therapy, Support and the patient's own booking screen are screens the patient drives, and a clinician acting inside them either fabricates data or reads private counselling history. Those routes redirect to the caseload.",
        },
      },
      {
        label: "Your overview screen",
        entry: {
          what: "A daily check-in, a line worth reading, and what has changed since your last assessment. It deliberately does not open with charts.",
          how: "The check-in is one tap and is stored only on your own device — it is a nudge for you, not a measurement for your clinician. The comparison only calls something a change when it crosses the threshold where that instrument's change is real: 7 points on the handicap score, a full band elsewhere. Quick links to Therapy, Support and your Doctor consultation sit at the top of the screen.",
          clinical:
            "The trend charts, rolling means and diary analytics that used to occupy this screen were moved off it entirely, not hidden — patients opening a dashboard of numbers they cannot act on before 8am stopped opening it. The full analysis is unchanged and lives on Results and the caseload.",
        },
      },
      {
        label: "What you need",
        entry: {
          what: "Headphones — not speakers — and the quietest room you can find. About 10 minutes.",
          how: "Tones are played to one ear at a time, which speakers cannot do. Room noise masks the quietest tones and makes your hearing look worse than it is.",
          limit:
            "If the room is above about 40 dB(A), low-frequency thresholds will be overstated. The app measures this and flags it on your report rather than hiding it.",
        },
      },
    ],
  },

  /* ========================================================= assessment === */
  {
    id: "assessment",
    icon: IconClipboard,
    title: "The assessment",
    route: "/assessment",
    audience: "both",
    intro:
      "Three required steps, roughly 10 minutes, plus optional extras you are asked about rather than given. Each step saves as you finish it, so you can stop and come back.",
    entries: [
      {
        label: "Step 1 — About you",
        entry: {
          what: "What your tinnitus sounds like, which ear, how long you have had it, and a few yes/no questions.",
          how: "Some answers change the whole pathway. A percept that pulses with your heartbeat, or one strictly in one ear, is handled differently from the start.",
          clinical:
            "Captures character, laterality, onset date, pulsatility, somatic modulation, hyperacusis, hearing-aid use, occupational noise years, comorbidities and medication. Feeds the red-flag rules and the predictive feature vector.",
        },
      },
      {
        label: "Step 2a — Device setup",
        entry: {
          what: "You say what you are listening through, set your device volume so a setup sound is at a comfortable talking level, and confirm left and right are the right way round.",
          how: "A browser has no idea how loud your headphones actually are. Getting one sound to a known loudness gives everything after it a starting point. There is no slider to fiddle with — your device volume is the only control that matters. If you have done this before on the same headphones, you can reuse it with one tap.",
          clinical:
            "Speech-band noise presented at a fixed digital level and levelled to a conversational anchor (~65 dB SPL) by device volume, then converted to estimated dB HL using the ISO 389 RETSPL table for the declared transducer class. Ambient noise optionally sampled from the microphone. This establishes a *working* anchor only; the definitive anchor is set in step 2d at the patient's own tinnitus frequency. Broadband noise rather than a tone because it is far more reliably localised, which is what the left/right check depends on. The device profile is stored on the assessment for provenance.",
          limit:
            "This produces a screening estimate, not calibrated clinical audiometry. It is reliable for tracking one patient on one set of headphones over time. It is not a sound-booth substitute, and every threshold in the app is labelled accordingly.",
        },
      },
      {
        label: "Step 2b — Hearing test",
        entry: {
          what: "Tones get quieter and quieter; you press a button whenever you hear one, however faint.",
          how: "The level moves down when you respond and up when you do not, closing in on the quietest tone you can reliably detect. Some 'tones' are silent on purpose — if you respond to those, the whole test gets flagged.",
          clinical:
            "Modified Hughson-Westlake: 10 dB down on a response, 5 dB up on none, threshold taken as the lowest level with 2 of 3 ascending responses. Randomised inter-stimulus intervals prevent anticipation. Silent catch trials every 7th presentation detect false positives. 1 kHz is tested first and repeated last; the two must agree within 10 dB. Octave frequencies are standard; 3 kHz and 6 kHz are added only when adjacent octaves differ by ≥20 dB, per the BSA recommended procedure — typically 12 threshold searches rather than 16.",
        },
      },
      {
        label: "Step 2c — Tinnitus measurement",
        entry: {
          what: "Three short modules: match the pitch of your tinnitus, match how loud it is, then find the level at which a sound covers it at each of eight frequencies.",
          how: "Each one narrows the next. The pitch tells us roughly where the percept sits; the loudness gives the masking search somewhere sensible to start; the masking profile is the one your therapy sound is actually built from.",
          clinical:
            "Pitch matched on a log-frequency slider stepped in 25-cent increments (a linear hertz step is a large musical interval at 250 Hz and inaudible at 8 kHz). Loudness matched in dB HL at the matched pitch, ceilinged at the level the hardware can deliver without clipping. Minimum masking level then measured with half-octave band noise across the standard audiometric series, seeded at each frequency from the previous answer because neighbouring masking thresholds are strongly correlated. Frequencies the patient cannot mask at any deliverable level are recorded as unmaskable rather than as a large number.",
        },
      },
      {
        label: "Step 2d — Your personalised reference level",
        entry: {
          what: "The last part of the hearing measurement. You are shown a reference tone and a reference level worked out from what you have just done, you hear it, and you confirm it.",
          how: "This used to be the first thing you did, and it used to be a 1 kHz tone — the same tone for everybody. It is now built from your own results: the pitch you matched, how loud you said it was, and the level at which sound covered it. So you hear a tone that is close to your own tinnitus rather than a generic one, and you are never asked to repeat a measurement to produce it.",
          clinical:
            "Derived server-side by `services/masking.personalised_reference`, never submitted by the client. Frequency: the pitch match, falling back to the masking-curve minimum, then the audiometric notch centre. Level: the masking threshold at that frequency, log-interpolated from the curve, falling back to the curve minimum, then the loudness match plus the usual masking increment, then a sensation level above the patient's own threshold. Floored at the better-ear threshold + 3 dB so the tone is audible, and capped at 85 dB HL. Confirming it re-solves the engine's dBFS↔dB HL anchor at the tinnitus frequency rather than at 1 kHz, which removes two to three octaves of RETSPL interpolation from the path between the anchor and where the measurement actually happens.",
          limit:
            "It is only as good as the modules underneath it. Where neither a pitch match nor a masking profile exists there is nothing to personalise from, and the module says so and steps aside rather than falling back to a generic tone.",
        },
      },
      {
        label: "Step 3 — How it affects you",
        entry: {
          what: "18 short questions about how tinnitus affects your life, sleep, mood and stress. That is the whole required set. If your answers indicate a longer questionnaire, it is offered — and you can say 'not now'.",
          how: "Five of them are the handicap questions your clinician tracks: sleep, concentration, anxiety, daily activities and mood. Nothing is ever asked twice — the longer anxiety and stress questionnaires contain the short ones you already answered, so they only add the five or six questions that are genuinely new. If you skip an offered questionnaire it is recorded as recommended and outstanding, so your clinician knows it is missing rather than assuming you scored well.",
          clinical:
            "Core battery, 18 items: THI-5, 4 VAS scales, GAD-2, PHQ-2, PSS-4 and one tinnitus-specific sleep item. THI-5 administers items 7, 1, 22, 13 and 21 of the published THI — one per loading domain — scored 0/2/4 to a raw 0–20 and projected onto the published 0–100 scale, so grades, trends and the model feature vector stay on one number. Stepped escalation — GAD-2 ≥3 → GAD-7 (+5 items, not 7); PSS-4 ≥6 → PSS-10 (+6 items, not 10); sleep item ≥2 → PSQI (17 items; time in bed is derived from the bedtime and rise-time answers rather than asked a third time); PHQ-2 ≥3 flags for PHQ-9 by the clinician. Worst-case battery is 46 items, with 18 required. Escalations are deferrable: a declined long form is written to derived.stepped_protocol.deferred and surfaces on the report as 'indicated but not administered'. Short-form scores are never extrapolated onto long-form scales.",
          limit:
            "The 25-item psychometrics do not transfer to a 5-item subset, which is why it is reported as THI-5 rather than THI. One response step moves the projected score by 10 points, so the 7-point MCID no longer discriminates — `mcid_applies` is false on the result and every consumer reads that flag rather than assuming. Historical 25-item assessments are still scored the original way, so no past record was rescored and every existing trend line is unchanged. The catastrophic subscale has no short-form item and is reported as null, never zero.",
        },
      },
      {
        label: "Optional — Tinnitus matching",
        entry: {
          what: "Offered at the end. Tones are played and you say which is closer to your tinnitus, then how loud it is, then whether a masking sound can cover it.",
          how: "This is the only way to find your actual tinnitus frequency, which is what lets the therapy cut a notch at exactly that pitch. Skipping it still gives you a full assessment and a plan — just a broadband one.",
          clinical:
            "Two-alternative forced-choice bracketing in log-frequency, followed by an explicit octave-confusion check and a test-retest of the first comparison. Then loudness match and minimum masking level in dB SL, loudness discomfort levels, and a 45-second residual-inhibition induction with a sampled recovery curve. Genuinely optional: AAO-HNSF states routine psychoacoustic testing is not required for initial tinnitus assessment.",
          limit:
            "A match that fails the retest is recorded but flagged as not reproducible, and the therapy engine will withhold the notch — a notch on the wrong frequency has no mechanism of benefit.",
        },
      },
    ],
  },

  /* ============================================================ therapy === */
  {
    id: "therapy",
    icon: IconWave,
    title: "Sound therapy",
    route: "/rehabilitation",
    audience: "both",
    intro:
      "Your plan is a set of sound blocks with a daily minutes target. Every sound is generated live in your browser — there are no audio files.",
    entries: [
      {
        label: "How to use it",
        entry: {
          what: "Pick a block, rate how loud your tinnitus is right now, press play, then rate it again at the end. Save the session and it goes on your record.",
          how: "Those two ratings are the point. Over a few weeks the app can measure that one sound moves you 1.4 points and another moves you 0.2, and 'Adapt to my response' reallocates your daily minutes toward what actually works for you.",
        },
      },
      {
        label: "If the page says you have no plan",
        entry: {
          what: "If you have finished an assessment, there is a 'Build my programme' button that generates one from it. If you have not, the assessment comes first — there is nothing to build a plan from.",
          how: "A plan is normally created the moment you finish an assessment, so this button is a recovery path rather than a routine step.",
          clinical:
            "POST /api/therapy/generate, scored from the latest complete assessment. Clinicians reach the same screen through the caseload: opening a patient scopes the session to them and their patient screens — Overview, Assessment, Therapy, Results, Support, Doctor consultation — appear in the rail under their name.",
        },
      },
      {
        label: "Why the volume may start low",
        entry: {
          what: "Your prescribed level is measured against your own hearing threshold. That only works if the app knows how loud your headphones are, which is what the device setup and the personalised reference level in the hearing measurement establish between them.",
          how: "Without a stored calibration for the device you are on, therapy starts at a deliberately quiet fixed level and tells you so, rather than guessing at a level that could be too loud. Use the fader to find the point where your tinnitus and the sound just blend.",
          clinical:
            "The engine's calibration is restored from the patient's saved device profile at session start, so dB SL targets are reachable on any screen rather than only inside the assessment flow. Where no calibration exists the player falls back to a fixed low output and labels the level as uncalibrated.",
        },
      },
      {
        label: "Setting the level — the most common mistake",
        entry: {
          what: "Turn it up until your tinnitus and the therapy sound just begin to blend, then stop. You should still be able to hear your tinnitus.",
          how: "If it disappears completely the level is too high. Complete masking works against habituation, because your brain never gets the chance to reclassify the sound as unimportant.",
          clinical:
            "Level strategy is selected from the psychoacoustics: mixing point by default; partial masking where residual inhibition is positive and the percept is maskable; sub-threshold where there is masking rebound or reduced sound tolerance. Output is capped 20 dB below the measured LDL and hard-limited in the audio graph.",
        },
      },
      {
        label: "Why there is a silent gap in the sound",
        entry: {
          what: "Deliberate. The band around your own tinnitus frequency is removed. It is not a fault in the audio.",
          how: "Removing energy at your frequency while stimulating everything around it is the mechanism — it reduces the reorganised cortical activity in that region.",
          clinical:
            "Notched sound training (Okamoto et al., PNAS 2010). Three cascaded peaking biquads; the per-stage Q is solved numerically so the composite −3 dB width matches the prescription — cascading sections at the target width produces a notch roughly three times too wide. 'Verify spectrum' shows the achieved attenuation and the residual in-notch energy, computed server-side in SciPy with the same coefficients the browser instantiates.",
        },
      },
      {
        label: "The 15 sound types",
        entry: {
          what: "Notched noise and music, broadband enrichment, partial masking, white/pink/brown noise, ocean surf, rainfall, forest ambience, fractal tones, modulated flanking noise, coordinated-reset tones, bimodal sound-plus-haptic, binaural relaxation, paced breathing, overnight fade, and residual-inhibition bursts.",
          how: "They fall into families: neuromodulation aims to change the abnormal activity; masking gives immediate relief; habituation lowers how much attention the sound captures; relaxation targets the stress that amplifies it; sleep blocks fade out so you are not under sound all night.",
          clinical:
            "All synthesised procedurally in Web Audio — no assets, works offline. Each block is a full synthesis recipe (filter chain, level, modulation) rather than a file, so the prescription is parameterised and auditable.",
        },
      },
      {
        label: "How long before it works",
        entry: {
          what: "Eight to twelve weeks, not days. Consistency beats intensity — two 30-minute sessions you actually complete daily beat a 3-hour session once a week.",
          limit:
            "Some people find the first week slightly worse as they start paying more attention to the sound. That is expected. But if your tinnitus is consistently louder *after* sessions, stop and tell your clinician — the level or the sound type is wrong for you.",
        },
      },
    ],
  },

  /* ======================================================= consultation === */
  {
    id: "consultation",
    icon: IconCalendar,
    title: "Doctor consultation",
    route: "/consultation",
    audience: "both",
    intro:
      "Everything about the human side of your care in one place: who is looking after you, when you next see them, what they wrote last time, and how to ask for an appointment.",
    entries: [
      {
        label: "Your clinician and your next appointment",
        entry: {
          what: "The top of the screen names the clinician your record is assigned to and shows your next appointment with its date, type and whether it is in person, by telephone or by video.",
          how: "An appointment marked 'Requested' is one you have asked for and your clinician has not confirmed yet. 'Scheduled' means it is in their calendar.",
          clinical:
            "GET /api/consultation, scoped through the same resolve_patient chokepoint as every other patient endpoint. It reads the Appointment and ClinicalNote rows the clinician console writes, so the patient's view of 'your next appointment' is derived once rather than by two clients independently.",
        },
      },
      {
        label: "Choosing a doctor",
        entry: {
          what: "Booking opens with every available doctor side by side: name, qualification, specialisation, years in practice, working days, consultation hours, how soon they are free and their next available times. You compare them and pick one.",
          how: "Nobody is assigned a doctor automatically. The doctor you choose when you book becomes the clinician on your record if you do not already have one — and if you do, booking a one-off with somebody else does not transfer you off them.",
          clinical:
            "GET /api/consultation/doctors returns every clinician with accepting_patients set, ordered by soonest availability rather than alphabetically — the question being asked is 'who can see me first?'. Each card carries a preview of the next four free times rather than the full grid; shipping every slot for every clinician would be tens of kilobytes to render four cards. POST /api/consultation/request takes clinician_id, and the care relationship is written only when Patient.clinician is empty.",
        },
      },
      {
        label: "Booking a consultation",
        entry: {
          what: "Once you have picked a doctor you see only their slots: working days, hours and slot length, with the times that are actually free. Pick a day, pick a free time, say what it is about, and book.",
          how: "Only real slots are offered, and slots somebody else has taken are shown struck through rather than hidden — a day with two free times looks very different from a day with two times, and you should be able to tell which you are looking at. You can hold one appointment at a time; cancelling frees the slot for someone else immediately.",
          clinical:
            "Availability is derived, not stored: GET /api/consultation/slots generates slots from the clinician's ClinicianProfile pattern (working_days, working_hours, slot_minutes) across the booking horizon and subtracts appointments in scheduled/requested/completed status. POST /api/consultation/request validates that the time is a genuine slot, is inside the horizon, is unheld, and that the patient has no other live booking. The race is settled by a partial unique constraint on (clinician, scheduled_for) excluding cancellations — the pre-check is only there to produce a better message than an integrity error.",
        },
      },
      {
        label: "Video consultations",
        entry: {
          what: "If you booked a video call, a Join meeting button appears on this screen and on your overview. It turns on ten minutes before the start and stays on until the appointment would have ended.",
          how: "Nothing to install — it opens Google Meet in a new tab. Before the window opens the button says when it will; if your clinician has not issued a link yet it says that instead. Outside your appointment there is nothing to click, which is deliberate.",
          clinical:
            "The join window is resolved server-side and delivered as `can_join` on the appointment payload. Clients never compare the start time against their own clock: a machine whose clock has drifted would either hide the button during the consultation or open it early, and both present as an application fault rather than a clock fault. Clinicians set the link per appointment from the console, falling back to their profile's standing room; links are restricted to Meet, Zoom and Teams hosts over https, because this field is presented to a patient as 'join your consultation'.",
        },
      },
      {
        label: "Consultation notes and history",
        entry: {
          what: "The notes your clinician wrote after previous appointments, and a table of every past appointment with its type and outcome.",
          how: "Notes are shown as written. If one was drafted with AI assistance it says so — every such note is reviewed and signed by the clinician before it is stored.",
        },
      },
      {
        label: "Follow-up and treatment recommendations",
        entry: {
          what: "What you are meant to do before the next appointment, and the reasoning behind your current therapy plan in the clinician's own terms.",
          clinical:
            "Follow-up items are assembled from unacknowledged red-flag alerts (urgent first), the prescription's review-after date, and whether an appointment exists at all. Treatment recommendations are the prescription's stored rationale — the same strings the clinician sees on the patient record.",
        },
      },
      {
        label: "Video consultation",
        entry: {
          what: "Appointments can be booked as video calls, and the screen shows when yours is one. Joining the call from inside EchoSense is not built yet.",
          limit:
            "The button is deliberately present and disabled rather than hidden, so the modality on your appointment and what the app can currently do are both visible. Until it is connected, your clinic sends the call link the way it does now.",
        },
      },
    ],
  },

  /* ============================================================ support === */
  {
    id: "support",
    icon: IconChat,
    title: "Everyday Assistant Companion",
    route: "/support",
    audience: "both",
    intro:
      "An assistant that knows your results, available at any hour, in English, Tamil, Hindi, Telugu, Spanish or French.",
    entries: [
      {
        label: "What it can help with",
        entry: {
          what: "Explaining your results, sleep, breathing exercises, working through a difficult thought, how to use your therapy, hearing protection, medication questions.",
          how: "It answers using your own numbers rather than in generalities, and it will tell you when something needs a real clinician.",
        },
      },
      {
        label: "The layout",
        entry: {
          what: "The conversation runs the full width of the page. 'Things I can explain' sits underneath it as a row of cards — tap any one to ask it — and the crisis numbers are below that.",
          how: "The context cards that used to sit in a column beside the conversation were costing every line of every reply about a third of its width. Replies now wrap at a proper reading measure instead of a narrow one, and the page is no taller than it was.",
        },
      },
      {
        label: "Crisis numbers are always on the page",
        entry: {
          what: "The panel at the bottom of the screen lists the crisis lines for your region, and each number is tappable — on a phone it dials.",
          how: "They are shown at all times rather than hidden behind a link. You do not need to be in crisis to call one, and nobody should have to go looking for a phone number while distressed.",
        },
      },
      {
        label: "Safety",
        entry: {
          what: "If you write something suggesting you might harm yourself, or describe an urgent medical sign, it stops and points you to real help immediately — and notifies your clinical team.",
          clinical:
            "Crisis and red-flag routing is deterministic and runs before any language model is consulted, so an urgent disclosure always produces the same correct response and always raises a critical alert. It is never delegated to a model's judgement.",
          limit:
            "It does not diagnose, does not prescribe, and does not replace your audiologist. In an emergency, contact emergency services.",
        },
      },
    ],
  },

  /* ============================================================ numbers === */
  {
    id: "numbers",
    icon: IconChart,
    title: "Your results and what they mean",
    route: "/results",
    audience: "both",
    intro:
      "The report opens on a plain-language summary. Everything technical is one click below it, and nothing was removed.",
    entries: [
      {
        label: "The two layers",
        entry: {
          what: "You land on a clinical summary: your overall hearing, how severe the tinnitus is, what that actually means, the key findings, your risk indicators, and what happens next — with a 3D model of your own cochlea beside the explanation. Under it, 'View Detailed Clinical Report' opens the complete technical report.",
          how: "The summary answers the questions people actually arrive with, in sentences rather than numbers. The full report has the audiogram, every instrument score, the psychoacoustic measurements, the model's reasoning and the coding — open it whenever you want the detail, or take it to your appointment.",
          clinical:
            "The detail section opens expanded for clinicians and collapsed for patients. 'Print / PDF' always expands it first, so a printed report is never silently missing the audiogram because the reader had it collapsed.",
        },
      },
      {
        label: "What this means",
        entry: {
          what: "A short explanation in ordinary sentences: what your hearing grade and severity grade actually amount to, why the two are connected, and what treatment is realistically aiming at.",
          how: "Assembled from the same two verdicts shown in the cards above it, so it cannot drift from the numbers it is summarising, and every sentence is conditional on a measurement that actually exists. Nothing is asserted about a step you did not complete.",
        },
      },
      {
        label: "Your cochlea, beside the explanation",
        entry: {
          what: "A 3D model of your own inner ear sits next to the explanation. Each block along the spiral is a group of hair cells, coloured from your own hearing test — green healthy, gold some loss, red significant loss — with your tinnitus frequency marked.",
          how: "Your percept lands inside your own damaged region. That correspondence is the mechanism, shown on your data, and it is usually the moment people stop asking whether the tinnitus is imaginary. Drag to rotate, scroll to zoom.",
          clinical:
            "Hair cells are positioned by the Greenwood cochlear frequency-position function, f = 165.4·(10^2.1x − 0.88), so each sits at the place that genuinely responds to its frequency. Thresholds come from the report's own audiometry block and the worse ear is shown by default — defaulting to the right ear would hide a unilateral loss half the time. This used to be a standalone page, which meant navigating away from your results to look at a picture of them; it is loaded lazily so the summary renders before Three.js arrives, and it is hidden in print because a WebGL canvas does not render to paper.",
          limit:
            "A schematic teaching aid built to scale relationships, not an anatomical or diagnostic image.",
        },
      },
      {
        label: "THI — Tinnitus Handicap Inventory, /100",
        entry: {
          what: "The main one. It measures how much tinnitus interferes with your life — not how loud it is.",
          how: "It responds to treatment even when the sound itself does not change. A fall of 7 points or more is a real clinical improvement, and it is the number your treatment is judged against.",
          clinical:
            "Newman, Jacobson & Spitzer 1996. 25 items, Yes=4 / Sometimes=2 / No=0. Five grades from Slight to Catastrophic, three subscales (functional 12, emotional 8, catastrophic 5). MCID 7. Maximal responses on the hopelessness cluster (items 5, 8, 19, 23) are flagged separately regardless of total.",
        },
      },
      {
        label: "Matched pitch and loudness",
        entry: {
          what: "The frequency your tinnitus sits at, and how far above your hearing threshold it is.",
          how: "Most people are surprised that the loudness comes out at only a few decibels above threshold even when it feels overwhelming. That gap between measured loudness and experienced intrusiveness is the single most useful thing the assessment demonstrates — and it is why treatment targets distress rather than volume.",
          clinical:
            "Loudness reported in dB SL, referenced to the patient's own threshold at the matched frequency. Pitch match carries a confidence score; below 0.5 the therapy engine withholds the notch.",
        },
      },
      {
        label: "MML and residual inhibition",
        entry: {
          what: "How easily a sound can cover your tinnitus, and whether it goes quiet for a while afterwards.",
          how: "A strong response here predicts that masking-based therapy will help you. No response means habituation and CBT should lead instead.",
          clinical:
            "Minimum masking level in dB SL. RI depth is signed — a negative value means the percept was louder after the masker, which is a contraindication to masking rather than simply 'no effect', and the prescription switches to sub-threshold enrichment.",
        },
      },
      {
        label: "TRI — Tinnitus Reactivity Index, /100",
        entry: {
          what: "A single triage figure combining handicap, annoyance, sleep, anxiety, stress, maskability and sound tolerance.",
          limit:
            "An EchoSense composite, not a validated instrument. Every component and weight is shown in your report, and it is renormalised over what was actually measured so a missing questionnaire does not silently score as zero.",
        },
      },
      {
        label: "The projections",
        entry: {
          what: "Estimated risk of worsening over six months, likelihood that sound therapy helps you, and a projected handicap score.",
          limit:
            "Estimates from models trained on a simulated cohort. They have not been prospectively validated. Held-out performance is published at GET /api/ml/model-card.",
        },
      },
    ],
  },

  /* ========================================================== clinician === */
  {
    id: "caseload",
    icon: IconUser,
    title: "Caseload and triage",
    route: "/clinic",
    audience: "clinician",
    intro:
      "Your patients, ranked by clinical priority, with the ranking inspectable — plus your schedule and the patients who need attention today.",
    entries: [
      {
        label: "Whose patients you see",
        entry: {
          what: "Only yours: patients assigned to you, plus anyone you have an appointment with.",
          clinical:
            "Scoped through permissions.caseload_patients, which is deliberately narrower than visible_patients. The latter is the authorisation boundary — what you *may* act on, which includes unassigned registrations so somebody can pick them up — and answering both questions with one query put every unassigned patient in the system on every clinician's console. Alerts and cohort analytics use the same caseload scope, so the three agree.",
        },
      },
      {
        label: "Critical patients",
        entry: {
          what: "A block at the top of the console for anyone with an emergency-level finding, extreme severity or high modelled risk — with the reason, the last assessment date and a quick view.",
          clinical:
            "Three independent routes in, because they catch different failures: an emergency or urgent red flag; a catastrophic or severe THI grade; and a modelled worsening risk ≥50% or a deterioration past the MCID. A catastrophic score with no red flag is a distress emergency, a red flag with a mild score is a possible retrocochlear lesion, and a high modelled risk is neither — the third is the one that would otherwise be missed. Derived from the caseload row rather than fetched separately, so there is one definition of critical.",
        },
      },
      {
        label: "Their cochlea, in the case",
        entry: {
          what: "Quick view on any row opens that patient's own 3D cochlea beside their numbers, without leaving the console.",
          how: "Hair cells are placed by the Greenwood function and coloured by that patient's thresholds, with their matched tinnitus frequency marked. The same component the patient sees inside their own report, scoped to one patient and sized for a case card.",
          clinical:
            "One case expands at a time. Each mounts a WebGL context and browsers silently discard the oldest past roughly a dozen, so an expand-all would present as cards going randomly blank rather than as a limit. Thresholds come from clinician/patients/<id>/overview, fetched on expand — loading twelve audiograms to render one would be most of a report per row.",
        },
      },
      {
        label: "Your consultation schedule",
        entry: {
          what: "Your specialization, working days, hours, slot length and how many slots are still free today — editable in place.",
          how: "Editing the pattern immediately changes what patients can book. Slots are generated from it rather than stored, so there is nothing to regenerate.",
          clinical:
            "GET/PATCH /api/clinician/schedule. The profile row is created lazily on first PATCH; a clinician who has never opened it is still bookable on Mon–Fri 09:00–13:00 / 14:00–18:00 in 30-minute slots. A default meeting link set here is used by any video appointment with no link of its own.",
        },
      },
      {
        label: "Confirming bookings and issuing meeting links",
        entry: {
          what: "Patient-booked slots arrive as 'Requested'. Confirm turns them into 'Scheduled'. Add link attaches the Google Meet room the patient will join.",
          how: "The link is edited next to the appointment it belongs to, because that is the moment you think about it — not on a settings screen.",
          clinical:
            "PATCH /api/clinician/appointments/<id> accepts meeting_link, status and notes. Links must be https on a Meet, Zoom or Teams host: the patient sees this as 'join your consultation', so an arbitrary URL there is either a mistake or a phishing vector.",
        },
      },
      {
        label: "How the triage score is built",
        entry: {
          what: "A weighted score, 0–100, with every contributing reason listed on the row.",
          clinical:
            "Emergency red flag +55, urgent +40, early-review flag +18; unacknowledged alerts up to +12; predicted worsening risk up to +22; THI up to +14; a ≥7-point THI deterioration +12; adherence below 40% +8; never assessed +9. Safety dominates deliberately — an urgent flag outranks a maximal THI by nearly 3:1. The scorer still computes the historical diary terms; with the diary withdrawn they contribute nothing to a current record and are not displayed.",
          limit:
            "It is a heuristic for ordering attention, not a severity index. The 'Why this order' panel exists so you can disagree with it.",
        },
      },
      {
        label: "Columns",
        entry: {
          what: "THI and its change since baseline, TRI, modelled worsening risk, 28-day adherence, open alerts, and time since last assessment.",
          clinical:
            "Δ THI is bolded when it crosses ±7 (the MCID). Adherence is measured minutes against prescribed minutes over 28 days; the 'Disengaged' filter is adherence below 40%.",
        },
      },
    ],
  },
  {
    id: "redflags",
    icon: IconShield,
    title: "Red-flag screening",
    audience: "clinician",
    intro:
      "Nine rules, run before and independently of the models, so a referral never depends on an ML artifact loading.",
    entries: [
      {
        label: "What is screened",
        entry: {
          what: "Sudden sensorineural hearing loss; pulsatile tinnitus; unilateral tinnitus with ≥15 dB asymmetry; neurological and vestibular accompaniment; severe psychological distress and positive depression screen; hyperacusis with collapsed dynamic range; masking rebound; invalid test environment.",
          clinical:
            "Each returns urgency (routine / soon / urgent / emergency), the recommended action, the evidence that triggered it, and the referral pathway. Following AAO-HNSF and NICE NG155 referral guidance. Sudden SNHL is flagged as an emergency because the corticosteroid window closes sharply after about two weeks.",
        },
      },
    ],
  },
  {
    id: "xai",
    icon: IconTrend,
    title: "Reading the predictions",
    audience: "clinician",
    intro: "Every prediction carries a per-patient attribution you can argue with.",
    entries: [
      {
        label: "The waterfall chart",
        entry: {
          what: "Bars run from the cohort baseline to this patient's prediction. Red bars pushed the risk up, green bars pulled it down. Faded bars mean the value was not measured.",
          clinical:
            "Permutation-sampling Shapley values (Štrumbelj & Kononenko), 48 antithetic orderings against a 256-row cohort background. Local accuracy is enforced, so the bars sum exactly to f(x) − E[f] and the chart cannot omit a contribution. This is deliberately not global feature importance, which answers a different question.",
        },
      },
      {
        label: "Counterfactuals",
        entry: {
          what: "Drag a modifiable value — stress, sleep, anxiety — and re-score to see which lever actually moves the number.",
          limit:
            "Model sensitivity, not a guaranteed treatment effect. Only clinically modifiable fields can be overridden.",
        },
      },
      {
        label: "Model performance",
        entry: {
          what: "Published in full at GET /api/ml/model-card.",
          clinical:
            "Worsening risk ROC AUC 0.93 (sens 0.96 / spec 0.79 / NPV 0.995 at a Youden-tuned threshold); therapy response 0.87; distress band 0.93 macro-OvR; pitch prediction 81% within half an octave. Binary targets are isotonic-calibrated so a stated probability is usable rather than merely a ranking. THI-at-6-months R² on the *change* is 0.57 — the 0.98 on the absolute level is inflated by baseline THI and is not the headline.",
          limit:
            "The shipped weights are trained on a simulated cohort generated from published epidemiology. No demographic subgroup fairness audit is possible on simulated data; that must be performed before any real deployment. Retraining on real records is a single command.",
        },
      },
    ],
  },
  {
    id: "prescribing",
    icon: IconSpark,
    title: "The therapy engine",
    audience: "clinician",
    intro: "Prescriptions are derived from the measurements, not selected from a menu.",
    entries: [
      {
        label: "How a plan is decided",
        entry: {
          what: "Strategy is chosen from residual inhibition and maskability; blocks are added for the specific drivers found; dose scales with handicap; review interval shortens with risk.",
          clinical:
            "Rebound or reduced sound tolerance forces sub-threshold and overrides any level the models would otherwise suggest. Positive RI with good maskability selects masking-forward. An unreliable pitch match withholds the notch entirely. Sleep and psychological blocks are added on PSQI/GAD-7 thresholds. Every block cites the finding that produced it in the rationale.",
        },
      },
      {
        label: "Adaptation",
        entry: {
          what: "After four or more logged sessions, the plan can be re-weighted from measured per-modality relief.",
          clinical:
            "Mean pre/post VAS drop per modality. Blocks with ≥1.0 points gain time; blocks with ≤0.1 are withdrawn and their minutes reallocated. Requires four sessions — below that there is not enough signal to justify changing a plan.",
        },
      },
      {
        label: "Approval",
        entry: {
          what: "Generated plans stay flagged as AI drafts until a named clinician approves them.",
          clinical: "Same for notes: the SOAP draft must be edited and signed, and codes marked 'verify' confirmed, before it files.",
        },
      },
    ],
  },
  {
    id: "records",
    icon: IconClipboard,
    title: "Records and export",
    audience: "clinician",
    intro: "Coding, documentation and data out.",
    entries: [
      {
        label: "ICD-11 coding",
        entry: {
          what: "A problem list is proposed from the findings, with the reasoning for each code.",
          limit:
            "Codes that could not be verified against the current MMS release are flagged 'verify' rather than asserted. A coding assistant that quietly invents plausible codes is worse than none.",
        },
      },
      {
        label: "HL7 FHIR R4 export",
        entry: {
          what: "A complete Bundle for the encounter, ready to post to an EHR.",
          clinical:
            "One Observation per ear with a component per frequency, a RiskAssessment carrying the model rationale, a CarePlan of therapy blocks, and Conditions with ICD-11 codings. Tinnitus psychoacoustics have no universal LOINC, so they are published under a local CodeSystem — which is what FHIR expects for locally-defined measures rather than guessing at a standard code.",
        },
      },
      {
        label: "Research extract",
        entry: {
          what: "A de-identified CSV across the caseload, from the button on the caseload header.",
          clinical:
            "Consent-gated inclusion; MRN replaced by a salted SHA-256 pseudonym so records link longitudinally but cannot be re-identified; age banded into five-year groups, because exact age plus a rare audiometric profile is re-identifying in a small cohort. 33 columns, one row per completed assessment, date-stamped filename.",
        },
      },
      {
        label: "How exports are delivered",
        entry: {
          what: "Files download straight to your machine with a date-stamped name.",
          clinical:
            "UTF-8 with a BOM so Excel reads multilingual free text correctly, booleans as 1/0, and an explicit charset in the content type. Exports are fetched with the session token and saved as a blob rather than opened as a link — browser navigation carries no Authorization header, which is why link-based exports failed silently.",
        },
      },
    ],
  },
];

export default function Guide() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [audience, setAudience] = useState<Audience>("patient");
  const session = useSession((s) => s.session);
  const videoRef = useRef<HTMLDivElement>(null);
  /**
   * Remount the player to restart it.
   *
   * "Watch again" has to work when the video has already ended, and a `<video>`
   * that has ended stays ended — the alternative is reaching into the element
   * imperatively from outside the component, which is exactly the coupling the
   * shared component exists to avoid. Changing the key is one line and cannot
   * get out of step with the player's own state.
   */
  const [watchNonce, setWatchNonce] = useState(0);

  /**
   * Replay the whole onboarding sequence: video, then the guided tour.
   *
   * Clears the completion flag and reloads, which is the only way to re-enter
   * a sequence the shell decides about at session level. Opening the tour
   * locally would show it without the video and would leave the flag set, so
   * the next login would skip it again — which is not what the button says.
   */
  function replayOnboarding() {
    if (session) resetWalkthrough(session.user_id);
    navigate("/");
    window.location.reload();
  }

  /** Section title and intro, translated, falling back to the English source. */
  const sectionTitle = (section: Section) =>
    t(`guide.section.${section.id}.title`, { defaultValue: section.title });
  const sectionIntro = (section: Section) =>
    t(`guide.section.${section.id}.intro`, { defaultValue: section.intro }) || section.intro;
  /** One entry field, translated, falling back to the English source. */
  const entryText = (section: Section, index: number, field: string, fallback: string) =>
    t(`guide.section.${section.id}.entries.${index}.${field}`, { defaultValue: fallback });
  const role = useSession((s) => s.session?.role);
  const isClinician = role === "clinician" || role === "admin";
  const visible = SECTIONS.filter((s) => s.audience === "both" || s.audience === audience);

  /**
   * Whether to offer the "Open …" button for a section.
   *
   * The audience switch is a reading preference, not an authorisation check — a
   * patient may read the clinician documentation, and should be able to. But the
   * clinician sections describe screens a patient's router will not serve, so
   * rendering the button for them would produce a link that lands on Not found.
   * The prose stays; the door does not.
   */
  const canOpen = (section: Section): boolean =>
    Boolean(section.route) && (section.audience !== "clinician" || isClinician);

  return (
    <div className="stack stack-6">
      <header className="pagehead">
        <div className="pagehead__title">
          <span className="label label--signal">{t("guide.label")}</span>
          <h1 style={{ fontSize: "clamp(2rem, 5vw, 3.25rem)" }}>{t("guide.title")}</h1>
          <p className="lead">{t("guide.lead")}</p>
        </div>
        <div className="btn-group">
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={audience === "patient"}
            onClick={() => setAudience("patient")}
          >
            {t("guide.forPatients")}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            aria-pressed={audience === "clinician"}
            onClick={() => setAudience("clinician")}
          >
            {t("guide.forClinicians")}
          </button>
        </div>
      </header>

      {/* -- introduction video --------------------------------------------- */}
      {/* Above the contents grid so it is the first thing on the page for
          somebody who has come here because they do not know where to start —
          which is most of the traffic this screen gets. Patients only: the six
          steps it walks through are the patient navigation. */}
      {!isClinician && (
        <Panel bracketed className="guidevideo">
          <div ref={videoRef} className="stack stack-4">
            <div className="stack stack-1">
              <span className="label label--signal">{t("video.gettingStarted")}</span>
              <h2 style={{ fontSize: "var(--fs-h2)" }}>{t("video.welcomeTitle")}</h2>
              <p className="lead" style={{ fontSize: "var(--fs-body)" }}>{t("video.welcomeLead")}</p>
            </div>

            {/* Native controls here, unlike the onboarding modal: this is a
                reference screen, so scrubbing back to the bit about the hearing
                test and going fullscreen matter more than the control bar
                matching the product's type. */}
            <OnboardingVideo key={watchNonce} nativeControls />

            <div className="row row--tight">
              <button type="button" className="btn btn--primary btn--sm" onClick={replayOnboarding}>
                <IconSpark size={15} />
                {t("video.startTour")}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setWatchNonce((n) => n + 1);
                  videoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {t("video.watchAgain")}
              </button>
              <Link className="btn btn--sm btn--ghost" to="/">
                {t("video.goToDashboard")}
              </Link>
            </div>
          </div>
        </Panel>
      )}

      <div className="grid grid-sidebar" style={{ ["--aside" as string]: "230px" }}>
        {/* -- content ------------------------------------------------------- */}
        <div className="stack stack-6">
          {visible.map((section) => (
            <section key={section.id} id={section.id} className="stack stack-4">
              <div className="row row--tight row--nowrap">
                <span className="iconbadge">
                  <section.icon size={20} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: "var(--fs-h3)" }}>{sectionTitle(section)}</h2>
                  <p className="meta">{sectionIntro(section)}</p>
                </div>
              </div>

              <div className="stack stack-3">
                {section.entries.map(({ label, entry }, index) => (
                  <Panel key={label} tight>
                    <div className="stack stack-3">
                      <strong style={{ fontSize: "var(--fs-body)" }}>
                        {entryText(section, index, "label", label)}
                      </strong>
                      <p style={{ fontSize: "var(--fs-small)", lineHeight: 1.6 }}>
                        {entryText(section, index, "what", entry.what)}
                      </p>

                      {entry.how && (
                        <p className="meta" style={{ fontSize: "var(--fs-tiny)", lineHeight: 1.65 }}>
                          {entryText(section, index, "how", entry.how)}
                        </p>
                      )}

                      {entry.clinical && audience === "clinician" && (
                        <Disclosure summary={t("guide.methodAndCutPoints")}>
                          <p className="meta" style={{ lineHeight: 1.65 }}>
                            {entryText(section, index, "clinical", entry.clinical)}
                          </p>
                        </Disclosure>
                      )}

                      {entry.limit && (
                        <div
                          className="row row--tight row--top row--nowrap"
                          style={{
                            borderLeft: "3px solid var(--warn)",
                            paddingLeft: "var(--s3)",
                          }}
                        >
                          <IconAlert size={15} style={{ color: "var(--warn-ink)", marginTop: 2, flex: "none" }} />
                          <p className="meta" style={{ lineHeight: 1.6 }}>
                            {entryText(section, index, "limit", entry.limit)}
                          </p>
                        </div>
                      )}
                    </div>
                  </Panel>
                ))}
              </div>

              {canOpen(section) && (
                <Link className="btn btn--sm" to={section.route!}>
                  {t("guide.openSection", { section: sectionTitle(section) })}
                </Link>
              )}
            </section>
          ))}

          <Panel tone="sunken">
            <div className="stack stack-2">
              <span className="label">{t("guide.inShort")}</span>
              <p style={{ fontSize: "var(--fs-small)" }}>{t("guide.inShortBody")}</p>
            </div>
          </Panel>
        </div>

        {/* -- section index -------------------------------------------------- */}
        <nav aria-label={t("guide.guideContents")}>
          <div style={{ position: "sticky", top: "calc(58px + var(--s5))" }}>
            <Panel tight>
              <span className="label" style={{ marginBottom: "var(--s3)" }}>
                {t("guide.contents")}
              </span>
              <div className="stack stack-1">
                {visible.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="row row--tight row--nowrap"
                    style={{
                      textDecoration: "none",
                      color: "var(--ink-2)",
                      fontSize: "var(--fs-tiny)",
                      fontWeight: 600,
                      padding: "5px 0",
                    }}
                  >
                    <section.icon size={15} />
                    <span>{sectionTitle(section)}</span>
                  </a>
                ))}
              </div>
              <hr className="rule rule--tight" />
              <div className="stack stack-2">
                <Chip tone="ghost">
                  {t(audience === "patient" ? "guide.patientView" : "guide.clinicianView")}
                </Chip>
                <p className="meta">
                  {t(audience === "patient" ? "guide.patientViewNote" : "guide.clinicianViewNote")}
                </p>
              </div>
            </Panel>

            <Panel tight tone="sunken" style={{ marginTop: "var(--s3)" }}>
              <div className="stack stack-2">
                <span className="label">{t("guide.needAHand")}</span>
                <p className="meta">
                  <Trans i18nKey="guide.needAHandBody" components={[<strong key="0" />]} />
                </p>
              </div>
            </Panel>
          </div>
        </nav>
      </div>
    </div>
  );
}

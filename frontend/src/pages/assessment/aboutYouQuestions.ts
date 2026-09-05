/**
 * The extended "About You" questionnaire.
 *
 * A data-driven registry rather than 70 hand-written question components,
 * following the same principle the backend's instrument registry already
 * uses for THI/GAD-7/PSS: the question set is data, and one generic renderer
 * (`AboutYouExtended.tsx`) draws whatever this file describes. Adding or
 * rewording a question is an edit here, not a new component.
 *
 * **Four questions here replace an existing, narrower one** rather than
 * sitting alongside it — because they are the same clinical question asked
 * more completely, and the app already asked it once:
 *
 *  - `sound_description` (Section 4) replaces the old single "what does it
 *    sound like" character picker.
 *  - `tinnitus_location` (Section 3) replaces the old laterality picker.
 *  - `pulsatile_beats_with_heart` (Section 6) replaces the old "pulsatile"
 *    checkbox.
 *  - `hearing_aids_current` (Section 14) replaces the old "hearing aids"
 *    checkbox.
 *
 * `Assessment.tsx` derives `tinnitus_character(s)`, `laterality`, `pulsatile`
 * and `hearing_aid_use` from these four answers at submit time, so the fields
 * the rest of the system already reads (red flags, the ML feature vector, the
 * report) keep receiving exactly what they always have — see the mapping
 * functions exported at the bottom of this file.
 *
 * Every other question is new and is stored only in `Patient.about_you`,
 * verbatim, under the key named here. A handful are additionally *merged*
 * into an existing list field server-side — see
 * `PatientProfileUpdateSerializer._sync_about_you` for `medical_conditions_select`
 * (into `comorbidities`) and `medications_detailed` (into `medications`) — but
 * nothing here is ever the sole writer of those two; the existing History
 * disclosure and medications box keep working exactly as before.
 *
 * Text is written in English with no i18n key, matching how `Guide.tsx`
 * documents its own convention: this is reference content added in one pass,
 * translated over time, and an untranslated line of accurate English is a far
 * better failure mode than a blank card or a raw key. `Assessment.tsx` wraps
 * every string from here in `t(...)` with the English text as the
 * `defaultValue`, so a translation can be added later without touching this
 * file's shape.
 */

export type AboutYouAnswer = string | string[] | number | MedicationEntry[] | undefined;
export type AboutYouAnswers = Record<string, AboutYouAnswer>;

export interface MedicationEntry {
  name: string;
  dose: string;
  frequency: string;
}

export type AboutYouQuestionType = "single" | "multi" | "scale" | "text" | "textarea" | "medications";

export interface AboutYouOption {
  value: string;
  /** Selecting this reveals a paired free-text field stored under `${key}__other`. */
  other?: boolean;
  /** Selecting this in a multi-select clears every other selection in the same question. */
  exclusive?: boolean;
}

export interface AboutYouQuestion {
  key: string;
  type: AboutYouQuestionType;
  prompt: string;
  options?: AboutYouOption[];
  optional?: boolean;
  placeholder?: string;
  scaleLabels?: { low: string; high: string };
  /** Rendered only when this returns true. Reads sibling answers already collected. */
  visibleIf?: (answers: AboutYouAnswers) => boolean;
  note?: string;
  noteTone?: "warn" | "info";
}

export interface AboutYouSection {
  id: string;
  title: string;
  intro?: string;
  questions: AboutYouQuestion[];
}

const yn = (key: string, prompt: string, visibleIf?: (a: AboutYouAnswers) => boolean): AboutYouQuestion => ({
  key,
  type: "single",
  prompt,
  options: [{ value: "Yes" }, { value: "No" }, { value: "I'm not sure" }],
  visibleIf,
});

export const ABOUT_YOU_SECTIONS: AboutYouSection[] = [
  // ==================================================== 1 — tinnitus profile
  {
    id: "onset",
    title: "1. Tinnitus Profile",
    questions: [
      {
        key: "onset_timing",
        type: "single",
        prompt: "When did you first become aware of your tinnitus?",
        options: [
          { value: "Within the last week" },
          { value: "1 week–1 month ago" },
          { value: "1–6 months ago" },
          { value: "6–12 months ago" },
          { value: "1–5 years ago" },
          { value: "More than 5 years ago" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
      },
      {
        key: "onset_manner",
        type: "single",
        prompt: "Did your tinnitus begin suddenly or gradually?",
        options: [
          { value: "Suddenly" },
          { value: "Gradually" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
      },
      yn("onset_hearing_change", "Did you notice any change in your hearing when your tinnitus began?"),
      {
        key: "onset_events",
        type: "multi",
        prompt: "Do you remember anything happening around the time your tinnitus started?",
        options: [
          { value: "Loud-noise exposure" },
          { value: "Ear infection or illness" },
          { value: "Ear blockage" },
          { value: "Hearing change" },
          { value: "Head or neck injury" },
          { value: "Jaw problems" },
          { value: "Stressful period" },
          { value: "Medication change" },
          { value: "No identifiable event", exclusive: true },
          { value: "I'm not sure", exclusive: true },
          { value: "Other", other: true },
        ],
      },
      { key: "onset_more", type: "textarea", prompt: "Would you like to tell us more?", optional: true },
    ],
  },

  // ============================================== 2 — how often experienced
  {
    id: "frequency",
    title: "2. How Often Do You Experience Tinnitus?",
    questions: [
      {
        key: "occurrence_frequency",
        type: "single",
        prompt: "How often do you hear your tinnitus?",
        options: [
          { value: "All the time" },
          { value: "Most of the time" },
          { value: "Some of the time" },
          { value: "Occasionally" },
          { value: "Rarely" },
          { value: "Other", other: true },
        ],
      },
      {
        key: "episode_duration",
        type: "single",
        prompt: "When you notice it, how long does it usually last?",
        options: [
          { value: "A few seconds" },
          { value: "A few minutes" },
          { value: "Less than an hour" },
          { value: "Several hours" },
          { value: "Most of the day" },
          { value: "It is continuous" },
          { value: "Other", other: true },
        ],
      },
    ],
  },

  // ===================================================== 3 — where you hear it
  {
    id: "location",
    title: "3. Where Do You Hear Your Tinnitus?",
    questions: [
      {
        key: "tinnitus_location",
        type: "single",
        prompt: "Where do you hear your tinnitus?",
        options: [
          { value: "Left ear" },
          { value: "Right ear" },
          { value: "Both ears" },
          { value: "In the middle of my head" },
          { value: "It feels like it is outside my ears" },
          { value: "I'm not sure" },
          { value: "Other / difficult to describe", other: true },
        ],
      },
      yn("location_changes", "Does the location of your tinnitus change?"),
      {
        key: "location_changes_description",
        type: "textarea",
        prompt: "Please describe how it changes.",
        visibleIf: (a) => a.location_changes === "Yes",
      },
    ],
  },

  // ============================================= 4 — what it sounds like
  {
    id: "sound",
    title: "4. What Does Your Tinnitus Sound Like?",
    questions: [
      {
        key: "sound_description",
        type: "multi",
        prompt: "Which sounds best describe your tinnitus?",
        options: [
          { value: "Ringing" },
          { value: "Buzzing" },
          { value: "Hissing" },
          { value: "Whistling" },
          { value: "Humming" },
          { value: "Clicking" },
          { value: "Static/crackling" },
          { value: "Roaring" },
          { value: "Pulsing/throbbing" },
          { value: "Other", other: true },
          { value: "I'm not sure", exclusive: true },
        ],
      },
      yn("sound_multiple", "Do you hear more than one type of sound?"),
      {
        key: "sound_multiple_description",
        type: "textarea",
        prompt: "Please describe the different sounds.",
        visibleIf: (a) => a.sound_multiple === "Yes",
      },
    ],
  },

  // =================================================== 5 — does it change
  {
    id: "variability",
    title: "5. Does Your Tinnitus Change?",
    questions: [
      {
        key: "variability_pattern",
        type: "single",
        prompt: "How would you describe your tinnitus?",
        options: [
          { value: "Mostly steady" },
          { value: "Changes in loudness" },
          { value: "Changes in pitch" },
          { value: "Changes in both loudness and pitch" },
          { value: "Comes and goes" },
          { value: "Changes unpredictably" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
      },
      {
        key: "variability_speed",
        type: "single",
        prompt: "How quickly can your tinnitus change?",
        options: [
          { value: "It stays about the same" },
          { value: "Changes gradually" },
          { value: "Changes suddenly" },
          { value: "Changes from moment to moment" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
      },
    ],
  },

  // ==================================================== 6 — pulsatile
  {
    id: "pulsatile",
    title: "6. Does Your Tinnitus Pulse?",
    questions: [
      {
        key: "pulsatile_beats_with_heart",
        type: "single",
        prompt: "Does your tinnitus ever seem to beat or pulse in time with your heartbeat?",
        options: [{ value: "Yes" }, { value: "No" }, { value: "I'm not sure" }],
        note:
          "Clinical review flag: Tinnitus that appears to pulse in time with the heartbeat may require further clinical assessment.",
        noteTone: "warn",
      },
      {
        key: "pulsatile_ear",
        type: "single",
        prompt: "Does it usually occur in:",
        options: [
          { value: "Left ear" },
          { value: "Right ear" },
          { value: "Both ears" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.pulsatile_beats_with_heart === "Yes",
      },
    ],
  },

  // ==================================================== 7 — how loud
  {
    id: "loudness",
    title: "7. How Loud Is Your Tinnitus?",
    questions: [
      {
        key: "loudness_usual",
        type: "scale",
        prompt: "How loud does your tinnitus usually seem?",
        scaleLabels: { low: "Not audible", high: "Extremely loud" },
      },
      {
        key: "loudness_worst",
        type: "scale",
        prompt: "How loud does your tinnitus get at its worst?",
        scaleLabels: { low: "Not audible", high: "Extremely loud" },
      },
      {
        key: "loudness_best",
        type: "scale",
        prompt: "How quiet does your tinnitus get at its best?",
        scaleLabels: { low: "Not audible", high: "Extremely loud" },
      },
    ],
  },

  // ================================================= 8 — how noticeable
  {
    id: "noticeability",
    title: "8. How Noticeable Is Your Tinnitus?",
    questions: [
      {
        key: "noticeability_typical_day",
        type: "scale",
        prompt: "How noticeable is your tinnitus during a typical day?",
        scaleLabels: { low: "I rarely notice it", high: "I notice it almost constantly" },
      },
      {
        key: "attention_shift_difficulty",
        type: "scale",
        prompt: "How difficult is it to shift your attention away from your tinnitus?",
        scaleLabels: { low: "Very easy", high: "Very difficult" },
      },
    ],
  },

  // =============================================== 9 — when most noticeable
  {
    id: "when_noticeable",
    title: "9. When Do You Notice It Most?",
    questions: [
      {
        key: "when_most_noticeable",
        type: "multi",
        prompt: "When is your tinnitus most noticeable?",
        options: [
          { value: "In quiet environments" },
          { value: "At bedtime" },
          { value: "During the night" },
          { value: "When I wake up" },
          { value: "In the morning" },
          { value: "During the day" },
          { value: "When concentrating" },
          { value: "When I am stressed" },
          { value: "When I am tired" },
          { value: "After loud sounds" },
          { value: "When I am alone" },
          { value: "Other", other: true },
          { value: "There is no particular pattern", exclusive: true },
          { value: "I'm not sure", exclusive: true },
        ],
      },
    ],
  },

  // ============================================== 10 — what makes it worse
  {
    id: "aggravating",
    title: "10. What Makes Your Tinnitus Worse?",
    questions: [
      {
        key: "aggravating_factors",
        type: "multi",
        prompt: "Have you noticed anything that increases or changes your tinnitus?",
        options: [
          { value: "Stress" },
          { value: "Poor sleep" },
          { value: "Fatigue" },
          { value: "Loud sounds/noise" },
          { value: "Quiet environments" },
          { value: "Certain environments" },
          { value: "Head or neck movement" },
          { value: "Jaw movement" },
          { value: "Changes in body position" },
          { value: "Physical activity" },
          { value: "Illness" },
          { value: "Caffeine" },
          { value: "Alcohol" },
          { value: "Other", other: true },
          { value: "Nothing I have noticed", exclusive: true },
          { value: "I'm not sure", exclusive: true },
        ],
      },
    ],
  },

  // ============================================= 11 — what makes it easier
  {
    id: "relieving",
    title: "11. What Makes Your Tinnitus Easier?",
    questions: [
      {
        key: "relieving_factors",
        type: "multi",
        prompt: "What helps you notice your tinnitus less or cope with it better?",
        options: [
          { value: "Background noise" },
          { value: "Music" },
          { value: "Nature sounds" },
          { value: "Fan/white noise" },
          { value: "Talking with someone" },
          { value: "Staying busy" },
          { value: "Relaxation" },
          { value: "Physical activity" },
          { value: "Sleep/rest" },
          { value: "Hearing aids" },
          { value: "Sound therapy" },
          { value: "Other", other: true },
          { value: "Nothing I have noticed", exclusive: true },
          { value: "I'm not sure", exclusive: true },
        ],
      },
    ],
  },

  // ============================================ 12 — does movement affect it
  {
    id: "movement",
    title: "12. Does Movement Affect Your Tinnitus?",
    questions: [
      yn("movement_head_neck", "Move your head or neck?"),
      {
        key: "movement_head_neck_change",
        type: "single",
        prompt: "How does your tinnitus change?",
        options: [
          { value: "Gets louder" },
          { value: "Gets quieter" },
          { value: "Changes pitch" },
          { value: "Changes sound" },
          { value: "Appears" },
          { value: "Disappears" },
          { value: "Other", other: true },
          { value: "I'm not sure" },
        ],
        visibleIf: (a) => a.movement_head_neck === "Yes",
      },
      yn("movement_jaw", "Move or clench your jaw?"),
      {
        key: "movement_jaw_change",
        type: "single",
        prompt: "How does your tinnitus change?",
        options: [
          { value: "Gets louder" },
          { value: "Gets quieter" },
          { value: "Changes pitch" },
          { value: "Changes sound" },
          { value: "Appears" },
          { value: "Disappears" },
          { value: "Other", other: true },
          { value: "I'm not sure" },
        ],
        visibleIf: (a) => a.movement_jaw === "Yes",
      },
      yn("movement_touch", "Touch around your ear, head, face or neck?"),
      {
        key: "movement_touch_change",
        type: "single",
        prompt: "How does your tinnitus change?",
        options: [
          { value: "Gets louder" },
          { value: "Gets quieter" },
          { value: "Changes pitch" },
          { value: "Changes sound" },
          { value: "Appears" },
          { value: "Disappears" },
          { value: "Other", other: true },
          { value: "I'm not sure" },
        ],
        visibleIf: (a) => a.movement_touch === "Yes",
      },
      yn("movement_body_position", "Change your body position?"),
      {
        key: "movement_body_position_change",
        type: "single",
        prompt: "How does your tinnitus change?",
        options: [
          { value: "Gets louder" },
          { value: "Gets quieter" },
          { value: "Changes pitch" },
          { value: "Changes sound" },
          { value: "Appears" },
          { value: "Disappears" },
          { value: "Other", other: true },
          { value: "I'm not sure" },
        ],
        visibleIf: (a) => a.movement_body_position === "Yes",
      },
      yn("movement_exercise", "Exercise or become physically active?"),
      {
        key: "movement_exercise_change",
        type: "single",
        prompt: "How does your tinnitus change?",
        options: [
          { value: "Gets louder" },
          { value: "Gets quieter" },
          { value: "Changes pitch" },
          { value: "Changes sound" },
          { value: "Appears" },
          { value: "Disappears" },
          { value: "Other", other: true },
          { value: "I'm not sure" },
        ],
        visibleIf: (a) => a.movement_exercise === "Yes",
      },
    ],
  },

  // ======================================= 13 — hearing & ear health
  {
    id: "hearing_health",
    title: "13. Your Hearing & Ear Health",
    questions: [
      yn("hearing_difficulty", "Do you feel that you have difficulty hearing?"),
      {
        key: "speech_in_noise_difficulty",
        type: "single",
        prompt: "Do you find it difficult to understand speech in noisy places?",
        options: [
          { value: "Often" },
          { value: "Sometimes" },
          { value: "Rarely" },
          { value: "Never" },
          { value: "I'm not sure" },
        ],
      },
      {
        key: "had_hearing_test",
        type: "single",
        prompt: "Have you had a hearing test?",
        options: [{ value: "Yes" }, { value: "No" }, { value: "I don't remember" }],
      },
      {
        key: "hearing_test_recency",
        type: "single",
        prompt: "When was your most recent hearing test?",
        options: [
          { value: "Within the last 6 months" },
          { value: "6–12 months ago" },
          { value: "1–2 years ago" },
          { value: "More than 2 years ago" },
          { value: "I don't remember" },
          { value: "Other / I'd like to specify", other: true },
        ],
        visibleIf: (a) => a.had_hearing_test === "Yes",
      },
      {
        key: "told_hearing_loss",
        type: "single",
        prompt: "Were you told that you had hearing loss?",
        options: [{ value: "Yes" }, { value: "No" }, { value: "I'm not sure" }],
        visibleIf: (a) => a.had_hearing_test === "Yes",
      },
      {
        key: "hearing_loss_ear",
        type: "single",
        prompt: "Which ear?",
        options: [
          { value: "Left" },
          { value: "Right" },
          { value: "Both" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.had_hearing_test === "Yes" && a.told_hearing_loss === "Yes",
      },
    ],
  },

  // ==================================== 14 — hearing aids / devices
  {
    id: "hearing_aids",
    title: "14. Do You Use Hearing Aids or Other Hearing Devices?",
    questions: [
      {
        key: "hearing_aids_current",
        type: "single",
        prompt: "Do you currently use hearing aids?",
        options: [{ value: "Yes" }, { value: "No" }],
      },
      {
        key: "hearing_aids_frequency",
        type: "single",
        prompt: "How often do you use your hearing aids?",
        options: [
          { value: "All day" },
          { value: "Most of the day" },
          { value: "Some of the day" },
          { value: "Occasionally" },
          { value: "Rarely" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.hearing_aids_current === "Yes",
      },
      {
        key: "other_hearing_devices",
        type: "single",
        prompt: "Do you use any other hearing or sound devices?",
        options: [{ value: "Yes" }, { value: "No" }],
      },
      {
        key: "other_hearing_devices_detail",
        type: "text",
        prompt: "Please specify:",
        visibleIf: (a) => a.other_hearing_devices === "Yes",
      },
    ],
  },

  // ============================== 15 — other ear-related symptoms
  {
    id: "ear_symptoms",
    title: "15. Other Ear-Related Symptoms",
    questions: [
      {
        key: "current_ear_symptoms",
        type: "multi",
        prompt: "Do you currently experience any of the following?",
        options: [
          { value: "Hearing changes" },
          { value: "Ear fullness or pressure" },
          { value: "Ear pain" },
          { value: "Dizziness or vertigo" },
          { value: "Sound sensitivity" },
          { value: "Ear blockage" },
          { value: "Ear discharge" },
          { value: "Recurrent ear infections" },
          { value: "None of these", exclusive: true },
          { value: "Other", other: true },
        ],
      },
      yn("past_ear_problems", "Have you ever had problems with your ears?"),
      {
        key: "past_ear_problems_detail",
        type: "multi",
        prompt: "Which problems?",
        options: [
          { value: "Ear infections" },
          { value: "Earwax blockage" },
          { value: "Eardrum problems" },
          { value: "Middle-ear problems" },
          { value: "Inner-ear problems" },
          { value: "Ear injury" },
          { value: "Ear surgery" },
          { value: "Other", other: true },
          { value: "I'm not sure", exclusive: true },
        ],
        visibleIf: (a) => a.past_ear_problems === "Yes",
      },
    ],
  },

  // ==================================== 16 — medical conditions
  {
    id: "medical_conditions",
    title: "16. Medical Conditions",
    questions: [
      {
        key: "has_medical_conditions",
        type: "single",
        prompt:
          "Do you currently have, or have you previously been diagnosed with, any medical conditions?",
        options: [
          { value: "Yes" },
          { value: "No" },
          { value: "I'm not sure" },
          { value: "Prefer not to say" },
        ],
      },
      {
        key: "medical_conditions_select",
        type: "multi",
        prompt: "Which conditions?",
        options: [
          { value: "High blood pressure" },
          { value: "Diabetes" },
          { value: "High cholesterol" },
          { value: "Heart/cardiovascular condition" },
          { value: "Blood vessel/circulation problems" },
          { value: "Thyroid condition" },
          { value: "Neurological condition" },
          { value: "Migraine" },
          { value: "Kidney disease" },
          { value: "Liver disease" },
          { value: "Autoimmune condition" },
          { value: "Sleep disorder" },
          { value: "Anxiety or stress-related condition" },
          { value: "Depression or other mood condition" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.has_medical_conditions === "Yes",
      },
      {
        key: "medical_conditions_more",
        type: "textarea",
        prompt: "Are there any other medical conditions you would like to mention?",
        optional: true,
      },
    ],
  },

  // =========================================== 17 — head, neck & jaw
  {
    id: "head_neck_jaw",
    title: "17. Head, Neck & Jaw Health",
    questions: [
      yn("head_neck_injury", "Have you experienced a significant head or neck injury?"),
      {
        key: "head_neck_injury_worsened",
        type: "single",
        prompt: "Did your tinnitus begin or become worse after the injury?",
        options: [{ value: "Yes" }, { value: "No" }, { value: "I'm not sure" }],
        visibleIf: (a) => a.head_neck_injury === "Yes",
      },
      yn("jaw_problems", "Do you experience jaw-related problems?"),
      {
        key: "jaw_problems_detail",
        type: "multi",
        prompt: "Which jaw-related problems?",
        options: [
          { value: "Jaw pain" },
          { value: "Jaw clicking/popping" },
          { value: "Difficulty opening the mouth" },
          { value: "Teeth grinding/clenching" },
          { value: "Jaw stiffness" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.jaw_problems === "Yes",
      },
    ],
  },

  // ==================================== 18 — current medications
  {
    id: "medications",
    title: "18. Current Medications",
    questions: [
      {
        key: "taking_medications",
        type: "single",
        prompt: "Are you currently taking any medications?",
        options: [{ value: "Yes" }, { value: "No" }, { value: "I'm not sure" }],
      },
      {
        key: "medications_detailed",
        type: "medications",
        prompt: "Please list each medication, its dose, and how often you take it.",
        visibleIf: (a) => a.taking_medications === "Yes",
      },
      {
        key: "medication_changed_recently",
        type: "single",
        prompt: "Have you recently started, stopped, or changed the dose of any medication?",
        options: [{ value: "Yes" }, { value: "No" }, { value: "I'm not sure" }],
      },
      {
        key: "medication_change_timing",
        type: "single",
        prompt: "When did the change occur?",
        options: [
          { value: "Within the last week" },
          { value: "1 week–1 month ago" },
          { value: "1–6 months ago" },
          { value: "More than 6 months ago" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.medication_changed_recently === "Yes",
      },
      {
        key: "medication_change_tinnitus_effect",
        type: "single",
        prompt: "Did you notice any change in your tinnitus around the same time?",
        options: [
          { value: "Became louder" },
          { value: "Became quieter" },
          { value: "The sound changed" },
          { value: "No noticeable change" },
          { value: "I'm not sure" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.medication_changed_recently === "Yes",
        note:
          "Important: Do not stop or change a prescribed medication because of tinnitus without discussing it with a qualified healthcare professional.",
        noteTone: "warn",
      },
    ],
  },

  // ==================================== 19 — previous tinnitus care
  {
    id: "previous_care",
    title: "19. Previous Tinnitus Care",
    questions: [
      yn("sought_professional_help", "Have you previously sought professional help for your tinnitus?"),
      {
        key: "consulted_professionals",
        type: "multi",
        prompt: "Who have you consulted?",
        options: [
          { value: "ENT doctor" },
          { value: "Audiologist" },
          { value: "Hearing healthcare professional" },
          { value: "General physician/family doctor" },
          { value: "Psychologist/counsellor" },
          { value: "Neurologist" },
          { value: "Physiotherapist" },
          { value: "Dentist" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.sought_professional_help === "Yes",
      },
      yn(
        "received_treatment",
        "Have you previously received any treatment or management for tinnitus?"
      ),
      {
        key: "treatments_received",
        type: "multi",
        prompt: "Which treatments?",
        options: [
          { value: "Hearing aids" },
          { value: "Sound therapy" },
          { value: "Tinnitus counselling" },
          { value: "CBT" },
          { value: "Relaxation/breathing strategies" },
          { value: "Medication" },
          { value: "Tinnitus retraining therapy" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.received_treatment === "Yes",
      },
      {
        key: "treatment_helped",
        type: "single",
        prompt: "Did the treatment help?",
        options: [
          { value: "A lot" },
          { value: "Somewhat" },
          { value: "A little" },
          { value: "Not at all" },
          { value: "It made my tinnitus worse" },
          { value: "I'm not sure" },
        ],
        visibleIf: (a) => a.received_treatment === "Yes",
      },
      {
        key: "previous_care_more",
        type: "textarea",
        prompt: "Would you like to tell us more?",
        optional: true,
      },
    ],
  },

  // ==================================== 20 — noise exposure
  {
    id: "noise_exposure",
    title: "20. Your Exposure to Loud Sounds",
    questions: [
      yn("regular_noise_exposure", "Have you regularly been exposed to loud sounds or noise?"),
      {
        key: "noise_exposure_types",
        type: "multi",
        prompt: "What type of noise exposure have you experienced?",
        options: [
          { value: "Music/concerts" },
          { value: "Headphones/earbuds" },
          { value: "Workplace noise" },
          { value: "Machinery" },
          { value: "Construction" },
          { value: "Traffic/transportation" },
          { value: "Firearms" },
          { value: "Fireworks" },
          { value: "Recreational activities" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.regular_noise_exposure === "Yes",
      },
      {
        key: "noise_exposure_frequency",
        type: "single",
        prompt: "How often are you exposed to loud sounds?",
        options: [
          { value: "Daily" },
          { value: "Several times a week" },
          { value: "Weekly" },
          { value: "Occasionally" },
          { value: "Rarely" },
          { value: "Other", other: true },
        ],
        visibleIf: (a) => a.regular_noise_exposure === "Yes",
      },
      {
        key: "hearing_protection_use",
        type: "single",
        prompt: "Do you usually use hearing protection around loud sounds?",
        options: [
          { value: "Always" },
          { value: "Often" },
          { value: "Sometimes" },
          { value: "Rarely" },
          { value: "Never" },
          { value: "Not applicable" },
        ],
      },
      yn(
        "noise_exposure_worsened_tinnitus",
        "Did your tinnitus begin or become worse after exposure to loud sound?"
      ),
    ],
  },

  // ==================================== 21 — family history
  {
    id: "family_history",
    title: "21. Family History",
    questions: [
      yn(
        "family_tinnitus_hearing_loss",
        "Does anyone in your immediate family have tinnitus or significant hearing loss?"
      ),
      {
        key: "family_relation",
        type: "multi",
        prompt: "Which family member(s)?",
        options: [
          { value: "Parent" },
          { value: "Sibling" },
          { value: "Child" },
          { value: "Other relative", other: true },
          { value: "I'm not sure", exclusive: true },
        ],
        visibleIf: (a) => a.family_tinnitus_hearing_loss === "Yes",
      },
    ],
  },

  // ==================================== 22 — anything else
  {
    id: "anything_else",
    title: "22. Tell Us More",
    questions: [
      {
        key: "anything_else",
        type: "textarea",
        prompt:
          "Is there anything else about your tinnitus, hearing, ears, health, medications, or previous treatment that you would like us to know?",
        optional: true,
      },
    ],
  },
];

/** Shown after Section 22, before the existing Continue button. */
export const SNAPSHOT_SECTION: AboutYouSection = {
  id: "snapshot",
  title: "Your Tinnitus Snapshot",
  intro:
    "Before moving to the next assessment, we would like to understand how your tinnitus feels right now.",
  questions: [
    {
      key: "snapshot_loudness_now",
      type: "scale",
      prompt: "How loud is your tinnitus right now?",
      scaleLabels: { low: "Not audible", high: "Extremely loud" },
    },
    {
      key: "snapshot_noticeability_now",
      type: "scale",
      prompt: "How noticeable is your tinnitus right now?",
      scaleLabels: { low: "Not noticeable", high: "Extremely noticeable" },
    },
    {
      key: "snapshot_bothersome_now",
      type: "scale",
      prompt: "How bothersome is your tinnitus right now?",
      scaleLabels: { low: "Not bothersome", high: "Extremely bothersome" },
    },
  ],
};

/* ------------------------------------------------------------------------- */
/* Mapping onto the four replaced legacy fields                              */
/* ------------------------------------------------------------------------- */

/** Section 3's answer, translated into the existing `Ear` enum where it cleanly maps. */
export function lateralityFromLocation(
  location: AboutYouAnswer
): "left" | "right" | "both" | "central" | "" {
  switch (location) {
    case "Left ear":
      return "left";
    case "Right ear":
      return "right";
    case "Both ears":
      return "both";
    case "In the middle of my head":
      return "central";
    default:
      // "outside my ears" / "I'm not sure" / "Other" have no equivalent in the
      // existing left/right/both/central enum — leaving it unset (rather than
      // guessing) means the field is simply not sent, and the previous stored
      // value on the patient record is left exactly as it was.
      return "";
  }
}

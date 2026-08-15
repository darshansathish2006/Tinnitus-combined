// Evidence-Based Tinnitus Knowledge Base & Clinical Guidance Engine

export interface QuestionAnswer {
  q: string;
  a: string;
}

export interface KnowledgeTopic {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  summary: string;
  questions: QuestionAnswer[];
}

export interface QuickPrompt {
  text: string;
  category?: string;
  action?: "start_assessment" | "open_masker" | "book_consultation" | "view_results";
}

export const DOCTOR_DISCLAIMER = {
  short:
    "Important: This assistant provides supportive guidance and educational information. Please consult an Otolaryngologist (ENT doctor) or qualified Audiologist as soon as possible for a professional diagnosis and evaluation.",
  full:
    "Tinnitus can sometimes be a sign of an underlying medical condition. While sound therapy, habituation, and relaxation techniques can provide significant relief, it is essential to undergo a comprehensive clinical examination by a physician (ENT) and an audiogram by an Audiologist.",
  redFlags: [
    "Sudden onset of tinnitus in one ear (unilateral tinnitus)",
    "Pulsatile tinnitus (ringing or beating that pulses in sync with your heartbeat)",
    "Tinnitus accompanied by sudden hearing loss, dizziness, or vertigo",
    "Tinnitus following head trauma or ear injury",
    "Tinnitus accompanied by facial numbness, weak facial muscles, or balance issues",
  ],
};

export const QUICK_PROMPTS: QuickPrompt[] = [
  { text: "🩺 Take AI Tinnitus Assessment", action: "start_assessment" },
  { text: "👂 How is tinnitus identified & diagnosed?", category: "identification" },
  { text: "💊 How can tinnitus be treated?", category: "treatment" },
  { text: "🚨 What are red-flag symptoms to tell a doctor?", category: "redflags" },
  { text: "🔊 How does sound therapy / masking work?", action: "open_masker" },
  { text: "😴 Help! Tinnitus is keeping me awake at night", category: "sleep" },
  { text: "🧘 How do I reduce tinnitus distress right now?", category: "relief" },
  { text: "👨‍⚕️ Book clinician consultation", action: "book_consultation" },
];

export const KNOWLEDGE_TOPICS: KnowledgeTopic[] = [
  {
    id: "identification",
    title: "Identifying Tinnitus & Sound Types",
    subtitle: "Understanding what your ringing, buzzing, or clicking noises mean",
    icon: "Ear",
    summary:
      "Tinnitus is the perception of noise or ringing in the ears when no external sound is present. Over 15% of people experience it.",
    questions: [
      {
        q: "How do I know if I have tinnitus?",
        a: `Tinnitus is identified when you hear sound in one ear, both ears, or inside your head without any external acoustic source. Common sound profiles include:
• High-pitched ringing or whistling (most common)
• Ocean roaring, humming, or static electricity sound
• Rhythmic clicking or ticking (often muscle spasms or Eustachian tube movement)
• Pulsatile beating (syncs with heart rate - requires prompt doctor review)

**Next Steps**: Take our AI Symptom Assessment or schedule an audiogram with an Audiologist to pinpoint your exact hearing profile.`,
      },
      {
        q: "What is the difference between Subjective and Objective Tinnitus?",
        a: `• **Subjective Tinnitus (99% of cases)**: Sound that only you can hear. It is usually caused by auditory nerve changes, noise damage, earwax, or inner ear hair cell sensitivity.
• **Objective Tinnitus (Rare)**: Sound that a doctor can actually hear using a stethoscope placed near your head or neck. It is usually linked to blood vessel abnormalities, muscle contractions, or Eustachian tube movement.

*Note*: If your tinnitus feels rhythmic like your pulse, please see an ENT doctor as soon as possible for a vascular check.`,
      },
      {
        q: "Is tinnitus a disease?",
        a: `No, tinnitus itself is not a disease. It is a **symptom** of changes within your auditory system (the ear, auditory nerve, and brain circuits processing sound). It is often your brain's natural response to reduced input from sensory hair cells in the inner ear.

While it can feel alarming initially, the brain has an incredible ability to learn to ignore it over time—a process called **habituation**.`,
      },
    ],
  },
  {
    id: "treatment",
    title: "Treatments & Management Options",
    subtitle: "Evidence-based therapies to lessen tinnitus awareness and distress",
    icon: "HeartPulse",
    summary:
      "While there is no single 'magic pill' cure for all forms of tinnitus, highly effective treatments exist to reduce its volume and neurological impact.",
    questions: [
      {
        q: "How is tinnitus treated?",
        a: `Modern tinnitus management focuses on lowering perception and neural distress through evidence-based treatments:

1. **Sound Therapy & Masking**: Uses customized white/pink/brown noise or ocean sounds to make tinnitus less noticeable and train the brain to ignore it.
2. **Tinnitus Retraining Therapy (TRT)**: Combines directive counseling with wearable sound generators to rewire the brain's emotional reaction (limbic system).
3. **Cognitive Behavioral Therapy (CBT)**: Proven to significantly reduce tinnitus distress by changing thought patterns, stress responses, and sleep anxiety.
4. **Hearing Aids with Maskers**: If subtle hearing loss is present, amplifying ambient sound often causes tinnitus to fade naturally into the background.
5. **Bimodal Neuromodulation (e.g. Lenire)**: FDA-cleared therapy combining sound stimulation with gentle tongue stimulation to promote neural plasticity.
6. **Medical & Physical Interventions**: Treating underlying earwax impaction, TMJ jaw tension, sinus pressure, or ototoxic medication adjustments under physician supervision.

**Always Consult**: An ENT doctor will examine your ear structure, while an Audiologist can match you with personalized sound therapy.`,
      },
      {
        q: "Can tinnitus be cured completely?",
        a: `If your tinnitus stems from a temporary treatable cause—such as earwax buildup, middle ear infection, high blood pressure, or jaw misalignment (TMJ)—treating the underlying condition can completely eliminate or drastically quiet the sound.

For sensory tinnitus related to hearing hair cell changes, treatment focuses on **habituation**. Through habituation, your brain's auditory cortex filters out the noise automatically (similar to how you don't feel clothes on your skin all day), allowing you to live comfortably without tinnitus causing distress.`,
      },
      {
        q: "Are there medications or supplements for tinnitus?",
        a: `Currently, there are no FDA-approved pharmaceuticals specifically for curing tinnitus. However:
• **Nutritional & Lifestyle**: Maintaining healthy blood flow (Magnesium, Zinc, B12 under medical advice) supports inner ear metabolic health.
• **Managing Anxiety/Sleep**: Doctors may occasionally prescribe short-term sleep aids or anti-anxiety medications during acute spikes.
• **Avoiding Ototoxic Substances**: Certain high-dose NSAIDs, antibiotics, or aspirin can exacerbate tinnitus. Always ask your pharmacist or doctor to review your medications.`,
      },
    ],
  },
  {
    id: "symptoms",
    title: "Symptoms, Causes & Triggers",
    subtitle: "What causes tinnitus and what worsens it?",
    icon: "Stethoscope",
    summary:
      "Identifying your personal tinnitus triggers is key to preventing spikes and accelerating habituation.",
    questions: [
      {
        q: "What causes tinnitus to suddenly start?",
        a: `Common triggers for tinnitus onset include:
• **Exposure to Loud Noise**: Concerts, power tools, earphones at high volume, or sudden loud blasts.
• **Ear Canal Blockage**: Impacted earwax or fluid buildup in the middle ear.
• **Age-Related Hearing Changes**: Natural gradual reduction in high-frequency sound sensory cells.
• **Stress & Anxiety**: High cortisol levels increase nervous system sensitivity, making brain auditory filters hyper-aware of internal noise.
• **Jaw (TMJ) or Neck Muscle Tension**: Somatosensory nerves from the jaw and neck connect directly to the brainstem auditory nuclei.
• **Cardiovascular Factors**: Changes in blood pressure, caffeine overload, or circulation changes.`,
      },
      {
        q: "Why does my tinnitus sound louder on some days (Spikes)?",
        a: `Tinnitus fluctuations ("spikes") are completely normal and temporary. Spikes are frequently triggered by:
• High stress or emotional fatigue
• Poor sleep or insomnia
• Dehydration or excess sodium intake
• Recent noise exposure
• Sinus congestion or weather pressure changes

**Tip during a spike**: Remind yourself that a spike is temporary and NOT permanent damage. Turn on soothing background ocean waves or brown noise, practice 4-7-8 breathing, and avoid silence.`,
      },
    ],
  },
  {
    id: "redflags",
    title: "Red-Flag Symptoms & Seeing a Doctor",
    subtitle: "Critical signs that require immediate medical evaluation",
    icon: "AlertTriangle",
    summary:
      "Certain tinnitus presentation patterns indicate conditions that need prompt medical diagnostic testing.",
    questions: [
      {
        q: "When should I see an ENT doctor or Audiologist immediately?",
        a: `You should seek urgent medical evaluation (within 24-48 hours) if you experience any of the following:

🚨 **1. Sudden Unilateral Tinnitus**: Ringing or buzzing that suddenly starts in **only one ear**.
🚨 **2. Pulsatile Tinnitus**: Hearing a rhythmic swooshing, thumping, or beating sound that pulses at the same rate as your heartbeat.
🚨 **3. Accompanied by Sudden Hearing Loss**: Noticeable drop in hearing clarity in one or both ears.
🚨 **4. Dizziness, Vertigo, or Loss of Balance**: Feeling like the room is spinning or unsteadiness.
🚨 **5. Ear Pain, Drainage, or Facial Numbness**: Signs of physical ear infection or acoustic nerve pressure.

**Why this matters**: Early medical intervention for conditions like Sudden Sensorineural Hearing Loss (SSHL) or middle ear fluid yields the highest recovery rates!`,
      },
      {
        q: "What happens during a doctor's tinnitus evaluation?",
        a: `A thorough clinical evaluation typically includes:
1. **Otoscopy**: Looking inside your ear canal for earwax, infection, or eardrum perforation.
2. **Comprehensive Audiogram**: Testing your hearing thresholds across frequencies (125 Hz to 8000 Hz+) to check for subtle high-frequency loss.
3. **Tinnitus Pitch & Loudness Matching**: Finding your exact frequency and minimum masking level.
4. **Tympanometry**: Assessing middle ear pressure and eardrum mobility.
5. **Imaging (if indicated)**: An MRI or CT scan may be ordered for unilateral or pulsatile cases to rule out vascular anomalies or acoustic neuromas.`,
      },
    ],
  },
  {
    id: "sleep",
    title: "Sleep & Nighttime Relief",
    subtitle: "Strategies to quiet your mind and fall asleep with tinnitus",
    icon: "Moon",
    summary:
      "Nighttime silence often makes tinnitus seem louder because there are no ambient background sounds to compete with it.",
    questions: [
      {
        q: "How can I sleep when my tinnitus is ringing loudly?",
        a: `Here is a proven nighttime routine to calm tinnitus distress before bed:

1. **Use Low Ambient Sound**: Play soothing Brown Noise, Rain, or Ocean Waves at a volume slightly below your tinnitus level (partial masking helps brain habituation).
2. **Avoid Total Silence**: A quiet bedroom acts like a dark room highlighting a single flashlight. Ambient sound dilutes the contrast.
3. **Pillow Speakers or Sleep Headbands**: Comfortable audio wearables that won't disturb a partner.
4. **Set a Sleep Timer**: Use our built-in 30-minute or 60-minute sound timer.
5. **Guided Somatic Breathing**: Breathe in for 4 seconds, hold for 4 seconds, exhale slowly for 6 seconds to quiet your autonomic nervous system.
6. **Limit Screens 1 hour before bed**: Blue light increases cognitive hyperarousal.`,
      },
    ],
  },
];

export const EMPATHETIC_RESPONSES = {
  greeting:
    "Hello there! I'm **Aura**, your supportive EchoSense tinnitus guidance companion. I'm here to listen, provide comforting evidence-based advice, help identify your symptoms, and guide you on therapies. Remember, you are not alone, and tinnitus CAN become manageable.\n\n*Please note: While I offer guidance, I always encourage consulting an ENT doctor or Audiologist for professional clinical evaluation.*",
  fallback:
    "I hear you, and I completely understand how overwhelming tinnitus can feel. While I can answer questions about tinnitus causes, therapies, sound masking, and symptom checks, I strongly advise having an ENT physician or Audiologist examine your ears for a tailored treatment plan. Would you like to take our quick **AI Symptom Assessment** or explore **Sound Masking Relief**?",
  doctorReminder:
    "\n\n💡 **Medical Recommendation**: For your safety and peace of mind, please schedule a consultation with an ENT doctor (Otolaryngologist) or Audiologist. They can run a comprehensive audiogram and rule out treatable ear conditions.",
};

export interface QueryMatchResult {
  type: "TRIGGER_ASSESSMENT" | "TRIGGER_MASKER" | "RED_FLAG_WARNING" | "KNOWLEDGE_ANSWER" | "GENERAL_GUIDANCE";
  title?: string;
  text: string;
}

export function matchLocalQuery(userText: string): QueryMatchResult {
  const clean = userText.toLowerCase().trim();

  // Check for assessment trigger
  if (
    clean.includes("assess") ||
    clean.includes("quiz") ||
    clean.includes("screen") ||
    clean.includes("test me") ||
    clean.includes("identify my") ||
    clean.includes("take assessment")
  ) {
    return {
      type: "TRIGGER_ASSESSMENT",
      text: "I would be happy to guide you through our **AI Tinnitus Assessment**! It will analyze your pitch match, loudness threshold, minimum masking level, and symptom severity to generate a personalized clinical report.",
    };
  }

  // Check for sound therapy / masker trigger
  if (
    clean.includes("masker") ||
    clean.includes("sound therapy") ||
    clean.includes("brown noise") ||
    clean.includes("pink noise") ||
    clean.includes("white noise") ||
    clean.includes("play sound")
  ) {
    return {
      type: "TRIGGER_MASKER",
      text: "Our **Sound Therapy & Ambient Masker** offers calibrated acoustic stimuli (notch therapy, pink noise, brown noise, and filtered ocean waves) tailored to your matched frequency.",
    };
  }

  // Check for red flags
  if (
    clean.includes("pulse") ||
    clean.includes("heartbeat") ||
    clean.includes("pulsatile") ||
    clean.includes("one ear") ||
    clean.includes("unilateral") ||
    clean.includes("dizzy") ||
    clean.includes("vertigo") ||
    clean.includes("sudden hearing")
  ) {
    return {
      type: "RED_FLAG_WARNING",
      text: `🚨 **Important Medical Notice Regarding Your Symptoms**:
You mentioned symptoms (such as single-ear ringing, pulsatile heartbeat rhythm, vertigo, or sudden hearing drop) that require **prompt medical evaluation by an ENT specialist**.

**Why you should see a doctor soon**:
• Pulsatile tinnitus can indicate vascular or blood flow changes.
• Sudden unilateral tinnitus or hearing drop responds best when evaluated medically within 24-48 hours.

Please contact an Otolaryngologist (ENT doctor) or book an appointment with our clinical team.`,
    };
  }

  // Search Knowledge Base
  let bestMatch: QuestionAnswer | null = null;
  let highestScore = 0;

  KNOWLEDGE_TOPICS.forEach((topic) => {
    topic.questions.forEach((item) => {
      const qText = item.q.toLowerCase();
      const aText = item.a.toLowerCase();

      let score = 0;
      const words = clean.split(/\s+/);
      words.forEach((w) => {
        if (w.length > 3) {
          if (qText.includes(w)) score += 3;
          if (aText.includes(w)) score += 1;
        }
      });

      if (score > highestScore) {
        highestScore = score;
        bestMatch = item;
      }
    });
  });

  if (bestMatch && highestScore >= 3) {
    return {
      type: "KNOWLEDGE_ANSWER",
      title: (bestMatch as QuestionAnswer).q,
      text: (bestMatch as QuestionAnswer).a + EMPATHETIC_RESPONSES.doctorReminder,
    };
  }

  return {
    type: "GENERAL_GUIDANCE",
    text: `Thank you for reaching out. Tinnitus affects everyone differently, but with the right guidance, habits, and sound therapy, the brain learns to habituate and lower its perception of tinnitus.

Here are helpful options you can try right now:
• **Take our AI Symptom Assessment** to build a personalized hearing & tinnitus profile.
• **Use our Ambient Sound Masker** (Brown Noise or Ocean Waves) to soothe your nervous system.
• **Consult an ENT Doctor or Audiologist** to inspect your ear canal and test your hearing thresholds.

Feel free to ask me specifically about treatments, causes, sleep advice, or red flags!`,
  };
}

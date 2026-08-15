"""Content for the Everyday Assistant Companion.

The assistant's name is a product name, so it stays in English in every locale
rather than being translated. The Tamil, Hindi and Telugu greetings still carry
the older *descriptive* phrasing ("EchoSense counselling assistant") because
substituting a proper noun into those sentences changes the case marking, and
guessing at that in a clinical product is worse than leaving an accurate
description in place. Flagged for a native-speaker pass.

Separated from the routing logic so a clinician can review and edit what the
assistant *says* without touching how it decides what to say - which is the only
arrangement a clinical service will accept.

Languages: English, Tamil, Hindi, Telugu, Spanish, French. Safety-critical
content (crisis response) is translated in full; where a long-tail intent has no
translation the router falls back to English and marks the reply so the gap is
visible rather than silent.
"""

from __future__ import annotations

from typing import Any

LANGUAGES: dict[str, dict[str, str]] = {
    "en": {"name": "English", "native": "English"},
    "ta": {"name": "Tamil", "native": "தமிழ்"},
    "hi": {"name": "Hindi", "native": "हिन्दी"},
    "te": {"name": "Telugu", "native": "తెలుగు"},
    "es": {"name": "Spanish", "native": "Espanol"},
    "fr": {"name": "French", "native": "Francais"},
}

# --------------------------------------------------------------------------- #
# Crisis resources. Region-specific where known, with an unambiguous
# emergency-services fallback everywhere else.
# --------------------------------------------------------------------------- #
CRISIS_RESOURCES: list[dict[str, str]] = [
    {"region": "India", "name": "Tele-MANAS (Government of India, 24x7)", "contact": "14416 or 1-800-891-4416"},
    {"region": "India", "name": "KIRAN Mental Health Helpline", "contact": "1800-599-0019"},
    {"region": "India", "name": "AASRA", "contact": "+91-9820466726"},
    {"region": "United Kingdom", "name": "Samaritans", "contact": "116 123"},
    {"region": "United States", "name": "988 Suicide & Crisis Lifeline", "contact": "988"},
    {"region": "Worldwide", "name": "Local emergency services", "contact": "Your national emergency number"},
    {"region": "Worldwide", "name": "Befrienders Worldwide directory", "contact": "befrienders.org"},
]

CRISIS_MESSAGE: dict[str, str] = {
    "en": (
        "I want to stop and take what you just said seriously.\n\n"
        "What you are describing sounds like you may be thinking about harming yourself. "
        "I am an automated assistant and I am not able to give you the help you need right now — "
        "but a person can, and it is worth reaching for them.\n\n"
        "**Please contact one of these now:**\n{resources}\n\n"
        "If you are in immediate danger, call your local emergency number or go to the nearest "
        "emergency department.\n\n"
        "Tinnitus-related despair is more common than most people realise, and it does respond to "
        "treatment — the distress is treatable even when the sound itself persists. "
        "I have alerted your audiology team so a clinician can contact you. Please stay safe."
    ),
    "ta": (
        "நீங்கள் இப்போது சொன்னதை நான் தீவிரமாக எடுத்துக்கொள்கிறேன்.\n\n"
        "நீங்கள் உங்களைத் தானே காயப்படுத்திக் கொள்ள நினைக்கிறீர்கள் என்று தோன்றுகிறது. "
        "நான் ஒரு தானியங்கி உதவியாளர் மட்டுமே — உங்களுக்குத் தேவையான உதவியை என்னால் தர முடியாது. "
        "ஆனால் ஒரு மனிதரால் முடியும்.\n\n"
        "**தயவுசெய்து இப்போதே தொடர்பு கொள்ளுங்கள்:**\n{resources}\n\n"
        "உடனடி ஆபத்தில் இருந்தால், அருகிலுள்ள அவசர சிகிச்சைப் பிரிவுக்குச் செல்லுங்கள்.\n\n"
        "காதுஒலி (tinnitus) காரணமாக ஏற்படும் மனச்சோர்வு பலருக்கும் வருகிறது, அதற்குச் சிகிச்சை உண்டு. "
        "ஒலி தொடர்ந்தாலும் துன்பத்தைக் குறைக்க முடியும். உங்கள் மருத்துவக் குழுவுக்கு நான் தெரிவித்துவிட்டேன். "
        "பாதுகாப்பாக இருங்கள்."
    ),
    "hi": (
        "आपने जो कहा, मैं उसे गंभीरता से ले रहा हूँ।\n\n"
        "ऐसा लगता है कि आप स्वयं को नुकसान पहुँचाने के बारे में सोच रहे हैं। "
        "मैं एक स्वचालित सहायक हूँ और अभी आपको जो सहायता चाहिए वह मैं नहीं दे सकता — "
        "लेकिन एक व्यक्ति दे सकता है।\n\n"
        "**कृपया अभी इनमें से किसी से संपर्क करें:**\n{resources}\n\n"
        "यदि आप तत्काल खतरे में हैं, तो आपातकालीन नंबर पर कॉल करें या नज़दीकी अस्पताल जाएँ।\n\n"
        "टिनिटस के कारण होने वाली निराशा आम है और इसका इलाज संभव है — आवाज़ बनी रहने पर भी "
        "तकलीफ़ कम की जा सकती है। मैंने आपकी ऑडियोलॉजी टीम को सूचित कर दिया है। कृपया सुरक्षित रहें।"
    ),
    "te": (
        "మీరు ఇప్పుడు చెప్పినది నేను తీవ్రంగా పరిగణిస్తున్నాను.\n\n"
        "మీరు మీకు హాని చేసుకోవాలని ఆలోచిస్తున్నట్టు అనిపిస్తోంది. నేను ఒక ఆటోమేటెడ్ సహాయకుడిని మాత్రమే — "
        "మీకు ఇప్పుడు అవసరమైన సహాయం నేను ఇవ్వలేను, కానీ ఒక వ్యక్తి ఇవ్వగలరు.\n\n"
        "**దయచేసి ఇప్పుడే సంప్రదించండి:**\n{resources}\n\n"
        "తక్షణ ప్రమాదంలో ఉంటే, అత్యవసర నంబర్‌కు కాల్ చేయండి లేదా దగ్గరి ఆసుపత్రికి వెళ్లండి.\n\n"
        "టిన్నిటస్ వల్ల కలిగే నిరాశ సాధారణం, దానికి చికిత్స ఉంది. మీ ఆడియాలజీ బృందానికి నేను తెలియజేశాను. "
        "సురక్షితంగా ఉండండి."
    ),
    "es": (
        "Quiero detenerme y tomar en serio lo que acabas de decir.\n\n"
        "Lo que describes suena como si estuvieras pensando en hacerte dano. Soy un asistente "
        "automatizado y no puedo darte la ayuda que necesitas ahora, pero una persona si puede.\n\n"
        "**Por favor contacta ahora con:**\n{resources}\n\n"
        "Si estas en peligro inmediato, llama a tu numero de emergencias o acude a urgencias.\n\n"
        "La desesperacion por el tinnitus es mas comun de lo que se cree y responde al tratamiento. "
        "He avisado a tu equipo de audiologia. Por favor, cuidate."
    ),
    "fr": (
        "Je veux m'arreter et prendre au serieux ce que vous venez de dire.\n\n"
        "Ce que vous decrivez donne l'impression que vous pensez a vous faire du mal. Je suis un "
        "assistant automatise et je ne peux pas vous apporter l'aide dont vous avez besoin maintenant, "
        "mais une personne peut le faire.\n\n"
        "**Veuillez contacter des maintenant :**\n{resources}\n\n"
        "Si vous etes en danger immediat, appelez les secours ou rendez-vous aux urgences.\n\n"
        "Le desespoir lie a l'acouphene est plus courant qu'on ne le croit et il repond au traitement. "
        "J'ai alerte votre equipe d'audiologie. Prenez soin de vous."
    ),
}

# --------------------------------------------------------------------------- #
# Intent definitions: trigger patterns per language.
# --------------------------------------------------------------------------- #
INTENTS: dict[str, dict[str, Any]] = {
    "crisis": {
        "priority": 100,
        "patterns": {
            "en": ["kill myself", "end my life", "suicide", "suicidal", "want to die", "better off dead",
                   "end it all", "no reason to live", "cant go on", "can't go on", "harm myself",
                   "hurt myself", "take my own life", "not worth living", "kill me"],
            "ta": ["தற்கொலை", "சாக வேண்டும்", "இறந்து", "உயிரை முடி", "வாழ விரும்பவில்லை"],
            "hi": ["आत्महत्या", "मरना चाहता", "मरना चाहती", "जान देना", "जीना नहीं चाहता"],
            "te": ["ఆత్మహత్య", "చనిపోవాలని", "బతకాలని లేదు"],
            "es": ["suicidio", "quitarme la vida", "quiero morir", "matarme"],
            "fr": ["suicide", "me tuer", "envie de mourir", "en finir"],
        },
    },
    "medical_emergency": {
        "priority": 95,
        "patterns": {
            "en": ["sudden hearing loss", "cant hear anything", "can't hear anything", "blood from ear",
                   "severe dizziness", "face is numb", "facial weakness", "worst headache",
                   "vision going", "ear discharge", "pulsatile", "heartbeat", "pulse in ear",
                   "unilateral", "one ear", "vertigo", "spinning room"],
            "hi": ["अचानक सुनाई", "कान से खून", "धड़कन", "चक्कर"],
            "ta": ["திடீர் காது", "காதில் இரத்தம்", "ஒரு காதில்", "சுழல்"],
        },
    },
    "greeting": {
        "priority": 5,
        "patterns": {
            "en": ["hello", "hi", "hey", "good morning", "good evening", "namaste", "who are you", "what can you do"],
            "ta": ["வணக்கம்", "ஹலோ"],
            "hi": ["नमस्ते", "हैलो", "हाय"],
            "te": ["నమస్కారం", "హలో"],
            "es": ["hola", "buenos dias", "buenas tardes"],
            "fr": ["bonjour", "salut", "bonsoir"],
        },
    },
    "education_what_is": {
        "priority": 30,
        "patterns": {
            "en": ["what is tinnitus", "why do i hear", "where does the sound come from",
                   "is it in my ear or my brain", "explain tinnitus", "what's happening to me",
                   "is my ear damaged", "phantom sound"],
            "ta": ["டின்னிடஸ் என்ன", "காதில் சத்தம் ஏன்", "எதனால் வருகிறது"],
            "hi": ["टिनिटस क्या है", "कान में आवाज़ क्यों", "क्यों सुनाई देती"],
            "te": ["టిన్నిటస్ అంటే", "చెవిలో శబ్దం ఎందుకు"],
            "es": ["que es el tinnitus", "por que escucho", "que causa el tinnitus"],
            "fr": ["qu'est-ce que l'acouphene", "pourquoi j'entends", "cause de l'acouphene"],
        },
    },
    "education_cure": {
        "priority": 35,
        "patterns": {
            "en": ["is there a cure", "can it be cured", "will it go away", "permanent", "forever",
                   "will i have this for life", "any medicine for tinnitus", "tablet for tinnitus",
                   "surgery for tinnitus"],
            "ta": ["குணமாகுமா", "நிரந்தரமா", "மாத்திரை"],
            "hi": ["ठीक हो जाएगा", "इलाज है", "हमेशा रहेगा", "दवा है"],
            "te": ["నయం అవుతుందా", "మందు ఉందా"],
            "es": ["hay cura", "se puede curar", "desaparecera"],
            "fr": ["y a-t-il un remede", "va-t-il disparaitre", "guerison"],
        },
    },
    "sleep": {
        "priority": 40,
        "patterns": {
            "en": ["cant sleep", "can't sleep", "trouble sleeping", "insomnia", "keeps me awake",
                   "worse at night", "wake up at night", "louder at night", "sleep problem", "lying in bed", "sleep"],
            "ta": ["தூக்கம் வரவில்லை", "இரவில் அதிகம்", "தூங்க முடியவில்லை", "தூக்கம்"],
            "hi": ["नींद नहीं आती", "रात में ज्यादा", "सो नहीं पाता", "नींद"],
            "te": ["నిద్ర రావడం లేదు", "రాత్రి ఎక్కువ", "నిద్ర"],
            "es": ["no puedo dormir", "insomnio", "peor de noche", "dormir"],
            "fr": ["je ne peux pas dormir", "insomnie", "pire la nuit", "sommeil"],
        },
    },
    "relaxation": {
        "priority": 38,
        "patterns": {
            "en": ["relax", "relaxation", "breathing exercise", "calm down", "panic", "anxious right now",
                   "cant calm", "meditation", "grounding", "4-7-8"],
            "ta": ["அமைதி", "மூச்சு பயிற்சி", "பயம்"],
            "hi": ["शांत", "सांस का अभ्यास", "घबराहट"],
            "te": ["ప్రశాంతంగా", "శ్వాస వ్యాయామం"],
            "es": ["relajarme", "respiracion", "calmarme", "ansiedad"],
            "fr": ["me detendre", "respiration", "me calmer", "anxiete"],
        },
    },
    "coping_distress": {
        "priority": 45,
        "patterns": {
            "en": ["i cant take it", "i can't take it", "driving me crazy", "driving me mad", "unbearable",
                   "hate this", "so frustrated", "hopeless", "depressed", "give up", "exhausted",
                   "no one understands", "ruining my life", "cant cope", "can't cope", "at my limit"],
            "ta": ["தாங்க முடியவில்லை", "பொறுமை இல்லை", "நம்பிக்கை இல்லை", "சோர்வாக"],
            "hi": ["सहन नहीं", "पागल कर रहा", "निराश", "हिम्मत नहीं", "थक गया"],
            "te": ["భరించలేను", "నిరాశ", "అలసిపోయాను"],
            "es": ["no puedo mas", "me esta volviendo loco", "insoportable", "desesperado"],
            "fr": ["je n'en peux plus", "insupportable", "desespere"],
        },
    },
    "cbt_catastrophising": {
        "priority": 50,
        "patterns": {
            "en": ["always be", "never get better", "getting worse and worse", "going deaf", "brain tumour",
                   "brain tumor", "something serious", "losing my mind", "never stop", "ruined forever"],
            "hi": ["कभी ठीक नहीं", "बहरा हो जाऊंगा"],
            "ta": ["ஒருபோதும் சரியாகாது", "காது கேளாமல்"],
            "es": ["nunca mejorara", "me quedare sordo"],
            "fr": ["ne guerira jamais", "devenir sourd"],
        },
    },
    "identification_types": {
        "priority": 36,
        "patterns": {
            "en": ["identif", "diagnos", "sound type", "types of tinnitus", "subjective objective", "high pitched",
                   "hissing", "clicking sound", "buzzing", "whistling", "what type", "subjective"],
            "ta": ["டின்னிடஸ் வகைகள்", "சத்த வகைகள்", "சுயநிலை டின்னிடஸ்"],
            "hi": ["टिनिटस पहचान", "ध्वनि के प्रकार", "रिंगिंग आवाज़"],
            "es": ["identificar tinnitus", "tipos de zumbido", "subjetivo u objetivo"],
            "fr": ["identifier acouphene", "types de sons", "subjectif ou objectif"],
        },
    },
    "treatment_options": {
        "priority": 37,
        "patterns": {
            "en": ["treatment", "treated", "treat tinnitus", "trt", "tinnitus retraining", "lenire", "bimodal",
                   "neuromodulation", "sound therapy", "masking", "masker", "cbt for tinnitus", "hearing aid masker", "therapies"],
            "ta": ["சிகிச்சை", "சிகிச்சை முறைகள்", "சிகிச்சை விருப்பங்கள்", "ஒலி சிகிச்சை"],
            "hi": ["उपचार", "इलाज", "साउंड थेरेपी"],
            "es": ["tratamiento", "como tratar", "terapia de sonido"],
            "fr": ["traitement", "comment traiter", "therapie sonore"],
        },
    },
    "causes_triggers": {
        "priority": 33,
        "patterns": {
            "en": ["cause", "causes", "trigger", "triggers", "why did my tinnitus start", "spikes", "spike",
                   "louder today", "acoustic trauma", "loud blast", "earwax", "ear wax", "cortisol", "started"],
            "ta": ["காரணங்கள்", "அதிகரிப்பு", "தூண்டுதல்கள்"],
            "hi": ["कारण", "स्पाइक", "तेज़ आवाज़ से"],
            "es": ["causas", "desencadenantes", "pico de tinnitus"],
            "fr": ["causes", "declencheurs", "pic d'acouphene"],
        },
    },
    "hearing_protection": {
        "priority": 32,
        "patterns": {
            "en": ["earplugs", "ear plugs", "loud music", "concert", "protect my hearing", "headphones safe",
                   "noise at work", "firecracker", "how loud is safe", "volume level"],
            "ta": ["காது பாதுகாப்பு", "சத்தமான இசை", "ஈயர்ப்ளக்"],
            "hi": ["कान की सुरक्षा", "तेज़ आवाज़", "ईयरप्लग"],
            "te": ["చెవి రక్షణ", "పెద్ద శబ్దం"],
            "es": ["tapones para los oidos", "musica alta", "proteger mi audicion"],
            "fr": ["bouchons d'oreille", "musique forte", "proteger mon audition"],
        },
    },
    "medication": {
        "priority": 34,
        "patterns": {
            "en": ["my medicine", "my medication", "did i take", "remind me", "reminder", "tablet time",
                   "forgot my", "dose", "ototoxic", "medicine causing"],
            "ta": ["மாத்திரை", "மருந்து", "நினைவூட்டு"],
            "hi": ["दवा", "गोली", "याद दिला"],
            "te": ["మందు", "గుర్తు చేయు"],
            "es": ["mi medicamento", "recordatorio", "pastilla"],
            "fr": ["mon medicament", "rappel", "comprime"],
        },
    },
    "lifestyle": {
        "priority": 28,
        "patterns": {
            "en": ["coffee", "caffeine", "alcohol", "smoking", "diet", "exercise", "salt", "should i avoid",
                   "food", "drink", "lifestyle"],
            "ta": ["காபி", "மது", "உணவு", "உடற்பயிற்சி"],
            "hi": ["कॉफ़ी", "शराब", "खाना", "व्यायाम"],
            "te": ["కాఫీ", "మద్యం", "ఆహారం"],
            "es": ["cafe", "cafeina", "alcohol", "dieta", "ejercicio"],
            "fr": ["cafe", "cafeine", "alcool", "regime", "exercice"],
        },
    },
    "therapy_help": {
        "priority": 42,
        "patterns": {
            "en": ["how do i use", "how long should i listen", "therapy not working", "which sound",
                   "volume too loud", "my program", "my plan", "how many minutes", "not helping",
                   "should i keep going", "notched"],
            "ta": ["எப்படி பயன்படுத்த", "சிகிச்சை வேலை செய்யவில்லை", "எத்தனை நிமிடம்"],
            "hi": ["कैसे उपयोग", "थेरेपी काम नहीं", "कितने मिनट"],
            "te": ["ఎలా ఉపయోగించాలి", "థెరపీ పని చేయడం లేదు"],
            "es": ["como uso", "la terapia no funciona", "cuantos minutos"],
            "fr": ["comment utiliser", "la therapie ne marche pas", "combien de minutes"],
        },
    },
    "results_meaning": {
        "priority": 44,
        "patterns": {
            "en": ["my score", "my thi", "what does my", "my results", "my frequency", "my pitch",
                   "my hearing test", "my audiogram", "my risk", "explain my"],
            "ta": ["என் மதிப்பெண்", "என் முடிவு", "என் அதிர்வெண்"],
            "hi": ["मेरा स्कोर", "मेरा परिणाम", "मेरी फ्रीक्वेंसी"],
            "te": ["నా స్కోరు", "నా ఫలితం"],
            "es": ["mi puntuacion", "mis resultados", "mi frecuencia"],
            "fr": ["mon score", "mes resultats", "ma frequence"],
        },
    },
    "somatic": {
        "priority": 33,
        "patterns": {
            "en": ["jaw", "tmj", "neck", "clenching", "grinding teeth", "changes when i move",
                   "posture", "dental"],
            "ta": ["தாடை", "கழுத்து", "பல் கடித்தல்"],
            "hi": ["जबड़ा", "गर्दन", "दांत पीसना"],
            "es": ["mandibula", "cuello", "apretar los dientes"],
            "fr": ["machoire", "cou", "serrer les dents"],
        },
    },
    "appointment": {
        "priority": 26,
        "patterns": {
            "en": ["appointment", "see my doctor", "book", "follow up", "when is my next", "audiologist"],
            "ta": ["சந்திப்பு", "மருத்துவரை"],
            "hi": ["अपॉइंटमेंट", "डॉक्टर से"],
            "te": ["అపాయింట్‌మెంట్"],
            "es": ["cita", "ver a mi medico"],
            "fr": ["rendez-vous", "voir mon medecin"],
        },
    },
    "thanks": {
        "priority": 6,
        "patterns": {
            "en": ["thank you", "thanks", "helpful", "appreciate"],
            "ta": ["நன்றி"],
            "hi": ["धन्यवाद", "शुक्रिया"],
            "te": ["ధన్యవాదాలు"],
            "es": ["gracias"],
            "fr": ["merci"],
        },
    },
}

# --------------------------------------------------------------------------- #
# Responses. `{placeholder}` fields are filled from the patient record so the
# answer references this patient's actual numbers, not generic advice.
# --------------------------------------------------------------------------- #
RESPONSES: dict[str, dict[str, str]] = {
    "greeting": {
        "en": "Hello{name_suffix}. I am the EchoSense Everyday Assistant Companion — available any time, "
              "including the hours when tinnitus is usually worst.\n\n"
              "I can help you with:\n"
              "- Understanding what your test results mean\n"
              "- Getting to sleep when the ringing is loud\n"
              "- A breathing exercise when you feel your chest tighten\n"
              "- Working through the thoughts that make it feel worse\n"
              "- Using your sound therapy properly\n"
              "- Protecting your hearing so it does not get worse\n\n"
              "What is on your mind right now?",
        "ta": "வணக்கம்{name_suffix}. நான் EchoSense ஆலோசனை உதவியாளர் — எப்போது வேண்டுமானாலும் கிடைப்பேன்.\n\n"
              "நான் உதவ முடியும்:\n- உங்கள் பரிசோதனை முடிவுகளைப் புரிந்துகொள்ள\n- இரவில் தூங்க\n"
              "- மூச்சுப் பயிற்சி மூலம் அமைதியாக\n- சிகிச்சையை சரியாகப் பயன்படுத்த\n- காதுகளைப் பாதுகாக்க\n\n"
              "இப்போது உங்கள் மனதில் என்ன இருக்கிறது?",
        "hi": "नमस्ते{name_suffix}। मैं EchoSense परामर्श सहायक हूँ — किसी भी समय उपलब्ध।\n\n"
              "मैं इनमें मदद कर सकता हूँ:\n- आपके परीक्षण परिणाम समझने में\n- रात में नींद आने में\n"
              "- सांस के अभ्यास से शांत होने में\n- ध्वनि चिकित्सा के सही उपयोग में\n- सुनने की सुरक्षा में\n\n"
              "अभी आपके मन में क्या है?",
        "te": "నమస్కారం{name_suffix}. నేను EchoSense సలహా సహాయకుడిని — ఎప్పుడైనా అందుబాటులో ఉంటాను.\n\n"
              "నేను సహాయం చేయగలను:\n- మీ పరీక్ష ఫలితాలను అర్థం చేసుకోవడంలో\n- రాత్రి నిద్రపోవడంలో\n"
              "- శ్వాస వ్యాయామంతో ప్రశాంతత పొందడంలో\n- సౌండ్ థెరపీ ఉపయోగించడంలో\n\nఇప్పుడు మీ మనసులో ఏమి ఉంది?",
        "es": "Hola{name_suffix}. Soy el Everyday Assistant Companion de EchoSense, disponible a cualquier hora.\n\n"
              "Puedo ayudarte con: entender tus resultados, dormir cuando el zumbido es fuerte, un ejercicio "
              "de respiracion, usar bien tu terapia de sonido y proteger tu audicion.\n\nQue te preocupa ahora?",
        "fr": "Bonjour{name_suffix}. Je suis l'Everyday Assistant Companion d'EchoSense, disponible a toute heure.\n\n"
              "Je peux vous aider a comprendre vos resultats, a dormir, avec un exercice de respiration, "
              "a bien utiliser votre therapie sonore et a proteger votre audition.\n\nQu'est-ce qui vous preoccupe ?",
    },
    "education_what_is": {
        "en": "Tinnitus is a sound you hear that has no source outside your head. That does not make it "
              "imaginary — the neural activity producing it is real and measurable.\n\n"
              "The current explanation is **central gain**. When hair cells in the cochlea are damaged, "
              "the nerve fibres they fed go quiet. Your brain's auditory centres respond the way any "
              "amplifier does when the input drops: they turn the gain up. The amplified background "
              "neural noise is what you hear. It is generated centrally, which is why it does not stop "
              "when you plug your ears.\n\n"
              "{personal_note}\n\n"
              "Two consequences matter for treatment:\n"
              "1. **The volume knob is partly attentional.** Stress and fear raise the gain; that is why it "
              "sounds louder on a bad day even though nothing in your ear changed.\n"
              "2. **Sound therapy works by reducing the contrast**, not by covering the sound. Feeding "
              "your auditory system real input lets the gain come back down.\n\n"
              "Would you like me to explain your own test results, or talk about what helps?",
        "ta": "டின்னிடஸ் என்பது வெளியில் ஆதாரம் இல்லாமல் நீங்கள் கேட்கும் ஒலி. அது கற்பனை அல்ல — "
              "அதை உருவாக்கும் நரம்பு செயல்பாடு உண்மையானது.\n\n"
              "தற்போதைய விளக்கம் **மைய ஆதாயம் (central gain)**. காதின் உள்ளே உள்ள முடி செல்கள் "
              "சேதமடையும்போது, அந்த நரம்புகள் அமைதியாகின்றன. மூளை ஒலியை அதிகரிக்கிறது — "
              "அந்த அதிகரித்த நரம்பு ஒலியே நீங்கள் கேட்பது.\n\n{personal_note}\n\n"
              "இதனால் இரண்டு விஷயங்கள்:\n1. மன அழுத்தம் ஒலியை அதிகமாகக் காட்டும்.\n"
              "2. ஒலி சிகிச்சை ஒலியை மறைப்பதற்காக அல்ல — வேறுபாட்டைக் குறைப்பதற்காக.\n\n"
              "உங்கள் முடிவுகளை விளக்கவா?",
        "hi": "टिनिटस वह ध्वनि है जो आप सुनते हैं लेकिन जिसका बाहर कोई स्रोत नहीं होता। यह कल्पना नहीं है — "
              "इसे पैदा करने वाली तंत्रिका गतिविधि वास्तविक है।\n\n"
              "वर्तमान व्याख्या **सेंट्रल गेन** है। जब कान की हेयर सेल्स क्षतिग्रस्त होती हैं, तो उनसे जुड़ी "
              "तंत्रिकाएँ शांत हो जाती हैं। मस्तिष्क आवाज़ बढ़ा देता है — वही बढ़ी हुई तंत्रिका ध्वनि आप सुनते हैं।\n\n"
              "{personal_note}\n\nदो बातें महत्वपूर्ण हैं:\n1. तनाव और डर आवाज़ को तेज़ कर देते हैं।\n"
              "2. ध्वनि चिकित्सा आवाज़ ढकने के लिए नहीं, अंतर कम करने के लिए है।\n\n"
              "क्या मैं आपके परिणाम समझाऊँ?",
    },
    "education_cure": {
        "en": "I will be straight with you, because false hope is its own kind of harm.\n\n"
              "**There is no treatment that reliably removes the sound.** Anyone selling you a cure is "
              "selling you something. No drug, supplement or surgery has been shown to abolish chronic "
              "subjective tinnitus.\n\n"
              "**But that is not the same as untreatable.** The thing that damages people's lives is not the "
              "sound's loudness — it is the distress attached to it. Those two come apart. Structured sound "
              "therapy plus CBT-based work reliably reduces handicap scores, and a substantial proportion of "
              "patients reach a point where the sound is still measurable but no longer matters to them. "
              "That is habituation, and it is a real clinical outcome, not a consolation prize.\n\n"
              "{personal_note}\n\n"
              "There is also a genuine chance of natural improvement, which is highest in the first year "
              "after onset. Your percept can also become less noticeable without becoming quieter.\n\n"
              "What I would not do is wait passively to see whether it fades. The distress responds to "
              "treatment much faster than the sound does.",
        "hi": "मैं आपसे सीधी बात करूँगा, क्योंकि झूठी आशा भी नुकसान पहुँचाती है।\n\n"
              "**कोई इलाज नहीं है जो आवाज़ को निश्चित रूप से हटा दे।** कोई भी दवा या सर्जरी क्रोनिक टिनिटस "
              "को समाप्त करने में सिद्ध नहीं हुई है।\n\n"
              "**लेकिन इसका मतलब यह नहीं कि यह अनुपचारित है।** जीवन को नुकसान आवाज़ की तेज़ी से नहीं, "
              "उससे जुड़ी तकलीफ़ से होता है — और ये दोनों अलग हैं। ध्वनि चिकित्सा और CBT मिलकर तकलीफ़ को "
              "विश्वसनीय रूप से कम करते हैं।\n\n{personal_note}",
        "ta": "நான் நேரடியாகச் சொல்கிறேன், ஏனெனில் பொய்யான நம்பிக்கையும் தீங்கே.\n\n"
              "**ஒலியை முழுமையாக நீக்கும் சிகிச்சை எதுவும் இல்லை.** எந்த மருந்தும் அறுவை சிகிச்சையும் "
              "நாள்பட்ட டின்னிடஸை நீக்குவதாக நிரூபிக்கப்படவில்லை.\n\n"
              "**ஆனால் இது சிகிச்சையளிக்க முடியாதது என்று அர்த்தமல்ல.** வாழ்க்கையைப் பாதிப்பது ஒலியின் "
              "சத்தம் அல்ல — அதனுடன் இணைந்த துன்பம். இவை இரண்டும் வேறு. ஒலி சிகிச்சையும் CBTயும் "
              "துன்பத்தை நிச்சயமாகக் குறைக்கின்றன.\n\n{personal_note}",
    },
    "sleep": {
        "en": "Night is when tinnitus is worst for almost everyone, and the reason is simple: a quiet "
              "bedroom removes every competing sound, so the percept is the loudest thing in the room. "
              "Then you start listening for it, and listening makes it louder.\n\n"
              "**Tonight, in order:**\n"
              "1. **Do not sleep in silence.** Your plan includes an overnight fade{sleep_block_note} — "
              "start it as you get into bed. It should sit *just underneath* the ringing, not cover it. "
              "If you cannot hear your tinnitus at all, it is too loud.\n"
              "2. **Get out of bed if you are awake past about 20 minutes.** Sit somewhere dim until you "
              "feel sleepy, then return. This stops your brain learning that bed is where you lie "
              "awake listening.\n"
              "3. **Run the 4-7-8 breathing** while you lie there — in for 4, hold 7, out for 8. It shifts "
              "you out of the arousal state that keeps the gain up.\n"
              "4. **Same wake time every day**, including weekends. Wake time anchors sleep far more than "
              "bedtime does.\n\n"
              "{sleep_score_note}\n\n"
              "The thing to expect: this improves over weeks, not in one night. Most people notice the "
              "difference in sleep onset before they notice any change in the tinnitus.\n\n"
              "Shall I start a breathing exercise with you now?",
        "ta": "இரவில் டின்னிடஸ் அதிகமாகத் தோன்றுவது இயல்பு — அமைதியான அறையில் அதுவே பெரிய ஒலி.\n\n"
              "**இன்று இரவு:**\n1. **அமைதியில் தூங்க வேண்டாம்.** உங்கள் திட்டத்தில் உள்ள இரவு ஒலியைத் "
              "தொடங்குங்கள். அது ஒலியை மறைக்கக் கூடாது — அதற்குக் கீழே இருக்க வேண்டும்.\n"
              "2. **20 நிமிடம் கழித்தும் தூக்கம் வராவிட்டால் படுக்கையை விட்டு எழுங்கள்.**\n"
              "3. **4-7-8 மூச்சுப் பயிற்சி** செய்யுங்கள்.\n4. **தினமும் ஒரே நேரத்தில் எழுங்கள்.**\n\n"
              "{sleep_score_note}\n\nஇது வாரங்களில் மேம்படும், ஒரே இரவில் அல்ல.",
        "hi": "रात में टिनिटस सबसे तेज़ लगता है — शांत कमरे में वही सबसे तेज़ आवाज़ होती है।\n\n"
              "**आज रात:**\n1. **सन्नाटे में न सोएँ।** अपनी योजना की रात की ध्वनि शुरू करें। यह ringing को "
              "ढके नहीं, उसके *नीचे* रहे।\n2. **20 मिनट बाद भी नींद न आए तो बिस्तर से उठ जाएँ।**\n"
              "3. **4-7-8 सांस** लें — 4 अंदर, 7 रोकें, 8 बाहर।\n4. **हर दिन एक ही समय पर उठें।**\n\n"
              "{sleep_score_note}\n\nयह हफ़्तों में सुधरता है, एक रात में नहीं।",
    },
    "relaxation": {
        "en": "Let us do this together now. It takes about two minutes and it works on the arousal that is "
              "amplifying the sound.\n\n"
              "**4-7-8 breathing.** Sit back, let your shoulders drop.\n\n"
              "- Breathe in through your nose for **4** counts\n"
              "- Hold for **7**\n"
              "- Breathe out slowly through your mouth for **8**\n\n"
              "The long exhale is the active part — it engages the parasympathetic system and slows your "
              "heart rate. Repeat four cycles, then read on.\n\n"
              "**Then a grounding step**, because relaxation alone leaves your attention on the ringing. "
              "Name, to yourself: five things you can see, four you can feel, three you can hear *besides* "
              "the tinnitus, two you can smell, one you can taste.\n\n"
              "That last part matters. You are not trying to *not hear* the tinnitus — that never works. "
              "You are giving your attention somewhere else to be. Attention is the one part of this you "
              "have direct control over.\n\n"
              "Your plan has a paced-breathing block with an audible guide — open the therapy player and "
              "it will pace you.",
        "hi": "चलिए अभी साथ करें। दो मिनट लगेंगे।\n\n**4-7-8 सांस।** कंधे ढीले छोड़ें।\n\n"
              "- नाक से **4** गिनती तक सांस लें\n- **7** तक रोकें\n- मुँह से **8** तक धीरे छोड़ें\n\n"
              "लंबी सांस छोड़ना ही असली हिस्सा है। चार बार दोहराएँ।\n\n"
              "**फिर ग्राउंडिंग:** पाँच चीज़ें जो दिख रही हैं, चार जो महसूस हो रही हैं, तीन जो टिनिटस के "
              "*अलावा* सुनाई दे रही हैं, दो गंध, एक स्वाद।\n\n"
              "आप टिनिटस को *न सुनने* की कोशिश नहीं कर रहे — वह कभी काम नहीं करता। आप ध्यान को कहीं "
              "और जगह दे रहे हैं।",
        "ta": "இப்போது ஒன்றாகச் செய்வோம். இரண்டு நிமிடம் ஆகும்.\n\n**4-7-8 மூச்சு.** தோள்களைத் தளர்த்துங்கள்.\n\n"
              "- மூக்கால் **4** எண்ணும் வரை உள்ளே\n- **7** வரை நிறுத்துங்கள்\n- வாயால் **8** வரை மெதுவாக வெளியே\n\n"
              "நீண்ட மூச்சுவிடுதலே முக்கியம். நான்கு முறை செய்யுங்கள்.\n\n"
              "**பிறகு:** தெரியும் ஐந்து பொருள், உணரும் நான்கு, டின்னிடஸ் *தவிர* கேட்கும் மூன்று ஒலி, "
              "இரண்டு வாசனை, ஒரு சுவை — மனதில் சொல்லுங்கள்.\n\n"
              "டின்னிடஸை *கேட்காமல் இருக்க* முயற்சிக்க வேண்டாம் — அது வேலை செய்யாது. "
              "கவனத்திற்கு வேறு இடம் கொடுங்கள்.",
    },
    "coping_distress": {
        "en": "That sounds genuinely hard, and I am not going to tell you it is not.\n\n"
              "What you are describing — the exhaustion, the sense that it is taking over — is the most "
              "common reason people come to a tinnitus clinic, and it is the part that treatment is "
              "actually good at. {distress_note}\n\n"
              "One thing worth knowing: the loudness of tinnitus and the suffering it causes are only "
              "weakly related. Patients with quiet tinnitus can be severely disabled by it, and patients "
              "with loud tinnitus can be barely troubled. What separates them is not the sound. It is the "
              "amount of threat the brain attaches to it, how much attention it captures, and how much "
              "sleep is being lost. **All three of those are treatable, and none of them require the sound "
              "to change.**\n\n"
              "Right now, pick one:\n"
              "- I can take you through a two-minute breathing exercise\n"
              "- I can help with tonight's sleep specifically\n"
              "- I can look at a thought that is making this heavier and help you test it\n\n"
              "And if it reaches the point where you are thinking about harming yourself, tell me or tell "
              "your clinician immediately. That is not a burden and it is not an overreaction.",
        "hi": "यह वाकई कठिन है, और मैं यह नहीं कहूँगा कि नहीं है।\n\n"
              "आप जो बता रहे हैं — थकान, यह भावना कि यह सब कुछ अपने कब्ज़े में ले रहा है — यही सबसे आम "
              "कारण है जिससे लोग टिनिटस क्लिनिक आते हैं, और उपचार इसी में सबसे अच्छा काम करता है। "
              "{distress_note}\n\n"
              "एक बात जानने योग्य है: टिनिटस की तेज़ी और उससे होने वाली तकलीफ़ में कमज़ोर संबंध है। "
              "जो चीज़ फ़र्क़ करती है वह आवाज़ नहीं है — वह है मस्तिष्क द्वारा जुड़ा खतरा, ध्यान, और नींद की कमी। "
              "**ये तीनों उपचार योग्य हैं।**\n\n"
              "अभी एक चुनें: सांस का अभ्यास, आज रात की नींद, या एक विचार की जाँच।",
        "ta": "இது உண்மையிலேயே கடினம், நான் அதை மறுக்கவில்லை.\n\n"
              "நீங்கள் சொல்வது — சோர்வு, இது எல்லாவற்றையும் ஆட்கொள்வது போன்ற உணர்வு — "
              "இதுவே மக்கள் டின்னிடஸ் மருத்துவமனைக்கு வரும் முக்கிய காரணம், "
              "மேலும் சிகிச்சை இதிலேயே சிறப்பாக வேலை செய்கிறது. {distress_note}\n\n"
              "ஒன்று தெரிந்துகொள்ளுங்கள்: ஒலியின் சத்தத்திற்கும் அது தரும் துன்பத்திற்கும் "
              "பெரிய தொடர்பு இல்லை. வேறுபாட்டை உண்டாக்குவது ஒலி அல்ல — மூளை இணைக்கும் அச்சம், "
              "கவனம், தூக்கமிழப்பு. **இந்த மூன்றுக்கும் சிகிச்சை உண்டு.**\n\n"
              "இப்போது ஒன்றைத் தேர்வு செய்யுங்கள்: மூச்சுப் பயிற்சி, இன்றைய தூக்கம், அல்லது ஒரு எண்ணத்தை ஆராய்வது.",
    },
    "cbt_catastrophising": {
        "en": "I want to slow down on the specific thought in what you just said, because it is doing a lot "
              "of work.\n\n"
              "The thought is roughly: *\"{detected_thought}\"*\n\n"
              "That is a prediction about the future stated as a fact. Your brain is presenting it as "
              "information, but it is a forecast — and forecasts can be examined:\n\n"
              "- **What is the actual evidence for it?** Not the feeling of certainty, the evidence.\n"
              "- **What is the evidence against it?** Has there been any hour, any day, when it mattered less?\n"
              "- **If a friend said this to you, what would you say back?**\n\n"
              "{catastrophe_correction}\n\n"
              "Here is why this matters mechanically, not just emotionally. A thought like that triggers a "
              "threat response. The threat response raises auditory gain and locks your attention onto the "
              "sound. So the belief *\"this will never get better\"* measurably makes the present moment "
              "worse. Testing the thought is not positive thinking — it is removing an amplifier.\n\n"
              "Would you like to write down the thought and work through the evidence properly? That is the "
              "core CBT exercise for tinnitus and it is more effective on paper than in your head.",
    },
    "hearing_protection": {
        "en": "This is the one area where you have real, direct control over whether things get worse — so "
              "it is worth getting right.\n\n"
              "**The rule of thumb:** if you have to raise your voice to be heard by someone at arm's "
              "length, the level is around 85 dB and you need protection. Risk depends on level *and* "
              "duration together: 85 dB is safe for about 8 hours, and every 3 dB louder halves the safe "
              "time. A nightclub at 100 dB gives you about 15 minutes.\n\n"
              "**What to use:**\n"
              "- **Musicians' earplugs with a flat attenuation filter** (ER-15/ER-25 style) for concerts and "
              "gigs. They reduce level without muffling — foam plugs cut the highs much more than the lows, "
              "which is why music sounds dead through them and people take them out.\n"
              "- **Foam plugs** (~30 dB) for power tools, firecrackers, machinery. Rolled thin, inserted deep.\n"
              "- **Earmuffs over plugs** for anything above 105 dB.\n\n"
              "**But do not over-protect.** This is the mistake I see most. Wearing plugs in ordinary quiet "
              "environments causes auditory deprivation, which raises central gain — the exact mechanism "
              "driving your tinnitus. It also worsens sound tolerance over time. Protect against genuinely "
              "loud sound; let normal sound in.{hyperacusis_note}\n\n"
              "**Headphones:** the 60/60 guide is reasonable — 60% volume, 60 minutes, then a break. "
              "Noise-cancelling headphones help a lot here, because the reason people turn music up is "
              "usually background noise, not preference.",
        "hi": "यही एक क्षेत्र है जहाँ आपका सीधा नियंत्रण है कि स्थिति बिगड़े या न बिगड़े।\n\n"
              "**नियम:** यदि आपको एक हाथ की दूरी पर खड़े व्यक्ति से बात करने के लिए आवाज़ ऊँची करनी पड़े, "
              "तो स्तर लगभग 85 dB है और सुरक्षा चाहिए। 85 dB लगभग 8 घंटे सुरक्षित है; हर 3 dB बढ़ने पर "
              "सुरक्षित समय आधा हो जाता है।\n\n"
              "**क्या उपयोग करें:** संगीत के लिए फ़्लैट फ़िल्टर वाले म्यूज़िशियन इयरप्लग; मशीनों और पटाखों के "
              "लिए फोम प्लग; 105 dB से ऊपर प्लग के ऊपर इयरमफ़।\n\n"
              "**लेकिन अति-सुरक्षा न करें।** सामान्य शांत जगहों पर प्लग पहनना central gain बढ़ाता है — "
              "वही तंत्र जो आपके टिनिटस को चला रहा है।{hyperacusis_note}\n\n"
              "**हेडफ़ोन:** 60% वॉल्यूम, 60 मिनट, फिर विराम।",
        "ta": "இதுவே நிலைமை மோசமாகாமல் தடுக்க உங்கள் நேரடிக் கட்டுப்பாட்டில் உள்ள ஒரே பகுதி.\n\n"
              "**விதி:** ஒரு கை தூரத்தில் இருப்பவரிடம் பேச குரலை உயர்த்த வேண்டியிருந்தால், "
              "ஒலி அளவு ~85 dB — பாதுகாப்பு தேவை. 85 dB சுமார் 8 மணி நேரம் பாதுகாப்பானது; "
              "3 dB கூடும்போது பாதுகாப்பான நேரம் பாதியாகும்.\n\n"
              "**எதைப் பயன்படுத்த:** இசைக்கு flat filter ஈயர்ப்ளக்; இயந்திரம்/பட்டாசுக்கு foam plug; "
              "105 dBக்கு மேல் earmuff + plug.\n\n"
              "**ஆனால் அதிகமாகப் பாதுகாக்க வேண்டாம்.** சாதாரண அமைதியான இடங்களில் ப்ளக் அணிவது "
              "central gain-ஐ அதிகரிக்கும் — அதுவே உங்கள் டின்னிடஸை இயக்கும் வழிமுறை.{hyperacusis_note}",
    },
    "medication": {
        "en": "{medication_status}\n\n"
              "A few things worth knowing about medication and tinnitus:\n\n"
              "**No drug is licensed to treat tinnitus itself.** Where medication helps, it is treating "
              "something attached to it — sleep, anxiety, depression — and that indirect route is often "
              "genuinely worthwhile.\n\n"
              "**Some drugs can make tinnitus worse.** High-dose aspirin and other NSAIDs, loop diuretics, "
              "aminoglycoside antibiotics, quinine, and some chemotherapy agents are the main ones. If your "
              "tinnitus changed noticeably within days of starting something new, tell your prescriber — "
              "but **do not stop a prescribed medicine on your own**, especially not anything for blood "
              "pressure, epilepsy or mental health.\n\n"
              "**Be sceptical of supplements.** Ginkgo biloba, zinc and melatonin are the most marketed. "
              "Trials of ginkgo for tinnitus have been broadly negative. Melatonin has some support for "
              "*sleep* in tinnitus patients, which is a reasonable thing to discuss with your clinician.\n\n"
              "Would you like me to set up a reminder schedule?",
        "hi": "{medication_status}\n\nदवा और टिनिटस के बारे में कुछ बातें:\n\n"
              "**कोई भी दवा टिनिटस के इलाज के लिए स्वीकृत नहीं है।** जहाँ दवा मदद करती है, वह नींद, "
              "चिंता या अवसाद का इलाज कर रही होती है।\n\n"
              "**कुछ दवाएँ टिनिटस बढ़ा सकती हैं** — अधिक मात्रा में एस्पिरिन, NSAIDs, कुछ एंटीबायोटिक्स, "
              "क्विनीन। यदि नई दवा शुरू करने के कुछ दिनों में बदलाव आया हो तो डॉक्टर को बताएँ, "
              "लेकिन **अपने आप दवा बंद न करें**।\n\n"
              "**सप्लीमेंट्स पर संदेह करें।** जिन्कगो के परीक्षण नकारात्मक रहे हैं।",
    },
    "lifestyle": {
        "en": "Honest answer: the lifestyle advice around tinnitus is much weaker than the internet "
              "suggests, and blanket restriction usually costs more than it gains.\n\n"
              "**Caffeine:** the evidence does *not* support cutting it out. A randomised withdrawal trial "
              "found caffeine reduction did not improve tinnitus — and withdrawal made things temporarily "
              "worse. If you have noticed a reliable personal link, act on that; otherwise keep your coffee.\n\n"
              "**Alcohol:** variable between people. Worth noting that it fragments sleep even when it helps "
              "you fall asleep, and poor sleep reliably worsens tinnitus. That indirect route is the real "
              "problem more often than any direct effect.\n\n"
              "**Salt:** only clearly relevant if you have Meniere's disease or significant aural fullness.\n\n"
              "**Smoking:** worth stopping. Nicotine is a vasoconstrictor and smoking is independently "
              "associated with hearing loss, which drives the tinnitus.\n\n"
              "**Exercise:** the one with the best support, and it is not close. Aerobic exercise improves "
              "sleep quality, lowers anxiety and reduces tinnitus distress scores. Three sessions a week is "
              "a reasonable target.\n\n"
              "**The useful move** is not a general diet — it is your diary. You are already logging "
              "triggers, and after a few weeks the correlation analysis will tell you what actually affects "
              "*you*. That beats any general rule.{trigger_note}",
    },
    "therapy_help": {
        "en": "{therapy_status}\n\n"
              "**The single most common mistake is setting the level too high.** The target is the *mixing "
              "point*: turn it up until your tinnitus and the therapy sound just begin to blend, and stop "
              "there. You should still be able to hear your tinnitus. If it disappears completely, the level "
              "is too loud — and complete masking actively works against habituation, because your brain "
              "never gets the chance to reclassify the sound as unimportant.\n\n"
              "**On the notch:** the silent band in your therapy sound is deliberate. Removing energy at "
              "your tinnitus frequency is the mechanism — it reduces the reorganised cortical activity in "
              "that region. It is not a fault in the audio.\n\n"
              "**On duration:** consistency beats intensity. Two 30-minute sessions you actually complete "
              "every day beat a 3-hour session once a week. Passive listening counts — you do not have to "
              "concentrate on it.\n\n"
              "**On the timescale:** this is the part people are not told clearly enough. Sound therapy "
              "works over **8 to 12 weeks**, not days. Early sessions often produce no noticeable change, "
              "and some people find the first week slightly worse as they start paying more attention to "
              "the sound. That is expected and it is not a sign it is failing.\n\n"
              "**Stop and tell your clinician** if the tinnitus is consistently louder *after* sessions. "
              "That pattern means the level or the modality is wrong for you and the plan needs revising.",
        "hi": "{therapy_status}\n\n**सबसे आम गलती है स्तर बहुत ऊँचा रखना।** लक्ष्य *mixing point* है — "
              "इतना बढ़ाएँ कि टिनिटस और थेरेपी की आवाज़ मिलने लगें, बस। टिनिटस सुनाई देता रहना चाहिए। "
              "पूरी तरह ढक जाना habituation के विरुद्ध काम करता है।\n\n"
              "**नॉच के बारे में:** आपकी थेरेपी में खाली बैंड जानबूझकर है — यही उपचार का तंत्र है।\n\n"
              "**अवधि:** नियमितता तीव्रता से बेहतर है। रोज़ पूरे किए गए दो 30-मिनट सत्र, "
              "हफ़्ते में एक 3-घंटे के सत्र से बेहतर हैं।\n\n"
              "**समय-सीमा:** यह **8 से 12 हफ़्तों** में काम करता है, दिनों में नहीं।\n\n"
              "यदि सत्रों के *बाद* टिनिटस लगातार तेज़ हो, तो रोकें और डॉक्टर को बताएँ।",
    },
    "somatic": {
        "en": "This is worth pursuing — if your tinnitus changes when you move your jaw, clench your teeth "
              "or turn your neck, you have **somatic tinnitus**, and it has a different treatment route "
              "from the usual one.\n\n"
              "The mechanism is real: the trigeminal and dorsal root inputs from your jaw and upper neck "
              "converge with auditory pathways in the brainstem (the dorsal cochlear nucleus). Tension "
              "there can modulate the percept. Roughly two thirds of tinnitus patients can change their "
              "tinnitus with a head or neck manoeuvre.\n\n"
              "**What actually helps:**\n"
              "- **A dental assessment for bruxism.** Night-time clenching is very common and very "
              "treatable — a splint can make a real difference.\n"
              "- **Physiotherapy for the cervical spine and jaw**, targeting the upper cervical segments "
              "and masticatory muscles. This has the best evidence of anything in this category.\n"
              "- **Posture work**, particularly if you spend hours at a screen with your head forward.\n"
              "- **Heat and self-massage** to the masseter and suboccipital muscles for immediate relief.\n\n"
              "I have noted this for your audiologist. Ask specifically about a TMJ and cervical spine "
              "assessment at your next appointment — it is easy to miss if nobody raises it.",
    },
    "results_meaning": {
        "en": "Here is what your assessment actually found.\n\n{results_summary}\n\n"
              "Two things to hold onto when reading those numbers:\n\n"
              "**Your matched frequency is not a verdict.** It tells us where to put the therapy notch. It "
              "does not predict how bad your outcome will be.\n\n"
              "**Your THI score is the one that matters clinically, and it is the one that moves.** It "
              "measures handicap — how much tinnitus is interfering with your life — not loudness. It "
              "responds to treatment. A drop of 7 points or more is a real, clinically meaningful "
              "improvement, and that is the target we are working toward.\n\n"
              "Which of these would you like me to go into properly?",
    },
    "appointment": {
        "en": "{appointment_status}\n\n"
              "**Worth bringing to the appointment:** your diary (the trend line is more useful to your "
              "clinician than any single day), which therapy blocks you have actually been completing and "
              "which you have not, and anything that has changed — new medication, a noise exposure, a "
              "change in the sound itself.\n\n"
              "**Contact the clinic before your scheduled appointment if:** the tinnitus becomes pulsatile "
              "(in time with your heartbeat), you notice sudden hearing loss, you develop dizziness or "
              "vertigo, or the distress reaches a point where you are struggling to cope. None of those "
              "should wait.",
    },
    "medical_emergency": {
        "en": "**Stop and seek medical care now — do not wait for your next appointment.**\n\n"
              "What you have described can indicate a condition where treatment is time-critical. Sudden "
              "sensorineural hearing loss in particular is treated with corticosteroids, and the benefit "
              "falls sharply after about two weeks from onset — so days matter.\n\n"
              "**Go to an emergency department or contact ENT today** if you have:\n"
              "- Sudden hearing loss in one or both ears\n"
              "- Tinnitus in time with your heartbeat\n"
              "- Facial weakness or numbness\n"
              "- Severe dizziness or vertigo with vomiting\n"
              "- Bleeding or discharge from the ear\n"
              "- The worst headache of your life, or new visual disturbance\n\n"
              "I have flagged this to your audiology team. Please do not use this app as a substitute for "
              "being seen today.",
        "hi": "**अभी चिकित्सा सहायता लें — अगली अपॉइंटमेंट का इंतज़ार न करें।**\n\n"
              "आपने जो बताया वह ऐसी स्थिति का संकेत हो सकता है जिसमें उपचार समय-संवेदनशील है। "
              "अचानक सुनने की हानि का इलाज स्टेरॉयड से होता है और दो हफ़्ते बाद लाभ बहुत घट जाता है।\n\n"
              "**आज ही आपातकालीन विभाग या ENT से संपर्क करें।** मैंने आपकी टीम को सूचित कर दिया है।",
        "ta": "**இப்போதே மருத்துவ உதவி பெறுங்கள் — அடுத்த சந்திப்புக்குக் காத்திருக்க வேண்டாம்.**\n\n"
              "நீங்கள் சொன்னது சிகிச்சை உடனடியாகத் தேவைப்படும் நிலையைக் குறிக்கலாம். "
              "திடீர் காது கேளாமைக்கு ஸ்டீராய்டு சிகிச்சை உண்டு, இரண்டு வாரங்களுக்குப் பிறகு பயன் மிகக் குறையும்.\n\n"
              "**இன்றே அவசர பிரிவு அல்லது ENT மருத்துவரைத் தொடர்பு கொள்ளுங்கள்.** உங்கள் குழுவுக்கு நான் தெரிவித்துவிட்டேன்.",
    },
    "identification_types": {
        "en": "Tinnitus is identified when you perceive sound without an external acoustic source.\n\n"
              "**Common sound profiles:**\n"
              "- **High-pitched tone / whistling:** most common, associated with sensorineural frequency loss.\n"
              "- **Ocean roaring or static hiss:** broad-band percept often responsive to pink/brown noise masking.\n"
              "- **Rhythmic clicking:** often Eustachian tube movement or middle ear muscle contractions.\n\n"
              "**Subjective vs Objective:**\n"
              "- **Subjective (99% of cases):** Heard only by you; generated by altered central auditory gain.\n"
              "- **Objective (rare):** An actual acoustic sound from blood flow or muscles that a doctor can hear with a stethoscope.\n\n"
              "Would you like to complete our AI assessment to match your exact pitch and loudness?",
        "hi": "टिनिटस तब पहचाना जाता है जब आप बिना किसी बाहरी स्रोत के ध्वनि सुनते हैं। 99% मामलों में यह सब्जेक्टिव होता है। क्या आप अपनी सटीक पिच जांचना चाहते हैं?",
        "ta": "டின்னிடஸ் என்பது வெளிப்புற ஒலி இல்லாமல் காதில் கேட்கும் சத்தம். 99% இது சுயநிலை (subjective) டின்னிடஸ் ஆகும்.",
    },
    "treatment_options": {
        "en": "Modern tinnitus management focuses on lowering perception and neural distress through evidence-based treatments:\n\n"
              "1. **Sound Therapy & Masking:** Uses calibrated broadband (pink/brown noise) or customized notched sound to decrease contrast and lower central gain.\n"
              "2. **Tinnitus Retraining Therapy (TRT):** Combines directive counseling with wearable acoustic generators to promote limbic habituation.\n"
              "3. **Cognitive Behavioural Therapy (CBT):** Clinically proven to reduce handicap and sleep disruption by breaking catastrophic fear cycles.\n"
              "4. **Bimodal Neuromodulation (e.g. Lenire):** Combines auditory stimuli with trigeminal/lingual stimulation for neural plasticity.\n"
              "5. **Hearing Aids with Maskers:** Amplifying ambient environmental sound naturally reduces tinnitus awareness if high-frequency loss is present.\n\n"
              "Which of these therapies would you like to explore?",
        "hi": "टिनिटस प्रबंधन के लिए आधुनिक साक्ष्य-आधारित उपचार: साउंड थेरेपी, TRT, CBT, और हियरिंग एड्स।",
        "ta": "டின்னிடஸ் மேலாண்மை முறைகள்: ஒலி சிகிச்சை, TRT, CBT மற்றும் கேட்கும் கருவிகள்.",
    },
    "causes_triggers": {
        "en": "Tinnitus onset and fluctuations (spikes) are tied to identifiable physiological mechanisms:\n\n"
              "**Onset Triggers:**\n"
              "- **Acoustic exposure:** Loud events or extended headphone use damaging high-frequency hair cells.\n"
              "- **Ear canal blockage:** Impacted cerumen (earwax) or Eustachian tube dysfunction.\n"
              "- **Elevated stress & cortisol:** Increases central auditory sensitivity and lowers filtration.\n"
              "- **Cervical/TMJ tension:** Trigeminal somatosensory connections feeding directly into the cochlear nucleus.\n\n"
              "**Managing Spikes:** Remember that spikes are temporary fluctuations in neural gain, not new permanent ear damage. Running low-level ambient masking and practicing 4-7-8 breathing reliably calms autonomic reactivity.",
        "hi": "टिनिटस के कारण: तेज़ आवाज़, कान में मैल, तनाव, और जबड़े का तनाव। स्पाइक्स अस्थायी होते हैं।",
        "ta": "டின்னிடஸ் காரணங்கள்: அதிக சத்தம், மன அழுத்தம், தாடை இறுக்கம். அதிகரிப்பு தற்காலிகமானது.",
    },
    "thanks": {
        "en": "You are welcome. I am here whenever you need — including at 3am, which is usually when this "
              "is hardest.\n\nOne thing that genuinely helps: log today in your diary before you close the "
              "app. The trend it builds is what lets your clinician see whether the plan is working, and "
              "it is far more useful than trying to remember how the last month went.",
        "hi": "आपका स्वागत है। मैं जब भी ज़रूरत हो उपलब्ध हूँ — रात 3 बजे भी, जब यह सबसे कठिन होता है।\n\n"
              "एक चीज़ जो वास्तव में मदद करती है: ऐप बंद करने से पहले आज की डायरी भरें।",
        "ta": "மகிழ்ச்சி. எப்போது வேண்டுமானாலும் நான் இருக்கிறேன் — அதிகாலை 3 மணிக்கும்.\n\n"
              "உண்மையில் உதவும் ஒன்று: செயலியை மூடும் முன் இன்றைய நாட்குறிப்பை நிரப்புங்கள்.",
    },
    "fallback": {
        "en": "I am not certain I understood that, and I would rather say so than guess.\n\n"
              "I can help with:\n"
              "- **What your results mean** — your frequency, THI score, audiogram\n"
              "- **Sleep** — the single most useful thing to fix first\n"
              "- **A breathing or grounding exercise**, right now if you want\n"
              "- **Working through a difficult thought** using the CBT approach\n"
              "- **Your therapy plan** — how to use it, why it is not working, what to change\n"
              "- **Hearing protection** and lifestyle questions\n"
              "- **Medication** reminders and interactions\n\n"
              "Try putting it in your own words and I will do better. If it is a clinical question that "
              "needs a real answer about your specific case, message your audiologist through the app — "
              "I will make sure it reaches them.",
        "hi": "मुझे यकीन नहीं है कि मैं समझ पाया, और अनुमान लगाने से बेहतर है यह कह देना।\n\n"
              "मैं इनमें मदद कर सकता हूँ: आपके परिणाम, नींद, सांस का अभ्यास, कठिन विचारों पर काम, "
              "आपकी थेरेपी योजना, कान की सुरक्षा, दवा।\n\nअपने शब्दों में फिर बताएँ।",
        "ta": "நான் புரிந்துகொண்டேனா என்று உறுதியாகத் தெரியவில்லை — ஊகிப்பதைவிட இதைச் சொல்வது நல்லது.\n\n"
              "நான் உதவ முடியும்: உங்கள் முடிவுகள், தூக்கம், மூச்சுப் பயிற்சி, கடினமான எண்ணங்கள், "
              "உங்கள் சிகிச்சைத் திட்டம், காது பாதுகாப்பு, மருந்து.\n\nஉங்கள் சொற்களில் மீண்டும் சொல்லுங்கள்.",
        "te": "నేను అర్థం చేసుకున్నానో లేదో నాకు నమ్మకం లేదు.\n\nనేను సహాయం చేయగలను: మీ ఫలితాలు, నిద్ర, "
              "శ్వాస వ్యాయామం, కష్టమైన ఆలోచనలు, మీ థెరపీ ప్లాన్, చెవి రక్షణ, మందులు.",
        "es": "No estoy seguro de haber entendido, y prefiero decirlo que adivinar.\n\n"
              "Puedo ayudarte con: tus resultados, el sueno, un ejercicio de respiracion, trabajar un "
              "pensamiento difficil, tu plan de terapia, proteccion auditiva y medicacion.",
        "fr": "Je ne suis pas sur d'avoir compris, et je prefere le dire plutot que de deviner.\n\n"
              "Je peux vous aider avec : vos resultats, le sommeil, un exercice de respiration, un "
              "pensee difficile, votre plan de therapie, la protection auditive et les medicaments.",
    },
}

# Cognitive distortions the CBT module detects, with the reframe it offers.
DISTORTIONS: list[dict[str, Any]] = [
    {
        "key": "permanence",
        "patterns": ["never get better", "never stop", "always be like this", "forever", "rest of my life",
                     "never go away", "permanent"],
        "name": "Predicting a fixed future",
        "correction": "Tinnitus distress is one of the more changeable things in audiology. Handicap scores "
                      "fall with treatment in most patients even when the sound itself is unchanged, and "
                      "the sound is most likely to shift in the first year. A confident prediction about "
                      "the next twenty years is not something you currently have the information to make.",
    },
    {
        "key": "catastrophising",
        "patterns": ["brain tumour", "brain tumor", "going deaf", "something serious", "losing my hearing",
                     "cancer", "dying", "aneurysm"],
        "name": "Jumping to the worst explanation",
        "correction": "Serious pathology behind tinnitus is uncommon, and this platform screens "
                      "specifically for the presentations that warrant imaging — asymmetric hearing loss, "
                      "a strictly one-sided percept, pulsatile character. If those were present in your "
                      "assessment you would already have been flagged for referral. If the fear itself is "
                      "persistent, ask your clinician directly what has been ruled out; a specific answer "
                      "is easier to live with than an open question.",
    },
    {
        "key": "attentional_absolute",
        "patterns": ["all i can hear", "cant think of anything else", "can't think of anything else",
                     "constantly", "every second", "all the time", "never stops for a second"],
        "name": "All-or-nothing attention",
        "correction": "Worth testing rather than accepting. Over the next few days, note the moments you "
                      "*did not* notice it — usually absorbed in something, in conversation, outdoors. "
                      "Most patients find those gaps exist and are more frequent than they believed. That "
                      "matters because it shows attention is a variable here, and variables can be shifted.",
    },
    {
        "key": "coping_denial",
        "patterns": ["cant cope", "can't cope", "cant handle", "can't handle", "too weak", "falling apart",
                     "no strength left"],
        "name": "Underestimating your own coping",
        "correction": "You have been coping with this — that is what the weeks behind you are. It has cost "
                      "you far more than it should, and the goal is to lower that cost. But 'I cannot cope' "
                      "and 'this is costing me too much' are different claims, and only the second one is "
                      "supported by the evidence in front of us.",
    },
    {
        "key": "isolation",
        "patterns": ["no one understands", "nobody understands", "alone in this", "no one else",
                     "nobody cares"],
        "name": "Assuming isolation",
        "correction": "Tinnitus affects 10-15% of adults, and roughly 1-2% are severely affected. In a "
                      "hundred people you pass tomorrow, somewhere between ten and fifteen hear something "
                      "too. That is not a platitude — the isolation is a feature of how invisible the "
                      "condition is, not of how rare it is.",
    },
    {
        "key": "self_blame",
        "patterns": ["my own fault", "i did this to myself", "i deserve", "should have known",
                     "i caused this"],
        "name": "Self-blame",
        "correction": "Even where noise exposure contributed, hindsight is not the same as culpability — "
                      "you did not have this information at the time. And blame has no treatment value: it "
                      "raises the distress that amplifies the percept without changing anything you can act "
                      "on. What you *can* act on is protection from here on, and you are already doing that.",
    },
]

EDUCATION_TOPICS: list[dict[str, str]] = [
    {"key": "mechanism", "title": "Why you hear it", "summary": "Central gain, hair cell loss and why plugging your ears does not help."},
    {"key": "habituation", "title": "What habituation actually is", "summary": "How the sound can stop mattering without getting quieter."},
    {"key": "notched", "title": "Why your therapy has a silent band", "summary": "The mechanism behind notched sound therapy."},
    {"key": "attention", "title": "The attention loop", "summary": "How listening for it makes it louder, and what to do instead."},
    {"key": "sleep", "title": "Night-time and tinnitus", "summary": "Why it is worst in bed and how to break the cycle."},
    {"key": "protection", "title": "Protecting your hearing", "summary": "Safe exposure limits, and why over-protection backfires."},
    {"key": "somatic", "title": "Jaw, neck and tinnitus", "summary": "When your tinnitus is modulated by movement."},
    {"key": "hyperacusis", "title": "When sound hurts", "summary": "Reduced sound tolerance and how it is treated."},
]

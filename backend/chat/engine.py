"""Counselling assistant routing engine.

Runs entirely offline by default: language detection by script and keyword,
weighted intent scoring, CBT distortion detection, and response templates
personalised from the patient's own record. No network, no API key, no cold-start
failure at a demo booth with bad wifi.

If ``ECHOSENSE_ANTHROPIC_API_KEY`` is set, the same routing runs first (so safety
escalation is never delegated to a model), and non-crisis turns are then handed to
Claude with the patient context and a strict clinical system prompt. The offline
reply is used as the fallback if that call fails for any reason.
"""

from __future__ import annotations

import json
import re
import unicodedata
import urllib.error
import urllib.request
from string import Formatter
from typing import Any, Mapping

from echosense.appconfig import settings
from chat.knowledge import (
    CRISIS_MESSAGE,
    CRISIS_RESOURCES,
    DISTORTIONS,
    INTENTS,
    LANGUAGES,
    RESPONSES,
)

# Unicode block ranges used for script-based language detection.
_SCRIPT_RANGES: list[tuple[str, int, int]] = [
    ("hi", 0x0900, 0x097F),  # Devanagari
    ("ta", 0x0B80, 0x0BFF),  # Tamil
    ("te", 0x0C00, 0x0C7F),  # Telugu
]

_LATIN_HINTS: dict[str, list[str]] = {
    "es": ["que", "por", "como", "mi ", "no puedo", "gracias", "oido", "ruido", "sueno", "dormir"],
    "fr": ["que", "pour", "comment", "mon ", "je ne", "merci", "oreille", "bruit", "sommeil", "dormir"],
}


class _Blank(dict):
    """Formatting map that renders unknown placeholders as empty strings."""

    def __missing__(self, key: str) -> str:  # noqa: D105
        return ""


def _safe_format(template: str, context: Mapping[str, Any]) -> str:
    try:
        return Formatter().vformat(template, (), _Blank(context))
    except (IndexError, ValueError):
        return template


def detect_language(text: str, default: str = "en") -> str:
    """Detect language from script first, then Latin-script keyword hints."""
    counts: dict[str, int] = {}
    for ch in text:
        cp = ord(ch)
        for lang, lo, hi in _SCRIPT_RANGES:
            if lo <= cp <= hi:
                counts[lang] = counts.get(lang, 0) + 1
                break
    if counts:
        return max(counts.items(), key=lambda kv: kv[1])[0]

    lowered = _normalise(text)
    scores = {
        lang: sum(1 for hint in hints if hint in lowered)
        for lang, hints in _LATIN_HINTS.items()
    }
    best = max(scores.items(), key=lambda kv: kv[1], default=("en", 0))
    if best[1] >= 2:
        return best[0]
    return default if default in LANGUAGES else "en"


def _normalise(text: str) -> str:
    """Lowercase, strip accents, collapse whitespace - so 'oido'/'oído' match."""
    decomposed = unicodedata.normalize("NFD", text.lower())
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", stripped).strip()


def classify_intent(text: str, lang: str) -> tuple[str, float, list[str]]:
    """Score every intent; return (best_intent, confidence, matched_phrases).

    Patterns from *all* languages are checked, not just the detected one, because
    code-switching is the norm - "sleep problem irukku" needs to route to the
    sleep intent regardless of which language won detection.
    """
    lowered = _normalise(text)
    raw = text.lower()
    best_intent, best_score, best_matches = "fallback", 0.0, []

    for name, spec in INTENTS.items():
        matches: list[str] = []
        score = 0.0
        for pattern_lang, patterns in spec["patterns"].items():
            for pattern in patterns:
                probe = pattern if pattern_lang in {"hi", "ta", "te"} else _normalise(pattern)
                haystack = raw if pattern_lang in {"hi", "ta", "te"} else lowered
                if probe and probe in haystack:
                    matches.append(pattern)
                    # Longer matches are more specific, so weight by token count.
                    weight = 1.0 + 0.35 * (len(pattern.split()) - 1)
                    if pattern_lang == lang:
                        weight *= 1.15
                    score += weight
        if not matches:
            continue
        # Priority separates a crisis phrase from a passing mention of sleep.
        score *= 1.0 + spec["priority"] / 100.0
        if score > best_score:
            best_intent, best_score, best_matches = name, score, matches

    confidence = min(1.0, best_score / 3.2) if best_score else 0.0
    return best_intent, round(confidence, 3), best_matches


def detect_distortions(text: str) -> list[dict[str, Any]]:
    lowered = _normalise(text)
    found: list[dict[str, Any]] = []
    for d in DISTORTIONS:
        hits = [p for p in d["patterns"] if _normalise(p) in lowered]
        if hits:
            found.append(
                {"key": d["key"], "name": d["name"], "correction": d["correction"], "matched": hits}
            )
    return found


# --------------------------------------------------------------------------- #
# Personalisation
# --------------------------------------------------------------------------- #
def build_context(patient_context: Mapping[str, Any] | None) -> dict[str, Any]:
    """Turn the patient record into the placeholder values the templates use."""
    ctx = patient_context or {}
    name = (ctx.get("full_name") or "").split(" ")[0]
    pitch = ctx.get("pitch_match_hz")
    thi = ctx.get("thi_score")
    thi_grade = ctx.get("thi_grade")
    psqi = ctx.get("psqi_score")
    who = ctx.get("who_grade")
    program = ctx.get("program") or []
    daily = ctx.get("daily_minutes_target")
    appointment = ctx.get("next_appointment")
    meds = ctx.get("medications") or []
    triggers = ctx.get("top_triggers") or []

    out: dict[str, Any] = {
        "name_suffix": f", {name}" if name else "",
        "resources": "\n".join(f"- **{r['name']}** — {r['contact']}  ({r['region']})" for r in CRISIS_RESOURCES),
    }

    # -- what is tinnitus / cure --------------------------------------------- #
    bits: list[str] = []
    if pitch:
        bits.append(
            f"In your case the percept was matched at about **{float(pitch):.0f} Hz**"
            + (
                f", and your audiogram shows {str(who).lower()} hearing loss — the two usually line up, "
                "because the pitch tends to sit at the edge of the hearing loss."
                if who and who != "No impairment"
                else ", and your hearing thresholds are close to normal, which is common and does not mean "
                "the tinnitus is imagined."
            )
        )
    if thi is not None:
        bits.append(f"Your THI handicap score is **{thi}/100** ({thi_grade or 'ungraded'}).")
    out["personal_note"] = " ".join(bits) if bits else (
        "Complete an assessment when you are ready and I can talk you through your own numbers "
        "rather than generalities."
    )

    # -- sleep ---------------------------------------------------------------- #
    sleep_block = next((b for b in program if b.get("schedule") == "sleep_onset"), None)
    out["sleep_block_note"] = (
        f" (**{sleep_block['title']}**, {sleep_block['minutes']} min)" if sleep_block else ""
    )
    if psqi is not None:
        out["sleep_score_note"] = (
            f"Your PSQI sleep score was **{psqi}/21**"
            + (
                " — above the cut-off of 5, so this is a genuine target rather than a minor irritation. "
                "In your profile, fixing sleep is likely to reduce your tinnitus distress more than any "
                "change to the sound itself."
                if psqi > 5
                else " — within normal limits, so protect what is already working."
            )
        )
    else:
        out["sleep_score_note"] = ""

    # -- distress ------------------------------------------------------------- #
    if thi is not None:
        out["distress_note"] = (
            f"Your THI of {thi}/100 puts you in the {(thi_grade or '').lower()} band, and that band "
            "responds to structured treatment — it is not a fixed property of you."
        )
    else:
        out["distress_note"] = ""

    out["hyperacusis_note"] = (
        "\n\nOne caveat for you specifically: your assessment flagged reduced sound tolerance. That "
        "changes the advice — you need a *graded* approach rather than either avoidance or exposure. "
        "Follow the desensitisation block in your plan rather than pushing through loud environments."
        if ctx.get("hyperacusis")
        else ""
    )

    # -- medication ----------------------------------------------------------- #
    if meds:
        listed = ", ".join(str(m) for m in meds[:6])
        out["medication_status"] = f"Your record lists: **{listed}**."
    else:
        out["medication_status"] = "Your record does not list any current medication."

    # -- therapy -------------------------------------------------------------- #
    if program:
        lines = "\n".join(
            f"- **{b.get('title')}** — {b.get('minutes')} min, {str(b.get('schedule', '')).replace('_', ' ')}"
            for b in program[:6]
        )
        out["therapy_status"] = (
            f"Your current plan is **{daily} minutes a day**:\n{lines}"
        )
    else:
        out["therapy_status"] = (
            "You do not have an active therapy plan yet — complete an assessment and one will be "
            "generated from your own measurements."
        )

    if triggers:
        out["trigger_note"] = (
            "\n\nFrom your own diary, the triggers most associated with your worse days so far are: "
            + ", ".join(f"**{t}**" for t in triggers[:4])
            + ". That is your data, not a general rule."
        )
    else:
        out["trigger_note"] = ""

    # -- results -------------------------------------------------------------- #
    rows: list[str] = []
    if pitch:
        rows.append(f"- **Matched frequency:** {float(pitch):.0f} Hz")
    if ctx.get("loudness_match_db_sl") is not None:
        rows.append(f"- **Loudness match:** {ctx['loudness_match_db_sl']:.1f} dB above your threshold")
    if ctx.get("mml_db_sl") is not None:
        rows.append(f"- **Minimum masking level:** {ctx['mml_db_sl']:.1f} dB — {str(ctx.get('maskability_category') or '').lower()}")
    if ctx.get("ri_category"):
        rows.append(f"- **Residual inhibition:** {ctx['ri_category']}")
    if thi is not None:
        rows.append(f"- **THI handicap:** {thi}/100 ({thi_grade})")
    if psqi is not None:
        rows.append(f"- **Sleep (PSQI):** {psqi}/21")
    if ctx.get("gad7_score") is not None:
        rows.append(f"- **Anxiety (GAD-7):** {ctx['gad7_score']}/21")
    if who:
        rows.append(f"- **Hearing:** {who}")
    if ctx.get("tri_score") is not None:
        rows.append(f"- **Tinnitus Reactivity Index:** {ctx['tri_score']}/100 ({ctx.get('tri_band')})")
    out["results_summary"] = "\n".join(rows) if rows else (
        "I cannot see a completed assessment on your record yet."
    )

    if appointment:
        out["appointment_status"] = f"Your next appointment is **{appointment}**."
    else:
        out["appointment_status"] = (
            "I cannot see a scheduled appointment. Your clinician can book one from their dashboard, "
            "or you can request one through the app."
        )
    return out


# --------------------------------------------------------------------------- #
# Suggested follow-ups
# --------------------------------------------------------------------------- #
SUGGESTIONS: dict[str, list[dict[str, str]]] = {
    "greeting": [
        {"label": "Explain my results", "intent": "results_meaning"},
        {"label": "I cannot sleep", "intent": "sleep"},
        {"label": "Help me calm down", "intent": "relaxation"},
    ],
    "education_what_is": [
        {"label": "Is there a cure?", "intent": "education_cure"},
        {"label": "What do my results mean?", "intent": "results_meaning"},
    ],
    "education_cure": [
        {"label": "How does my therapy work?", "intent": "therapy_help"},
        {"label": "What is habituation?", "intent": "education_what_is"},
    ],
    "sleep": [
        {"label": "Start a breathing exercise", "intent": "relaxation", "action": "open_breathing"},
        {"label": "Open my sleep programme", "intent": "therapy_help", "action": "open_therapy"},
    ],
    "coping_distress": [
        {"label": "Breathing exercise", "intent": "relaxation", "action": "open_breathing"},
        {"label": "Work through a thought", "intent": "cbt_catastrophising"},
        {"label": "Message my audiologist", "intent": "appointment", "action": "message_clinician"},
    ],
    "cbt_catastrophising": [
        {"label": "Open the thought record", "intent": "cbt_catastrophising", "action": "open_thought_record"},
        {"label": "What actually causes tinnitus?", "intent": "education_what_is"},
    ],
    "relaxation": [{"label": "Open the paced-breathing player", "intent": "relaxation", "action": "open_breathing"}],
    "therapy_help": [
        {"label": "Open therapy player", "intent": "therapy_help", "action": "open_therapy"},
        {"label": "Log today's diary", "intent": "fallback", "action": "open_diary"},
    ],
    "results_meaning": [
        {"label": "Why do I hear it?", "intent": "education_what_is"},
        {"label": "See my 3D ear model", "intent": "education_what_is", "action": "open_ear_model"},
    ],
    "identification_types": [
        {"label": "Take AI assessment", "intent": "results_meaning", "action": "open_assessment"},
        {"label": "How can it be treated?", "intent": "treatment_options"},
    ],
    "treatment_options": [
        {"label": "Open Sound Therapy", "intent": "therapy_help", "action": "open_therapy"},
        {"label": "What causes spikes?", "intent": "causes_triggers"},
    ],
    "causes_triggers": [
        {"label": "Calming breathing exercise", "intent": "relaxation", "action": "open_breathing"},
        {"label": "Treatment options", "intent": "treatment_options"},
    ],
    "medication": [{"label": "Set up reminders", "intent": "medication", "action": "open_reminders"}],
    "somatic": [{"label": "Message my audiologist", "intent": "appointment", "action": "message_clinician"}],
    "fallback": [
        {"label": "Take AI assessment", "intent": "results_meaning", "action": "open_assessment"},
        {"label": "Explain my results", "intent": "results_meaning"},
        {"label": "Sleep help", "intent": "sleep"},
        {"label": "Breathing exercise", "intent": "relaxation", "action": "open_breathing"},
    ],
}


# --------------------------------------------------------------------------- #
# Optional Claude upgrade
# --------------------------------------------------------------------------- #
CLAUDE_SYSTEM_PROMPT = """You are the Everyday Assistant Companion inside EchoSense AI, a clinical tinnitus \
platform. You are speaking directly to a patient between their audiology appointments.

Hard rules:
- You are not a doctor. Never diagnose, never name a specific medication or dose to start or stop, \
never contradict the patient's clinician.
- Never promise a cure and never claim the tinnitus will go away. Be honest that the sound usually \
persists while the distress is treatable. False hope is harmful here.
- If the patient mentions self-harm, suicide, sudden hearing loss, pulsatile tinnitus, facial \
weakness or severe vertigo, do not counsel - direct them to urgent human care immediately.
- Ground every claim in the patient's own assessment data provided below. Cite their real numbers. \
If a number is absent, say so rather than inventing it.
- Reply in the same language the patient wrote in.
- Warm, direct, concrete. No filler, no false cheerfulness, no bullet-point avalanche. \
Under 220 words unless they asked for detail.
- End with one specific thing they can do now, or one question.

Evidence base you may draw on: central gain and hair-cell loss as the mechanism; habituation; \
notched sound therapy; mixing-point level setting rather than complete masking; CBT for tinnitus \
distress; sleep hygiene and CBT-I; the weak relationship between loudness and suffering; safe noise \
exposure limits and the harm of over-protection."""


def _call_claude(
    *, message: str, patient_context: Mapping[str, Any], lang: str, history: list[Mapping[str, Any]]
) -> str | None:
    """Best-effort call to the Claude API using only the standard library."""
    if not settings.anthropic_api_key:
        return None

    facts = {
        k: v
        for k, v in (patient_context or {}).items()
        if k
        in {
            "full_name", "age", "pitch_match_hz", "loudness_match_db_sl", "mml_db_sl",
            "ri_category", "thi_score", "thi_grade", "psqi_score", "pss10_score",
            "gad7_score", "who_grade", "hyperacusis", "tri_score", "tri_band",
            "daily_minutes_target", "next_appointment", "top_triggers", "duration_months",
        }
        and v is not None
    }
    program = [
        {"title": b.get("title"), "minutes": b.get("minutes"), "schedule": b.get("schedule")}
        for b in (patient_context or {}).get("program", [])[:8]
    ]

    messages: list[dict[str, Any]] = []
    for turn in history[-8:]:
        role = "assistant" if turn.get("role") == "assistant" else "user"
        content = str(turn.get("content") or "").strip()
        if content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message})

    payload = {
        "model": settings.anthropic_model,
        "max_tokens": 700,
        "system": (
            f"{CLAUDE_SYSTEM_PROMPT}\n\n"
            f"Patient assessment data (JSON): {json.dumps(facts, default=str)}\n"
            f"Active therapy programme: {json.dumps(program, default=str)}\n"
            f"Detected language code: {lang}"
        ),
        "messages": messages,
    }
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "content-type": "application/json",
            "x-api-key": settings.anthropic_api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            body = json.loads(response.read().decode())
        parts = [b.get("text", "") for b in body.get("content", []) if b.get("type") == "text"]
        text = "\n".join(p for p in parts if p).strip()
        return text or None
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError):
        # Any failure falls through to the offline reply - the assistant must
        # never be unavailable because a third-party API had a bad minute.
        return None


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #
def respond(
    *,
    message: str,
    patient_context: Mapping[str, Any] | None = None,
    locale: str = "en",
    history: list[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    text = (message or "").strip()
    if not text:
        return {
            "reply": RESPONSES["fallback"].get(locale, RESPONSES["fallback"]["en"]),
            "intent": "fallback",
            "confidence": 0.0,
            "locale": locale,
            "engine": "rules",
            "safety_flag": None,
            "suggestions": SUGGESTIONS["fallback"],
        }

    lang = detect_language(text, default=locale)
    intent, confidence, matched = classify_intent(text, lang)
    distortions = detect_distortions(text)
    context = build_context(patient_context)

    # ---- safety first, always deterministic -------------------------------- #
    if intent == "crisis":
        template = CRISIS_MESSAGE.get(lang) or CRISIS_MESSAGE["en"]
        return {
            "reply": _safe_format(template, context),
            "intent": "crisis",
            "confidence": confidence,
            "locale": lang,
            "engine": "rules",
            "safety_flag": "self_harm_risk",
            "escalate": True,
            "escalation_reason": "Patient message contained self-harm or suicidal content.",
            "crisis_resources": CRISIS_RESOURCES,
            "matched_patterns": matched,
            "suggestions": [
                {"label": "Message my audiologist now", "intent": "appointment", "action": "message_clinician"}
            ],
        }

    if intent == "medical_emergency":
        template = RESPONSES["medical_emergency"].get(lang) or RESPONSES["medical_emergency"]["en"]
        return {
            "reply": _safe_format(template, context),
            "intent": "medical_emergency",
            "confidence": confidence,
            "locale": lang,
            "engine": "rules",
            "safety_flag": "urgent_medical",
            "escalate": True,
            "escalation_reason": "Patient reported a potential otological red flag.",
            "matched_patterns": matched,
            "suggestions": [
                {"label": "Message my audiologist now", "intent": "appointment", "action": "message_clinician"}
            ],
        }

    # ---- a detected distortion outranks a generic intent -------------------- #
    if distortions and intent in {"coping_distress", "fallback", "education_cure"}:
        intent = "cbt_catastrophising"

    if intent == "cbt_catastrophising" and distortions:
        primary = distortions[0]
        context = {
            **context,
            "detected_thought": text if len(text) <= 180 else text[:177] + "...",
            "catastrophe_correction": f"**{primary['name']}.** {primary['correction']}",
        }

    bank = RESPONSES.get(intent) or RESPONSES["fallback"]
    template = bank.get(lang)
    translation_fallback = template is None
    if template is None:
        template = bank.get("en") or RESPONSES["fallback"]["en"]

    reply = _safe_format(template, context)
    engine = "rules"

    # ---- optional Claude upgrade for non-safety turns ----------------------- #
    if settings.anthropic_api_key and intent != "greeting":
        upgraded = _call_claude(
            message=text,
            patient_context=patient_context or {},
            lang=lang,
            history=history or [],
        )
        if upgraded:
            reply, engine = upgraded, "claude"

    result: dict[str, Any] = {
        "reply": reply,
        "intent": intent,
        "confidence": confidence,
        "locale": lang,
        "engine": engine,
        "safety_flag": None,
        "matched_patterns": matched,
        "distortions": distortions,
        "suggestions": SUGGESTIONS.get(intent, SUGGESTIONS["fallback"]),
    }
    if translation_fallback and lang != "en":
        result["note"] = (
            f"This topic is not yet translated into {LANGUAGES.get(lang, {}).get('name', lang)}; "
            "answered in English."
        )
    if intent == "somatic":
        result["clinician_note"] = "Patient reports somatic modulation - flag for TMJ / cervical assessment."
    return result

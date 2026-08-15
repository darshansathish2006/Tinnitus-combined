"""Red-flag safety triage.

The single most important thing an automated tinnitus tool must do is recognise
the presentations that are *not* ordinary subjective tinnitus and route them to a
human quickly. These rules follow standard otology referral guidance (AAO-HNSF
clinical practice guideline for tinnitus; NICE NG155).

Every rule returns the referral action, urgency and the reason, so the clinician
sees why the system escalated rather than an opaque score.
"""

from __future__ import annotations

from typing import Any, Mapping

URGENCY_ORDER = {"routine": 0, "soon": 1, "urgent": 2, "emergency": 3}


def evaluate_red_flags(
    *,
    patient: Mapping[str, Any],
    assessment: Mapping[str, Any],
    audiogram_analysis: Mapping[str, Any],
    scores: Mapping[str, Any],
    diary_recent: list[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    flags: list[dict[str, Any]] = []

    def flag(
        code: str,
        title: str,
        urgency: str,
        action: str,
        evidence: str,
        pathway: str,
    ) -> None:
        flags.append(
            {
                "code": code,
                "title": title,
                "urgency": urgency,
                "action": action,
                "evidence": evidence,
                "pathway": pathway,
            }
        )

    duration_months = patient.get("duration_months")
    laterality = (patient.get("laterality") or "").lower()
    asym = audiogram_analysis.get("asymmetry_db")

    # --- 1. Sudden sensorineural hearing loss: a medical emergency ---------- #
    worse_pta = audiogram_analysis.get("worse_ear_pta")
    if (
        duration_months is not None
        and duration_months <= 1
        and worse_pta is not None
        and worse_pta >= 30
        and (asym or 0) >= 15
    ):
        flag(
            "sudden_snhl",
            "Possible sudden sensorineural hearing loss",
            "emergency",
            "Same-day ENT assessment. Systemic corticosteroids are time-critical and benefit falls sharply after 2 weeks from onset.",
            f"Onset {duration_months} month(s) ago with {worse_pta:.0f} dB HL in the worse ear and {asym:.0f} dB interaural asymmetry.",
            "ENT / emergency audiology",
        )

    # --- 2. Pulsatile tinnitus: vascular or CSF-pressure cause -------------- #
    if patient.get("pulsatile"):
        flag(
            "pulsatile",
            "Pulsatile tinnitus reported",
            "urgent",
            "Auscultate head and neck, check blood pressure, and refer for vascular imaging (MRA/CTA) to exclude dural AV fistula, stenosis, glomus tumour or idiopathic intracranial hypertension.",
            "Patient reports a percept synchronous with the heartbeat, which is objective rather than subjective tinnitus.",
            "Neuro-otology / neuroradiology",
        )

    # --- 3. Unilateral tinnitus with asymmetric loss: retrocochlear ---------- #
    if laterality in {"left", "right"} and (asym or 0) >= 15:
        flag(
            "asymmetric_unilateral",
            "Unilateral tinnitus with asymmetric hearing loss",
            "urgent",
            "Refer for MRI internal auditory meatus to exclude vestibular schwannoma or other retrocochlear pathology.",
            f"Strictly {laterality}-sided percept with {asym:.0f} dB interaural PTA asymmetry.",
            "ENT with MRI IAM",
        )
    elif laterality in {"left", "right"} and asym is None:
        flag(
            "unilateral_unquantified",
            "Unilateral tinnitus, asymmetry not yet quantified",
            "soon",
            "Complete bilateral pure-tone audiometry so interaural asymmetry can be assessed against the imaging threshold.",
            f"Strictly {laterality}-sided percept with incomplete audiometry.",
            "Audiology",
        )

    # --- 4. Neurological / vestibular accompaniment ------------------------- #
    comorbidities = {str(c).lower() for c in (patient.get("comorbidities") or [])}
    neuro_terms = {
        "vertigo": ("Vertigo with tinnitus", "Assess for Meniere disease, vestibular migraine or vestibular schwannoma; document episode duration and any aural fullness."),
        "facial weakness": ("Facial weakness with tinnitus", "Urgent neuro-otology review - cranial nerve involvement suggests a space-occupying or inflammatory lesion."),
        "facial numbness": ("Facial numbness with tinnitus", "Urgent neuro-otology review for trigeminal involvement."),
        "headache": ("Persistent headache with tinnitus", "Consider raised intracranial pressure, especially if the tinnitus is pulsatile or postural."),
        "visual disturbance": ("Visual disturbance with tinnitus", "Fundoscopy for papilloedema; consider idiopathic intracranial hypertension."),
        "otorrhoea": ("Ear discharge with tinnitus", "Otoscopy and ENT review for chronic otitis media or cholesteatoma."),
    }
    for term, (title, action) in neuro_terms.items():
        if any(term in c for c in comorbidities):
            flag(
                f"neuro_{term.replace(' ', '_')}",
                title,
                "urgent" if term in {"facial weakness", "facial numbness", "visual disturbance"} else "soon",
                action,
                f"Reported comorbidity: {term}.",
                "Neuro-otology",
            )

    # --- 5. Psychological risk --------------------------------------------- #
    thi = (scores.get("thi") or {})
    gad7 = (scores.get("gad7") or {})
    phq2 = (scores.get("phq2") or {})
    if "catastrophic_ideation_item" in (thi.get("flags") or []) or (thi.get("score") or 0) >= 78:
        flag(
            "psychological_distress_severe",
            "Severe tinnitus-related distress",
            "urgent",
            "Same-week clinician contact with explicit risk assessment. Offer crisis contact details and consider urgent psychological referral.",
            f"THI {thi.get('score')}/100 ({thi.get('grade')}) with maximal responses on the hopelessness cluster.",
            "Clinical psychology / mental health",
        )
    if (phq2.get("score") or 0) >= 3:
        flag(
            "depression_screen_positive",
            "Positive depression screen",
            "soon",
            "Administer PHQ-9 and assess suicidal ideation directly. Coordinate with primary care.",
            f"PHQ-2 {phq2.get('score')}/6.",
            "Primary care / mental health",
        )
    if (gad7.get("score") or 0) >= 15:
        flag(
            "severe_anxiety",
            "Severe anxiety",
            "soon",
            "Refer to mental-health services in parallel with audiological rehabilitation; anxiety maintains tinnitus distress.",
            f"GAD-7 {gad7.get('score')}/21.",
            "Mental health",
        )

    # --- 6. Hyperacusis with collapsed dynamic range ------------------------ #
    ldls = [v for v in (assessment.get("ldl_left"), assessment.get("ldl_right")) if v is not None]
    if patient.get("hyperacusis") or (ldls and min(ldls) < 80):
        detail = f"Lowest loudness discomfort level {min(ldls):.0f} dB HL." if ldls else "Patient reports sound intolerance."
        flag(
            "hyperacusis",
            "Hyperacusis / reduced sound tolerance",
            "soon",
            "Do NOT escalate masker level. Begin low-level desensitisation below the discomfort threshold and cap output. Consider pink-noise desensitisation protocol.",
            detail,
            "Audiology - hyperacusis protocol",
        )

    # --- 7. Rebound to masking: therapy contraindication -------------------- #
    if (assessment.get("ri_depth_pct") or 0) <= -10:
        flag(
            "masking_rebound",
            "Tinnitus rebound after masking",
            "routine",
            "Avoid masking-based therapy. Use low-level sound enrichment plus habituation and CBT instead.",
            f"Residual inhibition testing showed a {abs(assessment['ri_depth_pct']):.0f}% increase in loudness after the masker.",
            "Audiology - therapy plan revision",
        )

    # --- 8. Ambient noise invalidating thresholds --------------------------- #
    ambient = (assessment.get("device_profile") or {}).get("ambient_noise_db")
    if ambient is not None and ambient > 40:
        flag(
            "invalid_test_environment",
            "Ambient noise too high for valid thresholds",
            "routine",
            "Repeat audiometry in a quieter room or a sound booth. Low-frequency thresholds are likely masked and overstated.",
            f"Measured ambient level {ambient:.0f} dB(A) during testing (threshold for screening validity is ~40 dB(A)).",
            "Re-test",
        )

    # --- 9. Rapid deterioration in the diary trend ------------------------- #
    if diary_recent and len(diary_recent) >= 10:
        recent = [d for d in diary_recent[-7:] if d.get("ringing_intensity") is not None]
        prior = [d for d in diary_recent[-21:-7] if d.get("ringing_intensity") is not None]
        if len(recent) >= 4 and len(prior) >= 5:
            r = sum(d["ringing_intensity"] for d in recent) / len(recent)
            p = sum(d["ringing_intensity"] for d in prior) / len(prior)
            if r - p >= 2.0:
                flag(
                    "diary_escalation",
                    "Sustained escalation in self-reported intensity",
                    "soon",
                    "Contact the patient to review triggers, adherence and any new medication or noise exposure.",
                    f"7-day mean intensity {r:.1f}/10 versus {p:.1f}/10 in the preceding fortnight (+{r - p:.1f}).",
                    "Audiology follow-up",
                )

    flags.sort(key=lambda f: -URGENCY_ORDER.get(f["urgency"], 0))
    highest = flags[0]["urgency"] if flags else "routine"
    return {
        "flags": flags,
        "count": len(flags),
        "highest_urgency": highest,
        "requires_human_review": any(
            f["urgency"] in {"urgent", "emergency"} for f in flags
        ),
        "summary": (
            f"{len(flags)} safety consideration(s) identified; highest urgency: {highest}."
            if flags
            else "No red flags identified. Suitable for the standard digital rehabilitation pathway."
        ),
    }

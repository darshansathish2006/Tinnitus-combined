"""The analysis pipeline.

One function, `analyse`, is the single path from raw assessment data to everything
downstream: instrument scores, audiogram interpretation, derived composites,
red-flag triage, terminology coding, model predictions with Shapley explanations,
and a therapy prescription. Routers call this; nothing else recomputes any part
of it, so the report, the dashboard and the patient app can never disagree.

Ordering is deliberate:

1. Score the instruments (pure, always succeeds).
2. Interpret the audiogram and derive composites.
3. **Red-flag triage** - rule-based, runs before and independently of the models,
   so a safety escalation never depends on an ML artifact being present.
4. Predict, if the ensemble is trained. Degrades gracefully if it is not.
5. Prescribe therapy, informed by the predictions where available.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Mapping, Sequence

from clinical.audiometry import (
    audiometry_plan,
    analyse_audiogram,
    classify_residual_inhibition,
    maskability,
    spectral_signature,
    threshold_at,
    tinnitus_reactivity_index,
)
from clinical.coding import CODING_DISCLAIMER, suggest_icd11
from clinical.instruments import score_all
from clinical.redflags import evaluate_red_flags
from dsp.therapy import prescribe
from ml.predict import ModelsUnavailable, predict_all


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def patient_dict(patient: Any) -> dict[str, Any]:
    """Flatten an ORM Patient (plus its User) into the mapping the layers expect."""
    return {
        "id": patient.id,
        "mrn": patient.mrn,
        "full_name": getattr(patient.user, "full_name", None),
        "date_of_birth": patient.date_of_birth,
        "age": patient.age,
        "sex": patient.sex,
        "duration_months": patient.duration_months,
        "onset_date": patient.onset_date,
        "tinnitus_character": patient.tinnitus_character or None,
        "tinnitus_characters": list(patient.tinnitus_characters or []),
        # Django stores choices as plain strings, so there is no `.value` to unwrap.
        "laterality": patient.laterality or None,
        "pulsatile": patient.pulsatile,
        "somatic_modulation": patient.somatic_modulation,
        "hyperacusis": patient.hyperacusis,
        "hearing_aid_use": patient.hearing_aid_use,
        "noise_exposure_years": patient.noise_exposure_years,
        "comorbidities": patient.comorbidities or [],
        "medications": patient.medications or [],
        "etiology_notes": patient.etiology_notes,
    }


def assessment_dict(assessment: Any) -> dict[str, Any]:
    """Flatten an ORM Assessment into a plain mapping."""
    return {
        "id": assessment.id,
        "created_at": assessment.created_at,
        "status": assessment.status or None,
        "modules_done": assessment.modules_done or [],
        "device_profile": assessment.device_profile or {},
        "audiogram": assessment.audiogram or {},
        "pta_left": assessment.pta_left,
        "pta_right": assessment.pta_right,
        "hf_pta_left": assessment.hf_pta_left,
        "hf_pta_right": assessment.hf_pta_right,
        "pitch_match_hz": assessment.pitch_match_hz,
        "pitch_match_ear": assessment.pitch_match_ear or None,
        "pitch_match_confidence": assessment.pitch_match_confidence,
        "octave_confusion": assessment.octave_confusion,
        "pitch_match_trace": assessment.pitch_match_trace or [],
        "loudness_match_db_sl": assessment.loudness_match_db_sl,
        "loudness_match_db_hl": assessment.loudness_match_db_hl,
        "mml_db_sl": assessment.mml_db_sl,
        "ri_depth_pct": assessment.ri_depth_pct,
        "ri_duration_s": assessment.ri_duration_s,
        "ri_trace": assessment.ri_trace or [],
        "tinnitus_bandwidth": assessment.tinnitus_bandwidth,
        "ldl_left": assessment.ldl_left,
        "ldl_right": assessment.ldl_right,
        "thi_items": assessment.thi_items or {},
        "thi_score": assessment.thi_score,
        "thi_grade": assessment.thi_grade,
        "thi_subscales": assessment.thi_subscales or {},
        "vas_loudness": assessment.vas_loudness,
        "vas_annoyance": assessment.vas_annoyance,
        "vas_awareness": assessment.vas_awareness,
        "vas_sleep_interference": assessment.vas_sleep_interference,
        # `score_vas()` (and the clinical report's own VAS table) expect the
        # four scales nested under "vas", the same shape `apply_submission`
        # accepts on write and `rescore()` already builds for its own scoring
        # pass. Without this nested key, `score_all()` here always read the
        # scales as absent — the four flat fields above were being stored
        # correctly but never actually scored or reported on.
        "vas": {
            "vas_loudness": assessment.vas_loudness,
            "vas_annoyance": assessment.vas_annoyance,
            "vas_awareness": assessment.vas_awareness,
            "vas_sleep_interference": assessment.vas_sleep_interference,
        },
        "psqi_items": assessment.psqi_items or {},
        "psqi_score": assessment.psqi_score,
        "pss10_items": assessment.pss10_items or {},
        "pss10_score": assessment.pss10_score,
        "gad7_items": assessment.gad7_items or {},
        "gad7_score": assessment.gad7_score,
        # Short-form screeners under the stepped protocol.
        "gad2_items": assessment.gad7_items or {},
        "pss4_items": assessment.pss10_items or {},
        "sleep_screen_items": {"sleep_screen": assessment.sleep_screen_score}
        if assessment.sleep_screen_score is not None
        else {},
        "gad2_score": assessment.gad2_score,
        "pss4_score": assessment.pss4_score,
        "sleep_screen_score": assessment.sleep_screen_score,
        "phq2_items": assessment.phq2_items or {},
        "phq2_score": assessment.phq2_score,
        "derived": assessment.derived or {},
    }


def diary_dicts(entries: Sequence[Any]) -> list[dict[str, Any]]:
    return [
        {
            "entry_date": e.entry_date,
            "ringing_intensity": e.ringing_intensity,
            "annoyance": e.annoyance,
            "stress_level": e.stress_level,
            "sleep_hours": e.sleep_hours,
            "sleep_quality": e.sleep_quality,
            "therapy_minutes": e.therapy_minutes,
            "medication_taken": e.medication_taken,
            "mood": e.mood,
            "triggers": e.triggers or [],
            "pitch_shift": e.pitch_shift,
            "caffeine_units": e.caffeine_units,
            "alcohol_units": e.alcohol_units,
            "noise_exposure_minutes": e.noise_exposure_minutes,
        }
        for e in entries
    ]


def session_dicts(sessions: Sequence[Any]) -> list[dict[str, Any]]:
    return [
        {
            "modality": s.modality,
            "planned_seconds": s.planned_seconds,
            "actual_seconds": s.actual_seconds,
            "completed": s.completed,
            "pre_vas_loudness": s.pre_vas_loudness,
            "post_vas_loudness": s.post_vas_loudness,
            "pre_vas_annoyance": s.pre_vas_annoyance,
            "post_vas_annoyance": s.post_vas_annoyance,
            "residual_inhibition_s": s.residual_inhibition_s,
            "started_at": s.started_at,
        }
        for s in sessions
    ]


def adherence_from_sessions(sessions: Sequence[Mapping[str, Any]]) -> float | None:
    planned = sum(float(s.get("planned_seconds") or 0) for s in sessions)
    actual = sum(float(s.get("actual_seconds") or 0) for s in sessions)
    if planned <= 0:
        return None
    return round(min(100.0, 100 * actual / planned), 1)


# --------------------------------------------------------------------------- #
# Derived metric computation
# --------------------------------------------------------------------------- #
def compute_derived(
    *,
    patient: Mapping[str, Any],
    assessment: Mapping[str, Any],
    scores: Mapping[str, Any],
    audiogram_analysis: Mapping[str, Any],
) -> dict[str, Any]:
    mask = maskability(assessment.get("mml_db_sl"), assessment.get("loudness_match_db_sl"))
    ri = classify_residual_inhibition(
        assessment.get("ri_depth_pct"), assessment.get("ri_duration_s")
    )
    ldls = [v for v in (assessment.get("ldl_left"), assessment.get("ldl_right")) if v is not None]

    tri = tinnitus_reactivity_index(
        thi=(scores.get("thi") or {}).get("score"),
        vas_annoyance=assessment.get("vas_annoyance"),
        psqi=(scores.get("psqi") or {}).get("score"),
        gad7=(scores.get("gad7") or {}).get("score"),
        pss10=(scores.get("pss10") or {}).get("score"),
        maskability_index=mask.get("index"),
        somatic_modulation=bool(patient.get("somatic_modulation")),
        hyperacusis=bool(patient.get("hyperacusis")),
        ldl_min=min(ldls) if ldls else None,
    )

    pitch = assessment.get("pitch_match_hz")
    signature = spectral_signature(
        pitch, assessment.get("tinnitus_bandwidth"), assessment.get("audiogram")
    )

    # Sensation level of the percept, recomputed from the audiogram so it is
    # consistent even if the client sent only dB HL.
    sl = assessment.get("loudness_match_db_sl")
    if sl is None and assessment.get("loudness_match_db_hl") is not None and pitch:
        ear = "left" if (audiogram_analysis.get("pta_left") or 0) >= (
            audiogram_analysis.get("pta_right") or 0
        ) else "right"
        thr = threshold_at((assessment.get("audiogram") or {}).get(ear), float(pitch))
        if thr is not None:
            sl = round(float(assessment["loudness_match_db_hl"]) - thr, 1)

    return {
        "maskability": mask,
        "residual_inhibition": ri,
        "tri": tri,
        "spectral_signature": signature,
        "loudness_db_sl_derived": sl,
        "threshold_at_pitch": threshold_at(
            (assessment.get("audiogram") or {}).get("left"), float(pitch)
        )
        if pitch
        else None,
        "audiogram": {
            k: v for k, v in audiogram_analysis.items() if k not in {"notch_left", "notch_right"}
        },
    }


# --------------------------------------------------------------------------- #
# Full pipeline
# --------------------------------------------------------------------------- #
def analyse(
    *,
    patient: Mapping[str, Any],
    assessment: Mapping[str, Any],
    diary: Sequence[Mapping[str, Any]] | None = None,
    sessions: Sequence[Mapping[str, Any]] | None = None,
    include_prediction: bool = True,
    include_therapy: bool = True,
) -> dict[str, Any]:
    diary = list(diary or [])
    sessions = list(sessions or [])

    # 1 - instrument scoring
    scores = score_all(assessment)

    # 2 - audiometry + composites
    audiogram_analysis = analyse_audiogram(assessment.get("audiogram"))
    derived = compute_derived(
        patient=patient,
        assessment=assessment,
        scores=scores,
        audiogram_analysis=audiogram_analysis,
    )

    # 3 - safety triage, independent of the ML layer
    red_flags = evaluate_red_flags(
        patient=patient,
        assessment=assessment,
        audiogram_analysis=audiogram_analysis,
        scores=scores,
        diary_recent=diary,
    )

    # Terminology. Anxiety coding uses the GAD-7 when it was administered and falls
    # back to a GAD-2 positive screen scaled to the GAD-7 referral threshold, so a
    # patient who screened positive but has not yet completed the long form is not
    # silently coded as having no anxiety.
    gad7_for_coding = (scores.get("gad7") or {}).get("score")
    if gad7_for_coding is None and ((scores.get("gad2") or {}).get("score") or 0) >= 3:
        gad7_for_coding = 10

    icd11 = suggest_icd11(
        thi_score=(scores.get("thi") or {}).get("score"),
        pulsatile=bool(patient.get("pulsatile")),
        hyperacusis=bool(patient.get("hyperacusis")),
        who_grade=audiogram_analysis.get("who_grade"),
        noise_notch=bool(audiogram_analysis.get("notch")),
        psqi_score=(scores.get("psqi") or {}).get("score"),
        gad7_score=gad7_for_coding,
        phq2_score=(scores.get("phq2") or {}).get("score"),
    )

    # 4 - prediction
    prediction: dict[str, Any] | None = None
    prediction_error: str | None = None
    if include_prediction:
        # Feed the scored values back so the model sees the same numbers the
        # clinician does, even when the client posted only raw item responses.
        enriched = {
            **dict(assessment),
            "thi_score": (scores.get("thi") or {}).get("score"),
            "thi_subscales": (scores.get("thi") or {}).get("subscales"),
            "psqi_score": (scores.get("psqi") or {}).get("score"),
            "pss10_score": (scores.get("pss10") or {}).get("score"),
            "gad7_score": (scores.get("gad7") or {}).get("score"),
            "phq2_score": (scores.get("phq2") or {}).get("score"),
            # Short-form screeners are features in their own right, so a patient
            # who screened negative and never took the long form still contributes
            # that information rather than presenting as entirely missing.
            "gad2_score": (scores.get("gad2") or {}).get("score"),
            "pss4_score": (scores.get("pss4") or {}).get("score"),
            "sleep_screen_score": (scores.get("sleep_screen") or {}).get("score"),
            **{k: v for k, v in (scores.get("vas") or {}).items() if v is not None},
            "loudness_match_db_sl": assessment.get("loudness_match_db_sl")
            or derived.get("loudness_db_sl_derived"),
        }
        enriched["vas_sleep_interference"] = (scores.get("vas") or {}).get("vas_sleep_interference")
        try:
            prediction = predict_all(
                patient=patient,
                assessment=enriched,
                diary=diary,
                adherence_pct=adherence_from_sessions(sessions),
            )
        except ModelsUnavailable as exc:
            prediction_error = str(exc)

    # 5 - therapy
    therapy: dict[str, Any] | None = None
    if include_therapy:
        therapy = prescribe(
            patient=patient,
            assessment={
                **dict(assessment),
                "thi_score": (scores.get("thi") or {}).get("score"),
                "psqi_score": (scores.get("psqi") or {}).get("score"),
                "pss10_score": (scores.get("pss10") or {}).get("score"),
                "gad7_score": (scores.get("gad7") or {}).get("score"),
                "vas_sleep_interference": (scores.get("vas") or {}).get("vas_sleep_interference"),
                "hf_pta_right": audiogram_analysis.get("hf_pta_right"),
                "loudness_match_db_sl": assessment.get("loudness_match_db_sl")
                or derived.get("loudness_db_sl_derived"),
            },
            prediction=prediction,
            session_history=sessions,
            diary=diary,
        )

    summary = build_summary(
        patient=patient,
        scores=scores,
        audiogram_analysis=audiogram_analysis,
        derived=derived,
        red_flags=red_flags,
        prediction=prediction,
        therapy=therapy,
    )

    return _jsonable(
        {
            "scores": scores,
            "audiogram": audiogram_analysis,
            "derived": derived,
            "red_flags": red_flags,
            "icd11": icd11,
            "coding_disclaimer": CODING_DISCLAIMER,
            "prediction": prediction,
            "prediction_error": prediction_error,
            "therapy": therapy,
            "summary": summary,
            # What the stepped protocol indicates next, and which extra audiometric
            # frequencies the BSA inter-octave rule calls for. Both are shown to the
            # clinician so the shorter battery is auditable rather than just shorter.
            "escalations": scores.get("escalations", []),
            "audiometry_plan": audiometry_plan(assessment.get("audiogram")),
        }
    )


def build_summary(
    *,
    patient: Mapping[str, Any],
    scores: Mapping[str, Any],
    audiogram_analysis: Mapping[str, Any],
    derived: Mapping[str, Any],
    red_flags: Mapping[str, Any],
    prediction: Mapping[str, Any] | None,
    therapy: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """The narrative block that heads the clinical report."""
    thi = scores.get("thi") or {}
    tri = derived.get("tri") or {}
    ri = derived.get("residual_inhibition") or {}
    mask = derived.get("maskability") or {}
    outputs = (prediction or {}).get("outputs", {})

    headline_parts: list[str] = []
    age = patient.get("age")
    dur = patient.get("duration_months")
    headline_parts.append(
        f"{age}-year-old" if age else "Adult"
    )
    lat = patient.get("laterality")
    headline_parts.append(
        f"with {lat + '-sided' if lat in {'left', 'right'} else (lat or 'bilateral')} "
        f"{(patient.get('tinnitus_character') or 'tinnitus').lower()}"
    )
    if dur:
        headline_parts.append(
            f"for {dur / 12:.1f} years" if dur >= 24 else f"for {dur:.0f} months"
        )

    findings: list[str] = []
    if audiogram_analysis.get("who_grade"):
        findings.append(
            f"Audiometry: {audiogram_analysis['who_grade'].lower()} "
            f"(better-ear PTA {audiogram_analysis.get('better_ear_pta')} dB HL"
            + (
                f", {audiogram_analysis['configuration_left'].lower()} configuration)."
                if audiogram_analysis.get("configuration_left")
                else ")."
            )
        )
    if audiogram_analysis.get("notch"):
        findings.append(
            f"Audiometric notch at {audiogram_analysis['notch']['centre_hz']} Hz "
            f"({audiogram_analysis['notch']['depth_db']} dB deep), consistent with noise exposure."
        )
    if thi.get("score") is not None:
        findings.append(f"THI {thi['score']}/100 - {thi.get('grade')}.")
    if tri.get("score") is not None:
        findings.append(f"Tinnitus Reactivity Index {tri['score']}/100 ({tri.get('band')}).")
    if ri.get("category"):
        findings.append(f"Residual inhibition: {ri['category'].lower()}. {ri.get('note', '')}".strip())
    if mask.get("category"):
        findings.append(f"Maskability: {mask['category'].lower()}.")

    if outputs.get("worsening_risk") is not None:
        findings.append(
            f"Modelled six-month worsening risk {outputs['worsening_risk']:.0%} "
            f"({outputs.get('risk_band')} band)."
        )
    if outputs.get("therapy_response") is not None:
        findings.append(
            f"Predicted acoustic-therapy response likelihood {outputs['therapy_response']:.0%}."
        )

    actions: list[str] = []
    for flag in (red_flags.get("flags") or [])[:3]:
        actions.append(f"[{flag['urgency'].upper()}] {flag['title']}: {flag['action']}")
    if therapy:
        actions.append(
            f"Commence {therapy['strategy'].replace('_', ' ')} programme, "
            f"{therapy['daily_minutes_target']} min/day, review in {therapy['review_after_days']} days."
        )
    if (scores.get("gad7") or {}).get("score", 0) and scores["gad7"]["score"] >= 10:
        actions.append("Refer for psychological support - anxiety above the referral threshold.")

    return {
        "headline": " ".join(headline_parts) + ".",
        "findings": findings,
        "actions": actions,
        "requires_human_review": red_flags.get("requires_human_review", False),
        "highest_urgency": red_flags.get("highest_urgency", "routine"),
        "narratives": (prediction or {}).get("narratives", {}),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }

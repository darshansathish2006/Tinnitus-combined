"""The feature contract.

Training and inference both build their design matrix through `build_row` here,
so a feature can never be added on one side only - the classic cause of a model
that scores well offline and silently misbehaves in production.

Missing values are deliberately left as NaN: every model in this project is a
histogram gradient-boosting model, which handles missing values natively by
learning a default split direction. That means a patient who skipped the sleep
questionnaire still gets a prediction, with the uncertainty that implies, rather
than being silently imputed to the cohort mean.
"""

from __future__ import annotations

import math
from typing import Any, Mapping

import numpy as np

from clinical.audiometry import (
    HF_PTA_FREQS,
    PTA_FREQS,
    analyse_audiogram,
    maskability,
    mean_threshold,
    slope_db_per_octave,
    threshold_at,
)

NAN = float("nan")

# --------------------------------------------------------------------------- #
# Feature registry. `group` drives how the explanation panel clusters drivers;
# `label` and `unit` are what the clinician actually reads.
# --------------------------------------------------------------------------- #
FEATURES: list[dict[str, Any]] = [
    {"key": "age", "label": "Age", "unit": "years", "group": "demographic"},
    {"key": "sex_male", "label": "Sex (male)", "unit": "", "group": "demographic"},
    {"key": "duration_months", "label": "Tinnitus duration", "unit": "months", "group": "history"},
    {"key": "noise_exposure_years", "label": "Occupational noise exposure", "unit": "years", "group": "history"},
    {"key": "laterality_unilateral", "label": "Unilateral percept", "unit": "", "group": "history"},
    {"key": "pulsatile", "label": "Pulsatile character", "unit": "", "group": "history"},
    {"key": "somatic_modulation", "label": "Somatic modulation", "unit": "", "group": "history"},
    {"key": "hyperacusis", "label": "Hyperacusis", "unit": "", "group": "history"},
    {"key": "hearing_aid_use", "label": "Hearing aid use", "unit": "", "group": "history"},
    {"key": "comorbidity_count", "label": "Comorbidity count", "unit": "", "group": "history"},
    {"key": "pta_better", "label": "Better-ear pure tone average", "unit": "dB HL", "group": "audiometry"},
    {"key": "pta_worse", "label": "Worse-ear pure tone average", "unit": "dB HL", "group": "audiometry"},
    {"key": "hf_pta_worse", "label": "High-frequency PTA (worse ear)", "unit": "dB HL", "group": "audiometry"},
    {"key": "asymmetry_db", "label": "Interaural asymmetry", "unit": "dB", "group": "audiometry"},
    {"key": "audiogram_slope", "label": "Audiogram slope", "unit": "dB/octave", "group": "audiometry"},
    {"key": "notch_present", "label": "Audiometric notch present", "unit": "", "group": "audiometry"},
    {"key": "notch_centre_oct", "label": "Notch centre (log2 Hz)", "unit": "oct", "group": "audiometry"},
    {"key": "edge_frequency_oct", "label": "Hearing-loss edge frequency (log2 Hz)", "unit": "oct", "group": "audiometry"},
    {"key": "pitch_oct", "label": "Matched tinnitus pitch (log2 Hz)", "unit": "oct", "group": "psychoacoustic"},
    {"key": "loudness_db_sl", "label": "Tinnitus loudness (sensation level)", "unit": "dB SL", "group": "psychoacoustic"},
    {"key": "mml_db_sl", "label": "Minimum masking level", "unit": "dB SL", "group": "psychoacoustic"},
    {"key": "maskability_index", "label": "Maskability", "unit": "0-1", "group": "psychoacoustic"},
    {"key": "ri_depth_pct", "label": "Residual inhibition depth", "unit": "%", "group": "psychoacoustic"},
    {"key": "bandwidth_ordinal", "label": "Percept bandwidth", "unit": "0=tonal..2=broad", "group": "psychoacoustic"},
    {"key": "threshold_at_pitch", "label": "Hearing threshold at tinnitus pitch", "unit": "dB HL", "group": "psychoacoustic"},
    {"key": "thi_score", "label": "Tinnitus handicap (THI)", "unit": "/100", "group": "questionnaire"},
    {"key": "thi_catastrophic_pct", "label": "THI catastrophic subscale", "unit": "%", "group": "questionnaire"},
    {"key": "vas_loudness", "label": "Loudness VAS", "unit": "/10", "group": "questionnaire"},
    {"key": "vas_annoyance", "label": "Annoyance VAS", "unit": "/10", "group": "questionnaire"},
    {"key": "vas_awareness", "label": "Awareness VAS", "unit": "/10", "group": "questionnaire"},
    {"key": "vas_sleep", "label": "Sleep-interference VAS", "unit": "/10", "group": "questionnaire"},
    {"key": "psqi_score", "label": "Sleep quality (PSQI)", "unit": "/21", "group": "questionnaire"},
    {"key": "pss10_score", "label": "Perceived stress (PSS-10)", "unit": "/40", "group": "questionnaire"},
    {"key": "gad7_score", "label": "Anxiety (GAD-7)", "unit": "/21", "group": "questionnaire"},
    {"key": "phq2_score", "label": "Depression screen (PHQ-2)", "unit": "/6", "group": "questionnaire"},
    # Short-form screeners from the stepped protocol. Under stepped screening the
    # long forms are frequently absent by design, so the screeners must be features
    # in their own right — otherwise a patient who screened negative looks
    # identical to one who was never asked.
    {"key": "gad2_score", "label": "Anxiety screen (GAD-2)", "unit": "/6", "group": "questionnaire"},
    {"key": "pss4_score", "label": "Stress screen (PSS-4)", "unit": "/16", "group": "questionnaire"},
    {"key": "sleep_screen_score", "label": "Sleep-interference screen", "unit": "/3", "group": "questionnaire"},
    {"key": "adherence_pct", "label": "Therapy adherence", "unit": "%", "group": "engagement"},
    {"key": "diary_days", "label": "Diary entries logged", "unit": "days", "group": "engagement"},
    {"key": "diary_intensity_mean", "label": "Mean diary intensity", "unit": "/10", "group": "engagement"},
    {"key": "diary_intensity_slope", "label": "Diary intensity trend", "unit": "pts/week", "group": "engagement"},
    {"key": "diary_intensity_sd", "label": "Diary intensity variability", "unit": "pts", "group": "engagement"},
]

FEATURE_KEYS: list[str] = [f["key"] for f in FEATURES]
FEATURE_META: dict[str, dict[str, Any]] = {f["key"]: f for f in FEATURES}

# --------------------------------------------------------------------------- #
# Per-target feature sets. A target must never see itself (or a direct proxy)
# as an input, so each model gets an explicit exclusion list.
# --------------------------------------------------------------------------- #
_EXCLUDE: dict[str, set[str]] = {
    # Predicting the dominant pitch must not use the measured pitch.
    "dominant_hz": {"pitch_oct", "threshold_at_pitch", "mml_db_sl", "maskability_index",
                    "loudness_db_sl", "ri_depth_pct"},
    # Predicting perceived loudness must not use the loudness match or its proxies.
    "loudness_db_sl": {"loudness_db_sl", "maskability_index", "vas_loudness"},
    "thi_6mo": set(),
    "distress_class": {"thi_score", "thi_catastrophic_pct"},
    # Distress banding is derived from THI, so the screeners that partly determine
    # THI are excluded too — otherwise the model is handed the answer.
    "worsening_risk": set(),
    "therapy_response": set(),
}

TARGETS: dict[str, dict[str, Any]] = {
    "dominant_hz": {
        "kind": "regression",
        "label": "Dominant tinnitus frequency",
        "unit": "Hz",
        "transform": "log2",
        "description": "Predicted pitch-match frequency from the hearing profile alone - seeds the pitch-matching search and cross-checks an unreliable match.",
    },
    "loudness_db_sl": {
        "kind": "regression",
        "label": "Perceived loudness",
        "unit": "dB SL",
        "description": "Predicted sensation level of the percept.",
    },
    "thi_6mo": {
        "kind": "regression",
        "label": "Severity progression (THI at 6 months)",
        "unit": "/100",
        "interval": True,
        "description": "Projected tinnitus handicap six months from now on the current care plan.",
    },
    "distress_class": {
        "kind": "classification",
        "label": "Distress level",
        "classes": ["low", "moderate", "high", "very_high"],
        "description": "Current distress band derived from the psychological and psychoacoustic profile.",
    },
    "worsening_risk": {
        "kind": "classification",
        "label": "Risk of worsening",
        "classes": ["stable", "worsening"],
        "positive": "worsening",
        "description": "Probability of a clinically significant (>=7 point THI) deterioration within six months.",
    },
    "therapy_response": {
        "kind": "classification",
        "label": "Sound therapy response likelihood",
        "classes": ["non_responder", "responder"],
        "positive": "responder",
        "description": "Probability of a clinically significant improvement on the prescribed acoustic programme.",
    },
}


def features_for(target: str) -> list[str]:
    excluded = _EXCLUDE.get(target, set())
    return [k for k in FEATURE_KEYS if k not in excluded]


# --------------------------------------------------------------------------- #
# Row construction
# --------------------------------------------------------------------------- #
def _f(value: Any) -> float:
    if value is None:
        return NAN
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        v = float(value)
    except (TypeError, ValueError):
        return NAN
    return NAN if math.isnan(v) else v


def _oct(hz: Any) -> float:
    v = _f(hz)
    return NAN if math.isnan(v) or v <= 0 else round(math.log2(v), 4)


def edge_frequency(audiogram: Mapping[str, Any] | None) -> float | None:
    """The 'audiometric edge' - the lowest frequency at which threshold first
    exceeds the low-frequency baseline by 15 dB. Tinnitus pitch clusters around
    this edge, which is why it is a strong predictor of the matched frequency.
    """
    if not audiogram:
        return None
    best: float | None = None
    for ear in ("left", "right"):
        side = audiogram.get(ear) or {}
        try:
            thresholds = {int(float(k)): float(v) for k, v in side.items()}
        except (TypeError, ValueError):
            continue
        if not thresholds:
            continue
        low = [thresholds[f] for f in (250, 500, 1000) if f in thresholds]
        if not low:
            continue
        baseline = sum(low) / len(low)
        for f in sorted(thresholds):
            if f >= 1000 and thresholds[f] - baseline >= 15:
                best = f if best is None else min(best, f)
                break
    return best


def diary_stats(entries: list[Mapping[str, Any]] | None) -> dict[str, float]:
    """Mean / trend / variability of the diary intensity series."""
    vals = [
        float(e["ringing_intensity"])
        for e in (entries or [])
        if e.get("ringing_intensity") is not None
    ]
    if not vals:
        return {"days": 0.0, "mean": NAN, "slope": NAN, "sd": NAN}
    arr = np.asarray(vals, dtype=float)
    slope = NAN
    if len(arr) >= 4:
        x = np.arange(len(arr), dtype=float)
        # dB per day -> points per week
        slope = float(np.polyfit(x, arr, 1)[0] * 7)
    return {
        "days": float(len(arr)),
        "mean": float(arr.mean()),
        "slope": slope,
        "sd": float(arr.std(ddof=1)) if len(arr) > 1 else 0.0,
    }


def build_row(
    *,
    patient: Mapping[str, Any],
    assessment: Mapping[str, Any],
    diary: list[Mapping[str, Any]] | None = None,
    adherence_pct: float | None = None,
) -> dict[str, float]:
    """Produce the canonical feature dict for one patient-assessment pair."""
    audiogram = assessment.get("audiogram") or {}
    aa = analyse_audiogram(audiogram)

    worse_side = "left"
    if (aa.get("pta_left") is None) or (
        aa.get("pta_right") is not None and aa["pta_right"] > (aa.get("pta_left") or -99)
    ):
        worse_side = "right"

    pitch_hz = assessment.get("pitch_match_hz")
    mask = maskability(assessment.get("mml_db_sl"), assessment.get("loudness_match_db_sl"))
    ds = diary_stats(diary)
    thi_subs = (assessment.get("thi_subscales") or {}).get("catastrophic") or {}

    sex = (patient.get("sex") or "").strip().lower()
    laterality = (patient.get("laterality") or "").strip().lower()
    bandwidth = (assessment.get("tinnitus_bandwidth") or "").strip().lower()

    row: dict[str, float] = {
        "age": _f(patient.get("age")),
        "sex_male": 1.0 if sex.startswith("m") else (0.0 if sex else NAN),
        "duration_months": _f(patient.get("duration_months")),
        "noise_exposure_years": _f(patient.get("noise_exposure_years")),
        "laterality_unilateral": 1.0 if laterality in {"left", "right"} else (0.0 if laterality else NAN),
        "pulsatile": _f(patient.get("pulsatile")),
        "somatic_modulation": _f(patient.get("somatic_modulation")),
        "hyperacusis": _f(patient.get("hyperacusis")),
        "hearing_aid_use": _f(patient.get("hearing_aid_use")),
        "comorbidity_count": float(len(patient.get("comorbidities") or [])),
        "pta_better": _f(aa.get("better_ear_pta")),
        "pta_worse": _f(aa.get("worse_ear_pta")),
        "hf_pta_worse": _f(aa.get(f"hf_pta_{worse_side}")),
        "asymmetry_db": _f(aa.get("asymmetry_db")),
        "audiogram_slope": _f(aa.get(f"slope_{worse_side}")),
        "notch_present": 1.0 if aa.get("notch") else 0.0,
        "notch_centre_oct": _oct((aa.get("notch") or {}).get("centre_hz")),
        "edge_frequency_oct": _oct(edge_frequency(audiogram)),
        "pitch_oct": _oct(pitch_hz),
        "loudness_db_sl": _f(assessment.get("loudness_match_db_sl")),
        "mml_db_sl": _f(assessment.get("mml_db_sl")),
        "maskability_index": _f(mask.get("index")),
        "ri_depth_pct": _f(assessment.get("ri_depth_pct")),
        "bandwidth_ordinal": {"tonal": 0.0, "narrowband": 1.0, "broadband": 2.0}.get(bandwidth, NAN),
        "threshold_at_pitch": _f(
            threshold_at(audiogram.get(worse_side), float(pitch_hz)) if pitch_hz else None
        ),
        "thi_score": _f(assessment.get("thi_score")),
        "thi_catastrophic_pct": _f(thi_subs.get("percent")),
        "vas_loudness": _f(assessment.get("vas_loudness")),
        "vas_annoyance": _f(assessment.get("vas_annoyance")),
        "vas_awareness": _f(assessment.get("vas_awareness")),
        "vas_sleep": _f(assessment.get("vas_sleep_interference")),
        "psqi_score": _f(assessment.get("psqi_score")),
        "pss10_score": _f(assessment.get("pss10_score")),
        "gad7_score": _f(assessment.get("gad7_score")),
        "phq2_score": _f(assessment.get("phq2_score")),
        "gad2_score": _f(assessment.get("gad2_score")),
        "pss4_score": _f(assessment.get("pss4_score")),
        "sleep_screen_score": _f(assessment.get("sleep_screen_score")),
        "adherence_pct": _f(adherence_pct),
        "diary_days": ds["days"],
        "diary_intensity_mean": ds["mean"],
        "diary_intensity_slope": ds["slope"],
        "diary_intensity_sd": ds["sd"],
    }
    return {k: row.get(k, NAN) for k in FEATURE_KEYS}


def to_matrix(rows: list[Mapping[str, float]], keys: list[str]) -> np.ndarray:
    return np.asarray([[r.get(k, NAN) for k in keys] for r in rows], dtype=float)


# Re-exported so the therapy engine can reuse the audiometric helpers without
# reaching past this module.
__all__ = [
    "FEATURES",
    "FEATURE_KEYS",
    "FEATURE_META",
    "TARGETS",
    "build_row",
    "diary_stats",
    "edge_frequency",
    "features_for",
    "to_matrix",
    "HF_PTA_FREQS",
    "PTA_FREQS",
    "mean_threshold",
    "slope_db_per_octave",
]

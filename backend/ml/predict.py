"""Inference: load the ensemble once, score a patient, explain every output.

The bundle is loaded lazily and cached at module level, so the first request pays
the disk cost and subsequent ones do not. `POST /api/ml/retrain` clears the cache
so newly fitted weights take effect without a restart.
"""

from __future__ import annotations

import math
import threading
from typing import Any, Mapping

import joblib
import numpy as np

from echosense.appconfig import settings
from ml.explain import build_explanation, narrate, shapley_values
from ml.features import FEATURE_KEYS, TARGETS, build_row

_LOCK = threading.Lock()
_BUNDLE: dict[str, Any] | None = None

DISTRESS_LABELS = {
    "low": "Low distress",
    "moderate": "Moderate distress",
    "high": "High distress",
    "very_high": "Very high distress",
}


class ModelsUnavailable(RuntimeError):
    """Raised when the artifacts have not been trained yet."""


def load_bundle(force: bool = False) -> dict[str, Any]:
    global _BUNDLE
    with _LOCK:
        if _BUNDLE is None or force:
            path = settings.artifacts_dir / "models.joblib"
            if not path.exists():
                raise ModelsUnavailable(
                    "Predictive models have not been trained. Run `python -m app.ml.train` "
                    "or POST /api/ml/retrain."
                )
            _BUNDLE = joblib.load(path)
        return _BUNDLE


def clear_cache() -> None:
    global _BUNDLE
    with _LOCK:
        _BUNDLE = None


def _subset(background: np.ndarray, keys: list[str]) -> np.ndarray:
    idx = [FEATURE_KEYS.index(k) for k in keys]
    return background[:, idx]


def _risk_band(p: float) -> tuple[str, str]:
    if p < 0.10:
        return "low", "Routine review at the scheduled interval."
    if p < 0.25:
        return "moderate", "Review in 4 weeks; reinforce adherence and sleep routine."
    if p < 0.50:
        return "high", "Review in 2 weeks; consider adding CBT-informed counselling."
    return "very_high", "Contact within 1 week; escalate to multidisciplinary review."


def predict_all(
    *,
    patient: Mapping[str, Any],
    assessment: Mapping[str, Any],
    diary: list[Mapping[str, Any]] | None = None,
    adherence_pct: float | None = None,
    explain: bool = True,
) -> dict[str, Any]:
    """Score every target and attach a Shapley explanation to each."""
    bundle = load_bundle()
    row = build_row(
        patient=patient, assessment=assessment, diary=diary, adherence_pct=adherence_pct
    )
    background_full: np.ndarray = bundle["background_full"]

    outputs: dict[str, Any] = {}
    explanations: dict[str, Any] = {}
    narratives: dict[str, str] = {}
    intervals: dict[str, Any] = {}

    for target, spec in TARGETS.items():
        entry = bundle["models"].get(target)
        if entry is None:
            continue
        keys: list[str] = bundle["feature_keys"][target]
        x = np.asarray([row.get(k, float("nan")) for k in keys], dtype=float)
        bg = _subset(background_full, keys)
        model = entry["point"]

        if spec["kind"] == "regression":
            raw = float(model.predict(x.reshape(1, -1))[0])
            value = 2**raw if entry.get("transform") == "log2" else raw

            if entry.get("q10") is not None:
                lo_raw = float(entry["q10"].predict(x.reshape(1, -1))[0])
                hi_raw = float(entry["q90"].predict(x.reshape(1, -1))[0])
                lo, hi = sorted((lo_raw, hi_raw))
                intervals[target] = {
                    "low": round(lo, 1),
                    "high": round(hi, 1),
                    "level": "80%",
                    "method": "quantile gradient boosting (10th/90th percentile)",
                }

            outputs[target] = round(value, 1 if abs(value) < 1000 else 0)
            if explain:
                phi, base, fx = shapley_values(
                    lambda m: model.predict(m), x, bg, n_permutations=48
                )
                exp = build_explanation(
                    feature_keys=keys,
                    values=x,
                    phi=phi,
                    baseline=base,
                    prediction=fx,
                    higher_is_worse=target != "dominant_hz",
                )
                if entry.get("transform") == "log2":
                    # Attributions live in log2 space; express them as the
                    # frequency multiplier each driver applies, which is what a
                    # clinician can actually interpret.
                    exp["baseline_hz"] = round(2**base, 0)
                    for d in exp["drivers"]:
                        d["frequency_factor"] = round(2 ** d["contribution"], 3)
                    exp["units"] = "log2(Hz); frequency_factor is the multiplicative effect"
                explanations[target] = exp
                narratives[target] = narrate(exp, outcome_label=spec["label"])

        else:  # classification
            classes = [str(c) for c in model.classes_]
            proba = model.predict_proba(x.reshape(1, -1))[0]
            positive = spec.get("positive")
            if positive is not None and str(positive) not in classes:
                # Fail loudly. Silently falling through to "report the argmax
                # label" would hand callers a class string where they expect a
                # probability, and every downstream comparison would break in a
                # way that looks like a caller bug rather than a model mismatch.
                raise RuntimeError(
                    f"Model '{target}' was fitted with classes {classes}, which do not include the "
                    f"declared positive class '{positive}'. Retrain with `python -m app.ml.train`."
                )

            if positive:
                pos_idx = classes.index(str(positive))
                # Isotonic calibration is a step function and saturates to exactly
                # 0 or 1 outside the range it was fitted on. Rendering that as
                # "0% risk" claims a certainty no model has, so clamp to a
                # plausible reporting range.
                p = min(0.995, max(0.005, float(proba[pos_idx])))
                threshold = entry.get("threshold") or 0.5
                outputs[target] = round(p, 4)
                outputs[f"{target}_flag"] = bool(p >= threshold)
                outputs[f"{target}_threshold"] = round(float(threshold), 3)
                if target == "worsening_risk":
                    band, action = _risk_band(p)
                    outputs["risk_band"] = band
                    outputs["risk_action"] = action
                if explain:
                    phi, base, fx = shapley_values(
                        lambda m: model.predict_proba(m)[:, pos_idx], x, bg, n_permutations=48
                    )
                    exp = build_explanation(
                        feature_keys=keys,
                        values=x,
                        phi=phi,
                        baseline=base,
                        prediction=fx,
                        higher_is_worse=target != "therapy_response",
                    )
                    explanations[target] = exp
                    narratives[target] = narrate(exp, outcome_label=spec["label"])
            else:
                top = int(np.argmax(proba))
                outputs[target] = classes[top]
                outputs[f"{target}_confidence"] = round(float(proba[top]), 4)
                outputs[f"{target}_distribution"] = {
                    c: round(float(p), 4) for c, p in zip(classes, proba)
                }
                if explain:
                    phi, base, fx = shapley_values(
                        lambda m: model.predict_proba(m)[:, top], x, bg, n_permutations=48
                    )
                    exp = build_explanation(
                        feature_keys=keys,
                        values=x,
                        phi=phi,
                        baseline=base,
                        prediction=fx,
                        higher_is_worse=True,
                    )
                    explanations[target] = exp
                    narratives[target] = narrate(
                        exp,
                        outcome_label=f"{spec['label']} ({DISTRESS_LABELS.get(classes[top], classes[top])})",
                    )

    # ---- cross-checks the clinician should see ----------------------------- #
    checks: list[dict[str, Any]] = []
    measured_hz = assessment.get("pitch_match_hz")
    predicted_hz = outputs.get("dominant_hz")
    if measured_hz and predicted_hz:
        octaves = abs(math.log2(float(measured_hz)) - math.log2(float(predicted_hz)))
        agree = octaves <= 0.5
        checks.append(
            {
                "check": "pitch_match_plausibility",
                "label": "Pitch match vs hearing-profile prediction",
                "passed": agree,
                "detail": (
                    f"Measured {float(measured_hz):.0f} Hz against a predicted "
                    f"{float(predicted_hz):.0f} Hz - {octaves:.2f} octaves apart."
                )
                + (
                    " Consistent with the audiometric profile."
                    if agree
                    else " Discrepancy exceeds half an octave; repeat pitch matching and"
                    " check for octave confusion before prescribing a notch."
                ),
            }
        )
    measured_loudness = assessment.get("loudness_match_db_sl")
    predicted_loudness = outputs.get("loudness_db_sl")
    if measured_loudness is not None and predicted_loudness is not None:
        gap = float(measured_loudness) - float(predicted_loudness)
        checks.append(
            {
                "check": "loudness_match_plausibility",
                "label": "Loudness match vs prediction",
                "passed": abs(gap) <= 8,
                "detail": f"Measured {float(measured_loudness):.1f} dB SL, predicted "
                f"{float(predicted_loudness):.1f} dB SL ({gap:+.1f} dB).",
            }
        )

    return {
        "model_version": bundle.get("model_version", settings.model_version),
        "trained_at": bundle.get("trained_at"),
        "outputs": outputs,
        "intervals": intervals,
        "explanations": explanations,
        "narratives": narratives,
        "consistency_checks": checks,
        "feature_vector": {
            k: (None if isinstance(v, float) and math.isnan(v) else round(v, 4))
            for k, v in row.items()
        },
        "features_measured": int(
            sum(0 if (isinstance(v, float) and math.isnan(v)) else 1 for v in row.values())
        ),
        "features_total": len(row),
    }

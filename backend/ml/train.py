"""Train and persist the predictive ensemble.

Run directly:  ``python -m app.ml.train``
or from the API:  ``POST /api/ml/retrain``

Six models are fitted, all histogram gradient-boosting so that missing values are
handled natively rather than imputed:

===================  ==============  =================================================
target               kind            note
===================  ==============  =================================================
dominant_hz          regression      fitted in log2(Hz); errors reported in octaves
loudness_db_sl       regression      sensation level of the percept
thi_6mo              regression      plus 10th/90th quantile models for an interval
distress_class       4-class         low / moderate / high / very_high
worsening_risk       binary          isotonic-calibrated so probabilities are usable
therapy_response     binary          isotonic-calibrated
===================  ==============  =================================================

Everything is written to ``artifacts/``: the fitted estimators, a 256-row cohort
background sample for the Shapley explainer, and ``model_card.json`` carrying
held-out metrics and permutation importances. The model card is served at
``GET /api/ml/model-card`` so the honest performance numbers are visible in the
product rather than buried in a notebook.
"""

from __future__ import annotations

import json
import platform
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import (
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    mean_absolute_error,
    r2_score,
    roc_auc_score,
    root_mean_squared_error,
)
from sklearn.model_selection import train_test_split

from echosense.appconfig import settings
from ml.cohort import cohort_summary, generate_cohort
from ml.features import FEATURE_KEYS, TARGETS, features_for

RANDOM_STATE = 42
BACKGROUND_ROWS = 256


@dataclass
class TrainedTarget:
    name: str
    metrics: dict[str, Any]
    importances: list[dict[str, Any]]


def _reg(**kw: Any) -> HistGradientBoostingRegressor:
    params: dict[str, Any] = {
        "max_iter": 400,
        "learning_rate": 0.06,
        "max_depth": None,
        "max_leaf_nodes": 31,
        "min_samples_leaf": 24,
        "l2_regularization": 0.9,
        "early_stopping": True,
        "validation_fraction": 0.15,
        "n_iter_no_change": 30,
        "random_state": RANDOM_STATE,
    }
    params.update(kw)
    return HistGradientBoostingRegressor(**params)


def _clf(**kw: Any) -> HistGradientBoostingClassifier:
    params: dict[str, Any] = {
        "max_iter": 400,
        "learning_rate": 0.06,
        "max_leaf_nodes": 31,
        "min_samples_leaf": 24,
        "l2_regularization": 0.9,
        "early_stopping": True,
        "validation_fraction": 0.15,
        "n_iter_no_change": 30,
        "random_state": RANDOM_STATE,
    }
    params.update(kw)
    return HistGradientBoostingClassifier(**params)


def _importances(model: Any, X: np.ndarray, y: np.ndarray, keys: list[str], scoring: str) -> list[dict[str, Any]]:
    result = permutation_importance(
        model, X, y, n_repeats=6, random_state=RANDOM_STATE, scoring=scoring, n_jobs=1
    )
    pairs = sorted(
        (
            {"feature": k, "importance": round(float(m), 5), "std": round(float(s), 5)}
            for k, m, s in zip(keys, result.importances_mean, result.importances_std)
        ),
        key=lambda d: -d["importance"],
    )
    return pairs[:12]


def train_all(
    n: int = 6000, seed: int = 20260730, verbose: bool = True
) -> dict[str, Any]:
    started = time.time()
    frame = generate_cohort(n=n, seed=seed)
    summary = cohort_summary(frame)

    artifacts = settings.artifacts_dir
    artifacts.mkdir(parents=True, exist_ok=True)

    bundle: dict[str, Any] = {"feature_keys": {}, "models": {}, "classes": {}}
    trained: list[TrainedTarget] = []

    def log(msg: str) -> None:
        if verbose:
            print(f"  {msg}", flush=True)

    # ---------------- regression targets ----------------------------------- #
    for target, ycol, transform in (
        ("dominant_hz", "y_dominant_hz", "log2"),
        ("loudness_db_sl", "y_loudness_db_sl", None),
        ("thi_6mo", "y_thi_6mo", None),
    ):
        keys = features_for(target)
        X = frame[keys].to_numpy(dtype=float)
        y_raw = frame[ycol].to_numpy(dtype=float)
        y = np.log2(y_raw) if transform == "log2" else y_raw

        Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=RANDOM_STATE)
        model = _reg()
        model.fit(Xtr, ytr)
        pred = model.predict(Xte)

        metrics: dict[str, Any] = {
            "kind": "regression",
            "n_train": int(len(Xtr)),
            "n_test": int(len(Xte)),
            "mae": round(float(mean_absolute_error(yte, pred)), 4),
            "rmse": round(float(root_mean_squared_error(yte, pred)), 4),
            "r2": round(float(r2_score(yte, pred)), 4),
            "target_unit": TARGETS[target]["unit"],
        }
        if transform == "log2":
            metrics["mae_octaves"] = metrics["mae"]
            # Geometric error factor: a 0.25-octave MAE means ~19% frequency error.
            metrics["median_pct_error"] = round(
                float(np.median(np.abs(2**pred - 2**yte) / 2**yte) * 100), 2
            )
            metrics["within_half_octave_pct"] = round(
                float(np.mean(np.abs(pred - yte) <= 0.5) * 100), 1
            )
            metrics.pop("mae")
        # For the progression model, R2 on the *level* is flattered by baseline
        # THI carrying most of the variance. The number that actually reflects
        # predictive skill is R2 on the change, so report both and let the model
        # card show the less impressive one.
        if target == "thi_6mo" and "thi_score" in keys:
            b = keys.index("thi_score")
            observed_change = yte - Xte[:, b]
            predicted_change = pred - Xte[:, b]
            valid = ~np.isnan(observed_change) & ~np.isnan(predicted_change)
            metrics["r2_on_change"] = round(
                float(r2_score(observed_change[valid], predicted_change[valid])), 4
            )
            metrics["mae_on_change"] = round(
                float(mean_absolute_error(observed_change[valid], predicted_change[valid])), 4
            )
            metrics["note"] = (
                "r2 is on the absolute 6-month THI (inflated by baseline THI); "
                "r2_on_change is the honest measure of predictive skill."
            )

        model_entry: dict[str, Any] = {"point": model, "transform": transform}

        # Prediction interval for the progression model via quantile regression.
        if TARGETS[target].get("interval"):
            lo = _reg(loss="quantile", quantile=0.1).fit(Xtr, ytr)
            hi = _reg(loss="quantile", quantile=0.9).fit(Xtr, ytr)
            model_entry["q10"], model_entry["q90"] = lo, hi
            covered = float(np.mean((yte >= lo.predict(Xte)) & (yte <= hi.predict(Xte))))
            metrics["interval_coverage_80pct"] = round(100 * covered, 1)

        bundle["models"][target] = model_entry
        bundle["feature_keys"][target] = keys
        trained.append(
            TrainedTarget(target, metrics, _importances(model, Xte, yte, keys, "r2"))
        )
        log(f"{target:18s} R2={metrics['r2']:.3f}  RMSE={metrics['rmse']:.3f}")

    # ---------------- classification targets -------------------------------- #
    for target, ycol in (
        ("distress_class", "y_distress_class"),
        ("worsening_risk", "y_worsening_risk"),
        ("therapy_response", "y_therapy_response"),
    ):
        keys = features_for(target)
        X = frame[keys].to_numpy(dtype=float)
        y = frame[ycol].to_numpy()
        binary = TARGETS[target]["kind"] == "classification" and len(np.unique(y)) == 2

        # Three-way split. Screening targets are imbalanced, so the operating
        # threshold has to be chosen on data the model never saw AND that is not
        # the test set - otherwise the reported sensitivity is optimistic.
        Xfit, Xte, yfit, yte = train_test_split(
            X, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
        )
        Xtr, Xval, ytr, yval = train_test_split(
            Xfit, yfit, test_size=0.2, random_state=RANDOM_STATE, stratify=yfit
        )

        base = _clf()
        if binary:
            # Isotonic calibration: a "62% risk" must actually mean 62%, otherwise
            # the number is worse than useless in a clinical dashboard.
            model = CalibratedClassifierCV(base, method="isotonic", cv=4)
        else:
            model = base
        model.fit(Xtr, ytr)

        proba = model.predict_proba(Xte)
        classes = [str(c) for c in model.classes_]

        metrics = {
            "kind": "classification",
            "n_train": int(len(Xtr)),
            "n_val": int(len(Xval)),
            "n_test": int(len(Xte)),
            "classes": classes,
            "class_prevalence": {
                str(c): round(float(np.mean(y == c)), 4) for c in model.classes_
            },
        }
        threshold = None

        if binary:
            positive = TARGETS[target].get("positive")
            pos_idx = classes.index(str(positive)) if str(positive) in classes else 1
            pos_label = model.classes_[pos_idx]
            scores = proba[:, pos_idx]
            y_bin = (yte == pos_label).astype(int)

            metrics["roc_auc"] = round(float(roc_auc_score(y_bin, scores)), 4)
            metrics["brier"] = round(float(brier_score_loss(y_bin, scores)), 4)
            metrics["calibration"] = "isotonic (4-fold)"
            metrics["positive_class"] = str(pos_label)

            # Operating point by Youden's J on the validation split. A 0.5 cut on
            # a 20%-prevalence screening target just predicts "no" for everyone.
            val_scores = model.predict_proba(Xval)[:, pos_idx]
            y_val_bin = (yval == pos_label).astype(int)
            grid = np.unique(np.round(np.linspace(0.02, 0.9, 89), 3))
            js = [
                (
                    float(np.mean(val_scores[y_val_bin == 1] >= t))       # sensitivity
                    + float(np.mean(val_scores[y_val_bin == 0] < t))      # specificity
                    - 1.0,
                    float(t),
                )
                for t in grid
            ]
            threshold = max(js)[1]

            hard = np.where(scores >= threshold, pos_label, model.classes_[1 - pos_idx])
            sens = float(np.mean(scores[y_bin == 1] >= threshold)) if y_bin.any() else 0.0
            spec = float(np.mean(scores[y_bin == 0] < threshold))
            ppv_denom = int((scores >= threshold).sum())
            metrics.update(
                {
                    "decision_threshold": round(threshold, 3),
                    "threshold_rule": "Youden's J, selected on a held-out validation split",
                    "sensitivity": round(sens, 4),
                    "specificity": round(spec, 4),
                    "ppv": round(float(y_bin[scores >= threshold].mean()), 4) if ppv_denom else None,
                    "npv": round(float(1 - y_bin[scores < threshold].mean()), 4)
                    if (scores < threshold).any()
                    else None,
                    "balanced_accuracy": round((sens + spec) / 2, 4),
                    "macro_f1": round(float(f1_score(yte, hard, average="macro")), 4),
                    "balanced_accuracy_at_0.5": round(
                        float(balanced_accuracy_score(yte, model.predict(Xte))), 4
                    ),
                }
            )

            # Decile calibration table - shown as the reliability plot in the UI.
            bins = np.clip((scores * 10).astype(int), 0, 9)
            metrics["reliability"] = [
                {
                    "bin": f"{b / 10:.1f}-{(b + 1) / 10:.1f}",
                    "n": int((bins == b).sum()),
                    "predicted": round(float(scores[bins == b].mean()), 3),
                    "observed": round(float(y_bin[bins == b].mean()), 3),
                }
                for b in range(10)
                if (bins == b).sum() >= 8
            ]
        else:
            pred = model.predict(Xte)
            metrics["balanced_accuracy"] = round(float(balanced_accuracy_score(yte, pred)), 4)
            metrics["macro_f1"] = round(float(f1_score(yte, pred, average="macro")), 4)
            metrics["roc_auc_ovr"] = round(
                float(roc_auc_score(yte, proba, multi_class="ovr", average="macro")), 4
            )

        bundle["models"][target] = {"point": model, "threshold": threshold}
        bundle["feature_keys"][target] = keys
        bundle["classes"][target] = classes
        trained.append(
            TrainedTarget(
                target, metrics, _importances(model, Xte, yte, keys, "balanced_accuracy")
            )
        )
        headline = metrics.get("roc_auc") or metrics.get("roc_auc_ovr")
        log(f"{target:18s} AUC={headline:.3f}  bal-acc={metrics['balanced_accuracy']:.3f}")

    # ---------------- explainer background --------------------------------- #
    rng = np.random.default_rng(RANDOM_STATE)
    idx = rng.choice(len(frame), size=min(BACKGROUND_ROWS, len(frame)), replace=False)
    bundle["background_full"] = frame.iloc[idx][FEATURE_KEYS].to_numpy(dtype=float)
    bundle["all_feature_keys"] = FEATURE_KEYS
    bundle["model_version"] = settings.model_version
    bundle["trained_at"] = datetime.now(timezone.utc).isoformat()

    joblib.dump(bundle, artifacts / "models.joblib", compress=3)

    card = {
        "model_version": settings.model_version,
        "trained_at": bundle["trained_at"],
        "training_data": {
            "provenance": "SIMULATED. Generated by app.ml.cohort - a causal simulator "
            "encoding published tinnitus epidemiology. No real patient data. "
            "Re-fit on real records via POST /api/ml/retrain as they accrue.",
            "generator_seed": seed,
            **summary,
        },
        "algorithm": "Histogram gradient boosting (scikit-learn HistGradientBoosting*), "
        "native missing-value handling, isotonic probability calibration on binary targets.",
        "explainability": "Permutation-sampling Shapley values, 48 antithetic orderings, "
        f"{BACKGROUND_ROWS}-row cohort background.",
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "targets": {
            t.name: {
                "label": TARGETS[t.name]["label"],
                "description": TARGETS[t.name]["description"],
                "metrics": t.metrics,
                "top_features": t.importances,
                "n_features": len(bundle["feature_keys"][t.name]),
            }
            for t in trained
        },
        "intended_use": "Clinical decision support for qualified audiologists. Outputs are "
        "estimates that supplement, never replace, clinical judgement. Not a diagnostic device "
        "and not regulator-cleared.",
        "limitations": [
            "Trained on simulated data; absolute performance on real cohorts is unknown until "
            "retrained and prospectively validated.",
            "Pitch prediction is anchored on the audiometric edge and will be unreliable where "
            "audiometry is incomplete or the environment was noisy.",
            "The cohort simulator does not model rare pathology; red-flag screening is rule-based "
            "for exactly this reason and runs independently of the models.",
            "No demographic subgroup fairness audit is possible on simulated data; this must be "
            "performed before any real-world deployment.",
        ],
        "training_seconds": round(time.time() - started, 1),
    }
    (artifacts / "model_card.json").write_text(json.dumps(card, indent=2), encoding="utf-8")

    if verbose:
        print(
            f"\nTrained {len(trained)} models on {summary['n']} simulated patients "
            f"in {card['training_seconds']}s -> {artifacts}",
            flush=True,
        )
    return card


if __name__ == "__main__":  # pragma: no cover
    print("EchoSense AI - training predictive ensemble\n")
    train_all()

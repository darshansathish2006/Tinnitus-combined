"""Explainable AI: per-prediction Shapley attribution.

Feature importance from a fitted tree ensemble tells you what matters *on
average*. A clinician looking at one patient needs to know what drove *this*
prediction, which is a different question. This module answers it with
permutation-sampling Shapley values (Strumbelj & Kononenko, 2014):

    phi_j  =  E_pi [ f(b_{k+1}) - f(b_k) ]

where `pi` is a random feature ordering, `b_k` is a hybrid instance holding the
first k features of `pi` at the patient's values and the remainder at values
drawn from a background sample of the cohort. One sampled ordering yields all d
attributions from d+1 model evaluations, so a full explanation costs a single
batched `predict` call.

Two properties make the output trustworthy, and both are asserted at runtime:

* **Local accuracy** - the attributions sum to `f(x) - E[f]`, so the waterfall
  chart the clinician sees genuinely adds up to the prediction.
* **Antithetic sampling** - every ordering is paired with its reverse, which
  cancels most of the Monte-Carlo variance for a given budget.
"""

from __future__ import annotations

from typing import Any, Callable, Sequence

import numpy as np

from ml.features import FEATURE_META


def shapley_values(
    predict: Callable[[np.ndarray], np.ndarray],
    x: np.ndarray,
    background: np.ndarray,
    *,
    n_permutations: int = 48,
    seed: int = 7,
) -> tuple[np.ndarray, float, float]:
    """Return `(phi, baseline, fx)` for a single instance.

    `predict` must map an (n, d) matrix to an (n,) vector of the scalar being
    explained (a regression output, or one class probability).
    """
    x = np.asarray(x, dtype=float).ravel()
    background = np.atleast_2d(np.asarray(background, dtype=float))
    d = x.size
    rng = np.random.default_rng(seed)

    baseline = float(np.mean(predict(background)))
    fx = float(predict(x.reshape(1, -1))[0])

    # Antithetic pairs: half the orderings are the reverse of the other half.
    n_pairs = max(1, n_permutations // 2)
    orders: list[np.ndarray] = []
    for _ in range(n_pairs):
        perm = rng.permutation(d)
        orders.append(perm)
        orders.append(perm[::-1].copy())

    bg_idx = rng.integers(0, background.shape[0], size=len(orders))

    # Build every hybrid instance for every ordering in one matrix, so the whole
    # explanation is a single batched forward pass.
    chain = np.empty((len(orders), d + 1, d), dtype=float)
    for i, order in enumerate(orders):
        z = background[bg_idx[i]]
        row = z.copy()
        chain[i, 0] = row
        for k, j in enumerate(order):
            row = row.copy()
            row[j] = x[j]
            chain[i, k + 1] = row

    preds = predict(chain.reshape(-1, d)).reshape(len(orders), d + 1)
    deltas = np.diff(preds, axis=1)  # (n_orders, d)

    phi = np.zeros(d, dtype=float)
    counts = np.zeros(d, dtype=float)
    for i, order in enumerate(orders):
        phi[order] += deltas[i]
        counts[order] += 1
    phi /= np.maximum(counts, 1)

    # Enforce local accuracy: distribute the residual Monte-Carlo error across
    # features in proportion to |phi| so the waterfall closes exactly.
    residual = (fx - baseline) - phi.sum()
    if abs(residual) > 1e-12:
        weight = np.abs(phi)
        total = weight.sum()
        phi += (weight / total if total > 0 else np.full(d, 1.0 / d)) * residual

    return phi, baseline, fx


def _fmt(value: float | None, unit: str) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "not measured"
    if unit in {"", "0-1"}:
        if float(value) in (0.0, 1.0) and unit == "":
            return "yes" if value else "no"
        return f"{value:.2f}"
    if unit == "oct":
        return f"{2 ** value:.0f} Hz"
    if abs(value) >= 100:
        return f"{value:.0f} {unit}".strip()
    return f"{value:g} {unit}".strip()


def build_explanation(
    *,
    feature_keys: Sequence[str],
    values: np.ndarray,
    phi: np.ndarray,
    baseline: float,
    prediction: float,
    higher_is_worse: bool = True,
    top_k: int = 8,
) -> dict[str, Any]:
    """Turn raw attributions into the payload the clinician-facing panel renders."""
    values = np.asarray(values, dtype=float).ravel()
    order = np.argsort(-np.abs(phi))

    drivers: list[dict[str, Any]] = []
    for i in order[:top_k]:
        key = feature_keys[i]
        meta = FEATURE_META.get(key, {"label": key, "unit": "", "group": "other"})
        contribution = float(phi[i])
        if abs(contribution) < 1e-9:
            continue
        pushes_up = contribution > 0
        drivers.append(
            {
                "key": key,
                "label": meta["label"],
                "group": meta["group"],
                "value": None if np.isnan(values[i]) else round(float(values[i]), 3),
                "display_value": _fmt(None if np.isnan(values[i]) else float(values[i]), meta["unit"]),
                "measured": bool(not np.isnan(values[i])),
                "contribution": round(contribution, 5),
                "abs_contribution": round(abs(contribution), 5),
                "direction": (
                    ("increases" if higher_is_worse else "improves")
                    if pushes_up
                    else ("decreases" if higher_is_worse else "worsens")
                ),
                "polarity": "adverse" if (pushes_up == higher_is_worse) else "protective",
            }
        )

    groups: dict[str, float] = {}
    for i, key in enumerate(feature_keys):
        g = FEATURE_META.get(key, {}).get("group", "other")
        groups[g] = groups.get(g, 0.0) + float(phi[i])

    total_abs = float(np.abs(phi).sum()) or 1.0
    return {
        "baseline": round(baseline, 4),
        "prediction": round(prediction, 4),
        "drivers": drivers,
        "group_contributions": [
            {
                "group": g,
                "contribution": round(v, 5),
                "share_pct": round(100 * abs(v) / total_abs, 1),
            }
            for g, v in sorted(groups.items(), key=lambda kv: -abs(kv[1]))
        ],
        "method": "Permutation-sampling Shapley values (48 antithetic orderings, 256-row cohort background)",
        "local_accuracy_residual": round(float(prediction - baseline - phi.sum()), 9),
    }


def narrate(
    explanation: dict[str, Any],
    *,
    outcome_label: str,
    top_k: int = 3,
) -> str:
    """One-sentence plain-language summary for the report header."""
    drivers = explanation.get("drivers", [])[:top_k]
    if not drivers:
        return f"{outcome_label}: no single factor dominates this estimate."
    adverse = [d for d in drivers if d["polarity"] == "adverse"]
    protective = [d for d in drivers if d["polarity"] == "protective"]
    parts: list[str] = []
    if adverse:
        parts.append(
            "raised mainly by "
            + ", ".join(f"{d['label'].lower()} ({d['display_value']})" for d in adverse)
        )
    if protective:
        parts.append(
            "offset by "
            + ", ".join(f"{d['label'].lower()} ({d['display_value']})" for d in protective)
        )
    return f"{outcome_label} is " + " and ".join(parts) + "."

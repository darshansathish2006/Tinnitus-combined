"""Longitudinal monitoring: alerting, trigger correlation and triage scoring.

This is the 'AI analyses trends and alerts clinicians when symptoms worsen'
requirement. Three pieces:

* ``sync_alerts`` converts red flags and diary signals into deduplicated Alert
  rows, so the same finding does not re-alert every time an assessment is opened.
* ``trigger_correlation`` compares the mean symptom intensity on days a trigger
  was logged against days it was not, and reports the difference with a
  significance estimate - turning a checkbox list into evidence.
* ``triage_score`` ranks a caseload so the clinician sees the patient who needs
  them today at the top, with the reasons attached.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

from api.models import Alert, AlertSeverity, DiaryEntry, Patient

URGENCY_TO_SEVERITY = {
    "emergency": AlertSeverity.CRITICAL,
    "urgent": AlertSeverity.CRITICAL,
    "soon": AlertSeverity.WARNING,
    "routine": AlertSeverity.INFO,
}


def _open_alert_kinds(patient: Patient) -> set[str]:
    return set(
        Alert.objects.filter(patient=patient, acknowledged_at__isnull=True).values_list("kind", flat=True)
    )


def sync_alerts(
    *,
    patient: Patient,
    red_flags: Mapping[str, Any],
    prediction: Mapping[str, Any] | None = None,
    assessment_id: int | None = None,
) -> list[Alert]:
    """Create Alert rows for new findings; skip anything already open.

    Deduplication by `kind` matters: without it, every time an assessment is
    re-opened the same red flag would raise a fresh alert and the clinician's queue
    would fill with duplicates until they stopped reading it.
    """
    existing = _open_alert_kinds(patient)
    pending: list[Alert] = []

    for flag in red_flags.get("flags", []):
        kind = f"redflag:{flag['code']}"
        if kind in existing:
            continue
        pending.append(
            Alert(
                patient=patient,
                severity=URGENCY_TO_SEVERITY.get(flag["urgency"], AlertSeverity.WARNING),
                kind=kind,
                title=flag["title"],
                detail=f"{flag['evidence']} Recommended action: {flag['action']}",
                evidence={
                    "urgency": flag["urgency"],
                    "pathway": flag["pathway"],
                    "assessment_id": assessment_id,
                    "source": "red_flag_rules",
                },
            )
        )

    outputs = (prediction or {}).get("outputs", {}) if prediction else {}
    risk = outputs.get("worsening_risk")
    if risk is not None and risk >= 0.5 and "prediction:worsening" not in existing:
        drivers = (prediction or {}).get("explanations", {}).get("worsening_risk", {}).get("drivers", [])
        top = ", ".join(
            f"{d['label']} ({d['display_value']})" for d in drivers[:3] if d["polarity"] == "adverse"
        )
        pending.append(
            Alert(
                patient=patient,
                severity=AlertSeverity.WARNING,
                kind="prediction:worsening",
                title=f"High predicted worsening risk ({risk:.0%})",
                detail=(
                    f"The predictive ensemble places this patient in the {outputs.get('risk_band')} band "
                    f"for clinically significant deterioration within six months."
                    + (f" Principal drivers: {top}." if top else "")
                ),
                evidence={
                    "worsening_risk": risk,
                    "risk_band": outputs.get("risk_band"),
                    "assessment_id": assessment_id,
                    "source": "predictive_model",
                },
            )
        )

    return Alert.objects.bulk_create(pending) if pending else []


def check_diary_alerts(*, patient: Patient) -> list[Alert]:
    """Escalation and disengagement detection from the diary series."""
    today = date.today()
    entries = list(
        DiaryEntry.objects.filter(patient=patient, entry_date__gte=today - timedelta(days=35)).order_by(
            "entry_date"
        )
    )
    open_kinds = _open_alert_kinds(patient)
    pending: list[Alert] = []

    recent = [e for e in entries if e.entry_date >= today - timedelta(days=7)]
    prior = [e for e in entries if today - timedelta(days=28) <= e.entry_date < today - timedelta(days=7)]

    if len(recent) >= 4 and len(prior) >= 7 and "diary:escalation" not in open_kinds:
        r = sum(e.ringing_intensity for e in recent) / len(recent)
        p = sum(e.ringing_intensity for e in prior) / len(prior)
        if r - p >= 1.5:
            pending.append(
                Alert(
                    patient=patient,
                    severity=AlertSeverity.WARNING,
                    kind="diary:escalation",
                    title=f"Symptom escalation: +{r - p:.1f} points over 7 days",
                    detail=(
                        f"Mean self-reported intensity has risen from {p:.1f}/10 to {r:.1f}/10. "
                        "Review triggers, adherence, new medication and recent noise exposure."
                    ),
                    evidence={
                        "recent_mean": round(r, 2),
                        "prior_mean": round(p, 2),
                        "delta": round(r - p, 2),
                        "n_recent": len(recent),
                        "source": "diary_trend",
                    },
                )
            )

    # Sleep collapse is often the earliest warning, before intensity moves.
    sleep_recent = [e.sleep_hours for e in recent if e.sleep_hours is not None]
    if len(sleep_recent) >= 4 and "diary:sleep_collapse" not in open_kinds:
        mean_sleep = sum(sleep_recent) / len(sleep_recent)
        if mean_sleep < 5.0:
            pending.append(
                Alert(
                    patient=patient,
                    severity=AlertSeverity.WARNING,
                    kind="diary:sleep_collapse",
                    title=f"Severe sleep restriction ({mean_sleep:.1f} h/night)",
                    detail=(
                        "Mean sleep over the last week is below 5 hours. Sleep deprivation reliably "
                        "amplifies tinnitus distress; prioritise the sleep pathway and consider CBT-I referral."
                    ),
                    evidence={"mean_sleep_hours": round(mean_sleep, 2), "source": "diary_trend"},
                )
            )

    if entries and "diary:disengaged" not in open_kinds:
        gap = (today - entries[-1].entry_date).days
        if gap >= 10:
            pending.append(
                Alert(
                    patient=patient,
                    severity=AlertSeverity.INFO,
                    kind="diary:disengaged",
                    title=f"No diary entry for {gap} days",
                    detail="Monitoring data has stopped. Consider a check-in; disengagement often "
                    "precedes deterioration.",
                    evidence={"days_since_last_entry": gap, "source": "diary_trend"},
                )
            )

    return Alert.objects.bulk_create(pending) if pending else []


# --------------------------------------------------------------------------- #
# Trigger correlation
# --------------------------------------------------------------------------- #
def trigger_correlation(entries: Sequence[Mapping[str, Any]], min_days: int = 3) -> list[dict[str, Any]]:
    """For each logged trigger, compare intensity on exposed vs unexposed days.

    Uses Welch's t statistic and Cohen's d rather than a raw mean difference, so a
    trigger logged on three noisy days does not outrank one logged on twenty
    consistent days. Reported as decision support, not as proof of causation -
    these are within-patient observational associations.
    """
    labelled = [
        e for e in entries if e.get("ringing_intensity") is not None and e.get("triggers") is not None
    ]
    if len(labelled) < 2 * min_days:
        return []

    all_triggers: set[str] = set()
    for e in labelled:
        all_triggers.update(str(t) for t in (e.get("triggers") or []))

    def stats(values: list[float]) -> tuple[float, float, int]:
        n = len(values)
        mean = sum(values) / n
        var = sum((v - mean) ** 2 for v in values) / (n - 1) if n > 1 else 0.0
        return mean, var, n

    results: list[dict[str, Any]] = []
    for trigger in sorted(all_triggers):
        exposed = [
            float(e["ringing_intensity"])
            for e in labelled
            if trigger in [str(t) for t in (e.get("triggers") or [])]
        ]
        unexposed = [
            float(e["ringing_intensity"])
            for e in labelled
            if trigger not in [str(t) for t in (e.get("triggers") or [])]
        ]
        if len(exposed) < min_days or len(unexposed) < min_days:
            continue

        m1, v1, n1 = stats(exposed)
        m2, v2, n2 = stats(unexposed)
        delta = m1 - m2
        se = math.sqrt(v1 / n1 + v2 / n2)
        t_stat = delta / se if se > 0 else 0.0
        pooled_sd = math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / max(1, n1 + n2 - 2))
        cohens_d = delta / pooled_sd if pooled_sd > 0 else 0.0

        if abs(t_stat) >= 2.5:
            strength = "strong"
        elif abs(t_stat) >= 2.0:
            strength = "moderate"
        elif abs(t_stat) >= 1.3:
            strength = "weak"
        else:
            strength = "none"

        results.append(
            {
                "trigger": trigger,
                "days_with": n1,
                "days_without": n2,
                "mean_with": round(m1, 2),
                "mean_without": round(m2, 2),
                "delta": round(delta, 2),
                "t_statistic": round(t_stat, 2),
                "cohens_d": round(cohens_d, 2),
                "strength": strength,
                "direction": "worse" if delta > 0 else "better",
                "interpretation": (
                    f"Days with '{trigger}' averaged {abs(delta):.1f} points "
                    f"{'higher' if delta > 0 else 'lower'} "
                    f"({m1:.1f} vs {m2:.1f}/10) across {n1} exposed and {n2} unexposed days."
                ),
            }
        )

    results.sort(key=lambda r: -abs(r["t_statistic"]))
    return results


def diary_analytics(entries: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Rolling means, weekday effects, correlations and streaks for the charts."""
    rows = [e for e in entries if e.get("ringing_intensity") is not None]
    if not rows:
        return {"n": 0, "series": [], "triggers": [], "correlations": {}, "streak": 0}

    def get(field: str) -> list[float]:
        return [float(e[field]) for e in rows if e.get(field) is not None]

    def corr(field_a: str, field_b: str) -> dict[str, Any] | None:
        pairs = [
            (float(e[field_a]), float(e[field_b]))
            for e in rows
            if e.get(field_a) is not None and e.get(field_b) is not None
        ]
        if len(pairs) < 6:
            return None
        n = len(pairs)
        mx = sum(p[0] for p in pairs) / n
        my = sum(p[1] for p in pairs) / n
        num = sum((p[0] - mx) * (p[1] - my) for p in pairs)
        dx = math.sqrt(sum((p[0] - mx) ** 2 for p in pairs))
        dy = math.sqrt(sum((p[1] - my) ** 2 for p in pairs))
        if dx == 0 or dy == 0:
            return None
        r = num / (dx * dy)
        return {"r": round(r, 3), "n": n, "strength": "strong" if abs(r) >= 0.5 else "moderate" if abs(r) >= 0.3 else "weak"}

    intensities = [float(e["ringing_intensity"]) for e in rows]
    window = 7
    rolling: list[float | None] = []
    for i in range(len(intensities)):
        if i + 1 < window:
            rolling.append(None)
        else:
            rolling.append(round(sum(intensities[i + 1 - window : i + 1]) / window, 2))

    series = [
        {
            "date": str(e.get("entry_date")),
            "intensity": float(e["ringing_intensity"]),
            "rolling7": rolling[i],
            "stress": e.get("stress_level"),
            "sleep_hours": e.get("sleep_hours"),
            "sleep_quality": e.get("sleep_quality"),
            "therapy_minutes": e.get("therapy_minutes") or 0,
            "annoyance": e.get("annoyance"),
            "mood": e.get("mood"),
            "triggers": e.get("triggers") or [],
        }
        for i, e in enumerate(rows)
    ]

    slope = None
    if len(intensities) >= 5:
        n = len(intensities)
        xs = list(range(n))
        mx = sum(xs) / n
        my = sum(intensities) / n
        denom = sum((x - mx) ** 2 for x in xs)
        if denom:
            slope = round(sum((x - mx) * (y - my) for x, y in zip(xs, intensities)) / denom * 7, 3)

    # Adherence streak: consecutive most-recent days with therapy logged.
    streak = 0
    for e in reversed(rows):
        if (e.get("therapy_minutes") or 0) > 0:
            streak += 1
        else:
            break

    return {
        "n": len(rows),
        "series": series,
        "mean_intensity": round(sum(intensities) / len(intensities), 2),
        "best_day": round(min(intensities), 1),
        "worst_day": round(max(intensities), 1),
        "variability": round(
            math.sqrt(sum((v - sum(intensities) / len(intensities)) ** 2 for v in intensities) / len(intensities)),
            2,
        ),
        "trend_per_week": slope,
        "streak_days": streak,
        "total_therapy_minutes": int(sum((e.get("therapy_minutes") or 0) for e in rows)),
        "mean_sleep_hours": round(sum(get("sleep_hours")) / len(get("sleep_hours")), 2)
        if get("sleep_hours")
        else None,
        "correlations": {
            "stress_vs_intensity": corr("stress_level", "ringing_intensity"),
            "sleep_vs_intensity": corr("sleep_hours", "ringing_intensity"),
            "therapy_vs_intensity": corr("therapy_minutes", "ringing_intensity"),
            "sleep_quality_vs_intensity": corr("sleep_quality", "ringing_intensity"),
        },
        "triggers": trigger_correlation(rows),
    }


# --------------------------------------------------------------------------- #
# Triage
# --------------------------------------------------------------------------- #
def triage_score(row: Mapping[str, Any]) -> tuple[float, list[str]]:
    """Rank a caseload. Returns (score 0-100, human-readable reasons).

    Weighted so that a safety flag always outranks a poor questionnaire score -
    the clinician's scarce attention should go to the patient who might have
    retrocochlear pathology before the patient with a high but stable THI.
    """
    score = 0.0
    reasons: list[str] = []

    urgency = row.get("highest_urgency") or "routine"
    if urgency == "emergency":
        score += 55
        reasons.append("Emergency red flag on file")
    elif urgency == "urgent":
        score += 40
        reasons.append("Urgent red flag on file")
    elif urgency == "soon":
        score += 18
        reasons.append("Red flag requiring early review")

    alerts = row.get("open_alerts") or 0
    if alerts:
        score += min(12, 4 * alerts)
        reasons.append(f"{alerts} unacknowledged alert(s)")

    risk = row.get("worsening_risk")
    if risk is not None:
        score += 22 * float(risk)
        if risk >= 0.5:
            reasons.append(f"Predicted worsening risk {risk:.0%}")

    thi = row.get("thi_score")
    if thi is not None:
        score += 14 * (thi / 100)
        if thi >= 58:
            reasons.append(f"THI {thi}/100 - severe handicap")

    change = row.get("thi_change")
    if change is not None and change >= 7:
        score += 12
        reasons.append(f"THI worsened by {change} points since last assessment")

    trend = row.get("diary_trend")
    if trend is not None and trend >= 1.0:
        score += 10
        reasons.append(f"Diary intensity rising ({trend:+.1f}/week)")

    adherence = row.get("adherence_pct")
    if adherence is not None and adherence < 40:
        score += 8
        reasons.append(f"Adherence {adherence:.0f}%")

    if (row.get("diary_days_14") or 0) == 0:
        score += 6
        reasons.append("No diary data in 14 days")

    last = row.get("last_assessment")
    if last:
        if isinstance(last, str):
            try:
                last = datetime.fromisoformat(last)
            except ValueError:
                last = None
        if isinstance(last, datetime):
            ref = last if last.tzinfo else last.replace(tzinfo=timezone.utc)
            days = (datetime.now(timezone.utc) - ref).days
            if days > 180:
                score += 7
                reasons.append(f"Last assessed {days} days ago")
    else:
        score += 9
        reasons.append("Never assessed")

    return round(min(100.0, score), 1), reasons

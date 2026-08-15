"""Daily monitoring: trends, streaks and the recovery picture.

Turns three raw streams — daily check-ins, rehabilitation activity logs and
therapy sessions — into the series a progress screen plots and the numbers a
clinician reads between consultations.

**Improvement is measured against the patient's own baseline, never against a
population.** The first week of check-ins is the baseline; everything after is
change from it. A patient whose tinnitus rates 7/10 and has come down from 9 is
improving, and a summary that compares them to a cohort mean would call that a
poor outcome. The number that matters clinically is the direction of their own
line.

Windows are stated rather than implied. Weekly means over fewer than three
ratings are returned with their `n`, so a chart can render them faintly rather
than treating one bad Tuesday as a week's trend.
"""

from __future__ import annotations

from datetime import date as Date, datetime, timedelta
from statistics import mean
from typing import Any, Iterable, Sequence

from django.utils import timezone

# Fewer than this in a week and the mean is reported with a low-confidence flag.
MIN_RATINGS_FOR_TREND = 3

# The metrics a check-in carries, and which direction is better. Direction
# matters: a rising sleep-quality score is improvement, a rising tinnitus score
# is deterioration, and a trend arrow that gets that backwards is worse than no
# arrow at all.
METRICS: dict[str, str] = {
    "tinnitus_loudness": "lower_better",
    "tinnitus_annoyance": "lower_better",
    "sleep_quality": "higher_better",
    "stress_level": "lower_better",
    "mood": "higher_better",
}


def _local_date(value: datetime) -> Date:
    """A session timestamp in the viewer's local day, not UTC.

    A 23:30 session in IST falls on the *previous* UTC day; counting it there
    would break a patient's streak at midnight for a reason they cannot see.
    """
    return timezone.localtime(value).date()


def _values(check_ins: Sequence[Any], field: str) -> list[tuple[Date, float]]:
    out: list[tuple[Date, float]] = []
    for row in check_ins:
        value = getattr(row, field, None)
        if value is None:
            continue
        out.append((row.on_date, float(value)))
    return sorted(out)


def _weekly(series: Sequence[tuple[Date, float]], start: Date, weeks: int) -> list[dict[str, Any]]:
    """Mean per programme week, with the sample size attached."""
    buckets: list[dict[str, Any]] = []
    for index in range(weeks):
        week_start = start + timedelta(days=index * 7)
        week_end = week_start + timedelta(days=6)
        values = [v for d, v in series if week_start <= d <= week_end]
        buckets.append(
            {
                "week": index + 1,
                "start": week_start.isoformat(),
                "end": week_end.isoformat(),
                "mean": round(mean(values), 2) if values else None,
                "n": len(values),
                # The chart dims a point the clinician should not read a trend
                # from rather than hiding it — an absence is also information.
                "confident": len(values) >= MIN_RATINGS_FOR_TREND,
            }
        )
    return buckets


def _trend(series: Sequence[tuple[Date, float]], direction: str) -> dict[str, Any]:
    """Change from the patient's own baseline to their current state.

    Baseline is the first up-to-seven ratings, current is the last up-to-seven.
    Both are means rather than single points, because a single first rating
    taken on the day somebody decided to seek help is systematically their worst
    day and would make every subsequent week look like a triumph.
    """
    if len(series) < 2:
        return {"baseline": None, "current": None, "delta": None, "direction": None, "n": len(series)}

    values = [v for _, v in series]
    baseline = mean(values[: min(7, len(values) // 2 or 1)])
    current = mean(values[-min(7, len(values) // 2 or 1) :])
    delta = round(current - baseline, 2)

    if abs(delta) < 0.5:
        movement = "steady"
    elif (delta < 0) == (direction == "lower_better"):
        movement = "improving"
    else:
        movement = "worsening"

    return {
        "baseline": round(baseline, 2),
        "current": round(current, 2),
        "delta": delta,
        "direction": movement,
        "n": len(series),
    }


def streak(dates: Iterable[Date], today: Date) -> int:
    """Consecutive days up to today, tolerating today not being done yet."""
    days = set(dates)
    count = 0
    cursor = today if today in days else today - timedelta(days=1)
    while cursor in days:
        count += 1
        cursor -= timedelta(days=1)
    return count


def build(
    *,
    check_ins: Sequence[Any],
    activities: Sequence[Any],
    sessions: Sequence[Any],
    appointments: Sequence[Any],
    started_on: Date,
    today: Date,
    programme_weeks: int = 4,
    rehab_progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The whole monitoring picture, in the shape the client renders."""
    # **Everything is clipped to the programme window.**
    #
    # The queries deliberately fetch a week either side of `started_on` so a
    # late-arriving row is not lost, but adherence is a ratio and both halves of
    # it have to cover the same days. Counting a therapy session from before the
    # programme began against days elapsed *since* it began produced "8 active
    # days out of 1" — arithmetically impossible and visibly broken.
    in_window = lambda d: started_on <= d <= today  # noqa: E731
    check_in_dates = {row.on_date for row in check_ins if in_window(row.on_date)}
    activity_dates = {row.on_date for row in activities if in_window(row.on_date)}
    session_dates = {
        d for d in (_local_date(s.started_at) for s in sessions) if in_window(d)
    }

    metrics: dict[str, Any] = {}
    for field, direction in METRICS.items():
        series = _values(check_ins, field)
        metrics[field] = {
            "direction": direction,
            "daily": [{"date": d.isoformat(), "value": v} for d, v in series],
            "weekly": _weekly(series, started_on, programme_weeks),
            "trend": _trend(series, direction),
        }

    # Adherence is activity days against days elapsed, capped at the programme
    # length. Counting against a window that keeps growing would make a patient
    # who has done everything look worse every day they stay enrolled.
    elapsed = max(1, min((today - started_on).days + 1, programme_weeks * 7))
    active_days = len(activity_dates | session_dates)
    adherence_pct = round(100 * min(active_days, elapsed) / elapsed, 1)

    # Recovery is deliberately a blend, and the weights are stated: half is what
    # the patient reports, half is what they have done. Symptom change alone
    # rewards a good month with no work; adherence alone rewards effort with no
    # benefit. Neither is the thing a clinician wants to see on its own.
    symptom = metrics["tinnitus_annoyance"]["trend"] or {}
    symptom_delta = symptom.get("delta")
    symptom_component = (
        max(0.0, min(100.0, 50.0 + (-symptom_delta) * 12.5)) if symptom_delta is not None else None
    )
    recovery = (
        round(0.5 * symptom_component + 0.5 * adherence_pct, 1)
        if symptom_component is not None
        else None
    )

    consultations = [
        {
            "id": a.id,
            "scheduled_for": a.scheduled_for.isoformat(),
            "status": a.status,
            "kind": a.kind,
            "clinician_name": a.clinician.full_name if a.clinician_id else None,
        }
        for a in appointments
    ]

    return {
        "started_on": started_on.isoformat(),
        "today": today.isoformat(),
        "programme_weeks": programme_weeks,
        "day_of_programme": (today - started_on).days + 1,
        "metrics": metrics,
        "check_in": {
            "streak_days": streak(check_in_dates, today),
            "total_days": len(check_in_dates),
            "logged_today": today in check_in_dates,
            "dates": sorted(d.isoformat() for d in check_in_dates),
        },
        "adherence": {
            "active_days": active_days,
            "elapsed_days": elapsed,
            "pct": adherence_pct,
            "session_days": len(session_dates),
            "activity_days": len(activity_dates),
            "streak_days": streak(activity_dates | session_dates, today),
            "dates": sorted(d.isoformat() for d in (activity_dates | session_dates)),
        },
        "rehab": rehab_progress or {},
        "consultations": consultations,
        "recovery_pct": recovery,
    }

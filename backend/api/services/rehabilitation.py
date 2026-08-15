"""The personalised rehabilitation programme.

A tinnitus prescription is a set of sound blocks and a daily minutes target.
That is the *acoustic* half of treatment and, on its own, it is not a recovery
programme — it tells a patient what to listen to and nothing about what to
actually do this morning, whether they are on track, or what changes next week.

This module turns the existing clinical outputs into a four-week structured
programme:

* **Daily activities** — the prescribed sound blocks, plus breathing, relaxation
  and mindfulness work drawn from the psychological instruments rather than
  handed to everybody. A patient whose GAD-2 is negative and whose sleep screen
  is clean does not need a daily anxiety exercise, and giving them one dilutes
  the things they *do* need.
* **Weekly goals** — a progression, so week 3 asks for more than week 1. The
  ramp is deliberately gentle for severe presentations: someone at THI grade 5
  is the least able to absorb a demanding schedule and the most likely to
  abandon it.
* **Progress** — completion, streak and weekly percentage, computed from the
  `TherapySession` rows the player already writes plus the activity log below.

**Nothing here is invented clinical content.** Every activity maps to a
recommendation the assessment pipeline already produces, and the severity bands
are the same THI/GAD-7/PSQI/PSS cut-points `clinical.instruments` scores
against. This module composes them into a schedule; it does not decide anything
new about the patient.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date as Date, datetime, timedelta
from typing import Any, Iterable, Mapping, Sequence

from django.utils import timezone

# --------------------------------------------------------------------------- #
# Activity catalogue
# --------------------------------------------------------------------------- #
# Keys are stable and are what the client logs completions against, so they are
# treated as an API contract. The human-readable strings live in the frontend
# translation files under `rehab.activity.*` — this layer stays language-neutral
# for the same reason the instrument item banks do.

PROGRAMME_WEEKS = 4

# `minutes` is the default; a sound block overrides it from the prescription.
ACTIVITY_LIBRARY: dict[str, dict[str, Any]] = {
    "sound_therapy": {
        "category": "acoustic",
        "minutes": 20,
        "slot": "daytime",
        # Always present. It is the prescription, and the prescription is the
        # part with the evidence behind it.
        "core": True,
    },
    "breathing": {
        "category": "regulation",
        "minutes": 5,
        "slot": "morning",
        "core": True,
    },
    "symptom_check": {
        "category": "tracking",
        "minutes": 1,
        "slot": "evening",
        "core": True,
    },
    "relaxation": {
        "category": "regulation",
        "minutes": 10,
        "slot": "evening",
        "core": False,
    },
    "mindfulness": {
        "category": "psychological",
        "minutes": 10,
        "slot": "daytime",
        "core": False,
    },
    "sleep_routine": {
        "category": "sleep",
        "minutes": 15,
        "slot": "sleep_onset",
        "core": False,
    },
    "sound_enrichment": {
        "category": "acoustic",
        "minutes": 30,
        "slot": "sleep_onset",
        "core": False,
    },
    "listening_practice": {
        "category": "acoustic",
        "minutes": 10,
        "slot": "daytime",
        "core": False,
    },
    "hearing_protection": {
        "category": "education",
        "minutes": 2,
        "slot": "as_needed",
        "core": False,
    },
}


@dataclass(slots=True)
class Severity:
    """The assessment findings this module actually branches on."""

    thi_score: int | None = None
    thi_grade_number: int | None = None
    gad_score: int | None = None
    phq2_score: int | None = None
    stress_score: int | None = None
    sleep_score: int | None = None
    psqi_score: int | None = None
    hearing_grade: str | None = None
    hyperacusis: bool = False
    daily_minutes_target: int = 60
    sound_blocks: list[dict[str, Any]] = field(default_factory=list)

    @property
    def band(self) -> str:
        """Overall handicap band, driving how demanding the schedule is."""
        grade = self.thi_grade_number
        if grade is None:
            if self.thi_score is None:
                return "unknown"
            grade = 1 if self.thi_score <= 16 else 2 if self.thi_score <= 36 else 3 if self.thi_score <= 56 else 4 if self.thi_score <= 76 else 5
        return {1: "slight", 2: "mild", 3: "moderate", 4: "severe", 5: "severe"}.get(grade, "moderate")

    @property
    def anxious(self) -> bool:
        """GAD-2 >= 3 or GAD-7 >= 10 — the published referral cut-points."""
        if self.gad_score is None:
            return False
        return self.gad_score >= 10 if self.gad_score > 6 else self.gad_score >= 3

    @property
    def stressed(self) -> bool:
        """PSS-4 >= 6 or PSS-10 >= 14."""
        if self.stress_score is None:
            return False
        return self.stress_score >= 14 if self.stress_score > 16 else self.stress_score >= 6

    @property
    def sleep_disrupted(self) -> bool:
        """Sleep screener at/above the PSQI escalation cut-point, or PSQI > 5."""
        if self.psqi_score is not None:
            return self.psqi_score > 5
        return self.sleep_score is not None and self.sleep_score >= 2

    @property
    def low_mood(self) -> bool:
        return self.phq2_score is not None and self.phq2_score >= 3


def severity_from(
    assessment: Any | None,
    prescription: Any | None,
    patient: Any | None = None,
) -> Severity:
    """Read the fields this module needs off the existing records.

    Tolerant of every one of them being absent: a patient who has not finished
    an assessment still gets a programme, it is just the core battery with a
    conservative dose rather than a tailored one.
    """
    sev = Severity()
    if assessment is not None:
        sev.thi_score = assessment.thi_score
        subs = assessment.thi_subscales or {}
        sev.thi_grade_number = subs.get("grade_number") if isinstance(subs, dict) else None
        # Long form when it was administered, screener otherwise. Never mixed:
        # the properties above read the scale from the magnitude.
        sev.gad_score = assessment.gad7_score if assessment.gad7_score is not None else assessment.gad2_score
        sev.phq2_score = assessment.phq2_score
        sev.stress_score = (
            assessment.pss10_score if assessment.pss10_score is not None else assessment.pss4_score
        )
        sev.sleep_score = assessment.sleep_screen_score
        sev.psqi_score = assessment.psqi_score
        sev.hearing_grade = assessment.hearing_grade
    if patient is not None:
        sev.hyperacusis = bool(getattr(patient, "hyperacusis", False))
    if prescription is not None:
        sev.daily_minutes_target = int(prescription.daily_minutes_target or 60)
        sev.sound_blocks = list(prescription.program or [])
    return sev


# --------------------------------------------------------------------------- #
# Which activities this patient is prescribed
# --------------------------------------------------------------------------- #
def indicated_activities(sev: Severity) -> list[dict[str, Any]]:
    """The activity set for this patient, each with why it is there.

    `because` is a machine-readable reason key, not prose — the frontend renders
    it from `rehab.reason.*` so the justification is shown in the patient's own
    language. Every non-core activity carries one: an exercise that appears with
    no stated reason reads as filler and is the first thing a patient drops.
    """
    chosen: list[dict[str, Any]] = []

    def add(key: str, because: str | None = None, minutes: int | None = None) -> None:
        spec = ACTIVITY_LIBRARY[key]
        chosen.append(
            {
                "key": key,
                "category": spec["category"],
                "slot": spec["slot"],
                "minutes": int(minutes if minutes is not None else spec["minutes"]),
                "because": because,
                "core": bool(spec["core"]),
            }
        )

    # -- core, for everyone --------------------------------------------------- #
    # The sound dose is the prescription's own daily target, split across the
    # blocks it actually contains, so the programme and the player never
    # disagree about how long the patient is meant to listen.
    blocks = max(1, len(sev.sound_blocks))
    per_block = max(5, round(sev.daily_minutes_target / blocks))
    add("sound_therapy", "prescription", minutes=per_block)
    add("breathing", None)
    add("symptom_check", None)

    # -- indicated by the instruments ----------------------------------------- #
    if sev.anxious:
        add("mindfulness", "anxiety")
    if sev.stressed:
        add("relaxation", "stress")
    if sev.sleep_disrupted:
        add("sleep_routine", "sleep")
        add("sound_enrichment", "sleep")
    if sev.low_mood and not sev.anxious:
        # Low mood without anxiety still benefits from the same attention
        # training; the reason it is filed under differs so the clinician can
        # see which finding put it there.
        add("mindfulness", "mood")
    if sev.hearing_grade and sev.hearing_grade.lower() not in {"normal", "none"}:
        add("listening_practice", "hearing")
    if sev.hyperacusis:
        # Sound tolerance work replaces, rather than adds to, an escalating
        # acoustic dose — the guardrails in the prescription already cap output.
        add("hearing_protection", "hyperacusis")

    return chosen


# --------------------------------------------------------------------------- #
# The four-week ramp
# --------------------------------------------------------------------------- #
def weekly_plan(sev: Severity, activities: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Four weeks, each introducing what the one before it established.

    The ramp is expressed as a *multiplier on the sound dose* plus which
    non-core activities have been introduced by that week. A severe presentation
    ramps more slowly and starts lower: the evidence for adherence in tinnitus
    programmes is that the people who most need them are the people most likely
    to stop, and front-loading a 60-minute day on somebody at grade 5 is how
    that happens.
    """
    gentle = sev.band == "severe"
    ramp = [0.5, 0.7, 0.85, 1.0] if gentle else [0.6, 0.8, 1.0, 1.0]

    optional = [a for a in activities if not a["core"]]
    # Introduce at most one new optional activity per week, sleep first — it is
    # the highest-yield target in tinnitus care and the one whose improvement
    # makes the rest of the programme easier to sustain.
    order = sorted(optional, key=lambda a: {"sleep": 0, "stress": 1, "anxiety": 2}.get(a["because"] or "", 3))

    weeks: list[dict[str, Any]] = []
    for index in range(PROGRAMME_WEEKS):
        # Week 1 is the core battery alone — establishing it *is* week 1's job.
        # Each week after that adds the next optional activity, so `introduced`
        # is everything up to this week and `introduces` is the one this week
        # brought in. Reading `order[index]` here instead would advertise an
        # activity in the week *before* it appears in the checklist.
        introduced = [a["key"] for a in order[:index]]
        active = [a["key"] for a in activities if a["core"]] + introduced
        new_this_week = order[index - 1]["key"] if 0 < index <= len(order) else None
        weeks.append(
            {
                "week": index + 1,
                "sound_minutes": max(5, round(sev.daily_minutes_target * ramp[index])),
                "activities": active,
                "introduces": new_this_week,
                # Goal keys, rendered from `rehab.goal.*` on the client.
                "goals": _week_goals(index + 1, new_this_week, gentle),
            }
        )
    return weeks


def _week_goals(week: int, introduces: str | None, gentle: bool) -> list[dict[str, Any]]:
    goals: list[dict[str, Any]] = [
        {"key": "breathing_daily", "target": 7},
        {"key": "sound_sessions", "target": 3 if week == 1 else 5 if week < 4 else 6},
        {"key": "track_symptoms", "target": 5 if gentle else 7},
    ]
    if introduces:
        goals.append({"key": f"introduce_{introduces}", "target": 3})
    if week == PROGRAMME_WEEKS:
        goals.append({"key": "review_progress", "target": 1})
    return goals


# --------------------------------------------------------------------------- #
# Progress
# --------------------------------------------------------------------------- #
def _local_date(value: datetime) -> Date:
    return timezone.localtime(value).date()


def progress(
    started_on: Date,
    sessions: Iterable[Any],
    completions: Iterable[Any],
    activities: Sequence[Mapping[str, Any]],
    weeks: Sequence[Mapping[str, Any]],
    today: Date | None = None,
) -> dict[str, Any]:
    """Streak, weekly completion and where the patient is in the programme.

    A "done" day is one with *any* logged activity, not a fully completed one.
    That is the deliberate choice: a streak that breaks because somebody did
    four of five things punishes the patient who is mostly succeeding, and the
    metric people actually respond to is "did I show up".
    """
    today = today or timezone.localdate()

    # Both sources count. The sound player writes `TherapySession` rows and
    # knows nothing about this module; the checklist writes `RehabActivityLog`.
    # A day on which the patient only listened is still a day they turned up.
    session_days: set[Date] = {_local_date(s.started_at) for s in sessions}
    logged: list[tuple[Date, str]] = [(c.on_date, c.activity_key) for c in completions]

    # A listening session *is* the sound-therapy activity, so it satisfies it
    # without the patient also having to tick a box. Without this the player and
    # the checklist disagree: a patient who listened every day this week saw a
    # streak of seven next to a weekly completion of zero, because the only
    # thing that had written an activity row was a checkbox they never used.
    logged += [(day, "sound_therapy") for day in session_days]
    logged = sorted(set(logged))

    days: set[Date] = session_days | {d for d, _ in logged}

    # Streak counts back from today, tolerating today being not-yet-done: at
    # 9am a three-day streak should read as three, not as broken.
    streak = 0
    cursor = today if today in days else today - timedelta(days=1)
    while cursor in days:
        streak += 1
        cursor -= timedelta(days=1)

    elapsed_days = max(0, (today - started_on).days)
    week_number = min(PROGRAMME_WEEKS, elapsed_days // 7 + 1)
    week_start = started_on + timedelta(days=(week_number - 1) * 7)
    week_end = week_start + timedelta(days=6)

    this_week = [(d, k) for d, k in logged if week_start <= d <= week_end]
    week_session_days = {d for d in days if week_start <= d <= week_end}

    current = next((w for w in weeks if w["week"] == week_number), weeks[-1] if weeks else None)
    active_keys = set(current["activities"]) if current else set()
    # Denominator is "every active activity, every day so far this week" — not
    # the whole week, or Monday morning would read as 3% complete.
    days_so_far = max(1, min(7, (today - week_start).days + 1))
    expected = max(1, len(active_keys) * days_so_far)
    done = len({(d, k) for d, k in this_week if k in active_keys})
    week_pct = round(100 * min(done, expected) / expected, 1)

    overall_expected = max(1, PROGRAMME_WEEKS * 7)
    overall_pct = round(100 * min(len(days), overall_expected) / overall_expected, 1)

    todays_keys = {k for d, k in logged if d == today}
    return {
        "started_on": started_on.isoformat(),
        "week": week_number,
        "week_of": PROGRAMME_WEEKS,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "day_of_programme": elapsed_days + 1,
        "streak_days": streak,
        "active_days": len(days),
        "week_active_days": len(week_session_days),
        "week_completion_pct": week_pct,
        "overall_completion_pct": overall_pct,
        "completed_today": sorted(todays_keys),
        "remaining_today": sorted(active_keys - todays_keys),
        "next_milestone": (
            {"week": week_number + 1, "introduces": next((w["introduces"] for w in weeks if w["week"] == week_number + 1), None)}
            if week_number < PROGRAMME_WEEKS
            else None
        ),
        "programme_complete": week_number >= PROGRAMME_WEEKS and today > week_end,
    }


def build(
    *,
    assessment: Any | None,
    prescription: Any | None,
    patient: Any | None,
    sessions: Iterable[Any],
    completions: Iterable[Any],
    started_on: Date,
) -> dict[str, Any]:
    """The whole programme, in the shape the client renders."""
    sev = severity_from(assessment, prescription, patient)
    activities = indicated_activities(sev)
    weeks = weekly_plan(sev, activities)
    prog = progress(started_on, sessions, completions, activities, weeks)

    current_week = next((w for w in weeks if w["week"] == prog["week"]), weeks[0])
    active = set(current_week["activities"])

    return {
        "severity": {
            "band": sev.band,
            "thi_score": sev.thi_score,
            "anxious": sev.anxious,
            "stressed": sev.stressed,
            "sleep_disrupted": sev.sleep_disrupted,
            "low_mood": sev.low_mood,
            "hyperacusis": sev.hyperacusis,
            "hearing_grade": sev.hearing_grade,
        },
        "activities": activities,
        # Today's list is the current week's activities only — showing week 4's
        # schedule in week 1 is how a programme reads as impossible on day one.
        "today": [a for a in activities if a["key"] in active],
        "weeks": weeks,
        "current_week": current_week,
        "progress": prog,
        "has_assessment": assessment is not None,
        "has_prescription": prescription is not None,
        "programme_weeks": PROGRAMME_WEEKS,
    }

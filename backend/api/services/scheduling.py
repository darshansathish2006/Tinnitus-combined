"""Consultation scheduling.

Slots are *derived*, never stored. A clinician's availability is a rule — which
weekdays they work, which windows within a day, how long a slot is — and the
bookable slots for any given date fall out of that rule minus the appointments
that already exist. Materialising a year of 30-minute slots per clinician would
be thousands of rows that exist only to be mostly empty, and every edit to a
working pattern would have to rewrite them.

The one thing that *is* stored is the booking, and `Appointment` carries a
partial unique constraint on (clinician, scheduled_for) excluding cancellations.
Availability is checked here for a good error message; the constraint is what
actually prevents two patients taking the same slot when their requests arrive
together.
"""

from __future__ import annotations

from datetime import date as Date, datetime, time, timedelta
from typing import Any

from django.utils import timezone

from ..models import Appointment, ClinicianProfile, User

# Defaults for a clinician with no profile row yet. Not written to the database:
# a clinician who has never opened their schedule still needs to be bookable, and
# silently creating rows on a GET is the kind of write-on-read that makes an
# endpoint impossible to reason about.
DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]  # Mon-Fri, ISO weekday numbering
DEFAULT_WORKING_HOURS = [
    {"start": "09:00", "end": "13:00"},
    {"start": "14:00", "end": "18:00"},
]
DEFAULT_SLOT_MINUTES = 30
DEFAULT_HORIZON_DAYS = 30
DEFAULT_SPECIALIZATION = "Audiology & Tinnitus Rehabilitation"

WEEKDAY_NAMES = {1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday"}

# Statuses that hold a slot. A cancelled appointment releases its time; a
# completed one still occupied it, which matters when listing a past day.
BLOCKING_STATUSES = {"scheduled", "requested", "completed"}


def profile_for(user: User) -> ClinicianProfile:
    """Return the clinician's stored profile, or an unsaved default instance."""
    stored = getattr(user, "clinician_profile", None)
    if stored is not None:
        return stored
    return ClinicianProfile(
        user=user,
        specialization=DEFAULT_SPECIALIZATION,
        working_days=list(DEFAULT_WORKING_DAYS),
        working_hours=[dict(w) for w in DEFAULT_WORKING_HOURS],
        slot_minutes=DEFAULT_SLOT_MINUTES,
        booking_horizon_days=DEFAULT_HORIZON_DAYS,
    )


def _parse_hhmm(value: Any) -> time | None:
    if not isinstance(value, str) or ":" not in value:
        return None
    hours, _, minutes = value.partition(":")
    try:
        h, m = int(hours), int(minutes[:2])
    except ValueError:
        return None
    return time(h, m) if 0 <= h < 24 and 0 <= m < 60 else None


def working_windows(profile: ClinicianProfile) -> list[dict[str, Any]]:
    """Normalised, validated working windows. Bad rows are dropped, not guessed."""
    out: list[dict[str, Any]] = []
    for window in profile.working_hours or DEFAULT_WORKING_HOURS:
        start = _parse_hhmm((window or {}).get("start"))
        end = _parse_hhmm((window or {}).get("end"))
        if start is None or end is None or start >= end:
            continue
        out.append({"start": start.strftime("%H:%M"), "end": end.strftime("%H:%M")})
    return out or [dict(w) for w in DEFAULT_WORKING_HOURS]


def working_days(profile: ClinicianProfile) -> list[int]:
    raw = profile.working_days if isinstance(profile.working_days, list) else []
    days = sorted({int(d) for d in raw if isinstance(d, (int, float)) and 1 <= int(d) <= 7})
    return days or list(DEFAULT_WORKING_DAYS)


def describe_days(days: list[int]) -> str:
    """"Monday-Friday" when the run is contiguous, otherwise a comma list."""
    if not days:
        return "Not set"
    if len(days) > 1 and days == list(range(days[0], days[-1] + 1)):
        return f"{WEEKDAY_NAMES[days[0]]}–{WEEKDAY_NAMES[days[-1]]}"
    return ", ".join(WEEKDAY_NAMES[d] for d in days)


def _slot_starts(profile: ClinicianProfile, day: Date) -> list[datetime]:
    """Every slot start on `day`, as aware datetimes in the project timezone."""
    minutes = max(5, int(profile.slot_minutes or DEFAULT_SLOT_MINUTES))
    tz = timezone.get_current_timezone()
    starts: list[datetime] = []

    for window in working_windows(profile):
        start = _parse_hhmm(window["start"])
        end = _parse_hhmm(window["end"])
        if start is None or end is None:
            continue
        cursor = datetime.combine(day, start)
        last = datetime.combine(day, end)
        # `< last` not `<= last`: a slot must *finish* inside the window, so an
        # 18:00 end with 30-minute slots offers 17:30 as the last one.
        while cursor + timedelta(minutes=minutes) <= last:
            starts.append(timezone.make_aware(cursor, tz))
            cursor += timedelta(minutes=minutes)

    return starts


def day_slots(clinician: User, day: Date, *, include_past: bool = False) -> list[dict[str, Any]]:
    """Bookable slots for one clinician on one date, with availability resolved.

    Every slot is returned, taken ones included, each labelled with why it cannot
    be booked. A list that silently omits them looks like a clinician with no
    availability rather than one with a full morning.
    """
    profile = profile_for(clinician)
    if day.isoweekday() not in working_days(profile):
        return []

    now = timezone.localtime()
    taken = {
        timezone.localtime(a.scheduled_for).replace(second=0, microsecond=0): a
        for a in Appointment.objects.filter(
            clinician=clinician,
            scheduled_for__date=day,
            status__in=BLOCKING_STATUSES,
        )
    }

    slots: list[dict[str, Any]] = []
    for start in _slot_starts(profile, day):
        local = timezone.localtime(start).replace(second=0, microsecond=0)
        in_past = local <= now
        if in_past and not include_past:
            continue
        booked = taken.get(local)
        slots.append(
            {
                "start": start.isoformat(),
                "label": local.strftime("%H:%M"),
                "available": booked is None and not in_past,
                "reason": "booked" if booked else ("past" if in_past else None),
                "minutes": max(5, int(profile.slot_minutes or DEFAULT_SLOT_MINUTES)),
            }
        )
    return slots


def slot_exists(clinician: User, when: datetime) -> bool:
    """Whether `when` is a real slot start in the clinician's working pattern."""
    local = timezone.localtime(when).replace(second=0, microsecond=0)
    return any(
        timezone.localtime(start).replace(second=0, microsecond=0) == local
        for start in _slot_starts(profile_for(clinician), local.date())
    )


def availability(clinician: User, *, days: int | None = None) -> list[dict[str, Any]]:
    """Per-day availability across the booking horizon, for a calendar view."""
    profile = profile_for(clinician)
    horizon = days or max(1, int(profile.booking_horizon_days or DEFAULT_HORIZON_DAYS))
    today = timezone.localdate()

    out: list[dict[str, Any]] = []
    for offset in range(horizon):
        day = today + timedelta(days=offset)
        slots = day_slots(clinician, day)
        out.append(
            {
                "date": day.isoformat(),
                "weekday": WEEKDAY_NAMES[day.isoweekday()],
                "working": day.isoweekday() in working_days(profile),
                "slots": slots,
                "open_count": sum(1 for s in slots if s["available"]),
            }
        )
    return out


def profile_payload(clinician: User) -> dict[str, Any]:
    """Everything a booking UI needs to describe a clinician, in one shape."""
    profile = profile_for(clinician)
    days = working_days(profile)
    today = timezone.localdate()
    today_slots = day_slots(clinician, today)

    return {
        "clinician_id": clinician.id,
        "name": clinician.full_name,
        "email": clinician.email,
        "specialization": profile.specialization or DEFAULT_SPECIALIZATION,
        "qualifications": profile.qualifications or "",
        "years_experience": profile.years_experience,
        "bio": profile.bio or "",
        "accepting_patients": profile.accepting_patients,
        "working_days": days,
        "working_days_label": describe_days(days),
        "working_hours": working_windows(profile),
        "slot_minutes": max(5, int(profile.slot_minutes or DEFAULT_SLOT_MINUTES)),
        "booking_horizon_days": max(1, int(profile.booking_horizon_days or DEFAULT_HORIZON_DAYS)),
        "works_today": today.isoweekday() in days,
        # "Remaining today" counts only slots that are still in the future, which
        # is the number a clinician actually wants at 3pm.
        "slots_remaining_today": sum(1 for s in today_slots if s["available"]),
        "slots_today_total": len(_slot_starts(profile_for(clinician), today)),
        "has_default_meeting_link": bool(profile.default_meeting_link),
    }


def directory(*, horizon_days: int = 14) -> list[dict[str, Any]]:
    """Every bookable clinician, with enough availability to compare them.

    Built for the patient's "choose a doctor" step, so it carries the soonest
    free slot and a short preview of the next few times rather than the full
    grid: a directory that shipped every slot for every clinician would be tens
    of kilobytes to render a list of four cards, and the patient narrows to one
    doctor before they need the detail.
    """
    from ..models import Role, User as UserModel

    out: list[dict[str, Any]] = []
    clinicians = (
        UserModel.objects.filter(role=Role.CLINICIAN, is_active=True)
        .select_related("clinician_profile")
        .order_by("full_name")
    )

    for clinician in clinicians:
        profile = profile_for(clinician)
        if not profile.accepting_patients:
            continue

        days = availability(clinician, days=horizon_days)
        open_days = [d for d in days if d["open_count"] > 0]
        first = open_days[0] if open_days else None

        out.append(
            {
                **profile_payload(clinician),
                "next_available_date": first["date"] if first else None,
                "next_available_weekday": first["weekday"] if first else None,
                # Four is enough to show the shape of a morning without turning
                # the card into a grid.
                "next_slots": [s["label"] for s in (first["slots"] if first else []) if s["available"]][:4],
                "open_slots_soon": sum(d["open_count"] for d in days),
                "patient_count": clinician.caseload.count(),
            }
        )

    # Soonest availability first — the question a patient is actually asking is
    # "who can see me first?", and alphabetical order answers a different one.
    out.sort(key=lambda c: (c["next_available_date"] is None, c["next_available_date"] or ""))
    return out

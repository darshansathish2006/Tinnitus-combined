"""Build the demonstration cohort.

    python manage.py seed_demo [--reset]

Seeded records go through the **same** analysis pipeline as live submissions —
`api.views.finalise_assessment` — so nothing is hand-written into a derived column.
If the pipeline is broken, seeding fails rather than papering over it with
plausible-looking fixtures.

The cohort deliberately exercises the edges a reviewer should see: a longitudinal
responder, a pulsatile red flag, an asymmetric loss needing imaging, a sudden SNHL
emergency, hyperacusis with a collapsed dynamic range, a masking-rebound
contraindication, and a catastrophic-THI escalation.
"""

from __future__ import annotations

import math
import random
from datetime import date, datetime, time, timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from clinical.instruments import GAD7_ITEMS, PSS10_ITEMS, THI_ITEMS

from api.models import (
    Alert,
    Appointment,
    ClinicianProfile,
    Assessment,
    AssessmentStatus,
    ChatMessage,
    ClinicalNote,
    DiaryEntry,
    MedicationReminder,
    Patient,
    Prediction,
    Role,
    TherapyPrescription,
    TherapySession,
    User,
)

DEMO_PASSWORD = "echosense2026"
DEMO_EMAILS = {
    "dr.mehta@echosense.health",
    "dr.raman@echosense.health",
    "priya.sundaram@example.com",
    "arun.kumar@example.com",
    "meera.iyer@example.com",
    "david.osei@example.com",
    "fatima.noor@example.com",
    "james.whelan@example.com",
    "lakshmi.rao@example.com",
    "tom.becker@example.com",
    "ana.silva@example.com",
    "wei.chen@example.com",
    "grace.mbeki@example.com",
    "olu.adeyemi@example.com",
}

rng = random.Random(20260730)
MOODS = ["very_low", "low", "neutral", "good", "very_good"]
MODALITY_POOL = [
    "notched_noise", "notched_music", "broadband_enrichment", "sleep_ramp",
    "breathing_pacer", "ocean_waves", "rain", "coordinated_reset", "partial_masker",
    "fractal_tones", "desensitisation",
]


# --------------------------------------------------------------------------- #
# Instrument response synthesis
# --------------------------------------------------------------------------- #
def thi_short_items_for(target: int) -> dict[str, int]:
    """A five-item THI-5 response set whose projected score lands near `target`.

    The projection is raw x 5, and raw steps in 2s, so the reachable scores are
    multiples of 10 — `target` is met to the nearest 10 rather than exactly. That
    granularity is the short form's actual resolution, so rounding here is the
    honest thing to seed rather than a limitation of the seeder.
    """
    from clinical.instruments import THI_SHORT_IDS, THI_SHORT_MAX

    raw_target = round(max(0, min(100, target)) * THI_SHORT_MAX / 100 / 2) * 2
    items = {i: 0 for i in THI_SHORT_IDS}
    remaining = raw_target
    for item_id in rng.sample(THI_SHORT_IDS, len(THI_SHORT_IDS)):
        take = 4 if remaining >= 4 and rng.random() < 0.8 else min(2, remaining)
        items[item_id] = take
        remaining -= take
        if remaining <= 0:
            break
    return items


def thi_items_for(target: int) -> dict[str, int]:
    """A 25-item THI response set summing to roughly `target`.

    Weights the catastrophic-subscale items toward high responses at high totals so
    a severe score also carries a plausible *pattern* — the scoring layer flags the
    hopelessness cluster separately, and a severe total with a benign pattern would
    be an unrealistic record.
    """
    target = max(0, min(100, target))
    ids = [i["id"] for i in THI_ITEMS]
    catastrophic = {i["id"] for i in THI_ITEMS if i["sub"] == "catastrophic"}
    order = sorted(
        ids, key=lambda i: (0 if i in catastrophic else 1) if target >= 58 else (1 if i in catastrophic else 0)
    )
    items = {i: 0 for i in ids}
    remaining = target
    for item_id in order:
        if remaining >= 4 and rng.random() < 0.85:
            items[item_id], remaining = 4, remaining - 4
        elif remaining >= 2:
            items[item_id], remaining = 2, remaining - 2
        if remaining <= 0:
            break
    return items


def scale_items_for(item_ids, target: int, maximum: int) -> dict[str, int]:
    ids = list(item_ids)
    items = {i: 0 for i in ids}
    remaining = target
    for item_id in rng.sample(ids, len(ids)):
        take = min(maximum, remaining, maximum if rng.random() < 0.7 else max(0, maximum - 1))
        items[item_id] = take
        remaining -= take
        if remaining <= 0:
            break
    return items


def psqi_items_for(target: int, tinnitus_sleep: int = 2) -> dict:
    severity = min(3, max(0, round(target / 7)))
    return {
        "psqi_bedtime": "23:15", "psqi_waketime": "06:45",
        "psqi_latency_min": [10, 25, 45, 75][severity],
        "psqi_sleep_hours": [7.8, 6.5, 5.4, 4.2][severity],
        "psqi_hours_in_bed": 7.5,
        "psqi5a": min(3, severity + (1 if target > 12 else 0)),
        "psqi5b": severity, "psqi5c": max(0, severity - 1), "psqi5d": 0,
        "psqi5e": 0 if severity < 2 else 1, "psqi5f": 0, "psqi5g": max(0, severity - 2),
        "psqi5h": max(0, severity - 1), "psqi5i": tinnitus_sleep,
        "psqi6": severity, "psqi7": 0 if target < 10 else 2,
        "psqi8": max(0, severity - 1), "psqi9": severity,
    }


def make_audiogram(*, age: int, noise_years: float, asymmetry_db: float = 0.0,
                   notch: bool = False, extra_hf: float = 0.0) -> dict:
    """Plausible audiogram: presbycusis + optional noise notch + asymmetry.

    Only the frequencies the adaptive protocol would actually have tested are
    emitted: the octave set always, and 3/6 kHz only where adjacent octaves differ by
    20 dB or more — so seeded records match what the app would really collect.
    """
    presby = {250: 0.0022, 500: 0.0026, 1000: 0.0033, 2000: 0.0060,
              3000: 0.0090, 4000: 0.0122, 6000: 0.0155, 8000: 0.0180}
    notch_shape = {250: 0.02, 500: 0.05, 1000: 0.10, 2000: 0.28,
                   3000: 0.72, 4000: 1.00, 6000: 0.80, 8000: 0.45}

    out: dict[str, dict[str, float]] = {}
    for side, sign in (("left", 1.0), ("right", -1.0)):
        full: dict[int, float] = {}
        for f in (250, 500, 1000, 2000, 3000, 4000, 6000, 8000):
            base = 6.0 + presby[f] * max(0, age - 18) ** 2 / 10.0
            if notch or noise_years > 0:
                base += notch_shape[f] * 24.0 * (1 - math.exp(-max(noise_years, 6 if notch else 0) / 9.0))
            base += extra_hf * notch_shape[f] + sign * asymmetry_db / 2.0 + rng.uniform(-3.5, 3.5)
            full[f] = float(max(-10, min(115, round(base / 5) * 5)))

        thresholds = {str(f): full[f] for f in (250, 500, 1000, 2000, 4000, 8000)}
        if abs(full[4000] - full[2000]) >= 20:
            thresholds["3000"] = full[3000]
        if abs(full[8000] - full[4000]) >= 20:
            thresholds["6000"] = full[6000]
        out[side] = thresholds
    return out


def ri_trace(depth: float, duration: float) -> list[dict[str, float]]:
    if duration <= 0:
        return [{"t": float(t), "loudness_pct": 100.0} for t in range(0, 61, 5)]
    tau = max(2.0, duration / 2.2)
    return [
        {"t": float(t), "loudness_pct": round(min(120.0, max(0.0, 100 - depth * math.exp(-t / tau))), 1)}
        for t in range(0, int(max(60, duration * 1.6)) + 1, 5)
    ]


# --------------------------------------------------------------------------- #
# Cohort specification
# --------------------------------------------------------------------------- #
PATIENTS = [
    {
        "email": "priya.sundaram@example.com", "name": "Priya Sundaram", "sex": "female", "age": 42,
        "locale": "ta", "character": "Ringing", "laterality": "both", "onset_months": 19,
        "noise_years": 3, "somatic": True, "consent": True, "comorbidities": ["Migraine"],
        "medications": ["Amitriptyline 10 mg nocte", "Vitamin D"],
        "notes": "Software engineer. Onset after a period of intense work stress and prolonged headphone "
                 "use. Tinnitus modulates with jaw clenching — reports night-time bruxism.",
        "series": [
            {"days_ago": 168, "thi": 58, "gad7": 13, "pss10": 27, "psqi": 13, "pitch": 6000,
             "loud": 9.0, "mml": 12.0, "ri_depth": 62, "ri_dur": 38, "vas": [7.2, 7.8, 8.5, 7.0], "bandwidth": "tonal"},
            {"days_ago": 84, "thi": 44, "gad7": 9, "pss10": 21, "psqi": 9, "pitch": 5800,
             "loud": 8.0, "mml": 10.0, "ri_depth": 68, "ri_dur": 45, "vas": [6.0, 5.5, 7.0, 4.5], "bandwidth": "tonal"},
            {"days_ago": 5, "thi": 30, "gad7": 6, "pss10": 16, "psqi": 6, "pitch": 5800,
             "loud": 7.0, "mml": 9.0, "ri_depth": 74, "ri_dur": 55, "vas": [4.5, 3.8, 5.5, 2.5], "bandwidth": "tonal"},
        ],
        "diary_days": 120, "diary_trend": -0.022, "diary_base": 6.6, "adherence": 0.86, "relief": 1.5,
    },
    {
        "email": "arun.kumar@example.com", "name": "Arun Kumar", "sex": "male", "age": 57, "locale": "en",
        "character": "Hissing", "laterality": "right", "onset_months": 8, "noise_years": 26,
        "asymmetry": 26, "consent": True, "comorbidities": ["Hypertension", "Type 2 diabetes"],
        "medications": ["Amlodipine 5 mg", "Metformin 1 g BD"],
        "notes": "Textile mill floor supervisor, 26 years unprotected noise exposure. Strictly right-sided "
                 "percept with marked interaural asymmetry — imaging pathway indicated.",
        "series": [
            {"days_ago": 21, "thi": 52, "gad7": 8, "pss10": 22, "psqi": 11, "pitch": 4000, "loud": 11.0,
             "mml": 22.0, "ri_depth": 18, "ri_dur": 8, "vas": [6.8, 6.2, 7.5, 5.5], "bandwidth": "narrowband", "notch": True},
        ],
        "diary_days": 24, "diary_trend": 0.03, "diary_base": 6.4, "adherence": 0.45, "relief": 0.4,
    },
    {
        "email": "meera.iyer@example.com", "name": "Meera Iyer", "sex": "female", "age": 34, "locale": "en",
        "character": "Pulsing", "laterality": "left", "onset_months": 3, "noise_years": 0,
        "pulsatile": True, "consent": False, "comorbidities": ["Headache", "Visual disturbance"],
        "medications": [],
        "notes": "Percept synchronous with heartbeat, worse when lying down. Reports positional headache "
                 "and transient visual obscurations. Urgent vascular imaging and fundoscopy requested.",
        "series": [
            {"days_ago": 9, "thi": 46, "gad7": 12, "pss10": 24, "psqi": 12, "pitch": 800, "loud": 14.0,
             "mml": 30.0, "ri_depth": 4, "ri_dur": 0, "vas": [6.5, 7.5, 8.0, 6.5], "bandwidth": "broadband"},
        ],
        "diary_days": 9, "diary_trend": 0.08, "diary_base": 6.8, "adherence": 0.5, "relief": 0.1,
    },
    {
        "email": "david.osei@example.com", "name": "David Osei", "sex": "male", "age": 49, "locale": "en",
        "character": "Whistling", "laterality": "both", "onset_months": 62, "noise_years": 11,
        "hyperacusis": True, "ldl": [74, 78], "consent": True, "comorbidities": ["Anxiety disorder"],
        "medications": ["Sertraline 50 mg"],
        "notes": "Session musician. Significant sound intolerance — avoids restaurants and family events. "
                 "Dynamic range collapsed; graded desensitisation rather than masking.",
        "series": [
            {"days_ago": 112, "thi": 68, "gad7": 16, "pss10": 30, "psqi": 15, "pitch": 8000, "loud": 12.0,
             "mml": 34.0, "ri_depth": 12, "ri_dur": 6, "vas": [8.0, 8.8, 9.0, 8.0], "bandwidth": "tonal", "notch": True},
            {"days_ago": 16, "thi": 60, "gad7": 13, "pss10": 26, "psqi": 12, "pitch": 8000, "loud": 11.0,
             "mml": 31.0, "ri_depth": 16, "ri_dur": 9, "vas": [7.2, 7.5, 8.5, 6.5], "bandwidth": "tonal", "notch": True},
        ],
        "diary_days": 84, "diary_trend": -0.01, "diary_base": 7.4, "adherence": 0.62, "relief": 0.8,
    },
    {
        "email": "fatima.noor@example.com", "name": "Fatima Noor", "sex": "female", "age": 61, "locale": "hi",
        "character": "Buzzing", "laterality": "both", "onset_months": 41, "noise_years": 0, "consent": True,
        "comorbidities": ["Osteoarthritis"], "medications": ["Paracetamol PRN"],
        "notes": "Retired teacher. Presbycusic loss with well-controlled distress; using the platform "
                 "mainly for sleep support.",
        "series": [
            {"days_ago": 47, "thi": 22, "gad7": 4, "pss10": 12, "psqi": 8, "pitch": 3000, "loud": 6.0,
             "mml": 8.0, "ri_depth": 80, "ri_dur": 62, "vas": [3.5, 2.8, 4.0, 5.0], "bandwidth": "narrowband"},
        ],
        "diary_days": 46, "diary_trend": -0.015, "diary_base": 3.6, "adherence": 0.91, "relief": 1.2,
    },
    {
        "email": "james.whelan@example.com", "name": "James Whelan", "sex": "male", "age": 45, "locale": "en",
        "character": "Ringing", "laterality": "both", "onset_months": 14, "noise_years": 6, "consent": True,
        "comorbidities": ["Depression"], "medications": ["Fluoxetine 20 mg"],
        "notes": "Catastrophic handicap with maximal responses on the hopelessness cluster. Masking rebound "
                 "on testing — acoustic escalation contraindicated. Escalated to psychology.",
        "series": [
            {"days_ago": 11, "thi": 84, "gad7": 18, "pss10": 34, "psqi": 17, "pitch": 7000, "loud": 16.0,
             "mml": 44.0, "ri_depth": -22, "ri_dur": 0, "vas": [9.2, 9.6, 10.0, 9.0], "bandwidth": "narrowband", "phq2": 5},
        ],
        "diary_days": 18, "diary_trend": 0.09, "diary_base": 8.4, "adherence": 0.28, "relief": -0.3,
    },
    {
        "email": "lakshmi.rao@example.com", "name": "Lakshmi Rao", "sex": "female", "age": 29, "locale": "te",
        "character": "Ringing", "laterality": "left", "onset_months": 1, "noise_years": 0,
        "asymmetry": 34, "extra_hf": 18, "consent": True, "comorbidities": ["Vertigo"], "medications": [],
        "notes": "Sudden onset three weeks ago with marked unilateral threshold shift and rotatory vertigo. "
                 "Same-day ENT referral — steroid window closing.",
        "series": [
            {"days_ago": 2, "thi": 56, "gad7": 14, "pss10": 26, "psqi": 14, "pitch": 2000, "loud": 13.0,
             "mml": 26.0, "ri_depth": 30, "ri_dur": 14, "vas": [7.5, 8.0, 8.5, 7.5], "bandwidth": "narrowband"},
        ],
        "diary_days": 3, "diary_trend": 0.0, "diary_base": 7.4, "adherence": 0.6, "relief": 0.2,
    },
    {
        "email": "tom.becker@example.com", "name": "Tom Becker", "sex": "male", "age": 38, "locale": "en",
        "character": "Cricket-like", "laterality": "both", "onset_months": 96, "noise_years": 2,
        "consent": True, "comorbidities": [], "medications": [],
        "notes": "Long-standing, well-habituated tinnitus. Enrolled for monitoring only.",
        "series": [
            {"days_ago": 63, "thi": 12, "gad7": 2, "pss10": 9, "psqi": 4, "pitch": 9500, "loud": 5.0,
             "mml": 6.0, "ri_depth": 88, "ri_dur": 70, "vas": [2.5, 1.5, 2.0, 1.0], "bandwidth": "tonal"},
        ],
        "diary_days": 62, "diary_trend": -0.004, "diary_base": 2.4, "adherence": 0.72, "relief": 0.9,
    },
    {
        "email": "ana.silva@example.com", "name": "Ana Silva", "sex": "female", "age": 52, "locale": "es",
        "character": "Hissing", "laterality": "right", "onset_months": 27, "noise_years": 14,
        "consent": True, "comorbidities": ["Hypothyroidism"], "medications": ["Levothyroxine 75 mcg"],
        "notes": "Factory noise exposure with a clear 4 kHz notch. Moderate distress, good engagement.",
        "series": [
            {"days_ago": 133, "thi": 48, "gad7": 10, "pss10": 23, "psqi": 10, "pitch": 4000, "loud": 9.5,
             "mml": 15.0, "ri_depth": 48, "ri_dur": 26, "vas": [6.2, 6.0, 7.0, 5.5], "bandwidth": "narrowband", "notch": True},
            {"days_ago": 29, "thi": 38, "gad7": 7, "pss10": 18, "psqi": 8, "pitch": 4000, "loud": 8.5,
             "mml": 13.0, "ri_depth": 54, "ri_dur": 32, "vas": [5.0, 4.5, 6.0, 4.0], "bandwidth": "narrowband", "notch": True},
        ],
        "diary_days": 96, "diary_trend": -0.018, "diary_base": 5.8, "adherence": 0.79, "relief": 1.3,
    },
    {
        "email": "wei.chen@example.com", "name": "Wei Chen", "sex": "male", "age": 66, "locale": "en",
        "character": "Ringing", "laterality": "both", "onset_months": 54, "noise_years": 4,
        "hearing_aids": True, "consent": True, "comorbidities": ["Ischaemic heart disease"],
        "medications": ["Aspirin 75 mg", "Atorvastatin 20 mg"],
        "notes": "Bilateral hearing aid user. Tinnitus largely managed by amplification; monitoring for change.",
        "series": [
            {"days_ago": 38, "thi": 26, "gad7": 5, "pss10": 14, "psqi": 7, "pitch": 3000, "loud": 7.0,
             "mml": 11.0, "ri_depth": 66, "ri_dur": 40, "vas": [4.0, 3.2, 5.0, 3.5], "bandwidth": "narrowband"},
        ],
        "diary_days": 37, "diary_trend": -0.008, "diary_base": 4.2, "adherence": 0.83, "relief": 1.0,
    },
    {
        "email": "grace.mbeki@example.com", "name": "Grace Mbeki", "sex": "female", "age": 47, "locale": "en",
        "character": "Roaring", "laterality": "both", "onset_months": 6, "noise_years": 0, "consent": False,
        "comorbidities": ["Iron deficiency anaemia"], "medications": ["Ferrous sulphate"],
        "notes": "Broadband percept, difficult to match. Disengaged from monitoring after the first fortnight.",
        "series": [
            {"days_ago": 54, "thi": 42, "gad7": 9, "pss10": 20, "psqi": 10, "pitch": None, "loud": 10.0,
             "mml": 24.0, "ri_depth": 22, "ri_dur": 10, "vas": [5.8, 5.5, 6.5, 5.0], "bandwidth": "broadband"},
        ],
        "diary_days": 14, "diary_gap": 26, "diary_trend": 0.02, "diary_base": 5.6, "adherence": 0.35, "relief": 0.5,
    },
    {
        "email": "olu.adeyemi@example.com", "name": "Olu Adeyemi", "sex": "male", "age": 31, "locale": "fr",
        "character": "Ringing", "laterality": "left", "onset_months": 11, "noise_years": 5, "somatic": True,
        "consent": True, "comorbidities": [], "medications": [],
        "notes": "DJ. Clear somatic modulation with neck rotation; TMJ and cervical assessment requested.",
        "series": [
            {"days_ago": 40, "thi": 36, "gad7": 7, "pss10": 19, "psqi": 7, "pitch": 6500, "loud": 8.0,
             "mml": 12.0, "ri_depth": 58, "ri_dur": 30, "vas": [5.0, 4.8, 6.0, 3.5], "bandwidth": "tonal", "notch": True},
        ],
        "diary_days": 39, "diary_trend": -0.012, "diary_base": 5.0, "adherence": 0.75, "relief": 1.1,
    },
]


class Command(BaseCommand):
    help = "Seed the EchoSense demonstration cohort"

    def add_arguments(self, parser) -> None:
        parser.add_argument("--reset", action="store_true", help="Delete existing data first")

    @staticmethod
    def _seed_appointment(patient, rng) -> None:
        """Book the patient onto a genuinely free slot in their clinician's diary.

        Walks forward through the booking horizon and takes the first open slot
        after a random offset, so the demo cohort spreads across the calendar
        without two patients colliding on one time — which the appointment
        table's unique constraint would reject anyway.
        """
        from api.services import scheduling as sched

        # Unassigned patients have not chosen a doctor yet, so they have nothing
        # booked — which is the state the selection flow starts from.
        if patient.clinician is None:
            return

        days = sched.availability(patient.clinician)
        open_days = [d for d in days if d["open_count"] > 0]
        if not open_days:
            return

        day = open_days[min(rng.randrange(0, len(open_days)), len(open_days) - 1)]
        free = [s for s in day["slots"] if s["available"]]
        if not free:
            return

        slot = free[rng.randrange(0, len(free))]
        Appointment.objects.create(
            patient=patient,
            clinician=patient.clinician,
            scheduled_for=parse_datetime(slot["start"]),
            kind="follow_up",
            modality=rng.choice(["teleaudiology", "in_person"]),
            status="scheduled",
            notes="Review THI-5, therapy adherence and residual inhibition.",
        )

    @transaction.atomic
    def handle(self, *args, **options) -> None:
        from api.views import finalise_assessment
        from api.services.monitoring import check_diary_alerts

        self.stdout.write(self.style.MIGRATE_HEADING("EchoSense AI — seeding demo cohort\n"))

        if options["reset"]:
            for model in (Alert, ChatMessage, ClinicalNote, Appointment, MedicationReminder,
                          TherapySession, TherapyPrescription, Prediction, DiaryEntry,
                          Assessment, Patient):
                model.objects.all().delete()
            User.objects.all().delete()
        elif User.objects.filter(email="dr.mehta@echosense.health").exists():
            self.stdout.write(self.style.WARNING("  Demo data already present. Use --reset to rebuild."))
            return

        # Two clinicians with deliberately different working patterns, so the
        # booking screen is exercised against more than one shape: Mehta works a
        # standard Mon-Fri split day, Raman a shorter four-day week with longer
        # slots. A single pattern would have let a hardcoded assumption survive.
        CLINICIANS = [
            {
                "email": "dr.mehta@echosense.health",
                "name": "Dr Anjali Mehta",
                "specialization": "Audiology & Tinnitus Rehabilitation",
                "qualifications": "MSc Audiology, MBA (Clinical Lead)",
                "years_experience": 14,
                "bio": "Runs the tinnitus rehabilitation pathway. Particular interest in sound "
                       "therapy for patients whose sleep is the worst-affected domain.",
                "working_days": [1, 2, 3, 4, 5],
                "working_hours": [{"start": "09:00", "end": "13:00"}, {"start": "14:00", "end": "18:00"}],
                "slot_minutes": 30,
                "default_meeting_link": "https://meet.google.com/ech-osen-se1",
            },
            {
                "email": "dr.raman@echosense.health",
                "name": "Dr Karthik Raman",
                "specialization": "ENT & Neuro-otology",
                "qualifications": "MS (ENT), Fellowship in Otology",
                "years_experience": 9,
                "bio": "Sees the medical side: pulsatile tinnitus, asymmetric loss and anything "
                       "needing imaging or a surgical opinion.",
                "working_days": [1, 2, 4, 5],
                "working_hours": [{"start": "10:00", "end": "13:00"}, {"start": "15:00", "end": "17:00"}],
                "slot_minutes": 45,
                "default_meeting_link": "https://meet.google.com/ech-osen-se2",
            },
        ]
        clinicians = []
        for spec in CLINICIANS:
            user = User.objects.create_user(
                email=spec["email"], password=DEMO_PASSWORD, full_name=spec["name"],
                role=Role.CLINICIAN, locale="en",
            )
            ClinicianProfile.objects.create(
                user=user,
                specialization=spec["specialization"],
                qualifications=spec["qualifications"],
                years_experience=spec["years_experience"],
                bio=spec["bio"],
                working_days=spec["working_days"],
                working_hours=spec["working_hours"],
                slot_minutes=spec["slot_minutes"],
                default_meeting_link=spec["default_meeting_link"],
            )
            clinicians.append(user)
        self.stdout.write(f"  Created {len(clinicians)} clinicians with schedules")

        totals = {"assessments": 0, "diary": 0, "sessions": 0}

        for index, profile in enumerate(PATIENTS):
            user = User.objects.create_user(
                email=profile["email"], password=DEMO_PASSWORD, full_name=profile["name"],
                role=Role.PATIENT, locale=profile.get("locale", "en"),
                country="India", state="Tamil Nadu", city="Chennai",
                joined_community=True if index < 8 else False,
            )
            from api.views import get_or_create_community_for_user
            get_or_create_community_for_user(user, "India", "Tamil Nadu", "Chennai")
            # Every fourth patient is left unassigned. Patients are not routed to
            # a doctor automatically any more — they choose one when they book —
            # so the cohort has to contain people who have not chosen yet, or the
            # doctor-selection path is never exercised by the demo.
            patient = Patient.objects.create(
                user=user,
                clinician=None if index % 4 == 3 else clinicians[index % len(clinicians)],
                mrn=f"ESA-2026-{index + 1:05d}",
                date_of_birth=date.today() - timedelta(days=int(profile["age"] * 365.25)),
                sex=profile["sex"],
                phone=f"+91 98{rng.randint(10000000, 99999999)}",
                onset_date=date.today() - timedelta(days=int(profile["onset_months"] * 30.44)),
                tinnitus_character=profile["character"],
                laterality=profile["laterality"],
                pulsatile=profile.get("pulsatile", False),
                somatic_modulation=profile.get("somatic", False),
                hyperacusis=profile.get("hyperacusis", False),
                hearing_aid_use=profile.get("hearing_aids", False),
                noise_exposure_years=profile.get("noise_years", 0),
                comorbidities=profile.get("comorbidities", []),
                medications=profile.get("medications", []),
                etiology_notes=profile.get("notes", ""),
                consent_research=profile.get("consent", False),
            )

            # Diary first, so the engagement features exist when the models score
            # the most recent assessment.
            n_diary = self.build_diary(patient, profile)

            assessments = []
            # Only the most recent assessment uses the five-item short form —
            # which is exactly what the record looks like after the change went
            # live. It also means the demo exercises both scoring paths and both
            # report layouts rather than only the new one.
            last_index = len(profile["series"]) - 1
            for index, spec in enumerate(profile["series"]):
                assessment = self.build_assessment(
                    patient, spec, profile, short_form=index == last_index
                )
                finalise_assessment(patient, assessment)
                assessments.append(assessment)
                totals["assessments"] += 1

            # Sessions derive from the prescription the assessment produced, so they
            # can only be built afterwards; the latest assessment is then
            # re-finalised so its prediction sees the resulting adherence.
            n_sessions = self.build_sessions(patient, profile)
            if assessments:
                finalise_assessment(patient, assessments[-1])
            check_diary_alerts(patient=patient)

            for drug in profile.get("medications", [])[:2]:
                MedicationReminder.objects.create(
                    patient=patient, drug_name=drug.split(" ")[0],
                    dose=" ".join(drug.split(" ")[1:]),
                    times_of_day=["21:30"] if "nocte" in drug.lower() else ["08:00"],
                    notes="Seeded reminder.",
                )
            # Seeded onto a real slot in the clinician's pattern. An appointment
            # at 14:37 would be unreachable from the booking UI and would make
            # the console disagree with the schedule it sits next to.
            self._seed_appointment(patient, rng)
            # A note is written by a clinician, so a patient who has not chosen
            # one yet has none — the record reflects that rather than inventing
            # an author.
            if patient.clinician is not None:
                ClinicalNote.objects.create(
                    patient=patient, clinician=patient.clinician,
                    created_at=timezone.now() - timedelta(days=rng.randint(2, 40)),
                    body=f"Initial consultation. {profile.get('notes', '')}",
                )

            totals["diary"] += n_diary
            totals["sessions"] += n_sessions
            self.stdout.write(
                f"  {profile['name']:20s} — {len(profile['series'])} assessment(s), "
                f"{n_diary} diary days, {n_sessions} sessions"
            )

        self.seed_chat()

        self.stdout.write(
            self.style.SUCCESS(
                f"\nSeeded {len(PATIENTS)} patients, {totals['assessments']} assessments, "
                f"{totals['diary']} diary entries, {totals['sessions']} therapy sessions, "
                f"{Alert.objects.count()} alerts."
            )
        )
        self.stdout.write(
            f"\nSign in with any of these (password: {DEMO_PASSWORD}):\n"
            f"  Clinician : dr.mehta@echosense.health\n"
            f"  Patient   : priya.sundaram@example.com   (full longitudinal record)\n"
            f"  Patient   : james.whelan@example.com     (catastrophic THI, masking rebound)\n"
            f"  Patient   : meera.iyer@example.com       (pulsatile — urgent red flag)\n"
        )

    # -- builders ----------------------------------------------------------- #
    def build_assessment(self, patient: Patient, spec: dict, profile: dict, *, short_form: bool = False) -> Assessment:
        created = timezone.now() - timedelta(days=spec["days_ago"])
        vas = spec.get("vas", [5, 5, 5, 5])
        pitch = spec.get("pitch")

        modules = ["intake", "calibration", "audiometry", "thi", "vas", "gad2", "phq2", "pss4", "sleep_screen"]
        if spec["gad7"] >= 6:
            modules.append("gad7")
        if spec["pss10"] >= 15:
            modules.append("pss10")
        if spec["psqi"] >= 6:
            modules.append("psqi")
        if pitch:
            modules += ["pitch_match", "loudness_match", "mml", "residual_inhibition"]

        assessment = Assessment.objects.create(
            patient=patient,
            created_at=created,
            status=AssessmentStatus.IN_PROGRESS,
            modules_done=sorted(set(modules)),
            device_profile={
                "transducer": "circumaural",
                "model": "Sennheiser HD 280 Pro (demo profile)",
                "reference_spl_db": 65.0,
                "output_gain_db": -22.0,
                "ambient_noise_db": round(rng.uniform(28, 38), 1),
                "calibration_method": "reference-tone loudness balance at 1 kHz",
                "calibrated_at": created.isoformat(),
                "browser": "Chromium 131",
                "sample_rate": 48000,
            },
            audiogram=make_audiogram(
                age=profile["age"], noise_years=profile.get("noise_years", 0),
                asymmetry_db=profile.get("asymmetry", 0), notch=spec.get("notch", False),
                extra_hf=profile.get("extra_hf", 0),
            ),
            pitch_match_hz=pitch,
            pitch_match_ear=profile.get("laterality", "both"),
            pitch_match_confidence=None if pitch is None else round(rng.uniform(0.62, 0.94), 2),
            octave_confusion=False if pitch else None,
            pitch_match_trace=[
                {"step": i, "hz": round(pitch * (2 ** rng.uniform(-0.45, 0.45)), 1), "chosen": rng.random() < 0.5}
                for i in range(8)
            ] if pitch else [],
            loudness_match_db_sl=spec.get("loud"),
            loudness_match_db_hl=None if pitch is None else round((spec.get("loud") or 8) + rng.uniform(15, 45), 1),
            mml_db_sl=spec.get("mml"),
            ri_depth_pct=spec.get("ri_depth"),
            ri_duration_s=spec.get("ri_dur"),
            ri_trace=ri_trace(spec.get("ri_depth") or 0, spec.get("ri_dur") or 0),
            tinnitus_bandwidth=spec.get("bandwidth", "narrowband"),
            ldl_left=(profile.get("ldl") or [None, None])[0],
            ldl_right=(profile.get("ldl") or [None, None])[1],
            thi_items=thi_short_items_for(spec["thi"]) if short_form else thi_items_for(spec["thi"]),
            vas_loudness=vas[0], vas_annoyance=vas[1], vas_awareness=vas[2], vas_sleep_interference=vas[3],
            psqi_items=psqi_items_for(spec["psqi"], tinnitus_sleep=2 if vas[3] >= 4 else 1)
            if spec["psqi"] >= 6 else {},
            pss10_items=scale_items_for([i["id"] for i in PSS10_ITEMS], spec["pss10"], 4),
            gad7_items=scale_items_for([i["id"] for i in GAD7_ITEMS], spec["gad7"], 3),
            phq2_items={"phq1": min(3, spec.get("phq2", 1)), "phq2": max(0, spec.get("phq2", 1) - 1)},
            sleep_screen_score=min(3, max(0, round(vas[3] / 3.4))),
        )
        return assessment

    def build_diary(self, patient: Patient, profile: dict) -> int:
        days = profile.get("diary_days", 0)
        if not days:
            return 0
        gap = profile.get("diary_gap", 0)
        base = profile.get("diary_base", 5.0)
        trend = profile.get("diary_trend", 0.0)
        personal = rng.sample(
            ["stress", "poor_sleep", "caffeine", "loud_noise", "jaw_clenching",
             "neck_tension", "alcohol", "quiet_room", "screen_time", "weather"], 4
        )

        entries = []
        for offset in range(days):
            entry_date = date.today() - timedelta(days=days + gap - offset - 1)
            weekday_effect = 0.45 if entry_date.weekday() < 5 else -0.3
            today_triggers = [t for t in personal if rng.random() < 0.28]
            # A logged trigger genuinely raises intensity, so the correlation engine
            # has something real to find rather than noise.
            intensity = max(0.0, min(10.0,
                base + trend * offset + weekday_effect + rng.gauss(0, 0.7) + 0.75 * len(today_triggers)))
            did_therapy = rng.random() < profile.get("adherence", 0.6)

            entries.append(DiaryEntry(
                patient=patient, entry_date=entry_date,
                created_at=timezone.make_aware(datetime.combine(entry_date, time(21, 0))),
                ringing_intensity=round(intensity, 1),
                pitch_shift=rng.choice(["same", "same", "same", "higher", "lower", "unsure"]),
                annoyance=round(max(0.0, min(10.0, intensity * 0.94 + rng.gauss(0, 0.8))), 1),
                stress_level=round(max(0.0, min(10.0, intensity * 0.72 + rng.gauss(0, 1.1))), 1),
                mood=MOODS[max(0, min(4, round(4 - intensity / 2.5)))],
                sleep_hours=round(max(2.5, min(10.0, 8.4 - intensity * 0.28 + rng.gauss(0, 0.6))), 1),
                sleep_quality=round(max(0.0, min(10.0, 9.2 - intensity * 0.62 + rng.gauss(0, 0.7))), 1),
                medication_taken=rng.random() < 0.86 if profile.get("medications") else None,
                therapy_minutes=int(rng.uniform(25, 95)) if did_therapy else 0,
                caffeine_units=round(rng.uniform(0, 4), 1),
                alcohol_units=round(rng.uniform(0, 3), 1) if rng.random() < 0.3 else 0.0,
                noise_exposure_minutes=int(rng.uniform(0, 120)) if rng.random() < 0.25 else 0,
                triggers=today_triggers,
                notes=rng.choice([
                    "", "", "", "Louder after the commute.", "Good day — barely noticed it.",
                    "Woke at 3am and could not get back to sleep.", "Very busy day at work.",
                    "Used the notched programme twice.",
                ]),
            ))
        DiaryEntry.objects.bulk_create(entries)
        return len(entries)

    def build_sessions(self, patient: Patient, profile: dict) -> int:
        """Generate sessions **from the diary**, so adherence and logged therapy
        minutes agree. Generating them independently produced records where the
        diary claimed 70 minutes and the adherence figure reported 30%."""
        prescription = TherapyPrescription.objects.filter(patient=patient, active=True).order_by("-revision").first()
        modalities = [b["modality"] for b in (prescription.program or [])] if prescription else []
        modalities = modalities or MODALITY_POOL[:4]
        daily_target = prescription.daily_minutes_target if prescription else 60
        relief_scale = profile.get("relief", 1.0)

        sessions = []
        created = 0
        for entry in DiaryEntry.objects.filter(patient=patient, therapy_minutes__gt=0).order_by("entry_date"):
            remaining = int(entry.therapy_minutes)
            n_blocks = 1 if remaining <= 30 else (2 if remaining <= 65 else 3)
            planned_each = max(10, round(daily_target / n_blocks))

            for block in range(n_blocks):
                minutes = min(remaining, remaining if block == n_blocks - 1
                              else max(8, round(remaining / (n_blocks - block))))
                remaining -= minutes
                if minutes <= 0:
                    continue
                modality = modalities[(created + block) % len(modalities)]
                pre = round(max(0.0, min(10.0, (entry.ringing_intensity or 5.0) + rng.gauss(0, 0.4))), 1)
                family_gain = 1.25 if modality in {
                    "notched_noise", "partial_masker", "coordinated_reset", "notched_music"} else 0.7
                completed = minutes >= planned_each * 0.9
                drop = max(-1.0, rng.gauss(relief_scale * family_gain, 0.5)) if completed else rng.gauss(0.2, 0.3)

                sessions.append(TherapySession(
                    patient=patient, prescription=prescription,
                    started_at=timezone.make_aware(
                        datetime.combine(entry.entry_date, time(7 + block * 6, rng.randint(0, 50)))),
                    modality=modality,
                    planned_seconds=planned_each * 60,
                    actual_seconds=minutes * 60,
                    completed=completed,
                    volume_db=round(rng.uniform(-30, -14), 1),
                    pre_vas_loudness=pre,
                    post_vas_loudness=round(max(0.0, min(10.0, pre - drop)), 1),
                    pre_vas_annoyance=round(max(0.0, min(10.0, pre + rng.gauss(0.3, 0.4))), 1),
                    post_vas_annoyance=round(max(0.0, min(10.0, pre - drop + rng.gauss(0.1, 0.4))), 1),
                    residual_inhibition_s=round(rng.uniform(8, 55), 1)
                    if modality in {"partial_masker", "ri_induction"} and completed else None,
                    params={"modality": modality, "seeded": True},
                ))
                created += 1
        TherapySession.objects.bulk_create(sessions)
        return len(sessions)

    def seed_chat(self) -> None:
        """A short conversation on the flagship record, so the chat screen is not
        empty on first open."""
        flagship = Patient.objects.filter(user__email="priya.sundaram@example.com").first()
        if not flagship:
            return
        for role, content, intent in (
            ("user", "I cannot sleep, it is so much louder at night", "sleep"),
            ("assistant", "Night is when tinnitus is worst for almost everyone, and the reason is "
                          "simple: a quiet bedroom removes every competing sound.", "sleep"),
            ("user", "will this ever get better?", "education_cure"),
            ("assistant", "I will be straight with you, because false hope is its own kind of harm.",
             "education_cure"),
        ):
            ChatMessage.objects.create(
                patient=flagship, role=role, content=content, locale="en", intent=intent,
                engine="rules" if role == "assistant" else "",
                created_at=timezone.now() - timedelta(days=4, minutes=rng.randint(1, 200)),
            )

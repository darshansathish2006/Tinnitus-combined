"""ORM models for the EchoSense AI clinical record.

Design notes
------------
* Structured clinical values get real columns so they are queryable and indexable;
  instrument raw traces and item-level questionnaire responses live in ``JSONField``
  because their shape is instrument-specific and versioned.
* Nothing is ever hard-deleted from the clinical record — ``Assessment.status`` and
  ``TherapyPrescription.active`` carry lifecycle instead.
* Choice values are plain strings via ``TextChoices`` rather than database enums, so
  adding a value is a migration-free change and the same constants serialise
  directly to JSON for the API.
"""

from __future__ import annotations

from datetime import date

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone


# --------------------------------------------------------------------------- #
# Choices
# --------------------------------------------------------------------------- #
class Role(models.TextChoices):
    PATIENT = "patient", "Patient"
    CLINICIAN = "clinician", "Clinician"
    ADMIN = "admin", "Admin"


class AssessmentStatus(models.TextChoices):
    IN_PROGRESS = "in_progress", "In progress"
    COMPLETE = "complete", "Complete"
    ABANDONED = "abandoned", "Abandoned"


class Ear(models.TextChoices):
    LEFT = "left", "Left"
    RIGHT = "right", "Right"
    BOTH = "both", "Both"
    CENTRAL = "central", "Central"


class AlertSeverity(models.TextChoices):
    INFO = "info", "Info"
    WARNING = "warning", "Warning"
    CRITICAL = "critical", "Critical"


class Bandwidth(models.TextChoices):
    TONAL = "tonal", "Tonal"
    NARROWBAND = "narrowband", "Narrowband"
    BROADBAND = "broadband", "Broadband"


# --------------------------------------------------------------------------- #
# Identity
# --------------------------------------------------------------------------- #
class UserManager(BaseUserManager):
    """Email-based manager — there are no usernames in this system."""

    use_in_migrations = True

    def create_user(self, email: str, password: str, **extra):
        if not email:
            raise ValueError("An email address is required.")
        user = self.model(email=self.normalize_email(email).lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email: str, password: str, **extra):
        extra.setdefault("role", Role.ADMIN)
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        extra.setdefault("full_name", "Administrator")
        return self.create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(unique=True, db_index=True)
    full_name = models.CharField(max_length=160)
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.PATIENT, db_index=True)
    locale = models.CharField(max_length=12, default="en")
    country = models.CharField(max_length=100, blank=True, default="")
    state = models.CharField(max_length=100, blank=True, default="")
    city = models.CharField(max_length=100, blank=True, default="")
    community = models.ForeignKey(
        "Community", on_delete=models.SET_NULL, null=True, blank=True, related_name="members"
    )
    joined_community = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)
    last_login = models.DateTimeField(null=True, blank=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["full_name"]

    class Meta:
        db_table = "users"
        ordering = ["id"]

    def __str__(self) -> str:
        return f"{self.full_name} <{self.email}>"

    @property
    def is_clinician(self) -> bool:
        return self.role in {Role.CLINICIAN, Role.ADMIN}


class Patient(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="patient")
    clinician = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name="caseload", db_index=True
    )

    mrn = models.CharField(max_length=24, unique=True, db_index=True)
    date_of_birth = models.DateField(null=True, blank=True)
    sex = models.CharField(max_length=24, blank=True, default="")
    phone = models.CharField(max_length=32, blank=True, default="")

    onset_date = models.DateField(null=True, blank=True)
    # The single character is kept as the *primary* one and every existing
    # reader — the analysis layer, the report narrative, the ML feature vector,
    # the seeded cohort — goes on using it unchanged. `tinnitus_characters`
    # carries the full set for the many patients who hear more than one sound at
    # once, which the single field could only express as the blunt "Multiple
    # sounds". Two fields rather than a widened one, so nothing that reads the
    # old field has to learn a new shape.
    tinnitus_character = models.CharField(max_length=48, blank=True, default="")
    tinnitus_characters = models.JSONField(default=list, blank=True)
    laterality = models.CharField(max_length=16, choices=Ear.choices, blank=True, default="")
    pulsatile = models.BooleanField(default=False)
    somatic_modulation = models.BooleanField(default=False)
    hyperacusis = models.BooleanField(default=False)
    hearing_aid_use = models.BooleanField(default=False)
    noise_exposure_years = models.FloatField(null=True, blank=True)
    comorbidities = models.JSONField(default=list, blank=True)
    medications = models.JSONField(default=list, blank=True)
    etiology_notes = models.TextField(blank=True, default="")
    consent_research = models.BooleanField(default=False)

    # Remembered so a returning patient can reuse their headphone calibration
    # instead of repeating it — the single biggest source of drop-off.
    saved_device_profile = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "patients"
        ordering = ["id"]

    def __str__(self) -> str:
        return f"{self.mrn} — {self.user.full_name}"

    @property
    def age(self) -> int | None:
        if not self.date_of_birth:
            return None
        today = date.today()
        return (
            today.year
            - self.date_of_birth.year
            - ((today.month, today.day) < (self.date_of_birth.month, self.date_of_birth.day))
        )

    @property
    def duration_months(self) -> float | None:
        if not self.onset_date:
            return None
        return round((date.today() - self.onset_date).days / 30.44, 1)


# --------------------------------------------------------------------------- #
# Assessment
# --------------------------------------------------------------------------- #
class Assessment(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="assessments", db_index=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=16, choices=AssessmentStatus.choices, default=AssessmentStatus.IN_PROGRESS
    )
    modules_done = models.JSONField(default=list, blank=True)

    # -- calibration / provenance ------------------------------------------- #
    device_profile = models.JSONField(default=dict, blank=True)

    # -- pure tone audiometry ----------------------------------------------- #
    # {"left": {"500": 15, ...}, "right": {...}} in dB HL
    audiogram = models.JSONField(default=dict, blank=True)
    pta_left = models.FloatField(null=True, blank=True)
    pta_right = models.FloatField(null=True, blank=True)
    hf_pta_left = models.FloatField(null=True, blank=True)
    hf_pta_right = models.FloatField(null=True, blank=True)

    # -- audiometry reliability (the hearing test's own flagged review) ------ #
    # Distinct from `analyse_audiogram`'s `flags`, which describe the *shape* of
    # the hearing loss (asymmetry, noise notch). These describe whether the
    # measurement can be trusted at all: responses in silence, a retest that did
    # not reproduce, a frequency that never converged.
    #
    # A threshold obtained from a patient who pressed the button in silence is
    # not a threshold, and a report that presents it as one without saying so is
    # worse than a report with a gap. The client already computed all of this and
    # showed it on screen; it simply had nowhere to be stored, so it died with
    # the page. `None` on `audiometry_reliable` means "no audiometry submitted",
    # which is a different statement from `False`.
    audiometry_reliable = models.BooleanField(null=True, blank=True)
    audiometry_notes = models.JSONField(default=list, blank=True)
    audiometry_false_positives = models.IntegerField(null=True, blank=True)
    audiometry_catch_trials = models.IntegerField(null=True, blank=True)
    audiometry_retest_agreement_db = models.FloatField(null=True, blank=True)
    hearing_grade = models.CharField(max_length=32, blank=True, default="")
    audiometric_notch_hz = models.FloatField(null=True, blank=True)

    # -- psychoacoustic tinnitus measures (optional per AAO-HNSF) ----------- #
    pitch_match_hz = models.FloatField(null=True, blank=True)
    pitch_match_ear = models.CharField(max_length=16, choices=Ear.choices, blank=True, default="")
    pitch_match_confidence = models.FloatField(null=True, blank=True)
    octave_confusion = models.BooleanField(null=True, blank=True)
    pitch_match_trace = models.JSONField(default=list, blank=True)

    loudness_match_db_sl = models.FloatField(null=True, blank=True)
    loudness_match_db_hl = models.FloatField(null=True, blank=True)
    mml_db_sl = models.FloatField(null=True, blank=True)
    ri_depth_pct = models.FloatField(null=True, blank=True)
    ri_duration_s = models.FloatField(null=True, blank=True)
    ri_trace = models.JSONField(default=list, blank=True)
    ri_category = models.CharField(max_length=24, blank=True, default="")
    tinnitus_bandwidth = models.CharField(max_length=24, choices=Bandwidth.choices, blank=True, default="")
    ldl_left = models.FloatField(null=True, blank=True)
    ldl_right = models.FloatField(null=True, blank=True)

    # -- masking threshold profile ------------------------------------------ #
    # The minimum level, per frequency, at which a masking band renders the
    # tinnitus inaudible. Stored as {"250": 28.0, "500": 30.0, ...} — frequency
    # in Hz as a string key, threshold in dB HL.
    #
    # A JSON map rather than eight columns because the tested set is a clinical
    # decision, not a schema one: a service that adds 1.5 kHz, or drops 6 kHz
    # for a patient who cannot hear it, should not need a migration. The set
    # actually administered is recoverable from the keys, which is what
    # distinguishes "not tested" from "tested and unmaskable".
    masking_thresholds = models.JSONField(default=dict, blank=True)
    # Frequencies the patient could not mask at any deliverable level. Kept
    # separate from a null in the map above: "we tried and it would not mask"
    # is a finding, and it is the finding that contraindicates masking therapy.
    masking_unmasked_hz = models.JSONField(default=list, blank=True)
    # The derived summary — see `services.masking.reference_level`.
    reference_level_db = models.FloatField(null=True, blank=True)
    reference_level_hz = models.FloatField(null=True, blank=True)

    # -- validated questionnaires ------------------------------------------- #
    thi_items = models.JSONField(default=dict, blank=True)
    thi_score = models.IntegerField(null=True, blank=True)
    thi_grade = models.CharField(max_length=32, blank=True, default="")
    thi_subscales = models.JSONField(default=dict, blank=True)

    vas_loudness = models.FloatField(null=True, blank=True)
    vas_annoyance = models.FloatField(null=True, blank=True)
    vas_awareness = models.FloatField(null=True, blank=True)
    vas_sleep_interference = models.FloatField(null=True, blank=True)

    psqi_items = models.JSONField(default=dict, blank=True)
    psqi_score = models.IntegerField(null=True, blank=True)
    psqi_grade = models.CharField(max_length=32, blank=True, default="")

    pss10_items = models.JSONField(default=dict, blank=True)
    pss10_score = models.IntegerField(null=True, blank=True)
    pss10_grade = models.CharField(max_length=32, blank=True, default="")

    gad7_items = models.JSONField(default=dict, blank=True)
    gad7_score = models.IntegerField(null=True, blank=True)
    gad7_grade = models.CharField(max_length=32, blank=True, default="")

    phq2_items = models.JSONField(default=dict, blank=True)
    phq2_score = models.IntegerField(null=True, blank=True)

    # Short-form screeners administered first under the stepped protocol.
    gad2_score = models.IntegerField(null=True, blank=True)
    pss4_score = models.IntegerField(null=True, blank=True)
    sleep_screen_score = models.IntegerField(null=True, blank=True)
    escalated_instruments = models.JSONField(default=list, blank=True)

    # -- derived composite metrics ------------------------------------------ #
    derived = models.JSONField(default=dict, blank=True)
    icd11_codes = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = "assessments"
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["patient", "-created_at"], name="ix_assess_patient_date")]

    def __str__(self) -> str:
        return f"Assessment #{self.pk} — {self.patient.mrn}"


class Prediction(models.Model):
    assessment = models.OneToOneField(Assessment, on_delete=models.CASCADE, related_name="prediction")
    created_at = models.DateTimeField(default=timezone.now)
    model_version = models.CharField(max_length=48)

    predicted_dominant_hz = models.FloatField(null=True, blank=True)
    predicted_loudness_db_sl = models.FloatField(null=True, blank=True)
    severity_progression_thi = models.FloatField(null=True, blank=True)
    distress_class = models.CharField(max_length=32, blank=True, default="")
    distress_confidence = models.FloatField(null=True, blank=True)
    worsening_risk = models.FloatField(null=True, blank=True)
    risk_band = models.CharField(max_length=16, blank=True, default="")
    therapy_response_likelihood = models.FloatField(null=True, blank=True)

    explanations = models.JSONField(default=dict, blank=True)
    feature_vector = models.JSONField(default=dict, blank=True)
    confidence_interval = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "predictions"


# --------------------------------------------------------------------------- #
# Therapy
# --------------------------------------------------------------------------- #
class TherapyPrescription(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="prescriptions", db_index=True)
    assessment = models.ForeignKey(Assessment, on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    revision = models.IntegerField(default=1)
    active = models.BooleanField(default=True, db_index=True)
    generated_by = models.CharField(max_length=32, default="ai")
    approved_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name="approved_prescriptions"
    )

    program = models.JSONField(default=list, blank=True)
    daily_minutes_target = models.IntegerField(default=60)
    rationale = models.JSONField(default=list, blank=True)
    guardrails = models.JSONField(default=dict, blank=True)
    review_after_days = models.IntegerField(default=14)

    class Meta:
        db_table = "therapy_prescriptions"
        ordering = ["-revision"]


class TherapySession(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="sessions", db_index=True)
    prescription = models.ForeignKey(
        TherapyPrescription, on_delete=models.CASCADE, null=True, blank=True, related_name="sessions"
    )
    started_at = models.DateTimeField(default=timezone.now, db_index=True)
    modality = models.CharField(max_length=48)
    planned_seconds = models.IntegerField(default=0)
    actual_seconds = models.IntegerField(default=0)
    completed = models.BooleanField(default=False)
    volume_db = models.FloatField(null=True, blank=True)
    pre_vas_loudness = models.FloatField(null=True, blank=True)
    post_vas_loudness = models.FloatField(null=True, blank=True)
    pre_vas_annoyance = models.FloatField(null=True, blank=True)
    post_vas_annoyance = models.FloatField(null=True, blank=True)
    residual_inhibition_s = models.FloatField(null=True, blank=True)
    params = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "therapy_sessions"
        ordering = ["-started_at"]

    @property
    def relief_delta(self) -> float | None:
        if self.pre_vas_loudness is None or self.post_vas_loudness is None:
            return None
        return round(self.pre_vas_loudness - self.post_vas_loudness, 2)


# --------------------------------------------------------------------------- #
# Longitudinal monitoring
# --------------------------------------------------------------------------- #
class DiaryEntry(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="diary_entries")
    entry_date = models.DateField(default=date.today)
    created_at = models.DateTimeField(default=timezone.now)

    ringing_intensity = models.FloatField()
    pitch_shift = models.CharField(max_length=24, blank=True, default="")
    annoyance = models.FloatField(null=True, blank=True)
    stress_level = models.FloatField(null=True, blank=True)
    mood = models.CharField(max_length=24, blank=True, default="")
    sleep_hours = models.FloatField(null=True, blank=True)
    sleep_quality = models.FloatField(null=True, blank=True)
    medication_taken = models.BooleanField(null=True, blank=True)
    therapy_minutes = models.IntegerField(default=0)
    caffeine_units = models.FloatField(null=True, blank=True)
    alcohol_units = models.FloatField(null=True, blank=True)
    noise_exposure_minutes = models.IntegerField(null=True, blank=True)
    triggers = models.JSONField(default=list, blank=True)
    notes = models.TextField(blank=True, default="")

    class Meta:
        db_table = "diary_entries"
        ordering = ["entry_date"]
        constraints = [
            models.UniqueConstraint(fields=["patient", "entry_date"], name="uq_diary_patient_date")
        ]
        indexes = [models.Index(fields=["patient", "entry_date"], name="ix_diary_patient_date")]


class Alert(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="alerts", db_index=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    severity = models.CharField(
        max_length=16, choices=AlertSeverity.choices, default=AlertSeverity.WARNING, db_index=True
    )
    kind = models.CharField(max_length=64)
    title = models.CharField(max_length=160)
    detail = models.TextField()
    evidence = models.JSONField(default=dict, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    acknowledged_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True, related_name="acknowledged_alerts"
    )

    class Meta:
        db_table = "alerts"
        ordering = ["-created_at"]

    @property
    def urgency(self) -> str:
        """Red-flag alerts carry an explicit urgency; others fall back to severity.

        A critical alert must never default to routine, which is what an
        unqualified ``.get("urgency", "routine")`` would do for chat and diary
        alerts that have no urgency field of their own.
        """
        explicit = (self.evidence or {}).get("urgency")
        if explicit:
            return str(explicit)
        return {"critical": "urgent", "warning": "soon", "info": "routine"}.get(self.severity, "routine")


# --------------------------------------------------------------------------- #
# Engagement
# --------------------------------------------------------------------------- #
class ChatMessage(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="messages", db_index=True)
    created_at = models.DateTimeField(default=timezone.now)
    role = models.CharField(max_length=16)
    content = models.TextField()
    locale = models.CharField(max_length=12, default="en")
    intent = models.CharField(max_length=48, blank=True, default="")
    safety_flag = models.CharField(max_length=32, blank=True, default="")
    engine = models.CharField(max_length=24, blank=True, default="")

    class Meta:
        db_table = "chat_messages"
        ordering = ["created_at"]


class MedicationReminder(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="reminders", db_index=True)
    drug_name = models.CharField(max_length=96)
    dose = models.CharField(max_length=48, blank=True, default="")
    times_of_day = models.JSONField(default=list, blank=True)
    active = models.BooleanField(default=True)
    notes = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "medication_reminders"
        ordering = ["created_at"]


class ClinicianProfile(models.Model):
    """A clinician's bookable availability.

    Separate from ``User`` so the identity model stays about authentication. The
    working pattern is stored as a rule (which weekdays, which windows within a
    day, how long a slot is) rather than as materialised slot rows: a year of
    30-minute slots per clinician is ~4,000 rows that exist only to be mostly
    empty, and every change to the pattern would have to rewrite them. Slots are
    generated on demand and subtracted against real appointments.
    """

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="clinician_profile")
    specialization = models.CharField(max_length=96, blank=True, default="")
    qualifications = models.CharField(max_length=160, blank=True, default="")
    # Nullable rather than defaulting to 0: a profile that has not been filled in
    # is not a clinician with no experience, and a patient comparing doctors must
    # not be shown "0 years" for a missing value.
    years_experience = models.IntegerField(null=True, blank=True)
    bio = models.TextField(blank=True, default="")
    # Set false to take a clinician out of the patient-facing directory without
    # deleting them or disturbing their existing caseload.
    accepting_patients = models.BooleanField(default=True)

    # ISO weekday numbers, Monday = 1 … Sunday = 7, matching `date.isoweekday()`
    # so no off-by-one conversion is needed at the point of use.
    working_days = models.JSONField(default=list, blank=True)
    # [{"start": "09:00", "end": "13:00"}, …] — local wall-clock, in TIME_ZONE.
    working_hours = models.JSONField(default=list, blank=True)
    slot_minutes = models.IntegerField(default=30)
    # Longest a patient can book ahead. Stops a booking landing a year out where
    # nobody is looking at the calendar.
    booking_horizon_days = models.IntegerField(default=30)

    # Reused for appointments with no per-appointment link set.
    default_meeting_link = models.URLField(blank=True, default="")

    class Meta:
        db_table = "clinician_profiles"
        ordering = ["id"]

    def __str__(self) -> str:
        return f"{self.user.full_name} — {self.specialization or 'Audiology'}"


class Appointment(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="appointments", db_index=True)
    clinician = models.ForeignKey(User, on_delete=models.CASCADE, related_name="appointments", db_index=True)
    scheduled_for = models.DateTimeField(db_index=True)
    kind = models.CharField(max_length=48, default="follow_up")
    modality = models.CharField(max_length=24, default="teleaudiology")
    status = models.CharField(max_length=24, default="scheduled")
    notes = models.TextField(blank=True, default="")
    # Set by the clinician before the consultation. Blank means "not issued yet",
    # which the patient-facing screen reports rather than hiding.
    meeting_link = models.URLField(blank=True, default="")
    # -- cancellation ------------------------------------------------------- #
    # A cancelled consultation is *kept*, never deleted. The clinician needs to
    # see that a slot they were holding has been given back and why, and a
    # patient who cancels three times running is clinical information. `status`
    # already carries "cancelled"; these two carry the account of it.
    #
    # A blank reason is only reachable on rows cancelled before this field
    # existed - the cancel endpoint refuses an empty one.
    cancellation_reason = models.TextField(blank=True, default="")
    cancelled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "appointments"
        ordering = ["scheduled_for"]
        constraints = [
            # A clinician cannot be in two consultations at once. Enforced in the
            # database rather than only in the booking view, because two requests
            # arriving together both pass a "is this slot free?" read before
            # either writes. Cancelled slots are excluded so a cancellation
            # genuinely frees the time.
            models.UniqueConstraint(
                fields=["clinician", "scheduled_for"],
                condition=~models.Q(status="cancelled"),
                name="uniq_clinician_slot_active",
            )
        ]


class ClinicalNote(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="notes", db_index=True)
    clinician = models.ForeignKey(User, on_delete=models.CASCADE, related_name="notes")
    created_at = models.DateTimeField(default=timezone.now)
    body = models.TextField()
    icd11_codes = models.JSONField(default=list, blank=True)
    ai_draft = models.BooleanField(default=False)

    class Meta:
        db_table = "clinical_notes"
        ordering = ["-created_at"]


class RehabActivityLog(models.Model):
    """One rehabilitation activity, ticked off on one day.

    Deliberately *not* folded into `TherapySession`. A therapy session is a
    measured acoustic exposure — it carries a level, a duration, and before/after
    loudness ratings, and the adaptation engine reads those to decide what to
    prescribe next. A breathing exercise has none of that and must never be able
    to influence an acoustic dose. Two tables, two meanings.

    The unique constraint makes completion idempotent: tapping the same activity
    twice on the same day is a double-tap, not two sessions, and a streak that
    could be inflated by tapping is a streak nobody trusts.
    """

    patient = models.ForeignKey(
        Patient, on_delete=models.CASCADE, related_name="rehab_activities", db_index=True
    )
    # Matches a key in `services.rehabilitation.ACTIVITY_LIBRARY`. Stored as a
    # plain string rather than a FK so retiring an activity from the catalogue
    # never deletes a patient's history of having done it.
    activity_key = models.CharField(max_length=48)
    on_date = models.DateField(db_index=True)
    completed_at = models.DateTimeField(default=timezone.now)
    minutes = models.IntegerField(default=0)
    note = models.CharField(max_length=280, blank=True, default="")

    class Meta:
        db_table = "rehab_activity_log"
        ordering = ["-on_date", "-completed_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["patient", "activity_key", "on_date"],
                name="uniq_rehab_activity_per_day",
            )
        ]


class DailyCheckIn(models.Model):
    """One day's self-report during rehabilitation.

    The counterpart to `RehabActivityLog`: that records what the patient *did*,
    this records how they *were*. Both are needed to say anything useful about
    progress — adherence without symptoms cannot show benefit, and symptoms
    without adherence cannot attribute it.

    Every field is nullable on purpose. A patient who opens this at the end of a
    bad day and rates only their tinnitus has given something genuinely useful,
    and a form that refuses partial submission gets abandoned by exactly the
    people whose data matters most. One row per patient per day, so a correction
    overwrites rather than double-counting.

    **Visibility.** These rows are the patient's until they choose a clinician;
    once assigned, the clinician who is treating them can read them. That is
    enforced in the view layer against `Patient.clinician`, not here — the model
    stores, the permission layer decides who reads.
    """

    patient = models.ForeignKey(
        Patient, on_delete=models.CASCADE, related_name="check_ins", db_index=True
    )
    on_date = models.DateField(db_index=True)
    recorded_at = models.DateTimeField(default=timezone.now)

    # 0-10 visual analogue scales, the same anchors the assessment VAS uses so
    # a daily rating is comparable with the assessment it started from.
    tinnitus_loudness = models.FloatField(null=True, blank=True)
    tinnitus_annoyance = models.FloatField(null=True, blank=True)
    sleep_quality = models.FloatField(null=True, blank=True)
    stress_level = models.FloatField(null=True, blank=True)
    mood = models.FloatField(null=True, blank=True)

    note = models.CharField(max_length=500, blank=True, default="")

    class Meta:
        db_table = "daily_check_ins"
        ordering = ["-on_date"]
        constraints = [
            models.UniqueConstraint(fields=["patient", "on_date"], name="uniq_checkin_per_day")
        ]


class AuditLog(models.Model):
    at = models.DateTimeField(default=timezone.now, db_index=True)
    actor = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    action = models.CharField(max_length=64)
    entity = models.CharField(max_length=48, blank=True, default="")
    entity_id = models.IntegerField(null=True, blank=True)
    meta = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "audit_log"
        ordering = ["-at"]


# --------------------------------------------------------------------------- #
# Community & Location
# --------------------------------------------------------------------------- #
class Community(models.Model):
    name = models.CharField(max_length=255)
    country = models.CharField(max_length=100, db_index=True)
    state = models.CharField(max_length=100, db_index=True)
    city = models.CharField(max_length=100, db_index=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "communities"
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["country", "state", "city"], name="unique_community_location"
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.city}, {self.state}, {self.country})"


class CommunityPost(models.Model):
    community = models.ForeignKey(
        Community, on_delete=models.CASCADE, related_name="posts", db_index=True
    )
    author = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="community_posts", db_index=True
    )
    content = models.TextField()
    likes = models.ManyToManyField(
        User, related_name="liked_community_posts", blank=True
    )
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "community_posts"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Post #{self.id} by {self.author.full_name} in {self.community.name}"


class CommunityComment(models.Model):
    post = models.ForeignKey(
        CommunityPost, on_delete=models.CASCADE, related_name="comments", db_index=True
    )
    author = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="community_comments", db_index=True
    )
    parent = models.ForeignKey(
        "self", on_delete=models.CASCADE, null=True, blank=True, related_name="replies", db_index=True
    )
    content = models.TextField()
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "community_comments"
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"Comment #{self.id} on Post #{self.post_id}"


class CommunityChatMessage(models.Model):
    community = models.ForeignKey(
        Community, on_delete=models.CASCADE, related_name="chat_messages", db_index=True
    )
    sender = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="community_chat_messages", db_index=True
    )
    content = models.TextField()
    read_by = models.ManyToManyField(
        User, related_name="read_community_chat_messages", blank=True
    )
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "community_chat_messages"
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"Chat #{self.id} in {self.community.name}"


# --------------------------------------------------------------------------- #
# Group Therapy
# --------------------------------------------------------------------------- #
class GroupTherapySession(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        ENDED = "ended", "Ended"

    class Activity(models.TextChoices):
        BREATHING = "breathing", "Breathing & Soundscape"
        MOOD_CHECKIN = "mood_checkin", "Mood & Distress Check-in"
        REFLECTION_PROMPT = "reflection_prompt", "Reflection Prompt"
        GRATITUDE_WALL = "gratitude_wall", "Gratitude Wall"

    host = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="hosted_group_sessions", db_index=True
    )
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True, default="")
    meet_url = models.URLField(max_length=500, blank=True, default="")
    invite_code = models.CharField(max_length=10, unique=True, db_index=True)
    max_participants = models.IntegerField(default=10)
    participants = models.ManyToManyField(
        User, related_name="joined_group_sessions", blank=True
    )
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.ACTIVE, db_index=True
    )
    current_activity = models.CharField(
        max_length=32, choices=Activity.choices, default=Activity.BREATHING
    )
    activity_data = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "group_therapy_sessions"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Group Session '{self.title}' ({self.invite_code}) by {self.host.full_name}"


class GroupTherapyMessage(models.Model):
    class MessageType(models.TextChoices):
        CHAT = "chat", "Chat"
        FEELING_EMOJI = "feeling_emoji", "Feeling Emoji"
        SYSTEM = "system", "System"

    session = models.ForeignKey(
        GroupTherapySession, on_delete=models.CASCADE, related_name="messages", db_index=True
    )
    sender = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="group_therapy_messages", db_index=True
    )
    content = models.TextField()
    emoji_reaction = models.CharField(max_length=20, blank=True, default="")
    message_type = models.CharField(
        max_length=16, choices=MessageType.choices, default=MessageType.CHAT
    )
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "group_therapy_messages"
        ordering = ["created_at"]

    def __str__(self) -> str:
        return f"Message #{self.id} in Session {self.session.invite_code}"


class GroupTherapyActivityResponse(models.Model):
    session = models.ForeignKey(
        GroupTherapySession, on_delete=models.CASCADE, related_name="activity_responses", db_index=True
    )
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="group_activity_responses", db_index=True
    )
    activity_type = models.CharField(max_length=32, db_index=True)
    response_data = models.JSONField(default=dict)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "group_therapy_activity_responses"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Activity Response by {self.user.full_name} for {self.activity_type}"


class GroupTherapyJoinRequest(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"

    session = models.ForeignKey(
        GroupTherapySession, on_delete=models.CASCADE, related_name="join_requests", db_index=True
    )
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="group_therapy_join_requests", db_index=True
    )
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        db_table = "group_therapy_join_requests"
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Join Request by {self.user.full_name} for Session {self.session.invite_code} ({self.status})"





"""DRF serializers.

Instrument item banks and audiograms are open ``JSONField``s on purpose: their
shape is defined by the versioned instrument registry in ``clinical.instruments``,
and duplicating a 25-item bank as 25 declared fields would guarantee the two drift
apart. Everything with clinical meaning outside those payloads is typed and
range-validated, because an out-of-range threshold silently accepted is a wrong
audiogram.
"""

from __future__ import annotations

from typing import Any

from django.contrib.auth.password_validation import validate_password
from django.db import models
from rest_framework import serializers

from .models import (
    Alert,
    Appointment,
    Assessment,
    ClinicalNote,
    Community,
    CommunityComment,
    CommunityChatMessage,
    CommunityPost,
    DiaryEntry,
    Ear,
    GroupTherapySession,
    GroupTherapyMessage,
    GroupTherapyActivityResponse,
    GroupTherapyJoinRequest,
    MedicationReminder,
    Patient,
    TherapyPrescription,
    TherapySession,
    User,
)


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)


class RegisterSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=8, trim_whitespace=False)
    full_name = serializers.CharField(min_length=2, max_length=160)
    role = serializers.ChoiceField(choices=["patient", "clinician"], default="patient")
    locale = serializers.CharField(max_length=12, default="en")
    country = serializers.CharField(max_length=100, required=False, allow_blank=True, default="")
    state = serializers.CharField(max_length=100, required=False, allow_blank=True, default="")
    city = serializers.CharField(max_length=100, required=False, allow_blank=True, default="")
    date_of_birth = serializers.DateField(required=True, allow_null=False)
    sex = serializers.ChoiceField(
        choices=["male", "female", "other", "prefer_not_to_say"], required=True, allow_null=False
    )

    def to_internal_value(self, data):
        if isinstance(data, dict):
            data = data.copy()
            if data.get("date_of_birth") == "":
                data["date_of_birth"] = None
            if data.get("sex") == "":
                data["sex"] = None
        return super().to_internal_value(data)

    def validate_email(self, value: str) -> str:
        if User.objects.filter(email=value.lower()).exists():
            raise serializers.ValidationError("An account with that email already exists.")
        return value.lower()

    def validate_password(self, value: str) -> str:
        validate_password(value)
        return value


# --------------------------------------------------------------------------- #
# Patient
# --------------------------------------------------------------------------- #
class PatientSerializer(serializers.ModelSerializer):
    full_name = serializers.CharField(source="user.full_name", read_only=True)
    email = serializers.EmailField(source="user.email", read_only=True)
    clinician_name = serializers.SerializerMethodField()
    age = serializers.IntegerField(read_only=True)
    duration_months = serializers.FloatField(read_only=True)
    has_saved_calibration = serializers.SerializerMethodField()

    class Meta:
        model = Patient
        fields = [
            "id", "mrn", "full_name", "email", "date_of_birth", "age", "sex", "phone",
            "onset_date", "duration_months", "tinnitus_character", "tinnitus_characters", "laterality",
            "pulsatile", "somatic_modulation", "hyperacusis", "hearing_aid_use",
            "noise_exposure_years", "comorbidities", "medications", "etiology_notes",
            "about_you", "consent_research", "clinician_id", "clinician_name",
            "has_saved_calibration", "saved_device_profile",
        ]
        read_only_fields = ["id", "mrn", "clinician_id", "saved_device_profile"]

    def get_clinician_name(self, obj: Patient) -> str | None:
        return obj.clinician.full_name if obj.clinician else None

    def get_has_saved_calibration(self, obj: Patient) -> bool:
        return bool((obj.saved_device_profile or {}).get("calibrated_at"))


class PatientProfileUpdateSerializer(serializers.ModelSerializer):
    laterality = serializers.ChoiceField(choices=Ear.choices, required=False, allow_blank=True)
    tinnitus_characters = serializers.ListField(
        # `allow_blank` so a stray empty entry is *cleaned* rather than rejecting
        # the whole submission — the validator below drops it. A form that
        # refuses the entire answer because one hidden entry was whitespace is
        # not validation, it is a dead end the patient cannot diagnose.
        child=serializers.CharField(max_length=48, allow_blank=True),
        required=False,
        allow_empty=True,
    )
    # The extended About You questionnaire. Unvalidated per-item, the same as
    # `thi_items` on `Assessment` — the option lists that constrain each answer
    # live in the frontend's question registry, not duplicated here as a second
    # schema that the two would have to be kept in step with by hand.
    about_you = serializers.DictField(required=False)

    def validate_tinnitus_characters(self, value: list[str]) -> list[str]:
        """De-duplicate, trim, and cap. Order is the patient's own.

        Kept order-significant because the first entry becomes the primary
        character, and the patient tapping "Ringing" first is a statement about
        which sound dominates.
        """
        seen: list[str] = []
        for raw in value:
            item = (raw or "").strip()
            if item and item not in seen:
                seen.append(item)
        return seen[:10]

    def update(self, instance, validated_data):
        """Keep the primary character in step with the set.

        Everything downstream — the report narrative, the analysis payload, the
        feature vector — reads `tinnitus_character`. Deriving it here rather than
        asking the client to send both consistently means the two cannot drift:
        there is one place that decides what "primary" means.
        """
        characters = validated_data.get("tinnitus_characters")
        if characters is not None:
            validated_data["tinnitus_character"] = characters[0] if characters else ""

        about_you = validated_data.get("about_you")
        if about_you is not None:
            self._sync_about_you(about_you, validated_data)

        return super().update(instance, validated_data)

    def _sync_about_you(self, about_you: dict, validated_data: dict) -> None:
        """Mirror a handful of About You answers onto the discrete fields the
        rest of the system already reads.

        Only three answers are mirrored, and each exists for a concrete reason:

        * **Pulsatile** (Section 6) drives `Patient.pulsatile`, which
          `clinical.redflags.evaluate_red_flags` already checks to raise an
          *urgent* referral for vascular imaging. About You is the only place
          this question is asked now — folding its answer into the same
          boolean the existing rule reads means that rule keeps working
          unchanged rather than needing a second copy of it that reads
          `about_you` instead. Only a literal "Yes" sets it True and only a
          literal "No" sets it False; "I'm not sure" leaves the field as it
          was, because collapsing genuine uncertainty into "no" would suppress
          a flag that should fire, and collapsing it into "yes" would raise
          one on a patient who did not report the symptom.
        * **Somatic modulation** (Section 12, "does movement affect your
          tinnitus?") is asked as five separate movement types rather than the
          existing form's one checkbox. A "Yes" to *any* of them sets
          `somatic_modulation` True — OR'd with whatever the checkbox already
          contributed in the same payload, so neither can suppress a true
          positive reported through the other control.
        * **Comorbidities** (Section 16) and **medications** (Section 18) are
          *merged into*, not replacing, the existing lists the History
          disclosure and the medications textarea already write — so a
          clinician reading `comorbidities`/`medications` sees the union of
          both entry points, and the substring-matching neuro red-flag rules
          keep seeing every term they already saw.

        Everything else in `about_you` is stored verbatim and read nowhere
        else; this function only touches the fields that already had a reader
        before About You existed.
        """
        pulsatile_answer = about_you.get("pulsatile_beats_with_heart")
        if pulsatile_answer == "Yes":
            validated_data["pulsatile"] = True
        elif pulsatile_answer == "No":
            validated_data["pulsatile"] = False

        movement_keys = (
            "movement_head_neck", "movement_jaw", "movement_touch",
            "movement_body_position", "movement_exercise",
        )
        # Only ever sets True here, never False — a movement answer of "No" or
        # "I'm not sure" must not erase a positive the checkbox already sent in
        # the same payload, so this branch is additive-only.
        if any(about_you.get(k) == "Yes" for k in movement_keys):
            validated_data["somatic_modulation"] = True

        section16 = about_you.get("medical_conditions_select")
        if isinstance(section16, list) and section16:
            existing = list(validated_data.get("comorbidities", self.instance.comorbidities) or [])
            validated_data["comorbidities"] = existing + [c for c in section16 if c not in existing]

        detailed_meds = about_you.get("medications_detailed")
        if isinstance(detailed_meds, list) and detailed_meds:
            formatted = []
            for entry in detailed_meds:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or "").strip()
                if not name:
                    continue
                dose = str(entry.get("dose") or "").strip()
                frequency = str(entry.get("frequency") or "").strip()
                label = name
                if dose:
                    label += f" {dose}"
                if frequency:
                    label += f" — {frequency}"
                formatted.append(label)
            if formatted:
                existing = list(validated_data.get("medications", self.instance.medications) or [])
                validated_data["medications"] = existing + [m for m in formatted if m not in existing]

    class Meta:
        model = Patient
        fields = [
            "date_of_birth", "sex", "phone", "onset_date", "tinnitus_character", "tinnitus_characters", "laterality",
            "pulsatile", "somatic_modulation", "hyperacusis", "hearing_aid_use",
            "noise_exposure_years", "comorbidities", "medications", "etiology_notes",
            "about_you", "consent_research",
        ]
        extra_kwargs = {
            "noise_exposure_years": {"min_value": 0, "max_value": 80},
            "sex": {"required": False, "allow_blank": True},
            "phone": {"required": False, "allow_blank": True},
            "tinnitus_character": {"required": False, "allow_blank": True},
            "etiology_notes": {"required": False, "allow_blank": True},
        }


# --------------------------------------------------------------------------- #
# Assessment
# --------------------------------------------------------------------------- #
class AssessmentSerializer(serializers.ModelSerializer):
    """Read-only projection of the stored record — writes go through
    `AssessmentSubmitSerializer`, which validates ranges."""

    patient_id = serializers.IntegerField(read_only=True)

    class Meta:
        model = Assessment
        exclude = ["patient"]


class AssessmentSubmitSerializer(serializers.Serializer):
    """A whole or partial assessment.

    Every module is optional so the flow can be saved and resumed, and a patient who
    completes only the questionnaires still gets scored.
    """

    modules_done = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    device_profile = serializers.DictField(required=False)
    save_calibration = serializers.BooleanField(required=False, default=False)

    audiogram = serializers.DictField(required=False)

    # The hearing test's own reliability verdict, submitted alongside the
    # thresholds it qualifies. Bounded rather than free-form so a client cannot
    # post a retest disagreement of 900 dB.
    audiometry_reliable = serializers.BooleanField(required=False, allow_null=True)
    audiometry_notes = serializers.ListField(child=serializers.CharField(), required=False)
    audiometry_false_positives = serializers.IntegerField(required=False, allow_null=True, min_value=0, max_value=200)
    audiometry_catch_trials = serializers.IntegerField(required=False, allow_null=True, min_value=0, max_value=200)
    audiometry_retest_agreement_db = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=130)

    pitch_match_hz = serializers.FloatField(required=False, allow_null=True, min_value=50, max_value=20000)
    pitch_match_ear = serializers.ChoiceField(choices=Ear.choices, required=False, allow_blank=True)
    pitch_match_confidence = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=1)
    octave_confusion = serializers.BooleanField(required=False, allow_null=True)
    pitch_match_trace = serializers.ListField(required=False)

    pitch_match_sound_description = serializers.ChoiceField(
        choices=["Ringing", "Whistling", "Buzzing", "Hissing", "Other", "Not sure"],
        required=False,
        allow_blank=True,
    )
    pitch_match_sound_other_text = serializers.CharField(required=False, allow_blank=True, max_length=200)
    pitch_match_initial_level_db = serializers.FloatField(required=False, allow_null=True, min_value=-10, max_value=100)
    pitch_match_comfort_level_db = serializers.FloatField(required=False, allow_null=True, min_value=-10, max_value=100)
    pitch_match_not_sure_count = serializers.IntegerField(required=False, allow_null=True, min_value=0, max_value=100)
    pitch_match_octave_frequency_hz = serializers.FloatField(required=False, allow_null=True, min_value=50, max_value=20000)
    pitch_match_octave_response = serializers.ChoiceField(
        choices=["matched", "octave_higher", "not_sure"], required=False, allow_blank=True
    )
    pitch_match_confirmation = serializers.ChoiceField(
        choices=["very_similar", "somewhat_similar", "not_similar"], required=False, allow_blank=True
    )
    pitch_match_repeated = serializers.BooleanField(required=False)

    loudness_match_db_sl = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=80)
    loudness_match_db_hl = serializers.FloatField(required=False, allow_null=True, min_value=-10, max_value=130)
    loudness_match_starting_level_db = serializers.FloatField(required=False, allow_null=True, min_value=-10, max_value=130)
    loudness_match_trace = serializers.ListField(required=False)
    loudness_match_confirmation = serializers.ChoiceField(
        choices=["very_similar", "somewhat_similar"], required=False, allow_blank=True
    )
    loudness_match_repeated = serializers.BooleanField(required=False)
    mml_db_sl = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=90)
    # Bounded to the band the audiometer can actually deliver a masker in.
    mml_masker_hz = serializers.FloatField(required=False, allow_null=True, min_value=50, max_value=20000)
    # The patient's own answer after the masker stops. Constrained rather than
    # free text so it can be counted across a cohort.
    ri_reported_category = serializers.ChoiceField(
        choices=["none", "partial", "complete"], required=False, allow_blank=True
    )
    ri_depth_pct = serializers.FloatField(required=False, allow_null=True, min_value=-100, max_value=100)
    ri_duration_s = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=1800)
    ri_trace = serializers.ListField(required=False)
    tinnitus_bandwidth = serializers.ChoiceField(
        choices=["tonal", "narrowband", "broadband"], required=False, allow_blank=True
    )
    ldl_left = serializers.FloatField(required=False, allow_null=True, min_value=40, max_value=130)
    ldl_right = serializers.FloatField(required=False, allow_null=True, min_value=40, max_value=130)
    # The complete multi-frequency, multi-ear Sound Tolerance trial history —
    # additive to `ldl_left`/`ldl_right` above.
    ldl_trace = serializers.ListField(required=False)
    ldl_repeated = serializers.BooleanField(required=False)
    # The structured 4-way immediate response — additive to
    # `ri_reported_category` above, which has no "louder" option.
    ri_immediate_response = serializers.ChoiceField(
        choices=["COMPLETELY_ABSENT", "REDUCED", "NO_CHANGE", "LOUDER"], required=False, allow_blank=True
    )
    ri_baseline_pct = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=100)
    ri_post_stimulation_pct = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=100)
    ri_monitoring = serializers.ListField(required=False)
    ri_stimulus_frequency_hz = serializers.FloatField(required=False, allow_null=True, min_value=50, max_value=20000)
    ri_stimulus_level_db = serializers.FloatField(required=False, allow_null=True, min_value=-10, max_value=130)
    ri_stimulation_duration_s = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=600)
    ri_stimulation_started_at = serializers.IntegerField(required=False, allow_null=True)
    ri_stimulation_stopped_at = serializers.IntegerField(required=False, allow_null=True)
    ri_reduction_detected_at = serializers.IntegerField(required=False, allow_null=True)
    ri_return_to_baseline_at = serializers.IntegerField(required=False, allow_null=True)
    ri_repeated = serializers.BooleanField(required=False)

    # {"250": 28.0, ...} — the per-frequency minimum masking level. Bounds are
    # checked in the view against the same range the audiometer can deliver;
    # a DictField here keeps the frequency set open, which is the point of
    # storing it as a map rather than as columns.
    masking_thresholds = serializers.DictField(
        child=serializers.FloatField(min_value=-20, max_value=130), required=False
    )
    masking_unmasked_hz = serializers.ListField(
        child=serializers.FloatField(min_value=20, max_value=20000), required=False
    )
    masking_trace = serializers.ListField(required=False)
    masking_not_sure_count = serializers.IntegerField(required=False, allow_null=True, min_value=0, max_value=200)
    masking_repeated = serializers.BooleanField(required=False)
    # `reference_level_db` / `_hz` are deliberately absent. They are derived
    # server-side from the thresholds above — see `assessment_save` — so that a
    # client cannot submit a summary that disagrees with the data it summarises.

    thi_items = serializers.DictField(required=False)
    tfi_items = serializers.DictField(required=False)
    isi_items = serializers.DictField(required=False)
    vas = serializers.DictField(required=False)
    # The pain/discomfort faces scale, asked after the four tinnitus VAS
    # scales and stored in its own field - never inside `vas`, whose four keys
    # are the tinnitus severity block the algorithm scores.
    vas_pain = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=10)
    psqi_items = serializers.DictField(required=False)
    pss10_items = serializers.DictField(required=False)
    pss4_items = serializers.DictField(required=False)
    gad7_items = serializers.DictField(required=False)
    gad2_items = serializers.DictField(required=False)
    phq2_items = serializers.DictField(required=False)
    phq9_items = serializers.DictField(required=False)
    # The PHQ-9's separate, non-scored functional-difficulty item — never
    # folded into the 0-27 symptom total.
    phq9_functional_difficulty = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=4)
    whoqol_bref_items = serializers.DictField(required=False)
    sleep_screen_items = serializers.DictField(required=False)
    # Per-instrument status for the About Your Tinnitus module's skip feature —
    # {"thi": "completed"} or {"gad7": "skipped"}. Merged onto the stored dict,
    # never replacing it, so completing one instrument cannot erase another's
    # recorded skip.
    questionnaire_status = serializers.DictField(
        child=serializers.ChoiceField(choices=["not_started", "in_progress", "completed", "skipped"]),
        required=False,
    )
    # Which indicated long forms were completed, and which the patient deferred.
    # Recorded so an absent long-form score can be read as "declined, still
    # recommended" rather than "screened negative".
    escalated_instruments = serializers.ListField(
        child=serializers.CharField(max_length=32), required=False
    )
    deferred_instruments = serializers.ListField(
        child=serializers.CharField(max_length=32), required=False
    )

    def validate_audiogram(self, value: dict) -> dict:
        for ear, thresholds in value.items():
            if ear not in {"left", "right"}:
                raise serializers.ValidationError("Keys must be 'left' or 'right'.")
            if not isinstance(thresholds, dict):
                raise serializers.ValidationError(f"'{ear}' must be a frequency map.")
            for freq, level in thresholds.items():
                try:
                    f = float(freq)
                    db = float(level)
                except (TypeError, ValueError):
                    raise serializers.ValidationError(
                        f"Non-numeric entry at {ear} {freq} Hz."
                    ) from None
                if not 100 <= f <= 20000:
                    raise serializers.ValidationError(f"Frequency {f} Hz is out of range.")
                if not -20 <= db <= 130:
                    raise serializers.ValidationError(
                        f"Threshold {db} dB HL at {f} Hz is out of range."
                    )
        return value


# --------------------------------------------------------------------------- #
# Diary
# --------------------------------------------------------------------------- #
class DiarySerializer(serializers.ModelSerializer):
    class Meta:
        model = DiaryEntry
        exclude = ["patient"]
        extra_kwargs = {
            "entry_date": {"required": False},
            "ringing_intensity": {"min_value": 0, "max_value": 10},
            "annoyance": {"min_value": 0, "max_value": 10},
            "stress_level": {"min_value": 0, "max_value": 10},
            "sleep_hours": {"min_value": 0, "max_value": 24},
            "sleep_quality": {"min_value": 0, "max_value": 10},
            "therapy_minutes": {"min_value": 0, "max_value": 1440},
            "caffeine_units": {"min_value": 0, "max_value": 30},
            "alcohol_units": {"min_value": 0, "max_value": 60},
            "noise_exposure_minutes": {"min_value": 0, "max_value": 1440},
        }


# --------------------------------------------------------------------------- #
# Therapy
# --------------------------------------------------------------------------- #
class PrescriptionSerializer(serializers.ModelSerializer):
    approved_by_id = serializers.IntegerField(read_only=True, allow_null=True)

    class Meta:
        model = TherapyPrescription
        fields = [
            "id", "patient_id", "assessment_id", "created_at", "revision", "active",
            "generated_by", "approved_by_id", "program", "daily_minutes_target",
            "rationale", "guardrails", "review_after_days",
        ]


class TherapySessionSerializer(serializers.ModelSerializer):
    relief_delta = serializers.FloatField(read_only=True)
    prescription_id = serializers.IntegerField(required=False, allow_null=True)

    class Meta:
        model = TherapySession
        exclude = ["patient", "prescription"]
        extra_kwargs = {
            "planned_seconds": {"min_value": 0, "max_value": 28800},
            "actual_seconds": {"min_value": 0, "max_value": 28800},
            "pre_vas_loudness": {"min_value": 0, "max_value": 10},
            "post_vas_loudness": {"min_value": 0, "max_value": 10},
            "pre_vas_annoyance": {"min_value": 0, "max_value": 10},
            "post_vas_annoyance": {"min_value": 0, "max_value": 10},
            "residual_inhibition_s": {"min_value": 0, "max_value": 3600},
        }


# --------------------------------------------------------------------------- #
# Chat
# --------------------------------------------------------------------------- #
class ChatRequestSerializer(serializers.Serializer):
    message = serializers.CharField(min_length=1, max_length=4000, trim_whitespace=True)
    locale = serializers.CharField(max_length=12, default="en")


# --------------------------------------------------------------------------- #
# Engagement
# --------------------------------------------------------------------------- #
class MedicationReminderSerializer(serializers.ModelSerializer):
    class Meta:
        model = MedicationReminder
        exclude = ["patient"]


class AppointmentSerializer(serializers.ModelSerializer):
    patient_name = serializers.SerializerMethodField()

    class Meta:
        model = Appointment
        fields = [
            "id", "patient_id", "clinician_id", "scheduled_for", "kind", "modality",
            "status", "notes", "patient_name",
        ]
        read_only_fields = ["clinician_id", "status"]

    def get_patient_name(self, obj: Appointment) -> str | None:
        return obj.patient.user.full_name if obj.patient_id else None


class ClinicalNoteSerializer(serializers.ModelSerializer):
    patient_id = serializers.IntegerField()

    class Meta:
        model = ClinicalNote
        fields = ["id", "patient_id", "clinician_id", "created_at", "body", "icd11_codes", "ai_draft"]
        read_only_fields = ["clinician_id", "created_at"]


class AlertSerializer(serializers.ModelSerializer):
    patient_name = serializers.SerializerMethodField()
    patient_mrn = serializers.CharField(source="patient.mrn", read_only=True)
    urgency = serializers.CharField(read_only=True)

    class Meta:
        model = Alert
        fields = [
            "id", "patient_id", "created_at", "severity", "kind", "title", "detail",
            "evidence", "acknowledged_at", "patient_name", "patient_mrn", "urgency",
        ]

    def get_patient_name(self, obj: Alert) -> str | None:
        return obj.patient.user.full_name if obj.patient_id else None


class WhatIfSerializer(serializers.Serializer):
    """Only clinically modifiable fields may be overridden in a counterfactual."""

    ALLOWED = {
        "thi_score", "psqi_score", "pss10_score", "gad7_score", "phq2_score",
        "vas_loudness", "vas_annoyance", "vas_awareness", "vas_sleep_interference",
        "mml_db_sl", "loudness_match_db_sl", "ri_depth_pct",
    }

    def to_internal_value(self, data: Any) -> dict[str, float]:
        if not isinstance(data, dict) or not data:
            raise serializers.ValidationError("Provide at least one field to override.")
        rejected = set(data) - self.ALLOWED
        if rejected:
            raise serializers.ValidationError(
                f"Only modifiable clinical fields can be overridden. Rejected: {sorted(rejected)}"
            )
        out: dict[str, float] = {}
        for key, value in data.items():
            try:
                out[key] = float(value)
            except (TypeError, ValueError):
                raise serializers.ValidationError({key: "Must be numeric."}) from None
        return out


# --------------------------------------------------------------------------- #
# Community
# --------------------------------------------------------------------------- #
class LocationUpdateSerializer(serializers.Serializer):
    country = serializers.CharField(max_length=100)
    state = serializers.CharField(max_length=100)
    city = serializers.CharField(max_length=100)

    def validate(self, attrs):
        for field in ["country", "state", "city"]:
            val = attrs.get(field, "").strip()
            if not val:
                raise serializers.ValidationError({field: f"{field.capitalize()} is required."})
            attrs[field] = val
        return attrs


class CommunitySerializer(serializers.ModelSerializer):
    member_count = serializers.SerializerMethodField()
    online_count = serializers.SerializerMethodField()

    class Meta:
        model = Community
        fields = ["id", "name", "country", "state", "city", "created_at", "member_count", "online_count"]

    def get_member_count(self, obj: Community) -> int:
        return obj.members.filter(is_active=True).count()

    def get_online_count(self, obj: Community) -> int:
        from datetime import timedelta
        from django.utils import timezone

        five_mins_ago = timezone.now() - timedelta(minutes=5)
        cnt = obj.members.filter(is_active=True, joined_community=True, last_login__gte=five_mins_ago).count()
        return max(1, cnt)


class CommunityCommentSerializer(serializers.ModelSerializer):
    author_name = serializers.SerializerMethodField()
    is_own_comment = serializers.SerializerMethodField()
    replies = serializers.SerializerMethodField()

    class Meta:
        model = CommunityComment
        fields = ["id", "post_id", "parent_id", "author_name", "content", "created_at", "is_own_comment", "replies"]

    def get_author_name(self, obj: CommunityComment) -> str:
        return obj.author.full_name or "Community Member"

    def get_is_own_comment(self, obj: CommunityComment) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.author_id == request.user.id
        return False

    def get_replies(self, obj: CommunityComment) -> list[dict[str, Any]]:
        # Single-level nesting for replies
        if obj.parent_id is not None:
            return []
        replies = obj.replies.all().order_by("created_at")
        return CommunityCommentSerializer(replies, many=True, context=self.context).data


class CommunityPostSerializer(serializers.ModelSerializer):
    author_name = serializers.SerializerMethodField()
    is_own_post = serializers.SerializerMethodField()
    likes_count = serializers.SerializerMethodField()
    is_liked_by_me = serializers.SerializerMethodField()
    comments_count = serializers.SerializerMethodField()
    comments = serializers.SerializerMethodField()

    class Meta:
        model = CommunityPost
        fields = [
            "id",
            "community_id",
            "author_name",
            "content",
            "created_at",
            "updated_at",
            "is_own_post",
            "likes_count",
            "is_liked_by_me",
            "comments_count",
            "comments",
        ]

    def get_author_name(self, obj: CommunityPost) -> str:
        return obj.author.full_name or "Community Member"

    def get_is_own_post(self, obj: CommunityPost) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.author_id == request.user.id
        return False

    def get_likes_count(self, obj: CommunityPost) -> int:
        return obj.likes.count()

    def get_is_liked_by_me(self, obj: CommunityPost) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.likes.filter(id=request.user.id).exists()
        return False

    def get_comments_count(self, obj: CommunityPost) -> int:
        return obj.comments.count()

    def get_comments(self, obj: CommunityPost) -> list[dict[str, Any]]:
        top_comments = obj.comments.filter(parent=None).order_by("created_at")
        return CommunityCommentSerializer(top_comments, many=True, context=self.context).data


class CommunityPostCreateSerializer(serializers.Serializer):
    content = serializers.CharField(min_length=1, max_length=2000, trim_whitespace=True)


class CommunityChatMessageSerializer(serializers.ModelSerializer):
    sender_name = serializers.SerializerMethodField()
    is_own_message = serializers.SerializerMethodField()
    read_by_count = serializers.SerializerMethodField()
    read_by_members = serializers.SerializerMethodField()
    unread_members = serializers.SerializerMethodField()

    class Meta:
        model = CommunityChatMessage
        fields = [
            "id",
            "community_id",
            "sender_name",
            "content",
            "created_at",
            "is_own_message",
            "read_by_count",
            "read_by_members",
            "unread_members",
        ]

    def get_sender_name(self, obj: CommunityChatMessage) -> str:
        return obj.sender.full_name or "Community Member"

    def get_is_own_message(self, obj: CommunityChatMessage) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.sender_id == request.user.id
        return False

    def get_read_by_count(self, obj: CommunityChatMessage) -> int:
        return obj.read_by.count()

    def get_read_by_members(self, obj: CommunityChatMessage) -> list[str]:
        request = self.context.get("request")
        current_user = request.user if request and getattr(request, "user", None) and request.user.is_authenticated else None
        
        all_members = list(
            # `is_active` alone was the wrong test, and it is what produced the
            # wall of names nobody recognised. A community is assigned from a
            # user's city, so every account registered in that city belongs to
            # it whether or not they ever opened the chat — "Not read yet" was
            # listing the city's whole population. `joined_community` is the
            # opt-in the Community screen asks for before it shows anyone the
            # feed or the chatbox, so filtering on it makes this list what it
            # claims to be: the people actually present in the conversation.
            obj.community.members.filter(is_active=True, joined_community=True)
            .filter(
                # Present in the conversation, not merely enrolled in the city.
                # Joining the community is the opt-in that grants access to the
                # chat; having sent or read a message is evidence of actually
                # being in it. Without this second test the list was every
                # account registered in the city, most of whom had never opened
                # the room — which is what made "Not read yet" read as a page of
                # invented names.
                models.Q(community_chat_messages__community=obj.community)
                | models.Q(read_community_chat_messages__community=obj.community)
            )
            .distinct()
            .order_by("id")
        )
        read_ids = set(obj.read_by.values_list("id", flat=True))
        read_ids.add(obj.sender_id)
        
        out = []
        for m in all_members:
            if m.id in read_ids:
                if current_user and m.id == current_user.id:
                    out.append(f"You ({m.full_name})")
                else:
                    out.append(m.full_name)
        return out

    def get_unread_members(self, obj: CommunityChatMessage) -> list[str]:
        request = self.context.get("request")
        current_user = request.user if request and getattr(request, "user", None) and request.user.is_authenticated else None

        all_members = list(
            # `is_active` alone was the wrong test, and it is what produced the
            # wall of names nobody recognised. A community is assigned from a
            # user's city, so every account registered in that city belongs to
            # it whether or not they ever opened the chat — "Not read yet" was
            # listing the city's whole population. `joined_community` is the
            # opt-in the Community screen asks for before it shows anyone the
            # feed or the chatbox, so filtering on it makes this list what it
            # claims to be: the people actually present in the conversation.
            obj.community.members.filter(is_active=True, joined_community=True)
            .filter(
                # Present in the conversation, not merely enrolled in the city.
                # Joining the community is the opt-in that grants access to the
                # chat; having sent or read a message is evidence of actually
                # being in it. Without this second test the list was every
                # account registered in the city, most of whom had never opened
                # the room — which is what made "Not read yet" read as a page of
                # invented names.
                models.Q(community_chat_messages__community=obj.community)
                | models.Q(read_community_chat_messages__community=obj.community)
            )
            .distinct()
            .order_by("id")
        )
        read_ids = set(obj.read_by.values_list("id", flat=True))
        read_ids.add(obj.sender_id)

        out = []
        for m in all_members:
            if m.id not in read_ids:
                if current_user and m.id == current_user.id:
                    out.append(f"You ({m.full_name})")
                else:
                    out.append(m.full_name)
        return out


# --------------------------------------------------------------------------- #
# Group Therapy
# --------------------------------------------------------------------------- #
class GroupTherapySessionSerializer(serializers.ModelSerializer):
    host_name = serializers.SerializerMethodField()
    is_host = serializers.SerializerMethodField()
    participant_count = serializers.SerializerMethodField()
    is_participant = serializers.SerializerMethodField()

    class Meta:
        model = GroupTherapySession
        fields = [
            "id",
            "host_id",
            "host_name",
            "is_host",
            "title",
            "description",
            "meet_url",
            "invite_code",
            "max_participants",
            "participant_count",
            "is_participant",
            "status",
            "current_activity",
            "activity_data",
            "created_at",
        ]

    def get_host_name(self, obj: GroupTherapySession) -> str:
        return obj.host.full_name or "Patient Host"

    def get_is_host(self, obj: GroupTherapySession) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.host_id == request.user.id
        return False

    def get_participant_count(self, obj: GroupTherapySession) -> int:
        return obj.participants.count()

    def get_is_participant(self, obj: GroupTherapySession) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.participants.filter(id=request.user.id).exists()
        return False


class GroupTherapyMessageSerializer(serializers.ModelSerializer):
    sender_name = serializers.SerializerMethodField()
    is_own_message = serializers.SerializerMethodField()

    class Meta:
        model = GroupTherapyMessage
        fields = [
            "id",
            "session_id",
            "sender_id",
            "sender_name",
            "is_own_message",
            "content",
            "emoji_reaction",
            "message_type",
            "created_at",
        ]

    def get_sender_name(self, obj: GroupTherapyMessage) -> str:
        return obj.sender.full_name or "Participant"

    def get_is_own_message(self, obj: GroupTherapyMessage) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.sender_id == request.user.id
        return False


class GroupTherapyActivityResponseSerializer(serializers.ModelSerializer):
    user_name = serializers.SerializerMethodField()
    is_own_response = serializers.SerializerMethodField()

    class Meta:
        model = GroupTherapyActivityResponse
        fields = [
            "id",
            "session_id",
            "user_id",
            "user_name",
            "is_own_response",
            "activity_type",
            "response_data",
            "created_at",
        ]

    def get_user_name(self, obj: GroupTherapyActivityResponse) -> str:
        return obj.user.full_name or "Participant"

    def get_is_own_response(self, obj: GroupTherapyActivityResponse) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.user_id == request.user.id
        return False


class GroupTherapyJoinRequestSerializer(serializers.ModelSerializer):
    user_name = serializers.SerializerMethodField()
    is_own_request = serializers.SerializerMethodField()

    class Meta:
        model = GroupTherapyJoinRequest
        fields = [
            "id",
            "session_id",
            "user_id",
            "user_name",
            "is_own_request",
            "status",
            "created_at",
        ]

    def get_user_name(self, obj: GroupTherapyJoinRequest) -> str:
        return obj.user.full_name or "Patient Guest"

    def get_is_own_request(self, obj: GroupTherapyJoinRequest) -> bool:
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            return obj.user_id == request.user.id
        return False





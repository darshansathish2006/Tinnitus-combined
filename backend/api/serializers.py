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
    date_of_birth = serializers.DateField(required=False, allow_null=True)
    sex = serializers.ChoiceField(
        choices=["male", "female", "other", "prefer_not_to_say"], required=False, allow_null=True
    )

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
            "onset_date", "duration_months", "tinnitus_character", "laterality",
            "pulsatile", "somatic_modulation", "hyperacusis", "hearing_aid_use",
            "noise_exposure_years", "comorbidities", "medications", "etiology_notes",
            "consent_research", "clinician_id", "clinician_name", "has_saved_calibration",
            "saved_device_profile",
        ]
        read_only_fields = ["id", "mrn", "clinician_id", "saved_device_profile"]

    def get_clinician_name(self, obj: Patient) -> str | None:
        return obj.clinician.full_name if obj.clinician else None

    def get_has_saved_calibration(self, obj: Patient) -> bool:
        return bool((obj.saved_device_profile or {}).get("calibrated_at"))


class PatientProfileUpdateSerializer(serializers.ModelSerializer):
    laterality = serializers.ChoiceField(choices=Ear.choices, required=False, allow_blank=True)

    class Meta:
        model = Patient
        fields = [
            "date_of_birth", "sex", "phone", "onset_date", "tinnitus_character", "laterality",
            "pulsatile", "somatic_modulation", "hyperacusis", "hearing_aid_use",
            "noise_exposure_years", "comorbidities", "medications", "etiology_notes",
            "consent_research",
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

    pitch_match_hz = serializers.FloatField(required=False, allow_null=True, min_value=50, max_value=20000)
    pitch_match_ear = serializers.ChoiceField(choices=Ear.choices, required=False, allow_blank=True)
    pitch_match_confidence = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=1)
    octave_confusion = serializers.BooleanField(required=False, allow_null=True)
    pitch_match_trace = serializers.ListField(required=False)

    loudness_match_db_sl = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=80)
    loudness_match_db_hl = serializers.FloatField(required=False, allow_null=True, min_value=-10, max_value=130)
    mml_db_sl = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=90)
    ri_depth_pct = serializers.FloatField(required=False, allow_null=True, min_value=-100, max_value=100)
    ri_duration_s = serializers.FloatField(required=False, allow_null=True, min_value=0, max_value=1800)
    ri_trace = serializers.ListField(required=False)
    tinnitus_bandwidth = serializers.ChoiceField(
        choices=["tonal", "narrowband", "broadband"], required=False, allow_blank=True
    )
    ldl_left = serializers.FloatField(required=False, allow_null=True, min_value=40, max_value=130)
    ldl_right = serializers.FloatField(required=False, allow_null=True, min_value=40, max_value=130)

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
    # `reference_level_db` / `_hz` are deliberately absent. They are derived
    # server-side from the thresholds above — see `assessment_save` — so that a
    # client cannot submit a summary that disagrees with the data it summarises.

    thi_items = serializers.DictField(required=False)
    vas = serializers.DictField(required=False)
    psqi_items = serializers.DictField(required=False)
    pss10_items = serializers.DictField(required=False)
    pss4_items = serializers.DictField(required=False)
    gad7_items = serializers.DictField(required=False)
    gad2_items = serializers.DictField(required=False)
    phq2_items = serializers.DictField(required=False)
    sleep_screen_items = serializers.DictField(required=False)
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
        
        all_members = list(obj.community.members.filter(is_active=True).order_by("id"))
        read_ids = set(obj.read_by.values_list("id", flat=True))
        
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

        all_members = list(obj.community.members.filter(is_active=True).order_by("id"))
        read_ids = set(obj.read_by.values_list("id", flat=True))

        out = []
        for m in all_members:
            if m.id not in read_ids:
                if current_user and m.id == current_user.id:
                    out.append(f"You ({m.full_name})")
                else:
                    out.append(m.full_name)
        return out



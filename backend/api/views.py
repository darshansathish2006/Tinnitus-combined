"""API views.

URL paths are unchanged from the previous implementation, so the SPA needed no
rewrite when the backend moved to Django — the contract is the contract.

Every view that touches a patient record resolves it through
`permissions.resolve_patient`, which is the single place the "a patient may only
reach their own record" rule is enforced.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import threading
from datetime import date, date as Date, datetime, timedelta
from typing import Any, Sequence

from django.conf import settings as dj_settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken

from chat.engine import respond as chat_respond
from chat.knowledge import CRISIS_RESOURCES, EDUCATION_TOPICS, LANGUAGES
from clinical.audiometry import (
    AUDIOMETRIC_FREQS,
    CORE_FREQ_ORDER,
    EXTENDED_FREQS,
    HF_PTA_FREQS,
    INTER_OCTAVE_FREQS,
    INTER_OCTAVE_GAP_DB,
    PTA_FREQS,
    analyse_audiogram,
    classify_residual_inhibition,
    maskability,
)
from clinical.coding import build_fhir_bundle
from clinical.instruments import INSTRUMENT_REGISTRY, STEPPED_PROTOCOL, score_all
from dsp.synthesis import analyse_prescription_spectrum
from dsp.therapy import adapt as adapt_program, catalogue as therapy_catalogue, prescribe
from ml.features import FEATURES, TARGETS
from ml.predict import ModelsUnavailable, clear_cache, load_bundle, predict_all

from .models import (
    Alert,
    Appointment,
    Assessment,
    AssessmentStatus,
    AuditLog,
    ChatMessage,
    ClinicalNote,
    ClinicianProfile,
    Community,
    CommunityComment,
    CommunityChatMessage,
    CommunityPost,
    DiaryEntry,
    MedicationReminder,
    Patient,
    DailyCheckIn,
    Prediction,
    RehabActivityLog,
    Role,
    TherapyPrescription,
    TherapySession,
    User,
)
from .permissions import (
    IsClinician,
    assert_clinician_access,
    caseload_patients,
    resolve_patient,
    visible_patients,
)
from .serializers import (
    AlertSerializer,
    AppointmentSerializer,
    AssessmentSerializer,
    AssessmentSubmitSerializer,
    ChatRequestSerializer,
    ClinicalNoteSerializer,
    CommunityChatMessageSerializer,
    CommunityCommentSerializer,
    CommunityPostCreateSerializer,
    CommunityPostSerializer,
    CommunitySerializer,
    DiarySerializer,
    LocationUpdateSerializer,
    LoginSerializer,
    MedicationReminderSerializer,
    PatientProfileUpdateSerializer,
    PatientSerializer,
    PrescriptionSerializer,
    RegisterSerializer,
    TherapySessionSerializer,
    WhatIfSerializer,
)
from .services import analysis as svc
from .services import masking
from .services import monitoring_summary
from .services import rehabilitation as rehab
from .services import scheduling as sched
from .services.monitoring import check_diary_alerts, diary_analytics, sync_alerts, trigger_correlation, triage_score


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def audit(request, action: str, entity: str = "", entity_id: int | None = None, **meta) -> None:
    """Append to the audit trail. Never raises — a failed audit write must not take
    down the clinical action it was recording."""
    try:
        AuditLog.objects.create(
            actor=request.user if getattr(request, "user", None) and request.user.is_authenticated else None,
            action=action,
            entity=entity,
            entity_id=entity_id,
            meta=meta,
        )
    except Exception:
        pass


def issue_token(user: User) -> dict[str, Any]:
    refresh = RefreshToken.for_user(user)
    patient = Patient.objects.filter(user=user).first()
    user.last_login = timezone.now()
    user.save(update_fields=["last_login"])
    return {
        "access_token": str(refresh.access_token),
        "refresh_token": str(refresh),
        "token_type": "bearer",
        "role": user.role,
        "user_id": user.id,
        "patient_id": patient.id if patient else None,
        "full_name": user.full_name,
        "locale": user.locale,
    }


def patient_context(patient: Patient) -> dict[str, Any]:
    """Everything the analysis pipeline needs for this patient, in one place."""
    return {
        "patient": svc.patient_dict(patient),
        "diary": svc.diary_dicts(list(DiaryEntry.objects.filter(patient=patient).order_by("entry_date"))),
        "sessions": svc.session_dicts(list(TherapySession.objects.filter(patient=patient).order_by("started_at"))),
    }


def latest_complete(patient: Patient) -> Assessment | None:
    return (
        Assessment.objects.filter(patient=patient, status=AssessmentStatus.COMPLETE)
        .order_by("-created_at")
        .first()
    )


def active_prescription(patient: Patient) -> TherapyPrescription | None:
    return TherapyPrescription.objects.filter(patient=patient, active=True).order_by("-revision").first()


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
@api_view(["POST"])
@permission_classes([AllowAny])
def login(request):
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    email = serializer.validated_data["email"].lower()

    user = User.objects.filter(email=email).first()
    if user is None or not user.check_password(serializer.validated_data["password"]):
        return Response({"detail": "Incorrect email or password."}, status=status.HTTP_401_UNAUTHORIZED)
    if not user.is_active:
        return Response({"detail": "Account deactivated."}, status=status.HTTP_403_FORBIDDEN)

    audit(request, "login", "user", user.id)
    return Response(issue_token(user))


def get_or_create_community_for_user(user: User, country: str, state: str, city: str) -> Community | None:
    """Find or create a local tinnitus community matching country + state + city and assign the user."""
    country_clean = (country or "").strip()
    state_clean = (state or "").strip()
    city_clean = (city or "").strip()

    if not country_clean or not state_clean or not city_clean:
        return None

    title_city = city_clean.title()
    community_name = f"Tinnitus Support – {title_city}"

    with transaction.atomic():
        community = (
            Community.objects.filter(
                country__iexact=country_clean,
                state__iexact=state_clean,
                city__iexact=city_clean,
            )
            .select_for_update()
            .first()
        )

        if not community:
            try:
                community = Community.objects.create(
                    name=community_name,
                    country=country_clean,
                    state=state_clean,
                    city=city_clean,
                )
            except IntegrityError:
                community = Community.objects.get(
                    country__iexact=country_clean,
                    state__iexact=state_clean,
                    city__iexact=city_clean,
                )

        user.country = country_clean
        user.state = state_clean
        user.city = city_clean
        user.community = community
        user.save(update_fields=["country", "state", "city", "community"])

    return community


@api_view(["POST"])
@permission_classes([AllowAny])
@transaction.atomic
def register(request):
    serializer = RegisterSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data

    user = User.objects.create_user(
        email=data["email"],
        password=data["password"],
        full_name=data["full_name"],
        role=data["role"],
        locale=data.get("locale", "en"),
        country=(data.get("country") or "").strip(),
        state=(data.get("state") or "").strip(),
        city=(data.get("city") or "").strip(),
    )

    if user.role == Role.PATIENT:
        Patient.objects.create(
            user=user,
            clinician=None,
            mrn=f"ESA-2026-{Patient.objects.count() + 1:05d}",
            date_of_birth=data.get("date_of_birth"),
            sex=data.get("sex") or "",
        )

    country = data.get("country")
    state = data.get("state")
    city = data.get("city")
    if country and state and city:
        get_or_create_community_for_user(user, country, state, city)

    return Response(issue_token(user), status=status.HTTP_201_CREATED)


@api_view(["GET"])
def me(request):
    user = request.user
    out: dict[str, Any] = {
        "user_id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role,
        "locale": user.locale,
        "country": user.country,
        "state": user.state,
        "city": user.city,
        "community_id": user.community_id,
        "created_at": user.created_at,
        "last_login": user.last_login,
    }
    patient = Patient.objects.select_related("user", "clinician").filter(user=user).first()
    if patient:
        out["patient"] = PatientSerializer(patient).data
    return Response(out)


# --------------------------------------------------------------------------- #
# Community Views
# --------------------------------------------------------------------------- #
def _build_my_community_response(user: User, request) -> Response:
    if not user.country or not user.state or not user.city:
        user.country = user.country or "India"
        user.state = user.state or "Tamil Nadu"
        user.city = user.city or "Chennai"
        user.save(update_fields=["country", "state", "city"])

    if not user.community and user.country and user.state and user.city:
        get_or_create_community_for_user(user, user.country, user.state, user.city)

    user.last_login = timezone.now()
    user.save(update_fields=["last_login"])

    community = user.community
    five_mins_ago = timezone.now() - timedelta(minutes=5)
    online_cnt = max(1, community.members.filter(is_active=True, joined_community=True, last_login__gte=five_mins_ago).count()) if community else 1

    if not user.joined_community:
        return Response({
            "has_community": True,
            "joined_community": False,
            "community": CommunitySerializer(community).data if community else None,
            "user_location": {
                "country": user.country,
                "state": user.state,
                "city": user.city,
            },
            "resources": [],
            "posts": [],
            "chat_messages": [],
            "online_count": online_cnt,
        })

    resources = [
        {
            "id": 1,
            "title": "Understanding Sound Therapy & Habituation",
            "category": "Sound Therapy",
            "link": "/rehabilitation",
        },
        {
            "id": 2,
            "title": "Cognitive Reframing for Tinnitus Stress",
            "category": "CBT",
            "link": "/guide",
        },
        {
            "id": 3,
            "title": "Local Support Group Guidelines & Patient Privacy",
            "category": "Community Guidelines",
            "link": None,
        },
    ]

    posts = CommunityPost.objects.filter(community=community).select_related("author").prefetch_related("likes", "comments").order_by("-created_at")[:50]
    posts_data = CommunityPostSerializer(posts, many=True, context={"request": request}).data

    chat_msgs = CommunityChatMessage.objects.filter(community=community).select_related("sender").prefetch_related("read_by").order_by("created_at")[:100]
    for msg in chat_msgs:
        if not msg.read_by.filter(id=user.id).exists():
            msg.read_by.add(user)
    chat_data = CommunityChatMessageSerializer(chat_msgs, many=True, context={"request": request}).data

    return Response({
        "has_community": True,
        "joined_community": True,
        "community": CommunitySerializer(community).data,
        "user_location": {
            "country": user.country,
            "state": user.state,
            "city": user.city,
        },
        "resources": resources,
        "posts": posts_data,
        "chat_messages": chat_data,
        "online_count": online_cnt,
    })


@api_view(["GET"])
def my_community(request):
    return _build_my_community_response(request.user, request)


@api_view(["POST"])
def join_community(request):
    user = request.user
    should_join = request.data.get("join", True)
    if not user.country or not user.state or not user.city:
        user.country = user.country or "India"
        user.state = user.state or "Tamil Nadu"
        user.city = user.city or "Chennai"
        user.save(update_fields=["country", "state", "city"])

    if user.country and user.state and user.city:
        get_or_create_community_for_user(user, user.country, user.state, user.city)

    user.joined_community = bool(should_join)
    user.save(update_fields=["joined_community", "community"])
    audit(request, "join_community", "community", user.community_id, joined=should_join)
    return _build_my_community_response(user, request)


@api_view(["POST"])
def update_community_location(request):
    serializer = LocationUpdateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    c = serializer.validated_data["country"]
    s = serializer.validated_data["state"]
    ct = serializer.validated_data["city"]

    get_or_create_community_for_user(request.user, c, s, ct)
    request.user.joined_community = True
    request.user.save(update_fields=["joined_community"])
    audit(request, "update_location", "community", request.user.community_id, country=c, state=s, city=ct)
    return _build_my_community_response(request.user, request)


@api_view(["POST"])
def create_community_post(request):
    user = request.user
    if not user.community or not user.joined_community:
        return Response({"detail": "You must join a community before posting."}, status=status.HTTP_400_BAD_REQUEST)

    serializer = CommunityPostCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    post = CommunityPost.objects.create(
        community=user.community,
        author=user,
        content=serializer.validated_data["content"],
    )
    audit(request, "create_post", "community_post", post.id, community_id=user.community_id)
    return Response(
        CommunityPostSerializer(post, context={"request": request}).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(["DELETE"])
def delete_community_post(request, post_id: int):
    user = request.user
    post = CommunityPost.objects.filter(id=post_id).first()
    if not post:
        return Response({"detail": "Post not found."}, status=status.HTTP_404_NOT_FOUND)

    if post.author_id != user.id and not user.is_clinician:
        return Response({"detail": "You can only delete your own posts."}, status=status.HTTP_403_FORBIDDEN)

    post.delete()
    audit(request, "delete_post", "community_post", post_id)
    return Response({"detail": "Post deleted."})


@api_view(["POST"])
def toggle_like_post(request, post_id: int):
    user = request.user
    post = CommunityPost.objects.filter(id=post_id).first()
    if not post:
        return Response({"detail": "Post not found."}, status=status.HTTP_404_NOT_FOUND)

    if post.likes.filter(id=user.id).exists():
        post.likes.remove(user)
        liked = False
    else:
        post.likes.add(user)
        liked = True

    return Response({"likes_count": post.likes.count(), "is_liked_by_me": liked})


@api_view(["POST"])
def create_comment(request, post_id: int):
    user = request.user
    post = CommunityPost.objects.filter(id=post_id).first()
    if not post:
        return Response({"detail": "Post not found."}, status=status.HTTP_404_NOT_FOUND)

    content = (request.data.get("content") or "").strip()
    if not content:
        return Response({"detail": "Comment content cannot be empty."}, status=status.HTTP_400_BAD_REQUEST)

    parent_id = request.data.get("parent_id")
    parent = None
    if parent_id:
        parent = CommunityComment.objects.filter(id=parent_id, post=post).first()

    comment = CommunityComment.objects.create(
        post=post,
        author=user,
        parent=parent,
        content=content,
    )
    return Response(
        CommunityCommentSerializer(comment, context={"request": request}).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(["DELETE"])
def delete_comment(request, comment_id: int):
    user = request.user
    comment = CommunityComment.objects.filter(id=comment_id).first()
    if not comment:
        return Response({"detail": "Comment not found."}, status=status.HTTP_404_NOT_FOUND)

    if comment.author_id != user.id and not user.is_clinician:
        return Response({"detail": "You can only delete your own comments."}, status=status.HTTP_403_FORBIDDEN)

    comment.delete()
    return Response({"detail": "Comment deleted."})


@api_view(["GET", "POST"])
def community_chat(request):
    user = request.user
    if not user.community:
        return Response({"detail": "You are not assigned to a community."}, status=status.HTTP_400_BAD_REQUEST)

    user.last_login = timezone.now()
    user.save(update_fields=["last_login"])

    if request.method == "POST":
        content = (request.data.get("content") or "").strip()
        if not content:
            return Response({"detail": "Message cannot be empty."}, status=status.HTTP_400_BAD_REQUEST)

        msg = CommunityChatMessage.objects.create(
            community=user.community,
            sender=user,
            content=content,
        )
        msg.read_by.add(user)
        return Response(
            CommunityChatMessageSerializer(msg, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )

    msgs = CommunityChatMessage.objects.filter(community=user.community).select_related("sender").prefetch_related("read_by").order_by("created_at")[:100]
    for msg in msgs:
        if not msg.read_by.filter(id=user.id).exists():
            msg.read_by.add(user)

    data = CommunityChatMessageSerializer(msgs, many=True, context={"request": request}).data
    five_mins_ago = timezone.now() - timedelta(minutes=5)
    online_cnt = max(1, user.community.members.filter(is_active=True, joined_community=True, last_login__gte=five_mins_ago).count())
    return Response({"messages": data, "online_count": online_cnt})




@api_view(["PATCH"])
def set_locale(request):
    user = request.user
    user.locale = str(request.query_params.get("locale") or request.data.get("locale") or "en")[:12]
    user.save(update_fields=["locale"])
    return Response({"locale": user.locale})


@api_view(["GET"])
@permission_classes([AllowAny])
def demo_accounts(request):
    """Seeded credentials, so a reviewer can sign in without reading the README."""
    from api.management.commands.seed_demo import DEMO_EMAILS, DEMO_PASSWORD

    rows = []
    for user in User.objects.filter(email__in=sorted(DEMO_EMAILS)).select_related("patient"):
        patient = Patient.objects.filter(user=user).first()
        rows.append(
            {
                "email": user.email,
                "password": DEMO_PASSWORD,
                "role": user.role,
                "full_name": user.full_name,
                "mrn": patient.mrn if patient else None,
                "note": "Seeded demonstration account.",
            }
        )
    return Response({"accounts": rows, "seeded": bool(rows)})


# --------------------------------------------------------------------------- #
# Patients
# --------------------------------------------------------------------------- #
@api_view(["GET", "PATCH"])
def patient_me(request):
    patient = resolve_patient(request)
    if request.method == "PATCH":
        serializer = PatientProfileUpdateSerializer(patient, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        audit(request, "patient.update_profile", "patient", patient.id, fields=sorted(request.data.keys()))
    return Response(PatientSerializer(patient).data)


@api_view(["GET"])
@permission_classes([IsClinician])
def patient_list(request):
    return Response(PatientSerializer(visible_patients(request.user), many=True).data)


@api_view(["GET", "PATCH"])
@permission_classes([IsClinician])
def patient_detail(request, patient_id: int):
    patient = Patient.objects.select_related("user", "clinician").filter(pk=patient_id).first()
    if patient is None:
        return Response({"detail": "Patient not found."}, status=status.HTTP_404_NOT_FOUND)
    assert_clinician_access(request.user, patient)

    if request.method == "PATCH":
        serializer = PatientProfileUpdateSerializer(patient, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        audit(request, "patient.update", "patient", patient.id)
    return Response(PatientSerializer(patient).data)


# --------------------------------------------------------------------------- #
# Education content for the 3D ear model
# --------------------------------------------------------------------------- #
from .content import EAR_MODEL_LAYERS  # noqa: E402


@api_view(["GET"])
@permission_classes([AllowAny])
def ear_model(request):
    return Response(
        {
            "layers": EAR_MODEL_LAYERS,
            "note": "The 3D model is a schematic teaching aid built to scale relationships rather "
            "than anatomical exactness. It is not a diagnostic image.",
        }
    )


# --------------------------------------------------------------------------- #
# Assessments
# --------------------------------------------------------------------------- #
@api_view(["GET"])
@permission_classes([AllowAny])
def instruments(request):
    """Item banks, options, grading bands and the stepped protocol.

    Served from the backend so the questionnaire the patient sees and the scoring
    algorithm are guaranteed to be the same version.
    """
    return Response(
        {
            "instruments": INSTRUMENT_REGISTRY,
            "stepped_protocol": STEPPED_PROTOCOL,
            "audiometry": {
                "standard_frequencies": list(AUDIOMETRIC_FREQS),
                "core_order": list(CORE_FREQ_ORDER),
                "inter_octave_frequencies": list(INTER_OCTAVE_FREQS),
                "inter_octave_gap_db": INTER_OCTAVE_GAP_DB,
                "extended_frequencies": list(EXTENDED_FREQS),
                "pta_frequencies": list(PTA_FREQS),
                "hf_pta_frequencies": list(HF_PTA_FREQS),
                "level_step_db": 5,
                "level_range_db": [-10, 100],
                "method": "Modified Hughson-Westlake: 10 dB down on a response, 5 dB up on no "
                "response; threshold is the lowest level with 2 of 3 ascending responses.",
                "adaptive_note": "BSA recommended procedure — octave frequencies as standard, with "
                f"inter-octave frequencies added only when adjacent octaves differ by >= "
                f"{INTER_OCTAVE_GAP_DB} dB.",
            },
            "optional_modules": {
                "psychoacoustics": {
                    "modules": ["pitch_match", "loudness_match", "mml", "residual_inhibition"],
                    "required": False,
                    "basis": "AAO-HNSF clinical practice guideline: routine psychoacoustic testing is "
                    "not required for initial tinnitus assessment. It is offered because it is what "
                    "makes a therapy notch possible, not because every patient needs it.",
                }
            },
        }
    )


def apply_submission(assessment: Assessment, data: dict[str, Any]) -> None:
    """Merge a partial submission onto the row, then rescore everything."""
    if "device_profile" in data:
        assessment.device_profile = {**(assessment.device_profile or {}), **data["device_profile"]}

    if "audiogram" in data:
        merged = {**(assessment.audiogram or {})}
        for ear, thresholds in data["audiogram"].items():
            side = {**(merged.get(ear) or {})}
            side.update({str(int(float(f))): float(v) for f, v in thresholds.items()})
            merged[ear] = side
        assessment.audiogram = merged

    for field in (
        "pitch_match_hz", "pitch_match_confidence", "loudness_match_db_sl", "loudness_match_db_hl",
        "mml_db_sl", "ri_depth_pct", "ri_duration_s", "ldl_left", "ldl_right",
        "octave_confusion", "tinnitus_bandwidth", "pitch_match_ear",
        "pitch_match_trace", "ri_trace",
        "masking_thresholds", "masking_unmasked_hz",
    ):
        if field in data:
            setattr(assessment, field, data[field])

    # The reference level is *derived*, never accepted from the client. It is the
    # number the therapy prescription is built around, and a value the browser
    # could set is a value a stale client could set wrongly. Recomputed on every
    # save so it can never drift from the thresholds it summarises.
    if "masking_thresholds" in data or "masking_unmasked_hz" in data:
        summary = masking.reference_level(
            assessment.masking_thresholds, assessment.masking_unmasked_hz
        )
        assessment.reference_level_db = summary["reference_level_db"]
        assessment.reference_level_hz = summary["reference_level_hz"]

        # A masking profile is also a loudness measurement. If the optional
        # psychoacoustic battery was skipped — which it usually is — the
        # reference level is the only estimate of the percept's level the record
        # has, so it backfills the MML rather than leaving the therapy engine
        # with nothing to work from. Never overwrites a directly measured MML.
        if assessment.mml_db_sl is None and summary["reference_level_db"] is not None:
            assessment.mml_db_sl = summary["reference_level_db"]
        if assessment.pitch_match_hz is None and summary["reference_level_hz"] is not None:
            assessment.pitch_match_hz = float(summary["reference_level_hz"])

    # Questionnaire item banks merge, so a patient can answer across sittings and
    # so a GAD-7 escalation adds to the GAD-2 items already stored.
    for field in ("thi_items", "psqi_items", "pss10_items", "gad7_items", "phq2_items"):
        if field in data:
            setattr(assessment, field, {**(getattr(assessment, field) or {}), **data[field]})
    # Short forms are subsets of their long forms, so they merge into the same bank.
    if "gad2_items" in data:
        assessment.gad7_items = {**(assessment.gad7_items or {}), **data["gad2_items"]}
    if "pss4_items" in data:
        assessment.pss10_items = {**(assessment.pss10_items or {}), **data["pss4_items"]}
    if "sleep_screen_items" in data:
        raw = data["sleep_screen_items"].get("sleep_screen")
        if raw is not None:
            assessment.sleep_screen_score = int(raw)

    # Which indicated long forms were administered, and which were declined.
    #
    # This goes in `derived`, not in `escalated_instruments`: that column is
    # recomputed by rescore() from the screener scores and means "indicated by
    # the protocol", which is a different fact. The distinction matters clinically
    # — a null gad7_score means two very different things depending on whether
    # the GAD-2 screened negative or the patient declined five more questions —
    # and only the second is an outstanding recommendation.
    if "escalated_instruments" in data or "deferred_instruments" in data:
        record = dict((assessment.derived or {}).get("stepped_protocol") or {})
        if "escalated_instruments" in data:
            record["completed"] = sorted(set(data["escalated_instruments"]))
        if "deferred_instruments" in data:
            record["deferred"] = sorted(set(data["deferred_instruments"]))
        assessment.derived = {**(assessment.derived or {}), "stepped_protocol": record}

    if "vas" in data:
        for key, value in data["vas"].items():
            if key in {"vas_loudness", "vas_annoyance", "vas_awareness", "vas_sleep_interference"}:
                setattr(assessment, key, float(value))

    if data.get("modules_done"):
        assessment.modules_done = sorted(set((assessment.modules_done or []) + data["modules_done"]))

    rescore(assessment)


def rescore(assessment: Assessment) -> None:
    """Recompute every derived column from the stored raw responses."""
    raw = {
        "thi_items": assessment.thi_items,
        "psqi_items": assessment.psqi_items,
        "pss10_items": assessment.pss10_items,
        "pss4_items": assessment.pss10_items,
        "gad7_items": assessment.gad7_items,
        "gad2_items": assessment.gad7_items,
        "phq2_items": assessment.phq2_items,
        "sleep_screen_items": {"sleep_screen": assessment.sleep_screen_score}
        if assessment.sleep_screen_score is not None
        else {},
        "vas": {
            "vas_loudness": assessment.vas_loudness,
            "vas_annoyance": assessment.vas_annoyance,
            "vas_awareness": assessment.vas_awareness,
            "vas_sleep_interference": assessment.vas_sleep_interference,
        },
    }
    scores = score_all(raw)

    assessment.thi_score = scores["thi"]["score"]
    assessment.thi_grade = scores["thi"]["grade"] or ""
    assessment.thi_subscales = scores["thi"]["subscales"]
    assessment.psqi_score = scores["psqi"]["score"]
    assessment.psqi_grade = scores["psqi"]["grade"] or ""
    assessment.pss10_score = scores["pss10"]["score"]
    assessment.pss10_grade = scores["pss10"]["grade"] or ""
    assessment.gad7_score = scores["gad7"]["score"]
    assessment.gad7_grade = scores["gad7"]["grade"] or ""
    assessment.phq2_score = scores["phq2"]["score"]
    assessment.gad2_score = scores["gad2"]["score"]
    assessment.pss4_score = scores["pss4"]["score"]
    assessment.escalated_instruments = [e["instrument"] for e in scores.get("escalations", [])]

    aa = analyse_audiogram(assessment.audiogram)
    assessment.pta_left = aa["pta_left"]
    assessment.pta_right = aa["pta_right"]
    assessment.hf_pta_left = aa["hf_pta_left"]
    assessment.hf_pta_right = aa["hf_pta_right"]
    assessment.hearing_grade = aa["who_grade"] or ""
    assessment.audiometric_notch_hz = aa["audiometric_notch_hz"]

    assessment.ri_category = (
        classify_residual_inhibition(assessment.ri_depth_pct, assessment.ri_duration_s)["category"] or ""
    )


@api_view(["GET", "POST"])
def assessments(request):
    patient = resolve_patient(request)

    if request.method == "POST":
        # Reuse any in-progress assessment so a refresh does not strand half-finished data.
        existing = (
            Assessment.objects.filter(patient=patient, status=AssessmentStatus.IN_PROGRESS)
            .order_by("-created_at")
            .first()
        )
        if existing:
            return Response(AssessmentSerializer(existing).data)
        created = Assessment.objects.create(patient=patient)
        audit(request, "assessment.create", "assessment", created.id)
        return Response(AssessmentSerializer(created).data, status=status.HTTP_201_CREATED)

    rows = Assessment.objects.filter(patient=patient).order_by("-created_at")
    return Response(AssessmentSerializer(rows, many=True).data)


@api_view(["GET"])
def assessment_latest(request):
    patient = resolve_patient(request)
    assessment = latest_complete(patient)
    if assessment is None:
        return Response({"detail": "No completed assessment on record."}, status=status.HTTP_404_NOT_FOUND)
    return Response(AssessmentSerializer(assessment).data)


def _load_assessment(patient: Patient, assessment_id: int) -> Assessment | None:
    return Assessment.objects.filter(pk=assessment_id, patient=patient).first()


@api_view(["GET", "PATCH", "DELETE"])
def assessment_detail(request, assessment_id: int):
    patient = resolve_patient(request)
    assessment = _load_assessment(patient, assessment_id)
    if assessment is None:
        return Response({"detail": "Assessment not found for this patient."}, status=status.HTTP_404_NOT_FOUND)

    if request.method == "PATCH":
        if assessment.status == AssessmentStatus.COMPLETE:
            return Response(
                {"detail": "This assessment is finalised. Start a new one to record new measurements."},
                status=status.HTTP_409_CONFLICT,
            )
        serializer = AssessmentSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        apply_submission(assessment, data)

        # Remember the headphone calibration so returning patients can skip it.
        if data.get("save_calibration") and data.get("device_profile"):
            patient.saved_device_profile = assessment.device_profile
            patient.save(update_fields=["saved_device_profile"])

        assessment.save()
        audit(request, "assessment.save_module", "assessment", assessment.id, modules=data.get("modules_done"))
        return Response(AssessmentSerializer(assessment).data)

    if request.method == "DELETE":
        if assessment.status == AssessmentStatus.COMPLETE:
            return Response(
                {"detail": "Completed assessments are part of the clinical record and cannot be deleted."},
                status=status.HTTP_409_CONFLICT,
            )
        assessment.status = AssessmentStatus.ABANDONED
        assessment.save(update_fields=["status"])
        audit(request, "assessment.abandon", "assessment", assessment.id)
        return Response(status=status.HTTP_204_NO_CONTENT)

    return Response(AssessmentSerializer(assessment).data)


def masking_analysis(assessment: Assessment) -> dict[str, Any]:
    """The masking curve, the reference level, and the personalised reference.

    One call site for all three so the assessment result, the clinical report and
    the reference-level module cannot disagree about what the patient's own
    reference tone is. Everything it needs is already on the record — nothing
    here asks the patient to repeat a measurement they have already given.
    """
    return masking.analyse(
        assessment.masking_thresholds,
        assessment.masking_unmasked_hz,
        pitch_match_hz=assessment.pitch_match_hz,
        loudness_match_db_hl=assessment.loudness_match_db_hl,
        audiogram=assessment.audiogram,
        audiometric_notch_hz=assessment.audiometric_notch_hz,
    )


def run_analysis(patient: Patient, assessment: Assessment, **kwargs) -> dict[str, Any]:
    ctx = patient_context(patient)
    return svc.analyse(
        patient=ctx["patient"],
        assessment=svc.assessment_dict(assessment),
        diary=ctx["diary"],
        sessions=ctx["sessions"],
        **kwargs,
    )


@transaction.atomic
def finalise_assessment(patient: Patient, assessment: Assessment) -> dict[str, Any]:
    """Close the assessment and run the full pipeline.

    This is the single write path that produces the derived record: instrument
    scores, composites, red-flag alerts, a stored Prediction and an active
    TherapyPrescription. Everything the dashboards read is written here.
    """
    rescore(assessment)
    result = run_analysis(patient, assessment)

    assessment.derived = {
        **(assessment.derived or {}),
        **result["derived"],
        "summary": result["summary"],
        "red_flags": result["red_flags"],
        "escalations": result.get("escalations", []),
        "audiometry_plan": result.get("audiometry_plan", {}),
        # The masking curve and reference level travel with the analysis so the
        # report, the assessment result and the therapy engine all read one
        # derivation rather than three clients recomputing a minimum.
        "masking": masking_analysis(assessment),
    }
    assessment.icd11_codes = result["icd11"]
    assessment.status = AssessmentStatus.COMPLETE
    assessment.completed_at = assessment.completed_at or timezone.now()
    assessment.save()

    prediction = result.get("prediction")
    if prediction:
        outputs = prediction["outputs"]
        Prediction.objects.update_or_create(
            assessment=assessment,
            defaults={
                "model_version": prediction["model_version"],
                "predicted_dominant_hz": outputs.get("dominant_hz"),
                "predicted_loudness_db_sl": outputs.get("loudness_db_sl"),
                "severity_progression_thi": outputs.get("thi_6mo"),
                "distress_class": outputs.get("distress_class") or "",
                "distress_confidence": outputs.get("distress_class_confidence"),
                "worsening_risk": outputs.get("worsening_risk"),
                "risk_band": outputs.get("risk_band") or "",
                "therapy_response_likelihood": outputs.get("therapy_response"),
                "explanations": prediction.get("explanations"),
                "feature_vector": prediction.get("feature_vector"),
                "confidence_interval": prediction.get("intervals"),
            },
        )

    therapy = result.get("therapy")
    if therapy:
        TherapyPrescription.objects.filter(patient=patient, active=True).update(active=False)
        revision = (
            TherapyPrescription.objects.filter(patient=patient)
            .order_by("-revision")
            .values_list("revision", flat=True)
            .first()
            or 0
        ) + 1
        TherapyPrescription.objects.create(
            patient=patient,
            assessment=assessment,
            revision=revision,
            active=True,
            generated_by="ai",
            created_at=assessment.created_at,
            program=therapy["program"],
            daily_minutes_target=therapy["daily_minutes_target"],
            rationale=therapy["rationale"],
            guardrails=therapy["guardrails"],
            review_after_days=therapy["review_after_days"],
        )

    alerts = sync_alerts(
        patient=patient,
        red_flags=result["red_flags"],
        prediction=prediction,
        assessment_id=assessment.id,
    )
    result["alerts_created"] = [
        {"kind": a.kind, "title": a.title, "severity": a.severity} for a in alerts
    ]
    return result


@api_view(["POST"])
def assessment_finalise(request, assessment_id: int):
    patient = resolve_patient(request)
    assessment = _load_assessment(patient, assessment_id)
    if assessment is None:
        return Response({"detail": "Assessment not found for this patient."}, status=status.HTTP_404_NOT_FOUND)

    if request.data:
        serializer = AssessmentSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        apply_submission(assessment, serializer.validated_data)

    result = finalise_assessment(patient, assessment)
    audit(
        request,
        "assessment.finalise",
        "assessment",
        assessment.id,
        thi=assessment.thi_score,
        red_flags=result["red_flags"]["count"],
    )
    assessment.refresh_from_db()
    return Response({"assessment": AssessmentSerializer(assessment).data, "analysis": result})


@api_view(["GET"])
def assessment_reference_level(request, assessment_id: int):
    """The patient's personalised reference tone and level.

    Derived, never submitted — same rule as the reference level itself. The
    client asks for this *after* saving the pitch, loudness and masking modules,
    so the answer is computed from the stored record rather than from whatever
    the browser happens to be holding, and a patient is never asked to repeat a
    measurement to produce it.

    Recomputed per request rather than cached: it is a pure function of columns
    that can still change while the assessment is open.
    """
    patient = resolve_patient(request)
    assessment = _load_assessment(patient, assessment_id)
    if assessment is None:
        return Response({"detail": "Assessment not found for this patient."}, status=status.HTTP_404_NOT_FOUND)

    summary = masking_analysis(assessment)
    return Response(
        {
            "assessment_id": assessment.id,
            **summary["personalised"],
            # The curve and its minimum ride along so the module can show what
            # the personalised level was derived from without a second call.
            "masking": {
                "curve": summary["curve"],
                "reference_level_db": summary["reference_level_db"],
                "reference_level_hz": summary["reference_level_hz"],
                "selectivity": summary["selectivity"],
                "spread_db": summary["spread_db"],
                "interpretation": summary["interpretation"],
                "tested_count": summary["tested_count"],
                "unmaskable_count": summary["unmaskable_count"],
                "maskable": summary["maskable"],
                "safe": summary["safe"],
                "max_safe_db": summary.get("max_safe_db", masking.MAX_SAFE_MASKING_DB),
            },
        }
    )


@api_view(["GET"])
def assessment_analysis(request, assessment_id: int):
    """Recompute the analysis on demand — never served from a stale cache."""
    patient = resolve_patient(request)
    assessment = _load_assessment(patient, assessment_id)
    if assessment is None:
        return Response({"detail": "Assessment not found for this patient."}, status=status.HTTP_404_NOT_FOUND)

    result = run_analysis(
        patient,
        assessment,
        include_prediction=request.query_params.get("include_prediction", "true") != "false",
        include_therapy=request.query_params.get("include_therapy", "true") != "false",
    )
    return Response({"assessment": AssessmentSerializer(assessment).data, "analysis": result})


# --------------------------------------------------------------------------- #
# Therapy
# --------------------------------------------------------------------------- #
@api_view(["GET"])
@permission_classes([AllowAny])
def therapy_catalogue_view(request):
    return Response(
        {
            "modalities": therapy_catalogue(),
            "families": {
                "neuromodulation": "Aims to change the abnormal neural activity generating the percept.",
                "masking": "Reduces the audibility of the percept for immediate relief.",
                "habituation": "Lowers the salience of the percept so attention stops capturing it.",
                "relaxation": "Reduces the autonomic arousal that amplifies tinnitus.",
                "psychological": "Targets the thoughts and stress response maintaining distress.",
                "sleep": "Supports sleep onset without creating overnight dependence.",
                "hyperacusis": "Graded desensitisation for reduced sound tolerance.",
            },
        }
    )


@api_view(["GET"])
def therapy_current(request):
    patient = resolve_patient(request)
    prescription = active_prescription(patient)
    if prescription is None:
        return Response(
            {"detail": "No active therapy plan. Complete an assessment to have one generated."},
            status=status.HTTP_404_NOT_FOUND,
        )
    return Response(PrescriptionSerializer(prescription).data)


@api_view(["GET"])
def therapy_history(request):
    patient = resolve_patient(request)
    rows = TherapyPrescription.objects.filter(patient=patient).order_by("-revision")
    return Response(PrescriptionSerializer(rows, many=True).data)


@api_view(["POST"])
@transaction.atomic
def therapy_generate(request):
    patient = resolve_patient(request)
    assessment_id = request.query_params.get("assessment_id")
    assessment = (
        _load_assessment(patient, int(assessment_id)) if assessment_id else latest_complete(patient)
    )
    if assessment is None:
        return Response(
            {"detail": "A completed assessment is required first."}, status=status.HTTP_400_BAD_REQUEST
        )

    plan = run_analysis(patient, assessment)["therapy"]
    TherapyPrescription.objects.filter(patient=patient, active=True).update(active=False)
    revision = (
        TherapyPrescription.objects.filter(patient=patient)
        .order_by("-revision")
        .values_list("revision", flat=True)
        .first()
        or 0
    ) + 1
    prescription = TherapyPrescription.objects.create(
        patient=patient,
        assessment=assessment,
        revision=revision,
        active=True,
        generated_by="ai",
        program=plan["program"],
        daily_minutes_target=plan["daily_minutes_target"],
        rationale=plan["rationale"],
        guardrails=plan["guardrails"],
        review_after_days=plan["review_after_days"],
    )
    audit(request, "therapy.generate", "prescription", prescription.id, revision=revision)
    return Response(PrescriptionSerializer(prescription).data)


@api_view(["POST"])
@transaction.atomic
def therapy_adapt(request):
    patient = resolve_patient(request)
    prescription = active_prescription(patient)
    if prescription is None:
        return Response({"detail": "No active plan to adapt."}, status=status.HTTP_404_NOT_FOUND)

    sessions = list(TherapySession.objects.filter(patient=patient).order_by("started_at"))
    if len(sessions) < 4:
        return Response(
            {
                "detail": f"Adaptation needs at least 4 logged sessions; {len(sessions)} recorded so far."
            },
            status=status.HTTP_412_PRECONDITION_FAILED,
        )

    updated = adapt_program(
        current={
            "revision": prescription.revision,
            "program": prescription.program or [],
            "daily_minutes_target": prescription.daily_minutes_target,
            "rationale": prescription.rationale or [],
            "guardrails": prescription.guardrails or {},
            "review_after_days": prescription.review_after_days,
        },
        session_history=svc.session_dicts(sessions),
        diary=svc.diary_dicts(list(DiaryEntry.objects.filter(patient=patient).order_by("entry_date"))),
    )

    prescription.active = False
    prescription.save(update_fields=["active"])
    revised = TherapyPrescription.objects.create(
        patient=patient,
        assessment=prescription.assessment,
        revision=updated["revision"],
        active=True,
        generated_by="ai",
        program=updated["program"],
        daily_minutes_target=updated["daily_minutes_target"],
        rationale=(prescription.rationale or []) + updated.get("adaptation_notes", []),
        guardrails={
            **(prescription.guardrails or {}),
            "adaptation": {
                "effectiveness_by_modality": updated.get("effectiveness_by_modality"),
                "adherence_pct": updated.get("adherence_pct"),
                "diary_trend": updated.get("diary_trend"),
            },
        },
        review_after_days=prescription.review_after_days,
    )
    audit(request, "therapy.adapt", "prescription", revised.id, revision=revised.revision)
    return Response(PrescriptionSerializer(revised).data)


@api_view(["POST"])
@permission_classes([IsClinician])
def therapy_approve(request):
    patient = resolve_patient(request)
    prescription = TherapyPrescription.objects.filter(
        pk=request.query_params.get("prescription_id"), patient=patient
    ).first()
    if prescription is None:
        return Response({"detail": "Prescription not found for this patient."}, status=status.HTTP_404_NOT_FOUND)
    prescription.approved_by = request.user
    prescription.generated_by = "clinician_approved"
    prescription.save(update_fields=["approved_by", "generated_by"])
    audit(request, "therapy.approve", "prescription", prescription.id)
    return Response(PrescriptionSerializer(prescription).data)


@api_view(["GET", "POST"])
def therapy_sessions(request):
    patient = resolve_patient(request)

    if request.method == "POST":
        serializer = TherapySessionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        prescription_id = data.pop("prescription_id", None)
        prescription = (
            TherapyPrescription.objects.filter(pk=prescription_id, patient=patient).first()
            if prescription_id
            else active_prescription(patient)
        )
        session = TherapySession.objects.create(patient=patient, prescription=prescription, **data)

        # Roll the minutes into today's diary entry so adherence and symptom data
        # live on the same timeline.
        entry = DiaryEntry.objects.filter(patient=patient, entry_date=date.today()).first()
        if entry:
            entry.therapy_minutes = (entry.therapy_minutes or 0) + round(session.actual_seconds / 60)
            entry.save(update_fields=["therapy_minutes"])

        return Response(TherapySessionSerializer(session).data, status=status.HTTP_201_CREATED)

    days = int(request.query_params.get("days", 90))
    since = timezone.now() - timedelta(days=days)
    rows = TherapySession.objects.filter(patient=patient, started_at__gte=since).order_by("-started_at")
    return Response(TherapySessionSerializer(rows, many=True).data)


@api_view(["GET"])
def therapy_adherence(request):
    """Adherence and per-modality effectiveness — the patient's progress card."""
    patient = resolve_patient(request)
    days = int(request.query_params.get("days", 28))
    since = timezone.now() - timedelta(days=days)
    sessions = list(TherapySession.objects.filter(patient=patient, started_at__gte=since))

    prescription = active_prescription(patient)
    target_minutes = (prescription.daily_minutes_target if prescription else 60) * days
    actual = sum(s.actual_seconds for s in sessions) / 60

    by_modality: dict[str, dict[str, Any]] = {}
    for s in sessions:
        entry = by_modality.setdefault(s.modality, {"sessions": 0, "minutes": 0.0, "relief": [], "completed": 0})
        entry["sessions"] += 1
        entry["minutes"] += s.actual_seconds / 60
        entry["completed"] += 1 if s.completed else 0
        if s.relief_delta is not None:
            entry["relief"].append(s.relief_delta)

    for entry in by_modality.values():
        relief = entry.pop("relief")
        entry["minutes"] = round(entry["minutes"], 1)
        entry["mean_relief_vas"] = round(sum(relief) / len(relief), 2) if relief else None
        entry["relief_n"] = len(relief)

    days_active = len({s.started_at.date() for s in sessions})
    return Response(
        {
            "window_days": days,
            "target_minutes": target_minutes,
            "actual_minutes": round(actual, 1),
            "adherence_pct": round(min(100.0, 100 * actual / target_minutes), 1) if target_minutes else None,
            "sessions": len(sessions),
            "days_active": days_active,
            "days_active_pct": round(100 * days_active / days, 1),
            "completion_rate": round(100 * sum(1 for s in sessions if s.completed) / len(sessions), 1)
            if sessions
            else None,
            "by_modality": by_modality,
            "best_modality": max(
                (k for k, v in by_modality.items() if v["mean_relief_vas"] is not None),
                key=lambda k: by_modality[k]["mean_relief_vas"],
                default=None,
            ),
        }
    )


# --------------------------------------------------------------------------- #
# Rehabilitation programme
# --------------------------------------------------------------------------- #
def _programme_start(patient: Patient, prescription: TherapyPrescription | None) -> Date:
    """Day one of the programme.

    The active prescription's creation date, because that is when a patient was
    actually given something to do. Falling back to the first logged activity —
    and only then to today — keeps the week number stable for a patient whose
    prescription is regenerated: re-prescribing adapts the *content*, it does
    not restart somebody's week 3 as week 1.
    """
    if prescription is not None:
        return timezone.localtime(prescription.created_at).date()
    first = RehabActivityLog.objects.filter(patient=patient).order_by("on_date").first()
    return first.on_date if first else timezone.localdate()


@api_view(["GET"])
def rehab_programme(request):
    """The patient's structured four-week rehabilitation programme.

    Assembled server-side from the assessment, the active prescription and the
    logged history, for the same reason `consultation` is: the clinician's view
    of "what is this patient meant to be doing this week" has to be the patient's
    view, and two clients deriving a schedule independently is how those drift.
    """
    patient = resolve_patient(request)
    prescription = active_prescription(patient)
    assessment = latest_complete(patient)
    started = _programme_start(patient, prescription)

    # Bounded to the programme window plus a week of slack, so a patient two
    # years into the platform does not drag their whole history into a request
    # that only needs a streak.
    since = started - timedelta(days=7)
    sessions = TherapySession.objects.filter(patient=patient, started_at__date__gte=since)
    completions = RehabActivityLog.objects.filter(patient=patient, on_date__gte=since)

    return Response(
        rehab.build(
            assessment=assessment,
            prescription=prescription,
            patient=patient,
            sessions=list(sessions),
            completions=list(completions),
            started_on=started,
        )
    )


@api_view(["POST", "DELETE"])
def rehab_activity(request):
    """Tick a rehabilitation activity off for a day, or untick it.

    Idempotent by construction — the unique constraint on
    (patient, activity_key, on_date) means a double-tap is one completion. A
    patient correcting a mistake matters here: `DELETE` removes the entry rather
    than writing a negative one, because a streak built on a mis-tap that cannot
    be undone is a streak the patient stops believing.
    """
    patient = resolve_patient(request)

    key = str(request.data.get("activity_key") or request.query_params.get("activity_key") or "").strip()
    if key not in rehab.ACTIVITY_LIBRARY:
        return Response({"detail": "Unknown activity."}, status=status.HTTP_400_BAD_REQUEST)

    raw_date = request.data.get("on_date") or request.query_params.get("on_date")
    try:
        on_date = Date.fromisoformat(str(raw_date)) if raw_date else timezone.localdate()
    except ValueError:
        return Response({"detail": "Invalid date."}, status=status.HTTP_400_BAD_REQUEST)

    # Back-dating is allowed for the last week — people log yesterday's evening
    # exercise the next morning — but not the future, which would let a patient
    # complete a programme that has not happened.
    today = timezone.localdate()
    if on_date > today or (today - on_date).days > 7:
        return Response(
            {"detail": "Activities can only be logged for the last seven days."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if request.method == "DELETE":
        RehabActivityLog.objects.filter(patient=patient, activity_key=key, on_date=on_date).delete()
        audit(request, "rehab.activity.undo", "patient", patient.id, activity=key, on_date=on_date.isoformat())
        return Response(status=status.HTTP_204_NO_CONTENT)

    minutes = request.data.get("minutes")
    try:
        minutes = max(0, min(600, int(minutes))) if minutes is not None else int(
            rehab.ACTIVITY_LIBRARY[key]["minutes"]
        )
    except (TypeError, ValueError):
        minutes = int(rehab.ACTIVITY_LIBRARY[key]["minutes"])

    entry, created = RehabActivityLog.objects.get_or_create(
        patient=patient,
        activity_key=key,
        on_date=on_date,
        defaults={"minutes": minutes, "note": str(request.data.get("note") or "")[:280]},
    )
    if not created and entry.minutes != minutes:
        entry.minutes = minutes
        entry.save(update_fields=["minutes"])

    audit(request, "rehab.activity.done", "patient", patient.id, activity=key, on_date=on_date.isoformat())
    return Response(
        {
            "activity_key": entry.activity_key,
            "on_date": entry.on_date.isoformat(),
            "minutes": entry.minutes,
            "created": created,
        },
        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )


# --------------------------------------------------------------------------- #
# Daily monitoring
# --------------------------------------------------------------------------- #
def _monitoring_for(patient: Patient) -> dict[str, Any]:
    """Assemble one patient's monitoring picture.

    Shared by the patient's own view and the clinician's, deliberately: two
    implementations of "how is this patient doing" is two answers, and the
    consultation where they disagree is the one that matters.
    """
    prescription = active_prescription(patient)
    assessment = latest_complete(patient)
    started = _programme_start(patient, prescription)
    since = started - timedelta(days=7)

    check_ins = list(DailyCheckIn.objects.filter(patient=patient, on_date__gte=since))
    activities = list(RehabActivityLog.objects.filter(patient=patient, on_date__gte=since))
    sessions = list(TherapySession.objects.filter(patient=patient, started_at__date__gte=since))
    appointments = list(
        Appointment.objects.filter(patient=patient).select_related("clinician").order_by("-scheduled_for")[:10]
    )

    programme = rehab.build(
        assessment=assessment,
        prescription=prescription,
        patient=patient,
        sessions=sessions,
        completions=activities,
        started_on=started,
    )

    return monitoring_summary.build(
        check_ins=check_ins,
        activities=activities,
        sessions=sessions,
        appointments=appointments,
        started_on=started,
        today=timezone.localdate(),
        programme_weeks=rehab.PROGRAMME_WEEKS,
        rehab_progress=programme["progress"],
    )


@api_view(["GET"])
def monitoring(request):
    """The patient's own daily-monitoring dashboard."""
    patient = resolve_patient(request)
    payload = _monitoring_for(patient)
    # Whether a clinician can see this. Surfaced to the patient rather than left
    # implicit: somebody logging how they slept is entitled to know who reads it.
    payload["shared_with"] = (
        {"clinician_id": patient.clinician_id, "clinician_name": patient.clinician.full_name}
        if patient.clinician_id
        else None
    )
    return Response(payload)


@api_view(["POST", "DELETE"])
def monitoring_check_in(request):
    """Record — or clear — today's self-report.

    Upsert rather than append: one row per patient per day, so a patient who
    reconsiders their rating in the evening corrects it instead of creating a
    second reading that would drag the day's mean.
    """
    patient = resolve_patient(request)

    raw_date = request.data.get("on_date") or request.query_params.get("on_date")
    try:
        on_date = Date.fromisoformat(str(raw_date)) if raw_date else timezone.localdate()
    except ValueError:
        return Response({"detail": "Invalid date."}, status=status.HTTP_400_BAD_REQUEST)

    today = timezone.localdate()
    if on_date > today or (today - on_date).days > 7:
        return Response(
            {"detail": "Check-ins can only be recorded for the last seven days."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if request.method == "DELETE":
        DailyCheckIn.objects.filter(patient=patient, on_date=on_date).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    fields: dict[str, Any] = {}
    for name in ("tinnitus_loudness", "tinnitus_annoyance", "sleep_quality", "stress_level", "mood"):
        if name not in request.data:
            continue
        value = request.data[name]
        if value is None:
            fields[name] = None
            continue
        try:
            fields[name] = round(min(10.0, max(0.0, float(value))), 1)
        except (TypeError, ValueError):
            return Response({"detail": f"{name} must be a number between 0 and 10."},
                            status=status.HTTP_400_BAD_REQUEST)

    if not fields and "note" not in request.data:
        return Response({"detail": "Nothing to record."}, status=status.HTTP_400_BAD_REQUEST)

    fields["note"] = str(request.data.get("note") or "")[:500]

    entry, created = DailyCheckIn.objects.update_or_create(
        patient=patient, on_date=on_date, defaults={**fields, "recorded_at": timezone.now()}
    )
    audit(request, "monitoring.check_in", "patient", patient.id, on_date=on_date.isoformat())
    return Response(
        {
            "on_date": entry.on_date.isoformat(),
            "tinnitus_loudness": entry.tinnitus_loudness,
            "tinnitus_annoyance": entry.tinnitus_annoyance,
            "sleep_quality": entry.sleep_quality,
            "stress_level": entry.stress_level,
            "mood": entry.mood,
            "note": entry.note,
            "created": created,
        },
        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )


@api_view(["GET"])
@permission_classes([IsClinician])
def clinician_monitoring(request, patient_id: int):
    """A clinician's view of one of their patients' monitoring data.

    `assert_clinician_access` is the gate, and it is the same one every other
    clinician endpoint uses: a clinician sees the patients assigned to them.
    A patient who has not chosen a clinician has no one this can return for,
    which is the intended behaviour — their monitoring stays private until they
    enter into a care relationship.
    """
    patient = Patient.objects.select_related("user", "clinician").filter(pk=patient_id).first()
    if patient is None:
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
    assert_clinician_access(request.user, patient)

    payload = _monitoring_for(patient)
    payload["patient"] = {
        "id": patient.id,
        "full_name": patient.user.full_name,
        "mrn": patient.mrn,
    }
    audit(request, "monitoring.view", "patient", patient.id)
    return Response(payload)


@api_view(["GET"])
@permission_classes([AllowAny])
def therapy_spectrum(request):
    """Delivered spectrum, computed with the same biquads the browser will use."""

    def num(name, default=None, cast=float):
        raw = request.query_params.get(name)
        if raw in (None, "", "null"):
            return default
        return cast(raw)

    return Response(
        analyse_prescription_spectrum(
            notch_hz=num("notch_hz"),
            width_octaves=num("width_octaves", 0.5),
            depth_db=num("depth_db", 40.0),
            stages=num("stages", 3, int),
            noise_color=request.query_params.get("noise_color", "pink"),
            high_cut_hz=num("high_cut_hz", 14000.0),
            low_cut_hz=num("low_cut_hz", 120.0),
            tinnitus_hz=num("tinnitus_hz"),
        )
    )


@api_view(["GET"])
def therapy_preview(request):
    """What-if: the plan for a hypothetical pitch match, before committing to it."""
    patient = resolve_patient(request)
    pitch_hz = float(request.query_params.get("pitch_hz", 6000))
    bandwidth = request.query_params.get("bandwidth", "tonal")
    assessment = latest_complete(patient)
    base = svc.assessment_dict(assessment) if assessment else {}
    plan = prescribe(
        patient=svc.patient_dict(patient),
        assessment={
            **base,
            "pitch_match_hz": pitch_hz,
            "pitch_match_confidence": 0.9,
            "octave_confusion": False,
            "tinnitus_bandwidth": bandwidth,
        },
        revision=0,
    )
    return Response({"hypothetical": True, "pitch_hz": pitch_hz, "plan": plan})


# --------------------------------------------------------------------------- #
# Diary
# --------------------------------------------------------------------------- #
TRIGGER_OPTIONS = [
    {"key": "loud_noise", "label": "Loud noise exposure", "group": "acoustic"},
    {"key": "headphones", "label": "Headphone use", "group": "acoustic"},
    {"key": "quiet_room", "label": "Very quiet environment", "group": "acoustic"},
    {"key": "poor_sleep", "label": "Poor sleep", "group": "physiological"},
    {"key": "stress", "label": "Stressful day", "group": "psychological"},
    {"key": "anxiety", "label": "Anxiety episode", "group": "psychological"},
    {"key": "caffeine", "label": "Caffeine", "group": "dietary"},
    {"key": "alcohol", "label": "Alcohol", "group": "dietary"},
    {"key": "salty_food", "label": "Salty food", "group": "dietary"},
    {"key": "dehydration", "label": "Dehydration", "group": "physiological"},
    {"key": "jaw_clenching", "label": "Jaw clenching or grinding", "group": "somatic"},
    {"key": "neck_tension", "label": "Neck or shoulder tension", "group": "somatic"},
    {"key": "exercise", "label": "Exercise", "group": "physiological"},
    {"key": "illness", "label": "Cold, flu or congestion", "group": "physiological"},
    {"key": "weather", "label": "Weather or pressure change", "group": "environmental"},
    {"key": "medication_change", "label": "Medication change", "group": "medical"},
    {"key": "screen_time", "label": "Long screen session", "group": "environmental"},
    {"key": "menstrual", "label": "Menstrual cycle", "group": "physiological"},
]

MOOD_OPTIONS = ["very_low", "low", "neutral", "good", "very_good"]


@api_view(["GET"])
@permission_classes([AllowAny])
def diary_options(request):
    return Response(
        {
            "triggers": TRIGGER_OPTIONS,
            "moods": MOOD_OPTIONS,
            "pitch_shift": ["higher", "same", "lower", "unsure"],
            "note": "Triggers are a fixed vocabulary so that within-patient correlation analysis "
            "remains valid across weeks.",
        }
    )


@api_view(["GET", "POST"])
def diary(request):
    patient = resolve_patient(request)

    if request.method == "POST":
        serializer = DiarySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        entry_date = data.pop("entry_date", None) or date.today()
        entry, _ = DiaryEntry.objects.update_or_create(
            patient=patient, entry_date=entry_date, defaults=data
        )
        check_diary_alerts(patient=patient)
        return Response(DiarySerializer(entry).data, status=status.HTTP_201_CREATED)

    days = int(request.query_params.get("days", 90))
    since = date.today() - timedelta(days=days)
    rows = DiaryEntry.objects.filter(patient=patient, entry_date__gte=since).order_by("-entry_date")
    return Response(DiarySerializer(rows, many=True).data)


@api_view(["GET"])
def diary_today(request):
    patient = resolve_patient(request)
    entry = DiaryEntry.objects.filter(patient=patient, entry_date=date.today()).first()
    return Response(DiarySerializer(entry).data if entry else None)


@api_view(["GET"])
def diary_analytics_view(request):
    patient = resolve_patient(request)
    days = int(request.query_params.get("days", 90))
    since = date.today() - timedelta(days=days)
    rows = DiaryEntry.objects.filter(patient=patient, entry_date__gte=since).order_by("entry_date")
    result = diary_analytics(svc.diary_dicts(list(rows)))
    result["window_days"] = days
    result["trigger_note"] = (
        "These are within-patient observational associations from your own diary, not proof of "
        "causation. A trigger needs at least three exposed and three unexposed days before it is "
        "reported at all."
    )
    return Response(result)


@api_view(["GET", "POST"])
def diary_reminders(request):
    patient = resolve_patient(request)
    if request.method == "POST":
        serializer = MedicationReminderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        reminder = MedicationReminder.objects.create(patient=patient, **serializer.validated_data)
        return Response(MedicationReminderSerializer(reminder).data, status=status.HTTP_201_CREATED)
    rows = MedicationReminder.objects.filter(patient=patient).order_by("created_at")
    return Response(MedicationReminderSerializer(rows, many=True).data)


@api_view(["DELETE"])
def diary_reminder_detail(request, reminder_id: int):
    patient = resolve_patient(request)
    MedicationReminder.objects.filter(pk=reminder_id, patient=patient).update(active=False)
    return Response(status=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Chat
# --------------------------------------------------------------------------- #
@api_view(["GET"])
@permission_classes([AllowAny])
def chat_meta(request):
    configured = bool(dj_settings.ANTHROPIC_API_KEY)
    return Response(
        {
            "languages": [{"code": k, **v} for k, v in LANGUAGES.items()],
            "education_topics": EDUCATION_TOPICS,
            "crisis_resources": CRISIS_RESOURCES,
            "engine": "claude+rules" if configured else "rules",
            "engine_note": (
                "Claude is configured; safety routing still runs deterministically before any model call."
                if configured
                else "Running the built-in offline engine. Set ECHOSENSE_ANTHROPIC_API_KEY to enable Claude."
            ),
            "disclaimer": "This assistant provides education and support. It does not diagnose, does not "
            "prescribe, and does not replace your audiologist. In an emergency, contact emergency services.",
        }
    )


def build_chat_context(patient: Patient) -> dict[str, Any]:
    """Assemble the record the assistant is allowed to reference."""
    assessment = latest_complete(patient)
    prescription = active_prescription(patient)
    appointment = (
        Appointment.objects.filter(patient=patient, status="scheduled").order_by("scheduled_for").first()
    )
    entries = DiaryEntry.objects.filter(
        patient=patient, entry_date__gte=date.today() - timedelta(days=90)
    ).order_by("entry_date")

    correlations = trigger_correlation(
        [{"ringing_intensity": e.ringing_intensity, "triggers": e.triggers or []} for e in entries]
    )
    ctx: dict[str, Any] = {
        "full_name": patient.user.full_name,
        "age": patient.age,
        "duration_months": patient.duration_months,
        "hyperacusis": patient.hyperacusis,
        "medications": patient.medications or [],
        "top_triggers": [
            c["trigger"] for c in correlations if c["direction"] == "worse" and c["strength"] != "none"
        ],
        "next_appointment": appointment.scheduled_for.strftime("%d %B %Y at %H:%M") if appointment else None,
    }
    if assessment:
        mask = maskability(assessment.mml_db_sl, assessment.loudness_match_db_sl)
        ri = classify_residual_inhibition(assessment.ri_depth_pct, assessment.ri_duration_s)
        tri = (assessment.derived or {}).get("tri") or {}
        ctx.update(
            {
                "pitch_match_hz": assessment.pitch_match_hz,
                "loudness_match_db_sl": assessment.loudness_match_db_sl,
                "mml_db_sl": assessment.mml_db_sl,
                "maskability_category": mask.get("category"),
                "ri_category": ri.get("category"),
                "thi_score": assessment.thi_score,
                "thi_grade": assessment.thi_grade,
                "psqi_score": assessment.psqi_score,
                "pss10_score": assessment.pss10_score,
                "gad7_score": assessment.gad7_score,
                "who_grade": assessment.hearing_grade,
                "tri_score": tri.get("score"),
                "tri_band": tri.get("band"),
            }
        )
    if prescription:
        ctx["program"] = prescription.program or []
        ctx["daily_minutes_target"] = prescription.daily_minutes_target
    return ctx


@api_view(["POST"])
def chat_send(request):
    patient = resolve_patient(request)
    serializer = ChatRequestSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    message = serializer.validated_data["message"]
    locale = serializer.validated_data.get("locale") or patient.user.locale

    history = list(ChatMessage.objects.filter(patient=patient).order_by("-created_at")[:12])[::-1]
    result = chat_respond(
        message=message,
        patient_context=build_chat_context(patient),
        locale=locale,
        history=[{"role": m.role, "content": m.content} for m in history],
    )

    ChatMessage.objects.create(
        patient=patient,
        role="user",
        content=message,
        locale=result["locale"],
        intent=result["intent"],
        safety_flag=result.get("safety_flag") or "",
    )
    ChatMessage.objects.create(
        patient=patient,
        role="assistant",
        content=result["reply"],
        locale=result["locale"],
        intent=result["intent"],
        engine=result["engine"],
    )

    # A safety flag in a chat turn raises a clinician alert immediately. This is the
    # one place a conversational feature must not stay conversational.
    if result.get("escalate"):
        critical = result.get("safety_flag") == "self_harm_risk"
        Alert.objects.create(
            patient=patient,
            severity="critical",
            kind=f"chat:{result.get('safety_flag')}",
            title="Safety disclosure in counselling chat"
            if critical
            else "Possible otological red flag reported in chat",
            detail=(result.get("escalation_reason", "") or "")
            + " The patient was shown crisis resources and advised to seek urgent human care. "
            "Contact required.",
            evidence={
                "intent": result["intent"],
                "matched_patterns": result.get("matched_patterns", []),
                "source": "counselling_chat",
            },
        )

    return Response(
        {
            "reply": result["reply"],
            "intent": result["intent"],
            "confidence": result["confidence"],
            "locale": result["locale"],
            "engine": result["engine"],
            "safety_flag": result.get("safety_flag"),
            "escalate": bool(result.get("escalate")),
            "suggestions": result.get("suggestions", []),
            "distortions": result.get("distortions", []),
            "crisis_resources": result.get("crisis_resources", []),
            "note": result.get("note"),
        }
    )


@api_view(["GET", "DELETE"])
def chat_history(request):
    patient = resolve_patient(request)

    if request.method == "DELETE":
        # Safety-flagged turns are retained: the clinical record of a disclosure is
        # not the patient's to erase.
        ChatMessage.objects.filter(patient=patient).filter(Q(safety_flag="") | Q(safety_flag__isnull=True)).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    limit = int(request.query_params.get("limit", 60))
    rows = list(ChatMessage.objects.filter(patient=patient).order_by("-created_at")[:limit])[::-1]
    return Response(
        {
            "messages": [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "created_at": m.created_at,
                    "intent": m.intent,
                    "locale": m.locale,
                    "engine": m.engine,
                    "safety_flag": m.safety_flag or None,
                }
                for m in rows
            ]
        }
    )


# --------------------------------------------------------------------------- #
# Consultation (patient-facing)
# --------------------------------------------------------------------------- #
# The clinician endpoints below read the same two models, but from the other
# direction: `appointments` is filtered by `clinician=request.user` and is gated
# on `IsClinician`, so a patient could never see their own appointment through
# it. Rather than widen that permission — which would also expose every *other*
# patient on the clinician's list — these are separate views scoped through
# `resolve_patient`, the same single chokepoint every other patient-facing
# endpoint uses. Clinician authorisation is untouched.
CONSULTATION_KINDS = ["follow_up", "review", "counselling", "fitting", "initial"]
CONSULTATION_MODALITIES = ["teleaudiology", "in_person", "telephone"]


# How long before and after the start a video consultation counts as "now".
#
# Read from settings so the join window, the notice and any deployment override
# all agree on one number. A client computing "ten minutes" independently is how
# the notice fires at a different moment from the button appearing.
JOIN_OPENS_MINUTES = dj_settings.CONSULTATION_JOIN_OPENS_MINUTES


def _meeting_link_for(appointment: Appointment) -> str:
    """The room this consultation happens in.

    **Every consultation uses the same standing room** — see
    `settings.CONSULTATION_MEET_LINK` for why. A per-appointment link is still
    honoured if one has been set, so a clinician who needs a one-off room for a
    particular consultation can still have it, and every historical appointment
    that already carries a link keeps working. What changed is that setting one
    is no longer required for the patient to be able to join.

    Resolution order, most specific first:
      1. a link set on this appointment,
      2. the clinician's own standing room, if they have configured one,
      3. the service-wide room.
    """
    if appointment.meeting_link:
        return appointment.meeting_link
    profile = getattr(appointment.clinician, "clinician_profile", None)
    if profile and profile.default_meeting_link:
        return profile.default_meeting_link
    return dj_settings.CONSULTATION_MEET_LINK or ""


def _appointment_payload(appointment: Appointment, *, reveal_link: bool = False) -> dict[str, Any]:
    """One appointment, with the join window resolved server-side.

    The client is told *whether* it can join, not the rules for working it out.
    Two clients computing "is it time yet?" from a start time and their own clock
    is how a patient ends up staring at a disabled button during their
    appointment because their laptop clock drifted.

    `reveal_link` is the difference between the two audiences, and it is a
    genuine difference rather than a permission check bolted on:

    * A **patient** is not sent the room until the join window opens. Handing it
      over early and asking the UI not to render it is not a visibility rule, it
      is a suggestion — the value would still be in the network tab.
    * A **clinician** is sent it always. They need it to set up, to paste into a
      calendar invitation, and to open the room before the patient arrives.
      Withholding it from them would be withholding it from the person running
      the consultation.
    """
    profile = getattr(appointment.clinician, "clinician_profile", None)
    minutes = max(5, int(profile.slot_minutes)) if profile else 30
    now = timezone.now()
    opens = appointment.scheduled_for - timedelta(minutes=JOIN_OPENS_MINUTES)
    closes = appointment.scheduled_for + timedelta(minutes=minutes)
    link = _meeting_link_for(appointment)
    is_online = appointment.modality == "teleaudiology"
    live = is_online and appointment.status == "scheduled" and opens <= now <= closes

    # Which of the four consultation phases this appointment is in.
    #
    # Derived here rather than on the client for the same reason `can_join` is:
    # a browser comparing the start time against its own clock decides the
    # patient's consultation "has not started" while the clinician is already
    # waiting in the room. One clock, on the server, settles it.
    #
    #   upcoming  → more than JOIN_OPENS_MINUTES away; no link is exposed
    #   imminent  → inside the join window but not yet started
    #   live      → running
    #   ended     → past its end, or explicitly completed/cancelled
    if appointment.status in {"cancelled", "no_show"}:
        phase = "closed"
    elif appointment.status == "completed" or now > closes:
        phase = "ended"
    elif now >= appointment.scheduled_for:
        phase = "live"
    elif now >= opens:
        phase = "imminent"
    else:
        phase = "upcoming"

    starts_in = int((appointment.scheduled_for - now).total_seconds())

    return {
        "id": appointment.id,
        "scheduled_for": appointment.scheduled_for.isoformat(),
        "ends_at": closes.isoformat(),
        "kind": appointment.kind,
        "modality": appointment.modality,
        "status": appointment.status,
        "notes": appointment.notes,
        "clinician_name": appointment.clinician.full_name if appointment.clinician_id else None,
        "clinician_specialization": (profile.specialization if profile else "") or "",
        "duration_minutes": minutes,
        # Withheld from a patient until the window opens; always present for
        # the clinician running the consultation. See `reveal_link` above.
        "meeting_link": link if (reveal_link or live) else "",
        "has_meeting_link": bool(link),
        # `can_join` is the only thing the UI should gate the button on.
        "can_join": bool(live and link),
        "join_opens_at": opens.isoformat() if is_online else None,
        "is_online": is_online,
        "phase": phase,
        # Negative once the start time has passed. The client counts down from
        # this rather than from `scheduled_for`, so a drifted clock shifts the
        # countdown by its drift instead of changing which phase is shown.
        "starts_in_seconds": starts_in,
    }


@api_view(["GET"])
def consultation(request):
    """Everything a patient needs about their care team on one screen.

    Deliberately assembled server-side rather than by the client stitching four
    calls together: the patient view of "my next appointment" has to agree with
    the clinician's, and two clients deriving it independently is how those
    drift apart.
    """
    patient = resolve_patient(request)
    now = timezone.now()

    appointments_qs = list(
        Appointment.objects.filter(patient=patient).select_related("clinician").order_by("scheduled_for")
    )
    # "Upcoming" is future *and* not already closed out — a cancelled slot next
    # week is not something to show a patient as their next appointment.
    upcoming = [
        a for a in appointments_qs if a.scheduled_for >= now and a.status in {"scheduled", "requested"}
    ]
    history = [a for a in reversed(appointments_qs) if a not in upcoming]

    notes = ClinicalNote.objects.filter(patient=patient).select_related("clinician").order_by("-created_at")[:8]

    latest = (
        Assessment.objects.filter(patient=patient, status=AssessmentStatus.COMPLETE)
        .order_by("-created_at")
        .first()
    )
    prescription = active_prescription(patient)

    # Follow-up recommendations, in the order a patient would act on them: the
    # safety ones first, then the plan review date, then the routine cadence.
    recommendations: list[dict[str, str]] = []
    for alert in Alert.objects.filter(patient=patient, acknowledged_at__isnull=True).order_by("-created_at")[:4]:
        if alert.urgency in {"emergency", "urgent", "soon"}:
            recommendations.append(
                {"urgency": alert.urgency, "title": alert.title, "detail": alert.detail}
            )
    if prescription:
        due = prescription.created_at + timedelta(days=prescription.review_after_days)
        recommendations.append(
            {
                "urgency": "routine" if due >= now else "soon",
                "title": "Therapy plan review",
                "detail": (
                    f"Your programme was written to be reviewed after {prescription.review_after_days} days"
                    f" — that was due {due.date().isoformat()}."
                    if due < now
                    else f"Your programme is due for review on {due.date().isoformat()}."
                ),
            }
        )
    if not upcoming:
        recommendations.append(
            {
                "urgency": "routine",
                "title": "No appointment booked",
                "detail": "Request one below and your clinician will confirm a time.",
            }
        )

    clinician_block: dict[str, Any] = {
        "id": patient.clinician_id,
        "name": patient.clinician.full_name if patient.clinician_id else None,
        "email": patient.clinician.email if patient.clinician_id else None,
        "assigned": patient.clinician_id is not None,
    }
    if patient.clinician_id:
        clinician_block.update(sched.profile_payload(patient.clinician))

    return Response(
        {
            "clinician": clinician_block,
            "upcoming": [_appointment_payload(a) for a in upcoming],
            "history": [_appointment_payload(a) for a in history],
            "notes": [
                {
                    "id": n.id,
                    "created_at": n.created_at.isoformat(),
                    "body": n.body,
                    "clinician_name": n.clinician.full_name if n.clinician_id else None,
                    "ai_draft": n.ai_draft,
                }
                for n in notes
            ],
            "recommendations": recommendations,
            "summary": {
                "assessment_date": latest.created_at.date().isoformat() if latest else None,
                "thi_score": latest.thi_score if latest else None,
                "thi_grade": latest.thi_grade if latest else None,
                "hearing_grade": latest.hearing_grade if latest else None,
                "laterality": patient.laterality or None,
                "plan_active": prescription is not None,
                "plan_blocks": len(prescription.program) if prescription else 0,
                "daily_minutes_target": prescription.daily_minutes_target if prescription else None,
                "review_after_days": prescription.review_after_days if prescription else None,
            },
            "treatment_recommendations": list(prescription.rationale) if prescription else [],
            "options": {"kinds": CONSULTATION_KINDS, "modalities": CONSULTATION_MODALITIES},
        }
    )


@api_view(["GET"])
def consultation_doctors(request):
    """The doctors a patient can choose between, with availability to compare.

    Patients are never silently routed to a clinician: booking starts here, with
    every accepting clinician side by side, and the patient picks. Their existing
    clinician (if they have one) is flagged rather than pre-selected, so
    continuity is visible without being imposed.
    """
    patient = resolve_patient(request)
    return Response(
        {
            "current_clinician_id": patient.clinician_id,
            "doctors": sched.directory(),
        }
    )


@api_view(["POST"])
def consultation_select_clinician(request):
    """Confirm a clinician as this patient's own, without booking anything.

    Separate from `consultation_request` on purpose. Choosing who looks after
    you and choosing when to see them are two decisions, and forcing the first
    to happen as a side effect of the second means a patient cannot browse the
    directory, pick a doctor, and *then* look at their calendar — which is the
    order people actually do it in.

    Re-selection is allowed and is a transfer of care, so it is audited with
    both the previous and the new clinician. Existing appointments are left
    alone: an already-confirmed slot with the previous clinician is a commitment
    they have both made, and silently moving it is worse than leaving it.
    """
    patient = resolve_patient(request)

    raw = request.data.get("clinician_id")
    try:
        chosen_id = int(raw)
    except (TypeError, ValueError):
        return Response({"detail": "Choose a doctor."}, status=status.HTTP_400_BAD_REQUEST)

    clinician = (
        User.objects.select_related("clinician_profile")
        .filter(pk=chosen_id, role=Role.CLINICIAN, is_active=True)
        .first()
    )
    if clinician is None:
        return Response({"detail": "That doctor is not available."}, status=status.HTTP_404_NOT_FOUND)

    profile = getattr(clinician, "clinician_profile", None)
    if profile is not None and not profile.accepting_patients:
        return Response(
            {"detail": f"{clinician.full_name} is not accepting new patients at the moment."},
            status=status.HTTP_409_CONFLICT,
        )

    previous_id = patient.clinician_id
    patient.clinician = clinician
    patient.save(update_fields=["clinician"])

    audit(
        request,
        "consultation.select_clinician",
        "patient",
        patient.id,
        clinician_id=clinician.id,
        previous_clinician_id=previous_id,
    )

    block: dict[str, Any] = {
        "id": clinician.id,
        "name": clinician.full_name,
        "email": clinician.email,
        "assigned": True,
        "changed": previous_id is not None and previous_id != clinician.id,
    }
    block.update(sched.profile_payload(clinician))
    return Response({"clinician": block})


def _bookable_clinician(request, patient) -> User | None:
    """Resolve the clinician a request is about: explicit choice, else current."""
    raw = request.query_params.get("clinician_id") or request.data.get("clinician_id")
    if raw:
        try:
            chosen = int(raw)
        except (TypeError, ValueError):
            return None
        return (
            User.objects.select_related("clinician_profile")
            .filter(pk=chosen, role=Role.CLINICIAN, is_active=True)
            .first()
        )
    return patient.clinician


@api_view(["GET"])
def consultation_slots(request):
    """Bookable slots for a chosen clinician.

    `?clinician_id=` selects the doctor; without it the patient's current one is
    used, so the consultation screen still works for someone who already has a
    care relationship. `?date=YYYY-MM-DD` returns one day, otherwise the whole
    booking horizon — a calendar can then show which days have capacity without
    a request per day.
    """
    patient = resolve_patient(request)
    clinician = _bookable_clinician(request, patient)
    if clinician is None:
        return Response({"clinician": None, "days": []})

    raw = request.query_params.get("date")
    if raw:
        try:
            day = Date.fromisoformat(raw)
        except ValueError:
            return Response({"detail": "date must be YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        slots = sched.day_slots(clinician, day)
        days = [
            {
                "date": day.isoformat(),
                "weekday": sched.WEEKDAY_NAMES[day.isoweekday()],
                "working": day.isoweekday() in sched.working_days(sched.profile_for(clinician)),
                "slots": slots,
                "open_count": sum(1 for s in slots if s["available"]),
            }
        ]
    else:
        days = sched.availability(clinician)

    return Response({"clinician": sched.profile_payload(clinician), "days": days})


@api_view(["POST"])
@transaction.atomic
def consultation_request(request):
    """Book a consultation slot with the assigned clinician.

    Written as an `Appointment` with `status="requested"` rather than a separate
    request model, so it lands directly in the clinician's existing appointment
    list instead of a queue nobody is looking at. The clinician confirms by
    moving it to `scheduled`.

    Three things are refused, in the order a patient would hit them: a time that
    is not a real slot in the clinician's working pattern, a slot somebody else
    already holds, and a second live booking by a patient who already has one.
    The middle check is advisory — `Appointment`'s partial unique constraint is
    what actually settles a race, and `IntegrityError` below is that constraint
    firing, not a bug.
    """
    patient = resolve_patient(request)
    clinician = _bookable_clinician(request, patient)
    if clinician is None:
        return Response(
            {"detail": "Choose a doctor before booking."}, status=status.HTTP_400_BAD_REQUEST
        )

    raw = request.data.get("scheduled_for")
    when = parse_datetime(str(raw)) if raw else None
    if when is None:
        return Response(
            {"detail": "Choose a date and an available time."}, status=status.HTTP_400_BAD_REQUEST
        )
    if timezone.is_naive(when):
        when = timezone.make_aware(when)
    when = when.replace(second=0, microsecond=0)

    if when < timezone.now():
        return Response({"detail": "That time has already passed."}, status=status.HTTP_400_BAD_REQUEST)

    profile = sched.profile_for(clinician)
    horizon = timezone.localdate() + timedelta(days=max(1, int(profile.booking_horizon_days or 30)))
    if timezone.localtime(when).date() > horizon:
        return Response(
            {"detail": f"Appointments can only be booked up to {profile.booking_horizon_days} days ahead."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if not sched.slot_exists(clinician, when):
        return Response(
            {"detail": f"That time is not one of {clinician.full_name}'s consultation slots."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if Appointment.objects.filter(
        clinician=clinician, scheduled_for=when, status__in=sched.BLOCKING_STATUSES
    ).exists():
        return Response(
            {"detail": "That slot has just been taken. Please choose another time."},
            status=status.HTTP_409_CONFLICT,
        )

    # One live booking at a time. Without this a patient can quietly accumulate
    # six slots and the clinician's week is gone.
    existing = Appointment.objects.filter(
        patient=patient, scheduled_for__gte=timezone.now(), status__in={"scheduled", "requested"}
    ).first()
    if existing is not None:
        return Response(
            {
                "detail": "You already have an upcoming appointment. Cancel it before booking another.",
                "appointment": _appointment_payload(existing),
            },
            status=status.HTTP_409_CONFLICT,
        )

    kind = str(request.data.get("kind") or "follow_up")
    modality = str(request.data.get("modality") or "teleaudiology")
    if kind not in CONSULTATION_KINDS or modality not in CONSULTATION_MODALITIES:
        return Response({"detail": "Unknown appointment type."}, status=status.HTTP_400_BAD_REQUEST)

    try:
        appointment = Appointment.objects.create(
            patient=patient,
            clinician=clinician,
            scheduled_for=when,
            kind=kind,
            modality=modality,
            status="requested",
            notes=str(request.data.get("notes") or "")[:2000],
        )
    except IntegrityError:
        return Response(
            {"detail": "That slot has just been taken. Please choose another time."},
            status=status.HTTP_409_CONFLICT,
        )

    # The care relationship forms from the patient's choice. Only filled when
    # empty — booking a one-off with a colleague must not silently transfer a
    # patient off the clinician who has been treating them.
    if patient.clinician_id is None:
        patient.clinician = clinician
        patient.save(update_fields=["clinician"])

    audit(
        request,
        "consultation.request",
        "appointment",
        appointment.id,
        patient_id=patient.id,
        clinician_id=clinician.id,
    )
    return Response(_appointment_payload(appointment), status=status.HTTP_201_CREATED)


@api_view(["POST"])
def consultation_cancel(request, appointment_id: int):
    """Cancel one's own upcoming appointment, freeing the slot for someone else."""
    patient = resolve_patient(request)
    appointment = Appointment.objects.filter(pk=appointment_id, patient=patient).first()
    if appointment is None:
        return Response({"detail": "Appointment not found."}, status=status.HTTP_404_NOT_FOUND)
    if appointment.scheduled_for < timezone.now():
        return Response(
            {"detail": "That appointment has already passed."}, status=status.HTTP_400_BAD_REQUEST
        )

    appointment.status = "cancelled"
    appointment.save(update_fields=["status"])
    audit(request, "consultation.cancel", "appointment", appointment.id, patient_id=patient.id)
    return Response(_appointment_payload(appointment))


# --------------------------------------------------------------------------- #
# Clinician
# --------------------------------------------------------------------------- #
@api_view(["GET"])
@permission_classes([IsClinician])
def caseload(request):
    """This clinician's caseload, triage-ranked — safety first by design.

    Scoped through `caseload_patients`, not `visible_patients`: the console is a
    worklist, and every unassigned registration in the system appearing on it
    made the ranking useless.
    """
    rows: list[dict[str, Any]] = []
    today = date.today()

    for patient in caseload_patients(request.user):
        assessments_qs = list(
            Assessment.objects.filter(patient=patient, status=AssessmentStatus.COMPLETE).order_by(
                "-created_at"
            )[:2]
        )
        latest = assessments_qs[0] if assessments_qs else None
        previous = assessments_qs[1] if len(assessments_qs) > 1 else None
        prediction = Prediction.objects.filter(assessment=latest).first() if latest else None

        entries = list(
            DiaryEntry.objects.filter(patient=patient, entry_date__gte=today - timedelta(days=14)).order_by(
                "entry_date"
            )
        )
        intensities = [e.ringing_intensity for e in entries if e.ringing_intensity is not None]
        trend = None
        if len(intensities) >= 5:
            n = len(intensities)
            xs = list(range(n))
            mx, my = sum(xs) / n, sum(intensities) / n
            denom = sum((x - mx) ** 2 for x in xs)
            if denom:
                trend = round(sum((x - mx) * (y - my) for x, y in zip(xs, intensities)) / denom * 7, 2)

        sessions = TherapySession.objects.filter(
            patient=patient, started_at__gte=timezone.now() - timedelta(days=28)
        )
        prescription = active_prescription(patient)
        target = (prescription.daily_minutes_target if prescription else 60) * 28
        actual = sum(s.actual_seconds for s in sessions) / 60
        adherence = round(min(100.0, 100 * actual / target), 1) if target else None

        open_alerts = list(Alert.objects.filter(patient=patient, acknowledged_at__isnull=True))
        order = {"emergency": 3, "urgent": 2, "soon": 1, "routine": 0}
        highest = max((a.urgency for a in open_alerts), key=lambda u: order.get(u, 0), default="routine")

        appointment = (
            Appointment.objects.filter(patient=patient, status="scheduled").order_by("scheduled_for").first()
        )
        tri = (latest.derived or {}).get("tri") if latest else None

        payload = {
            "patient_id": patient.id,
            "mrn": patient.mrn,
            "full_name": patient.user.full_name,
            "age": patient.age,
            "laterality": patient.laterality or None,
            "duration_months": patient.duration_months,
            "last_assessment": latest.created_at if latest else None,
            "thi_score": latest.thi_score if latest else None,
            "thi_grade": latest.thi_grade if latest else None,
            "thi_change": (
                latest.thi_score - previous.thi_score
                if latest and previous and latest.thi_score is not None and previous.thi_score is not None
                else None
            ),
            "tri_score": (tri or {}).get("score"),
            "tri_band": (tri or {}).get("band"),
            "worsening_risk": prediction.worsening_risk if prediction else None,
            "risk_band": prediction.risk_band if prediction else None,
            "adherence_pct": adherence,
            "diary_days_14": len(entries),
            "diary_mean_14": round(sum(intensities) / len(intensities), 2) if intensities else None,
            "diary_trend": trend,
            "open_alerts": len(open_alerts),
            "highest_urgency": highest,
            "next_appointment": appointment.scheduled_for if appointment else None,
        }
        score, reasons = triage_score(payload)
        rows.append({**payload, "triage_score": score, "triage_reasons": reasons})

    rows.sort(key=lambda r: -r["triage_score"])
    return Response(rows)


def _ear_model_inputs(assessments: Sequence[Assessment]) -> dict[str, Any] | None:
    """Thresholds and matched pitch for the 3D cochlea, or None if unmeasured.

    Takes the whole series, newest last, and picks the most recent assessment
    that actually *has* an audiogram — not simply the most recent one. A patient
    who abandons the hearing measurement on a later visit still has thresholds on file,
    and reading only the newest record showed "no audiogram" for people with
    three of them.

    The matched pitch is resolved independently for the same reason: pitch
    matching is optional, so the latest audiogram and the latest pitch match are
    frequently on different assessments.

    Prefers the worse ear. A clinician opening this wants to see the damage, and
    defaulting to the right ear would hide a unilateral loss on the left half the
    time.
    """

    def usable(assessment: Assessment) -> dict[str, dict[str, Any]] | None:
        audiogram = assessment.audiogram or {}
        left, right = audiogram.get("left") or {}, audiogram.get("right") or {}
        return {"left": left, "right": right} if (left or right) else None

    source = next(((a, ears) for a in reversed(list(assessments)) if (ears := usable(a))), None)
    if source is None:
        return None
    assessment, ears = source

    def mean(values: dict[str, Any]) -> float:
        numeric = [float(v) for v in values.values() if isinstance(v, (int, float))]
        return sum(numeric) / len(numeric) if numeric else -1.0

    ear = "left" if mean(ears["left"]) > mean(ears["right"]) else "right"
    pitch = next(
        (a.pitch_match_hz for a in reversed(list(assessments)) if a.pitch_match_hz), None
    )
    return {
        "ear": ear,
        "thresholds": ears[ear],
        "pitch_match_hz": pitch,
        "hearing_grade": assessment.hearing_grade,
        "assessment_id": assessment.id,
        # Surfaced so the UI can say "from your March hearing measurement" rather than
        # implying the cochlea reflects the assessment currently on screen.
        "measured_at": assessment.created_at.date().isoformat(),
    }


@api_view(["GET"])
@permission_classes([IsClinician])
def patient_overview(request, patient_id: int):
    """Everything about one patient on one screen, including the trajectory."""
    patient = Patient.objects.select_related("user").filter(pk=patient_id).first()
    if patient is None:
        return Response({"detail": "Patient not found."}, status=status.HTTP_404_NOT_FOUND)
    assert_clinician_access(request.user, patient)

    assessments_qs = list(
        Assessment.objects.filter(patient=patient, status=AssessmentStatus.COMPLETE).order_by("created_at")
    )
    trajectory = [
        {
            "assessment_id": a.id,
            "date": a.created_at.date().isoformat(),
            "thi": a.thi_score,
            "thi_grade": a.thi_grade,
            "tri": ((a.derived or {}).get("tri") or {}).get("score"),
            "psqi": a.psqi_score,
            "gad7": a.gad7_score,
            "pss10": a.pss10_score,
            "vas_loudness": a.vas_loudness,
            "vas_annoyance": a.vas_annoyance,
            "pitch_hz": a.pitch_match_hz,
            "mml_db_sl": a.mml_db_sl,
            "pta_better": min([v for v in (a.pta_left, a.pta_right) if v is not None], default=None),
        }
        for a in assessments_qs
    ]

    thi_values = [t["thi"] for t in trajectory if t["thi"] is not None]
    change = None
    if len(thi_values) >= 2:
        delta = thi_values[-1] - thi_values[0]
        change = {
            "baseline": thi_values[0],
            "current": thi_values[-1],
            "delta": delta,
            "direction": "improved" if delta <= -7 else "worsened" if delta >= 7 else "stable",
            "clinically_significant": abs(delta) >= 7,
            "note": "A change of 7 points or more on the THI is the accepted minimum clinically "
            "important difference.",
        }

    return Response(
        {
            "patient": {
                **PatientSerializer(patient).data,
                "etiology_notes": patient.etiology_notes,
            },
            "trajectory": trajectory,
            "thi_change": change,
            "assessment_count": len(assessments_qs),
            "latest_assessment_id": assessments_qs[-1].id if assessments_qs else None,
            # Enough to render this patient's cochlea in the console without a
            # second round trip or scoping the session to them. The 3D model
            # needs one ear's thresholds and the matched pitch; sending the whole
            # assessment for that would be most of a report per patient card.
            "ear_model": _ear_model_inputs(assessments_qs),
            "prescriptions": [
                {
                    "id": p.id,
                    "revision": p.revision,
                    "active": p.active,
                    "created_at": p.created_at,
                    "daily_minutes_target": p.daily_minutes_target,
                    "generated_by": p.generated_by,
                    "approved_by_id": p.approved_by_id,
                    "blocks": len(p.program or []),
                    "rationale": p.rationale or [],
                    "review_after_days": p.review_after_days,
                }
                for p in TherapyPrescription.objects.filter(patient=patient).order_by("-revision")
            ],
            "alerts": [
                {
                    "id": a.id,
                    "created_at": a.created_at,
                    "severity": a.severity,
                    "kind": a.kind,
                    "title": a.title,
                    "detail": a.detail,
                    "evidence": a.evidence,
                    "acknowledged_at": a.acknowledged_at,
                }
                for a in Alert.objects.filter(patient=patient).order_by("-created_at")
            ],
            "notes": ClinicalNoteSerializer(
                ClinicalNote.objects.filter(patient=patient).order_by("-created_at"), many=True
            ).data,
        }
    )


@api_view(["GET"])
@permission_classes([IsClinician])
def alerts(request):
    # Caseload-scoped, matching the console: an alert about a patient this
    # clinician is not treating is noise they cannot act on.
    patient_ids = list(caseload_patients(request.user).values_list("id", flat=True))
    if not patient_ids:
        return Response([])
    queryset = Alert.objects.filter(patient_id__in=patient_ids).select_related("patient__user")
    if request.query_params.get("unacknowledged_only", "true") != "false":
        queryset = queryset.filter(acknowledged_at__isnull=True)
    severity_rank = {"critical": 0, "warning": 1, "info": 2}
    rows = sorted(
        queryset[: int(request.query_params.get("limit", 100))],
        key=lambda a: (severity_rank.get(a.severity, 3), -a.created_at.timestamp()),
    )
    return Response(AlertSerializer(rows, many=True).data)


@api_view(["POST"])
@permission_classes([IsClinician])
def alert_acknowledge(request, alert_id: int):
    alert = Alert.objects.select_related("patient__user").filter(pk=alert_id).first()
    if alert is None:
        return Response({"detail": "Alert not found."}, status=status.HTTP_404_NOT_FOUND)
    assert_clinician_access(request.user, alert.patient)
    alert.acknowledged_at = timezone.now()
    alert.acknowledged_by = request.user
    alert.save(update_fields=["acknowledged_at", "acknowledged_by"])
    audit(request, "alert.acknowledge", "alert", alert.id)
    return Response(AlertSerializer(alert).data)


@api_view(["GET", "POST"])
@permission_classes([IsClinician])
def appointments(request):
    if request.method == "POST":
        serializer = AppointmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        patient = Patient.objects.filter(pk=request.data.get("patient_id")).first()
        if patient is None:
            return Response({"detail": "Patient not found."}, status=status.HTTP_404_NOT_FOUND)
        assert_clinician_access(request.user, patient)
        appointment = Appointment.objects.create(
            patient=patient,
            clinician=request.user,
            **{k: v for k, v in serializer.validated_data.items() if k != "patient_id"},
        )
        audit(request, "appointment.create", "appointment", appointment.id, patient_id=patient.id)
        return Response(AppointmentSerializer(appointment).data, status=status.HTTP_201_CREATED)

    queryset = Appointment.objects.filter(clinician=request.user).select_related(
        "patient__user", "clinician__clinician_profile"
    )
    if request.query_params.get("upcoming_only", "true") != "false":
        queryset = queryset.filter(scheduled_for__gte=timezone.now())
    # `_appointment_payload` rather than the serializer: the console needs the
    # meeting link and the resolved join window, and deriving those in two places
    # is how the clinician's view of "is this live?" drifts from the patient's.
    return Response(
        [
            {
                # Clinician surface: the room is theirs to prepare with.
                **_appointment_payload(a, reveal_link=True),
                "patient_id": a.patient_id,
                "patient_name": a.patient.user.full_name,
                "patient_mrn": a.patient.mrn,
            }
            for a in queryset.order_by("scheduled_for")
        ]
    )


@api_view(["GET", "PATCH"])
@permission_classes([IsClinician])
def clinician_schedule(request):
    """The clinician's own working pattern, and today's remaining capacity.

    PATCH edits the pattern. Writing the profile row lazily here rather than on
    read keeps GET side-effect free while still meaning a clinician who has never
    touched their schedule is bookable on sensible defaults.
    """
    if request.method == "PATCH":
        profile, _ = ClinicianProfile.objects.get_or_create(
            user=request.user,
            defaults={
                "specialization": sched.DEFAULT_SPECIALIZATION,
                "working_days": list(sched.DEFAULT_WORKING_DAYS),
                "working_hours": [dict(w) for w in sched.DEFAULT_WORKING_HOURS],
            },
        )
        data = request.data
        if "specialization" in data:
            profile.specialization = str(data["specialization"])[:96]
        if "qualifications" in data:
            profile.qualifications = str(data["qualifications"])[:160]
        if "default_meeting_link" in data:
            link = str(data["default_meeting_link"]).strip()
            if link and not _is_meeting_url(link):
                return Response({"detail": MEETING_URL_ERROR}, status=status.HTTP_400_BAD_REQUEST)
            profile.default_meeting_link = link
        if isinstance(data.get("working_days"), list):
            days = sorted({int(d) for d in data["working_days"] if str(d).isdigit() and 1 <= int(d) <= 7})
            if not days:
                return Response(
                    {"detail": "Select at least one working day."}, status=status.HTTP_400_BAD_REQUEST
                )
            profile.working_days = days
        if isinstance(data.get("working_hours"), list):
            profile.working_hours = data["working_hours"]
            # Normalise through the same validator the slot generator uses, so an
            # unparseable window is rejected here instead of silently vanishing
            # from the schedule later.
            if not sched.working_windows(profile):
                return Response(
                    {"detail": "Working hours must be HH:MM ranges with start before end."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            profile.working_hours = sched.working_windows(profile)
        if "slot_minutes" in data:
            try:
                profile.slot_minutes = max(5, min(180, int(data["slot_minutes"])))
            except (TypeError, ValueError):
                return Response({"detail": "slot_minutes must be a number."}, status=status.HTTP_400_BAD_REQUEST)
        profile.save()
        audit(request, "clinician.schedule_update", "clinician", request.user.id)

    profile_data = sched.profile_payload(request.user)
    today = timezone.localdate()
    return Response(
        {
            "profile": {
                **profile_data,
                "default_meeting_link": sched.profile_for(request.user).default_meeting_link or "",
            },
            "today": {
                "date": today.isoformat(),
                "weekday": sched.WEEKDAY_NAMES[today.isoweekday()],
                "slots": sched.day_slots(request.user, today, include_past=True),
            },
            "upcoming_days": sched.availability(request.user, days=14),
        }
    )


MEETING_URL_ERROR = "Enter a valid https:// meeting link (Google Meet, Zoom or Teams)."


def _is_meeting_url(value: str) -> bool:
    """Accept an https URL from a known conferencing host.

    Deliberately not a general URL check: this link is shown to a patient as
    "join your consultation", and pasting an arbitrary http address there is
    either a mistake or a phishing vector.
    """
    if not value.startswith("https://"):
        return False
    host = value[len("https://"):].split("/", 1)[0].lower().split("@")[-1]
    allowed = ("meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com")
    return any(host == h or host.endswith("." + h) for h in allowed)


@api_view(["PATCH"])
@permission_classes([IsClinician])
def clinician_appointment_detail(request, appointment_id: int):
    """Set the meeting link, move the status, or amend the notes.

    This is the confirm step for a patient-requested slot: `status="requested"`
    to `"scheduled"`. The link can be set at any point before the consultation
    and edited afterwards, because in practice a room gets recreated.
    """
    appointment = (
        Appointment.objects.select_related("patient__user", "clinician").filter(pk=appointment_id).first()
    )
    if appointment is None:
        return Response({"detail": "Appointment not found."}, status=status.HTTP_404_NOT_FOUND)
    assert_clinician_access(request.user, appointment.patient)

    changed: list[str] = []
    if "meeting_link" in request.data:
        link = str(request.data["meeting_link"]).strip()
        if link and not _is_meeting_url(link):
            return Response({"detail": MEETING_URL_ERROR}, status=status.HTTP_400_BAD_REQUEST)
        appointment.meeting_link = link
        changed.append("meeting_link")
    if "status" in request.data:
        new_status = str(request.data["status"])
        if new_status not in APPOINTMENT_STATUSES:
            return Response({"detail": "Unknown appointment status."}, status=status.HTTP_400_BAD_REQUEST)
        appointment.status = new_status
        changed.append("status")
    if "notes" in request.data:
        appointment.notes = str(request.data["notes"])[:2000]
        changed.append("notes")

    if not changed:
        return Response({"detail": "Nothing to update."}, status=status.HTTP_400_BAD_REQUEST)

    try:
        appointment.save(update_fields=changed)
    except IntegrityError:
        # Reinstating a cancelled appointment whose slot was taken meanwhile.
        return Response(
            {"detail": "That slot is now held by another appointment."}, status=status.HTTP_409_CONFLICT
        )
    audit(
        request,
        "appointment.update",
        "appointment",
        appointment.id,
        patient_id=appointment.patient_id,
        fields=changed,
    )
    return Response(
        {
            **_appointment_payload(appointment, reveal_link=True),
            "patient_name": appointment.patient.user.full_name,
        }
    )


APPOINTMENT_STATUSES = {"requested", "scheduled", "completed", "cancelled", "no_show"}


@api_view(["POST"])
@permission_classes([IsClinician])
def clinical_notes(request):
    serializer = ClinicalNoteSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    patient = Patient.objects.filter(pk=serializer.validated_data["patient_id"]).first()
    if patient is None:
        return Response({"detail": "Patient not found."}, status=status.HTTP_404_NOT_FOUND)
    assert_clinician_access(request.user, patient)
    note = ClinicalNote.objects.create(
        patient=patient,
        clinician=request.user,
        body=serializer.validated_data["body"],
        icd11_codes=serializer.validated_data.get("icd11_codes", []),
        ai_draft=serializer.validated_data.get("ai_draft", False),
    )
    audit(request, "note.create", "note", note.id, patient_id=patient.id)
    return Response(ClinicalNoteSerializer(note).data, status=status.HTTP_201_CREATED)


@api_view(["POST"])
@permission_classes([IsClinician])
def patient_assign(request, patient_id: int):
    patient = Patient.objects.filter(pk=patient_id).first()
    if patient is None:
        return Response({"detail": "Patient not found."}, status=status.HTTP_404_NOT_FOUND)
    patient.clinician = request.user
    patient.save(update_fields=["clinician"])
    audit(request, "patient.assign", "patient", patient.id)
    return Response({"patient_id": patient.id, "clinician_id": request.user.id})


@api_view(["GET"])
@permission_classes([IsClinician])
def cohort(request):
    """Service-level analytics. Only consented patients enter the distributions."""
    patients = list(caseload_patients(request.user))
    if not patients:
        return Response({"n_patients": 0})

    latest_ids = [
        Assessment.objects.filter(patient=p, status=AssessmentStatus.COMPLETE)
        .order_by("-created_at")
        .values_list("id", flat=True)
        .first()
        for p in patients
    ]
    assessments_qs = list(Assessment.objects.filter(id__in=[i for i in latest_ids if i]))
    consented = {p.id for p in patients if p.consent_research}
    research = [a for a in assessments_qs if a.patient_id in consented]

    def dist(values, bins):
        return [{"label": label, "count": sum(1 for v in values if lo <= v < hi)} for lo, hi, label in bins]

    thi = [a.thi_score for a in research if a.thi_score is not None]
    pitches = [a.pitch_match_hz for a in research if a.pitch_match_hz]
    ptas = [
        min([v for v in (a.pta_left, a.pta_right) if v is not None], default=None) for a in research
    ]
    ptas = [p for p in ptas if p is not None]
    ages = [p.age for p in patients if p.age]

    return Response(
        {
            "n_patients": len(patients),
            "n_assessed": len(assessments_qs),
            "n_consented_research": len(consented),
            "open_alerts": Alert.objects.filter(
                patient_id__in=[p.id for p in patients], acknowledged_at__isnull=True
            ).count(),
            "mean_age": round(sum(ages) / len(ages), 1) if ages else None,
            "thi": {
                "n": len(thi),
                "mean": round(sum(thi) / len(thi), 1) if thi else None,
                "distribution": dist(
                    thi,
                    [(0, 17, "Slight"), (17, 37, "Mild"), (37, 57, "Moderate"), (57, 77, "Severe"), (77, 101, "Catastrophic")],
                ),
            },
            "pitch_hz": {
                "n": len(pitches),
                "median": sorted(pitches)[len(pitches) // 2] if pitches else None,
                "distribution": dist(
                    pitches,
                    [(0, 1000, "<1 kHz"), (1000, 2000, "1-2 kHz"), (2000, 4000, "2-4 kHz"), (4000, 8000, "4-8 kHz"), (8000, 30000, ">8 kHz")],
                ),
            },
            "hearing": {
                "n": len(ptas),
                "distribution": dist(
                    ptas,
                    [(-10, 20, "Normal"), (20, 35, "Mild"), (35, 50, "Moderate"), (50, 65, "Mod-severe"), (65, 200, "Severe+")],
                ),
            },
            "research_note": "Distributions are drawn only from patients who gave research consent "
            f"({len(consented)}/{len(patients)}). Operational counts cover the full caseload.",
        }
    )


# --------------------------------------------------------------------------- #
# Reports
# --------------------------------------------------------------------------- #
def _resolve_report_assessment(request, patient: Patient) -> Assessment | None:
    raw = request.query_params.get("assessment_id")
    if raw:
        return _load_assessment(patient, int(raw))
    return latest_complete(patient)


@api_view(["GET"])
def report_clinical(request):
    patient = resolve_patient(request)
    assessment = _resolve_report_assessment(request, patient)
    if assessment is None:
        return Response({"detail": "No completed assessment to report on."}, status=status.HTTP_404_NOT_FOUND)

    result = run_analysis(patient, assessment)
    prescription = active_prescription(patient)
    prediction = result.get("prediction") or {}
    ctx = patient_context(patient)

    audit(request, "report.generate", "assessment", assessment.id, kind="clinical")
    return Response(
        {
            "meta": {
                "title": "Tinnitus Assessment and Rehabilitation Report",
                "generated_at": timezone.now().isoformat(timespec="seconds"),
                "generated_by": request.user.full_name,
                "platform": "EchoSense AI",
                "model_version": prediction.get("model_version"),
                "assessment_id": assessment.id,
                "assessment_date": assessment.created_at.isoformat(),
                "status": "AI-generated draft — requires clinician verification and signature.",
            },
            "patient": {
                "mrn": patient.mrn,
                "name": patient.user.full_name,
                "age": patient.age,
                "sex": patient.sex,
                "date_of_birth": patient.date_of_birth,
                "onset": patient.onset_date,
                "duration_months": patient.duration_months,
            },
            "presenting_complaint": {
                "character": patient.tinnitus_character,
                "laterality": patient.laterality or None,
                "pulsatile": patient.pulsatile,
                "somatic_modulation": patient.somatic_modulation,
                "hyperacusis": patient.hyperacusis,
                "noise_exposure_years": patient.noise_exposure_years,
                "comorbidities": patient.comorbidities or [],
                "medications": patient.medications or [],
                "history_notes": patient.etiology_notes,
            },
            "summary": result["summary"],
            "audiometry": {
                **result["audiogram"],
                "raw": assessment.audiogram,
                "device_profile": assessment.device_profile,
                "plan": result.get("audiometry_plan"),
            },
            "psychoacoustics": {
                "pitch_match_hz": assessment.pitch_match_hz,
                "pitch_match_ear": assessment.pitch_match_ear or None,
                "pitch_match_confidence": assessment.pitch_match_confidence,
                "octave_confusion": assessment.octave_confusion,
                "loudness_match_db_sl": assessment.loudness_match_db_sl,
                "mml_db_sl": assessment.mml_db_sl,
                "maskability": result["derived"].get("maskability"),
                "residual_inhibition": result["derived"].get("residual_inhibition"),
                "bandwidth": assessment.tinnitus_bandwidth or None,
                "ldl_left": assessment.ldl_left,
                "ldl_right": assessment.ldl_right,
                "performed": bool(assessment.pitch_match_hz),
                "note": "Psychoacoustic testing is optional per AAO-HNSF guidance and is offered "
                "because it is what makes a therapy notch possible.",
            },
            "questionnaires": result["scores"],
            "stepped_screening": {
                "escalations": result.get("escalations", []),
                "protocol": STEPPED_PROTOCOL,
                # What the patient actually did with the indicated long forms.
                # A deferral is an outstanding recommendation, so it belongs in
                # the report rather than only in the raw row.
                "administration": (assessment.derived or {}).get("stepped_protocol", {}),
            },
            "composite_indices": {"tri": result["derived"].get("tri")},
            "predictions": {
                "outputs": prediction.get("outputs", {}),
                "intervals": prediction.get("intervals", {}),
                "narratives": prediction.get("narratives", {}),
                "explanations": prediction.get("explanations", {}),
                "consistency_checks": prediction.get("consistency_checks", []),
                "features_measured": prediction.get("features_measured"),
                "features_total": prediction.get("features_total"),
                "unavailable_reason": result.get("prediction_error"),
            },
            "safety": result["red_flags"],
            "coding": {"icd11": result["icd11"], "disclaimer": result["coding_disclaimer"]},
            "management_plan": {
                "strategy": (result.get("therapy") or {}).get("strategy"),
                "daily_minutes_target": prescription.daily_minutes_target if prescription else None,
                "review_after_days": prescription.review_after_days if prescription else None,
                "program": prescription.program if prescription else (result.get("therapy") or {}).get("program"),
                "rationale": prescription.rationale if prescription else (result.get("therapy") or {}).get("rationale"),
                "guardrails": prescription.guardrails if prescription else (result.get("therapy") or {}).get("guardrails"),
                "revision": prescription.revision if prescription else None,
                "approved": bool(prescription and prescription.approved_by_id),
            },
            "monitoring": {
                "diary_entries": len(ctx["diary"]),
                "therapy_sessions": len(ctx["sessions"]),
                "adherence_pct": svc.adherence_from_sessions(ctx["sessions"]),
            },
            "disclaimer": (
                "This report was produced by an AI-assisted clinical decision support system. All findings, "
                "codes and recommendations require verification by a qualified audiologist before they are "
                "acted upon or entered into the permanent record. The predictive outputs are estimates from "
                "models trained on simulated data and have not been prospectively validated."
            ),
        }
    )


@api_view(["GET"])
def report_fhir(request):
    patient = resolve_patient(request)
    assessment = _resolve_report_assessment(request, patient)
    if assessment is None:
        return Response({"detail": "No completed assessment to export."}, status=status.HTTP_404_NOT_FOUND)

    result = run_analysis(patient, assessment, include_therapy=False)
    prescription = active_prescription(patient)
    prediction = result.get("prediction") or {}

    bundle = build_fhir_bundle(
        patient={
            "id": patient.id,
            "mrn": patient.mrn,
            "full_name": patient.user.full_name,
            "sex": patient.sex,
            "date_of_birth": patient.date_of_birth,
        },
        assessment={**svc.assessment_dict(assessment), "derived": {"tri": result["derived"].get("tri")}},
        prediction={
            "model_version": prediction.get("model_version"),
            "worsening_risk": prediction.get("outputs", {}).get("worsening_risk"),
            "explanations": {k: v.get("drivers", []) for k, v in prediction.get("explanations", {}).items()},
        }
        if prediction
        else None,
        prescription={
            "id": prescription.id,
            "active": prescription.active,
            "created_at": prescription.created_at,
            "program": prescription.program,
            "rationale": prescription.rationale,
        }
        if prescription
        else None,
        icd11=result["icd11"],
    )
    audit(request, "report.fhir", "assessment", assessment.id)
    return Response(bundle)


def _csv_response(buffer: io.StringIO, filename: str) -> HttpResponse:
    """Return a CSV body as a download.

    Two details that decide whether the file is actually usable:

    * **A UTF-8 BOM.** Excel assumes the system codepage for a .csv without one,
      which turns the Tamil, Hindi and Telugu free-text notes this app accepts
      into mojibake. Every other reader tolerates the BOM.
    * **An explicit charset**, so browsers and pandas do not have to guess.
    """
    response = HttpResponse(
        "﻿" + buffer.getvalue(), content_type="text/csv; charset=utf-8"
    )
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


def _csv_bool(value: bool | None) -> str:
    """1 / 0 / empty — `True` and `False` are Python spellings, not data."""
    return "" if value is None else ("1" if value else "0")


@api_view(["GET"])
def report_diary_csv(request):
    patient = resolve_patient(request)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["date", "ringing_intensity", "annoyance", "stress_level", "mood", "sleep_hours", "sleep_quality",
         "therapy_minutes", "medication_taken", "caffeine_units", "alcohol_units",
         "noise_exposure_minutes", "pitch_shift", "triggers", "notes"]
    )
    rows = 0
    for r in DiaryEntry.objects.filter(patient=patient).order_by("entry_date"):
        writer.writerow(
            [r.entry_date, r.ringing_intensity, r.annoyance, r.stress_level, r.mood, r.sleep_hours,
             r.sleep_quality, r.therapy_minutes, _csv_bool(r.medication_taken), r.caffeine_units,
             r.alcohol_units, r.noise_exposure_minutes, r.pitch_shift,
             "|".join(map(str, r.triggers or [])),
             (r.notes or "").replace("\r", " ").replace("\n", " ")]
        )
        rows += 1

    audit(request, "report.diary_csv", "patient", patient.id, rows=rows)
    # Date-stamped so a patient who exports monthly does not end up with five
    # files called echosense-diary-ESA-2026-00001.csv in their downloads folder.
    filename = f"echosense-diary-{patient.mrn}-{timezone.now():%Y-%m-%d}.csv"
    response = _csv_response(buffer, filename)
    response["X-Rows"] = str(rows)
    return response


@api_view(["GET"])
@permission_classes([IsClinician])
def report_research_extract(request):
    """De-identified cohort extract.

    Three safeguards, none optional: consent-gated inclusion, a salted one-way
    pseudonym in place of the MRN, and age banded into five-year groups — because
    an exact age plus a rare audiometric profile is re-identifying in a small cohort.
    """
    patients = [p for p in Patient.objects.select_related("user") if p.consent_research]
    salt = "echosense-research-extract-v1"

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["pseudonym", "age_band", "sex", "duration_months", "laterality", "pulsatile", "hyperacusis",
         "somatic_modulation", "noise_exposure_years", "pta_better", "pta_worse", "hf_pta_worse",
         "who_grade", "notch_hz", "pitch_match_hz", "bandwidth", "loudness_db_sl", "mml_db_sl",
         "ri_depth_pct", "ri_category", "thi_score", "thi_grade", "vas_loudness", "vas_annoyance",
         "psqi_score", "pss10_score", "gad7_score", "gad2_score", "pss4_score", "phq2_score",
         "tri_score", "assessment_index", "days_from_first_assessment"]
    )

    rows = 0
    for patient in patients:
        pseudonym = hashlib.sha256(f"{salt}:{patient.mrn}".encode()).hexdigest()[:16]
        age_band = f"{(patient.age // 5) * 5}-{(patient.age // 5) * 5 + 4}" if patient.age else ""
        assessments_qs = list(
            Assessment.objects.filter(patient=patient, status=AssessmentStatus.COMPLETE).order_by("created_at")
        )
        if not assessments_qs:
            continue
        first = assessments_qs[0].created_at
        for index, a in enumerate(assessments_qs):
            ptas = [v for v in (a.pta_left, a.pta_right) if v is not None]
            hf = [v for v in (a.hf_pta_left, a.hf_pta_right) if v is not None]
            writer.writerow(
                [pseudonym, age_band, patient.sex, patient.duration_months, patient.laterality,
                 int(patient.pulsatile), int(patient.hyperacusis), int(patient.somatic_modulation),
                 patient.noise_exposure_years, min(ptas) if ptas else "", max(ptas) if ptas else "",
                 max(hf) if hf else "", a.hearing_grade, a.audiometric_notch_hz or "",
                 a.pitch_match_hz or "", a.tinnitus_bandwidth, a.loudness_match_db_sl or "",
                 a.mml_db_sl or "", a.ri_depth_pct or "", a.ri_category, a.thi_score or "", a.thi_grade,
                 a.vas_loudness or "", a.vas_annoyance or "", a.psqi_score or "", a.pss10_score or "",
                 a.gad7_score or "", a.gad2_score or "", a.pss4_score or "", a.phq2_score or "",
                 ((a.derived or {}).get("tri") or {}).get("score", ""), index, (a.created_at - first).days]
            )
            rows += 1

    audit(request, "report.research_extract", patients=len(patients), rows=rows)
    response = _csv_response(
        buffer, f"echosense-research-extract-{timezone.now():%Y-%m-%d}.csv"
    )
    response["X-Consented-Patients"] = str(len(patients))
    response["X-Rows"] = str(rows)
    return response


@api_view(["GET"])
@permission_classes([IsClinician])
def report_note_draft(request):
    """Draft a SOAP note for the clinician to edit and sign."""
    patient = resolve_patient(request)
    assessment = _resolve_report_assessment(request, patient)
    if assessment is None:
        return Response({"detail": "No completed assessment."}, status=status.HTTP_404_NOT_FOUND)

    result = run_analysis(patient, assessment)
    summary = result["summary"]
    prescription = active_prescription(patient)
    diary = patient_context(patient)["diary"]

    subjective = [
        summary["headline"],
        f"Reported character: {patient.tinnitus_character or 'not specified'}, "
        f"{patient.laterality or 'bilateral'}.",
    ]
    if assessment.vas_loudness is not None:
        subjective.append(
            f"VAS loudness {assessment.vas_loudness}/10, annoyance {assessment.vas_annoyance}/10, "
            f"awareness {assessment.vas_awareness}/10, sleep interference "
            f"{assessment.vas_sleep_interference}/10."
        )
    intensities = [d["ringing_intensity"] for d in diary if d.get("ringing_intensity") is not None]
    if intensities:
        subjective.append(
            f"Diary: {len(intensities)} entries, mean intensity {sum(intensities) / len(intensities):.1f}/10."
        )

    plan_lines = list(summary["actions"])
    if prescription:
        plan_lines.append(
            f"Acoustic programme revision {prescription.revision}: "
            + "; ".join(
                f"{b.get('title')} {b.get('minutes')} min ({str(b.get('schedule', '')).replace('_', ' ')})"
                for b in (prescription.program or [])[:6]
            )
        )
    for escalation in result.get("escalations", []):
        plan_lines.append(f"Administer {escalation['instrument'].upper()} — {escalation['because']}.")
    plan_lines.append(
        f"Review in {prescription.review_after_days if prescription else 28} days with repeat THI and diary review."
    )

    return Response(
        {
            "format": "SOAP",
            "subjective": "\n".join(subjective),
            "objective": "\n".join(summary["findings"]),
            "assessment": "\n".join(
                f"{c['title']} ({c['code']})" + (" [verify code]" if c.get("verify") else "")
                for c in result["icd11"]
            ),
            "plan": "\n".join(f"- {line}" for line in plan_lines),
            "icd11_codes": result["icd11"],
            "ai_draft": True,
            "note": "Draft only. Edit and sign before filing; verify all codes marked [verify].",
        }
    )


# --------------------------------------------------------------------------- #
# ML
# --------------------------------------------------------------------------- #
_RETRAIN_STATE: dict[str, Any] = {"running": False, "last_result": None, "last_error": None}


@api_view(["GET"])
@permission_classes([AllowAny])
def model_card(request):
    path = dj_settings.ARTIFACTS_DIR / "model_card.json"
    if not path.exists():
        return Response(
            {"detail": "Models have not been trained. Run `python manage.py train_models`."},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    card = json.loads(path.read_text(encoding="utf-8"))
    card["features"] = FEATURES
    card["targets_spec"] = TARGETS
    return Response(card)


@api_view(["GET"])
@permission_classes([AllowAny])
def ml_status(request):
    try:
        bundle = load_bundle()
    except ModelsUnavailable as exc:
        return Response({"available": False, "detail": str(exc), "retrain": _RETRAIN_STATE})
    return Response(
        {
            "available": True,
            "model_version": bundle.get("model_version"),
            "trained_at": bundle.get("trained_at"),
            "targets": list(bundle.get("models", {}).keys()),
            "n_features": len(bundle.get("all_feature_keys", [])),
            "background_rows": int(bundle["background_full"].shape[0]),
            "retrain": _RETRAIN_STATE,
        }
    )


def _run_training(n: int, seed: int) -> None:
    from ml.train import train_all

    _RETRAIN_STATE.update({"running": True, "last_error": None})
    try:
        card = train_all(n=n, seed=seed, verbose=False)
        clear_cache()
        _RETRAIN_STATE["last_result"] = {
            "model_version": card["model_version"],
            "trained_at": card["trained_at"],
            "training_seconds": card["training_seconds"],
        }
    except Exception as exc:
        _RETRAIN_STATE["last_error"] = f"{type(exc).__name__}: {exc}"
    finally:
        _RETRAIN_STATE["running"] = False


@api_view(["POST"])
@permission_classes([IsClinician])
def ml_retrain(request):
    """Re-fit the ensemble and hot-swap it without restarting the server."""
    if _RETRAIN_STATE["running"]:
        return Response({"detail": "A retraining job is already running."}, status=status.HTTP_409_CONFLICT)
    n = int(request.query_params.get("n", 6000))
    seed = int(request.query_params.get("seed", 20260730))
    audit(request, "ml.retrain", n=n, seed=seed)
    threading.Thread(target=_run_training, args=(n, seed), daemon=True).start()
    return Response(
        {
            "started": True,
            "cohort_size": n,
            "note": "Training runs in the background. Poll GET /api/ml/status for completion.",
        }
    )


@api_view(["GET"])
def ml_predict(request):
    patient = resolve_patient(request)
    assessment = _resolve_report_assessment(request, patient)
    if assessment is None:
        return Response({"detail": "No completed assessment to score."}, status=status.HTTP_404_NOT_FOUND)
    ctx = patient_context(patient)
    try:
        return Response(
            predict_all(
                patient=ctx["patient"],
                assessment=svc.assessment_dict(assessment),
                diary=ctx["diary"],
                adherence_pct=svc.adherence_from_sessions(ctx["sessions"]),
            )
        )
    except ModelsUnavailable as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)


@api_view(["POST"])
def ml_what_if(request):
    """Counterfactual: which modifiable factor actually moves the prediction?"""
    patient = resolve_patient(request)
    assessment = _resolve_report_assessment(request, patient)
    if assessment is None:
        return Response({"detail": "No completed assessment to score."}, status=status.HTTP_404_NOT_FOUND)

    overrides = WhatIfSerializer().to_internal_value(
        {k: v for k, v in request.data.items() if k != "patient_id"}
    )
    ctx = patient_context(patient)
    base = svc.assessment_dict(assessment)
    try:
        before = predict_all(patient=ctx["patient"], assessment=base, diary=ctx["diary"], explain=False)
        after = predict_all(
            patient=ctx["patient"], assessment={**base, **overrides}, diary=ctx["diary"], explain=False
        )
    except ModelsUnavailable as exc:
        return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

    deltas = {
        key: round(float(value) - float(before["outputs"][key]), 4)
        for key, value in after["outputs"].items()
        if isinstance(value, (int, float)) and isinstance(before["outputs"].get(key), (int, float))
    }
    return Response(
        {
            "overrides": overrides,
            "before": before["outputs"],
            "after": after["outputs"],
            "deltas": deltas,
            "note": "Counterfactual estimate under the fitted model. It shows the model's sensitivity "
            "to each factor, not a guaranteed treatment effect.",
        }
    )


# --------------------------------------------------------------------------- #
# Meta
# --------------------------------------------------------------------------- #
@api_view(["GET"])
@permission_classes([AllowAny])
def health(request):
    try:
        bundle = load_bundle()
        models = {
            "available": True,
            "version": bundle.get("model_version"),
            "trained_at": bundle.get("trained_at"),
        }
    except ModelsUnavailable:
        models = {"available": False, "detail": "Run python manage.py train_models"}

    return Response(
        {
            "status": "ok",
            "app": dj_settings.APP_NAME,
            "api_version": dj_settings.API_VERSION,
            "framework": "Django + Django REST Framework",
            "database": dj_settings.DATABASES["default"]["ENGINE"].rsplit(".", 1)[-1],
            "models": models,
            "chat_engine": "claude+rules" if dj_settings.ANTHROPIC_API_KEY else "rules",
        }
    )


@api_view(["GET"])
@permission_classes([AllowAny])
def index(request):
    return Response(
        {
            "name": dj_settings.APP_NAME,
            "version": dj_settings.API_VERSION,
            "framework": "Django REST Framework",
            "health": "/api/health",
            "modules": [
                "AI-assisted assessment (adaptive audiometry, optional psychoacoustics, stepped screening)",
                "Predictive engine with per-patient Shapley explanations",
                "Personalised sound therapy generator with spectral verification",
                "Multilingual Everyday Assistant Companion with crisis escalation",
                "Daily symptom monitoring with trigger correlation",
                "Interactive 3D ear model education content",
                "Clinician dashboard with safety-first triage",
                "HL7 FHIR R4 export and ICD-11 coding assistance",
            ],
        }
    )

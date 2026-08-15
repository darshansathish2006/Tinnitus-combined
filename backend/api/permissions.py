"""Access control.

One rule, enforced in one place: a patient can only ever reach their own record.
The `patient_id` query parameter that clinicians use to scope a request is
*ignored* for patients rather than trusted, so a patient cannot read someone else's
data by editing a URL.
"""

from __future__ import annotations

from rest_framework import permissions
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from .models import Patient, Role


class IsClinician(permissions.BasePermission):
    message = "This endpoint requires a clinician account."

    def has_permission(self, request, view) -> bool:
        user = request.user
        return bool(user and user.is_authenticated and user.role in {Role.CLINICIAN, Role.ADMIN})


def resolve_patient(request) -> Patient:
    """Return the patient this request is about, enforcing access rules."""
    user = request.user

    if user.role == Role.PATIENT:
        patient = Patient.objects.select_related("user", "clinician").filter(user=user).first()
        if patient is None:
            raise NotFound("No patient record is linked to this account.")
        return patient

    raw = request.query_params.get("patient_id") or request.data.get("patient_id") if hasattr(request, "data") else None
    if not raw:
        raise ValidationError({"patient_id": "Required when acting as a clinician."})
    try:
        patient_id = int(raw)
    except (TypeError, ValueError):
        raise ValidationError({"patient_id": "Must be an integer."}) from None

    patient = Patient.objects.select_related("user", "clinician").filter(pk=patient_id).first()
    if patient is None:
        raise NotFound("Patient not found.")
    if user.role == Role.CLINICIAN and patient.clinician_id not in (None, user.id):
        raise PermissionDenied("This patient is assigned to a different clinician.")
    return patient


def assert_clinician_access(user, patient: Patient) -> Patient:
    """Check a clinician may act on a patient they named explicitly."""
    if user.role == Role.CLINICIAN and patient.clinician_id not in (None, user.id):
        raise PermissionDenied("This patient is assigned to a different clinician.")
    return patient


def visible_patients(user):
    """Patients a clinician is *permitted* to act on: assigned, plus unassigned.

    Unassigned patients are included because somebody has to be able to pick up a
    new registration; `assert_clinician_access` applies the same rule, so the two
    stay consistent.

    This is an authorisation boundary, not a worklist — see `caseload_patients`
    for what the console shows.
    """
    queryset = Patient.objects.select_related("user", "clinician").all()
    if user.role == Role.CLINICIAN:
        from django.db.models import Q

        queryset = queryset.filter(Q(clinician=user) | Q(clinician__isnull=True))
    return queryset.order_by("id")


def caseload_patients(user):
    """The clinician's actual worklist: their patients, and nobody else's.

    Distinct from `visible_patients` on purpose. *May* see and *should be shown*
    are different questions, and answering them with one query is what put every
    unassigned registration on every clinician's console — a list that includes
    people you are not treating is a list you stop reading.

    Included: patients assigned to this clinician, plus anyone they have an
    appointment with (a patient seen once but assigned elsewhere is still part of
    this clinician's history and their notes have to stay reachable).
    """
    queryset = Patient.objects.select_related("user", "clinician").all()
    if user.role == Role.CLINICIAN:
        from django.db.models import Q

        queryset = queryset.filter(Q(clinician=user) | Q(appointments__clinician=user)).distinct()
    return queryset.order_by("id")

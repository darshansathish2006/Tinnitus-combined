"""URL routing.

Paths are identical to the previous implementation so the SPA required no rewrite
when the backend moved to Django. Function views are used rather than viewsets
because most of these endpoints are procedures ("finalise this assessment",
"adapt this plan") rather than CRUD on a resource, and forcing them into a
router's shape would obscure that.
"""

from django.urls import path

from . import views

urlpatterns = [
    # -- meta --------------------------------------------------------------- #
    path("api", views.index),
    path("api/health", views.health),

    # -- auth --------------------------------------------------------------- #
    path("api/auth/login", views.login),
    path("api/auth/register", views.register),
    path("api/auth/me", views.me),
    path("api/auth/locale", views.set_locale),
    path("api/auth/demo-accounts", views.demo_accounts),

    # -- community ---------------------------------------------------------- #
    path("api/communities/my-community", views.my_community),
    path("api/communities/location", views.update_community_location),
    path("api/communities/posts", views.create_community_post),
    path("api/communities/posts/<int:post_id>", views.delete_community_post),

    # -- patients ----------------------------------------------------------- #
    path("api/patients/me", views.patient_me),
    path("api/patients", views.patient_list),
    path("api/patients/education/ear-model", views.ear_model),
    path("api/patients/<int:patient_id>", views.patient_detail),

    # -- assessments -------------------------------------------------------- #
    path("api/assessments/instruments", views.instruments),
    path("api/assessments/latest", views.assessment_latest),
    path("api/assessments", views.assessments),
    path("api/assessments/<int:assessment_id>", views.assessment_detail),
    path("api/assessments/<int:assessment_id>/finalise", views.assessment_finalise),
    path("api/assessments/<int:assessment_id>/analysis", views.assessment_analysis),
    path("api/assessments/<int:assessment_id>/reference-level", views.assessment_reference_level),

    # -- therapy ------------------------------------------------------------ #
    path("api/therapy/catalogue", views.therapy_catalogue_view),
    path("api/therapy/current", views.therapy_current),
    path("api/therapy/history", views.therapy_history),
    path("api/therapy/generate", views.therapy_generate),
    path("api/therapy/adapt", views.therapy_adapt),
    path("api/therapy/approve", views.therapy_approve),
    path("api/therapy/sessions", views.therapy_sessions),
    path("api/therapy/adherence", views.therapy_adherence),
    path("api/therapy/spectrum", views.therapy_spectrum),

    # -- rehabilitation (the structured programme built on the prescription) - #
    path("api/rehab/programme", views.rehab_programme),
    path("api/rehab/activity", views.rehab_activity),

    # -- daily monitoring (patient self-report + clinician oversight) -------- #
    path("api/monitoring", views.monitoring),
    path("api/monitoring/check-in", views.monitoring_check_in),
    path("api/clinician/patients/<int:patient_id>/monitoring", views.clinician_monitoring),
    path("api/therapy/preview", views.therapy_preview),

    # -- diary -------------------------------------------------------------- #
    path("api/diary/options", views.diary_options),
    path("api/diary/analytics", views.diary_analytics_view),
    path("api/diary/today", views.diary_today),
    path("api/diary/reminders", views.diary_reminders),
    path("api/diary/reminders/<int:reminder_id>", views.diary_reminder_detail),
    path("api/diary", views.diary),

    # -- consultation (patient-facing view of their own care team) ---------- #
    path("api/consultation", views.consultation),
    path("api/consultation/doctors", views.consultation_doctors),
    path("api/consultation/slots", views.consultation_slots),
    path("api/consultation/select-clinician", views.consultation_select_clinician),
    path("api/consultation/request", views.consultation_request),
    path("api/consultation/<int:appointment_id>/cancel", views.consultation_cancel),

    # -- chat --------------------------------------------------------------- #
    path("api/chat/meta", views.chat_meta),
    path("api/chat/history", views.chat_history),
    path("api/chat", views.chat_send),

    # -- clinician ---------------------------------------------------------- #
    path("api/clinician/caseload", views.caseload),
    path("api/clinician/cohort", views.cohort),
    path("api/clinician/alerts", views.alerts),
    path("api/clinician/alerts/<int:alert_id>/acknowledge", views.alert_acknowledge),
    path("api/clinician/appointments", views.appointments),
    path("api/clinician/appointments/<int:appointment_id>", views.clinician_appointment_detail),
    path("api/clinician/schedule", views.clinician_schedule),
    path("api/clinician/notes", views.clinical_notes),
    path("api/clinician/patients/<int:patient_id>/overview", views.patient_overview),
    path("api/clinician/patients/<int:patient_id>/assign", views.patient_assign),

    # -- reports ------------------------------------------------------------ #
    path("api/reports/clinical", views.report_clinical),
    path("api/reports/fhir", views.report_fhir),
    path("api/reports/diary.csv", views.report_diary_csv),
    path("api/reports/research-extract.csv", views.report_research_extract),
    path("api/reports/note-draft", views.report_note_draft),

    # -- ml ----------------------------------------------------------------- #
    path("api/ml/model-card", views.model_card),
    path("api/ml/status", views.ml_status),
    path("api/ml/retrain", views.ml_retrain),
    path("api/ml/predict", views.ml_predict),
    path("api/ml/what-if", views.ml_what_if),
]

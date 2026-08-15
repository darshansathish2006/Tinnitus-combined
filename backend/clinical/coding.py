"""Terminology binding and HL7 FHIR R4 export.

Two rules govern this module:

1. **Standard codes are only claimed where they are known.** Entries carry a
   ``verify`` flag; anything not independently confirmed against the current
   ICD-11 MMS / LOINC release is marked ``"verify": True`` and surfaced to the
   clinician for confirmation rather than being asserted silently. A coding
   assistant that quietly invents plausible codes is worse than no assistant.
2. **Non-standard measures get a local CodeSystem.** Tinnitus psychoacoustics
   (pitch match, MML, residual inhibition) have no universal code, so they are
   published under an EchoSense CodeSystem URI - which is what FHIR expects for
   locally-defined observations, not a reason to guess at a LOINC.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

LOCAL_SYSTEM = "http://echosense.ai/fhir/CodeSystem/tinnitus-metrics"
ICD11_SYSTEM = "http://id.who.int/icd/release/11/mms"
LOINC_SYSTEM = "http://loinc.org"
SNOMED_SYSTEM = "http://snomed.info/sct"

CODING_DISCLAIMER = (
    "Codes are generated as decision support. Entries flagged 'verify' must be "
    "confirmed against the current ICD-11 MMS release by the coding clinician "
    "before submission for billing or statutory reporting."
)


# --------------------------------------------------------------------------- #
# ICD-11 candidate map
# --------------------------------------------------------------------------- #
# `verify: False` marks codes carried in the well-known ICD-11 tinnitus/mental
# health chapters. `verify: True` marks codes whose exact stem must be confirmed
# against the live MMS browser for the deploying jurisdiction.
ICD11_MAP: dict[str, dict[str, Any]] = {
    "tinnitus": {"code": "MC41", "title": "Tinnitus", "verify": False},
    "tinnitus_subjective": {"code": "MC41.0", "title": "Subjective tinnitus", "verify": False},
    "tinnitus_objective": {"code": "MC41.1", "title": "Objective tinnitus", "verify": False},
    "tinnitus_unspecified": {"code": "MC41.Z", "title": "Tinnitus, unspecified", "verify": False},
    "insomnia": {"code": "7A00", "title": "Chronic insomnia", "verify": False},
    "gad": {"code": "6B00", "title": "Generalised anxiety disorder", "verify": False},
    "depressive_episode": {
        "code": "6A70",
        "title": "Single episode depressive disorder",
        "verify": True,
    },
    "hearing_impairment": {
        "code": "AB50-AB53",
        "title": "Hearing impairment (grade-dependent stem)",
        "verify": True,
    },
    "hyperacusis": {"code": "MC41.2", "title": "Hyperacusis", "verify": True},
    "noise_effects": {
        "code": "AB31",
        "title": "Effects of noise on the inner ear",
        "verify": True,
    },
}


def suggest_icd11(
    *,
    thi_score: int | None,
    pulsatile: bool,
    hyperacusis: bool,
    who_grade: str | None,
    noise_notch: bool,
    psqi_score: int | None,
    gad7_score: int | None,
    phq2_score: int | None,
) -> list[dict[str, Any]]:
    """Propose an ICD-11 problem list from the assessment findings."""
    picks: list[dict[str, Any]] = []

    def take(key: str, why: str, primary: bool = False) -> None:
        entry = ICD11_MAP.get(key)
        if not entry:
            return
        picks.append({**entry, "rationale": why, "primary": primary})

    take(
        "tinnitus_objective" if pulsatile else "tinnitus_subjective",
        "Pulsatile character reported - objective tinnitus pathway."
        if pulsatile
        else "Non-pulsatile percept with no external correlate.",
        primary=True,
    )
    if who_grade and who_grade != "No impairment":
        take("hearing_impairment", f"Audiometry indicates {who_grade.lower()} impairment.")
    if noise_notch:
        take("noise_effects", "Audiometric notch consistent with noise exposure.")
    if hyperacusis:
        take("hyperacusis", "Reduced loudness discomfort levels / reported sound intolerance.")
    if psqi_score is not None and psqi_score > 10:
        take("insomnia", f"PSQI {psqi_score}/21 indicates severe sleep disruption.")
    if gad7_score is not None and gad7_score >= 10:
        take("gad", f"GAD-7 {gad7_score}/21 at or above the referral threshold.")
    if phq2_score is not None and phq2_score >= 3:
        take("depressive_episode", f"PHQ-2 {phq2_score}/6 positive - confirm with PHQ-9.")
    if thi_score is not None and thi_score >= 58:
        picks[0]["severity_note"] = f"THI {thi_score}/100 - severe handicap; document functional impact."
    return picks


# --------------------------------------------------------------------------- #
# FHIR R4 bundle
# --------------------------------------------------------------------------- #
def _obs(
    *,
    ref: str,
    code: str,
    display: str,
    system: str,
    value: float | str | None,
    unit: str | None,
    subject: str,
    effective: str,
    category: str = "survey",
    body_site: str | None = None,
) -> dict[str, Any] | None:
    if value is None:
        return None
    resource: dict[str, Any] = {
        "resourceType": "Observation",
        "id": ref,
        "status": "final",
        "category": [
            {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code": category,
                    }
                ]
            }
        ],
        "code": {"coding": [{"system": system, "code": code, "display": display}], "text": display},
        "subject": {"reference": subject},
        "effectiveDateTime": effective,
    }
    if isinstance(value, str):
        resource["valueString"] = value
    elif unit:
        resource["valueQuantity"] = {
            "value": round(float(value), 2),
            "unit": unit,
            "system": "http://unitsofmeasure.org",
            "code": unit,
        }
    else:
        resource["valueQuantity"] = {"value": round(float(value), 2)}
    if body_site:
        resource["bodySite"] = {"text": body_site}
    return resource


def build_fhir_bundle(
    *,
    patient: Mapping[str, Any],
    assessment: Mapping[str, Any],
    prediction: Mapping[str, Any] | None = None,
    prescription: Mapping[str, Any] | None = None,
    icd11: list[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Assemble a FHIR R4 `Bundle` of type `collection` for the encounter."""
    now = datetime.now(timezone.utc).isoformat()
    effective = str(assessment.get("created_at") or now)
    pid = f"patient-{patient.get('id')}"
    subject = f"Patient/{patient['id']}"
    entries: list[dict[str, Any]] = []

    def push(resource: dict[str, Any] | None) -> None:
        if resource:
            entries.append(
                {
                    "fullUrl": f"urn:uuid:echosense-{resource['resourceType'].lower()}-{resource['id']}",
                    "resource": resource,
                }
            )

    push(
        {
            "resourceType": "Patient",
            "id": str(patient["id"]),
            "identifier": [
                {
                    "system": "http://echosense.ai/fhir/sid/mrn",
                    "value": patient.get("mrn"),
                    "type": {"text": "Medical record number"},
                }
            ],
            "name": [{"text": patient.get("full_name")}],
            "gender": (patient.get("sex") or "unknown").lower(),
            "birthDate": str(patient["date_of_birth"]) if patient.get("date_of_birth") else None,
        }
    )

    # --- audiometry: one Observation per ear per frequency, grouped by a panel
    audiogram = assessment.get("audiogram") or {}
    component_by_ear: dict[str, list[dict[str, Any]]] = {}
    for ear in ("left", "right"):
        for freq, level in sorted(
            (audiogram.get(ear) or {}).items(), key=lambda kv: float(kv[0])
        ):
            component_by_ear.setdefault(ear, []).append(
                {
                    "code": {
                        "coding": [
                            {
                                "system": LOCAL_SYSTEM,
                                "code": f"pta-{freq}",
                                "display": f"Air conduction threshold {freq} Hz",
                            }
                        ]
                    },
                    "valueQuantity": {
                        "value": float(level),
                        "unit": "dB[HL]",
                        "system": "http://unitsofmeasure.org",
                    },
                }
            )
    for ear, components in component_by_ear.items():
        push(
            {
                "resourceType": "Observation",
                "id": f"audiogram-{ear}-{assessment.get('id')}",
                "status": "final",
                "category": [
                    {
                        "coding": [
                            {
                                "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                                "code": "procedure",
                            }
                        ]
                    }
                ],
                "code": {
                    "coding": [
                        {
                            "system": LOCAL_SYSTEM,
                            "code": "pure-tone-audiogram",
                            "display": "Pure tone air conduction audiogram",
                        }
                    ],
                    "text": f"Pure tone audiogram - {ear} ear",
                },
                "subject": {"reference": subject},
                "effectiveDateTime": effective,
                "bodySite": {"text": f"{ear.capitalize()} ear"},
                "component": components,
                "method": {"text": "Modified Hughson-Westlake, browser-calibrated transducer"},
            }
        )

    metrics: list[tuple[str, str, str, str, Any, str | None]] = [
        ("pta-left", LOCAL_SYSTEM, "pta-better-ear", "Pure tone average, left", "dB[HL]", assessment.get("pta_left")),
        ("pta-right", LOCAL_SYSTEM, "pta-right", "Pure tone average, right", "dB[HL]", assessment.get("pta_right")),
        ("pitch-match", LOCAL_SYSTEM, "tinnitus-pitch-match", "Tinnitus pitch match frequency", "Hz", assessment.get("pitch_match_hz")),
        ("loudness-match", LOCAL_SYSTEM, "tinnitus-loudness-match", "Tinnitus loudness match, sensation level", "dB", assessment.get("loudness_match_db_sl")),
        ("mml", LOCAL_SYSTEM, "minimum-masking-level", "Minimum masking level", "dB", assessment.get("mml_db_sl")),
        ("ri-depth", LOCAL_SYSTEM, "residual-inhibition-depth", "Residual inhibition depth", "%", assessment.get("ri_depth_pct")),
        ("ri-duration", LOCAL_SYSTEM, "residual-inhibition-duration", "Residual inhibition duration", "s", assessment.get("ri_duration_s")),
        ("thi", LOCAL_SYSTEM, "thi-total", "Tinnitus Handicap Inventory total score", "{score}", assessment.get("thi_score")),
        ("psqi", LOCAL_SYSTEM, "psqi-global", "PSQI global score", "{score}", assessment.get("psqi_score")),
        ("pss10", LOCAL_SYSTEM, "pss10-total", "Perceived Stress Scale total", "{score}", assessment.get("pss10_score")),
        ("gad7", LOCAL_SYSTEM, "gad7-total", "GAD-7 total score", "{score}", assessment.get("gad7_score")),
        ("vas-loudness", LOCAL_SYSTEM, "vas-loudness", "Tinnitus loudness VAS", "{score}", assessment.get("vas_loudness")),
        ("vas-annoyance", LOCAL_SYSTEM, "vas-annoyance", "Tinnitus annoyance VAS", "{score}", assessment.get("vas_annoyance")),
    ]
    for ref, system, code, display, unit, value in metrics:
        push(
            _obs(
                ref=f"{ref}-{assessment.get('id')}",
                code=code,
                display=display,
                system=system,
                value=value,
                unit=unit,
                subject=subject,
                effective=effective,
            )
        )

    derived = assessment.get("derived") or {}
    tri = (derived.get("tri") or {}).get("score")
    push(
        _obs(
            ref=f"tri-{assessment.get('id')}",
            code="tinnitus-reactivity-index",
            display="Tinnitus Reactivity Index (EchoSense composite)",
            system=LOCAL_SYSTEM,
            value=tri,
            unit="{score}",
            subject=subject,
            effective=effective,
        )
    )

    for entry in icd11 or []:
        push(
            {
                "resourceType": "Condition",
                "id": f"cond-{entry['code'].replace('.', '-').replace('/', '-')}-{assessment.get('id')}",
                "clinicalStatus": {
                    "coding": [
                        {
                            "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
                            "code": "active",
                        }
                    ]
                },
                "verificationStatus": {
                    "coding": [
                        {
                            "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
                            "code": "provisional" if entry.get("verify") else "confirmed",
                        }
                    ]
                },
                "code": {
                    "coding": [
                        {
                            "system": ICD11_SYSTEM,
                            "code": entry["code"],
                            "display": entry["title"],
                        }
                    ],
                    "text": entry["title"],
                },
                "subject": {"reference": subject},
                "recordedDate": effective,
                "note": [{"text": entry.get("rationale", "")}],
            }
        )

    if prediction:
        push(
            {
                "resourceType": "RiskAssessment",
                "id": f"risk-{assessment.get('id')}",
                "status": "final",
                "subject": {"reference": subject},
                "occurrenceDateTime": now,
                "method": {"text": f"EchoSense predictive ensemble {prediction.get('model_version')}"},
                "prediction": [
                    {
                        "outcome": {"text": "Clinically significant worsening of tinnitus distress"},
                        "probabilityDecimal": prediction.get("worsening_risk"),
                        "whenRange": {
                            "low": {"value": 0, "unit": "mo"},
                            "high": {"value": 6, "unit": "mo"},
                        },
                        "rationale": "; ".join(
                            f"{e['label']} ({e['direction']})"
                            for e in (prediction.get("explanations") or {}).get("worsening_risk", [])[:4]
                        ),
                    }
                ],
            }
        )

    if prescription:
        push(
            {
                "resourceType": "CarePlan",
                "id": f"careplan-{prescription.get('id')}",
                "status": "active" if prescription.get("active") else "completed",
                "intent": "plan",
                "title": "Personalised tinnitus sound therapy and rehabilitation plan",
                "subject": {"reference": subject},
                "created": str(prescription.get("created_at") or now),
                "author": {"display": "EchoSense AI therapy engine"},
                "activity": [
                    {
                        "detail": {
                            "kind": "ServiceRequest",
                            "status": "scheduled",
                            "code": {
                                "coding": [
                                    {
                                        "system": LOCAL_SYSTEM,
                                        "code": block.get("modality"),
                                        "display": block.get("title", block.get("modality")),
                                    }
                                ]
                            },
                            "description": block.get("instruction", ""),
                            "scheduledString": f"{block.get('minutes')} min - {block.get('schedule')}",
                        }
                    }
                    for block in (prescription.get("program") or [])
                ],
                "note": [{"text": r} for r in (prescription.get("rationale") or [])],
            }
        )

    return {
        "resourceType": "Bundle",
        "id": f"echosense-encounter-{assessment.get('id')}",
        "type": "collection",
        "timestamp": now,
        "meta": {
            "profile": ["http://hl7.org/fhir/StructureDefinition/Bundle"],
            "tag": [{"system": LOCAL_SYSTEM, "code": "echosense-export"}],
        },
        "entry": entries,
        "_disclaimer": CODING_DISCLAIMER,
    }

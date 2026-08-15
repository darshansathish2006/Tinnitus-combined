"""Personalised sound-therapy prescription engine.

Rather than picking a preset from a menu, this module *derives* an acoustic
programme: it selects a masking strategy from the psychoacoustic findings, chooses
modalities that address the specific drivers the predictive models flagged, sets
the delivery level against measured discomfort thresholds, and emits a fully
specified synthesis recipe that the browser renders node-for-node with Web Audio.

Design principles
-----------------
* **Every block cites the finding that produced it.** ``rationale`` is not
  decoration; the clinician dashboard renders it beside the block, and a block
  that cannot justify itself is not emitted.
* **Contraindications beat optimisation.** Rebound to masking and reduced sound
  tolerance override any level the models would otherwise suggest.
* **The plan adapts.** ``adapt`` re-weights the programme from session outcomes
  and diary trend, so revision 4 does not look like revision 1.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from clinical.audiometry import classify_residual_inhibition, maskability
from dsp.synthesis import (
    analyse_prescription_spectrum,
    build_notch_chain,
    masker_level_recommendation,
)

# --------------------------------------------------------------------------- #
# Modality catalogue
# --------------------------------------------------------------------------- #
# `engine` names the generator the Web Audio client must instantiate; `params`
# are its defaults before personalisation.
MODALITIES: dict[str, dict[str, Any]] = {
    "notched_noise": {
        "title": "Notched broadband noise",
        "engine": "notchedNoise",
        "family": "neuromodulation",
        "goal": "Withdraw stimulation from the tinnitus frequency band to reduce reorganised cortical activity.",
        "evidence": "Tailor-made notched sound training - Okamoto et al., PNAS 2010; Pantev et al., 2012.",
        "requires": ["pitch_match_hz"],
        "params": {"noiseColor": "pink", "notchWidthOctaves": 0.5, "notchDepthDb": 40, "stages": 3},
    },
    "notched_music": {
        "title": "Notched generative music",
        "engine": "notchedMusic",
        "family": "neuromodulation",
        "goal": "Long-duration passive listening with the tinnitus band removed; more tolerable than noise for multi-hour use.",
        "evidence": "Notched music training - Okamoto et al., 2010; Stein et al., 2016.",
        "requires": ["pitch_match_hz"],
        "params": {"scale": "pentatonic_minor", "tempo": 52, "notchWidthOctaves": 0.5, "notchDepthDb": 36},
    },
    "broadband_enrichment": {
        "title": "Low-level sound enrichment",
        "engine": "shapedNoise",
        "family": "habituation",
        "goal": "Reduce the contrast between the percept and silence so the auditory system stops flagging it as salient.",
        "evidence": "Tinnitus Retraining Therapy sound enrichment - Jastreboff & Hazell.",
        "params": {"noiseColor": "pink", "strategy": "sub_threshold", "highCutHz": 12000},
    },
    "partial_masker": {
        "title": "Partial masking",
        "engine": "shapedNoise",
        "family": "masking",
        "goal": "Immediate relief: bring the percept down without covering it, preserving habituation.",
        "evidence": "Mixing-point masking; requires positive residual inhibition for best effect.",
        "params": {"noiseColor": "pink", "strategy": "partial_masking"},
    },
    "white_noise": {
        "title": "White noise",
        "engine": "shapedNoise",
        "family": "masking",
        "goal": "Flat-spectrum masking. Bright; best for high-frequency percepts.",
        "params": {"noiseColor": "white"},
    },
    "pink_noise": {
        "title": "Pink noise",
        "engine": "shapedNoise",
        "family": "masking",
        "goal": "Equal energy per octave - the best-tolerated broadband masker for most patients.",
        "params": {"noiseColor": "pink"},
    },
    "brown_noise": {
        "title": "Brown noise",
        "engine": "shapedNoise",
        "family": "masking",
        "goal": "Low-frequency weighted; preferred where high-frequency sound is uncomfortable.",
        "params": {"noiseColor": "brown"},
    },
    "ocean_waves": {
        "title": "Ocean surf",
        "engine": "oceanWaves",
        "family": "relaxation",
        "goal": "Slow amplitude cycling entrains breathing and is rated the most pleasant masker in preference studies.",
        "params": {"swellPeriodS": 11, "brightness": 0.45, "surfDensity": 0.6},
    },
    "rain": {
        "title": "Rainfall",
        "engine": "rain",
        "family": "relaxation",
        "goal": "Dense stochastic masking with high acceptability; effective for sleep onset.",
        "params": {"intensity": 0.55, "dropletRate": 34, "roofResonanceHz": 900},
    },
    "forest_ambience": {
        "title": "Forest ambience",
        "engine": "forest",
        "family": "relaxation",
        "goal": "Sparse natural sound enrichment for daytime use where continuous noise is intrusive.",
        "params": {"windDepth": 0.35, "birdRatePerMin": 7, "canopyHz": 2600},
    },
    "fractal_tones": {
        "title": "Fractal tones",
        "engine": "fractalTones",
        "family": "habituation",
        "goal": "Non-repeating, non-predictive tonal sequences: audible enough to enrich, too unpredictable to attend to.",
        "evidence": "Fractal tone stimuli in hearing instruments - Sweetow & Sabes, 2010.",
        "params": {"scale": "pentatonic_major", "densityPerMin": 14, "reverb": 0.5},
    },
    "am_masker": {
        "title": "Amplitude-modulated flanking noise",
        "engine": "amMasker",
        "family": "neuromodulation",
        "goal": "Modulated energy in the bands flanking the percept, targeting lateral inhibition of the tinnitus generator.",
        "evidence": "Lateral-inhibition and coordinated-reset stimulation literature.",
        "requires": ["pitch_match_hz"],
        "params": {"modRateHz": 10, "modDepth": 0.85, "flankOffsetOctaves": 0.55},
    },
    "coordinated_reset": {
        "title": "Coordinated-reset tone sequence",
        "engine": "coordinatedReset",
        "family": "neuromodulation",
        "goal": "Four tones bracketing the tinnitus frequency, presented in shuffled order to desynchronise pathologically synchronous neural firing.",
        "evidence": "Acoustic coordinated reset neuromodulation - Tass et al., 2012.",
        "requires": ["pitch_match_hz"],
        "params": {"toneSpacingOctaves": 0.29, "cycleHz": 1.5, "onFraction": 0.6, "jitter": 0.25},
    },
    "bimodal_stim": {
        "title": "Bimodal sound + haptic stimulation",
        "engine": "bimodal",
        "family": "neuromodulation",
        "goal": "Time-locked acoustic and somatosensory input to drive stimulus-timing-dependent plasticity.",
        "evidence": "Bimodal auditory-somatosensory stimulation - Conlon et al., Sci Transl Med 2020; Marks et al., 2018.",
        "params": {"hapticLeadMs": 5, "pulseRateHz": 2.2, "toneSweep": True},
        "device_note": "Uses device vibration where available; a clinical implementation pairs this with tongue or cervical stimulation hardware.",
    },
    "binaural_relax": {
        "title": "Binaural beat relaxation",
        "engine": "binaural",
        "family": "relaxation",
        "goal": "Low-frequency interaural beat with a warm carrier, used as a wind-down cue before sleep.",
        "params": {"carrierHz": 220, "beatHz": 4.5, "padDepth": 0.4},
        "caution": "Requires headphones. Evidence for entrainment is mixed; prescribed for subjective relaxation only.",
    },
    "breathing_pacer": {
        "title": "Paced breathing",
        "engine": "breathingPacer",
        "family": "psychological",
        "goal": "4-7-8 paced breathing with an audible envelope, to interrupt the stress-tinnitus amplification loop.",
        "params": {"inhaleS": 4, "holdS": 7, "exhaleS": 8, "cycles": 12, "toneHz": 174},
    },
    "sleep_ramp": {
        "title": "Overnight fade",
        "engine": "sleepRamp",
        "family": "sleep",
        "goal": "Masking at sleep onset that decays to silence, so the night is not spent under continuous sound.",
        "params": {"startColor": "brown", "rampMinutes": 45, "floorGainDb": -60, "highCutHz": 6000},
    },
    "ri_induction": {
        "title": "Residual inhibition induction",
        "engine": "riInduction",
        "family": "masking",
        "goal": "A brief narrowband burst at the tinnitus frequency to trigger a period of true silence.",
        "requires": ["pitch_match_hz", "ri_positive"],
        "params": {"burstSeconds": 45, "bandwidthOctaves": 0.4, "levelAboveMmlDb": 8},
    },
    "desensitisation": {
        "title": "Hyperacusis desensitisation",
        "engine": "shapedNoise",
        "family": "hyperacusis",
        "goal": "Very low level pink noise, escalated in small weekly steps, to widen a collapsed dynamic range.",
        "evidence": "Hyperacusis desensitisation protocols - Formby et al.",
        "params": {"noiseColor": "pink", "strategy": "sub_threshold", "weeklyStepDb": 1.5},
    },
}

SCHEDULE_SLOTS = ["morning", "daytime", "evening", "sleep_onset", "as_needed"]


# --------------------------------------------------------------------------- #
# Prescription
# --------------------------------------------------------------------------- #
def _block(
    modality: str,
    *,
    minutes: int,
    schedule: str,
    params: Mapping[str, Any] | None = None,
    instruction: str = "",
    priority: int = 5,
) -> dict[str, Any]:
    spec = MODALITIES[modality]
    merged = {**spec.get("params", {}), **(params or {})}
    return {
        "id": f"{modality}-{schedule}",
        "modality": modality,
        "engine": spec["engine"],
        "title": spec["title"],
        "family": spec["family"],
        "goal": spec["goal"],
        "evidence": spec.get("evidence"),
        "caution": spec.get("caution"),
        "device_note": spec.get("device_note"),
        "minutes": minutes,
        "schedule": schedule,
        "priority": priority,
        "instruction": instruction,
        "params": merged,
    }


def prescribe(
    *,
    patient: Mapping[str, Any],
    assessment: Mapping[str, Any],
    prediction: Mapping[str, Any] | None = None,
    session_history: Sequence[Mapping[str, Any]] | None = None,
    diary: Sequence[Mapping[str, Any]] | None = None,
    revision: int = 1,
) -> dict[str, Any]:
    pitch = assessment.get("pitch_match_hz")
    loudness_sl = assessment.get("loudness_match_db_sl")
    mml = assessment.get("mml_db_sl")
    ri_depth = assessment.get("ri_depth_pct")
    bandwidth = (assessment.get("tinnitus_bandwidth") or "narrowband").lower()
    hyperacusis = bool(patient.get("hyperacusis"))
    ldls = [v for v in (assessment.get("ldl_left"), assessment.get("ldl_right")) if v is not None]
    ldl_min = min(ldls) if ldls else None

    thi = assessment.get("thi_score")
    psqi = assessment.get("psqi_score")
    gad7 = assessment.get("gad7_score")
    pss10 = assessment.get("pss10_score")
    vas_sleep = assessment.get("vas_sleep_interference")

    mask = maskability(mml, loudness_sl)
    ri = classify_residual_inhibition(ri_depth, assessment.get("ri_duration_s"))
    outputs = (prediction or {}).get("outputs", {}) if prediction else {}
    response_likelihood = outputs.get("therapy_response")
    worsening = outputs.get("worsening_risk")

    rationale: list[str] = []
    contraindications: list[str] = []
    blocks: list[dict[str, Any]] = []

    # ---- 1. strategy selection -------------------------------------------- #
    rebound = ri_depth is not None and ri_depth <= -10
    if rebound:
        strategy = "sub_threshold"
        contraindications.append(
            "Masking contraindicated: residual inhibition testing showed a rebound "
            f"({abs(ri_depth):.0f}% louder after the masker). All blocks are held below the percept."
        )
    elif hyperacusis or (ldl_min is not None and ldl_min < 85):
        strategy = "sub_threshold"
        contraindications.append(
            "Reduced sound tolerance: output capped and escalation is stepwise. "
            + (f"Lowest measured LDL {ldl_min:.0f} dB HL." if ldl_min else "Patient-reported hyperacusis.")
        )
    elif (ri.get("category") in {"Complete", "Partial"}) and (mask.get("index") or 0) >= 0.55:
        strategy = "partial_masking"
        rationale.append(
            f"Residual inhibition is {ri['category'].lower()} and the percept is "
            f"{(mask.get('category') or 'maskable').lower()} (MML {mml:.0f} dB SL) - masking-forward "
            "programme selected because this profile predicts the largest immediate relief."
            if mml is not None
            else f"Residual inhibition is {ri['category'].lower()} - masking-forward programme selected."
        )
    else:
        strategy = "mixing_point"
        rationale.append(
            "No strong residual inhibition, so the programme targets habituation at the mixing "
            "point rather than relief through masking."
        )

    level = masker_level_recommendation(
        loudness_db_sl=loudness_sl,
        mml_db_sl=mml,
        ldl_db_hl=ldl_min,
        hyperacusis=hyperacusis,
        strategy=strategy,
    )

    # ---- 2. notch-based neuromodulation ------------------------------------ #
    pitch_reliable = bool(
        pitch
        and (assessment.get("pitch_match_confidence") or 0) >= 0.5
        and not assessment.get("octave_confusion")
    )
    notch_width = {"tonal": 0.4, "narrowband": 0.5, "broadband": 0.8}.get(bandwidth, 0.5)
    spectrum: dict[str, Any] | None = None

    if pitch and pitch_reliable and bandwidth != "broadband":
        notch_params = {
            "notchHz": round(float(pitch), 1),
            "notchWidthOctaves": notch_width,
            "targetSensationLevelDb": level["target_sensation_level_db"],
            "filterChain": build_notch_chain(
                notch_hz=float(pitch), width_octaves=notch_width, depth_db=40
            ),
        }
        spectrum = analyse_prescription_spectrum(
            notch_hz=float(pitch),
            width_octaves=notch_width,
            depth_db=40,
            noise_color="pink",
            tinnitus_hz=float(pitch),
        )
        blocks.append(
            _block(
                "notched_noise",
                minutes=25,
                schedule="morning",
                priority=1,
                params=notch_params,
                instruction=(
                    f"Listen at a level where your tinnitus is still just audible. The band around "
                    f"{float(pitch):.0f} Hz is removed by design - you are not meant to hear sound there."
                ),
            )
        )
        blocks.append(
            _block(
                "notched_music",
                minutes=60,
                schedule="daytime",
                priority=2,
                params={
                    "notchHz": round(float(pitch), 1),
                    "notchWidthOctaves": notch_width,
                    "targetSensationLevelDb": level["target_sensation_level_db"],
                },
                instruction="Play quietly in the background while you work or read. Passive listening is enough.",
            )
        )
        rationale.append(
            f"Pitch match at {float(pitch):.0f} Hz was reliable "
            f"(confidence {(assessment.get('pitch_match_confidence') or 0):.0%}, no octave confusion), so a "
            f"{notch_width:g}-octave notch is placed there. Verified attenuation "
            f"{spectrum['verification'].get('achieved_attenuation_db', 0):.0f} dB with "
            f"{spectrum['verification'].get('residual_energy_in_notch_pct', 0):.2f}% of delivered energy "
            "remaining inside the notch."
        )
        if not rebound and not hyperacusis:
            blocks.append(
                _block(
                    "coordinated_reset",
                    minutes=20,
                    schedule="evening",
                    priority=4,
                    params={"centreHz": round(float(pitch), 1)},
                    instruction="Four quiet tones around your tinnitus pitch in a shuffling pattern. Sit still and let it play.",
                )
            )
    elif pitch and not pitch_reliable:
        rationale.append(
            "Pitch match was not reliable (low confidence or octave confusion detected), so notched "
            "therapy is withheld until the match is repeated. A notch on the wrong frequency has no "
            "mechanism of benefit."
        )
        blocks.append(
            _block(
                "broadband_enrichment",
                minutes=45,
                schedule="daytime",
                priority=1,
                params={"targetSensationLevelDb": level["target_sensation_level_db"]},
                instruction="Low-level background sound. It should sit underneath your tinnitus, not cover it.",
            )
        )
    else:
        rationale.append(
            "Percept is broadband or unmatched, so spectral notching does not apply; the programme uses "
            "broadband enrichment and habituation instead."
        )
        blocks.append(
            _block(
                "broadband_enrichment",
                minutes=45,
                schedule="daytime",
                priority=1,
                params={"targetSensationLevelDb": level["target_sensation_level_db"]},
                instruction="Low-level background sound throughout the day.",
            )
        )

    # ---- 3. relief block --------------------------------------------------- #
    if strategy == "partial_masking":
        blocks.append(
            _block(
                "partial_masker",
                minutes=20,
                schedule="as_needed",
                priority=3,
                params={
                    "targetSensationLevelDb": level["target_sensation_level_db"],
                    "noiseColor": "brown" if (assessment.get("hf_pta_right") or 0) > 45 else "pink",
                },
                instruction="Use this when the tinnitus spikes. Turn it up only until the ringing softens - never until it disappears.",
            )
        )
        if ri.get("category") in {"Complete", "Partial"} and pitch:
            blocks.append(
                _block(
                    "ri_induction",
                    minutes=2,
                    schedule="as_needed",
                    priority=6,
                    params={
                        "centreHz": round(float(pitch), 1),
                        "levelSensationDb": (mml + 8) if mml is not None else 20,
                    },
                    instruction=(
                        f"A 45-second burst that often produces a period of true quiet afterwards. "
                        f"Your test showed {ri_depth:.0f}% reduction lasting "
                        f"{assessment.get('ri_duration_s') or 0:.0f} s."
                    ),
                )
            )
    elif hyperacusis or rebound:
        blocks.append(
            _block(
                "desensitisation",
                minutes=30,
                schedule="daytime",
                priority=2,
                params={"targetSensationLevelDb": level["target_sensation_level_db"]},
                instruction="Start at the lowest level you can just detect. We increase it by about 1.5 dB each week, never faster.",
            )
        )

    # ---- 4. sleep ---------------------------------------------------------- #
    sleep_problem = (
        (psqi is not None and psqi > 5)
        or (vas_sleep is not None and vas_sleep >= 4)
        or (assessment.get("psqi_items") or {}).get("psqi5i", 0) >= 2
    )
    if sleep_problem:
        blocks.append(
            _block(
                "sleep_ramp",
                minutes=45,
                schedule="sleep_onset",
                priority=2,
                params={
                    "startColor": "brown",
                    "rampMinutes": 45,
                    "targetSensationLevelDb": max(1.0, level["target_sensation_level_db"] - 2),
                },
                instruction="Start this as you get into bed. It fades to silence over 45 minutes, so it will not wake you later.",
            )
        )
        blocks.append(
            _block(
                "rain",
                minutes=30,
                schedule="sleep_onset",
                priority=5,
                instruction="An alternative for sleep onset if you prefer it to the plain fade.",
            )
        )
        rationale.append(
            (f"PSQI {psqi}/21 indicates disrupted sleep" if psqi is not None else "Sleep interference reported")
            + " - an overnight fading masker is prescribed for sleep onset rather than continuous "
            "overnight sound, which perpetuates dependence."
        )

    # ---- 5. psychological ------------------------------------------------- #
    stress_driven = (gad7 is not None and gad7 >= 8) or (pss10 is not None and pss10 >= 20)
    if stress_driven:
        blocks.append(
            _block(
                "breathing_pacer",
                minutes=8,
                schedule="evening",
                priority=3,
                instruction="Follow the tone: in for 4, hold for 7, out for 8. Twelve cycles.",
            )
        )
        blocks.append(
            _block("binaural_relax", minutes=15, schedule="evening", priority=6)
        )
        rationale.append(
            (f"GAD-7 {gad7}/21" if gad7 is not None else f"PSS-10 {pss10}/40")
            + " indicates that affective arousal is a major driver of distress, so paced-breathing and "
            "wind-down blocks are included. Acoustic therapy alone under-treats this profile."
        )

    # ---- 6. bimodal / pleasantness --------------------------------------- #
    if pitch and pitch_reliable and not hyperacusis and (thi or 0) >= 38:
        blocks.append(
            _block(
                "bimodal_stim",
                minutes=15,
                schedule="evening",
                priority=5,
                params={"centreHz": round(float(pitch), 1)},
                instruction="Hold the phone in your hand. Each vibration is paired with a tone - keep them together.",
            )
        )
    if not any(b["family"] == "relaxation" for b in blocks):
        blocks.append(_block("ocean_waves", minutes=20, schedule="evening", priority=7))
    if (thi or 0) < 38 and not rebound:
        blocks.append(
            _block(
                "fractal_tones",
                minutes=30,
                schedule="daytime",
                priority=6,
                instruction="Unpredictable soft tones - pleasant to have on, hard to focus on. That is the point.",
            )
        )

    # ---- 7. dose ----------------------------------------------------------- #
    if thi is None:
        daily = 60
    elif thi >= 78:
        daily = 150
    elif thi >= 58:
        daily = 120
    elif thi >= 38:
        daily = 90
    elif thi >= 18:
        daily = 60
    else:
        daily = 40

    adherence = _adherence(session_history)
    if adherence is not None and adherence < 45 and revision > 1:
        daily = max(30, int(daily * 0.6))
        rationale.append(
            f"Adherence has been {adherence:.0f}% of the previous target, so the daily dose is reduced to "
            f"{daily} minutes. A shorter plan that is actually completed beats a longer one that is not."
        )

    review_days = 7 if (worsening or 0) >= 0.5 else 14 if (thi or 0) >= 58 else 28

    blocks.sort(key=lambda b: (SCHEDULE_SLOTS.index(b["schedule"]), b["priority"]))

    # ---- 8. rationale from the predictive layer ---------------------------- #
    if response_likelihood is not None:
        rationale.append(
            f"Predicted likelihood of a clinically significant response to this acoustic programme is "
            f"{response_likelihood:.0%}"
            + (
                ". This is below the level at which acoustic therapy alone is usually sufficient, so the "
                "psychological components are weighted more heavily."
                if response_likelihood < 0.4
                else ". A predominantly acoustic programme is appropriate."
            )
        )
    if worsening is not None and worsening >= 0.35:
        rationale.append(
            f"Six-month worsening risk is {worsening:.0%}, so review is brought forward to {review_days} days."
        )

    guardrails = {
        "level": level,
        "contraindications": contraindications,
        "max_daily_minutes": min(240, daily + 60),
        "absolute_output_cap_db_spl": 80 if not hyperacusis else 70,
        "stop_rules": [
            "Stop immediately and contact the clinic if the tinnitus becomes louder during or after a session.",
            "Stop if you develop ear pain, fullness, discharge or dizziness.",
            "Never raise the level to the point where the tinnitus disappears completely - that level is too high.",
            "Do not use headphone therapy while driving or operating machinery.",
        ],
        "escalation": "Level increases are limited to 1.5 dB per week and only when the previous week was completed.",
    }

    return {
        "revision": revision,
        "strategy": strategy,
        "daily_minutes_target": daily,
        "review_after_days": review_days,
        "program": blocks,
        "rationale": rationale,
        "guardrails": guardrails,
        "spectrum": spectrum,
        "derived": {
            "maskability": mask,
            "residual_inhibition": ri,
            "pitch_reliable": pitch_reliable,
            "adherence_pct": adherence,
        },
        "generated_by": "ai",
    }


def _adherence(history: Sequence[Mapping[str, Any]] | None) -> float | None:
    """Completed seconds as a percentage of planned seconds."""
    if not history:
        return None
    planned = sum(float(s.get("planned_seconds") or 0) for s in history)
    actual = sum(float(s.get("actual_seconds") or 0) for s in history)
    if planned <= 0:
        return None
    return round(min(100.0, 100 * actual / planned), 1)


# --------------------------------------------------------------------------- #
# Adaptation
# --------------------------------------------------------------------------- #
def adapt(
    *,
    current: Mapping[str, Any],
    session_history: Sequence[Mapping[str, Any]],
    diary: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Re-weight an existing programme from observed response.

    Per-modality relief is measured as the mean pre/post VAS loudness drop across
    completed sessions. Modalities that consistently help get more time;
    modalities that do nothing get dropped and their time reallocated. This is the
    'AI continuously adjusts therapy according to patient progress' loop.
    """
    program = [dict(b) for b in (current.get("program") or [])]
    notes: list[str] = []

    by_modality: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for s in session_history:
        m = s.get("modality")
        if not m:
            continue
        counts[m] = counts.get(m, 0) + 1
        pre, post = s.get("pre_vas_loudness"), s.get("post_vas_loudness")
        if pre is not None and post is not None:
            by_modality.setdefault(m, []).append(float(pre) - float(post))

    effectiveness = {
        m: round(sum(v) / len(v), 2) for m, v in by_modality.items() if len(v) >= 2
    }

    freed_minutes = 0
    kept: list[dict[str, Any]] = []
    for block in program:
        m = block["modality"]
        relief = effectiveness.get(m)
        if relief is None:
            kept.append(block)
            continue
        if relief >= 1.0:
            bonus = min(20, int(block["minutes"] * 0.3))
            block["minutes"] += bonus
            block["priority"] = max(1, block["priority"] - 1)
            notes.append(
                f"{block['title']}: mean relief {relief:+.1f} VAS points over {counts.get(m, 0)} sessions - "
                f"time increased to {block['minutes']} min."
            )
            kept.append(block)
        elif relief <= 0.1 and block["family"] not in {"psychological", "sleep"}:
            freed_minutes += block["minutes"]
            notes.append(
                f"{block['title']}: no measurable relief ({relief:+.1f} VAS over {counts.get(m, 0)} sessions) - "
                "withdrawn and its time reallocated."
            )
        else:
            kept.append(block)

    if freed_minutes and kept:
        best = max(kept, key=lambda b: effectiveness.get(b["modality"], 0.0))
        best["minutes"] += freed_minutes
        notes.append(f"{freed_minutes} reallocated minutes added to {best['title']}.")

    adherence = _adherence(session_history)
    daily = current.get("daily_minutes_target", 60)
    if adherence is not None:
        if adherence < 45:
            daily = max(30, int(daily * 0.65))
            notes.append(f"Adherence {adherence:.0f}% - daily target reduced to {daily} min to make the plan achievable.")
        elif adherence > 90 and daily < 150:
            daily = min(150, daily + 15)
            notes.append(f"Adherence {adherence:.0f}% - daily target raised to {daily} min.")

    trend = None
    if diary and len(diary) >= 8:
        vals = [float(d["ringing_intensity"]) for d in diary if d.get("ringing_intensity") is not None]
        if len(vals) >= 8:
            half = len(vals) // 2
            trend = round(
                sum(vals[half:]) / len(vals[half:]) - sum(vals[:half]) / len(vals[:half]), 2
            )
            if trend >= 1.0:
                notes.append(
                    f"Diary intensity has risen {trend:+.1f} points across the period. Level escalation is "
                    "paused and clinician review is requested before the next revision."
                )
            elif trend <= -1.0:
                notes.append(f"Diary intensity has fallen {trend:+.1f} points - programme is working; continuing unchanged.")

    kept.sort(key=lambda b: (SCHEDULE_SLOTS.index(b["schedule"]), b["priority"]))
    return {
        **dict(current),
        "revision": int(current.get("revision", 1)) + 1,
        "program": kept,
        "daily_minutes_target": daily,
        "adaptation_notes": notes,
        "effectiveness_by_modality": effectiveness,
        "adherence_pct": adherence,
        "diary_trend": trend,
        "generated_by": "ai",
    }


def catalogue() -> list[dict[str, Any]]:
    """The full modality catalogue, for the therapy library screen."""
    return [
        {
            "key": k,
            "title": v["title"],
            "engine": v["engine"],
            "family": v["family"],
            "goal": v["goal"],
            "evidence": v.get("evidence"),
            "caution": v.get("caution"),
            "requires": v.get("requires", []),
            "default_params": v.get("params", {}),
        }
        for k, v in MODALITIES.items()
    ]

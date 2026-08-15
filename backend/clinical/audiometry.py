"""Audiogram interpretation and derived tinnitus metrics.

Implements the arithmetic an audiologist performs by hand after a pure-tone
test: pure-tone averages, WHO grading, configuration classification, noise-notch
detection by the Coles criteria, interaural asymmetry, and the psychoacoustic
derivations (sensation level, maskability) that drive therapy selection.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

# Standard clinical audiometric frequencies (Hz).
AUDIOMETRIC_FREQS: tuple[int, ...] = (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)
# Extended high-frequency set - tinnitus is frequently matched above 8 kHz.
EXTENDED_FREQS: tuple[int, ...] = (9000, 10000, 11200, 12500, 14000, 16000)
PTA_FREQS: tuple[int, ...] = (500, 1000, 2000, 4000)
HF_PTA_FREQS: tuple[int, ...] = (4000, 6000, 8000)

# --------------------------------------------------------------------------- #
# Adaptive frequency selection
# --------------------------------------------------------------------------- #
# The BSA recommended procedure for pure-tone audiometry tests **octave**
# frequencies as standard, and adds the inter-octave frequencies only when a gap
# between adjacent octaves is 20 dB or more — because that is where a notch or a
# steep edge could otherwise be missed entirely.
#
# Testing all eight frequencies in both ears unconditionally is not "more
# thorough": it is 16 threshold searches, roughly doubling the time, for
# information that in most ears the octave set already determines. Following the
# guideline shortens the test *and* matches practice.
#
# Order matters too: 1 kHz first, because it is the most reliably matched frequency
# and gives the patient a clear reference for what they are listening for.
CORE_FREQ_ORDER: tuple[int, ...] = (1000, 2000, 4000, 8000, 500, 250)
INTER_OCTAVE_FREQS: tuple[int, ...] = (3000, 6000)

# Adjacent octave pairs whose gap triggers each inter-octave frequency.
INTER_OCTAVE_TRIGGERS: dict[int, tuple[int, int]] = {3000: (2000, 4000), 6000: (4000, 8000)}
INTER_OCTAVE_GAP_DB = 20


def inter_octave_required(side: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Which inter-octave frequencies this ear needs, and why.

    Returns the reason alongside each frequency so the report can show that the
    extra tests were indicated rather than arbitrary — and, equally, that the ones
    not performed were correctly omitted.
    """
    thresholds = _thresholds(side)
    required: list[dict[str, Any]] = []
    for freq, (low, high) in INTER_OCTAVE_TRIGGERS.items():
        if low not in thresholds or high not in thresholds:
            continue
        gap = abs(thresholds[high] - thresholds[low])
        if gap >= INTER_OCTAVE_GAP_DB:
            required.append(
                {
                    "freq": freq,
                    "gap_db": round(gap, 1),
                    "between": [low, high],
                    "reason": f"{round(gap)} dB gap between {low} and {high} Hz meets the "
                    f"{INTER_OCTAVE_GAP_DB} dB threshold for inter-octave testing.",
                }
            )
    return required


def audiometry_plan(audiogram: Mapping[str, Any] | None) -> dict[str, Any]:
    """Full adaptive test plan for both ears, given whatever is measured so far."""
    audiogram = audiogram or {}
    plan: dict[str, Any] = {"core": list(CORE_FREQ_ORDER), "ears": {}}
    for ear in ("right", "left"):
        side = audiogram.get(ear) or {}
        measured = sorted(_thresholds(side))
        extra = inter_octave_required(side)
        plan["ears"][ear] = {
            "measured": measured,
            "core_remaining": [f for f in CORE_FREQ_ORDER if f not in measured],
            "inter_octave_required": extra,
            "inter_octave_remaining": [e["freq"] for e in extra if e["freq"] not in measured],
            "complete": not [f for f in CORE_FREQ_ORDER if f not in measured]
            and not [e["freq"] for e in extra if e["freq"] not in measured],
        }
    plan["basis"] = (
        "BSA recommended procedure: octave frequencies as standard; inter-octave "
        f"frequencies added when adjacent octaves differ by >= {INTER_OCTAVE_GAP_DB} dB."
    )
    return plan

# WHO 2021 World Report on Hearing grading, applied to the better-ear PTA.
WHO_GRADES: tuple[tuple[float, float, str, str], ...] = (
    (-10, 20, "No impairment", "Hearing thresholds within normal limits (<20 dB HL)."),
    (20, 35, "Mild", "Mild hearing impairment (20-34 dB HL)."),
    (35, 50, "Moderate", "Moderate hearing impairment (35-49 dB HL)."),
    (50, 65, "Moderately severe", "Moderately severe hearing impairment (50-64 dB HL)."),
    (65, 80, "Severe", "Severe hearing impairment (65-79 dB HL)."),
    (80, 95, "Profound", "Profound hearing impairment (80-94 dB HL)."),
    (95, 200, "Complete", "Complete or total hearing loss (>=95 dB HL)."),
)


def _thresholds(side: Mapping[str, Any] | None) -> dict[int, float]:
    """Normalise a {"1000": 25} style map into {1000: 25.0}, dropping junk."""
    out: dict[int, float] = {}
    if not side:
        return out
    for k, v in side.items():
        try:
            f = int(float(k))
            out[f] = float(v)
        except (TypeError, ValueError):
            continue
    return out


def mean_threshold(side: Mapping[str, Any] | None, freqs: Sequence[int]) -> float | None:
    t = _thresholds(side)
    vals = [t[f] for f in freqs if f in t]
    if len(vals) < max(2, len(freqs) - 1):  # tolerate one missing frequency
        return None
    return round(sum(vals) / len(vals), 1)


def who_grade(pta: float | None) -> tuple[str | None, str]:
    if pta is None:
        return None, ""
    for lo, hi, label, detail in WHO_GRADES:
        if lo <= pta < hi:
            return label, detail
    return None, ""


def detect_notch(side: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Noise-notch detection following the Coles/Lutman/Buffin (2000) criteria.

    A notch is present when the threshold at 3, 4 or 6 kHz is at least 10 dB
    worse than the better of 1 and 2 kHz, and recovers by at least 10 dB at a
    higher frequency (6 or 8 kHz). Depth and centre frequency are reported
    because the notch centre is the primary candidate for a therapy notch when
    pitch matching is unreliable.
    """
    t = _thresholds(side)
    low_ref = [t[f] for f in (1000, 2000) if f in t]
    if not low_ref:
        return None
    baseline = min(low_ref)

    best: dict[str, Any] | None = None
    for centre in (3000, 4000, 6000):
        if centre not in t:
            continue
        depth = t[centre] - baseline
        if depth < 10:
            continue
        recovery_candidates = [f for f in (6000, 8000) if f in t and f > centre]
        if not recovery_candidates:
            continue
        recovery = max(t[centre] - t[f] for f in recovery_candidates)
        if recovery < 10:
            continue
        cand = {
            "centre_hz": centre,
            "depth_db": round(depth, 1),
            "recovery_db": round(recovery, 1),
            "baseline_db": round(baseline, 1),
        }
        if best is None or cand["depth_db"] > best["depth_db"]:
            best = cand
    return best


def classify_configuration(side: Mapping[str, Any] | None) -> str | None:
    """Label the audiogram shape - drives counselling and device advice."""
    t = _thresholds(side)
    lows = [t[f] for f in (250, 500) if f in t]
    mids = [t[f] for f in (1000, 2000) if f in t]
    highs = [t[f] for f in (4000, 6000, 8000) if f in t]
    if not (lows and mids and highs):
        return None
    lo, mid, hi = sum(lows) / len(lows), sum(mids) / len(mids), sum(highs) / len(highs)

    if detect_notch(side):
        return "Notched (noise-type)"
    if hi - lo >= 20:
        return "High-frequency sloping"
    if lo - hi >= 20:
        return "Rising (low-frequency)"
    if mid - lo >= 15 and mid - hi >= 15:
        return "Mid-frequency (cookie-bite)"
    if max(lo, mid, hi) - min(lo, mid, hi) <= 15:
        return "Flat"
    return "Irregular"


def slope_db_per_octave(side: Mapping[str, Any] | None) -> float | None:
    """Least-squares slope of threshold against log2(frequency)."""
    t = _thresholds(side)
    pts = [(math.log2(f), v) for f, v in sorted(t.items()) if f >= 500]
    if len(pts) < 3:
        return None
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    denom = sum((p[0] - mx) ** 2 for p in pts)
    if denom == 0:
        return None
    return round(sum((p[0] - mx) * (p[1] - my) for p in pts) / denom, 1)


def threshold_at(side: Mapping[str, Any] | None, freq: float) -> float | None:
    """Log-frequency interpolated threshold - tinnitus pitch rarely lands on an
    audiometric frequency, so sensation level needs interpolation."""
    t = _thresholds(side)
    if not t:
        return None
    if freq in t:
        return t[int(freq)]
    below = [f for f in t if f <= freq]
    above = [f for f in t if f >= freq]
    if not below:
        return t[min(above)]
    if not above:
        return t[max(below)]
    f0, f1 = max(below), min(above)
    if f0 == f1:
        return t[f0]
    w = (math.log2(freq) - math.log2(f0)) / (math.log2(f1) - math.log2(f0))
    return round(t[f0] + w * (t[f1] - t[f0]), 1)


def analyse_audiogram(audiogram: Mapping[str, Any] | None) -> dict[str, Any]:
    audiogram = audiogram or {}
    left, right = audiogram.get("left"), audiogram.get("right")

    pta_l, pta_r = mean_threshold(left, PTA_FREQS), mean_threshold(right, PTA_FREQS)
    hf_l, hf_r = mean_threshold(left, HF_PTA_FREQS), mean_threshold(right, HF_PTA_FREQS)

    ptas = [p for p in (pta_l, pta_r) if p is not None]
    better = min(ptas) if ptas else None
    worse = max(ptas) if ptas else None
    grade, grade_detail = who_grade(better)

    asymmetry = None
    if pta_l is not None and pta_r is not None:
        asymmetry = round(abs(pta_l - pta_r), 1)

    notch_l, notch_r = detect_notch(left), detect_notch(right)
    notch = max(
        (n for n in (notch_l, notch_r) if n), key=lambda n: n["depth_db"], default=None
    )

    flags: list[str] = []
    if asymmetry is not None and asymmetry >= 15:
        # Red flag: asymmetric SNHL with unilateral tinnitus warrants imaging to
        # exclude retrocochlear pathology (e.g. vestibular schwannoma).
        flags.append("asymmetric_hearing_loss_refer_imaging")
    if notch:
        flags.append("noise_notch_present")
    if (hf_l is not None and hf_l >= 40) or (hf_r is not None and hf_r >= 40):
        flags.append("significant_high_frequency_loss")

    return {
        "pta_left": pta_l,
        "pta_right": pta_r,
        "hf_pta_left": hf_l,
        "hf_pta_right": hf_r,
        "better_ear_pta": better,
        "worse_ear_pta": worse,
        "who_grade": grade,
        "who_grade_detail": grade_detail,
        "asymmetry_db": asymmetry,
        "configuration_left": classify_configuration(left),
        "configuration_right": classify_configuration(right),
        "slope_left": slope_db_per_octave(left),
        "slope_right": slope_db_per_octave(right),
        "notch": notch,
        "notch_left": notch_l,
        "notch_right": notch_r,
        "audiometric_notch_hz": notch["centre_hz"] if notch else None,
        "flags": flags,
        "frequencies_tested": sorted(
            {*_thresholds(left).keys(), *_thresholds(right).keys()}
        ),
        # Recorded so the report can show that omitted inter-octave frequencies
        # were correctly omitted, not skipped.
        "inter_octave": {
            "left": inter_octave_required(left),
            "right": inter_octave_required(right),
            "rule": f"Tested when adjacent octaves differ by >= {INTER_OCTAVE_GAP_DB} dB (BSA).",
        },
    }


# --------------------------------------------------------------------------- #
# Psychoacoustic derivations
# --------------------------------------------------------------------------- #
def maskability(mml_db_sl: float | None, loudness_db_sl: float | None) -> dict[str, Any]:
    """Feldmann-style maskability: how much level above the tinnitus percept is
    needed before a masker covers it. Small differences mean the tinnitus is
    easy to mask and predicts a good response to sound therapy.
    """
    if mml_db_sl is None:
        return {"index": None, "category": None, "delta_db": None}
    delta = None if loudness_db_sl is None else round(mml_db_sl - loudness_db_sl, 1)

    if mml_db_sl <= 6:
        cat, idx = "Very easily masked", 0.95
    elif mml_db_sl <= 12:
        cat, idx = "Easily masked", 0.8
    elif mml_db_sl <= 20:
        cat, idx = "Moderately maskable", 0.6
    elif mml_db_sl <= 32:
        cat, idx = "Difficult to mask", 0.35
    else:
        cat, idx = "Refractory to masking", 0.15

    if delta is not None and delta <= 0:
        # Masker below the percept level still masks it: unusually favourable.
        idx = min(1.0, idx + 0.1)
    return {"index": round(idx, 2), "category": cat, "delta_db": delta}


def classify_residual_inhibition(
    depth_pct: float | None, duration_s: float | None
) -> dict[str, Any]:
    """Grade residual inhibition. Positive RI is the single strongest bedside
    predictor that masking-based therapy will help this patient."""
    if depth_pct is None:
        return {"category": None, "score": None, "note": ""}
    if depth_pct >= 95:
        cat, note = "Complete", "Tinnitus fully abolished after masking - excellent prognosis for sound therapy."
    elif depth_pct >= 40:
        cat, note = "Partial", "Substantial reduction after masking - masking-based therapy indicated."
    elif depth_pct >= 10:
        cat, note = "Minimal", "Slight reduction after masking - expect modest benefit; combine with habituation therapy."
    elif depth_pct <= -10:
        cat, note = "Rebound", "Tinnitus louder after masking - avoid high-level maskers; use low-level enrichment and habituation instead."
    else:
        cat, note = "Absent", "No residual inhibition - prioritise habituation, CBT and notched therapy over masking."

    score = None
    if duration_s is not None:
        # Blend depth with persistence; 60 s of RI is a strong response.
        score = round(min(1.0, (depth_pct / 100) * 0.7 + min(duration_s, 60) / 60 * 0.3), 2)
    return {"category": cat, "score": score, "note": note, "duration_s": duration_s}


def spectral_signature(
    pitch_hz: float | None,
    bandwidth: str | None,
    audiogram: Mapping[str, Any] | None,
    bins: int = 48,
) -> list[float]:
    """Build the normalised 48-bin log-frequency vector that renders as the
    patient's 'tinnitus fingerprint' and feeds the similarity search.

    The vector superimposes a Gaussian centred on the matched pitch (width set
    by the reported bandwidth) on the audiometric loss profile, so two patients
    with the same pitch but different hearing are distinguishable.
    """
    lo, hi = math.log2(125), math.log2(16000)
    sigma = {"tonal": 0.12, "narrowband": 0.3, "broadband": 0.75}.get(
        (bandwidth or "narrowband").lower(), 0.3
    )

    left = _thresholds((audiogram or {}).get("left"))
    right = _thresholds((audiogram or {}).get("right"))
    merged: dict[int, float] = {}
    for f in set(left) | set(right):
        vals = [d[f] for d in (left, right) if f in d]
        merged[f] = sum(vals) / len(vals)

    out: list[float] = []
    for i in range(bins):
        oct_pos = lo + (hi - lo) * i / (bins - 1)
        f = 2**oct_pos
        percept = 0.0
        if pitch_hz:
            percept = math.exp(-((oct_pos - math.log2(pitch_hz)) ** 2) / (2 * sigma**2))
        loss = 0.0
        if merged:
            near = min(merged, key=lambda k: abs(math.log2(k) - oct_pos))
            if abs(math.log2(near) - oct_pos) < 1.0:
                loss = max(0.0, min(1.0, merged[near] / 90))
        out.append(round(min(1.0, 0.72 * percept + 0.28 * loss), 4)
                   )
    return out


def tinnitus_reactivity_index(
    *,
    thi: int | None,
    vas_annoyance: float | None,
    psqi: int | None,
    gad7: int | None,
    pss10: int | None,
    maskability_index: float | None,
    somatic_modulation: bool = False,
    hyperacusis: bool = False,
    ldl_min: float | None = None,
) -> dict[str, Any]:
    """**TRI - Tinnitus Reactivity Index** (0-100), an EchoSense composite.

    Not a validated instrument. It is a transparent, fixed-weight decision-support
    index that fuses handicap, annoyance, sleep, anxiety, stress, maskability and
    auditory hypersensitivity into one triage number, so a clinician scanning a
    caseload sees a single comparable figure. Every component and weight is
    returned so the number can always be taken apart.
    """
    parts: list[dict[str, Any]] = []

    def add(name: str, label: str, value: float | None, norm: float | None, weight: float):
        contribution = None if norm is None else round(norm * weight, 2)
        parts.append(
            {
                "key": name,
                "label": label,
                "raw": value,
                "normalised": None if norm is None else round(norm, 3),
                "weight": weight,
                "contribution": contribution,
            }
        )

    add("thi", "Tinnitus handicap (THI)", thi, None if thi is None else thi / 100, 30)
    add("annoyance", "Annoyance (VAS)", vas_annoyance,
        None if vas_annoyance is None else vas_annoyance / 10, 15)
    add("sleep", "Sleep disruption (PSQI)", psqi, None if psqi is None else psqi / 21, 15)
    add("anxiety", "Anxiety (GAD-7)", gad7, None if gad7 is None else gad7 / 21, 12)
    add("stress", "Perceived stress (PSS-10)", pss10, None if pss10 is None else pss10 / 40, 10)
    add("maskability", "Resistance to masking", maskability_index,
        None if maskability_index is None else 1 - maskability_index, 8)

    hyper = 0.0
    hyper_raw: list[str] = []
    if hyperacusis:
        hyper += 0.5
        hyper_raw.append("hyperacusis")
    if ldl_min is not None and ldl_min < 85:
        hyper += 0.3
        hyper_raw.append(f"LDL {ldl_min:.0f} dB")
    if somatic_modulation:
        hyper += 0.2
        hyper_raw.append("somatic modulation")
    add("reactivity", "Auditory hypersensitivity", ", ".join(hyper_raw) or None,
        min(1.0, hyper) if hyper_raw else None, 10)

    present = [p for p in parts if p["contribution"] is not None]
    if not present:
        return {"score": None, "band": None, "components": parts, "coverage": 0.0}

    weight_present = sum(p["weight"] for p in present)
    score = round(100 * sum(p["contribution"] for p in present) / weight_present, 1)

    if score < 20:
        band, action = "Low", "Reassurance, education and self-managed sound enrichment."
    elif score < 40:
        band, action = "Moderate", "Structured sound therapy with monthly review."
    elif score < 60:
        band, action = "Elevated", "Combined sound therapy plus CBT-informed counselling; review fortnightly."
    elif score < 80:
        band, action = "High", "Intensive multidisciplinary programme; clinician contact weekly."
    else:
        band, action = "Very high", "Urgent multidisciplinary review including mental-health input."

    return {
        "score": score,
        "band": band,
        "recommended_intensity": action,
        "components": parts,
        "coverage": round(weight_present / sum(p["weight"] for p in parts), 2),
    }

"""Filter design and spectral verification for the therapy engine.

The browser renders therapy audio with Web Audio `BiquadFilterNode`s. This module
implements the *same* RBJ Audio-EQ-Cookbook biquads in NumPy, so the spectrum the
clinician sees plotted is the spectrum that will actually be delivered - not a
decorative curve drawn to look plausible.

That also lets the server *verify* a prescription before it is issued: given a
notch centre, width and depth, it measures the achieved attenuation at the
tinnitus frequency and the residual energy inside the notch, and refuses to issue
a program whose notch does not actually reach the target depth.
"""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Any, Iterable, Literal

import numpy as np
from scipy import signal

SAMPLE_RATE = 48_000
NoiseColor = Literal["white", "pink", "brown", "blue", "grey"]

# Spectral slope in dB per octave for each noise colour.
NOISE_SLOPE_DB_OCT: dict[str, float] = {
    "white": 0.0,
    "pink": -3.0,
    "brown": -6.0,
    "blue": +3.0,
    "grey": 0.0,  # perceptually flat; equal-loudness weighted below
}


# --------------------------------------------------------------------------- #
# Biquad design (RBJ Audio EQ Cookbook) - mirrors Web Audio BiquadFilterNode
# --------------------------------------------------------------------------- #
def q_from_bandwidth(bandwidth_octaves: float) -> float:
    """Convert a bandwidth in octaves to the Q that Web Audio expects."""
    bw = max(0.05, float(bandwidth_octaves))
    return math.sqrt(2**bw) / (2**bw - 1)


def peaking_biquad(
    f0: float, gain_db: float, q: float, fs: int = SAMPLE_RATE
) -> tuple[np.ndarray, np.ndarray]:
    """Peaking EQ. A negative `gain_db` is the notch used by the therapy engine."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * math.pi * f0 / fs
    alpha = math.sin(w0) / (2 * q)
    cos_w0 = math.cos(w0)
    b = np.array([1 + alpha * A, -2 * cos_w0, 1 - alpha * A], dtype=float)
    a = np.array([1 + alpha / A, -2 * cos_w0, 1 - alpha / A], dtype=float)
    return b / a[0], a / a[0]


def lowshelf_biquad(
    f0: float, gain_db: float, s: float = 1.0, fs: int = SAMPLE_RATE
) -> tuple[np.ndarray, np.ndarray]:
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * math.pi * f0 / fs
    cos_w0, sin_w0 = math.cos(w0), math.sin(w0)
    alpha = sin_w0 / 2 * math.sqrt((A + 1 / A) * (1 / s - 1) + 2)
    two_sqrt_a_alpha = 2 * math.sqrt(A) * alpha
    b = np.array(
        [
            A * ((A + 1) - (A - 1) * cos_w0 + two_sqrt_a_alpha),
            2 * A * ((A - 1) - (A + 1) * cos_w0),
            A * ((A + 1) - (A - 1) * cos_w0 - two_sqrt_a_alpha),
        ]
    )
    a = np.array(
        [
            (A + 1) + (A - 1) * cos_w0 + two_sqrt_a_alpha,
            -2 * ((A - 1) + (A + 1) * cos_w0),
            (A + 1) + (A - 1) * cos_w0 - two_sqrt_a_alpha,
        ]
    )
    return b / a[0], a / a[0]


def lowpass_biquad(f0: float, q: float = 0.707, fs: int = SAMPLE_RATE):
    w0 = 2 * math.pi * min(f0, fs / 2 * 0.99) / fs
    alpha = math.sin(w0) / (2 * q)
    cos_w0 = math.cos(w0)
    b = np.array([(1 - cos_w0) / 2, 1 - cos_w0, (1 - cos_w0) / 2])
    a = np.array([1 + alpha, -2 * cos_w0, 1 - alpha])
    return b / a[0], a / a[0]


def highpass_biquad(f0: float, q: float = 0.707, fs: int = SAMPLE_RATE):
    w0 = 2 * math.pi * max(f0, 10.0) / fs
    alpha = math.sin(w0) / (2 * q)
    cos_w0 = math.cos(w0)
    b = np.array([(1 + cos_w0) / 2, -(1 + cos_w0), (1 + cos_w0) / 2])
    a = np.array([1 + alpha, -2 * cos_w0, 1 - alpha])
    return b / a[0], a / a[0]


def log_frequency_axis(
    f_lo: float = 50.0, f_hi: float = 18_000.0, points: int = 320
) -> np.ndarray:
    return np.logspace(math.log10(f_lo), math.log10(f_hi), points)


def cascade_response(
    sections: Iterable[tuple[np.ndarray, np.ndarray]],
    freqs: np.ndarray,
    fs: int = SAMPLE_RATE,
) -> np.ndarray:
    """Magnitude response in dB of a cascade of biquads at `freqs`."""
    total = np.zeros_like(freqs, dtype=float)
    w = 2 * math.pi * freqs / fs
    for b, a in sections:
        _, h = signal.freqz(b, a, worN=w)
        total += 20 * np.log10(np.maximum(np.abs(h), 1e-9))
    return total


# --------------------------------------------------------------------------- #
# Therapy filter chains
# --------------------------------------------------------------------------- #
def _cascade_width_octaves(
    notch_hz: float, per_stage_bw: float, stages: int, depth_db: float, fs: int
) -> float:
    """Composite -3 dB width, in octaves, of `stages` identical peaking sections."""
    q = q_from_bandwidth(per_stage_bw)
    per_stage_gain = -abs(depth_db) / max(1, stages)
    sections = [peaking_biquad(notch_hz, per_stage_gain, q, fs) for _ in range(stages)]

    lo_hz = max(20.0, notch_hz / 16)
    hi_hz = min(fs / 2 * 0.98, notch_hz * 16)
    freqs = np.logspace(math.log10(lo_hz), math.log10(hi_hz), 700)
    attenuation = -cascade_response(sections, freqs, fs)

    centre = int(np.argmin(np.abs(np.log2(freqs / notch_hz))))
    if attenuation[centre] < 3.0:
        return 0.0
    lo_idx = centre
    while lo_idx > 0 and attenuation[lo_idx - 1] >= 3.0:
        lo_idx -= 1
    hi_idx = centre
    while hi_idx < len(freqs) - 1 and attenuation[hi_idx + 1] >= 3.0:
        hi_idx += 1
    return math.log2(freqs[hi_idx] / freqs[lo_idx])


@lru_cache(maxsize=512)
def calibrate_stage_bandwidth(
    notch_hz: float, target_width_octaves: float, stages: int, depth_db: float, fs: int = SAMPLE_RATE
) -> float:
    """Per-stage bandwidth whose *cascade* achieves `target_width_octaves`.

    Cascading N identical peaking sections multiplies the attenuation but also
    widens the -3 dB skirt: three sections each specified at 0.5 octaves produce a
    composite notch about 1.8 octaves wide. Naively passing the target width to
    every stage therefore removes three times more spectrum than intended, which
    strips the stimulation that notched therapy depends on.

    So solve for it. The mapping from per-stage bandwidth to composite width is
    monotonic, so a bisection converges quickly and exactly.
    """
    lo, hi = 0.005, max(0.02, target_width_octaves)
    if _cascade_width_octaves(notch_hz, hi, stages, depth_db, fs) <= target_width_octaves:
        return hi  # already narrow enough (single stage, or a very wide target)

    for _ in range(40):
        mid = (lo + hi) / 2
        width = _cascade_width_octaves(notch_hz, mid, stages, depth_db, fs)
        if width > target_width_octaves:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-4:
            break
    return (lo + hi) / 2


def build_notch_chain(
    *,
    notch_hz: float,
    width_octaves: float = 0.5,
    depth_db: float = 40.0,
    stages: int = 3,
    high_cut_hz: float | None = 14_000.0,
    low_cut_hz: float | None = 120.0,
    fs: int = SAMPLE_RATE,
) -> list[dict[str, Any]]:
    """Cascade of peaking sections forming the therapy notch.

    A single biquad cannot reach 40 dB of attenuation while staying half an octave
    wide, so the notch is built from `stages` shallower sections at the same
    centre, with the per-stage Q calibrated so the composite width matches the
    prescription. The returned chain is exactly what the client instantiates,
    node for node - same filter types, same frequencies, same Q values.
    """
    stage_bw = calibrate_stage_bandwidth(
        round(float(notch_hz), 2), round(float(width_octaves), 4), int(stages), round(float(depth_db), 2), fs
    )
    per_stage = -abs(depth_db) / max(1, stages)
    q = q_from_bandwidth(stage_bw)

    chain: list[dict[str, Any]] = []
    if low_cut_hz:
        chain.append({"type": "highpass", "frequency": low_cut_hz, "Q": 0.707, "gain": 0.0})
    for _ in range(stages):
        chain.append(
            {"type": "peaking", "frequency": float(notch_hz), "Q": round(q, 4), "gain": round(per_stage, 3)}
        )
    if high_cut_hz:
        chain.append(
            {"type": "lowpass", "frequency": float(min(high_cut_hz, fs / 2 * 0.95)), "Q": 0.707, "gain": 0.0}
        )
    return chain


def _sections_from_chain(chain: list[dict[str, Any]], fs: int = SAMPLE_RATE):
    sections = []
    for node in chain:
        t = node["type"]
        f0 = float(node["frequency"])
        q = float(node.get("Q", 0.707))
        gain = float(node.get("gain", 0.0))
        if t == "peaking":
            sections.append(peaking_biquad(f0, gain, q, fs))
        elif t == "lowshelf":
            sections.append(lowshelf_biquad(f0, gain, fs=fs))
        elif t == "lowpass":
            sections.append(lowpass_biquad(f0, q, fs))
        elif t == "highpass":
            sections.append(highpass_biquad(f0, q, fs))
    return sections


def noise_psd_db(freqs: np.ndarray, color: str) -> np.ndarray:
    """Idealised power spectral density of the noise source, in dB, referenced
    to 1 kHz."""
    slope = NOISE_SLOPE_DB_OCT.get(color, 0.0)
    octaves = np.log2(np.maximum(freqs, 1.0) / 1000.0)
    psd = slope * octaves
    if color == "grey":
        # Grey noise is shaped to be perceptually flat: apply an inverted
        # A-weighting so equal-loudness rather than equal-energy is achieved.
        psd = -a_weighting_db(freqs)
    return psd


def a_weighting_db(freqs: np.ndarray) -> np.ndarray:
    """IEC 61672 A-weighting curve, used for grey noise and level reporting."""
    f = np.maximum(np.asarray(freqs, dtype=float), 1.0)
    f2 = f**2
    num = (12194.0**2) * f2**2
    den = (
        (f2 + 20.6**2)
        * np.sqrt((f2 + 107.7**2) * (f2 + 737.9**2))
        * (f2 + 12194.0**2)
    )
    return 20 * np.log10(num / den) + 2.0


def analyse_prescription_spectrum(
    *,
    notch_hz: float | None,
    width_octaves: float = 0.5,
    depth_db: float = 40.0,
    stages: int = 3,
    noise_color: str = "pink",
    high_cut_hz: float | None = 14_000.0,
    low_cut_hz: float | None = 120.0,
    tinnitus_hz: float | None = None,
) -> dict[str, Any]:
    """Compute and verify the delivered spectrum of a therapy block."""
    freqs = log_frequency_axis()
    source_db = noise_psd_db(freqs, noise_color)

    if notch_hz:
        chain = build_notch_chain(
            notch_hz=notch_hz,
            width_octaves=width_octaves,
            depth_db=depth_db,
            stages=stages,
            high_cut_hz=high_cut_hz,
            low_cut_hz=low_cut_hz,
        )
    else:
        chain = []
        if low_cut_hz:
            chain.append({"type": "highpass", "frequency": low_cut_hz, "Q": 0.707})
        if high_cut_hz:
            chain.append({"type": "lowpass", "frequency": high_cut_hz, "Q": 0.707})

    filter_db = cascade_response(_sections_from_chain(chain), freqs)
    delivered_db = source_db + filter_db
    delivered_db -= float(np.max(delivered_db))  # normalise to 0 dB peak

    verification: dict[str, Any] = {"notch_requested_db": depth_db if notch_hz else None}
    target = tinnitus_hz or notch_hz
    if notch_hz and target:
        at_target = float(np.interp(math.log10(target), np.log10(freqs), filter_db))
        verification["achieved_attenuation_db"] = round(-at_target, 1)
        verification["meets_target"] = bool(-at_target >= abs(depth_db) * 0.75)

        # Measured -3 dB width of the realised notch, in octaves.
        #
        # Measured as the contiguous band around the notch centre where
        # attenuation relative to the passband exceeds 3 dB - NOT as the band
        # within 3 dB of the notch floor, which for a deep cascaded notch
        # describes only the sharp tip and badly understates the real width.
        # Walking outward from the centre also keeps the band-edge roll-off of the
        # high/low-pass sections out of the measurement.
        attenuation = -filter_db
        centre_idx = int(np.argmin(np.abs(np.log2(freqs / notch_hz))))
        if attenuation[centre_idx] >= 3.0:
            lo_idx = centre_idx
            while lo_idx > 0 and attenuation[lo_idx - 1] >= 3.0:
                lo_idx -= 1
            hi_idx = centre_idx
            while hi_idx < len(freqs) - 1 and attenuation[hi_idx + 1] >= 3.0:
                hi_idx += 1
            lo, hi = float(freqs[lo_idx]), float(freqs[hi_idx])
            verification["achieved_width_octaves"] = round(math.log2(hi / lo), 3)
            verification["notch_edges_hz"] = [round(lo, 1), round(hi, 1)]
            verification["width_definition"] = (
                "contiguous band about the centre with >3 dB attenuation relative to the passband"
            )

        # Fraction of total delivered power that still falls inside the notch -
        # the number that says whether the stimulus really spares the tinnitus band.
        band = (freqs >= target / 2 ** (width_octaves / 2)) & (
            freqs <= target * 2 ** (width_octaves / 2)
        )
        lin = 10 ** (delivered_db / 10)
        verification["residual_energy_in_notch_pct"] = round(
            100 * float(lin[band].sum() / lin.sum()), 3
        )

    return {
        "frequencies_hz": [round(float(f), 1) for f in freqs],
        "source_db": [round(float(v), 2) for v in source_db],
        "filter_db": [round(float(v), 2) for v in filter_db],
        "delivered_db": [round(float(v), 2) for v in delivered_db],
        "filter_chain": chain,
        "noise_color": noise_color,
        "notch_hz": notch_hz,
        "sample_rate": SAMPLE_RATE,
        "verification": verification,
    }


def masker_level_recommendation(
    *,
    loudness_db_sl: float | None,
    mml_db_sl: float | None,
    ldl_db_hl: float | None,
    hyperacusis: bool,
    strategy: str,
) -> dict[str, Any]:
    """Choose the delivery level, in dB relative to the patient's tinnitus.

    Three strategies with different level targets:

    * ``mixing_point`` - the TRT target: the masker just begins to blend with the
      percept without covering it, which supports habituation.
    * ``partial_masking`` - a few dB above the mixing point for immediate relief.
    * ``sub_threshold`` - deliberately below the percept, for hyperacusis and for
      patients who rebound after masking.
    """
    base = loudness_db_sl if loudness_db_sl is not None else 8.0
    if strategy == "sub_threshold":
        target_sl = max(0.5, base - 4.0)
        note = "Below the tinnitus percept - desensitisation without masking."
    elif strategy == "partial_masking":
        target_sl = base + 3.0 if mml_db_sl is None else min(mml_db_sl - 1.0, base + 6.0)
        note = "Partial masking: the percept should remain just audible, never covered."
    else:
        target_sl = base + 1.0
        note = "Mixing point: masker and tinnitus blend without the percept disappearing."

    cap_reason = None
    if hyperacusis:
        target_sl = min(target_sl, base + 1.0, 12.0)
        cap_reason = "Capped for reduced sound tolerance."
    if ldl_db_hl is not None:
        # Never approach the loudness discomfort level; keep 20 dB of headroom.
        ceiling_sl = max(1.0, ldl_db_hl - 20.0)
        if target_sl > ceiling_sl:
            target_sl = ceiling_sl
            cap_reason = f"Capped 20 dB below the measured LDL of {ldl_db_hl:.0f} dB HL."

    return {
        "strategy": strategy,
        "target_sensation_level_db": round(float(target_sl), 1),
        "note": note,
        "cap_reason": cap_reason,
        "max_session_minutes": 120 if strategy != "partial_masking" else 90,
        "safety": "Total daily acoustic dose is capped so that no programme can approach "
        "an 80 dB(A) 8-hour equivalent exposure.",
    }

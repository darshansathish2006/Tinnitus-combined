"""Masking threshold analysis: the curve, and the reference level.

A minimum masking level (MML) measured at one frequency tells you how loud a
masker has to be to cover the tinnitus *there*. Measured across the audiometric
range it tells you something considerably more useful — **where** the percept is
easiest to cover, which is not always where the patient matched its pitch, and
how sharply the requirement rises away from that point.

Three things come out of the profile:

* **The curve** — threshold against frequency, which is what gets plotted.
* **The reference level** — the minimum of the curve, and the frequency it
  occurs at. This is the level a therapy masker has to reach to be effective at
  all, and it is the number the prescription is built around.
* **A shape classification** — how selective the masking is. A patient whose
  curve is flat can be masked by almost anything; one with a sharp minimum
  needs a narrow band placed accurately, and one who cannot be masked at any
  frequency should not be prescribed masking at all.

Nothing here invents a cut-point. The bands below are the conventional MML
sensation-level descriptors already used by `clinical.instruments` and the
therapy engine; this module applies them to a profile rather than a single
number.
"""

from __future__ import annotations

import math
from typing import Any, Iterable, Mapping

from clinical.audiometry import threshold_at

# The audiometric set the masking module administers, in order. Frequencies are
# the standard clinical series — the same ones the audiogram uses, so a masking
# threshold and a hearing threshold at 4 kHz are directly comparable.
MASKING_FREQUENCIES: list[int] = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000]

# Above this, a masker is loud enough to be a problem in its own right: it
# approaches the level at which sound-induced discomfort and further hearing
# damage become the greater risk. A threshold recorded above it is treated as
# "not maskable at a safe level" rather than as a usable number.
MAX_SAFE_MASKING_DB = 85.0

# How much the curve has to rise away from its minimum before the masking is
# called frequency-selective. One-third of an octave either side of a 10 dB
# minimum is the difference between "any broadband sound works" and "the band
# has to be placed on the percept".
SELECTIVITY_DB = 12.0

# A reference tone has to be *audible* to the patient it was personalised for.
# Presented at their own threshold it is, by definition, at the edge of
# detection — so the derived level is floored a few dB above it.
MIN_SENSATION_LEVEL_DB = 3.0

# Where masking was never measured, the loudness match is the fallback. A masker
# has to reach the percept's own level before it starts to cover it, and the
# usual clinical observation is that minimum masking sits a few dB above the
# loudness match rather than exactly on it.
LOUDNESS_TO_MASKING_DB = 6.0


def _clean(raw: Mapping[str, Any] | None) -> dict[int, float]:
    """Coerce the stored map into {hz: db}, dropping anything unusable."""
    out: dict[int, float] = {}
    if not raw:
        return out
    for key, value in raw.items():
        try:
            hz = int(float(key))
            db = float(value)
        except (TypeError, ValueError):
            continue
        if hz <= 0 or not (-20.0 <= db <= 130.0):
            continue
        out[hz] = round(db, 1)
    return out


def _unmaskable_set(unmasked: Iterable[Any]) -> set[int]:
    out: set[int] = set()
    for item in unmasked or ():
        try:
            out.add(int(float(item)))
        except (TypeError, ValueError):
            continue
    return out


def _usable(thresholds: Mapping[str, Any] | None, unmasked: Iterable[Any] = ()) -> dict[int, float]:
    """Tested frequencies that produced a real threshold, keyed by hertz.

    Frequencies the patient could not mask at any level are excluded: "never
    disappeared" is a finding, not a very large number, and letting it behave
    like one would drag every derivation upwards.
    """
    unmaskable = _unmaskable_set(unmasked)
    return {hz: db for hz, db in _clean(thresholds).items() if hz not in unmaskable}


def curve(thresholds: Mapping[str, Any] | None, unmasked: Iterable[Any] = ()) -> list[dict[str, Any]]:
    """The plotted series: one point per tested frequency, in frequency order.

    Untested frequencies are omitted rather than interpolated. A masking curve
    with a fabricated point on it is a curve a clinician cannot reason about,
    and the honest rendering of "we did not test 6 kHz" is a gap in the line.

    Frequencies the patient could not mask are returned with `masked: False` and
    a null threshold, so the chart can mark them distinctly from untested ones.
    """
    values = _clean(thresholds)
    unmaskable = set()
    for item in unmasked or ():
        try:
            unmaskable.add(int(float(item)))
        except (TypeError, ValueError):
            continue

    points: list[dict[str, Any]] = []
    for hz in MASKING_FREQUENCIES:
        if hz in unmaskable:
            points.append({"hz": hz, "threshold_db": None, "masked": False, "tested": True})
        elif hz in values:
            db = values[hz]
            points.append(
                {
                    "hz": hz,
                    "threshold_db": db,
                    "masked": True,
                    "tested": True,
                    # Flagged rather than dropped: the measurement is real, it
                    # is the *dose* it implies that is unsafe.
                    "above_safe_level": db > MAX_SAFE_MASKING_DB,
                }
            )
        else:
            points.append({"hz": hz, "threshold_db": None, "masked": None, "tested": False})
    return points


def reference_level(
    thresholds: Mapping[str, Any] | None,
    unmasked: Iterable[Any] = (),
) -> dict[str, Any]:
    """The patient's estimated tinnitus matching level, from the masking profile.

    **Definition.** The reference level is the *minimum* of the masking curve —
    the quietest masker, at the frequency where it is quietest, that renders the
    tinnitus inaudible. That minimum is taken as the best available estimate of
    the percept's own effective level, because a masker only has to match it to
    cover it.

    Why the minimum and not the mean: a mean across eight frequencies is
    dominated by the frequencies furthest from the percept, where the threshold
    is high for reasons that have nothing to do with the tinnitus. The minimum
    is the one point on the curve that is actually about the percept.

    Ties go to the lower frequency. A flat curve genuinely has no single best
    frequency, and picking the lowest gives a stable, reproducible answer rather
    than one that changes with dictionary ordering — `selectivity` is what tells
    the reader the choice was arbitrary.
    """
    values = _clean(thresholds)
    unmaskable = set()
    for item in unmasked or ():
        try:
            unmaskable.add(int(float(item)))
        except (TypeError, ValueError):
            continue
    usable = {hz: db for hz, db in values.items() if hz not in unmaskable}

    if not usable:
        return {
            "reference_level_db": None,
            "reference_level_hz": None,
            "tested_count": len(values),
            "unmaskable_count": len(unmaskable),
            "maskable": False,
            "selectivity": "not_measured",
            "spread_db": None,
            "safe": None,
        }

    best_hz = min(sorted(usable), key=lambda hz: usable[hz])
    best_db = usable[best_hz]
    spread = round(max(usable.values()) - best_db, 1)

    # Broad: any sound covers it. Selective: the band has to be on the percept.
    if len(usable) < 3:
        selectivity = "insufficient"
    elif spread >= SELECTIVITY_DB:
        selectivity = "selective"
    else:
        selectivity = "broad"

    return {
        "reference_level_db": best_db,
        "reference_level_hz": best_hz,
        "tested_count": len(values),
        "unmaskable_count": len(unmaskable),
        "maskable": True,
        "selectivity": selectivity,
        "spread_db": spread,
        # False means an effective masker would have to run above the safe
        # ceiling — the therapy engine must not simply raise the level.
        "safe": best_db <= MAX_SAFE_MASKING_DB,
        "max_safe_db": MAX_SAFE_MASKING_DB,
    }


def interpretation_key(summary: Mapping[str, Any]) -> str:
    """Which explanation the client should render for this result.

    Returns a key, not prose — the sentence lives in the translation files, the
    clinical banding lives here. Same split as `clinical.instruments`.
    """
    if not summary.get("maskable"):
        return "unmaskable"
    if not summary.get("safe"):
        return "above_safe"
    db = summary.get("reference_level_db")
    if db is None:
        return "unmaskable"
    if db <= 25:
        return "easily_masked"
    if db <= 45:
        return "moderately_masked"
    return "hard_to_mask"


def _masking_at(usable: Mapping[int, float], hz: float) -> tuple[float, int] | None:
    """The masking threshold at an arbitrary frequency, log-interpolated.

    Returns `(db, nearest_tested_hz)`, or None when nothing was measured. The
    tinnitus pitch almost never lands on an audiometric frequency — a patient
    who matched at 3.4 kHz has thresholds at 3 kHz and 4 kHz either side of it —
    so the value between them is interpolated on a log-frequency axis, the same
    way `clinical.audiometry.threshold_at` interpolates hearing thresholds.

    Outside the tested span the nearest endpoint is used rather than an
    extrapolation, because a masking curve gives no basis for guessing beyond
    where it was measured.
    """
    if not usable:
        return None
    freqs = sorted(usable)
    nearest = min(freqs, key=lambda f: abs(math.log2(f) - math.log2(max(hz, 1.0))))
    if hz <= freqs[0]:
        return usable[freqs[0]], freqs[0]
    if hz >= freqs[-1]:
        return usable[freqs[-1]], freqs[-1]
    for lo, hi in zip(freqs, freqs[1:]):
        if lo <= hz <= hi:
            if hi == lo:
                return usable[lo], lo
            w = (math.log2(hz) - math.log2(lo)) / (math.log2(hi) - math.log2(lo))
            return round(usable[lo] + w * (usable[hi] - usable[lo]), 1), nearest
    return usable[nearest], nearest


def _better_ear_threshold(audiogram: Mapping[str, Any] | None, hz: float) -> float | None:
    """The patient's own hearing threshold at a frequency, better ear.

    Better rather than mean: the reference tone is presented to both ears, so
    the ear that hears it first is the one that decides whether it is audible.
    """
    if not audiogram:
        return None
    values = [
        threshold_at(audiogram.get(side), hz)
        for side in ("left", "right")
    ]
    present = [v for v in values if v is not None]
    return min(present) if present else None


def personalised_reference(
    thresholds: Mapping[str, Any] | None = None,
    unmasked: Iterable[Any] = (),
    *,
    pitch_match_hz: float | None = None,
    loudness_match_db_hl: float | None = None,
    audiogram: Mapping[str, Any] | None = None,
    audiometric_notch_hz: float | None = None,
) -> dict[str, Any]:
    """The patient's *own* reference tone and level, from their own assessment.

    A fixed 1 kHz tone at a nominal loudness is a property of the equipment, not
    of the patient. It tells you nothing about the percept and, for the majority
    of tinnitus patients — whose percept sits in the 3–8 kHz region where their
    hearing loss also sits — it is played into the one part of the spectrum the
    assessment already established is *least* representative of them.

    So the reference is derived instead, from measurements the patient has
    already given:

    * **Frequency** — the pitch match, which is the patient's own answer to
      "where is it". Where pitch matching was not performed, the minimum of the
      masking curve is the next best statement of where the percept lives, then
      the audiometric notch centre, which is where tinnitus most often sits when
      nothing else was measured.
    * **Level** — the masking threshold *at that frequency*, interpolated from
      the curve. That is the measured level at which the percept stops being
      audible, which is the only level in the assessment that is about the
      percept rather than about the hardware. Falling back, in order: the
      minimum of the curve, the loudness match plus the usual masking increment,
      then a sensation level above the patient's own hearing threshold.

    Two bounds are then applied, and both are clinical rather than cosmetic:

    * **Audibility floor.** A level below the patient's own threshold at that
      frequency is a tone they cannot hear. Floored at threshold +
      `MIN_SENSATION_LEVEL_DB`.
    * **Safety ceiling.** Capped at `MAX_SAFE_MASKING_DB`. A reference tone is
      not worth hearing damage, and a patient whose derived level wants to go
      above the cap is told that rather than being played it.

    Every field carries the basis it came from, so the screen can say *which*
    of the patient's measurements produced the number instead of presenting it
    as having appeared from nowhere.
    """
    usable = _usable(thresholds, unmasked)
    summary = reference_level(thresholds, unmasked)

    # -- frequency ---------------------------------------------------------- #
    hz: float | None = None
    frequency_basis = "unavailable"
    if pitch_match_hz is not None and 50 <= float(pitch_match_hz) <= 20000:
        hz = float(pitch_match_hz)
        frequency_basis = "pitch_match"
    elif summary["reference_level_hz"] is not None:
        hz = float(summary["reference_level_hz"])
        frequency_basis = "masking_minimum"
    elif audiometric_notch_hz is not None and 50 <= float(audiometric_notch_hz) <= 20000:
        hz = float(audiometric_notch_hz)
        frequency_basis = "audiometric_notch"

    if hz is None:
        return {
            "personalised": False,
            "reference_tone_hz": None,
            "reference_level_db_hl": None,
            "frequency_basis": frequency_basis,
            "level_basis": "unavailable",
            "hearing_threshold_db_hl": None,
            "sensation_level_db": None,
            "masking_at_reference_db": None,
            "masking_nearest_hz": None,
            "floored_to_audibility": False,
            "capped_to_safe": False,
            "safe": None,
            "max_safe_db": MAX_SAFE_MASKING_DB,
            "inputs": {
                "pitch_match_hz": None,
                "loudness_match_db_hl": loudness_match_db_hl,
                "masking_tested_count": len(usable),
                "masking_minimum_db": summary["reference_level_db"],
                "masking_minimum_hz": summary["reference_level_hz"],
                "hearing_profile": False,
            },
        }

    hz = round(hz)

    # -- level -------------------------------------------------------------- #
    at_reference = _masking_at(usable, hz)
    hearing_threshold = _better_ear_threshold(audiogram, hz)

    level: float | None = None
    level_basis = "unavailable"
    if at_reference is not None:
        level, _nearest = at_reference
        level_basis = "masking_at_reference"
    elif summary["reference_level_db"] is not None:
        level = float(summary["reference_level_db"])
        level_basis = "masking_minimum"
    elif loudness_match_db_hl is not None:
        level = float(loudness_match_db_hl) + LOUDNESS_TO_MASKING_DB
        level_basis = "loudness_match"
    elif hearing_threshold is not None:
        level = hearing_threshold + 10.0
        level_basis = "hearing_profile"

    if level is None:
        return {
            "personalised": False,
            "reference_tone_hz": hz,
            "reference_level_db_hl": None,
            "frequency_basis": frequency_basis,
            "level_basis": level_basis,
            "hearing_threshold_db_hl": hearing_threshold,
            "sensation_level_db": None,
            "masking_at_reference_db": None,
            "masking_nearest_hz": None,
            "floored_to_audibility": False,
            "capped_to_safe": False,
            "safe": None,
            "max_safe_db": MAX_SAFE_MASKING_DB,
            "inputs": {
                "pitch_match_hz": pitch_match_hz,
                "loudness_match_db_hl": loudness_match_db_hl,
                "masking_tested_count": len(usable),
                "masking_minimum_db": summary["reference_level_db"],
                "masking_minimum_hz": summary["reference_level_hz"],
                "hearing_profile": hearing_threshold is not None,
            },
        }

    floor = None if hearing_threshold is None else hearing_threshold + MIN_SENSATION_LEVEL_DB
    floored = floor is not None and level < floor
    if floored:
        level = floor

    capped = level > MAX_SAFE_MASKING_DB
    if capped:
        level = MAX_SAFE_MASKING_DB

    level = round(max(level, 0.0), 1)

    return {
        "personalised": True,
        "reference_tone_hz": hz,
        "reference_level_db_hl": level,
        "frequency_basis": frequency_basis,
        "level_basis": level_basis,
        "hearing_threshold_db_hl": hearing_threshold,
        # How far above the patient's own threshold the tone sits. This is the
        # number that travels to the therapy engine, because a level in dB HL
        # means something different to every patient and a sensation level does
        # not.
        "sensation_level_db": None if hearing_threshold is None else round(level - hearing_threshold, 1),
        "masking_at_reference_db": None if at_reference is None else at_reference[0],
        "masking_nearest_hz": None if at_reference is None else at_reference[1],
        "floored_to_audibility": floored,
        "capped_to_safe": capped,
        "safe": not capped,
        "max_safe_db": MAX_SAFE_MASKING_DB,
        "inputs": {
            "pitch_match_hz": None if pitch_match_hz is None else round(float(pitch_match_hz)),
            "loudness_match_db_hl": loudness_match_db_hl,
            "masking_tested_count": len(usable),
            "masking_minimum_db": summary["reference_level_db"],
            "masking_minimum_hz": summary["reference_level_hz"],
            "hearing_profile": hearing_threshold is not None,
        },
    }


def analyse(
    thresholds: Mapping[str, Any] | None,
    unmasked: Iterable[Any] = (),
    *,
    pitch_match_hz: float | None = None,
    loudness_match_db_hl: float | None = None,
    audiogram: Mapping[str, Any] | None = None,
    audiometric_notch_hz: float | None = None,
) -> dict[str, Any]:
    """Everything the report and the therapy engine need, in one call.

    The personalised reference travels with the masking analysis rather than
    being a separate derivation, so the report, the assessment result and the
    reference-level module all read one computation of it.
    """
    summary = reference_level(thresholds, unmasked)
    return {
        "frequencies": MASKING_FREQUENCIES,
        "curve": curve(thresholds, unmasked),
        **summary,
        "interpretation": interpretation_key(summary),
        "personalised": personalised_reference(
            thresholds,
            unmasked,
            pitch_match_hz=pitch_match_hz,
            loudness_match_db_hl=loudness_match_db_hl,
            audiogram=audiogram,
            audiometric_notch_hz=audiometric_notch_hz,
        ),
    }

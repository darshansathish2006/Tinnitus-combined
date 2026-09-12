"""Validated instrument item banks and scoring algorithms.

Every scoring function here follows the published algorithm for its instrument so
that scores are comparable with the literature and with paper administration:

* **THI-5** - a five-item short form drawn from the Tinnitus Handicap Inventory
             (Newman, Jacobson & Spitzer, 1996), covering sleep, concentration,
             anxiety, daily function and mood. Yes=4 / Sometimes=2 / No=0, raw
             0-20, projected onto the published 0-100 scale so the grading bands,
             historical scores and model features stay on one number. The 25-item
             bank is retained and `score_thi()` still scores historical long-form
             records the original way, so no past assessment is rescored.
* **PSQI** - Pittsburgh Sleep Quality Index (Buysse et al., 1989). Seven component
             scores of 0-3 summed to a global 0-21; >5 indicates poor sleep.
* **PSS-10** - Perceived Stress Scale (Cohen & Williamson, 1988). Items 4,5,7,8
             reverse scored, total 0-40.
* **GAD-7** - Generalised Anxiety Disorder 7 (Spitzer et al., 2006). 0-21.
* **PHQ-2** - Depression screen (Kroenke et al., 2003). Positive at >=3.
* **TFI** - Tinnitus Functional Index (Meikle et al., 2012). 25 items, 8
             subscales, 0-100. Items 1 and 3 are percentage scales divided by
             10 for scoring; every other item is already 0-10. Invalid (no
             score reported) if fewer than 19 of 25 items are answered; a
             subscale is invalid if more than one of its items is missing.
             The overall score is always computed from the individual items,
             never from an average of the subscale scores.
* **ISI** - Insomnia Severity Index (Bastien et al., 2001). Seven scored
             components (three make up the published form's grouped item 1),
             each 0-4, summed to 0-28. Unlike GAD-7/PSS-10 this is never
             prorated: the source specifies no partial-completion allowance,
             so all seven are required or no score is reported at all.
* **PHQ-9** - Patient Health Questionnaire-9 (Kroenke et al., 2001). Nine
             items, each 0-3, summed to 0-27; also never prorated, for the
             same reason as the ISI. Item 9 (thoughts of self-harm) is
             flagged independently of that all-or-nothing gate - a positive
             response is a safety fact regardless of form completeness - and
             `clinical/redflags.py` acts on it exactly the way it already
             acts on THI's despair-item flag.

Scoring is deliberately tolerant of partial completion: `answered`/`expected`
counts are returned so the UI and the ML layer can distinguish "score 0" from
"not administered", and prorating is applied only when >=80% of items are present
(the TFI, ISI and PHQ-9 are the exceptions - see above).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Mapping, Sequence

# --------------------------------------------------------------------------- #
# Result container
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class ScoreResult:
    instrument: str
    score: int | None
    max_score: int
    grade: str | None
    interpretation: str
    answered: int
    expected: int
    subscales: dict[str, Any] = field(default_factory=dict)
    prorated: bool = False
    flags: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return self.answered == self.expected

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["complete"] = self.complete
        return d


def _coerce_items(raw: Mapping[str, Any] | None, keys: Iterable[str]) -> dict[str, int]:
    """Pull integer answers for `keys` out of a loosely-typed payload."""
    out: dict[str, int] = {}
    if not raw:
        return out
    for k in keys:
        v = raw.get(k, raw.get(str(k)))
        if v is None or v == "":
            continue
        try:
            out[k] = int(round(float(v)))
        except (TypeError, ValueError):
            continue
    return out


def _prorate(subtotal: int, answered: int, expected: int) -> tuple[int | None, bool]:
    """Return (score, was_prorated). Requires >=80% completion to prorate."""
    if answered == 0:
        return None, False
    if answered == expected:
        return subtotal, False
    if answered / expected >= 0.8:
        return int(round(subtotal * expected / answered)), True
    return None, False


# --------------------------------------------------------------------------- #
# THI - Tinnitus Handicap Inventory
# --------------------------------------------------------------------------- #
# `THI_ITEMS` below is the full published 25-item bank. It is no longer what gets
# administered - see `THI_SHORT_ITEMS` - but it stays here in full because every
# historical assessment in the record was scored against it, and `score_thi()`
# still scores those the original way. Deleting the bank would silently rescore
# every past assessment and break every trend line in the app.
THI_ITEMS: list[dict[str, Any]] = [
    {"id": "thi1", "n": 1, "sub": "functional", "text": "Because of your tinnitus, is it difficult for you to concentrate?"},
    {"id": "thi2", "n": 2, "sub": "functional", "text": "Does the loudness of your tinnitus make it difficult for you to hear people?"},
    {"id": "thi3", "n": 3, "sub": "emotional", "text": "Does your tinnitus make you angry?"},
    {"id": "thi4", "n": 4, "sub": "functional", "text": "Does your tinnitus make you feel confused?"},
    {"id": "thi5", "n": 5, "sub": "catastrophic", "text": "Because of your tinnitus, do you feel desperate?"},
    {"id": "thi6", "n": 6, "sub": "emotional", "text": "Do you complain a great deal about your tinnitus?"},
    {"id": "thi7", "n": 7, "sub": "functional", "text": "Because of your tinnitus, do you have trouble falling asleep at night?"},
    {"id": "thi8", "n": 8, "sub": "catastrophic", "text": "Do you feel as though you cannot escape your tinnitus?"},
    {"id": "thi9", "n": 9, "sub": "functional", "text": "Does your tinnitus interfere with your ability to enjoy social activities?"},
    {"id": "thi10", "n": 10, "sub": "emotional", "text": "Because of your tinnitus, do you feel frustrated?"},
    {"id": "thi11", "n": 11, "sub": "catastrophic", "text": "Because of your tinnitus, do you feel that you have a terrible disease?"},
    {"id": "thi12", "n": 12, "sub": "functional", "text": "Does your tinnitus make it difficult for you to enjoy life?"},
    {"id": "thi13", "n": 13, "sub": "functional", "text": "Does your tinnitus interfere with your job or household responsibilities?"},
    {"id": "thi14", "n": 14, "sub": "functional", "text": "Because of your tinnitus, do you find that you are often irritable?"},
    {"id": "thi15", "n": 15, "sub": "functional", "text": "Because of your tinnitus, is it difficult for you to read?"},
    {"id": "thi16", "n": 16, "sub": "emotional", "text": "Does your tinnitus make you upset?"},
    {"id": "thi17", "n": 17, "sub": "emotional", "text": "Do you feel that your tinnitus has placed stress on your relationships?"},
    {"id": "thi18", "n": 18, "sub": "functional", "text": "Do you find it difficult to focus your attention away from your tinnitus?"},
    {"id": "thi19", "n": 19, "sub": "catastrophic", "text": "Do you feel that you have no control over your tinnitus?"},
    {"id": "thi20", "n": 20, "sub": "functional", "text": "Because of your tinnitus, do you often feel tired?"},
    {"id": "thi21", "n": 21, "sub": "emotional", "text": "Because of your tinnitus, do you feel depressed?"},
    {"id": "thi22", "n": 22, "sub": "emotional", "text": "Does your tinnitus make you feel anxious?"},
    {"id": "thi23", "n": 23, "sub": "catastrophic", "text": "Do you feel that you can no longer cope with your tinnitus?"},
    {"id": "thi24", "n": 24, "sub": "functional", "text": "Does your tinnitus get worse when you are under stress?"},
    {"id": "thi25", "n": 25, "sub": "emotional", "text": "Does your tinnitus make you feel insecure?"},
]

THI_OPTIONS = [
    {"label": "No", "value": 0},
    {"label": "Sometimes", "value": 2},
    {"label": "Yes", "value": 4},
]

# --------------------------------------------------------------------------- #
# THI-5 - the administered short form
# --------------------------------------------------------------------------- #
# Five items, one per domain the THI actually loads on: sleep, concentration,
# anxiety, daily function and mood. Each keeps the *item id and number* of the
# published THI item it is drawn from, so a short-form response sits in the same
# item bank as a historical long-form one and the same scorer reads both.
#
# The wording is plainer than the published item. That is a deliberate departure
# and the reason this is reported as "THI-5 (short form)" everywhere rather than
# as a THI: the 25-item psychometrics do not transfer to a 5-item subset, and
# labelling it THI would imply they do.
#
# **What this costs, stated plainly.** Five items scored 0/2/4 give a raw range
# of 0-20 in steps of 2, projected onto the published 0-100 scale for continuity
# with historical scores, the grading bands and the model features. That makes
# the smallest observable change 10 points - larger than the THI's 7-point MCID.
# So the MCID no longer discriminates: any change this form can see is at or
# above it. `mcid_applies` is False on the result, and every consumer that used
# to compare against 7 has to read that flag rather than assume.
THI_SHORT_ITEMS: list[dict[str, Any]] = [
    {"id": "thi7", "n": 7, "sub": "functional", "text": "Does tinnitus interfere with your sleep?"},
    {"id": "thi1", "n": 1, "sub": "functional", "text": "Does tinnitus affect your concentration?"},
    {"id": "thi22", "n": 22, "sub": "emotional", "text": "Does tinnitus make you feel anxious?"},
    {"id": "thi13", "n": 13, "sub": "functional", "text": "Does tinnitus interfere with your daily activities?"},
    {"id": "thi21", "n": 21, "sub": "emotional", "text": "Does tinnitus affect your mood?"},
]

THI_SHORT_IDS = [i["id"] for i in THI_SHORT_ITEMS]
THI_SHORT_MAX = len(THI_SHORT_ITEMS) * 4  # 20

# (lower, upper, grade, label) - Newman/McCombe grading bands
THI_BANDS: list[tuple[int, int, int, str]] = [
    (0, 16, 1, "Slight"),
    (17, 36, 2, "Mild"),
    (37, 56, 3, "Moderate"),
    (57, 76, 4, "Severe"),
    (77, 100, 5, "Catastrophic"),
]

THI_GRADE_DETAIL = {
    1: "Only heard in quiet environments; very easily masked. No interference with sleep or daily activity.",
    2: "Easily masked by environmental sound and forgotten during activities. May occasionally interfere with sleep.",
    3: "Noticed in the presence of background noise, although daily activities can still be performed.",
    4: "Almost always heard, rarely masked, leads to disturbed sleep and interference with daily activity.",
    5: "Always heard, sleep badly disturbed, difficulty with any activity. Escalate for urgent multidisciplinary care.",
}

# Minimum clinically important difference for THI (Zeman et al.) - used for
# progress interpretation and to decide whether a change is real or noise.
THI_MCID = 7


def _thi_band(score: int | None) -> tuple[int | None, str | None, str]:
    if score is None:
        return None, None, ""
    for lo, hi, g, label in THI_BANDS:
        if lo <= score <= hi:
            return g, label, THI_GRADE_DETAIL[g]
    return None, None, ""


def score_thi(raw: Mapping[str, Any] | None) -> ScoreResult:
    """Score whichever THI form was administered.

    One scorer, two forms. Which one ran is decided by the data, not by a flag
    passed in: if any item outside the five-item short form was answered, this is
    a long-form record and is scored exactly as it always was, so historical
    assessments keep the scores their reports and trend lines were built on.
    Otherwise it is scored as the short form.
    """
    keys = [i["id"] for i in THI_ITEMS]
    items = _coerce_items(raw, keys)
    # Snap to the legal 0/2/4 response set.
    for k, v in list(items.items()):
        items[k] = min(THI_OPTIONS, key=lambda o: abs(o["value"] - v))["value"]

    long_form_answers = {k: v for k, v in items.items() if k not in THI_SHORT_IDS}
    short_form = not long_form_answers

    if short_form:
        return _score_thi_short(items)

    subtotal = sum(items.values())
    score, prorated = _prorate(subtotal, len(items), len(keys))

    subs: dict[str, Any] = {}
    for name, maximum in (("functional", 48), ("emotional", 32), ("catastrophic", 20)):
        ids = [i["id"] for i in THI_ITEMS if i["sub"] == name]
        got = {k: v for k, v in items.items() if k in ids}
        subs[name] = {
            "score": sum(got.values()) if got else None,
            "max": maximum,
            "answered": len(got),
            "expected": len(ids),
            "percent": round(100 * sum(got.values()) / maximum, 1) if got else None,
        }

    grade_num, grade_label, detail = _thi_band(score)

    flags: list[str] = []
    # Items 5, 8, 19, 23 are the hopelessness/no-control cluster - a maximal
    # response here warrants a psychological pathway even at a modest total.
    despair = [items.get(k) for k in ("thi5", "thi8", "thi19", "thi23")]
    if any(v == 4 for v in despair if v is not None):
        flags.append("catastrophic_ideation_item")

    return ScoreResult(
        instrument="THI",
        score=score,
        max_score=100,
        grade=f"Grade {grade_num} - {grade_label}" if grade_num else None,
        interpretation=detail,
        answered=len(items),
        expected=len(keys),
        subscales={
            **subs,
            "grade_number": grade_num,
            "mcid": THI_MCID,
            "mcid_applies": True,
            "form": "thi25",
        },
        prorated=prorated,
        flags=flags,
    )


def _score_thi_short(items: dict[str, int]) -> ScoreResult:
    """THI-5, projected onto the published 0-100 scale.

    The projection is what keeps `Assessment.thi_score`, the grading bands, the
    trend comparison and the model feature vector all working off one number
    across both forms. It is a rescaling, not an estimate of what the 25-item
    score would have been, and the result says so.

    A short form with missing answers is scored on what was answered, the same
    prorating the long form uses - with only five items, dropping the record
    entirely for one skipped question would lose the whole instrument.
    """
    answered = {k: v for k, v in items.items() if k in THI_SHORT_IDS}
    if not answered:
        return ScoreResult(
            instrument="THI-5",
            score=None,
            max_score=100,
            grade=None,
            interpretation="",
            answered=0,
            expected=len(THI_SHORT_IDS),
            subscales={"form": "thi5", "mcid_applies": False, "raw": None, "raw_max": THI_SHORT_MAX},
            prorated=False,
            flags=[],
        )

    raw = sum(answered.values())
    prorated = len(answered) < len(THI_SHORT_IDS)
    # Prorate to the full five items first, then project 0-20 onto 0-100.
    projected_raw = raw * len(THI_SHORT_IDS) / len(answered)
    score = int(round(projected_raw * 100 / THI_SHORT_MAX))
    grade_num, grade_label, detail = _thi_band(score)

    subs: dict[str, Any] = {}
    for name, maximum in (("functional", 12), ("emotional", 8)):
        ids = [i["id"] for i in THI_SHORT_ITEMS if i["sub"] == name]
        got = {k: v for k, v in answered.items() if k in ids}
        subs[name] = {
            "score": sum(got.values()) if got else None,
            "max": maximum,
            "answered": len(got),
            "expected": len(ids),
            "percent": round(100 * sum(got.values()) / maximum, 1) if got else None,
        }
    # The catastrophic subscale has no short-form items. Reported as null rather
    # than zero, because "not measured" and "no catastrophic thinking" are very
    # different findings and a zero here would read as the second.
    subs["catastrophic"] = {"score": None, "max": 20, "answered": 0, "expected": 0, "percent": None}

    flags: list[str] = []
    # The hopelessness cluster (items 5, 8, 19, 23) is not administered by the
    # short form, so its flag cannot fire. The nearest available signal is a
    # maximal mood or anxiety response, which routes to the same place.
    if any(answered.get(k) == 4 for k in ("thi21", "thi22")):
        flags.append("severe_mood_or_anxiety_item")

    return ScoreResult(
        instrument="THI-5",
        score=score,
        max_score=100,
        grade=f"Grade {grade_num} - {grade_label}" if grade_num else None,
        interpretation=detail,
        answered=len(answered),
        expected=len(THI_SHORT_IDS),
        subscales={
            **subs,
            "grade_number": grade_num,
            "mcid": THI_MCID,
            # False on purpose: one response step moves the projected score by 10,
            # which already exceeds the 7-point MCID.
            "mcid_applies": False,
            "smallest_detectable_change": 10,
            "form": "thi5",
            "raw": raw,
            "raw_max": THI_SHORT_MAX,
        },
        prorated=prorated,
        flags=flags,
    )


# --------------------------------------------------------------------------- #
# PSQI - Pittsburgh Sleep Quality Index
# --------------------------------------------------------------------------- #
PSQI_DISTURBANCE_KEYS = [
    "psqi5a", "psqi5b", "psqi5c", "psqi5d", "psqi5e",
    "psqi5f", "psqi5g", "psqi5h", "psqi5i",
]

# Note the absence of a "how many hours were you in bed?" item. The published
# PSQI derives time in bed from the bedtime and rise-time answers it has already
# collected, and asking for it a third time was redundant: three questions about
# the same interval, one of which patients routinely answer inconsistently with
# the other two. `_hours_in_bed()` computes it, and a stored value is still
# honoured so historical assessments score identically.
PSQI_ITEMS: list[dict[str, Any]] = [
    {"id": "psqi_bedtime", "kind": "time", "text": "What time have you usually gone to bed?"},
    {"id": "psqi_latency_min", "kind": "number", "unit": "minutes", "text": "How long has it taken you to fall asleep each night?"},
    {"id": "psqi_waketime", "kind": "time", "text": "What time have you usually got up in the morning?"},
    {"id": "psqi_sleep_hours", "kind": "number", "unit": "hours", "text": "How many hours of actual sleep did you get at night?"},
    {"id": "psqi5a", "kind": "freq", "text": "Trouble sleeping because you cannot get to sleep within 30 minutes"},
    {"id": "psqi5b", "kind": "freq", "text": "Trouble sleeping because you wake in the middle of the night or early morning"},
    {"id": "psqi5c", "kind": "freq", "text": "Trouble sleeping because you have to get up to use the bathroom"},
    {"id": "psqi5d", "kind": "freq", "text": "Trouble sleeping because you cannot breathe comfortably"},
    {"id": "psqi5e", "kind": "freq", "text": "Trouble sleeping because you cough or snore loudly"},
    {"id": "psqi5f", "kind": "freq", "text": "Trouble sleeping because you feel too cold"},
    {"id": "psqi5g", "kind": "freq", "text": "Trouble sleeping because you feel too hot"},
    {"id": "psqi5h", "kind": "freq", "text": "Trouble sleeping because you had bad dreams"},
    {"id": "psqi5i", "kind": "freq", "text": "Trouble sleeping because your tinnitus was intrusive"},
    {"id": "psqi6", "kind": "quality", "text": "How would you rate your sleep quality overall?"},
    {"id": "psqi7", "kind": "freq", "text": "How often have you taken medicine to help you sleep?"},
    {"id": "psqi8", "kind": "freq", "text": "How often have you had trouble staying awake while driving, eating or socialising?"},
    {"id": "psqi9", "kind": "problem", "text": "How much of a problem has it been to keep up enough enthusiasm to get things done?"},
]

PSQI_FREQ_OPTIONS = [
    {"label": "Not during the past month", "value": 0},
    {"label": "Less than once a week", "value": 1},
    {"label": "Once or twice a week", "value": 2},
    {"label": "Three or more times a week", "value": 3},
]
PSQI_QUALITY_OPTIONS = [
    {"label": "Very good", "value": 0},
    {"label": "Fairly good", "value": 1},
    {"label": "Fairly bad", "value": 2},
    {"label": "Very bad", "value": 3},
]
PSQI_PROBLEM_OPTIONS = [
    {"label": "No problem at all", "value": 0},
    {"label": "Only a very slight problem", "value": 1},
    {"label": "Somewhat of a problem", "value": 2},
    {"label": "A very big problem", "value": 3},
]


def _band(value: float, cuts: Sequence[float]) -> int:
    """Return the number of cut-points `value` exceeds (0..len(cuts))."""
    return sum(1 for c in cuts if value > c)


def _clock_hours(value: Any) -> float | None:
    """Parse an "HH:MM" time-of-day answer into hours past midnight."""
    if not isinstance(value, str) or ":" not in value:
        return None
    hours, _, minutes = value.partition(":")
    try:
        h, m = int(hours), int(minutes[:2])
    except ValueError:
        return None
    if not (0 <= h < 24 and 0 <= m < 60):
        return None
    return h + m / 60


def _hours_in_bed(raw: Mapping[str, Any]) -> float | None:
    """Time in bed, from rise time minus bedtime.

    Wrapping past midnight is the normal case, so a negative interval is a
    same-clock-day crossing rather than bad data and gets 24 h added.
    """
    stored = raw.get("psqi_hours_in_bed")
    if stored not in (None, ""):
        try:
            return float(stored)
        except (TypeError, ValueError):
            pass

    bed = _clock_hours(raw.get("psqi_bedtime"))
    wake = _clock_hours(raw.get("psqi_waketime"))
    if bed is None or wake is None:
        return None
    hours = wake - bed
    if hours <= 0:
        hours += 24
    # A reported interval outside 2-16 h is a data-entry error, not a sleep
    # pattern; scoring efficiency off it would produce a nonsense component.
    return hours if 2 <= hours <= 16 else None


def score_psqi(raw: Mapping[str, Any] | None) -> ScoreResult:
    raw = raw or {}

    def num(key: str) -> float | None:
        v = raw.get(key)
        try:
            return float(v)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None

    freqs = _coerce_items(raw, PSQI_DISTURBANCE_KEYS + ["psqi6", "psqi7", "psqi8", "psqi9"])
    latency = num("psqi_latency_min")
    sleep_hours = num("psqi_sleep_hours")
    in_bed = _hours_in_bed(raw)

    components: dict[str, int | None] = {}

    # C1 subjective sleep quality
    components["c1_subjective_quality"] = freqs.get("psqi6")

    # C2 sleep latency: minutes band (0-15/16-30/31-60/>60) + item 5a, rescaled
    if latency is not None and "psqi5a" in freqs:
        c2_raw = _band(latency, [15, 30, 60]) + freqs["psqi5a"]
        components["c2_latency"] = _band(c2_raw, [0, 2, 4])
    else:
        components["c2_latency"] = None

    # C3 sleep duration: >7 = 0, 6-7 = 1, 5-6 = 2, <5 = 3
    if sleep_hours is not None:
        components["c3_duration"] = (
            0 if sleep_hours > 7 else 1 if sleep_hours >= 6 else 2 if sleep_hours >= 5 else 3
        )
    else:
        components["c3_duration"] = None

    # C4 habitual sleep efficiency = hours asleep / hours in bed
    if sleep_hours is not None and in_bed and in_bed > 0:
        eff = 100 * sleep_hours / in_bed
        components["c4_efficiency"] = (
            0 if eff >= 85 else 1 if eff >= 75 else 2 if eff >= 65 else 3
        )
    else:
        components["c4_efficiency"] = None

    # C5 sleep disturbances: mean-preserving sum of 5b..5i banded
    dist_keys = [k for k in PSQI_DISTURBANCE_KEYS if k != "psqi5a"]
    dist = [freqs[k] for k in dist_keys if k in freqs]
    if len(dist) >= len(dist_keys) - 2:  # tolerate two omissions
        total = sum(dist)
        if len(dist) < len(dist_keys):
            total = int(round(total * len(dist_keys) / len(dist)))
        components["c5_disturbance"] = _band(total, [0, 9, 18])
    else:
        components["c5_disturbance"] = None

    # C6 use of sleeping medication
    components["c6_medication"] = freqs.get("psqi7")

    # C7 daytime dysfunction: item 8 + item 9 banded
    if "psqi8" in freqs and "psqi9" in freqs:
        components["c7_daytime_dysfunction"] = _band(freqs["psqi8"] + freqs["psqi9"], [0, 2, 4])
    else:
        components["c7_daytime_dysfunction"] = None

    present = {k: v for k, v in components.items() if v is not None}
    score, prorated = _prorate(sum(present.values()), len(present), 7)

    grade = interp = None
    if score is not None:
        if score <= 5:
            grade, interp = "Good sleeper", "Global PSQI <=5 - sleep quality within normal limits."
        elif score <= 10:
            grade, interp = (
                "Poor sleeper",
                "Global PSQI 6-10 - clinically meaningful sleep disruption. Sleep hygiene and bedside sound enrichment indicated.",
            )
        else:
            grade, interp = (
                "Severely disrupted",
                "Global PSQI >10 - severe sleep disruption. Consider CBT-I referral alongside tinnitus management.",
            )

    flags: list[str] = []
    if freqs.get("psqi5i", 0) >= 2:
        flags.append("tinnitus_specific_sleep_onset_problem")
    if freqs.get("psqi7", 0) >= 2:
        flags.append("regular_hypnotic_use")

    return ScoreResult(
        instrument="PSQI",
        score=score,
        max_score=21,
        grade=grade,
        interpretation=interp or "",
        answered=len(present),
        expected=7,
        subscales={"components": components},
        prorated=prorated,
        flags=flags,
    )


# --------------------------------------------------------------------------- #
# PSS-10 - Perceived Stress Scale
# --------------------------------------------------------------------------- #
PSS10_ITEMS = [
    {"id": "pss1", "reverse": False, "text": "In the last month, how often have you been upset because of something that happened unexpectedly?"},
    {"id": "pss2", "reverse": False, "text": "How often have you felt that you were unable to control the important things in your life?"},
    {"id": "pss3", "reverse": False, "text": "How often have you felt nervous and stressed?"},
    {"id": "pss4", "reverse": True, "text": "How often have you felt confident about your ability to handle your personal problems?"},
    {"id": "pss5", "reverse": True, "text": "How often have you felt that things were going your way?"},
    {"id": "pss6", "reverse": False, "text": "How often have you found that you could not cope with all the things you had to do?"},
    {"id": "pss7", "reverse": True, "text": "How often have you been able to control irritations in your life?"},
    {"id": "pss8", "reverse": True, "text": "How often have you felt that you were on top of things?"},
    {"id": "pss9", "reverse": False, "text": "How often have you been angered because of things that were outside of your control?"},
    {"id": "pss10", "reverse": False, "text": "How often have you felt difficulties were piling up so high that you could not overcome them?"},
]

PSS10_OPTIONS = [
    {"label": "Never", "value": 0},
    {"label": "Almost never", "value": 1},
    {"label": "Sometimes", "value": 2},
    {"label": "Fairly often", "value": 3},
    {"label": "Very often", "value": 4},
]


def score_pss10(raw: Mapping[str, Any] | None) -> ScoreResult:
    keys = [i["id"] for i in PSS10_ITEMS]
    items = _coerce_items(raw, keys)
    reverse = {i["id"] for i in PSS10_ITEMS if i["reverse"]}
    subtotal = sum(
        (4 - min(4, max(0, v))) if k in reverse else min(4, max(0, v)) for k, v in items.items()
    )
    score, prorated = _prorate(subtotal, len(items), len(keys))

    grade = interp = None
    if score is not None:
        if score <= 13:
            grade, interp = "Low stress", "PSS-10 0-13 - low perceived stress."
        elif score <= 26:
            grade, interp = (
                "Moderate stress",
                "PSS-10 14-26 - moderate perceived stress; a strong amplifier of tinnitus annoyance. Relaxation and stress-reduction blocks prioritised.",
            )
        else:
            grade, interp = (
                "High stress",
                "PSS-10 27-40 - high perceived stress. Stress is likely the dominant driver of distress; psychological pathway recommended before escalating acoustic dose.",
            )

    return ScoreResult(
        instrument="PSS-10",
        score=score,
        max_score=40,
        grade=grade,
        interpretation=interp or "",
        answered=len(items),
        expected=len(keys),
        prorated=prorated,
    )


# --------------------------------------------------------------------------- #
# GAD-7 / PHQ-2
# --------------------------------------------------------------------------- #
GAD7_ITEMS = [
    {"id": "gad1", "text": "Feeling nervous, anxious or on edge"},
    {"id": "gad2", "text": "Not being able to stop or control worrying"},
    {"id": "gad3", "text": "Worrying too much about different things"},
    {"id": "gad4", "text": "Trouble relaxing"},
    {"id": "gad5", "text": "Being so restless that it is hard to sit still"},
    {"id": "gad6", "text": "Becoming easily annoyed or irritable"},
    {"id": "gad7", "text": "Feeling afraid as if something awful might happen"},
]

PHQ2_ITEMS = [
    {"id": "phq1", "text": "Little interest or pleasure in doing things"},
    # Corrected to match the published PHQ-9 wording exactly (comma before
    # "or") when the full PHQ-9 was implemented alongside this screener —
    # a punctuation-only fix, item id and scoring both unchanged.
    {"id": "phq2", "text": "Feeling down, depressed, or hopeless"},
]

FOUR_POINT_OPTIONS = [
    {"label": "Not at all", "value": 0},
    {"label": "Several days", "value": 1},
    {"label": "More than half the days", "value": 2},
    {"label": "Nearly every day", "value": 3},
]


def score_gad7(raw: Mapping[str, Any] | None) -> ScoreResult:
    keys = [i["id"] for i in GAD7_ITEMS]
    items = _coerce_items(raw, keys)
    subtotal = sum(min(3, max(0, v)) for v in items.values())
    score, prorated = _prorate(subtotal, len(items), len(keys))

    grade = interp = None
    if score is not None:
        if score <= 4:
            grade, interp = "Minimal", "GAD-7 0-4 - minimal anxiety symptoms."
        elif score <= 9:
            grade, interp = "Mild", "GAD-7 5-9 - mild anxiety. Monitor; psychoeducation and relaxation."
        elif score <= 14:
            grade, interp = (
                "Moderate",
                "GAD-7 10-14 - moderate anxiety, above the usual referral threshold. CBT-informed support indicated.",
            )
        else:
            grade, interp = (
                "Severe",
                "GAD-7 >=15 - severe anxiety. Recommend referral to mental-health services in parallel with audiological care.",
            )

    flags = ["anxiety_referral_threshold"] if (score or 0) >= 10 else []
    return ScoreResult(
        instrument="GAD-7",
        score=score,
        max_score=21,
        grade=grade,
        interpretation=interp or "",
        answered=len(items),
        expected=len(keys),
        prorated=prorated,
        flags=flags,
    )


# --------------------------------------------------------------------------- #
# Stepped screening short forms
# --------------------------------------------------------------------------- #
# A first assessment that asks 65 questions gets abandoned, and an abandoned
# assessment has no clinical value at all. Stepped screening is the established
# answer: administer a validated ultra-short screener to everyone, and only
# administer the full instrument to those who screen positive.
#
# This is not a shortcut invented for convenience — it is how these instruments
# are designed to be used:
#
# * **GAD-2** is the first two items of the GAD-7, validated as a standalone
#   screener by Kroenke et al. (2007). A score of >=3 is the referral cut-point at
#   which the full GAD-7 is indicated.
# * **PHQ-2** is already a screener by construction; >=3 indicates administering
#   the PHQ-9.
# * **PSS-4** is Cohen's validated four-item form of the PSS-10 (items 2, 4, 5
#   and 10, with 4 and 5 reverse scored).
# * **Sleep** uses a single tinnitus-specific sleep-interference item, escalating
#   to the full PSQI when positive. The PSQI has no validated short form, so no
#   abbreviated version of it is invented here — it is either administered in full
#   or not at all.
#
# Nothing is ever extrapolated from a short form to a long-form score. If only the
# GAD-2 was administered, `gad7_score` stays null and the GAD-2 score is reported
# in its own right. The predictive models take the short-form scores as their own
# features and handle the absent long forms natively.

GAD2_ITEM_IDS = ["gad1", "gad2"]
GAD2_CUTOFF = 3

PSS4_ITEM_IDS = ["pss2", "pss4", "pss5", "pss10"]
PSS4_REVERSE = {"pss4", "pss5"}
PSS4_CUTOFF = 6

SLEEP_SCREEN_ITEMS = [
    {
        "id": "sleep_screen",
        "text": "In the past month, how often has your tinnitus stopped you falling asleep, or woken you up?",
    }
]
SLEEP_SCREEN_CUTOFF = 2


def score_gad2(raw: Mapping[str, Any] | None) -> ScoreResult:
    """GAD-2 — the first two GAD-7 items, used as the anxiety gate."""
    items = _coerce_items(raw, GAD2_ITEM_IDS)
    score = sum(min(3, max(0, v)) for v in items.values()) if items else None
    positive = score is not None and score >= GAD2_CUTOFF
    return ScoreResult(
        instrument="GAD-2",
        score=score,
        max_score=6,
        grade="Positive screen" if positive else ("Negative screen" if score is not None else None),
        interpretation=(
            f"GAD-2 >={GAD2_CUTOFF} — administer the full GAD-7 to grade severity."
            if positive
            else "GAD-2 below the cut-point; the full GAD-7 is not indicated."
        )
        if score is not None
        else "",
        answered=len(items),
        expected=len(GAD2_ITEM_IDS),
        flags=["escalate_gad7"] if positive else [],
    )


def score_pss4(raw: Mapping[str, Any] | None) -> ScoreResult:
    """PSS-4 — Cohen's four-item Perceived Stress Scale."""
    items = _coerce_items(raw, PSS4_ITEM_IDS)
    subtotal = sum(
        (4 - min(4, max(0, v))) if k in PSS4_REVERSE else min(4, max(0, v)) for k, v in items.items()
    )
    score, prorated = _prorate(subtotal, len(items), len(PSS4_ITEM_IDS))
    positive = score is not None and score >= PSS4_CUTOFF

    grade = interp = None
    if score is not None:
        if score < PSS4_CUTOFF:
            grade, interp = "Low stress", "PSS-4 below the cut-point; the full PSS-10 is not indicated."
        elif score <= 9:
            grade, interp = (
                "Moderate stress",
                f"PSS-4 {score}/16 — administer the full PSS-10. Stress is a strong amplifier of tinnitus annoyance.",
            )
        else:
            grade, interp = (
                "High stress",
                f"PSS-4 {score}/16 — administer the full PSS-10 and prioritise the psychological pathway.",
            )

    return ScoreResult(
        instrument="PSS-4",
        score=score,
        max_score=16,
        grade=grade,
        interpretation=interp or "",
        answered=len(items),
        expected=len(PSS4_ITEM_IDS),
        prorated=prorated,
        flags=["escalate_pss10"] if positive else [],
    )


def score_sleep_screen(raw: Mapping[str, Any] | None) -> ScoreResult:
    """Single tinnitus-specific sleep item — the gate for the full PSQI."""
    items = _coerce_items(raw, ["sleep_screen"])
    score = min(3, max(0, next(iter(items.values())))) if items else None
    positive = score is not None and score >= SLEEP_SCREEN_CUTOFF
    return ScoreResult(
        instrument="Sleep screen",
        score=score,
        max_score=3,
        grade="Positive screen" if positive else ("Negative screen" if score is not None else None),
        interpretation=(
            "Tinnitus is disrupting sleep at least once or twice a week — administer the full PSQI. "
            "Sleep is usually the highest-yield target in tinnitus management."
            if positive
            else "Tinnitus-related sleep disruption below the cut-point; the full PSQI is not indicated."
        )
        if score is not None
        else "",
        answered=len(items),
        expected=1,
        flags=["escalate_psqi"] if positive else [],
    )


# The core battery every patient completes, and what each screener escalates to.
STEPPED_PROTOCOL: dict[str, Any] = {
    "core": ["thi", "vas", "gad2", "phq2", "pss4", "sleep_screen"],
    # 5 + 4 + 2 + 2 + 4 + 1 = 18, down from 38 when the THI was administered in
    # full. The reduction is entirely in the THI; every other core instrument is
    # already a validated short form and shortening those further would cost
    # scores rather than time.
    "core_item_count": len(THI_SHORT_ITEMS) + 4 + 2 + 2 + 4 + 1,
    "escalations": [
        {
            "screener": "gad2",
            "cutoff": GAD2_CUTOFF,
            "escalates_to": "gad7",
            "extra_items": 5,
            "basis": "Kroenke K, et al. Ann Intern Med. 2007;146(5):317-25.",
            "optional": True,
        },
        {
            "screener": "phq2",
            "cutoff": 3,
            "escalates_to": "phq9",
            "extra_items": 7,
            "basis": "Kroenke K, Spitzer RL, Williams JB. J Gen Intern Med. 2001;16(9):606-13. "
            "The PHQ-9 is administered directly, in full, under About Your Tinnitus (Mood / "
            "Depression) - not escalated inline here, the same way GAD-7 and PSS-10 are.",
            "optional": True,
        },
        {
            "screener": "pss4",
            "cutoff": PSS4_CUTOFF,
            "escalates_to": "pss10",
            "extra_items": 6,
            "basis": "Cohen S, Williamson G. 1988 (PSS-4 short form).",
            "optional": True,
        },
        {
            "screener": "sleep_screen",
            "cutoff": SLEEP_SCREEN_CUTOFF,
            "escalates_to": "psqi",
            "extra_items": 17,
            "basis": "PSQI has no validated short form, so it is administered in full or not at all.",
            "optional": True,
        },
    ],
    "note": "Short-form scores are never extrapolated to long-form scales. A patient who screens "
    "negative simply has no long-form score, and the models handle that natively.",
    # A long form only ever adds the items its screener has not already asked, and
    # the patient may defer it. A deferral is recorded on the assessment as a
    # recommendation the clinician can act on, never silently dropped.
    "deferrable": True,
}


def escalation_plan(scores: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Which full instruments this patient's screeners indicate."""
    plan: list[dict[str, Any]] = []
    for rule in STEPPED_PROTOCOL["escalations"]:
        screener = scores.get(rule["screener"]) or {}
        score = screener.get("score")
        if score is None:
            continue
        if score >= rule["cutoff"]:
            plan.append(
                {
                    "instrument": rule["escalates_to"],
                    "because": f"{screener.get('instrument', rule['screener'])} scored "
                    f"{score} (cut-point {rule['cutoff']})",
                    "extra_items": rule["extra_items"],
                    "basis": rule["basis"],
                }
            )
    return plan


def score_phq2(raw: Mapping[str, Any] | None) -> ScoreResult:
    keys = [i["id"] for i in PHQ2_ITEMS]
    items = _coerce_items(raw, keys)
    score = sum(min(3, max(0, v)) for v in items.values()) if items else None
    positive = score is not None and score >= 3
    return ScoreResult(
        instrument="PHQ-2",
        score=score,
        max_score=6,
        grade="Positive screen" if positive else ("Negative screen" if score is not None else None),
        interpretation=(
            "PHQ-2 >=3 - positive depression screen. Administer PHQ-9 and consider mental-health referral."
            if positive
            else "PHQ-2 <3 - depression screen negative."
        )
        if score is not None
        else "",
        answered=len(items),
        expected=len(keys),
        flags=["depression_screen_positive"] if positive else [],
    )


# --------------------------------------------------------------------------- #
# Visual Analogue Scales
# --------------------------------------------------------------------------- #
VAS_SCALES = [
    {
        "id": "vas_loudness",
        "label": "Loudness",
        "prompt": "How loud is your tinnitus right now?",
        "low": "Silent",
        "high": "Extremely loud",
    },
    {
        "id": "vas_annoyance",
        "label": "Annoyance",
        "prompt": "How annoying is your tinnitus?",
        "low": "Not at all",
        "high": "Unbearable",
    },
    {
        "id": "vas_awareness",
        "label": "Awareness",
        "prompt": "What percentage of your waking day are you aware of it?",
        "low": "Never",
        "high": "All the time",
    },
    {
        "id": "vas_sleep_interference",
        "label": "Sleep impact",
        "prompt": "How much does it interfere with your sleep?",
        "low": "Not at all",
        "high": "Completely",
    },
]


def score_vas(raw: Mapping[str, Any] | None) -> dict[str, float | None]:
    raw = raw or {}
    out: dict[str, float | None] = {}
    for s in VAS_SCALES:
        v = raw.get(s["id"])
        try:
            out[s["id"]] = round(min(10.0, max(0.0, float(v))), 1)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            out[s["id"]] = None
    return out


# --------------------------------------------------------------------------- #
# Pain / discomfort VAS - the faces scale
# --------------------------------------------------------------------------- #
# A separate question asked *after* the four tinnitus VAS scales, never one of
# them: the published 0-10 Visual Analogue pain scale, with its face row, its
# verbal scale and its own ADL-impact bands. It is deliberately kept out of
# `score_vas` and out of `VAS_SCALES` - it measures pain, not the percept, so
# folding it into the tinnitus severity block would change what those four
# numbers mean. Structurally this is the same arrangement as the PHQ-9's
# functional-difficulty item: asked on the same screen, stored in its own
# field, scored on its own terms.
#
# The bands are the correlation printed on the scale itself:
#   1-3 mild pain, minimal impact on ADLs
#   4-6 moderate pain, moderate impact on ADLs
#   7-10 severe pain, major impact on ADLs
# 0 is a real answer ("no pain"), not an absent one, and gets its own band
# rather than being folded into "mild".
PAIN_VAS_BANDS: list[dict[str, Any]] = [
    {"key": "none", "min": 0, "max": 0, "label": "No pain",
     "impact": "No pain reported."},
    {"key": "mild", "min": 1, "max": 3, "label": "Mild",
     "impact": "Mild pain; minimal impact on activities of daily living."},
    {"key": "moderate", "min": 4, "max": 6, "label": "Moderate",
     "impact": "Moderate pain; moderate impact on activities of daily living."},
    {"key": "severe", "min": 7, "max": 10, "label": "Severe pain",
     "impact": "Severe pain; major impact on activities of daily living."},
]

PAIN_VAS: dict[str, Any] = {
    "id": "vas_pain",
    "text": "How much pain or physical discomfort are you in right now?",
    "help": "Choose the face and the number that match how you feel.",
    "low": "No Pain",
    "mid": "Moderate Pain",
    "high": "Worst Pain",
    "min": 0,
    "max": 10,
    "step": 1,
    #: The positions the printed scale draws a face at.
    "face_values": [0, 2, 4, 6, 8, 10],
    "bands": PAIN_VAS_BANDS,
}


def pain_vas_band(value: float) -> dict[str, Any]:
    """The printed scale's band for a 0-10 pain rating."""
    for band in PAIN_VAS_BANDS:
        if band["min"] <= value <= band["max"]:
            return band
    return PAIN_VAS_BANDS[-1]


def score_pain_vas(raw: Any) -> dict[str, Any]:
    """Read back the pain VAS: the rating, its verbal band and its ADL impact.

    Unanswered stays null all the way through - a patient who was never asked
    and a patient who answered 0 must never look the same.
    """
    try:
        value = round(min(10.0, max(0.0, float(raw))), 1)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {"score": None, "band": None, "grade": None, "interpretation": ""}
    band = pain_vas_band(value)
    return {
        "score": value,
        "band": band["key"],
        "grade": band["label"],
        "interpretation": band["impact"],
    }


# --------------------------------------------------------------------------- #
# TFI - Tinnitus Functional Index
# --------------------------------------------------------------------------- #
# Meikle MB, Henry JA, Griest SE, et al. The Tinnitus Functional Index:
# development of a new clinical measure for chronic, intrusive tinnitus. Ear
# Hear. 2012;33(2):153-76. Item text, response scales, item numbering, subscale
# membership and the scoring/validity rules below are taken verbatim from the
# published TFI instrument and scoring instructions (Oregon Health & Science
# University, 2008) - nothing here is paraphrased, reordered or invented.
#
# Two response kinds, per the published form:
#   * "percent" - items 1 and 3 only, an 11-point 0%/10%/.../100% scale.
#   * "scale10" - item 2 and items 4-25, an 11-point 0-10 scale.
# Both kinds are scored on the same 0-10 basis: a "percent" answer is divided
# by 10 for scoring only (see `_tfi_item_score`) - the stored raw answer is
# never overwritten with the transformed value.
TFI_ITEMS: list[dict[str, Any]] = [
    {"id": "tfi1", "n": 1, "sub": "intrusive", "kind": "percent",
     "context": "Over the PAST WEEK...",
     "text": "What percentage of your time awake were you consciously AWARE OF your tinnitus?",
     "low": "Never aware", "high": "Always aware"},
    {"id": "tfi2", "n": 2, "sub": "intrusive", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How STRONG or LOUD was your tinnitus?",
     "low": "Not at all strong or loud", "high": "Extremely strong or loud"},
    {"id": "tfi3", "n": 3, "sub": "intrusive", "kind": "percent",
     "context": "Over the PAST WEEK...",
     "text": "What percentage of your time awake were you ANNOYED by your tinnitus?",
     "low": "None of the time", "high": "All of the time"},
    {"id": "tfi4", "n": 4, "sub": "sense_of_control", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "Did you feel IN CONTROL in regard to your tinnitus?",
     "low": "Very much in control", "high": "Never in control"},
    {"id": "tfi5", "n": 5, "sub": "sense_of_control", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How easy was it for you to COPE with your tinnitus?",
     "low": "Very easy to cope", "high": "Impossible to cope"},
    {"id": "tfi6", "n": 6, "sub": "sense_of_control", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How easy was it for you to IGNORE your tinnitus?",
     "low": "Very easy to ignore", "high": "Impossible to ignore"},
    {"id": "tfi7", "n": 7, "sub": "cognitive", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "Your ability to CONCENTRATE?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi8", "n": 8, "sub": "cognitive", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "Your ability to THINK CLEARLY?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi9", "n": 9, "sub": "cognitive", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "Your ability to FOCUS ATTENTION on other things besides your tinnitus?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi10", "n": 10, "sub": "sleep", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How often did your tinnitus make it difficult to FALL ASLEEP or STAY ASLEEP?",
     "low": "Never had difficulty", "high": "Always had difficulty"},
    {"id": "tfi11", "n": 11, "sub": "sleep", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How often did your tinnitus cause you difficulty in getting AS MUCH SLEEP as you needed?",
     "low": "Never had difficulty", "high": "Always had difficulty"},
    {"id": "tfi12", "n": 12, "sub": "sleep", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How much of the time did your tinnitus keep you from SLEEPING as DEEPLY or as PEACEFULLY as you would have liked?",
     "low": "None of the time", "high": "All of the time"},
    {"id": "tfi13", "n": 13, "sub": "auditory", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your ability to HEAR CLEARLY?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi14", "n": 14, "sub": "auditory", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your ability to UNDERSTAND PEOPLE who are talking?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi15", "n": 15, "sub": "auditory", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your ability to FOLLOW CONVERSATIONS in a group or at meetings?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi16", "n": 16, "sub": "relaxation", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your QUIET RESTING ACTIVITIES?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi17", "n": 17, "sub": "relaxation", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your ability to RELAX?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi18", "n": 18, "sub": "relaxation", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": 'Your ability to enjoy "PEACE AND QUIET"?',
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi19", "n": 19, "sub": "quality_of_life", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your enjoyment of SOCIAL ACTIVITIES?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi20", "n": 20, "sub": "quality_of_life", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your ENJOYMENT OF LIFE?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi21", "n": 21, "sub": "quality_of_life", "kind": "scale10",
     "context": "Over the PAST WEEK, how much has your tinnitus interfered with...",
     "text": "Your RELATIONSHIPS with family, friends and other people?",
     "low": "Did not interfere", "high": "Completely interfered"},
    {"id": "tfi22", "n": 22, "sub": "quality_of_life", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How often did your tinnitus cause you to have difficulty performing your WORK OR OTHER "
     "TASKS, such as home maintenance, school work, or caring for children or others?",
     "low": "Never had difficulty", "high": "Always had difficulty"},
    {"id": "tfi23", "n": 23, "sub": "emotional", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How ANXIOUS or WORRIED has your tinnitus made you feel?",
     "low": "Not at all anxious or worried", "high": "Extremely anxious or worried"},
    {"id": "tfi24", "n": 24, "sub": "emotional", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How BOTHERED or UPSET have you been because of your tinnitus?",
     "low": "Not at all bothered or upset", "high": "Extremely bothered or upset"},
    {"id": "tfi25", "n": 25, "sub": "emotional", "kind": "scale10",
     "context": "Over the PAST WEEK...",
     "text": "How DEPRESSED were you because of your tinnitus?",
     "low": "Not at all depressed", "high": "Extremely depressed"},
]

TFI_ITEM_IDS = [i["id"] for i in TFI_ITEMS]
# Items 1 and 3 are the only percentage-scale items; every other item is
# already on the 0-10 scale the overall/subscale formulas use directly.
TFI_PERCENT_IDS = {i["id"] for i in TFI_ITEMS if i["kind"] == "percent"}

TFI_PERCENT_OPTIONS = [{"label": f"{v}%", "value": v} for v in range(0, 101, 10)]
TFI_SCALE_OPTIONS = [{"label": str(v), "value": v} for v in range(0, 11)]

# The eight published subscales, in the order the scoring instructions list
# them. Every subscale tolerates at most one omitted item - the Quality of
# Life subscale included, despite having four items instead of three.
TFI_SUBSCALES: dict[str, list[str]] = {
    "intrusive": ["tfi1", "tfi2", "tfi3"],
    "sense_of_control": ["tfi4", "tfi5", "tfi6"],
    "cognitive": ["tfi7", "tfi8", "tfi9"],
    "sleep": ["tfi10", "tfi11", "tfi12"],
    "auditory": ["tfi13", "tfi14", "tfi15"],
    "relaxation": ["tfi16", "tfi17", "tfi18"],
    "quality_of_life": ["tfi19", "tfi20", "tfi21", "tfi22"],
    "emotional": ["tfi23", "tfi24", "tfi25"],
}
TFI_SUBSCALE_MAX_OMITTED = 1

# "CAUTION - Overall TFI score is not valid if respondent omits 7 or more
# items. To be valid... the respondent must answer at least 19 items."
TFI_MIN_VALID_OVERALL = 19
TFI_INSUFFICIENT_MESSAGE = (
    "Overall TFI score cannot be calculated because fewer than 19 items have valid responses."
)


def _tfi_item_score(item_id: str, raw_value: float) -> float:
    """The 0-10 scoring representation of one answer.

    Items 1 and 3 are collected as a percentage and divided by 10 for scoring,
    exactly as the published instructions specify - the caller keeps the raw
    percentage separately and this function never mutates it.
    """
    return raw_value / 10.0 if item_id in TFI_PERCENT_IDS else raw_value


def _tfi_valid_items(raw: Mapping[str, Any] | None) -> dict[str, float]:
    """Raw answers, validated and converted to their 0-10 scoring value.

    An out-of-range, off-grid, or unparseable answer is dropped rather than
    clamped or coerced - a bad value must count as "not answered", never as a
    guessed-at answer that would change how many items are valid.

    Every item is collected on screen by the same 11-position slider (0%,
    10%, ..., 100%) - see `AboutYourTinnitus.tsx::TfiSlider` - so a value off
    that grid cannot have come from an honest interaction and must not be
    trusted from the client alone:
      * "percent" items (1, 3) store the percentage itself, so a legitimate
        value is a multiple of 10 in [0, 100].
      * every other item stores the slider's 0-10 scoring value directly, so
        a legitimate value is a whole number in [0, 10] - the exact result
        of dividing a 0/10/.../100 slider position by 10.
    """
    raw = raw or {}
    valid: dict[str, float] = {}
    for item_id in TFI_ITEM_IDS:
        v = raw.get(item_id)
        if v is None or v == "":
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if item_id in TFI_PERCENT_IDS:
            if not (0 <= v <= 100) or v % 10 != 0:
                continue
        else:
            if not (0 <= v <= 10) or v != int(v):
                continue
        valid[item_id] = _tfi_item_score(item_id, v)
    return valid


def score_tfi(raw: Mapping[str, Any] | None) -> ScoreResult:
    """Tinnitus Functional Index - overall score and eight subscales.

    The overall score is computed directly from the valid individual items,
    never by averaging the eight subscale scores - the published instructions
    explicitly warn against that shortcut, since a subscale's valid item count
    can differ from the overall valid count. See `TFI_MIN_VALID_OVERALL` for
    the omission rule and `TFI_SUBSCALE_MAX_OMITTED` for each subscale's.
    """
    valid = _tfi_valid_items(raw)
    answered = len(valid)
    is_valid = answered >= TFI_MIN_VALID_OVERALL

    score = round(sum(valid.values()) / answered * 10) if is_valid else None

    subscales: dict[str, Any] = {}
    for name, ids in TFI_SUBSCALES.items():
        got = {k: valid[k] for k in ids if k in valid}
        sub_valid = len(got) >= len(ids) - TFI_SUBSCALE_MAX_OMITTED
        subscales[name] = {
            "score": round(sum(got.values()) / len(got) * 10) if sub_valid and got else None,
            "answered": len(got),
            "expected": len(ids),
            "valid": sub_valid,
        }

    interpretation = ""
    if not is_valid and answered > 0:
        interpretation = TFI_INSUFFICIENT_MESSAGE

    return ScoreResult(
        instrument="TFI",
        score=score,
        max_score=100,
        # No severity bands are published alongside the TFI scoring
        # instructions supplied for this implementation, so none are invented
        # here - the numeric score is reported on its own.
        grade=None,
        interpretation=interpretation,
        answered=answered,
        expected=len(TFI_ITEM_IDS),
        subscales={**subscales, "min_valid_overall": TFI_MIN_VALID_OVERALL, "valid": is_valid},
        prorated=False,
        flags=[],
    )


# --------------------------------------------------------------------------- #
# ISI - Insomnia Severity Index
# --------------------------------------------------------------------------- #
# Bastien CH, Vallieres A, Morin CM. Validation of the Insomnia Severity Index
# as an outcome measure for insomnia research. Sleep Med. 2001;2(4):297-307.
# Item text, response labels, item structure and the scoring/interpretation
# ranges below are taken verbatim from the published ISI patient form -
# nothing here is paraphrased, reordered or invented.
#
# The published form shows five *numbered* questions, but the first is a
# grouped item with three independently-scored rows (difficulty falling
# asleep / staying asleep / waking too early) - seven scored components in
# total, each 0-4, summed to a 0-28 total. `ISI_QUESTION_PAGES` is what lets
# the frontend show "Question 1 of 5" while still collecting three answers
# on that one page - see `AboutYourTinnitus.tsx::groupItemsIntoPages`, which
# groups consecutive items by their shared `group` key.
ISI_SEVERITY_OPTIONS = [
    {"label": "None", "value": 0},
    {"label": "Mild", "value": 1},
    {"label": "Moderate", "value": 2},
    {"label": "Severe", "value": 3},
    {"label": "Very severe", "value": 4},
]
# Item 2 is bipolar with only its two endpoints labelled in the published
# form - values 1-3 are deliberately blank, not invented middle labels.
ISI_Q2_OPTIONS = [
    {"label": "Very Satisfied", "value": 0},
    {"label": "", "value": 1},
    {"label": "", "value": 2},
    {"label": "", "value": 3},
    {"label": "Very Dissatisfied", "value": 4},
]
ISI_Q3_OPTIONS = [
    {"label": "Not at all Interfering", "value": 0},
    {"label": "A Little", "value": 1},
    {"label": "Somewhat", "value": 2},
    {"label": "Much", "value": 3},
    {"label": "Very Much Interfering", "value": 4},
]
ISI_Q4_OPTIONS = [
    {"label": "Not at all Noticeable", "value": 0},
    {"label": "Barely", "value": 1},
    {"label": "Somewhat", "value": 2},
    {"label": "Much", "value": 3},
    {"label": "Very Much Noticeable", "value": 4},
]
ISI_Q5_OPTIONS = [
    {"label": "Not at all", "value": 0},
    {"label": "A Little", "value": 1},
    {"label": "Somewhat", "value": 2},
    {"label": "Much", "value": 3},
    {"label": "Very Much", "value": 4},
]

ISI_ITEMS: list[dict[str, Any]] = [
    {"id": "isi1a", "n": "1a", "group": "q1", "kind": "severity",
     "context": "Please rate the current (i.e., last 2 weeks) SEVERITY of your insomnia problem(s).",
     "text": "Difficulty falling asleep"},
    {"id": "isi1b", "n": "1b", "group": "q1", "kind": "severity",
     "context": "Please rate the current (i.e., last 2 weeks) SEVERITY of your insomnia problem(s).",
     "text": "Difficulty staying asleep"},
    {"id": "isi1c", "n": "1c", "group": "q1", "kind": "severity",
     "context": "Please rate the current (i.e., last 2 weeks) SEVERITY of your insomnia problem(s).",
     "text": "Problem waking up too early"},
    {"id": "isi2", "n": 2, "group": "q2", "kind": "q2",
     "text": "How SATISFIED/dissatisfied are you with your current sleep pattern?"},
    {"id": "isi3", "n": 3, "group": "q3", "kind": "q3",
     "text": "To what extent do you consider your sleep problem to INTERFERE with your daily "
     "functioning (e.g. daytime fatigue, ability to function at work/daily chores, "
     "concentration, memory, mood, etc.)?"},
    {"id": "isi4", "n": 4, "group": "q4", "kind": "q4",
     "text": "How NOTICEABLE to others do you think your sleeping problem is in terms of "
     "impairing the quality of your life?"},
    {"id": "isi5", "n": 5, "group": "q5", "kind": "q5",
     "text": "How WORRIED/distressed are you about your current sleep problem?"},
]
ISI_ITEM_IDS = [i["id"] for i in ISI_ITEMS]

# Which of the 7 scored components make up each of the 5 *displayed*
# questions - the single source both the scorer's breakdown and the frontend
# page-grouping key off.
ISI_QUESTION_GROUPS: dict[int, list[str]] = {
    1: ["isi1a", "isi1b", "isi1c"],
    2: ["isi2"],
    3: ["isi3"],
    4: ["isi4"],
    5: ["isi5"],
}

# (lower, upper, label) - the published interpretation bands. Nothing here is
# an invented cut-point; the developers' own guidance is quoted verbatim.
ISI_BANDS: list[tuple[int, int, str]] = [
    (0, 7, "No clinically significant insomnia"),
    (8, 14, "Subthreshold insomnia"),
    (15, 21, "Clinical insomnia (moderate severity)"),
    (22, 28, "Clinical insomnia (severe)"),
]


def _isi_band(score: int | None) -> str | None:
    if score is None:
        return None
    for lo, hi, label in ISI_BANDS:
        if lo <= score <= hi:
            return label
    return None


def score_isi(raw: Mapping[str, Any] | None) -> ScoreResult:
    """Insomnia Severity Index - all seven components, 0-28 total.

    The published scoring instructions are "add scores for all seven items"
    with no partial-completion allowance documented anywhere in the source,
    so - unlike GAD-7/PSS-10, which prorate a mostly-complete long form -
    this requires all seven valid before reporting a score at all. An
    out-of-range, non-integer, or missing answer is dropped rather than
    coerced, so a bad value counts as "not answered" and the total stays
    unscored rather than quietly wrong.
    """
    raw = raw or {}
    valid: dict[str, int] = {}
    for item_id in ISI_ITEM_IDS:
        v = raw.get(item_id)
        if v is None or v == "":
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if 0 <= v <= 4 and v == int(v):
            valid[item_id] = int(v)

    answered = len(valid)
    is_valid = answered == len(ISI_ITEM_IDS)
    score = sum(valid.values()) if is_valid else None
    grade = _isi_band(score)

    # An optional, additive breakdown by displayed question - never used to
    # derive the total, which always comes from the raw components above.
    breakdown: dict[str, Any] = {}
    for q, ids in ISI_QUESTION_GROUPS.items():
        got = {k: valid[k] for k in ids if k in valid}
        breakdown[f"q{q}"] = {
            "score": sum(got.values()) if len(got) == len(ids) else None,
            "max": len(ids) * 4,
            "answered": len(got),
            "expected": len(ids),
        }

    return ScoreResult(
        instrument="ISI",
        score=score,
        max_score=28,
        grade=grade,
        interpretation=grade or "",
        answered=answered,
        expected=len(ISI_ITEM_IDS),
        subscales={"breakdown": breakdown},
        prorated=False,
        flags=[],
    )


# --------------------------------------------------------------------------- #
# PHQ-9 - Patient Health Questionnaire
# --------------------------------------------------------------------------- #
# Kroenke K, Spitzer RL, Williams JB. J Gen Intern Med. 2001;16(9):606-13. Item
# text, response labels, the "last 2 weeks" timeframe and the functional-
# difficulty item are taken verbatim from the published patient form.
#
# PHQ-2 (`PHQ2_ITEMS` above, administered as the stepped-protocol screener) is
# literally the first two items of this form and shares their exact item ids
# (`phq1`, `phq2`) - a patient who already answered the screener does not
# answer those two again; see the `phq2_items` -> `phq9_items` merge in
# `api/views.py::apply_submission`, the same pattern already used for
# GAD-2 -> GAD-7 and PSS-4 -> PSS-10.
PHQ9_ITEM_IDS = ["phq1", "phq2", "phq3", "phq4", "phq5", "phq6", "phq7", "phq8", "phq9"]
# `kind: "phq9"` carries no per-item option_sets entry (all nine share the
# same four `PHQ9_OPTIONS`) - it exists purely so the frontend's guided form
# can pick the compact numbered-scale control over the large `.option`
# button stack THI/GAD-7/PSS-10 use, without touching those instruments.
PHQ9_ITEMS: list[dict[str, Any]] = [
    {"id": "phq1", "n": 1, "kind": "phq9", "text": "Little interest or pleasure in doing things"},
    {"id": "phq2", "n": 2, "kind": "phq9", "text": "Feeling down, depressed, or hopeless"},
    {"id": "phq3", "n": 3, "kind": "phq9", "text": "Trouble falling or staying asleep, or sleeping too much"},
    {"id": "phq4", "n": 4, "kind": "phq9", "text": "Feeling tired or having little energy"},
    {"id": "phq5", "n": 5, "kind": "phq9", "text": "Poor appetite or overeating"},
    {"id": "phq6", "n": 6, "kind": "phq9", "text": "Feeling bad about yourself — or that you are a failure or "
     "have let yourself or your family down"},
    {"id": "phq7", "n": 7, "kind": "phq9", "text": "Trouble concentrating on things, such as reading the "
     "newspaper or watching television"},
    {"id": "phq8", "n": 8, "kind": "phq9", "text": "Moving or speaking so slowly that other people could have "
     "noticed? Or the opposite – being so fidgety or restless that you have been moving around a lot more "
     "than usual"},
    {"id": "phq9", "n": 9, "kind": "phq9", "text": "Thoughts that you would be better off dead or of hurting "
     "yourself in some way"},
]
PHQ9_TIMEFRAME = "Over the last 2 weeks, how often have you been bothered by the following problems?"
PHQ9_OPTIONS = [
    {"label": "Not at all", "value": 0},
    {"label": "Several days", "value": 1},
    {"label": "More than half the days", "value": 2},
    {"label": "Nearly every day", "value": 3},
]

# A separate, non-scored item shown after the 9 symptom questions - never the
# form's "10th question" and never added to the 0-27 total (see `score_phq9`).
PHQ9_FUNCTIONAL_DIFFICULTY_TEXT = (
    "If you checked off any problems, how difficult have these problems made it for you to do "
    "your work, take care of things at home, or get along with other people?"
)
PHQ9_FUNCTIONAL_DIFFICULTY_OPTIONS = [
    {"label": "Not difficult at all", "value": 1},
    {"label": "Somewhat difficult", "value": 2},
    {"label": "Very difficult", "value": 3},
    {"label": "Extremely difficult", "value": 4},
]


def score_phq9(raw: Mapping[str, Any] | None) -> ScoreResult:
    """PHQ-9 - nine symptom items, summed directly to a 0-27 total.

    No partial-completion allowance is documented for the PHQ-9 in the
    supplied reference, so - matching the ISI - all nine are required before
    a total is reported; a missing or out-of-range item is dropped rather
    than coerced, never scored as zero.

    Item 9 (thoughts of self-harm) is inspected independently of that
    all-or-nothing gate: whether the patient endorsed it is a safety-relevant
    fact regardless of whether the rest of the form is complete, and is
    surfaced as a flag the same way THI's despair-item cluster already is
    (see `score_thi`) so `clinical/redflags.py` can act on it without this
    module knowing anything about triage.
    """
    raw = raw or {}
    valid: dict[str, int] = {}
    for item_id in PHQ9_ITEM_IDS:
        v = raw.get(item_id)
        if v is None or v == "":
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if 0 <= v <= 3 and v == int(v):
            valid[item_id] = int(v)

    answered = len(valid)
    is_valid = answered == len(PHQ9_ITEM_IDS)
    score = sum(valid.values()) if is_valid else None

    flags: list[str] = []
    item9 = valid.get("phq9")
    if item9 is not None and item9 >= 1:
        flags.append("item9_positive")

    return ScoreResult(
        instrument="PHQ-9",
        score=score,
        max_score=27,
        # No validated severity bands exist anywhere in this codebase for the
        # full PHQ-9 (only the PHQ-2 screener's own >=3 referral cut-point, a
        # different, shorter instrument) - none is invented here; the numeric
        # score is reported on its own, per the implementation brief.
        grade=None,
        interpretation="",
        answered=answered,
        expected=len(PHQ9_ITEM_IDS),
        subscales={},
        prorated=False,
        flags=flags,
    )


# --------------------------------------------------------------------------- #
# WHOQOL-BREF - World Health Organization Quality of Life, abbreviated form
# --------------------------------------------------------------------------- #
# The WHOQOL Group. Development of the World Health Organization WHOQOL-BREF
# quality of life assessment. Psychol Med. 1998;28(3):551-8. Item text, item
# numbering, the published item codes (G1, G4, F1.4, ...), response-scale
# wording, response order and the 1-5 numeric values below are reproduced
# verbatim from the published WHOQOL-BREF patient form (Appendix 8) supplied
# as the source for this implementation - nothing here is paraphrased,
# reordered or invented.
#
# Six response scales are used across the 26 items, not one generic scale:
#   * "poor_good"          - Q1, Q15 (Very poor .. Very good)
#   * "satisfaction"       - Q2, Q16-Q25 (Very dissatisfied .. Very satisfied)
#   * "amount"              - Q3-Q6 (Not at all .. An extreme amount)
#   * "amount_extremely"   - Q7-Q9 (Not at all .. Extremely - the published
#                             form's own inconsistency: the same "how much"
#                             framing sentence covers Q3-Q9, but the top label
#                             of the scale changes from "An extreme amount" to
#                             "Extremely" for Q7-Q9; both are reproduced
#                             exactly as printed, not harmonised)
#   * "capacity"            - Q10-Q14 (Not at all .. Completely)
#   * "frequency"           - Q26 (Never .. Always)
# Every scale is 1-5, ascending in the order printed. `option_sets` maps each
# item's `kind` to its scale, the same mechanism PSQI/ISI/TFI already use for
# an instrument with more than one response type.
#
# `code` carries the published item code (G1, F1.4, ...) so the digital
# implementation stays traceable against the source form; `n` is the
# question's printed position (1-26). Neither is a scored field - `id` (used
# for storage, translation lookup and scoring) follows this codebase's own
# `<instrument><n>` convention, matching thi1/gad1/isi1a/phq1 rather than the
# source's own "Q1"/"G1" labelling.
#
# **Scoring is deliberately not implemented.** The supplied source is the
# patient form only; it does not include the published WHOQOL-BREF scoring
# manual's raw-to-transformed domain-score conversion tables (four domains:
# physical health, psychological, social relationships, environment), and no
# WHOQOL-BREF scoring of any kind previously existed anywhere in this
# codebase (this module replaces what had been an empty "eq5d5l"/"whoqol_bref"
# stub with no item bank at all). Inventing a transformation here would
# fabricate a clinical-looking domain score nobody validated, so
# `score_whoqol_bref()` reports only what was actually collected - which of
# the 26 items have a valid response, and whether all 26 are present - and
# `score`/`grade` stay `None` permanently until a validated scoring reference
# is supplied and wired in.
WHOQOL_REFERENCE_PERIOD = "the last two weeks"

WHOQOL_INSTRUCTIONS = (
    "This assessment asks how you feel about your quality of life, health, and other areas of "
    "your life. Please answer all the questions. If you are unsure about which response to give "
    "to a question, choose the one that appears most appropriate — this can often be your first "
    "response. Please keep in mind your own standards, hopes, pleasures and concerns, and think "
    "about your life over the last two weeks."
)

WHOQOL_POOR_GOOD_OPTIONS = [
    {"label": "Very poor", "value": 1},
    {"label": "Poor", "value": 2},
    {"label": "Neither poor nor good", "value": 3},
    {"label": "Good", "value": 4},
    {"label": "Very good", "value": 5},
]
WHOQOL_SATISFACTION_OPTIONS = [
    {"label": "Very dissatisfied", "value": 1},
    {"label": "Dissatisfied", "value": 2},
    {"label": "Neither satisfied nor dissatisfied", "value": 3},
    {"label": "Satisfied", "value": 4},
    {"label": "Very satisfied", "value": 5},
]
WHOQOL_AMOUNT_OPTIONS = [
    {"label": "Not at all", "value": 1},
    {"label": "A little", "value": 2},
    {"label": "A moderate amount", "value": 3},
    {"label": "Very much", "value": 4},
    {"label": "An extreme amount", "value": 5},
]
WHOQOL_AMOUNT_EXTREMELY_OPTIONS = [
    {"label": "Not at all", "value": 1},
    {"label": "A little", "value": 2},
    {"label": "A moderate amount", "value": 3},
    {"label": "Very much", "value": 4},
    {"label": "Extremely", "value": 5},
]
WHOQOL_CAPACITY_OPTIONS = [
    {"label": "Not at all", "value": 1},
    {"label": "A little", "value": 2},
    {"label": "Moderately", "value": 3},
    {"label": "Mostly", "value": 4},
    {"label": "Completely", "value": 5},
]
WHOQOL_FREQUENCY_OPTIONS = [
    {"label": "Never", "value": 1},
    {"label": "Seldom", "value": 2},
    {"label": "Quite often", "value": 3},
    {"label": "Very often", "value": 4},
    {"label": "Always", "value": 5},
]

_WHOQOL_AMOUNT_CONTEXT = "The following questions ask about how much you have experienced certain things in the last two weeks."
_WHOQOL_CAPACITY_CONTEXT = "The following questions ask about how completely you experience or were able to do certain things in the last two weeks."
_WHOQOL_SATISFACTION_CONTEXT = "The following questions ask you to say how good or satisfied you have felt about various aspects of your life over the last two weeks."
_WHOQOL_FREQUENCY_CONTEXT = "The following question refers to how often you have felt or experienced certain things in the last two weeks."

WHOQOL_BREF_ITEMS: list[dict[str, Any]] = [
    {"id": "whoqol1", "n": 1, "code": "G1", "kind": "poor_good",
     "text": "How would you rate your quality of life?"},
    {"id": "whoqol2", "n": 2, "code": "G4", "kind": "satisfaction",
     "text": "How satisfied are you with your health?"},
    {"id": "whoqol3", "n": 3, "code": "F1.4", "kind": "amount", "context": _WHOQOL_AMOUNT_CONTEXT,
     "text": "To what extent do you feel that (physical) pain prevents you from doing what you need to do?"},
    {"id": "whoqol4", "n": 4, "code": "F11.3", "kind": "amount", "context": _WHOQOL_AMOUNT_CONTEXT,
     "text": "How much do you need any medical treatment to function in your daily life?"},
    {"id": "whoqol5", "n": 5, "code": "F4.1", "kind": "amount", "context": _WHOQOL_AMOUNT_CONTEXT,
     "text": "How much do you enjoy life?"},
    {"id": "whoqol6", "n": 6, "code": "F24.2", "kind": "amount", "context": _WHOQOL_AMOUNT_CONTEXT,
     "text": "To what extent do you feel your life to be meaningful?"},
    {"id": "whoqol7", "n": 7, "code": "F5.3", "kind": "amount_extremely", "context": _WHOQOL_AMOUNT_CONTEXT,
     "text": "How well are you able to concentrate?"},
    {"id": "whoqol8", "n": 8, "code": "F16.1", "kind": "amount_extremely", "context": _WHOQOL_AMOUNT_CONTEXT,
     "text": "How safe do you feel in your daily life?"},
    {"id": "whoqol9", "n": 9, "code": "F22.1", "kind": "amount_extremely", "context": _WHOQOL_AMOUNT_CONTEXT,
     "text": "How healthy is your physical environment?"},
    {"id": "whoqol10", "n": 10, "code": "F2.1", "kind": "capacity", "context": _WHOQOL_CAPACITY_CONTEXT,
     "text": "Do you have enough energy for everyday life?"},
    {"id": "whoqol11", "n": 11, "code": "F7.1", "kind": "capacity", "context": _WHOQOL_CAPACITY_CONTEXT,
     "text": "Are you able to accept your bodily appearance?"},
    {"id": "whoqol12", "n": 12, "code": "F18.1", "kind": "capacity", "context": _WHOQOL_CAPACITY_CONTEXT,
     "text": "Have you enough money to meet your needs?"},
    {"id": "whoqol13", "n": 13, "code": "F20.1", "kind": "capacity", "context": _WHOQOL_CAPACITY_CONTEXT,
     "text": "How available to you is the information that you need in your day-to-day life?"},
    {"id": "whoqol14", "n": 14, "code": "F21.1", "kind": "capacity", "context": _WHOQOL_CAPACITY_CONTEXT,
     "text": "To what extent do you have the opportunity for leisure activities?"},
    {"id": "whoqol15", "n": 15, "code": "F9.1", "kind": "poor_good",
     "text": "How well are you able to get around?"},
    {"id": "whoqol16", "n": 16, "code": "F3.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with your sleep?"},
    {"id": "whoqol17", "n": 17, "code": "F10.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with your ability to perform your daily living activities?"},
    {"id": "whoqol18", "n": 18, "code": "F12.4", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with your capacity for work?"},
    {"id": "whoqol19", "n": 19, "code": "F6.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with yourself?"},
    {"id": "whoqol20", "n": 20, "code": "F13.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with your personal relationships?"},
    {"id": "whoqol21", "n": 21, "code": "F15.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with your sex life?"},
    {"id": "whoqol22", "n": 22, "code": "F14.4", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with the support you get from your friends?"},
    {"id": "whoqol23", "n": 23, "code": "F17.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with the conditions of your living place?"},
    {"id": "whoqol24", "n": 24, "code": "F19.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with your access to health services?"},
    {"id": "whoqol25", "n": 25, "code": "F23.3", "kind": "satisfaction", "context": _WHOQOL_SATISFACTION_CONTEXT,
     "text": "How satisfied are you with your transport?"},
    {"id": "whoqol26", "n": 26, "code": "F8.1", "kind": "frequency", "context": _WHOQOL_FREQUENCY_CONTEXT,
     "text": "How often do you have negative feelings such as blue mood, despair, anxiety, depression?"},
]

WHOQOL_BREF_ITEM_IDS = [i["id"] for i in WHOQOL_BREF_ITEMS]
WHOQOL_BREF_ITEM_CODES = {i["id"]: i["code"] for i in WHOQOL_BREF_ITEMS}
#: 26 items, each answered 1-5 - the raw ceiling, not a domain score (see above).
WHOQOL_BREF_RAW_MAX = len(WHOQOL_BREF_ITEMS) * 5


def score_whoqol_bref(raw: Mapping[str, Any] | None) -> ScoreResult:
    """WHOQOL-BREF — item-level completion only, no domain/overall score.

    All 26 items are required before this reports "complete" - like the ISI
    and PHQ-9 above, no partial-completion allowance is documented for this
    instrument in the source supplied for this feature, so this does not
    prorate. An out-of-range, non-integer, or missing answer is dropped
    rather than coerced, so a bad value counts as "not answered" rather than
    a guessed-at response.

    `score` and `grade` are always `None`: see the module comment above for
    why a domain-scoring formula is deliberately not invented here.
    """
    raw = raw or {}
    valid: dict[str, int] = {}
    for item_id in WHOQOL_BREF_ITEM_IDS:
        v = raw.get(item_id)
        if v is None or v == "":
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if 1 <= v <= 5 and v == int(v):
            valid[item_id] = int(v)

    return ScoreResult(
        instrument="WHOQOL-BREF",
        score=None,
        max_score=WHOQOL_BREF_RAW_MAX,
        grade=None,
        interpretation=(
            "WHOQOL-BREF domain scoring is not implemented in this system: the published "
            "scoring manual's raw-to-transformed domain conversion tables were not part of "
            "the source supplied for this feature, and no WHOQOL-BREF scoring previously "
            "existed in this codebase. Responses are recorded in full and available for a "
            "future scoring pass; no score is fabricated in the meantime."
        ),
        answered=len(valid),
        expected=len(WHOQOL_BREF_ITEM_IDS),
        subscales={"scoring_implemented": False, "item_codes": WHOQOL_BREF_ITEM_CODES},
        prorated=False,
        flags=[],
    )


# --------------------------------------------------------------------------- #
# Registry consumed by the frontend so item banks live in exactly one place
# --------------------------------------------------------------------------- #
INSTRUMENT_REGISTRY: dict[str, dict[str, Any]] = {
    "thi": {
        # Administers the five-item short form. `THI_ITEMS` (the full 25) is not
        # exposed here: the registry is what the client renders, and shipping the
        # long bank would put 25 questions back on screen.
        "name": "Tinnitus handicap, short form",
        "abbrev": "THI-5",
        "citation": "Items drawn from Newman CW, Jacobson GP, Spitzer JB. Arch Otolaryngol "
        "Head Neck Surg. 1996;122(2):143-8. Administered as a 5-item short form; the "
        "25-item psychometrics do not transfer.",
        "items": THI_SHORT_ITEMS,
        "options": THI_OPTIONS,
        "max_score": 100,
        "raw_max": THI_SHORT_MAX,
        "bands": [{"lo": lo, "hi": hi, "grade": g, "label": l} for lo, hi, g, l in THI_BANDS],
        "mcid": THI_MCID,
        # The projection makes one response step worth 10 points, so the 7-point
        # MCID no longer discriminates. Clients must read this rather than
        # assuming the MCID applies.
        "mcid_applies": False,
        "smallest_detectable_change": 10,
        "form": "thi5",
        "long_form_items": THI_ITEMS,
        "note": "Scored on the raw 0-20 range and projected onto the published 0-100 scale so "
        "grades, trends and historical comparisons stay on one number.",
    },
    "psqi": {
        "name": "Pittsburgh Sleep Quality Index",
        "abbrev": "PSQI",
        "citation": "Buysse DJ, et al. Psychiatry Res. 1989;28(2):193-213.",
        "items": PSQI_ITEMS,
        "option_sets": {
            "freq": PSQI_FREQ_OPTIONS,
            "quality": PSQI_QUALITY_OPTIONS,
            "problem": PSQI_PROBLEM_OPTIONS,
        },
        "max_score": 21,
        "cutoff": 5,
    },
    "pss10": {
        "name": "Perceived Stress Scale",
        "abbrev": "PSS-10",
        "citation": "Cohen S, Williamson G. In: The Social Psychology of Health. 1988.",
        "items": PSS10_ITEMS,
        "options": PSS10_OPTIONS,
        "max_score": 40,
        "escalation_only": True,
        # Same again: the PSS-4 is items 2, 4, 5 and 10 of this scale.
        "screener_key": "pss4",
    },
    "gad7": {
        "name": "Generalised Anxiety Disorder 7-item",
        "abbrev": "GAD-7",
        "citation": "Spitzer RL, et al. Arch Intern Med. 2006;166(10):1092-7.",
        "items": GAD7_ITEMS,
        "options": FOUR_POINT_OPTIONS,
        "max_score": 21,
        "escalation_only": True,
        # The GAD-2 *is* the first two GAD-7 items. Naming the screener here lets
        # the client administer only the five it has not already asked instead of
        # putting the same two questions to the patient twice in one sitting.
        "screener_key": "gad2",
    },
    "gad2": {
        "name": "Generalised Anxiety Disorder 2-item screener",
        "abbrev": "GAD-2",
        "citation": "Kroenke K, et al. Ann Intern Med. 2007;146(5):317-25.",
        "items": [i for i in GAD7_ITEMS if i["id"] in GAD2_ITEM_IDS],
        "options": FOUR_POINT_OPTIONS,
        "max_score": 6,
        "cutoff": GAD2_CUTOFF,
        "escalates_to": "gad7",
    },
    "pss4": {
        "name": "Perceived Stress Scale, 4-item",
        "abbrev": "PSS-4",
        "citation": "Cohen S, Williamson G. In: The Social Psychology of Health. 1988.",
        "items": [i for i in PSS10_ITEMS if i["id"] in PSS4_ITEM_IDS],
        "options": PSS10_OPTIONS,
        "max_score": 16,
        "cutoff": PSS4_CUTOFF,
        "escalates_to": "pss10",
    },
    "sleep_screen": {
        "name": "Tinnitus sleep-interference screener",
        "abbrev": "Sleep screen",
        "citation": "Single-item gate for the PSQI; the PSQI itself has no validated short form.",
        "items": SLEEP_SCREEN_ITEMS,
        "options": PSQI_FREQ_OPTIONS,
        "max_score": 3,
        "cutoff": SLEEP_SCREEN_CUTOFF,
        "escalates_to": "psqi",
    },
    "phq2": {
        "name": "Patient Health Questionnaire 2-item",
        "abbrev": "PHQ-2",
        "citation": "Kroenke K, Spitzer RL, Williams JB. Med Care. 2003;41(11):1284-92.",
        "items": PHQ2_ITEMS,
        "options": FOUR_POINT_OPTIONS,
        "max_score": 6,
    },
    "vas": {
        "name": "Tinnitus Visual Analogue Scales",
        "abbrev": "VAS",
        "citation": "Tinnitus Research Initiative minimum reporting standard.",
        "items": VAS_SCALES,
        "max_score": 10,
        # Asked once, after the four scales above - see `PAIN_VAS`. Carried on
        # the registry rather than hard-coded in the client for the same reason
        # every other item bank is: the question the patient sees and the code
        # that scores it come from one place.
        "pain_scale": PAIN_VAS,
    },
    "tfi": {
        "name": "Tinnitus Functional Index",
        "abbrev": "TFI",
        "citation": "Meikle MB, Henry JA, Griest SE, et al. Ear Hear. 2012;33(2):153-76. "
        "Item bank and scoring: Oregon Health & Science University, 2008.",
        "items": TFI_ITEMS,
        "option_sets": {"percent": TFI_PERCENT_OPTIONS, "scale10": TFI_SCALE_OPTIONS},
        "max_score": 100,
        "subscales": list(TFI_SUBSCALES.keys()),
        "min_valid_overall": TFI_MIN_VALID_OVERALL,
    },
    "isi": {
        "name": "Insomnia Severity Index",
        "abbrev": "ISI",
        "citation": "Bastien CH, Vallieres A, Morin CM. Sleep Med. 2001;2(4):297-307.",
        "items": ISI_ITEMS,
        "option_sets": {
            "severity": ISI_SEVERITY_OPTIONS,
            "q2": ISI_Q2_OPTIONS,
            "q3": ISI_Q3_OPTIONS,
            "q4": ISI_Q4_OPTIONS,
            "q5": ISI_Q5_OPTIONS,
        },
        "max_score": 28,
        "bands": [{"lo": lo, "hi": hi, "label": label} for lo, hi, label in ISI_BANDS],
        "question_groups": ISI_QUESTION_GROUPS,
    },
    "phq9": {
        "name": "Patient Health Questionnaire-9",
        "abbrev": "PHQ-9",
        "citation": "Kroenke K, Spitzer RL, Williams JB. J Gen Intern Med. 2001;16(9):606-13.",
        "items": PHQ9_ITEMS,
        "options": PHQ9_OPTIONS,
        "max_score": 27,
        "timeframe": PHQ9_TIMEFRAME,
        # The PHQ-2 *is* the first two PHQ-9 items - same twin-purpose
        # metadata GAD-7/PSS-10 already carry for their own screeners.
        "screener_key": "phq2",
        "functional_difficulty": {
            "text": PHQ9_FUNCTIONAL_DIFFICULTY_TEXT,
            "options": PHQ9_FUNCTIONAL_DIFFICULTY_OPTIONS,
        },
    },
    "whoqol_bref": {
        "name": "World Health Organization Quality of Life — BREF",
        "abbrev": "WHOQOL-BREF",
        "citation": "The WHOQOL Group. Psychol Med. 1998;28(3):551-8. Item text, item numbering, "
        "item codes and response scales reproduced verbatim from the published WHOQOL-BREF "
        "patient form (Appendix 8).",
        "items": WHOQOL_BREF_ITEMS,
        "option_sets": {
            "poor_good": WHOQOL_POOR_GOOD_OPTIONS,
            "satisfaction": WHOQOL_SATISFACTION_OPTIONS,
            "amount": WHOQOL_AMOUNT_OPTIONS,
            "amount_extremely": WHOQOL_AMOUNT_EXTREMELY_OPTIONS,
            "capacity": WHOQOL_CAPACITY_OPTIONS,
            "frequency": WHOQOL_FREQUENCY_OPTIONS,
        },
        "max_score": WHOQOL_BREF_RAW_MAX,
        "reference_period": WHOQOL_REFERENCE_PERIOD,
        "instructions": WHOQOL_INSTRUCTIONS,
        # No domain/overall score is computed — see `score_whoqol_bref`. Carried
        # on the registry so a client can show the honest "scoring not yet
        # available" note without guessing at why a score is absent.
        "scoring_implemented": False,
    },
}


def score_all(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Score every instrument present in a submitted assessment payload.

    Screeners and full instruments are read from the same item banks: the GAD-2 is
    literally the first two GAD-7 items, and the PSS-4 is four of the PSS-10 items,
    so both are scored from whichever item dictionary the client sent. A patient who
    answered only the screener gets a screener score and a null long-form score,
    which is the honest representation of what was administered.
    """
    gad_items = payload.get("gad7_items") or payload.get("gad2_items")
    pss_items = payload.get("pss10_items") or payload.get("pss4_items")

    scores: dict[str, Any] = {
        "thi": score_thi(payload.get("thi_items")).to_dict(),
        "vas": score_vas(payload.get("vas")),
        # The pain faces scale, kept out of "vas" so the four tinnitus scales
        # keep meaning exactly what they meant before it existed.
        "vas_pain": score_pain_vas(payload.get("vas_pain")),
        "gad2": score_gad2(gad_items).to_dict(),
        "phq2": score_phq2(payload.get("phq2_items")).to_dict(),
        "pss4": score_pss4(pss_items).to_dict(),
        "sleep_screen": score_sleep_screen(payload.get("sleep_screen_items")).to_dict(),
        # Long forms are only scored when all their items are actually present, so a
        # 2-item GAD-2 submission cannot masquerade as a partially-complete GAD-7.
        "gad7": score_gad7(payload.get("gad7_items")).to_dict(),
        "pss10": score_pss10(payload.get("pss10_items")).to_dict(),
        "psqi": score_psqi(payload.get("psqi_items")).to_dict(),
        "tfi": score_tfi(payload.get("tfi_items")).to_dict(),
        "isi": score_isi(payload.get("isi_items")).to_dict(),
        "phq9": score_phq9(payload.get("phq9_items")).to_dict(),
        "whoqol_bref": score_whoqol_bref(payload.get("whoqol_bref_items")).to_dict(),
    }
    scores["escalations"] = escalation_plan(scores)
    return scores

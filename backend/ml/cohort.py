"""Synthetic training cohort.

**This cohort is simulated, not collected.** No real patient data is used or
implied. It exists so the predictive engine ships with working, inspectable
weights on day one; `POST /api/ml/retrain` re-fits the same pipeline on real
records once they accrue, which is the continuous-learning path.

The generator is a *causal* simulator rather than random noise with labels: it
samples latent variables (cochlear damage, central gain, distress diathesis,
engagement) and derives every observable from them using relationships that are
well replicated in the tinnitus literature:

* Presbycusis rises with age and is steeper at high frequencies (ISO 7029 shape).
* Occupational noise carves a 3-6 kHz notch with recovery at 8 kHz.
* **Matched tinnitus pitch clusters at the audiometric edge / notch region**,
  not uniformly across the spectrum.
* **THI is driven far more by psychological state than by audiometric severity** -
  the simulator gives hearing thresholds a deliberately small THI weight and the
  distress diathesis a large one, so a model trained here cannot learn the naive
  "worse hearing = worse handicap" shortcut.
* Loudness matches sit at low sensation levels (typically 3-15 dB SL) even when
  the patient rates the percept as very loud.
* Residual inhibition is present in roughly two thirds of patients and tracks
  maskability.
* Six-month change shows regression to the mean, an adherence benefit, and an
  anxiety-driven persistence effect.

Realistic missingness is injected (skipped questionnaires, no extended-frequency
audiometry, no diary) so the deployed models are trained under exactly the
partial-data conditions they will meet.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from ml.features import FEATURE_KEYS

AUDIOMETRIC_FREQS = (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)

TARGET_COLUMNS = [
    "y_dominant_hz",
    "y_loudness_db_sl",
    "y_thi_6mo",
    "y_distress_class",
    "y_worsening_risk",
    "y_therapy_response",
]


def _sigmoid(x: np.ndarray | float) -> np.ndarray | float:
    return 1.0 / (1.0 + np.exp(-x))


def _presbycusis(age: np.ndarray, freq: float, sex_male: np.ndarray) -> np.ndarray:
    """Median age-related threshold shift at `freq`, ISO-7029-like in shape."""
    years = np.clip(age - 18, 0, None)
    # Frequency-dependent coefficient: negligible below 1 kHz, steep at 8 kHz.
    k = {250: 0.0022, 500: 0.0026, 1000: 0.0033, 2000: 0.0060,
         3000: 0.0090, 4000: 0.0122, 6000: 0.0155, 8000: 0.0180}[freq]
    male_bonus = np.where(sex_male > 0.5, 1.25, 1.0)  # men lose HF hearing faster
    return k * male_bonus * years**2 / 10.0


def _noise_notch(exposure_years: np.ndarray, freq: float, rng: np.random.Generator) -> np.ndarray:
    """Noise-induced component: maximal at 4 kHz, partial recovery at 8 kHz."""
    shape = {250: 0.02, 500: 0.05, 1000: 0.10, 2000: 0.28,
             3000: 0.72, 4000: 1.00, 6000: 0.80, 8000: 0.45}[freq]
    saturating = 26.0 * (1.0 - np.exp(-exposure_years / 9.0))
    return shape * saturating * rng.normal(1.0, 0.16, size=exposure_years.shape)


def generate_cohort(n: int = 6000, seed: int = 20260730) -> pd.DataFrame:
    rng = np.random.default_rng(seed)

    # ---------------- latent variables ------------------------------------- #
    age = np.clip(rng.normal(54, 15, n), 18, 92)
    sex_male = (rng.random(n) < 0.53).astype(float)
    # Distress diathesis: standardised latent trait driving all affective scores.
    diathesis = rng.normal(0, 1, n)
    # Central gain: how much the auditory system amplifies the percept.
    central_gain = np.clip(rng.normal(0, 1, n) + 0.25 * diathesis, -3, 3)
    engagement = np.clip(rng.beta(2.6, 1.9, n), 0.02, 1.0)

    noise_exposure_years = np.where(
        rng.random(n) < 0.42,
        np.clip(rng.gamma(2.0, 5.5, n) * (0.6 + 0.5 * sex_male), 0, 42),
        0.0,
    )
    noise_exposure_years = np.minimum(noise_exposure_years, np.clip(age - 18, 0, None))

    duration_months = np.clip(rng.lognormal(3.1, 1.05, n), 0.5, 420)

    # ---------------- audiogram -------------------------------------------- #
    # Per-ear asymmetry seed: most patients near-symmetric, a tail that is not.
    asym_seed = np.where(rng.random(n) < 0.18, rng.normal(0, 11, n), rng.normal(0, 3.0, n))
    ear_noise = {ear: rng.normal(0, 4.2, (n, len(AUDIOMETRIC_FREQS))) for ear in ("left", "right")}

    audiograms: dict[str, dict[int, np.ndarray]] = {"left": {}, "right": {}}
    for ear_idx, ear in enumerate(("left", "right")):
        side_shift = asym_seed * (1 if ear == "left" else -1) / 2.0
        for fi, freq in enumerate(AUDIOMETRIC_FREQS):
            base = 6.0 + _presbycusis(age, freq, sex_male)
            notch = _noise_notch(noise_exposure_years, freq, rng)
            thr = base + notch + side_shift + ear_noise[ear][:, fi]
            # Audiometers step in 5 dB; floor at -10 dB HL.
            audiograms[ear][freq] = np.clip(np.round(thr / 5.0) * 5.0, -10, 120)

    def pta(ear: str, freqs: tuple[int, ...]) -> np.ndarray:
        return np.mean([audiograms[ear][f] for f in freqs], axis=0)

    pta_left = pta("left", (500, 1000, 2000, 4000))
    pta_right = pta("right", (500, 1000, 2000, 4000))
    hf_left = pta("left", (4000, 6000, 8000))
    hf_right = pta("right", (4000, 6000, 8000))
    pta_better = np.minimum(pta_left, pta_right)
    pta_worse = np.maximum(pta_left, pta_right)
    hf_worse = np.where(pta_left >= pta_right, hf_left, hf_right)
    asymmetry_db = np.abs(pta_left - pta_right)

    log_f = np.log2(np.asarray(AUDIOMETRIC_FREQS, dtype=float))
    worse_matrix = np.stack(
        [
            np.where(pta_left >= pta_right, audiograms["left"][f], audiograms["right"][f])
            for f in AUDIOMETRIC_FREQS
        ],
        axis=1,
    )
    lf_baseline = worse_matrix[:, :3].mean(axis=1)
    centred = log_f - log_f.mean()
    audiogram_slope = (
        ((worse_matrix - worse_matrix.mean(axis=1, keepdims=True)) * centred).sum(axis=1)
        / (centred**2).sum()
    )

    # Notch detection on the simulated worse ear, mirroring the Coles criteria.
    idx = {f: i for i, f in enumerate(AUDIOMETRIC_FREQS)}
    notch_present = np.zeros(n)
    notch_centre_oct = np.full(n, np.nan)
    best_depth = np.zeros(n)
    ref = np.minimum(worse_matrix[:, idx[1000]], worse_matrix[:, idx[2000]])
    for centre in (3000, 4000, 6000):
        depth = worse_matrix[:, idx[centre]] - ref
        recovery = np.max(
            np.stack(
                [worse_matrix[:, idx[centre]] - worse_matrix[:, idx[f]]
                 for f in (6000, 8000) if f > centre],
                axis=1,
            ),
            axis=1,
        )
        hit = (depth >= 10) & (recovery >= 10) & (depth > best_depth)
        notch_present = np.where(hit, 1.0, notch_present)
        notch_centre_oct = np.where(hit, math.log2(centre), notch_centre_oct)
        best_depth = np.where(hit, depth, best_depth)

    # Audiometric edge: first frequency >=1 kHz that is 15 dB above the LF baseline.
    edge_oct = np.full(n, np.nan)
    for f in (1000, 2000, 3000, 4000, 6000, 8000):
        hit = np.isnan(edge_oct) & ((worse_matrix[:, idx[f]] - lf_baseline) >= 15)
        edge_oct = np.where(hit, math.log2(f), edge_oct)

    # ---------------- tinnitus percept ------------------------------------- #
    # Pitch anchors on the notch centre, else the edge, else a high-frequency
    # default; scatter is roughly half an octave, as reported for pitch matching.
    anchor = np.where(
        notch_present > 0.5,
        notch_centre_oct,
        np.where(np.isnan(edge_oct), math.log2(5200) + 0.11 * (audiogram_slope - 8) / 8, edge_oct),
    )
    # Scatter of ~0.38 octaves reflects the test-retest reliability of pitch
    # matching itself; a tighter simulator would train an over-confident model.
    pitch_oct = np.clip(anchor + rng.normal(0.12, 0.38, n), math.log2(300), math.log2(15500))
    dominant_hz = 2**pitch_oct

    threshold_at_pitch = np.clip(
        lf_baseline
        + np.clip(audiogram_slope, 0, None) * np.clip(pitch_oct - math.log2(1000), 0, None)
        + rng.normal(0, 5, n),
        -10,
        120,
    )

    bandwidth_ordinal = rng.choice([0.0, 1.0, 2.0], size=n, p=[0.46, 0.36, 0.18]).astype(float)

    # Loudness match: low sensation level, pushed up by central gain.
    loudness_db_sl = np.clip(
        6.4 + 2.9 * central_gain + 0.055 * threshold_at_pitch + rng.normal(0, 2.6, n), 0.5, 42
    )
    # MML tracks loudness, worse for broadband percepts and steep losses.
    mml_db_sl = np.clip(
        loudness_db_sl * 0.85
        + 5.2
        + 3.1 * bandwidth_ordinal
        + 0.09 * hf_worse
        + 2.2 * central_gain
        + rng.normal(0, 4.0, n),
        0.5,
        60,
    )
    maskability_index = np.clip(
        1.05 - 0.021 * mml_db_sl - 0.055 * bandwidth_ordinal + rng.normal(0, 0.055, n), 0.05, 1.0
    )
    # Residual inhibition: present in ~66%, deeper where maskability is good.
    ri_latent = 1.9 * maskability_index - 0.36 * bandwidth_ordinal - 0.35 * central_gain
    ri_present = rng.random(n) < _sigmoid(1.5 * ri_latent - 0.35)
    ri_depth_pct = np.where(
        ri_present,
        np.clip(rng.normal(52, 24, n) * (0.5 + maskability_index), 5, 100),
        np.clip(rng.normal(-2, 9, n), -35, 8),
    )

    hyperacusis = (rng.random(n) < _sigmoid(0.85 * central_gain + 0.5 * diathesis - 1.35)).astype(float)
    somatic_modulation = (rng.random(n) < 0.36).astype(float)
    pulsatile = (rng.random(n) < 0.055).astype(float)
    laterality_unilateral = (
        rng.random(n) < _sigmoid(0.05 * asymmetry_db - 1.05)
    ).astype(float)
    hearing_aid_use = (rng.random(n) < _sigmoid(0.085 * pta_better - 2.9)).astype(float)
    comorbidity_count = rng.poisson(0.55 + 0.022 * np.clip(age - 40, 0, None), n).astype(float)

    # ---------------- affective / questionnaire layer ----------------------- #
    gad7_score = np.clip(np.round(5.6 + 3.5 * diathesis + 0.9 * hyperacusis + rng.normal(0, 1.9, n)), 0, 21)
    pss10_score = np.clip(np.round(16.5 + 5.6 * diathesis + rng.normal(0, 3.3, n)), 0, 40)
    phq2_score = np.clip(np.round(1.15 + 0.95 * diathesis + rng.normal(0, 0.7, n)), 0, 6)

    # Short-form screeners are *subsets* of their long forms, so they are derived
    # from them rather than sampled independently: the GAD-2 is two of the seven
    # GAD-7 items and the PSS-4 is four of the ten PSS-10 items. Scaling the long
    # form by the item ratio and adding subset noise reproduces the real
    # relationship — strongly correlated but not deterministic, which is what lets
    # the model learn how much a screener alone is worth.
    gad2_score = np.clip(np.round(gad7_score * (2 / 7) + rng.normal(0, 0.55, n)), 0, 6)
    pss4_score = np.clip(np.round(pss10_score * (4 / 10) + rng.normal(0, 1.1, n)), 0, 16)

    vas_loudness = np.clip(
        3.4 + 0.115 * loudness_db_sl + 0.72 * central_gain + 0.32 * diathesis + rng.normal(0, 1.0, n), 0, 10
    )
    vas_annoyance = np.clip(
        1.5 + 0.52 * vas_loudness + 1.25 * diathesis + 0.7 * hyperacusis + rng.normal(0, 1.0, n), 0, 10
    )
    vas_awareness = np.clip(
        3.0 + 0.42 * vas_loudness + 0.85 * diathesis - 0.22 * np.log2(np.clip(duration_months, 1, None))
        + rng.normal(0, 1.2, n),
        0,
        10,
    )
    vas_sleep = np.clip(
        0.7 + 0.44 * vas_annoyance + 0.95 * diathesis + rng.normal(0, 1.2, n), 0, 10
    )
    psqi_score = np.clip(
        np.round(4.3 + 0.72 * vas_sleep + 1.55 * diathesis + 0.055 * gad7_score + rng.normal(0, 1.7, n)),
        0,
        21,
    )
    # Single tinnitus-specific sleep item on the 0-3 PSQI frequency scale, driven by
    # the same sleep-interference construct as the VAS.
    sleep_screen_score = np.clip(
        np.round(vas_sleep * 0.34 + rng.normal(0, 0.45, n)), 0, 3
    )

    # THI: psychology-dominant by construction. Note how small the audiometric
    # coefficient (0.055 * pta_worse) is next to the affective terms.
    thi_raw = (
        13.0
        + 11.6 * diathesis
        + 3.05 * vas_annoyance
        + 1.32 * psqi_score
        + 0.92 * gad7_score
        + 0.30 * pss10_score
        + 4.4 * hyperacusis
        + 0.055 * pta_worse
        + 0.85 * (1.0 - maskability_index) * 10
        - 1.25 * np.log2(np.clip(duration_months, 1, None))
        + rng.normal(0, 6.4, n)
    )
    thi_score = np.clip(np.round(thi_raw / 2) * 2, 0, 100)  # THI totals are even
    thi_catastrophic_pct = np.clip(
        100 * (thi_score / 100) ** 1.25 + rng.normal(0, 7, n), 0, 100
    )

    # ---------------- engagement ------------------------------------------- #
    adherence_pct = np.clip(
        100 * engagement * (0.72 + 0.3 * _sigmoid(-0.6 * diathesis)) + rng.normal(0, 9, n), 0, 100
    )
    diary_days = np.clip(np.round(engagement * rng.normal(62, 26, n)), 0, 180)
    diary_intensity_mean = np.clip(vas_loudness + rng.normal(0, 0.65, n), 0, 10)
    # Trend: improves with adherence, worsens with stress.
    diary_intensity_slope = (
        -0.030 * (adherence_pct / 10) + 0.021 * (pss10_score - 16) + rng.normal(0, 0.11, n)
    )
    diary_intensity_sd = np.clip(
        0.72 + 0.055 * pss10_score * 0.5 + 0.6 * somatic_modulation + rng.normal(0, 0.28, n), 0.1, 4.0
    )
    diary_intensity_slope = np.where(diary_days < 4, np.nan, diary_intensity_slope)

    # ---------------- outcomes --------------------------------------------- #
    # Six-month change in THI, written as an explicit signal + noise decomposition
    # so the learnability of the outcome is a design choice rather than an
    # accident. Each term is centred on its cohort mean, which keeps the average
    # trajectory mildly improving (as it should be for a treated cohort) while
    # giving the *individual* trajectory genuine predictable spread.
    #
    # Deteriorating forces: anxiety and stress maintain handicap, sound
    # intolerance spirals, continued noise exposure re-injures, masking rebound
    # makes acoustic therapy counterproductive.
    # Improving forces: mean reversion, adherence, a maskable percept with
    # positive residual inhibition, and time already lived with the percept.
    delta_signal = (
        -0.13 * (thi_score - 32)                                  # regression to the mean
        - 0.055 * (adherence_pct - 55)                            # therapy works if you do it
        - 0.045 * np.clip(ri_depth_pct, 0, None)                  # RI predicts masking benefit
        - 6.0 * (maskability_index - 0.60)                        # maskable percepts settle
        + 0.70 * (gad7_score - 5.6)                               # anxiety maintains handicap
        + 0.30 * (psqi_score - 8.0)                               # unrefreshing sleep
        + 0.55 * (pss10_score - 16.5)                             # sustained stress
        + 6.0 * hyperacusis                                       # sound intolerance spirals
        + 0.30 * np.nan_to_num(noise_exposure_years)              # ongoing acoustic insult
        + 3.5 * np.clip(-ri_depth_pct / 20, 0, None)              # rebound to masking
        - 0.25 * np.log2(np.clip(duration_months, 1, None))       # habituation over time
    )
    # Idiosyncratic component: life events, medication changes, unmeasured
    # factors. Kept below the signal spread so ~3/4 of outcome variance is
    # explainable - any more and the risk model would be predicting coin flips.
    delta = delta_signal + rng.normal(0, 3.5, n)

    thi_6mo = np.round(np.clip(thi_score + delta, 0, 100) / 2) * 2
    realised_delta = thi_6mo - thi_score

    # Worsening / response are both defined at the THI minimum clinically
    # important difference of 7 points, so the labels mean something clinically
    # rather than being arbitrary cut-points.
    #
    # Labels are the named classes from `features.TARGETS`, not 0/1: the fitted
    # estimator's `classes_` must match the declared positive class by name, or
    # inference cannot tell which probability column is the one to report.
    y_worsening = np.where(realised_delta >= 7, "worsening", "stable")
    y_response = np.where(-realised_delta >= 7, "responder", "non_responder")

    distress_bins = np.digitize(thi_score, [17, 37, 57])
    y_distress = np.asarray(["low", "moderate", "high", "very_high"])[distress_bins]

    frame = pd.DataFrame(
        {
            "age": age,
            "sex_male": sex_male,
            "duration_months": duration_months,
            "noise_exposure_years": noise_exposure_years,
            "laterality_unilateral": laterality_unilateral,
            "pulsatile": pulsatile,
            "somatic_modulation": somatic_modulation,
            "hyperacusis": hyperacusis,
            "hearing_aid_use": hearing_aid_use,
            "comorbidity_count": comorbidity_count,
            "pta_better": pta_better,
            "pta_worse": pta_worse,
            "hf_pta_worse": hf_worse,
            "asymmetry_db": asymmetry_db,
            "audiogram_slope": audiogram_slope,
            "notch_present": notch_present,
            "notch_centre_oct": notch_centre_oct,
            "edge_frequency_oct": edge_oct,
            "pitch_oct": pitch_oct,
            "loudness_db_sl": loudness_db_sl,
            "mml_db_sl": mml_db_sl,
            "maskability_index": maskability_index,
            "ri_depth_pct": ri_depth_pct,
            "bandwidth_ordinal": bandwidth_ordinal,
            "threshold_at_pitch": threshold_at_pitch,
            "thi_score": thi_score,
            "thi_catastrophic_pct": thi_catastrophic_pct,
            "vas_loudness": vas_loudness,
            "vas_annoyance": vas_annoyance,
            "vas_awareness": vas_awareness,
            "vas_sleep": vas_sleep,
            "psqi_score": psqi_score,
            "pss10_score": pss10_score,
            "gad7_score": gad7_score,
            "phq2_score": phq2_score,
            "gad2_score": gad2_score,
            "pss4_score": pss4_score,
            "sleep_screen_score": sleep_screen_score,
            "adherence_pct": adherence_pct,
            "diary_days": diary_days,
            "diary_intensity_mean": diary_intensity_mean,
            "diary_intensity_slope": diary_intensity_slope,
            "diary_intensity_sd": diary_intensity_sd,
            # targets
            "y_dominant_hz": dominant_hz,
            "y_loudness_db_sl": loudness_db_sl,
            "y_thi_6mo": thi_6mo,
            "y_distress_class": y_distress,
            "y_worsening_risk": y_worsening,
            "y_therapy_response": y_response,
        }
    )

    # ---------------- realistic missingness -------------------------------- #
    # Patients skip modules. Training under these conditions is what lets the
    # deployed model score a partially-completed assessment.
    def blank(cols: list[str], rate: float) -> None:
        mask = rng.random(n) < rate
        frame.loc[mask, cols] = np.nan

    # Long-form instruments are absent *by design* under the stepped protocol: they
    # are only administered when the screener is positive. Encoding that here means
    # the deployed models are trained under exactly the conditions they meet in
    # practice, rather than on a fully-completed battery real patients rarely give.
    frame.loc[frame["gad2_score"] < 3, "gad7_score"] = np.nan
    frame.loc[frame["pss4_score"] < 6, "pss10_score"] = np.nan
    frame.loc[frame["sleep_screen_score"] < 2, "psqi_score"] = np.nan

    # Residual dropout on top of the protocol (patients abandoning mid-instrument).
    blank(["psqi_score"], 0.08)
    blank(["pss10_score"], 0.07)
    blank(["gad7_score"], 0.06)
    blank(["phq2_score"], 0.04)
    blank(["gad2_score", "pss4_score", "sleep_screen_score"], 0.03)
    # Psychoacoustics are optional per AAO-HNSF, so they are missing far more often
    # than the questionnaires — the models must not depend on them.
    blank(["mml_db_sl", "maskability_index", "ri_depth_pct"], 0.42)
    blank(["pitch_oct", "threshold_at_pitch", "loudness_db_sl", "bandwidth_ordinal"], 0.34)
    blank(["noise_exposure_years"], 0.13)
    blank(["vas_awareness"], 0.07)
    blank(["adherence_pct"], 0.19)
    blank(["diary_intensity_mean", "diary_intensity_sd", "diary_intensity_slope"], 0.21)
    blank(["duration_months"], 0.05)

    missing = [c for c in FEATURE_KEYS if c not in frame.columns]
    if missing:  # pragma: no cover - contract guard
        raise RuntimeError(f"Cohort generator is missing feature columns: {missing}")

    return frame[FEATURE_KEYS + TARGET_COLUMNS]


def cohort_summary(frame: pd.DataFrame) -> dict[str, Any]:
    return {
        "n": int(len(frame)),
        "mean_age": round(float(frame["age"].mean()), 1),
        "pct_male": round(100 * float(frame["sex_male"].mean()), 1),
        "mean_thi": round(float(frame["thi_score"].mean()), 1),
        "median_pitch_hz": int(frame["y_dominant_hz"].median()),
        "pct_notch": round(100 * float(frame["notch_present"].mean()), 1),
        "pct_worsening": round(100 * float((frame["y_worsening_risk"] == "worsening").mean()), 1),
        "pct_responder": round(100 * float((frame["y_therapy_response"] == "responder").mean()), 1),
        "distress_distribution": {
            k: int(v) for k, v in frame["y_distress_class"].value_counts().items()
        },
        "missing_rate": {
            c: round(float(frame[c].isna().mean()), 3)
            for c in FEATURE_KEYS
            if frame[c].isna().any()
        },
    }

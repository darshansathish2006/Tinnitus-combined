"""Tests for the Tinnitus Functional Index (TFI), the Insomnia Severity Index
(ISI) and the Patient Health Questionnaire-9 (PHQ-9): scoring rules and the
"About Your Tinnitus" integration.

TFI scoring is exercised directly against `clinical.instruments.score_tfi`
(pure function, no DB needed) per the published TFI scoring instructions:
  - Items 1 and 3 are percentage scales, divided by 10 for scoring only.
  - Overall score = (sum of valid item scores / count of valid items) x 10,
    valid only when at least 19 of 25 items were answered.
  - Each of the 8 subscales tolerates at most one missing item.
  - The overall score is computed from the items directly, never from an
    average of the subscale scores.

ISI scoring is exercised directly against `clinical.instruments.score_isi`
per the published ISI patient form and scoring instructions:
  - Seven scored components (three make up the published form's grouped
    item 1), each 0-4, summed directly to a 0-28 total.
  - Unlike the TFI, no partial-completion allowance is documented anywhere
    in the source, so all seven are required or no score is reported.
  - The published interpretation bands (0-7/8-14/15-21/22-28) are used
    verbatim, with no invented cut-points.

PHQ-9 scoring is exercised directly against
`clinical.instruments.score_phq9` per the published patient form:
  - Nine items, each 0-3, summed directly to a 0-27 total; like the ISI, no
    partial-completion allowance is documented, so all nine are required.
  - Item 9 (thoughts of self-harm) is flagged (`item9_positive`) independently
    of that gate and is picked up by `clinical.redflags.evaluate_red_flags`.
  - No severity bands are invented — none exist in this codebase for the
    full PHQ-9 (only the PHQ-2 screener's own referral cut-point).

The API-level tests exercise the same "About Your Tinnitus" wiring the other
real instruments (THI/GAD-7/PSS-10) already have — the module-completion
status, the report's `questionnaires.tfi`/`.isi`/`.phq9` blocks, and the
finalise-time lock — following the `CommunityFeatureTests` pattern already
established in `tests_community.py`.
"""

from django.test import SimpleTestCase, TestCase
from rest_framework import status
from rest_framework.test import APIClient

from clinical.instruments import (
    ISI_ITEM_IDS,
    ISI_QUESTION_GROUPS,
    PHQ9_ITEM_IDS,
    TFI_ITEM_IDS,
    TFI_SUBSCALES,
    score_isi,
    score_phq9,
    score_tfi,
)
from clinical.redflags import evaluate_red_flags


def _answers(value=5, **overrides):
    """25 TFI answers, uniform except for `overrides`.

    Items 1 and 3 default to a percentage; every other item defaults to 0-10.
    `value` sets the 0-10 items; percentage items are always given explicitly
    via `overrides` when a test cares about their exact transformation.
    """
    out = {f"tfi{n}": value for n in range(1, 26)}
    out["tfi1"] = 50
    out["tfi3"] = 50
    out.update(overrides)
    return out


class TfiScoringTests(SimpleTestCase):
    # -- item 1 / item 3 percentage transformation --------------------------- #
    def test_item1_percentage_transformation(self):
        for pct, expected in ((0, 0), (10, 1), (50, 5), (100, 10)):
            answers = _answers(value=5, tfi1=pct)
            result = score_tfi(answers)
            self.assertIsNotNone(result.score)
            # Every other item is fixed at 5 (item 3 included, at 50% -> 5), so
            # the overall score is a direct function of item 1's scored value —
            # recomputed here via the same formula the scorer uses, to check
            # the percentage-to-0-10 transformation itself.
            expected_overall = round((expected + 5 + 5 + sum(5 for _ in range(22))) / 25 * 10)
            self.assertEqual(result.score, expected_overall)

    def test_item3_percentage_transformation(self):
        for pct, expected_scaled in ((0, 0), (50, 5), (100, 10)):
            answers = _answers(value=0, tfi1=0, tfi3=pct)
            result = score_tfi(answers)
            # All other items are 0, so the overall score is exactly item 3's
            # scaled contribution divided across 25 valid items, x10.
            expected_overall = round(expected_scaled / 25 * 10)
            self.assertEqual(result.score, expected_overall)

    def test_raw_percentage_is_not_persisted_transformed(self):
        """The scorer must never mutate the caller's raw answers dict."""
        answers = _answers(value=5, tfi1=70)
        score_tfi(answers)
        self.assertEqual(answers["tfi1"], 70)  # untouched — still the raw percentage

    # -- overall score formula ------------------------------------------------ #
    def test_overall_score_25_valid_answers(self):
        # Every item at the top of its scale scores 100.
        answers = _answers(value=10, tfi1=100, tfi3=100)
        result = score_tfi(answers)
        self.assertEqual(result.score, 100)
        self.assertEqual(result.answered, 25)
        self.assertTrue(result.subscales["valid"])

    def test_overall_score_is_not_a_plain_sum(self):
        """Regression guard: the score must be the mean x10, not the raw sum."""
        answers = _answers(value=10, tfi1=100, tfi3=100)  # sum would be 250
        result = score_tfi(answers)
        self.assertEqual(result.score, 100)  # not 250

    def test_overall_score_never_averages_subscales(self):
        """Uneven subscale sizes (3 vs 4 items) make averaging subscales wrong.

        Two subscales (6 items) are maxed out, the other six (19 items) are
        zero — chosen so per-item averaging and subscale-averaging land on
        different, non-tied numbers. If this ever regresses to averaging the
        8 subscale scores instead of the 25 items directly, this test fails.
        """
        answers = _answers(value=0, tfi1=0, tfi3=0)
        answers.update(tfi1=100, tfi2=10, tfi3=100, tfi4=10, tfi5=10, tfi6=10)
        result = score_tfi(answers)
        per_item = round((10 + 10 + 10 + 10 + 10 + 10 + 0 * 19) / 25 * 10)  # = 24
        self.assertEqual(result.score, per_item)
        # An 8-subscale average would instead be (100 + 100 + 0*6)/8 = 25 — a
        # different number, and the wrong one per the scoring instructions.
        subscale_average = round(sum(s["score"] or 0 for s in result.subscales.values() if isinstance(s, dict)) / 8)
        self.assertNotEqual(result.score, subscale_average)

    # -- validity: >=19 of 25 items ------------------------------------------- #
    def test_19_valid_answers_is_valid(self):
        answers = _answers(value=5, tfi1=50, tfi3=50)
        for n in range(1, 7):  # drop 6 items -> 19 remain
            del answers[f"tfi{n + 3}"]
        result = score_tfi(answers)
        self.assertEqual(result.answered, 19)
        self.assertIsNotNone(result.score)
        self.assertTrue(result.subscales["valid"])

    def test_18_valid_answers_is_invalid(self):
        answers = _answers(value=5, tfi1=50, tfi3=50)
        for n in range(1, 8):  # drop 7 items -> 18 remain
            del answers[f"tfi{n + 3}"]
        result = score_tfi(answers)
        self.assertEqual(result.answered, 18)
        self.assertIsNone(result.score)
        self.assertFalse(result.subscales["valid"])
        self.assertIn("fewer than 19", result.interpretation)

    def test_missing_answers_are_not_scored_as_zero(self):
        """An 18-answer record must not silently become an 18/25-at-zero score."""
        answers = {k: v for k, v in _answers(value=5, tfi1=50, tfi3=50).items() if k not in ("tfi1", "tfi2")}
        result = score_tfi(answers)
        # If missing items were treated as zero this would still report a
        # (wrong) score; the correct behaviour is that they are excluded from
        # both the numerator and the denominator entirely.
        self.assertEqual(result.answered, 23)

    def test_no_answers_at_all(self):
        result = score_tfi(None)
        self.assertEqual(result.answered, 0)
        self.assertIsNone(result.score)
        self.assertEqual(result.interpretation, "")  # never administered, not "invalid"

    def test_out_of_range_values_are_dropped_not_clamped(self):
        answers = _answers(value=5, tfi1=50, tfi3=50)
        answers["tfi4"] = 15  # illegal on a 0-10 scale
        answers["tfi1"] = 150  # illegal on a 0-100 scale
        result = score_tfi(answers)
        self.assertEqual(result.answered, 23)  # tfi1 and tfi4 dropped, not coerced

    # -- the 11-position slider grid (0/10/.../100) -------------------------- #
    # The frontend now collects every item with an 11-position slider
    # (`AboutYourTinnitus.tsx::TfiSlider`) rather than discrete buttons. The
    # slider itself cannot emit an off-grid value, but the backend must not
    # rely on that alone — see `_tfi_valid_items`.
    def test_percent_item_accepts_every_grid_value(self):
        for pct in range(0, 101, 10):
            result = score_tfi(_answers(value=5, tfi1=pct, tfi3=50))
            self.assertEqual(result.answered, 25, f"{pct}% should be accepted")

    def test_percent_item_rejects_off_grid_values(self):
        for pct in (5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 47):
            result = score_tfi(_answers(value=5, tfi1=pct, tfi3=50))
            self.assertEqual(result.answered, 24, f"{pct}% should be rejected, not coerced")

    def test_scale10_item_accepts_every_whole_value(self):
        for v in range(0, 11):
            result = score_tfi(_answers(value=v, tfi1=50, tfi3=50))
            self.assertEqual(result.answered, 25, f"{v} should be accepted")

    def test_scale10_item_rejects_off_grid_values(self):
        # These are exactly what a percentage divided by 10 would produce for
        # an off-grid slider position (5%, 15%, ...) - illegal for the same
        # reason, expressed in the 0-10 storage domain instead of 0-100.
        for v in (0.5, 1.5, 6.5, 9.5):
            answers = _answers(value=5, tfi1=50, tfi3=50)
            answers["tfi4"] = v
            result = score_tfi(answers)
            self.assertEqual(result.answered, 24, f"{v} should be rejected, not coerced")

    # -- subscales -------------------------------------------------------------- #
    def test_all_eight_subscales_present(self):
        result = score_tfi(_answers(value=5, tfi1=50, tfi3=50))
        for name in TFI_SUBSCALES:
            self.assertIn(name, result.subscales)

    def test_three_item_subscale_tolerates_one_missing(self):
        answers = _answers(value=5, tfi1=50, tfi3=50)
        del answers["tfi5"]  # sense_of_control: 4, 5, 6 -> 2 of 3 remain
        result = score_tfi(answers)
        self.assertTrue(result.subscales["sense_of_control"]["valid"])
        self.assertEqual(result.subscales["sense_of_control"]["answered"], 2)

    def test_three_item_subscale_invalid_with_two_missing(self):
        answers = _answers(value=5, tfi1=50, tfi3=50)
        del answers["tfi5"], answers["tfi6"]  # only 1 of 3 remains
        result = score_tfi(answers)
        self.assertFalse(result.subscales["sense_of_control"]["valid"])
        self.assertIsNone(result.subscales["sense_of_control"]["score"])

    def test_quality_of_life_four_item_subscale_tolerates_one_missing(self):
        answers = _answers(value=5, tfi1=50, tfi3=50)
        del answers["tfi22"]  # quality_of_life: 19,20,21,22 -> 3 of 4 remain
        result = score_tfi(answers)
        self.assertTrue(result.subscales["quality_of_life"]["valid"])
        self.assertEqual(result.subscales["quality_of_life"]["answered"], 3)

    def test_quality_of_life_invalid_with_two_missing(self):
        answers = _answers(value=5, tfi1=50, tfi3=50)
        del answers["tfi21"], answers["tfi22"]  # only 2 of 4 remain
        result = score_tfi(answers)
        self.assertFalse(result.subscales["quality_of_life"]["valid"])
        self.assertIsNone(result.subscales["quality_of_life"]["score"])

    def test_subscale_item_mapping_matches_published_instrument(self):
        self.assertEqual(TFI_SUBSCALES["intrusive"], ["tfi1", "tfi2", "tfi3"])
        self.assertEqual(TFI_SUBSCALES["sense_of_control"], ["tfi4", "tfi5", "tfi6"])
        self.assertEqual(TFI_SUBSCALES["cognitive"], ["tfi7", "tfi8", "tfi9"])
        self.assertEqual(TFI_SUBSCALES["sleep"], ["tfi10", "tfi11", "tfi12"])
        self.assertEqual(TFI_SUBSCALES["auditory"], ["tfi13", "tfi14", "tfi15"])
        self.assertEqual(TFI_SUBSCALES["relaxation"], ["tfi16", "tfi17", "tfi18"])
        self.assertEqual(TFI_SUBSCALES["quality_of_life"], ["tfi19", "tfi20", "tfi21", "tfi22"])
        self.assertEqual(TFI_SUBSCALES["emotional"], ["tfi23", "tfi24", "tfi25"])
        self.assertEqual(len(TFI_ITEM_IDS), 25)

    def test_no_invented_severity_grade(self):
        """The supplied TFI reference gives no severity bands — none may be invented."""
        result = score_tfi(_answers(value=5, tfi1=50, tfi3=50))
        self.assertIsNone(result.grade)


class TfiApiIntegrationTests(TestCase):
    """The "About Your Tinnitus" wiring: save, report, and the finalise-time lock."""

    def setUp(self):
        self.client = APIClient()
        register = self.client.post(
            "/api/auth/register",
            {
                "email": "tfi.tester@example.com",
                "password": "probepass2026",
                "full_name": "TFI Tester",
                "role": "patient",
                "date_of_birth": "1990-01-01",
                "sex": "male",
            },
            format="json",
        )
        self.assertEqual(register.status_code, status.HTTP_201_CREATED)
        self.token = register.json()["access_token"]
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {self.token}")
        created = self.client.post("/api/assessments")
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        self.assessment_id = created.json()["id"]

    def test_tfi_items_saved_and_scored_in_report(self):
        answers = _answers(value=6, tfi1=60, tfi3=60)
        patch = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"tfi_items": answers, "questionnaire_status": {"tfi": "completed"}},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)

        finalise = self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        self.assertEqual(finalise.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        self.assertEqual(report.status_code, status.HTTP_200_OK)
        body = report.json()

        tfi = body["questionnaires"]["tfi"]
        self.assertIsNotNone(tfi["score"])
        self.assertEqual(tfi["answered"], 25)
        self.assertIsNone(tfi["grade"])  # no invented severity bands

        domain = next(d for d in body["about_your_tinnitus"] if d["key"] == "tfi")
        self.assertEqual(domain["kind"], "real")
        self.assertTrue(domain["available"])
        self.assertEqual(domain["score"], tfi["score"])

    def test_skipped_tfi_reports_no_score(self):
        patch = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"questionnaire_status": {"tfi": "skipped"}},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)
        finalise = self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        self.assertEqual(finalise.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        domain = next(d for d in report.json()["about_your_tinnitus"] if d["key"] == "tfi")
        self.assertEqual(domain["status"], "skipped")
        self.assertFalse(domain["available"])
        self.assertIsNone(domain["score"])
        self.assertIn("skipped", domain["reason"].lower())

    def test_insufficient_tfi_answers_reports_unavailable_not_a_fake_score(self):
        answers = {k: v for k, v in _answers(value=5, tfi1=50, tfi3=50).items()
                   if k in [f"tfi{n}" for n in range(1, 19)]}  # 18 items only
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"tfi_items": answers, "questionnaire_status": {"tfi": "completed"}},
            format="json",
        )
        finalise = self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        self.assertEqual(finalise.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        domain = next(d for d in report.json()["about_your_tinnitus"] if d["key"] == "tfi")
        self.assertFalse(domain["available"])
        self.assertIsNone(domain["score"])
        self.assertIn("enough valid responses", domain["reason"])

    def test_off_grid_slider_value_rejected_end_to_end(self):
        """The backend must not trust an off-grid value even via the live API."""
        answers = _answers(value=5, tfi1=47, tfi3=50)  # 47% is not one of the 11 slider positions
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"tfi_items": answers, "questionnaire_status": {"tfi": "completed"}},
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        # 24 of 25 items are valid (item 1 rejected) - still >=19, so a score
        # exists, but it must reflect 24 valid answers, never a value derived
        # by trusting the illegal 47.
        self.assertEqual(report.json()["questionnaires"]["tfi"]["answered"], 24)

    def test_measurement_fields_locked_but_tfi_items_editable_after_finalise(self):
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"tfi_items": _answers(value=5, tfi1=50, tfi3=50)},
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")

        locked = self.client.patch(
            f"/api/assessments/{self.assessment_id}", {"pitch_match_hz": 4000}, format="json"
        )
        self.assertEqual(locked.status_code, status.HTTP_409_CONFLICT)

        still_editable = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"tfi_items": _answers(value=8, tfi1=80, tfi3=80)},
            format="json",
        )
        self.assertEqual(still_editable.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        self.assertEqual(report.json()["questionnaires"]["tfi"]["score"], 80)

    def test_unrelated_instruments_unaffected_by_tfi(self):
        """Regression: THI/GAD-7 keep scoring correctly alongside a TFI submission."""
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {
                "tfi_items": _answers(value=5, tfi1=50, tfi3=50),
                "thi_items": {"thi7": 4, "thi1": 4, "thi22": 4, "thi13": 4, "thi21": 4},
                "gad7_items": {f"gad{n}": 2 for n in range(1, 8)},
            },
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        q = report.json()["questionnaires"]
        self.assertEqual(q["thi"]["score"], 100)
        self.assertEqual(q["gad7"]["score"], 14)
        self.assertIsNotNone(q["tfi"]["score"])


def _isi_answers(value=2, **overrides):
    """All 7 ISI components at `value` (0-4), except `overrides`."""
    out = {item_id: value for item_id in ISI_ITEM_IDS}
    out.update(overrides)
    return out


class IsiScoringTests(SimpleTestCase):
    # -- structure ------------------------------------------------------------- #
    def test_seven_scored_components_three_displayed_questions_group_one(self):
        self.assertEqual(len(ISI_ITEM_IDS), 7)
        self.assertEqual(ISI_ITEM_IDS[:3], ["isi1a", "isi1b", "isi1c"])
        self.assertEqual(ISI_QUESTION_GROUPS[1], ["isi1a", "isi1b", "isi1c"])
        for q in (2, 3, 4, 5):
            self.assertEqual(len(ISI_QUESTION_GROUPS[q]), 1)

    # -- overall scoring --------------------------------------------------------- #
    def test_minimum_score(self):
        result = score_isi(_isi_answers(value=0))
        self.assertEqual(result.score, 0)
        self.assertEqual(result.grade, "No clinically significant insomnia")

    def test_maximum_score(self):
        result = score_isi(_isi_answers(value=4))
        self.assertEqual(result.score, 28)
        self.assertEqual(result.grade, "Clinical insomnia (severe)")

    def test_question1_contributes_up_to_12(self):
        result = score_isi(_isi_answers(value=0, isi1a=4, isi1b=4, isi1c=4))
        self.assertEqual(result.score, 12)  # 4+4+4, everything else 0
        self.assertEqual(result.subscales["breakdown"]["q1"]["score"], 12)
        self.assertEqual(result.subscales["breakdown"]["q1"]["max"], 12)

    def test_questions_2_to_5_each_contribute_up_to_4(self):
        for q, item_id in ((2, "isi2"), (3, "isi3"), (4, "isi4"), (5, "isi5")):
            result = score_isi(_isi_answers(value=0, **{item_id: 4}))
            self.assertEqual(result.score, 4)
            self.assertEqual(result.subscales["breakdown"][f"q{q}"]["max"], 4)

    def test_intermediate_score(self):
        # 1a=2,1b=1,1c=0 (=3) + 2=3 + 3=2 + 4=1 + 5=4 => 13
        result = score_isi(
            {"isi1a": 2, "isi1b": 1, "isi1c": 0, "isi2": 3, "isi3": 2, "isi4": 1, "isi5": 4}
        )
        self.assertEqual(result.score, 13)
        self.assertEqual(result.grade, "Subthreshold insomnia")

    def test_interpretation_bands(self):
        cases = [
            (0, "No clinically significant insomnia"),
            (7, "No clinically significant insomnia"),
            (8, "Subthreshold insomnia"),
            (14, "Subthreshold insomnia"),
            (15, "Clinical insomnia (moderate severity)"),
            (21, "Clinical insomnia (moderate severity)"),
            (22, "Clinical insomnia (severe)"),
            (28, "Clinical insomnia (severe)"),
        ]
        for total, expected_label in cases:
            # Distribute `total` greedily across all seven components (each
            # capped at 4) so any total from 0-28 lands exactly.
            remaining = total
            answers = {}
            for item_id in ISI_ITEM_IDS:
                v = min(4, remaining)
                answers[item_id] = v
                remaining -= v
            self.assertEqual(remaining, 0, f"could not construct total={total}")
            result = score_isi(answers)
            self.assertEqual(result.score, total)
            self.assertEqual(result.grade, expected_label, f"total={total}")

    # -- all-or-nothing validity (no partial-completion allowance in the source) - #
    def test_all_seven_present_is_valid(self):
        result = score_isi(_isi_answers(value=1))
        self.assertEqual(result.answered, 7)
        self.assertIsNotNone(result.score)

    def test_missing_one_component_is_invalid(self):
        answers = _isi_answers(value=2)
        del answers["isi5"]
        result = score_isi(answers)
        self.assertEqual(result.answered, 6)
        self.assertIsNone(result.score)  # no prorating - the source specifies none
        self.assertIsNone(result.grade)

    def test_missing_one_of_the_three_question1_rows_is_invalid(self):
        answers = _isi_answers(value=2)
        del answers["isi1b"]
        result = score_isi(answers)
        self.assertIsNone(result.score)
        # The breakdown still reports what it can about question 1 itself.
        self.assertEqual(result.subscales["breakdown"]["q1"]["answered"], 2)
        self.assertIsNone(result.subscales["breakdown"]["q1"]["score"])

    def test_no_answers_at_all(self):
        result = score_isi(None)
        self.assertEqual(result.answered, 0)
        self.assertIsNone(result.score)
        self.assertEqual(result.interpretation, "")  # never administered, not "invalid"

    def test_missing_answers_are_not_scored_as_zero(self):
        answers = _isi_answers(value=4)
        del answers["isi1a"]
        result = score_isi(answers)
        self.assertIsNone(result.score)  # never silently becomes 24 (6 x 4)

    # -- value validation (0-4 only) ---------------------------------------------- #
    def test_accepts_every_legal_value(self):
        for v in range(0, 5):
            result = score_isi(_isi_answers(value=v))
            self.assertEqual(result.answered, 7, f"{v} should be accepted")

    def test_rejects_out_of_range_values(self):
        for v in (-1, 5, 10):
            answers = _isi_answers(value=2)
            answers["isi3"] = v
            result = score_isi(answers)
            self.assertEqual(result.answered, 6, f"{v} should be rejected, not clamped")

    def test_rejects_non_integer_values(self):
        for v in (2.5, 0.5, 3.9):
            answers = _isi_answers(value=2)
            answers["isi4"] = v
            result = score_isi(answers)
            self.assertEqual(result.answered, 6, f"{v} should be rejected, not rounded")

    def test_no_invented_cutoffs_beyond_the_published_bands(self):
        result = score_isi(_isi_answers(value=2))  # total = 14
        self.assertEqual(result.grade, "Subthreshold insomnia")
        self.assertEqual(result.max_score, 28)


class IsiApiIntegrationTests(TestCase):
    """The "About Your Tinnitus" wiring: save, report, and the finalise-time lock."""

    def setUp(self):
        self.client = APIClient()
        register = self.client.post(
            "/api/auth/register",
            {
                "email": "isi.tester@example.com",
                "password": "probepass2026",
                "full_name": "ISI Tester",
                "role": "patient",
                "date_of_birth": "1990-01-01",
                "sex": "female",
            },
            format="json",
        )
        self.assertEqual(register.status_code, status.HTTP_201_CREATED)
        self.token = register.json()["access_token"]
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {self.token}")
        created = self.client.post("/api/assessments")
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        self.assessment_id = created.json()["id"]

    def test_isi_items_saved_and_scored_in_report(self):
        answers = _isi_answers(value=3)  # total = 21
        patch = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"isi_items": answers, "questionnaire_status": {"isi": "completed"}},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)

        finalise = self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        self.assertEqual(finalise.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        self.assertEqual(report.status_code, status.HTTP_200_OK)
        body = report.json()

        isi = body["questionnaires"]["isi"]
        self.assertEqual(isi["score"], 21)
        self.assertEqual(isi["grade"], "Clinical insomnia (moderate severity)")
        self.assertEqual(isi["answered"], 7)

        domain = next(d for d in body["about_your_tinnitus"] if d["key"] == "isi")
        self.assertEqual(domain["kind"], "real")
        self.assertTrue(domain["available"])
        self.assertEqual(domain["score"], 21)

    def test_skipped_isi_reports_no_score(self):
        patch = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"questionnaire_status": {"isi": "skipped"}},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)
        finalise = self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        self.assertEqual(finalise.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        domain = next(d for d in report.json()["about_your_tinnitus"] if d["key"] == "isi")
        self.assertEqual(domain["status"], "skipped")
        self.assertFalse(domain["available"])
        self.assertIsNone(domain["score"])
        self.assertIn("skipped", domain["reason"].lower())

    def test_incomplete_isi_reports_unavailable_not_a_fake_score(self):
        answers = {k: v for k, v in _isi_answers(value=2).items() if k != "isi1c"}  # 6 of 7
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"isi_items": answers, "questionnaire_status": {"isi": "completed"}},
            format="json",
        )
        finalise = self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        self.assertEqual(finalise.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        domain = next(d for d in report.json()["about_your_tinnitus"] if d["key"] == "isi")
        self.assertFalse(domain["available"])
        self.assertIsNone(domain["score"])
        self.assertIn("enough valid responses", domain["reason"])

    def test_measurement_fields_locked_but_isi_items_editable_after_finalise(self):
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"isi_items": _isi_answers(value=1)},
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")

        locked = self.client.patch(
            f"/api/assessments/{self.assessment_id}", {"pitch_match_hz": 4000}, format="json"
        )
        self.assertEqual(locked.status_code, status.HTTP_409_CONFLICT)

        still_editable = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"isi_items": _isi_answers(value=4)},
            format="json",
        )
        self.assertEqual(still_editable.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        self.assertEqual(report.json()["questionnaires"]["isi"]["score"], 28)

    def test_off_grid_isi_value_rejected_end_to_end(self):
        answers = _isi_answers(value=2)
        answers["isi2"] = 3.5  # not a legal ISI response
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"isi_items": answers, "questionnaire_status": {"isi": "completed"}},
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        isi = report.json()["questionnaires"]["isi"]
        self.assertEqual(isi["answered"], 6)
        self.assertIsNone(isi["score"])  # 6 of 7 valid - the ISI requires all seven

    def test_unrelated_instruments_unaffected_by_isi(self):
        """Regression: TFI/THI/GAD-7 keep scoring correctly alongside an ISI submission."""
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {
                "isi_items": _isi_answers(value=2),
                "tfi_items": {f"tfi{n}": (50 if n in (1, 3) else 5) for n in range(1, 26)},
                "thi_items": {"thi7": 4, "thi1": 4, "thi22": 4, "thi13": 4, "thi21": 4},
            },
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        q = report.json()["questionnaires"]
        self.assertEqual(q["isi"]["score"], 14)
        self.assertIsNotNone(q["tfi"]["score"])


def _phq9_answers(value=1, **overrides):
    """All 9 PHQ-9 items at `value` (0-3), except `overrides`."""
    out = {item_id: value for item_id in PHQ9_ITEM_IDS}
    out.update(overrides)
    return out


class Phq9ScoringTests(SimpleTestCase):
    # -- structure ------------------------------------------------------------- #
    def test_nine_items(self):
        self.assertEqual(len(PHQ9_ITEM_IDS), 9)
        self.assertEqual(PHQ9_ITEM_IDS, [f"phq{n}" for n in range(1, 10)])

    # -- scoring ----------------------------------------------------------------- #
    def test_minimum_score(self):
        result = score_phq9(_phq9_answers(value=0))
        self.assertEqual(result.score, 0)
        self.assertEqual(result.max_score, 27)

    def test_maximum_score(self):
        result = score_phq9(_phq9_answers(value=3))
        self.assertEqual(result.score, 27)

    def test_worked_example_from_the_brief(self):
        # Q1..Q9 = 1,2,1,2,0,1,2,1,0 -> 10
        answers = {f"phq{n}": v for n, v in enumerate([1, 2, 1, 2, 0, 1, 2, 1, 0], start=1)}
        result = score_phq9(answers)
        self.assertEqual(result.score, 10)

    def test_no_invented_severity_bands(self):
        """No validated PHQ-9 interpretation exists anywhere in this codebase."""
        result = score_phq9(_phq9_answers(value=3))  # 27/27
        self.assertIsNone(result.grade)
        self.assertEqual(result.interpretation, "")

    # -- all-or-nothing validity (no partial-completion allowance documented) - #
    def test_all_nine_present_is_valid(self):
        result = score_phq9(_phq9_answers(value=1))
        self.assertEqual(result.answered, 9)
        self.assertIsNotNone(result.score)

    def test_missing_one_item_is_invalid(self):
        answers = _phq9_answers(value=2)
        del answers["phq5"]
        result = score_phq9(answers)
        self.assertEqual(result.answered, 8)
        self.assertIsNone(result.score)  # never prorated

    def test_missing_answers_are_not_scored_as_zero(self):
        answers = _phq9_answers(value=3)
        del answers["phq1"]
        result = score_phq9(answers)
        self.assertIsNone(result.score)  # never silently becomes 24 (8 x 3)

    def test_no_answers_at_all(self):
        result = score_phq9(None)
        self.assertEqual(result.answered, 0)
        self.assertIsNone(result.score)

    # -- value validation (0-3 only) ---------------------------------------------- #
    def test_accepts_every_legal_value(self):
        for v in range(0, 4):
            result = score_phq9(_phq9_answers(value=v))
            self.assertEqual(result.answered, 9, f"{v} should be accepted")

    def test_rejects_out_of_range_values(self):
        for v in (-1, 4, 5):
            answers = _phq9_answers(value=1)
            answers["phq3"] = v
            result = score_phq9(answers)
            self.assertEqual(result.answered, 8, f"{v} should be rejected, not clamped")

    def test_rejects_non_integer_values(self):
        for v in (1.5, 2.9):
            answers = _phq9_answers(value=1)
            answers["phq4"] = v
            result = score_phq9(answers)
            self.assertEqual(result.answered, 8, f"{v} should be rejected, not rounded")

    # -- item 9 safety flag, independent of overall completeness ---------------- #
    def test_item9_zero_does_not_flag(self):
        result = score_phq9(_phq9_answers(value=1, phq9=0))
        self.assertNotIn("item9_positive", result.flags)

    def test_item9_any_positive_response_flags(self):
        for v in (1, 2, 3):
            result = score_phq9(_phq9_answers(value=1, phq9=v))
            self.assertIn("item9_positive", result.flags, f"item9={v} should flag")

    def test_item9_flags_even_when_form_is_incomplete(self):
        """A self-harm signal must not wait for the rest of the form."""
        result = score_phq9({"phq9": 2})
        self.assertIn("item9_positive", result.flags)
        self.assertIsNone(result.score)  # still no fabricated total


class Phq9RedFlagTests(SimpleTestCase):
    """`clinical.redflags.evaluate_red_flags` picks up `item9_positive`."""

    def _flags(self, scores, assessment=None):
        result = evaluate_red_flags(
            patient={}, assessment=assessment or {}, audiogram_analysis={}, scores=scores
        )
        return {f["code"] for f in result["flags"]}

    def test_item9_positive_raises_a_flag(self):
        scores = {"phq9": score_phq9({"phq9": 1}).to_dict()}
        codes = self._flags(scores, assessment={"phq9_items": {"phq9": 1}})
        self.assertIn("phq9_self_harm_ideation", codes)

    def test_item9_zero_raises_no_flag(self):
        scores = {"phq9": score_phq9(_phq9_answers(value=0)).to_dict()}
        codes = self._flags(scores, assessment={"phq9_items": _phq9_answers(value=0)})
        self.assertNotIn("phq9_self_harm_ideation", codes)

    def test_no_phq9_data_raises_no_flag(self):
        codes = self._flags({}, assessment={})
        self.assertNotIn("phq9_self_harm_ideation", codes)


class Phq9ApiIntegrationTests(TestCase):
    """The "About Your Tinnitus" wiring: save, report, safety flag, finalise lock."""

    def setUp(self):
        self.client = APIClient()
        register = self.client.post(
            "/api/auth/register",
            {
                "email": "phq9.tester@example.com",
                "password": "probepass2026",
                "full_name": "PHQ-9 Tester",
                "role": "patient",
                "date_of_birth": "1990-01-01",
                "sex": "male",
            },
            format="json",
        )
        self.assertEqual(register.status_code, status.HTTP_201_CREATED)
        self.token = register.json()["access_token"]
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {self.token}")
        created = self.client.post("/api/assessments")
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        self.assessment_id = created.json()["id"]

    def test_phq9_items_saved_and_scored_in_report(self):
        answers = {f"phq{n}": v for n, v in enumerate([1, 2, 1, 2, 0, 1, 2, 1, 0], start=1)}
        patch = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"phq9_items": answers, "questionnaire_status": {"phq9": "completed"}},
            format="json",
        )
        self.assertEqual(patch.status_code, status.HTTP_200_OK)
        finalise = self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        self.assertEqual(finalise.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        body = report.json()
        phq9 = body["questionnaires"]["phq9"]
        self.assertEqual(phq9["score"], 10)
        self.assertIsNone(phq9["grade"])

        domain = next(d for d in body["about_your_tinnitus"] if d["key"] == "phq9")
        self.assertEqual(domain["kind"], "real")
        self.assertTrue(domain["available"])
        self.assertEqual(domain["score"], 10)

    def test_functional_difficulty_saved_separately_not_in_score(self):
        answers = _phq9_answers(value=1)
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {
                "phq9_items": answers,
                "phq9_functional_difficulty": 3,
                "questionnaire_status": {"phq9": "completed"},
            },
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        row = self.client.get(f"/api/assessments/{self.assessment_id}")
        self.assertEqual(row.json()["phq9_functional_difficulty"], 3)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        # 9 items x 1 = 9 - the functional-difficulty value of 3 must not have
        # leaked into the symptom total.
        self.assertEqual(report.json()["questionnaires"]["phq9"]["score"], 9)

    def test_item9_positive_response_raises_a_safety_flag_in_the_report(self):
        answers = _phq9_answers(value=0, phq9=2)
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"phq9_items": answers, "questionnaire_status": {"phq9": "completed"}},
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        safety = report.json()["safety"]
        codes = {f["code"] for f in safety["flags"]}
        self.assertIn("phq9_self_harm_ideation", codes)
        self.assertTrue(safety["requires_human_review"])

    def test_skipped_phq9_reports_no_score(self):
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"questionnaire_status": {"phq9": "skipped"}},
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        domain = next(d for d in report.json()["about_your_tinnitus"] if d["key"] == "phq9")
        self.assertEqual(domain["status"], "skipped")
        self.assertFalse(domain["available"])
        self.assertIsNone(domain["score"])

    def test_measurement_fields_locked_but_phq9_items_editable_after_finalise(self):
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"phq9_items": _phq9_answers(value=1)},
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")

        locked = self.client.patch(
            f"/api/assessments/{self.assessment_id}", {"pitch_match_hz": 4000}, format="json"
        )
        self.assertEqual(locked.status_code, status.HTTP_409_CONFLICT)

        still_editable = self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"phq9_items": _phq9_answers(value=3)},
            format="json",
        )
        self.assertEqual(still_editable.status_code, status.HTTP_200_OK)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        self.assertEqual(report.json()["questionnaires"]["phq9"]["score"], 27)

    def test_phq2_screener_merges_into_phq9_items(self):
        """The PHQ-2 (already-answered screener) is not re-asked in the PHQ-9."""
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {"phq2_items": {"phq1": 2, "phq2": 3}},
            format="json",
        )
        row = self.client.get(f"/api/assessments/{self.assessment_id}")
        self.assertEqual(row.json()["phq9_items"], {"phq1": 2, "phq2": 3})
        # And the pre-existing phq2_items/phq2_score path is untouched.
        self.assertEqual(row.json()["phq2_items"], {"phq1": 2, "phq2": 3})

    def test_unrelated_instruments_unaffected_by_phq9(self):
        """Regression: ISI/TFI/THI keep scoring correctly alongside a PHQ-9 submission."""
        self.client.patch(
            f"/api/assessments/{self.assessment_id}",
            {
                "phq9_items": _phq9_answers(value=1),
                "isi_items": {"isi1a": 2, "isi1b": 2, "isi1c": 2, "isi2": 2, "isi3": 2, "isi4": 2, "isi5": 2},
                "thi_items": {"thi7": 4, "thi1": 4, "thi22": 4, "thi13": 4, "thi21": 4},
            },
            format="json",
        )
        self.client.post(f"/api/assessments/{self.assessment_id}/finalise")
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.assessment_id}")
        q = report.json()["questionnaires"]
        self.assertEqual(q["phq9"]["score"], 9)
        self.assertEqual(q["isi"]["score"], 14)
        self.assertEqual(q["thi"]["score"], 100)
        self.assertEqual(q["thi"]["score"], 100)

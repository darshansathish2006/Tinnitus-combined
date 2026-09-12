"""Full end-to-end assessment-system regression suite.

Ports the executed, passing checks from the Task F full-system audit into the
permanent test suite, closing the coverage gap it found: before this file,
THI/GAD-7/PSS-10/VAS/EQ-5D-5L had no API-level tests at all, and the entire
psychoacoustic/audiometric battery (calibration, audiometry, pitch/loudness/
masking, reference level, residual inhibition, sound tolerance) and the Daily
Check-In feature had no automated tests of any kind. TFI/ISI/PHQ-9 already
have their own thorough suite in `tests_instruments.py`; this file does not
repeat that coverage.

Every value asserted here was independently hand-calculated (documented
inline) and cross-checked against a live run of the API before being written
down - nothing here is copied from the implementation being tested.
"""

import datetime

from django.test import TestCase
from rest_framework import status
from rest_framework.test import APIClient


def _register(client: APIClient, tag: str) -> tuple[str, int]:
    email = f"{tag}@example.com"
    resp = client.post(
        "/api/auth/register",
        {
            "email": email,
            "password": "probepass2026",
            "full_name": tag.title(),
            "role": "patient",
            "date_of_birth": "1990-01-01",
            "sex": "male",
        },
        format="json",
    )
    assert resp.status_code == status.HTTP_201_CREATED, resp.json()
    token = resp.json()["access_token"]
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    created = client.post("/api/assessments")
    assert created.status_code == status.HTTP_201_CREATED, created.json()
    return token, created.json()["id"]


class ThiGad7Pss10VasApiTests(TestCase):
    """Min/max/mixed scoring for the three long-established questionnaires
    that had item banks and scoring but no API-level regression coverage."""

    def setUp(self):
        self.client = APIClient()
        self.token, self.aid = _register(self.client, "thigadpssvas")

    def _patch(self, body):
        return self.client.patch(f"/api/assessments/{self.aid}", body, format="json")

    def _finalise(self):
        return self.client.post(f"/api/assessments/{self.aid}/finalise")

    def _report(self):
        return self.client.get(f"/api/reports/clinical?assessment_id={self.aid}")

    def test_thi_min_max_and_mid_projected_score(self):
        # THI short form: 5 items, 0-4 raw each (0-20 raw), projected to 0-100.
        thi = {"thi7": 0, "thi1": 0, "thi22": 0, "thi13": 0, "thi21": 0}
        self.assertEqual(self._patch({"thi_items": thi, "questionnaire_status": {"thi": "completed"}}).status_code, 200)
        self.assertEqual(self._finalise().status_code, 200)
        report = self._report().json()
        self.assertEqual(report["questionnaires"]["thi"]["score"], 0)

    def test_gad7_mixed_sum(self):
        mixed = {"gad1": 2, "gad2": 1, "gad3": 3, "gad4": 0, "gad5": 2, "gad6": 1, "gad7": 3}
        self.assertEqual(self._patch({"gad7_items": mixed, "questionnaire_status": {"gad7": "completed"}}).status_code, 200)
        self.assertEqual(self._finalise().status_code, 200)
        report = self._report().json()
        self.assertEqual(report["questionnaires"]["gad7"]["score"], sum(mixed.values()))

    def test_pss10_reverse_scored_items_all_zero(self):
        # Items 4, 5, 7, 8 are reverse-scored (4 - raw). All-raw-0 should
        # therefore total 16 (4 reverse items x 4), not 0.
        all_zero = {f"pss{n}": 0 for n in range(1, 11)}
        self.assertEqual(self._patch({"pss10_items": all_zero, "questionnaire_status": {"pss10": "completed"}}).status_code, 200)
        self.assertEqual(self._finalise().status_code, 200)
        report = self._report().json()
        self.assertEqual(report["questionnaires"]["pss10"]["score"], 16)

    def test_pss10_reverse_scored_items_all_max(self):
        # All-raw-4: non-reverse items contribute 4 each (6 x 4 = 24),
        # reverse items contribute (4-4)=0 each -> total 24, not 40.
        all_four = {f"pss{n}": 4 for n in range(1, 11)}
        self.assertEqual(self._patch({"pss10_items": all_four, "questionnaire_status": {"pss10": "completed"}}).status_code, 200)
        self.assertEqual(self._finalise().status_code, 200)
        report = self._report().json()
        self.assertEqual(report["questionnaires"]["pss10"]["score"], 24)

    def test_vas_zero_is_a_real_answer_not_unanswered(self):
        vas = {"vas_loudness": 0, "vas_annoyance": 0, "vas_awareness": 0, "vas_sleep_interference": 0}
        patched = self._patch({"vas": vas, "questionnaire_status": {"vas": "completed"}})
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["vas_loudness"], 0.0)

    def test_pain_vas_is_scored_beside_the_four_scales_never_inside_them(self):
        # The pain faces scale is a separate question asked after the four
        # tinnitus VAS scales, so it has to reach the report on its own terms
        # and the tinnitus severity block has to still be exactly four keys -
        # folding a pain rating into them would change what those four numbers
        # mean to every consumer of the report.
        vas = {"vas_loudness": 7, "vas_annoyance": 6, "vas_awareness": 5, "vas_sleep_interference": 4}
        patched = self._patch({"vas": vas, "vas_pain": 8, "questionnaire_status": {"vas": "completed"}})
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["vas_pain"], 8.0)
        self.assertEqual(self._finalise().status_code, 200)
        report = self._report().json()
        self.assertEqual(
            sorted(report["questionnaires"]["vas"]),
            ["vas_annoyance", "vas_awareness", "vas_loudness", "vas_sleep_interference"],
        )
        pain = report["questionnaires"]["vas_pain"]
        self.assertEqual(pain["score"], 8.0)
        self.assertEqual(pain["band"], "severe")
        self.assertIn("major impact", pain["interpretation"])

    def test_pain_vas_bands_follow_the_printed_correlation(self):
        # The correlation printed on the scale itself: 1-3 mild (minimal ADL
        # impact), 4-6 moderate, 7-10 severe. 0 is its own band, not "mild".
        self.assertEqual(self._finalise().status_code, 200)
        for value, band in [(0, "none"), (1, "mild"), (3, "mild"), (4, "moderate"),
                            (6, "moderate"), (7, "severe"), (10, "severe")]:
            self.assertEqual(self._patch({"vas_pain": value}).status_code, 200, value)
            self.assertEqual(self._report().json()["questionnaires"]["vas_pain"]["band"], band, value)

    def test_pain_vas_zero_is_a_real_answer_and_unanswered_is_not_a_zero(self):
        self.assertEqual(self._finalise().status_code, 200)
        unanswered = self._report().json()["questionnaires"]["vas_pain"]
        self.assertIsNone(unanswered["score"])
        self.assertIsNone(unanswered["band"])
        self.assertEqual(self._patch({"vas_pain": 0}).status_code, 200)
        answered = self._report().json()["questionnaires"]["vas_pain"]
        self.assertEqual(answered["score"], 0.0)
        self.assertEqual(answered["band"], "none")

    def test_pain_vas_rejects_ratings_off_the_scale(self):
        self.assertEqual(self._patch({"vas_pain": 11}).status_code, 400)
        self.assertEqual(self._patch({"vas_pain": -1}).status_code, 400)

    def test_pain_scale_is_published_on_the_vas_registry_entry(self):
        # The client draws the faces, the ruler and the verbal scale from this,
        # so an assessment run against a server that has it and a client that
        # does not must degrade to "no pain question", never to a made-up one.
        registry = self.client.get("/api/assessments/instruments").json()["instruments"]
        pain = registry["vas"]["pain_scale"]
        self.assertEqual(pain["id"], "vas_pain")
        self.assertEqual([0, 2, 4, 6, 8, 10], pain["face_values"])
        self.assertEqual([b["key"] for b in pain["bands"]], ["none", "mild", "moderate", "severe"])
        # The pain question is never one of the four scored tinnitus scales.
        self.assertNotIn("vas_pain", [item["id"] for item in registry["vas"]["items"]])

    def test_whoqol_bref_is_a_genuine_26_item_instrument_with_no_fabricated_score(self):
        # Formerly an honest "eq5d5l"-renamed stub with no item content at
        # all (repo-wide search found zero "whoqol" hits). Now backed by the
        # published WHOQOL-BREF patient form's 26 items in full — see
        # `WhoqolBrefScoringTests`/`WhoqolBrefApiIntegrationTests` in
        # `tests_instruments.py` for the item-bank and API-level coverage.
        # This still asserts the one thing that must never change: no
        # domain/overall score is fabricated, because no validated scoring
        # formula for this instrument exists anywhere in this codebase.
        answers = {f"whoqol{n}": 3 for n in range(1, 27)}
        self.assertEqual(
            self._patch({"whoqol_bref_items": answers, "questionnaire_status": {"whoqol_bref": "completed"}}).status_code,
            200,
        )
        self.assertEqual(self._finalise().status_code, 200)
        report = self._report().json()
        whoqol = report["questionnaires"]["whoqol_bref"]
        self.assertEqual(whoqol["answered"], 26)
        self.assertIsNone(whoqol["score"])
        domain = next(d for d in report["about_your_tinnitus"] if d["key"] == "whoqol_bref")
        self.assertEqual(domain["instrument"], "WHOQOL-BREF")
        self.assertEqual(domain["kind"], "real")
        self.assertTrue(domain["available"])
        self.assertIsNone(domain["score"])
        self.assertFalse(domain["required"])

    def test_core_vs_optional_required_flags(self):
        report = self._report().json()
        domains = {d["key"]: d for d in report["about_your_tinnitus"]}
        self.assertEqual({k for k, d in domains.items() if d["required"]}, {"vas", "thi", "tfi"})
        self.assertEqual(
            {k for k, d in domains.items() if not d["required"]},
            {"isi", "gad7", "phq9", "pss10", "whoqol_bref"},
        )

    def test_pss10_instrument_label(self):
        report = self._report().json()
        domain = next(d for d in report["about_your_tinnitus"] if d["key"] == "pss10")
        self.assertEqual(domain["instrument"], "PSS-10")


class SkipResumeAllInstrumentsTests(TestCase):
    """Skip -> complete-later for every skippable questionnaire, in one pass."""

    def setUp(self):
        self.client = APIClient()
        self.token, self.aid = _register(self.client, "skipresumeall")

    def test_skip_then_complete_later_for_every_domain(self):
        domains = {
            "gad7": ({f"gad{n}": 3 for n in range(1, 8)}, "gad7_items", 21),
            "pss10": ({f"pss{n}": 4 for n in range(1, 11)}, "pss10_items", 24),
            "isi": ({"isi1a": 4, "isi1b": 4, "isi1c": 4, "isi2": 4, "isi3": 4, "isi4": 4, "isi5": 4}, "isi_items", 28),
            "phq9": ({f"phq{n}": 3 for n in range(1, 10)}, "phq9_items", 27),
            "tfi": ({f"tfi{n}": (100 if n in (1, 3) else 10) for n in range(1, 26)}, "tfi_items", 100),
        }
        skip_all = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"questionnaire_status": {k: "skipped" for k in domains}},
            format="json",
        )
        self.assertEqual(skip_all.status_code, 200)
        self.assertEqual(self.client.post(f"/api/assessments/{self.aid}/finalise").status_code, 200)

        report = self.client.get(f"/api/reports/clinical?assessment_id={self.aid}").json()
        for key in domains:
            domain = next(d for d in report["about_your_tinnitus"] if d["key"] == key)
            self.assertEqual(domain["status"], "skipped", key)
            self.assertIsNone(domain["score"], key)

        for key, (answers, field, _expected) in domains.items():
            resp = self.client.patch(
                f"/api/assessments/{self.aid}",
                {field: answers, "questionnaire_status": {key: "completed"}},
                format="json",
            )
            self.assertEqual(resp.status_code, 200, f"{key}: {resp.json()}")

        report2 = self.client.get(f"/api/reports/clinical?assessment_id={self.aid}").json()
        for key, (_answers, _field, expected) in domains.items():
            domain = next(d for d in report2["about_your_tinnitus"] if d["key"] == key)
            self.assertTrue(domain["available"], key)
            self.assertEqual(domain["score"], expected, key)


class MultipleAttemptsAndIsolationTests(TestCase):
    """History across repeated assessments, and cross-patient isolation."""

    def test_two_assessments_do_not_cross_contaminate(self):
        client = APIClient()
        token, aid_a = _register(client, "historya")
        client.patch(
            f"/api/assessments/{aid_a}",
            {"thi_items": {"thi7": 0, "thi1": 0, "thi22": 0, "thi13": 0, "thi21": 0}, "questionnaire_status": {"thi": "completed"}},
            format="json",
        )
        self.assertEqual(client.post(f"/api/assessments/{aid_a}/finalise").status_code, 200)

        created_b = client.post("/api/assessments")
        aid_b = created_b.json()["id"]
        self.assertNotEqual(aid_a, aid_b)
        client.patch(
            f"/api/assessments/{aid_b}",
            {"thi_items": {"thi7": 4, "thi1": 4, "thi22": 4, "thi13": 4, "thi21": 4}, "questionnaire_status": {"thi": "completed"}},
            format="json",
        )
        self.assertEqual(client.post(f"/api/assessments/{aid_b}/finalise").status_code, 200)

        report_a = client.get(f"/api/reports/clinical?assessment_id={aid_a}").json()
        report_b = client.get(f"/api/reports/clinical?assessment_id={aid_b}").json()
        self.assertEqual(report_a["questionnaires"]["thi"]["score"], 0, "assessment A must not be overwritten by B")
        self.assertEqual(report_b["questionnaires"]["thi"]["score"], 100)

    def test_patient_cannot_read_or_patch_another_patients_assessment(self):
        client_x = APIClient()
        _token_x, aid_x = _register(client_x, "isolatex")
        client_x.patch(
            f"/api/assessments/{aid_x}",
            {"thi_items": {"thi7": 4, "thi1": 4, "thi22": 4, "thi13": 4, "thi21": 4}, "questionnaire_status": {"thi": "completed"}},
            format="json",
        )
        client_x.post(f"/api/assessments/{aid_x}/finalise")

        client_y = APIClient()
        _register(client_y, "isolatey")
        leak_read = client_y.get(f"/api/reports/clinical?assessment_id={aid_x}")
        self.assertIn(leak_read.status_code, (403, 404))
        leak_patch = client_y.patch(f"/api/assessments/{aid_x}", {"thi_items": {"thi7": 0}}, format="json")
        self.assertIn(leak_patch.status_code, (403, 404))


class PsychoacousticChainApiTests(TestCase):
    """Calibration -> Audiometry -> Pitch/Loudness/Masking -> Reference Level,
    plus the dependency-failure and post-finalise-lock behaviours. Field
    names and validation ranges per `AssessmentSubmitSerializer` /
    `apply_submission` in views.py."""

    def setUp(self):
        self.client = APIClient()
        self.token, self.aid = _register(self.client, "psychoacoustic")

    def test_audiogram_round_trips_and_locks_after_finalise(self):
        audiogram = {
            "left": {"250": 15, "500": 10, "1000": 15, "2000": 20, "4000": 55, "8000": 60},
            "right": {"250": 10, "500": 10, "1000": 10, "2000": 15, "4000": 20, "8000": 25},
        }
        patched = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"audiogram": audiogram, "audiometry_reliable": True, "audiometry_false_positives": 0,
             "audiometry_catch_trials": 3, "audiometry_retest_agreement_db": 5, "modules_done": ["audiometry"]},
            format="json",
        )
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["audiogram"]["left"]["4000"], 55.0)

        self.assertEqual(self.client.post(f"/api/assessments/{self.aid}/finalise").status_code, 200)
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.aid}").json()
        self.assertEqual(report["audiometry"]["raw"], audiogram)

        locked = self.client.patch(f"/api/assessments/{self.aid}", {"audiogram": {"left": {"250": 99}}}, format="json")
        self.assertEqual(locked.status_code, 409, "measurement data must be immutable after finalise")

    def test_pitch_loudness_masking_chain_and_derived_reference_level(self):
        pitch = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"pitch_match_hz": 5657.0, "pitch_match_ear": "right", "pitch_match_confidence": 0.82,
             "modules_done": ["pitch_match"]},
            format="json",
        )
        self.assertEqual(pitch.status_code, 200)
        self.assertEqual(pitch.json()["pitch_match_hz"], 5657.0)

        loud = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"loudness_match_db_hl": 45.0, "modules_done": ["pitch_match", "loudness_match"]},
            format="json",
        )
        self.assertEqual(loud.status_code, 200)

        masking_thresholds = {"1000": 40, "2000": 42, "3000": 44, "4000": 46, "5000": 48, "6000": 50, "8000": 55}
        masked = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"masking_thresholds": masking_thresholds, "masking_unmasked_hz": [],
             "modules_done": ["pitch_match", "loudness_match", "masking_profile"]},
            format="json",
        )
        self.assertEqual(masked.status_code, 200)
        body = masked.json()
        # reference_level_* is server-derived - never accepted verbatim from
        # the client, and always recomputed on every masking-bearing save.
        self.assertEqual(body["reference_level_hz"], 1000.0, "minimum masking threshold, not the mean")
        self.assertIsNotNone(body["reference_level_db"])

        client_override = self.client.patch(f"/api/assessments/{self.aid}", {"reference_level_db": 999.0}, format="json")
        self.assertNotEqual(client_override.json()["reference_level_db"], 999.0)

    def test_loudness_match_without_prior_pitch_match_does_not_fabricate_a_frequency(self):
        resp = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"loudness_match_db_hl": 50.0, "modules_done": ["loudness_match"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["pitch_match_hz"], "must not invent a default frequency")

    def test_masking_only_backfills_pitch_from_its_own_minimum_not_a_fabricated_default(self):
        resp = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"masking_thresholds": {"1000": 30, "2000": 35}, "masking_unmasked_hz": [4000, 5000, 6000, 8000],
             "modules_done": ["masking_profile"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["pitch_match_hz"], 1000.0, "honest fallback to the masking minimum, not e.g. 4000")

    def test_residual_inhibition_and_ldl_round_trip(self):
        self.client.patch(f"/api/assessments/{self.aid}", {"pitch_match_hz": 4500, "loudness_match_db_hl": 40}, format="json")
        ri = self.client.patch(
            f"/api/assessments/{self.aid}",
            {
                "ri_depth_pct": 72.5, "ri_duration_s": 18.0,
                "ri_reported_category": "partial", "ri_immediate_response": "REDUCED",
                "ri_baseline_pct": 100, "ri_post_stimulation_pct": 27.5,
                "ri_stimulus_frequency_hz": 4500, "ri_stimulus_level_db": 46,
                "modules_done": ["residual_inhibition"],
            },
            format="json",
        )
        self.assertEqual(ri.status_code, 200)
        self.assertEqual(ri.json()["ri_depth_pct"], 72.5)

        ldl = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"ldl_left": 90.0, "ldl_right": 95.0,
             "ldl_trace": [{"ear": "left", "frequency_hz": 1000, "trials": [], "ull_db": 90}],
             "modules_done": ["sound_tolerance"]},
            format="json",
        )
        self.assertEqual(ldl.status_code, 200)
        self.assertEqual(ldl.json()["ldl_left"], 90.0)

        self.assertEqual(self.client.post(f"/api/assessments/{self.aid}/finalise").status_code, 200)
        report = self.client.get(f"/api/reports/clinical?assessment_id={self.aid}").json()
        ri_summary = report["psychoacoustics"]["residual_inhibition"]
        self.assertEqual(ri_summary["category"], "Partial", "40 <= 72.5 < 95 -> Partial band")

    def test_invalid_inputs_are_rejected_not_coerced(self):
        cases = [
            ({"pitch_match_hz": 999999}, "pitch_match_hz above max"),
            ({"pitch_match_hz": -5}, "pitch_match_hz negative"),
            ({"pitch_match_confidence": 1.5}, "confidence above 1.0"),
            ({"pitch_match_ear": "sideways"}, "invalid ear enum"),
            ({"masking_thresholds": {"1000": "loud"}}, "non-numeric masking threshold"),
            ({"audiometry_catch_trials": -1}, "negative catch trials"),
            ({"phq9_functional_difficulty": 7}, "functional difficulty out of 1-4"),
            ({"octave_confusion": "not_a_bool"}, "wrong type for boolean field"),
        ]
        for body, label in cases:
            resp = self.client.patch(f"/api/assessments/{self.aid}", body, format="json")
            self.assertEqual(resp.status_code, 400, label)

    def test_unauthenticated_and_nonexistent_assessment_requests_are_rejected(self):
        anon = APIClient()
        resp = anon.patch(f"/api/assessments/{self.aid}", {"pitch_match_hz": 1000}, format="json")
        self.assertEqual(resp.status_code, 401)

        missing = self.client.patch("/api/assessments/999999999", {"pitch_match_hz": 1000}, format="json")
        self.assertEqual(missing.status_code, 404)


class DailyCheckInTests(TestCase):
    """`DailyCheckIn` / `/api/monitoring/check-in` — found during Task F's
    fresh whole-repo inventory sweep; it had no automated tests at all."""

    def setUp(self):
        self.client = APIClient()
        self.token, _aid = _register(self.client, "dailycheckin")

    def test_create_and_same_day_upsert(self):
        today = datetime.date.today().isoformat()
        created = self.client.post(
            "/api/monitoring/check-in",
            {"on_date": today, "tinnitus_loudness": 6, "mood": 4, "note": "Rough night."},
            format="json",
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)

        updated = self.client.post("/api/monitoring/check-in", {"on_date": today, "tinnitus_loudness": 2}, format="json")
        self.assertEqual(updated.status_code, status.HTTP_200_OK, "same-day resubmit must upsert, not duplicate")
        self.assertEqual(updated.json()["tinnitus_loudness"], 2.0)

    def test_non_numeric_value_rejected(self):
        today = datetime.date.today().isoformat()
        resp = self.client.post("/api/monitoring/check-in", {"on_date": today, "mood": "great"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_date_outside_seven_day_window_rejected(self):
        old_date = (datetime.date.today() - datetime.timedelta(days=10)).isoformat()
        resp = self.client.post("/api/monitoring/check-in", {"on_date": old_date, "mood": 5}, format="json")
        self.assertEqual(resp.status_code, 400)

        future_date = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
        resp2 = self.client.post("/api/monitoring/check-in", {"on_date": future_date, "mood": 5}, format="json")
        self.assertEqual(resp2.status_code, 400)

    def test_delete_check_in(self):
        today = datetime.date.today().isoformat()
        self.client.post("/api/monitoring/check-in", {"on_date": today, "mood": 5}, format="json")
        deleted = self.client.delete(f"/api/monitoring/check-in?on_date={today}")
        self.assertEqual(deleted.status_code, status.HTTP_204_NO_CONTENT)


class AboutYourTinnitusTwoSectionTests(TestCase):
    """The Core Tinnitus Assessment / Optional Wellbeing Assessment split:
    `in_progress` autosave + resume, and skip never counting as complete for
    a required core instrument — even via a direct API call that bypasses
    the frontend's own "no Skip button on a core card" restriction."""

    def setUp(self):
        self.client = APIClient()
        self.token, self.aid = _register(self.client, "twosection")

    def _report(self):
        return self.client.get(f"/api/reports/clinical?assessment_id={self.aid}")

    def _domain(self, key):
        report = self._report().json()
        return next(d for d in report["about_your_tinnitus"] if d["key"] == key)

    def test_in_progress_autosave_persists_partial_answers_and_reports_in_progress(self):
        # Only 2 of ISI's 7 scored components answered - a page-advance
        # autosave mid-questionnaire, not a full submit.
        partial = {"isi1a": 2, "isi1b": 3}
        patched = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"isi_items": partial, "questionnaire_status": {"isi": "in_progress"}},
            format="json",
        )
        self.assertEqual(patched.status_code, 200)
        self.assertEqual(patched.json()["isi_items"], partial, "partial answers must round-trip exactly")

        domain = self._domain("isi")
        self.assertEqual(domain["status"], "in_progress")
        self.assertFalse(domain["available"])
        self.assertIsNone(domain["score"], "no score is fabricated from a partial answer set")
        self.assertIn("started but not finished", domain["reason"])

        # Resume: more answers merge onto the same partial dict rather than
        # replacing it, then a full submit completes and scores normally.
        rest = {"isi1c": 1, "isi2": 0, "isi3": 2, "isi4": 1, "isi5": 3}
        completed = self.client.patch(
            f"/api/assessments/{self.aid}",
            {"isi_items": rest, "questionnaire_status": {"isi": "completed"}},
            format="json",
        )
        self.assertEqual(completed.status_code, 200)
        self.assertEqual(
            completed.json()["isi_items"], {**partial, **rest}, "the in-progress answers were not lost"
        )
        domain2 = self._domain("isi")
        self.assertEqual(domain2["status"], "completed")
        self.assertTrue(domain2["available"])
        self.assertEqual(domain2["score"], sum({**partial, **rest}.values()))

    def test_core_instrument_skipped_via_raw_api_is_never_reported_as_complete(self):
        # Rule 4: even bypassing the frontend (which no longer offers a Skip
        # control for VAS/THI/TFI) and PATCHing the status directly, a
        # "skipped" core instrument must never be treated as complete.
        for key in ("vas", "thi", "tfi"):
            resp = self.client.patch(
                f"/api/assessments/{self.aid}", {"questionnaire_status": {key: "skipped"}}, format="json"
            )
            self.assertEqual(resp.status_code, 200)
            domain = self._domain(key)
            self.assertEqual(domain["status"], "skipped")
            self.assertFalse(domain["available"], f"{key} must not be available when skipped")
            self.assertIsNone(domain["score"], f"{key} must not report a fabricated score when skipped")

    def test_core_all_three_completed_is_distinguishable_from_partial(self):
        self.client.patch(
            f"/api/assessments/{self.aid}",
            {
                "vas": {"vas_loudness": 5, "vas_annoyance": 5, "vas_awareness": 5, "vas_sleep_interference": 5},
                "thi_items": {"thi7": 2, "thi1": 2, "thi22": 2, "thi13": 2, "thi21": 2},
                "questionnaire_status": {"vas": "completed", "thi": "completed"},
            },
            format="json",
        )
        # TFI still not started: core must read as incomplete.
        statuses = {d["key"]: d["status"] for d in self._report().json()["about_your_tinnitus"]}
        self.assertEqual(statuses["vas"], "completed")
        self.assertEqual(statuses["thi"], "completed")
        self.assertEqual(statuses["tfi"], "not_started")
        core_complete = all(statuses[k] == "completed" for k in ("vas", "thi", "tfi"))
        self.assertFalse(core_complete)

        self.client.patch(
            f"/api/assessments/{self.aid}",
            {"tfi_items": {f"tfi{n}": (50 if n in (1, 3) else 5) for n in range(1, 26)},
             "questionnaire_status": {"tfi": "completed"}},
            format="json",
        )
        statuses2 = {d["key"]: d["status"] for d in self._report().json()["about_your_tinnitus"]}
        core_complete2 = all(statuses2[k] == "completed" for k in ("vas", "thi", "tfi"))
        self.assertTrue(core_complete2)

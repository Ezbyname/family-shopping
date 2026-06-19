"""
Pytest tests for the readiness validation pipeline.

Run from C:\\Codes\\family-shopping\\scripts:
    python -m pytest tests/ -v
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

# Make the parent (scripts/) importable without installing anything
sys.path.insert(0, str(Path(__file__).parent.parent))

from readiness_criteria import (
    run_all_validations,
    validate_automation_readiness_status_correct,
    validate_business_goal_present,
    validate_dynamic_counts_use_ranges,
    validate_human_required_marked_correctly,
    validate_important_results_have_validation_methods,
    validate_preconditions_clear,
    validate_registry_needs_mentioned,
    validate_result_classification_defined,
    validate_risks_documented,
    validate_test_data_documented,
    validate_test_data_stable,
    validate_all_steps_have_expected_results,
)
from readiness_decision import compute_decision
from readiness_report_generator import format_json_report, format_report

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_FIXTURES_DIR = Path(__file__).parent / "fixtures"
_SCRIPTS_DIR = Path(__file__).parent.parent
_CLI = _SCRIPTS_DIR / "validate_test_readiness.py"


def _load_fixture(name):
    with open(_FIXTURES_DIR / name, "r", encoding="utf-8") as f:
        return json.load(f)


# ===========================================================================
# Section 1: Individual validator smoke tests (pass + fail for all 12)
# ===========================================================================

class TestValidateBusinessGoalPresent:
    def test_pass_with_long_goal(self):
        tc = {"metadata": {"business_goal": "Verify cart total updates when items are added"}}
        is_valid, details = validate_business_goal_present(tc)
        assert is_valid is True
        assert details["criterion"] == "Business Goal Present"
        assert details["is_valid"] is True

    def test_fail_with_empty_goal(self):
        tc = {"metadata": {"business_goal": ""}}
        is_valid, details = validate_business_goal_present(tc)
        assert is_valid is False
        assert details["suggested_fix"] is not None

    def test_fail_with_short_goal(self):
        tc = {"metadata": {"business_goal": "Too short"}}
        is_valid, details = validate_business_goal_present(tc)
        assert is_valid is False

    def test_fail_with_missing_metadata(self):
        is_valid, details = validate_business_goal_present({})
        assert is_valid is False


class TestValidatePreconditionsClear:
    def test_pass_with_list_of_strings(self):
        tc = {"preconditions": ["User is logged in", "Cart is empty"]}
        is_valid, details = validate_preconditions_clear(tc)
        assert is_valid is True
        assert details["count"] == 2

    def test_fail_with_empty_list(self):
        tc = {"preconditions": []}
        is_valid, details = validate_preconditions_clear(tc)
        assert is_valid is False
        assert details["count"] == 0

    def test_fail_with_missing_field(self):
        is_valid, details = validate_preconditions_clear({})
        assert is_valid is False

    def test_fail_with_short_strings(self):
        tc = {"preconditions": ["Yes"]}
        is_valid, details = validate_preconditions_clear(tc)
        assert is_valid is False

    def test_severity_is_info(self):
        _, details = validate_preconditions_clear({})
        assert details["severity"] == "info"


class TestValidateTestDataDocumented:
    def test_pass_with_proper_dict(self):
        tc = {"test_data": {"price": {"value": 9.99}}}
        is_valid, details = validate_test_data_documented(tc)
        assert is_valid is True
        assert details["data_entries"] == 1

    def test_fail_with_empty_dict(self):
        tc = {"test_data": {}}
        is_valid, details = validate_test_data_documented(tc)
        assert is_valid is False

    def test_fail_with_missing_value_key(self):
        tc = {"test_data": {"price": {"amount": 9.99}}}
        is_valid, details = validate_test_data_documented(tc)
        assert is_valid is False

    def test_fail_with_missing_field(self):
        is_valid, details = validate_test_data_documented({})
        assert is_valid is False

    def test_severity_is_blocker(self):
        _, details = validate_test_data_documented({})
        assert details["severity"] == "blocker"


class TestValidateTestDataStable:
    def test_pass_when_stable_true(self):
        tc = {"test_data": {"price": {"value": 9.99, "stable": True}}}
        is_valid, details = validate_test_data_stable(tc)
        assert is_valid is True
        assert details["unstable_entries"] == []

    def test_pass_when_handling_provided(self):
        tc = {"test_data": {"count": {"value": 5, "stable": False, "handling": "Use range assertion"}}}
        is_valid, details = validate_test_data_stable(tc)
        assert is_valid is True

    def test_fail_when_stable_false_and_no_handling(self):
        tc = {"test_data": {"count": {"value": 5, "stable": False}}}
        is_valid, details = validate_test_data_stable(tc)
        assert is_valid is False
        assert "count" in details["unstable_entries"]

    def test_pass_with_empty_test_data(self):
        # No test data entries = nothing unstable
        tc = {"test_data": {}}
        is_valid, details = validate_test_data_stable(tc)
        assert is_valid is True

    def test_severity_is_info(self):
        # After fix: severity must be 'info', NOT 'blocker'
        tc = {"test_data": {"x": {"value": 1, "stable": False}}}
        _, details = validate_test_data_stable(tc)
        assert details["severity"] == "info"


class TestValidateAllStepsHaveExpectedResults:
    def test_pass_all_steps_have_expected_result(self):
        tc = {"steps": [
            {"action": "Click login", "expected_result": "Login page appears"},
        ]}
        is_valid, details = validate_all_steps_have_expected_results(tc)
        assert is_valid is True

    def test_fail_step_missing_expected_result(self):
        tc = {"steps": [
            {"action": "Click login", "expected_result": ""},
        ]}
        is_valid, details = validate_all_steps_have_expected_results(tc)
        assert is_valid is False
        assert 0 in details["steps_missing_results"]

    def test_pass_with_no_steps(self):
        is_valid, details = validate_all_steps_have_expected_results({})
        assert is_valid is True

    def test_severity_is_blocker(self):
        tc = {"steps": [{"action": "x", "expected_result": ""}]}
        _, details = validate_all_steps_have_expected_results(tc)
        assert details["severity"] == "blocker"


class TestValidateImportantResultsHaveValidationMethods:
    def test_pass_all_steps_have_validation_method(self):
        tc = {"steps": [
            {"action": "Click button", "expected_result": "Dialog appears", "validation_method": "Verify Content"},
        ]}
        is_valid, details = validate_important_results_have_validation_methods(tc)
        assert is_valid is True

    def test_fail_step_missing_validation_method(self):
        tc = {"steps": [
            {"action": "Click button", "expected_result": "Dialog appears"},
        ]}
        is_valid, details = validate_important_results_have_validation_methods(tc)
        assert is_valid is False
        assert 0 in details["steps_missing_methods"]

    def test_pass_human_required_step_exempt(self):
        tc = {"steps": [
            {"action": "Visually verify layout", "expected_result": "Looks good", "human_required": True},
        ]}
        is_valid, details = validate_important_results_have_validation_methods(tc)
        assert is_valid is True

    def test_severity_is_blocker(self):
        tc = {"steps": [{"action": "x", "expected_result": "y"}]}
        _, details = validate_important_results_have_validation_methods(tc)
        assert details["severity"] == "blocker"


class TestValidateHumanRequiredMarkedCorrectly:
    def test_pass_when_visual_keyword_has_human_required(self):
        tc = {"steps": [
            {"action": "Visually verify the layout", "expected_result": "Matches design", "human_required": True},
        ]}
        is_valid, details = validate_human_required_marked_correctly(tc)
        assert is_valid is True

    def test_fail_when_visual_keyword_without_human_required(self):
        tc = {"steps": [
            {"action": "Visually verify the layout", "expected_result": "Matches design"},
        ]}
        is_valid, details = validate_human_required_marked_correctly(tc)
        assert is_valid is False
        assert 0 in details["steps_potentially_manual"]

    def test_pass_no_visual_keywords(self):
        tc = {"steps": [
            {"action": "Click the submit button", "expected_result": "Form submitted", "validation_method": "Verify Content"},
        ]}
        is_valid, details = validate_human_required_marked_correctly(tc)
        assert is_valid is True

    def test_severity_is_info(self):
        tc = {"steps": [{"action": "inspect element", "expected_result": "y"}]}
        _, details = validate_human_required_marked_correctly(tc)
        assert details["severity"] == "info"


class TestValidateDynamicCountsUseRanges:
    def test_pass_no_rigid_count(self):
        tc = {"steps": [
            {"action": "Check results", "expected_result": "At least 3 results shown", "validation_method": "Verify Count"},
        ]}
        is_valid, details = validate_dynamic_counts_use_ranges(tc)
        assert is_valid is True

    def test_fail_rigid_count_with_exactly(self):
        tc = {"steps": [
            {"action": "Check results", "expected_result": "exactly 5 results", "validation_method": "Verify Count"},
        ]}
        is_valid, details = validate_dynamic_counts_use_ranges(tc)
        assert is_valid is False
        assert 0 in details["steps_with_rigid_counts"]

    def test_pass_exactly_without_count_method(self):
        tc = {"steps": [
            {"action": "Check results", "expected_result": "exactly 5 results", "validation_method": "Verify Content"},
        ]}
        is_valid, details = validate_dynamic_counts_use_ranges(tc)
        assert is_valid is True

    def test_severity_is_info(self):
        tc = {"steps": [{"action": "x", "expected_result": "exactly 5", "validation_method": "Verify Count"}]}
        _, details = validate_dynamic_counts_use_ranges(tc)
        assert details["severity"] == "info"


class TestValidateResultClassificationDefined:
    def test_pass_all_valid_classifications(self):
        tc = {"results": [{"classification": "PASS"}, {"classification": "FAIL"}, {"classification": "WARN"}]}
        is_valid, details = validate_result_classification_defined(tc)
        assert is_valid is True

    def test_fail_empty_results_list(self):
        tc = {"results": []}
        is_valid, details = validate_result_classification_defined(tc)
        assert is_valid is False

    def test_fail_invalid_classification(self):
        tc = {"results": [{"classification": "UNKNOWN"}]}
        is_valid, details = validate_result_classification_defined(tc)
        assert is_valid is False
        assert 0 in details["results_unclassified"]

    def test_fail_missing_results(self):
        is_valid, details = validate_result_classification_defined({})
        assert is_valid is False

    def test_severity_is_blocker(self):
        _, details = validate_result_classification_defined({})
        assert details["severity"] == "blocker"


class TestValidateAutomationReadinessStatusCorrect:
    def test_pass_valid_status(self):
        for status in ["ready_for_automation", "ready_with_manual_steps",
                       "needs_clarification", "needs_test_data", "blocked"]:
            tc = {"automation_readiness_status": status}
            is_valid, details = validate_automation_readiness_status_correct(tc)
            assert is_valid is True, f"Expected pass for status={status!r}"

    def test_fail_empty_status(self):
        tc = {"automation_readiness_status": ""}
        is_valid, details = validate_automation_readiness_status_correct(tc)
        assert is_valid is False

    def test_fail_missing_field(self):
        is_valid, details = validate_automation_readiness_status_correct({})
        assert is_valid is False

    def test_fail_invalid_value(self):
        tc = {"automation_readiness_status": "unknown_value"}
        is_valid, details = validate_automation_readiness_status_correct(tc)
        assert is_valid is False

    def test_severity_is_blocker(self):
        _, details = validate_automation_readiness_status_correct({})
        assert details["severity"] == "blocker"


class TestValidateRisksDocumented:
    def test_pass_with_risk_and_mitigation(self):
        tc = {"risks": [{"risk": "Data may change", "mitigation": "Use fixtures"}]}
        is_valid, details = validate_risks_documented(tc)
        assert is_valid is True
        assert details["risks_count"] == 1

    def test_fail_empty_list(self):
        tc = {"risks": []}
        is_valid, details = validate_risks_documented(tc)
        assert is_valid is False

    def test_fail_missing_mitigation(self):
        tc = {"risks": [{"risk": "Data may change"}]}
        is_valid, details = validate_risks_documented(tc)
        assert is_valid is False

    def test_fail_missing_field(self):
        is_valid, details = validate_risks_documented({})
        assert is_valid is False

    def test_severity_is_info(self):
        _, details = validate_risks_documented({})
        assert details["severity"] == "info"


class TestValidateRegistryNeedsMentioned:
    def test_pass_with_empty_list(self):
        tc = {"registry_needs": []}
        is_valid, details = validate_registry_needs_mentioned(tc)
        assert is_valid is True
        assert details["needs_count"] == 0

    def test_pass_with_entries(self):
        tc = {"registry_needs": ["flow_A", "action_B"]}
        is_valid, details = validate_registry_needs_mentioned(tc)
        assert is_valid is True

    def test_fail_when_field_missing(self):
        is_valid, details = validate_registry_needs_mentioned({})
        assert is_valid is False
        assert details["needs"] == "[MISSING FIELD]"

    def test_severity_is_info(self):
        _, details = validate_registry_needs_mentioned({})
        assert details["severity"] == "info"


# ===========================================================================
# Section 2: run_all_validations() tests
# ===========================================================================

class TestRunAllValidations:
    def test_returns_twelve_entries(self):
        results = run_all_validations({})
        assert len(results) == 12

    def test_each_entry_is_tuple_of_bool_and_dict(self):
        results = run_all_validations({})
        for item in results:
            assert isinstance(item, (tuple, list)), f"Expected tuple/list, got {type(item)}"
            assert len(item) == 2
            is_valid, details = item
            assert isinstance(is_valid, bool)
            assert isinstance(details, dict)

    def test_empty_dict_has_mostly_failures(self):
        results = run_all_validations({})
        passed = [is_valid for is_valid, _ in results]
        # Critical blockers must all fail on an empty dict
        by_name = {d["criterion"]: ok for ok, d in results}
        assert by_name["Test Data Documented"] is False
        assert by_name["All Steps Have Expected Results"] is True   # no steps = nothing missing
        assert by_name["Result Classification Defined"] is False
        assert by_name["Automation Readiness Status Correct"] is False
        assert by_name["Business Goal Present"] is False
        assert by_name["Registry Needs Mentioned"] is False
        # At least half the validators should fail on an empty input
        fail_count = sum(1 for v in passed if v is False)
        assert fail_count >= 6, f"Expected at least 6 failures, got {fail_count}: {passed}"

    def test_none_input_treated_as_empty(self):
        results = run_all_validations(None)
        assert len(results) == 12

    def test_all_criteria_names_present(self):
        results = run_all_validations({})
        names = {d.get("criterion") for _, d in results}
        expected = {
            "Business Goal Present",
            "Preconditions Clear",
            "Test Data Documented",
            "Test Data Stable",
            "All Steps Have Expected Results",
            "Important Results Have Validation Methods",
            "Human Required? Marked Correctly",
            "Dynamic Counts Use Ranges",
            "Result Classification Defined",
            "Automation Readiness Status Correct",
            "Risks Documented",
            "Registry Needs Mentioned",
        }
        assert names == expected


# ===========================================================================
# Section 3: compute_decision() end-to-end pipeline tests with real fixtures
# ===========================================================================

class TestComputeDecisionWithFixtures:
    def _run(self, fixture_name):
        tc = _load_fixture(fixture_name)
        vr = run_all_validations(tc)
        return compute_decision(vr, tc)

    # ready_test_case.json → exit 0
    def test_ready_decision(self):
        dr = self._run("ready_test_case.json")
        assert dr["decision"] == "Ready for Automation"

    def test_ready_can_start_true(self):
        dr = self._run("ready_test_case.json")
        assert dr["can_start_automation_now"] is True

    def test_ready_human_review_false(self):
        dr = self._run("ready_test_case.json")
        assert dr["human_review_required"] is False

    # needs_clarification.json → exit 1
    def test_needs_clarification_decision(self):
        dr = self._run("needs_clarification.json")
        assert dr["decision"] == "Needs Clarification"

    def test_needs_clarification_can_start_false(self):
        dr = self._run("needs_clarification.json")
        assert dr["can_start_automation_now"] is False

    def test_needs_clarification_human_review_true(self):
        dr = self._run("needs_clarification.json")
        assert dr["human_review_required"] is True

    # needs_test_data.json → exit 2
    def test_needs_test_data_decision(self):
        dr = self._run("needs_test_data.json")
        assert dr["decision"] == "Needs Test Data"

    def test_needs_test_data_can_start_false(self):
        dr = self._run("needs_test_data.json")
        assert dr["can_start_automation_now"] is False

    def test_needs_test_data_human_review_true(self):
        dr = self._run("needs_test_data.json")
        assert dr["human_review_required"] is True

    # needs_human_validation.json → exit 3
    def test_needs_human_validation_decision(self):
        dr = self._run("needs_human_validation.json")
        assert dr["decision"] == "Needs Human Validation"

    def test_needs_human_validation_can_start_false(self):
        dr = self._run("needs_human_validation.json")
        assert dr["can_start_automation_now"] is False

    def test_needs_human_validation_human_review_true(self):
        dr = self._run("needs_human_validation.json")
        assert dr["human_review_required"] is True

    # blocked_test_case.json → exit 4
    def test_blocked_decision(self):
        dr = self._run("blocked_test_case.json")
        assert dr["decision"] == "Blocked"

    def test_blocked_can_start_false(self):
        dr = self._run("blocked_test_case.json")
        assert dr["can_start_automation_now"] is False

    def test_blocked_human_review_true(self):
        dr = self._run("blocked_test_case.json")
        assert dr["human_review_required"] is True

    def test_blocked_has_blockers_list(self):
        dr = self._run("blocked_test_case.json")
        assert len(dr["blockers"]) > 0


# ===========================================================================
# Section 4: Report generation tests (text format)
# ===========================================================================

class TestFormatReport:
    def _make_report(self, fixture_name):
        tc = _load_fixture(fixture_name)
        vr = run_all_validations(tc)
        dr = compute_decision(vr, tc)
        return format_report(tc.get("name", fixture_name), vr, dr)

    def test_returns_string(self):
        report = self._make_report("ready_test_case.json")
        assert isinstance(report, str)

    def test_ready_contains_ready_label(self):
        report = self._make_report("ready_test_case.json")
        assert "[READY]" in report

    def test_blocked_contains_blocked_label(self):
        report = self._make_report("blocked_test_case.json")
        assert "[BLOCKED]" in report

    def test_needs_clarification_contains_label(self):
        report = self._make_report("needs_clarification.json")
        assert "[NEEDS CLARIFICATION]" in report

    def test_needs_test_data_contains_label(self):
        report = self._make_report("needs_test_data.json")
        assert "[NEEDS TEST DATA]" in report

    def test_needs_human_contains_label(self):
        report = self._make_report("needs_human_validation.json")
        assert "[NEEDS HUMAN]" in report

    def test_ready_automation_can_start_now(self):
        report = self._make_report("ready_test_case.json")
        assert "[AUTOMATION CAN START NOW]" in report

    def test_non_ready_automation_blocked(self):
        for fname in ["needs_clarification.json", "needs_test_data.json",
                      "needs_human_validation.json", "blocked_test_case.json"]:
            report = self._make_report(fname)
            assert "[AUTOMATION BLOCKED]" in report, f"Missing in {fname}"

    def test_non_ready_human_review_required(self):
        for fname in ["needs_clarification.json", "needs_test_data.json",
                      "needs_human_validation.json", "blocked_test_case.json"]:
            report = self._make_report(fname)
            assert "[HUMAN REVIEW REQUIRED]" in report, f"Missing in {fname}"

    def test_ready_no_human_review_required_line(self):
        report = self._make_report("ready_test_case.json")
        assert "[HUMAN REVIEW REQUIRED]" not in report

    def test_report_contains_validation_details_section(self):
        report = self._make_report("ready_test_case.json")
        assert "VALIDATION DETAILS" in report

    def test_report_contains_pass_and_fail_tags(self):
        report = self._make_report("blocked_test_case.json")
        assert "[PASS]" in report
        assert "[FAIL]" in report


# ===========================================================================
# Section 5: JSON report tests
# ===========================================================================

class TestFormatJsonReport:
    def _make_json_report(self, fixture_name):
        tc = _load_fixture(fixture_name)
        vr = run_all_validations(tc)
        dr = compute_decision(vr, tc)
        return format_json_report(tc.get("name", fixture_name), vr, dr)

    def test_returns_valid_json(self):
        raw = self._make_json_report("ready_test_case.json")
        parsed = json.loads(raw)
        assert isinstance(parsed, dict)

    def test_parsed_dict_has_decision_key(self):
        parsed = json.loads(self._make_json_report("ready_test_case.json"))
        assert "decision" in parsed

    def test_decision_value_correct_ready(self):
        parsed = json.loads(self._make_json_report("ready_test_case.json"))
        assert parsed["decision"] == "Ready for Automation"

    def test_decision_value_correct_blocked(self):
        parsed = json.loads(self._make_json_report("blocked_test_case.json"))
        assert parsed["decision"] == "Blocked"

    def test_ensure_ascii_no_non_ascii_chars(self):
        for fname in ["ready_test_case.json", "blocked_test_case.json"]:
            raw = self._make_json_report(fname)
            for ch in raw:
                assert ord(ch) < 128, f"Non-ASCII char {ch!r} found in JSON output for {fname}"

    def test_json_has_expected_top_level_keys(self):
        parsed = json.loads(self._make_json_report("ready_test_case.json"))
        for key in ["test_case", "decision", "confidence", "can_start_automation_now",
                    "human_review_required", "blockers", "warnings", "info",
                    "risks", "suggested_fixes", "registry_needs", "missing_fields",
                    "validation_summary"]:
            assert key in parsed, f"Key {key!r} missing from JSON report"

    def test_validation_summary_has_twelve_entries(self):
        parsed = json.loads(self._make_json_report("ready_test_case.json"))
        assert len(parsed["validation_summary"]) == 12


# ===========================================================================
# Section 6: CLI exit code tests (subprocess)
# ===========================================================================

class TestCliExitCodes:
    def _run_cli(self, fixture_name, extra_args=None):
        fixture_path = _FIXTURES_DIR / fixture_name
        cmd = [sys.executable, str(_CLI), "--test-case", str(fixture_path)]
        if extra_args:
            cmd.extend(extra_args)
        return subprocess.run(cmd, capture_output=True, cwd=str(_SCRIPTS_DIR))

    def test_exit_0_for_ready(self):
        result = self._run_cli("ready_test_case.json")
        assert result.returncode == 0

    def test_exit_1_for_needs_clarification(self):
        result = self._run_cli("needs_clarification.json")
        assert result.returncode == 1

    def test_exit_2_for_needs_test_data(self):
        result = self._run_cli("needs_test_data.json")
        assert result.returncode == 2

    def test_exit_3_for_needs_human_validation(self):
        result = self._run_cli("needs_human_validation.json")
        assert result.returncode == 3

    def test_exit_4_for_blocked(self):
        result = self._run_cli("blocked_test_case.json")
        assert result.returncode == 4


# ===========================================================================
# Section 7: CLI JSON mode tests
# ===========================================================================

class TestCliJsonMode:
    def test_json_format_produces_valid_json_on_stdout(self):
        fixture_path = _FIXTURES_DIR / "ready_test_case.json"
        result = subprocess.run(
            [sys.executable, str(_CLI), "--test-case", str(fixture_path), "--format", "json"],
            capture_output=True, cwd=str(_SCRIPTS_DIR)
        )
        stdout = result.stdout.decode("utf-8")
        parsed = json.loads(stdout)
        assert isinstance(parsed, dict)

    def test_json_stdout_contains_no_non_json_lines(self):
        fixture_path = _FIXTURES_DIR / "ready_test_case.json"
        result = subprocess.run(
            [sys.executable, str(_CLI), "--test-case", str(fixture_path), "--format", "json"],
            capture_output=True, cwd=str(_SCRIPTS_DIR)
        )
        stdout = result.stdout.decode("utf-8").strip()
        # The entire stdout must be a single valid JSON document
        parsed = json.loads(stdout)
        assert parsed["decision"] == "Ready for Automation"


# ===========================================================================
# Section 8: CLI --output file tests
# ===========================================================================

class TestCliOutputFile:
    def test_output_flag_writes_report_to_file(self):
        fixture_path = _FIXTURES_DIR / "ready_test_case.json"
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
            tmp_path = tmp.name

        result = subprocess.run(
            [sys.executable, str(_CLI), "--test-case", str(fixture_path), "--output", tmp_path],
            capture_output=True, cwd=str(_SCRIPTS_DIR)
        )
        assert result.returncode == 0
        content = Path(tmp_path).read_text(encoding="utf-8")
        assert len(content) > 0
        assert "Ready for Automation" in content
        Path(tmp_path).unlink(missing_ok=True)

    def test_output_file_contains_report_markers(self):
        fixture_path = _FIXTURES_DIR / "blocked_test_case.json"
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp:
            tmp_path = tmp.name

        subprocess.run(
            [sys.executable, str(_CLI), "--test-case", str(fixture_path), "--output", tmp_path],
            capture_output=True, cwd=str(_SCRIPTS_DIR)
        )
        content = Path(tmp_path).read_text(encoding="utf-8")
        assert "[BLOCKED]" in content
        assert "[AUTOMATION BLOCKED]" in content
        Path(tmp_path).unlink(missing_ok=True)


# ===========================================================================
# Section 9: Error handling tests
# ===========================================================================

class TestCliErrorHandling:
    def test_missing_file_exits_5(self):
        result = subprocess.run(
            [sys.executable, str(_CLI), "--test-case", "nonexistent_file_xyz.json"],
            capture_output=True, cwd=str(_SCRIPTS_DIR)
        )
        assert result.returncode == 5
        assert b"ERROR" in result.stderr

    def test_invalid_json_exits_5(self):
        with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False, encoding="utf-8") as tmp:
            tmp.write("{this is not valid json}")
            tmp_path = tmp.name

        result = subprocess.run(
            [sys.executable, str(_CLI), "--test-case", tmp_path],
            capture_output=True, cwd=str(_SCRIPTS_DIR)
        )
        assert result.returncode == 5
        assert b"ERROR" in result.stderr
        Path(tmp_path).unlink(missing_ok=True)

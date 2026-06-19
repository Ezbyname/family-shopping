# `/tangles-test-readiness` Review Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a safety gate that validates test cases designed via `/test-case` are truly automation-ready before ADO work items are created, producing a 5-level decision and detailed readiness report.

> **Integration note (2026-06-18):** Upstream is `/test-case` (not `/tangles-plan-author`). The gate fires after the user confirms all test categories but BEFORE ADO work item creation. `/test-case` constructs an intermediate JSON per test, passes it to this validator, and only proceeds to ADO creation if the result is "Ready for Automation". Task 6 must extend `/test-case` to collect the additional fields this schema requires (preconditions, test_data, validation_method, risks, registry_needs).

**Architecture:** A multi-stage validator that evaluates test cases against 12 readiness criteria, maps findings to decision levels, identifies gaps/risks, and generates a structured report with actionable fixes and registry needs.

**Tech Stack:** Python 3.9+, structured JSON output, reference docs (flow-catalog.md, manual-indicators.md, registry requirements)

---

## File Structure

```
scripts/
├── validate_test_readiness.py          # Main review engine + decision logic
├── readiness_criteria.py                # 12 readiness checks (validators)
├── readiness_report_generator.py        # Report template + formatting
└── tests/
    ├── test_readiness_validators.py     # Unit tests for each criterion
    └── fixtures/
        ├── ready_test_case.json         # Passing example
        ├── needs_clarification.json     # Gap example
        └── blocked_test_case.json       # Fail example

docs/
├── references/
│   └── readiness-criteria.md            # Detailed definitions of 12 checks
└── superpowers/plans/
    └── 2026-06-17-tangles-test-readiness-review.md  (this file)
```

---

## Task 1: Define Readiness Criteria Module

**Files:**
- Create: `scripts/readiness_criteria.py`
- Create: `docs/references/readiness-criteria.md`

**Purpose:** Document the 12 readiness checks; implement each as a reusable validator function.

---

### Task 1a: Create Criteria Documentation

- [ ] **Step 1: Write readiness-criteria.md with all 12 checks**

Create `docs/references/readiness-criteria.md`:

```markdown
# Readiness Criteria for Test Case Automation

## 1. Business Goal Present

**What it checks:** Test case has a clear, stated business goal.

**Expected format:** `test_case['metadata']['business_goal']` is a non-empty string.

**Examples of passing:**
- "Verify that users can search for people by name and see results within 2 seconds"

**Examples of failing:**
- `business_goal` missing
- `business_goal: "test search"`  (too vague)

**Risk if missing:** Automation may solve the wrong problem; no success criteria.

**Suggested fix:** Interview stakeholder on why this test matters.

---

## 2. Preconditions Clear

**What it checks:** Prerequisites are explicit, achievable, and stable.

**Expected format:** `test_case['preconditions']` is a non-empty list of strings; each is testable (e.g., "User is logged in", "Database contains 50 test records").

**Examples of passing:**
- `["User is logged in", "Search index is up to date", "Database has 100+ sample records"]`

**Examples of failing:**
- `preconditions: []`
- `preconditions: ["System is ready"]`  (too vague)
- `preconditions: ["User has admin privileges OR regular privileges"]`  (ambiguous)

**Risk if missing:** Test may fail due to setup issues, not actual bugs.

**Suggested fix:** Document each precondition as a separate, verifiable state.

---

## 3. Test Data Documented

**What it checks:** All test data used in the test case is explicitly documented.

**Expected format:** `test_case['test_data']` is a dict with entries like:
```json
{
  "search_term": { "value": "John Doe", "source": "fixture", "stable": true },
  "expected_min_results": { "value": 5, "source": "manual", "stable": true }
}
```

**Examples of passing:**
- Each step that references data (e.g., "Search for NAME") has corresponding entry in `test_data`

**Examples of failing:**
- `test_data: {}`
- Step says "Search for the first person in the list" but no `test_data['person_name']`

**Risk if missing:** Automation doesn't know what values to use; brittleness if data changes.

**Suggested fix:** Audit each step for data references; add to `test_data` dict.

---

## 4. Test Data Stable

**What it checks:** Test data won't change unexpectedly between runs.

**Expected format:** For each entry in `test_data`, `stable: true` or document why instability is acceptable.

**Examples of passing:**
- `search_term: { value: "John Doe", stable: true }`  (fixed fixture)
- `max_wait_ms: { value: 5000, stable: true }`  (constant)

**Examples of failing:**
- `user_id: { value: "{{ random_user_id() }}", stable: false }`  with no rationale
- `current_time: { value: "now()", stable: false }`  and no documented handling

**Risk if missing:** Tests flake randomly; CI becomes unreliable.

**Suggested fix:** If data must vary, document how automation will handle it (e.g., "Use timestamped search; verify result rank, not ID").

---

## 5. All Steps Have Expected Results

**What it checks:** Every step has a corresponding expected result.

**Expected format:** Step table has 4 columns; every row with `Action` has a non-empty `Expected Result`.

**Examples of passing:**
| Action | Expected Result | Validation Method | Human Required? |
|---|---|---|---|
| Click "Search" button | Results appear within 2s | Verify Content | No |

**Examples of failing:**
| Action | Expected Result | Validation Method | Human Required? |
|---|---|---|---|
| Click "Search" button | | | No |

**Risk if missing:** Automation doesn't know what to verify; test becomes unmaintainable.

**Suggested fix:** For each action, ask "What should happen as a result?" and document it.

---

## 6. Important Expected Results Have Validation Methods

**What it checks:** Critical expected results are bound to a validation method (Count/Content/Badge/Manual).

**Expected format:** Step table `Validation Method` column is filled for all rows marked `Human Required? = No`.

**Examples of passing:**
- `Expected Result: "5-10 results appear"` → `Validation Method: Verify Count (5-10)`

**Examples of failing:**
- `Expected Result: "Results appear"` → `Validation Method: ` (empty)

**Risk if missing:** Automation runs but doesn't actually verify the outcome.

**Suggested fix:** For each result, choose Verify Count, Verify Content, Verify Badge, or Manual.

---

## 7. Human Required? Fields Marked Correctly

**What it checks:** Non-automatable steps are marked `Human Required? = Yes`.

**Expected format:** Any step matching manual-only indicators (visual inspection, design check, browser comparison, dev tools, etc.) has `Human Required? = Yes`.

**Examples of passing:**
- Step: "Verify the layout matches the design mockup" → `Human Required? = Yes`

**Examples of failing:**
- Step: "Visually inspect that the button is blue" → `Human Required? = No`  (should be Yes)

**Risk if missing:** Automation tries to execute visual checks; tests become fragile.

**Suggested fix:** Review against manual-indicators.md; mark visual/design/rendering steps as Human Required.

---

## 8. At Least / Minimum Count Validation for Dynamic Counts

**What it checks:** When exact counts are unstable (e.g., search results vary), validation uses ranges/minimums, not exact counts.

**Expected format:** `Validation Method: Verify Count (≥ N)` or `Verify Count (N ≤ count ≤ M)`, not `Verify Count (== exact_number)` for dynamic data.

**Examples of passing:**
- `Expected Result: "At least 1 result shown"` → `Verify Count (≥ 1)`
- `Expected Result: "Between 5 and 20 results"` → `Verify Count (5-20)`

**Examples of failing:**
- `Expected Result: "Exactly 7 results shown"` → `Verify Count (== 7)` for a live database (too rigid)

**Risk if missing:** Test flakes when data count changes; false negatives poison CI.

**Suggested fix:** Use `≥`, `≤`, or ranges for counts of dynamic data.

---

## 9. Result Classification Defined

**What it checks:** Each expected result is tagged as PASS, WARN, or FAIL for the automation engine.

**Expected format:** `test_case['results'][i]['classification']` = "PASS" | "WARN" | "FAIL".

**Examples of passing:**
- Critical result: "User data retrieved" → `classification: "FAIL"`  (if missing, test fails)
- Nice-to-have: "Animation complete within 100ms" → `classification: "WARN"`  (if slow, warn but don't fail)

**Examples of failing:**
- Result with no `classification` field

**Risk if missing:** Automation doesn't know if a missing animation makes the test fail or just warn.

**Suggested fix:** For each result, decide if it's critical (FAIL), important (WARN), or informational (PASS).

---

## 10. Automation Readiness Status Correct

**What it checks:** `test_case['automation_readiness_status']` matches the actual content readiness.

**Expected format:** Status must be one of:
- `"ready_for_automation"` (all data present, no manual steps)
- `"ready_with_manual_steps"` (automatable steps + documented manual steps)
- `"needs_clarification"` (ambiguous data or steps)
- `"needs_test_data"` (missing or unstable data)
- `"blocked"` (unmappable flow or unresolvable dependencies)

**Examples of passing:**
- Test has 5 automated steps + 1 manual verification → Status: `"ready_with_manual_steps"`
- Test is fully automated with stable data → Status: `"ready_for_automation"`

**Examples of failing:**
- Test has missing test data but status says `"ready_for_automation"`

**Risk if missing:** Automation engine may try to run blocked or incomplete tests.

**Suggested fix:** After all other checks, validate status matches the facts on the ground.

---

## 11. Risks Documented

**What it checks:** Known risks (flaky timing, dependent data, external APIs, etc.) are documented.

**Expected format:** `test_case['risks']` is a list of risk objects:
```json
[
  { "risk": "External API timeout", "mitigation": "Retry up to 3x with 2s backoff" },
  { "risk": "Database state not isolated", "mitigation": "Use transaction rollback after test" }
]
```

**Examples of passing:**
- Risks documented and mitigations clear

**Examples of failing:**
- `risks: []` for a test that calls external APIs
- `risks: ["May be slow"]`  (no mitigation)

**Risk if missing:** Automation is deployed; flakiness causes CI churn with no context.

**Suggested fix:** Brainstorm potential failure modes; document mitigations for each.

---

## 12. Registry Needs Mentioned for New Flows/Actions/Buttons/Helpers

**What it checks:** If the test uses new flows, actions, buttons, or test helpers not yet in the registry, they are flagged for creation.

**Expected format:** `test_case['registry_needs']` is a list:
```json
[
  { "type": "flow", "name": "Advanced_Analysis_CustomReport", "status": "new" },
  { "type": "action", "name": "click_export_button", "status": "new" },
  { "type": "helper", "name": "wait_for_export_download", "status": "new" }
]
```

**Examples of passing:**
- Test uses only existing flows/actions → `registry_needs: []`
- Test needs new flow → documented and flagged

**Examples of failing:**
- Test says "Use the Export flow" but Export flow doesn't exist, and `registry_needs: []`

**Risk if missing:** Automation tries to use non-existent flows; test fails at runtime with confusing errors.

**Suggested fix:** Cross-check against flow-catalog.md and action registry; list any gaps.

---

## Summary: Readiness Criteria Mapping

| # | Criterion | Blocker? | Auto-Fixable? |
|---|---|---|---|
| 1 | Business Goal | No | No (needs interview) |
| 2 | Preconditions | No | Partially (needs refinement) |
| 3 | Test Data Documented | **Yes** | Partially (needs audit) |
| 4 | Test Data Stable | **Yes** | No (needs redesign) |
| 5 | All Steps Have Expected Results | **Yes** | Partially (needs review) |
| 6 | Important Results Have Validation Methods | **Yes** | Partially (needs selection) |
| 7 | Human Required? Marked Correctly | No | Partially (needs verification) |
| 8 | Dynamic Counts Use Ranges | No | Partially (needs adjustment) |
| 9 | Result Classification | **Yes** | Partially (needs assignment) |
| 10 | Automation Readiness Status Correct | **Yes** | Yes (computed from other fields) |
| 11 | Risks Documented | No | No (needs brainstorm) |
| 12 | Registry Needs Mentioned | No | Partially (needs cross-check) |

**Blocker criteria:** 3, 4, 5, 6, 9, 10. If any of these fail, test is **Blocked** or **Needs X** (depending on severity).

**Info criteria:** 1, 2, 7, 8, 11, 12. If any of these fail, test is **Needs Clarification** or **Needs Review**.
```

- [ ] **Step 2: Run a quick syntax check on the markdown**

Use your editor or `python -m markdown <file>` to validate the file is well-formed.

---

## Task 2: Create Decision Logic Engine

**Files:**
- Create: `scripts/readiness_decision.py`

**Purpose:** Map validation results to one of 5 decision levels and enumerate missing fields, risks, and fixes.

---

- [ ] **Step 1: Implement the decision engine**

Create `scripts/readiness_decision.py` with compute_decision() function that:
- Takes validation_results and test_case
- Maps blockers/warnings/info to 5-level decision
- Returns dict with decision, confidence, missing_fields, risks, suggested_fixes, can_start_automation_now, human_review_required, registry_needs

---

## Task 3: Create Report Generator

**Files:**
- Create: `scripts/readiness_report_generator.py`

**Purpose:** Format validation results and decision into a human-readable report.

---

- [ ] **Step 1: Implement the report generator**

Create `scripts/readiness_report_generator.py` with:
- `format_report()` — human-readable text output with decision, blockers, warnings, risks, fixes
- `format_json_report()` — machine-readable JSON for CI/CD integration

---

## Task 4: Create Main Review Flow Script

**Files:**
- Create: `scripts/validate_test_readiness.py` (main entry point)

**Purpose:** Orchestrate the full validation pipeline and output reports.

---

- [ ] **Step 1: Implement the main script**

Create `scripts/validate_test_readiness.py` with:
- argparse for --test-case, --format, --output
- load_test_case() to read JSON
- main() to orchestrate run_all_validations() → compute_decision() → format_report()
- Exit codes: 0 (Ready), 1 (Clarification), 2 (Data), 3 (Human), 4 (Blocked)

---

## Task 5: Create Test Fixtures and Unit Tests

**Files:**
- Create: `scripts/tests/test_readiness_validators.py`
- Create: `scripts/tests/fixtures/ready_test_case.json`
- Create: `scripts/tests/fixtures/needs_clarification.json`
- Create: `scripts/tests/fixtures/blocked_test_case.json`

**Purpose:** Ensure validators work correctly with realistic test cases.

---

### Task 5a: Create Test Fixtures

- [ ] **Step 1: Create three realistic test case fixtures**

- `ready_test_case.json` — all criteria pass, automation ready
- `needs_clarification.json` — some steps lack validation methods
- `blocked_test_case.json` — missing test data, cannot automate

### Task 5b: Create Unit Tests

- [ ] **Step 1: Create unit tests**

`scripts/tests/test_readiness_validators.py` with:
- `TestValidators` class testing each of 12 validators independently
- `TestFixtures` class testing that 3 fixtures classify correctly
- Run with `pytest test_readiness_validators.py -v`

---

## Task 6: Integration with `/tangles-test-readiness` Skill

**Files:**
- Modify: `/tangles-test-readiness` skill (Phase 4 extension)

**Purpose:** Wire the review flow into the skill's assessment pipeline.

---

- [ ] **Step 1: Document the integration point**

Update `/tangles-test-readiness` skill to reference Phase 4 "Readiness Review Gate":
- After Phase 3 assessment, run `scripts/validate_test_readiness.py`
- Display decision + report to user
- Next steps depend on decision level

---

## Task 7: Create Documentation and README

**Files:**
- Create: `docs/tangles-test-readiness-review.md`

**Purpose:** Document the review flow, how to use it, and interpret results.

---

- [ ] **Step 1: Write user-facing documentation**

Create `docs/tangles-test-readiness-review.md` with:
- Overview of 5 decisions
- Running the review command
- Interpreting each decision level
- Common issues and fixes
- CI/CD integration examples
- Exit code reference
- JSON output format

---

## Task 8: Create Validation Tests and Run Full Test Suite

**Files:**
- Run tests to verify everything works

**Purpose:** Ensure the readiness review flow works end-to-end.

---

- [ ] **Step 1: Run unit tests**

```bash
cd scripts/tests
python -m pytest test_readiness_validators.py -v
```

Expected: All tests pass (9+ tests).

---

- [ ] **Step 2: Test with ready fixture**

```bash
python scripts/validate_test_readiness.py --test-case scripts/tests/fixtures/ready_test_case.json --format text
```

Expected: Decision is `Ready for Automation` or `Needs Clarification` (not Blocked).

---

- [ ] **Step 3: Test with needs-clarification fixture**

```bash
python scripts/validate_test_readiness.py --test-case scripts/tests/fixtures/needs_clarification.json --format text
```

Expected: Decision is `Needs Clarification` or `Blocked`.

---

- [ ] **Step 4: Test with blocked fixture**

```bash
python scripts/validate_test_readiness.py --test-case scripts/tests/fixtures/blocked_test_case.json --format text
```

Expected: Decision is `Blocked`.

---

- [ ] **Step 5: Test JSON output**

```bash
python scripts/validate_test_readiness.py --test-case scripts/tests/fixtures/ready_test_case.json --format json
```

Expected: Valid JSON with `decision`, `confidence`, `blockers`, `warnings`, `info` fields.

---

- [ ] **Step 6: Commit all work**

```bash
git add \
  scripts/readiness_criteria.py \
  scripts/readiness_decision.py \
  scripts/readiness_report_generator.py \
  scripts/validate_test_readiness.py \
  scripts/tests/test_readiness_validators.py \
  scripts/tests/fixtures/ \
  docs/references/readiness-criteria.md \
  docs/tangles-test-readiness-review.md

git commit -m "feat: implement test case readiness review flow

- Add 12-criterion validation engine (blocker + info criteria)
- Implement 5-level decision logic (Ready / Needs X / Blocked)
- Create report generator with text + JSON output
- Add unit tests with 3 fixture scenarios
- Document criteria and usage guide

Exit codes: 0 (Ready), 1 (Clarification), 2 (Data), 3 (Human), 4 (Blocked)
Fixes #150173"
```

---

## Summary

**What this builds:**

A complete safety gate that validates test cases from `/tangles-plan-author` are truly automation-ready. The review flow:

- ✅ Checks 12 readiness criteria (6 blockers, 6 info)
- ✅ Produces a 5-level decision with confidence score
- ✅ Reports missing fields, risks, and exact fixes
- ✅ Tells you if automation can start and if human review is needed
- ✅ Flags new registry entries needed
- ✅ Works in text and JSON formats
- ✅ Returns exit codes for CI/CD integration

**Next steps after implementation:**

1. Wire into `/tangles-test-readiness` skill
2. Test with real `/tangles-plan-author` output
3. Iterate on criterion definitions based on feedback
4. Add to CI/CD pipeline to gate automation start

# Readiness Criteria for Test Case Automation

## 1. Business Goal Present
**What it checks:** Test case has a clear, stated business goal.
**Expected format:** `test_case['metadata']['business_goal']` is a non-empty string (>10 chars).
**Passing:** "Verify users can search by name and get results within 2s"
**Failing:** missing, or "test search" (too vague)
**Risk:** Automation solves wrong problem; no success criteria.
**Fix:** Interview stakeholder on why test matters.

---

## 2. Preconditions Clear
**What it checks:** Prerequisites are explicit, achievable, and stable.
**Expected format:** `test_case['preconditions']` is a non-empty list; each item >5 chars and testable.
**Passing:** `["User is logged in", "Database has 100+ sample records"]`
**Failing:** `[]`, or `["System is ready"]` (vague), or ambiguous OR conditions
**Risk:** Test fails due to setup issues, not actual bugs.
**Fix:** Document each precondition as a separate, verifiable state.

---

## 3. Test Data Documented
**What it checks:** All test data is explicitly documented with value and source.
**Expected format:** `test_case['test_data']` is a non-empty dict; each entry has a `value` key.
**Passing:** `{"search_term": {"value": "John Doe", "source": "fixture", "stable": true}}`
**Failing:** `test_data: {}`, or step references data not in dict
**Risk:** Automation doesn't know values; brittleness when data changes.
**Fix:** Audit each step for data references; add to test_data dict.

---

## 4. Test Data Stable
**What it checks:** Test data won't change unexpectedly between runs.
**Expected format:** Each `test_data` entry has `stable: true`, or unstable entries have a `handling` field.
**Passing:** `{"value": "John Doe", "stable": true}` — or unstable with `"handling": "use range"`
**Failing:** `{"value": "{{random()}}", "stable": false}` with no handling strategy
**Risk:** Tests flake randomly; CI becomes unreliable.
**Fix:** Stabilize data or document handling strategy (e.g., "use range for count").

---

## 5. All Steps Have Expected Results
**What it checks:** Every action step has a corresponding expected result.
**Expected format:** Each step with non-empty `action` must have non-empty `expected_result`.
**Passing:** `{"action": "Click Search", "expected_result": "Results appear within 2s"}`
**Failing:** `{"action": "Click Search", "expected_result": ""}`
**Risk:** Automation has nothing to verify; test is unmaintainable.
**Fix:** For each action, ask "What should happen?" and document it.

---

## 6. Important Expected Results Have Validation Methods
**What it checks:** Critical results (not Human Required) are bound to a validation method.
**Expected format:** Steps where `human_required=False` must have non-empty `validation_method`.
**Passing:** `{"validation_method": "Verify Count (≥ 5)"}`
**Failing:** `{"human_required": false, "validation_method": ""}` 
**Risk:** Automation runs but doesn't actually verify the outcome.
**Fix:** Bind to: Verify Count, Verify Content, Verify Filter Badge, or Manual.

---

## 7. Human Required? Fields Marked Correctly
**What it checks:** Non-automatable steps (visual/design/comparison) are flagged.
**Expected format:** Steps containing visual/design keywords must have `human_required: true`.
**Manual indicator keywords:** visually verify, compare, looks, renders, design, matches, inspect
**Passing:** `{"action": "Visually verify layout", "human_required": true}`
**Failing:** `{"action": "Visually inspect button color", "human_required": false}`
**Risk:** Automation tries to execute visual checks; tests become fragile.
**Fix:** Review against manual-indicators.md; mark visual steps as Human Required.

---

## 8. At Least / Minimum Count Validation for Dynamic Counts
**What it checks:** Dynamic result counts use ranges/minimums, not exact counts.
**Expected format:** Expected results with "exactly" should not use exact counts for dynamic data.
**Passing:** `"At least 1 result"` → `Verify Count (≥ 1)`, or `"Between 5 and 20"` → `Verify Count (5-20)`
**Failing:** `"Exactly 7 results"` → `Verify Count (== 7)` for live DB
**Risk:** Test flakes when data count changes; false negatives poison CI.
**Fix:** Use ≥, ≤, or ranges for dynamic data counts.

---

## 9. Result Classification Defined
**What it checks:** Each result entry has a PASS/WARN/FAIL classification.
**Expected format:** `test_case['results']` is non-empty; each item has `classification` in ["PASS","WARN","FAIL"].
**Passing:** `{"description": "User data retrieved", "classification": "FAIL"}`
**Failing:** Result entry missing `classification` field
**Risk:** Automation doesn't know if missing animation = fail or warn.
**Fix:** Classify each result: FAIL (critical), WARN (important), PASS (informational).

---

## 10. Automation Readiness Status Correct
**What it checks:** Declared status matches actual readiness.
**Valid statuses:** `ready_for_automation`, `ready_with_manual_steps`, `needs_clarification`, `needs_test_data`, `blocked`
**Passing:** Test with manual steps → status is `ready_with_manual_steps`
**Failing:** Test has missing data but status says `ready_for_automation`
**Risk:** Automation engine tries to run blocked or incomplete tests.
**Fix:** After all other checks, update status to match actual state.

---

## 11. Risks Documented
**What it checks:** Known risks with mitigations are documented.
**Expected format:** `test_case['risks']` is a non-empty list; each entry has `risk` and `mitigation` keys.
**Passing:** `[{"risk": "API timeout", "mitigation": "Retry 3x with 2s backoff"}]`
**Failing:** `[]`, or `[{"risk": "May be slow"}]` (no mitigation)
**Risk:** Flakiness causes CI churn with no context.
**Fix:** Brainstorm failure modes; document mitigations for each.

---

## 12. Registry Needs Mentioned for New Flows/Actions/Buttons/Helpers
**What it checks:** New flows/actions/helpers not in the registry are flagged.
**Expected format:** `test_case['registry_needs']` is a list; new items have `type`, `name`, `status: "new"`.
**Passing:** `[]` (only existing flows used), or `[{"type":"flow","name":"Export","status":"new"}]`
**Failing:** Test references non-existent Export flow but `registry_needs: []`
**Risk:** Automation uses non-existent flows; fails at runtime with confusing errors.
**Fix:** Cross-check flow-catalog.md and action registry; flag gaps in registry_needs.

---

## Summary: Readiness Criteria Mapping

| # | Criterion | Blocker? | Auto-Fixable? |
|---|---|---|---|
| 1 | Business Goal | No | No |
| 2 | Preconditions | No | Partially |
| 3 | Test Data Documented | **Yes** | Partially |
| 4 | Test Data Stable | **Yes** | No |
| 5 | All Steps Have Expected Results | **Yes** | Partially |
| 6 | Important Results Have Validation Methods | **Yes** | Partially |
| 7 | Human Required? Marked Correctly | No | Partially |
| 8 | Dynamic Counts Use Ranges | No | Partially |
| 9 | Result Classification | **Yes** | Partially |
| 10 | Automation Readiness Status Correct | **Yes** | Yes |
| 11 | Risks Documented | No | No |
| 12 | Registry Needs Mentioned | No | Partially |

**Blocker criteria (any failure → Blocked or Needs X):** 3, 4, 5, 6, 9, 10
**Info criteria (failure → Needs Clarification):** 1, 2, 7, 8, 11, 12

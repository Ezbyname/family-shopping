# Tangles Test Readiness Review Flow

## 1. Purpose

The readiness review flow is a **safety gate** that validates test case designs before they are created in Azure DevOps or sent to automation teams. It prevents unclear, unstable, incomplete, or risky test cases from being automated prematurely.

**Why this matters:**
- Prevents breaking existing working automation
- Reduces wasted effort on unclear test designs
- Catches missing test data or preconditions early
- Identifies human validation steps that cannot be automated
- Ensures test designs are stable and repeatable

**When it runs:** After you confirm a test design in `/test-case`, but *before* Azure DevOps work items are created.

---

## 2. Where This Fits in the Workflow

The readiness review is **Step 2.5** of the `/test-case` workflow:

1. **User runs `/test-case`** — invokes the skill to create test cases
2. **Step 1: Discuss test scenarios category by category** — present tests by category (Positive, Negative, UI/UX, Performance, etc.)
3. **User confirms test design** — selects which tests to create and approves detailed steps
4. **Step 2: Gather Azure DevOps details** — suite URL, scrum team, sprint, CW automation status
5. **Step 2.5: Readiness Gate** — invokes `/tangles-test-readiness` ← **YOU ARE HERE**
   - Quick-Collect: preconditions + test data
   - Build readiness JSON for each test
   - Run readiness validators
   - Show decision: Ready / Needs Clarification / Needs Test Data / Needs Human Validation / Blocked
6. **Step 3: Create Test Cases** — ADO work items created only if gate is acceptable or user explicitly overrides
7. **Step 4: Add to Suite** — test cases added to the specified suite
8. **Step 5: Open for Review** — suite opened in browser for user review

**Key principle:** `/test-case` is the upstream skill. The readiness review is invoked *as part of* the `/test-case` workflow, not before it.

---

## 3. What `/tangles-test-readiness` Checks

The readiness review validates your test case against **12 automation-readiness criteria**:

### Blockers (Must pass to automate)

1. **Test Data Documented** — Required test data is clearly defined (e.g., search terms, user IDs, fixture data)
2. **All Steps Have Expected Results** — Every action step has a clear expected result
3. **Important Results Have Validation Methods** — Non-human steps specify how to verify results (UI check, API validation, database query, etc.)
4. **Result Classification Defined** — Results are classified as PASS (informational), WARN (important), or FAIL (critical)
5. **Automation Readiness Status Correct** — Declared status is valid and matches actual content
6. **Test Data Stable** — Test data doesn't change unpredictably (or dynamic handling is documented)

### Info-level (Clarifications & recommendations)

7. **Business Goal Present** — Clear, stated reason for the test (>10 characters)
8. **Preconditions Clear** — System state required before test runs (logged in, data loaded, feature enabled, etc.)
9. **Human Required? Marked Correctly** — Steps requiring visual/design/manual inspection are flagged
10. **Dynamic Counts Use Ranges** — Expected results use "at least N" instead of exact counts (when data is dynamic)
11. **Risks Documented** — Known risks and mitigations are identified
12. **Registry Needs Mentioned** — New flows, actions, or helpers that need to be registered are flagged

---

## 4. Required Fields from `/test-case`

Before the readiness gate runs, `/test-case` must collect or have available:

| Field | Source | Auto-derivable? |
|-------|--------|-----------------|
| Test title | User input (Step 1) | No |
| Business goal | Feature name/requirement | Partial (uses feature description if needed) |
| Priority | User selection (Step 1) | No |
| ADO requirement/story | User input | Optional |
| Owner | User input (Step 2) | No |
| **Preconditions** | Quick-Collect (Step 2.5) | No — must ask |
| **Test data** | Quick-Collect (Step 2.5) | No — must ask |
| Test data stability | Quick-Collect answer + default | Partial (defaults to "stable" if not specified) |
| Test steps (action, result) | User confirmed (Step 1) | No |
| Validation method per step | Auto-derived | Yes (defaults to "Verify Content") |
| Human Required? per step | Auto-detected | Yes (keywords: visually verify, compare, looks, renders, design, matches, inspect) |
| Risks | Optional (Step 2.5) | Partial (defaults to empty; info-level only) |
| Registry needs | Optional (Step 2.5) | Partial (defaults to empty; info-level only) |
| Automation readiness status | Auto-derived | Yes (based on human steps + CW automation status) |

**Quick-Collect questions** are asked to collect the two fields that cannot be auto-derived:

---

## 5. Quick-Collect Questions

After confirming all test categories but **before** Azure DevOps details are requested, ask the user:

### Question 1: Preconditions

**"What preconditions must be true before any of these tests start?"**

Preconditions are the system state that must exist. Examples:

- User is logged in as a standard member
- User has Search permissions enabled
- QA environment contains at least 10 sample records
- Monitor feature is enabled for this user
- Dehashed search service is accessible
- No existing filters are applied

*If no preconditions:* User can answer "none" — validator will accept.

### Question 2: Test Data

**"What test data does this test need, and is it stable?"**

Specify input values and whether they are fixed or dynamic. Examples:

- `search_term: John Smith [stable]` — exact value, same every time
- `user_id: 12345 [stable]` — known fixture ID
- `expected_results_count: >= 1 [dynamic]` — count can vary, but "at least 1" is acceptable
- `monitor_name: auto-generated [dynamic, handling: use timestamp fixture]` — generated value, but fixture handles variability
- `no_specific_data` — test works with any valid data, no special setup needed

*If no special test data:* User can answer "none" — validator will accept with placeholder.

*Dynamic data:* If data is dynamic, also explain how it's handled (fixture, mock, range validation, etc.). This prevents exit 2 (Needs Test Data) and instead produces actionable guidance.

---

## 6. Validation Methods

A validation method is the technical approach to verify a step's expected result. Common methods:

- **UI Element Exists** — Button, field, or text is present on screen
- **UI Text Equals** — Exact text match (heading, message, label)
- **UI Contains** — Text/element appears somewhere in the page
- **API Response** — HTTP response status, headers, or body match expected values
- **Database Query** — SQL query returns expected rows or values
- **File/Export** — Generated file exists and contains expected data
- **Screenshot Comparison** — Visual comparison (exact or fuzzy)
- **AI Result Analysis** — Generative AI or ML model classifies results correctly
- **Human Validation Required** — Marked as manual; automation cannot check
- **Exact Count** — Result count equals N (use only if count never changes)
- **At Least / Minimum Count** — Result count >= N (use for dynamic results)
- **Status/State** — Record status is correct (Open, Closed, Active, etc.)
- **Error Message** — Specific error appears when expected
- **Performance/Threshold** — Response time, latency, or size is within limits

### At Least / Minimum Count Validation

**When to use:** The number of results can vary, but there is a meaningful minimum.

**Why:** Exact count validation breaks when data changes. Minimum count is more stable and realistic.

**Examples:**
- Search results: `count >= 1` (at least one match found)
- Active monitors: `count >= 1` (at least one monitor running)
- Exported rows: `count >= 10` (export captured meaningful data)
- Detected entities: `count >= 1` (at least one entity detected)

This is the **preferred approach** for dynamic data in automation.

---

## 7. Readiness Decisions

The readiness review returns one of **5 decisions** (plus exit code 5 for errors):

| Decision | Exit | Meaning | Can Create ADO? |
|----------|------|---------|-----------------|
| **Ready for Automation** | 0 | Test is clear, stable, and ready for automation | ✅ Yes |
| **Needs Clarification** | 1 | Test intent, preconditions, or validation details are unclear | ❌ No (unless overridden) |
| **Needs Test Data** | 2 | Required test data is missing or unstable | ❌ No (unless overridden) |
| **Needs Human Validation** | 3 | One or more steps require human review/judgment | ❌ No (ask user if acceptable) |
| **Blocked** | 4 | Critical issue prevents automation (missing field, invalid status) | ❌ No (rarely override) |
| **Input Error** | 5 | File not found, invalid JSON, or unexpected error | ❌ No (fix file) |

### Exit 0: Ready for Automation

✅ Proceed to ADO creation automatically.

**Important:** This decision is **only returned** when all criteria pass AND **no human validation steps are present**. If any step is marked `human_required: true`, the decision will be exit 3 (Needs Human Validation), not exit 0.

### Exit 1: Needs Clarification

Test is mostly good, but some details are unclear:
- Preconditions missing or vague (e.g., "setup required")
- Expected result unclear (e.g., "should work")
- Validation method missing for an important result

**Next action:** QA clarifies the detail and re-runs the gate, or explicitly approves continuation.

### Exit 2: Needs Test Data

Test design is good, but required data is missing or unstable:
- No specific test data documented
- Test data marked dynamic but no handling strategy (fixture, range, mock)
- Search term or fixture value not specified

**Next action:** QA provides stable data (value + source), or documents dynamic handling (e.g., "use database fixture" or "count >= 1"), then re-runs the gate.

### Exit 3: Needs Human Validation

One or more steps contain visual verification, design inspection, or manual judgment:
- "Verify layout looks correct"
- "Compare screenshot to golden image"
- "Inspect color contrast for accessibility"

**Next action:** QA confirms this is intentional (manual validation is needed) or changes validation method to automated. User approves or re-runs.

**Note:** It is acceptable to create ADO work items with human validation steps. The gate is flagging that automation cannot complete the test alone.

### Exit 4: Blocked

Critical issue prevents automation:
- Missing `automation_readiness_status` field
- Invalid value for `automation_readiness_status`
- Missing `test_data` entirely (no data, no "none" placeholder)
- Step missing expected result
- Result missing classification

**Next action:** QA reviews blocker list, fixes required field, re-runs gate. Override is rare.

---

## 8. Override Policy

**When override is allowed:**

- **Exit 1 (Needs Clarification)** — Override allowed. User records reason (e.g., "preconditions will be clarified during automation"). Proceed to ADO.
- **Exit 2 (Needs Test Data)** — Override allowed. User records action plan (e.g., "QA will provide fixture data during automation sprint"). Proceed to ADO.
- **Exit 3 (Needs Human Validation)** — Override allowed. User confirms this mode is acceptable. Proceed to ADO.
- **Exit 4 (Blocked)** — Override rarely allowed. If overridden, must clearly document the exception and required fix.

**Override requirement:**

When overriding, record:
- Which test is overridden
- Which exit code
- Reason for override
- When the issue will be fixed (e.g., "sprint X", "before automation coding")

**Example:**
> "Override exit 2 for 'Search large dataset': Test data will be provided during QA setup phase. User confirmed: 2026-06-20."

---

## 9. Standalone CLI Usage

The readiness validator can also be run directly on a test case JSON file:

### Text Report

```powershell
python scripts/validate_test_readiness.py --test-case path/to/test_case.json --format text
```

Output: Human-readable text report with decision, blockers, warnings, info, risks, and validation details.

### JSON Report

```powershell
python scripts/validate_test_readiness.py --test-case path/to/test_case.json --format json
```

Output: JSON with decision, confidence, validator results, and exit code. Suitable for CI/CD pipelines or automated reporting.

### Save to File

```powershell
python scripts/validate_test_readiness.py --test-case path/to/test_case.json --format text --output reports/readiness-report.txt
```

Output: Report written to file instead of stdout.

### Exit Code

The exit code matches the decision:

```
0 = Ready for Automation
1 = Needs Clarification
2 = Needs Test Data
3 = Needs Human Validation
4 = Blocked
5 = Input Error
```

Use in scripts: `$? -eq 0` (PowerShell) or `$? == 0` (bash).

---

## 10. Example Readiness JSON

Here is a realistic test case in the readiness JSON format:

```json
{
  "name": "Search by Valid VIN Returns Results",
  "metadata": {
    "business_goal": "Feature 140240: Dehashed VIN and License Plate Search"
  },
  "preconditions": [
    "User is logged in as a standard member",
    "Dehashed search page is accessible",
    "Network connection is stable"
  ],
  "test_data": {
    "vin": {
      "value": "1HGBH41JXMN109186",
      "stable": true
    },
    "expected_min_results": {
      "value": 1,
      "stable": true
    }
  },
  "steps": [
    {
      "action": "Navigate to Dehashed search page",
      "expected_result": "Search page loads successfully",
      "validation_method": "Verify Content",
      "human_required": false
    },
    {
      "action": "Enter VIN 1HGBH41JXMN109186 in the VIN search field",
      "expected_result": "VIN is entered in the search field",
      "validation_method": "Verify Content",
      "human_required": false
    },
    {
      "action": "Click Search button",
      "expected_result": "Results page loads with matching records",
      "validation_method": "Verify Content",
      "human_required": false
    },
    {
      "action": "Review results layout and formatting",
      "expected_result": "Results display cleanly with correct columns",
      "validation_method": "Verify Content",
      "human_required": true
    }
  ],
  "results": [
    {
      "classification": "PASS",
      "description": "Test completes as expected"
    }
  ],
  "automation_readiness_status": "ready_with_manual_steps",
  "risks": [
    {
      "risk": "VIN lookup service may be unavailable",
      "mitigation": "Use mock data or skip test if service is down"
    }
  ],
  "registry_needs": [
    "Search results display helper",
    "VIN validation action"
  ]
}
```

**Key observations:**
- Preconditions are specific and testable
- Test data is documented with stable flag
- Steps include both automated and manual validation
- One step is marked `human_required: true` (layout review) — **this will trigger exit 3 (Needs Human Validation)**
- Result is classified as PASS
- Status is `ready_with_manual_steps` (indicates manual steps present)
- Risks and registry needs are documented
- **Expected readiness decision:** Needs Human Validation (Exit 3) — because the test contains a human_required step, automation cannot complete it alone

---

## 11. Example Report Interpretation

### Decision: Ready for Automation (Exit 0)

```
DECISION: Ready for Automation  [READY]
Confidence: 100%

[AUTOMATION CAN START NOW]
```

**Interpretation:** All criteria pass. Test is clear, stable, and automation can begin. No human review required.

### Decision: Needs Test Data (Exit 2)

```
DECISION: Needs Test Data  [NEEDS TEST DATA]
Confidence: 50%

[AUTOMATION BLOCKED]
[HUMAN REVIEW REQUIRED]

BLOCKERS
-------
(none)

WARNINGS
-------
(none)

SUGGESTED FIXES
------
1. Add stable test data for monitor_name and expected_results_count
2. Specify data handling strategy (fixture, mock, or range validation)
```

**Interpretation:** Test design is good, but test data is missing or unstable. Before ADO creation, QA must:
- Provide specific test values (e.g., `monitor_name: Test Monitor 001`)
- Or define dynamic handling (e.g., `expected_count >= 1`)

**Next action:**
1. Update test case with stable data or dynamic handling
2. Re-run the readiness gate
3. Proceed to ADO creation when exit is 0 or 1

### Decision: Needs Human Validation (Exit 3)

```
DECISION: Needs Human Validation  [NEEDS HUMAN]
Confidence: 70%

[AUTOMATION BLOCKED]
[HUMAN REVIEW REQUIRED]

BLOCKERS
-------
(none)

WARNINGS
-------
(none)

VALIDATION DETAILS
---------
[PASS] Business Goal Present
[PASS] Preconditions Clear
[PASS] Test Data Documented
[PASS] Test Data Stable
[PASS] All Steps Have Expected Results
[FAIL] Important Results Have Validation Methods: step 3 (layout review) marked human_required=true, omits validation_method
[PASS] Human Required? Marked Correctly
[PASS] Dynamic Counts Use Ranges
[PASS] Result Classification Defined
[PASS] Automation Readiness Status Correct
[PASS] Risks Documented
[PASS] Registry Needs Mentioned
```

**Interpretation:** Test design is good and data is stable, but one or more steps require **human judgment or visual inspection**. Step 3 ("Review results layout and formatting") is marked `human_required: true`, meaning a human must verify the layout visually.

**Next action:**
1. **Confirm with QA:** Is human validation truly required for this step, or can it be automated (e.g., screenshot comparison, pixel validation)?
2. **If human validation is intentional:** Proceed to ADO creation. The test will be marked as requiring manual review during execution.
3. **If automation is preferred:** Change the validation method to automated (e.g., "UI Element Exists" or "Screenshot Comparison") and re-run the gate.

---

## 12. Registry Needs

**What are registry needs?**

When a test introduces a new flow, reusable action, button, helper function, or automation concept that does not already exist, it should be **registered** in the project's registry so other tests and automation can reuse it.

**Examples of things that need registry entries:**
- New search filter action
- Custom assertion helper
- Fixture or test data factory
- Reusable page object or component
- New automation concept (e.g., "At Least count validation")

**Important:** The readiness review **does not create registry entries itself.** It only *flags* that registry work may be needed before automation coding starts.

**Next action:**
When registry needs are flagged, coordinate with the automation team to:
1. Decide if reusable components are worth extracting
2. Create registry entries in the project's registration system
3. Document for future tests

---

## 13. What This Does Not Do

The readiness review is **not**:

- ❌ Does not automate the test (that is the automation engineer's job)
- ❌ Does not create Azure DevOps work items by itself (only triggers ADO creation in `/test-case` after gate passes)
- ❌ Does not modify production automation code
- ❌ Does not approve risky tests automatically (human judgment still required for "Needs Human Validation")
- ❌ Does not replace QA expertise (it is a checklist, not a replacement for critical thinking)

**What it does:**

- ✅ Validates test designs against 12 automation-readiness criteria
- ✅ Identifies missing or unclear requirements early
- ✅ Flags tests that need human review before automation
- ✅ Catches unstable test data and precondition issues
- ✅ Provides actionable suggested fixes
- ✅ Prevents low-quality tests from being automated
- ✅ Gives QA and automation teams confidence in test clarity

---

## 14. Troubleshooting

### Problem: "Needs Test Data"

**Symptoms:**
```
DECISION: Needs Test Data
```

**Cause:** Required test data is missing or marked unstable without handling strategy.

**Fix:**
1. Identify which data is unstable or missing (from "SUGGESTED FIXES" section)
2. Provide **specific values** (e.g., `search_term: "John Smith"`) OR
3. Define **dynamic handling** (e.g., `expected_count >= 1`, `use fixture`, `mock API`)
4. Update test case JSON
5. Re-run readiness gate

---

### Problem: "Needs Clarification"

**Symptoms:**
```
DECISION: Needs Clarification
```

**Cause:** Preconditions, expected results, or validation methods are unclear.

**Fix:**
1. Review "SUGGESTED FIXES" section for specific items
2. Common causes:
   - Preconditions too vague (e.g., "setup" instead of "User logged in as admin")
   - Expected result unclear (e.g., "should work" instead of "Results page displays 5+ matches")
   - Validation method missing (how will you verify the result?)
3. Clarify and re-run readiness gate

---

### Problem: "Needs Human Validation"

**Symptoms:**
```
DECISION: Needs Human Validation
```

**Cause:** One or more steps require visual/design inspection or manual judgment.

**Options:**
1. **Accept this mode:** Tests with human steps are valid. ADO creation can proceed.
2. **Change validation method:** Convert visual check to automated check (screenshot comparison, pixel validation, etc.)
3. Confirm with user and proceed to ADO

---

### Problem: "Blocked"

**Symptoms:**
```
DECISION: Blocked
```

**Cause:** Critical required field is missing or invalid.

**Fix:**
1. Review "BLOCKERS" section — identifies exact missing/invalid fields
2. Common causes:
   - Missing `automation_readiness_status` field
   - Invalid `automation_readiness_status` value (must be: `ready_for_automation`, `ready_with_manual_steps`, `needs_clarification`, `needs_test_data`, `blocked`)
   - Missing step `expected_result`
   - Missing result `classification` (must be: `PASS`, `WARN`, or `FAIL`)
3. Fix the required field
4. Re-run readiness gate
5. Do not override Blocked unless it is truly an exceptional situation

---

### Problem: "Exit code 5"

**Symptoms:**
```
ERROR: Invalid JSON in path/to/test_case.json
```

**Cause:** File not found, invalid JSON, or unexpected schema error.

**Fix:**
1. Verify file path is correct
2. Validate JSON syntax (use a JSON linter or editor)
3. Verify the JSON matches the expected schema (all required fields present)
4. Check for typos in field names and values
5. Try again with corrected file

---

## Next Steps

- **From within `/test-case`:** After the readiness gate passes or user approves, proceed to Step 3 (Create Test Cases) automatically.
- **Standalone validation:** Run the CLI command on an existing test case JSON to get a detailed readiness report.
- **Questions or feedback:** Refer to the implementation plan or readiness criteria reference documentation.

---

*Last updated: 2026-06-18*
*For implementation details, see: `docs/superpowers/plans/2026-06-17-tangles-test-readiness-review.md`*
*For detailed readiness criteria, see: `docs/references/readiness-criteria.md`*

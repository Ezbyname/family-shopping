"""
Decision logic for test case readiness.

Maps validation results from readiness_criteria.run_all_validations()
to one of 5 decision levels.
"""

from readiness_criteria import BLOCKER_CRITERIA

DECISIONS = {
    'ready': 'Ready for Automation',
    'needs_clarification': 'Needs Clarification',
    'needs_test_data': 'Needs Test Data',
    'needs_human': 'Needs Human Validation',
    'blocked': 'Blocked',
}

_CONF_KEY_READY_WITH_INFO = 'Ready for Automation (with info warnings)'

CONFIDENCE = {
    'Ready for Automation': 1.0,
    _CONF_KEY_READY_WITH_INFO: 0.85,
    'Needs Human Validation': 0.7,
    'Needs Clarification': 0.6,
    'Needs Test Data': 0.5,
    'Blocked': 0.2,
}

_TEST_DATA_CRITERIA = {'Test Data Documented', 'Test Data Stable'}
_HUMAN_MARKING_CRITERION = 'Human Required? Marked Correctly'


def _format_missing_fields(details):
    """Extract missing-field info from a single validator's details dict.

    Returns a list of human-readable strings describing missing or problematic
    fields/steps discovered by that validator.
    """
    items = []

    # Steps missing expected_result
    for idx in details.get('steps_missing_results', []):
        items.append(f'step {idx}: missing expected_result')

    # Steps missing validation_method
    for idx in details.get('steps_missing_methods', []):
        items.append(f'step {idx}: missing validation_method')

    # Unstable test data entries
    for entry in details.get('unstable_entries', []):
        items.append(f'test_data.{entry}: unstable')

    # Steps potentially requiring human interaction but not flagged
    for idx in details.get('steps_potentially_manual', []):
        items.append(f'step {idx}: potentially manual but human_required not set')

    return items


def compute_decision(validation_results, test_case):
    """Compute a single structured decision dict from validation results.

    Parameters
    ----------
    validation_results : list of (bool, dict)
        Output of readiness_criteria.run_all_validations().
    test_case : dict
        The raw test case being evaluated.

    Returns
    -------
    dict
        Structured decision with all diagnostic fields populated.
    """
    if test_case is None:
        test_case = {}

    if validation_results is None:
        validation_results = []

    # ------------------------------------------------------------------ #
    # 1. Partition results into buckets
    # ------------------------------------------------------------------ #
    failed_blockers = []     # (criterion, details) for severity=='blocker' failures
    failed_info = []         # (criterion, details) for severity!='blocker' failures

    missing_fields = []
    suggested_fixes_seen = set()
    suggested_fixes = []

    for is_valid, details in validation_results:
        criterion = details.get('criterion', '')
        severity = details.get('severity', 'info')
        fix = details.get('suggested_fix')

        if not is_valid:
            # Collect missing fields regardless of severity
            missing_fields.extend(_format_missing_fields(details))

            # Collect suggested fixes (deduplicated, preserving insertion order)
            if fix and fix not in suggested_fixes_seen:
                suggested_fixes_seen.add(fix)
                suggested_fixes.append(fix)

            if severity == 'blocker':
                failed_blockers.append((criterion, details))
            else:
                failed_info.append((criterion, details))

    # ------------------------------------------------------------------ #
    # 2. Build blockers / warnings / info lists
    # ------------------------------------------------------------------ #
    blockers_list = []
    for criterion, details in failed_blockers:
        fix = details.get('suggested_fix')
        entry = criterion
        if fix:
            entry = f'{criterion}: {fix}'
        blockers_list.append(entry)

    # Classify non-blocker failures as warnings or info
    # Treat human-marking and dynamic-count criteria as pure info;
    # anything else that touches data safety is a warning.
    _pure_info_criteria = {
        'Human Required? Marked Correctly',
        'Dynamic Counts Use Ranges',
        'Business Goal Present',
        'Risks Documented',
        'Registry Needs Mentioned',
    }
    warnings_list = []
    info_list = []
    for criterion, details in failed_info:
        fix = details.get('suggested_fix')
        entry = criterion
        if fix:
            entry = f'{criterion}: {fix}'
        if criterion in _pure_info_criteria:
            info_list.append(entry)
        else:
            warnings_list.append(entry)

    # ------------------------------------------------------------------ #
    # 3. Determine decision in priority order
    # ------------------------------------------------------------------ #
    steps = [s for s in test_case.get('steps', []) if isinstance(s, dict)]
    has_human_steps = any(s.get('human_required', False) for s in steps)

    if failed_blockers:
        # Priority 1: Blocked
        decision_label = DECISIONS['blocked']
        can_start = False
        human_required = True
        confidence = CONFIDENCE['Blocked']

    else:
        # No blocker failures — check lower-priority paths

        # Priority 2: non-blocker test-data criterion failure (fallback for callers
        # who pass test-data criteria with severity != 'blocker').
        # NOTE: Under normal operation both 'Test Data Documented' and 'Test Data Stable'
        # have severity='blocker' in readiness_criteria.py, so they always land in
        # failed_blockers (Priority-1) and this branch is unreachable in standard usage.
        # It is retained as a safety net for non-standard callers.
        test_data_criteria_failed = any(
            criterion in _TEST_DATA_CRITERIA
            for criterion, _ in failed_info
        )

        # Priority 3: Needs Human Validation — triggered by human steps in test_case
        # OR by the "Human Required? Marked Correctly" criterion failing
        human_criterion_failed = any(
            criterion == _HUMAN_MARKING_CRITERION
            for criterion, details in failed_info
        )

        if test_data_criteria_failed:
            # Priority 2: Needs Test Data (driven by validation results)
            decision_label = DECISIONS['needs_test_data']
            can_start = False
            human_required = True
            confidence = CONFIDENCE['Needs Test Data']

        elif has_human_steps or human_criterion_failed:
            # Priority 3: Needs Human Validation
            # Human steps exist or the marking criterion failed.
            decision_label = DECISIONS['needs_human']
            can_start = False
            human_required = True
            confidence = CONFIDENCE['Needs Human Validation']

        elif warnings_list:
            # Priority 4: Needs Clarification — non-blocker but meaningful failures
            # (e.g., missing result classification with non-blocker severity)
            decision_label = DECISIONS['needs_clarification']
            can_start = False
            # human_required=True: human must clarify; human-step cases are
            # already intercepted by Priority 3 above, so this is always correct.
            human_required = True
            confidence = CONFIDENCE['Needs Clarification']

        elif info_list:
            # Priority 4b: Ready for Automation with advisory recommendations
            # Pure info failures (Business Goal vague, Risks undocumented, etc.)
            # do not block automation — they are surfaced as recommendations only.
            decision_label = DECISIONS['ready']
            can_start = True
            human_required = False
            confidence = CONFIDENCE[_CONF_KEY_READY_WITH_INFO]

        else:
            # Priority 5: Ready for Automation — no issues at all
            # Reached only when: no blockers, no test-data gaps, no human steps,
            # no clarification-level warnings. Info-only items are surfaced as
            # recommendations but do not block automation.
            decision_label = DECISIONS['ready']
            can_start = True
            human_required = False  # human steps always caught by Priority 3
            confidence = CONFIDENCE['Ready for Automation']

    # ------------------------------------------------------------------ #
    # 4. Risks
    # ------------------------------------------------------------------ #
    raw_risks = test_case.get('risks', [])
    if isinstance(raw_risks, list) and raw_risks:
        risks_list = []
        for item in raw_risks:
            if isinstance(item, dict) and item.get('risk'):
                risk_text = item['risk']
                mitigation = item.get('mitigation', '')
                if mitigation:
                    risks_list.append(f'{risk_text}: {mitigation}')
                else:
                    risks_list.append(risk_text)
            else:
                risks_list.append(str(item))
    else:
        risks_list = ['No risks documented']

    # ------------------------------------------------------------------ #
    # 5. Assemble output
    # ------------------------------------------------------------------ #
    return {
        'decision': decision_label,
        'confidence': confidence,
        'missing_fields': missing_fields,
        'risks': risks_list,
        'suggested_fixes': suggested_fixes,
        'can_start_automation_now': can_start,
        'human_review_required': human_required,
        'registry_needs': test_case.get('registry_needs', []),
        'blockers': blockers_list,
        'warnings': warnings_list,
        'info': info_list,
    }

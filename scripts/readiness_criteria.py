"""
Readiness validators for test case automation.

Each validator checks one criterion and returns (is_valid: bool, details: dict).
"""

MANUAL_INDICATORS = [
    'visually verify', 'compare', 'looks', 'renders',
    'design', 'matches', 'inspect'
]

BLOCKER_CRITERIA = {
    'Test Data Documented',
    'All Steps Have Expected Results',
    'Important Results Have Validation Methods',
    'Result Classification Defined',
    'Automation Readiness Status Correct',
}


def validate_business_goal_present(test_case):
    goal = test_case.get('metadata', {}).get('business_goal', '').strip()
    is_valid = len(goal) > 10
    return is_valid, {
        'criterion': 'Business Goal Present',
        'is_valid': is_valid,
        'value': goal or '[MISSING]',
        'severity': 'info',
        'suggested_fix': 'Add a clear business goal (>10 chars) to metadata.business_goal' if not is_valid else None,
    }


def validate_preconditions_clear(test_case):
    preconditions = test_case.get('preconditions', [])
    is_valid = (
        isinstance(preconditions, list)
        and len(preconditions) > 0
        and all(isinstance(p, str) and len(p.strip()) > 5 for p in preconditions)
    )
    return is_valid, {
        'criterion': 'Preconditions Clear',
        'is_valid': is_valid,
        'count': len(preconditions) if isinstance(preconditions, list) else 0,
        'severity': 'info',
        'suggested_fix': 'Document each precondition as a testable state (e.g., "User is logged in")' if not is_valid else None,
    }


def validate_test_data_documented(test_case):
    test_data = test_case.get('test_data', {})
    is_valid = (
        isinstance(test_data, dict)
        and len(test_data) > 0
        and all(isinstance(v, dict) and 'value' in v for v in test_data.values())
    )
    return is_valid, {
        'criterion': 'Test Data Documented',
        'is_valid': is_valid,
        'data_entries': len(test_data) if isinstance(test_data, dict) else 0,
        'severity': 'blocker',
        'suggested_fix': 'Add all data values to test_data dict with at minimum a "value" key' if not is_valid else None,
    }


def validate_test_data_stable(test_case):
    test_data = test_case.get('test_data', {})
    if not isinstance(test_data, dict):
        unstable = []
    else:
        unstable = [
            k for k, v in test_data.items()
            if isinstance(v, dict) and not v.get('stable', False) and not v.get('handling')
        ]
    is_valid = len(unstable) == 0
    return is_valid, {
        'criterion': 'Test Data Stable',
        'is_valid': is_valid,
        'unstable_entries': unstable,
        'severity': 'info',
        'suggested_fix': 'Mark dynamic data stable=true or add a "handling" field explaining how instability is managed' if not is_valid else None,
    }


def validate_all_steps_have_expected_results(test_case):
    steps = [s for s in test_case.get('steps', []) if isinstance(s, dict)]
    missing = [
        i for i, step in enumerate(steps)
        if step.get('action', '').strip() and not step.get('expected_result', '').strip()
    ]
    is_valid = len(missing) == 0
    return is_valid, {
        'criterion': 'All Steps Have Expected Results',
        'is_valid': is_valid,
        'steps_missing_results': missing,
        'severity': 'blocker',
        'suggested_fix': 'For each action step, add a non-empty expected_result' if not is_valid else None,
    }


def validate_important_results_have_validation_methods(test_case):
    steps = [s for s in test_case.get('steps', []) if isinstance(s, dict)]
    missing = [
        i for i, step in enumerate(steps)
        if step.get('action', '').strip()
        and not step.get('human_required', False)
        and not step.get('validation_method', '').strip()
    ]
    is_valid = len(missing) == 0
    return is_valid, {
        'criterion': 'Important Results Have Validation Methods',
        'is_valid': is_valid,
        'steps_missing_methods': missing,
        'severity': 'blocker',
        'suggested_fix': 'Bind each non-manual step result to: Verify Count, Verify Content, Verify Filter Badge, or Manual' if not is_valid else None,
    }


def validate_human_required_marked_correctly(test_case):
    steps = [s for s in test_case.get('steps', []) if isinstance(s, dict)]
    flagged = [
        i for i, step in enumerate(steps)
        if any(ind in step.get('action', '').lower() for ind in MANUAL_INDICATORS)
        and not step.get('human_required', False)
    ]
    is_valid = len(flagged) == 0
    return is_valid, {
        'criterion': 'Human Required? Marked Correctly',
        'is_valid': is_valid,
        'steps_potentially_manual': flagged,
        'severity': 'info',
        'suggested_fix': 'Mark steps containing visual/design/comparison keywords as human_required=True' if not is_valid else None,
    }


def validate_dynamic_counts_use_ranges(test_case):
    steps = [s for s in test_case.get('steps', []) if isinstance(s, dict)]
    rigid = [
        i for i, step in enumerate(steps)
        if 'exactly' in step.get('expected_result', '').lower()
        and 'count' in step.get('validation_method', '').lower()
    ]
    is_valid = len(rigid) == 0
    return is_valid, {
        'criterion': 'Dynamic Counts Use Ranges',
        'is_valid': is_valid,
        'steps_with_rigid_counts': rigid,
        'severity': 'info',
        'suggested_fix': 'Replace exact count expectations with "at least N" or "N-M" ranges for dynamic data' if not is_valid else None,
    }


def validate_result_classification_defined(test_case):
    results = test_case.get('results', [])
    valid_classifications = {'PASS', 'WARN', 'FAIL'}
    unclassified = [
        i for i, r in enumerate(results)
        if not isinstance(r, dict) or r.get('classification') not in valid_classifications
    ]
    is_valid = len(results) > 0 and len(unclassified) == 0
    return is_valid, {
        'criterion': 'Result Classification Defined',
        'is_valid': is_valid,
        'results_total': len(results),
        'results_unclassified': unclassified,
        'severity': 'blocker',
        'suggested_fix': 'Classify each result as FAIL (critical), WARN (important), or PASS (informational)' if not is_valid else None,
    }


def validate_automation_readiness_status_correct(test_case):
    declared = test_case.get('automation_readiness_status', '')
    valid_statuses = {
        'ready_for_automation', 'ready_with_manual_steps',
        'needs_clarification', 'needs_test_data', 'blocked',
    }
    is_valid = declared in valid_statuses
    return is_valid, {
        'criterion': 'Automation Readiness Status Correct',
        'is_valid': is_valid,
        'declared': declared or '[MISSING]',
        'severity': 'blocker',
        'suggested_fix': f'Set automation_readiness_status to one of: {", ".join(sorted(valid_statuses))}' if not is_valid else None,
    }


def validate_risks_documented(test_case):
    risks = test_case.get('risks', [])
    is_valid = (
        isinstance(risks, list)
        and len(risks) > 0
        and all(isinstance(r, dict) and r.get('risk') and r.get('mitigation') for r in risks)
    )
    return is_valid, {
        'criterion': 'Risks Documented',
        'is_valid': is_valid,
        'risks_count': len(risks) if isinstance(risks, list) else 0,
        'severity': 'info',
        'suggested_fix': 'Add at least one risk with mitigation: [{"risk": "...", "mitigation": "..."}]' if not is_valid else None,
    }


def validate_registry_needs_mentioned(test_case):
    registry_needs = test_case.get('registry_needs', None)
    is_valid = isinstance(registry_needs, list)
    return is_valid, {
        'criterion': 'Registry Needs Mentioned',
        'is_valid': is_valid,
        'needs_count': len(registry_needs) if is_valid else 0,
        'needs': registry_needs if is_valid else '[MISSING FIELD]',
        'severity': 'info',
        'suggested_fix': 'Add registry_needs field (empty list [] if using only existing flows/actions)' if not is_valid else None,
    }


def run_all_validations(test_case):
    """Run all 12 validators and return list of (is_valid, details) tuples."""
    if test_case is None:
        test_case = {}
    return [
        validate_business_goal_present(test_case),
        validate_preconditions_clear(test_case),
        validate_test_data_documented(test_case),
        validate_test_data_stable(test_case),
        validate_all_steps_have_expected_results(test_case),
        validate_important_results_have_validation_methods(test_case),
        validate_human_required_marked_correctly(test_case),
        validate_dynamic_counts_use_ranges(test_case),
        validate_result_classification_defined(test_case),
        validate_automation_readiness_status_correct(test_case),
        validate_risks_documented(test_case),
        validate_registry_needs_mentioned(test_case),
    ]

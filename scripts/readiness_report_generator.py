"""
Report generator for test case readiness assessments.

Formats decision results into human-readable text or machine-readable JSON.
"""

import json

_SEP = '-' * 70
_HDR = '=' * 70

def _safe_unpack(entry):
    """Safely unpack a validation_results entry to (bool, dict)."""
    if isinstance(entry, (list, tuple)) and len(entry) == 2:
        return entry[0], entry[1] if isinstance(entry[1], dict) else {}
    return False, {}


_DECISION_LABELS = {
    'Ready for Automation': '[READY]',
    'Needs Clarification': '[NEEDS CLARIFICATION]',
    'Needs Test Data': '[NEEDS TEST DATA]',
    'Needs Human Validation': '[NEEDS HUMAN]',
    'Blocked': '[BLOCKED]',
}


def _format_list_section(title, items, empty_label='(none)'):
    """Render a titled section with a numbered list or an empty-label fallback."""
    lines = [_SEP, title, _SEP]
    if items:
        for i, item in enumerate(items, 1):
            lines.append(f'{i}. {item}')
    else:
        lines.append(empty_label)
    return lines


def format_report(test_case_name, validation_results, decision_result):
    """Return a plain-text readiness report (ASCII-safe, no Unicode).

    Parameters
    ----------
    test_case_name : str
        Display name for the test case.
    validation_results : list of (bool, dict)
        Output of readiness_criteria.run_all_validations().
    decision_result : dict
        Output of readiness_decision.compute_decision().

    Returns
    -------
    str
        Multi-line ASCII report string.
    """
    decision = decision_result.get('decision', '')
    confidence = decision_result.get('confidence', 0.0)
    can_start = decision_result.get('can_start_automation_now', False)
    human_required = decision_result.get('human_review_required', False)
    blockers = decision_result.get('blockers', [])
    warnings = decision_result.get('warnings', [])
    info = decision_result.get('info', [])
    risks = decision_result.get('risks', [])
    suggested_fixes = decision_result.get('suggested_fixes', [])
    registry_needs = decision_result.get('registry_needs', [])

    decision_label = _DECISION_LABELS.get(decision, f'[{decision.upper()}]')
    confidence_pct = int(round(confidence * 100))

    lines = []

    # Header
    lines.append(_HDR)
    lines.append(f'Test Case Readiness Assessment: {test_case_name}')
    lines.append(_HDR)
    lines.append('')

    # Decision block
    lines.append(f'DECISION: {decision}  {decision_label}')
    lines.append(f'Confidence: {confidence_pct}%')
    lines.append('')

    # Automation start line — always shown
    if can_start:
        lines.append('[AUTOMATION CAN START NOW]')
    else:
        lines.append('[AUTOMATION BLOCKED]')

    # Human review line — only shown when required
    if human_required:
        lines.append('[HUMAN REVIEW REQUIRED]')

    lines.append('')

    # Blockers
    lines.extend(_format_list_section('BLOCKERS  (must fix before automation)', blockers))
    lines.append('')

    # Warnings
    lines.extend(_format_list_section('WARNINGS  (review before automation)', warnings))
    lines.append('')

    # Info / Recommendations
    lines.extend(_format_list_section('INFO / RECOMMENDATIONS', info))
    lines.append('')

    # Risks — filter sentinel value; default empty_label '(none)' is used
    risks_display = [r for r in risks if r != 'No risks documented']
    lines.extend(_format_list_section('RISKS', risks_display))
    lines.append('')

    # Suggested Fixes
    lines.extend(_format_list_section('SUGGESTED FIXES', suggested_fixes))
    lines.append('')

    # Registry Entries Needed
    lines.append(_SEP)
    lines.append('REGISTRY ENTRIES NEEDED')
    lines.append(_SEP)
    if registry_needs:
        for entry in registry_needs:
            if isinstance(entry, dict):
                entry_type = entry.get('type', '')
                entry_name = entry.get('name', '')
                entry_status = entry.get('status', '')
                lines.append(f'  - {entry_type}: {entry_name}  (status: {entry_status})')
            else:
                lines.append(f'  - {entry}')
    else:
        lines.append('(none)')
    lines.append('')

    # Validation Details
    lines.append(_SEP)
    lines.append('VALIDATION DETAILS')
    lines.append(_SEP)
    for entry in validation_results:
        is_valid, details = _safe_unpack(entry)
        criterion = details.get('criterion', '')
        tag = '[PASS]' if is_valid else '[FAIL]'
        lines.append(f'  {tag} {criterion}')

    lines.append('')
    lines.append(_HDR)

    return '\n'.join(lines)


def format_json_report(test_case_name, validation_results, decision_result):
    """Return a JSON string representation of the readiness assessment.

    Parameters
    ----------
    test_case_name : str
        Display name for the test case.
    validation_results : list of (bool, dict)
        Output of readiness_criteria.run_all_validations().
    decision_result : dict
        Output of readiness_decision.compute_decision().

    Returns
    -------
    str
        JSON string, indented, ASCII-safe.
    """
    validation_summary = []
    for entry in validation_results:
        is_valid, details = _safe_unpack(entry)
        validation_summary.append({'criterion': details.get('criterion', ''), 'passed': is_valid})

    payload = {
        'test_case': test_case_name,
        'decision': decision_result.get('decision', ''),
        'confidence': decision_result.get('confidence', 0.0),
        'can_start_automation_now': decision_result.get('can_start_automation_now', False),
        'human_review_required': decision_result.get('human_review_required', False),
        'blockers': decision_result.get('blockers', []),
        'warnings': decision_result.get('warnings', []),
        'info': decision_result.get('info', []),
        'risks': decision_result.get('risks', []),
        'suggested_fixes': decision_result.get('suggested_fixes', []),
        'registry_needs': decision_result.get('registry_needs', []),
        'missing_fields': decision_result.get('missing_fields', []),
        'validation_summary': validation_summary,
    }

    return json.dumps(payload, indent=2, ensure_ascii=True)

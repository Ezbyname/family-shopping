#!/usr/bin/env python3
"""
Main CLI entry point for test case readiness validation.

Usage:
    python validate_test_readiness.py --test-case <path.json> [--format text|json] [--output <path>]
"""

import argparse
import json
import sys
from pathlib import Path

# Add scripts/ directory to path so peer modules can be imported
sys.path.insert(0, str(Path(__file__).parent))

from readiness_criteria import run_all_validations
from readiness_decision import compute_decision
from readiness_report_generator import format_report, format_json_report

EXIT_CODES = {
    'Ready for Automation': 0,
    'Needs Clarification': 1,
    'Needs Test Data': 2,
    'Needs Human Validation': 3,
    'Blocked': 4,
}


def load_test_case(path_str):
    """Load and parse a test case JSON file. Exits with code 5 on any failure."""
    path = Path(path_str)
    if not path.exists():
        print(f'ERROR: File not found: {path_str}', file=sys.stderr)
        sys.exit(5)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        print(f'ERROR: Invalid JSON in {path_str}: {e}', file=sys.stderr)
        sys.exit(5)
    except Exception as e:
        print(f'ERROR: Could not read {path_str}: {e}', file=sys.stderr)
        sys.exit(5)


def main():
    parser = argparse.ArgumentParser(
        description='Validate a test case JSON file for automation readiness.'
    )
    parser.add_argument('--test-case', required=True, metavar='PATH',
                        help='Path to the test case JSON file')
    parser.add_argument('--format', choices=['text', 'json'], default='text',
                        dest='fmt', help='Output format (default: text)')
    parser.add_argument('--output', metavar='PATH',
                        help='Write report to this file instead of stdout')
    args = parser.parse_args()

    test_case = load_test_case(args.test_case)
    test_case_name = test_case.get('name', Path(args.test_case).stem)

    try:
        validation_results = run_all_validations(test_case)
        decision_result = compute_decision(validation_results, test_case)
    except Exception as e:
        print(f'ERROR: Validation failed unexpectedly: {e}', file=sys.stderr)
        sys.exit(5)

    try:
        if args.fmt == 'json':
            report = format_json_report(test_case_name, validation_results, decision_result)
        else:
            report = format_report(test_case_name, validation_results, decision_result)
    except Exception as e:
        print(f'ERROR: Report generation failed for {args.test_case}: {e}', file=sys.stderr)
        sys.exit(5)

    if args.output:
        try:
            out_path = Path(args.output)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(report, encoding='utf-8')
        except Exception as e:
            print(f'ERROR: Could not write to {args.output}: {e}', file=sys.stderr)
            sys.exit(5)
    else:
        print(report)

    exit_code = EXIT_CODES.get(decision_result.get('decision', ''), 5)
    sys.exit(exit_code)


if __name__ == '__main__':
    main()

"""Fetch an ADO test plan suite and dump it as markdown for assess_plan.py.

Reads PAT from %USERPROFILE%\.claude\secrets\ado_pat.txt (stripping BOM/whitespace).
"""
import base64
import html
import json
import os
import re
import sys
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

ORG = "cobwebsdev"
PROJECT = "Tangles - V7"
PLAN_ID = 25091
SUITE_ID = 144486

PAT_PATH = os.path.join(os.environ["USERPROFILE"], ".claude", "secrets", "ado_pat.txt")
OUT_MD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plan.md")
OUT_RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw_dump.json")


def load_pat() -> str:
    with open(PAT_PATH, "rb") as f:
        data = f.read()
    # strip UTF-8/16 BOM
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    elif data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        data = data.decode("utf-16").encode("utf-8")
    pat = data.decode("utf-8", errors="replace").strip()
    if not pat:
        raise SystemExit("PAT file is empty")
    return pat


def auth_header(pat: str) -> str:
    token = base64.b64encode(f":{pat}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def ado_get(url: str, pat: str) -> dict:
    req = urllib.request.Request(url, headers={
        "Authorization": auth_header(pat),
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise SystemExit(f"HTTP {e.code} on {url}\n{body}")


def org_url(path: str) -> str:
    from urllib.parse import quote
    return f"https://dev.azure.com/{ORG}/{quote(PROJECT)}/_apis/{path}"


def strip_html(s: str) -> str:
    if not s:
        return ""
    # ADO returns step actions/expected as HTML fragments — usually <P>, <DIV>, <BR>
    s = re.sub(r"<\s*br\s*/?\s*>", "\n", s, flags=re.I)
    s = re.sub(r"</\s*(p|div|li)\s*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    return s.strip()


def parse_steps_xml(xml_str: str) -> list[dict]:
    """Parse the Microsoft.VSTS.TCM.Steps XML payload."""
    if not xml_str:
        return []
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return [{"action": strip_html(xml_str), "expected": ""}]
    out = []
    for step in root.findall(".//step"):
        params = step.findall("parameterizedString")
        action = strip_html(params[0].text if len(params) > 0 and params[0].text else "")
        expected = strip_html(params[1].text if len(params) > 1 and params[1].text else "")
        out.append({"action": action, "expected": expected})
    return out


def fmt_case(idx: int, wi: dict) -> str:
    fields = wi.get("fields", {})
    wid = wi.get("id")
    title = fields.get("System.Title", f"Test Case {wid}")
    desc = strip_html(fields.get("System.Description", ""))
    steps_xml = fields.get("Microsoft.VSTS.TCM.Steps", "")
    steps = parse_steps_xml(steps_xml)
    acc = strip_html(fields.get("Microsoft.VSTS.Common.AcceptanceCriteria", ""))

    lines = [f"## Scenario {idx}: {title}  _(work item {wid})_", ""]
    if desc:
        lines += ["**Description:**", desc, ""]
    if steps:
        lines.append("**Steps:**")
        for i, s in enumerate(steps, 1):
            act = s["action"] or "(empty action)"
            lines.append(f"{i}. {act}")
            if s["expected"]:
                lines.append(f"   - _Expected:_ {s['expected']}")
        lines.append("")
    if acc:
        lines += ["**Acceptance criteria:**", acc, ""]
    return "\n".join(lines)


def main() -> int:
    pat = load_pat()
    print(f"[ado] PAT loaded ({len(pat)} chars)", file=sys.stderr)

    # 1. List test cases in the suite
    list_url = org_url(f"testplan/Plans/{PLAN_ID}/Suites/{SUITE_ID}/TestCase?api-version=7.1")
    print(f"[ado] GET {list_url}", file=sys.stderr)
    listing = ado_get(list_url, pat)
    cases = listing.get("value", [])
    print(f"[ado] suite returned {len(cases)} test case(s)", file=sys.stderr)

    if not cases:
        print(json.dumps(listing, indent=2)[:2000], file=sys.stderr)
        raise SystemExit("No test cases returned. Check planId/suiteId/PAT scopes.")

    # 2. Collect work item IDs (the test case's actual work item)
    wi_ids = []
    for c in cases:
        wid = (c.get("workItem") or {}).get("id") or c.get("id")
        if wid:
            wi_ids.append(int(wid))
    print(f"[ado] {len(wi_ids)} work-item IDs to fetch", file=sys.stderr)

    # 3. Fetch work items in batches of 200
    fields_csv = "System.Title,System.Description,Microsoft.VSTS.TCM.Steps,Microsoft.VSTS.Common.AcceptanceCriteria,System.State"
    items: list[dict] = []
    BATCH = 200
    for i in range(0, len(wi_ids), BATCH):
        chunk = wi_ids[i:i+BATCH]
        ids_csv = ",".join(str(x) for x in chunk)
        wi_url = f"https://dev.azure.com/{ORG}/_apis/wit/workitems?ids={ids_csv}&fields={fields_csv}&api-version=7.1"
        print(f"[ado] GET workitems batch ({len(chunk)})", file=sys.stderr)
        resp = ado_get(wi_url, pat)
        items.extend(resp.get("value", []))

    # Preserve suite ordering
    by_id = {w["id"]: w for w in items}
    ordered = [by_id[i] for i in wi_ids if i in by_id]

    # 4. Dump raw for debugging
    with open(OUT_RAW, "w", encoding="utf-8") as f:
        json.dump({"suite": listing, "workItems": items}, f, indent=2, ensure_ascii=False)

    # 5. Render markdown
    title = f"ADO Plan {PLAN_ID} / Suite {SUITE_ID}"
    md_lines = [f"# {title}", "", f"_{len(ordered)} test case(s) from {ORG}/{PROJECT}_", ""]
    for idx, wi in enumerate(ordered, 1):
        md_lines.append(fmt_case(idx, wi))
    md = "\n".join(md_lines)

    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write(md)
    print(f"[ado] wrote {OUT_MD} ({len(md)} chars)", file=sys.stderr)
    print(f"[ado] wrote {OUT_RAW}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

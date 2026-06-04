# Phase 10: Admin Review Console — Design Specification

**System**: Plan Tab Learning System (PTLS) — TanglesUIDataSetup  
**Phase**: 10 of N  
**Document date**: 2026-06-04  
**Status**: Draft — pending implementation  
**Author**: AI-generated spec, requires human review before Phase 10a begins  

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [UX Layout](#2-ux-layout)
3. [Data Model Additions](#3-data-model-additions)
4. [State Machine](#4-state-machine)
5. [Admin Actions — Detailed Behavior](#5-admin-actions--detailed-behavior)
6. [Evidence Display Model](#6-evidence-display-model)
7. [Safety Rules](#7-safety-rules)
8. [Admin Console UI — Implementation Plan](#8-admin-console-ui--implementation-plan)
9. [Open Questions](#9-open-questions)
10. [Evidence Artifacts Policy](#10-evidence-artifacts-policy)
11. [Integration Points](#11-integration-points)
12. [Rollback Plan](#12-rollback-plan)

---

## 1. Purpose and Scope

### What the Admin Review Console Is

The Admin Review Console is the human-in-the-loop checkpoint between AI-generated capability proposals (Phase 9) and future implementation work (Phase 11). Its sole purpose is to let a human admin read, evaluate, and make a disposition decision on each `CapabilityProposal` that the AI pipeline has produced.

The console is a read-evaluate-decide surface. It does not generate artifacts, does not write code, and does not modify any production registry. It only changes the status and admin-controlled metadata fields on a proposal.

### What a Human Admin Can Do

- Read all 7 information cards associated with each proposal.
- Approve a proposal — signals that it is ready for future implementation planning.
- Reject a proposal — removes it from the active queue with a required explanation.
- Request re-investigation — sends the proposal back to the AI Investigation Engine (Phase 8) for more analysis.
- Mark a proposal as duplicate — cross-references it with another proposal and archives it.
- Add freeform notes to a proposal at any time (before it is Implemented or Deprecated).

### What a Human Admin Cannot Do

- Generate code.
- Create or merge pull requests.
- Write to `registry.json`, `verification_registry.json`, or the Capability Index.
- Manually set a proposal's status to `Implemented` — that status is reserved for the Phase 11 implementation pipeline.
- Delete proposals.
- Retroactively edit or remove admin notes.

### The Boundary Between "Approved" and "Implemented"

**Approved** means: a human has reviewed the evidence and decided the proposal is valid and worth building. It is a planning signal, not a build signal.

**Implemented** means: the Phase 11 implementation pipeline has completed the work described by the proposal and verified it. Only Phase 11 sets this status.

An Approved proposal sits in a queue waiting for Phase 11 to pick it up. Nothing else happens automatically at approval time. This boundary is intentional: it decouples the human decision from the engineering execution, and it allows implementation work to be batched, prioritized, and scheduled separately from the review cadence.

### Upstream and Downstream Connections

**Upstream (Phases 8–9 → Phase 10):**
- Phase 8 (AI Investigation Engine) produces `InvestigationProposal` objects from `Discovery` objects.
- Phase 9 (Capability Proposal Generation) converts `InvestigationProposal` objects into `CapabilityProposal` objects with status `Draft`.
- Phase 10 reads from the `CapabilityProposalStore` (draft store). No new data format is required for the handoff.

**Downstream (Phase 10 → Phase 11):**
- Phase 11 (not yet designed) will read the Approved queue and produce implementation artifacts.
- Phase 10 does not know anything about Phase 11's internals. It only marks proposals as `Approved` and populates the admin workflow fields.

**Re-investigation loop (Phase 10 → Phase 8):**
- When the admin selects "Request Investigation," the proposal is flagged as `NeedsInvestigation` and re-queued for Phase 8.
- Phase 8 produces a new `InvestigationProposal`, Phase 9 produces a new `CapabilityProposal`, and the original proposal is superseded (linked by `discovery_id`).

---

## 2. UX Layout

The Admin Review Console displays one proposal at a time in a card-based layout. The admin sees 7 cards stacked vertically (or arranged in a 2-column grid on wide screens). Each card is collapsible. The Decision Card (Card 7) is always visible and pinned to the bottom of the viewport.

A filter/sort bar at the top of the console controls which proposals are displayed and in what order.

**Filter controls:**
- Status: All / Draft / Reviewed / NeedsInvestigation
- Proposal type: All / FLOW_PROPOSAL / VERIFICATION_PROPOSAL / CAPABILITY_EXTENSION / ...
- Confidence: All / HIGH / MEDIUM / LOW / VERY_LOW
- Investigation priority: All / CRITICAL / HIGH / MEDIUM / LOW
- Sort: Newest first / Priority descending / Confidence descending

---

### Card 1: Summary Card

Displayed at the top. Provides the fast-read overview.

| Field | Source | Notes |
|---|---|---|
| Proposal type | `proposal_type` | Displayed as a type badge |
| Confidence score | `confidence` | Numeric (e.g., 0.82) |
| Confidence label | Derived from score | HIGH ≥ 0.75, MEDIUM ≥ 0.50, LOW ≥ 0.25, VERY_LOW < 0.25 |
| Investigation priority | `discovery.investigation_priority` | Badge: CRITICAL / HIGH / MEDIUM / LOW |
| Status badge | `status` | Color-coded |
| Title | `title` | Displayed as card heading |
| One-sentence summary | `summary` | Plain text |
| Source plan reference | `discovery.source_plan_id` | Clickable if plan is addressable |
| Source step reference | `discovery.source_step_id` | Shown as "Step {id}" |

---

### Card 2: Source Evidence Card

Provides full provenance for the gap that triggered this proposal.

| Field | Source | Notes |
|---|---|---|
| Source plan name | `discovery.source_plan_id` resolved to name | Plain text |
| Source plan ID | `discovery.source_plan_id` | Raw ID |
| Source scenario/test case name | Derived from plan | If available |
| Source step ID | `discovery.source_step_id` | |
| Source step text (verbatim) | `discovery.source_text` | Displayed in a monospace block |
| Expected result | `discovery.expected_result` | If not available, show "Not recorded" |
| ADO case ID | `discovery.attachments` or plan metadata | If linked; otherwise omit row |
| Attachments | `discovery.attachments` | File names only — no content embedded |
| Date discovered | `discovery.created_at` | Human-readable date/time |

---

### Card 3: Screenshot / Evidence Card

Displays visual and DOM evidence without embedding file content.

| Field | Source | Notes |
|---|---|---|
| Screenshot reference(s) | `discovery.screenshot_refs` | One row per ref; thumbnail placeholder if no file |
| Failure screen name | `failure_screen_name` (new field) | Which screen the gap was found on |
| Page URL context | `page_url` (new field) | URL string; not a live link unless safe |
| DOM dump reference | `dom_dump_ref` (new field) | Clickable link to file path; never embedded |
| Evidence artifacts | `evidence_artifacts` (new field) | One clickable file-path link per artifact |

Screenshot display logic:
- If `screenshot_refs` is empty: show a grey placeholder box labeled "No screenshot captured."
- If `screenshot_refs` contains a path: show a clickable "View screenshot" link. Do not embed the image.
- Thumbnail previews are out of scope for Phase 10; they may be added in a later UI iteration.

---

### Card 4: Current Capability Match Card

Shows what the AI found as the nearest existing capability and what is missing.

| Field | Source | Notes |
|---|---|---|
| Nearest capability key | `discovery.nearest_capabilities[0].key` | Primary match |
| Nearest capability ID | `discovery.nearest_capabilities[0].id` | |
| Match confidence | `discovery.nearest_capabilities[0].confidence` | Numeric |
| Evidence level | `evidence[0].evidence_level` | PROVEN / PARTIAL / THEORETICAL |
| Related verification ID | `evidence` where type = `verification_registry` | VER-* ID if exists |
| What is missing | `missing_information` | Bulleted list |

If `nearest_capabilities` is empty, display: "No matching capability found — this is a net-new gap."

---

### Card 5: Proposed Fix Card

Describes what the AI recommends building or changing. All content is informational — nothing here triggers action.

| Field | Source | Notes |
|---|---|---|
| Proposal type | `proposal_type` | |
| Type-specific fields | `type_specific` | Rendered as key: value pairs; all fields shown |
| Proposed flow key | `type_specific.proposed_flow_key` | If FLOW_PROPOSAL |
| Suggested verification | `type_specific.suggested_verification` | If VERIFICATION_PROPOSAL |
| Rationale | `rationale` | Full text, not truncated |
| Related existing flows/capabilities | `type_specific.related_flows` or similar | Informational list |
| Suggested files to modify | `suggested_files_to_modify` (new field) | File names only — no code |
| Suggested test coverage description | `suggested_test_coverage` (new field) | Plain text description |
| Implementation risk | `implementation_risk` (new field) | Badge: LOW / MEDIUM / HIGH / CRITICAL |
| Expected benefit statement | `rationale` + `type_specific.expected_benefit` | Combined or separate |

---

### Card 6: Open Questions Card

Shows outstanding uncertainties that the admin should consider before deciding.

| Field | Source | Notes |
|---|---|---|
| Open questions | `open_questions` | Numbered list |
| Missing information | `missing_information` | Bulleted list |
| Recommended next investigation | `recommended_next_investigation` | Plain text |
| Resolution status indicator | Derived | If all lists are empty: show green banner "No outstanding questions — ready for implementation planning." |

---

### Card 7: Admin Decision Card

Pinned to the bottom of the viewport. Contains all actionable controls.

**Action buttons:**

| Button | Label | Color | Enabled when |
|---|---|---|---|
| Approve | "Approve" | Green | status is Draft or Reviewed |
| Reject | "Reject" | Red | status is Draft, Reviewed, or NeedsInvestigation |
| Request Investigation | "Request Investigation" | Blue | status is Draft or Reviewed |
| Mark as Duplicate | "Mark as Duplicate" | Grey | status is Draft or Reviewed |

**Admin note text area:**
- Placeholder text: "Add a note (required for Reject and Request Investigation)..."
- Required for: Reject, Request Investigation.
- Optional for: Approve, Mark as Duplicate.
- Disabled for: proposals with status Implemented, Deprecated.

**Duplicate ID field** (shown only when "Mark as Duplicate" is selected):
- Label: "Duplicate of proposal ID:"
- Validates that the entered ID exists in the store before allowing submission.

**Status display:**
- Current status shown as a badge.
- If status is Approved/Rejected/Duplicate/NeedsInvestigation: show "Decided by {decided_by} at {decided_at}" below the badge.
- Previous admin notes displayed as a read-only timestamped thread below the action controls.

---

## 3. Data Model Additions

All additions are backward-compatible. Existing fields are not modified. New fields default to `None` or empty list so that Phase 9 output loads without migration.

---

### 3.1 Evidence Enrichment Fields

These fields are added to `Discovery` (Phase 5 model) and propagated into `CapabilityProposal` at proposal generation time (Phase 9). They capture the visual and DOM context of the failure.

```python
# Added to Discovery dataclass
failure_screen_name: Optional[str] = None
# What it contains: Human-readable name of the UI screen where the gap was observed.
#   Example: "Advanced Analysis Results", "Keyword Form"
# Who sets it: System (during plan investigation in Phase 6, if available from
#   test runner context or DOM analysis).
# When set: At Discovery creation time, if the investigation engine captures screen context.

page_url: Optional[str] = None
# What it contains: The URL of the page/route where the gap was found.
#   Example: "https://app.tangles.com/analysis/results?case=ADO-4412"
# Who sets it: System (from test execution context or plan investigation).
# When set: At Discovery creation time.

dom_dump_ref: Optional[str] = None
# What it contains: File path to a DOM dump snapshot captured during investigation.
#   Example: "registry/dom_dumps/discovery_D-0042_dom.html"
#   The file itself is NOT embedded — only the path is stored.
# Who sets it: System (during Phase 6 plan investigation, if DOM capture is enabled).
# When set: At Discovery creation time, if DOM capture ran.

evidence_artifacts: list[str] = field(default_factory=list)
# What it contains: List of file paths to additional evidence files (logs, har files,
#   response dumps, etc.) captured during investigation.
#   Example: ["registry/artifacts/D-0042_network.har", "registry/artifacts/D-0042_console.log"]
# Who sets it: System (Phase 6).
# When set: At Discovery creation time.
```

These same fields are added to `CapabilityProposal` as copies from the linked Discovery, so the Admin Console has a single object to read without join lookups.

---

### 3.2 Implementation Guidance Fields

These fields are added to `CapabilityProposal`. They are informational only. They help the admin understand the scope of the proposed change. They do not trigger any action and do not cause any file to be modified.

```python
# Added to CapabilityProposal dataclass
suggested_files_to_modify: list[str] = field(default_factory=list)
# What it contains: File names (not paths, not code) that would likely be touched
#   if this proposal were implemented.
#   Example: ["capability_registry.py", "flow_runner.py", "test_advanced_analysis.py"]
# Who sets it: Phase 9 (AI generation). Admin never sets this field.
# When set: At proposal generation time. Never updated after creation.

suggested_test_coverage: Optional[str] = None
# What it contains: Plain-text description of what test scenarios would cover
#   the proposed capability. Not a test script — a description.
#   Example: "Needs a test that verifies the 'Export to CSV' button appears on
#   the Advanced Analysis Results screen after a keyword search with >= 10 results."
# Who sets it: Phase 9 (AI generation).
# When set: At proposal generation time.

implementation_risk: str = "MEDIUM"
# What it contains: Admin-visible risk classification for the proposed change.
#   Values: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
#   LOW: isolated, additive, no existing behavior changed.
#   MEDIUM: modifies existing flow, moderate test coverage needed.
#   HIGH: cross-cutting change, significant test surface.
#   CRITICAL: touches core infrastructure, risk of regression across many flows.
# Who sets it: Phase 9 (AI generation, based on proposal type and evidence).
# When set: At proposal generation time.
```

---

### 3.3 Admin Workflow Fields

These fields are set exclusively by admin actions. The AI pipeline never sets them. They form the audit trail of human decisions.

```python
# Added to CapabilityProposal dataclass
admin_decision: str = "PENDING"
# What it contains: The current admin disposition.
#   Values: "PENDING" | "APPROVED" | "REJECTED" | "NEEDS_INVESTIGATION" | "DUPLICATE"
#   Mirrors the status field but is the admin-explicit signal (status may have
#   additional system-driven states).
# Who sets it: Admin (via Admin Review API).
# When set: At the moment the admin submits a decision action.

admin_notes: str = ""
# What it contains: Append-only thread of admin notes. Each note is prepended with
#   a timestamp and admin identifier:
#   "[2026-06-04T14:32:00Z | admin@tangles.com] Approved — strong evidence from
#   3 separate test runs."
#   Multiple notes are separated by a blank line.
# Who sets it: Admin (via Admin Review API, "Add Admin Note" or as part of any decision).
# When set: At decision time (for decisions that include a note) or via standalone
#   "Add Admin Note" action.
# Constraint: NEVER overwritten. Always appended. Existing entries are immutable.

duplicate_of: Optional[str] = None
# What it contains: The proposal_id of the proposal that this one duplicates.
#   Example: "CP-0031"
# Who sets it: Admin (via "Mark as Duplicate" action).
# When set: Only when admin_decision = "DUPLICATE".
# Constraint: Must reference an existing proposal_id in the store.

decided_at: Optional[str] = None
# What it contains: ISO 8601 timestamp of the most recent admin decision.
#   Example: "2026-06-04T14:32:00Z"
# Who sets it: System (populated automatically when any admin decision action is taken).
# When set: At decision submission time. Updated on each subsequent decision (e.g.,
#   if admin approves, then un-approves before implementation).

decided_by: Optional[str] = None
# What it contains: Identifier of the admin who made the most recent decision.
#   Format depends on resolved authentication model (see Open Question #1).
#   Example: "admin@tangles.com" or "user:erezg"
# Who sets it: System (derived from session/auth context at decision time).
# When set: Same as decided_at.
```

---

## 4. State Machine

### Complete State Transition Diagram

```
                         [Phase 9 creates proposal]
                                    │
                                    ▼
                                  Draft
                                    │
                      ┌─────────────┴──────────────┐
                      │                            │
          [Admin opens/views]          [Admin marks duplicate]
                      │                            │
                      ▼                            ▼
                  Reviewed                     Duplicate
                      │                      (terminal)
          ┌───────────┼───────────┐
          │           │           │
     [Approve]   [Reject]  [Request Investigation]
          │           │           │
          ▼           ▼           ▼
      Approved    Rejected   NeedsInvestigation
          │       (terminal)      │
          │                  [Phase 8 re-runs]
          │                       │
          │               [Phase 9 generates new proposal]
          │               (original stays NeedsInvestigation;
          │                new proposal enters as Draft)
          │
    [Phase 11 implements]
          │
          ▼
     Implemented
      (terminal)
          │
          ▼
     Deprecated   ← [Phase 11 or system deprecates old Implemented proposals]
      (terminal)
```

---

### Transition Specifications

**Draft → Reviewed**
- Trigger: Admin opens and views the proposal in the Admin Console.
- Guard: Proposal exists in the store with status `Draft`.
- Effect: `status` → `Reviewed`. No admin fields changed. No note required.
- Reversible: No (but inconsequential — Reviewed has the same action set as Draft).

---

**Draft / Reviewed → Approved**
- Trigger: Admin clicks "Approve" and submits.
- Guard: `status` must be `Draft` or `Reviewed`.
- Effect:
  - `status` → `Approved`
  - `admin_decision` → `"APPROVED"`
  - `decided_at` → current UTC timestamp
  - `decided_by` → current admin identifier
  - `admin_notes` → append note if provided
  - `reviewed_at` → current UTC timestamp (if not already set)
- Reversible: Yes — admin may un-approve (Approved → Reviewed) before Phase 11 picks it up. Once Phase 11 begins implementation, the transition is locked.

---

**Draft / Reviewed / NeedsInvestigation → Rejected**
- Trigger: Admin clicks "Reject" and submits with a note.
- Guard: `status` must be `Draft`, `Reviewed`, or `NeedsInvestigation`. Admin note must be non-empty.
- Effect:
  - `status` → `Rejected`
  - `admin_decision` → `"REJECTED"`
  - `decided_at` → current UTC timestamp
  - `decided_by` → current admin identifier
  - `admin_notes` → append admin note (required)
- Reversible: No. Rejected proposals are archived. They cannot be re-activated. If the admin later decides the proposal was valid, a new proposal must be generated via Phase 8–9.

---

**Draft / Reviewed → NeedsInvestigation**
- Trigger: Admin clicks "Request Investigation" and submits with a note.
- Guard: `status` must be `Draft` or `Reviewed`. Admin note must be non-empty (specifying what to investigate).
- Effect:
  - `status` → `NeedsInvestigation`
  - `admin_decision` → `"NEEDS_INVESTIGATION"`
  - `decided_at` → current UTC timestamp
  - `decided_by` → current admin identifier
  - `admin_notes` → append admin note (required)
  - `recommended_next_investigation` → updated with the admin's note content
- Reversible: Only indirectly — the admin cannot manually move NeedsInvestigation → Draft. A new proposal from Phase 9 supersedes the original.

---

**NeedsInvestigation → (new Draft, via Phase 8–9)**
- Trigger: Phase 8 re-investigation runs and Phase 9 generates a new proposal.
- Guard: A `NeedsInvestigation` proposal exists with a linked `discovery_id`.
- Effect: A new `CapabilityProposal` with status `Draft` is created, linked to the same `discovery_id`. The original proposal remains in `NeedsInvestigation` state permanently (for audit trail).
- Reversible: N/A (creates a new object, does not modify the original).

---

**Draft / Reviewed → Duplicate**
- Trigger: Admin clicks "Mark as Duplicate" and enters a `duplicate_of` proposal ID.
- Guard: `status` must be `Draft` or `Reviewed`. The entered `duplicate_of` value must resolve to an existing proposal in the store.
- Effect:
  - `status` → `Duplicate`
  - `admin_decision` → `"DUPLICATE"`
  - `duplicate_of` → entered proposal ID
  - `decided_at` → current UTC timestamp
  - `decided_by` → current admin identifier
- Reversible: No. Terminal state.

---

**Approved → Implemented**
- Trigger: Phase 11 implementation pipeline completes and verifies the change.
- Guard: `status` must be `Approved`. Only Phase 11 may trigger this transition. Admin cannot trigger it.
- Effect:
  - `status` → `Implemented`
  - `implemented_at` → timestamp set by Phase 11
- Reversible: No. Terminal state.

---

**Implemented → Deprecated**
- Trigger: Phase 11 or system determines the implementation is obsolete (e.g., superseded by a larger change).
- Guard: `status` must be `Implemented`.
- Effect: `status` → `Deprecated`.
- Reversible: No. Terminal state.

---

## 5. Admin Actions — Detailed Behavior

### 5.1 Approve

**Pre-conditions:**
- `status` is `Draft` or `Reviewed`.
- No pre-condition on confidence score or open questions. Admin may approve a LOW-confidence proposal if they judge it valid.

**Effect:**
- `status` → `Approved`
- `admin_decision` → `"APPROVED"`
- `decided_at` → current UTC ISO timestamp
- `decided_by` → current admin identifier from session context
- `admin_notes` → append timestamped note if provided (optional)
- `reviewed_at` → set to current time if not already set

**Admin note:** Optional. If provided, appended to `admin_notes` thread.

**Does NOT:**
- Generate code.
- Create a pull request.
- Modify `registry.json`, `verification_registry.json`, or the Capability Index.
- Write to the `CapabilityIndex` store.
- Trigger Phase 11 automatically (Phase 11 polls the Approved queue on its own schedule).

**Post-state:** Proposal appears in the "Approved — pending implementation" queue view.

**Reversibility:** Yes, before Phase 11 begins implementation. The admin can transition Approved → Reviewed by opening the proposal and selecting "Un-approve." Once Phase 11 has started implementation (detectable via a Phase 11 lock flag — see Open Question #6), the action is locked.

---

### 5.2 Reject

**Pre-conditions:**
- `status` is `Draft`, `Reviewed`, or `NeedsInvestigation`.
- Admin note is non-empty. The system enforces this at submission time.

**Effect:**
- `status` → `Rejected`
- `admin_decision` → `"REJECTED"`
- `decided_at` → current UTC ISO timestamp
- `decided_by` → current admin identifier
- `admin_notes` → append timestamped note (required)

**Admin note:** REQUIRED. If the note field is empty, the "Reject" submission is blocked with validation error: "A rejection reason is required."

**Does NOT:**
- Delete the proposal. It remains in the store permanently.
- Propagate any signal to Phase 8 or Phase 9.

**Post-state:** Proposal moves to "Rejected" archive view. It is no longer shown in the active review queue.

**Reversibility:** No. Rejected is terminal. If the admin later judges the proposal valid, a new proposal must be generated by re-running Phase 8–9 on the same discovery.

---

### 5.3 Request Investigation

**Pre-conditions:**
- `status` is `Draft` or `Reviewed`.
- Admin note is non-empty. The note must specify what should be investigated.

**Effect:**
- `status` → `NeedsInvestigation`
- `admin_decision` → `"NEEDS_INVESTIGATION"`
- `decided_at` → current UTC ISO timestamp
- `decided_by` → current admin identifier
- `admin_notes` → append timestamped note (required)
- `recommended_next_investigation` → updated with the text of the admin note

**Admin note:** REQUIRED. Prompt placeholder: "Describe what should be investigated further..."

**System effect:** The proposal is flagged in the `NeedsInvestigation` queue. Phase 8 (AI Investigation Engine) reads this queue and picks up the proposal for re-investigation. The re-investigation does NOT happen immediately — it is queued (see Open Question #5 for queue trigger mechanism).

**Does NOT:**
- Immediately trigger Phase 8.
- Block the admin from reviewing other proposals.
- Modify any existing evidence or AI-generated fields.

**Post-state:** Proposal appears in "Pending Investigation" queue. It will re-enter as a new Draft once Phase 8–9 complete.

**Reversibility:** No direct reversal. The admin cannot manually move `NeedsInvestigation` → `Draft`. A new proposal from Phase 9 supersedes it.

---

### 5.4 Mark as Duplicate

**Pre-conditions:**
- `status` is `Draft` or `Reviewed`.
- Admin must enter a `duplicate_of` value.
- The `duplicate_of` value must be validated: the referenced proposal ID must exist in the store.

**Effect:**
- `status` → `Duplicate`
- `admin_decision` → `"DUPLICATE"`
- `duplicate_of` → entered proposal ID
- `decided_at` → current UTC ISO timestamp
- `decided_by` → current admin identifier
- `admin_notes` → append timestamped note if provided (optional)

**Admin note:** Optional.

**Validation error:** If the entered proposal ID does not exist: "Proposal ID {id} not found. Check the ID and try again."

**Does NOT:**
- Merge the two proposals.
- Modify the referenced (original) proposal.
- Delete either proposal.

**Post-state:** Proposal moves to "Duplicate" archive. The original proposal (referenced by `duplicate_of`) is unchanged and remains in its current status.

**Reversibility:** No. Terminal state.

---

### 5.5 Add Admin Note

**Pre-conditions:**
- `status` is any value except `Implemented` or `Deprecated`.
- Note text is non-empty.

**Effect:**
- `admin_notes` → append timestamped, attributed note.
  - Format: `[{ISO timestamp} | {decided_by}] {note text}`
- No status change.
- No `decided_at` or `admin_decision` update (this is a note, not a decision).

**Admin note:** Required (it is the content of this action).

**Does NOT:**
- Change `status`.
- Change `admin_decision`.

**Post-state:** Note appears in the read-only admin notes thread in Card 7.

**Reversibility:** No. Notes are append-only and immutable once written.

---

## 6. Evidence Display Model

### Evidence Chip Rendering

Each `EvidenceRef` in the `evidence` list is rendered as an inline chip in Card 4 and Card 5.

| Evidence Source | Chip Display | Notes |
|---|---|---|
| `capability_index` | "Capability: {reference}" | Reference is the capability key or ID |
| `verification_registry` | "Verification: {reference}" | Reference is the VER-* ID |
| `file_search` | "File: {filename only, not full path}" | Strip directory; show only the filename |
| `ai_reasoning` | Italic text block: "AI analysis: {relevance}" | Rendered as a paragraph, not a chip |
| `discovery` | "Discovery: {reference}" | Reference is the discovery_id |
| `investigation_proposal` | "Investigation: {reference}" | Reference is the investigation_proposal_id |

Chips are non-interactive (no click action) in Phase 10. Future phases may add navigation on click.

---

### Screenshot Handling

Screenshots are referenced by file path or ID in `discovery.screenshot_refs`. The Admin Console never embeds image data.

| Condition | Display |
|---|---|
| `screenshot_refs` is empty | Grey placeholder box labeled "No screenshot captured." |
| Path exists in `screenshot_refs` | "View screenshot" — clickable link opening the file |
| Path in `screenshot_refs` but file not found | "Screenshot reference found but file missing: {path}" in amber warning text |

Thumbnails are out of scope for Phase 10.

---

### DOM Dump Reference Handling

`dom_dump_ref` is displayed as a single clickable file-path link in Card 3. The DOM content is never rendered inline. If the file does not exist at display time, show: "DOM dump reference found but file missing: {path}".

---

### Evidence Artifacts Handling

Each entry in `evidence_artifacts` is displayed as a clickable file-path link. Missing files show the same "file missing" pattern. Links open the file externally (browser default action for the file type).

---

## 7. Safety Rules

The following constraints are non-negotiable. Any implementation that violates these rules is incorrect and must not be shipped.

1. **Approval never generates code.** The `admin_approve()` method writes only to the proposal store. It does not invoke any code generation, template rendering, or file writing beyond the store update.

2. **Approval never creates a pull request.** No GitHub API call, no `git` command, no PR template is touched at approval time.

3. **Approval never modifies production registries.** `registry.json`, `verification_registry.json`, and any other production registry are read-only from Phase 10's perspective. The Admin Review API has no write access to these files.

4. **Approval never writes to the Capability Index.** The Capability Index (Phase 3) is a read-only query layer from Phase 10's perspective.

5. **Admin decisions only change admin-controlled fields.** The only fields an admin action may modify are: `status`, `admin_decision`, `admin_notes`, `duplicate_of`, `decided_at`, `decided_by`, and `recommended_next_investigation` (for Request Investigation). All other proposal fields are immutable after Phase 9 creation.

6. **Rejected proposals are never deleted.** The `admin_reject()` method never calls any delete or remove operation. Rejected proposals remain in the store permanently.

7. **Duplicate proposals are never merged.** Both the duplicate and the original remain as separate records. Cross-referencing via `duplicate_of` is the only relationship created.

8. **"Implemented" status is set only by Phase 11.** The Admin Review API has no method that sets `status = Implemented`. Any attempt to add such a method is a design violation.

9. **No transition out of terminal states.** Proposals with status `Implemented`, `Deprecated`, `Rejected`, or `Duplicate` cannot be transitioned to any other status by any admin action or system event. The API must reject any such attempt with a clear error.

10. **Admin notes are append-only.** The `admin_notes` field is always appended to, never overwritten, never truncated. There is no delete-note or edit-note operation.

11. "`suggested_files_to_modify` is informational only.** The presence of a file name in this list does not cause that file to be read, written, or modified. It is a hint for human readers only.

12. **All admin actions are timestamped and attributed.** Every action that changes `status` or `admin_notes` must populate `decided_at` with the current UTC timestamp and `decided_by` with the admin's identifier. Anonymous or unattributed actions are rejected.

---

## 8. Admin Console UI — Implementation Plan

### Phase 10a: Data Model Extension

**Goal:** Add new fields to the Python data models. No UI changes.

**Work items:**
- Add `failure_screen_name`, `page_url`, `dom_dump_ref`, `evidence_artifacts` to `Discovery` dataclass.
- Add the same four fields to `CapabilityProposal` (copied from linked Discovery at proposal creation).
- Add `suggested_files_to_modify`, `suggested_test_coverage`, `implementation_risk` to `CapabilityProposal`.
- Add `admin_decision`, `admin_notes`, `duplicate_of`, `decided_at`, `decided_by` to `CapabilityProposal`.
- Add `NeedsInvestigation` and `Duplicate` to `CapabilityProposalStatus` enum.
- Update `to_dict()` / `from_dict()` for all new fields with safe defaults.
- Add `AdminReviewRecord` dataclass (see Phase 10d).
- All new fields must have safe defaults (`None`, `""`, `[]`, `"PENDING"`) so existing Phase 9 output loads without migration errors.

**Estimated files:**
- `registry/capability_proposal.py` — primary target
- `registry/discovery.py` (if Discovery is a separate dataclass file)

---

### Phase 10b: Admin Review API (Python backend)

**Goal:** Expose the admin actions as callable methods on the `Api` class (or equivalent backend entry point).

**Methods to add:**

```
review_proposals(filters: dict) -> list[dict]
  Returns filtered, sorted list of proposals for admin review.
  Filters: status, proposal_type, confidence range, investigation_priority.
  Sort: newest_first | priority_desc | confidence_desc.

admin_approve(proposal_id: str, note: Optional[str]) -> dict
  Returns: {"ok": True, "proposal": dict} or {"ok": False, "error": str}
  Error cases: proposal not found, status not in [Draft, Reviewed], Phase 11 lock active.

admin_reject(proposal_id: str, note: str) -> dict
  Returns: {"ok": True, "proposal": dict} or {"ok": False, "error": str}
  Error cases: proposal not found, status not in [Draft, Reviewed, NeedsInvestigation],
               note is empty.

admin_request_investigation(proposal_id: str, note: str) -> dict
  Returns: {"ok": True, "proposal": dict} or {"ok": False, "error": str}
  Error cases: proposal not found, status not in [Draft, Reviewed], note is empty.

admin_mark_duplicate(proposal_id: str, duplicate_of: str, note: Optional[str]) -> dict
  Returns: {"ok": True, "proposal": dict} or {"ok": False, "error": str}
  Error cases: proposal not found, duplicate_of proposal not found,
               status not in [Draft, Reviewed].

admin_add_note(proposal_id: str, note: str) -> dict
  Returns: {"ok": True, "proposal": dict} or {"ok": False, "error": str}
  Error cases: proposal not found, status in [Implemented, Deprecated], note is empty.
```

All methods write an `AdminReviewRecord` to the audit store (Phase 10d) after each successful action.

**Estimated files:**
- `config/test_config_app.py` — add new API methods (additive only)

---

### Phase 10c: Admin Console UI (HTML/JS)

**Goal:** Render the 7-card admin review interface in the browser.

**Work items:**
- Add an "Admin" tab or section to the main navigation in the Plans tab area.
- Implement the filter/sort bar at the top of the console.
- Implement the 7-card layout per proposal (collapsible cards, pinned Decision Card).
- Render all fields per card as described in Section 2.
- Implement admin action buttons with client-side validation (note required for Reject/RequestInvestigation; duplicate ID required and validated for MarkAsDuplicate).
- Call backend API methods via the existing frontend↔backend call pattern.
- Show success/error feedback after each admin action.
- Refresh the proposal display after each action without full page reload.

**Evidence chip rendering:** Implement the chip display table from Section 6.

**Screenshot/artifact links:** Implement the conditional display logic from Section 6.

**Estimated files:**
- `config/test_config.html` — add Admin tab/section and card templates (additive)
- Inline JS within `test_config.html` or a companion `.js` file if the project uses separate scripts.

---

### Phase 10d: Audit Trail

**Goal:** Maintain an append-only record of every admin decision for accountability and debugging.

**`AdminReviewRecord` dataclass:**

```python
@dataclass
class AdminReviewRecord:
    record_id: str             # UUID, generated at write time
    proposal_id: str           # The proposal this record applies to
    action: str                # "APPROVE" | "REJECT" | "REQUEST_INVESTIGATION" |
                               #   "MARK_DUPLICATE" | "ADD_NOTE" | "VIEW"
    admin_note: str            # Note provided with the action (may be empty for VIEW)
    decided_at: str            # ISO timestamp
    decided_by: str            # Admin identifier
    before_status: str         # Status before action
    after_status: str          # Status after action
```

**Storage:** `registry/drafts/admin_review_records.json` — a JSON array, append-only. Each new record is appended. Records are never deleted or modified.

**Admin Console display:** A read-only "Audit Log" section below the Decision Card shows all `AdminReviewRecord` entries for the current proposal, newest first.

**Estimated files:**
- `registry/admin_review_store.py` — new file implementing `AdminReviewStore` with `append_record()` and `get_records_for_proposal()` methods.
- `registry/drafts/admin_review_records.json` — created on first admin action (not checked into git if it contains sensitive data; check project `.gitignore` policy).

---

## 9. Open Questions

The following questions must be resolved before Phase 10 implementation begins. They are listed in approximate priority order.

**Q1. Authentication: Who is "admin"?**
Is there an existing user/role model in TanglesRunner? Should admin actions require a specific user type, a hardcoded role, or a separate login? The `decided_by` field needs a concrete value format. If there is no auth model, what is the minimum viable identity signal (e.g., machine hostname, environment variable, or manual name entry)?

**Q2. Multi-admin concurrency: What happens if two admins act simultaneously?**
Can multiple admins review simultaneously? What is the conflict resolution policy if two admins approve and reject the same proposal within the same second? Is last-write-wins acceptable, or does the system need optimistic locking (e.g., an `etag` or `version` field on each proposal)?

**Q3. Screenshot capture: How and when are screenshots taken?**
How are screenshots captured during plan investigation? Is there an existing mechanism in TanglesRunner or the test executor? Does Phase 6 need a screenshot capture step, or does the test executor already produce screenshots that can be referenced? What is the file naming convention and storage location?

**Q4. DOM dumps: Where are DOM dump files stored and who generates them?**
Who generates DOM dumps — the test executor, Phase 6, or Phase 8? Where are they stored? What is the file naming convention so that `dom_dump_ref` paths are consistent and findable? Is DOM capture always performed, or only when a gap is detected?

**Q5. Re-investigation queue: What triggers Phase 8 after "Request Investigation"?**
When the admin selects "Request Investigation," Phase 8 is queued to re-run. What mechanism triggers it? Options include: (a) a manual admin action in a separate "Run Investigation" button, (b) a background job that polls the `NeedsInvestigation` queue on a schedule, (c) a webhook/event from the proposal store. Which approach fits the existing TanglesRunner architecture?

**Q6. Phase 11 handoff: What signal does Phase 11 receive when a proposal is Approved?**
Phase 11 (not yet designed) needs to know when a proposal is Approved. Options: (a) Phase 11 polls the proposal store for `status = Approved`, (b) the Admin Review API writes to a separate "implementation queue" file that Phase 11 reads, (c) a webhook/event is fired at approval time. Which mechanism should Phase 10 prepare for? This affects whether Phase 10 needs to write to anything beyond the proposal store at approval time.

**Q7. Approval reversibility: Can an admin un-approve before Phase 11 begins?**
The spec states approval is reversible before Phase 11 starts. What is the signal that Phase 11 has "started"? Is there a lock flag written by Phase 11 to the proposal? If so, what field name and where is it written? Phase 10 needs to read this flag to enforce the lock.

**Q8. ADO linkage: How is the ADO case ID linked to a proposal?**
Card 2 shows an "ADO case ID if linked." How does the ADO case ID get onto a Discovery or plan? Is it entered manually by the user when importing a plan? Is it extracted from plan text by the Phase 6 parser? Is there an existing ADO integration elsewhere in the codebase? This determines whether `discovery.attachments` is the right place to store it or whether a dedicated `ado_case_id` field is needed.

**Q9. Confidence thresholds: Should very-low-confidence proposals be blocked from approval?**
Should proposals with confidence below a threshold (e.g., `< 0.30`) trigger a mandatory warning or require the admin to confirm explicitly before approving? Or should confidence be purely informational with no enforcement? A threshold policy would need a configurable constant and a UI confirmation dialog.

**Q10. Admin notifications: How are admins alerted when new proposals arrive?**
Should admins receive a notification (email, Slack, in-app badge) when new `Draft` proposals appear in the review queue? Is there an existing notification mechanism in the system? What is the expected review latency SLA (same day, 48 hours, etc.)?

**Q11. Batch actions: Can the admin approve or reject multiple proposals at once?**
A batch mode would allow the admin to select multiple proposals via checkboxes and apply a single action (e.g., approve all LOW-priority proposals of type VERIFICATION_PROPOSAL). Is this a Phase 10 requirement or a later enhancement? Batch actions add complexity around partial failures and audit trail granularity.

**Q12. Priority queue ordering: How should the review queue be ordered by default?**
Should CRITICAL and HIGH `investigation_priority` proposals appear first, or should the default be newest-first? Should the default sort be configurable per admin? This affects Card 1 prominence and the filter bar default state.

**Q13. `CapabilityProposalStore` persistence: Where is the draft store file?**
The spec references `registry/drafts/capability_proposals.json` as the draft store. Is this the actual file path used by Phase 9? If Phase 9 writes to a different location, Phase 10a must read from the same location. Confirm the canonical store path before implementation.

---

## 10. Evidence Artifacts Policy

### Storage Principle

Evidence artifacts (screenshots, DOM dumps, network HAR files, console logs, etc.) are stored as files on disk. Their file paths are recorded in proposal and discovery fields. The proposal JSON never embeds file content.

This principle applies to all artifact types:
- `screenshot_refs` — file paths or IDs only. Never image data.
- `dom_dump_ref` — single file path only. Never DOM content.
- `evidence_artifacts` — list of file paths only. Never file content.

### Display-Time Existence Check

At display time (when the Admin Console renders a proposal card), the system checks whether each referenced file path exists on disk. The check is read-only and non-blocking.

| File state | Display |
|---|---|
| File exists | Clickable link to open the file |
| File does not exist | Amber warning text: "File not found: {path}" |
| Field is empty or None | Grey placeholder: "Not captured" |

### Retention Policy

No artifact file is automatically deleted when:
- A proposal is rejected.
- A proposal is marked as Duplicate.
- A proposal is deprecated.

Artifact files persist until a separate cleanup policy (outside Phase 10's scope) removes them. Phase 10 does not implement any file deletion logic.

### Access Control

Artifact files are accessed directly by the browser (via clickable links). If artifact files are stored in a location that requires authentication or special permissions, the link behavior depends on the browser and OS configuration — Phase 10 does not implement a file serving API.

If sensitive information may appear in DOM dumps or screenshots (e.g., test credentials, PII in the UI), a review of artifact storage access controls is recommended before Phase 10 ships.

---

## 11. Integration Points

### Upstream: Phase 9 → Phase 10

- **Data source:** `CapabilityProposalStore` (`registry/drafts/capability_proposals.json` or equivalent).
- **Input format:** `CapabilityProposal` objects as produced by Phase 9.
- **Handoff mechanism:** Phase 10 reads from the same store that Phase 9 writes to. No new data format, no queue, no event. Phase 10 polls or reads on demand.
- **Backward compatibility:** All new fields added in Phase 10a have safe defaults. Phase 9 output (without the new fields) loads correctly; new fields simply default to `None`, `""`, or `[]`.
- **Phase 10 adds fields to the store:** When an admin takes an action, Phase 10 updates the proposal record in the store with the new admin workflow fields. Phase 9 is not aware of or affected by these updates.

---

### Downstream: Phase 10 → Phase 11 (future)

- **Output signal:** Proposals with `status = Approved` in the `CapabilityProposalStore`.
- **Handoff mechanism:** Phase 11 (not yet designed) will read the Approved queue. The exact mechanism (polling, queue file, event) is an open question (see Q6).
- **Phase 10's commitment:** Phase 10 guarantees that when a proposal is Approved, its record in the store has `status = "Approved"`, `admin_decision = "APPROVED"`, `decided_at` populated, and `decided_by` populated. Phase 11 may read any of these fields.
- **Phase 10 does not:** Create any Phase 11 artifact, trigger any Phase 11 process, or write to any file that Phase 11 owns.

---

### Peer Integration: Phase 10 → Phase 8 (re-investigation)

- **Trigger:** Admin "Request Investigation" action sets `status = NeedsInvestigation`.
- **Phase 8's input:** Phase 8 reads the `NeedsInvestigation` queue from the proposal store. The proposal's `recommended_next_investigation` field (updated by the admin action) gives Phase 8 the context for what to investigate.
- **Phase 9's output:** Phase 9 generates a new `CapabilityProposal` linked to the same `discovery_id`. The new proposal enters as `Draft` and appears in the Admin Console as a fresh item.
- **Original proposal fate:** The original `NeedsInvestigation` proposal is not deleted or superseded in the store. It remains with `status = NeedsInvestigation` permanently, linked to the new proposal via `discovery_id`.
- **Admin Console display:** The Admin Console may show a "Superseded by {new_proposal_id}" note on the original `NeedsInvestigation` proposal once the new proposal exists (optional UX enhancement; not required for Phase 10).

---

### Peer Integration: Phase 7 (Investigation UI) → Phase 10

Phase 7 provides the read-only display of investigations in the Plans tab. Phase 10 adds the admin decision layer on top. These are separate UI surfaces:
- Phase 7: read-only, shown to all users, in the Plans tab.
- Phase 10: admin-only, decision-enabled, in the Admin tab or section.

No data contract between Phase 7 and Phase 10 is required. Both read from the same stores independently.

---

## 12. Rollback Plan

Phase 10 is designed to be fully rollback-safe. All changes are additive.

### Files Modified (Additive Only)

| File | Change type | Rollback impact |
|---|---|---|
| `registry/capability_proposal.py` | Add new fields and enum values | Removing the new fields restores Phase 9 behavior exactly. Existing Phase 9 output is unaffected. |
| `config/test_config_app.py` | Add new API methods | Removing the new methods restores Phase 9 behavior. No existing method is modified. |
| `config/test_config.html` | Add Admin tab/section | Removing the new HTML/JS section restores the prior UI. No existing tab is modified. |

### New Files Created

| File | Rollback action |
|---|---|
| `registry/admin_review_store.py` | Delete the file. No other file depends on it. |
| `registry/drafts/admin_review_records.json` | Delete the file. Contains only audit records; no functional data. |

### Rollback Procedure

```
1. git revert HEAD   # Reverts all Phase 10 commits (assumes Phase 10 was a single commit or series of commits)
2. rm registry/admin_review_store.py             # if created
3. rm registry/drafts/admin_review_records.json  # if created
```

The `CapabilityProposalStore` draft file (`registry/drafts/capability_proposals.json`) will retain any admin workflow fields written during Phase 10 operation. These are harmless — Phase 9 code ignores unknown fields when loading proposals. The only cleanup needed if rollback occurs mid-review is to manually reset any `status` values that were changed from `Draft` to an admin-set value (e.g., `Approved`, `Rejected`). A one-off migration script can do this, or the fields can be left as-is since Phase 9 re-generates proposals from discoveries on the next run.

### What Is Not Affected by Rollback

- Phases 2–9 are completely unaffected. They read and write their own stores and have no dependency on Phase 10 code.
- `CapabilityIndex` (Phase 3) is unaffected — Phase 10 never writes to it.
- `verification_registry.json` and `registry.json` are unaffected — Phase 10 never writes to them.
- The frontend Plans tab is unaffected if the Admin tab is added as a new section (not replacing existing content).

---

*End of Phase 10 Admin Review Console Design Specification.*  
*Next: Phase 11 (Implementation Pipeline) — not yet designed.*

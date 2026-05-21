---
name: claude-md-documentation-validation
description: Good architecture documentation helps validate assumptions and catch drift
metadata:
  type: feedback
---

**The Lesson:** When I created the comprehensive CLAUDE.md documentation, I discovered that the price sync worker had a real bug (Shufersal API format change). The act of documenting the architecture forced a deeper read of the actual code and led to discovering this issue that hadn't been caught by tests.

**Why this matters:**
- Writing CLAUDE.md meant I had to understand the full flow: index fetch → URL extraction → file download → parsing
- This revealed that the URL extraction regex was brittle (`/PriceFull/` only)
- Testing the worker exposed that Shufersal's API had actually changed from the documented format
- A developer following the README alone would have been confused by "No PriceFull URL found" with no clear fix path

**How to apply:**
- **Documentation is a form of validation.** Writing it forces you to walk the actual code paths, not just imagine them.
- **Keep README/CLAUDE.md in sync with reality.** If a chain's API format changes, update the docs and code together in one commit.
- **Use documentation to catch architecture drift.** If you can't explain how something works clearly in prose, it's usually over-complicated or missing a piece.
- **New chains: document → test → add to code.** Don't assume a new chain follows the same pattern as existing ones.

**Prevention checklist:**
- [ ] Architecture docs (CLAUDE.md, README) updated whenever APIs change
- [ ] Sample API responses or expected output documented (easier to spot when they drift)
- [ ] Chain configuration includes expected filename pattern and index format
- [ ] Tests verify assumptions (e.g., "Shufersal index is HTML table with href links")

**Related:** [[api-format-assumption]], [[brittle-regex-patterns]]

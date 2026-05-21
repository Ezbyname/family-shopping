---
name: brittle-regex-patterns
description: Overly specific regex patterns break when upstream naming conventions change
metadata:
  type: feedback
---

**The Bug:** Parser looked for "PriceFull" in filenames, but Shufersal's actual price files are named `Price7290027600007-001-001-20260518-010000.gz`. The regex `/PriceFull/i` matched nothing, leaving zero price URLs extracted.

**Why:** The regex was too specific—it hardcoded the exact string "PriceFull" that one chain uses. When Shufersal switched to a different naming scheme, the pattern became useless. There was no fallback to match "Price" + digits.

**How to apply:**
- **Match structural patterns, not exact strings.** Instead of `/PriceFull/`, use `/Price\d+/` or `/Price[^.]+\.gz/` to match Price followed by any word characters.
- **Combine multiple patterns with alternation.** Use `/(?:PriceFull|Price\d+)/i` so old and new formats both work.
- **Document the filename pattern for each chain** in `chains.js` comments (e.g., "Shufersal: Price{chainId}-{storeId}-{date}.gz").
- **Test against actual sample URLs** from the chain's current API before deploying.

**Prevention checklist:**
- [ ] Regex uses character classes (`\d`, `\w`, `[^.]`) not exact strings for variable parts
- [ ] Multiple filename patterns for the same purpose combined with `|` (OR)
- [ ] Sample URLs from each chain's current API documented or tested
- [ ] Regex tested against 2-3 real filenames before code review
- [ ] Comment explains what parts of filename are fixed vs. variable

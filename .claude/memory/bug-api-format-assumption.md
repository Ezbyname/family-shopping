---
name: api-format-assumption
description: Third-party APIs change format; don't assume JSON/HTML stays constant
metadata:
  type: feedback
---

**The Bug:** Shufersal's price index API changed from JSON to HTML table format, breaking the price sync worker. The code was hardcoded to expect JSON and didn't recognize the HTML response, resulting in "No PriceFull URL found" failures.

**Why:** We assumed the API format would remain stable. The code had an HTML parsing fallback, but it was never invoked because the logic tried JSON-parsing first and didn't fail loudly when it found no JSON.

**How to apply:** 
- **Always implement multiple parsing strategies for external APIs.** Don't let one format assumption block the whole flow.
- **Test against real API responses periodically**, especially for government/regulatory price feeds that may change without notice.
- **Add logging that distinguishes between "tried JSON, got HTML" vs "got neither"** so you know which fallback to activate.
- When adding a new chain: fetch the actual index URL and inspect the response format BEFORE coding the parser.

**Prevention checklist:**
- [ ] External API parser has ≥2 format handlers (JSON + HTML, or multiple JSON structures)
- [ ] Non-JSON responses don't silently fail; they trigger fallback parsing
- [ ] Parsing logic logs which format was detected (helps debug format changes)
- [ ] Sample API response documented in code or README (drift is easier to spot)

---
name: geoblocking-testing-constraint
description: Respect geoblocking constraints; some code can only be tested in specific regions
metadata:
  type: feedback
---

**The Issue:** Israeli supermarkets block non-Israeli IPs outright. Testing the price sync worker from a non-Israeli IP results in timeouts/empty responses. This can't be "fixed" with code changes—it's an intentional business/legal constraint.

**Why:** Supermarkets enforce geoblocking because of data licensing agreements, Israeli law, or anti-bot measures. The worker design correctly documents this ("DO NOT run this from Vercel/GitHub Actions") but it's easy to forget when testing.

**How to apply:**
- **Document environment-specific requirements upfront.** Mark code sections with required geographic regions or network conditions (e.g., `// Requires Israeli IP`).
- **Provide bypass flags for development.** The `BYPASS_IP_CHECK=true` env var allows dry-run testing without actual API calls (but still won't connect from non-IL IP).
- **Distinguish between "can't test here" vs. "code is broken."** A timeout from non-Israeli IP is expected; a parsing error when using `BYPASS_IP_CHECK` is a real bug.
- **Plan testing on the actual target platform.** For this worker: deploy to Google Cloud me-west1 (Tel Aviv) free tier or AWS il-central-1 first, not from local machine.

**Prevention checklist:**
- [ ] Environment constraints documented at top of file (e.g., "Requires Israeli IP")
- [ ] Dry-run/bypass modes available for development without network calls
- [ ] CI/CD aware of constraints; uses proxy fallback or skips geo-blocked steps
- [ ] Test plan specifies where/how to test (VPS, cloud region, local with bypass flags)
- [ ] Error messages distinguish geo-blocking (expected) from parsing bugs (unexpected)

**Related:** [[api-format-assumption]] — Testing against real APIs requires being in the right region to see actual responses.

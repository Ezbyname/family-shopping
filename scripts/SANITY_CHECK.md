# Price Sanity Check

## Architecture: Two Modes

The sanity check is **split into two independent verifications**:

### A. **Parser Fixture Tests** (GitHub Actions)
- **Runs**: Every PR, every push to main
- **IP requirement**: None (no external network calls)
- **Tests**: Parser correctness using local XML fixtures
- **Verifies**:
  - Parser handles different XML schemas (Shufersal, Rami Levy formats)
  - Tag name mapping works across chains
  - gzip decompression works
  - HTML entity decoding works (`&amp;` → `&`)
  - Field validation logic (barcode, name, price)
- **Fails CI if**: Parser has regressions

### B. **Live Chain Tests** (Israeli VM)
- **Runs**: Cron schedule on price-worker VM
- **IP requirement**: Yes (Israeli IP required for supermarket access)
- **Tests**: Real supermarket sources return valid prices
- **Verifies**: Every **enabled chain** produces at least one real official price
- **Writes**: Result to Firebase `latestPriceSanityStatus`
- **Requirement**: **ALL enabled chains must pass**
  - If any chain fails → status: "partial" or "fail"
  - Never "pass" if even one enabled chain fails

## When It Runs

### GitHub Actions (Parser Fixtures)
```
Trigger: PR or push to main (if scripts/ changed)
Command: npm run sanity:prices:fixture
No IP dependency ✅
```

### Israeli VM (Live Chains)
```
Trigger: Cron schedule (before/after sync)
Command: npm run sanity:prices:live
Requires Israeli IP ⚠️
Writes to Firebase
```

## Running Locally

### Parser Fixture Tests (No IP Required)
```bash
cd scripts/
npm install
npm run sanity:prices:fixture
```

**Output example:**
```
✅ shufersal PASS
   Parsed 2 items
   • 11210000094: רוטב טבסקו 60 מ"ל ₪13.9
   • 7290010328103: חלב תנובה 3% 1 ליטר ₪7.5

✅ rami-levy PASS
   Parsed 2 items
   ...

✅ Gzip decompression PASS

📊 PARSER FIXTURE SUMMARY
Passed: 3 | Failed: 0
```

### Live Chain Tests (Israeli IP Required)
```bash
cd scripts/
npm run sanity:prices:live
```

Requires Firebase credentials in `.env`:
```
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
FIREBASE_DATABASE_URL=...
```

**Output example:**
```
✅ shufersal PASS
   barcode: 11210000094
   name: רוטב טבסקו 60 מ"ל
   price: ₪13.90
   storeId: 034
   source: official

❌ rami-levy FAIL
   reason: DNS timeout / HTTP 403 / no valid item

📊 LIVE CHAIN SUMMARY
Tested: 5 | Passed: 1 | Failed: 4
✅ Firebase status updated
```

## Firebase Status

When run on the Israeli VM, live checks write to:

```
latestPriceSanityStatus = {
  status: "pass" | "partial" | "fail",
  runId: "sanity-1234567890",
  checkedAt: "2026-05-21T12:00:00Z",
  chainsTested: 5,
  chainsPassed: 5,
  chainsFailed: 0,
  results: {
    shufersal: {
      status: "pass",
      barcode: "11210000094",
      name: "רוטב טבסקו 60 מ\"ל",
      price: 13.90,
      storeId: "034",
      error: null
    },
    rami-levy: {
      status: "fail",
      barcode: null,
      name: null,
      price: null,
      storeId: null,
      error: "DNS timeout"
    }
  }
}
```

**Status meanings:**
- `pass`: ALL enabled chains returned valid prices
- `partial`: Some chains passed, some failed
- `fail`: Most/all chains failed

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | ✅ All enabled chains passed sanity check |
| 1 | ❌ Any chain failed — at least one cannot produce valid prices |

## CI/CD Integration

The GitHub Actions workflow (`.github/workflows/price-sanity.yml`):

- Runs on PR + push to main + manual dispatch
- Installs Node.js and dependencies
- Executes sanity check
- Fails pipeline if any enabled chain cannot produce a price
- Reports results in the PR

## Guardrails

This sanity check catches:

- ✅ Chain's index URL is down or unreachable
- ✅ Price file URL pattern changed (regex needs update)
- ✅ XML schema changed (parser field mappings broke)
- ✅ Product items missing barcode/name/price (normalization issue)
- ✅ gzip detection broken (file extension regex issue)
- ✅ HTML entity decoding broken (`&amp;` → `&`)

## Common Failures & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `DNS timeout / ENOTFOUND` | Running from non-Israeli IP | Expected; use `ALLOW_PARTIAL_SANITY=true` in CI |
| `HTTP 404 / 403` | Chain URL changed or blocked | Update `chains.js` indexUrl |
| `No price file URLs found` | Regex extraction broke | Review HTML structure; update regex in `fetchPriceUrl()` |
| `No valid item found` | XML schema changed | Map new tag names in `downloadAndFindFirstItem()` |

## Code Map

- **Script**: `scripts/sanity-price-check.js` (300 lines)
- **CI Workflow**: `.github/workflows/price-sanity.yml`
- **npm script**: `scripts/package.json` → `"sanity:prices"`

## Design Notes

### Lightweight

- Does **not** require Firebase credentials
- Does **not** write to any database
- Stops parsing after finding one valid item (early exit)
- Fast turnaround (30–60s per run, depending on download speeds)

### Reusable Code

Reuses logic from:
- `workers/prices/fetchPrices.js` — URL extraction, download, gzip handling
- `workers/prices/parseXml.js` — Tag name mappings across chains

### No Mock Data

- Every chain queried from real, live source
- Real products, real prices, real timestamps
- If parser broken → test will fail (catch regression)

---

**Last updated**: 2026-05-21  
**Created by**: CI/CD Sanity Check Setup

# Price Sanity Check

## Purpose

The sanity check ensures that **every enabled supermarket chain's price source is accessible and parseable** before code is deployed. This catches silent failures in the price sync pipeline.

## When It Runs

- **Automatically**: On every pull request (if `workers/prices/` or `scripts/` changed)
- **Automatically**: On every push to `main`
- **Manually**: Via GitHub Actions workflow dispatch button

## What It Does

For each enabled chain in `workers/prices/chains.js`:

1. **Fetch the index page** (HTML or JSON listing price files)
2. **Extract the price file URL** (handles SAS tokens, gzip extensions)
3. **Download the price file** (typically 10-50MB, compressed)
4. **Parse minimally** to find one valid product item
5. **Validate item structure**:
   - barcode (8+ digits)
   - product name (non-empty)
   - price > 0 ILS
   - source: "official"

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | ✅ All chains passed — at least one real price found per chain |
| 1 | ❌ One or more chains failed — cannot produce valid prices |

## Running Locally

```bash
cd scripts/
npm install
npm run sanity:prices
```

**Output example:**
```
✅ shufersal PASS
   barcode: 11210000094
   name: רוטב טבסקו 60 מ"ל
   price: ₪13.90
   source: official

❌ rami-levy FAIL
   reason: DNS timeout / HTTP 403 / no valid item

📊 SUMMARY
Tested: 5 | Passed: 1 | Failed: 4 | Duration: 52.24s
```

## Environment Variables

### `ALLOW_PARTIAL_SANITY` (optional)

If set to `true`, the check will warn about failed chains but **not fail the pipeline**:

```bash
ALLOW_PARTIAL_SANITY=true npm run sanity:prices
```

Useful for:
- Temporary chain downtime during maintenance
- Testing with non-Israeli IP (expected failures)

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

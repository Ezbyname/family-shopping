# Chain Onboarding Guide

How to add a new supermarket chain and verify the application continues working correctly.

---

## What "onboarding a chain" means

Adding a new chain means the price-sync worker will:
1. Fetch the chain's XML price feed from their servers.
2. Parse product barcodes, prices, store IDs, and addresses.
3. Write the data to Firebase under `prices/{barcode}/{chainId_storeId}` and `stores/{chainId_storeId}`.
4. Update `syncStatus/{chainId}` and `syncSummary` with the sync result.

The frontend is **chain-agnostic** by design — it renders whatever is in Firebase. No code changes are required in `app.js`, `styles.css`, or any API file when adding a new chain. The only change is in the worker.

---

## Step 1 — Add the chain to the worker

Edit `workers/prices/chains.js`:

```js
{
  id:        'new-chain',              // lowercase, hyphen-separated
  name:      'שם הרשת',               // Hebrew display name
  chainId:   '7290012345678',          // GS1 company prefix (13 digits)
  enabled:   true,
  indexUrl:  'https://prices.newchain.co.il/',
  baseUrl:   'https://prices.newchain.co.il',
  indexType: 'html',                   // 'html' or 'json'
}
```

Run a dry-run from an **Israeli IP** to verify parsing before writing to Firebase:

```bash
cd workers/prices
DRY_RUN=true node index.js new-chain
```

Expected output: products parsed, no errors, exit code 0.

---

## Step 2 — Run the regression suite

Run all three validation scripts from the `tests/` directory:

```bash
cd tests

# 1. Core basket compare (10 + 25 stores, mobile + desktop) — ~2 min
node pw-bc-validate.mjs

# 2. Large dataset (50 + 100 stores, mobile + desktop) — ~3 min
node pw-bc-large.mjs

# 3. Chain-expansion matrix (5/10/25 chains × 25–250 stores) — ~4 min
node pw-bc-chains.mjs
```

All three must report **0 failed** before proceeding.

---

## Step 3 — Run the Playwright e2e suite

```bash
cd tests
npx playwright test
```

Pay attention to:
- `11-coverage-diagnostics.spec.js` — verifies `/api/coverage` returns valid data
- `12-price-search-ui.spec.js` — verifies price search renders any chain configuration
- `15-chain-onboarding.spec.js` — directly tests "new chain joins existing chains"

---

## Step 4 — Validate the live sync

After the worker has synced the new chain (from the Israeli VPS):

```bash
# 1. Check Firebase for the new chain's data
curl "https://your-project-default-rtdb.europe-west1.firebasedatabase.app/syncStatus/new-chain.json"
# Expected: { "lastSyncDate": "...", "itemsProcessed": N, "storesProcessed": M, "errors": 0 }

# 2. Spot-check a product barcode that should exist in the new chain
curl "https://your-app.vercel.app/api/prices?barcode=BARCODE_HERE"
# Expected: prices array includes an entry with chainName = "שם הרשת"

# 3. Check coverage endpoint includes the new chain
curl "https://your-app.vercel.app/api/coverage"
# Expected: chains array includes { "id": "new-chain", "errors": 0, ... }
```

---

## Checklist

```
□ Chain entry added to workers/prices/chains.js
□ Dry-run passes with no errors (DRY_RUN=true node index.js new-chain)
□ node tests/pw-bc-validate.mjs → 0 failed
□ node tests/pw-bc-large.mjs    → 0 failed
□ node tests/pw-bc-chains.mjs   → 0 failed
□ npx playwright test           → 0 failed
□ syncStatus/new-chain shows errors: 0 after first live sync
□ /api/prices returns new chain stores for a known barcode
□ /api/coverage includes the new chain in chains[]
□ /api/basket-compare results include stores from the new chain
□ No regressions in existing chains (spot-check 2–3 barcodes)
```

---

## What the regression suite protects

| Test file | What it catches |
|---|---|
| `pw-bc-validate.mjs` | Rendering regressions (savings, medals, pagination) |
| `pw-bc-large.mjs` | Scale regressions (50/100 stores) |
| `pw-bc-chains.mjs` | Chain-count regressions (5/10/25 chains × up to 250 stores) |
| `11-coverage-diagnostics.spec.js` | `/api/coverage` shape and per-chain fields |
| `12-price-search-ui.spec.js` | Price search renders any chain configuration |
| `15-chain-onboarding.spec.js` | "New chain alongside existing chains" pattern |

The suite is **chain-agnostic**: all mock data uses generic names (`רשת 1`, `רשת 2`, …). Adding a real chain requires no test changes.

---

## Common issues

**Chain doesn't appear in `/api/prices`**
- Check `syncStatus/{chainId}.errors` — if > 0, the sync failed
- Run `LOG_LEVEL=debug DRY_RUN=true node index.js new-chain` to diagnose
- Verify the chain's `indexUrl` is reachable from the Israeli VPS

**Chain appears but store addresses are missing**
- The XML may use different tag names for address fields
- Check `parseXml.js` — add field mappings for the new chain's format
- Re-run dry-run and check store output

**`/api/coverage` doesn't include the new chain**
- Verify `syncStatus/{chainId}` was written to Firebase
- The coverage API reads `syncStatus/*` — if the key is missing, the chain won't appear
- Force a sync and check Firebase directly

**Regression suite fails after adding the chain**
- The suite uses only generic mock data — real chain names never appear in mocks
- If a test fails, the regression is in the rendering logic, not the chain data
- Run `npx playwright test --headed` to watch the failure visually

# Retailer Expansion Plan — Phase 4

Prerequisite: Phase 1 live Precision@3 ≥ 90% confirmed before starting.

## Current State

| Chain          | Status   | Known Issue |
|----------------|----------|-------------|
| Shufersal      | ✅ Live  | — |
| Rami Levy      | ⏸ pending | `url.retail.pe.il` ENOTFOUND; FTP index URL unverified |
| Carrefour IL   | ⏸ pending | `prices.carrefour.co.il` candidate unverified |
| Yochananof     | ⏸ pending | Not yet in chains.js |
| Victory        | ⏸ pending | `laibcatalog.co.il` candidate unverified |
| Osher Ad       | ⏸ pending | `osherad.co.il/prices/` returns HTTP 403 |

## Integration Order

### 1. Rami Levy (`rami-levy`)

**Why first:** High market share, high probability of user overlap with Shufersal users.

**Action steps:**
1. On Israeli VPS, verify the candidate URL:
   ```bash
   curl -I "https://url.retail.publishedprices.co.il/MF/latest/7290058140886/"
   ```
2. If HTTP 200: inspect the HTML index for `PriceFull*.gz` file naming pattern.
3. Verify XML structure matches Shufersal's or requires parser adjustment.
   - Compare `<Product>` tag structure with `parseXml.js` expected fields.
   - Key fields to confirm: `ItemCode`, `ItemPrice`, `StoreId`, `StoreName`.
4. In `chains.js`, set `enabled: true`, update `status: 'enabled'`, set `lastVerified`.
5. Run dry-run: `node index.js rami-levy` — confirm product count > 0.
6. Run live sync: check Firebase `prices/` node for `rami-levy` entries.
7. Update `sanityRequired: true` once confirmed stable.

**Parser compatibility check:** Run this on the VPS after downloading one file:
```bash
DRY_RUN=true node index.js rami-levy 2>&1 | grep -E "items|error|warn"
```

---

### 2. Carrefour IL (`yeinot-bitan`)

**Why second:** Yeinot Bitan rebranded to Carrefour; large network, especially south Israel.

**Action steps:**
1. On Israeli VPS, verify:
   ```bash
   curl -I "https://prices.carrefour.co.il/"
   ```
2. Check if chainId `7290873255550` is still correct (may have changed on rebrand).
   - Verify against IL Ministry of Economy price transparency registry.
3. Check index type (HTML listing or JSON array) and file naming.
4. Enable, dry-run, live sync as above.

---

### 3. Yochananof

**Why third:** Large presence in Jerusalem area, distinct pricing from other chains.

**Action steps:**
1. Find index URL. Candidate sources:
   - IL price transparency registry: `http://consumers.gov.il/`
   - Community resource: `https://github.com/public-il/supermarkets`
2. Add entry to `chains.js` with `enabled: false` until URL is verified.
3. Confirm chainId via GS1 IL registry.
4. Follow same verify → dry-run → live cycle.

---

## Architecture Rules for Retailer Integration

1. **Do not modify normalization logic** (`api/ingredients.js`, `api/normalize-he.js`) during integration.
   - If a new chain exposes product names that fail search, log them via `unmapped_query` telemetry first.
   - Only add catalog entries after telemetry shows ≥ 5 real user queries.

2. **`normalizeProduct.js` handles all per-chain field mapping.**
   - Chain-specific field names (e.g. `ItemCode` vs `Barcode`) belong here, not in the API.

3. **Parser compatibility:** `parseXml.js` uses SAX streaming. If a new chain uses a different root element or attribute structure, add a `parseStyle` flag to `chains.js` and branch in `parseXml.js` — do not duplicate the parser.

4. **`syncStatus` telemetry per chain:**
   - After enabling, monitor `Firebase → syncStatus/{chainId}` for `errors` count.
   - A chain with `errors > 0.05 * itemsProcessed` on first run is a parser mismatch — disable and investigate before next cron run.

5. **Search compatibility check:**
   After first live sync of a new chain, run:
   ```bash
   BASE=https://your-deploy.vercel.app \
   VERCEL_BYPASS=<token> \
   node tests/search-health.mjs
   ```
   Precision@3 must not regress. If it does, the new chain is injecting noise — investigate product name normalization.

---

## Verification Checklist per Chain

- [ ] Candidate URL returns HTTP 200 from Israeli VPS
- [ ] HTML index lists `PriceFull*.gz` (or equivalent) files
- [ ] chainId confirmed against official registry
- [ ] `node index.js <chain> --dry-run` produces > 1000 items with 0 parse errors
- [ ] `node index.js <chain>` (live) writes to Firebase without error
- [ ] `syncStatus/{chainId}.errors` = 0 or < 5% of items
- [ ] `node tests/search-health.mjs` Precision@3 unchanged or improved
- [ ] `sanityRequired: true` set, chain passes `npm run sanity:prices:live`
- [ ] `lastVerified` date updated in `chains.js`

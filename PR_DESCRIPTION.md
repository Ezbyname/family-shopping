# Search UX, Store Details V2, Price Enrichment, Chain Research

## What changed

### Bug fixes
- **Curly quote SyntaxError** (`4a44000`) — 41 U+2018/U+2019 characters in `app.js` replaced with straight quotes; caused a parse failure on strict JS engines.
- **Search first-tap reliability** (`f143506`) — translation resolver pre-warmed on page load; first tap no longer sends raw Hebrew before modules are ready.
- **Android back button** (`af8e4b5`) — back button now dismisses dialogs in priority order; no longer falls through to browser navigation when a sheet is open.
- **Score threshold** (`af8e4b5`) — filter no longer silently drops all results when no product passes the threshold; shows top-N with a "lower relevance" banner instead.

### Search improvements
- **Tap-lock** (`af8e4b5`) — search button disabled immediately on tap; prevents duplicate in-flight requests from double-taps.
- **Adaptive relevance threshold** (`3476866`) — relative scoring (`best−15` / `best−20`) replaces fixed cutoff; fixes Kinder Chocolate appearing in "חלב" results.
- **Debug instrumentation** (`3476866`) — `window._searchDebug()` in console shows last query scores and threshold decisions.

### Store Details V2 (product modal)
- **Flat per-store list** (`d7fcd84`) — replaces grouped chain accordion with a flat sorted list (price asc, distance tiebreaker). Each row shows chain, sub-branch, price, address, distance. Tap to expand: sync age, approximate-location flag, Google Maps nav button.
- **Savings spread header** (`d7fcd84`) — min→max price range shown at top of modal when spread > ₪0.
- **Pagination** (`1c80d3b`) — 10 stores shown initially per product; "Show N more" button; state preserved across swipe navigation in a module-scoped `Map` (no `window` pollution).
- **Removed dead code** (`1c80d3b`) — `_fetchByCity` and `_fetchNearby` async updaters that referenced removed DOM nodes deleted.

### Price enrichment (address / navigation)
- **Field name drift fix** (`3e5b437`, worker + API) — worker was writing `name: store.storeName` to `storeCoords/`; API was reading `v.name`. Both corrected to `storeName`.
- **`detail=1` API contract** (`3e5b437`) — new query param gates storeIndex load + enrichment. Without it, responses are lightweight (no storeIndex read).
- **Modal-only enrichment** (`06587d8`) — search and barcode requests are now lightweight. `detail=1` fires only when the product modal opens:
  1. Modal renders immediately with price data.
  2. Fetch `?barcode=...&detail=1` in background.
  3. Merge `address` / `city` / `storeName` / `lat` / `lng` into store rows.
  4. Silent re-render. Cache (`_productDetailCache` Map) prevents repeat fetches on swipe-back.
- **`Number.isFinite` coordinate guard** (`3e5b437`) — Maps URL builder now validates lat/lng strictly; falls back to text query when coordinates are `null` or `NaN`.

### Chain research & config
- **Rami Levy** (`ededcbd`) — correct URL (`url.retail.publishedprices.co.il/RamiLevi/`), status `needs-ftp`, FTP host/user documented.
- **Victory** (`ededcbd`) — new source `laibcatalog.co.il` (JSON REST API), status `needs-json-parser`.
- **Carrefour** (`ededcbd`) — replaces defunct Yeinot Bitan entry; corrected chainId `7290055700007`; status `ready-to-test`.
- **Osher Ad** (`ededcbd`) — corrected chainId `7290103152017`; same FTP server as Rami Levy.
- **Mahsanei Lahav** (`ededcbd`) — marked `deprecated: true`; brand absorbed into Carrefour.
- **`scripts/chains.js` synced** (`1e43912`) — same corrections applied to the scripts copy; added full status lifecycle documentation.

### CI / repo hygiene
- **`.gitignore`** (`39553f2`) — `playwright-report/` and `test-results/` added; prevents accidental artifact commits.
- **Playwright version reverted** (`e81b36f`) — container-specific pin to 1.60.0 reverted; original `^1.44.0` range restored.

---

## Files changed

| File | Change |
|---|---|
| `app.js` | Search fixes, Store Details V2, pagination, enrichment flow, cache |
| `api/prices.js` | `detail=1` param, storeIndex gate, `enrichFromStoreIndex()`, field name fix |
| `workers/prices/index.js` | `storeName`/`address` written to `storeCoords/` |
| `workers/prices/chains.js` | Chain URLs, chainIds, statuses updated |
| `scripts/chains.js` | Same corrections + status lifecycle docs |
| `styles.css` | Store Details V2 CSS (`.sr2-*`, `.pm-spread`, `.pm-store-footer`) |
| `.gitignore` | Playwright artifact dirs added |
| `tests/package.json` | Formatting restored (no version change) |

---

## Validation checklist (manual, post-CI)

- [ ] Search: `קוטג'`, `קוטג׳`, `קוטץ` — results appear, no Kinder Chocolate in `חלב`
- [ ] Search: `נייר טואלט` / `נייר שירותים` — same results
- [ ] Import: add / bought / remove / duplicate merge
- [ ] Product modal: opens, address appears ~200ms after open, Maps nav button works
- [ ] Product modal: swipe next/previous, cache prevents repeat fetch (check Network tab)
- [ ] Pagination: >10 stores → counter + "Show N more" button
- [ ] Price comparison modal: stores render, no JS errors
- [ ] Existing flows unchanged: favorites, barcode, WhatsApp import

---

## Rollback

Each concern is an independent commit. Targeted revert order if needed:
1. Enrichment only: revert `06587d8` + `3e5b437`
2. Store Details V2 only: revert `1c80d3b` + `d7fcd84`
3. Search threshold only: revert `3476866`
4. Chain config only: revert `1e43912` + `ededcbd`

No Firebase schema changes. No API contract breaks (additive `detail=1` param only).

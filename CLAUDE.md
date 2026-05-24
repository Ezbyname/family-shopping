# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Family Shopping** is a Hebrew-language PWA for comparing Israeli supermarket prices. Families create shared shopping lists, and the app fetches live prices from official supermarket price feeds to show the cheapest options.

- **Frontend**: Vanilla JS/HTML/CSS PWA (RTL, offline-capable, ~3KB gzipped)
- **Price Sync Worker**: Node.js daemon that runs on Israeli VPS, syncing prices from 6+ Israeli supermarket chains into Firebase
- **APIs**: Price lookup, basket comparison, manual price overrides, proxy cache fallback
- **Database**: Firebase Realtime Database (prices, stores, sync metadata, user overrides)
- **Deployment**: Vercel (frontend + serverless APIs), Netlify (alternative), or VPS (worker only)

## Architecture

### Frontend (`index.html` + inline CSS/JS)
- Single-page PWA with tabs: groups, lists, items, deals, settings
- Hebrew (RTL) with offline-first design: app shell cached via service worker
- Real-time sync via Firebase listeners on group/list data
- Translation/fuzzy matching via `js/translation/` for product name resolution
- Service worker (`sw.js`) caches assets and falls back offline

### Price Sync Worker (`workers/prices/`)
- **Constraint**: Must run on server with Israeli IP address (supermarkets block non-IL IPs)
- Runs on cron (typically 2×/day via PM2 or GitHub Actions)
- Flow:
  1. Load config from environment (Firebase credentials, chain list)
  2. Check server IP is Israeli (fail fast if not)
  3. For each supermarket chain:
     - Fetch index of price files (HTML listing or JSON array)
     - Download full price XML (typically 50-200MB per chain)
     - Parse XML stream into product objects
     - Normalize barcodes, prices, store locations
     - Batch-write to Firebase (deduped by barcode + chain + store)
  4. Write sync metadata (lastSync, item count, error count)
- Exit codes: `0` (success), `1` (all chains failed), `2` (config error), `3` (non-Israeli IP), `4` (Firebase write), `5` (all sources unreachable)

**Key modules**:
- `index.js`: Orchestrator, chain loop, error handling, exit codes
- `config.js`: Env var validation (fail-fast pattern)
- `chains.js`: Chain definitions (Shufersal, Rami Levy, Victory, etc.)
- `fetchPrices.js`: HTTP download + stream handling (retries, timeouts)
- `parseXml.js`: SAX parser for price XML (memory-efficient streaming)
- `normalizeProduct.js`: Barcode validation, price extraction, store mapping
- `firebaseWriter.js`: Batch writer, deduplication, sync metadata
- `check-ip.js`: IP geolocation check (blocks non-Israeli IPs)
- `logger.js`: Structured JSON logging (local dev, PM2 files, Slack alerts)
- `tests/run-tests.js`: Smoke tests (config, Firebase, IP, cURL to supermarkets)

### APIs (`api/`)
- **Serverless on Vercel/Netlify** (can also run on VPS as Express routes)
- `prices.js` (v6): Layered price lookup — personal overrides → official XML → proxy cache → manual family entries
  - Query params: `barcode`, `q` (search), `lat`/`lng`/`radiusKm` (location filter), `groupId`, `userId`
  - Returns: ranked array of stores + prices with freshness timestamp, source, and staleness flag
  - Hebrew-to-English translation for Open Food Facts fallback search
- `basket-compare.js`: Compare total cost of shopping list across stores
- `manual-price.js`: User-submitted price corrections (for when official feeds are wrong)
- `proxy-prices.js`: Fallback proxy for non-Israeli users (1h cache, lower priority)
- `_firebase.js`: Shared helpers (Haversine distance, CORS, barcode validation)

### Data Schema (Firebase Realtime DB)
```
prices/{barcode}/{chainId_storeId}
  → { barcode, name, price, chainId, chainName, storeId, storeName, unit, quantity, brand, updatedAt, currency: "ILS", source: "official", syncedAt }

stores/{chainId_storeId}
  → { chainId, chainName, storeId, storeName, address, city, zipCode, latitude, longitude, hasCoords, updatedAt }

syncStatus/{chainId}
  → { lastSyncDate, lastSuccessAt, lastPriceUrl, itemsProcessed, storesProcessed, errors }

syncSummary
  → { lastSync, lastSyncDate, totalProducts, chainsSucceeded, chainsFailed, elapsedMinutes }

groups/{groupId}
  → { name, members, createdAt, ... }

lists/{groupId}/{listId}
  → { name, items, completedAt, ... }

manualPrices/{groupId}/{barcode}/{entryId}
  → { price, storeId, storeName, entryDate }

userPriceOverrides/{userId}/{barcode}/{key}
  → { name, price, store, manual: true, overrideDate }

priceReports
  → Crowdsourced price alerts (warning signal, never shown as real price)
```

## Commands

### Local Development
```bash
# Frontend only (static)
# Serve index.html on http://localhost:3000 (most IDEs or python -m http.server)

# Worker (requires Israeli VPS to actually sync)
cd workers/prices
npm install
npm run test:config        # Validate env vars
npm run check:ip           # Verify Israeli IP (must pass to sync)
npm run test:firebase      # Verify Firebase connectivity
npm run sync:dry-run       # Parse prices without writing to Firebase
npm run sync               # Full sync (all chains)
node index.js shufersal    # Single chain
LOG_LEVEL=debug npm run sync:dry-run  # Verbose logging

# Scripts (legacy one-off syncs, rarely used)
cd scripts
npm install
node sync-prices.js        # Use FIREBASE_SERVICE_ACCOUNT env var instead of separate vars
```

### Testing
```bash
# Worker tests
cd workers/prices
npm test                   # Run test suite (smoke tests)
npm run test:curl          # Verify Shufersal and Rami Levy are reachable (HTTP 200)

# Frontend: no automated tests; manual QA via browser
# Test offline mode: DevTools → Network → Offline, reload, app should still load
```

### Deployment
```bash
# Frontend: Push to main, Vercel auto-deploys
git push origin main

# Worker: Deploy to VPS and set up cron/PM2
# (See workers/prices/README.md for step-by-step)
# Or trigger via GitHub Actions (runs on GH runner, which has non-Israeli IP, so uses proxy sync)

# APIs: Deployed to Vercel /api/ or Netlify /functions/
```

## Key Constraints & Implementation Notes

### Israeli IP Requirement
- Supermarkets (Shufersal, Rami Levy, etc.) block non-Israeli IPs with HTTP 403 or empty responses
- Worker **refuses to sync** if IP check fails (exit code 3)
- GitHub Actions runners have US/non-IL IPs → sync script uses proxy fallback or lightweight heuristics
- **Recommended deployment**: Google Cloud `me-west1` (Tel Aviv) free tier, AWS `il-central-1`, or Israeli VPS
- **Check IP**: `npm run check:ip` (looks up via ipapi.co, uses ipv4.icanhazip.com fallback)

### Price XML Format & Parsing
- Each chain publishes XML files (50-200MB) with barcodes, prices, store locations
- Parser is **SAX-based streaming** (low memory footprint) not DOM parsing
- Expected structure varies by chain:
  - Shufersal: `PricesFull` → `Product` → `PriceTag` (for each store)
  - Rami Levy: Similar but different tag names
  - Other chains: Unique formats (see `chains.js` for `indexUrl` and `baseUrl`)
- Parser extracts: `barcode`, `name`, `price`, `quantity`, `unit`, `storeId`, `storeName`, `address`, `city`, `zipCode`, `lat`, `lng`
- Normalization:
  - Barcodes: Remove non-digits, validate 8/12/13/14 digits, reject obviously wrong
  - Prices: Must be 0.01–10,000 ILS
  - Units: Normalize "kg" vs "gr" vs "L" vs "pcs"

### Sync Deduplication
- Key: `{barcode}#{chainId}#{storeId}#{unit}#{quantity}` (not just barcode)
- Same product can have different prices per store or unit (e.g., 1L milk vs 1.5L milk)
- Firebase batch writes with 400-item max size (safety margin below Firebase's 500-document limit)
- Stale data cleanup: Not automatic; old records overwritten on next sync

### Concurrency & Resource Limits
- Default: Sequential chain syncing (`SYNC_CONCURRENCY=1`) to reduce peak memory
- Can parallelize with `SYNC_CONCURRENCY=2` or higher (uses more RAM)
- Download timeout: 120s per file (configurable)
- Batch size: 400 Firebase writes per batch (safer than max 500)
- Typical run time: Shufersal ~8-15 min, all 3-6 chains ~25-90 min

### API Response Format
- Prices API returns **layered results** (priority order):
  1. User personal overrides (personal shopping history)
  2. Official prices (from supermarket XML)
  3. Proxy cache (non-Israeli users' fallback)
  4. Manual family entries (crowdsourced)
  5. Price reports (warning signal, not shown as real)
- Each result includes: `source` (string), `syncedAt` (timestamp), `isStale` (if older than 36h)
- Frontend shows warning if `isStale: true`

### Offline & Caching
- Service worker caches app shell (HTML, manifest, icons)
- Firebase data cached locally (via browser IndexedDB via Firebase SDK)
- If offline: app loads from cache; price queries fail gracefully (show cached prices with old timestamp)
- If network returns but prices are stale (>36h): frontend shows "Prices may be outdated" warning

### Language & RTL
- All text in Hebrew (manifest, HTML, CSS)
- RTL layout via `dir="rtl"` in HTML, Flexbox with `flex-direction: column-reverse` for certain stacks
- Translation engine (`js/translation/`) maps Hebrew product names to English for Open Food Facts lookup
- Fuzzy matching for misspellings/variations

## Development Notes

### Adding a New Supermarket Chain
1. Add entry to `workers/prices/chains.js`:
   ```js
   {
     id: 'chain-id',
     name: 'שם הרשת',        // Hebrew name
     chainId: '7290000000000', // Official GS1 company ID
     enabled: true,
     indexUrl: 'https://prices.chain.co.il/', // URL of file index
     baseUrl: 'https://prices.chain.co.il',   // Base for relative URLs
     indexType: 'html',       // 'html' or 'json'
   }
   ```
2. Test: `node index.js chain-id` (dry-run or full)
3. Verify parser extracts expected fields; adjust `parseXml.js` if format is unique

### Debugging Worker
- `LOG_LEVEL=debug npm run sync:dry-run` for verbose output
- `npm run test:firebase` to validate credentials early
- `npm run test:curl` to verify supermarket URLs are reachable
- Check `/var/log/price-worker/` on VPS for PM2 logs

### Firebase Rules (Production Checklist)
```json
{
  "rules": {
    "prices":     { ".read": true, ".write": false },       // Readable by app, written only by service account
    "stores":     { ".read": true, ".write": false },
    "syncStatus": { ".read": true, ".write": false },
    "syncSummary": { ".read": true, ".write": false },
    "manualPrices": {
      "$groupId": { ".read": "root.child('groups').child($groupId).child('members').hasChild(auth.uid)", ".write": false }
    },
    "groups": {
      "$groupId": {
        ".read": "root.child('groups').child($groupId).child('members').hasChild(auth.uid)",
        ".write": "root.child('groups').child($groupId).child('members').hasChild(auth.uid)"
      }
    }
  }
}
```

### Common Tasks
- **Worker won't start**: Check `.env` exists and all 4 `FIREBASE_*` vars are set (`npm run test:config`)
- **Prices not syncing**: Verify Israeli IP (`npm run check:ip`), verify supermarket URLs reachable (`npm run test:curl`), check Firebase write rules
- **Frontend shows stale warning**: Sync ran >36h ago; check cron job or manually trigger `node index.js`
- **Barcode not found**: Might not be in any supermarket's official feed; user can add via manual override or ask group to add

## Dependencies
- **Frontend**: None (vanilla JS)
- **Worker**: `firebase-admin` (v12+), `node-fetch` (v3), `sax` (v1.4 for XML parsing)
- **APIs**: Firebase Admin SDK (shared)
- **Deployment**: Node.js 20+, npm
- **Testing**: Minimal (config validation, cURL checks, Firebase connectivity)

## VM Paths (Israeli Price-Worker VPS)
- **User/home**: `/home/yahalom_assets/family-shopping/`
- **Scripts .env**: `/home/yahalom_assets/family-shopping/scripts/.env`
- **Worker .env**: `/home/yahalom_assets/family-shopping/workers/prices/.env`
- **PM2 config**: `/home/yahalom_assets/family-shopping/ecosystem.config.cjs`
- Both `.env` files contain the 4 `FIREBASE_*` credentials
- `sync-prices.js` auto-loads `scripts/.env` on startup (no `--env-file` flag needed)

## Environment Variables
**Worker (`workers/prices/.env`)**:
```
FIREBASE_PROJECT_ID=<your-project>
FIREBASE_CLIENT_EMAIL=<service-account-email>
FIREBASE_PRIVATE_KEY=<service-account-key-with-newlines>
FIREBASE_DATABASE_URL=https://<project>.firebaseio.com
ENABLED_CHAINS=               # Optional: comma-separated; empty = all
SYNC_CONCURRENCY=1            # Optional: 1-4
BATCH_SIZE=400                # Optional: max 400 (safety margin)
DOWNLOAD_TIMEOUT_MS=120000    # Optional: per-file timeout
DOWNLOAD_RETRIES=3            # Optional: retry attempts
LOG_LEVEL=info                # Optional: debug/info/warn/error
SLACK_WEBHOOK_URL=            # Optional: Slack alerts on critical failure
BYPASS_IP_CHECK=              # Development only: skip Israeli IP check
DRY_RUN=true                  # Development: parse but don't write to Firebase
```

**APIs (via Vercel/Netlify env)**:
- Same 4 `FIREBASE_*` vars as worker

## References
- Full VPS deployment guide: `workers/prices/README.md`
- Chain definitions & XML formats: `workers/prices/chains.js`
- Firebase schema & sync metadata: `workers/prices/index.js` and API comments
- GitHub Actions workflow (runs sync with proxy fallback): `.github/workflows/sync-prices.yml`

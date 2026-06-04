# Family Shopping — CI/CD Safety System

## Architecture

```
Every push/PR to main
        │
        ▼
┌─────────────────────┐
│  Job 1: Parser      │  Fast (< 2 min). No secrets.
│  Sanity             │  Catches XML parsing regressions.
│  (scripts/)         │  Always runs — blocks merge on failure.
└────────┬────────────┘
         │ passes
         ▼
┌─────────────────────┐
│  Job 2: API Smoke   │  Fast (< 2 min). Requires VERCEL_PRODUCTION_URL.
│  • Firebase health  │  Catches: Firebase down, API 500s, missing assets.
│  • Vercel assets    │  Exit-fast before spending browser time.
└────────┬────────────┘
         │ passes
         ▼
┌─────────────────────────────────────────────────────┐
│  Job 3: E2E Tests (Playwright)                      │  ~10 min
│  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │ mobile-chrome   │  │ desktop-chrome           │  │  Parallel
│  │                 │  │                          │  │
│  │ 01-app-loads    │  │ 01-app-loads             │  │
│  │ 02-new-user     │  │ 02-new-user              │  │
│  │ 03-returning    │  │ 03-returning             │  │
│  │ 04-join-group   │  │ 04-join-group            │  │
│  │ 05-shopping     │  │ 05-shopping              │  │
│  │ 06-prices       │  │ 06-prices                │  │
│  │ 07-offline      │  │ 07-offline               │  │
│  └─────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │ passes
         ▼
     Merge allowed ✅

After Vercel deploys to production:
         │
         ▼
┌─────────────────────┐
│ Post-Deploy Verify  │  Triggered by Vercel deploy hook
│ (same smoke + E2E)  │  Failure → shows rollback instructions
└─────────────────────┘
```

## Folder Structure

```
tests/
├── package.json              # @playwright/test dependency
├── playwright.config.js      # Browser matrix, timeouts, reporter
├── README.md                 # This file
├── e2e/
│   ├── fixtures/
│   │   └── test-fixtures.js  # Shared Playwright fixtures + helpers
│   ├── pages/
│   │   └── AppPage.js        # Page Object Model for the PWA
│   ├── 01-app-loads.spec.js  # App shell, SW, manifest, health API
│   ├── 02-new-user.spec.js   # New user registration + group creation
│   ├── 03-returning-user.spec.js  # Returning user / continue session
│   ├── 04-join-group.spec.js # Join group flow + error handling
│   ├── 05-shopping-list.spec.js   # Add item + Firebase round-trip
│   ├── 06-price-comparison.spec.js # Price API correctness
│   └── 07-offline.spec.js    # Service worker offline recovery
└── smoke/
    ├── firebase-health.js    # Fast HTTP probe of /api/health
    └── vercel-health.js      # Checks all static assets + API routes

.github/workflows/
├── ci.yml                   # Main CI gate (PR + push to main)
├── post-deploy-verify.yml   # Runs after Vercel production deploy
├── rollback.yml             # Emergency rollback (manual, admin-gated)
├── price-sanity.yml         # Existing: XML parser tests (unchanged)
└── sync-prices.yml          # Existing: price sync cron (unchanged)
```

## Setup

### 1. Install test dependencies
```bash
cd tests
npm install
npx playwright install chromium
```

### 2. Run locally against production
```bash
TEST_BASE_URL=https://your-app.vercel.app npm run test:smoke
TEST_BASE_URL=https://your-app.vercel.app npm run test:e2e
```

### 3. Run locally with local server
```bash
npm run test:e2e:headed  # opens a browser you can watch
```

### 4. GitHub Actions setup
Add these to your repository (Settings → Variables → Actions):
- `VERCEL_PRODUCTION_URL` = `https://your-app.vercel.app`

No secrets needed for E2E tests — they probe the live deployed app.

## Critical Flows Protected

| # | Flow | Test file |
|---|------|-----------|
| 1 | New user registration | 02-new-user.spec.js |
| 2 | Create group | 02-new-user.spec.js |
| 3 | Join group | 04-join-group.spec.js |
| 4 | Returning user login | 03-returning-user.spec.js |
| 5 | Continue existing session | 03-returning-user.spec.js |
| 6 | Add shopping item | 05-shopping-list.spec.js |
| 7 | Mark item purchased | 05-shopping-list.spec.js |
| 8 | Sync between users | 05-shopping-list.spec.js (Firebase write round-trip) |
| 9 | Price comparison | 06-price-comparison.spec.js |
| 10 | Firebase connectivity | smoke/firebase-health.js + 01-app-loads |
| 11 | Offline recovery | 07-offline.spec.js |
| 12 | App shell loads | 01-app-loads.spec.js |

## Rollback Strategy

### Automatic (post-deploy failure)
1. Post-deploy workflow prints rollback instructions
2. Go to Vercel → Deployments → find last green → "Promote to Production"
3. Takes ~30 seconds, zero code change required

### Git revert (if Vercel rollback isn't enough)
```bash
git revert HEAD
git push origin main
# Vercel auto-deploys the reverted code
```

### Emergency rollback workflow
1. GitHub → Actions → "Emergency Rollback" → Run workflow
2. Requires admin approval (protected `production` environment)
3. Enter the target SHA or leave blank to revert HEAD
4. After merge, run "Post-Deploy Verification" to confirm recovery

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Firebase outage | Low | High | Health check fails fast in smoke; price data has 36h stale tolerance |
| Vercel cold start timeout | Medium | Low | Health check has 15s timeout; retried 2× in CI |
| Test accesses live Firebase | Medium | Medium | Tests use ci-test-group / clear localStorage — no real family data touched |
| E2E selector rot (UI changes) | High | Low | Selectors use multiple fallbacks (id → aria → text); failures are warnings not blockers for unrelated flows |
| Non-Israeli IP blocks price sync | N/A | None | Sync tests only check parser fixtures, not live chain URLs |
| Service worker caching old test state | Medium | Medium | Tests call `localStorage.clear()` + `sessionStorage.clear()` in beforeEach |
| Flaky Firebase write timing | Medium | Low | 8s timeout on Firebase write round-trip; 2 retries in CI |

## Deployment Gate Summary

A deployment is blocked if ANY of the following are true:
- Parser fixture test fails (XML regression)
- `/api/health` returns non-200 or `ok: false`
- Any static asset (index.html, app.js, styles.css, sw.js, manifest.json) returns non-200
- App shell does not render within 15 seconds
- New user flow crashes or fails to reach main app
- Firebase write round-trip (add item) fails to appear in list within 8 seconds
- Price API returns HTTP 500
- Offline reload shows a browser error page

# Setting Up Live Sanity Checks on Israeli VM

## Purpose

The live sanity check runs on the price-worker VM (with Israeli IP) to verify that every enabled supermarket chain returns real prices. Results are written to Firebase.

## Setup on Israeli VPS

### 1. Add PM2 Ecosystem Task

Update `ecosystem.config.cjs` on the VM to add the sanity check cron job:

```javascript
{
  name: 'price-sanity-live',
  script: 'scripts/sanity-live.js',
  cwd: '/home/price-worker/family-shopping',
  args: '',
  instances: 1,
  exec_mode: 'fork',
  error_file: '/var/log/price-worker/sanity.error.log',
  out_file: '/var/log/price-worker/sanity.out.log',
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  cron_restart: '0 3,15 * * *',  // 03:00 & 15:00 UTC = 06:00 & 18:00 Israel time
  env: {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
    FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL,
  },
  watch: false,
  ignore_watch: ['node_modules', '.git', 'data'],
  max_memory_restart: '2G',
  autorestart: true,
  max_restarts: 5,
  min_uptime: '10s',
},
```

### 2. Update PM2

```bash
sudo pm2 reload ecosystem.config.cjs
sudo pm2 save
```

### 3. Verify Cron Schedule

```bash
sudo pm2 logs price-sanity-live
```

You should see output at:
- **06:00 Israel time** (03:00 UTC): Before morning price sync
- **18:00 Israel time** (15:00 UTC): After afternoon price sync

## What It Does

1. **Fetches enabled chains** from `workers/prices/chains.js`
2. **For each chain**:
   - Fetches the index page (HTML/JSON listing price files)
   - Extracts the price file URL
   - Downloads the file (typically 50-200MB, gzipped)
   - Parses XML to find one valid product
   - Validates: barcode, name, price > 0
3. **Writes Firebase status** to `latestPriceSanityStatus`
4. **Exits**:
   - Exit 0 if ALL enabled chains pass
   - Exit 1 if ANY chain fails (PM2 will log as error)

## Firebase Status Fields

After each run, check:

```bash
curl "https://[your-firebase-project].firebaseio.com/latestPriceSanityStatus.json"
```

Response example:
```json
{
  "status": "pass",
  "runId": "sanity-1234567890",
  "checkedAt": "2026-05-21T15:00:00Z",
  "chainsTested": 5,
  "chainsPassed": 5,
  "chainsFailed": 0,
  "results": {
    "shufersal": {
      "status": "pass",
      "barcode": "11210000094",
      "name": "רוטב טבסקו 60 מ\"ל",
      "price": 13.90,
      "storeId": "034",
      "error": null
    },
    "rami-levy": {
      "status": "pass",
      ...
    }
  }
}
```

## Alerting & Monitoring

### Check Latest Status

```bash
node -e "const admin = require('firebase-admin'); admin.initializeApp({ ... }); admin.database().ref('latestPriceSanityStatus').once('value', snap => console.log(JSON.stringify(snap.val(), null, 2)));"
```

### Set Up Slack Alert (Optional)

Modify `sanity-live.js` to send Slack notification on failure:

```javascript
if (failed > 0 && firebaseDb) {
  const slackWebhook = process.env.SLACK_WEBHOOK_URL;
  if (slackWebhook) {
    await fetch(slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🚨 Price Sanity Check FAILED: ${failed}/${results.length} chains`,
        blocks: [ /* format message */ ]
      })
    });
  }
}
```

### Check Logs

```bash
tail -f /var/log/price-worker/sanity.out.log
tail -f /var/log/price-worker/sanity.error.log
```

## Troubleshooting

### Chain fails with "DNS timeout" or "HTTP 403"

- **Cause**: Supermarket may be temporarily down or blocking the IP
- **Action**: Check if sync job is also failing. Wait for next cron run.

### Chain fails with "No valid item found"

- **Cause**: XML schema may have changed
- **Action**: 
  1. Manually fetch the chain's price file
  2. Check XML structure
  3. Update `sanity-live.js` tag mappings if needed
  4. Test locally: `npm run sanity:prices:live`

### Firebase write fails

- **Cause**: Firebase credentials expired or invalid
- **Action**: Rotate Firebase service account key. Update `.env` on VM.

### Parser fixture test fails in CI

- **Cause**: Parser has a regression
- **Action**: 
  1. Run locally: `npm run sanity:prices:fixture`
  2. Fix parser in `sanity-fixture.js`
  3. Commit and retry CI

## Manual Testing

On the Israeli VM:

```bash
cd /home/price-worker/family-shopping/scripts
npm run sanity:prices:live
```

Should complete in 30-90 seconds and report all chains passed.

## Deployment Guardrail

**Before marking a deployment as production-ready:**

1. ✅ GitHub Actions parser test passes
2. ✅ VM live sanity check passed within last 24 hours
3. ✅ Firebase `latestPriceSanityStatus.status` is "pass" (all chains)

If any check fails → hold off on prod promotion until resolved.

---

**Last updated**: 2026-05-21  
**Location**: Israeli VM (me-west1-b/Tel Aviv)  
**Cron schedule**: 03:00 & 15:00 UTC (06:00 & 18:00 Israel time)

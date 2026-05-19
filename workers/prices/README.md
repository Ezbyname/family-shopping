# Israeli Price Worker — VPS Deployment Guide

## Why a VPS?

Israeli supermarket websites block non-Israeli IP ranges (GitHub Actions, Vercel, AWS, Cloudflare).  
This worker **must** run on a server with an Israeli IP address.

## Recommended VPS Providers with Israeli IPs

| Provider | Plan | Price | Notes |
|---|---|---|---|
| **DigitalOcean** | Basic Droplet | ~$6/mo | No Israeli DC — use Frankfurt, works for some chains |
| **Hetzner** | CX11 | €3.79/mo | Germany — partial success |
| **Israeli VPS** (e.g. IsraelVPS, Servervault.co.il) | Entry | ~$8-15/mo | ✅ Israeli IP — best results |
| **Google Cloud** | e2-micro | Free tier | `me-west1` (Tel Aviv) ✅ |
| **AWS** | t3.micro | ~$8/mo | `il-central-1` (Tel Aviv) ✅ |

**Recommended:** Google Cloud `me-west1` (Tel Aviv) free tier or AWS `il-central-1`.

---


---

## Step 0: Verify Israeli Outbound IP (CRITICAL)

This **must** pass before running any price sync.  
Israeli supermarkets reject non-Israeli IPs silently or with HTTP 403.

### Check 1: IP Geolocation Tool

```bash
# Run the built-in IP check
npm run check:ip
```

Expected output when passing:
```
═══════════════════════════════════════
  🌍 Israeli IP Verification Check
═══════════════════════════════════════

Checking via ipapi.co... OK

  IP Address : 34.165.x.x
  Country    : IL ✅
  Region     : Tel Aviv District
  City       : Tel Aviv
  Org / ASN  : AS15169 Google LLC

  ✅ PASS — Server is geolocated in Israel.
  Price sync is allowed.
```

If you see `❌ FAIL`:
```
  ❌ FAIL — Server is NOT in Israel.
  Detected: DE (Frankfurt)

  ▶ Use one of these Israeli cloud regions:
    • Google Cloud: me-west1 (Tel Aviv)
    • AWS:          il-central-1 (Tel Aviv)
```

The worker will **refuse to run** until this passes.

---

### Check 2: Verify with curl

Test direct access to supermarket price feeds:

```bash
# Quick IP check
curl -s https://ipapi.co/json/ | python3 -m json.tool | grep -E '"country_code"|"ip"|"city"'

# Test Shufersal index
curl -v --max-time 15 \
  -H "Accept: application/json" \
  -H "Accept-Language: he-IL,he;q=0.9" \
  "https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=3&page=1"
# Expected: HTTP 200 with JSON array of files

# Test Rami Levy index
curl -v --max-time 15 \
  "https://url.retail.pe.il/MF/latest/7290058140886/"
# Expected: HTTP 200 with HTML listing of XML files

# Run npm test:curl shortcut
npm run test:curl
```

**HTTP 200 + content** → your IP is allowed ✅  
**HTTP 403 / empty response / HTML "Access Denied"** → IP is blocked ❌

---

### Check 3: Traceroute to Confirm Israeli Route

```bash
# Should show hops through Israeli networks (BEZEQ, Cellcom, HOT-NET)
traceroute prices.shufersal.co.il

# Or with mtr
mtr --report prices.shufersal.co.il
```

---

## Recommended Cloud Regions (Israeli IP)

| Provider | Region | Location | Notes |
|---|---|---|---|
| **Google Cloud** | `me-west1` | Tel Aviv, Israel | ✅ Free tier eligible (e2-micro) |
| **AWS** | `il-central-1` | Tel Aviv, Israel | ✅ ~$7/mo t3.micro |
| **Oracle Cloud** | `il-jerusalem-1` | Jerusalem, Israel | ✅ Free tier available |

### Google Cloud me-west1 Setup

```bash
# Install gcloud CLI
# https://cloud.google.com/sdk/docs/install

# Create VM in Tel Aviv
gcloud compute instances create price-worker \
  --zone=me-west1-b \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=10GB \
  --tags=price-worker

# SSH into it
gcloud compute ssh price-worker --zone=me-west1-b

# Verify IP is Israeli
curl -s https://ipapi.co/json/ | python3 -m json.tool | grep country_code
# Should output: "country_code": "IL"
```

### AWS il-central-1 Setup

```bash
# Using AWS CLI
aws ec2 run-instances \
  --region il-central-1 \
  --image-id ami-XXXXXXXX \
  --instance-type t3.micro \
  --key-name your-key-pair \
  --count 1

# Or use AWS Console → EC2 → Launch Instance → Region: Tel Aviv
```

---

## Production Checklist (Complete Before Enabling Cron)

```
VPS SETUP
[ ] VPS running in Israeli region (me-west1 or il-central-1)
[ ] npm run check:ip → PASS (country: IL)
[ ] npm run test:curl → HTTP 200 from Shufersal and Rami Levy
[ ] traceroute shows Israeli hops

CREDENTIALS
[ ] .env created from .env.example
[ ] FIREBASE_PROJECT_ID correct
[ ] FIREBASE_DATABASE_URL correct (includes europe-west1 or correct region)
[ ] FIREBASE_CLIENT_EMAIL correct (service account email)
[ ] FIREBASE_PRIVATE_KEY correct (with actual newlines, not \n)
[ ] npm run test:config → Config OK
[ ] npm run test:firebase → Firebase OK

MANUAL TEST RUN
[ ] LOG_LEVEL=debug node index.js shufersal 2>&1 | head -100
[ ] At least 1,000 items synced (Shufersal has ~800K)
[ ] Firebase Realtime DB shows data under prices/
[ ] syncSummary written to Firebase

CRON / PM2
[ ] ecosystem.config.cjs created
[ ] pm2 start ecosystem.config.cjs → OK
[ ] pm2 save → saved
[ ] pm2 startup → startup command run
[ ] Log files writable at /var/log/price-worker/
[ ] Test cron fires at expected time (watch pm2 logs)

MONITORING (optional but recommended)
[ ] SLACK_WEBHOOK_URL set for failure alerts
[ ] Log rotation configured (logrotate or PM2 log rotate)
[ ] Disk space check (XML files + logs)

FIREBASE RULES
[ ] prices/ and stores/ writable by service account
[ ] prices/ and stores/ readable by all (for Vercel API)
[ ] syncStatus/ writable by service account
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success (all or partial chains synced) |
| `1` | All chains failed |
| `2` | Config/env var error |
| `3` | **IP check failed — not an Israeli IP** |


## Step 1: Server Setup

```bash
# Connect to your VPS
ssh root@YOUR_VPS_IP

# Install Node.js 20 (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version   # should be v20.x.x
npm --version

# Install PM2 (process manager)
npm install -g pm2

# Create app directory
mkdir -p /opt/price-worker
cd /opt/price-worker
```

---

## Step 2: Deploy the Worker

```bash
# Clone or copy the worker files to /opt/price-worker/
# Files needed:
#   index.js, config.js, chains.js, fetchPrices.js,
#   parseXml.js, normalizeProduct.js, firebaseWriter.js,
#   logger.js, package.json

# Install dependencies
npm install

# Create .env from template
cp .env.example .env
nano .env   # Fill in your Firebase credentials
```

---

## Step 3: Firebase Service Account

1. Go to [Firebase Console](https://console.firebase.google.com)
2. ⚙️ Project Settings → **Service accounts**
3. Click **Generate new private key** → download JSON
4. Open the JSON file and copy values to `.env`:

```bash
FIREBASE_PROJECT_ID=     # "project_id" field
FIREBASE_CLIENT_EMAIL=   # "client_email" field
FIREBASE_PRIVATE_KEY=    # "private_key" field (full value with \n)
FIREBASE_DATABASE_URL=   # from Firebase Realtime Database settings
```

**Tip:** For `FIREBASE_PRIVATE_KEY`, wrap in single quotes in `.env`:
```
FIREBASE_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----\n'
```

---

## Step 4: Test Before Running

```bash
# Test 1: Config validation
npm run test:config
# Expected: "Config OK, project: your-project-id"

# Test 2: Firebase connectivity
npm run test:firebase
# Expected: "Firebase OK, syncSummary: ..."

# Test 3: Dry run (single chain)
node index.js shufersal 2>&1 | head -50
# Expected: logs showing download progress

# Test 4: Full run
node index.js 2>&1 | tee test-run.log
```

---

## Step 5: Set Up Cron with PM2

### ecosystem.config.cjs

```js
module.exports = {
  apps: [{
    name:        'price-worker',
    script:      '/opt/price-worker/index.js',
    interpreter: 'node',
    cron_restart: '0 4,12 * * *',   // 04:00 and 12:00 Israel time (UTC+3)
    autorestart:  false,             // Don't restart after each cron run
    watch:        false,
    env_file:     '/opt/price-worker/.env',
    log_file:     '/var/log/price-worker/combined.log',
    error_file:   '/var/log/price-worker/error.log',
    out_file:     '/var/log/price-worker/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
```

```bash
# Create log directory
sudo mkdir -p /var/log/price-worker
sudo chown $USER /var/log/price-worker

# Start with PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to auto-start on boot
```

### Alternative: system cron (simpler)

```bash
# Edit crontab
crontab -e

# Add these lines (runs at 07:00 and 15:00 Israel time = 04:00 and 12:00 UTC):
0 4  * * * cd /opt/price-worker && /usr/bin/node index.js >> /var/log/price-worker/sync.log 2>&1
0 12 * * * cd /opt/price-worker && /usr/bin/node index.js >> /var/log/price-worker/sync.log 2>&1
```

---

## Step 6: Viewing Logs

```bash
# PM2 real-time logs
pm2 logs price-worker

# PM2 log file
tail -f /var/log/price-worker/out.log

# Parse JSON logs with jq
tail -f /var/log/price-worker/out.log | jq .

# Filter errors only
cat /var/log/price-worker/combined.log | jq 'select(.level == "error")'

# Filter by chain
cat /var/log/price-worker/out.log | jq 'select(.msg | contains("שופרסל"))'

# Count items synced in last run
grep '"✅"' /var/log/price-worker/out.log | tail -10
```

---

## Step 7: Manual Runs

```bash
# Sync all chains
cd /opt/price-worker && node index.js

# Sync single chain
node index.js shufersal
node index.js rami-levy
node index.js victory

# With verbose logging
LOG_LEVEL=debug node index.js shufersal 2>&1 | jq .
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `FIREBASE_PROJECT_ID` | ✅ | Firebase project ID |
| `FIREBASE_DATABASE_URL` | ✅ | Realtime DB URL |
| `FIREBASE_CLIENT_EMAIL` | ✅ | Service account email |
| `FIREBASE_PRIVATE_KEY` | ✅ | Service account private key |
| `ENABLED_CHAINS` | — | Comma-separated chain IDs (empty = all) |
| `SYNC_CONCURRENCY` | — | Parallel chains (default: 1) |
| `BATCH_SIZE` | — | Firebase batch size (default: 400) |
| `DOWNLOAD_TIMEOUT_MS` | — | Per-file timeout (default: 120000) |
| `DOWNLOAD_RETRIES` | — | Retry attempts (default: 3) |
| `LOG_LEVEL` | — | debug/info/warn/error (default: info) |
| `SLACK_WEBHOOK_URL` | — | Slack alert on critical failure |

---

## Firebase Data Written

```
prices/{barcode}/{chainId_storeId} = {
  barcode, name, price, chainId, chainName,
  storeId, storeName, unit, quantity, brand,
  updatedAt, currency: "ILS", source: "official",
  syncedAt, lastUpdated
}

stores/{chainId_storeId} = {
  chainId, chainName, storeId, storeName,
  address, city, zipCode, latitude, longitude,
  hasCoords, updatedAt
}

syncStatus/{chainId} = {
  lastSyncDate, lastSuccessAt, lastPriceUrl,
  itemsProcessed, storesProcessed, errors
}

syncSummary = {
  lastSync, lastSyncDate, totalProducts,
  chainsSucceeded, chainsFailed, elapsedMinutes
}
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `HTTP 403` | IP blocked | Switch to Israeli VPS/region |
| `File too small (< 100 bytes)` | HTML block page returned | Same — IP issue |
| `getaddrinfo ENOTFOUND` | DNS / firewall | Check VPS network |
| `Firebase init failed` | Wrong credentials | Re-check `.env` private key |
| `Batch write failed` | Firebase rules | Allow write for service account |
| `No PriceFull URL found` | Chain changed format | Update `chains.js` indexUrl |

---

## Adding a New Chain

1. Open `chains.js`
2. Add a new object to `CHAINS`:
```js
{
  id:       'new-chain',
  name:     'שם הרשת',
  chainId:  '7290000000000',  // official GS1 company ID
  enabled:  true,
  indexUrl: 'https://prices.new-chain.co.il/',
  baseUrl:  'https://prices.new-chain.co.il',
  indexType: 'html',  // or 'json'
}
```
3. Restart the worker: `pm2 restart price-worker`
4. Test: `node index.js new-chain`

---

## Production Checklist

- [ ] VPS has Israeli IP (verify: `curl ifconfig.me`)
- [ ] Node.js 20+ installed
- [ ] `.env` file created and filled
- [ ] Firebase service account has Realtime DB write access
- [ ] `npm run test:config` passes
- [ ] `npm run test:firebase` passes
- [ ] Manual run succeeds: `node index.js shufersal`
- [ ] Cron job configured (PM2 or system cron)
- [ ] Logs directory writable
- [ ] PM2 startup configured (`pm2 startup && pm2 save`)
- [ ] Slack alert configured (optional but recommended)
- [ ] Firebase rules updated to allow service account writes to `prices/` and `stores/`

---

## Estimated Run Times

| Chains | Items | Time |
|---|---|---|
| 1 chain (Shufersal) | ~800K | 8-15 min |
| 3 chains | ~2.5M | 25-40 min |
| All 6 chains | ~5M | 60-90 min |

Run twice daily is sufficient — supermarkets update prices once per day.

---

## Emergency Disable

### Stop PM2 immediately

```bash
pm2 stop price-worker      # Stop (keeps in PM2 list)
pm2 delete price-worker    # Remove from PM2 completely

# Verify stopped
pm2 list
```

### Disable cron job

```bash
crontab -e
# Comment out or delete the price-worker lines:
# 0 4  * * * cd /opt/price-worker && node index.js ...
# 0 12 * * * cd /opt/price-worker && node index.js ...
```

### Prevent Firebase writes without stopping the server

Set Firebase Realtime Database rules to read-only temporarily:

```json
{
  "rules": {
    "prices":     { ".read": true, ".write": false },
    "stores":     { ".read": true, ".write": false },
    "syncStatus": { ".read": true, ".write": false }
  }
}
```

Go to: Firebase Console → Realtime Database → Rules → Publish

The worker will fail at the write step — cached prices remain intact.

### Roll back to cached prices only

The API (`api/prices.js`) already serves Firebase cached prices when the worker is stopped.  
The `isStale: true` flag will appear in API responses after 36 hours without a sync.  
The frontend shows a "Prices may be outdated" warning automatically.

No code change is needed — just stop the worker.

### Re-enable after emergency

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

---

## Exit Codes

| Code | Meaning | Action |
|---|---|---|
| `0` | Success | Normal |
| `1` | All chains failed | Check logs, retry |
| `2` | Config/env error | Fix `.env` |
| `3` | IP not Israeli | Move to me-west1 or il-central-1 |
| `4` | Firebase write error | Check credentials and rules |
| `5` | All sources unreachable | VPS network issue or all IPs blocked |

---

## Dry Run Mode

Test fetch + parse without writing to Firebase:

```bash
# All chains dry run
DRY_RUN=true node index.js

# Single chain dry run
DRY_RUN=true node index.js shufersal

# Via npm
npm run sync:dry-run
```

Output shows what *would* be written. Firebase is not touched.

---

## Commands Reference

### Local development (non-Israeli IP)

```bash
# Install
npm install

# Validate config only
npm run test:config

# Bypass IP check for local testing (dev only)
BYPASS_IP_CHECK=true NODE_ENV=development DRY_RUN=true node index.js shufersal
```

### On the VPS (Israeli IP)

```bash
# 1. Verify Israeli IP
npm run check:ip

# 2. Verify supermarket access
npm run test:curl

# 3. Verify Firebase
npm run test:firebase

# 4. Dry run
npm run sync:dry-run

# 5. Full sync
npm run sync

# 6. Check logs
pm2 logs price-worker --lines 50
```

---

## Final Production Checklist

```
VPS & NETWORK
[ ] Server in Israeli region (me-west1, il-central-1, or il-jerusalem-1)
[ ] npm run check:ip → PASS  (Country: IL)
[ ] curl to Shufersal returns HTTP 200 (not 403/empty)
[ ] curl to Rami Levy returns HTTP 200
[ ] npm run test:curl → all HTTP 200

CREDENTIALS
[ ] .env created from .env.example
[ ] All 4 FIREBASE_* vars set correctly
[ ] npm run test:config → Config OK
[ ] npm run test:firebase → Firebase OK + syncSummary accessible

DRY RUN
[ ] DRY_RUN=true node index.js shufersal → items parsed, 0 Firebase writes
[ ] DRY_RUN=true node index.js → all chains dry run completes

REAL SYNC
[ ] node index.js shufersal → items > 0 written to Firebase
[ ] Firebase Realtime DB → prices/ populated
[ ] Firebase Realtime DB → syncSummary.lastSyncDate = today

CRON / PM2
[ ] ecosystem.config.cjs created
[ ] pm2 start ecosystem.config.cjs
[ ] pm2 save
[ ] pm2 startup → startup command executed
[ ] Log files written to /var/log/price-worker/

FRONTEND
[ ] /api/prices?barcode=... returns source: "firebase_cache"
[ ] Fresh sync: isStale: false
[ ] Old data (>36h): isStale: true + warning shown in UI
[ ] Frontend doesn't crash when isStale: true

ALERTS (optional)
[ ] SLACK_WEBHOOK_URL set
[ ] Test alert: node -e "import('./firebaseWriter.js').then(m => m.sendAlert(process.env.SLACK_WEBHOOK_URL, 'test alert'))"

EMERGENCY
[ ] Know how to: pm2 stop price-worker
[ ] Know how to: disable Firebase writes via rules
[ ] Confirmed: frontend serves stale cache when worker stopped
```

---

## Recommended Deployment Path (Google Cloud me-west1)

```bash
# 1. Create Tel Aviv VM (free tier)
gcloud compute instances create price-worker \
  --zone=me-west1-b \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=10GB

# 2. SSH in
gcloud compute ssh price-worker --zone=me-west1-b

# 3. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 4. Deploy worker
git clone https://github.com/Ezbyname/family-shopping.git /opt/family-shopping
cd /opt/family-shopping/workers/prices
npm install

# 5. Configure
cp .env.example .env
nano .env   # Fill in Firebase credentials

# 6. Verify
npm run check:ip         # Must show IL
npm run test:firebase    # Must show Firebase OK
npm run sync:dry-run     # Dry run all chains

# 7. First real sync
node index.js

# 8. Set up PM2
npm install -g pm2
cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'price-worker',
    script: '/opt/family-shopping/workers/prices/index.js',
    cron_restart: '0 4,12 * * *',
    autorestart: false,
    watch: false,
    env_file: '/opt/family-shopping/workers/prices/.env',
    error_file: '/var/log/price-worker/error.log',
    out_file: '/var/log/price-worker/out.log',
  }]
};
EOF

sudo mkdir -p /var/log/price-worker
sudo chown $USER /var/log/price-worker
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # Run the printed command
```

Done. The worker now runs automatically at 07:00 and 15:00 Israel time (04:00 and 12:00 UTC).

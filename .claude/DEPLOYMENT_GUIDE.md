# Google Cloud Deployment Guide (me-west1, Tel Aviv)

## Phase 1: Google Cloud Setup (5 mins)

### Step 1a: Create Google Cloud Account & Project
1. Go to https://console.cloud.google.com
2. Click **Create Project**
3. Name: `family-shopping-prices` (or similar)
4. Click **Create** (takes ~30 seconds)
5. Wait for project to be active, then select it from the dropdown

### Step 1b: Install & Configure gcloud CLI

**Windows:**
```powershell
# Download installer from:
# https://cloud.google.com/sdk/docs/install#windows

# OR use chocolatey:
choco install google-cloud-sdk

# Initialize gcloud
gcloud init
```

When prompted:
- Choose to log in (opens browser)
- Select your project created above
- Set default region to `me-west1` (Tel Aviv)

**Verify:**
```bash
gcloud config list
gcloud auth list
```

---

## Phase 2: Create VM in Tel Aviv (5 mins)

Run this command to create a small VM:

```bash
gcloud compute instances create price-worker \
  --zone=me-west1-b \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --tags=price-worker \
  --metadata=startup-script='#!/bin/bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
'
```

**What this does:**
- Creates `price-worker` VM in Tel Aviv zone (me-west1-b)
- Uses free tier eligible `e2-micro` (0.25-2 vCPU, 1GB RAM)
- Installs Node.js 20 automatically on startup
- Takes ~2 mins to be ready

**Verify it's running:**
```bash
gcloud compute instances list
# Should show: price-worker | me-west1-b | RUNNING
```

---

## Phase 3: SSH into VM & Deploy Worker (10 mins)

### Connect to VM
```bash
gcloud compute ssh price-worker --zone=me-west1-b
```

This opens a bash shell on the VM. You're now in `/home/YOUR_EMAIL/`

### Verify Israeli IP
```bash
curl -s https://ipapi.co/json/ | grep -E '"country_code"|"ip"'
# Should show: "country_code": "IL" ✓
```

### Clone & Setup Worker
```bash
# Download the project
git clone https://github.com/Ezbyname/family-shopping.git
cd family-shopping/workers/prices

# Install dependencies
npm install

# Create .env from template
cp .env.example .env

# Edit .env with your Firebase credentials
nano .env
```

In the `nano` editor:
- Paste your Firebase credentials (see **Phase 4** below)
- Press `Ctrl+X`, then `Y`, then `Enter` to save

### Test Setup
```bash
# Verify config
npm run test:config
# Expected: "Config OK, project: your-project-id"

# Verify Israeli IP
npm run check:ip
# Expected: "PASS — Server is geolocated in Israel"

# Test Firebase connection
npm run test:firebase
# Expected: "Firebase OK, syncSummary: ..."
```

---

## Phase 4: Firebase Credentials

You need to get credentials from your Firebase project:

1. Go to https://console.firebase.google.com
2. Select your project (created earlier)
3. Click ⚙️ (Settings) → **Service Accounts**
4. Click **Generate New Private Key** → Download JSON file
5. Open the JSON file and copy these values into your `.env`:

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEp....\n-----END RSA PRIVATE KEY-----\n
FIREBASE_DATABASE_URL=https://your-project.firebaseio.com
```

**⚠️ IMPORTANT:** For `FIREBASE_PRIVATE_KEY`:
- Copy the entire key including `-----BEGIN` and `-----END` lines
- Keep the literal `\n` characters (don't convert to actual newlines)
- In `nano`, paste it as a single line

---

## Phase 5: Test Price Sync (5-10 mins)

Back on the VM:

### Dry Run (no Firebase writes)
```bash
npm run sync:dry-run
# Should show: fetching index, parsing prices, extracting URLs
# May take 30-60 seconds
```

**Expected output:**
- ✅ Shufersal: "URLs resolved" with actual file count
- ✅ Other chains: similar progress
- ✅ No Firebase writes (dry-run mode)

### Full Sync (writes to Firebase)
```bash
node index.js shufersal
# Full sync of Shufersal chain
# Expected: 30-60 seconds, ~800K products
```

**Check Firebase:**
1. Go to https://console.firebase.google.com
2. Select your project → **Realtime Database**
3. Navigate to `prices/` → should see entries like `7290000123456/`
4. Navigate to `syncSummary` → should show `lastSyncDate: today`

---

## Phase 6: Automate with PM2 (Optional but Recommended)

### Install PM2 on VM
```bash
npm install -g pm2
```

### Create PM2 Config
```bash
cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'price-worker',
    script: '/home/YOUR_EMAIL/family-shopping/workers/prices/index.js',
    interpreter: 'node',
    cron_restart: '0 4,12 * * *',  // 04:00 & 12:00 UTC = 07:00 & 15:00 Israel time
    autorestart: false,
    watch: false,
    env_file: '/home/YOUR_EMAIL/family-shopping/workers/prices/.env',
    log_file: '/var/log/price-worker/combined.log',
    error_file: '/var/log/price-worker/error.log',
    out_file: '/var/log/price-worker/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
EOF
```

Replace `YOUR_EMAIL` with your actual email (check with `echo $HOME`)

### Start PM2
```bash
# Create log directory
mkdir -p /var/log/price-worker

# Start with PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Follow printed command to enable auto-start on reboot

# Verify
pm2 list
pm2 logs price-worker --lines 20
```

---

## Phase 7: Monitor & Troubleshoot

### View Logs
```bash
# Real-time
tail -f /var/log/price-worker/out.log

# JSON format
cat /var/log/price-worker/out.log | jq .

# Errors only
cat /var/log/price-worker/error.log | grep error
```

### Manual Sync Anytime
```bash
node index.js shufersal    # Single chain
node index.js              # All chains
```

### Check IP Anytime
```bash
npm run check:ip
curl ifconfig.me           # Your IP address
```

---

## Costs & Free Tier

✅ **Always Free:**
- Compute Engine: 1 e2-micro VM (745 hours/month = always on)
- Cloud Storage: 5GB/month
- Cloud Firestore/Realtime DB: Pay per read/write (small usage = free)

⚠️ **Watch:**
- Data transfer out (egress) — keep worker close to DB (same region)
- If you scale beyond free tier, expect ~$5-15/month

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `HTTP 403` from supermarkets | IP isn't Israeli; recheck `npm run check:ip` |
| `Firebase init failed` | Check `.env` vars are correct; test with `npm run test:firebase` |
| `No PriceFull URL found` | Shufersal API format changed; update parser (already fixed in our code) |
| `Timeout connecting to VM` | Check firewall rules or SSH key permissions |
| PM2 cron not firing | Check timezone; cron runs in UTC (our times are UTC+3) |

---

## Next Steps After Deployment

1. ✅ Verify prices syncing to Firebase
2. ✅ Check APIs return correct prices (test `GET /api/prices?barcode=...`)
3. ✅ Frontend should display live prices instead of cached
4. ✅ Set up Slack alerts (optional): add `SLACK_WEBHOOK_URL` to `.env`
5. ✅ Monitor logs for any chain failures

---

## Quick Command Reference

```bash
# On VM
ssh gcloud compute ssh price-worker --zone=me-west1-b

# Check IP
npm run check:ip

# Test connectivity
npm run test:curl

# Dry run
npm run sync:dry-run

# Full sync
node index.js

# Single chain
node index.js shufersal

# Logs
tail -f /var/log/price-worker/out.log

# PM2
pm2 list
pm2 logs price-worker
pm2 stop price-worker
pm2 restart price-worker
```

---

## Cost Estimate
- **Free Tier:** $0/month (e2-micro always-free)
- **If over quota:** ~$5-15/month (still very cheap)

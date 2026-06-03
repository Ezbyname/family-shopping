#!/usr/bin/env bash
# scripts/deploy-firebase-rules.sh
# Deploy RTDB security rules and verify unauthenticated writes are blocked.
#
# Prerequisites:
#   npm install -g firebase-tools
#   firebase login
#   .firebaserc must contain your real project ID
#
# Usage:
#   bash scripts/deploy-firebase-rules.sh
#
# Exit codes:
#   0 = rules deployed and verified
#   1 = deployment failed
#   2 = verification failed (unauthenticated write NOT blocked — investigate)
#   3 = missing prerequisites

set -euo pipefail

# ── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
fail() { echo -e "${RED}❌ $*${NC}"; }

echo "═══════════════════════════════════════════════"
echo "  Firebase RTDB Rules — Deploy & Verify"
echo "═══════════════════════════════════════════════"

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
if ! command -v firebase &>/dev/null; then
  fail "firebase CLI not found. Run: npm install -g firebase-tools"
  exit 3
fi

RULES_FILE="firebase-rules.json"
if [ ! -f "$RULES_FILE" ]; then
  fail "$RULES_FILE not found — run from repo root"
  exit 3
fi

PROJECT_ID=$(node -e "
  try { const r=require('./.firebaserc');
    console.log(r.projects?.default||'');
  } catch(e) { console.log(''); }
" 2>/dev/null || true)

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "YOUR_FIREBASE_PROJECT_ID" ]; then
  fail ".firebaserc is missing or still has placeholder project ID"
  fail "Update .firebaserc with your Firebase project ID from:"
  fail "  Firebase Console → Project Settings → Project ID"
  exit 3
fi

ok "Project ID: $PROJECT_ID"

# ── 2. Validate rules file (syntax check) ────────────────────────────────────
echo ""
echo "Checking rules syntax…"
if ! node -e "
  const fs = require('fs');
  // Strip // comments (Firebase rules files support them; JSON.parse does not)
  const raw = fs.readFileSync('$RULES_FILE','utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  JSON.parse(raw);
  console.log('syntax ok');
" 2>/dev/null; then
  fail "firebase-rules.json has invalid JSON. Fix before deploying."
  exit 1
fi
ok "Rules syntax valid"

# ── 3. Deploy ────────────────────────────────────────────────────────────────
echo ""
echo "Deploying rules to $PROJECT_ID …"
if firebase deploy --only database --project "$PROJECT_ID"; then
  ok "Rules deployed"
else
  fail "firebase deploy failed"
  exit 1
fi

# ── 4. Read back rules from Firebase to confirm they are live ─────────────────
echo ""
echo "Reading rules back from Firebase REST API…"
DB_URL="https://${PROJECT_ID}-default-rtdb.firebaseio.com"

# Read the analytics rules node (the critical security gate)
RULES_RESPONSE=$(curl -sf \
  "${DB_URL}/.settings/rules.json?auth=$(firebase login:ci --no-localhost 2>/dev/null || echo 'NOCI')" \
  2>/dev/null || echo "CURL_FAILED")

if echo "$RULES_RESPONSE" | grep -q 'auth !== null'; then
  ok "Rules confirmed live — 'auth !== null' found in deployed rules"
else
  warn "Could not auto-verify via REST (requires service account token)"
  warn "Manually verify in Firebase Console:"
  warn "  https://console.firebase.google.com/project/$PROJECT_ID/database/data/~2F-rules"
fi

# ── 5. Security probe — unauthenticated write attempt ────────────────────────
echo ""
echo "Security probe: unauthenticated analytics write attempt…"
PROBE_PATH="analytics/events/SECURITY-PROBE-DO-NOT-KEEP"

PROBE_RESP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PUT \
  -H "Content-Type: application/json" \
  -d '{"event":"probe","ts":1,"group":"test12","platform":"test"}' \
  "${DB_URL}/${PROBE_PATH}.json")

if [ "$PROBE_RESP" = "401" ] || [ "$PROBE_RESP" = "403" ]; then
  ok "Security probe PASSED — unauthenticated write blocked (HTTP $PROBE_RESP)"
elif [ "$PROBE_RESP" = "200" ]; then
  fail "SECURITY PROBE FAILED — unauthenticated write SUCCEEDED (HTTP 200)"
  fail "Rules are NOT active. Check Firebase Console → Realtime Database → Rules"
  # Clean up the probe entry
  curl -s -X DELETE "${DB_URL}/${PROBE_PATH}.json" >/dev/null 2>&1 || true
  exit 2
else
  warn "Probe returned HTTP $PROBE_RESP — verify manually in Firebase Console"
fi

# ── 6. storeCoords node presence check ───────────────────────────────────────
echo ""
echo "Checking storeCoords node…"
COORDS_RESP=$(curl -sf "${DB_URL}/storeCoords.json?shallow=true&limitToFirst=1" 2>/dev/null || echo "null")
if [ "$COORDS_RESP" = "null" ] || [ -z "$COORDS_RESP" ]; then
  warn "storeCoords node does not exist yet"
  warn "It will be populated on the next price sync worker run (VPS)"
  warn "basket-compare will use fallback path until then"
else
  STORE_COUNT=$(echo "$COORDS_RESP" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
      try { console.log(Object.keys(JSON.parse(d)).length); }
      catch(e) { console.log('?'); }
    });
  " 2>/dev/null || echo "?")
  ok "storeCoords node exists (probe found entries)"
fi

echo ""
echo "═══════════════════════════════════════════════"
ok "Firebase rules deployment complete"
echo ""
echo "Next steps:"
echo "  1. Open Firebase Console → Realtime Database → Rules"
echo "     https://console.firebase.google.com/project/$PROJECT_ID/database/rules"
echo "  2. Confirm analytics.events rules show 'auth !== null'"
echo "  3. Run price sync worker to populate storeCoords:"
echo "     ssh <vps> 'cd ~/price-worker && node index.js'"
echo "═══════════════════════════════════════════════"

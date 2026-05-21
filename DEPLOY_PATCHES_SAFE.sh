#!/bin/bash
set -euo pipefail

rollback() {
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "❌ DEPLOYMENT FAILED - INITIATING ROLLBACK"
  echo "════════════════════════════════════════════════════════════"
  echo ""
  echo "🔄 Restoring chains.js..."
  CHAINS_BACKUP=$(ls -t ~/family-shopping/workers/prices/chains.js.bak.* 2>/dev/null | head -1 || true)
  if [ -n "$CHAINS_BACKUP" ]; then
    cp "$CHAINS_BACKUP" ~/family-shopping/workers/prices/chains.js
    echo "✅ Restored chains.js from backup"
  else
    echo "⚠️  WARNING: No chains.js backup found"
  fi
  echo "🔄 Restoring sanity-live.js..."
  SANITY_BACKUP=$(ls -t ~/family-shopping/scripts/sanity-live.js.bak.* 2>/dev/null | head -1 || true)
  if [ -n "$SANITY_BACKUP" ]; then
    cp "$SANITY_BACKUP" ~/family-shopping/scripts/sanity-live.js
    echo "✅ Restored sanity-live.js from backup"
  else
    echo "⚠️  WARNING: No sanity-live.js backup found"
  fi
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "ROLLBACK COMPLETED"
  echo "════════════════════════════════════════════════════════════"
  exit 1
}

trap rollback ERR

echo "🚀 DEPLOYING CHAINS.JS AND SANITY-LIVE.JS PATCHES"
echo ""
echo "📦 STEP 1: Creating backups..."
cd ~/family-shopping
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
cp workers/prices/chains.js workers/prices/chains.js.bak.${TIMESTAMP}
cp scripts/sanity-live.js scripts/sanity-live.js.bak.${TIMESTAMP}
echo "✅ Backups created"
echo ""

echo "📝 STEP 2: Updating chains.js..."
cat > ~/family-shopping/workers/prices/chains.js << 'CHAINS_CONTENT'
export const CHAINS = [
  {
    id:       'shufersal',
    name:     'שופרסל',
    chainId:  '7290027600007',
    enabled:  true,
    sanityRequired: true,
    knownIssue: null,
    indexUrl: 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=10&page=1',
    baseUrl:  'https://prices.shufersal.co.il',
    indexType: 'html',
  },
  {
    id:       'rami-levy',
    name:     'רמי לוי',
    chainId:  '7290058140886',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'DNS ENOTFOUND from Israeli VM (url.retail.pe.il) - endpoint needs verification',
    indexUrl: 'https://url.retail.pe.il/MF/latest/7290058140886/',
    baseUrl:  'https://url.retail.pe.il',
    indexType: 'html',
  },
  {
    id:       'victory',
    name:     'ויקטורי',
    chainId:  '7290696200003',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'Timeout during index fetch (matrixcatalog.co.il) - endpoint needs verification',
    indexUrl: 'https://matrixcatalog.co.il/NBcompetitionRegulations.aspx',
    baseUrl:  'https://matrixcatalog.co.il',
    indexType: 'html',
  },
  {
    id:       'yeinot-bitan',
    name:     'יינות ביתן',
    chainId:  '7290873255550',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'DNS ENOTFOUND - redirects to prices.ybitan.co.il which is not accessible from Israeli VM',
    indexUrl: 'https://publishprice.ybitan.co.il/',
    baseUrl:  'https://publishprice.ybitan.co.il',
    indexType: 'html',
  },
  {
    id:       'osher-ad',
    name:     'אושר עד',
    chainId:  '7290058179504',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'HTTP 403 Forbidden - endpoint requires authentication or is blocking requests',
    indexUrl: 'https://osherad.co.il/prices/',
    baseUrl:  'https://osherad.co.il',
    indexType: 'html',
  },
  {
    id:       'mahsanei-lahav',
    name:     'מחסני להב',
    chainId:  '7290055755557',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'DNS ENOTFOUND for www.mega-market.co.il - endpoint needs verification',
    indexUrl: 'https://www.mega-market.co.il/prices/',
    baseUrl:  'https://www.mega-market.co.il',
    indexType: 'html',
  },
];
CHAINS_CONTENT
echo "✅ chains.js written"
echo ""

echo "✔️  STEP 3: Validating chains.js syntax..."
if ! node --check ~/family-shopping/workers/prices/chains.js; then
  echo "❌ Syntax validation failed"
  exit 1
fi
echo "✅ Syntax valid"
echo ""

echo "📋 STEP 4: Verifying chain imports..."
cd ~/family-shopping/scripts
node << 'IMPORT_TEST'
import('../workers/prices/chains.js').then(m => {
  const table = m.CHAINS.map(c => ({
    id: c.id,
    enabled: c.enabled ? 'YES' : 'NO',
    sanityRequired: c.sanityRequired ? 'YES' : 'NO'
  }));
  console.table(table);
  const enabledCount = m.CHAINS.filter(c => c.enabled).length;
  console.log('Enabled: ' + enabledCount);
  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
IMPORT_TEST
if [ $? -ne 0 ]; then
  echo "❌ Import verification failed"
  exit 1
fi
echo "✅ Imports verified"
echo ""

echo "🔍 STEP 5: Checking sanity-live.js filtering logic..."
if grep -q "filter(c => c.enabled)" ~/family-shopping/scripts/sanity-live.js; then
  echo "✅ sanity-live.js filters by enabled status"
else
  echo "❌ CRITICAL: sanity-live.js missing filter(c => c.enabled)"
  exit 1
fi
echo ""

echo "🛡️  SAFETY CHECK 5C: Verifying semantic chain filtering variables..."
REQUIRED_VARS=("enabledChains" "disabledChains" "requiredChains" "productionCoverage" "baseline_pass")
MISSING_VARS=()

for VAR in "${REQUIRED_VARS[@]}"; do
  if ! grep -q "$VAR" ~/family-shopping/scripts/sanity-live.js; then
    MISSING_VARS+=("$VAR")
  fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  echo "❌ CRITICAL: sanity-live.js missing required semantic variables"
  echo "   Missing: ${MISSING_VARS[*]}"
  echo "   Required: enabledChains, disabledChains, requiredChains, productionCoverage, baseline_pass"
  exit 1
fi

echo "✅ sanity-live.js has all required semantic variables:"
grep -n "const enabledChains\|const disabledChains\|const requiredChains" ~/family-shopping/scripts/sanity-live.js | head -3
grep -n "productionCoverage\|baseline_pass" ~/family-shopping/scripts/sanity-live.js | head -2
echo ""

echo "🛡️  SAFETY CHECK 5A: Verifying exactly one enabled required chain..."
node << 'CHECK_5A'
import('../workers/prices/chains.js').then(m => {
  const required = m.CHAINS.filter(c => c.enabled && c.sanityRequired);
  if (required.length !== 1 || required[0].id !== 'shufersal') {
    console.error('ERROR: Expected 1 required chain (shufersal), got ' + required.length);
    process.exit(1);
  }
  console.log('✅ Baseline configuration valid: shufersal only');
  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
CHECK_5A
if [ $? -ne 0 ]; then exit 1; fi
echo ""

echo "🛡️  SAFETY CHECK 5B: Verifying no duplicate chain IDs..."
node << 'CHECK_5B'
import('../workers/prices/chains.js').then(m => {
  const ids = m.CHAINS.map(c => c.id);
  const dupes = ids.filter((x,i)=>ids.indexOf(x)!==i);
  if (dupes.length) {
    console.error('ERROR: Duplicate ids: ' + dupes.join(', '));
    process.exit(1);
  }
  console.log('✅ All ' + ids.length + ' chain IDs unique');
  process.exit(0);
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
CHECK_5B
if [ $? -ne 0 ]; then exit 1; fi
echo ""

echo "✅ ALL SAFETY CHECKS PASSED"
echo ""
echo "🧪 STEP 6: Running sanity check..."
cd ~/family-shopping/scripts
npm run sanity:prices:live || exit 1

echo ""
echo "════════════════════════════════════════════════════════════"
echo "✅ DEPLOYMENT COMPLETE - NO ROLLBACK NEEDED"
echo "════════════════════════════════════════════════════════════"

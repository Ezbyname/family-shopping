#!/usr/bin/env node
// verify.js — End-to-end verification of price sync + Firebase API mock
// Usage:
//   node verify.js                     — show syncSummary + 3 sample barcodes
//   node verify.js 72917367            — show all stores for a specific barcode
//   node verify.js --json 72917367     — output raw JSON (mirrors /api/prices response)

import 'dotenv/config.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const args = process.argv.slice(2);
const jsonMode  = args.includes('--json');
const barcodeArg = args.filter(a => !a.startsWith('-'))[0] || null;

const config = {
  projectId:   process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};

if (!config.projectId || !config.clientEmail || !config.privateKey || !config.databaseURL) {
  console.error('❌ Missing Firebase env vars. Copy .env.example → .env and fill in credentials.');
  process.exit(2);
}

const STALE_MS = 36 * 3600 * 1000;

function isStale(syncedAt) {
  if (!syncedAt) return true;
  return (Date.now() - Number(syncedAt)) > STALE_MS;
}

function sep(title) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(title);
  console.log('═'.repeat(50));
}

try {
  initializeApp({ credential: cert(config), databaseURL: config.databaseURL });
  const db = getDatabase();

  if (barcodeArg) {
    // ── SINGLE BARCODE LOOKUP (mirrors /api/prices?barcode=XXXX) ──────────────
    const clean = barcodeArg.replace(/\D/g, '');
    if (clean.length < 4 || clean.length > 20) {
      console.error(`❌ Invalid barcode: "${barcodeArg}" (must be 4-20 digits)`);
      process.exit(2);
    }

    const [priceSnap, storeSnap] = await Promise.all([
      db.ref(`prices/${clean}`).get(),
      db.ref('stores').get(),
    ]);

    const priceData  = priceSnap.exists()  ? priceSnap.val()  : {};
    const storeData  = storeSnap.exists()  ? storeSnap.val()  : {};

    // Build store lookup (strip leading zeros, city-bearing record wins)
    const storeLookup = {};
    for (const [k, v] of Object.entries(storeData)) {
      const stripped = k.replace(/_0+(\d)/, '_$1');
      const existing = storeLookup[stripped];
      if (!existing || (!existing.city && v.city)) storeLookup[stripped] = v;
    }

    const results = [];
    for (const [storeKey, p] of Object.entries(priceData)) {
      if (!p?.price || p.price <= 0) continue;
      const stripped = storeKey.replace(/_0+(\d)/, '_$1');
      const store    = storeLookup[stripped] || storeData[storeKey] || {};
      results.push({
        storeKey,
        chainId:   p.chainId   || store.chainId   || '',
        chainName: p.chainName || store.chainName || '',
        storeId:   p.storeId   || store.storeId   || '',
        storeName: p.storeName || store.storeName || '',
        city:      store.city  || '',
        address:   store.address || '',
        barcode:   clean,
        name:      p.name      || '',
        price:     p.price,
        currency:  'ILS',
        source:    p.source    || 'official',
        syncedAt:  p.syncedAt  ? new Date(p.syncedAt).toISOString() : null,
        isStale:   isStale(p.syncedAt),
      });
    }
    results.sort((a, b) => a.price - b.price);

    const latestSync  = Math.max(...results.map(r => r.syncedAt ? new Date(r.syncedAt).getTime() : 0));
    const anyStale    = results.some(r => r.isStale);
    const apiResponse = {
      version:     '6.0.0',
      barcode:     clean,
      count:       results.length,
      source:      results.length > 0 ? 'firebase_cache' : 'none',
      isStale:     anyStale,
      lastUpdated: latestSync > 0 ? new Date(latestSync).toISOString() : null,
      prices:      results,
    };

    if (jsonMode) {
      console.log(JSON.stringify(apiResponse, null, 2));
    } else {
      sep(`🔍 /api/prices?barcode=${clean}`);
      console.log(`Product name : ${results[0]?.name || '(unknown)'}`);
      console.log(`Store count  : ${results.length}`);
      console.log(`Cheapest     : ₪${results[0]?.price ?? 'N/A'} @ ${results[0]?.storeName || results[0]?.chainName || 'N/A'} (${results[0]?.city || ''})`);
      console.log(`Is stale     : ${anyStale}`);
      console.log(`Last updated : ${apiResponse.lastUpdated || 'N/A'}`);
      console.log(`\n── Prices by store (cheapest first) ──`);
      for (const r of results.slice(0, 20)) {
        const city = r.city ? ` (${r.city})` : '';
        console.log(`  ₪${String(r.price.toFixed(2)).padStart(7)}  ${r.chainName} — ${r.storeName}${city}`);
      }
      if (results.length > 20) console.log(`  … and ${results.length - 20} more`);
      console.log(`\n── Raw JSON (first entry) ──`);
      console.log(JSON.stringify(results[0] || {}, null, 2));
    }

    process.exit(results.length > 0 ? 0 : 1);
  }

  // ── FULL VERIFICATION (default when no barcode given) ─────────────────────

  sep('📊 SYNC METRICS');
  const summarySnap = await db.ref('syncSummary').get();
  if (summarySnap.exists()) {
    const s = summarySnap.val();
    console.log(`Last sync     : ${s.lastSyncAt}`);
    console.log(`Total products: ${s.totalProducts}`);
    console.log(`Chains OK     : ${s.chainsSucceeded}`);
    console.log(`Chains failed : ${s.chainsFailed}`);
    console.log(`Elapsed       : ${s.elapsedMinutes} min`);
    console.log(`Dry run       : ${s.dryRun}`);
  } else {
    console.log('❌ No syncSummary found in Firebase');
  }

  sep('📈 SHUFERSAL CHAIN STATUS');
  const shufSnap = await db.ref('syncStatus/shufersal').get();
  if (shufSnap.exists()) {
    const s = shufSnap.val();
    console.log(`Last sync date  : ${s.lastSyncDate}`);
    console.log(`Last success    : ${s.lastSuccessAt}`);
    console.log(`Items processed : ${s.itemsProcessed}`);
    console.log(`Stores processed: ${s.storesProcessed}`);
    console.log(`Store IDs       : ${(s.storeIds || []).join(', ')}`);
    console.log(`Errors          : ${s.errors}`);
  } else {
    console.log('❌ No Shufersal status in Firebase');
  }

  sep('🏪 STORE METADATA SAMPLE');
  const storeSnap = await db.ref('stores').limitToFirst(5).get();
  if (storeSnap.exists()) {
    for (const [k, v] of Object.entries(storeSnap.val())) {
      console.log(`  ${k}: ${v.storeName} (${v.city}) addr=${v.address}`);
    }
  } else {
    console.log('❌ No store metadata in Firebase');
  }

  sep('🔎 SAMPLE BARCODES');
  // Fetch enough of the price tree to surface 3 distinct barcodes
  const pricesSnap = await db.ref('prices').limitToFirst(200).get();
  const sampleBarcodes = [];
  if (pricesSnap.exists()) {
    for (const [barcode, storeData] of Object.entries(pricesSnap.val())) {
      if (sampleBarcodes.length >= 3) break;
      if (!storeData || typeof storeData !== 'object') continue;
      const firstStore = Object.values(storeData).find(s => s?.barcode && s?.price > 0);
      if (firstStore) sampleBarcodes.push({ barcode, ...firstStore });
    }
  }

  if (sampleBarcodes.length === 0) {
    console.log('❌ No price data in Firebase');
    process.exit(1);
  }

  for (const p of sampleBarcodes) {
    const storeCount = Object.keys(
      pricesSnap.val()[p.barcode] || {}
    ).length;
    console.log(`\n  Barcode : ${p.barcode}`);
    console.log(`  Name    : ${p.name}`);
    console.log(`  Price   : ₪${p.price} @ ${p.chainName} store ${p.storeId}`);
    console.log(`  Stores  : ${storeCount} entries in Firebase`);
    console.log(`  Synced  : ${p.syncedAt ? new Date(p.syncedAt).toISOString() : 'N/A'}`);
    console.log(`  Stale   : ${isStale(p.syncedAt)}`);
  }

  sep('✅ VERIFICATION CHECKS');
  const checks = [
    { name: 'Firebase connected',          pass: sampleBarcodes.length > 0 },
    { name: 'SyncSummary present',         pass: summarySnap.exists() },
    { name: 'Shufersal status present',    pass: shufSnap.exists() },
    { name: 'Store metadata present',      pass: storeSnap.exists() },
    { name: '3+ sample barcodes found',    pass: sampleBarcodes.length >= 3 },
    { name: 'Price data not stale',        pass: !isStale(sampleBarcodes[0]?.syncedAt) },
  ];
  let allPass = true;
  for (const c of checks) {
    console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
    if (!c.pass) allPass = false;
  }

  if (!allPass) {
    console.log('\n⚠️ Some checks failed — see above');
    process.exit(1);
  }

  console.log(`\n🎉 ALL CHECKS PASSED`);
  console.log(`\nTo verify the API for a specific barcode:`);
  console.log(`  node verify.js ${sampleBarcodes[0]?.barcode}`);
  console.log(`  node verify.js --json ${sampleBarcodes[0]?.barcode}`);

  process.exit(0);
} catch (err) {
  console.error('❌ VERIFICATION FAILED:', err.message);
  process.exit(1);
}

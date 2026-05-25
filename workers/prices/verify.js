#!/usr/bin/env node
// verify.js — End-to-end verification of price sync + Firebase API mock
// Usage:
//   node verify.js                     — show syncSummary + 3 sample barcodes
//   node verify.js 72917367            — show all stores for a specific barcode
//   node verify.js --json 72917367     — output raw JSON (mirrors /api/prices response)
//   node verify.js --stores            — show store geocoding coverage + sample coords

import 'dotenv/config.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const args = process.argv.slice(2);
const jsonMode   = args.includes('--json');
const storesMode = args.includes('--stores');
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

  if (storesMode) {
    // ── STORE GEOCODING COVERAGE ──────────────────────────────────────────────
    sep('📍 STORE GEOCODING COVERAGE');

    const snap = await db.ref('stores').get();
    if (!snap.exists()) {
      console.log('❌ No stores in Firebase — run sync worker first.');
      process.exit(1);
    }
    const stores = snap.val();
    const keys   = Object.keys(stores);

    const withCoords    = keys.filter(k => stores[k].hasCoords === true && stores[k].latitude);
    const noCoords      = keys.filter(k => !(stores[k].hasCoords === true && stores[k].latitude));
    const noAddr        = noCoords.filter(k => !stores[k].address?.trim() || !stores[k].city?.trim());
    const geocodeable   = noCoords.filter(k => stores[k].address?.trim() && stores[k].city?.trim());

    console.log(`Total stores:         ${keys.length}`);
    console.log(`With coords:          ${withCoords.length} (${Math.round(withCoords.length/keys.length*100)}%)`);
    console.log(`Without coords:       ${noCoords.length}`);
    console.log(`  Missing addr/city:  ${noAddr.length}  (cannot geocode)`);
    console.log(`  Geocodeable:        ${geocodeable.length} (run geocode-stores.js)`);

    if (withCoords.length > 0) {
      console.log('\n📍 Sample stores with coordinates:');
      const PROD_URL = 'https://family-shopping-one.vercel.app';
      // Tel Aviv: 32.0853, 34.7818
      const testLat = 32.0853, testLng = 34.7818;
      const R = 6371;
      const hav = (lat1, lng1, lat2, lng2) => {
        const dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
        return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      };
      const sample = withCoords.slice(0, 8);
      for (const k of sample) {
        const s = stores[k];
        const dist = hav(testLat, testLng, s.latitude, s.longitude);
        console.log(`  ${k.padEnd(30)} ${String(s.latitude.toFixed(4)).padStart(8)}, ${String(s.longitude.toFixed(4)).padEnd(9)} dist-from-TLV: ${dist.toFixed(1)} km  [${s.geocodeConfidence || 'manual'}]`);
      }
      if (withCoords.length > 8) console.log(`  … and ${withCoords.length - 8} more`);

      // Count how many are within 10km of Tel Aviv
      const within10 = withCoords.filter(k => {
        const s = stores[k];
        return hav(testLat, testLng, s.latitude, s.longitude) <= 10;
      });
      console.log(`\n🗺️  Stores within 10km of Tel Aviv (32.0853, 34.7818): ${within10.length}`);

      if (geocodeable.length === 0) {
        console.log('\n✅ All geocodeable stores have coordinates.');
      } else {
        console.log(`\n⚠️  ${geocodeable.length} stores still need geocoding.`);
        console.log('   Run: GEOCODE_WRITE=true node geocode-stores.js');
      }

      // Live API smoke test
      console.log('\n🌐 Testing production API (lat=32.0853, lng=34.7818, radiusKm=10)...');
      try {
        const apiRes = await fetch(
          `${PROD_URL}/api/prices?barcode=72917367&lat=${testLat}&lng=${testLng}&radiusKm=10`,
          { signal: AbortSignal.timeout(15_000) }
        );
        const data = await apiRes.json();
        const prices = data.prices || [];
        const withDist = prices.filter(p => p.distanceKm != null);
        console.log(`   Total returned:     ${prices.length}`);
        console.log(`   With distanceKm:    ${withDist.length}`);
        if (withDist.length > 0) {
          const sorted = [...withDist].sort((a, b) => a.distanceKm - b.distanceKm);
          console.log(`   Nearest:  ${sorted[0].storeName || sorted[0].chainName}  ${sorted[0].distanceKm} km  ₪${sorted[0].price}`);
          console.log(`   Farthest: ${sorted[sorted.length-1].storeName || sorted[sorted.length-1].chainName}  ${sorted[sorted.length-1].distanceKm} km  ₪${sorted[sorted.length-1].price}`);
        }
        if (withDist.length > 0 && prices.length < 89) {
          console.log(`\n✅ Radius filter is working — ${prices.length} stores (was 89 pre-geocoding)`);
        } else if (withDist.length === 0) {
          console.log('\n⚠️  distanceKm still null — store keys may not match price entry keys');
          console.log('   Check that chainId in prices/{barcode}/{key} matches stores/{key} prefix');
        }
      } catch (e) {
        console.log(`   ⚠️  API test failed: ${e.message}`);
      }
    } else {
      console.log('\n⚠️  No stores have coordinates yet.');
      console.log('   Run: GEOCODE_WRITE=true node geocode-stores.js');
    }

    process.exit(0);
  }

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

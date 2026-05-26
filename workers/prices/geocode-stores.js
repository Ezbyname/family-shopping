#!/usr/bin/env node
// workers/prices/geocode-stores.js
// One-time script: populates lat/lng for stores in Firebase using Google Geocoding API.
//
// Under Israeli law, Shufersal price XML files include StoreAddress + City but not GPS.
// This script geocodes those addresses so radius filtering works in the price API.
//
// ── Usage ───────────────────────────────────────────────────────────────────────
//   node geocode-stores.js                            # dry-run (safe default)
//   node geocode-stores.js --dry-run                  # explicit dry-run
//   GEOCODE_WRITE=true node geocode-stores.js         # write to Firebase
//   FORCE_GEOCODE=true node geocode-stores.js         # re-geocode already-coorded stores
//   CHAIN_FILTER=shufersal node geocode-stores.js     # only one chain prefix
//   RATE_LIMIT_MS=100 node geocode-stores.js          # faster (10 req/sec)
//
// ── Required env vars ─────────────────────────────────────────────────────────
//   GOOGLE_MAPS_API_KEY        — Google Cloud Geocoding API key
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
//   FIREBASE_DATABASE_URL
//
// ── Confidence levels accepted ───────────────────────────────────────────────
//   ROOFTOP              → exact building (best)
//   RANGE_INTERPOLATED   → street-segment interpolation (good)
//   GEOMETRIC_CENTER     → area/polygon center (acceptable for stores in malls)
//   APPROXIMATE          → city-level only → REJECTED (too imprecise for radius)
//   partial_match        → IGNORED for stores (abbreviated Israeli addresses like
//                          "א.ת", "ק.שר", mall names always trigger this flag even
//                          when Google returns a correct precise location)

import 'dotenv/config.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

// ── Config ────────────────────────────────────────────────────────────────────
const ARGS         = process.argv.slice(2);
const DRY_RUN      = process.env.GEOCODE_WRITE !== 'true' || ARGS.includes('--dry-run');
const FORCE        = process.env.FORCE_GEOCODE === 'true';
const CHAIN_FILTER = process.env.CHAIN_FILTER || null;
const RATE_MS      = Math.max(50, parseInt(process.env.RATE_LIMIT_MS || '200', 10)); // ≤20 req/s
const MAX_RETRIES  = 3;

// Google Geocoding API location_type values we trust for store placement.
// APPROXIMATE is city-level — too coarse for sub-km radius filtering.
const TRUSTED_TYPES = new Set(['ROOFTOP', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER']);

// ── Firebase init ─────────────────────────────────────────────────────────────
function initFirebase() {
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  const missing = [
    !projectId   && 'FIREBASE_PROJECT_ID',
    !clientEmail && 'FIREBASE_CLIENT_EMAIL',
    !privateKey  && 'FIREBASE_PRIVATE_KEY',
    !databaseURL && 'FIREBASE_DATABASE_URL',
  ].filter(Boolean);

  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    console.error('   Copy workers/prices/.env.example → .env and fill in credentials.');
    process.exit(2);
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    console.error('❌ Missing GOOGLE_MAPS_API_KEY');
    console.error('   Enable Geocoding API in Google Cloud Console and create an API key.');
    process.exit(2);
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
      databaseURL,
    });
  }
  return getDatabase();
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let _lastCallAt = 0;

async function throttle() {
  const now  = Date.now();
  const wait = RATE_MS - (now - _lastCallAt);
  if (wait > 0) await sleep(wait);
  _lastCallAt = Date.now();
}

// ── Google Geocoding API ──────────────────────────────────────────────────────
async function geocodeAddress(address, city) {
  // Build query: "{address}, {city}, ישראל" — Hebrew "Israel" improves results for IL addresses
  const query = `${address.trim()}, ${city.trim()}, ישראל`;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const url = [
    'https://maps.googleapis.com/maps/api/geocode/json',
    `?address=${encodeURIComponent(query)}`,
    `&key=${apiKey}`,
    '&language=he',   // Hebrew response — better for Hebrew addresses
    '&region=il',     // Bias results toward Israel
  ].join('');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();

    let res, data;
    try {
      res  = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      data = await res.json();
    } catch (e) {
      if (attempt < MAX_RETRIES) { await sleep(1000 * attempt); continue; }
      return { ok: false, reason: `network: ${e.message}`, query };
    }

    if (!res.ok) {
      if (attempt < MAX_RETRIES) { await sleep(1000 * attempt); continue; }
      return { ok: false, reason: `HTTP ${res.status}`, query };
    }

    switch (data.status) {
      case 'OK':
        break; // continue to parse
      case 'ZERO_RESULTS':
        return { ok: false, reason: 'ZERO_RESULTS', query };
      case 'OVER_QUERY_LIMIT':
        console.warn('\n  ⚠ OVER_QUERY_LIMIT — waiting 10s before retry...');
        await sleep(10_000);
        continue;
      case 'UNKNOWN_ERROR':
        if (attempt < MAX_RETRIES) { await sleep(2000 * attempt); continue; }
        return { ok: false, reason: 'UNKNOWN_ERROR (Google-side transient)', query };
      case 'REQUEST_DENIED':
        console.error('\n❌ REQUEST_DENIED — check that:');
        console.error('   1. GOOGLE_MAPS_API_KEY is correct');
        console.error('   2. Geocoding API is enabled in Google Cloud Console');
        console.error('   3. API key has no overly-restrictive IP restrictions');
        process.exit(1);
        break;
      default:
        return { ok: false, reason: data.status, query };
    }

    const result  = data.results?.[0];
    if (!result) return { ok: false, reason: 'empty results array', query };

    const locType = result.geometry?.location_type;

    // partial_match is intentionally ignored for stores: abbreviated Israeli store
    // addresses (א.ת, ק.שר, mall names) often trigger partial_match even when Google
    // returns a correct ROOFTOP/GEOMETRIC_CENTER location.

    // APPROXIMATE = city-level fallback. Stored with approximateLocation:true so the
    // API and basket-compare can exclude them from strict nearby queries.
    if (locType === 'APPROXIMATE') {
      return {
        ok:                  true,
        approximate:         true,
        latitude:            result.geometry.location.lat,
        longitude:           result.geometry.location.lng,
        confidence:          locType,
        formattedAddress:    result.formatted_address,
        query,
      };
    }

    if (!TRUSTED_TYPES.has(locType)) {
      return { ok: false, reason: `unknown location_type (${locType})`, query };
    }

    return {
      ok:               true,
      approximate:      false,
      latitude:         result.geometry.location.lat,
      longitude:        result.geometry.location.lng,
      confidence:       locType,
      formattedAddress: result.formatted_address,
      query,
    };
  }

  return { ok: false, reason: 'max retries exceeded', query };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           geocode-stores.js                     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log(`  Mode:              ${DRY_RUN ? '🔍 DRY-RUN (no Firebase writes)' : '✏️  WRITE  (GEOCODE_WRITE=true)'}`);
  console.log(`  Force re-geocode:  ${FORCE  ? 'yes (FORCE_GEOCODE=true)'       : 'no  (skipping hasCoords=true)'}`);
  console.log(`  Rate limit:        ${RATE_MS}ms between requests (~${Math.floor(1000/RATE_MS)} req/s)`);
  if (CHAIN_FILTER) console.log(`  Chain filter:      ${CHAIN_FILTER}`);
  console.log('');

  const db = initFirebase();

  // ── Load all stores ─────────────────────────────────────────────────────────
  console.log('Loading stores from Firebase...');
  const snap = await db.ref('stores').get();
  if (!snap.exists()) {
    console.error('❌ No stores found at stores/ in Firebase.');
    console.error('   Run the price sync worker first: node index.js shufersal');
    process.exit(1);
  }

  const stores = snap.val();  // { [storeKey]: { ... } }

  // ── Categorize ──────────────────────────────────────────────────────────────
  const alreadyDone   = []; // hasCoords=true, skip unless FORCE
  const needsGeocode  = []; // will be processed
  const missingAddr   = []; // no address or city — cannot geocode

  for (const [key, s] of Object.entries(stores)) {
    if (CHAIN_FILTER && !key.startsWith(CHAIN_FILTER + '_')) continue;

    if (s.hasCoords === true && s.latitude && s.longitude && !FORCE) {
      alreadyDone.push(key);
      continue;
    }
    // Need both address and city to form a useful query
    if (!s.address?.trim() || !s.city?.trim()) {
      missingAddr.push(key);
      continue;
    }
    needsGeocode.push(key);
  }

  const totalScoped = alreadyDone.length + needsGeocode.length + missingAddr.length;
  console.log('📊 Store breakdown:');
  console.log(`   Total in Firebase:       ${Object.keys(stores).length}`);
  if (CHAIN_FILTER) console.log(`   Matching "${CHAIN_FILTER}":         ${totalScoped}`);
  console.log(`   Already have coords:     ${alreadyDone.length}`);
  console.log(`   Missing address/city:    ${missingAddr.length}`);
  console.log(`   To geocode now:          ${needsGeocode.length}`);

  if (missingAddr.length > 0) {
    console.log(`   Sample missing-addr:     ${missingAddr.slice(0, 3).join(', ')}`);
  }
  console.log('');

  if (needsGeocode.length === 0) {
    console.log('✅ Nothing to geocode. All stores either have coordinates or lack address data.');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log(`⚠️  DRY-RUN — showing what would be geocoded. No Firebase writes.`);
    console.log(`   Set GEOCODE_WRITE=true to persist results.\n`);

    // Show a sample of what queries would be made
    const sample = needsGeocode.slice(0, 5);
    console.log('   Sample queries that would be sent to Google Geocoding API:');
    for (const key of sample) {
      const s = stores[key];
      console.log(`     ${key}: "${s.address}, ${s.city}, ישראל"`);
    }
    if (needsGeocode.length > 5) console.log(`     … and ${needsGeocode.length - 5} more`);

    // Estimate cost
    const freePerMonth = 40_000; // Google Geocoding free tier
    const cost = needsGeocode.length > freePerMonth
      ? `~$${((needsGeocode.length - freePerMonth) * 0.005).toFixed(2)} above free tier`
      : `within free tier (${needsGeocode.length}/${freePerMonth})`;
    console.log(`\n   Estimated API calls:  ${needsGeocode.length} (${cost})`);
    console.log(`   Estimated time:       ~${Math.ceil(needsGeocode.length * RATE_MS / 60000)} minutes at ${RATE_MS}ms/request`);
    process.exit(0);
  }

  // ── Geocode loop ─────────────────────────────────────────────────────────────
  const counts  = { succeeded: 0, failed: 0 };
  const failures = [];
  const samples  = [];

  console.log(`Starting geocoding of ${needsGeocode.length} stores...\n`);

  for (let i = 0; i < needsGeocode.length; i++) {
    const key = needsGeocode[i];
    const s   = stores[key];
    const pct = String(Math.round(((i + 1) / needsGeocode.length) * 100)).padStart(3);
    const idx = String(i + 1).padStart(4);
    const tag = key.slice(0, 28).padEnd(28);

    process.stdout.write(`  [${idx}/${needsGeocode.length}] ${pct}% ${tag} `);

    const geo = await geocodeAddress(s.address, s.city);

    if (!geo.ok) {
      process.stdout.write(`✗ ${geo.reason}\n`);
      counts.failed++;
      failures.push({ key, store: `${s.storeName || ''}/${s.city}`, reason: geo.reason, query: geo.query });
      continue;
    }

    const latStr  = geo.latitude.toFixed(4);
    const lngStr  = geo.longitude.toFixed(4);
    const approxTag = geo.approximate ? ' [~APPROX]' : '';
    process.stdout.write(`✓ ${latStr},${lngStr} [${geo.confidence}]${approxTag}\n`);
    counts.succeeded++;

    if (samples.length < 8) {
      samples.push({
        key,
        storeName:        s.storeName || s.chainName || key,
        city:             s.city,
        lat:              geo.latitude,
        lng:              geo.longitude,
        confidence:       geo.confidence,
        approximate:      geo.approximate,
        formattedAddress: geo.formattedAddress,
      });
    }

    // Write to Firebase
    const update = {
      latitude:            geo.latitude,
      longitude:           geo.longitude,
      hasCoords:           true,
      approximateLocation: geo.approximate === true,   // true for APPROXIMATE, false otherwise
      geocodedAt:          new Date().toISOString(),
      geocodeProvider:     'google',
      geocodeQuery:        geo.query,
      geocodeConfidence:   geo.confidence,             // ROOFTOP / GEOMETRIC_CENTER / APPROXIMATE etc.
    };

    try {
      await db.ref(`stores/${key}`).update(update);
    } catch (e) {
      console.error(`\n  Firebase write failed for ${key}: ${e.message}`);
      counts.failed++;
      counts.succeeded--;
      failures.push({ key, reason: `firebase_write: ${e.message}` });
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Geocoding complete                             ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  console.log(`  ✅ Succeeded:           ${counts.succeeded}`);
  console.log(`  ✗  Failed:              ${counts.failed}`);
  console.log(`  ⏭  Skipped (no addr):  ${missingAddr.length}`);
  console.log(`  📍 Already had coords: ${alreadyDone.length}`);
  console.log(`  Total with coords now: ${alreadyDone.length + counts.succeeded}`);

  if (samples.length > 0) {
    console.log('\n📍 Sample results:');
    for (const s of samples) {
      console.log(`  ${s.storeName} (${s.city})`);
      console.log(`    coords:  ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}  [${s.confidence}]`);
      console.log(`    google:  ${s.formattedAddress}`);
    }
  }

  if (failures.length > 0) {
    const showCount = Math.min(failures.length, 20);
    console.log(`\n✗ Failed stores (showing ${showCount}/${failures.length}):`);
    for (const f of failures.slice(0, showCount)) {
      console.log(`  ${f.key}: ${f.reason}`);
      if (f.query) console.log(`    query: "${f.query}"`);
    }
    if (failures.length > showCount) {
      console.log(`  … and ${failures.length - showCount} more`);
    }
  }

  console.log('');
  if (counts.succeeded > 0) {
    console.log('Next steps:');
    console.log('  1. Verify: node verify.js --stores');
    console.log('  2. Test production API:');
    console.log('     curl "https://family-shopping-one.vercel.app/api/prices?barcode=72917367&lat=32.0853&lng=34.7818&radiusKm=10"');
    console.log('     Expected: filtered results with distanceKm on each row');
  }

  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\n❌ Fatal error:', e.message);
  process.exit(1);
});

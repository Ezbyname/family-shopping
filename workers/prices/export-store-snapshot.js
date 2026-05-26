#!/usr/bin/env node
// workers/prices/export-store-snapshot.js
// Reads stores/ from Firebase and exports all geocoded stores to
// workers/prices/data/stores-geocoded.json for local backup + monthly maintenance.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node export-store-snapshot.js            # dry-run: preview what would be written
//   SNAPSHOT_WRITE=true node export-store-snapshot.js   # write snapshot file
//
// Run this once after initial geocoding is complete, then re-run monthly
// via stores-monthly-update.js (which calls the export step automatically).
//
// ── Output format ────────────────────────────────────────────────────────────
//   data/stores-geocoded.json  →  { exportedAt, version, totalStores,
//                                   geocodedStores, stores: { [storeKey]: {...} } }

import 'dotenv/config.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT   = resolve(__dirname, 'data', 'stores-geocoded.json');
const ARGS       = process.argv.slice(2);
const DRY_RUN    = process.env.SNAPSHOT_WRITE !== 'true' && !ARGS.includes('--write');

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
    console.error(`\n❌ Missing env vars: ${missing.join(', ')}`);
    console.error('   Copy .env.example → .env and fill in credentials.');
    process.exit(2);
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }),
      databaseURL,
    });
  }
  return getDatabase();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║         export-store-snapshot.js                ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`  Mode: ${DRY_RUN ? '🔍 DRY-RUN  (set SNAPSHOT_WRITE=true to persist)' : '✏️  WRITE   (SNAPSHOT_WRITE=true)'}`);
  console.log(`  Output: ${SNAPSHOT}\n`);

  const db = initFirebase();

  console.log('Loading stores from Firebase...');
  const snap = await db.ref('stores').get();
  if (!snap.exists()) {
    console.error('\n❌ No stores found at stores/ in Firebase.');
    console.error('   Run the price sync worker first: node index.js shufersal');
    process.exit(1);
  }

  const raw       = snap.val();
  const allKeys   = Object.keys(raw);
  const exportedAt = new Date().toISOString();

  // ── Build export entries ────────────────────────────────────────────────────
  // Include ALL stores regardless of geocode status — geocoded ones get full
  // coord data; un-geocoded ones serve as a roster for monthly update to act on.
  const stores = {};
  let geocodedCount = 0;
  let approxCount   = 0;
  let noCoordCount  = 0;

  for (const key of allKeys) {
    const s = raw[key];
    if (!s || typeof s !== 'object') continue;

    const hasCoords = s.hasCoords === true && s.latitude != null && s.longitude != null;
    if (hasCoords) geocodedCount++;
    else            noCoordCount++;
    if (hasCoords && s.approximateLocation === true) approxCount++;

    stores[key] = {
      // Identity
      storeKey:           key,
      chainId:            s.chainId            || '',
      storeId:            s.storeId            || '',
      storeName:          s.storeName          || '',
      city:               s.city               || '',
      address:            s.address            || '',
      zipCode:            s.zipCode            || '',
      // Coordinates
      latitude:           hasCoords ? s.latitude  : null,
      longitude:          hasCoords ? s.longitude : null,
      hasCoords,
      // Geocoding metadata
      geocodeConfidence:  s.geocodeConfidence  || null,  // ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER / APPROXIMATE
      geocodeLocationType:s.geocodeConfidence  || null,  // alias — same value, explicit field name per spec
      approximateLocation:s.approximateLocation === true,
      geocodedAt:         s.geocodedAt         || null,
      geocodeProvider:    s.geocodeProvider    || null,
      geocodeQuery:       s.geocodeQuery       || null,
      // Lifecycle (set to "active" on first export; maintained by stores-monthly-update.js)
      status:             s.status             || 'active',
      missedChecks:       s.missedChecks       ?? 0,
      lastSeenAt:         s.updatedAt          || null,  // last time price worker touched this store
      // Snapshot metadata
      exportedAt,
    };
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const highConf   = geocodedCount - approxCount;
  const pctGeocoded = allKeys.length > 0 ? Math.round(geocodedCount / allKeys.length * 100) : 0;

  console.log(`\n📊 Store breakdown:`);
  console.log(`   Total stores in Firebase:     ${allKeys.length}`);
  console.log(`   Geocoded (high-confidence):   ${highConf}  (ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER)`);
  console.log(`   Geocoded (APPROXIMATE):       ${approxCount}  (city-level, excluded from strict nearby)`);
  console.log(`   Not yet geocoded:             ${noCoordCount}  (missing address or failed geocode)`);
  console.log(`   Coverage:                     ${pctGeocoded}%`);

  if (approxCount > 0) {
    console.log(`\n⚠️  ${approxCount} store(s) have APPROXIMATE geocoding (city-level only).`);
    console.log('   These are excluded from strict radius queries but visible with &includeApproximate=true.');
    console.log('   Consider manual review — see stores-monthly-update.js for the full list.');
  }

  // ── Build output document ─────────────────────────────────────────────────
  const output = {
    exportedAt,
    version:       '1',
    totalStores:   allKeys.length,
    geocodedStores: geocodedCount,
    approximateStores: approxCount,
    stores,
  };

  if (DRY_RUN) {
    console.log(`\n⚠️  DRY-RUN — snapshot not written.`);
    console.log(`   Would write ${allKeys.length} stores to: ${SNAPSHOT}`);
    console.log(`   Set SNAPSHOT_WRITE=true to persist.\n`);
    // Show a sample of what would be written
    const sampleKeys = Object.keys(stores).slice(0, 3);
    console.log('   Sample entries:');
    for (const k of sampleKeys) {
      const e = stores[k];
      const coordStr = e.hasCoords
        ? `${e.latitude?.toFixed(4)}, ${e.longitude?.toFixed(4)}  [${e.geocodeConfidence}]`
        : '(no coords)';
      console.log(`   ${k.padEnd(30)} ${coordStr}`);
    }
    if (allKeys.length > 3) console.log(`   … and ${allKeys.length - 3} more`);
    process.exit(0);
  }

  // ── Write local snapshot ───────────────────────────────────────────────────
  mkdirSync(resolve(__dirname, 'data'), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ Local snapshot written → ${SNAPSHOT}`);
  console.log(`   ${allKeys.length} stores exported (${geocodedCount} geocoded, ${noCoordCount} without coords)`);

  // ── Firebase RTDB backup ───────────────────────────────────────────────────
  // Rotates: previous ← latest ← new export.
  // This ensures the snapshot survives VM disk loss / accidental deletion.
  // storeSnapshot/latest  → current export (full stores map)
  // storeSnapshot/previous → the export before this one (one-generation rollback)
  console.log('\nBacking up snapshot to Firebase RTDB (storeSnapshot/)...');
  try {
    // Read existing latest → rotate to previous
    const existingSnap = await db.ref('storeSnapshot/latest').get();
    if (existingSnap.exists()) {
      const existing = existingSnap.val();
      await db.ref('storeSnapshot/previous').set({
        ...existing,
        rotatedAt: new Date().toISOString(),
      });
    }
    // Write new latest
    await db.ref('storeSnapshot/latest').set(output);
    console.log('  ✅ Firebase backup complete  (storeSnapshot/latest + storeSnapshot/previous)');
  } catch (e) {
    console.warn(`  ⚠ Firebase backup failed: ${e.message}`);
    console.warn('    Local snapshot is still intact — consider manual backup.');
  }

  console.log('\nNext steps:');
  console.log('  • Monthly maintenance: node stores-monthly-update.js --dry-run');
  console.log('  • Full verification:   node verify.js --stores');
  console.log('  • Firebase backup:     firebase.rtdb/storeSnapshot/latest');

  process.exit(0);
}

main().catch(e => {
  console.error('\n❌ Fatal error:', e.message);
  process.exit(1);
});

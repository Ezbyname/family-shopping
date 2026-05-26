#!/usr/bin/env node
// workers/prices/stores-monthly-update.js
// Monthly store maintenance: detects new / changed / closed stores, geocodes
// new arrivals, and updates lifecycle status in Firebase + local snapshot.
//
// ── Usage ─────────────────────────────────────────────────────────────────────
//   node stores-monthly-update.js                    # dry-run (safe default)
//   node stores-monthly-update.js --dry-run          # explicit dry-run
//   STORE_MAINTENANCE_WRITE=true node stores-monthly-update.js  # live run
//
// ── Scheduling (PM2 ecosystem.config.js or crontab on VPS) ───────────────────
//   0 3 1 * *   cd /path/to/family-shopping && node workers/prices/stores-monthly-update.js
//
//   PM2 cron entry (SEPARATE from daily price sync — add to ecosystem.config.js):
//     {
//       name: 'store-maintenance',
//       script: 'workers/prices/stores-monthly-update.js',
//       cron_restart: '0 3 1 * *',
//       autorestart: false,
//       env: { STORE_MAINTENANCE_WRITE: 'true', NODE_ENV: 'production' }
//     }
//
// ── What this script does ────────────────────────────────────────────────────
//   1. Load Firebase stores/ (current ground truth)
//   2. Load data/stores-geocoded.json (previous snapshot)
//   3. Detect:
//        • New stores (in Firebase, absent from snapshot)
//        • Changed address/city vs snapshot
//        • Stores not seen in a price sync for 35+ days  →  lifecycle update
//        • APPROXIMATE-geocoded stores needing review
//   4. Geocode new stores without coords (requires GOOGLE_MAPS_API_KEY)
//   5. Update lifecycle status per rules:
//        • active        — seen in price sync within the last 35 days
//        • possibly_closed — missed 1–2 monthly checks  (missedChecks 1-2)
//        • closed         — missed 3 consecutive monthly checks (missedChecks ≥ 3)
//   6. Log all planned changes before any write
//   7. If STORE_MAINTENANCE_WRITE=true:
//        • Write status updates to Firebase stores/{key}
//        • Geocode new stores + write coords to Firebase
//        • Refresh data/stores-geocoded.json snapshot
//
// ── Safety rules ─────────────────────────────────────────────────────────────
//   • Dry-run by default — no Firebase writes without STORE_MAINTENANCE_WRITE=true
//   • Never overwrite high-confidence coords with lower-confidence ones
//   • Never delete stores from Firebase or from the snapshot
//   • All planned changes are printed before any write occurs
//   • Price sync (index.js) is NOT affected — this script touches only
//     status/missedChecks fields, never prices/{barcode}/*

import 'dotenv/config.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT   = resolve(__dirname, 'data', 'stores-geocoded.json');
const ARGS       = process.argv.slice(2);
const DRY_RUN    = process.env.STORE_MAINTENANCE_WRITE !== 'true' && !ARGS.includes('--write');

// A store is considered "not seen in recent sync" if its updatedAt is older than this.
// Price sync runs 2×/day — 35 days gives a full monthly buffer.
const STALE_SYNC_MS   = 35 * 24 * 3600 * 1000;

// Confidence ranking — higher index = more precise
const CONFIDENCE_RANK = {
  'ROOFTOP':            4,
  'RANGE_INTERPOLATED': 3,
  'GEOMETRIC_CENTER':   2,
  'APPROXIMATE':        1,
  'MANUAL':             0, // legacy manual entries — not upgraded
};

const TRUSTED_TYPES = new Set(['ROOFTOP', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER']);
const RATE_MS       = 200; // 5 geocode req/s
const MAX_RETRIES   = 3;

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
    console.error(`\n❌ Missing Firebase env vars: ${missing.join(', ')}`);
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

// ── Rate-limited sleep ────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let _lastGeoAt = 0;
async function throttle() {
  const wait = RATE_MS - (Date.now() - _lastGeoAt);
  if (wait > 0) await sleep(wait);
  _lastGeoAt = Date.now();
}

// ── Google Geocoding API ──────────────────────────────────────────────────────
async function geocodeAddress(address, city) {
  if (!process.env.GOOGLE_MAPS_API_KEY) return { ok: false, reason: 'GOOGLE_MAPS_API_KEY not set' };

  const query = `${address.trim()}, ${city.trim()}, ישראל`;
  const url = [
    'https://maps.googleapis.com/maps/api/geocode/json',
    `?address=${encodeURIComponent(query)}`,
    `&key=${process.env.GOOGLE_MAPS_API_KEY}`,
    '&language=he',
    '&region=il',
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
      case 'OK':               break;
      case 'ZERO_RESULTS':     return { ok: false, reason: 'ZERO_RESULTS', query };
      case 'OVER_QUERY_LIMIT':
        console.warn('  ⚠ OVER_QUERY_LIMIT — waiting 10s...');
        await sleep(10_000);
        continue;
      case 'REQUEST_DENIED':
        console.error('\n❌ REQUEST_DENIED — check GOOGLE_MAPS_API_KEY and Geocoding API enablement');
        process.exit(1);
        break;
      default:
        if (attempt < MAX_RETRIES) { await sleep(2000 * attempt); continue; }
        return { ok: false, reason: data.status, query };
    }
    const result  = data.results?.[0];
    if (!result) return { ok: false, reason: 'empty results', query };

    const locType = result.geometry?.location_type;

    // APPROXIMATE = city-level. Accept as low-confidence fallback, tagged accordingly.
    const isApprox = locType === 'APPROXIMATE';
    if (!isApprox && !TRUSTED_TYPES.has(locType)) {
      return { ok: false, reason: `unknown location_type (${locType})`, query };
    }
    return {
      ok:               true,
      approximate:      isApprox,
      latitude:         result.geometry.location.lat,
      longitude:        result.geometry.location.lng,
      confidence:       locType,
      formattedAddress: result.formatted_address,
      query,
    };
  }
  return { ok: false, reason: 'max retries exceeded', query };
}

// ── Snapshot I/O ──────────────────────────────────────────────────────────────
function loadSnapshot() {
  if (!existsSync(SNAPSHOT)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  } catch (e) {
    console.warn(`  ⚠ Could not parse snapshot (${e.message}) — treating as first run`);
    return null;
  }
}

function saveSnapshot(data) {
  mkdirSync(resolve(__dirname, 'data'), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(data, null, 2), 'utf8');
}

// ── Lifecycle helper ──────────────────────────────────────────────────────────
function nextLifecycle(prevStatus, prevMissedChecks, seenRecently) {
  if (seenRecently) return { status: 'active', missedChecks: 0 };

  const missed = (prevMissedChecks ?? 0) + 1;
  if (prevStatus === 'closed') return { status: 'closed', missedChecks: missed };
  if (missed >= 3) return { status: 'closed', missedChecks: missed };
  return { status: 'possibly_closed', missedChecks: missed };
}

// ── Section header ────────────────────────────────────────────────────────────
function sep(title) {
  console.log(`\n${'─'.repeat(56)}`);
  console.log(title);
  console.log('─'.repeat(56));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║          stores-monthly-update.js                   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  console.log(`  Mode:       ${DRY_RUN ? '🔍 DRY-RUN  (no writes — set STORE_MAINTENANCE_WRITE=true)' : '✏️  WRITE'}`);
  console.log(`  Snapshot:   ${SNAPSHOT}`);
  console.log(`  Geocoding:  ${process.env.GOOGLE_MAPS_API_KEY ? '✅ GOOGLE_MAPS_API_KEY present' : '⚠️  GOOGLE_MAPS_API_KEY not set (new stores will not be geocoded)'}`);
  console.log('');

  const db          = initFirebase();
  const prevSnap    = loadSnapshot();
  const prevStores  = prevSnap?.stores ?? {};
  const isFirstRun  = !prevSnap;
  const now         = Date.now();
  const runAt       = new Date().toISOString();

  if (isFirstRun) {
    console.log('  ℹ️  No previous snapshot found — this is the first run.');
    console.log('     All stores will be set to status=active.');
    console.log('     Run export-store-snapshot.js first for a clean baseline.\n');
  } else {
    console.log(`  Previous snapshot: ${prevSnap.exportedAt}  (${Object.keys(prevStores).length} stores)\n`);
  }

  // ── Load Firebase stores ────────────────────────────────────────────────────
  console.log('Loading stores from Firebase...');
  const firebaseSnap = await db.ref('stores').get();
  if (!firebaseSnap.exists()) {
    console.error('\n❌ No stores at stores/ in Firebase — run price sync first.');
    process.exit(1);
  }
  const fbStores = firebaseSnap.val();
  const fbKeys   = new Set(Object.keys(fbStores));

  // ── Categorize ──────────────────────────────────────────────────────────────
  const newStores          = []; // in Firebase, not in snapshot
  const changedAddress     = []; // address or city differs from snapshot
  const needsGeocodeNew    = []; // new store with no coords → will geocode
  const lifecycleChanges   = []; // status transitions (active ↔ possibly_closed ↔ closed)
  const approxReviewList   = []; // APPROXIMATE stores flagged for human review
  const alreadyGeocoded    = []; // high-confidence, no action needed
  const noCoordNoAddr      = []; // cannot geocode (missing address)
  const removedFromFirebase= []; // in snapshot but no longer in Firebase at all

  // Stores that were in the previous snapshot but are now gone from Firebase entirely
  for (const key of Object.keys(prevStores)) {
    if (!fbKeys.has(key)) removedFromFirebase.push(key);
  }

  for (const [key, s] of Object.entries(fbStores)) {
    const prev          = prevStores[key];
    const hasCoords     = s.hasCoords === true && s.latitude != null && s.longitude != null;
    const seenRecently  = s.updatedAt && (now - Number(new Date(s.updatedAt))) < STALE_SYNC_MS;
    const isApprox      = s.approximateLocation === true;
    const prevConf      = CONFIDENCE_RANK[prev?.geocodeConfidence] ?? -1;
    const currConf      = CONFIDENCE_RANK[s.geocodeConfidence]     ?? -1;

    // ── New store (not in snapshot) ─────────────────────────────────────────
    if (!prev) {
      newStores.push(key);
      if (!hasCoords) {
        if (s.address?.trim() && s.city?.trim()) needsGeocodeNew.push(key);
        else                                       noCoordNoAddr.push(key);
      }
      continue; // lifecycle computed fresh below
    }

    // ── Address/city change detection ───────────────────────────────────────
    const addrChanged = (s.address || '') !== (prev.address || '');
    const cityChanged = (s.city    || '') !== (prev.city    || '');
    if ((addrChanged || cityChanged) && hasCoords) {
      changedAddress.push({
        key,
        oldAddr: `${prev.address}, ${prev.city}`,
        newAddr: `${s.address},    ${s.city}`,
        currentConfidence: s.geocodeConfidence || 'unknown',
        note: TRUSTED_TYPES.has(s.geocodeConfidence)
          ? 'address changed — consider manual re-geocode (high-confidence coords preserved)'
          : 'address changed — automatic re-geocode recommended (low-confidence)',
      });
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    const prevStatus       = prev.status       || 'active';
    const prevMissedChecks = prev.missedChecks ?? 0;
    const { status, missedChecks } = nextLifecycle(prevStatus, prevMissedChecks, seenRecently);

    if (status !== prevStatus || missedChecks !== prevMissedChecks) {
      lifecycleChanges.push({
        key,
        from:        prevStatus,
        to:          status,
        missedChecks,
        updatedAt:   s.updatedAt || null,
        seenRecently,
      });
    }

    // ── APPROXIMATE review list ─────────────────────────────────────────────
    if (isApprox) {
      approxReviewList.push({
        key,
        storeName: s.storeName || '',
        city:      s.city      || '',
        address:   s.address   || '',
        confidence: s.geocodeConfidence,
        geocodedAt: s.geocodedAt || null,
      });
    } else if (hasCoords) {
      alreadyGeocoded.push(key);
    }
  }

  // ── Print report ────────────────────────────────────────────────────────────
  sep('📊 OVERVIEW');
  console.log(`   Firebase stores total:        ${fbKeys.size}`);
  console.log(`   Stores in previous snapshot:  ${Object.keys(prevStores).length}`);
  console.log(`   New stores (not in snapshot): ${newStores.length}`);
  console.log(`   Removed from Firebase:        ${removedFromFirebase.length}`);
  console.log(`   Address/city changed:         ${changedAddress.length}`);
  console.log(`   Lifecycle transitions:        ${lifecycleChanges.length}`);
  console.log(`   APPROXIMATE coords (review):  ${approxReviewList.length}`);
  console.log(`   Needs geocoding (new):        ${needsGeocodeNew.length}`);
  console.log(`   Cannot geocode (no addr):     ${noCoordNoAddr.length}`);
  console.log(`   Already high-confidence:      ${alreadyGeocoded.length}`);

  // ── New stores ──────────────────────────────────────────────────────────────
  if (newStores.length > 0) {
    sep(`🆕 NEW STORES  (${newStores.length})`);
    for (const key of newStores) {
      const s = fbStores[key];
      const hasCoords = s.hasCoords === true && s.latitude != null;
      console.log(`   ${key}`);
      console.log(`     Name:    ${s.storeName || '(unknown)'}`);
      console.log(`     City:    ${s.city      || '(unknown)'}`);
      console.log(`     Address: ${s.address   || '(none)'}`);
      console.log(`     Coords:  ${hasCoords ? `${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)}  [${s.geocodeConfidence}]` : 'none — will geocode'}`);
    }
  }

  // ── Lifecycle changes ───────────────────────────────────────────────────────
  if (lifecycleChanges.length > 0) {
    sep(`🔄 LIFECYCLE CHANGES  (${lifecycleChanges.length})`);
    for (const c of lifecycleChanges) {
      const s    = fbStores[c.key];
      const age  = c.updatedAt
        ? `last seen ${Math.floor((now - Number(new Date(c.updatedAt))) / 86400000)}d ago`
        : 'never seen in sync';
      console.log(`   ${c.key}  ${c.from} → ${c.to}  (missed=${c.missedChecks}, ${age})`);
      if (s?.storeName) console.log(`     ${s.storeName}, ${s.city || ''}`);
    }
    const toClose    = lifecycleChanges.filter(c => c.to === 'closed');
    const toPossible = lifecycleChanges.filter(c => c.to === 'possibly_closed');
    const toActive   = lifecycleChanges.filter(c => c.to === 'active');
    if (toClose.length)    console.log(`\n   ⛔  Will mark CLOSED:         ${toClose.length}`);
    if (toPossible.length) console.log(`   ⚠️   Will mark POSSIBLY_CLOSED: ${toPossible.length}`);
    if (toActive.length)   console.log(`   ✅  Will restore ACTIVE:       ${toActive.length}`);
  }

  // ── Address changes ────────────────────────────────────────────────────────
  if (changedAddress.length > 0) {
    sep(`📬 ADDRESS / CITY CHANGES  (${changedAddress.length})`);
    for (const c of changedAddress) {
      console.log(`   ${c.key}`);
      console.log(`     Old: ${c.oldAddr}`);
      console.log(`     New: ${c.newAddr}`);
      console.log(`     ℹ️   ${c.note}`);
    }
  }

  // ── Approximate review ─────────────────────────────────────────────────────
  if (approxReviewList.length > 0) {
    sep(`📍 APPROXIMATE GEOCODING — REVIEW RECOMMENDED  (${approxReviewList.length})`);
    console.log('   These stores were geocoded at city-level only.');
    console.log('   They appear with "📍 מיקום משוער" badge in the app.');
    console.log('   To improve: verify their address manually and re-run geocode-stores.js.\n');
    for (const a of approxReviewList) {
      console.log(`   ${a.key.padEnd(30)} ${a.storeName}  (${a.city})`);
      console.log(`     Address:    ${a.address || '(empty)'}`);
      console.log(`     Geocoded:   ${a.geocodedAt || 'unknown'}`);
    }
  }

  // ── Removed from Firebase ──────────────────────────────────────────────────
  if (removedFromFirebase.length > 0) {
    sep(`🗑️  REMOVED FROM FIREBASE  (${removedFromFirebase.length})`);
    console.log('   These keys exist in the snapshot but are gone from Firebase.');
    console.log('   Snapshot entries will be marked closed; no Firebase write needed.\n');
    for (const key of removedFromFirebase) {
      const prev = prevStores[key];
      console.log(`   ${key}  (was: ${prev.storeName || '?'}, ${prev.city || '?'})`);
    }
  }

  // ── Cannot geocode ────────────────────────────────────────────────────────
  if (noCoordNoAddr.length > 0) {
    sep(`⛔ CANNOT GEOCODE — MISSING ADDRESS  (${noCoordNoAddr.length})`);
    for (const key of noCoordNoAddr) {
      const s = fbStores[key];
      console.log(`   ${key}  storeName=${s.storeName || '?'}  city=${s.city || '?'}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n' + '═'.repeat(56));
    console.log('DRY-RUN COMPLETE — no writes performed.');
    console.log(`  ${lifecycleChanges.length} lifecycle changes would be written to Firebase.`);
    console.log(`  ${needsGeocodeNew.length} new stores would be geocoded.`);
    console.log(`  Snapshot would be refreshed at: ${SNAPSHOT}`);
    console.log('═'.repeat(56));
    console.log('\nTo apply: STORE_MAINTENANCE_WRITE=true node stores-monthly-update.js');
    process.exit(0);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WRITE MODE
  // ══════════════════════════════════════════════════════════════════════════
  sep('✏️  APPLYING CHANGES');

  const counts = {
    lifecycleWritten: 0,
    geocodedNew:      0,
    geocodeFailed:    0,
    snapshotUpdated:  0,
  };
  const geocodeFailures = [];

  // Build the updated snapshot stores map starting from Firebase current state
  // Merge with previous snapshot for stores still in Firebase.
  const updatedStores = {};

  // ── Step 1: Geocode new stores without coords ──────────────────────────────
  const geocodedResults = {}; // key → geo result

  if (needsGeocodeNew.length > 0) {
    console.log(`\nGeocoding ${needsGeocodeNew.length} new stores...`);
    for (let i = 0; i < needsGeocodeNew.length; i++) {
      const key = needsGeocodeNew[i];
      const s   = fbStores[key];
      process.stdout.write(`  [${i+1}/${needsGeocodeNew.length}] ${key.padEnd(30)} `);

      const geo = await geocodeAddress(s.address, s.city);
      if (!geo.ok) {
        process.stdout.write(`✗ ${geo.reason}\n`);
        counts.geocodeFailed++;
        geocodeFailures.push({ key, reason: geo.reason });
        continue;
      }

      const tag = geo.approximate ? ' [~APPROX]' : '';
      process.stdout.write(`✓ ${geo.latitude.toFixed(4)},${geo.longitude.toFixed(4)}  [${geo.confidence}]${tag}\n`);
      geocodedResults[key] = geo;
      counts.geocodedNew++;

      // Write to Firebase
      await db.ref(`stores/${key}`).update({
        latitude:            geo.latitude,
        longitude:           geo.longitude,
        hasCoords:           true,
        approximateLocation: geo.approximate === true,
        geocodedAt:          new Date().toISOString(),
        geocodeProvider:     'google',
        geocodeQuery:        geo.query,
        geocodeConfidence:   geo.confidence,
      });
    }
  }

  // ── Step 2: Write lifecycle changes to Firebase ────────────────────────────
  if (lifecycleChanges.length > 0) {
    console.log(`\nWriting ${lifecycleChanges.length} lifecycle changes to Firebase...`);
    for (const c of lifecycleChanges) {
      try {
        await db.ref(`stores/${c.key}`).update({
          status:       c.to,
          missedChecks: c.missedChecks,
        });
        counts.lifecycleWritten++;
        process.stdout.write(`  ✓ ${c.key}  ${c.from} → ${c.to}\n`);
      } catch (e) {
        console.error(`  ✗ ${c.key}: Firebase write failed — ${e.message}`);
      }
    }
  }

  // ── Step 3: Mark removed-from-Firebase stores as closed in snapshot ────────
  // (No Firebase write needed — they're already gone from Firebase)

  // ── Step 4: Build updated snapshot ─────────────────────────────────────────
  console.log('\nBuilding updated snapshot...');

  // Reload Firebase after writes to get fresh data (coords + status)
  const freshSnap = await db.ref('stores').get();
  const freshStores = freshSnap.exists() ? freshSnap.val() : {};

  for (const [key, s] of Object.entries(freshStores)) {
    const prev       = prevStores[key];
    const hasCoords  = s.hasCoords === true && s.latitude != null && s.longitude != null;

    // Determine final lifecycle status
    const seenRecently = s.updatedAt && (now - Number(new Date(s.updatedAt))) < STALE_SYNC_MS;
    const prevStatus       = prev?.status       ?? 'active';
    const prevMissedChecks = prev?.missedChecks  ?? 0;
    const { status, missedChecks } = nextLifecycle(prevStatus, prevMissedChecks, seenRecently);

    updatedStores[key] = {
      storeKey:            key,
      chainId:             s.chainId            || '',
      storeId:             s.storeId            || '',
      storeName:           s.storeName          || '',
      city:                s.city               || '',
      address:             s.address            || '',
      zipCode:             s.zipCode            || '',
      latitude:            hasCoords ? s.latitude  : null,
      longitude:           hasCoords ? s.longitude : null,
      hasCoords,
      geocodeConfidence:   s.geocodeConfidence  || null,
      geocodeLocationType: s.geocodeConfidence  || null,
      approximateLocation: s.approximateLocation === true,
      geocodedAt:          s.geocodedAt         || null,
      geocodeProvider:     s.geocodeProvider    || null,
      geocodeQuery:        s.geocodeQuery       || null,
      status,
      missedChecks,
      lastSeenAt:          s.updatedAt          || null,
      exportedAt:          runAt,
    };
  }

  // Preserve removed-from-Firebase stores in snapshot, marked closed
  for (const key of removedFromFirebase) {
    const prev = prevStores[key];
    updatedStores[key] = {
      ...prev,
      status:      'closed',
      missedChecks: (prev.missedChecks ?? 0) + 1,
      exportedAt:  runAt,
      removedFromFirebaseAt: runAt,
    };
  }

  const geocodedCount = Object.values(updatedStores).filter(s => s.hasCoords).length;
  const newSnapshot = {
    exportedAt:        runAt,
    version:           '1',
    totalStores:       Object.keys(updatedStores).length,
    geocodedStores:    geocodedCount,
    approximateStores: Object.values(updatedStores).filter(s => s.approximateLocation).length,
    stores:            updatedStores,
  };

  saveSnapshot(newSnapshot);
  counts.snapshotUpdated = Object.keys(updatedStores).length;

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(56));
  console.log('✅ MONTHLY UPDATE COMPLETE');
  console.log('═'.repeat(56));
  console.log(`   Lifecycle changes written:  ${counts.lifecycleWritten}`);
  console.log(`   New stores geocoded:        ${counts.geocodedNew}`);
  console.log(`   Geocode failures:           ${counts.geocodeFailed}`);
  console.log(`   Snapshot stores updated:    ${counts.snapshotUpdated}`);
  console.log(`   Snapshot path:              ${SNAPSHOT}`);

  if (geocodeFailures.length > 0) {
    console.log(`\n⚠️  Geocoding failures (${geocodeFailures.length}):`);
    for (const f of geocodeFailures) console.log(`   ${f.key}: ${f.reason}`);
  }

  if (changedAddress.length > 0) {
    console.log(`\n⚠️  ${changedAddress.length} store(s) have changed address/city.`);
    console.log('   Existing high-confidence coordinates were PRESERVED.');
    console.log('   Consider manual review and targeted re-geocode if needed:');
    console.log('   FORCE_GEOCODE=true CHAIN_FILTER=<chain> node geocode-stores.js');
  }

  if (approxReviewList.length > 0) {
    console.log(`\nℹ️  ${approxReviewList.length} APPROXIMATE store(s) still need better geocoding.`);
    console.log('   Review addresses and re-run: FORCE_GEOCODE=true node geocode-stores.js');
  }

  console.log('\nNext steps:');
  console.log('  • Verify: node verify.js --stores');
  console.log('  • Check snapshot: cat data/stores-geocoded.json | head -40');

  process.exit(counts.geocodeFailed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\n❌ Fatal error:', e.message);
  process.exit(1);
});

// scripts/audit-geo-coverage.js
// Geo Trust Stratification Audit — Firebase Realtime Database, read-only.
//
// Measures coverage, trust tier, ranking readiness, validation priority,
// and repair priority across all stores. Does not mutate production data.
//
// Usage:
//   node audit-geo-coverage.js
//   node audit-geo-coverage.js > audit-$(date +%F).json
//   node audit-geo-coverage.js | jq '.rankingReadiness'
//
// Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY,
// FIREBASE_DATABASE_URL — same env vars as the price worker.
// Source from workers/prices/.env or scripts/.env before running.
//
// Assumptions:
//   - Firebase Realtime Database. Reads the entire `stores` node in one call.
//     Classification is O(N) in memory. No per-store network calls.
//   - Legacy stores use latitude/longitude. LRS-normalized stores use lat/lng.
//     Both are supported as audit-time compatibility only — no normalization occurs.
//   - locationMeta will be absent on most stores (pre-LRS state). That is expected.
//   - Noisy-coordinate detection is deterministic and explainable. No ML, no fuzzy rules.
//   - Duplicate-coordinate check is per-chain, not global, because the same
//     shopping-mall coordinate shared by two chains is legitimate; shared by 3+
//     stores in the same chain indicates a centroid/HQ placeholder.
//   - All suspicious checks are audit-only signals. They never trigger writes.
//
// Core invariant preserved throughout:
//   Audit classifies data quality.
//   Policy decides business eligibility.
//   Presentation decides UX.

import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase }                   from 'firebase-admin/database';

// ── Configuration ─────────────────────────────────────────────────────────────

const ISRAEL_BOUNDS = { minLat: 29.4, maxLat: 33.4, minLng: 34.2, maxLng: 35.9 };

// Coordinates with fewer decimal places than this are city/centroid-level precision.
const MIN_DECIMAL_PRECISION = 4;

// Coordinates shared by this many or more stores within the same chain are
// flagged as likely HQ/centroid placeholders.
const DUPLICATE_COORD_THRESHOLD_PER_CHAIN = 3;

// Known placeholder coordinates (lat, lng as comma-joined string).
// Add entries here as they are discovered during audit runs.
const KNOWN_PLACEHOLDER_COORDS = new Set([
  // Example: '32.0853,34.7818'  (Tel Aviv city center)
]);

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {"direct_coords"|"legacy_import_coords"|"legacy_noisy_coords"|"resolved_coords"|"heuristic_coords"|"address_only"|"invalid_coords"|"missing_geo"} CoverageBucket
 *
 * Trust tier mapping (read-only reference — policy lives in the backend):
 *   certified_truth    → direct_coords, resolved_coords
 *   candidate_truth    → legacy_import_coords
 *   suspicious_candidate → legacy_noisy_coords
 *   inferred_truth     → heuristic_coords
 *   no_truth           → address_only, invalid_coords, missing_geo
 */

/**
 * @typedef {"outsideCountryBounds"|"lowPrecision"|"knownPlaceholder"|"duplicateCoords"|"chainAnomaly"|"likelySwapped"|"centroidOrHqFallback"} NoisyReason
 */

/**
 * @typedef {{
 *   outsideCountryBounds: number,
 *   lowPrecision: number,
 *   knownPlaceholder: number,
 *   duplicateCoords: number,
 *   chainAnomaly: number,
 *   likelySwapped: number,
 *   centroidOrHqFallback: number
 * }} NoisyReasonCounts
 */

/**
 * @typedef {{
 *   storesTotal: number,
 *   buckets: Record<CoverageBucket, number>,
 *   coverage: { hasAnyCoords: number, hasCleanCoords: number, hasNoisyCoords: number, addressOnly: number, missingGeo: number },
 *   trustability: { certifiedTruth: number, candidateTruth: number, suspiciousCandidate: number, inferredTruth: number, noTruth: number },
 *   rankingReadiness: { strictReady: number, softReady: number, requiresValidation: number, requiresRepair: number, excluded: number },
 *   classificationNote: { mode: string, storesWithLrsMeta: number, storesWithoutLrsMeta: number, legacyImportCoordsRequireBackfill: number, legacyNoisyCoordsRequireRepair: number },
 *   diagnostics: { legacyNoisyReasons: NoisyReasonCounts }
 * }} Report
 */

// ── Coordinate helpers ────────────────────────────────────────────────────────

/**
 * Extracts raw coordinate pair from a store record.
 * Supports both legacy (latitude/longitude) and LRS-normalized (lat/lng) field names.
 * Does not normalise, write, or prefer one schema over the other.
 *
 * @param {any} store
 * @returns {{ lat: any, lng: any }}
 */
function rawCoords(store) {
  return {
    lat: store.lat      ?? store.latitude,
    lng: store.lng      ?? store.longitude,
  };
}

/**
 * @param {any} lat
 * @param {any} lng
 * @returns {boolean}
 */
function isValidCoord(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;           // null-island placeholder
  if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return false;
  return true;
}

/** @param {number} n @returns {number} */
function decimalPlaces(n) {
  const s   = Math.abs(n).toString();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** @param {any} store @returns {boolean} */
function hasAddress(store) {
  return (store.address || '').trim().length > 0 ||
         (store.city    || '').trim().length > 0;
}

// ── Noisy-coordinate detection (audit-only) ───────────────────────────────────

/**
 * Builds a per-chain map of coordinate key → store count.
 * Used to identify shared placeholder coordinates within the same chain.
 *
 * @param {Record<string, any>} stores
 * @returns {Map<string, Map<string, number>>}  chainId → (coordKey → count)
 */
function buildPerChainCoordCounts(stores) {
  /** @type {Map<string, Map<string, number>>} */
  const byChain = new Map();

  for (const store of Object.values(stores)) {
    if (!store || typeof store !== 'object') continue;
    const chainId = String(store.chainId ?? store.chainid ?? 'unknown');
    const { lat, lng } = rawCoords(store);
    if (!isValidCoord(lat, lng)) continue;

    if (!byChain.has(chainId)) byChain.set(chainId, new Map());
    const coordMap = byChain.get(chainId);
    const key      = `${lat},${lng}`;
    coordMap.set(key, (coordMap.get(key) ?? 0) + 1);
  }

  return byChain;
}

/**
 * Returns the first noisy reason found for raw legacy/import coordinates,
 * or null if the coordinates are clean.
 *
 * Reasons are checked in priority order — most specific first.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} chainId
 * @param {Map<string, Map<string, number>>} chainCoordCounts
 * @returns {NoisyReason|null}
 */
function detectNoisyReason(lat, lng, chainId, chainCoordCounts) {
  const coordKey = `${lat},${lng}`;

  // Known bad placeholder
  if (KNOWN_PLACEHOLDER_COORDS.has(coordKey)) return 'knownPlaceholder';

  // Likely swapped lat/lng: check if swapping would place the store inside Israel
  if (
    (lat < ISRAEL_BOUNDS.minLat || lat > ISRAEL_BOUNDS.maxLat ||
     lng < ISRAEL_BOUNDS.minLng || lng > ISRAEL_BOUNDS.maxLng) &&
    lng >= ISRAEL_BOUNDS.minLat && lng <= ISRAEL_BOUNDS.maxLat &&
    lat >= ISRAEL_BOUNDS.minLng && lat <= ISRAEL_BOUNDS.maxLng
  ) {
    return 'likelySwapped';
  }

  // Outside Israel entirely (and not a swap)
  if (
    lat < ISRAEL_BOUNDS.minLat || lat > ISRAEL_BOUNDS.maxLat ||
    lng < ISRAEL_BOUNDS.minLng || lng > ISRAEL_BOUNDS.maxLng
  ) {
    return 'outsideCountryBounds';
  }

  // Coordinates shared by too many stores in the same chain
  const chainMap = chainCoordCounts.get(chainId);
  if (chainMap) {
    const count = chainMap.get(coordKey) ?? 0;
    if (count >= DUPLICATE_COORD_THRESHOLD_PER_CHAIN) {
      // Centroid or HQ: precision may still be high, but location is not store-specific.
      // Use centroidOrHqFallback (more specific) rather than duplicateCoords (generic count).
      return 'centroidOrHqFallback';
    }
    // Two stores sharing the same coordinate is unusual but not necessarily wrong;
    // flag only if above the threshold.
    if (count === 2) return 'duplicateCoords';
  }

  // Below minimum store-level precision
  if (
    decimalPlaces(lat) < MIN_DECIMAL_PRECISION ||
    decimalPlaces(lng) < MIN_DECIMAL_PRECISION
  ) {
    return 'lowPrecision';
  }

  return null;
}

// ── Classification ────────────────────────────────────────────────────────────

/**
 * Classifies one store into exactly one CoverageBucket.
 *
 * @param {any} store
 * @param {string} chainId
 * @param {Map<string, Map<string, number>>} chainCoordCounts
 * @returns {{ bucket: CoverageBucket, noisyReason: NoisyReason|null }}
 */
function classifyStore(store, chainId, chainCoordCounts) {
  const { lat, lng } = rawCoords(store);
  const meta         = store.locationMeta;
  const coordsExist  = lat !== undefined && lat !== null &&
                       lng !== undefined && lng !== null;
  const valid        = coordsExist && isValidCoord(lat, lng);

  // ── LRS-certified path (locationMeta present with recognizable provenance) ──
  if (meta && valid) {
    const src = meta.coordinateSource;
    const via = meta.resolvedVia;

    if (src === 'firebase' && via === 'import_pipeline') {
      return { bucket: 'direct_coords', noisyReason: null };
    }
    if (src === 'geocode' &&
        (via === 'geocode_service' || via === 'cached_geocode')) {
      return { bucket: 'resolved_coords', noisyReason: null };
    }
    if (src === 'heuristic') {
      return { bucket: 'heuristic_coords', noisyReason: null };
    }
    // Metadata exists but does not match any trusted provenance combination.
    // Classify conservatively — do not accidentally promote unknown metadata.
    // Fall through to raw-coordinate handling below.
  }

  // ── Coordinate fields present but invalid ──
  if (coordsExist && !valid) {
    return { bucket: 'invalid_coords', noisyReason: null };
  }

  // ── Raw legacy/import coordinates — no LRS metadata (or unrecognized metadata) ──
  if (valid) {
    const reason = detectNoisyReason(lat, lng, chainId, chainCoordCounts);
    return reason
      ? { bucket: 'legacy_noisy_coords',  noisyReason: reason }
      : { bucket: 'legacy_import_coords', noisyReason: null   };
  }

  // ── Address present but no usable coordinates ──
  if (hasAddress(store)) {
    return { bucket: 'address_only', noisyReason: null };
  }

  return { bucket: 'missing_geo', noisyReason: null };
}

// ── Report construction ───────────────────────────────────────────────────────

/** @returns {Report} */
function emptyReport() {
  return {
    storesTotal: 0,
    buckets: {
      direct_coords:        0,
      legacy_import_coords: 0,
      legacy_noisy_coords:  0,
      resolved_coords:      0,
      heuristic_coords:     0,
      address_only:         0,
      invalid_coords:       0,
      missing_geo:          0,
    },
    coverage: {
      hasAnyCoords:   0,
      hasCleanCoords: 0,
      hasNoisyCoords: 0,
      addressOnly:    0,
      missingGeo:     0,
    },
    trustability: {
      certifiedTruth:      0,
      candidateTruth:      0,
      suspiciousCandidate: 0,
      inferredTruth:       0,
      noTruth:             0,
    },
    rankingReadiness: {
      strictReady:        0,
      softReady:          0,
      requiresValidation: 0,
      requiresRepair:     0,
      excluded:           0,
    },
    classificationNote: {
      mode:                              'pre_lrs_inference',
      storesWithLrsMeta:                 0,
      storesWithoutLrsMeta:              0,
      legacyImportCoordsRequireBackfill: 0,
      legacyNoisyCoordsRequireRepair:    0,
    },
    diagnostics: {
      legacyNoisyReasons: {
        outsideCountryBounds: 0,
        lowPrecision:         0,
        knownPlaceholder:     0,
        duplicateCoords:      0,
        chainAnomaly:         0,
        likelySwapped:        0,
        centroidOrHqFallback: 0,
      },
    },
  };
}

// Bucket membership sets — defined once, used by accumulate().
const CLEAN_BUCKETS  = new Set(['direct_coords', 'legacy_import_coords', 'resolved_coords']);
const NOISY_BUCKETS  = new Set(['legacy_noisy_coords', 'heuristic_coords', 'invalid_coords']);
const ANY_COORD_BUCKETS = new Set([...CLEAN_BUCKETS, ...NOISY_BUCKETS]);
const STRICT_BUCKETS = new Set(['direct_coords', 'resolved_coords']);
const SOFT_EXTRA     = new Set(['legacy_import_coords']);
const REPAIR_BUCKETS = new Set(['legacy_noisy_coords', 'invalid_coords']);
const EXCLUDED_BUCKETS = new Set(['heuristic_coords', 'address_only', 'missing_geo']);

/**
 * Adds one store's classification into a report in-place.
 *
 * @param {Report} r
 * @param {CoverageBucket} bucket
 * @param {NoisyReason|null} noisyReason
 * @param {boolean} hasLrsMeta
 */
function accumulate(r, bucket, noisyReason, hasLrsMeta) {
  r.storesTotal++;
  r.buckets[bucket]++;

  // coverage
  if (ANY_COORD_BUCKETS.has(bucket))  r.coverage.hasAnyCoords++;
  if (CLEAN_BUCKETS.has(bucket))      r.coverage.hasCleanCoords++;
  if (NOISY_BUCKETS.has(bucket))      r.coverage.hasNoisyCoords++;
  if (bucket === 'address_only')      r.coverage.addressOnly++;
  if (bucket === 'missing_geo')       r.coverage.missingGeo++;

  // trustability
  if (STRICT_BUCKETS.has(bucket))          r.trustability.certifiedTruth++;
  if (bucket === 'legacy_import_coords')   r.trustability.candidateTruth++;
  if (bucket === 'legacy_noisy_coords')    r.trustability.suspiciousCandidate++;
  if (bucket === 'heuristic_coords')       r.trustability.inferredTruth++;
  if (bucket === 'address_only' || bucket === 'invalid_coords' || bucket === 'missing_geo')
                                           r.trustability.noTruth++;

  // ranking readiness
  if (STRICT_BUCKETS.has(bucket))                        r.rankingReadiness.strictReady++;
  if (STRICT_BUCKETS.has(bucket) || SOFT_EXTRA.has(bucket)) r.rankingReadiness.softReady++;
  if (bucket === 'legacy_import_coords')                 r.rankingReadiness.requiresValidation++;
  if (REPAIR_BUCKETS.has(bucket))                        r.rankingReadiness.requiresRepair++;
  if (EXCLUDED_BUCKETS.has(bucket))                      r.rankingReadiness.excluded++;

  // classification note
  if (hasLrsMeta) r.classificationNote.storesWithLrsMeta++;
  else            r.classificationNote.storesWithoutLrsMeta++;
  if (bucket === 'legacy_import_coords') r.classificationNote.legacyImportCoordsRequireBackfill++;
  if (bucket === 'legacy_noisy_coords')  r.classificationNote.legacyNoisyCoordsRequireRepair++;

  // diagnostics
  if (noisyReason) r.diagnostics.legacyNoisyReasons[noisyReason]++;
}

/**
 * Merges a chain report into the global report in-place.
 *
 * @param {Report} global
 * @param {Report} chain
 */
function mergeInto(global, chain) {
  global.storesTotal += chain.storesTotal;

  for (const k of Object.keys(chain.buckets))          global.buckets[k]          += chain.buckets[k];
  for (const k of Object.keys(chain.coverage))         global.coverage[k]         += chain.coverage[k];
  for (const k of Object.keys(chain.trustability))     global.trustability[k]     += chain.trustability[k];
  for (const k of Object.keys(chain.rankingReadiness)) global.rankingReadiness[k] += chain.rankingReadiness[k];
  for (const k of Object.keys(chain.diagnostics.legacyNoisyReasons))
    global.diagnostics.legacyNoisyReasons[k] += chain.diagnostics.legacyNoisyReasons[k];

  const gn = global.classificationNote;
  const cn = chain.classificationNote;
  gn.storesWithLrsMeta                 += cn.storesWithLrsMeta;
  gn.storesWithoutLrsMeta              += cn.storesWithoutLrsMeta;
  gn.legacyImportCoordsRequireBackfill += cn.legacyImportCoordsRequireBackfill;
  gn.legacyNoisyCoordsRequireRepair    += cn.legacyNoisyCoordsRequireRepair;
}

/**
 * Resolves the classificationNote.mode string after all stores are counted.
 *
 * @param {Report} r
 */
function resolveMode(r) {
  const { storesWithLrsMeta, storesWithoutLrsMeta } = r.classificationNote;
  if (storesWithLrsMeta === 0)      r.classificationNote.mode = 'pre_lrs_inference';
  else if (storesWithoutLrsMeta === 0) r.classificationNote.mode = 'full_lrs';
  else                              r.classificationNote.mode = 'mixed_lrs_and_legacy';
}

// ── Firebase ──────────────────────────────────────────────────────────────────

function initFirebase() {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
    FIREBASE_DATABASE_URL,
  } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL ||
      !FIREBASE_PRIVATE_KEY || !FIREBASE_DATABASE_URL) {
    process.stderr.write(
      'ERROR: Missing required FIREBASE_* environment variables.\n' +
      '       Source workers/prices/.env or scripts/.env before running.\n'
    );
    process.exit(2);
  }

  if (getApps().length > 0) return getDatabase();

  try {
    initializeApp({
      credential:  cert({
        projectId:   FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey:  FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      databaseURL: FIREBASE_DATABASE_URL,
    });
    return getDatabase();
  } catch (err) {
    process.stderr.write(`ERROR: Firebase initialisation failed: ${err.message}\n`);
    process.exit(2);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = initFirebase();

  let rawStores;
  try {
    const snap = await db.ref('stores').once('value');
    rawStores   = snap.val();
  } catch (err) {
    process.stderr.write(`ERROR: Failed to read stores node: ${err.message}\n`);
    process.exit(1);
  }

  if (!rawStores || typeof rawStores !== 'object') {
    process.stderr.write('ERROR: stores node is empty or not an object.\n');
    process.exit(1);
  }

  // Single pass to build per-chain duplicate-coordinate counts.
  // Required before classification so the noisy-reason check can reference counts.
  const chainCoordCounts = buildPerChainCoordCounts(rawStores);

  const global = emptyReport();
  /** @type {Record<string, Report>} */
  const chains = {};

  for (const store of Object.values(rawStores)) {
    if (!store || typeof store !== 'object') continue;

    const chainId = String(store.chainId ?? store.chainid ?? 'unknown');
    if (!chains[chainId]) chains[chainId] = emptyReport();

    const { bucket, noisyReason } = classifyStore(store, chainId, chainCoordCounts);
    const hasLrsMeta = !!store.locationMeta;

    accumulate(chains[chainId], bucket, noisyReason, hasLrsMeta);
  }

  for (const chainReport of Object.values(chains)) {
    mergeInto(global, chainReport);
  }

  resolveMode(global);
  for (const chainReport of Object.values(chains)) resolveMode(chainReport);

  const output = {
    auditedAt:          new Date().toISOString(),
    lrsVersion:         1,
    storesTotal:        global.storesTotal,
    buckets:            global.buckets,
    coverage:           global.coverage,
    trustability:       global.trustability,
    rankingReadiness:   global.rankingReadiness,
    classificationNote: global.classificationNote,
    diagnostics:        global.diagnostics,
    chains,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(`ERROR: Unhandled error: ${err.message}\n`);
  process.exit(1);
});

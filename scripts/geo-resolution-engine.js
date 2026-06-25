// scripts/geo-resolution-engine.js
// Geo Resolution Engine v1 — candidate generation only.
//
// Transforms store address data from Firebase into GeoResolutionCandidate objects:
// multiple coordinate hypotheses per store, scored for confidence and uncertainty.
//
// This module MUST NOT:
//   - write to Firebase
//   - select a single truth (selectedCandidate is always null in v1)
//   - persist any output to disk
//   - introduce external state or mutation
//   - perform backfill, ranking, or validation
//
// Pipeline position:
//   Audit (Layer 1) → Resolution (Layer 2, this file) → Validation (Layer 3, future)
//   → Backfill (Layer 4, future) → Ranking (Layer 5, future)
//
// Usage:
//   node --env-file=../workers/prices/.env geo-resolution-engine.js
//   node --env-file=../workers/prices/.env geo-resolution-engine.js > candidates-$(date +%F).json
//   node --env-file=../workers/prices/.env geo-resolution-engine.js --chain=7290058140886
//   node --env-file=../workers/prices/.env geo-resolution-engine.js --limit=10 --verbose
//
// Providers (in priority order):
//   1. Google Maps Geocoding API  (GOOGLE_MAPS_API_KEY env var, optional)
//   2. Nominatim / OpenStreetMap  (no key required, rate-limited to 1 req/s)
//
// If neither provider is available, stores are classified as 'insufficient_input'
// or 'failed' with an empty candidate set. The engine never fabricates coordinates.
//
// Environment variables:
//   GOOGLE_MAPS_API_KEY   — optional; enables Google provider
//   GEOCODE_CONCURRENCY   — parallel store resolution limit (default: 2)
//   GEOCODE_TIMEOUT_MS    — per-request timeout in ms (default: 8000)
//   NOMINATIM_USER_AGENT  — required for Nominatim (default: family-shopping-geo-engine/1)
//
// Hard invariant:
//   selectedCandidate MUST remain null in v1.
//   Truth is validated, not generated.

import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase }                   from 'firebase-admin/database';

// ── Configuration ─────────────────────────────────────────────────────────────

const ISRAEL_BOUNDS = { minLat: 29.4, maxLat: 33.4, minLng: 34.2, maxLng: 35.9 };

const CONFIG = {
  googleApiKey:    process.env.GOOGLE_MAPS_API_KEY  ?? null,
  concurrency:     Number(process.env.GEOCODE_CONCURRENCY ?? 2),
  timeoutMs:       Number(process.env.GEOCODE_TIMEOUT_MS  ?? 8000),
  nominatimAgent:  process.env.NOMINATIM_USER_AGENT ?? 'family-shopping-geo-engine/1',
  nominatimDelay:  1100,  // ms between Nominatim requests (policy: max 1 req/s)
};

// ── CLI args ──────────────────────────────────────────────────────────────────

const ARGS = (() => {
  const a = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    a[k] = v ?? true;
  }
  return a;
})();

const FILTER_CHAIN = ARGS.chain   ?? null;
const LIMIT        = ARGS.limit   ? Number(ARGS.limit) : null;
const VERBOSE      = !!ARGS.verbose;

// ── Types (JSDoc) ─────────────────────────────────────────────────────────────

/**
 * @typedef {"google"|"nominatim"|"manual"|"unknown"} Provider
 */

/**
 * @typedef {"exact_address"|"street_level"|"city_centroid"|"poi_match"|"mall_match"|"ambiguous"|"failed"} MatchType
 */

/**
 * @typedef {"resolved_high_confidence"|"resolved_candidate"|"ambiguous"|"failed"|"insufficient_input"} ResolutionStatus
 */

/**
 * @typedef {{
 *   lat: number,
 *   lng: number,
 *   provider: Provider,
 *   confidence: number,
 *   uncertaintyScore: number,
 *   matchType: MatchType,
 *   formattedAddress?: string,
 *   rawProviderType?: string,
 *   distanceFromExpectedCityKm?: number
 * }} GeoCandidate
 */

/**
 * @typedef {{
 *   storeId: string,
 *   chainId: string,
 *   input: { storeName?: string, address?: string, city?: string },
 *   normalizedAddress: string|null,
 *   candidates: GeoCandidate[],
 *   resolutionStatus: ResolutionStatus,
 *   selectedCandidate: null,
 *   failureReason?: string,
 *   version: 1
 * }} GeoResolutionCandidate
 */

// ── Address normalization ─────────────────────────────────────────────────────

const HEBREW_STREET_SUFFIXES = [
  'רחוב', 'רח\'', 'שד\'', 'שדרות', 'דרך', 'כיכר', 'סמטא', 'גשר', 'מעלה',
];

const CITY_NORMALIZATIONS = new Map([
  ['תל אביב יפו', 'תל אביב'],
  ['תל-אביב', 'תל אביב'],
  ['ירושלים', 'Jerusalem'],
  ['בני ברק', 'בני ברק'],
  ['פתח תקוה', 'פתח תקווה'],
]);

/**
 * Normalizes a Hebrew/mixed address string for geocoding.
 * Does not transliterate — providers handle Hebrew natively.
 *
 * @param {{ storeName?: string, address?: string, city?: string }} input
 * @returns {string|null}
 */
function normalizeAddress(input) {
  const parts = [];

  if (input.address) {
    let addr = input.address.trim();
    // Remove leading street-type prefix if duplicated in the string
    for (const sfx of HEBREW_STREET_SUFFIXES) {
      if (addr.startsWith(sfx + ' ')) { addr = addr.slice(sfx.length).trim(); break; }
    }
    if (addr.length > 0) parts.push(addr);
  }

  if (input.city) {
    const city = CITY_NORMALIZATIONS.get(input.city.trim()) ?? input.city.trim();
    if (city.length > 0) parts.push(city);
  }

  parts.push('ישראל');

  const result = parts.join(', ');
  // Require at least address or city (not just "ישראל")
  return parts.length > 1 ? result : null;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

/**
 * Haversine distance in km between two points.
 *
 * @param {number} lat1 @param {number} lng1
 * @param {number} lat2 @param {number} lng2
 * @returns {number}
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const dL = (lat2 - lat1) * Math.PI / 180;
  const dN = (lng2 - lng1) * Math.PI / 180;
  const a  = Math.sin(dL / 2) ** 2 +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
             Math.sin(dN / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** @param {number} lat @param {number} lng @returns {boolean} */
function isInsideIsrael(lat, lng) {
  return lat >= ISRAEL_BOUNDS.minLat && lat <= ISRAEL_BOUNDS.maxLat &&
         lng >= ISRAEL_BOUNDS.minLng && lng <= ISRAEL_BOUNDS.maxLng;
}

// ── Candidate scoring ─────────────────────────────────────────────────────────

/**
 * Approximate city center coordinates for uncertainty estimation.
 * Used only when distanceFromExpectedCityKm cannot be computed from provider data.
 */
const CITY_APPROX_COORDS = new Map([
  ['תל אביב',       { lat: 32.0853, lng: 34.7818 }],
  ['tel aviv',      { lat: 32.0853, lng: 34.7818 }],
  ['ירושלים',       { lat: 31.7683, lng: 35.2137 }],
  ['jerusalem',     { lat: 31.7683, lng: 35.2137 }],
  ['חיפה',          { lat: 32.7940, lng: 34.9896 }],
  ['haifa',         { lat: 32.7940, lng: 34.9896 }],
  ['באר שבע',       { lat: 31.2518, lng: 34.7913 }],
  ['beersheba',     { lat: 31.2518, lng: 34.7913 }],
  ['ראשון לציון',   { lat: 31.9730, lng: 34.7925 }],
  ['פתח תקווה',     { lat: 32.0879, lng: 34.8878 }],
  ['נתניה',         { lat: 32.3215, lng: 34.8532 }],
  ['אשדוד',         { lat: 31.8044, lng: 34.6553 }],
  ['אשקלון',        { lat: 31.6688, lng: 34.5743 }],
  ['רמת גן',        { lat: 32.0700, lng: 34.8238 }],
  ['בני ברק',       { lat: 32.0833, lng: 34.8333 }],
  ['חולון',         { lat: 32.0107, lng: 34.7796 }],
  ['רחובות',        { lat: 31.8956, lng: 34.8071 }],
  ['הרצליה',        { lat: 32.1663, lng: 34.8438 }],
  ['מודיעין',       { lat: 31.8979, lng: 35.0107 }],
  ['כפר סבא',       { lat: 32.1784, lng: 34.9078 }],
]);

/**
 * Maps a provider location type string to a MatchType.
 *
 * @param {string} rawType
 * @param {Provider} provider
 * @returns {MatchType}
 */
function mapToMatchType(rawType, provider) {
  if (provider === 'google') {
    switch (rawType) {
      case 'ROOFTOP':            return 'exact_address';
      case 'RANGE_INTERPOLATED': return 'street_level';
      case 'GEOMETRIC_CENTER':   return 'city_centroid';
      case 'APPROXIMATE':        return 'city_centroid';
      default:                   return 'ambiguous';
    }
  }
  if (provider === 'nominatim') {
    switch (rawType) {
      case 'house':
      case 'building':          return 'exact_address';
      case 'street':
      case 'road':              return 'street_level';
      case 'city':
      case 'town':
      case 'village':
      case 'suburb':
      case 'neighbourhood':     return 'city_centroid';
      case 'commercial':
      case 'retail':
      case 'supermarket':       return 'poi_match';
      case 'mall':
      case 'marketplace':       return 'mall_match';
      default:                  return 'ambiguous';
    }
  }
  return 'ambiguous';
}

/**
 * Scores a raw geocode result into confidence and uncertaintyScore.
 *
 * confidence    = provider belief in its own result (0..1)
 * uncertaintyScore = system-level ambiguity estimate (0..1)
 *                    Higher = less trustworthy for ranking purposes.
 *
 * @param {MatchType} matchType
 * @param {boolean} insideIsrael
 * @param {number|null} distanceKm
 * @returns {{ confidence: number, uncertaintyScore: number }}
 */
function scoreCandidate(matchType, insideIsrael, distanceKm) {
  const BASE_CONFIDENCE = {
    exact_address:  0.92,
    street_level:   0.75,
    poi_match:      0.80,
    mall_match:     0.72,
    city_centroid:  0.45,
    ambiguous:      0.30,
    failed:         0.00,
  };

  let confidence = BASE_CONFIDENCE[matchType] ?? 0.20;

  // Outside Israel is a hard signal — confidence drops sharply
  if (!insideIsrael) confidence = Math.min(confidence, 0.20);

  // Distance from expected city penalizes confidence
  let distancePenalty = 0;
  if (distanceKm !== null) {
    if (distanceKm > 50)      distancePenalty = 0.40;
    else if (distanceKm > 20) distancePenalty = 0.25;
    else if (distanceKm > 10) distancePenalty = 0.10;
    else if (distanceKm > 5)  distancePenalty = 0.05;
  }
  confidence = Math.max(0, confidence - distancePenalty);

  // uncertaintyScore: inverse of confidence with amplification for weak signals
  let uncertaintyScore;
  if (matchType === 'city_centroid' || matchType === 'ambiguous') {
    uncertaintyScore = 0.80 + (1 - confidence) * 0.20;
  } else if (!insideIsrael) {
    uncertaintyScore = 0.95;
  } else {
    uncertaintyScore = Math.max(0.05, 1 - confidence);
  }

  return {
    confidence:     Math.round(confidence      * 1000) / 1000,
    uncertaintyScore: Math.round(uncertaintyScore * 1000) / 1000,
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Fetches a URL with timeout. Returns parsed JSON or throws.
 *
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<any>}
 */
async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Google Maps provider ──────────────────────────────────────────────────────

/**
 * Queries Google Maps Geocoding API for a normalized address.
 * Returns up to 3 candidates (Google may return multiple results).
 *
 * @param {string} normalizedAddress
 * @param {string|null} expectedCity
 * @returns {Promise<GeoCandidate[]>}
 */
async function geocodeGoogle(normalizedAddress, expectedCity) {
  if (!CONFIG.googleApiKey) return [];

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${
    encodeURIComponent(normalizedAddress)
  }&region=il&language=iw&key=${CONFIG.googleApiKey}`;

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    warn(`Google geocode failed for "${normalizedAddress}": ${err.message}`);
    return [];
  }

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    warn(`Google returned status ${data.status} for "${normalizedAddress}"`);
  }

  const results = (data.results ?? []).slice(0, 3);
  const candidates = [];

  for (const r of results) {
    const lat = r.geometry?.location?.lat;
    const lng = r.geometry?.location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;

    const rawType  = r.geometry?.location_type ?? 'UNKNOWN';
    const matchType = mapToMatchType(rawType, 'google');
    const inside    = isInsideIsrael(lat, lng);

    let distanceKm = null;
    if (expectedCity) {
      const cityKey = expectedCity.trim().toLowerCase();
      const approx  = CITY_APPROX_COORDS.get(expectedCity.trim()) ??
                      CITY_APPROX_COORDS.get(cityKey);
      if (approx) distanceKm = haversineKm(lat, lng, approx.lat, approx.lng);
    }

    const { confidence, uncertaintyScore } = scoreCandidate(matchType, inside, distanceKm);

    candidates.push({
      lat,
      lng,
      provider:           'google',
      confidence,
      uncertaintyScore,
      matchType,
      formattedAddress:   r.formatted_address ?? undefined,
      rawProviderType:    rawType,
      ...(distanceKm !== null ? { distanceFromExpectedCityKm: Math.round(distanceKm * 10) / 10 } : {}),
    });
  }

  return candidates;
}

// ── Nominatim provider ────────────────────────────────────────────────────────

let _lastNominatimCall = 0;

/**
 * Queries Nominatim with a mandatory ≥1s delay between calls (OSM policy).
 *
 * @param {string} normalizedAddress
 * @param {string|null} expectedCity
 * @returns {Promise<GeoCandidate[]>}
 */
async function geocodeNominatim(normalizedAddress, expectedCity) {
  // Enforce rate limit
  const now   = Date.now();
  const since = now - _lastNominatimCall;
  if (since < CONFIG.nominatimDelay) {
    await sleep(CONFIG.nominatimDelay - since);
  }
  _lastNominatimCall = Date.now();

  const url = `https://nominatim.openstreetmap.org/search?q=${
    encodeURIComponent(normalizedAddress)
  }&format=jsonv2&countrycodes=il&limit=3&addressdetails=1`;

  let data;
  try {
    data = await fetchJson(url, { 'User-Agent': CONFIG.nominatimAgent });
  } catch (err) {
    warn(`Nominatim geocode failed for "${normalizedAddress}": ${err.message}`);
    return [];
  }

  if (!Array.isArray(data)) return [];

  const candidates = [];

  for (const r of data.slice(0, 3)) {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const rawType   = r.type ?? r.category ?? 'unknown';
    const matchType  = mapToMatchType(rawType, 'nominatim');
    const inside     = isInsideIsrael(lat, lng);

    let distanceKm = null;
    if (expectedCity) {
      const approx = CITY_APPROX_COORDS.get(expectedCity.trim()) ??
                     CITY_APPROX_COORDS.get(expectedCity.trim().toLowerCase());
      if (approx) distanceKm = haversineKm(lat, lng, approx.lat, approx.lng);
    }

    const { confidence, uncertaintyScore } = scoreCandidate(matchType, inside, distanceKm);

    candidates.push({
      lat,
      lng,
      provider:          'nominatim',
      confidence,
      uncertaintyScore,
      matchType,
      formattedAddress:  r.display_name ?? undefined,
      rawProviderType:   rawType,
      ...(distanceKm !== null ? { distanceFromExpectedCityKm: Math.round(distanceKm * 10) / 10 } : {}),
    });
  }

  return candidates;
}

// ── Resolution status ─────────────────────────────────────────────────────────

/**
 * Derives the overall ResolutionStatus from a candidate set.
 *
 * @param {GeoCandidate[]} candidates
 * @param {boolean} hadSufficientInput
 * @returns {ResolutionStatus}
 */
function deriveStatus(candidates, hadSufficientInput) {
  if (!hadSufficientInput)   return 'insufficient_input';
  if (candidates.length === 0) return 'failed';

  const best = candidates.reduce((a, b) => a.confidence > b.confidence ? a : b);

  if (best.confidence >= 0.85 && best.uncertaintyScore <= 0.20) return 'resolved_high_confidence';
  if (best.confidence >= 0.50 && best.uncertaintyScore <= 0.60) return 'resolved_candidate';
  if (candidates.length > 1)                                    return 'ambiguous';
  if (best.confidence < 0.30)                                    return 'failed';
  return 'resolved_candidate';
}

// ── Store resolution ──────────────────────────────────────────────────────────

/**
 * Resolves a single store into a GeoResolutionCandidate.
 * Never writes, never selects truth, never throws (all errors are captured in the output).
 *
 * @param {string} storeKey   — Firebase key (chainId_storeId)
 * @param {any}    store      — raw Firebase store object
 * @returns {Promise<GeoResolutionCandidate>}
 */
async function resolveStore(storeKey, store) {
  const storeId = String(store.storeId ?? store.storeid ?? storeKey);
  const chainId = String(store.chainId ?? store.chainid ?? 'unknown');

  const input = {
    storeName: store.storeName ?? store.storename ?? undefined,
    address:   store.address   ?? undefined,
    city:      store.city      ?? undefined,
  };

  const normalizedAddress = normalizeAddress(input);
  const hadSufficientInput = normalizedAddress !== null;

  /** @type {GeoResolutionCandidate} */
  const result = {
    storeId,
    chainId,
    input,
    normalizedAddress,
    candidates:        [],
    resolutionStatus:  'insufficient_input',
    selectedCandidate: null,   // HARD RULE: never set in v1
    version:           1,
  };

  if (!hadSufficientInput) {
    result.failureReason = 'no_address_or_city';
    return result;
  }

  const expectedCity = input.city ?? null;

  // Try Google first (higher quality), fall back to Nominatim
  let googleCandidates = [];
  let nominatimCandidates = [];

  try {
    googleCandidates = await geocodeGoogle(normalizedAddress, expectedCity);
  } catch (err) {
    warn(`Unexpected error from Google for store ${storeId}: ${err.message}`);
  }

  try {
    nominatimCandidates = await geocodeNominatim(normalizedAddress, expectedCity);
  } catch (err) {
    warn(`Unexpected error from Nominatim for store ${storeId}: ${err.message}`);
  }

  // Merge: Google first (already deduplicated by provider)
  result.candidates = [...googleCandidates, ...nominatimCandidates];
  result.resolutionStatus = deriveStatus(result.candidates, hadSufficientInput);

  if (result.candidates.length === 0) {
    result.failureReason = 'no_results_from_any_provider';
  }

  return result;
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

/**
 * Runs an async task producer through a fixed-concurrency pool.
 * Yields results in completion order (not input order).
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @param {(done: number, total: number) => void} onProgress
 * @returns {Promise<T[]>}
 */
async function runPool(tasks, concurrency, onProgress) {
  const results = [];
  let idx    = 0;
  let done   = 0;
  const total = tasks.length;

  async function worker() {
    while (idx < total) {
      const i    = idx++;
      const item = await tasks[i]();
      results.push(item);
      done++;
      onProgress(done, total);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return results;
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
      '       Source workers/prices/.env before running.\n'
    );
    process.exit(2);
  }

  if (getApps().length > 0) return getDatabase();

  initializeApp({
    credential:  cert({
      projectId:   FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey:  FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    databaseURL: FIREBASE_DATABASE_URL,
  });
  return getDatabase();
}

// ── Summary ───────────────────────────────────────────────────────────────────

/**
 * @param {GeoResolutionCandidate[]} results
 * @returns {object}
 */
function buildSummary(results) {
  const byStatus = {};
  const byChain  = {};
  let totalCandidates = 0;

  for (const r of results) {
    byStatus[r.resolutionStatus] = (byStatus[r.resolutionStatus] ?? 0) + 1;
    if (!byChain[r.chainId]) byChain[r.chainId] = { total: 0, resolved: 0, failed: 0 };
    byChain[r.chainId].total++;
    totalCandidates += r.candidates.length;
    if (r.resolutionStatus === 'resolved_high_confidence' ||
        r.resolutionStatus === 'resolved_candidate') {
      byChain[r.chainId].resolved++;
    } else {
      byChain[r.chainId].failed++;
    }
  }

  const resolved = (byStatus['resolved_high_confidence'] ?? 0) +
                   (byStatus['resolved_candidate']        ?? 0);

  return {
    storesTotal:              results.length,
    resolved,
    resolutionRate:           results.length ? Math.round(resolved / results.length * 1000) / 1000 : 0,
    avgCandidatesPerStore:    results.length ? Math.round(totalCandidates / results.length * 100) / 100 : 0,
    byStatus,
    byChain,
    providers: {
      google:    CONFIG.googleApiKey ? 'enabled' : 'disabled (no GOOGLE_MAPS_API_KEY)',
      nominatim: 'enabled',
    },
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function warn(msg) {
  if (VERBOSE) process.stderr.write(`[WARN] ${msg}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = initFirebase();

  process.stderr.write('Reading stores from Firebase...\n');

  let rawStores;
  try {
    const snap = await db.ref('stores').once('value');
    rawStores   = snap.val();
  } catch (err) {
    process.stderr.write(`ERROR: Failed to read stores: ${err.message}\n`);
    process.exit(1);
  }

  if (!rawStores || typeof rawStores !== 'object') {
    process.stderr.write('ERROR: stores node is empty.\n');
    process.exit(1);
  }

  // Filter and limit
  let entries = Object.entries(rawStores).filter(([, s]) => s && typeof s === 'object');

  if (FILTER_CHAIN) {
    entries = entries.filter(([, s]) =>
      String(s.chainId ?? s.chainid ?? '') === FILTER_CHAIN
    );
    process.stderr.write(`Filtered to chain ${FILTER_CHAIN}: ${entries.length} stores\n`);
  }

  if (LIMIT) {
    entries = entries.slice(0, LIMIT);
    process.stderr.write(`Limited to first ${LIMIT} stores\n`);
  }

  process.stderr.write(
    `Resolving ${entries.length} stores ` +
    `[concurrency=${CONFIG.concurrency}, timeout=${CONFIG.timeoutMs}ms, ` +
    `google=${CONFIG.googleApiKey ? 'yes' : 'no'}]\n`
  );

  const tasks = entries.map(([key, store]) => () => resolveStore(key, store));

  const results = await runPool(tasks, CONFIG.concurrency, (done, total) => {
    if (done % 10 === 0 || done === total) {
      process.stderr.write(`  ${done}/${total} stores resolved\n`);
    }
  });

  const output = {
    engineVersion:  1,
    engineName:     'geo_resolution_engine',
    generatedAt:    new Date().toISOString(),
    summary:        buildSummary(results),
    stores:         results,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`ERROR: Unhandled error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

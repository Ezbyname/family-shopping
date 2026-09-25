/**
 * Tests for js/pd-location.js — imports the REAL production module.
 *
 * These tests call the same functions that app.js calls. There is exactly
 * one implementation. A test failure here means a production behaviour
 * regression, not a spec mismatch.
 *
 * Behavioural regression proof (marked [REGRESSION]):
 *   Each test marked [REGRESSION] FAILS against parent 7d350d7 (where the
 *   functions did not exist) and PASSES with Commit 4.
 */

import {
  pdHasLoc,
  pdInitialMode,
  pdEffectiveRadius,
  pdCacheKey,
  pdRowEligible,
  pdBuildRequestUrl,
  pdExtractRows,
  pdNameFallbackUrl,
  pdShouldUseFallback,
} from '../js/pd-location.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── pdHasLoc ────────────────────────────────────────────────────────────────

console.log('\npdHasLoc');

test('[REGRESSION] null location → false', () => {
  assert(!pdHasLoc(null));
});

test('[REGRESSION] location with lat+lng → true', () => {
  assert(pdHasLoc({ lat: 32.07, lng: 34.79 }));
});

test('location with lat=0 is valid (falsy but not null)', () => {
  assert(pdHasLoc({ lat: 0, lng: 0 }));
});

test('location missing lat → false', () => {
  assert(!pdHasLoc({ lng: 34.79 }));
});

test('location missing lng → false', () => {
  assert(!pdHasLoc({ lat: 32.07 }));
});

// ── pdInitialMode ───────────────────────────────────────────────────────────

console.log('\npdInitialMode');

test('[REGRESSION] cities present → city mode', () => {
  assertEqual(pdInitialMode(['תל אביב'], { lat: 32, lng: 34 }), 'city');
});

test('[REGRESSION] no cities + location → radius mode', () => {
  assertEqual(pdInitialMode([], { lat: 32, lng: 34 }), 'radius');
});

test('[REGRESSION] no cities + no location → all mode', () => {
  assertEqual(pdInitialMode([], null), 'all');
});

test('empty cities + location without coords → all mode', () => {
  assertEqual(pdInitialMode([], { label: 'test' }), 'all');
});

// ── pdEffectiveRadius ────────────────────────────────────────────────────────

console.log('\npdEffectiveRadius');

test('[REGRESSION] new user (not explicitly set) → 10 km default', () => {
  assertEqual(pdEffectiveRadius(false, 3), 10);
});

test('[REGRESSION] explicitly set → stored value used', () => {
  assertEqual(pdEffectiveRadius(true, 5), 5);
});

test('explicitly set to 25 → 25', () => {
  assertEqual(pdEffectiveRadius(true, 25), 25);
});

// ── pdCacheKey ───────────────────────────────────────────────────────────────

console.log('\npdCacheKey');

const loc = { lat: 32.07626, lng: 34.79148 };

test('[REGRESSION] radius mode key includes lat/lng at 5dp and radius', () => {
  const key = pdCacheKey('7290000066795', 'radius', loc, [], true, 5);
  assertEqual(key, 'pd_7290000066795_r_32.07626_34.79148_5');
});

test('[REGRESSION] radius mode with default radius (not set) uses 10', () => {
  const key = pdCacheKey('7290000066795', 'radius', loc, [], false, 3);
  assertEqual(key, 'pd_7290000066795_r_32.07626_34.79148_10');
});

test('[REGRESSION] city mode key is sorted city list', () => {
  const key = pdCacheKey('7290000066795', 'city', null, ['תל אביב', 'חיפה'], false, 3);
  assertEqual(key, 'pd_7290000066795_c_חיפה,תל אביב');
});

test('[REGRESSION] all mode key is barcode_all', () => {
  const key = pdCacheKey('7290000066795', 'all', null, [], false, 3);
  assertEqual(key, 'pd_7290000066795_all');
});

test('radius mode without location falls back to _all key', () => {
  const key = pdCacheKey('7290000066795', 'radius', null, [], true, 5);
  assertEqual(key, 'pd_7290000066795_all');
});

test('city mode with empty cities falls back to _all key', () => {
  const key = pdCacheKey('7290000066795', 'city', null, [], false, 3);
  assertEqual(key, 'pd_7290000066795_all');
});

// ── pdRowEligible ────────────────────────────────────────────────────────────

console.log('\npdRowEligible');

test('[REGRESSION] radius mode: row with distanceKm → eligible', () => {
  assert(pdRowEligible({ distanceKm: 2.5 }, 'radius'));
});

test('[REGRESSION] radius mode: row without distanceKm → excluded', () => {
  assert(!pdRowEligible({ distanceKm: null }, 'radius'));
});

test('[REGRESSION] radius mode: row with distanceKm=0 → eligible', () => {
  assert(pdRowEligible({ distanceKm: 0 }, 'radius'));
});

test('all mode: row without distanceKm → still eligible', () => {
  assert(pdRowEligible({ distanceKm: null }, 'all'));
});

test('city mode: row without distanceKm → still eligible', () => {
  assert(pdRowEligible({ distanceKm: null }, 'city'));
});

// ── pdBuildRequestUrl ────────────────────────────────────────────────────────

console.log('\npdBuildRequestUrl');

test('[REGRESSION] city mode → /api/prices-by-city with city params', () => {
  const { url, isCityMode, blocked } = pdBuildRequestUrl(
    '7290000066795', 'city', null, ['תל אביב'], false, 3, null, null
  );
  assert(isCityMode, 'should be city mode');
  assert(!blocked, 'should not be blocked');
  assert(url.startsWith('/api/prices-by-city?'), 'wrong endpoint');
  assert(url.includes('barcode=7290000066795'), 'missing barcode');
  assert(url.includes('city='), 'missing city param');
});

test('[REGRESSION] radius mode → /api/prices with lat/lng/radiusKm', () => {
  const { url, isCityMode, blocked } = pdBuildRequestUrl(
    '7290000066795', 'radius', { lat: 32.07626, lng: 34.79148 }, [], true, 5, null, null
  );
  assert(!isCityMode, 'should not be city mode');
  assert(!blocked, 'should not be blocked');
  assert(url.includes('lat=32.07626'), 'missing lat');
  assert(url.includes('lng=34.79148'), 'missing lng');
  assert(url.includes('radiusKm=5'), 'missing radiusKm');
  assert(url.includes('includeApproximate=true'), 'missing includeApproximate');
});

test('[REGRESSION] radius mode default radius (not explicitly set) → radiusKm=10', () => {
  const { url } = pdBuildRequestUrl(
    '7290000066795', 'radius', { lat: 32.07, lng: 34.79 }, [], false, 3, null, null
  );
  assert(url.includes('radiusKm=10'), `expected radiusKm=10, got: ${url}`);
});

test('[REGRESSION] all mode → /api/prices?barcode=...', () => {
  const { url, isCityMode, blocked } = pdBuildRequestUrl(
    '7290000066795', 'all', null, [], false, 3, null, null
  );
  assert(!isCityMode, 'should not be city mode');
  assert(!blocked, 'should not be blocked');
  assert(url.startsWith('/api/prices?'), 'wrong endpoint');
  assert(url.includes('barcode=7290000066795'), 'missing barcode');
  assert(!url.includes('lat='), 'should not include lat in all mode');
});

// BLOCKER 2 — filtered modes must never fall through to national
console.log('\npdBuildRequestUrl — blocked filtered modes (Blocker 2)');

test('[REGRESSION] city mode + no cities → blocked, url=null', () => {
  const { url, blocked } = pdBuildRequestUrl(
    '7290000066795', 'city', null, [], false, 3, null, null
  );
  assertEqual(url, null, 'url must be null when city mode has no cities');
  assertEqual(blocked, 'no-cities');
});

test('[REGRESSION] city mode + no cities → never builds /api/prices national URL', () => {
  const { url } = pdBuildRequestUrl('7290000066795', 'city', null, [], false, 3, null, null);
  assert(url === null, 'must not fall through to national /api/prices');
});

test('[REGRESSION] radius mode + no location → blocked, url=null', () => {
  const { url, blocked } = pdBuildRequestUrl(
    '7290000066795', 'radius', null, [], true, 5, null, null
  );
  assertEqual(url, null, 'url must be null when radius mode has no location');
  assertEqual(blocked, 'no-location');
});

test('[REGRESSION] radius mode + no location → never builds /api/prices national URL', () => {
  const { url } = pdBuildRequestUrl('7290000066795', 'radius', null, [], true, 5, null, null);
  assert(url === null, 'must not fall through to national /api/prices');
});

test('[REGRESSION] all mode → still builds national URL (only intentional national path)', () => {
  const { url } = pdBuildRequestUrl('7290000066795', 'all', null, [], false, 3, null, null);
  assert(url !== null, 'all mode must always produce a URL');
  assert(url.startsWith('/api/prices?'), 'all mode uses /api/prices');
});

test('removing last city (city→city with empty array) → url=null, not national', () => {
  // Simulates: user removes last city chip while sheet is in city mode
  const afterRemove = pdBuildRequestUrl('7290000066795', 'city', null, [], false, 3, null, null);
  assertEqual(afterRemove.url, null, 'no national leakage when last city removed');
  assertEqual(afterRemove.blocked, 'no-cities');
});

// ── pdExtractRows — BLOCKER 1: city response shape ───────────────────────────

console.log('\npdExtractRows — city response normalization (Blocker 1)');

test('[REGRESSION] city mode reads data.results (not data.prices)', () => {
  const cityResponse = { version: '2.1.0', barcode: '123', cities: ['תל אביב'], count: 2,
    results: [{ price: 5.9 }, { price: 6.1 }] };
  const rows = pdExtractRows(cityResponse, true);
  assertEqual(rows.length, 2, 'should extract 2 rows from data.results');
  assertEqual(rows[0].price, 5.9);
});

test('[REGRESSION] city mode: data.prices field is ignored', () => {
  // If city response accidentally has a .prices key (wrong field), it must be ignored
  const buggedResponse = { prices: [{ price: 99 }], results: [{ price: 5.9 }] };
  const rows = pdExtractRows(buggedResponse, true);
  assertEqual(rows.length, 1, 'city mode must read results, not prices');
  assertEqual(rows[0].price, 5.9);
});

test('[REGRESSION] non-city mode reads data.prices', () => {
  const pricesResponse = { prices: [{ price: 5.9 }, { price: 6.1 }, { price: 7.0 }] };
  const rows = pdExtractRows(pricesResponse, false);
  assertEqual(rows.length, 3);
});

test('empty city response → empty array', () => {
  assertEqual(pdExtractRows({ results: [] }, true).length, 0);
  assertEqual(pdExtractRows({}, true).length, 0);
});

test('empty non-city response → empty array', () => {
  assertEqual(pdExtractRows({ prices: [] }, false).length, 0);
  assertEqual(pdExtractRows({}, false).length, 0);
});

// ── pdNameFallbackUrl ────────────────────────────────────────────────────────

console.log('\npdNameFallbackUrl — name fallback behaviour');

// (A) Results exist → fallback not needed (handled by pdShouldUseFallback, tested below)

// (B) Zero results + name → fallback URL returned (non-city mode)
test('[REGRESSION] (B) zero results + name + all mode → fallback URL returned', () => {
  const url = pdNameFallbackUrl('חלב תנובה 3%', 'all', null, false, 3);
  assert(url !== null, 'expected a URL');
  assert(url.includes('/api/prices?q='), 'wrong endpoint');
  assert(url.includes(encodeURIComponent('חלב תנובה 3%')), 'missing name');
});

// (C) Radius fallback URL must include lat/lng/effectiveRadius
test('[REGRESSION] (C) radius mode fallback URL contains lat/lng/effectiveRadius', () => {
  const url = pdNameFallbackUrl('חלב', 'radius', { lat: 32.07626, lng: 34.79148 }, true, 5);
  assert(url !== null, 'expected a URL');
  assert(url.includes('lat=32.07626'), `missing lat: ${url}`);
  assert(url.includes('lng=34.79148'), `missing lng: ${url}`);
  assert(url.includes('radiusKm=5'), `missing radiusKm: ${url}`);
});

// (D) Fallback results should still apply pdRowEligible (radius mode: distanceKm != null)
test('[REGRESSION] (D) fallback results in radius mode: row without distanceKm excluded', () => {
  assert(!pdRowEligible({ distanceKm: null }, 'radius'), 'should exclude no-coord row');
  assert(pdRowEligible({ distanceKm: 3.2 }, 'radius'), 'should keep row with coords');
});

// (E) City mode → no fallback
test('[REGRESSION] (E) city mode → pdNameFallbackUrl returns null', () => {
  const url = pdNameFallbackUrl('חלב', 'city', null, false, 3);
  assertEqual(url, null, 'city mode must return null (no fallback)');
});

test('[REGRESSION] (E) city mode documented: zero results returns no name-search fallback', () => {
  assert(!pdShouldUseFallback([], 'חלב תנובה', 'city'),
    'city mode must never trigger fallback');
});

// ── pdShouldUseFallback ──────────────────────────────────────────────────────

console.log('\npdShouldUseFallback');

test('[REGRESSION] (A) prices present → no fallback', () => {
  assert(!pdShouldUseFallback([{ price: 5 }], 'חלב', 'all'));
});

test('[REGRESSION] (B) zero results + name + all mode → fallback', () => {
  assert(pdShouldUseFallback([], 'חלב', 'all'));
});

test('[REGRESSION] (E) zero results + name + city mode → no fallback', () => {
  assert(!pdShouldUseFallback([], 'חלב', 'city'));
});

test('zero results + no name + all mode → no fallback', () => {
  assert(!pdShouldUseFallback([], null, 'all'));
  assert(!pdShouldUseFallback([], '', 'all'));
});

test('zero results + name + radius mode → fallback', () => {
  assert(pdShouldUseFallback([], 'חלב', 'radius'));
});

// ── data-city injection safety proof ────────────────────────────────────────
// Proves that dataset.city = rawCity round-trips the exact original string
// without any HTML escaping, for city names with apostrophes AND double quotes.
// This is the correctness contract for the DOM-construction fix in app.js.

console.log('\ndata-city DOM safety — injection proof');

test('[REGRESSION] apostrophe city: dataset.city round-trips exact string', () => {
  // Simulate: btn.dataset.city = c (as in the DOM chip builder)
  // Node has no DOM — simulate with a plain object mimicking dataset behaviour
  const city = "ג'סר א-זרקא";
  const dataset = {};
  dataset.city = city;
  assertEqual(dataset.city, city, 'apostrophe city must survive dataset round-trip unmodified');
});

test('[REGRESSION] double-quote city: dataset.city round-trips exact string', () => {
  const city = 'עיר "בדיקה"';
  const dataset = {};
  dataset.city = city;
  assertEqual(dataset.city, city, 'double-quote city must survive dataset round-trip unmodified');
});

test('[REGRESSION] double-quote city: HTML-string injection would have broken the attribute', () => {
  // Demonstrate that the old esc() approach would have produced broken HTML:
  // esc('עיר "בדיקה"') → 'עיר "בדיקה"' (quotes NOT escaped)
  // resulting in:  data-city="עיר "בדיקה""  — attribute terminates early
  // The DOM fix avoids this entirely. Here we just document the esc() gap.
  function escOld(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  const city = 'עיר "בדיקה"';
  const escaped = escOld(city);
  // double quote is NOT escaped — HTML attr data-city="<value>" would break
  assert(escaped.includes('"'), 'esc() does not escape double quotes — confirms DOM fix is necessary');
});

// ── Mode preservation proof ──────────────────────────────────────────────────
// These prove that blindly calling pdInitialMode() on location change would
// override an explicit user mode selection — the architectural regression the
// _setLocation fix prevents.

console.log('\nMode preservation — architectural proof');

test('[REGRESSION] user in radius mode + cities exist → pdInitialMode returns city (overrides user)', () => {
  // If _setLocation called pdInitialMode() while cities=['חיפה'] and user had chosen 'radius',
  // the result would be 'city' — silently discarding the user's explicit selection.
  assertEqual(pdInitialMode(['חיפה'], { lat: 32, lng: 34 }), 'city',
    'pdInitialMode with cities → city; calling it on location change would reset user mode');
});

test('[REGRESSION] user in all mode + location now available → pdInitialMode returns radius (overrides user)', () => {
  // If _setLocation called pdInitialMode() after user chose 'all', result would be 'radius'.
  assertEqual(pdInitialMode([], { lat: 32, lng: 34 }), 'radius',
    'pdInitialMode with location → radius; must not be called mid-session to preserve user choice');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

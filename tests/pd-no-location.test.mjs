// tests/pd-no-location.test.mjs
// FS-LOC-DIST-002 — System-2 (price-detail sheet) distance tab with no saved
// location rendered the generic "אין מחירים זמינים" as if no stores existed.
// Phone evidence: sheet showed "לא נבחר מיקום"; with a valid Haifa location the
// same pipeline returns 32/32 rows at 10 km.
//
// Runs the REAL _pdFetchPrices and _renderPriceDetail extracted from app.js
// (same pattern as ui-fixes / nearby-distance) plus the real pd-location module.
import { readFileSync } from 'fs';
import * as pd from '../js/pd-location.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function extractFn(name) {
  const start = app.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  let i = app.indexOf('{', app.indexOf(')', start)), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const HAIFA = { label: 'חיפה', lat: 32.794, lng: 34.9896, source: 'manual' };
const jsonRes = body => ({ ok: true, json: async () => body });
const rows = n => Array.from({ length: n }, (_, i) => ({ _key: `c_${i}`, price: 5 + i, distanceKm: i * 0.3 }));

// Real _pdFetchPrices with injected module state.
function loadFetch({ mode = 'radius', location = HAIFA, cities = ['חיפה'], radius = 10, online = true, fetchImpl }) {
  const calls = [];
  const factory = new Function(
    '_pdCacheGet', '_pdCacheSet', 'navigator', 'fetch', 'pdBuildRequestUrl', 'pdExtractRows', 'pdRowEligible',
    'pdShouldUseFallback', 'pdNameFallbackUrl', '_pdMode', '_selectedLocation', '_selectedCities',
    '_radiusExplicitlySet', '_nearbyRadius', 'myId', 'groupId', '_pdName',
    `${extractFn('_pdFetchPrices')}\nreturn _pdFetchPrices;`
  );
  const fn = factory(() => null, () => {}, { onLine: online },
    async (u, o) => { calls.push(u); return fetchImpl(u, o); },
    pd.pdBuildRequestUrl, pd.pdExtractRows, pd.pdRowEligible, pd.pdShouldUseFallback, pd.pdNameFallbackUrl,
    mode, location, cities, true, radius, null, null, '');
  return { fetchPrices: fn, calls, cities };
}

// Real _renderPriceDetail; only the empty-state branches are exercised.
function render({ prices = [], blocked = null, mode = 'radius', online = true }) {
  const body = { innerHTML: '' };
  const factory = new Function(
    'document', 'navigator', '_pdLastUpdateBy', '_pdFromCache', '_pcGet', 'PRICE_CACHE_TTL', '_pdBarcode',
    '_pdName', '_pdPrices', '_pdBlocked', '_pdMode', 'pdEmptyStateKind', 'esc', '_jsAttr',
    `${extractFn('_renderPriceDetail')}\nreturn _renderPriceDetail;`
  );
  factory({ getElementById: () => body }, { onLine: online }, null, false, () => null, 0, '7290004131074',
    'חלב', prices, blocked, mode, pd.pdEmptyStateKind, s => s, s => JSON.stringify(s))();
  return body.innerHTML;
}
const GENERIC = 'אין מחירים זמינים';
const CTA     = 'בחר מיקום כדי לראות מחירים לפי מרחק';

console.log('\nFS-LOC-DIST-002 — System-2 no-location state');

await test('pdEmptyStateKind: radius + no-location → location-required; everything else → no-prices', () => {
  eq(pd.pdEmptyStateKind('no-location', 'radius'), 'location-required');
  eq(pd.pdEmptyStateKind(null, 'radius'), 'no-prices');
  eq(pd.pdEmptyStateKind(undefined, 'radius'), 'no-prices');
  eq(pd.pdEmptyStateKind('no-cities', 'city'), 'no-prices');
  eq(pd.pdEmptyStateKind('no-location', 'all'), 'no-prices');
});

await test('1. no saved location → _pdFetchPrices reports blocked:no-location, issues no request', async () => {
  const l = loadFetch({ location: null, fetchImpl: async () => jsonRes({ prices: rows(5) }) });
  const r = await l.fetchPrices('7290004131074');
  eq(r.blocked, 'no-location'); eq(r.prices.length, 0); eq(l.calls.length, 0, 'no network request');
});

await test('2. no saved location → explicit location-required state with GPS + address CTAs', () => {
  const html = render({ blocked: 'no-location' });
  ok(html.includes(CTA), 'CTA text shown');
  ok(html.includes('onclick="selectLocGPS()"'), 'GPS option');
  ok(html.includes('onclick="openManualAddressModal()"'), 'manual address option');
});

await test('3. no saved location → generic "no prices" state is NOT shown', () => {
  const html = render({ blocked: 'no-location' });
  ok(!html.includes(GENERIC), 'no "אין מחירים זמינים"');
  ok(!html.includes('לא נמצאו מחירים רשמיים'), 'no "לא נמצאו מחירים רשמיים"');
  ok(!html.includes('openMp2('), 'no manual-price CTA implying missing prices');
});

await test('4. valid location + 10 km → request radiusKm=10, 32 rows survive client filtering', async () => {
  const l = loadFetch({ fetchImpl: async () => jsonRes({ prices: rows(32) }) });
  const r = await l.fetchPrices('7290004131074');
  eq(l.calls.length, 1);
  const sp = new URL(l.calls[0], 'http://x').searchParams;
  eq(sp.get('radiusKm'), '10'); eq(sp.get('lat'), '32.794'); eq(sp.get('lng'), '34.9896');
  ok(!sp.has('city'), 'distance request carries no city filter');
  eq(r.blocked, undefined); eq(r.prices.length, 32);
});

await test('5. HTTP/API failure → null result (not blocked) → never the location-required state', async () => {
  const l = loadFetch({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const r = await l.fetchPrices('7290004131074');
  eq(r, null, 'failure stays distinguishable from blocked');
  const html = render({ blocked: r?.blocked || null });
  ok(!html.includes(CTA), 'failure does not ask for a location');
});

await test('6. genuine zero rows with valid location → real zero-results state', async () => {
  const l = loadFetch({ fetchImpl: async () => jsonRes({ prices: [] }) });
  const r = await l.fetchPrices('7290004131074');
  eq(l.calls.length, 1, 'request was made'); eq(r.prices.length, 0); eq(r.blocked, undefined);
  const html = render({ blocked: r.blocked || null });
  ok(html.includes(GENERIC), 'real zero state shown'); ok(!html.includes(CTA));
});

await test('7. city chip untouched; city mode empty still uses its existing state', async () => {
  const l = loadFetch({ location: null, fetchImpl: async () => jsonRes({ prices: [] }) });
  await l.fetchPrices('7290004131074');
  eq(JSON.stringify(l.cities), JSON.stringify(['חיפה']), 'selected cities unchanged');
  const html = render({ mode: 'city', blocked: null });
  ok(html.includes(GENERIC) && !html.includes(CTA), 'city mode unaffected');
});

await test('8. offline keeps the existing offline message (unchanged)', async () => {
  const l = loadFetch({ online: false, fetchImpl: async () => jsonRes({ prices: [] }) });
  eq(await l.fetchPrices('7290004131074'), null);
  ok(render({ online: false }).includes('אין חיבור — לא ניתן לחפש מחירים'));
});

await test('9. every sheet result assignment carries blocked (no stale state)', () => {
  const n = (app.match(/_pdBlocked\s*=/g) || []).length;
  ok(n >= 6, `expected _pdBlocked set at each _pdFetchPrices consumer, found ${n}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// tests/pd-clear-location.test.mjs
// FS-LOC-ADDR-001 — the saved location could only be replaced, never removed, from
// the price-detail sheet; and clearLocation() did not refresh an open sheet, so the
// distance tab kept showing results for a location that no longer existed.
//
// Runs the REAL clearLocation, deleteRecentLocation, _syncNearbyUI, _syncPdLocationUI,
// pd cache helpers, _pdFetchPrices, _pdRefreshPrices and _renderPriceDetail extracted
// from app.js into one shared scope (same pattern as pd-gps-feedback / pd-no-location).
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
function sliceBody(start, label) {
  let i = app.indexOf('{', app.indexOf(')', start)), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${label}`);
}
function extractFn(name) {
  const start = app.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  return sliceBody(start, name);
}
function extractWindowFn(name) {
  const start = app.search(new RegExp(`window\\.${name}\\s*=\\s*(async\\s+)?function\\s*\\(`));
  if (start < 0) throw new Error(`window.${name} not found in app.js`);
  return sliceBody(start, name) + ';';
}

const BARCODE  = '7290004131074';
const MANUAL   = { label: 'הרצל 1, חיפה', address: 'הרצל 1 חיפה', lat: 32.794, lng: 34.9896, source: 'manual', createdAt: '2026-10-01T00:00:00Z' };
const GPS      = { label: 'המיקום שלי עכשיו', lat: 32.08, lng: 34.78, source: 'gps' };
const OTHER    = { label: 'דיזנגוף 50, תל אביב', address: 'דיזנגוף 50', lat: 32.07, lng: 34.77, source: 'manual' };
const GENERIC  = 'אין מחירים זמינים';
const REQUIRED = 'בחר מיקום כדי לראות מחירים לפי מרחק';
const MISSING  = 'לא נבחר מיקום';
const CLEAR_BTN = 'onclick="clearLocation()"';
const NATIONAL = [{ _key: 'all_1', price: 4.9, storeName: 'NATIONAL-ROW' }];

function el() {
  const classes = new Set();
  return { textContent: '', innerHTML: '', classes,
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: c => classes.has(c),
                 add: c => classes.add(c), remove: c => classes.delete(c) } };
}

function makeApp({ location = MANUAL, mode = 'radius', sheetOpen = true, cities = ['חיפה'], recents = [MANUAL, OTHER],
                   gpsState = 'idle', gpsError = null, query = '' } = {}) {
  const els = {};
  for (const id of ['nearby-toggle-btn', 'nearby-strip', 'loc-label-bar', 'loc-label-txt', 'loc-source-btn',
                    'loc-source-icon', 'loc-source-label', 'price-detail-overlay', 'pd-body']) els[id] = el();
  els['pd-loc-controls'] = { innerHTML: '', querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  if (sheetOpen) els['price-detail-overlay'].classList.add('show');
  els['pd-body'].innerHTML = 'SENTINEL-RESULTS';
  const store = { selectedLocation: location ? JSON.stringify(location) : undefined,
                  recentLocations: JSON.stringify(recents), nearbyRadius: '10' };
  const log = { fetches: [], searches: 0 };
  const win = {};
  const factory = new Function(
    'document', 'localStorage', 'navigator', 'window', 'log', 'fetch', 'init',
    'pdEmptyStateKind', 'pdHasLocFn', 'pdCKFn', 'pdEffR', 'pdBuildRequestUrl', 'pdExtractRows', 'pdRowEligible',
    'pdShouldUseFallback', 'pdNameFallbackUrl', `
    let _selectedLocation = init.location, _selectedCities = init.cities, _recentLocations = init.recents;
    let _nearbyMode = true, _nearbyRadius = 10, _radiusExplicitlySet = true;
    let _pdPrices = [], _pdFromCache = false, _pdBlocked = null, _pdLastUpdateBy = null;
    let _pdGpsState = init.gpsState, _pdGpsError = init.gpsError, _pdMode = init.mode;
    const _pdBarcode = '${BARCODE}', _pdName = 'חלב', PRICE_CACHE_TTL = 0, lastSearchQuery = init.query;
    const myId = null, groupId = null, _pcGet = () => null, esc = s => s, _jsAttr = s => JSON.stringify(s);
    const _hasLoc = () => Boolean(_nearbyMode && _selectedLocation?.lat);
    const _pdHasLoc = () => pdHasLocFn(_selectedLocation);
    const _renderRecentLocOpts = () => {};
    const searchPrices = () => { log.searches++; };
    function clearLocation() { return window.clearLocation(); }
    const _pdCache = {};
    const PD_CACHE_TTL = 30 * 60 * 1000;
    ${extractFn('_syncNearbyUI')}
    ${extractFn('_pdEffectiveRadius')}
    ${extractFn('_syncPdLocationUI')}
    ${extractFn('_pdCacheKey')}
    ${extractFn('_pdCacheGet')}
    ${extractFn('_pdCacheSet')}
    ${extractFn('_pdCacheInvalidate')}
    ${extractFn('_pdFetchPrices')}
    ${extractFn('_pdRefreshPrices')}
    ${extractFn('_renderPriceDetail')}
    ${extractFn('_pdGpsErrorHtml')}
    ${extractWindowFn('clearLocation')}
    ${extractWindowFn('deleteRecentLocation')}
    // Seed: a national ("all") cache entry for the same barcode — must never leak into the radius tab.
    _pdCache['pd_${BARCODE}_all'] = { prices: init.national, ts: Date.now() };
    return {
      syncPd: _syncPdLocationUI,
      state: () => ({ loc: _selectedLocation, cities: _selectedCities, recents: _recentLocations, nearbyMode: _nearbyMode,
                      radius: _nearbyRadius, radiusExplicit: _radiusExplicitlySet, gps: _pdGpsState, gpsError: _pdGpsError,
                      blocked: _pdBlocked, prices: _pdPrices }),
    };`);
  const s = factory(
    { getElementById: id => els[id] || null, querySelectorAll: () => [] },
    { setItem: (k, v) => { store[k] = v; }, getItem: k => store[k] ?? null, removeItem: k => { delete store[k]; } },
    { onLine: true }, win, log,
    async u => { log.fetches.push(u); return { ok: true, json: async () => ({ prices: NATIONAL }) }; },
    { location, mode, cities: [...cities], recents: recents.map(r => ({ ...r })), gpsState, gpsError, query, national: NATIONAL },
    pd.pdEmptyStateKind, pd.pdHasLoc, pd.pdCacheKey, pd.pdEffectiveRadius, pd.pdBuildRequestUrl, pd.pdExtractRows,
    pd.pdRowEligible, pd.pdShouldUseFallback, pd.pdNameFallbackUrl);
  s.syncPd();
  return { ...s, els, store, log, win, controls: () => els['pd-loc-controls'].innerHTML, body: () => els['pd-body'].innerHTML };
}
const tick = () => new Promise(r => setTimeout(r, 0));

console.log('\nFS-LOC-ADDR-001 — clear the saved location');

await test('distance row shows "נקה מיקום" wired to clearLocation() only when a location exists', () => {
  const a = makeApp();
  ok(a.controls().includes('נקה מיקום') && a.controls().includes(CLEAR_BTN), 'clear action present');
  ok(a.controls().includes('שנה מיקום'), 'change action kept');
  const b = makeApp({ location: null });
  ok(!b.controls().includes(CLEAR_BTN), 'no clear action without a location');
});

for (const [label, loc] of [['manual address', MANUAL], ['GPS location', GPS]]) {
  await test(`${label} → clear → selectedLocation + localStorage removed; history, cities, radius, nearby mode unchanged`, async () => {
    const a = makeApp({ location: loc });
    const before = a.state();
    const recentsBefore = a.store.recentLocations;
    a.win.clearLocation(); await tick();
    const s = a.state();
    eq(s.loc, null, '_selectedLocation');
    ok(!('selectedLocation' in a.store), 'localStorage key removed');
    eq(a.store.recentLocations, recentsBefore, 'recentLocations storage unchanged');
    eq(JSON.stringify(s.recents), JSON.stringify(before.recents), 'recentLocations in memory unchanged');
    eq(JSON.stringify(s.cities), JSON.stringify(before.cities), 'selected cities unchanged');
    eq(s.radius, before.radius, 'radius'); eq(s.radiusExplicit, before.radiusExplicit, 'radius explicit flag');
    eq(a.store.nearbyRadius, '10', 'stored radius'); eq(s.nearbyMode, true, 'nearby mode');
  });
}

await test('distance mode open → label "לא נבחר מיקום", location-required panel with GPS + address, no generic', async () => {
  const a = makeApp();
  a.win.clearLocation(); await tick();
  ok(a.controls().includes(MISSING), 'missing-location label');
  ok(!a.controls().includes(CLEAR_BTN), 'clear action gone once cleared');
  const html = a.body();
  ok(html.includes(REQUIRED), 'location-required panel');
  ok(html.includes('onclick="_pdUseCurrentLocation()"'), 'GPS option'); ok(html.includes('onclick="openManualAddressModal()"'), 'address option');
  ok(!html.includes(GENERIC), 'no generic'); ok(!html.includes('SENTINEL-RESULTS'), 'old results replaced');
  eq(a.state().blocked, 'no-location');
});

await test('distance mode clear → no network request, no national/all rows leak in', async () => {
  const a = makeApp();
  a.win.clearLocation(); await tick();
  eq(a.log.fetches.length, 0, 'no request without a location');
  eq(a.state().prices.length, 0, 'no rows'); ok(!a.body().includes('NATIONAL-ROW'), 'national row absent');
});

await test('city mode clear → location UI only; no price refetch; cities unchanged', async () => {
  const a = makeApp({ mode: 'city' });
  a.win.clearLocation(); await tick();
  eq(a.log.fetches.length, 0, 'no fetch'); eq(a.body(), 'SENTINEL-RESULTS', 'city results untouched');
  ok(a.controls().includes('pd-city-panel'), 'city panel re-rendered');
  eq(JSON.stringify(a.state().cities), JSON.stringify(['חיפה']));
});

await test('failed GPS state is reset by clearing', async () => {
  const a = makeApp({ location: GPS, gpsState: 'location-error', gpsError: 'denied' });
  a.win.clearLocation(); await tick();
  eq(a.state().gps, 'idle'); eq(a.state().gpsError, null);
});

await test('search screen (no sheet open) → existing clear behaviour preserved', async () => {
  const a = makeApp({ sheetOpen: false, query: 'חלב' });
  a.els['loc-label-bar'].classList.add('show');
  a.win.clearLocation(); await tick();
  eq(a.state().loc, null); ok(!('selectedLocation' in a.store), 'localStorage key removed');
  ok(!a.els['loc-label-bar'].classList.contains('show'), 'label bar hidden');
  eq(a.els['loc-source-label'].textContent, 'בחר מיקום', 'source button reset');
  eq(a.log.searches, 1, 'search re-run'); eq(a.log.fetches.length, 0, 'no sheet fetch');
  eq(a.body(), 'SENTINEL-RESULTS', 'closed sheet untouched');
});

await test('deleting the active recent location → sheet consistent (location-required, no leak)', async () => {
  const a = makeApp();
  a.win.deleteRecentLocation(0, { stopPropagation() {} }); await tick();
  eq(a.state().loc, null, 'active location cleared');
  eq(a.state().recents.length, 1, 'only the deleted entry removed'); eq(a.state().recents[0].address, OTHER.address);
  ok(a.body().includes(REQUIRED), 'location-required panel'); ok(a.controls().includes(MISSING), 'missing label');
  eq(a.log.fetches.length, 0, 'no request'); ok(!a.body().includes(GENERIC), 'no generic');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

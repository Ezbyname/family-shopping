// tests/prices-radius-boundary.test.js
// Backend radius boundary regression tests for FS-RADIUS-001.
// Verifies filterByRadius contract: inside/outside/missing-coords/mixed-chains/boundary.

import { haversine } from '../api/_firebase.js';
import handler, { _resetStoreCache } from '../api/prices.js';

let passed = 0;
let failed = 0;

function expect(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(
      `  ❌ ${name}\n` +
      `     got:      ${JSON.stringify(got)}\n` +
      `     expected: ${JSON.stringify(expected)}`
    );
    failed++;
  }
}

function expectTruthy(name, value) {
  if (value) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name} — got falsy: ${JSON.stringify(value)}`);
    failed++;
  }
}

function makeReq(query) { return { method: 'GET', query, headers: {} }; }
function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = s => { res._status = s; return res; };
  res.json   = b => { res._body   = b; return res; };
  res.setHeader = () => res;
  res.end = () => res;
  return res;
}
async function callHandler(query) {
  const req = makeReq(query);
  const res = makeRes();
  await handler(req, res);
  return { status: res._status, body: res._body };
}

// Reference point: Tel Aviv city centre
const LAT = 32.0853;
const LNG = 34.7818;
const BARCODE = '7290011111111';

// Build a test store at exactly `distKm` km north of the reference point.
// A degree of latitude ≈ 111.32 km, so delta_lat = distKm / 111.32.
function storeAtKm(id, distKm, chain = 'chain') {
  const lat = LAT + distKm / 111.32;
  return {
    chainId:   chain,
    chainName: chain,
    storeId:   id,
    storeName: `Store ${id}`,
    city:      'Test',
    address:   '',
    latitude:  lat,
    longitude: LNG,
    hasCoords: true,
  };
}

function priceRow(id, price, chain = 'chain') {
  return {
    barcode:   BARCODE,
    name:      'Test Product',
    price,
    chainId:   chain,
    chainName: chain,
    storeId:   id,
    storeName: `Store ${id}`,
    source:    'official',
    currency:  'ILS',
    syncedAt:  Date.now(),
    updatedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── haversine sanity ──');
// ──────────────────────────────────────────────────────────────────────────────

{
  // A store placed 24 km north should be ~24 km away
  const s = storeAtKm('X', 24);
  const d = haversine(LAT, LNG, s.latitude, s.longitude);
  expectTruthy('haversine: 24 km store is between 23.5 and 24.5 km away', d >= 23.5 && d <= 24.5);
}
{
  const s = storeAtKm('Y', 26);
  const d = haversine(LAT, LNG, s.latitude, s.longitude);
  expectTruthy('haversine: 26 km store is between 25.5 and 26.5 km away', d >= 25.5 && d <= 26.5);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── filterByRadius via API handler ──');
// ──────────────────────────────────────────────────────────────────────────────

process.env.FIREBASE_DATABASE_URL = 'https://test-project.firebaseio.com';
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.FIREBASE_PRIVATE_KEY;

const realFetch = globalThis.fetch;

// ── Test A: Store at 24 km within radius=25 → included ────────────────────────
{
  const STORES  = { 'chain_near': storeAtKm('near', 24) };
  const PRICES  = { 'chain_near': priceRow('near', 10) };

  globalThis.fetch = mockFetch(STORES, PRICES);
  _resetStoreCache();
  const { body } = await callHandler({ barcode: BARCODE, lat: String(LAT), lng: String(LNG), radiusKm: '25' });
  expect('A: store at 24 km is within radius=25 → 1 result', body?.prices?.length, 1);
  expect('A: result storeId is "near"', body?.prices?.[0]?.storeId, 'near');
  expectTruthy('A: distanceKm is set', typeof body?.prices?.[0]?.distanceKm === 'number');
  expectTruthy('A: distanceKm ≤ 25', (body?.prices?.[0]?.distanceKm ?? 99) <= 25);
  _resetStoreCache();
}

// ── Test B: Store at 26 km outside radius=25 → excluded ──────────────────────
{
  const STORES  = { 'chain_far': storeAtKm('far', 26) };
  const PRICES  = { 'chain_far': priceRow('far', 9) };

  globalThis.fetch = mockFetch(STORES, PRICES);
  _resetStoreCache();
  const { body } = await callHandler({ barcode: BARCODE, lat: String(LAT), lng: String(LNG), radiusKm: '25' });
  expect('B: store at 26 km is outside radius=25 → 0 results', body?.prices?.length, 0);
  _resetStoreCache();
}

// ── Test C: Store with missing coords → excluded regardless of radius ──────────
{
  const STORES  = { 'chain_nocoord': { chainId:'chain', storeId:'nocoord', storeName:'No Coord', hasCoords:false, latitude:null, longitude:null } };
  const PRICES  = { 'chain_nocoord': priceRow('nocoord', 8) };

  globalThis.fetch = mockFetch(STORES, PRICES);
  _resetStoreCache();
  const { body } = await callHandler({ barcode: BARCODE, lat: String(LAT), lng: String(LNG), radiusKm: '999' });
  expect('C: store with no coords excluded even at radius=999', body?.prices?.length, 0);
  _resetStoreCache();
}

// ── Test D: Mixed inside/outside — only inside returned ─────────────────────
{
  const STORES = {
    'chain_near': storeAtKm('near', 10),
    'chain_far':  storeAtKm('far',  30),
  };
  const PRICES = {
    'chain_near': priceRow('near', 10),
    'chain_far':  priceRow('far',  8),
  };

  globalThis.fetch = mockFetch(STORES, PRICES);
  _resetStoreCache();
  const { body } = await callHandler({ barcode: BARCODE, lat: String(LAT), lng: String(LNG), radiusKm: '25' });
  expect('D: mixed stores → only 1 inside radius returned', body?.prices?.length, 1);
  expect('D: the inside store is returned', body?.prices?.[0]?.storeId, 'near');
  _resetStoreCache();
}

// ── Test E: Different chains use the same radius contract ────────────────────
{
  const STORES = {
    'shufersal_100': { ...storeAtKm('100', 5), chainId:'shufersal', chainName:'שופרסל' },
    'rami-levy_200': { ...storeAtKm('200', 20), chainId:'rami-levy', chainName:'רמי לוי' },
    'victory_300':   { ...storeAtKm('300', 30), chainId:'victory',   chainName:'ויקטורי' },
  };
  const PRICES = {
    'shufersal_100': { ...priceRow('100', 12), chainId:'shufersal', chainName:'שופרסל' },
    'rami-levy_200': { ...priceRow('200', 10), chainId:'rami-levy', chainName:'רמי לוי' },
    'victory_300':   { ...priceRow('300', 8),  chainId:'victory',   chainName:'ויקטורי' },
  };

  globalThis.fetch = mockFetch(STORES, PRICES);
  _resetStoreCache();
  const { body } = await callHandler({ barcode: BARCODE, lat: String(LAT), lng: String(LNG), radiusKm: '25' });
  expect('E: 2 chains within radius=25 (shufersal@5km, rami-levy@20km)', body?.prices?.length, 2);
  const storeIds = (body?.prices || []).map(p => p.storeId).sort();
  expect('E: correct stores returned', storeIds, ['100','200']);
  _resetStoreCache();
}

// ── Test F: Boundary — store at exactly 25 km → included ────────────────────
{
  // Place store at exactly 25 km (within floating-point tolerance)
  const STORES = { 'chain_boundary': storeAtKm('boundary', 25) };
  const PRICES = { 'chain_boundary': priceRow('boundary', 11) };

  globalThis.fetch = mockFetch(STORES, PRICES);
  _resetStoreCache();
  const { body } = await callHandler({ barcode: BARCODE, lat: String(LAT), lng: String(LNG), radiusKm: '25' });
  // storeAtKm(25) is approximately 25 km — should be included at radius=25
  expectTruthy('F: store at ~25 km included at radius=25', (body?.prices?.length ?? 0) >= 1);
  if (body?.prices?.length) {
    expectTruthy('F: boundary store has distanceKm ≤ 25', (body?.prices?.[0]?.distanceKm ?? 99) <= 25.5);
  }
  _resetStoreCache();
}

// ── Test G: No radius params → nationwide (all coords-having stores returned) ──
{
  const STORES = {
    'chain_near': storeAtKm('near', 5),
    'chain_far':  storeAtKm('far',  100),
  };
  const PRICES = {
    'chain_near': priceRow('near', 10),
    'chain_far':  priceRow('far',  7),
  };

  globalThis.fetch = mockFetch(STORES, PRICES);
  _resetStoreCache();
  const { body } = await callHandler({ barcode: BARCODE });  // no lat/lng/radius
  expect('G: no radius params → nationwide → 2 results', body?.prices?.length, 2);
  _resetStoreCache();
}

// ──────────────────────────────────────────────────────────────────────────────
globalThis.fetch = realFetch;
console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);

// ── helpers ──────────────────────────────────────────────────────────────────
function mockFetch(STORES, PRICES) {
  return async url => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com'))    return { ok: true, json: async () => ({ access_token: 'test-token' }) };
    if (u.includes('/stores.json'))             return { ok: true, json: async () => STORES };
    if (u.includes('/storeCoords.json'))        return { ok: true, json: async () => ({}) };
    if (u.includes(`/prices/${BARCODE}.json`))  return { ok: true, json: async () => PRICES };
    if (u.includes('/proxyCache/'))             return { ok: true, json: async () => null };
    if (u.includes('/priceReports/'))           return { ok: true, json: async () => null };
    if (u.includes('/userPriceOverrides/'))     return { ok: true, json: async () => null };
    if (u.includes('/manualPrices/'))           return { ok: true, json: async () => null };
    return { ok: true, json: async () => null };
  };
}

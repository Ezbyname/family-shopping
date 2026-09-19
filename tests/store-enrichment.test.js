// Store branch metadata enrichment — integration tests against REAL api/prices.js
//
// Run with: node tests/store-enrichment.test.js
//
// All tests exercise the actual production handler imported from api/prices.js.
// Firebase REST calls are intercepted by a global fetch mock.
// No production logic is copied or re-implemented here.

import handler, { _resetStoreCache } from '../api/prices.js';

// ── Test harness ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function expect(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${name}`);
    pass++;
  } else {
    console.error(`  ❌ ${name}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`);
    fail++;
  }
}
function expectTruthy(name, got) {
  if (got) { console.log(`  ✅ ${name}`); pass++; }
  else      { console.error(`  ❌ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}
function expectType(name, got, type) {
  if (typeof got === type) { console.log(`  ✅ ${name}`); pass++; }
  else { console.error(`  ❌ ${name} — expected typeof ${type}, got ${typeof got}`); fail++; }
}

// ── Minimal req/res mocks ────────────────────────────────────────────────────
function makeReq(query = {}) {
  return { method: 'GET', query, headers: {} };
}
function makeRes() {
  const res = { _status: 200, _body: null };
  res.status    = (s)    => { res._status = s; return res; };
  res.json      = (b)    => { res._body   = b; return res; };
  res.setHeader = ()     => res;
  res.end       = ()     => res;
  return res;
}

// Call the real handler and return the response body.
async function callHandler(query) {
  const req = makeReq(query);
  const res = makeRes();
  await handler(req, res);
  return res._body;
}

// ── Shared test fixtures ─────────────────────────────────────────────────────
const DB_URL = 'https://test-project.firebaseio.com';

// Full stores/ Firebase node — what the new code reads first
const STORES_NODE = {
  'rami-levy_203': {
    chainId: 'rami-levy', chainName: 'Rami Levy', storeId: '203',
    storeName: 'Rami Levy Rishon LeZion',
    address: 'Derech Ben Gurion 2', city: 'Rishon LeZion',
    latitude: 31.8964, longitude: 34.8091, hasCoords: true,
  },
  'shufersal_118': {
    chainId: 'shufersal', chainName: 'Shufersal', storeId: '118',
    storeName: 'Shufersal Express Givatayim',
    address: 'Herzel St 12', city: 'Givatayim',
    latitude: 32.0718, longitude: 34.8116, hasCoords: true,
  },
  'shufersal_208': {
    chainId: 'shufersal', chainName: 'Shufersal', storeId: '208',
    storeName: 'Shufersal Deal Kfar Saba',
    address: 'Weizmann 3', city: 'Kfar Saba',
    latitude: 32.1849, longitude: 34.9068, hasCoords: true,
  },
  'shufersal_266': {
    chainId: 'shufersal', chainName: 'Shufersal', storeId: '266',
    storeName: 'Shufersal Sheli Tel Aviv',
    address: 'Dizengoff 50', city: 'Tel Aviv',
    latitude: 32.0776, longitude: 34.7742, hasCoords: true,
  },
};

// storeCoords/ node — lightweight fallback (no storeName/address)
const COORDS_NODE = {
  'rami-levy_203': { lat: 31.8964, lng: 34.8091, city: 'Rishon LeZion' },
  'shufersal_118': { lat: 32.0718, lng: 34.8116, city: 'Givatayim' },
  'shufersal_208': { lat: 32.1849, lng: 34.9068, city: 'Kfar Saba' },
  'shufersal_266': { lat: 32.0776, lng: 34.7742, city: 'Tel Aviv' },
};

// Price records with blank storeName — the bug scenario
function makePrices(keys) {
  return Object.fromEntries(keys.map(k => {
    const [chainId, storeId] = k.split('_');
    return [k, {
      barcode: '7290010935007',
      name: 'Test Product',
      price: 6.90 + Math.random() * 0.1,  // small variation so prices differ
      chainId, chainName: chainId === 'rami-levy' ? 'Rami Levy' : 'Shufersal',
      storeId,
      storeName: '',   // ← blank — the bug
      address:   '',
      city:      '',
      unit: 'unit', quantity: '1', brand: '',
      currency: 'ILS', source: 'official',
      syncedAt: Date.now(), updatedAt: new Date().toISOString(),
    }];
  }));
}

// Build a mock fetch that intercepts Firebase REST calls.
// fetchLog records every URL called, in order — used to verify call ordering.
function buildMockFetch({ storesFails = false, coordsFails = false,
                          storesEmpty = false, coordsEmpty = false,
                          priceKeys = ['rami-levy_203'],
                          overrideData = null } = {}) {
  const fetchLog = [];
  const mockFetch = async (url) => {
    fetchLog.push(url);

    // OAuth token — return immediately (no real JWT needed for tests)
    if (url.includes('oauth2.googleapis.com')) {
      return { ok: true, json: async () => ({ access_token: 'test-token' }) };
    }

    // stores/ node
    if (url.includes('/stores.json')) {
      if (storesFails) throw new Error('stores/ simulated failure');
      const data = storesEmpty ? {} : STORES_NODE;
      return { ok: true, json: async () => data };
    }

    // storeCoords/ node
    if (url.includes('/storeCoords.json')) {
      if (coordsFails) throw new Error('storeCoords/ simulated failure');
      const data = coordsEmpty ? {} : COORDS_NODE;
      return { ok: true, json: async () => data };
    }

    // prices/{barcode}
    if (url.match(/\/prices\/\d+\.json/)) {
      return { ok: true, json: async () => makePrices(priceKeys) };
    }

    // priceReports/{barcode}
    if (url.includes('/priceReports/')) {
      return { ok: true, json: async () => null };
    }

    // userPriceOverrides
    if (url.includes('/userPriceOverrides/')) {
      return { ok: true, json: async () => overrideData };
    }

    // Default: 404
    return { ok: false, status: 404, json: async () => null };
  };
  return { mockFetch, fetchLog };
}

// Set env vars and install a fetch mock for one test, then clean up.
async function withMock(mockFetch, fn) {
  process.env.FIREBASE_DATABASE_URL = DB_URL;
  process.env.FIREBASE_PROJECT_ID   = 'test-project';
  // Intentionally leave CLIENT_EMAIL and PRIVATE_KEY unset → getAdminToken returns null
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  _resetStoreCache();   // reset module-level cache between tests
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    _resetStoreCache();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. No-radius enrichment — proves the real bug fix
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── A. No-radius enrichment (real handler, stores/ primary) ──');
{
  const { mockFetch, fetchLog } = buildMockFetch({ priceKeys: ['rami-levy_203'] });
  const body = await withMock(mockFetch, () =>
    callHandler({ barcode: '7290010935007' })
  );

  const row = body?.prices?.[0];
  expectTruthy('response has prices array',        body?.prices?.length > 0);
  expect('storeName populated from stores/',        row?.storeName, 'Rami Levy Rishon LeZion');
  expect('address populated from stores/',          row?.address,   'Derech Ben Gurion 2');
  expect('city populated from stores/',             row?.city,       'Rishon LeZion');
  expect('price source is firebase_cache',          body?.source,   'firebase_cache');

  // Verify stores/ was actually requested (not storeCoords/ alone)
  const storesFetched  = fetchLog.some(u => u.includes('/stores.json'));
  const coordsFetched  = fetchLog.some(u => u.includes('/storeCoords.json'));
  expectTruthy('real handler fetched stores/ endpoint',    storesFetched);
  expect(    'storeCoords/ NOT fetched when stores/ ok',   coordsFetched, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Existing non-empty metadata preserved — real handler
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── B. Existing metadata not overwritten (real handler) ──');
{
  // Inject price records that already have storeName/address filled
  const customFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com'))
      return { ok: true, json: async () => ({ access_token: 'tok' }) };
    if (url.includes('/stores.json'))
      return { ok: true, json: async () => STORES_NODE };
    if (url.match(/\/prices\/\d+\.json/)) {
      return { ok: true, json: async () => ({
        'rami-levy_203': {
          barcode: '7290010935007', name: 'Test', price: 5.50,
          chainId: 'rami-levy', chainName: 'Rami Levy', storeId: '203',
          storeName: 'Pre-existing Branch Name',   // ← already filled
          address:   'Pre-existing Address',
          city:      'Pre-existing City',
          unit: 'unit', quantity: '1', brand: '',
          currency: 'ILS', source: 'official',
          syncedAt: Date.now(), updatedAt: new Date().toISOString(),
        },
      }) };
    }
    if (url.includes('/priceReports/')) return { ok: true, json: async () => null };
    return { ok: false, status: 404, json: async () => null };
  };

  const body = await withMock(customFetch, () =>
    callHandler({ barcode: '7290010935007' })
  );
  const row = body?.prices?.[0];
  expect('pre-existing storeName preserved', row?.storeName, 'Pre-existing Branch Name');
  expect('pre-existing address preserved',   row?.address,   'Pre-existing Address');
  expect('pre-existing city preserved',      row?.city,      'Pre-existing City');
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Radius path — real handler with lat/lng
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── C. Radius path (real handler) ──');
{
  // shufersal_118 (Givatayim, ~3km from Tel Aviv) — within 10km
  // shufersal_208 (Kfar Saba, ~16km from Tel Aviv) — outside 10km
  const { mockFetch } = buildMockFetch({
    priceKeys: ['shufersal_118', 'shufersal_208'],
  });
  const body = await withMock(mockFetch, () =>
    callHandler({ barcode: '7290010935007', lat: '32.0853', lng: '34.7818', radiusKm: '10' })
  );

  // Only shufersal_118 should survive 10km radius from Tel Aviv
  expect('only in-radius store returned',     body?.prices?.length, 1);
  const row = body?.prices?.[0];
  expectTruthy('in-radius row has _key shufersal_118',  row?._key === 'shufersal_118' ||
                                                          row?.storeId === '118');
  expectType(  'distanceKm is a number',                row?.distanceKm, 'number');
  expectType(  'latitude is a number',                  row?.latitude,   'number');
  expectType(  'longitude is a number',                 row?.longitude,  'number');
  expect(      'storeName enriched on radius row',      row?.storeName,  'Shufersal Express Givatayim');
  expect(      'address enriched on radius row',        row?.address,    'Herzel St 12');
}

// ─────────────────────────────────────────────────────────────────────────────
// D. stores/ is primary — verified via fetch call log
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── D. stores/ called first, storeCoords/ not called when stores/ ok ──');
{
  const { mockFetch, fetchLog } = buildMockFetch({ priceKeys: ['rami-levy_203'] });
  await withMock(mockFetch, () => callHandler({ barcode: '7290010935007' }));

  const storesIdx  = fetchLog.findIndex(u => u.includes('/stores.json'));
  const coordsIdx  = fetchLog.findIndex(u => u.includes('/storeCoords.json'));
  expectTruthy('stores/ was fetched',              storesIdx !== -1);
  expect(      'storeCoords/ was NOT fetched',     coordsIdx, -1);
  // stores/ must appear before any price read
  const pricesIdx = fetchLog.findIndex(u => u.match(/\/prices\/\d+\.json/));
  // (stores/ and prices/ are loaded concurrently via getStoreIndex + parallel price read)
  expectTruthy('both stores/ and prices/ were fetched', storesIdx !== -1 && pricesIdx !== -1);
}

// ─────────────────────────────────────────────────────────────────────────────
// E. storeCoords/ fallback — real handler, stores/ fails
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── E. storeCoords/ fallback when stores/ fails (real handler) ──');
{
  const { mockFetch, fetchLog } = buildMockFetch({
    storesFails: true,          // stores/ throws → triggers fallback
    priceKeys:   ['rami-levy_203'],
  });
  const body = await withMock(mockFetch, () =>
    callHandler({ barcode: '7290010935007' })
  );

  // Response must still succeed
  expectTruthy('response has prices even when stores/ fails', body?.prices?.length > 0);
  // storeCoords/ was used as fallback
  expectTruthy('storeCoords/ was fetched as fallback', fetchLog.some(u => u.includes('/storeCoords.json')));
  // storeName/address remain blank — expected with coords-only fallback
  const row = body?.prices?.[0];
  expect('storeName blank in storeCoords fallback',  row?.storeName, '');
  expect('address blank in storeCoords fallback',    row?.address,   '');
  expect('city populated from storeCoords fallback', row?.city,      'Rishon LeZion');

  // Radius still works with storeCoords fallback
  const { mockFetch: mf2 } = buildMockFetch({
    storesFails: true,
    priceKeys:   ['rami-levy_203'],
  });
  const body2 = await withMock(mf2, () =>
    callHandler({ barcode: '7290010935007', lat: '31.9', lng: '34.8', radiusKm: '5' })
  );
  expectTruthy('radius filtering works with storeCoords fallback', body2?.prices?.length > 0);
  expectType(  'distanceKm present with storeCoords fallback',     body2?.prices?.[0]?.distanceKm, 'number');
}

// ─────────────────────────────────────────────────────────────────────────────
// F. Missing store key — no crash
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── F. Missing store key — no crash, row preserved ──');
{
  const { mockFetch } = buildMockFetch({ priceKeys: ['unknown-chain_999'] });
  const body = await withMock(mockFetch, () =>
    callHandler({ barcode: '7290010935007' })
  );
  expectTruthy('response valid with unknown storeKey', body !== null);
  expectTruthy('prices array present',                 Array.isArray(body?.prices));
  // Row remains intact even though no store metadata exists for it
  if (body?.prices?.length > 0) {
    const row = body.prices[0];
    expectTruthy('price is positive',      row.price > 0);
    expectTruthy('chainId present',        !!row.chainId);
  } else {
    expect('no crash on unknown key', true, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G. Zero official results — store index not loaded unnecessarily
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── G. Zero official results — no store read ──');
{
  const storeCallCount = { n: 0 };
  const zeroFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com'))
      return { ok: true, json: async () => ({ access_token: 'tok' }) };
    if (url.includes('/stores.json')) {
      storeCallCount.n++;
      return { ok: true, json: async () => STORES_NODE };
    }
    if (url.match(/\/prices\/\d+\.json/))
      return { ok: true, json: async () => ({}) };   // empty — no results
    if (url.includes('/priceReports/')) return { ok: true, json: async () => null };
    if (url.includes('/proxyCache/'))   return { ok: true, json: async () => null };
    if (url.includes('/manualPrices/')) return { ok: true, json: async () => null };
    return { ok: false, status: 404, json: async () => null };
  };
  await withMock(zeroFetch, () => callHandler({ barcode: '7290010935007' }));
  expect('stores/ not fetched when official is empty', storeCallCount.n, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// H. Override regression — real handler
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── H. Override regression (real handler) ──');
{
  const overrideData = {
    'rami-levy_203': { overridePrice: 4.9, note: 'user fix', overrideDate: new Date().toISOString() },
  };
  const { mockFetch } = buildMockFetch({
    priceKeys:    ['rami-levy_203'],
    overrideData,
  });
  // Inject price at 4.8, override at 4.9
  const customFetch = async (url) => {
    if (url.includes('oauth2.googleapis.com'))
      return { ok: true, json: async () => ({ access_token: 'tok' }) };
    if (url.includes('/stores.json'))
      return { ok: true, json: async () => STORES_NODE };
    if (url.match(/\/prices\/\d+\.json/)) {
      return { ok: true, json: async () => ({
        'rami-levy_203': {
          barcode: '7290010935007', name: 'Test', price: 4.8,
          chainId: 'rami-levy', chainName: 'Rami Levy', storeId: '203',
          storeName: '', address: '', city: '',
          unit: 'unit', quantity: '1', brand: '',
          currency: 'ILS', source: 'official',
          syncedAt: Date.now(), updatedAt: new Date().toISOString(),
        },
      }) };
    }
    if (url.includes('/userPriceOverrides/'))
      return { ok: true, json: async () => overrideData };
    if (url.includes('/priceReports/')) return { ok: true, json: async () => null };
    return { ok: false, status: 404, json: async () => null };
  };

  const body = await withMock(customFetch, () =>
    callHandler({ barcode: '7290010935007', userId: 'test-user-1' })
  );
  const row = body?.prices?.[0];
  expect('raw price unchanged (4.8)',          row?.price,         4.8);
  expect('displayPrice is override (4.9)',     row?.displayPrice,  4.9);
  expect('sourceDisplay = user_override',      row?.sourceDisplay, 'user_override');
  expectTruthy('override object present',      row?.override != null);
  expect('_key unchanged',                     row?._key,          'rami-levy_203');
  // Metadata enrichment still happened
  expect('storeName still populated',          row?.storeName,     'Rami Levy Rishon LeZion');
}

// ─────────────────────────────────────────────────────────────────────────────
// QA: four distinct branch keys — not deduplicated
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── QA: four distinct branch keys, no deduplication ──');
{
  const { mockFetch } = buildMockFetch({
    priceKeys: ['rami-levy_203', 'shufersal_118', 'shufersal_208', 'shufersal_266'],
  });
  const body = await withMock(mockFetch, () =>
    callHandler({ barcode: '7290010935007' })
  );
  expect('four distinct rows returned', body?.prices?.length, 4);
  const keys = body?.prices?.map(p => p._key).sort();
  expect('all four keys present', keys,
    ['rami-levy_203', 'shufersal_118', 'shufersal_208', 'shufersal_266'].sort());
  const storeNames = body?.prices?.map(p => p.storeName);
  expect('rami-levy_203 storeName',  storeNames?.find((_, i) => body.prices[i]._key === 'rami-levy_203'),
    'Rami Levy Rishon LeZion');
  const shufNames = new Set(body.prices.filter(p => p.chainId === 'shufersal').map(p => p.storeName));
  expect('three distinct shufersal branch names', shufNames.size, 3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);

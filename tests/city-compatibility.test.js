// Minimal production-release tests for city compatibility in api/prices.js.
// Exercises the real handler; all Firebase REST calls are mocked.

import handler, { _resetStoreCache } from '../api/prices.js';

let pass = 0;
let fail = 0;

function expect(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    console.log(`PASS ${name}`);
    pass++;
  } else {
    console.error(`FAIL ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`);
    fail++;
  }
}

function makeReq(query = {}) {
  return { method: 'GET', query, headers: {} };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = n => { res._status = n; return res; };
  res.json = b => { res._body = b; return res; };
  res.setHeader = () => res;
  res.end = () => res;
  return res;
}

async function callHandler(query) {
  const req = makeReq(query);
  const res = makeRes();
  await handler(req, res);
  return res._body;
}

async function withMock(mockFetch, fn) {
  process.env.FIREBASE_DATABASE_URL = 'https://test-project.firebaseio.com';
  process.env.FIREBASE_PROJECT_ID = 'test-project';
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  _resetStoreCache();

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    _resetStoreCache();
  }
}

function officialRow(city = '') {
  return {
    barcode: '7290010935007',
    name: 'Test Product',
    price: 5.5,
    chainId: 'rami-levy',
    chainName: 'Rami Levy',
    storeId: '203',
    storeName: '',
    address: '',
    city,
    syncedAt: Date.now(),
  };
}

function buildFetch({
  stores = {},
  storesFail = false,
  coords = {},
  official = {},
  proxy = null,
  manual = null,
} = {}) {
  return async url => {
    if (url.includes('oauth2.googleapis.com'))
      return { ok: true, json: async () => ({ access_token: 'tok' }) };

    if (url.includes('/stores.json')) {
      if (storesFail) throw new Error('stores unavailable');
      return { ok: true, json: async () => stores };
    }

    if (url.includes('/storeCoords.json'))
      return { ok: true, json: async () => coords };

    if (url.match(/\/prices\/\d+\.json/))
      return { ok: true, json: async () => official };

    if (url.includes('/priceReports/'))
      return { ok: true, json: async () => null };

    if (url.includes('/proxyCache/'))
      return { ok: true, json: async () => proxy };

    if (url.includes('/manualPrices/'))
      return { ok: true, json: async () => manual };

    return { ok: false, status: 404, json: async () => null };
  };
}

// 1. Canonical stores/ enriches ordinary official price rows.
{
  const stores = {
    'rami-levy_203': {
      storeName: 'Canonical Branch',
      address: 'Canonical Address',
      city: 'Rishon LeZion',
    },
  };
  const official = { 'rami-levy_203': officialRow('') };

  const body = await withMock(
    buildFetch({ stores, official }),
    () => callHandler({ barcode: '7290010935007' }),
  );

  expect('canonical storeName enrichment', body?.prices?.[0]?.storeName, 'Canonical Branch');
  expect('canonical address enrichment', body?.prices?.[0]?.address, 'Canonical Address');
  expect('canonical human city enrichment', body?.prices?.[0]?.city, 'Rishon LeZion');
}

// 2. Known legacy supplier locality code resolves to a human-readable city.
{
  const stores = {
    'rami-levy_203': {
      storeName: 'Legacy Branch',
      address: 'Legacy Address',
      city: '5000',
    },
  };
  const official = { 'rami-levy_203': officialRow('') };

  const body = await withMock(
    buildFetch({ stores, official }),
    () => callHandler({ barcode: '7290010935007' }),
  );

  expect('legacy city 5000 resolves', body?.prices?.[0]?.city, 'תל אביב -יפו');
}

// 3. Canonical store metadata overrides a legacy numeric price-row city.
{
  const stores = {
    'rami-levy_203': {
      storeName: 'Canonical Branch',
      address: 'Canonical Address',
      city: 'Rishon LeZion',
    },
  };
  const official = { 'rami-levy_203': officialRow('5000') };

  const body = await withMock(
    buildFetch({ stores, official }),
    () => callHandler({ barcode: '7290010935007' }),
  );

  expect('canonical city overrides numeric price city', body?.prices?.[0]?.city, 'Rishon LeZion');
}

// 4. Unknown numeric city must never leak to the public response.
{
  const stores = {
    'rami-levy_203': {
      storeName: 'Unknown Branch',
      address: 'Unknown Address',
      city: '10098',
    },
  };
  const official = { 'rami-levy_203': officialRow('10098') };

  const body = await withMock(
    buildFetch({ stores, official }),
    () => callHandler({ barcode: '7290010935007' }),
  );

  expect('unknown numeric city suppressed', body?.prices?.[0]?.city, '');
}

// 5. Existing human-readable price metadata remains untouched.
{
  const stores = {
    'rami-levy_203': {
      storeName: 'Canonical Branch',
      address: 'Canonical Address',
      city: 'Rishon LeZion',
    },
  };
  const official = { 'rami-levy_203': officialRow('Pre-existing Human City') };

  const body = await withMock(
    buildFetch({ stores, official }),
    () => callHandler({ barcode: '7290010935007' }),
  );

  expect('existing human city preserved', body?.prices?.[0]?.city, 'Pre-existing Human City');
}

// 6. storeCoords fallback also normalizes legacy numeric city.
{
  const coords = {
    'rami-levy_203': {
      lat: 32.0,
      lng: 34.8,
      city: '5000',
    },
  };
  const official = { 'rami-levy_203': officialRow('') };

  const body = await withMock(
    buildFetch({ storesFail: true, coords, official }),
    () => callHandler({ barcode: '7290010935007' }),
  );

  expect('storeCoords numeric city resolves', body?.prices?.[0]?.city, 'תל אביב -יפו');
}

// 7. Proxy path resolves a known numeric city even without radius filtering.
{
  const proxy = {
    p1: {
      barcode: '7290010935007',
      name: 'Proxy Test',
      price: 5.5,
      city: '5000',
      fetchedAt: Date.now(),
    },
  };

  const body = await withMock(
    buildFetch({ official: {}, proxy }),
    () => callHandler({ barcode: '7290010935007' }),
  );

  expect('proxy source', body?.source, 'proxy');
  expect('proxy numeric city resolves', body?.prices?.[0]?.city, 'תל אביב -יפו');
}

// 8. Manual path suppresses an unresolved numeric city.
{
  const manual = {
    m1: {
      barcode: '7290010935007',
      name: 'Manual Test',
      price: 5.5,
      chainName: 'Manual Chain',
      storeName: 'Manual Store',
      city: '10098',
      submittedAt: new Date().toISOString(),
    },
  };

  const body = await withMock(
    buildFetch({ official: {}, proxy: null, manual }),
    () => callHandler({ barcode: '7290010935007', groupId: 'test-group' }),
  );

  expect('manual source', body?.source, 'manual');
  expect('manual unresolved city suppressed', body?.prices?.[0]?.city, '');
}

console.log(`\n${pass} / ${pass + fail} PASS`);
if (fail > 0) process.exit(1);

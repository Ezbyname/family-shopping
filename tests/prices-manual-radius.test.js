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
    console.error(`  ❌ ${name} — got: ${JSON.stringify(value)}`);
    failed++;
  }
}

function makeReq(query) {
  return { method: 'GET', query, headers: {} };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = s => { res._status = s; return res; };
  res.json = b => { res._body = b; return res; };
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

const BARCODE = '7290004131074';

const STORES = {
  exact_1: {
    chainId: 'exact',
    chainName: 'Exact Chain',
    storeId: '1',
    storeName: 'Exact Nearby Store',
    city: 'Test City',
    address: 'Exact Address 1',
    latitude: 32.001,
    longitude: 34.801,
    hasCoords: true,
  },

  unknown_2: {
    chainId: 'unknown',
    chainName: 'Unknown Chain',
    storeId: '2',
    storeName: 'Unknown Location Store',
    city: 'Unknown City',
    address: '',
    latitude: null,
    longitude: null,
    hasCoords: false,
  },
};

const PRICES = {};


const realFetch = globalThis.fetch;

globalThis.fetch = async url => {
  const u = String(url);

  if (u.includes('oauth2.googleapis.com')) {
    return { ok: true, json: async () => ({ access_token: 'test-token' }) };
  }

  if (u.includes('/stores.json')) {
    return { ok: true, json: async () => STORES };
  }

  if (u.includes('/storeCoords.json')) {
    return {
      ok: true,
      json: async () => ({
        exact_1: { lat: 32.001, lng: 34.801, city: 'Test City' },
      }),
    };
  }

  if (u.includes(`/prices/${BARCODE}.json`)) {
    return { ok: true, json: async () => PRICES };
  }

  if (u.includes('/proxyCache/')) {
    return { ok: true, json: async () => null };
  }

  if (u.includes('/priceReports/')) {
    return { ok: true, json: async () => null };
  }

  if (u.includes('/userPriceOverrides/')) {
    return { ok: true, json: async () => null };
  }

  if (u.includes('/manualPrices/')) {
    return {
      ok: true,
      json: async () => ({
        manual_1: {
          barcode: BARCODE,
          name: 'Manual Test Product',
          price: 9.5,
          chainName: 'Manual Chain',
          storeName: 'Manual Store',
          groupId: 'test-group',
          submittedAt: new Date().toISOString(),
          source: 'manual',
        },
      }),
    };
  }

  return { ok: true, json: async () => null };
};

process.env.FIREBASE_DATABASE_URL = 'https://test-project.firebaseio.com';
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.FIREBASE_PRIVATE_KEY;

console.log('\n── /api/prices manual price strict-radius contract ──');

try {
  _resetStoreCache();

  const { status, body } = await callHandler({
    barcode: BARCODE,
    groupId: 'test-group',
    lat: '32.0',
    lng: '34.8',
    radiusKm: '5',
  });

  expect('HTTP status', status, 200);

  expect(
    'manual price without verifiable store location is excluded from strict radius',
    body?.prices?.length,
    0
  );
} finally {
  globalThis.fetch = realFetch;
  _resetStoreCache();
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);

if (failed > 0) process.exit(1);

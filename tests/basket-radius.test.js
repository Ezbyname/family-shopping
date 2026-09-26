import handler from '../api/basket-compare.js';

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

function makeReq(body) {
  return {
    method: 'POST',
    body,
    headers: {},
  };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
  };

  res.status = status => {
    res._status = status;
    return res;
  };

  res.json = body => {
    res._body = body;
    return res;
  };

  res.setHeader = () => res;
  res.end = () => res;

  return res;
}

async function callHandler(body) {
  const req = makeReq(body);
  const res = makeRes();
  await handler(req, res);
  return { status: res._status, body: res._body };
}

const BARCODE = '7290000066614';

const exactStore = {
  chainId: 'exact',
  chainName: 'Exact Chain',
  storeId: '1',
  storeName: 'Exact Nearby Store',
  city: 'Test City',
  address: 'Exact Address 1',
  latitude: 32.001,
  longitude: 34.801,
  hasCoords: true,
  approximateLocation: false,
};

const unknownStore = {
  chainId: 'unknown',
  chainName: 'Unknown Chain',
  storeId: '2',
  storeName: 'Unknown Location Store',
  city: 'Unknown City',
  address: '',
  latitude: null,
  longitude: null,
  hasCoords: false,
};

const prices = {
  exact_1: {
    barcode: BARCODE,
    name: 'Test Product',
    price: 10,
    chainId: 'exact',
    chainName: 'Exact Chain',
    storeId: '1',
    storeName: 'Exact Nearby Store',
    source: 'official',
  },

  unknown_2: {
    barcode: BARCODE,
    name: 'Test Product',
    price: 11,
    chainId: 'unknown',
    chainName: 'Unknown Chain',
    storeId: '2',
    storeName: 'Unknown Location Store',
    source: 'official',
  },
};

const realFetch = globalThis.fetch;

globalThis.fetch = async url => {
  const u = String(url);

  if (u.includes('oauth2.googleapis.com')) {
    return {
      ok: true,
      json: async () => ({ access_token: 'test-token' }),
    };
  }

  if (u.includes(`/prices/${BARCODE}.json`)) {
    return {
      ok: true,
      json: async () => prices,
    };
  }

  if (u.includes(`/proxyCache/${BARCODE}.json`)) {
    return {
      ok: true,
      json: async () => null,
    };
  }

  // Lightweight coordinate index intentionally contains ONLY the known store.
  if (u.includes('/storeCoords.json')) {
    return {
      ok: true,
      json: async () => ({
        exact_1: {
          lat: exactStore.latitude,
          lng: exactStore.longitude,
          city: exactStore.city,
        },
        // unknown_2 intentionally missing:
        // strict radius must NOT treat missing coordinates as "safe to include".
      }),
    };
  }

  if (u.includes('/stores/exact_1.json')) {
    return {
      ok: true,
      json: async () => exactStore,
    };
  }

  if (u.includes('/stores/unknown_2.json')) {
    return {
      ok: true,
      json: async () => unknownStore,
    };
  }

  return {
    ok: true,
    json: async () => null,
  };
};

process.env.FIREBASE_DATABASE_URL = 'https://test-project.firebaseio.com';
delete process.env.FIREBASE_CLIENT_EMAIL;
delete process.env.FIREBASE_PRIVATE_KEY;

console.log('\n── Strict radius: stores without coordinates must be excluded ──');

try {
  const { status, body } = await callHandler({
    items: [
      {
        barcode: BARCODE,
        name: 'Test Product',
        quantity: 1,
      },
    ],
    lat: 32.0,
    lng: 34.8,
    radiusKm: 5,
    includeApproximate: false,
  });

  expect('HTTP status', status, 200);

  expect(
    'strict radius returns only stores whose location can be verified',
    body?.results?.length,
    1
  );

  expect(
    'known nearby store survives',
    body?.results?.[0]?.storeId,
    '1'
  );

  expectTruthy(
    'every strict-radius result has distanceKm',
    body?.results?.every(r => typeof r.distanceKm === 'number')
  );

  expectTruthy(
    'every strict-radius result is within requested radius',
    body?.results?.every(r => r.distanceKm <= 5)
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);

if (failed > 0) process.exit(1);

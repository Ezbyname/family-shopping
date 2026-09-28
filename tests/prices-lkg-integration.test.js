import handler, {
  _setSearchLkgRepositoryForTests,
} from '../api/prices.js';

import {
  createSearchLkgRepository,
} from '../api/_search-lkg-repository.js';

let passed = 0;
let failed = 0;

function assert(name, condition, details = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${details ? ` — ${details}` : ''}`);
    failed++;
  }
}

function equal(name, actual, expected) {
  assert(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function makeReq(q) {
  return {
    method: 'GET',
    query: { q },
    headers: {},
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
  };

  res.setHeader = () => res;

  res.status = code => {
    res.statusCode = code;
    return res;
  };

  res.json = body => {
    res.body = body;
    return res;
  };

  res.end = () => res;

  return res;
}

async function callSearch(q = 'coffee') {
  const res = makeRes();
  await handler(makeReq(q), res);
  return res;
}

function offResponse(products = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ products }),
  };
}

function offFailure(status = 503) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  };
}

function installFetch(offResponses) {
  let offIndex = 0;

  globalThis.fetch = async url => {
    const u = String(url);

    if (u.includes('world.openfoodfacts.org')) {
      const response =
        offResponses[Math.min(offIndex, offResponses.length - 1)];

      offIndex++;
      return response;
    }

    if (u.includes('oauth2.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'test-token',
        }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => null,
    };
  };
}

const product = {
  code: '7290000000001',
  product_name: 'Black Coffee',
  product_name_he: 'קפה שחור',
  brands: 'Test Brand',
  quantity: '100g',
  image_small_url: '',
  countries_tags: ['en:israel'],
};

const memory = new Map();

const repository = createSearchLkgRepository({
  read: async key => memory.get(key) ?? null,
  write: async (key, value) => {
    memory.set(key, value);
  },
  remove: async key => {
    memory.delete(key);
  },
});

const realFetch = globalThis.fetch;
const originalDbUrl = process.env.FIREBASE_DATABASE_URL;

// No real Firebase access in this test.
delete process.env.FIREBASE_DATABASE_URL;

_setSearchLkgRepositoryForTests(
  repository,
  60_000
);

console.log('\n── /api/prices Main Search LKG integration ──');

try {
  // ------------------------------------------------------------
  // 1. Complete OFF success => GOOD written
  // ------------------------------------------------------------
  installFetch([
    offResponse([product]),
    offResponse([]),
  ]);

  const fresh = await callSearch();

  equal(
    '1. fresh OFF success returns product',
    fresh.body?.results?.length,
    1
  );

  equal(
    '2. fresh OFF success source is fresh',
    fresh.body?.lkgSource,
    'fresh'
  );

  equal(
    '3. fresh OFF success writes GOOD',
    [...memory.values()][0]?.state,
    'good'
  );

  // ------------------------------------------------------------
  // 2. OFF remote failure => serve stored GOOD
  // ------------------------------------------------------------
  installFetch([
    offFailure(503),
    offFailure(503),
  ]);

  const failureWithGood = await callSearch();

  equal(
    '4. remote failure serves stored GOOD',
    failureWithGood.body?.results?.length,
    1
  );

  equal(
    '5. remote failure identifies last_known_good',
    failureWithGood.body?.lkgSource,
    'last_known_good'
  );

  equal(
    '6. OFF failure remains visible even when LKG is served',
    failureWithGood.body?.offStatus,
    'REMOTE_FAILURE'
  );

  // ------------------------------------------------------------
  // 3. Authoritative zero => overwrite GOOD with ZERO tombstone
  // ------------------------------------------------------------
  installFetch([
    offResponse([]),
    offResponse([]),
  ]);

  const zero = await callSearch();

  equal(
    '7. authoritative zero returns no products',
    zero.body?.results?.length,
    0
  );

  equal(
    '8. authoritative zero source is explicit',
    zero.body?.lkgSource,
    'authoritative_zero'
  );

  equal(
    '9. authoritative zero replaces GOOD with ZERO tombstone',
    [...memory.values()][0]?.state,
    'zero'
  );

  // ------------------------------------------------------------
  // 4. Subsequent failure must NOT resurrect previous GOOD
  // ------------------------------------------------------------
  installFetch([
    offFailure(503),
    offFailure(503),
  ]);

  const failureAfterZero = await callSearch();

  equal(
    '10. GOOD -> ZERO -> failure returns no stale product',
    failureAfterZero.body?.results?.length,
    0
  );

  equal(
    '11. GOOD -> ZERO -> failure remains remote_failure',
    failureAfterZero.body?.lkgSource,
    'remote_failure'
  );

  equal(
    '12. ZERO tombstone remains stored',
    [...memory.values()][0]?.state,
    'zero'
  );

} finally {
  _setSearchLkgRepositoryForTests(null);

  globalThis.fetch = realFetch;

  if (originalDbUrl === undefined) {
    delete process.env.FIREBASE_DATABASE_URL;
  } else {
    process.env.FIREBASE_DATABASE_URL = originalDbUrl;
  }
}

console.log(
  `\nprices-lkg-integration: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

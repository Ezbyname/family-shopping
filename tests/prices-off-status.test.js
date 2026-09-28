import handler from '../api/prices.js';

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

function assertEqual(name, actual, expected) {
  assert(
    name,
    actual === expected,
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

async function callSearch(q) {
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

    // Defensive fallback for any token/Firebase request that may occur.
    if (u.includes('oauth2.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'test-token' }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => null,
    };
  };
}

const realFetch = globalThis.fetch;
const originalDbUrl = process.env.FIREBASE_DATABASE_URL;

// Keep this test focused only on OFF search semantics.
delete process.env.FIREBASE_DATABASE_URL;

console.log('\n── /api/prices OFF status contract ──');

try {
  // English query => original_il + translated_broad.
  installFetch([
    offResponse([]),
    offResponse([]),
  ]);

  {
    const res = await callSearch('coffee');

    assertEqual('clean zero: HTTP 200', res.statusCode, 200);
    assertEqual(
      'clean zero is authoritative',
      res.body?.offStatus,
      'SUCCESS_WITH_ZERO_RESULTS'
    );
    assertEqual(
      'clean zero is not partial failure',
      res.body?.offPartialFailure,
      false
    );
    assertEqual(
      'clean zero returns zero results',
      res.body?.results?.length,
      0
    );
  }

  installFetch([
    offFailure(503),
    offFailure(503),
  ]);

  {
    const res = await callSearch('coffee');

    assertEqual('remote failure: HTTP 200', res.statusCode, 200);
    assertEqual(
      'remote failure is distinguishable from clean zero',
      res.body?.offStatus,
      'REMOTE_FAILURE'
    );
    assertEqual(
      'remote failure currently has no products before LKG',
      res.body?.results?.length,
      0
    );
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

  installFetch([
    offResponse([product]),
    offFailure(503),
  ]);

  {
    const res = await callSearch('coffee');

    assertEqual('partial success: HTTP 200', res.statusCode, 200);
    assertEqual(
      'partial success remains status ok',
      res.body?.offStatus,
      'ok'
    );
    assertEqual(
      'partial failure is explicitly exposed',
      res.body?.offPartialFailure,
      true
    );
    assert(
      'partial success keeps usable products',
      Array.isArray(res.body?.results) &&
        res.body.results.length > 0
    );
  }
} finally {
  globalThis.fetch = realFetch;

  if (originalDbUrl === undefined) {
    delete process.env.FIREBASE_DATABASE_URL;
  } else {
    process.env.FIREBASE_DATABASE_URL = originalDbUrl;
  }
}

console.log(`\nprices-off-status: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

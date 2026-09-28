import handler, {
  _setSearchLkgRepositoryForTests,
} from '../api/prices.js';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  if (a === e) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    console.error('    actual:  ', a);
    console.error('    expected:', e);
    failed++;
  }
}

function makeReq(q = 'coffee') {
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

const realFetch = globalThis.fetch;

const originalDbUrl =
  process.env.FIREBASE_DATABASE_URL;

const originalEnabled =
  process.env.SEARCH_LKG_ENABLED;

const originalTtl =
  process.env.SEARCH_LKG_TTL_MS;

let offCalls = 0;
let searchLkgCalls = 0;

console.log('\n── /api/prices persistent LKG hard-gate safety ──');

try {
  // Simulate the dangerous case:
  // remote Vercel environment already contains ENABLED=true.
  process.env.SEARCH_LKG_ENABLED = 'true';
  process.env.SEARCH_LKG_TTL_MS = '60000';
  process.env.FIREBASE_DATABASE_URL =
    'https://test-project.firebaseio.com';

  // Ensure no test repository bypasses the production-shaped path.
  _setSearchLkgRepositoryForTests(null);

  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);

    if (u.includes('world.openfoodfacts.org')) {
      offCalls++;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          products: [],
        }),
      };
    }

    if (u.includes('/searchLkg/')) {
      searchLkgCalls++;

      return {
        ok: true,
        status: 200,
        json: async () => null,
      };
    }

    // Defensive fake for ordinary Firebase / OAuth requests.
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

  const res = makeRes();

  await handler(
    makeReq(),
    res
  );

  eq(
    '1. production-shaped request still succeeds',
    res.statusCode,
    200
  );

  eq(
    '2. OFF clean zero remains authoritative',
    res.body?.offStatus,
    'SUCCESS_WITH_ZERO_RESULTS'
  );

  eq(
    '3. clean zero still returns zero products',
    res.body?.results?.length,
    0
  );

  eq(
    '4. OFF transport was actually exercised',
    offCalls,
    2
  );

  eq(
    '5. remote ENABLED=true causes zero Search-LKG Firebase calls',
    searchLkgCalls,
    0
  );

  eq(
    '6. disabled production runtime exposes no LKG result metadata',
    Object.prototype.hasOwnProperty.call(
      res.body || {},
      'lkgSource'
    ),
    false
  );

} finally {
  _setSearchLkgRepositoryForTests(null);

  globalThis.fetch = realFetch;

  if (originalDbUrl === undefined) {
    delete process.env.FIREBASE_DATABASE_URL;
  } else {
    process.env.FIREBASE_DATABASE_URL = originalDbUrl;
  }

  if (originalEnabled === undefined) {
    delete process.env.SEARCH_LKG_ENABLED;
  } else {
    process.env.SEARCH_LKG_ENABLED = originalEnabled;
  }

  if (originalTtl === undefined) {
    delete process.env.SEARCH_LKG_TTL_MS;
  } else {
    process.env.SEARCH_LKG_TTL_MS = originalTtl;
  }
}

console.log(
  `\nprices-lkg-hard-gate: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

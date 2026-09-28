import {
  createFirebaseSearchLkgStorage,
} from '../api/_search-lkg-firebase.js';

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);

  ok(name, a === e, `expected ${e}, got ${a}`);
}

const KEY = `v1_${'a'.repeat(64)}`;
const DB_URL = 'https://test-project.firebaseio.com';

const RECORD = {
  state: 'good',
  products: [
    {
      barcode: '7290000000001',
      name: 'Black Coffee',
    },
  ],
  savedAt: 12345,
};

console.log('\n── Firebase Search LKG adapter ──');

{
  const calls = [];

  const storage = createFirebaseSearchLkgStorage({
    dbUrl: DB_URL,
    tokenProvider: async () => 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      return {
        ok: true,
        status: 200,
        json: async () => RECORD,
      };
    },
  });

  const result = await storage.read(KEY);

  equal(
    '1. GET returns Firebase record',
    result,
    RECORD
  );

  ok(
    '2. GET uses expected LKG path',
    calls[0].url.includes(`/searchLkg/${KEY}.json`)
  );

  ok(
    '3. GET includes encoded admin token',
    calls[0].url.includes('access_token=test-token')
  );

  equal(
    '4. GET uses GET method',
    calls[0].options.method,
    'GET'
  );
}

{
  const calls = [];

  const storage = createFirebaseSearchLkgStorage({
    dbUrl: DB_URL,
    tokenProvider: async () => 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      return {
        ok: true,
        status: 200,
        json: async () => RECORD,
      };
    },
  });

  await storage.write(KEY, RECORD);

  equal(
    '5. write uses PUT',
    calls[0].options.method,
    'PUT'
  );

  equal(
    '6. PUT body preserves exact record',
    JSON.parse(calls[0].options.body),
    RECORD
  );

  equal(
    '7. PUT content type is JSON',
    calls[0].options.headers['Content-Type'],
    'application/json'
  );
}

{
  const calls = [];

  const storage = createFirebaseSearchLkgStorage({
    dbUrl: DB_URL,
    tokenProvider: async () => 'test-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      return {
        ok: true,
        status: 200,
        json: async () => null,
      };
    },
  });

  await storage.remove(KEY);

  equal(
    '8. clear uses DELETE',
    calls[0].options.method,
    'DELETE'
  );
}

{
  const storage = createFirebaseSearchLkgStorage({
    dbUrl: DB_URL,
    tokenProvider: async () => null,
    fetchImpl: async url => ({
      ok: true,
      status: 200,
      json: async () => {
        ok(
          '9. missing token does not create malformed auth query',
          !String(url).includes('access_token=')
        );

        return null;
      },
    }),
  });

  await storage.read(KEY);
}

{
  const storage = createFirebaseSearchLkgStorage({
    dbUrl: DB_URL,
    tokenProvider: async () => 'test-token',
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }),
  });

  let threw = false;

  try {
    await storage.read(KEY);
  } catch (error) {
    threw =
      error.message === 'Firebase LKG GET HTTP 503';
  }

  ok(
    '10. non-2xx read becomes bounded failure',
    threw
  );
}

{
  let rejected = false;

  try {
    const storage = createFirebaseSearchLkgStorage({
      dbUrl: DB_URL,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => null,
      }),
    });

    await storage.read('unsafe/key');
  } catch (_) {
    rejected = true;
  }

  ok(
    '11. malformed Firebase key is rejected before fetch',
    rejected
  );
}

console.log(
  `\nsearch-lkg-firebase: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

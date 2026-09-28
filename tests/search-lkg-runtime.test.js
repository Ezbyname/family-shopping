import {
  createSearchLkgRuntime,
} from '../api/_search-lkg-runtime.js';

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

function ok(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

const KEY = `v1_${'a'.repeat(64)}`;

console.log('\n── Search LKG runtime construction ──');

// ------------------------------------------------------------------
// Default production contract: even remote true cannot bypass
// the source-controlled approval gate.
// ------------------------------------------------------------------
{
  let fetchCalls = 0;

  const runtime = createSearchLkgRuntime({
    env: {
      SEARCH_LKG_ENABLED: 'true',
      SEARCH_LKG_TTL_MS: '60000',
    },
    dbUrl: 'https://test-project.firebaseio.com',
    tokenProvider: async () => 'token',
    fetchImpl: async () => {
      fetchCalls++;
      throw new Error('fetch must not run');
    },
  });

  eq(
    '1. default hard gate blocks runtime',
    {
      enabled: runtime.enabled,
      ttlMs: runtime.ttlMs,
      repository: runtime.repository,
      reason: runtime.reason,
    },
    {
      enabled: false,
      ttlMs: null,
      repository: null,
      reason: 'approval_gate',
    }
  );

  eq(
    '2. blocked construction performs zero network calls',
    fetchCalls,
    0
  );
}

// ------------------------------------------------------------------
// Normal disabled feature flag.
// ------------------------------------------------------------------
{
  const runtime = createSearchLkgRuntime({
    env: {},
  });

  eq(
    '3. absent feature flag remains disabled',
    runtime.reason,
    'disabled'
  );
}

// ------------------------------------------------------------------
// Test-only simulated approval.
// This does NOT change the real source-controlled hard gate.
// ------------------------------------------------------------------
{
  const runtime = createSearchLkgRuntime({
    dbUrl: null,
    configProvider: () => ({
      enabled: true,
      ttlMs: 60_000,
    }),
  });

  eq(
    '4. enabled config without DB URL fails closed',
    {
      enabled: runtime.enabled,
      repository: runtime.repository,
      reason: runtime.reason,
    },
    {
      enabled: false,
      repository: null,
      reason: 'missing_db_url',
    }
  );
}

// ------------------------------------------------------------------
// Simulated approved runtime with mocked Firebase.
// Construction must still perform zero I/O.
// ------------------------------------------------------------------
{
  const calls = [];

  const runtime = createSearchLkgRuntime({
    dbUrl: 'https://test-project.firebaseio.com',
    tokenProvider: async () => 'test-token',
    configProvider: () => ({
      enabled: true,
      ttlMs: 60_000,
    }),
    fetchImpl: async (url, options) => {
      calls.push({
        url: String(url),
        method: options?.method,
        body: options?.body,
      });

      return {
        ok: true,
        status: 200,
        json: async () => null,
      };
    },
  });

  eq(
    '5. simulated approved runtime is constructed',
    {
      enabled: runtime.enabled,
      ttlMs: runtime.ttlMs,
      reason: runtime.reason,
    },
    {
      enabled: true,
      ttlMs: 60_000,
      reason: null,
    }
  );

  ok(
    '6. constructed runtime exposes repository',
    runtime.repository !== null
  );

  eq(
    '7. runtime construction itself performs zero Firebase calls',
    calls.length,
    0
  );

  const read = await runtime.repository.get(KEY);

  eq(
    '8. repository operation uses mocked Firebase adapter',
    {
      status: read.status,
      calls: calls.length,
      method: calls[0]?.method,
    },
    {
      status: 'miss',
      calls: 1,
      method: 'GET',
    }
  );
}

console.log(
  `\nsearch-lkg-runtime: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

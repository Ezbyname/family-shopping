import {
  resolveSearchWithLkg,
} from '../api/_search-lkg-service.js';

import {
  createSearchLkgRepository,
} from '../api/_search-lkg-repository.js';

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

const KEY = `v1_${'a'.repeat(64)}`;
const NOW = 1_000_000;
const TTL = 60_000;

const GOOD = [
  { barcode: '1', name: 'Black Coffee' },
];

function makeRepo(initial = null) {
  const map = new Map();

  if (initial) {
    map.set(KEY, initial);
  }

  const repository = createSearchLkgRepository({
    read: async key => map.get(key) ?? null,
    write: async (key, value) => map.set(key, value),
    remove: async key => map.delete(key),
  });

  return { repository, map };
}

console.log('\n── Search LKG service orchestration ──');

{
  const { repository, map } = makeRepo();

  const result = await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'ok',
      partialFailure: false,
      products: GOOD,
    },
    ttlMs: TTL,
    now: NOW,
  });

  eq('1. fresh success returned as fresh', result.source, 'fresh');
  eq('2. fresh success writes LKG', map.get(KEY), {
    state: 'good',
    products: GOOD,
    savedAt: NOW,
  });
}

{
  const { repository } = makeRepo({
    state: 'good',
    products: GOOD,
    savedAt: NOW - 10_000,
  });

  const result = await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'REMOTE_FAILURE',
      products: [],
    },
    ttlMs: TTL,
    now: NOW,
  });

  eq(
    '3. failure serves existing LKG',
    result.products,
    GOOD
  );

  eq(
    '4. failure source is last_known_good',
    result.source,
    'last_known_good'
  );
}

{
  const { repository, map } = makeRepo({
    state: 'good',
    products: GOOD,
    savedAt: NOW - 10_000,
  });

  const result = await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'SUCCESS_WITH_ZERO_RESULTS',
      products: [],
    },
    ttlMs: TTL,
    now: NOW,
  });

  eq(
    '5. authoritative zero returned',
    result.source,
    'authoritative_zero'
  );

  eq(
    '6. authoritative zero replaces GOOD with ZERO tombstone',
    map.get(KEY),
    {
      state: 'zero',
      products: [],
      savedAt: NOW,
    }
  );
}

{
  const { repository } = makeRepo();

  await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'ok',
      partialFailure: false,
      products: GOOD,
    },
    ttlMs: TTL,
    now: NOW,
  });

  await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'SUCCESS_WITH_ZERO_RESULTS',
      products: [],
    },
    ttlMs: TTL,
    now: NOW + 1_000,
  });

  const afterFailure = await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'REMOTE_FAILURE',
      products: [],
    },
    ttlMs: TTL,
    now: NOW + 2_000,
  });

  eq(
    '7. GOOD -> ZERO -> failure does not resurrect old GOOD',
    afterFailure.source,
    'remote_failure'
  );

  eq(
    '8. GOOD -> ZERO -> failure returns no stale products',
    afterFailure.products,
    []
  );
}

{
  const { repository } = makeRepo({
    state: 'good',
    products: GOOD,
    savedAt: NOW - TTL - 1,
  });

  const result = await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'REMOTE_FAILURE',
      products: [],
    },
    ttlMs: TTL,
    now: NOW,
  });

  eq(
    '9. expired LKG is not served',
    result.source,
    'remote_failure'
  );
}

{
  const repository = createSearchLkgRepository({
    read: async () => {
      throw new Error('backend down');
    },
    write: async () => {
      throw new Error('backend down');
    },
    remove: async () => {
      throw new Error('backend down');
    },
  });

  const result = await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'REMOTE_FAILURE',
      products: [],
    },
    ttlMs: TTL,
    now: NOW,
  });

  eq(
    '10. repository outage does not masquerade as cache hit',
    result.source,
    'remote_failure'
  );

  eq(
    '11. repository outage is visible',
    result.repositoryReadStatus,
    'unavailable'
  );
}

{
  const map = new Map();

  map.set(KEY, {
    state: 'good',
    products: GOOD,
    savedAt: NOW - 10_000,
  });

  const repository = createSearchLkgRepository({
    read: async key => map.get(key) ?? null,
    write: async () => {
      throw new Error('backend write down');
    },
    remove: async key => map.delete(key),
  });

  const result = await resolveSearchWithLkg({
    repository,
    key: KEY,
    current: {
      status: 'SUCCESS_WITH_ZERO_RESULTS',
      products: [],
    },
    ttlMs: TTL,
    now: NOW,
  });

  eq(
    '12. failed ZERO tombstone persistence is explicitly visible',
    result.mutationStatus,
    'unavailable'
  );
}

console.log(
  `\nsearch-lkg-service: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

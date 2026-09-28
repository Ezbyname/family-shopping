import {
  decideSearchLkg,
  buildSearchLkgKey,
} from '../api/_search-lkg.js';
import { normalizeProductText } from '../api/prices.js';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);

  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    console.error('    actual:  ', JSON.stringify(actual));
    console.error('    expected:', JSON.stringify(expected));
    failed++;
  }
}

const NOW = 1_000_000;
const TTL = 60_000;

const GOOD = [
  { barcode: '1', name: 'Black Coffee' },
];

const PARTIAL = [
  { barcode: '2', name: 'Partial Coffee' },
];

console.log('\n── Search Last-Known-Good semantics ──');

eq(
  '1. complete success becomes writable LKG',
  decideSearchLkg({
    current: {
      status: 'ok',
      partialFailure: false,
      products: GOOD,
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'fresh',
    products: GOOD,
    cacheAction: 'write',
    degraded: false,
  }
);

eq(
  '2. REMOTE_FAILURE serves valid LKG',
  decideSearchLkg({
    current: {
      status: 'REMOTE_FAILURE',
      products: [],
    },
    cached: {
      products: GOOD,
      savedAt: NOW - 10_000,
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'last_known_good',
    products: GOOD,
    cacheAction: 'keep',
    degraded: true,
  }
);

eq(
  '3. REMOTE_FAILURE without LKG remains failure',
  decideSearchLkg({
    current: {
      status: 'REMOTE_FAILURE',
      products: [],
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'remote_failure',
    products: [],
    cacheAction: 'keep',
    degraded: true,
  }
);

eq(
  '4. expired LKG is not served',
  decideSearchLkg({
    current: {
      status: 'REMOTE_FAILURE',
      products: [],
    },
    cached: {
      products: GOOD,
      savedAt: NOW - TTL - 1,
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'remote_failure',
    products: [],
    cacheAction: 'keep',
    degraded: true,
  }
);

eq(
  '5. partial success preserves valid complete LKG',
  decideSearchLkg({
    current: {
      status: 'ok',
      partialFailure: true,
      products: PARTIAL,
    },
    cached: {
      products: GOOD,
      savedAt: NOW - 10_000,
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'last_known_good',
    products: GOOD,
    cacheAction: 'keep',
    degraded: true,
  }
);

eq(
  '6. partial success without LKG remains usable but not writable',
  decideSearchLkg({
    current: {
      status: 'ok',
      partialFailure: true,
      products: PARTIAL,
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'partial_success',
    products: PARTIAL,
    cacheAction: 'keep',
    degraded: true,
  }
);

eq(
  '7. authoritative zero replaces older LKG with ZERO tombstone',
  decideSearchLkg({
    current: {
      status: 'SUCCESS_WITH_ZERO_RESULTS',
      products: [],
    },
    cached: {
      products: GOOD,
      savedAt: NOW - 10_000,
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'authoritative_zero',
    products: [],
    cacheAction: 'write_zero',
    degraded: false,
  }
);

eq(
  '8. status ok with no products is not written',
  decideSearchLkg({
    current: {
      status: 'ok',
      partialFailure: false,
      products: [],
    },
    now: NOW,
    ttlMs: TTL,
  }),
  {
    source: 'empty',
    products: [],
    cacheAction: 'keep',
    degraded: false,
  }
);


function searchKey(query, translated = query) {
  return buildSearchLkgKey({
    normalizedQuery: normalizeProductText(query),
    normalizedTranslatedQuery: normalizeProductText(translated),
  });
}

console.log('\n── Search LKG key contract ──');

eq(
  '9. case and surrounding whitespace normalize to same key',
  searchKey(' Coffee ', 'coffee'),
  searchKey('coffee', 'coffee')
);

eq(
  '10. percent wording normalizes to same key',
  searchKey('חלב 3 אחוז', 'milk 3%'),
  searchKey('חלב 3%', 'milk 3%')
);

eq(
  '11. equivalent Hebrew final-letter normalization is stable',
  searchKey('מלך', 'king'),
  searchKey('מלכ', 'king')
);

eq(
  '12. changing translated identity changes key',
  searchKey('coffee', 'coffee') === searchKey('coffee', 'tea'),
  false
);

eq(
  '13. distinct source queries do not share key only because translation matches',
  searchKey('קפה שחור', 'black coffee') ===
    searchKey('קפה', 'black coffee'),
  false
);

const firebaseSafeKey = searchKey('קפה שחור', 'black coffee');

eq(
  '14. key is versioned SHA-256 and Firebase-safe',
  /^v1_[a-f0-9]{64}$/.test(firebaseSafeKey),
  true
);

console.log(`\nsearch-lkg: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

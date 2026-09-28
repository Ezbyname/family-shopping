import {
  getSearchLkgConfig,
  SEARCH_LKG_PERSISTENCE_APPROVED,
} from '../api/_search-lkg-config.js';

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

console.log('\n── Search LKG runtime config safety gate ──');

eq(
  '1. source-controlled persistence approval is false',
  SEARCH_LKG_PERSISTENCE_APPROVED,
  false
);

eq(
  '2. absent feature flag is disabled',
  getSearchLkgConfig({}),
  {
    enabled: false,
    ttlMs: null,
  }
);

eq(
  '3. explicit false is disabled',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'false',
  }),
  {
    enabled: false,
    ttlMs: null,
  }
);

eq(
  '4. explicit zero is disabled',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: '0',
  }),
  {
    enabled: false,
    ttlMs: null,
  }
);

eq(
  '5. remote true is blocked by source approval gate',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'true',
  }),
  {
    enabled: false,
    ttlMs: null,
    blockedByApprovalGate: true,
  }
);

eq(
  '6. remote 1 is blocked by source approval gate',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: '1',
  }),
  {
    enabled: false,
    ttlMs: null,
    blockedByApprovalGate: true,
  }
);

eq(
  '7. valid TTL cannot bypass source approval gate',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'true',
    SEARCH_LKG_TTL_MS: '3600000',
  }),
  {
    enabled: false,
    ttlMs: null,
    blockedByApprovalGate: true,
  }
);

eq(
  '8. malformed TTL cannot bypass source approval gate',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'true',
    SEARCH_LKG_TTL_MS: 'banana',
  }),
  {
    enabled: false,
    ttlMs: null,
    blockedByApprovalGate: true,
  }
);

console.log(
  `\nsearch-lkg-config: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

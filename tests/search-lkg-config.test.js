import {
  getSearchLkgConfig,
  SEARCH_LKG_DEFAULT_TTL_MS,
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

console.log('\n── Search LKG runtime config ──');

eq(
  '1. absent feature flag is disabled',
  getSearchLkgConfig({}),
  {
    enabled: false,
    ttlMs: null,
  }
);

eq(
  '2. false is disabled',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'false',
  }),
  {
    enabled: false,
    ttlMs: null,
  }
);

eq(
  '3. zero is disabled',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: '0',
  }),
  {
    enabled: false,
    ttlMs: null,
  }
);

eq(
  '4. explicit true enables with conservative default TTL',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'true',
  }),
  {
    enabled: true,
    ttlMs: SEARCH_LKG_DEFAULT_TTL_MS,
  }
);

eq(
  '5. explicit 1 enables',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: '1',
  }),
  {
    enabled: true,
    ttlMs: SEARCH_LKG_DEFAULT_TTL_MS,
  }
);

eq(
  '6. configured positive TTL is accepted',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'true',
    SEARCH_LKG_TTL_MS: '3600000',
  }),
  {
    enabled: true,
    ttlMs: 3600000,
  }
);

eq(
  '7. zero TTL fail-closes the feature',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'true',
    SEARCH_LKG_TTL_MS: '0',
  }),
  {
    enabled: false,
    ttlMs: null,
    error: 'invalid_search_lkg_ttl',
  }
);

eq(
  '8. malformed TTL fail-closes the feature',
  getSearchLkgConfig({
    SEARCH_LKG_ENABLED: 'true',
    SEARCH_LKG_TTL_MS: 'banana',
  }),
  {
    enabled: false,
    ttlMs: null,
    error: 'invalid_search_lkg_ttl',
  }
);

console.log(
  `\nsearch-lkg-config: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

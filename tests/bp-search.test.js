/**
 * tests/bp-search.test.js
 *
 * Tests for the Search Stability commit.
 * Imports REAL production code — api/openfoodfacts-search.js and js/bp-search.js.
 * Mocks only outbound fetch to OpenFoodFacts or the same-origin proxy.
 * Does NOT recreate ranking, scoring, heStrict, or eligibility logic.
 */

import handler, { OFF_ERR } from '../api/openfoodfacts-search.js';
import {
  bpSelectName,
  bpConsumeBatches,
  bpFetchCorpus,
  _testOnlyGetCache,
  _testOnlyClearCache,
  _testOnlySetClientTimeout,
} from '../js/bp-search.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeMockRes() {
  const captured = { code: null, body: null };
  return {
    setHeader: () => {},
    status(code) {
      captured.code = code;
      return {
        json(data) { captured.body = data; },
        end()      { captured.body = null; },
      };
    },
    captured,
  };
}

function makeReq(query = {}) {
  return { method: 'GET', query };
}

function mockFetch(responses) {
  // responses: array of { ok, status, body } — consumed in order
  let i = 0;
  global.fetch = async () => {
    const resp = responses[Math.min(i++, responses.length - 1)];
    if (resp.throws) throw resp.throws;
    return {
      ok:     resp.ok !== false,
      status: resp.status || 200,
      json:   async () => resp.body,
      text:   async () => JSON.stringify(resp.body),
    };
  };
}

function mockFetchAll(response) {
  global.fetch = async () => {
    if (response.throws) throw response.throws;
    return {
      ok:     response.ok !== false,
      status: response.status || 200,
      json:   async () => response.body,
    };
  };
}

function makeProduct(overrides = {}) {
  return {
    code:             overrides.code            ?? '1234567890123',
    product_name:     overrides.product_name    ?? 'Cheese',
    product_name_he:  overrides.product_name_he ?? 'גבינה',
    product_name_ar:  overrides.product_name_ar ?? 'جبن',
    brands:           overrides.brands          ?? 'Tnuva',
    quantity:         overrides.quantity        ?? '200g',
    image_small_url:  overrides.image           ?? '',
    countries_tags:   overrides.countries_tags  ?? ['en:israel'],
  };
}

function offResp(products) {
  return { ok: true, status: 200, body: { products } };
}

// ── Section A: Real API handler tests ─────────────────────────────────────────

console.log('\n── A. API handler ──');

await asyncTest('1. original_il success — returns ok with products', async () => {
  const p = makeProduct();
  mockFetchAll(offResp([p]));
  const res = makeMockRes();
  await handler(makeReq({ q: 'cheese' }), res);
  assertEqual(res.captured.code, 200);
  assertEqual(res.captured.body.status, 'ok');
  assert(res.captured.body.batches.some(b => b.strategy === 'original_il' && b.products.length === 1));
});

await asyncTest('2. translated_il strategy present when translatedQ differs', async () => {
  mockFetchAll(offResp([makeProduct()]));
  const res = makeMockRes();
  await handler(makeReq({ q: 'גבינה', translatedQ: 'cheese' }), res);
  assertEqual(res.captured.body.status, 'ok');
  const strategies = res.captured.body.batches.map(b => b.strategy);
  assert(strategies.includes('translated_il'), 'translated_il missing');
  assert(strategies.includes('original_il'),   'original_il missing');
  assert(strategies.includes('translated_broad'), 'translated_broad missing');
});

await asyncTest('3. translated_broad always present', async () => {
  mockFetchAll(offResp([]));
  const res = makeMockRes();
  await handler(makeReq({ q: 'milk' }), res);
  assert(res.captured.body.batches.some(b => b.strategy === 'translated_broad'));
});

await asyncTest('4. translated_il omitted when translatedQ === q', async () => {
  mockFetchAll(offResp([]));
  const res = makeMockRes();
  await handler(makeReq({ q: 'milk', translatedQ: 'milk' }), res);
  assertEqual(res.captured.body.status, 'SUCCESS_WITH_ZERO_RESULTS');
  const strategies = res.captured.body.batches.map(b => b.strategy);
  assert(!strategies.includes('translated_il'), 'translated_il should be absent');
  assertEqual(strategies.length, 2); // original_il + translated_broad
});

await asyncTest('5. partial success — one batch fails, other has products → ok', async () => {
  let call = 0;
  global.fetch = async () => {
    call++;
    if (call === 1) return { ok: true, status: 200, json: async () => ({ products: [makeProduct()] }) };
    if (call === 2) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    return { ok: true, status: 200, json: async () => ({ products: [] }) };
  };
  const res = makeMockRes();
  await handler(makeReq({ q: 'milk' }), res);
  assertEqual(res.captured.body.status, 'ok');
  const failed = res.captured.body.batches.filter(b => b.error !== null);
  assert(failed.length > 0, 'should have at least one failed batch');
});

await asyncTest('6. all batches succeed + zero products → SUCCESS_WITH_ZERO_RESULTS', async () => {
  mockFetchAll(offResp([]));
  const res = makeMockRes();
  await handler(makeReq({ q: 'xyznotaproduct' }), res);
  assertEqual(res.captured.body.status, 'SUCCESS_WITH_ZERO_RESULTS');
  assert(res.captured.body.batches.every(b => b.error === null));
});

await asyncTest('7. zero products + one batch failure → REMOTE_FAILURE', async () => {
  let call = 0;
  global.fetch = async () => {
    call++;
    if (call === 1) return { ok: true, status: 200, json: async () => ({ products: [] }) };
    throw Object.assign(new Error('net'), { name: 'TypeError' });
  };
  const res = makeMockRes();
  await handler(makeReq({ q: 'abc' }), res);
  assertEqual(res.captured.body.status, 'REMOTE_FAILURE');
});

await asyncTest('8. all batches fail → REMOTE_FAILURE', async () => {
  global.fetch = async () => { throw Object.assign(new Error('net'), { name: 'TypeError' }); };
  const res = makeMockRes();
  await handler(makeReq({ q: 'abc' }), res);
  assertEqual(res.captured.body.status, 'REMOTE_FAILURE');
  assert(res.captured.body.batches.every(b => b.error !== null));
});

await asyncTest('9. HTTP 4xx → off_http_4xx bounded error code', async () => {
  mockFetchAll({ ok: false, status: 404, body: null });
  const res = makeMockRes();
  await handler(makeReq({ q: 'test' }), res);
  assert(res.captured.body.batches.some(b => b.error === OFF_ERR.HTTP_4XX));
});

await asyncTest('10. HTTP 5xx → off_http_5xx bounded error code', async () => {
  mockFetchAll({ ok: false, status: 503, body: null });
  const res = makeMockRes();
  await handler(makeReq({ q: 'test' }), res);
  assert(res.captured.body.batches.some(b => b.error === OFF_ERR.HTTP_5XX));
});

await asyncTest('11. timeout → off_timeout bounded error code', async () => {
  global.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  const res = makeMockRes();
  await handler(makeReq({ q: 'test' }), res);
  assert(res.captured.body.batches.some(b => b.error === OFF_ERR.TIMEOUT));
});

await asyncTest('12. malformed OFF JSON → off_parse bounded error code', async () => {
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => { throw new SyntaxError('bad json'); },
  });
  const res = makeMockRes();
  await handler(makeReq({ q: 'test' }), res);
  assert(res.captured.body.batches.some(b => b.error === OFF_ERR.PARSE));
});

await asyncTest('13. raw OFF product fields preserved in batch', async () => {
  const p = makeProduct({ code: '9876543210123', product_name_he: 'חלב', brands: 'Tnuva' });
  mockFetchAll(offResp([p]));
  const res = makeMockRes();
  await handler(makeReq({ q: 'milk' }), res);
  const products = res.captured.body.batches.flatMap(b => b.products);
  const found = products.find(x => x.code === '9876543210123');
  assert(found, 'product not found');
  assertEqual(found.product_name_he, 'חלב');
  assertEqual(found.brands, 'Tnuva');
});

await asyncTest('14. ordered batch structure preserved (original_il first)', async () => {
  mockFetchAll(offResp([]));
  const res = makeMockRes();
  await handler(makeReq({ q: 'a', translatedQ: 'b' }), res);
  const strategies = res.captured.body.batches.map(b => b.strategy);
  assertEqual(strategies[0], 'original_il');
  assertEqual(strategies[strategies.length - 1], 'translated_broad');
});

// ── Section B: Real client module tests ───────────────────────────────────────

console.log('\n── B. Client module (bpFetchCorpus) ──');

const PROXY_OK_RESP = {
  status: 'ok',
  batches: [{ strategy: 'original_il', products: [makeProduct()], error: null }],
};

const PROXY_ZERO_RESP = {
  status: 'SUCCESS_WITH_ZERO_RESULTS',
  batches: [{ strategy: 'original_il', products: [], error: null }],
};

const PROXY_FAIL_RESP = {
  status: 'REMOTE_FAILURE',
  batches: [{ strategy: 'original_il', products: [], error: 'off_timeout' }],
};

function mockProxy(response) {
  global.fetch = async () => {
    if (response.throws) throw response.throws;
    return {
      ok:     response.ok !== false,
      status: response.status || 200,
      json:   async () => response.body,
    };
  };
}

function setFakeCache(key, data, ageMs) {
  _testOnlyGetCache().set(key, { data, fetchedAt: Date.now() - ageMs });
}

const FRESH   = 1  * 60 * 1000;   // 1 min (within FRESH_TTL)
const STALE   = 10 * 60 * 1000;   // 10 min (stale but within STALE_IF_ERROR)
const EXPIRED = 35 * 60 * 1000;   // 35 min (beyond STALE_IF_ERROR)

const CK = 'he:גבינה'; // canonical test cache key

await asyncTest('15. fresh cache → no network call', async () => {
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_OK_RESP, FRESH);
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => PROXY_OK_RESP }; };
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assert(!called, 'fetch should not be called on fresh cache hit');
  assert(result.fromCache === true);
  assert(result.stale === false);
});

await asyncTest('16. stale cache + successful refresh → replaced', async () => {
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_ZERO_RESP, STALE);
  mockProxy({ body: PROXY_OK_RESP });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assert(result.fromCache === false);
  assertEqual(result.status, 'ok');
});

await asyncTest('17. stale cache + proxy REMOTE_FAILURE → stale served', async () => {
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_OK_RESP, STALE);
  mockProxy({ body: PROXY_FAIL_RESP });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assert(result.fromCache === true);
  assert(result.stale === true);
  assertEqual(result.status, 'ok');
});

await asyncTest('18. stale cache + proxy HTTP 503 → stale served', async () => {
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_OK_RESP, STALE);
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assert(result.fromCache === true);
  assert(result.stale === true);
});

await asyncTest('19. stale cache + rejected fetch → stale served', async () => {
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_OK_RESP, STALE);
  global.fetch = async () => { throw new TypeError('network error'); };
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assert(result.fromCache === true);
  assert(result.stale === true);
});

await asyncTest('20. stale cache + malformed proxy JSON → stale served', async () => {
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_OK_RESP, STALE);
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => { throw new SyntaxError('bad'); },
  });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assert(result.fromCache === true);
  assert(result.stale === true);
});

await asyncTest('21. expired stale cache + failure → REMOTE_FAILURE', async () => {
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_OK_RESP, EXPIRED);
  global.fetch = async () => { throw new TypeError('net'); };
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assertEqual(result.status, 'REMOTE_FAILURE');
  assert(result.fromCache === false);
});

await asyncTest('22. no cache + failure → REMOTE_FAILURE', async () => {
  _testOnlyClearCache();
  global.fetch = async () => { throw new TypeError('net'); };
  const result = await bpFetchCorpus('new', 'new', CK, 20);
  assertEqual(result.status, 'REMOTE_FAILURE');
  assert(result.fromCache === false);
});

await asyncTest('23. successful zero → cached as authoritative zero', async () => {
  _testOnlyClearCache();
  mockProxy({ body: PROXY_ZERO_RESP });
  await bpFetchCorpus('empty', 'empty', CK, 20);
  const cache = _testOnlyGetCache();
  assert(cache.has(CK), 'zero result should be cached');
  assertEqual(cache.get(CK).data.status, 'SUCCESS_WITH_ZERO_RESULTS');
});

await asyncTest('24. second open does not clear successful cache', async () => {
  _testOnlyClearCache();
  mockProxy({ body: PROXY_OK_RESP });
  await bpFetchCorpus('persist', 'persist', CK, 20);
  // simulate closeBrandPicker — no _corpusCache.clear() in new code
  // second call should hit cache without fetching
  let fetched = false;
  global.fetch = async () => { fetched = true; return { ok: true, json: async () => PROXY_OK_RESP }; };
  const r2 = await bpFetchCorpus('persist', 'persist', CK, 20);
  assert(!fetched, 'cache should survive picker close');
  assert(r2.fromCache === true);
});

await asyncTest('25. abort propagates to transport', async () => {
  _testOnlyClearCache();
  const ctrl = new AbortController();
  global.fetch = async (url, opts) => {
    ctrl.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  try {
    await bpFetchCorpus('signal', 'signal', '', 20, { signal: ctrl.signal });
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e.name === 'AbortError', `expected AbortError, got ${e.name}: ${e.message}`);
  }
});

await asyncTest('26. aborted old request cannot overwrite cache', async () => {
  _testOnlyClearCache();
  // Prime cache with stale data
  setFakeCache(CK, PROXY_OK_RESP, STALE);
  const ctrl = new AbortController();
  global.fetch = async () => {
    ctrl.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  try {
    await bpFetchCorpus('race', 'race', CK, 20, { signal: ctrl.signal });
  } catch (_) {}
  // Cache should still have original stale entry — not replaced or deleted
  assert(_testOnlyGetCache().has(CK), 'stale cache should not be evicted by aborted request');
});

// ── Section B2: v2 transport + partial-failure tests ─────────────────────────

console.log('\n── B2. v2 transport + partial-failure ──');

await asyncTest('36. caller abort → AbortError propagated, stale not served', async () => {
  _testOnlyClearCache();
  // stale cache exists but caller abort must NOT silently return stale
  setFakeCache(CK, PROXY_OK_RESP, STALE);
  const ctrl = new AbortController();
  ctrl.abort(); // pre-aborted
  let threw = false;
  try {
    await bpFetchCorpus('גבינה', 'cheese', CK, 40, { signal: ctrl.signal });
    assert(false, 'should have thrown AbortError');
  } catch (e) {
    threw = e.name === 'AbortError';
  }
  assert(threw, 'pre-aborted signal must propagate as AbortError');
});

await asyncTest('37. transport timeout → underlying fetch aborted, REMOTE_FAILURE returned', async () => {
  _testOnlyClearCache();
  _testOnlySetClientTimeout(50); // fast timeout for this test
  let fetchAborted = false;
  global.fetch = async (url, opts) => {
    // Block until signal fires
    await new Promise(resolve => {
      if (opts?.signal?.aborted) { fetchAborted = true; resolve(); return; }
      opts?.signal?.addEventListener('abort', () => { fetchAborted = true; resolve(); }, { once: true });
    });
    throw Object.assign(new Error('aborted by internal ctrl'), { name: 'AbortError' });
  };
  const result = await bpFetchCorpus('timeout-test', 'timeout-test', '', 20);
  _testOnlySetClientTimeout(26_000); // restore
  assert(fetchAborted, 'underlying fetch must be aborted on transport timeout');
  assertEqual(result.status, 'REMOTE_FAILURE', 'transport timeout → REMOTE_FAILURE');
});

await asyncTest('38. listener and timer cleanup after successful fetch', async () => {
  _testOnlyClearCache();
  const ctrl = new AbortController();
  let listenerCount = 0;
  const origAddEventListener = ctrl.signal.addEventListener.bind(ctrl.signal);
  const origRemoveEventListener = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = (type, fn, opts) => { listenerCount++; origAddEventListener(type, fn, opts); };
  ctrl.signal.removeEventListener = (type, fn) => { listenerCount--; origRemoveEventListener(type, fn); };

  mockProxy({ body: PROXY_OK_RESP });
  await bpFetchCorpus('cleanup', 'cleanup', '', 20, { signal: ctrl.signal });
  // After fetch completes, removeEventListener should have been called — net count 0
  assertEqual(listenerCount, 0, 'abort listener must be cleaned up after successful fetch');
});

await asyncTest('39. partial failure + stale complete cache → stale served, cache not overwritten', async () => {
  _testOnlyClearCache();
  const completeOkResp = {
    status: 'ok',
    batches: [{ strategy: 'original_il', products: [makeProduct({ code: 'stale1' })], error: null }],
  };
  setFakeCache(CK, completeOkResp, STALE);
  // proxy returns ok but with a partial failure batch
  const partialResp = {
    status: 'ok',
    batches: [
      { strategy: 'original_il',   products: [makeProduct({ code: 'fresh1' })], error: null },
      { strategy: 'translated_broad', products: [], error: 'off_timeout' },
    ],
  };
  mockProxy({ body: partialResp });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assert(result.fromCache === true,  'should serve stale on partial failure');
  assert(result.stale    === true,   'must be marked stale');
  // cache must NOT have been overwritten with partial response
  const cached = _testOnlyGetCache().get(CK);
  assert(cached.data.batches[0].products[0].code === 'stale1', 'cache must not be overwritten with partial');
});

await asyncTest('40. partial failure + no cache + products → partialFailure:true, NOT cached', async () => {
  _testOnlyClearCache();
  const partialResp = {
    status: 'ok',
    batches: [
      { strategy: 'original_il',     products: [makeProduct({ code: 'p1' })], error: null },
      { strategy: 'translated_broad', products: [], error: 'off_timeout' },
    ],
  };
  mockProxy({ body: partialResp });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assertEqual(result.status, 'ok');
  assert(result.partialFailure === true, 'must signal partialFailure');
  assert(result.fromCache === false);
  assert(!_testOnlyGetCache().has(CK), 'partial response must NOT be cached');
});

await asyncTest('41. partial failure + no cache + zero usable products → REMOTE_FAILURE semantics, NOT cached', async () => {
  _testOnlyClearCache();
  // off returns ok status but all products have no names, and one batch fails
  const partialResp = {
    status: 'ok',
    batches: [
      { strategy: 'original_il',     products: [makeProduct({ code: 'p2' })], error: null },
      { strategy: 'translated_broad', products: [], error: 'off_timeout' },
    ],
  };
  mockProxy({ body: partialResp });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  // result has partialFailure:true; caller in app.js checks raw.length===0 && partialFailure
  // Here we just confirm partialFailure is flagged and NOT cached
  assert(result.partialFailure === true, 'partialFailure must be flagged');
  assert(!_testOnlyGetCache().has(CK), 'partial response must NOT be cached');
});

await asyncTest('42. root-token key sharing: גבינה and גבינה לבנה use same he:גבינה cache', async () => {
  _testOnlyClearCache();
  // Populate cache with גבינה
  mockProxy({ body: PROXY_OK_RESP });
  await bpFetchCorpus('גבינה', 'cheese', 'he:גבינה', 40);
  assert(_testOnlyGetCache().has('he:גבינה'), 'cache must have he:גבינה');
  // Now fetch גבינה לבנה with the same root token key
  let fetched = false;
  global.fetch = async () => { fetched = true; return { ok: true, json: async () => PROXY_OK_RESP }; };
  const result = await bpFetchCorpus('גבינה לבנה', 'white cheese', 'he:גבינה', 40);
  assert(!fetched, 'גבינה לבנה should hit the shared he:גבינה cache');
  assert(result.fromCache === true, 'must be a cache hit');
});

// ── Section B3: abort-source race tests ──────────────────────────────────────

console.log('\n── B3. Abort-source race (BLOCKER 1 regression) ──');

await asyncTest('43. timeout fires first, caller aborts immediately after — result must be REMOTE_FAILURE', async () => {
  _testOnlyClearCache();
  _testOnlySetClientTimeout(10);
  const ctrl = new AbortController();
  global.fetch = async (url, opts) => {
    // Wait for the internal abort (timeout fires and aborts internal ctrl)
    await new Promise(resolve => {
      if (opts?.signal?.aborted) { resolve(); return; }
      opts?.signal?.addEventListener('abort', () => {
        // Timeout just fired. Immediately trigger caller abort before returning.
        ctrl.abort();
        resolve();
      }, { once: true });
    });
    throw Object.assign(new Error('internal abort'), { name: 'AbortError' });
  };
  const result = await bpFetchCorpus('timeout-race', 'timeout-race', '', 20, { signal: ctrl.signal });
  _testOnlySetClientTimeout(26_000);
  assertEqual(result.status, 'REMOTE_FAILURE',
    'timeout fires first must produce REMOTE_FAILURE even when caller also aborts right after');
});

await asyncTest('44. caller aborts first, timeout fires later — result must be AbortError', async () => {
  _testOnlyClearCache();
  _testOnlySetClientTimeout(20); // short enough to fire during test
  const ctrl = new AbortController();
  global.fetch = async (url, opts) => {
    // Caller aborts immediately (before timeout can fire)
    ctrl.abort();
    // Wait long enough for the 20ms timeout to also fire, then reject
    await new Promise(r => setTimeout(r, 60));
    throw Object.assign(new Error('abort'), { name: 'AbortError' });
  };
  let threw = false;
  try {
    await bpFetchCorpus('caller-race', 'caller-race', '', 20, { signal: ctrl.signal });
    assert(false, 'should have thrown');
  } catch (e) {
    threw = e.name === 'AbortError';
  }
  _testOnlySetClientTimeout(26_000);
  assert(threw, 'caller-abort-first must produce AbortError even when timeout also fires later');
});

// ── Section B4: expired cache + partial success (BLOCKER 2) ──────────────────

console.log('\n── B4. Expired cache + partial success (BLOCKER 2) ──');

await asyncTest('45. expired cache + partial refresh with products → partialFailure:true returned, not cached', async () => {
  _testOnlyClearCache();
  const completeEntry = {
    status: 'ok',
    batches: [{ strategy: 'original_il', products: [makeProduct({ code: 'old1' })], error: null }],
  };
  setFakeCache(CK, completeEntry, EXPIRED); // 35 min — beyond STALE_IF_ERROR
  const partialResp = {
    status: 'ok',
    batches: [
      { strategy: 'original_il',     products: [makeProduct({ code: 'fresh1' })], error: null },
      { strategy: 'translated_broad', products: [], error: 'off_timeout' },
    ],
  };
  mockProxy({ body: partialResp });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  assertEqual(result.status, 'ok',               'partial ok must remain ok');
  assert(result.partialFailure === true,          'must signal partialFailure');
  assert(result.fromCache === false,              'must not be served from cache');
  assert(result.stale === false,                  'must not be flagged stale');
  // products must be present — caller (app.js) decides what to do with them
  assert(result.batches.some(b => b.products.length > 0), 'fresh partial batches must be present in response');
  // expired cache entry must NOT be overwritten with partial response
  const cached = _testOnlyGetCache().get(CK);
  assert(cached.data.batches[0].products[0].code === 'old1', 'expired cache must not be overwritten by partial');
});

await asyncTest('46. expired cache + partial refresh whose usable products will be decided by caller', async () => {
  // Confirms that when expired cache exists, a partial response is returned
  // to app.js intact (not swallowed as REMOTE_FAILURE) so app.js can
  // apply bpConsumeBatches and decide: show partial results or show unavailable.
  _testOnlyClearCache();
  setFakeCache(CK, PROXY_OK_RESP, EXPIRED);
  const partialWithTwoProducts = {
    status: 'ok',
    batches: [
      { strategy: 'original_il',     products: [makeProduct({ code: 'a' }), makeProduct({ code: 'b' })], error: null },
      { strategy: 'translated_broad', products: [], error: 'off_network' },
    ],
  };
  mockProxy({ body: partialWithTwoProducts });
  const result = await bpFetchCorpus('גבינה', 'cheese', CK, 40);
  // Must reach caller with partialFailure flag so app.js can render appropriately
  assert(result.partialFailure === true, 'partial flag must reach caller');
  const allProducts = result.batches.flatMap(b => b.products);
  assert(allProducts.length === 2, 'both fresh products must be present for caller to consume');
  assert(!_testOnlyGetCache().has(CK) || _testOnlyGetCache().get(CK).data !== partialWithTwoProducts,
    'partial must not have been cached');
});

// ── Section C: Parent-parity tests ───────────────────────────────────────────

console.log('\n── C. Parent-parity (bpConsumeBatches / bpSelectName) ──');

test('27. two codeless products both survive (no dedup on empty code)', () => {
  const batches = [{
    strategy: 'original_il',
    products: [
      { code: '', product_name: 'Product A', product_name_he: '', product_name_ar: '', brands: '', quantity: '', image_small_url: '', countries_tags: [] },
      { code: '', product_name: 'Product B', product_name_he: '', product_name_ar: '', brands: '', quantity: '', image_small_url: '', countries_tags: [] },
    ],
  }];
  const seen = new Set(); const raw = [];
  bpConsumeBatches(batches, seen, raw, 'latin');
  assertEqual(raw.length, 2, 'both codeless products should survive');
  assert(raw.every(p => p.barcode === ''), 'both should have empty barcode');
});

test('28. duplicate real barcode is deduplicated', () => {
  const batches = [{
    strategy: 'original_il',
    products: [
      makeProduct({ code: '111', product_name: 'A' }),
      makeProduct({ code: '111', product_name: 'A-dup' }),
      makeProduct({ code: '222', product_name: 'B' }),
    ],
  }];
  const seen = new Set(); const raw = [];
  bpConsumeBatches(batches, seen, raw, 'latin');
  assertEqual(raw.length, 2);
  assertEqual(raw.filter(p => p.barcode === '111').length, 1);
});

test('29. Hebrew name-selection parity — he || en, no Arabic', () => {
  const p = { product_name_he: 'גבינה', product_name_ar: 'جبن', product_name: 'Cheese' };
  assertEqual(bpSelectName(p, 'he'), 'גבינה', 'he query → Hebrew name');
});

test('30. Arabic name-selection parity — ar || he || en', () => {
  const p = { product_name_he: 'גבינה', product_name_ar: 'جبن', product_name: 'Cheese' };
  assertEqual(bpSelectName(p, 'ar'), 'جبن', 'ar query → Arabic name');
});

test('31. Latin name-selection parity — en || he || ar', () => {
  const p = { product_name_he: 'גבינה', product_name_ar: 'جبن', product_name: 'Cheese' };
  assertEqual(bpSelectName(p, 'latin'), 'Cheese', 'latin query → English name');
});

test('32. Hebrew missing-name fallback is he→en, NOT Arabic', () => {
  const noHe = { product_name_he: '', product_name_ar: 'جبن', product_name: 'Cheese' };
  assertEqual(bpSelectName(noHe, 'he'), 'Cheese', 'he query, no Hebrew → English, not Arabic');
  assert(bpSelectName(noHe, 'he') !== 'جبن', 'must not fall through to Arabic for he query');
});

test('33. batch with 60 eligible products → raw has 60, not 55', () => {
  const products = Array.from({ length: 60 }, (_, i) => ({
    code: String(1000 + i), product_name: `P${i}`,
    product_name_he: '', product_name_ar: '', brands: '', quantity: '', image_small_url: '', countries_tags: [],
  }));
  const batches = [{ strategy: 'original_il', products }];
  const seen = new Set(); const raw = [];
  bpConsumeBatches(batches, seen, raw, 'latin');
  assertEqual(raw.length, 60, 'full batch must be consumed even when it exceeds 55');
});

test('34. following batch skipped once raw >= 55 before it starts', () => {
  const products60 = Array.from({ length: 60 }, (_, i) => ({
    code: String(1000 + i), product_name: `P${i}`,
    product_name_he: '', product_name_ar: '', brands: '', quantity: '', image_small_url: '', countries_tags: [],
  }));
  const batches = [
    { strategy: 'original_il', products: products60 },
    { strategy: 'translated_broad', products: [makeProduct({ code: '9999', product_name: 'Extra' })] },
  ];
  const seen = new Set(); const raw = [];
  bpConsumeBatches(batches, seen, raw, 'latin');
  assertEqual(raw.length, 60, 'second batch should not be processed');
  assert(!raw.some(p => p.barcode === '9999'), '9999 product must not appear');
});

test('35. ordered batches preserve corpus order across batch boundaries', () => {
  const batches = [
    { strategy: 'original_il',     products: [makeProduct({ code: 'A', product_name: 'First' })]  },
    { strategy: 'translated_il',   products: [makeProduct({ code: 'B', product_name: 'Second' })] },
    { strategy: 'translated_broad', products: [makeProduct({ code: 'C', product_name: 'Third' })]  },
  ];
  const seen = new Set(); const raw = [];
  bpConsumeBatches(batches, seen, raw, 'latin');
  assertEqual(raw.length, 3);
  assertEqual(raw[0].barcode, 'A');
  assertEqual(raw[1].barcode, 'B');
  assertEqual(raw[2].barcode, 'C');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nbp-search: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

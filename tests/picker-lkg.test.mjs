// tests/picker-lkg.test.mjs
// /api/openfoodfacts-search wired to the EXISTING Search LKG (persistence stays gated OFF).
// All storage is an in-memory Map behind the real createSearchLkgRepository.
import handler, { _setPickerLkgForTests } from '../api/openfoodfacts-search.js';
import { createSearchLkgRepository } from '../api/_search-lkg-repository.js';
import { buildSearchLkgKey } from '../api/_search-lkg.js';
import {
  SEARCH_LKG_PERSISTENCE_APPROVED, getSearchLkgConfig, SEARCH_LKG_DEFAULT_TTL_MS,
} from '../api/_search-lkg-config.js';
import { createSearchLkgRuntime } from '../api/_search-lkg-runtime.js';
import { buildPickerLkgKey, resolvePickerSearch, flattenBatches, rebuildBatches, isTrustworthyPickerResult } from '../api/_off-picker-lkg.js';
import { bpFetchCorpus, bpConsumeBatches, _testOnlyGetCache, _testOnlyClearCache } from '../js/bp-search.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

// ── fixtures ────────────────────────────────────────────────────────────────
const TTL = SEARCH_LKG_DEFAULT_TTL_MS;
const prod = (code, he, brands = '', image) => ({ code, product_name_he: he, product_name: he, brands, quantity: '', countries_tags: ['en:israel'], ...(image ? { image_small_url: image } : {}) });
const CASES = {
  'גבינה':       { en: 'cheese',        il: [prod('1001', 'גבינה צהובה', 'תנובה', 'http://i/1.jpg'), prod('1002', 'קוטג׳', 'שטראוס')], tr: [prod('2001', 'Cheddar Cheese')], br: [prod('3001', 'Cream cheese')] },
  'גבינה לבנה':  { en: 'white cheese',  il: [prod('1101', 'גבינה לבנה 5%', 'תנובה'), prod('1102', 'גבינה לבנה 3%')], tr: [prod('2101', 'גבינה לבנה עם שום')], br: [prod('3101', 'Bulgarian White Cheese'), prod('3102', 'ORIGINAL WHITE CHEESE')] },
  'שמנת לבישול': { en: 'cooking cream', il: [prod('7290000056951', 'שמנת לבישול', 'תנובה'), prod('7290000522340', 'שמנת לבישול 15%', 'רמת הגולן', 'http://i/c.jpg')], tr: [], br: [prod('3201', 'Cooking cream UHT')] },
};

function memRepo() {
  const store = new Map(); const log = { reads: 0, writes: 0 };
  const repo = createSearchLkgRepository({
    read: async k => { log.reads++; return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null; },
    write: async (k, r) => { log.writes++; store.set(k, JSON.parse(JSON.stringify(r))); },
    remove: async k => { store.delete(k); },
  });
  return { repo, store, log };
}

// behaviour per strategy: 'ok' | '503' | 'timeout' | 'zero'
function mockOff(q, c, beh) {
  global.fetch = async (url) => {
    const u = new URL(url);
    const il = u.searchParams.get('tag_0') === 'israel';
    const terms = u.searchParams.get('search_terms');
    const strategy = !il ? 'br' : (terms === q ? 'il' : 'tr');
    const b = beh[strategy] || 'ok';
    if (b === 'timeout') throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    if (b === '503') return { ok: false, status: 503, json: async () => ({}) };
    const products = b === 'zero' ? [] : c[strategy];
    return { ok: true, status: 200, json: async () => ({ products }) };
  };
}
async function call(q, pageSize = 40) {
  const c = CASES[q];
  let body; const res = { setHeader() {}, status() { return { json(d) { body = d; }, end() {} }; } };
  await handler({ method: 'GET', query: { q, translatedQ: c.en, pageSize: String(pageSize) } }, res);
  return body;
}
const ALL = { il: 'ok', tr: 'ok', br: 'ok' };
const DOWN = { il: '503', tr: '503', br: '503' };
const names = r => r.batches.flatMap(b => b.products.map(p => p.code));

// ── 1-4 core flows ───────────────────────────────────────────────────────────
console.log('\nCore flows');
await test('1. fresh OFF success → fresh response and LKG updated', async () => {
  const { repo, store, log } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], ALL);
  const r = await call('גבינה');
  eq(r.status, 'ok'); eq(r.cacheStatus, 'fresh'); eq(r.offStatus, 'ok'); eq(r.lkgMutationStatus, 'ok');
  eq(log.writes, 1); eq(store.size, 1);
  const rec = [...store.values()][0]; eq(rec.state, 'good'); eq(rec.products.length, 4);
});
await test('2. OFF 503 + valid LKG → stale-if-error with the cached results', async () => {
  const { repo } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], ALL); const first = await call('גבינה');
  mockOff('גבינה', CASES['גבינה'], DOWN); const r = await call('גבינה');
  eq(r.status, 'ok'); eq(r.cacheStatus, 'stale-if-error'); eq(r.offStatus, 'REMOTE_FAILURE');
  ok(Number.isFinite(r.cachedAt) && r.ageSeconds >= 0, 'cachedAt/ageSeconds');
  eq(names(r), names(first), 'same products as the fresh answer');
  ok(r.batches.every(b => b.error === null) && r.batches[0].strategy === 'original_il');
});
await test('3. OFF timeout + valid LKG → same fallback', async () => {
  const { repo } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], ALL); await call('גבינה');
  mockOff('גבינה', CASES['גבינה'], { il: 'timeout', tr: 'timeout', br: 'timeout' });
  const r = await call('גבינה'); eq(r.cacheStatus, 'stale-if-error'); eq(r.offStatus, 'REMOTE_FAILURE');
});
await test('4. OFF failure + no LKG → unavailable (REMOTE_FAILURE, cacheStatus none)', async () => {
  const { repo, log } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], DOWN); const r = await call('גבינה');
  eq(r.status, 'REMOTE_FAILURE'); eq(r.cacheStatus, 'none'); eq(log.writes, 0);
  ok(r.batches.every(b => b.error === 'off_http_5xx'));
});

// ── 5-7 degraded / zero ──────────────────────────────────────────────────────
console.log('\nDegraded and zero results');
await test('5a. Hebrew: both Israel batches fail, broad English survives → NOT cached, no LKG → degraded response', async () => {
  const { repo, log } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה לבנה', CASES['גבינה לבנה'], { il: '503', tr: '503', br: 'ok' });
  const r = await call('גבינה לבנה');
  eq(log.writes, 0, 'degraded corpus must not be written'); eq(r.cacheStatus, 'fresh');
  eq(r.batches.find(b => b.strategy === 'original_il').error, 'off_http_5xx');
});
await test('5b. same degraded corpus + prior valid LKG → LKG is served instead of the English-only corpus', async () => {
  const { repo } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה לבנה', CASES['גבינה לבנה'], ALL); await call('גבינה לבנה');
  mockOff('גבינה לבנה', CASES['גבינה לבנה'], { il: '503', tr: '503', br: 'ok' });
  const r = await call('גבינה לבנה');
  eq(r.cacheStatus, 'stale-if-error');
  ok(names(r).includes('1101'), 'Hebrew Israel results present');
});
await test('6. partial failure must NOT overwrite a good LKG', async () => {
  const { repo, store } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], ALL); await call('גבינה');
  const key = [...store.keys()][0]; const before = JSON.stringify(store.get(key));
  mockOff('גבינה', CASES['גבינה'], { il: '503', tr: 'ok', br: '503' });
  const r = await call('גבינה');
  eq(r.cacheStatus, 'stale-if-error'); eq(JSON.stringify(store.get(key)), before, 'record untouched');
});
await test('6b. a later trustworthy-but-incomplete answer (translated/broad failed) still updates LKG', async () => {
  const { repo, store } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], ALL); await call('גבינה');
  mockOff('גבינה', CASES['גבינה'], { il: 'ok', tr: '503', br: '503' });
  const r = await call('גבינה'); eq(r.cacheStatus, 'fresh'); eq(r.lkgMutationStatus, 'ok');
  eq([...store.values()][0].products.length, 2, 'LKG now holds the fresh original_il answer');
});
await test('7. legitimate fresh zero results are NOT replaced by stale LKG', async () => {
  const { repo, store } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], ALL); await call('גבינה');
  mockOff('גבינה', CASES['גבינה'], { il: 'zero', tr: 'zero', br: 'zero' });
  const r = await call('גבינה');
  eq(r.status, 'SUCCESS_WITH_ZERO_RESULTS'); eq(r.cacheStatus, 'fresh'); eq(names(r), []);
  eq([...store.values()][0].state, 'zero', 'tombstone replaces the older good record');
  mockOff('גבינה', CASES['גבינה'], DOWN);
  eq((await call('גבינה')).cacheStatus, 'none', 'tombstone is never served as stale results');
});

// ── 8 key isolation ──────────────────────────────────────────────────────────
console.log('\nKey isolation, TTL, images');
await test('8. cache keys: גבינה ≠ גבינה לבנה ≠ שמנת לבישול (and ≠ the /api/prices key)', async () => {
  const k = q => buildPickerLkgKey({ q, translatedQ: CASES[q].en, pageSize: 40 });
  const keys = Object.keys(CASES).map(k);
  eq(new Set(keys).size, 3); ok(keys.every(x => /^v1_[a-f0-9]{64}$/.test(x)));
  ok(!keys.includes(buildSearchLkgKey({ normalizedQuery: 'גבינה', normalizedTranslatedQuery: 'cheese' })), 'namespaced away from /api/prices');
  ok(k('גבינה') !== buildPickerLkgKey({ q: 'גבינה', translatedQ: 'cheese', pageSize: 20 }), 'pageSize is part of identity');
  eq(buildPickerLkgKey({ q: ' גבינה  ', translatedQ: 'Cheese', pageSize: 40 }), k('גבינה'), 'whitespace/case normalised');
});
await test('8b. an LKG for גבינה is never served for גבינה לבנה', async () => {
  const { repo } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('גבינה', CASES['גבינה'], ALL); await call('גבינה');
  mockOff('גבינה לבנה', CASES['גבינה לבנה'], DOWN);
  eq((await call('גבינה לבנה')).cacheStatus, 'none');
});
await test('9. TTL: 6h accepted, beyond 6h rejected', async () => {
  const { repo } = memRepo(); const key = buildPickerLkgKey({ q: 'גבינה', translatedQ: 'cheese', pageSize: 40 });
  const good = { status: 'ok', batches: [{ strategy: 'original_il', products: CASES['גבינה'].il, error: null }] };
  const T0 = 1_700_000_000_000; await repo.put(key, flattenBatches(good.batches), T0);
  const down = { status: 'REMOTE_FAILURE', batches: [{ strategy: 'original_il', products: [], error: 'off_http_5xx' }] };
  const within = await resolvePickerSearch({ result: down, repository: repo, ttlMs: TTL, key, now: T0 + TTL });
  eq(within.cacheStatus, 'stale-if-error'); eq(within.ageSeconds, TTL / 1000);
  const beyond = await resolvePickerSearch({ result: down, repository: repo, ttlMs: TTL, key, now: T0 + TTL + 1 });
  eq(beyond.cacheStatus, 'none'); eq(beyond.status, 'REMOTE_FAILURE');
});
await test('10. no fabricated image: Tnuva 7290000056951 stays image-less through LKG', async () => {
  const { repo } = memRepo(); _setPickerLkgForTests(repo, TTL);
  mockOff('שמנת לבישול', CASES['שמנת לבישול'], ALL); await call('שמנת לבישול');
  mockOff('שמנת לבישול', CASES['שמנת לבישול'], DOWN); const r = await call('שמנת לבישול');
  eq(r.cacheStatus, 'stale-if-error');
  const tnuva = r.batches.flatMap(b => b.products).find(p => p.code === '7290000056951');
  ok(tnuva && !('image_small_url' in tnuva), 'no image field invented');
  const raw = []; bpConsumeBatches(r.batches, new Set(), raw, 'he');
  eq(raw.find(p => p.barcode === '7290000056951').image, '');
  ok(raw.find(p => p.barcode === '7290000522340').image === 'http://i/c.jpg', 'real image preserved');
});

// ── 11 gate ──────────────────────────────────────────────────────────────────
console.log('\nPersistence gate');
await test('11a. SEARCH_LKG_PERSISTENCE_APPROVED is false and blocks SEARCH_LKG_ENABLED=true', () => {
  eq(SEARCH_LKG_PERSISTENCE_APPROVED, false);
  const c = getSearchLkgConfig({ SEARCH_LKG_ENABLED: 'true', SEARCH_LKG_TTL_MS: '1000' });
  eq(c.enabled, false); eq(c.blockedByApprovalGate, true);
  const rt = createSearchLkgRuntime({ env: { SEARCH_LKG_ENABLED: 'true' }, dbUrl: 'https://x.firebaseio.com', tokenProvider: async () => 't' });
  eq(rt.enabled, false); eq(rt.repository, null); eq(rt.reason, 'approval_gate');
});
await test('11b. handler with env enabled + dbUrl set makes ZERO Firebase calls (only OFF)', async () => {
  _setPickerLkgForTests(null);
  const env = { ...process.env };
  process.env.SEARCH_LKG_ENABLED = 'true'; process.env.FIREBASE_DATABASE_URL = 'https://test-only.firebaseio.com';
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ products: CASES['גבינה'].il }) }; };
  try {
    const r = await call('גבינה');
    eq(r.status, 'ok'); eq(r.cacheStatus, 'fresh'); ok(!('lkgSource' in r), 'no LKG involvement while gated');
    ok(urls.length === 3 && urls.every(u => u.startsWith('https://world.openfoodfacts.org/')), urls.join(','));
    ok(!urls.some(u => /firebase|searchLkg/i.test(u)));
  } finally { process.env.SEARCH_LKG_ENABLED = env.SEARCH_LKG_ENABLED; process.env.FIREBASE_DATABASE_URL = env.FIREBASE_DATABASE_URL;
    if (env.SEARCH_LKG_ENABLED === undefined) delete process.env.SEARCH_LKG_ENABLED; if (env.FIREBASE_DATABASE_URL === undefined) delete process.env.FIREBASE_DATABASE_URL; }
});
await test('11c. gated + OFF down → plain REMOTE_FAILURE, cacheStatus none (current behaviour preserved)', async () => {
  _setPickerLkgForTests(null); mockOff('גבינה', CASES['גבינה'], DOWN);
  const r = await call('גבינה'); eq(r.status, 'REMOTE_FAILURE'); eq(r.cacheStatus, 'none');
});

// ── 12 matrix for the three queries ──────────────────────────────────────────
console.log('\nMatrix: full / partial / total failure with LKG / total failure without LKG');
for (const q of Object.keys(CASES)) {
  await test(`12. ${q}`, async () => {
    const { repo } = memRepo(); _setPickerLkgForTests(repo, TTL); const c = CASES[q];
    mockOff(q, c, ALL); const full = await call(q);
    eq(full.cacheStatus, 'fresh'); ok(names(full).length >= c.il.length);
    mockOff(q, c, { il: '503', tr: 'ok', br: 'ok' }); const partial = await call(q);
    eq(partial.cacheStatus, 'stale-if-error', 'partial with LKG serves LKG'); eq(names(partial), names(full));
    mockOff(q, c, DOWN); const total = await call(q);
    eq(total.cacheStatus, 'stale-if-error'); eq(names(total), names(full));
    const fresh = memRepo(); _setPickerLkgForTests(fresh.repo, TTL);
    mockOff(q, c, DOWN); eq((await call(q)).cacheStatus, 'none');
    mockOff(q, c, { il: '503', tr: 'ok', br: 'ok' }); const p2 = await call(q);
    eq(p2.cacheStatus, 'fresh', 'partial without LKG returns the degraded corpus, uncached'); eq(fresh.log.writes, 0);
  });
}

// ── helpers & client ─────────────────────────────────────────────────────────
console.log('\nAdapter helpers and client');
await test('flatten → rebuild round trip preserves order and raw fields', () => {
  const batches = [{ strategy: 'original_il', products: CASES['גבינה'].il, error: null }, { strategy: 'translated_broad', products: CASES['גבינה'].br, error: null }];
  eq(rebuildBatches(flattenBatches(batches)), batches);
});
await test('isTrustworthyPickerResult requires a clean original_il', () => {
  eq(isTrustworthyPickerResult({ batches: [{ strategy: 'original_il', products: [], error: null }] }), true);
  eq(isTrustworthyPickerResult({ batches: [{ strategy: 'original_il', products: [], error: 'off_http_5xx' }, { strategy: 'translated_broad', products: [prod('1', 'x')], error: null }] }), false);
});
await test('a repository failure never breaks the endpoint', async () => {
  const broken = { get: async () => { throw new Error('boom'); }, put: async () => { throw new Error('boom'); }, putZero: async () => { throw new Error('boom'); } };
  _setPickerLkgForTests(broken, TTL); mockOff('גבינה', CASES['גבינה'], ALL);
  const r = await call('גבינה'); eq(r.status, 'ok'); ok(['fresh'].includes(r.cacheStatus));
});
await test('client: server-stale answer is shown but never cached as fresh', async () => {
  _testOnlyClearCache();
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ status: 'ok', cacheStatus: 'stale-if-error', cachedAt: 1, ageSeconds: 5, batches: [{ strategy: 'original_il', products: CASES['גבינה'].il, error: null }] }) }; };
  const r1 = await bpFetchCorpus('גבינה', 'cheese', 'he:גבינה', 40);
  eq(r1.cacheStatus, 'stale-if-error'); eq(_testOnlyGetCache().size, 0, 'not cached');
  await bpFetchCorpus('גבינה', 'cheese', 'he:גבינה', 40); eq(calls, 2, 'asks the server again');
});
await test('client: fresh answer is still cached (no regression)', async () => {
  _testOnlyClearCache();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', cacheStatus: 'fresh', batches: [{ strategy: 'original_il', products: CASES['גבינה'].il, error: null }] }) });
  await bpFetchCorpus('גבינה', 'cheese', 'he:גבינה', 40); eq(_testOnlyGetCache().size, 1);
});
await test('UI: stale notice text present and shown only for stale-if-error', async () => {
  const { readFileSync } = await import('fs');
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  ok(app.includes("_corpusResult.cacheStatus === 'stale-if-error'"));
  ok(app.includes('מוצגות תוצאות שמורות — ייתכן שאינן העדכניות ביותר'));
});

_setPickerLkgForTests(null);
console.log(`\npicker-lkg: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

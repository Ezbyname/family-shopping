// tests/lkg-isolation.test.mjs
// The Product Picker LKG (/api/openfoodfacts-search) and the /api/prices search LKG
// have independent activation gates. Nothing here enables either one in the repo.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import handler from '../api/openfoodfacts-search.js';
import {
  SEARCH_LKG_PERSISTENCE_APPROVED, PICKER_LKG_PERSISTENCE_APPROVED,
  getSearchLkgConfig, getPickerLkgConfig, SEARCH_LKG_DEFAULT_TTL_MS,
} from '../api/_search-lkg-config.js';
import { createSearchLkgRuntime } from '../api/_search-lkg-runtime.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(here, '..', f), 'utf8');

// Read-only copy of the config module with BOTH source gates opened. The repo file is untouched;
// this only lets the tests prove what each env flag would (not) activate once approved.
const cfgSrc = read('api/_search-lkg-config.js')
  .replace('SEARCH_LKG_PERSISTENCE_APPROVED = false', 'SEARCH_LKG_PERSISTENCE_APPROVED = true')
  .replace('PICKER_LKG_PERSISTENCE_APPROVED = false', 'PICKER_LKG_PERSISTENCE_APPROVED = true');
const tmp = path.join(os.tmpdir(), `lkg-open-${process.pid}.mjs`);
fs.writeFileSync(tmp, cfgSrc);
const open = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

console.log('\nSource gates');
await test('both source gates are false in the repo', () => {
  eq(SEARCH_LKG_PERSISTENCE_APPROVED, false); eq(PICKER_LKG_PERSISTENCE_APPROVED, false);
});
await test('sanity: the opened copy really has both gates true', () => {
  eq(open.SEARCH_LKG_PERSISTENCE_APPROVED, true); eq(open.PICKER_LKG_PERSISTENCE_APPROVED, true);
});

console.log('\nPicker gate OFF (real module)');
await test('PICKER_LKG_ENABLED=true is blocked by the picker approval gate', () => {
  const c = getPickerLkgConfig({ PICKER_LKG_ENABLED: 'true', PICKER_LKG_TTL_MS: '1000' });
  eq(c.enabled, false); eq(c.blockedByApprovalGate, true);
});
await test('picker runtime: no repository, reason approval_gate', () => {
  const rt = createSearchLkgRuntime({ env: { PICKER_LKG_ENABLED: 'true' }, dbUrl: 'https://x.firebaseio.com', tokenProvider: async () => 't', configProvider: getPickerLkgConfig });
  eq(rt.enabled, false); eq(rt.repository, null); eq(rt.reason, 'approval_gate');
});
await test('handler with PICKER+SEARCH env enabled and dbUrl set: ZERO Firebase calls', async () => {
  const saved = { ...process.env };
  process.env.PICKER_LKG_ENABLED = 'true'; process.env.SEARCH_LKG_ENABLED = 'true';
  process.env.FIREBASE_DATABASE_URL = 'https://test-only.firebaseio.com';
  const realFetch = global.fetch; const urls = [];
  global.fetch = async (u) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ products: [{ code: '1', product_name_he: 'גבינה', product_name: 'גבינה', countries_tags: ['en:israel'] }] }) }; };
  try {
    let body; const res = { setHeader() {}, status() { return { json(d) { body = d; }, end() {} }; } };
    await handler({ method: 'GET', query: { q: 'גבינה', translatedQ: 'cheese', pageSize: '40' } }, res);
    eq(body.status, 'ok'); eq(body.cacheStatus, 'fresh'); ok(!('lkgSource' in body));
    ok(urls.length > 0 && urls.every(u => u.startsWith('https://world.openfoodfacts.org/')), urls.join(','));
    ok(!urls.some(u => /firebase|searchLkg/i.test(u)));
  } finally {
    global.fetch = realFetch;
    for (const k of ['PICKER_LKG_ENABLED', 'SEARCH_LKG_ENABLED', 'FIREBASE_DATABASE_URL']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

console.log('\nIndependence (both gates opened in a copy)');
await test('picker gate ON does NOT activate /api/prices LKG', () => {
  const env = { PICKER_LKG_ENABLED: 'true' };
  eq(open.getPickerLkgConfig(env).enabled, true);
  eq(open.getSearchLkgConfig(env).enabled, false);
  eq(createSearchLkgRuntime({ env, dbUrl: 'https://x.firebaseio.com', tokenProvider: async () => 't', configProvider: open.getSearchLkgConfig }).repository, null);
});
await test('existing SEARCH_LKG_* gate does NOT activate picker LKG', () => {
  const env = { SEARCH_LKG_ENABLED: 'true', SEARCH_LKG_TTL_MS: '1000' };
  eq(open.getSearchLkgConfig(env).enabled, true);
  eq(open.getPickerLkgConfig(env).enabled, false);
  eq(createSearchLkgRuntime({ env, dbUrl: 'https://x.firebaseio.com', tokenProvider: async () => 't', configProvider: open.getPickerLkgConfig }).repository, null);
});
await test('picker TTL: default equals the search default; own TTL env; bad TTL rejected', () => {
  eq(open.getPickerLkgConfig({ PICKER_LKG_ENABLED: '1' }).ttlMs, SEARCH_LKG_DEFAULT_TTL_MS);
  eq(open.getPickerLkgConfig({ PICKER_LKG_ENABLED: '1', PICKER_LKG_TTL_MS: '5000' }).ttlMs, 5000);
  eq(open.getPickerLkgConfig({ PICKER_LKG_ENABLED: '1', PICKER_LKG_TTL_MS: '-1' }).error, 'invalid_picker_lkg_ttl');
  eq(open.getPickerLkgConfig({ PICKER_LKG_ENABLED: '1', SEARCH_LKG_TTL_MS: '5000' }).ttlMs, SEARCH_LKG_DEFAULT_TTL_MS, 'search TTL env must not leak into picker');
});
await test('existing getSearchLkgConfig semantics unchanged (SEARCH_* only, blocked by its own gate)', () => {
  eq(getSearchLkgConfig({ SEARCH_LKG_ENABLED: 'true' }).blockedByApprovalGate, true);
  eq(getSearchLkgConfig({ PICKER_LKG_ENABLED: 'true' }).enabled, false);
  eq(open.getSearchLkgConfig({ SEARCH_LKG_ENABLED: 'true' }).ttlMs, SEARCH_LKG_DEFAULT_TTL_MS);
});

console.log('\nWiring');
await test('openfoodfacts-search.js uses only the picker config provider', () => {
  const s = read('api/openfoodfacts-search.js');
  ok(/configProvider:\s*getPickerLkgConfig/.test(s));
  ok(!/getSearchLkgConfig/.test(s));
});
await test('prices.js has no picker gate and keeps the default (SEARCH_LKG_*) provider', () => {
  const s = read('api/prices.js');
  ok(!/PICKER_LKG|getPickerLkgConfig/.test(s));
  const call = s.slice(s.indexOf('createSearchLkgRuntime({'), s.indexOf('createSearchLkgRuntime({') + 120);
  ok(!/configProvider/.test(call), call);
});

console.log(`\nlkg-isolation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

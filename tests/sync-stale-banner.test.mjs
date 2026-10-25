// tests/sync-stale-banner.test.mjs
// FS-SYNC-STALE-001 — the global red "prices may not be up to date" banner must show
// ONLY when the newest successful price-chain sync (syncStatus/*.lastSuccessAt) is
// more than 24 h old. syncSummary.lastSync (written after every run, failed runs
// included) and the failed-chain count must not drive it.
//
// Runs the REAL checkSyncHealth / showSyncStaleBanner / helpers extracted from app.js
// (same pattern as pd-clear-location). APP_SRC=<path> runs the suite against another
// copy of app.js — used as a negative control against the pre-fix baseline.
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const app = readFileSync(process.env.APP_SRC || new URL('../app.js', import.meta.url), 'utf8');
function sliceBody(start, label) {
  let i = app.indexOf('{', app.indexOf(')', start)), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${label}`);
}
function extractFn(name, { optional = false } = {}) {
  const start = app.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) { if (optional) return ''; throw new Error(`function ${name} not found in app.js`); }
  return sliceBody(start, name);
}
const staleConst = app.match(/const _STALE_HOURS\s*=\s*\d+;/)?.[0];
if (!staleConst) throw new Error('_STALE_HOURS not found in app.js');

const SRC = [
  staleConst,
  extractFn('esc'),
  extractFn('_newestPriceSyncSuccessMs', { optional: true }),
  extractFn('_isSyncStale', { optional: true }),
  extractFn('showSyncStaleBanner'),
  extractFn('checkSyncHealth'),
].join('\n');

const NOW  = Date.parse('2026-10-25T12:00:00Z');
const HOUR = 3_600_000;
const iso  = ms => new Date(ms).toISOString();
const BANNER = 'המחירים עשויים להיות לא מעודכנים';

// Fake DOM — just enough for showSyncStaleBanner and the ✕ dismiss handler.
function makeDom() {
  const nodes = [];
  const document = {
    getElementById: id => nodes.find(n => n.id === id) || null,
    createElement: () => {
      const n = { id: '', style: {}, innerHTML: '' };
      n.remove = () => { const i = nodes.indexOf(n); if (i >= 0) nodes.splice(i, 1); };
      return n;
    },
    body: { prepend: n => nodes.unshift(n) },
  };
  return { document, nodes };
}

// data: { syncStatus, syncSummary } — what Firebase holds at each path.
// readFails: the syncStatus read rejects.
function makeApp({ syncStatus, syncSummary, readFails = false } = {}) {
  const { document, nodes } = makeDom();
  const events = [];
  const reads  = [];
  const dbData = { syncStatus, syncSummary };
  const env = {
    db: {},
    document,
    ref: (_db, path) => path,
    get: path => {
      reads.push(path);
      if (readFails && path === 'syncStatus') return Promise.reject(new Error('PERMISSION_DENIED'));
      const v = dbData[path];
      return Promise.resolve({ exists: () => v != null, val: () => v });
    },
    withClientTimeout: p => p,
    trackEvent: (name, props) => events.push({ name, props }),
  };
  const RealDate = Date;
  const FakeDate = class extends RealDate { static now() { return NOW; } };
  const factory = new Function(...Object.keys(env), 'Date', `${SRC}
    return { checkSyncHealth, showSyncStaleBanner,
      _newestPriceSyncSuccessMs: typeof _newestPriceSyncSuccessMs === 'function' ? _newestPriceSyncSuccessMs : null,
      _isSyncStale: typeof _isSyncStale === 'function' ? _isSyncStale : null };`);
  const fns = factory(...Object.values(env), FakeDate);
  const banner = () => document.getElementById('sync-stale-banner');
  return { ...fns, nodes, events, reads, banner };
}

// A fresh summary that the OLD code would accept as "not stale" — so any test that
// still shows/hides correctly here proves syncStatus, not syncSummary, is the source.
const freshSummary = (extra = {}) => ({ lastSync: NOW - 1 * HOUR, chainsSucceeded: 3, chainsFailed: 0, ...extra });
const status = (...ages) => Object.fromEntries(ages.map((a, i) => [`chain${i}`, { lastSuccessAt: iso(NOW - a) }]));

async function run(opts) { const a = makeApp(opts); await a.checkSyncHealth(); return a; }

console.log('\nFS-SYNC-STALE-001 — global stale banner');

await test('newest success 1h ago → hidden', async () => {
  const a = await run({ syncStatus: status(1 * HOUR, 50 * HOUR), syncSummary: freshSummary() });
  eq(a.banner(), null, 'banner');
});

await test('23h59m → hidden', async () => {
  const a = await run({ syncStatus: status(24 * HOUR - 60_000), syncSummary: freshSummary() });
  eq(a.banner(), null, 'banner');
});

await test('exactly 24h → hidden', async () => {
  const a = await run({ syncStatus: status(24 * HOUR), syncSummary: freshSummary() });
  eq(a.banner(), null, 'banner');
});

await test('24h + 1ms → shown', async () => {
  // ISO strings carry ms precision, so 24h+1ms survives the round trip
  const a = await run({ syncStatus: status(24 * HOUR + 1), syncSummary: freshSummary() });
  ok(a.banner(), 'banner should be shown');
  ok(a.banner().innerHTML.includes(BANNER), 'banner text');
  ok(a.banner().innerHTML.includes('24 שעות'), `age label: ${a.banner().innerHTML}`);
});

await test('24h + 1min → shown, tracked once', async () => {
  const a = await run({ syncStatus: status(24 * HOUR + 60_000), syncSummary: freshSummary() });
  ok(a.banner(), 'banner should be shown');
  eq(a.events.filter(e => e.name === 'sync_stale_banner_shown').length, 1, 'trackEvent count');
});

await test('stale success even though syncSummary.lastSync is 1h old → shown', async () => {
  // A failed run 1h ago rewrote lastSync; the last SUCCESS is 30h old.
  const a = await run({ syncStatus: status(30 * HOUR), syncSummary: freshSummary({ chainsSucceeded: 0, chainsFailed: 0 }) });
  ok(a.banner(), 'banner should be shown');
});

await test('newest of several chains wins (one fresh, others stale) → hidden', async () => {
  const a = await run({ syncStatus: status(40 * HOUR, 2 * HOUR, 90 * HOUR), syncSummary: freshSummary() });
  eq(a.banner(), null, 'banner');
});

await test('failed chains (majority failed) with fresh success → hidden', async () => {
  const a = await run({ syncStatus: status(3 * HOUR), syncSummary: freshSummary({ chainsSucceeded: 1, chainsFailed: 5 }) });
  eq(a.banner(), null, 'failed chains must not force the banner');
});

await test('*-stores entry ignored (fresh stores sync does not hide stale prices)', async () => {
  const a = await run({
    syncStatus: { shufersal: { lastSuccessAt: iso(NOW - 30 * HOUR) }, 'rami-levy-stores': { lastSuccessAt: iso(NOW - 1 * HOUR) } },
    syncSummary: freshSummary(),
  });
  ok(a.banner(), 'banner should be shown — only shufersal counts');
});

await test('malformed / missing timestamps ignored', async () => {
  const a = await run({
    syncStatus: {
      bad1: { lastSuccessAt: 'not-a-date' },
      bad2: { lastSuccessAt: '' },
      bad3: { lastSuccessAt: null },
      bad4: { lastSyncDate: '2026-10-25' },
      bad5: 'garbage',
      bad6: { lastSuccessAt: { nested: true } },
      good: { lastSuccessAt: iso(NOW - 26 * HOUR) },
    },
    syncSummary: freshSummary(),
  });
  ok(a.banner(), 'stale banner from the only valid entry');
  ok(a.banner().innerHTML.includes('26 שעות'), `age label: ${a.banner().innerHTML}`);
});

await test('no valid success timestamp → silent', async () => {
  const a = await run({
    syncStatus: { x: { lastSuccessAt: 'nope' }, 'rami-levy-stores': { lastSuccessAt: iso(NOW - 99 * HOUR) } },
    syncSummary: { lastSync: NOW - 99 * HOUR, chainsSucceeded: 0, chainsFailed: 6 },
  });
  eq(a.banner(), null, 'no false warning');
  eq(a.events.length, 0, 'no event');
});

await test('syncStatus missing → silent', async () => {
  const a = await run({ syncStatus: undefined, syncSummary: { lastSync: NOW - 99 * HOUR } });
  eq(a.banner(), null, 'no false warning');
});

await test('syncStatus read failure → silent, no throw', async () => {
  const a = await run({ readFails: true, syncSummary: { lastSync: NOW - 99 * HOUR, chainsFailed: 6, chainsSucceeded: 0 } });
  eq(a.banner(), null, 'no false warning');
});

await test('reads syncStatus, never syncSummary', async () => {
  const a = await run({ syncStatus: status(1 * HOUR), syncSummary: freshSummary() });
  ok(a.reads.includes('syncStatus'), `reads: ${a.reads}`);
  ok(!a.reads.includes('syncSummary'), `reads: ${a.reads}`);
});

await test('dismiss preserved: ✕ removes banner; shown at most once while present', async () => {
  const a = await run({ syncStatus: status(30 * HOUR), syncSummary: freshSummary() });
  ok(a.banner(), 'banner shown');
  ok(a.banner().innerHTML.includes('onclick="this.parentElement.remove()"'), 'dismiss button');
  a.showSyncStaleBanner('30 שעות');
  eq(a.nodes.filter(n => n.id === 'sync-stale-banner').length, 1, 'no duplicate banner');
  a.banner().remove();               // what the ✕ handler does
  eq(a.banner(), null, 'dismissed');
});

await test('helpers: boundary + parsing (unit)', async () => {
  const a = makeApp({});
  ok(a._isSyncStale && a._newestPriceSyncSuccessMs, 'helpers exist');
  eq(a._isSyncStale(NOW - 24 * HOUR, NOW), false, 'exactly 24h');
  eq(a._isSyncStale(NOW - 24 * HOUR - 1, NOW), true, '24h+1ms');
  eq(a._isSyncStale(null, NOW), false, 'null');
  eq(a._newestPriceSyncSuccessMs(null), null, 'null input');
  eq(a._newestPriceSyncSuccessMs({ a: { lastSuccessAt: NOW - 5 } }), NOW - 5, 'numeric ms accepted');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

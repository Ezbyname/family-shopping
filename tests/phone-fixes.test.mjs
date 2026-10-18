// tests/phone-fixes.test.mjs
// Focused regression tests for the real-phone bug-fix cycle on 3.2.1:
//   A. Hebrew corpus completeness (OFF partial failure must not become the answer)
//   B. Shufersal parent chain visible in store titles
//   C. Navigation destination (address + city) and Google Maps / Waze URLs
//   D. "דווח" no longer rendered in price rows
import { readFileSync } from 'fs';
import { bpIsIncompleteHebrewCorpus, bpConsumeBatches } from '../js/bp-search.js';
import { bpSelectStrictCandidates } from '../js/bp-strict.js';
import { isShufersal, storeRowTitle, navDestination, googleMapsUrl, wazeUrl, hasUsableCoords } from '../js/store-ui.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// ── A. search completeness ───────────────────────────────────────────────────
console.log('\nA. Hebrew corpus completeness');
const b = (strategy, products, error = null) => ({ strategy, products, error });
const P = (code, he, en, brands = '') => ({ code, product_name_he: he, product_name: en || he, brands, countries_tags: ['en:israel'] });

test('only translated_broad survived (both Israel batches failed) → incomplete', () => {
  eq(bpIsIncompleteHebrewCorpus([b('original_il', [], 'off_http_5xx'), b('translated_il', [], 'off_http_5xx'), b('translated_broad', [P('1', '', 'ORIGINAL WHITE CHEESE')])], 'he'), true);
});
test('translated_il survived → complete enough to show', () => {
  eq(bpIsIncompleteHebrewCorpus([b('original_il', [], 'off_http_5xx'), b('translated_il', [P('1', 'גבינה לבנה')]), b('translated_broad', [], 'off_http_5xx')], 'he'), false);
});
test('original_il survived → not incomplete', () => {
  eq(bpIsIncompleteHebrewCorpus([b('original_il', [P('1', 'שמנת לבישול')]), b('translated_il', [], 'off_http_5xx'), b('translated_broad', [], 'off_http_5xx')], 'he'), false);
});
test('Israel batch succeeded with ZERO products is not a transport failure', () => {
  eq(bpIsIncompleteHebrewCorpus([b('original_il', []), b('translated_il', []), b('translated_broad', [], 'off_http_5xx')], 'he'), false);
});
test('non-Hebrew queries are never flagged', () => {
  eq(bpIsIncompleteHebrewCorpus([b('original_il', [], 'off_http_5xx'), b('translated_broad', [P('1', '', 'Milk')])], 'latin'), false);
});
test('garbage input is safe', () => {
  eq(bpIsIncompleteHebrewCorpus(undefined, 'he'), false);
  eq(bpIsIncompleteHebrewCorpus([], 'he'), false);
});
test('reproduces the phone symptom: English-only survivors pass strict mode as 2 English results', () => {
  const batches = [b('original_il', [], 'off_http_5xx'), b('translated_il', [], 'off_http_5xx'),
    b('translated_broad', [P('10', '', 'Bulgarian White Cheese'), P('11', '', 'ORIGINAL WHITE CHEESE'), P('12', '', 'Brie Orange Cheese Slices Pack Big')])];
  const raw = []; bpConsumeBatches(batches, new Set(), raw, 'he');
  const st = bpSelectStrictCandidates(raw, { queryLang: 'he', normQ: 'גבינה לבנה', enQuery: 'white cheese' });
  eq(st.mode, 'translated'); eq(st.candidates.length, 2, 'the two English results seen on the phone');
  eq(bpIsIncompleteHebrewCorpus(batches, 'he'), true, 'guard must flag this as incomplete');
});
test('full corpus keeps Hebrew-first strict results (שמנת לבישול)', () => {
  const batches = [b('original_il', [P('1', 'שמנת לבישול', '', 'תנובה'), P('2', 'שמנת לבישול 15%'), P('3', 'שמנת לבישול 10%'), P('4', 'שמנת לבישול 10')]),
    b('translated_il', []), b('translated_broad', [])];
  const raw = []; bpConsumeBatches(batches, new Set(), raw, 'he');
  const st = bpSelectStrictCandidates(raw, { queryLang: 'he', normQ: 'שמנת לבישול', enQuery: 'cooking cream' });
  eq(st.mode, 'hebrew'); eq(st.candidates.length, 4);
  eq(bpIsIncompleteHebrewCorpus(batches, 'he'), false);
});
test('image is not fabricated: product without image_small_url stays without image', () => {
  const raw = []; bpConsumeBatches([b('original_il', [P('7290000056951', 'שמנת לבישול', '', 'תנובה')])], new Set(), raw, 'he');
  eq(raw[0].image, '');
});

// ── B. Shufersal naming ──────────────────────────────────────────────────────
console.log('\nB. Shufersal store titles');
const S = (o) => ({ chainId: 'shufersal', chainName: 'שופרסל', ...o });
test('standard branch gets parent chain', () => eq(storeRowTitle(S({ storeName: 'שלי רזין אילת' })), 'שופרסל · שלי רזין אילת'));
test('Deal branch keeps sub-format and gets parent', () => eq(storeRowTitle(S({ storeName: 'דיל אילת הסתת' })), 'שופרסל · דיל אילת הסתת'));
test('bare city-only name gets parent', () => eq(storeRowTitle(S({ storeName: 'אילת' })), 'שופרסל · אילת'));
test('Deal in Eilat (typo preserved, not rewritten)', () => eq(storeRowTitle(S({ storeName: 'דילאילת נחל אורה' })), 'שופרסל · דילאילת נחל אורה'));
test('name already containing שופרסל is not doubled', () => eq(storeRowTitle(S({ storeName: 'שופרסל דיל אילת' })), 'שופרסל דיל אילת'));
test('no storeName → chain name only', () => eq(storeRowTitle(S({ storeName: '' })), 'שופרסל'));
test('identified by GS1 chain id', () => eq(storeRowTitle({ chainId: '7290027600007', chainName: '', storeName: 'אילת' }), 'שופרסל · אילת'));
test('identified by key prefix', () => ok(isShufersal({ _key: 'shufersal_123' })));
test('multiple Shufersal stores in one modal all carry שופרסל', () => {
  const names = ['BE אייס מול אילת', 'אקספרס אילת שחמון', 'דיל אילת הסתת', 'דילאילת נחל אורה', 'שלי רזין אילת'];
  for (const n of names) ok(storeRowTitle(S({ storeName: n })).includes('שופרסל'), n);
});
test('non-Shufersal chain unchanged (רמי לוי / אילת)', () => {
  eq(storeRowTitle({ chainId: 'rami-levy', chainName: 'רמי לוי', storeName: 'אילת' }), 'אילת');
  eq(isShufersal({ chainId: 'rami-levy', chainName: 'רמי לוי' }), false);
});
test('non-Shufersal chain without storeName falls back to chain name', () =>
  eq(storeRowTitle({ chainId: 'victory', chainName: 'ויקטורי', storeName: '' }), 'ויקטורי'));

// ── C. navigation ────────────────────────────────────────────────────────────
console.log('\nC. Navigation');
const qOf = (u, key) => decodeURIComponent(new URL(u).searchParams.get(key));
test('REGRESSION הזגג 11, אילת → Google query contains the city', () => {
  const d = navDestination({ address: 'הזגג 11', city: 'אילת', name: 'אילת' });
  const g = googleMapsUrl(d);
  eq(qOf(g, 'query'), 'הזגג 11, אילת, ישראל');
  ok(!/%D7%94%D7%96%D7%92%D7%92%2011(&|$)/.test(g), 'must not be street+number only');
});
test('REGRESSION הזגג 11, אילת → Waze query contains the city', () => {
  const w = wazeUrl(navDestination({ address: 'הזגג 11', city: 'אילת' }));
  eq(qOf(w, 'q'), 'הזגג 11, אילת, ישראל'); ok(w.includes('navigate=yes'));
});
test('both providers receive the same destination text', () => {
  const d = navDestination({ address: 'הסתת 15 א תעשיה', city: 'אילת' });
  eq(qOf(googleMapsUrl(d), 'query'), qOf(wazeUrl(d), 'q'));
});
test('ambiguous street in two cities resolves to different destinations', () => {
  const a = navDestination({ address: 'הרצל 10', city: 'חיפה' }), c = navDestination({ address: 'הרצל 10', city: 'תל אביב' });
  ok(qOf(googleMapsUrl(a), 'query') !== qOf(googleMapsUrl(c), 'query'));
  ok(qOf(googleMapsUrl(a), 'query').includes('חיפה')); ok(qOf(wazeUrl(c), 'q').includes('תל אביב'));
});
test('second ambiguous pair: ירושלים 5 in באר שבע vs אשדוד', () => {
  const a = navDestination({ address: 'ירושלים 5', city: 'באר שבע' }), c = navDestination({ address: 'ירושלים 5', city: 'אשדוד' });
  ok(qOf(wazeUrl(a), 'q').includes('באר שבע')); ok(qOf(wazeUrl(c), 'q').includes('אשדוד'));
});
test('city already inside address is not duplicated', () =>
  eq(navDestination({ address: 'הזגג 11, אילת', city: 'אילת' }).query, 'הזגג 11, אילת, ישראל'));
test('trusted coordinates win and feed both providers identically', () => {
  const d = navDestination({ lat: 29.5577, lng: 34.9519, address: 'הזגג 11', city: 'אילת' });
  eq(d.kind, 'coords'); ok(googleMapsUrl(d).includes('destination=29.5577,34.9519')); ok(wazeUrl(d).includes('ll=29.5577,34.9519'));
});
test('unusable coords (0/0, null, strings, outside Israel) fall back to address+city', () => {
  for (const [la, ln] of [[0, 0], [null, null], ['x', 'y'], [48.85, 2.35], [34.9, 29.5]]) {
    eq(hasUsableCoords(la, ln), false, `${la},${ln}`);
    eq(navDestination({ lat: la, lng: ln, address: 'הזגג 11', city: 'אילת' }).kind, 'address');
  }
});
test('no address → name + city; nothing at all → null', () => {
  eq(navDestination({ name: 'רמי לוי', city: 'אילת' }).query, 'רמי לוי, אילת, ישראל');
  eq(navDestination({}), null); eq(googleMapsUrl(null), null); eq(wazeUrl(null), null);
});
test('URLs are fully encoded (no raw spaces / Hebrew / commas in query value)', () => {
  const g = googleMapsUrl(navDestination({ address: 'שדרות התמרים 37', city: 'אילת' }));
  ok(!/[֐-׿ ]/.test(g), 'raw Hebrew or space found in URL');
});

// ── D. report button + wiring (source-level) ─────────────────────────────────
console.log('\nD. Report button / wiring');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
test('no rendered "🚨 דווח" button remains in price rows', () => ok(!/🚨\s*דווח/.test(app)));
test('openReportModal handler is intact (reversible change)', () => ok(/window\.openReportModal\s*=/.test(app) || /function openReportModal/.test(app)));
test('"תקן" buttons remain', () => { ok(app.includes('✏️ תקן</button>')); ok(app.includes('✏️ תקן אישי</button>')); });
test('every navigateToStoreDirect call site passes the city', () => {
  const calls = app.split('\n').filter(l => /navigateToStoreDirect\(/.test(l) && !/window\.navigateToStoreDirect\s*=/.test(l));
  ok(calls.length >= 4, `found ${calls.length} call sites`);
  for (const l of calls) ok(/city/.test(l), `call site without city: ${l.trim().slice(0, 100)}`);
});
test('price rows use storeRowTitle', () => { ok(app.includes('storeRowTitle(p)')); ok(app.includes("from './js/store-ui.js'")); });
test('SW shell lists the new module', () => ok(readFileSync(new URL('../sw.js', import.meta.url), 'utf8').includes("'/js/store-ui.js'")));

console.log(`\nphone-fixes: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

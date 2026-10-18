// tests/picker-semantics.test.mjs
// Query specificity (broad vs specific), "ראה עוד", pagination, store identity, nav icons.
// Fixtures are synthetic OFF-shaped products used only by these tests.
import { readFileSync } from 'fs';
import { bpConsumeBatches } from '../js/bp-search.js';
import { bpSelectStrictCandidates } from '../js/bp-strict.js';
import { bpSelectBroadCandidates, bpIsBroadCategoryQuery, bpHebrewForms } from '../js/bp-intent.js';
import { bpDedupeProducts, bpPickerView, bpPage, PICKER_INITIAL, MORE_PAGE_SIZE } from '../js/bp-results.js';
import { bpTranslate } from '../js/bp-translation.js';
import { storeRowTitle, storeAddressLine, navDestination, googleMapsUrl, wazeUrl, NAV_ICON_GOOGLE, NAV_ICON_WAZE } from '../js/store-ui.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// ── fixtures (raw OFF shape) ─────────────────────────────────────────────────
let seq = 7290000000000;
const off = (he, cats = [], extra = {}) => ({
  code: String(seq++), product_name_he: he, product_name: he, brands: extra.brands || '',
  quantity: '', countries_tags: ['en:israel'], categories_tags: cats, ...extra,
});
const CHEESE = ['en:dairies', 'en:cheeses'];
const WHITE = [...CHEESE, 'en:white-cheeses'];
const COTTAGE = "קוטג' 5% תנובה";
const whiteVariants = [
  'גבינה לבנה 5% תנובה', 'גבינה לבנה 9% תנובה', 'גבינה לבנה 3% טרה', 'גבינה לבנה גד',
  'גבינה לבנה 5% 250 גרם', 'גבינה לבנה 500 גרם', 'גבינה לבנה דלת שומן', 'גבינה לבנה חלב עיזים',
];
const yellow = ['גבינה צהובה עמק 28%', 'גבינה צהובה גאודה', 'גבינה צהובה אדם פרוסות'];
const others = [
  ['גבינה בולגרית 24%', CHEESE], ['גבינת שמנת פילדלפיה', CHEESE], [COTTAGE, [...CHEESE, 'en:cottage-cheeses']],
  ['מוצרלה במי מלח', [...CHEESE, 'en:mozzarella']], ['פטה יווני', [...CHEESE, 'en:feta']], ['גבינה צפתית', CHEESE],
  ['גבינות קשות מיוחדות', CHEESE], ['גבינה מלוחה', CHEESE], ['גבינה עיזים רכה', CHEESE],
  ['גבינה מגורדת לפיצה', CHEESE], ['גבינת קממבר', CHEESE],
];
const unrelated = [
  ['שמנת לבישול 15%', ['en:dairies', 'en:creams']], ['שוקולד חלב', ['en:snacks', 'en:milk-chocolates']],
  ['חלבה בטעם וניל', ['en:halvas']], ['לחם פרוס', ['en:breads']], ['יוגורט תות', ['en:dairies', 'en:yogurts']],
];
const corpus = [
  ...whiteVariants.map(n => off(n, WHITE)), ...yellow.map(n => off(n, CHEESE)),
  ...others.map(([n, c]) => off(n, c)), ...unrelated.map(([n, c]) => off(n, c)),
  // loose English noise from a non-Israeli product
  { code: '3000000000001', product_name: 'Cheese Puffs Snack', brands: 'X', countries_tags: ['en:france'], categories_tags: ['en:snacks'] },
];
const batches = [{ strategy: 'original_il', products: corpus, error: null }];
const raw = []; bpConsumeBatches(batches, new Set(), raw, 'he');

// Mirrors the app.js selection order: strict (multi-word) -> broad (one word).
function select(q) {
  const normQ = q, enQuery = bpTranslate(q);
  const strict = bpSelectStrictCandidates(raw, { queryLang: 'he', normQ, enQuery });
  if (strict.used) return { mode: strict.mode, names: strict.candidates.map(p => p.name), products: strict.candidates };
  const broad = bpSelectBroadCandidates(raw, { queryLang: 'he', normQ, enQuery });
  return { mode: broad.used ? 'broad' : 'none', names: broad.candidates.map(p => p.name), products: broad.candidates };
}

// ── A. broad query ───────────────────────────────────────────────────────────
console.log('\nA. "גבינה" — broad category');
const broad = select('גבינה');
test('is classified as broad', () => { eq(bpIsBroadCategoryQuery('גבינה', 'he'), true); eq(broad.mode, 'broad'); });
test('includes white cheese', () => ok(broad.names.some(n => n.startsWith('גבינה לבנה'))));
test('includes yellow cheese', () => ok(broad.names.some(n => n.startsWith('גבינה צהובה'))));
test('includes Bulgarian / cream / tzfatit / construct forms', () => {
  for (const n of ['גבינה בולגרית 24%', 'גבינת שמנת פילדלפיה', 'גבינה צפתית', 'גבינות קשות מיוחדות', 'גבינת קממבר'])
    ok(broad.names.includes(n), n);
});
test('includes cottage / mozzarella / feta via the OFF category taxonomy (name lacks the word גבינה)', () => {
  for (const n of [COTTAGE, 'מוצרלה במי מלח', 'פטה יווני']) ok(broad.names.includes(n), n);
});
test('excludes unrelated foods (cooking cream, chocolate, halva, bread, yogurt)', () => {
  for (const [n] of unrelated) ok(!broad.names.includes(n), n);
});
test('excludes loose non-Israeli English results', () => ok(!broad.names.includes('Cheese Puffs Snack')));
test('total is the FULL match set (not capped at 10)', () => eq(broad.products.length, whiteVariants.length + yellow.length + others.length));
test('more than 10 results → picker shows 10 and exposes "ראה עוד (N-10)"', () => {
  const v = bpPickerView(broad.products);
  eq(v.shown.length, PICKER_INITIAL); eq(v.remaining, broad.products.length - PICKER_INITIAL); ok(v.remaining > 0);
});
test('Hebrew forms never leak into look-alike words (חלב ≠ חלבה/חלבון)', () => {
  const f = bpHebrewForms('חלב');
  ok(f.has('חלב')); ok(!f.has('חלבה')); ok(!f.has('חלבון'));
  const g = bpHebrewForms('גבינה'); ok(g.has('גבינת') && g.has('גבינות') && g.has('גבינה'));
});

// ── B. specific queries ──────────────────────────────────────────────────────
console.log('\nB. "גבינה לבנה" — specific intent');
const white = select('גבינה לבנה');
test('is NOT broad; uses strict Hebrew matching', () => { eq(bpIsBroadCategoryQuery('גבינה לבנה', 'he'), false); eq(white.mode, 'hebrew'); });
test('returns every white-cheese variant (manufacturers / fat % / sizes)', () => eq([...white.names].sort(), [...whiteVariants].sort()));
test('excludes yellow cheese', () => ok(!white.names.some(n => n.includes('צהובה'))));
test('excludes Bulgarian, mozzarella, cream cheese, cottage, other cheese types', () => {
  for (const n of ['גבינה בולגרית 24%', 'מוצרלה במי מלח', 'גבינת שמנת פילדלפיה', COTTAGE, 'פטה יווני', 'גבינה צפתית']) ok(!white.names.includes(n), n);
});
const yel = select('גבינה צהובה');
test('"גבינה צהובה" → only yellow cheese', () => eq([...yel.names].sort(), [...yellow].sort()));
test('specificity scales: broad ⊃ specific', () => ok(white.products.length < broad.products.length && yel.products.length < broad.products.length));
const cot = select('קוטג');
test('"קוטג" (single word) → cottage only, no other cheese', () => eq(cot.names, [COTTAGE]));
const moz = select('מוצרלה');
test('"מוצרלה" → mozzarella only', () => eq(moz.names, ['מוצרלה במי מלח']));
test('"שמנת לבישול" keeps working (specific)', () => {
  const r = select('שמנת לבישול'); ok(r.names.includes('שמנת לבישול 15%')); ok(!r.names.some(n => n.includes('גבינה')));
});
test('broad query with no family match leaves the caller on its existing path', () => {
  const r = bpSelectBroadCandidates(raw, { queryLang: 'he', normQ: 'ספגטי', enQuery: 'spaghetti' });
  eq(r.used, true); eq(r.candidates.length, 0);
});
test('non-Hebrew queries are not broad-matched', () => eq(bpSelectBroadCandidates(raw, { queryLang: 'latin', normQ: 'cheese', enQuery: 'cheese' }).used, false));

// ── C. dedup + pagination ────────────────────────────────────────────────────
console.log('\nC. Dedup and pagination');
const list = Array.from({ length: 47 }, (_, i) => ({ barcode: String(1000 + i), name: `מוצר ${i}`, brand: '', size: '' }));
test('dedup by barcode keeps first (best-ranked); codeless dedup by name|brand|size', () => {
  const d = bpDedupeProducts([...list.slice(0, 3), { ...list[0] }, { barcode: '', name: 'א', brand: 'ב', size: '1' }, { barcode: '', name: 'א', brand: 'ב', size: '1' }]);
  eq(d.length, 4); eq(d[0].barcode, '1000');
});
test('47 results → picker 10, remaining 37 ("ראה עוד (37)")', () => { const v = bpPickerView(list); eq(v.shown.length, 10); eq(v.remaining, 37); eq(v.total, 47); });
test('≤10 results → no "ראה עוד"', () => eq(bpPickerView(list.slice(0, 10)).remaining, 0));
test('page size is 12 → 47 results = 4 pages', () => { eq(MORE_PAGE_SIZE, 12); eq(bpPage(list, 1).pages, 4); });
test('page 1', () => { const p = bpPage(list, 1); eq(p.items.length, 12); eq(p.start, 0); eq(p.hasPrev, false); eq(p.hasNext, true); });
test('page 2', () => { const p = bpPage(list, 2); eq(p.items[0].barcode, '1012'); eq(p.start, 12); eq(p.hasPrev, true); });
test('last page holds the remainder', () => { const p = bpPage(list, 4); eq(p.items.length, 11); eq(p.hasNext, false); eq(p.page, 4); });
test('out-of-range page clamps', () => { eq(bpPage(list, 99).page, 4); eq(bpPage(list, 0).page, 1); eq(bpPage(list, -3).page, 1); });
test('no duplicates across pages and full coverage', () => {
  const seen = []; for (let i = 1; i <= bpPage(list, 1).pages; i++) seen.push(...bpPage(list, i).items.map(p => p.barcode));
  eq(seen.length, 47); eq(new Set(seen).size, 47);
});
test('page items map back to the right global index (selection works)', () => {
  const p = bpPage(list, 3); p.items.forEach((it, k) => eq(list[p.start + k].barcode, it.barcode));
});
test('empty list → one empty page', () => { const p = bpPage([], 1); eq(p.pages, 1); eq(p.items.length, 0); });

// ── D. navigation UI ─────────────────────────────────────────────────────────
console.log('\nD. Navigation');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('Google Maps and Waze icons are inline brand SVGs', () => {
  ok(NAV_ICON_GOOGLE.startsWith('<svg') && NAV_ICON_GOOGLE.includes('<path'));
  ok(NAV_ICON_WAZE.startsWith('<svg') && NAV_ICON_WAZE.includes('<path'));
  ok(NAV_ICON_GOOGLE !== NAV_ICON_WAZE);
});
test('chooser buttons render the icons (no emoji identity)', () => {
  ok(app.includes('${NAV_ICON_GOOGLE}<span>Google Maps</span>')); ok(app.includes('${NAV_ICON_WAZE}<span>Waze</span>'));
  ok(!app.includes('🗺 Google Maps') && !app.includes('🚗 Waze'));
});
test('icon buttons are mobile-sized', () => ok(css.includes('.nav-chooser-btn{min-height:46px') && css.includes('.nav-ico{width:24px;height:24px')));
test('REGRESSION הזגג 11, אילת → both providers get the same Eilat destination', () => {
  const d = navDestination({ address: 'הזגג 11', city: 'אילת', name: 'רמי לוי' });
  const g = new URL(googleMapsUrl(d)).searchParams.get('query'), w = new URL(wazeUrl(d)).searchParams.get('q');
  eq(g, 'הזגג 11, אילת, ישראל'); eq(w, g); ok(!g.includes('חדרה'));
});
test('verified coordinates are preferred and shared by both providers', () => {
  const d = navDestination({ lat: 29.5577, lng: 34.9519, address: 'הזגג 11', city: 'אילת' });
  ok(googleMapsUrl(d).includes('29.5577,34.9519')); ok(wazeUrl(d).includes('ll=29.5577,34.9519'));
});

// ── E. store identity ────────────────────────────────────────────────────────
console.log('\nE. Store identity');
test('chain + branch (רמי לוי · מרכול אינטרנט)', () => eq(storeRowTitle({ chainId: 'rami-levy', chainName: 'רמי לוי', storeName: 'מרכול אינטרנט' }), 'רמי לוי · מרכול אינטרנט'));
test('chain only when no branch name', () => eq(storeRowTitle({ chainId: 'victory', chainName: 'ויקטורי', storeName: '' }), 'ויקטורי'));
test('branch already containing the chain is not doubled', () => eq(storeRowTitle({ chainId: 'rami-levy', chainName: 'רמי לוי', storeName: 'רמי לוי אילת' }), 'רמי לוי אילת'));
test('Shufersal Deal always shows שופרסל', () => {
  eq(storeRowTitle({ chainId: 'shufersal', chainName: 'שופרסל', storeName: 'דיל' }), 'שופרסל · דיל');
  for (const n of ['דיל', 'אילת', 'דיל אילת הסתת', 'BE אייס']) ok(storeRowTitle({ chainId: 'shufersal', chainName: 'שופרסל', storeName: n }).includes('שופרסל'), n);
});
test('Shufersal identified only by GS1 id still shows שופרסל', () => ok(storeRowTitle({ chainId: '7290027600007', storeName: 'אילת' }).includes('שופרסל')));
test('address line is full address + city, city once', () => {
  eq(storeAddressLine({ address: 'הזגג 11', city: 'אילת' }), 'הזגג 11, אילת');
  eq(storeAddressLine({ address: 'הזגג 11, אילת', city: 'אילת' }), 'הזגג 11, אילת');
  eq(storeAddressLine({ address: '', city: 'בני ברק' }), 'בני ברק');
  eq(storeAddressLine({}), '');
});
test('both price-comparison renderers use chain-aware title + address line', () => {
  ok(app.includes('${esc(storeRowTitle(p))}</span>')); ok(app.includes('const primaryName  = storeRowTitle(p);'));
  ok(app.includes('const addrLine     = storeAddressLine(p);')); ok(app.includes('const _addrLine = storeAddressLine(p);'));
});

// ── F. wiring ────────────────────────────────────────────────────────────────
console.log('\nF. App wiring');
test('picker shows 10 + "ראה עוד (N)" button and expanded paginated view', () => {
  ok(app.includes('bpPickerView(_bpProducts)')); ok(app.includes('ראה עוד (${_view.remaining})'));
  ok(app.includes('window.openBpMore') && app.includes('window.bpMorePage') && app.includes('window.closeBpMore'));
  ok(app.includes('>קודם</button>') && app.includes('>הבא</button>') && app.includes('עמוד ${pg.page} מתוך ${pg.pages}'));
});
test('ranked list is no longer truncated to 20 before counting', () => {
  const run = app.slice(app.indexOf('async function _bpRunSearch'), app.indexOf('function _bpItemHtml'));
  ok(!/\.slice\(0, 20\)/.test(run), 'slice(0,20) still present in _bpRunSearch');
  ok(!run.includes('_bpProducts.slice(0, 14)'));
});
test('broad selection runs only when strict mode did not, then falls back to the existing scorer', () => {
  ok(app.includes('bpSelectBroadCandidates(eligible')); ok(app.includes('if (!_heStrictUsed && !_broadUsed)'));
});
test('OFF incomplete-Hebrew safety is unchanged', () => ok(app.includes('bpIsIncompleteHebrewCorpus(_corpusResult.batches, queryLang)')));
test('report UI still hidden; help text has no report copy', () => {
  ok(!app.includes('דיווח מוצג')); ok(!/>\s*🚨 דווח/.test(app));
});
test('SW shell lists the new modules', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  ok(sw.includes("'/js/bp-intent.js'") && sw.includes("'/js/bp-results.js'"));
});

console.log(`\npicker-semantics: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

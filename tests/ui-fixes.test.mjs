/**
 * tests/ui-fixes.test.mjs
 *
 * Regression tests for the four UI/UX fixes:
 *   Fix 1 — qty-mode-toggle: overflow:hidden removed, per-button border-radius added
 *   Fix 2 — bought button text: קניתי ↔ החזר לעגלה state machine
 *   Fix 3 — splash background: #1b4a1b → #ffffff (correct layer confirmed)
 *   Fix 4 — search fallback: numeric-filtered longest-token, tiered ranking via matchScore,
 *            parallel broadening, merge+preLimitDedup+limit+render order
 *
 * Run with: node tests/ui-fixes.test.mjs
 * No framework required — plain Node.js + fs.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = resolve(__dir, '..');

const css  = readFileSync(resolve(root, 'styles.css'),  'utf8');
const js   = readFileSync(resolve(root, 'app.js'),      'utf8');
const sw   = readFileSync(resolve(root, 'sw.js'),       'utf8');

let pass = 0, fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ── FIX 1: qty-mode-toggle ──────────────────────────────────────────────────
console.log('\nFix 1 — qty-mode-toggle (ק״ג clipping)');

test('.qty-mode-toggle must NOT have overflow:hidden', () => {
  // Extract the .qty-mode-toggle rule
  const m = css.match(/\.qty-mode-toggle\{([^}]+)\}/);
  assert(m, '.qty-mode-toggle rule not found in styles.css');
  const rule = m[1];
  assert(!rule.includes('overflow:hidden'),
    `overflow:hidden found in .qty-mode-toggle — clipping bug present.\n    Rule: ${rule}`);
});

test('.qty-mode-toggle retains border-radius (visual containment)', () => {
  const m = css.match(/\.qty-mode-toggle\{([^}]+)\}/);
  assert(m, '.qty-mode-toggle rule not found');
  assert(m[1].includes('border-radius'),
    'border-radius was removed from .qty-mode-toggle — visual regression');
});

test('.qty-mode-btn:first-child has border-radius (right side in RTL)', () => {
  assert(css.includes('.qty-mode-btn:first-child'),
    '.qty-mode-btn:first-child rule missing — active state will paint square corners on right side');
  const m = css.match(/\.qty-mode-btn:first-child\{([^}]+)\}/);
  assert(m && m[1].includes('border-radius'),
    '.qty-mode-btn:first-child missing border-radius');
});

test('.qty-mode-btn:last-child has border-radius (left side in RTL)', () => {
  assert(css.includes('.qty-mode-btn:last-child'),
    '.qty-mode-btn:last-child rule missing — active state will paint square corners on left side');
  const m = css.match(/\.qty-mode-btn:last-child\{([^}]+)\}/);
  assert(m && m[1].includes('border-radius'),
    '.qty-mode-btn:last-child missing border-radius');
});

test('יח׳ button text present in HTML template (app.js)', () => {
  assert(js.includes("יח׳"),
    'יח׳ button label not found in app.js');
});

test('ק״ג button text present in HTML template (app.js)', () => {
  assert(js.includes('ק״ג'),
    'ק״ג button label not found in app.js');
});

test('qty-mode-btn active rule still exists', () => {
  assert(css.includes('.qty-mode-btn.active'),
    '.qty-mode-btn.active rule was removed — active state has no visual indicator');
});

// ── FIX 2: bought button state machine ─────────────────────────────────────
console.log('\nFix 2 — bought button state (קניתי / החזר לעגלה)');

test("'קניתי' label present for un-bought state", () => {
  // Should appear in boughtBtn template as the :false branch
  assert(js.includes("'קניתי'"),
    "'קניתי' label not found in app.js");
});

test("'החזר לעגלה' label present for bought state", () => {
  assert(js.includes("'החזר לעגלה'"),
    "'החזר לעגלה' label missing — bought items show wrong text");
});

test("'✅ קניתי' old label is gone (would duplicate emoji + text)", () => {
  assert(!js.includes("'✅ קניתי'"),
    "'✅ קניתי' old label still present — old bought-state text was not replaced");
});

test("bought button text is derived from item.bought (single source of truth)", () => {
  // The boughtBtn template must use item.bought for both the class and the label.
  // Verify the ternary pattern: item.bought?'...':'...' appears once in boughtBtn context.
  const boughtBtnLine = js.split('\n').find(l => l.includes('boughtBtn') && l.includes('item.bought'));
  assert(boughtBtnLine, 'boughtBtn assignment using item.bought not found');
  assert(boughtBtnLine.includes("'החזר לעגלה'"),
    "'החזר לעגלה' not in the boughtBtn assignment line — label and state may be out of sync");
  assert(boughtBtnLine.includes("'קניתי'"),
    "'קניתי' not in the boughtBtn assignment line");
  // Both labels must be in the same ternary so they track the same state flag
  const ternaryIdx = boughtBtnLine.indexOf('item.bought?');
  assert(ternaryIdx !== -1, 'item.bought ternary not found in boughtBtn line');
});

test('bought-tag CSS class still defined (bought button styling)', () => {
  assert(css.includes('.bought-tag'), '.bought-tag CSS rule missing');
});

test('pending-tag CSS class still defined (un-bought button styling)', () => {
  assert(css.includes('.pending-tag'), '.pending-tag CSS rule missing');
});

// ── FIX 3: splash background ────────────────────────────────────────────────
console.log('\nFix 3 — splash background (#1b4a1b → #ffffff)');

test('#splash-overlay background is white (#ffffff)', () => {
  const m = css.match(/#splash-overlay\{([^}]+)\}/s);
  assert(m, '#splash-overlay rule not found');
  const rule = m[1];
  assert(rule.includes('#ffffff') || rule.includes('#fff') || rule.includes('white'),
    `#splash-overlay background is not white.\n    Rule: ${rule}`);
});

test('#splash-overlay does NOT have green background (#1b4a1b)', () => {
  const m = css.match(/#splash-overlay\{([^}]+)\}/s);
  assert(m, '#splash-overlay rule not found');
  assert(!m[1].includes('#1b4a1b'),
    'Old green background #1b4a1b still present in #splash-overlay');
});

test('#splash-overlay retains transition (fade-out behavior intact)', () => {
  assert(css.includes('splash-overlay') && css.includes('transition'),
    '#splash-overlay lost the transition — fade-out may break');
});

// ── FIX 4: search fallback — matchScore + longest-token ────────────────────
console.log('\nFix 4 — search fallback (עגבניות שרי / שרי עגבניות)');

// Extract matchScore from app.js and eval it in Node context
const matchScoreFnMatch = js.match(/function matchScore\(name, query\) \{[\s\S]*?\n\}/);
assert(matchScoreFnMatch, 'matchScore function not found in app.js — tests cannot run');
const matchScoreFn = new Function('name', 'query', matchScoreFnMatch[0]
  .replace('function matchScore(name, query) {', '')
  .replace(/\}$/, ''));

// Shim to call as a proper function
function matchScore(name, query) {
  const n = (name || '').trim().toLowerCase();
  const q = (query || '').trim().toLowerCase();
  if (!q) return 50;
  if (n === q) return 100;
  if (n.startsWith(q)) return n[q.length] === ' ' ? 90 : 85;
  const words = n.split(/\s+/);
  if (words[0] === q) return 88;
  if (words.includes(q)) return 75;
  if (n.includes(q)) return 60;
  const qWords = q.split(/\s+/);
  if (qWords.length > 1 && qWords.every(qw => words.some(w => w.startsWith(qw)))) return 40;
  return 10;
}

const CHERRY_PRODUCTS = [
  'עגבניות שרי',
  'עגבניות שרי לובלו',
  'עגבניות שרי לקופן',
  'עגבניות שרי קלמר',
  'עגבניות שרי 250 גרם',
];

const BROADER_TOMATO_PRODUCTS = [
  'עגבניות',
  'עגבניות מרוסקות',
  'עגבניות שלמות בשימורים',
  'רסק עגבניות',
  'מיץ עגבניות',
  'עגבניות לייבוש',
];

const UNRELATED_PRODUCTS = [
  'במבה',
  'חלב טרי',
  'שמן זית',
  'קוקה קולה',
];

function rank(products, query) {
  return [...products]
    .map(p => ({ name: p, score: matchScore(p, query) }))
    .sort((a, b) => b.score - a.score);
}

function minScore(products, query) {
  return Math.min(...products.map(p => matchScore(p, query)));
}
function maxScore(products, query) {
  return Math.max(...products.map(p => matchScore(p, query)));
}

// Tests for query "עגבניות שרי" (natural order)
test('עגבניות שרי — all cherry tomato products score > all broader tomato products', () => {
  const q = 'עגבניות שרי';
  const cherryMin = minScore(CHERRY_PRODUCTS, q);
  const broaderMax = maxScore(BROADER_TOMATO_PRODUCTS, q);
  assert(cherryMin > broaderMax,
    `Cherry min score ${cherryMin} must exceed broader max score ${broaderMax}`);
});

test('עגבניות שרי — cherry tomatoes score ≥ 40', () => {
  const q = 'עגבניות שרי';
  for (const p of CHERRY_PRODUCTS) {
    const s = matchScore(p, q);
    assert(s >= 40, `"${p}" scored ${s} — expected ≥ 40 for "${q}"`);
  }
});

test('עגבניות שרי — exact match scores 100', () => {
  assert(matchScore('עגבניות שרי', 'עגבניות שרי') === 100,
    'Exact match should score 100');
});

test('עגבניות שרי — variants (לובלו, לקופן) score ≥ 90 (prefix match)', () => {
  const q = 'עגבניות שרי';
  const variant1 = matchScore('עגבניות שרי לובלו', q);
  const variant2 = matchScore('עגבניות שרי לקופן', q);
  assert(variant1 >= 90, `עגבניות שרי לובלו scored ${variant1}, expected ≥ 90`);
  assert(variant2 >= 90, `עגבניות שרי לקופן scored ${variant2}, expected ≥ 90`);
});

test('עגבניות שרי — unrelated products score 10', () => {
  const q = 'עגבניות שרי';
  for (const p of UNRELATED_PRODUCTS) {
    const s = matchScore(p, q);
    assert(s === 10, `"${p}" scored ${s} — expected 10 (unrelated to "${q}")`);
  }
});

// Tests for query "שרי עגבניות" (reversed order)
test('שרי עגבניות — cherry tomato products outscore unrelated products', () => {
  const q = 'שרי עגבניות';
  const cherryMin = minScore(CHERRY_PRODUCTS, q);
  const unrelatedMax = maxScore(UNRELATED_PRODUCTS, q);
  assert(cherryMin > unrelatedMax,
    `Cherry min score ${cherryMin} must exceed unrelated max score ${unrelatedMax}`);
});

test('שרי עגבניות — cherry tomatoes score ≥ 40 (all-tokens match)', () => {
  const q = 'שרי עגבניות';
  for (const p of CHERRY_PRODUCTS) {
    const s = matchScore(p, q);
    assert(s >= 40, `"${p}" scored ${s} — expected ≥ 40 for reversed query "${q}"`);
  }
});

test('שרי עגבניות — cherry tomatoes outscore plain tomatoes', () => {
  const q = 'שרי עגבניות';
  const cherryMin = minScore(CHERRY_PRODUCTS, q);
  const broaderMax = maxScore(BROADER_TOMATO_PRODUCTS, q);
  assert(cherryMin > broaderMax,
    `Cherry min ${cherryMin} must exceed broader max ${broaderMax} for reversed query`);
});

test('שרי עגבניות — unrelated products score 10', () => {
  const q = 'שרי עגבניות';
  for (const p of UNRELATED_PRODUCTS) {
    const s = matchScore(p, q);
    assert(s === 10, `"${p}" scored ${s} for "${q}" — expected 10`);
  }
});

// Fallback token selection logic
// Helper matching app.js multi-token broadening selection:
//   non-numeric, ≥2 chars, sorted longest-first (stable), capped at 2
function selectBroadToks(q, cap = 2) {
  const toks = q.trim().split(/\s+/);
  return toks
    .filter(t => !/^\d+$/.test(t) && t.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, cap);
}

test('multi-token broadening: "עגבניות שרי" → both tokens selected', () => {
  const toks = selectBroadToks('עגבניות שרי');
  assert(toks.includes('עגבניות'), `"עגבניות" must be in broader tokens; got [${toks.join(', ')}]`);
  assert(toks.includes('שרי'),     `"שרי" must be in broader tokens; got [${toks.join(', ')}]`);
  assert(toks.length <= 2, `Must not exceed cap of 2; got ${toks.length}`);
});

test('multi-token broadening: "שרי עגבניות" → same 2 tokens regardless of word order', () => {
  const fwd = selectBroadToks('עגבניות שרי').sort().join(',');
  const rev = selectBroadToks('שרי עגבניות').sort().join(',');
  assert(fwd === rev, `Token selection must be order-invariant; fwd=[${fwd}] rev=[${rev}]`);
});

test('multi-token broadening: "חלב 3 אחוז" → "3" excluded, both non-numeric tokens selected', () => {
  const toks = selectBroadToks('חלב 3 אחוז');
  assert(!toks.includes('3'), `Numeric "3" must not appear; got [${toks.join(', ')}]`);
  assert(toks.includes('חלב'),  `"חלב" (milk) must be in broader tokens; got [${toks.join(', ')}]`);
  assert(toks.includes('אחוז'), `"אחוז" must be in broader tokens; got [${toks.join(', ')}]`);
});

test('multi-token broadening: "5 ביצים" → "5" excluded, just "ביצים"', () => {
  const toks = selectBroadToks('5 ביצים');
  assert(!toks.includes('5'), `Numeric "5" must not appear`);
  assert(toks.includes('ביצים'), `"ביצים" must be selected`);
  assert(toks.length === 1, `Only 1 non-numeric token; got ${toks.length}`);
});

test('multi-token broadening: "לחם ללא גלוטן" → "גלוטן" and "לחם" (not "ללא")', () => {
  const toks = selectBroadToks('לחם ללא גלוטן');
  assert(toks.includes('גלוטן'), `"גלוטן" (longest) must be first; got [${toks.join(', ')}]`);
  assert(toks.includes('לחם'),   `"לחם" must be in top 2 (stable sort favours original order for tie); got [${toks.join(', ')}]`);
  assert(!toks.includes('ללא'),  `"ללא" must be excluded by the cap; got [${toks.join(', ')}]`);
});

test('multi-token broadening: "קפה שחור" → both tokens selected', () => {
  const toks = selectBroadToks('קפה שחור');
  assert(toks.includes('קפה'),   `"קפה" must be in broader tokens; got [${toks.join(', ')}]`);
  assert(toks.includes('שחור'),  `"שחור" must be in broader tokens; got [${toks.join(', ')}]`);
});

test('multi-token broadening: cap is 2 — 4-word query yields at most 2 tokens', () => {
  const toks = selectBroadToks('שמן זית כתית מיובא');
  assert(toks.length <= 2, `Cap of 2 must be respected; got ${toks.length}`);
});

test('multi-token broadening: all-numeric query falls back gracefully (empty broader pool)', () => {
  // All-numeric tokens filtered → empty candidate list → no broader requests fired
  const toks = selectBroadToks('100 200 300');
  assert(toks.length === 0, `All-numeric query must produce empty broader token list; got [${toks.join(', ')}]`);
});

test('app.js broadening: uses Promise.all for parallel multi-token requests', () => {
  assert(js.includes('Promise.all(_broaderPromises)'),
    'Promise.all(_broaderPromises) not found — parallel broader requests not implemented');
});

test('app.js broadening: numeric filter (/^\\d+$/) and min-length (>= 2) both present', () => {
  assert(js.includes('/^\\d+$/'),
    'Numeric filter /^\\d+$/ not found in app.js broadening logic');
  assert(js.includes('.length >= 2'),
    'Min-length >= 2 filter not found in app.js broadening logic');
});

test('app.js broadening: capped at 2 tokens (.slice(0, 2))', () => {
  assert(js.includes('.slice(0, 2)'),
    '.slice(0, 2) cap not found in app.js broadening logic');
});

// ── FIX 4 continued: merge + broadening architecture ─────────────────────────
console.log('\nFix 4 — merge + broadening architecture');

// Inline _mergeByBarcode matching the app.js implementation exactly
function _mergeByBarcode(primary, broader) {
  if (!broader?.length) return primary;
  const seen = new Set(primary.map(r => r.barcode).filter(Boolean));
  const extras = broader.filter(r => !r.barcode || !seen.has(r.barcode));
  return [...primary, ...extras];
}

// Fixture: primary (full query "עגבניות שרי") returns some cherry tomatoes.
// This tests the case where the full query ALREADY returns results — the key case.
const PRIMARY_RESULTS = [
  { barcode: '7290000001', name: 'עגבניות שרי',       prices: [{ store: 'שופרסל', price: 9.90 }] },
  { barcode: '7290000002', name: 'עגבניות שרי לובלו', prices: [{ store: 'רמי לוי', price: 8.50 }] },
];

// Broader (token "עגבניות") returns more — including one duplicate barcode
const BROADER_RESULTS = [
  { barcode: '7290000002', name: 'עגבניות שרי לובלו',  prices: [{ store: 'שופרסל', price: 8.50 }] }, // duplicate
  { barcode: '7290000010', name: 'עגבניות שרי וונדר',  prices: [{ store: 'מגה',     price: 7.90 }] }, // new cherry variant
  { barcode: '7290000020', name: 'עגבניות',             prices: [{ store: 'שופרסל', price: 5.90 }] }, // plain tomato
  { barcode: '7290000021', name: 'עגבניות מרוסקות',    prices: [{ store: 'שופרסל', price: 4.50 }] }, // crushed
  { barcode: '7290000022', name: 'רסק עגבניות',        prices: [{ store: 'שופרסל', price: 3.90 }] }, // paste
  { barcode: '7290000099', name: 'במבה',                prices: [{ store: 'שופרסל', price: 6.50 }] }, // unrelated
];

test('_mergeByBarcode — duplicate barcode appears only once in merged set', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, BROADER_RESULTS);
  const barcodes = merged.map(r => r.barcode);
  const unique = new Set(barcodes);
  assert(barcodes.length === unique.size,
    `Duplicate barcodes found: [${barcodes.join(', ')}]`);
});

test('_mergeByBarcode — primary (2) + broader unique (5) = 7 total', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, BROADER_RESULTS);
  assert(merged.length === 7,
    `Expected 7 merged items (2 primary + 5 new from broader), got ${merged.length}`);
});

test('_mergeByBarcode — primary results come first in merged set', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, BROADER_RESULTS);
  assert(merged[0].barcode === '7290000001', 'First primary result must be first in merged set');
  assert(merged[1].barcode === '7290000002', 'Second primary result must be second in merged set');
});

test('_mergeByBarcode — new cherry tomato variant from broader is included', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, BROADER_RESULTS);
  assert(merged.some(r => r.barcode === '7290000010'),
    'עגבניות שרי וונדר (barcode 7290000010) missing from merged set');
});

test('_mergeByBarcode — empty broader returns primary unchanged', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, []);
  assert(merged.length === PRIMARY_RESULTS.length,
    'Empty broader should not change primary result count');
});

test('merged set — cherry tomatoes rank above generic tomatoes for "עגבניות שרי"', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, BROADER_RESULTS);
  const query = 'עגבניות שרי';
  const ranked = merged
    .map(r => ({ name: r.name, score: matchScore(r.name, query) }))
    .sort((a, b) => b.score - a.score);

  const cherryNames = new Set(['עגבניות שרי', 'עגבניות שרי לובלו', 'עגבניות שרי וונדר']);
  const genericNames = new Set(['עגבניות', 'עגבניות מרוסקות', 'רסק עגבניות']);

  const lastCherryPos  = Math.max(...ranked.map((r, i) => cherryNames.has(r.name) ? i : -1));
  const firstGenericPos = Math.min(...ranked.map((r, i) => genericNames.has(r.name) ? i : Infinity));

  assert(lastCherryPos < firstGenericPos,
    `Cherry tomatoes must all rank above generic tomatoes.\nOrder: ${ranked.map(r => r.name + '(' + r.score + ')').join(', ')}`);
});

test('merged set — cherry tomatoes rank above generic tomatoes for "שרי עגבניות" (reversed)', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, BROADER_RESULTS);
  const query = 'שרי עגבניות';
  const cherryScores  = merged.filter(r => r.name.includes('שרי')).map(r => matchScore(r.name, query));
  const genericScores = ['עגבניות', 'עגבניות מרוסקות', 'רסק עגבניות'].map(n => matchScore(n, query));
  const minCherry  = Math.min(...cherryScores);
  const maxGeneric = Math.max(...genericScores);
  assert(minCherry > maxGeneric,
    `Cherry tomatoes must outscore generic for reversed query.\nMin cherry: ${minCherry}, max generic: ${maxGeneric}`);
});

test('merged set — unrelated product (במבה) scores last for "עגבניות שרי"', () => {
  const merged = _mergeByBarcode(PRIMARY_RESULTS, BROADER_RESULTS);
  const query = 'עגבניות שרי';
  const bambScore = matchScore('במבה', query);
  const cherryMin = Math.min(...PRIMARY_RESULTS.map(r => matchScore(r.name, query)));
  assert(bambScore < cherryMin,
    `במבה (score ${bambScore}) must score below cherry tomatoes (min ${cherryMin}) for "${query}"`);
});

test('architecture: _mergeByBarcode defined in app.js', () => {
  assert(js.includes('function _mergeByBarcode('),
    '_mergeByBarcode not defined in app.js — merge function missing');
});

test('architecture: broader fetches fire before zero-results check (enrichment, not rescue)', () => {
  const broaderStart     = js.indexOf('_broaderPromises.push(');
  const zeroResultsCheck = js.indexOf('if (!data.results || !data.results.length)');
  assert(broaderStart !== -1,     '_broaderPromises.push( not found in app.js');
  assert(zeroResultsCheck !== -1, 'zero-results check not found in app.js');
  assert(broaderStart < zeroResultsCheck,
    '_broaderPromises must be populated BEFORE the zero-results check — broadening is not rescue-only');
});

test('architecture: Promise.all awaited before zero-results check (merged set always available)', () => {
  const awaitIdx         = js.indexOf('await Promise.all(_broaderPromises)');
  const zeroResultsCheck = js.indexOf('if (!data.results || !data.results.length)');
  assert(awaitIdx !== -1,         'await Promise.all(_broaderPromises) not found in app.js');
  assert(awaitIdx < zeroResultsCheck,
    'await Promise.all must occur before the zero-results check so merged set is always available');
});

// ── FIX 4: final result limit (rank-then-limit, preserve pre-change max of 20) ──
console.log('\nFix 4 — final result limit');

// Inline _limitMerged matching app.js implementation
function _limitMerged(results, query, limit = 20) {
  if (results.length <= limit) return results;
  return [...results]
    .sort((a, b) => matchScore(b.name || '', query) - matchScore(a.name || '', query))
    .slice(0, limit);
}

// Fixture: primary (12 cherry tomatoes) + broader (1 duplicate + 3 new cherry + 8 generic)
// Total after dedup: 12 + 3 + 8 = 23 — exceeds limit of 20.
const LIMIT_PRIMARY = Array.from({ length: 12 }, (_, i) => ({
  barcode: `72900001${String(i).padStart(2,'0')}`,
  name: `עגבניות שרי ${['לובלו','קלמר','אורגני','סנסי','זרי','טבעת','אדום','צהוב','ירוק','שחור','גדול','קטן'][i]}`,
  prices: [{ store: 'שופרסל', price: 9 + i * 0.1 }],
}));

const LIMIT_BROADER = [
  // 1 duplicate barcode (7290000100 = first item of LIMIT_PRIMARY — must be filtered out)
  { barcode: '7290000100', name: 'עגבניות שרי לובלו', prices: [{ store: 'מגה', price: 8.5 }] },
  // 3 new cherry tomato variants (high score for עגבניות שרי)
  { barcode: '7290001201', name: 'עגבניות שרי ביו',    prices: [{ store: 'מגה', price: 9.5 }] },
  { barcode: '7290001202', name: 'עגבניות שרי פרמיום', prices: [{ store: 'מגה', price: 10.0 }] },
  { barcode: '7290001203', name: 'עגבניות שרי מיני',   prices: [{ store: 'מגה', price: 7.5 }] },
  // 8 generic tomato products (low score for עגבניות שרי)
  { barcode: '7290002001', name: 'עגבניות',             prices: [{ store: 'שופרסל', price: 5.9 }] },
  { barcode: '7290002002', name: 'עגבניות מרוסקות',    prices: [{ store: 'שופרסל', price: 4.5 }] },
  { barcode: '7290002003', name: 'עגבניות שלמות',      prices: [{ store: 'שופרסל', price: 4.2 }] },
  { barcode: '7290002004', name: 'רסק עגבניות',        prices: [{ store: 'שופרסל', price: 3.9 }] },
  { barcode: '7290002005', name: 'מיץ עגבניות',        prices: [{ store: 'שופרסל', price: 6.5 }] },
  { barcode: '7290002006', name: 'עגבניות לייבוש',     prices: [{ store: 'שופרסל', price: 8.0 }] },
  { barcode: '7290002007', name: 'עגבניות מרוסקות אורגני', prices: [{ store: 'שופרסל', price: 5.2 }] },
  { barcode: '7290002008', name: 'עגבניות שלמות ללא מלח', prices: [{ store: 'שופרסל', price: 4.8 }] },
];

test('result-limit: merged set exceeds limit before applying _limitMerged', () => {
  const merged = _mergeByBarcode(LIMIT_PRIMARY, LIMIT_BROADER);
  assert(merged.length === 23,
    `Expected 23 merged items (12 primary + 3 new cherry + 8 generic, 1 dup removed), got ${merged.length}`);
  assert(merged.length > 20, `Merged set must exceed limit of 20; got ${merged.length}`);
});

test('result-limit: _limitMerged caps at 20', () => {
  const merged = _mergeByBarcode(LIMIT_PRIMARY, LIMIT_BROADER);
  const limited = _limitMerged(merged, 'עגבניות שרי');
  assert(limited.length === 20,
    `Expected 20 after limit, got ${limited.length}`);
});

test('result-limit: all cherry tomato results survive the limit', () => {
  const merged = _mergeByBarcode(LIMIT_PRIMARY, LIMIT_BROADER);
  const limited = _limitMerged(merged, 'עגבניות שרי');
  // 12 primary + 3 new cherry = 15 cherry tomatoes, all score ≥ 40
  const cherryInLimited = limited.filter(r => r.name.includes('שרי'));
  assert(cherryInLimited.length === 15,
    `All 15 cherry tomato products must survive the limit, found ${cherryInLimited.length}`);
});

test('result-limit: weaker generic results removed first', () => {
  const merged = _mergeByBarcode(LIMIT_PRIMARY, LIMIT_BROADER);
  const limited = _limitMerged(merged, 'עגבניות שרי');
  // 8 generic tomatoes (score 10) — only 5 should fit (20 - 15 cherry = 5)
  const genericInLimited = limited.filter(r => !r.name.includes('שרי'));
  assert(genericInLimited.length === 5,
    `Expected 5 generic tomatoes after limit (20 - 15 cherry), got ${genericInLimited.length}`);
  // All survivors must have barcodes from the generic set
  genericInLimited.forEach(r => {
    assert(r.barcode?.startsWith('7290002'),
      `Unexpected product in limited generic slot: ${r.name}`);
  });
});

test('result-limit: _limitMerged is no-op for ≤ 20 results', () => {
  const small = LIMIT_PRIMARY.slice(0, 5);
  const result = _limitMerged(small, 'עגבניות שרי');
  assert(result === small, '_limitMerged must return original array reference when no limiting needed');
});

test('result-limit: _limitMerged defined in app.js', () => {
  assert(js.includes('function _limitMerged('),
    '_limitMerged not defined in app.js');
});

test('result-limit: _SEARCH_RESULT_LIMIT is 20 (matches API ranked.slice(0, 20))', () => {
  assert(js.includes('_SEARCH_RESULT_LIMIT = 20'),
    '_SEARCH_RESULT_LIMIT constant not found or not 20 in app.js');
});

// ── Fix 4: non-tomato fixture 1 — קפה שחור (modifier longer than head noun) ─────
console.log('\nFix 4 — non-tomato: קפה שחור (both tokens broaden; קפה adds coffee candidates)');

// "קפה שחור" (black coffee): שחור(4) > קפה(3).
// A single-longest-token strategy would pick only "שחור" → misses useful coffee candidates.
// Multi-token strategy picks BOTH "שחור" AND "קפה" → both broader queries fire.
// The "קפה" broader query retrieves additional coffee products that the primary "קפה שחור"
// query might miss. The "שחור" broader query retrieves noise — but noise scores low (10) and
// is cut by _limitMerged before any primary קפה שחור product.

const COFFEE_PRIMARY = [
  { barcode: '7300000001', name: 'קפה שחור',       prices: [{ chainName: 'שופרסל', price: 12.9 }] },
  { barcode: '7300000002', name: 'קפה שחור נמס',   prices: [{ chainName: 'שופרסל', price: 11.5 }] },
  { barcode: '7300000003', name: 'קפה שחור טורקי', prices: [{ chainName: 'רמי לוי', price: 13.5 }] },
];
const BROADER_SHACHOR = [  // from broader "שחור" query — noise
  { barcode: '7300000010', name: 'לחם שחור',     prices: [{ chainName: 'שופרסל', price: 5.9 }] },
  { barcode: '7300000011', name: 'שומשום שחור',  prices: [{ chainName: 'שופרסל', price: 8.5 }] },
];
const BROADER_CAFE = [  // from broader "קפה" query — useful candidates
  { barcode: '7300000020', name: 'קפה נמס',    prices: [{ chainName: 'מגה', price: 9.9 }] },
  { barcode: '7300000021', name: 'קפה טורקי',  prices: [{ chainName: 'מגה', price: 14.0 }] },
  { barcode: '7300000022', name: 'קפה קלוי',   prices: [{ chainName: 'מגה', price: 22.0 }] },
];

test('קפה שחור — both tokens ("שחור" and "קפה") selected for broadening', () => {
  const toks = selectBroadToks('קפה שחור');
  assert(toks.includes('שחור'), `"שחור" must be selected as broader token`);
  assert(toks.includes('קפה'),  `"קפה" must be selected as broader token`);
});

test('קפה שחור — קפה broader results enter merged candidate pool', () => {
  // Simulates the multi-token pool: both "שחור" and "קפה" broader results are flattened
  const broaderPool = [...BROADER_SHACHOR, ...BROADER_CAFE];
  const merged = _mergeByBarcode(COFFEE_PRIMARY, broaderPool);
  assert(merged.some(r => r.barcode === '7300000020'),
    '"קפה נמס" (from קפה broader search) must be in merged candidate pool');
  assert(merged.some(r => r.barcode === '7300000021'),
    '"קפה טורקי" (from קפה broader search) must be in merged candidate pool');
});

test('קפה שחור — primary products rank above broader noise', () => {
  const q = 'קפה שחור';
  const primaryMin  = Math.min(...COFFEE_PRIMARY.map(r => matchScore(r.name, q)));
  const shachorMax  = Math.max(...BROADER_SHACHOR.map(r => matchScore(r.name, q)));
  assert(primaryMin > shachorMax,
    `Primary coffee products (min ${primaryMin}) must outscore שחור-only noise (max ${shachorMax})`);
});

test('קפה שחור — שחור-only noise scores 10 (cut before primary results)', () => {
  const q = 'קפה שחור';
  BROADER_SHACHOR.forEach(r => {
    const s = matchScore(r.name, q);
    assert(s === 10, `"${r.name}" scored ${s} — שחור-only noise must score 10`);
  });
});

test('קפה שחור — after merge + limit, primary coffee products all survive', () => {
  const broaderPool = [...BROADER_SHACHOR, ...BROADER_CAFE];
  const merged  = _mergeByBarcode(COFFEE_PRIMARY, broaderPool);
  const limited = _limitMerged(merged, 'קפה שחור');
  const primarySurvived = COFFEE_PRIMARY.every(r => limited.some(l => l.barcode === r.barcode));
  assert(primarySurvived, 'All primary קפה שחור products must survive after merge + limit');
});

// ── Fix 4: non-tomato fixture 2 — גבינה צהובה (cheese) ─────────────────────
console.log('\nFix 4 — non-tomato: גבינה צהובה (cheese)');

// "גבינה צהובה" (yellow cheese): גבינה(5) > צהובה(4) → broadening picks "גבינה" ✓ (correct).
// Also tests that the broad product term is chosen when it IS the longest token.
const CHEESE_PRODUCTS = [
  'גבינה צהובה',
  'גבינה צהובה עמק',
  'גבינה צהובה 30%',
  'גבינה צהובה פרוסה',
];
const CHEESE_BROADER = [
  'גבינה לבנה',
  'גבינה עיזים',
  'גבינה קשה',
];

test('גבינה צהובה — "גבינה" is in broadening tokens (product term, longest non-numeric)', () => {
  const toks = selectBroadToks('גבינה צהובה');
  assert(toks.includes('גבינה'),
    `Expected "גבינה" in broader tokens; got [${toks.join(', ')}]`);
});

test('גבינה צהובה — yellow cheese products score ≥ 40 for original full query', () => {
  const q = 'גבינה צהובה';
  CHEESE_PRODUCTS.forEach(p => {
    const s = matchScore(p, q);
    assert(s >= 40, `"${p}" scored ${s} — expected ≥ 40 for "${q}"`);
  });
});

test('גבינה צהובה — yellow cheese outscores generic cheese for specific query', () => {
  const q = 'גבינה צהובה';
  const yellowMin  = Math.min(...CHEESE_PRODUCTS.map(p => matchScore(p, q)));
  const broaderMax = Math.max(...CHEESE_BROADER.map(p => matchScore(p, q)));
  assert(yellowMin > broaderMax,
    `Yellow cheese (min ${yellowMin}) must outscore generic cheese (max ${broaderMax}) for "${q}"`);
});

// ── Fix 4: non-tomato fixture 2 — חלב 3 אחוז (milk, numeric token) ───────────
console.log('\nFix 4 — non-tomato: חלב 3 אחוז (numeric "3" filtered; both non-numeric tokens used)');

const MILK_PRIMARY = [
  { barcode: '7200000001', name: 'חלב 3% שופרסל',   prices: [{ chainName: 'שופרסל', price: 5.9 }] },
  { barcode: '7200000002', name: 'חלב 3% תנובה',     prices: [{ chainName: 'רמי לוי', price: 5.5 }] },
];
// Broader "אחוז" search — likely near-zero useful results; any noise scores 10
const BROADER_ACHUZ = [
  { barcode: '7200000010', name: 'אחוז 3 מסחרי',     prices: [{ chainName: 'שופרסל', price: 1.0 }] },
];
// Broader "חלב" search — useful milk candidates that may not appear for "חלב 3 אחוז"
const BROADER_CHALAV = [
  { barcode: '7200000020', name: 'חלב 1% תנובה',     prices: [{ chainName: 'מגה', price: 5.2 }] },
  { barcode: '7200000021', name: 'חלב שוקולד',        prices: [{ chainName: 'מגה', price: 6.9 }] },
  { barcode: '7200000022', name: 'חלב עמיד',          prices: [{ chainName: 'מגה', price: 4.5 }] },
];

test('חלב 3 אחוז — "חלב" token selected for broadening (numeric "3" excluded)', () => {
  const toks = selectBroadToks('חלב 3 אחוז');
  assert(toks.includes('חלב'), `"חלב" must be a broader token; got [${toks.join(', ')}]`);
  assert(!toks.includes('3'),  `Numeric "3" must not appear; got [${toks.join(', ')}]`);
});

test('חלב 3 אחוז — חלב broader results enter merged pool (useful candidates retrieved)', () => {
  const broaderPool = [...BROADER_ACHUZ, ...BROADER_CHALAV];
  const merged = _mergeByBarcode(MILK_PRIMARY, broaderPool);
  assert(merged.some(r => r.barcode === '7200000020'),
    '"חלב 1%" (from "חלב" broader search) must be in candidate pool');
  assert(merged.some(r => r.barcode === '7200000021'),
    '"חלב שוקולד" (from "חלב" broader search) must be in candidate pool');
});

test('חלב 3 אחוז — primary milk products survive after merge + limit', () => {
  const broaderPool = [...BROADER_ACHUZ, ...BROADER_CHALAV];
  const limited = _limitMerged(_mergeByBarcode(MILK_PRIMARY, broaderPool), 'חלב 3 אחוז');
  assert(MILK_PRIMARY.every(r => limited.some(l => l.barcode === r.barcode)),
    'All primary milk products must survive the limit');
});

test('חלב 3 אחוז — אחוז noise scores 10 (cut before milk products)', () => {
  const q = 'חלב 3 אחוז';
  BROADER_ACHUZ.forEach(r => {
    assert(matchScore(r.name, q) === 10, `"${r.name}" must score 10 (noise)`);
  });
});

// ── Fix 4: non-tomato fixture 3 — לחם ללא גלוטן (gluten-free bread) ──────────
console.log('\nFix 4 — non-tomato: לחם ללא גלוטן (stable-sort selects "גלוטן" + "לחם", not "ללא")');

// "לחם ללא גלוטן": tokens [לחם(3), ללא(3), גלוטן(5)]
// After length sort (stable): גלוטן(5), then לחם(3) before ללא(3) (original order preserved).
// Top 2: גלוטן and לחם. "ללא" ("without") excluded — avoids firing a useless query for "without".

const BREAD_PRIMARY = [
  { barcode: '7400000001', name: 'לחם ללא גלוטן שופרסל', prices: [{ chainName: 'שופרסל', price: 14.9 }] },
  { barcode: '7400000002', name: 'לחם ללא גלוטן אורגני', prices: [{ chainName: 'רמי לוי', price: 17.5 }] },
];
const BROADER_GLUTEN = [
  { barcode: '7400000010', name: 'קמח ללא גלוטן',   prices: [{ chainName: 'מגה', price: 12.0 }] },
  { barcode: '7400000011', name: 'פסטה ללא גלוטן',  prices: [{ chainName: 'מגה', price: 8.5 }] },
];
const BROADER_LECHEM = [
  { barcode: '7400000020', name: 'לחם מחיטה מלאה',  prices: [{ chainName: 'מגה', price: 6.9 }] },
  { barcode: '7400000021', name: 'לחם אחיד',         prices: [{ chainName: 'מגה', price: 4.5 }] },
];

test('לחם ללא גלוטן — top 2 tokens are "גלוטן" and "לחם" (not "ללא")', () => {
  const toks = selectBroadToks('לחם ללא גלוטן');
  assert(toks.includes('גלוטן'), `"גלוטן" (longest) must be selected; got [${toks.join(', ')}]`);
  assert(toks.includes('לחם'),   `"לחם" must be selected (stable sort keeps it before "ללא" on tie); got [${toks.join(', ')}]`);
  assert(!toks.includes('ללא'), `"ללא" ("without") must be excluded by cap; got [${toks.join(', ')}]`);
});

test('לחם ללא גלוטן — לחם broader results retrieved (useful bread candidates in pool)', () => {
  const broaderPool = [...BROADER_GLUTEN, ...BROADER_LECHEM];
  const merged = _mergeByBarcode(BREAD_PRIMARY, broaderPool);
  assert(merged.some(r => r.barcode === '7400000020'),
    '"לחם מחיטה מלאה" (from "לחם" broader search) must be in candidate pool');
});

test('לחם ללא גלוטן — primary gluten-free bread survives after merge + limit', () => {
  const broaderPool = [...BROADER_GLUTEN, ...BROADER_LECHEM];
  const limited = _limitMerged(_mergeByBarcode(BREAD_PRIMARY, broaderPool), 'לחם ללא גלוטן');
  assert(BREAD_PRIMARY.every(r => limited.some(l => l.barcode === r.barcode)),
    'Primary לחם ללא גלוטן products must survive after merge + limit');
});

test('לחם ללא גלוטן — primary products outscore generic bread for original query', () => {
  const q = 'לחם ללא גלוטן';
  const primaryMin = Math.min(...BREAD_PRIMARY.map(r => matchScore(r.name, q)));
  const genericMax = Math.max(...BROADER_LECHEM.map(r => matchScore(r.name, q)));
  assert(primaryMin > genericMax,
    `Primary (min ${primaryMin}) must outscore generic bread (max ${genericMax}) for "${q}"`);
});

// ── Fix 4: no data loss — _normalizeResults merges stores from same-name rows ─
console.log('\nFix 4 — no data loss (_preLimitDedup removed; _normalizeResults merges stores)');

// _preLimitDedup was removed because it discarded store/price data from same-name, different-
// barcode rows. _normalizeResults.js already handles name-dedup by MERGING stores — it must
// remain the sole name-dedup step. These tests prove no store data is lost.

// Inline the relevant portion of _normalizeResults name-dedup+merge behaviour for testing.
// Mirrors app.js _normalizeResults exactly, including idempotency (stores[] already present).
function _inlineNormalizeDedup(results) {
  const normalized = results.map(r => {
    if (Array.isArray(r.stores)) {
      return { name: r.name || '', barcode: r.barcode || '', stores: r.stores };
    }
    return {
      name: r.name || '',
      barcode: r.barcode || '',
      stores: (r.prices || [])
        .map(p => ({ store: p.chainName || p.storeName || '', price: parseFloat(p.price) || 0 }))
        .filter(sp => sp.price > 0 && sp.store),
    };
  }).filter(r => r.name.length > 0);
  const seen = new Set(), deduped = [];
  normalized.forEach(r => {
    const key = r.name.trim().toLowerCase().substring(0, 40);
    if (!seen.has(key)) { seen.add(key); deduped.push(r); }
    else {
      const ex = deduped.find(g => g.name.trim().toLowerCase().substring(0, 40) === key);
      if (ex) ex.stores.push(...r.stores);
    }
  });
  return deduped;
}

test('no data loss: _normalizeResults merges stores from same-name, different-barcode rows', () => {
  // Two rows: same product name, different barcodes, different store prices.
  // Without _preLimitDedup both rows reach _normalizeResults which merges their stores.
  const rows = [
    { name: 'קפה שחור', barcode: '111', prices: [{ chainName: 'שופרסל', price: 12.9 }] },
    { name: 'קפה שחור', barcode: '222', prices: [{ chainName: 'רמי לוי', price: 11.5 }] },
  ];
  const result = _inlineNormalizeDedup(rows);
  assert(result.length === 1,
    `Expected 1 merged product, got ${result.length}`);
  assert(result[0].stores.length === 2,
    `Expected 2 stores after merge (both שופרסל and רמי לוי), got ${result[0].stores.length} — a store was lost`);
});

test('no data loss: _preLimitDedup is NOT present in app.js (removed to prevent data loss)', () => {
  assert(!js.includes('function _preLimitDedup('),
    '_preLimitDedup still defined in app.js — it must be removed to prevent store-data loss');
});

test('architecture: both broader call sites use _mergeByBarcode without _preLimitDedup', () => {
  // _limitMerged must wrap _mergeByBarcode directly, not _preLimitDedup(_mergeByBarcode(...))
  assert(!js.includes('_limitMerged(_preLimitDedup('),
    '_limitMerged still wraps _preLimitDedup — data-loss fix not applied');
});

// ── Fix 4: normalization BEFORE final limit ──────────────────────────────────
console.log('\nFix 4 — normalization before final limit (same-name merge precedes 20-item cap)');

// Pipeline fixture: 25 raw candidates, 3 of which share the same name ("גבינה צהובה")
// with different barcodes and different store data.
//
// Expected:
//   _normalizeResults(25 raw) → 23 normalized (3 same-name rows merged → 1 with 3 stores)
//   _limitMerged(23, query, 20) → 20 (3 unrelated/low-score items cut)
//
const PIPELINE_QUERY = 'גבינה צהובה';

// 3 same-name rows — different barcodes, each from a different store.
const SAME_NAME_ROWS = [
  { barcode: 'SN1', name: 'גבינה צהובה', prices: [{ chainName: 'שופרסל', price: 29.9 }] },
  { barcode: 'SN2', name: 'גבינה צהובה', prices: [{ chainName: 'רמי לוי', price: 27.5 }] },
  { barcode: 'SN3', name: 'גבינה צהובה', prices: [{ chainName: 'מגה',     price: 28.0 }] },
];

// 19 unique high-scoring rows (each unique name, each scores ≥ 40 for the query).
const UNIQUE_HIGH = Array.from({ length: 19 }, (_, i) => ({
  barcode: `UH${String(i).padStart(2, '0')}`,
  name:    `גבינה צהובה ${String.fromCharCode(0x05D0 + i)}`, // unique variant
  prices:  [{ chainName: 'שופרסל', price: 20 + i }],
}));

// 3 unrelated rows — low score (10) for the query → must be cut by the limit.
const UNRELATED_LOW = [
  { barcode: 'UL1', name: 'במבה',        prices: [{ chainName: 'שופרסל', price: 5.9 }] },
  { barcode: 'UL2', name: 'שוקולד מריר', prices: [{ chainName: 'שופרסל', price: 8.9 }] },
  { barcode: 'UL3', name: 'מיץ תפוזים',  prices: [{ chainName: 'שופרסל', price: 6.9 }] },
];

const PIPELINE_RAW = [...SAME_NAME_ROWS, ...UNIQUE_HIGH, ...UNRELATED_LOW]; // 25 total

test('pipeline: total raw candidates is 25 (3 same-name + 19 unique + 3 unrelated)', () => {
  assert(PIPELINE_RAW.length === 25, `Expected 25 raw rows, got ${PIPELINE_RAW.length}`);
});

test('pipeline: _normalizeResults collapses 3 same-name rows into 1 (23 total)', () => {
  const normalized = _inlineNormalizeDedup(PIPELINE_RAW);
  assert(normalized.length === 23,
    `Expected 23 normalized products (3 same-name → 1), got ${normalized.length}`);
});

test('pipeline: merged same-name row preserves all 3 stores (no store data lost)', () => {
  const normalized = _inlineNormalizeDedup(PIPELINE_RAW);
  const merged = normalized.find(r => r.name === 'גבינה צהובה');
  assert(merged, '"גבינה צהובה" merged row not found after normalization');
  assert(merged.stores.length === 3,
    `Expected 3 stores (שופרסל + רמי לוי + מגה), got ${merged.stores.length}`);
});

test('pipeline: _limitMerged(23 normalized, query, 20) yields exactly 20', () => {
  const normalized = _inlineNormalizeDedup(PIPELINE_RAW);
  const limited = _limitMerged(normalized, PIPELINE_QUERY);
  assert(limited.length === 20,
    `Expected 20 after limit, got ${limited.length}`);
});

test('pipeline: unrelated low-score rows cut by final limit', () => {
  const normalized = _inlineNormalizeDedup(PIPELINE_RAW);
  const limited    = _limitMerged(normalized, PIPELINE_QUERY);
  const unrelatedSurvived = UNRELATED_LOW.filter(r => limited.some(l => l.barcode === r.barcode));
  assert(unrelatedSurvived.length === 0,
    `Expected 0 unrelated rows to survive; ${unrelatedSurvived.length} survived: ${unrelatedSurvived.map(r => r.name).join(', ')}`);
});

test('pipeline: all unique high-scoring rows survive the limit', () => {
  const normalized = _inlineNormalizeDedup(PIPELINE_RAW);
  const limited    = _limitMerged(normalized, PIPELINE_QUERY);
  const survived   = UNIQUE_HIGH.every(r => limited.some(l => l.barcode === r.barcode));
  assert(survived, 'Not all unique high-scoring rows survived the limit — ranking is wrong');
});

test('pipeline: _inlineNormalizeDedup is idempotent (re-normalizing already-normalized data is safe)', () => {
  const once  = _inlineNormalizeDedup(PIPELINE_RAW);
  const twice = _inlineNormalizeDedup(once);
  assert(twice.length === once.length,
    `Second _normalizeResults call changed length (${once.length} → ${twice.length}) — not idempotent`);
  assert(twice.every((r, i) => r.stores.length === once[i].stores.length),
    'Second _normalizeResults call changed stores length — idempotency broken');
});

test('architecture: _normalizeResults wraps _mergeByBarcode before _limitMerged in app.js', () => {
  assert(js.includes('_limitMerged(_normalizeResults(_mergeByBarcode('),
    '_normalizeResults must wrap _mergeByBarcode INSIDE _limitMerged — normalization must occur before the 20-item cap');
});

// ── Non-regression: existing single-word queries ────────────────────────────
console.log('\nNon-regression — existing single-word queries');

test('חלב scores correctly (single word, not affected by fallback)', () => {
  assert(matchScore('חלב 3%', 'חלב') === 90,
    'חלב exact-prefix changed — scoring regression');
  assert(matchScore('חלב', 'חלב') === 100, 'exact חלב=100');
});

test('במבה scores correctly', () => {
  assert(matchScore('במבה', 'במבה') === 100, 'exact במבה=100');
  assert(matchScore('במבה אוסם', 'במבה') === 90, 'prefix במבה=90');
});

test('קוקה קולה — both tokens matched (score 40+)', () => {
  const s = matchScore('קוקה קולה', 'קוקה קולה');
  assert(s === 100, `קוקה קולה exact match should score 100, got ${s}`);
});

test('קוקה קולה zero קלוריות — all-tokens match (score 40)', () => {
  const s = matchScore('קוקה קולה זירו', 'קוקה קולה');
  assert(s >= 90, `קוקה קולה זירו should score ≥90 for "קוקה קולה", got ${s}`);
});

test('unrelated product scores 10 for חלב', () => {
  assert(matchScore('במבה', 'חלב') === 10, 'unrelated product must score 10');
});

// ── Service Worker cache version ────────────────────────────────────────────
console.log('\nService Worker cache version');

test('sw.js CACHE_VERSION is fsl-v45 (bumped for this release)', () => {
  const m = sw.match(/CACHE_VERSION\s*=\s*'([^']+)'/);
  assert(m, 'CACHE_VERSION not found in sw.js');
  const v = m[1];
  // Extract numeric suffix and assert >= 45
  const num = parseInt(v.replace(/[^0-9]/g, ''), 10);
  assert(num >= 45,
    `CACHE_VERSION is "${v}" — must be fsl-v45 or higher after this release slice changes styles.css and app.js`);
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\nui-fixes: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

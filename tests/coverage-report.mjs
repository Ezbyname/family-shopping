// Local coverage + translation-audit script (no network needed)
import { CATALOG, SYNONYMS } from '../api/ingredients.js';
import { translateIngredient } from '../api/normalize-he.js';

// 30 harness queries + expected tokens (same as search-quality.mjs)
const TRUTH = [
  ['חלב',         ['חלב','milk']],
  ['אורז',        ['אורז','rice']],
  ['קוטג',        ['קוטג','cottage']],
  ['יוגורט',      ['יוגורט','yogurt','yoghurt']],
  ['קפה',         ['קפה','coffee']],
  ['פסטה',        ['פסטה','pasta']],
  ['טונה',        ['טונה','tuna']],
  ['ביצים',       ['ביצ','egg']],
  ['לחם',         ['לחם','bread']],
  ['חמאה',        ['חמאה','butter']],
  ['שמן זית',     ['שמן','olive','oil']],
  ['סוכר',        ['סוכר','sugar']],
  ['קמח',         ['קמח','flour']],
  ['שמפו',        ['שמפו','shampoo']],
  ['סבון',        ['סבון','soap']],
  ['שוקולד',      ['שוקולד','chocolate']],
  ['עגבניות',     ['עגבני','tomato']],
  ['גבינה',       ['גבינ','cheese']],
  ['עוף',         ['עוף','chicken']],
  ['בשר',         ['בשר','beef','meat']],
  ['תפוחים',      ['תפוח','apple']],
  ['בננות',       ['בנ','banana']],
  ['מיץ תפוזים',  ['מיץ','juice','orange']],
  ['שמנת',        ['שמנת','cream','sour']],
  ['דבש',         ['דבש','honey']],
  ['ריבה',        ['ריב','jam']],
  ['שמן',         ['שמן','oil']],
  ['מלח',         ['מלח','salt']],
  ['פלפל',        ['פלפל','pepper']],
  ['קטשופ',       ['קטשופ','ketchup']],
];

// Replicate the normalization pipeline's resolution paths for audit
const PLURAL_SUFFIXES = ['יות','יים','ות','ים','י','ת'];

function normalizeHe(s) {
  if (!s) return '';
  let t = String(s).trim();
  t = t.replace(/״/g,'').replace(/"/g,'').replace(/"/g,'');
  return t.replace(/\s+/g,' ').trim();
}

function classifyResolution(raw) {
  const n = normalizeHe(raw);

  if (CATALOG.has(n)) return { en: CATALOG.get(n), path: 'exact' };

  const synKey = SYNONYMS.get(n);
  if (synKey && CATALOG.has(synKey)) return { en: CATALOG.get(synKey), path: 'synonym', via: synKey };

  let best = null, bestLen = 0;
  for (const [key, en] of CATALOG) {
    if (n.includes(key) && key.length > bestLen) { best = en; bestLen = key.length; }
  }
  if (best) return { en: best, path: 'phrase' };

  for (const word of n.split(' ')) {
    if (word.length < 3) continue;
    for (const sfx of PLURAL_SUFFIXES) {
      if (word.length > sfx.length + 2 && word.endsWith(sfx)) {
        const stem = word.slice(0, -sfx.length);
        if (CATALOG.has(stem)) return { en: CATALOG.get(stem), path: 'plural', stem };
      }
    }
  }

  return { en: null, path: 'unmapped' };
}

const pathCounts = { exact:0, synonym:0, phrase:0, plural:0, unmapped:0 };
const rows = [];

for (const [q, tokens] of TRUTH) {
  const r = classifyResolution(q);
  pathCounts[r.path]++;

  // Also call the real translateIngredient to confirm pipeline agrees
  const realEn = translateIngredient(q);

  // Token hit: does the english term contain any expected token?
  const en = (r.en || '').toLowerCase();
  // Note: some tokens are Hebrew fragments (ביצ, עגבני) — those won't match English
  const enHit  = tokens.some(t => /[a-z]/.test(t) && en.includes(t.toLowerCase()));
  // If token list has no English tokens, still flag as 'needs live check'
  const hasEnTokens = tokens.some(t => /[a-z]/.test(t));

  rows.push({
    q, en: r.en, realEn, path: r.path, tokens,
    enHit: hasEnTokens ? enHit : null,
    extra: r.via || r.stem || '',
  });
}

// ─── Coverage Report ──────────────────────────────────────────────────────────
const W = 65;
const bar = '═'.repeat(W);
const sep = '─'.repeat(W);

console.log('\n' + bar);
console.log('INGREDIENT CATALOG — COVERAGE REPORT');
console.log(bar);
console.log(`Canonical entries : ${CATALOG.size}`);
console.log(`Synonym entries   : ${SYNONYMS.size}`);
console.log(`Total mapped terms: ${CATALOG.size + SYNONYMS.size}`);
console.log('');
console.log('Resolution paths across 30 harness queries:');
const total = TRUTH.length;
for (const [path, count] of Object.entries(pathCounts)) {
  const pct  = (count / total * 100).toFixed(0).padStart(3);
  const bar2 = '█'.repeat(count);
  console.log(`  ${path.padEnd(10)} ${String(count).padStart(2)}/${total}  (${pct}%)  ${bar2}`);
}

// ─── Per-query Translation Audit ─────────────────────────────────────────────
console.log('\n' + bar);
console.log('PER-QUERY TRANSLATION AUDIT  (local, no OFF network call)');
console.log(bar);
console.log('St  Query              Path       English translation');
console.log(sep);

const unmapped = [];
for (const row of rows) {
  const st = row.en === null ? '✗' : row.enHit === false ? '~' : '✓';
  if (!row.en) unmapped.push(row.q);
  const note = row.extra ? ` [via: ${row.extra}]` : '';
  const flag = row.realEn !== row.en ? ` ⚠ pipeline=${row.realEn}` : '';
  console.log(`${st}   ${row.q.padEnd(17)} ${row.path.padEnd(10)} ${row.en || '(none)'}${note}${flag}`);
}

// ─── Unmapped Queries ─────────────────────────────────────────────────────────
console.log('\n' + bar);
console.log('UNMAPPED QUERIES  (translate returns null → raw Hebrew sent to OFF)');
console.log(bar);
if (unmapped.length === 0) {
  console.log('  ✓ All 30 queries resolve to an English term.');
} else {
  for (const q of unmapped) {
    console.log(`  ✗ "${q}"  — root cause: see per-query table above`);
  }
}

// ─── Failure Classification ───────────────────────────────────────────────────
const enMisses = rows.filter(r => r.enHit === false);
console.log('\n' + bar);
console.log('TRANSLATION MISMATCHES  (EN term doesn\'t contain expected English token)');
console.log(bar);
if (enMisses.length === 0) {
  console.log('  ✓ None — every resolved EN translation contains at least one expected English token.');
} else {
  console.log('  Query              EN result          Expected tokens');
  console.log(sep);
  for (const r of enMisses) {
    console.log(`  ${r.q.padEnd(17)} ${(r.en||'').padEnd(20)} [${r.tokens.filter(t=>/[a-z]/.test(t)).join(', ')}]`);
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const resolved    = rows.filter(r => r.en !== null).length;
const enHitCount  = rows.filter(r => r.enHit === true).length;
const enNaCount   = rows.filter(r => r.enHit === null).length;  // Hebrew-only tokens

console.log('\n' + bar);
console.log('SUMMARY');
console.log(bar);
console.log(`Queries with English translation : ${resolved}/${total}`);
console.log(`EN translation token match       : ${enHitCount}/${total - enNaCount} (excl. Hebrew-only token queries)`);
console.log(`Unmapped (fallback to raw Hebrew): ${unmapped.length}/${total}`);
console.log('');
console.log('Live Precision@3 must be measured from your Windows machine:');
console.log('  $env:BASE="https://<vercel-preview-url>"');
console.log('  $env:VERCEL_BYPASS="82TYgnhQCp0GjOnKrBDHae1FAP7wU8Yn"');
console.log('  node tests/search-quality.mjs');
console.log(bar + '\n');

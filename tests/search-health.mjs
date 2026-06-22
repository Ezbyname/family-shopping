/**
 * tests/search-health.mjs — Phase 3: Search Health Dashboard
 *
 * Runnable locally and in CI. Combines:
 *   - Catalog metrics (no network needed)
 *   - Live Precision@3 + @5 from deployed preview (needs BASE env var)
 *   - Telemetry summary (optional, reads reports/telemetry-*.json if present)
 *
 * Usage:
 *   # Catalog-only (no network):
 *   node tests/search-health.mjs
 *
 *   # Full live run:
 *   BASE=https://your-preview.vercel.app \
 *   VERCEL_BYPASS=82TYgnhQCp0GjOnKrBDHae1FAP7wU8Yn \
 *   node tests/search-health.mjs
 *
 *   # CI mode (exits 1 if P@3 < threshold):
 *   P3_THRESHOLD=90 node tests/search-health.mjs
 *
 * Exit codes:
 *   0 = healthy (all thresholds met, or no live run)
 *   1 = unhealthy (P@3 below threshold)
 *   2 = error
 */

import { CATALOG, SYNONYMS } from '../api/ingredients.js';
import { translateIngredient } from '../api/normalize-he.js';
import { readFileSync, readdirSync } from 'fs';

const BASE          = process.env.BASE || '';
const BYPASS        = process.env.VERCEL_BYPASS || '';
const P3_THRESHOLD  = parseInt(process.env.P3_THRESHOLD || '90', 10);
const K3 = 3, K5 = 5;

// 30-query truth set (same as search-quality.mjs)
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

function hitsAtK(results, tokens, k) {
  const top = results.slice(0, k);
  return top.some(r => {
    const hay = ((r.name || '') + ' ' + (r.brand || '')).toLowerCase();
    return tokens.some(t => hay.includes(t.toLowerCase()));
  });
}

// ── Section 1: Catalog Metrics (always, no network) ───────────────────────────
const W = 68;
const BAR = '═'.repeat(W);
const SEP = '─'.repeat(W);

console.log('\n' + BAR);
console.log('SEARCH HEALTH DASHBOARD');
console.log(`Generated: ${new Date().toISOString()}`);
console.log(BAR);

console.log('\n── CATALOG METRICS ──────────────────────────────────────────');
console.log(`Canonical ingredients : ${CATALOG.size}`);
console.log(`Synonym entries       : ${SYNONYMS.size}`);
console.log(`Total mapped terms    : ${CATALOG.size + SYNONYMS.size}`);

// Translation coverage across truth set
let translationHits = 0, unmappedQueries = [];
for (const [q] of TRUTH) {
  const en = translateIngredient(q);
  if (en) translationHits++;
  else unmappedQueries.push(q);
}
console.log(`Truth-set translation : ${translationHits}/${TRUTH.length} (${(translationHits/TRUTH.length*100).toFixed(0)}%)`);
if (unmappedQueries.length) {
  console.log(`Untranslated queries  : ${unmappedQueries.join(', ')}`);
}

// ── Section 2: Telemetry Summary (from saved reports if present) ──────────────
console.log('\n── TELEMETRY SUMMARY ────────────────────────────────────────');
let latestReport = null;
try {
  const files = readdirSync('reports').filter(f => f.startsWith('telemetry-') && f.endsWith('.json')).sort();
  if (files.length > 0) {
    latestReport = JSON.parse(readFileSync(`reports/${files.at(-1)}`, 'utf8'));
    const s = latestReport.summary;
    const unmappedRate = s.parsedEvents > 0
      ? (s.uniqueUnmapped / s.parsedEvents * 100).toFixed(1) : 'n/a';
    const zeroRate = s.parsedEvents > 0
      ? (s.uniqueZeroResult / s.parsedEvents * 100).toFixed(1) : 'n/a';
    console.log(`Report date           : ${latestReport.generatedAt.slice(0,10)}`);
    console.log(`Events analyzed       : ${s.parsedEvents}`);
    console.log(`Unique unmapped       : ${s.uniqueUnmapped}  (rate: ${unmappedRate}%)`);
    console.log(`Unique zero-result    : ${s.uniqueZeroResult}  (rate: ${zeroRate}%)`);
    if (latestReport.topUnmapped?.length) {
      console.log(`Top unmapped          : ${latestReport.topUnmapped.slice(0,5).map(r=>`"${r.query}"(${r.count}×)`).join(', ')}`);
    }
    if (latestReport.topZeroResult?.length) {
      console.log(`Top zero-result       : ${latestReport.topZeroResult.slice(0,5).map(r=>`"${r.query}"(${r.count}×)`).join(', ')}`);
    }
  } else {
    console.log('No telemetry reports found in reports/');
    console.log('Run: vercel logs --json | node tests/telemetry-aggregator.mjs');
    console.log('Then: WRITE_REPORT=1 node tests/telemetry-aggregator.mjs < logs.jsonl');
  }
} catch (_) {
  console.log('reports/ directory not found — no telemetry data yet.');
}

// ── Section 3: Live Precision@3 + @5 (needs BASE) ────────────────────────────
console.log('\n── LIVE SEARCH QUALITY ──────────────────────────────────────');

if (!BASE) {
  console.log('Skipped (no BASE env var set).');
  console.log('Run with:');
  console.log('  BASE=https://<preview>.vercel.app \\');
  console.log('  VERCEL_BYPASS=82TYgnhQCp0GjOnKrBDHae1FAP7wU8Yn \\');
  console.log('  node tests/search-health.mjs');
  console.log('\n' + BAR + '\n');
  process.exit(0);
}

console.log(`Base URL: ${BASE}`);

const headers = BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {};
const failures = [];
let p3hits = 0, p5hits = 0, errors = 0;

console.log(`\n${'Query'.padEnd(20)} ${'P@3'.padEnd(6)} ${'P@5'.padEnd(6)} Top-3 names`);
console.log(SEP);

const BASELINE_FAILURES = new Set(['קפה','בננות','מיץ תפוזים','ריבה','מלח']); // v6.2 baseline

for (const [query, tokens] of TRUTH) {
  try {
    const url = `${BASE}/api/prices?q=${encodeURIComponent(query)}&debugScore=1`;
    const r   = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const results = data.results || [];

    const hit3 = hitsAtK(results, tokens, K3);
    const hit5 = hitsAtK(results, tokens, K5);
    if (hit3) p3hits++;
    if (hit5) p5hits++;

    const top3names = results.slice(0,3).map(r => r.name || '?').join(' | ');
    const mark3 = hit3 ? '✓' : '✗';
    const mark5 = hit5 ? '✓' : '✗';
    console.log(`${mark3} ${query.padEnd(19)} ${mark3.padEnd(5)}  ${mark5.padEnd(5)}  ${top3names}`);

    if (!hit3) {
      const wasBaseline = BASELINE_FAILURES.has(query);
      failures.push({
        query,
        tokens,
        top3: results.slice(0,3).map(r => ({ name: r.name, score: r._score })),
        regression: !wasBaseline,
        en: translateIngredient(query),
      });
    }
  } catch (e) {
    errors++;
    console.log(`✗ ${query.padEnd(19)} ERROR  ERROR  ${e.message}`);
    failures.push({ query, tokens, error: e.message, regression: !BASELINE_FAILURES.has(query) });
  }
}

const p3pct = (p3hits / TRUTH.length * 100).toFixed(1);
const p5pct = (p5hits / TRUTH.length * 100).toFixed(1);

console.log(SEP);
console.log(`\nPrecision@3 : ${p3hits}/${TRUTH.length} = ${p3pct}%`);
console.log(`Precision@5 : ${p5hits}/${TRUTH.length} = ${p5pct}%`);

// ── Failure Analysis ──────────────────────────────────────────────────────────
if (failures.length > 0) {
  const regressions = failures.filter(f => f.regression);
  console.log(`\nFailures    : ${failures.length}  (regressions: ${regressions.length})`);
  console.log('\n── FAILURE ANALYSIS ─────────────────────────────────────────');

  for (const f of failures) {
    const en = f.en || '(unmapped)';
    // Classify root cause
    let cause;
    if (f.error) {
      cause = 'network/api error';
    } else if (!f.en) {
      cause = 'CATALOG GAP — translateIngredient returned null';
    } else if (!f.top3 || f.top3.length === 0) {
      cause = 'RETRIEVAL ISSUE — OFF returned 0 products for: ' + en;
    } else {
      const allScoresLow = f.top3.every(p => (p.score ?? 0) < 50);
      cause = allScoresLow
        ? 'RANKING ISSUE — products present but scored too low'
        : 'DATA-SOURCE GAP — products retrieved but wrong category';
    }
    const reg = f.regression ? ' ⚠ REGRESSION' : '';
    console.log(`\n  Query  : "${f.query}" → EN: "${en}"${reg}`);
    console.log(`  Cause  : ${cause}`);
    if (f.top3?.length) {
      console.log(`  Top-3  : ${f.top3.map(p => `"${p.name}"(${p.score})`).join(' | ')}`);
    }
  }

  if (regressions.length > 0) {
    console.log(`\n⚠  ${regressions.length} REGRESSION(S) — queries that passed the 83.3% baseline now fail:`);
    for (const r of regressions) console.log(`   • "${r.query}"`);
  }
}

// ── Final Status ──────────────────────────────────────────────────────────────
const regressionCount = failures.filter(f => f.regression).length;
console.log('\n' + BAR);
console.log('STATUS');
console.log(BAR);
const p3ok  = parseFloat(p3pct) >= P3_THRESHOLD;
const regOk = regressionCount === 0;
console.log(`Precision@3 >= ${P3_THRESHOLD}%  : ${p3ok  ? '✓ PASS' : '✗ FAIL'}  (${p3pct}%)`);
console.log(`No regressions        : ${regOk  ? '✓ PASS' : '✗ FAIL'}  (${regressionCount} regression(s))`);
const healthy = p3ok && regOk;
console.log(`\nOverall: ${healthy ? '✓ HEALTHY' : '✗ UNHEALTHY'}`);
console.log(BAR + '\n');

process.exit(healthy ? 0 : 1);

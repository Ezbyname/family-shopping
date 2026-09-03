/**
 * tests/telemetry-aggregator.mjs — Phase 2
 *
 * Aggregates unmapped_query and zero_results events from Vercel function logs.
 *
 * Input:
 *   Pipe JSON-per-line Vercel logs:
 *     vercel logs --json | node tests/telemetry-aggregator.mjs
 *
 *   Or read a saved log file:
 *     node tests/telemetry-aggregator.mjs < logs/2026-06-22.jsonl
 *
 *   Or provide raw text logs (non-JSON lines are skipped):
 *     node tests/telemetry-aggregator.mjs < logs/raw.txt
 *
 * The script picks out lines containing our structured telemetry events:
 *   {"event":"unmapped_query","query":"...","ts":"..."}
 *   {"event":"zero_results","query":"...","englishQuery":"...","translated":true,"ts":"..."}
 *
 * Output:
 *   REPORT — printed to stdout
 *   reports/telemetry-<date>.json  — machine-readable summary (optional, set WRITE_REPORT=1)
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const TOP_N = 20;

// ── Read stdin or file arg ─────────────────────────────────────────────────────
const source = process.argv[2]
  ? createReadStream(process.argv[2])
  : process.stdin;

const rl = createInterface({ input: source, crlfDelay: Infinity });

// ── Accumulators ───────────────────────────────────────────────────────────────
const unmapped   = new Map(); // query → { count, lastSeen }
const zeroResult = new Map(); // query → { count, lastSeen, translated }
const translations = new Map(); // englishQuery → { count, lastSeen } (zero-result translated queries)

let totalLines = 0, parsedEvents = 0;

for await (const line of rl) {
  totalLines++;
  if (!line.trim()) continue;

  // Try to extract the JSON payload from the line.
  // Vercel logs may wrap it: {"message":"{\"event\":\"...\"}","..."}
  // or emit it directly as: {"event":"..."}
  let payload = null;

  // 1. Try direct parse
  try { payload = JSON.parse(line); } catch (_) {}

  // 2. Try extracting nested JSON from a "message" field
  if (!payload?.event && payload?.message) {
    try { payload = JSON.parse(payload.message); } catch (_) {}
  }

  // 3. Try extracting embedded JSON with regex (raw text logs)
  if (!payload?.event) {
    const m = line.match(/(\{[^{}]*"event"\s*:[^{}]*\})/);
    if (m) try { payload = JSON.parse(m[1]); } catch (_) {}
  }

  if (!payload?.event) continue;
  parsedEvents++;

  const q  = (payload.query || '').trim();
  const ts = payload.ts || new Date().toISOString();

  if (payload.event === 'unmapped_query' && q) {
    const cur = unmapped.get(q) ?? { count: 0, lastSeen: ts };
    cur.count++;
    if (ts > cur.lastSeen) cur.lastSeen = ts;
    unmapped.set(q, cur);
  }

  if (payload.event === 'zero_results' && q) {
    const cur = zeroResult.get(q) ?? { count: 0, lastSeen: ts, translated: false };
    cur.count++;
    if (ts > cur.lastSeen) cur.lastSeen = ts;
    if (payload.translated) cur.translated = true;
    zeroResult.set(q, cur);

    const en = (payload.englishQuery || '').trim();
    if (en && en !== q) {
      const curEn = translations.get(en) ?? { count: 0, lastSeen: ts, sourceQuery: q };
      curEn.count++;
      if (ts > curEn.lastSeen) curEn.lastSeen = ts;
      translations.set(en, curEn);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function topN(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, n)
    .map(([query, v]) => ({ query, ...v }));
}

const W = 65;
const bar = '═'.repeat(W);

// ── Report ─────────────────────────────────────────────────────────────────────
console.log('\n' + bar);
console.log('TELEMETRY AGGREGATION REPORT');
console.log(bar);
console.log(`Lines processed : ${totalLines}`);
console.log(`Events parsed   : ${parsedEvents}`);
console.log(`Unmapped queries: ${unmapped.size} unique`);
console.log(`Zero-result     : ${zeroResult.size} unique`);
console.log('');

function printSection(title, rows) {
  console.log('─'.repeat(W));
  console.log(title);
  console.log('─'.repeat(W));
  if (rows.length === 0) {
    console.log('  (no data)');
    return;
  }
  for (const r of rows) {
    const q = r.query.length > 35 ? r.query.slice(0, 32) + '…' : r.query;
    console.log(`  ${String(r.count).padStart(5)}×  ${q.padEnd(36)}  ${r.lastSeen}`);
  }
  console.log('');
}

printSection(`TOP ${TOP_N} UNMAPPED QUERIES  (translate() returned null → raw Hebrew sent to OFF)`,
  topN(unmapped, TOP_N));

printSection(`TOP ${TOP_N} ZERO-RESULT QUERIES  (OFF returned 0 products after translation)`,
  topN(zeroResult, TOP_N));

const translatedZeroResults = topN(zeroResult, TOP_N).filter(r => r.translated);
printSection(`TOP ${TOP_N} TRANSLATED BUT ZERO-RESULT  (translation OK, retrieval failed)`,
  translatedZeroResults);

printSection(`TOP ${TOP_N} FAILED ENGLISH TRANSLATIONS  (EN terms that produced 0 results)`,
  topN(translations, TOP_N));

console.log(bar);
console.log('BACKLOG CLASSIFICATION');
console.log(bar);
console.log('Unmapped queries → likely CATALOG GAP: add to ingredients.js with evidence');
console.log('Translated but 0 results → RETRIEVAL ISSUE: OFF has no Israeli product for this term');
console.log('Repeated zero-results (>5×) → HIGH PRIORITY: worth manual investigation');
console.log('');
const highPri = [...zeroResult.entries()].filter(([,v]) => v.count > 5);
if (highPri.length > 0) {
  console.log(`HIGH PRIORITY (>5 occurrences):`);
  for (const [q, v] of highPri.sort((a,b) => b[1].count - a[1].count)) {
    console.log(`  ${v.count}× "${q}" (translated=${v.translated})`);
  }
} else {
  console.log('No high-priority failures yet (none exceeds 5 occurrences).');
}
console.log(bar + '\n');

// ── Machine-readable output ────────────────────────────────────────────────────
if (process.env.WRITE_REPORT) {
  const { writeFileSync, mkdirSync } = await import('fs');
  const date = new Date().toISOString().slice(0, 10);
  const out = {
    generatedAt: new Date().toISOString(),
    summary: { totalLines, parsedEvents, uniqueUnmapped: unmapped.size, uniqueZeroResult: zeroResult.size },
    topUnmapped:          topN(unmapped, TOP_N),
    topZeroResult:        topN(zeroResult, TOP_N),
    topFailedTranslation: topN(translations, TOP_N),
  };
  mkdirSync('reports', { recursive: true });
  const path = `reports/telemetry-${date}.json`;
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`Report written to ${path}`);
}

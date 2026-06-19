/**
 * Search Quality Harness — measures Precision@3 for Hebrew grocery queries.
 * Usage:
 *   node tests/search-quality.mjs                        # vs localhost:3000
 *   BASE=https://your-deploy.vercel.app node tests/search-quality.mjs
 *   WRITE_BASELINE=1 node tests/search-quality.mjs       # save current scores as baseline
 */

const BASE = process.env.BASE || 'http://localhost:3000';

// Truth queries: [hebrewQuery, [...expectedTokens in top-3 names (ANY match = hit)]]
// A result "hits" if its name contains at least one expected token (case-insensitive, Hebrew-aware).
const TRUTH = [
  ['חלב',       ['חלב', 'milk']],
  ['אורז',      ['אורז', 'rice']],
  ['קוטג',      ['קוטג', 'cottage']],
  ['יוגורט',    ['יוגורט', 'yogurt', 'yoghurt']],
  ['קפה',       ['קפה', 'coffee']],
  ['פסטה',      ['פסטה', 'pasta']],
  ['טונה',      ['טונה', 'tuna']],
  ['ביצים',     ['ביצ', 'egg']],
  ['לחם',       ['לחם', 'bread']],
  ['חמאה',      ['חמאה', 'butter']],
  ['שמן זית',   ['שמן', 'olive', 'oil']],
  ['סוכר',      ['סוכר', 'sugar']],
  ['קמח',       ['קמח', 'flour']],
  ['שמפו',      ['שמפו', 'shampoo']],
  ['סבון',      ['סבון', 'soap']],
  ['שוקולד',    ['שוקולד', 'chocolate']],
  ['עגבניות',   ['עגבני', 'tomato']],
  ['גבינה',     ['גבינ', 'cheese']],
  ['עוף',       ['עוף', 'chicken']],
  ['בשר',       ['בשר', 'beef', 'meat']],
  ['תפוחים',    ['תפוח', 'apple']],
  ['בננות',     ['בנ', 'banana']],
  ['מיץ תפוזים',['מיץ', 'juice', 'orange']],
  ['שמנת',      ['שמנת', 'cream', 'sour']],
  ['דבש',       ['דבש', 'honey']],
  ['ריבה',      ['ריב', 'jam']],
  ['שמן',       ['שמן', 'oil']],
  ['מלח',       ['מלח', 'salt']],
  ['פלפל',      ['פלפל', 'pepper']],
  ['קטשופ',     ['קטשופ', 'ketchup']],
];

const K = 3; // Precision@K

function hits(results, tokens) {
  const top = results.slice(0, K);
  return top.filter(r => {
    const hay = ((r.name || '') + ' ' + (r.brand || '')).toLowerCase();
    return tokens.some(t => hay.includes(t.toLowerCase()));
  }).length;
}

async function runQuery(q) {
  const url = `${BASE}/api/prices?q=${encodeURIComponent(q)}&debugScore=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${q}"`);
  return res.json();
}

async function main() {
  console.log(`\nSearch Quality Harness — Precision@${K}`);
  console.log(`Base: ${BASE}\n`);
  console.log('Query'.padEnd(20), 'P@3'.padEnd(8), 'Top-3 names');
  console.log('─'.repeat(80));

  let totalHits = 0;
  const results = [];

  for (const [query, tokens] of TRUTH) {
    try {
      const data = await runQuery(query);
      const top3 = (data.results || []).slice(0, K);
      const h = hits(data.results || [], tokens);
      totalHits += h > 0 ? 1 : 0;
      const names = top3.map(r => `${r.name || '?'} (${r._score ?? '?'})`).join(' | ');
      const mark = h > 0 ? '✓' : '✗';
      console.log(`${mark} ${query.padEnd(18)} ${String(h+'/'+K).padEnd(8)} ${names}`);
      results.push({ query, tokens, hit: h > 0, top3 });
    } catch (e) {
      console.log(`✗ ${query.padEnd(18)} ERROR   ${e.message}`);
      results.push({ query, tokens, hit: false, error: e.message });
    }
  }

  const p = (totalHits / TRUTH.length * 100).toFixed(1);
  console.log('─'.repeat(80));
  console.log(`\nOverall Precision@${K}: ${totalHits}/${TRUTH.length} = ${p}%\n`);

  if (process.env.WRITE_BASELINE) {
    const { writeFileSync } = await import('fs');
    writeFileSync(
      new URL('./search-quality-baseline.json', import.meta.url),
      JSON.stringify({ precision: parseFloat(p), totalHits, total: TRUTH.length, results }, null, 2)
    );
    console.log('Baseline written to tests/search-quality-baseline.json');
  }
}

main().catch(e => { console.error(e); process.exit(1); });

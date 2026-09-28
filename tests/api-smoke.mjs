import { execFileSync } from 'node:child_process';
import {
  bpConsumeBatches,
} from '../js/bp-search.js';
import {
  bpSelectStrictCandidates,
} from '../js/bp-strict.js';
import {
  bpTranslate,
} from '../js/bp-translation.js';

const arg = process.argv.find(a => a.startsWith('--base-url='));
if (!arg) {
  console.error('Usage: npm run test:api-smoke -- --base-url=https://...');
  process.exit(2);
}

const baseUrl = arg.slice('--base-url='.length).replace(/\/+$/, '');

const cases = [
  {
    query: 'עגבניות שרי',
    expectedTranslation: 'cherry tomatoes',
    strict: true,
    relevant: text =>
      (text.includes('cherry') && text.includes('tomat')) ||
      (text.includes('שרי') && text.includes('עגבנ')),
  },
  {
    query: 'שרי עגבניות',
    expectedTranslation: 'cherry tomatoes',
    strict: true,
    relevant: text =>
      (text.includes('cherry') && text.includes('tomat')) ||
      (text.includes('שרי') && text.includes('עגבנ')),
  },
  {
    query: 'חלב 3 אחוז',
    expectedTranslation: 'milk 3%',
    strict: true,
    relevant: text =>
      (text.includes('milk') || text.includes('חלב')) &&
      text.includes('3'),
  },
  {
    query: 'קפה שחור',
    expectedTranslation: 'black coffee',
    strict: true,
    relevant: text =>
      (text.includes('black') && text.includes('coffee')) ||
      (text.includes('קפה') && text.includes('שחור')),
  },
  {
    query: 'לחם ללא גלוטן',
    expectedTranslation: 'gluten free bread',
    strict: true,
    relevant: text =>
      (text.includes('gluten') && text.includes('bread')) ||
      (text.includes('לחם') && text.includes('גלוטן')),
  },
  {
    query: 'חלב',
    expectedTranslation: 'milk',
    strict: false,
    relevant: text =>
      text.includes('milk') || text.includes('חלב'),
  },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function productText(p) {
  return [
    p?.name,
    p?.nameHe,
    p?.nameEn,
    p?.productName,
    p?.product_name,
    p?.displayName,
    p?.brand,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function vercelCurl(url) {
  const out = execFileSync(
    'npx',
    ['vercel', 'curl', url],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45000,
    }
  );

  return JSON.parse(out.trim());
}

async function fetchWithRetry(url, accept, label) {
  let last = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      last = vercelCurl(url);
      lastError = null;

      if (accept(last)) {
        if (attempt > 1) {
          console.log(`    recovered on attempt ${attempt}: ${label}`);
        }
        return last;
      }
    } catch (e) {
      lastError = e;
    }

    if (attempt < 5) await sleep(2000);
  }

  if (lastError) {
    throw new Error(`${label}: request failed: ${lastError.message}`);
  }

  return last;
}

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

console.log(`\nAPI smoke target: ${baseUrl}`);

for (const tc of cases) {
  console.log(`\n── ${tc.query} ──`);

  try {
    const translated = bpTranslate(tc.query);

    assert(
      translated === tc.expectedTranslation,
      `local picker translation mismatch: expected ${JSON.stringify(tc.expectedTranslation)}, got ${JSON.stringify(translated)}`
    );

    console.log(`  ✓ picker translation: ${translated}`);

    const pickerUrl =
      `${baseUrl}/api/openfoodfacts-search` +
      `?q=${encodeURIComponent(tc.query)}` +
      `&translatedQ=${encodeURIComponent(translated)}` +
      `&pageSize=40`;

    const picker = await fetchWithRetry(
      pickerUrl,
      data => data?.status === 'ok',
      `picker ${tc.query}`
    );

    assert(
      picker?.status === 'ok',
      `picker API status=${JSON.stringify(picker?.status)}`
    );

    assert(
      Array.isArray(picker.batches),
      'picker API schema: batches must be an array'
    );

    const raw = [];
    bpConsumeBatches(picker.batches, new Set(), raw, 'he');

    assert(raw.length > 0, 'picker returned zero usable corpus products');

    const strict = bpSelectStrictCandidates(raw, {
      queryLang: 'he',
      normQ: tc.query,
      enQuery: translated,
    });

    if (tc.strict) {
      assert(strict.used === true, 'expected strict mode to be used');
      assert(
        strict.candidates.length > 0,
        'strict candidate set is empty'
      );

      const relevant = strict.candidates.filter(p =>
        tc.relevant(productText(p))
      );

      assert(
        relevant.length > 0,
        `strict candidates exist but none are relevant: ${strict.candidates
          .slice(0, 5)
          .map(p => productText(p))
          .join(' | ')}`
      );

      console.log(
        `  ✓ picker strict: mode=${strict.mode}, candidates=${strict.candidates.length}`
      );
      console.log(
        `  ✓ picker representative: ${productText(relevant[0])}`
      );
    } else {
      assert(
        strict.used === false,
        'single-word query unexpectedly activated strict mode'
      );

      const relevant = raw.filter(p => tc.relevant(productText(p)));

      assert(
        relevant.length > 0,
        'single-word picker corpus has no relevant representative product'
      );

      console.log(`  ✓ picker single-word path: strict=false`);
      console.log(
        `  ✓ picker representative: ${productText(relevant[0])}`
      );
    }

    const mainUrl =
      `${baseUrl}/api/prices?q=${encodeURIComponent(tc.query)}`;

    const main = await fetchWithRetry(
      mainUrl,
      data => Array.isArray(data?.results) && data.results.length > 0,
      `main search ${tc.query}`
    );

    assert(
      main?.englishQuery === tc.expectedTranslation,
      `main translation mismatch: expected ${JSON.stringify(tc.expectedTranslation)}, got ${JSON.stringify(main?.englishQuery)}`
    );

    assert(
      Array.isArray(main?.results),
      'main API schema: results must be an array'
    );

    assert(
      main.results.length > 0,
      'main search returned zero results for known query'
    );

    const relevantMain = main.results.filter(p =>
      tc.relevant(productText(p))
    );

    assert(
      relevantMain.length > 0,
      `main search returned products but none are relevant: ${main.results
        .slice(0, 5)
        .map(p => productText(p))
        .join(' | ')}`
    );

    console.log(
      `  ✓ main search: results=${main.results.length}, translation=${main.englishQuery}`
    );
    console.log(
      `  ✓ main representative: ${productText(relevantMain[0])}`
    );

    console.log(`  PASS ${tc.query}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL ${tc.query}: ${e.message}`);
    failed++;
  }
}

console.log(`\nAPI smoke: ${passed}/${cases.length} passed`);

if (failed) {
  console.error(`API smoke FAILED: ${failed} release-gate case(s) failed`);
  process.exitCode = 1;
} else {
  console.log('API smoke PASSED');
}

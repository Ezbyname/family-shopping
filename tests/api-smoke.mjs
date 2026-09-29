import { execFileSync } from 'node:child_process';
import {
  bpConsumeBatches,
  bpSelectName,
} from '../js/bp-search.js';
import {
  bpSelectStrictCandidates,
} from '../js/bp-strict.js';
import {
  bpTranslate,
} from '../js/bp-translation.js';

const arg = process.argv.find(a => a.startsWith('--base-url='));
if (!arg) {
  console.error(
    'Usage: npm run test:api-smoke -- --base-url=https://... [--pack=A|B|C|all]'
  );
  process.exit(2);
}

const baseUrl = arg
  .slice('--base-url='.length)
  .replace(/\/+$/, '');

const packArg = process.argv.find(a => a.startsWith('--pack='));
const selectedPack = (
  packArg
    ? packArg.slice('--pack='.length)
    : 'A'
).toUpperCase();

if (!['A', 'B', 'C', 'ALL'].includes(selectedPack)) {
  console.error(
    `Invalid --pack=${JSON.stringify(selectedPack)}. Expected A, B, C, or all.`
  );
  process.exit(2);
}

const CORE_CASES = [
  {
    group: 'CORE',
    category: 'coffee',
    query: 'קפה שחור',
    expectedTranslation: 'black coffee',
    strict: true,
    relevant: text =>
      (text.includes('black') && text.includes('coffee')) ||
      (text.includes('קפה') && text.includes('שחור')),
  },
  {
    group: 'CORE',
    category: 'special-diet',
    query: 'לחם ללא גלוטן',
    expectedTranslation: 'gluten free bread',
    strict: true,
    relevant: text =>
      (text.includes('gluten') && text.includes('bread')) ||
      (text.includes('לחם') && text.includes('גלוטן')),
  },
  {
    group: 'CORE',
    category: 'dairy',
    query: 'חלב',
    expectedTranslation: 'milk',
    strict: false,
    relevant: text =>
      text.includes('milk') || text.includes('חלב'),
  },
  {
    group: 'CORE',
    category: 'household',
    query: 'נייר טואלט',
    expectedTranslation: 'toilet paper',
    strict: true,
    relevant: text =>
      (text.includes('toilet') && text.includes('paper')) ||
      (text.includes('נייר') &&
        (text.includes('טואלט') || text.includes('אסלה'))),
  },
  {
    group: 'CORE',
    category: 'personal-care',
    query: 'משחת שיניים',
    expectedTranslation: 'toothpaste',
    strict: true,
    relevant: text =>
      text.includes('toothpaste') ||
      text.includes('משחת שיניים') ||
      text.includes('קרם שיניים'),
  },
  {
    group: 'CORE',
    category: 'drinks-specificity',
    query: 'קוקה קולה zero',
    expectedTranslation: 'coca cola zero',
    strict: true,
    relevant: text =>
      (
        text.includes('coca') &&
        text.includes('cola') &&
        text.includes('zero')
      ) ||
      (
        text.includes('קולה') &&
        (text.includes('zero') || text.includes('זירו'))
      ),
  },
];

const CONTROL_CASES = [
  {
    group: 'CONTROL',
    category: 'canned-protein',
    query: 'טונה',
    expectedTranslation: 'tuna',
    strict: false,
    relevant: text =>
      text.includes('tuna') || text.includes('טונה'),
  },
  {
    group: 'CONTROL',
    category: 'snacks',
    query: 'שוקולד חלב',
    expectedTranslation: 'milk chocolate',
    strict: true,
    relevant: text =>
      (text.includes('milk') && text.includes('chocolate')) ||
      (text.includes('שוקולד') && text.includes('חלב')),
  },
];

const ROTATING_PACKS = {
  A: [
    {
      group: 'PACK-A',
      category: 'dairy',
      query: 'גבינה צהובה',
      expectedTranslation: 'yellow cheese',
      strict: true,
      relevant: text =>
        (text.includes('yellow') && text.includes('cheese')) ||
        (text.includes('גבינה') && text.includes('צהובה')),
    },
    {
      group: 'PACK-A',
      category: 'dairy',
      query: 'יוגורט',
      expectedTranslation: 'yogurt',
      strict: false,
      relevant: text =>
        text.includes('yogurt') || text.includes('יוגורט'),
    },
    {
      group: 'PACK-A',
      category: 'pantry',
      query: 'שמן זית',
      expectedTranslation: 'olive oil',
      strict: true,
      relevant: text =>
        (text.includes('olive') && text.includes('oil')) ||
        (text.includes('שמן') && text.includes('זית')),
    },
    {
      group: 'PACK-A',
      category: 'pantry',
      query: 'אורז',
      expectedTranslation: 'rice',
      strict: false,
      relevant: text =>
        text.includes('rice') || text.includes('אורז'),
    },
  ],

  B: [
    {
      group: 'PACK-B',
      category: 'pantry',
      query: 'פסטה',
      expectedTranslation: 'pasta',
      strict: false,
      relevant: text =>
        text.includes('pasta') || text.includes('פסטה'),
    },
    {
      group: 'PACK-B',
      category: 'snacks',
      query: 'במבה',
      expectedTranslation: 'bamba',
      strict: false,
      relevant: text =>
        text.includes('bamba') || text.includes('במבה'),
    },
    {
      group: 'PACK-B',
      category: 'breakfast',
      query: 'קורנפלקס',
      expectedTranslation: 'cornflakes',
      strict: false,
      relevant: text =>
        text.includes('cornflake') ||
        text.includes('corn flakes') ||
        text.includes('קורנפלקס'),
    },
    {
      group: 'PACK-B',
      category: 'drinks',
      query: 'קוקה קולה',
      expectedTranslation: 'cola',
      strict: true,
      relevant: text =>
        (text.includes('coca') && text.includes('cola')) ||
        (text.includes('קוקה') && text.includes('קולה')),
    },
  ],

  C: [
    {
      group: 'PACK-C',
      category: 'fresh',
      query: 'ביצים',
      expectedTranslation: 'eggs',
      expectedMainTranslations: ['egg'],
      strict: false,
      relevant: text =>
        text.includes('egg') || text.includes('ביצ'),
    },
    {
      group: 'PACK-C',
      category: 'pantry',
      query: 'סוכר',
      expectedTranslation: 'sugar',
      strict: false,
      relevant: text =>
        text.includes('sugar') || text.includes('סוכר'),
    },
    {
      group: 'PACK-C',
      category: 'baking',
      query: 'קמח',
      expectedTranslation: 'flour',
      strict: false,
      relevant: text =>
        text.includes('flour') || text.includes('קמח'),
    },
    {
      group: 'PACK-C',
      category: 'drinks',
      query: 'מים מינרליים',
      expectedTranslation: 'mineral water',
      strict: true,
      relevant: text =>
        (text.includes('mineral') && text.includes('water')) ||
        (text.includes('מים') && text.includes('מינרל')),
    },
    {
      group: 'PACK-C',
      category: 'condiments',
      query: 'קטשופ',
      expectedTranslation: 'ketchup',
      strict: false,
      relevant: text =>
        text.includes('ketchup') || text.includes('קטשופ'),
    },
    {
      group: 'PACK-C',
      category: 'condiments',
      query: 'מיונז',
      expectedTranslation: 'mayonnaise',
      strict: false,
      relevant: text =>
        text.includes('mayonnaise') ||
        text.includes('mayo') ||
        text.includes('מיונז'),
    },
    {
      group: 'PACK-C',
      category: 'personal-care',
      query: 'שמפו',
      expectedTranslation: 'shampoo',
      strict: false,
      relevant: text =>
        text.includes('shampoo') || text.includes('שמפו'),
    },
    {
      group: 'PACK-C',
      category: 'household',
      query: 'אבקת כביסה',
      expectedTranslation: 'laundry detergent',
      strict: true,
      externalDataGap: 'off-no-usable-name',
      relevant: text =>
        (text.includes('laundry') && text.includes('detergent')) ||
        (text.includes('אבקת') && text.includes('כביסה')),
    },
  ],
};

const rotatingCases =
  selectedPack === 'ALL'
    ? [
        ...ROTATING_PACKS.A,
        ...ROTATING_PACKS.B,
        ...ROTATING_PACKS.C,
      ]
    : ROTATING_PACKS[selectedPack];

const cases = [
  ...CORE_CASES,
  ...CONTROL_CASES,
  ...rotatingCases,
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

function isExpectedExternalDataGap(tc, picker, raw) {
  if (tc.externalDataGap !== 'off-no-usable-name') return false;
  if (picker?.status !== 'ok') return false;
  if (raw.length !== 0) return false;

  const products = Array.isArray(picker?.batches)
    ? picker.batches.flatMap(batch =>
        Array.isArray(batch?.products) ? batch.products : []
      )
    : [];

  if (products.length === 0) return false;

  return products.every(
    product => !bpSelectName(product, 'he')
  );
}

function pickerResponseIsUsable(tc, data, translated) {
  if (data?.status !== 'ok') return false;
  if (!Array.isArray(data?.batches)) return false;

  const raw = [];
  bpConsumeBatches(data.batches, new Set(), raw, 'he');

  // A specifically-approved external data gap is a valid completed
  // response for retry purposes. It will still be reported as DATA GAP
  // later and is never counted as PASS.
  if (isExpectedExternalDataGap(tc, data, raw)) {
    return true;
  }

  if (raw.length === 0) return false;

  const strict = bpSelectStrictCandidates(raw, {
    queryLang: 'he',
    normQ: tc.query,
    enQuery: translated,
  });

  if (tc.strict) {
    if (!strict.used || strict.candidates.length === 0) {
      return false;
    }

    return strict.candidates.some(product =>
      tc.relevant(productText(product))
    );
  }

  if (strict.used) return false;

  return raw.some(product =>
    tc.relevant(productText(product))
  );
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

const TRANSIENT_OFF_ERRORS = new Set([
  'off_http_5xx',
  'off_timeout',
  'off_network',
]);

const TRANSIENT_REQUEST_ERRORS = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function transientSignalsForAttempt(item) {
  const signals = new Set();

  if (item?.error) {
    const code = item.error?.code;

    // Only explicit timeout/network failures are accepted as direct
    // evidence of external instability. Generic exceptions remain FAIL.
    if (TRANSIENT_REQUEST_ERRORS.has(code)) {
      signals.add(`request_${String(code).toLowerCase()}`);
    }

    return [...signals];
  }

  const data = item?.data;
  if (!data) return [];

  if (
    data?.status === 'REMOTE_FAILURE' ||
    data?.offStatus === 'REMOTE_FAILURE'
  ) {
    signals.add('off_remote_failure');
  }

  if (data?.offPartialFailure === true) {
    signals.add('off_partial_failure');
  }

  if (Array.isArray(data?.batches)) {
    for (const batch of data.batches) {
      if (TRANSIENT_OFF_ERRORS.has(batch?.error)) {
        signals.add(batch.error);
      }
    }
  }

  return [...signals];
}

function externalInstabilitySignals(attempts) {
  const failedAttempts = attempts.filter(
    item => item?.accepted !== true
  );

  if (failedAttempts.length === 0) return [];

  const signalsByAttempt = failedAttempts.map(
    transientSignalsForAttempt
  );

  // Hard safety rule:
  // Never downgrade a deterministic failure just because some other
  // retry happened to encounter a transient upstream problem.
  //
  // External instability is reported only when EVERY unsuccessful
  // attempt contains direct transient/upstream-failure evidence.
  if (signalsByAttempt.some(signals => signals.length === 0)) {
    return [];
  }

  return [...new Set(signalsByAttempt.flat())];
}

async function fetchWithRetry(url, accept, label) {
  let last = null;
  let lastError = null;
  const attempts = [];

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      last = vercelCurl(url);
      lastError = null;

      const accepted = Boolean(accept(last));

      attempts.push({
        attempt,
        data: last,
        accepted,
      });

      if (accepted) {
        if (attempt > 1) {
          console.log(`    recovered on attempt ${attempt}: ${label}`);
        }

        return {
          data: last,
          attempts,
          accepted: true,
          terminalError: null,
        };
      }
    } catch (e) {
      lastError = e;

      attempts.push({
        attempt,
        error: e,
        accepted: false,
      });
    }

    if (attempt < 5) await sleep(2000);
  }

  return {
    data: last,
    attempts,
    accepted: false,
    terminalError: lastError,
  };
}

let passed = 0;
let failed = 0;
let dataGaps = 0;
let externalInstabilities = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

console.log(`\nAPI smoke target: ${baseUrl}`);
console.log(`Coverage pack: ${selectedPack}`);
console.log(
  `Cases: ${CORE_CASES.length} core + ` +
  `${CONTROL_CASES.length} controls + ` +
  `${rotatingCases.length} rotating = ${cases.length}`
);

const groupStats = new Map();

function recordGroup(group, outcome) {
  const current = groupStats.get(group) || {
    passed: 0,
    failed: 0,
    dataGap: 0,
    externalInstability: 0,
  };

  if (outcome === 'passed') {
    current.passed++;
  } else if (outcome === 'dataGap') {
    current.dataGap++;
  } else if (outcome === 'externalInstability') {
    current.externalInstability++;
  } else {
    current.failed++;
  }

  groupStats.set(group, current);
}

for (const tc of cases) {
  console.log(
    `\n── [${tc.group}] [${tc.category}] ${tc.query} ──`
  );

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

    const pickerRetry = await fetchWithRetry(
      pickerUrl,
      data => pickerResponseIsUsable(tc, data, translated),
      `picker ${tc.query}`
    );

    const picker = pickerRetry.data;

    if (!pickerRetry.accepted) {
      const signals =
        externalInstabilitySignals(pickerRetry.attempts);

      if (signals.length > 0) {
        console.log(
          `  EXTERNAL INSTABILITY ${tc.query}: picker could not produce ` +
          `a semantically usable result after 5 attempts; ` +
          `signals=${signals.join(',')}`
        );

        externalInstabilities++;
        recordGroup(tc.group, 'externalInstability');
        continue;
      }

      if (pickerRetry.terminalError && !picker) {
        throw new Error(
          `picker ${tc.query}: request failed: ` +
          pickerRetry.terminalError.message
        );
      }
    }

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

    if (isExpectedExternalDataGap(tc, picker, raw)) {
      const sourceProducts = picker.batches.reduce(
        (sum, batch) =>
          sum + (Array.isArray(batch?.products) ? batch.products.length : 0),
        0
      );

      console.log(
        `  DATA GAP ${tc.query}: OFF returned ${sourceProducts} product record(s), ` +
        'but none has a usable Hebrew/English product name'
      );

      dataGaps++;
      recordGroup(tc.group, 'dataGap');
      continue;
    }

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

    const mainRetry = await fetchWithRetry(
      mainUrl,
      data => Array.isArray(data?.results) && data.results.length > 0,
      `main search ${tc.query}`
    );

    const main = mainRetry.data;

    if (!mainRetry.accepted) {
      const signals =
        externalInstabilitySignals(mainRetry.attempts);

      if (signals.length > 0) {
        console.log(
          `  EXTERNAL INSTABILITY ${tc.query}: main search could not produce ` +
          `results after 5 attempts; signals=${signals.join(',')}`
        );

        externalInstabilities++;
        recordGroup(tc.group, 'externalInstability');
        continue;
      }

      if (mainRetry.terminalError && !main) {
        throw new Error(
          `main search ${tc.query}: request failed: ` +
          mainRetry.terminalError.message
        );
      }
    }

    const expectedMainTranslations =
      tc.expectedMainTranslations || [tc.expectedTranslation];

    assert(
      expectedMainTranslations.includes(main?.englishQuery),
      `main translation mismatch: expected one of ${JSON.stringify(expectedMainTranslations)}, got ${JSON.stringify(main?.englishQuery)}`
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
    recordGroup(tc.group, 'passed');
  } catch (e) {
    console.error(`  FAIL ${tc.query}: ${e.message}`);
    failed++;
    recordGroup(tc.group, 'failed');
  }
}

console.log('\n===== COVERAGE SUMMARY =====');

for (const [group, stats] of groupStats.entries()) {
  const total =
    stats.passed +
    stats.failed +
    stats.dataGap +
    stats.externalInstability;

  const details = [
    stats.failed ? `${stats.failed} failed` : '',
    stats.dataGap ? `${stats.dataGap} data gap` : '',
    stats.externalInstability
      ? `${stats.externalInstability} external instability`
      : '',
  ].filter(Boolean);

  console.log(
    `${group}: ${stats.passed}/${total} passed` +
    (details.length ? ` (${details.join(', ')})` : '')
  );
}

console.log(
  `\nAPI smoke: ${passed} passed, ${dataGaps} data gap(s), ` +
  `${externalInstabilities} external instability case(s), ` +
  `${failed} failed / ${cases.length} total`
);

if (failed) {
  console.error(
    `API smoke FAILED: ${failed} release-gate case(s) failed` +
    (
      externalInstabilities
        ? `; ${externalInstabilities} external instability case(s)`
        : ''
    )
  );
  process.exitCode = 1;
} else if (externalInstabilities) {
  console.error(
    `API smoke INCONCLUSIVE: ${externalInstabilities} external ` +
    'instability case(s) prevented a clean release-gate result'
  );
  process.exitCode = 1;
} else if (dataGaps) {
  console.log(
    `API smoke PASSED with ${dataGaps} external data gap(s)`
  );
} else {
  console.log('API smoke PASSED');
}

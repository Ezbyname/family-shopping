import {
  bpTranslate,
  LEGACY_BP_HE_EN,
} from '../js/bp-translation.js';

let pass = 0;
let fail = 0;

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

console.log('\nProduct Picker translation compatibility');

test('all legacy exact translations are preserved', () => {
  const lost = [];
  const changed = [];

  for (const [q, expected] of Object.entries(LEGACY_BP_HE_EN)) {
    const actual = bpTranslate(q);

    if (!actual) lost.push({ q, expected });
    else if (actual !== expected) changed.push({ q, expected, actual });
  }

  assert(
    lost.length === 0,
    `lost ${lost.length} legacy translations: ${JSON.stringify(lost)}`
  );

  assert(
    changed.length === 0,
    `changed ${changed.length} legacy exact translations: ${JSON.stringify(changed)}`
  );
});

test('עגבניות שרי uses canonical specific translation', () => {
  assert(
    bpTranslate('עגבניות שרי') === 'cherry tomatoes',
    `got ${JSON.stringify(bpTranslate('עגבניות שרי'))}`
  );
});

test('שרי עגבניות is word-order resilient', () => {
  assert(
    bpTranslate('שרי עגבניות') === 'cherry tomatoes',
    `got ${JSON.stringify(bpTranslate('שרי עגבניות'))}`
  );
});

test('חלב 3 אחוז resolves through shared canonical synonym knowledge', () => {
  assert(
    bpTranslate('חלב 3 אחוז') === 'milk 3%',
    `got ${JSON.stringify(bpTranslate('חלב 3 אחוז'))}`
  );
});

test('legacy fuzzy typo: ניר טואלט remains covered', () => {
  assert(
    bpTranslate('ניר טואלט') === 'toilet paper',
    `got ${JSON.stringify(bpTranslate('ניר טואלט'))}`
  );
});

test('legacy fuzzy typo: ניר מגבת remains covered', () => {
  assert(
    bpTranslate('ניר מגבת') === 'paper towel',
    `got ${JSON.stringify(bpTranslate('ניר מגבת'))}`
  );
});

test('legacy canonical toothpaste translation remains covered', () => {
  // Production normalizes "משחת שיניים" -> "קרם שיניים"
  // before bpTranslate() is called.
  assert(
    bpTranslate('קרם שיניים') === 'toothpaste',
    `got ${JSON.stringify(bpTranslate('קרם שיניים'))}`
  );
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;

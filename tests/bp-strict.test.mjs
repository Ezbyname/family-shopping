import { bpSelectStrictCandidates } from '../js/bp-strict.js';

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

function names(result) {
  return result.candidates.map(p => p.name);
}

console.log('\nProduct Picker strict candidate selection');

test('Hebrew strict match keeps priority', () => {
  const result = bpSelectStrictCandidates([
    {
      name: 'עגבניות שרי לובלו',
      nameHe: 'עגבניות שרי לובלו',
      nameEn: 'Cherry Tomatoes Lobello',
    },
    {
      name: 'Cherry Tomatoes',
      nameHe: '',
      nameEn: 'Cherry Tomatoes',
    },
  ], {
    queryLang: 'he',
    normQ: 'עגבניות שרי',
    enQuery: 'cherry tomatoes',
  });

  assert(result.used === true);
  assert(result.mode === 'hebrew', `expected hebrew, got ${result.mode}`);
  assert(result.candidates.length === 1);
  assert(result.candidates[0].name === 'עגבניות שרי לובלו');
});

test('translated strict accepts concise relevant English names', () => {
  const result = bpSelectStrictCandidates([
    { name: 'Cherry Tomatoes', nameHe: '', nameEn: 'Cherry Tomatoes' },
    { name: 'Italian Cherry Tomatoes', nameHe: '', nameEn: 'Italian Cherry Tomatoes' },
    { name: 'Tomatoes - Cherry Tomatoes Italian', nameHe: '', nameEn: 'Tomatoes - Cherry Tomatoes Italian' },
  ], {
    queryLang: 'he',
    normQ: 'עגבניות שרי',
    enQuery: 'cherry tomatoes',
  });

  assert(result.mode === 'translated', `expected translated, got ${result.mode}`);
  assert(result.candidates.length === 3,
    `expected 3 relevant candidates, got ${result.candidates.length}`);
});

test('translated strict rejects processed/composite names with too many extra tokens', () => {
  const result = bpSelectStrictCandidates([
    {
      name: 'Bocconcini mozzarella & Sunblush cherry tomatoes',
      nameHe: '',
      nameEn: 'Bocconcini mozzarella & Sunblush cherry tomatoes',
    },
    {
      name: 'Mozzarella & Semi-Dried Cherry Tomato Wood Fired Pizza',
      nameHe: '',
      nameEn: 'Mozzarella & Semi-Dried Cherry Tomato Wood Fired Pizza',
    },
    {
      name: 'Cherry Tomatoes',
      nameHe: '',
      nameEn: 'Cherry Tomatoes',
    },
  ], {
    queryLang: 'he',
    normQ: 'עגבניות שרי',
    enQuery: 'cherry tomatoes',
  });

  const got = names(result);
  assert(got.length === 1, `expected 1 candidate, got ${got.length}: ${got.join(' | ')}`);
  assert(got[0] === 'Cherry Tomatoes');
});

test('single-token broad translation does NOT open English fallback', () => {
  const result = bpSelectStrictCandidates([
    { name: 'Instant Coffee', nameHe: '', nameEn: 'Instant Coffee' },
    { name: 'Coffee Drink Vanilla', nameHe: '', nameEn: 'Coffee Drink Vanilla' },
  ], {
    queryLang: 'he',
    normQ: 'קפה שחור',
    enQuery: 'coffee',
  });

  assert(result.used === true);
  assert(result.mode === 'empty', `expected empty, got ${result.mode}`);
  assert(result.candidates.length === 0);
});

test('numeric translated token is preserved: milk 3%', () => {
  const result = bpSelectStrictCandidates([
    { name: 'Milk 3%', nameHe: '', nameEn: 'Milk 3%' },
    { name: 'Chocolate Milk 3%', nameHe: '', nameEn: 'Chocolate Milk 3%' },
    { name: 'Chocolate Flavoured Long Life Milk 3%', nameHe: '', nameEn: 'Chocolate Flavoured Long Life Milk 3%' },
  ], {
    queryLang: 'he',
    normQ: 'חלב 3 אחוז',
    enQuery: 'milk 3%',
  });

  const got = names(result);
  assert(got.includes('Milk 3%'), 'Milk 3% must be accepted');
  assert(got.includes('Chocolate Milk 3%'), 'one descriptive token must be allowed');
  assert(!got.includes('Chocolate Flavoured Long Life Milk 3%'),
    'long composite product must be rejected');
});

test('non-Hebrew and single-token Hebrew queries do not activate strict mode', () => {
  const latin = bpSelectStrictCandidates([], {
    queryLang: 'latin',
    normQ: 'milk',
    enQuery: 'milk',
  });

  const singleHe = bpSelectStrictCandidates([], {
    queryLang: 'he',
    normQ: 'חלב',
    enQuery: 'milk',
  });

  assert(latin.used === false);
  assert(singleHe.used === false);
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exitCode = 1;

/**
 * Ingredient catalog & normalization coverage tests.
 * Usage:  node tests/ingredients.test.mjs
 * Exit:   0 = all pass, 1 = failures
 *
 * Covers:
 *   - Catalog size ≥ 300 canonical entries
 *   - Synonym layer size ≥ 200 entries (validates bulk; full count printed)
 *   - Exact canonical lookups
 *   - Synonym resolution
 *   - Phrase-level queries (must not singularize before phrase lookup)
 *   - Plural form regression
 *   - Cross-check: every SYNONYM value must point to a valid CATALOG key
 */

import { CATALOG, SYNONYMS } from '../api/ingredients.js';
import { translateIngredient, normalizeHe } from '../api/normalize-he.js';

let passed = 0, failed = 0;

function assert(description, condition) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${description}`);
  }
}

function expectTranslation(input, expectedSubstring, label) {
  const result = translateIngredient(input);
  const ok = result !== null && result.toLowerCase().includes(expectedSubstring.toLowerCase());
  assert(label ?? `"${input}" → contains "${expectedSubstring}"`, ok);
  if (!ok) console.error(`        got: ${JSON.stringify(result)}`);
}

// ── 1. Catalog size ───────────────────────────────────────────────────────────
console.log('\n1. Catalog size');
assert(`CATALOG has ≥ 300 entries (got ${CATALOG.size})`, CATALOG.size >= 300);

// ── 2. Synonym layer size ──────────────────────────────────────────────────────
console.log('\n2. Synonym layer size');
assert(`SYNONYMS has ≥ 200 entries (got ${SYNONYMS.size})`, SYNONYMS.size >= 200);

// ── 3. Cross-check: every synonym value must exist in CATALOG ─────────────────
console.log('\n3. Synonym → CATALOG integrity');
let orphans = 0;
for (const [syn, canonical] of SYNONYMS) {
  if (!CATALOG.has(canonical)) {
    orphans++;
    console.error(`  ORPHAN synonym "${syn}" → "${canonical}" (not in CATALOG)`);
  }
}
assert(`All synonym targets exist in CATALOG (orphans: ${orphans})`, orphans === 0);

// ── 4. Exact canonical lookups ────────────────────────────────────────────────
console.log('\n4. Exact canonical lookups');
expectTranslation('חלב',         'milk');
expectTranslation('גבינה',       'cheese');
expectTranslation('קוטג',        'cottage');
expectTranslation('יוגורט',      'yogurt');
expectTranslation('חמאה',        'butter');
expectTranslation('ביצה',        'egg');
expectTranslation('גלידה',       'ice cream');
expectTranslation('לחם',         'bread');
expectTranslation('קמח',         'flour');
expectTranslation('אורז',        'rice');
expectTranslation('פסטה',        'pasta');
expectTranslation('שמן זית',     'olive oil');
expectTranslation('שמן',         'oil');
expectTranslation('קטשופ',       'ketchup');
expectTranslation('מיונז',       'mayonnaise');
expectTranslation('טחינה',       'tahini');
expectTranslation('ריבה',        'jam');
expectTranslation('דבש',         'honey');
expectTranslation('סוכר',        'sugar');
expectTranslation('מלח',         'salt');
expectTranslation('פלפל שחור',   'black pepper');
expectTranslation('פפריקה',      'paprika');
expectTranslation('כמון',        'cumin');
expectTranslation('קינמון',      'cinnamon');
expectTranslation('שומשום',      'sesame');
expectTranslation('טונה',        'tuna');
expectTranslation('שוקולד',      'chocolate');
expectTranslation('קקאו',        'cocoa');
expectTranslation('אבקת אפייה',  'baking powder');
expectTranslation('שמרים',       'yeast');
expectTranslation('קפה',         'coffee');
expectTranslation('תה',          'tea');
expectTranslation('מים',         'water');
expectTranslation('עוף',         'chicken');
expectTranslation('בשר בקר',     'beef');
expectTranslation('סלמון',       'salmon');
expectTranslation('דג',          'fish');
expectTranslation('שמפו',        'shampoo');
expectTranslation('סבון',        'soap');
expectTranslation('נייר טואלט',  'toilet paper');
expectTranslation('עגבנייה',     'tomato');
expectTranslation('מלפפון',      'cucumber');
expectTranslation('בצל',         'onion');
expectTranslation('שום',         'garlic');
expectTranslation('גזר',         'carrot');
expectTranslation('תפוח אדמה',   'potato');
expectTranslation('תפוח',        'apple');
expectTranslation('בננה',        'banana');
expectTranslation('תפוז',        'orange');
expectTranslation('לימון',       'lemon');
expectTranslation('ענבים',       'grape');
expectTranslation('אבוקדו',      'avocado');

// ── 5. Phrase queries — must match phrase BEFORE singularizing ─────────────────
console.log('\n5. Phrase-level queries (must not singularize before phrase lookup)');
expectTranslation('מיץ תפוזים',   'orange juice',   '"מיץ תפוזים" → orange juice (not just juice)');
expectTranslation('מיץ תפוחים',   'apple juice',    '"מיץ תפוחים" → apple juice');
expectTranslation('שמן זית',      'olive oil',      '"שמן זית" → olive oil (not just oil)');
expectTranslation('שמן זית כתית', 'extra virgin',   '"שמן זית כתית" → extra virgin olive oil');
expectTranslation('ריבת תות',     'strawberry jam', '"ריבת תות" → strawberry jam');
expectTranslation('ריבת משמש',    'apricot jam',    '"ריבת משמש" → apricot jam');
expectTranslation('חמאת בוטנים',  'peanut butter',  '"חמאת בוטנים" → peanut butter');
expectTranslation('גבינת פטה',    'feta',           '"גבינת פטה" → feta cheese');
expectTranslation('גבינת מוצרלה', 'mozzarella',     '"גבינת מוצרלה" → mozzarella');
expectTranslation('חלב סויה',     'soy milk',       '"חלב סויה" → soy milk');
expectTranslation('יוגורט יווני', 'greek yogurt',   '"יוגורט יווני" → greek yogurt');
expectTranslation('שמנת חמוצה',   'sour cream',     '"שמנת חמוצה" → sour cream');
expectTranslation('לחם מלא',      'whole wheat',    '"לחם מלא" → whole wheat bread');
expectTranslation('אורז בסמטי',   'basmati',        '"אורז בסמטי" → basmati rice');
expectTranslation('קפה נמס',      'instant',        '"קפה נמס" → instant coffee');
expectTranslation('תה ירוק',      'green tea',      '"תה ירוק" → green tea');
expectTranslation('מים מינרלים',  'mineral water',  '"מים מינרלים" → mineral water');
expectTranslation('מים מוגזים',   'sparkling',      '"מים מוגזים" → sparkling water');
expectTranslation('חזה עוף',      'chicken breast', '"חזה עוף" → chicken breast');
expectTranslation('בשר טחון',     'ground beef',    '"בשר טחון" → ground beef');

// ── 6. Plural form regression ─────────────────────────────────────────────────
console.log('\n6. Plural form regression (synonym or singular-strip)');
expectTranslation('ביצים',        'egg',        '"ביצים" plural → egg');
expectTranslation('עגבניות',      'tomato',     '"עגבניות" plural → tomato');
expectTranslation('בננות',        'banana',     '"בננות" plural → banana');
expectTranslation('תפוחים',       'apple',      '"תפוחים" plural → apple');
expectTranslation('תפוזים',       'orange',     '"תפוזים" plural → orange');
expectTranslation('מלפפונים',     'cucumber',   '"מלפפונים" plural → cucumber');
expectTranslation('בצלים',        'onion',      '"בצלים" plural → onion');
expectTranslation('גזרים',        'carrot',     '"גזרים" plural → carrot');
expectTranslation('שקדים',        'almond',     '"שקדים" → almonds');
expectTranslation('פטריות',       'mushroom',   '"פטריות" plural → mushroom');
expectTranslation('תמרים',        'date',       '"תמרים" plural → date');
expectTranslation('צימוקים',      'raisin',     '"צימוקים" plural → raisin');
expectTranslation('זיתים',        'olive',      '"זיתים" plural → olive');
expectTranslation('סרדינים',      'sardine',    '"סרדינים" plural → sardine');
expectTranslation('נקניקיות',     'frankfurter','נקניקיות plural');

// ── 7. Synonym lookups ────────────────────────────────────────────────────────
console.log('\n7. Synonym lookups');
expectTranslation("קוטג'",        'cottage',    "קוטג׳ (apostrophe variant)");
expectTranslation('תפוחי אדמה',   'potato',     'תפוחי אדמה (construct plural)');
expectTranslation('תפ״א',         'potato',     'תפ״א abbreviation');
expectTranslation('נסקפה',        'instant',    'נסקפה → instant coffee');
expectTranslation('נוטלה',        'chocolate',  'נוטלה → chocolate spread');
expectTranslation('מוצרלה',       'mozzarella', 'מוצרלה short form');
expectTranslation('פטה',          'feta',       'פטה short form');
expectTranslation('פרמזן',        'parmesan',   'פרמזן short form');
expectTranslation('קצפת',         'cream',      'קצפת → heavy cream');
expectTranslation('הומוס',        'chickpea',   'הומוס (variant spelling) → chickpeas');
expectTranslation('חומוס',        'chickpea',   'חומוס → chickpeas');
expectTranslation('ציפס',         'chip',       'ציפס variant spelling');
expectTranslation('פיירי',        'dish soap',  'פיירי (brand) → dish soap');
expectTranslation('אריאל',        'detergent',  'אריאל (brand) → laundry detergent');
expectTranslation('בסמטי',        'basmati',    'בסמטי short form');
expectTranslation('אוטס',         'oatmeal',    'אוטס → oatmeal');
expectTranslation('מג׳הול',       'date',       'מג׳הול → date');

// ── 8. normalizeHe surface normalization ──────────────────────────────────────
console.log('\n8. normalizeHe surface normalization');
assert('strips ״',           normalizeHe('בשר״טחון') === 'בשרטחון'); // edge case
assert('collapses spaces',   normalizeHe('  חלב   3%  ') === 'חלב 3%');
assert('strips left-double-quote', normalizeHe('גבינה"לבנה') === 'גבינהלבנה');
assert('empty string',       normalizeHe('') === '');
assert('null safe',          normalizeHe(null) === '');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`Catalog:  ${CATALOG.size} canonical entries`);
console.log(`Synonyms: ${SYNONYMS.size} synonym entries`);
console.log(`Tests:    ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log('─'.repeat(60));

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED\n`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.\n');
}

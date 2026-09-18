// Department classifier regression tests (Stage 4)
// Run with: node tests/dept-classifier.test.js
// No test framework required — plain Node.js assertions.
'use strict';

import { DEPARTMENTS, DEPT_OVERRIDES, DEPT_KEYWORDS, _normText, getItemDepartment } from '../js/product-taxonomy.js';

// ── Test harness ────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function expect(name, got, expected) {
  if (got === expected) {
    console.log(`  ✅ ${name}`);
    pass++;
  } else {
    console.error(`  ❌ ${name}\n     got: ${got}\n     expected: ${expected}`);
    fail++;
  }
}
function classify(name, attached) {
  return getItemDepartment({ name, attached: attached || null }).id;
}

console.log('\n── Standard examples ──');
expect('תפוחים',     classify('תפוחים'),        'produce');
expect('בננה',       classify('בננה'),           'produce');
expect('עגבניה',     classify('עגבניה'),         'produce');
expect('גזר',        classify('גזר'),            'produce');
expect('לחם',        classify('לחם'),            'bakery');
expect('פיתה',       classify('פיתה'),           'bakery');
expect('פרחים',      classify('פרחים'),          'seasonal');
expect('עציץ',       classify('עציץ'),           'seasonal');
expect('גבינה צהובה', classify('גבינה צהובה'),   'deli');
expect('גבינה לבנה', classify('גבינה לבנה'),    'deli');
expect('מוצרלה',     classify('מוצרלה'),         'deli');
expect('פסטרמה',     classify('פסטרמה'),         'deli');
expect('חלב',        classify('חלב'),            'dairy');
expect('ביצים',      classify('ביצים'),          'dairy');
expect('ביצה',       classify('ביצה'),           'dairy');
expect('יוגורט',     classify('יוגורט'),         'dairy');
expect('שמנת',       classify('שמנת'),           'dairy');
expect('סלמון',      classify('סלמון'),          'meat');
expect('עוף',        classify('עוף'),            'meat');
expect('בשר',        classify('בשר'),            'meat');
expect('שניצל',      classify('שניצל'),          'meat');
expect('אורז',       classify('אורז'),           'pantry');
expect('פסטה',       classify('פסטה'),           'pantry');
expect('שמן',        classify('שמן'),            'pantry');
expect('תבלין',      classify('תבלין'),          'pantry');
expect('במבה',       classify('במבה'),           'snacks');
expect('שוקולד',     classify('שוקולד'),         'snacks');
expect('חטיף',       classify('חטיף'),           'snacks');
expect('קולה',       classify('קולה'),           'drinks');
expect('מים',        classify('מים'),            'drinks');
expect('שתייה',      classify('שתייה'),  'drinks');
expect('קפה',        classify('קפה'),            'drinks');
expect('שניצל קפוא', classify('שניצל קפוא'),    'frozen');
expect('גלידה',      classify('גלידה'),          'frozen');
expect('פיצה קפואה', classify('פיצה קפואה'),    'frozen');
expect('נייר טואלט', classify('נייר טואלט'),    'cleaning');
expect('שמפו',       classify('שמפו'),           'cleaning');
expect('סבון',       classify('סבון'),           'cleaning');
expect('דיאודורנט',  classify('דיאודורנט'),      'cleaning');
expect('חיתולים',    classify('חיתולים'),        'baby');
expect('חיתול',      classify('חיתול'),          'baby');
expect('פורמולה',    classify('פורמולה'),        'baby');
expect('נייר כסף',   classify('נייר כסף'),       'home');
expect('נרות',       classify('נרות'),           'home');
expect('כלי בית',    classify('כלי בית'),        'home');
expect('מסטיק',      classify('מסטיק'),          'impulse');
expect('מצית',       classify('מצית'),           'impulse');
expect('זבנג וגמרנו', classify('זבנג וגמרנו'),   'other');
expect('xyz123',     classify('xyz123'),          'other');

console.log('\n── Ambiguous / phrase override cases ──');
expect('מיץ תפוזים → משקאות',  classify('מיץ תפוזים'),  'drinks');
expect('תפוזים → פירות',        classify('תפוזים'),       'produce');
expect('מיץ תפוחים → משקאות',  classify('מיץ תפוחים'),  'drinks');
expect('שניצל → בשר',           classify('שניצל'),        'meat');
expect('שניצל קפוא → קפואים',  classify('שניצל קפוא'),   'frozen');
expect('חומוס יבש → מזווה',    classify('חומוס יבש'),    'pantry');
expect('גרגרי חומוס → מזווה',  classify('גרגרי חומוס'),  'pantry');
expect('חומוס שימורים → מזווה',classify('חומוס שימורים'),'pantry');
expect('ממרח חומוס → מעדנייה', classify('ממרח חומוס'),   'deli');
expect('סלט חומוס → מעדנייה',  classify('סלט חומוס'),    'deli');
expect('חומוס מוכן → מעדנייה', classify('חומוס מוכן'),   'deli');
expect('שוקולד → חטיפים',       classify('שוקולד'),       'snacks');
expect('שוקולד קטן → קו קופות',classify('שוקולד קטן'),   'impulse');
expect('חטיף קטן → קו קופות',  classify('חטיף קטן'),     'impulse');
expect('מסטיק → קו קופות',     classify('מסטיק'),        'impulse');
expect('גלידה → קפואים (not snacks)', classify('גלידה'), 'frozen');
expect('נייר טואלט → ניקיון',  classify('נייר טואלט'),   'cleaning');
expect('נייר כסף → כלי בית',   classify('נייר כסף'),      'home');
expect('גבינה → מעדנייה',       classify('גבינה'),         'deli');
expect('גבינה עיזים → מעדנייה',classify('גבינה עיזים'),   'deli');

console.log('\n── attached metadata ──');
expect('attached.name wins: salmon brand → meat',
  classify('דג', {name:'סלמון טרי',brand:'SeaFresh'}), 'meat');
expect('attached.brand: גבינה brand → deli',
  classify('מוצר', {name:'גבינה צהובה',brand:'תנובה'}), 'deli');
expect('null attached → safe fallback',
  classify('תפוח', null), 'produce');
expect('empty attached → safe',
  classify('תפוח', {}), 'produce');

console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`);
if (fail > 0) process.exit(1);

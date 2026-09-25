// Department classifier regression tests (Stage 4 — Commit 2)
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

// ── Original 73 cases (must all still pass) ──────────────────────────────────
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

// ── Commit 2: new produce items (previously classified wrong or as other) ─────
console.log('\n── New produce: previously missing items ──');
expect('נקטרינה → פירות',          classify('נקטרינה'),          'produce');
expect('נקטרינות → פירות',         classify('נקטרינות'),         'produce');
expect('בזיליקום → פירות/ירקות',   classify('בזיליקום'),         'produce');
expect('שורש סלרי → פירות/ירקות',  classify('שורש סלרי'),        'produce');
expect('עגבניות שרי → פירות',      classify('עגבניות שרי'),      'produce');
expect('עגבנייה שרי → פירות',      classify('עגבנייה שרי'),      'produce');
expect('עגבניות מיני → פירות',     classify('עגבניות מיני'),     'produce');
expect('ברוקולי → פירות/ירקות',    classify('ברוקולי'),          'produce');
expect('כרובית → פירות/ירקות',     classify('כרובית'),           'produce');
expect('אפרסק → פירות',            classify('אפרסק'),            'produce');
expect('מישמיש → פירות',           classify('מישמיש'),           'produce');
expect('דובדבן → פירות',           classify('דובדבן'),           'produce');
expect('אבטיח → פירות',            classify('אבטיח'),            'produce');
expect('מלון → פירות',             classify('מלון'),             'produce');
expect('תות שדה → פירות',          classify('תות שדה'),          'produce');
expect('תותים → פירות',            classify('תותים'),            'produce');
expect('אוכמניות → פירות',         classify('אוכמניות'),         'produce');
expect('פטל → פירות',              classify('פטל'),              'produce');
expect('פפאיה → פירות',            classify('פפאיה'),            'produce');
expect('מנגו → פירות',             classify('מנגו'),             'produce');
expect('אננס → פירות',             classify('אננס'),             'produce');
expect('קיווי → פירות',            classify('קיווי'),            'produce');
expect('לימון → פירות',            classify('לימון'),            'produce');
expect('ליים → פירות',             classify('ליים'),             'produce');
expect('אשכולית → פירות',          classify('אשכולית'),          'produce');
expect('פומלה → פירות',            classify('פומלה'),            'produce');
expect('תמר → פירות',              classify('תמר'),              'produce');
expect('תאנה → פירות',             classify('תאנה'),             'produce');
expect('ענבים → פירות',            classify('ענבים'),            'produce');
expect('רימון → פירות',            classify('רימון'),            'produce');
expect('שזיף → פירות',             classify('שזיף'),             'produce');
expect('אגס → פירות',              classify('אגס'),              'produce');
expect('חבוש → פירות',             classify('חבוש'),             'produce');
expect('שסק → פירות',              classify('שסק'),              'produce');

console.log('\n── New produce: vegetables ──');
expect('חציל → ירקות',             classify('חציל'),             'produce');
expect('חצילים → ירקות',           classify('חצילים'),           'produce');
expect('קישוא → ירקות',            classify('קישוא'),            'produce');
expect('קישואים → ירקות',          classify('קישואים'),          'produce');
expect('דלעת → ירקות',             classify('דלעת'),             'produce');
expect('דלורית → ירקות',           classify('דלורית'),           'produce');
expect('תירס → ירקות',             classify('תירס'),             'produce');
expect('אפונה → ירקות',            classify('אפונה'),            'produce');
expect('שעועית ירוקה → ירקות',     classify('שעועית ירוקה'),     'produce');
expect('אספרגוס → ירקות',          classify('אספרגוס'),          'produce');
expect('ארטישוק → ירקות',          classify('ארטישוק'),          'produce');
expect('שומר → ירקות',             classify('שומר'),             'produce');
expect('בטטה → ירקות',             classify('בטטה'),             'produce');
expect('לפת → ירקות',              classify('לפת'),              'produce');
expect('צנון → ירקות',             classify('צנון'),             'produce');
expect('פטריות → ירקות',           classify('פטריות'),           'produce');
expect('שמפיניון → ירקות',         classify('שמפיניון'),         'produce');
expect('פטרייה → ירקות',           classify('פטרייה'),           'produce');
expect('פטריות ממולאות → ירקות',   classify('פטריות ממולאות'),   'produce');
expect('כרוב → ירקות',             classify('כרוב'),             'produce');
expect('כרוב אדום → ירקות',        classify('כרוב אדום'),        'produce');
expect('כרוב ניצנים → ירקות',      classify('כרוב ניצנים'),      'produce');
expect('קולרבי → ירקות',           classify('קולרבי'),           'produce');
expect('מנגולד → ירקות',           classify('מנגולד'),           'produce');
expect('תרד → ירקות',              classify('תרד'),              'produce');
expect('קייל → ירקות',             classify('קייל'),             'produce');
expect('חסה גלילית → ירקות',       classify('חסה גלילית'),       'produce');
expect('רוקט → ירקות',             classify('רוקט'),             'produce');
expect('סלרי → ירקות',             classify('סלרי'),             'produce');
expect('כרישה → ירקות',            classify('כרישה'),            'produce');
expect('שאלוט → ירקות',            classify('שאלוט'),            'produce');
expect('בצל ירוק → ירקות',         classify('בצל ירוק'),         'produce');
expect('בצל סגול → ירקות',         classify('בצל סגול'),         'produce');
expect('שורש פטרוזיליה → ירקות',   classify('שורש פטרוזיליה'),   'produce');
expect('סלק → ירקות',              classify('סלק'),              'produce');

console.log('\n── New produce: fresh herbs ──');
expect('פטרוזיליה → ירקות',        classify('פטרוזיליה'),        'produce');
expect('כוסברה → ירקות',           classify('כוסברה'),           'produce');
expect('שמיר → ירקות',             classify('שמיר'),             'produce');
expect('נענע → ירקות',             classify('נענע'),             'produce');
expect('עירית → ירקות',            classify('עירית'),            'produce');
expect('מרווה → ירקות',            classify('מרווה'),            'produce');
expect('טימין → ירקות',            classify('טימין'),            'produce');
expect('רוזמרין → ירקות',          classify('רוזמרין'),          'produce');
expect('עשבי תיבול → ירקות',       classify('עשבי תיבול'),       'produce');

console.log('\n── False positive regression: these must NOT be produce ──');
expect('מיץ גזר → drinks (not produce)',       classify('מיץ גזר'),         'drinks');
expect('מיץ תפוחים → drinks (not produce)',    classify('מיץ תפוחים'),      'drinks');
expect('ריבת תפוחים → pantry (not produce)',   classify('ריבת תפוחים'),     'pantry');
expect('תה לימון → drinks (not produce)',      classify('תה לימון'),        'drinks');
expect('עוגת גזר → bakery (not produce)',      classify('עוגת גזר'),        'bakery');
expect('ממרח אבוקדו → deli (not produce)',     classify('ממרח אבוקדו'),     'deli');
expect('קמח תפוח אדמה → pantry (not produce)',classify('קמח תפוח אדמה'),   'pantry');
expect('פלפל שחור → pantry (spice, not fresh)',classify('פלפל שחור'),       'pantry');
expect('פלפל לבן → pantry (spice, not fresh)', classify('פלפל לבן'),        'pantry');
expect('כורכום → pantry (spice, not produce)', classify('כורכום'),          'pantry');
expect('שייק בננה → drinks (not produce)',     classify('שייק בננה'),       'drinks');
expect('שייק → drinks (not produce)',          classify('שייק'),            'drinks');

console.log('\n── New overrides ──');
expect('ממרח אבוקדו → deli',        classify('ממרח אבוקדו'),      'deli');
expect('פלפל שחור → pantry',        classify('פלפל שחור'),        'pantry');
expect('פלפל לבן → pantry',         classify('פלפל לבן'),         'pantry');

console.log('\n── Spelling variants / plurals ──');
expect('עגבניות (plural) → produce', classify('עגבניות'),          'produce');
expect('עגבנייה (variant) → produce',classify('עגבנייה'),          'produce');
expect('מלפפונים → produce',         classify('מלפפונים'),         'produce');
expect('אגסים → produce',            classify('אגסים'),            'produce');
expect('אפרסקים → produce',          classify('אפרסקים'),          'produce');
expect('שזיפים → produce',           classify('שזיפים'),           'produce');
expect('קלמנטינה → produce',         classify('קלמנטינה'),         'produce');
expect('מנדרינה → produce',          classify('מנדרינה'),          'produce');
expect('בננות → produce',            classify('בננות'),            'produce');
expect('תמרים → produce',            classify('תמרים'),            'produce');
expect('תאנים → produce',            classify('תאנים'),            'produce');

console.log('\n── Commit 2 corrections: item.name-only Produce matching ──');
// Bug 1: attached.brand must NOT break alias match on item.name
expect('נקטרינה + attached.brand=שופרסל → produce',
  classify('נקטרינה', {brand:'שופרסל'}), 'produce');
expect('בזיליקום + attached.brand=כרמל → produce',
  classify('בזיליקום', {brand:'כרמל'}), 'produce');
expect('עגבניות + attached.brand=רמי לוי → produce',
  classify('עגבניות', {brand:'רמי לוי'}), 'produce');
expect('תפוח + attached.brand=תנובה → produce',
  classify('תפוח', {brand:'תנובה'}), 'produce');
expect('גזר + attached.brand=שופרסל + attached.name=גזר ישראלי → produce',
  classify('גזר', {name:'גזר ישראלי',brand:'שופרסל'}), 'produce');

// Bug 1: attached.name must NOT override item.name classification
expect('מיץ גזר + attached.name=גזר → drinks (not produce)',
  classify('מיץ גזר', {name:'גזר',brand:'תנובה'}), 'drinks');
expect('שייק בננה + attached.name=בננה → drinks (not produce)',
  classify('שייק בננה', {name:'בננה',brand:'תנובה'}), 'drinks');
expect('עגבניות מרוסקות + attached.name=עגבניות → pantry (not produce)',
  classify('עגבניות מרוסקות', {name:'עגבניות',brand:'שופרסל'}), 'pantry');
expect('ריבת תפוחים + attached.name=תפוח → pantry (not produce)',
  classify('ריבת תפוחים', {name:'תפוח',brand:'תנובה'}), 'pantry');

console.log('\n── Commit 2 corrections: generic Produce exact aliases ──');
// Bug 2: generic terms must classify as produce (exact alias, not substring)
expect('ירק → produce',          classify('ירק'),          'produce');
expect('ירקות → produce',        classify('ירקות'),        'produce');
expect('ירק טרי → produce',      classify('ירק טרי'),      'produce');
expect('פרי → produce',          classify('פרי'),          'produce');
expect('פירות → produce',        classify('פירות'),        'produce');
expect('פירות טריים → produce',  classify('פירות טריים'),  'produce');

// Generic terms: substring must NOT produce false positives
expect('סלט ירק → other (not produce)',  classify('סלט ירק'),   'other');
expect('מיץ פרי → drinks (not produce)', classify('מיץ פרי'),   'drinks');

console.log('\n── Commit 2 corrections: numeric normalization (unit required) ──');
// With recognized unit → produce (weight stripped, alias matches)
expect('עגבניות שרי 500 גרם → produce', classify('עגבניות שרי 500 גרם'), 'produce');
expect('מלפפון 3 יחידות → produce',     classify('מלפפון 3 יחידות'),     'produce');
expect('תפוח 1 ק"ג → produce',          classify('תפוח 1 ק"ג'),          'produce');
// Without unit → bare number NOT stripped → not in alias set → other
expect('מנגו 2 → other (no unit)',       classify('מנגו 2'),               'other');
expect('תפוח 12 → other (no unit)',      classify('תפוח 12'),              'other');
expect('פלפל 3 → other (no unit)',       classify('פלפל 3'),               'other');

console.log('\n── Commit 2 corrections: confirmed conflict protections ──');
expect('ממרח אבוקדו → deli',             classify('ממרח אבוקדו'),          'deli');
expect('פלפל שחור → pantry',            classify('פלפל שחור'),            'pantry');
expect('פלפל לבן → pantry',             classify('פלפל לבן'),             'pantry');
expect('פלפל אדום טחון → pantry',       classify('פלפל אדום טחון'),       'pantry');
expect('מיץ גזר → drinks',              classify('מיץ גזר'),              'drinks');
expect('שייק בננה → drinks',            classify('שייק בננה'),            'drinks');
expect('תה לימון → drinks',             classify('תה לימון'),             'drinks');
expect('ריבת תפוחים → pantry',          classify('ריבת תפוחים'),          'pantry');
expect('עגבניות מרוסקות → pantry',      classify('עגבניות מרוסקות'),      'pantry');
expect('ירקות קפואים → frozen',         classify('ירקות קפואים'),         'frozen');

console.log(`\n── Results: ${pass} passed, ${fail} failed ──\n`);
if (fail > 0) process.exit(1);

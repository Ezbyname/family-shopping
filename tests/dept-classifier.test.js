// Department classifier regression tests (Stage 4)
// Run with: node tests/dept-classifier.test.js
// No test framework required — plain Node.js assertions.
'use strict';

// ── Inline the classifier (no browser globals needed) ──────────────────────
const DEPARTMENTS = [
  { id:'produce',  label:'פירות וירקות',                order:1  },
  { id:'bakery',   label:'מאפייה',                      order:2  },
  { id:'seasonal', label:'פרחים ועונתי',                order:3  },
  { id:'deli',     label:'מעדנייה וגבינות',             order:4  },
  { id:'meat',     label:'בשר ודגים',                   order:5  },
  { id:'dairy',    label:'חלב וביצים',                  order:6  },
  { id:'pantry',   label:'בישול, שימורים ומזווה',       order:7  },
  { id:'snacks',   label:'חטיפים ומתוקים',              order:8  },
  { id:'drinks',   label:'משקאות',                      order:9  },
  { id:'frozen',   label:'קפואים ומוכנים',              order:10 },
  { id:'cleaning', label:'ניקיון וטואלטיקה',            order:11 },
  { id:'baby',     label:'תינוקות',                     order:12 },
  { id:'home',     label:'כלי בית ושונות',              order:13 },
  { id:'impulse',  label:'קו קופות / קטן ואימפולסיבי', order:14 },
  { id:'other',    label:'אחר',                         order:15 },
];

const DEPT_OVERRIDES = [
  ['מיץ תפוזים','drinks'], ['מיץ תפוז','drinks'], ['מיץ ענבים','drinks'],
  ['מיץ תפוחים','drinks'], ['מיץ אשכוליות','drinks'],
  ['שניצל קפוא','frozen'], ['פיצה קפואה','frozen'], ['ירקות קפואים','frozen'],
  ['בורקס קפוא','frozen'], ['ארוחה מוכנה','frozen'], ['מנה מוכנה','frozen'],
  ['ממרח חומוס','deli'], ['סלט חומוס','deli'], ['חומוס מוכן','deli'],
  ['חומוס יבש','pantry'], ['גרגרי חומוס','pantry'], ['חומוס שימורים','pantry'],
  ['גבינה צהובה','deli'], ['גבינה לבנה','deli'], ['גבינה עיזים','deli'],
  ['ממרח גבינה','deli'],
  ['נייר טואלט','cleaning'], ['מגבות נייר','cleaning'], ['נוזל כלים','cleaning'],
  ['שקיות אשפה','cleaning'], ['משחת שיניים','cleaning'],
  ['נייר אפייה','home'], ['נייר כסף','home'], ['ניילון נצמד','home'],
  ['שוקולד קטן','impulse'], ['חטיף קטן','impulse'],
  ['שוקולד','snacks'],
  ['גלידה','frozen'],
  ['מסטיק','impulse'],
].sort((a,b) => b[0].length - a[0].length);

const DEPT_KEYWORDS = {
  produce:  ['עגבניה','עגבנייה','מלפפון','תפוח','בננה','חסה','בצל','תפוח אדמה','גזר','פלפל','אבוקדו','לימון','פטרוזיליה','כוסברה','שמיר','קישוא','סלק','כרוב','שום','תפוז','קלמנטינה','מנגו','ענבים','רימון','ירק','פרי'],
  bakery:   ['לחם','לחמניה','לחמנייה','פיתה','בגט','חלה','עוגה','עוגייה','עוגיות','מאפה','קרואסון','רוגלך','מאפינס'],
  seasonal: ['פרח','פרחים','עציץ','צמח','זר פרחים','זר','קישוט','קישוטים'],
  deli:     ['גבינה','מוצרלה','קשקבל','פרמזן','ריקוטה','בולגרית','צפתית','גאודה','קולבי','פסטרמה','נקניק פרוס','סלמי','קוטג','סלטים'],
  meat:     ['עוף','בשר','שניצל','קציצות','דג','דגים','סלמון','טונה טרייה','הודו','פרגית','כנפיים','שוקיים','סטייק','קבב','בשר טחון','פילה','כבד','לברק','קרפיון','פורל','בקלה'],
  dairy:    ['חלב','ביצים','ביצה','יוגורט','שמנת','חמאה','שוקו','מעדן','אשל','מרגרינה'],
  pantry:   ['אורז','פסטה','פתיתים','קוסקוס','שמן','רוטב','עגבניות מרוסקות','קמח','סוכר','מלח','תבלין','תבלינים','קטניות','עדשים','שעועית','שימורים','טונה שימורים','מיונז','דבש','ריבה','זיתים','פסטו','קמח תפוח אדמה','אטריות','קינואה'],
  snacks:   ['במבה','ביסלי','תפוציפס','שוקולד','עוגיות','חטיף','סוכריות','קרמבו','ופל','חלבה','פופקורן','אגוזים','שקדים','בוטנים','פיסטוק','גרנולה'],
  drinks:   ['מים','קולה','ספרייט','מיץ','שתייה','בירה','סודה','משקה','קפה','תה','יין','רד בול','טוויסטר'],
  frozen:   ['קפוא','קפואים','מלאווח','גחנון','ג׳חנון','פיש סטיקס','כופתאות','פלאפל קפוא'],
  cleaning: ['סבון','שמפו','מרכך','אקונומיקה','כביסה','אבקת כביסה','מרכך כביסה','חומר ניקוי','ניקוי','ספוג','דיאודורנט','קרם','תחליב','גילוח','מברשת שיניים','מגבונים'],
  baby:     ['חיתולים','חיתול','מטרנה','סימילאק','מגבונים לתינוק','מוצץ','בקבוק תינוק','פורמולה','מזון לתינוק','קרם תינוק','שמפו תינוק'],
  home:     ['נרות','חד פעמי','כוסות','צלחות','שקיות','שקיות ניילון','אלומיניום','תבנית','מפיות','קופסאות','כלי בית'],
  impulse:  ['מצית','גפרורים'],
  other:    [],
};

function _normText(s) { return (s || '').toLowerCase().trim(); }

function getItemDepartment(item) {
  const text = _normText(
    [item.name, item.attached && item.attached.name, item.attached && item.attached.brand]
      .filter(Boolean).join(' ')
  );
  for (const [phrase, deptId] of DEPT_OVERRIDES) {
    if (text.includes(_normText(phrase))) return DEPARTMENTS.find(d => d.id === deptId);
  }
  for (const dept of DEPARTMENTS) {
    if (dept.id === 'other') continue;
    const kws = DEPT_KEYWORDS[dept.id] || [];
    if (kws.some(kw => text.includes(_normText(kw)))) return dept;
  }
  return DEPARTMENTS.find(d => d.id === 'other');
}

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

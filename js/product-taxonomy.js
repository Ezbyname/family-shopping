// ── DEPARTMENT GROUPING (Stage 4) ──────────────────────────────────────────
// Presentation-only. No Firebase writes. Department is derived at render time.
// Single source of truth — imported by app.js (browser) and tests/dept-classifier.test.js (Node).
export const DEPARTMENTS = [
  { id:'produce',  label:'פירות וירקות',                    order:1,  icon:'🥦' },
  { id:'bakery',   label:'מאפייה',                          order:2,  icon:'🍞' },
  { id:'seasonal', label:'פרחים ועונתי',                    order:3,  icon:'🌸' },
  { id:'deli',     label:'מעדנייה וגבינות',                 order:4,  icon:'🧀' },
  { id:'meat',     label:'בשר ודגים',                       order:5,  icon:'🥩' },
  { id:'dairy',    label:'חלב וביצים',                      order:6,  icon:'🥛' },
  { id:'pantry',   label:'בישול, שימורים ומזווה',           order:7,  icon:'🥫' },
  { id:'snacks',   label:'חטיפים ומתוקים',                  order:8,  icon:'🍫' },
  { id:'drinks',   label:'משקאות',                          order:9,  icon:'🧃' },
  { id:'frozen',   label:'קפואים ומוכנים',                  order:10, icon:'🧊' },
  { id:'cleaning', label:'ניקיון וטואלטיקה',                order:11, icon:'🧹' },
  { id:'baby',     label:'תינוקות',                         order:12, icon:'👶' },
  { id:'home',     label:'כלי בית ושונות',                  order:13, icon:'🏠' },
  { id:'impulse',  label:'קו קופות / קטן ואימפולסיבי',     order:14, icon:'🛍' },
  { id:'other',    label:'אחר',                             order:15, icon:'🛒' },
];

// Explicit phrase overrides — checked before keyword scanning. More-specific wins.
// Sorted by phrase length descending so longer phrases match before shorter ones.
export const DEPT_OVERRIDES = [
  // Drinks disambiguation (juice beats produce)
  ['מיץ תפוזים','drinks'], ['מיץ תפוז','drinks'], ['מיץ ענבים','drinks'],
  ['מיץ תפוחים','drinks'], ['מיץ אשכוליות','drinks'],
  // Frozen beats everything (explicit "קפוא" in phrase)
  ['שניצל קפוא','frozen'], ['פיצה קפואה','frozen'], ['ירקות קפואים','frozen'],
  ['בורקס קפוא','frozen'], ['ארוחה מוכנה','frozen'], ['מנה מוכנה','frozen'],
  // Hummus disambiguation: prepared/spread → deli; dry/canned → pantry
  ['ממרח חומוס','deli'], ['סלט חומוס','deli'], ['חומוס מוכן','deli'],
  ['חומוס יבש','pantry'], ['גרגרי חומוס','pantry'], ['חומוס שימורים','pantry'],
  // Cheese disambiguation — specific phrases → deli (before generic גבינה)
  ['גבינה צהובה','deli'], ['גבינה לבנה','deli'], ['גבינה עיזים','deli'],
  ['ממרח גבינה','deli'],
  // Cleaning specifics (override generic words)
  ['נייר טואלט','cleaning'], ['מגבות נייר','cleaning'], ['נוזל כלים','cleaning'],
  ['שקיות אשפה','cleaning'], ['משחת שיניים','cleaning'],
  // Home specifics
  ['נייר אפייה','home'], ['נייר כסף','home'], ['ניילון נצמד','home'],
  // Impulse: only very explicit phrases
  ['שוקולד קטן','impulse'], ['חטיף קטן','impulse'],
  // Chocolate bar → snacks (prevents dairy "שוקו" substring match on "שוקולד")
  // שוקולד קטן (longer) is checked first due to sort-by-length, so impulse still wins there.
  ['שוקולד','snacks'],
  // Ice cream → frozen (prevent snacks match on גלידה keyword)
  ['גלידה','frozen'],
  // Chewing gum → impulse only
  ['מסטיק','impulse'],
].sort((a,b) => b[0].length - a[0].length); // longest phrase first

export const DEPT_KEYWORDS = {
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

// Normalize text for classification: lowercase, trim
export function _normText(s) { return (s || '').toLowerCase().trim(); }

// Classify a single item to a DEPARTMENTS entry. Never writes to Firebase or item.order.
export function getItemDepartment(item) {
  const text = _normText(
    [item.name, item.attached && item.attached.name, item.attached && item.attached.brand]
      .filter(Boolean).join(' ')
  );
  // 1. Explicit phrase overrides (longest-first, deterministic)
  for (const [phrase, deptId] of DEPT_OVERRIDES) {
    if (text.includes(_normText(phrase))) {
      return DEPARTMENTS.find(d => d.id === deptId);
    }
  }
  // 2. Keyword rules in department order (deterministic: DEPARTMENTS array order)
  for (const dept of DEPARTMENTS) {
    if (dept.id === 'other') continue;
    const kws = DEPT_KEYWORDS[dept.id] || [];
    if (kws.some(kw => text.includes(_normText(kw)))) return dept;
  }
  // 3. Fallback
  return DEPARTMENTS.find(d => d.id === 'other');
}

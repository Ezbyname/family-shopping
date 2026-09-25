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
  // Avocado spread → deli (avocado alone stays produce)
  ['ממרח אבוקדו','deli'],
  // Cheese disambiguation — specific phrases → deli (before generic גבינה)
  ['גבינה צהובה','deli'], ['גבינה לבנה','deli'], ['גבינה עיזים','deli'],
  ['ממרח גבינה','deli'],
  // Pepper spices → pantry (not fresh produce)
  ['פלפל שחור','pantry'], ['פלפל לבן','pantry'], ['פלפל אדום טחון','pantry'],
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

// ── PRODUCE TAXONOMY (Commit 2) ───────────────────────────────────────────────
// Exact-match aliases. Used by _produceAliasSet for O(1) lookup.
// Each entry: canonical name + all accepted spelling/plural variants.
// DEPT_KEYWORDS.produce is intentionally [] — all produce matching goes through this.
export const PRODUCE_TAXONOMY = [
  // ── Tomatoes ──────────────────────────────────────────────────────────────
  { canonical:'עגבנייה',        aliases:['עגבנייה','עגבניה','עגבניות','עגבנייות','עגבנייה גדולה','עגבניה גדולה'] },
  { canonical:'עגבניות שרי',    aliases:['עגבניות שרי','עגבנייות שרי','עגבנייה שרי','עגבניה שרי','עגבניות מיני','עגבניות קוקטייל','עגבנייה קוקטייל','עגבנייה מיני','שרי','מיני עגבניות'] },

  // ── Cucumbers ─────────────────────────────────────────────────────────────
  { canonical:'מלפפון',         aliases:['מלפפון','מלפפונים','מלפפון שמש','מלפפון מיני','מלפפון אנגלי','מיני מלפפון'] },

  // ── Peppers (fresh only; black/white pepper overrides go to pantry) ────────
  { canonical:'פלפל',           aliases:['פלפל','פלפלים','פלפל ירוק','פלפל אדום','פלפל צהוב','פלפל כתום','פלפל מתוק','פלפל חריף','פלפל בנגורה','בנגורה','צ’ילי','צ״ילי'] },

  // ── Onion family ──────────────────────────────────────────────────────────
  { canonical:'בצל',            aliases:['בצל','בצלים','בצל לבן','בצל סגול','בצל אדום','בצל ירוק','בצל יבש'] },
  { canonical:'כרישה',          aliases:['כרישה','כרישות'] },
  { canonical:'שאלוט',          aliases:['שאלוט','שאלוטים','שאלט'] },
  { canonical:'שום',            aliases:['שום','שום טרי','ראש שום','שיני שום','שן שום'] },

  // ── Root vegetables ───────────────────────────────────────────────────────
  { canonical:'גזר',            aliases:['גזר','גזרים','גזריות','בייבי גזר','גזר מיני'] },
  { canonical:'תפוח אדמה',      aliases:['תפוח אדמה','תפוחי אדמה','תפו"א','תפוא','תפו אדמה'] },
  { canonical:'בטטה',           aliases:['בטטה','בטטות','ביטאטו'] },
  { canonical:'סלק',            aliases:['סלק','סלקים','שורש סלק'] },
  { canonical:'לפת',            aliases:['לפת','לפות'] },
  { canonical:'צנון',           aliases:['צנון','צנונות','צנוניות'] },
  { canonical:'שורש סלרי',      aliases:['שורש סלרי','שורש סלרי','שורשי סלרי'] },
  { canonical:'שורש פטרוזיליה', aliases:['שורש פטרוזיליה','שורשי פטרוזיליה','שורש פטרוזיה'] },
  { canonical:'ג״ינג״ר', aliases:['ג״ינג״ר','ג״ינג״ר טרי','ג׳ינג׳ר','ג׳ינג׳ר טרי','זנגביל'] },
  { canonical:'כורכום טרי',      aliases:['כורכום טרי','שורש כורכום'] },

  // ── Cabbage family ────────────────────────────────────────────────────────
  { canonical:'כרוב',           aliases:['כרוב','כרוב לבן','כרוב אדום','כרוב סגול','כרובים'] },
  { canonical:'כרובית',         aliases:['כרובית','כרוביות'] },
  { canonical:'ברוקולי',        aliases:['ברוקולי','ברוקולי ירוק','ברוקולי סגול','ברוקולים'] },
  { canonical:'כרוב ניצנים',    aliases:['כרוב ניצנים','ניצני כרוב','בריסל'] },
  { canonical:'קולרבי',         aliases:['קולרבי'] },

  // ── Leafy greens ──────────────────────────────────────────────────────────
  { canonical:'חסה',            aliases:['חסה','חסות','חסה גלילית','חסה רומית','חסה כרובית','חסה איזביט','רוקט','חסה ערבית'] },
  { canonical:'תרד',            aliases:['תרד','תרדים'] },
  { canonical:'מנגולד',         aliases:['מנגולד','מנגולד ירוק','מנגולד אדום'] },
  { canonical:'קייל',           aliases:['קייל','קייל ירוק','קייל גבשושי','קייל צבעוני'] },

  // ── Fresh herbs ───────────────────────────────────────────────────────────
  { canonical:'פטרוזיליה',      aliases:['פטרוזיליה','פטרוזיה','פטרוזיליה קרלד','פטרוזיליה חלקה','פטרוזיה קרלד','פטרוזיה חלקה'] },
  { canonical:'כוסברה',         aliases:['כוסברה','כוזברה'] },
  { canonical:'שמיר',           aliases:['שמיר'] },
  { canonical:'בזיליקום',       aliases:['בזיליקום','בזיליקום ירוק','בזיליקום סגול','ריחן'] },
  { canonical:'נענע',           aliases:['נענע','נענע ירוקה'] },
  { canonical:'עירית',          aliases:['עירית','עירית ירוקה'] },
  { canonical:'מרווה',          aliases:['מרווה'] },
  { canonical:'טימין',          aliases:['טימין','טימין טרי'] },
  { canonical:'רוזמרין',        aliases:['רוזמרין','רוזמרין טרי'] },
  { canonical:'אורגנו',         aliases:['אורגנו','אורגנו טרי'] },
  { canonical:'עשבי תיבול',     aliases:['עשבי תיבול','צרור עשבי תיבול'] },
  { canonical:'סלרי',           aliases:['סלרי','סלרי ירוק','סלרי עלים','ענפי סלרי'] },

  // ── Squash / Eggplant ─────────────────────────────────────────────────────
  { canonical:'קישוא',          aliases:['קישוא','קישואים','קישוא ירוק','קישוא צהוב'] },
  { canonical:'חציל',           aliases:['חציל','חצילים','חציל ארוך','חציל גדול','חציל עגול','חציל תאילנדי'] },
  { canonical:'דלעת',           aliases:['דלעת','דלעות','דלורית','דלעת חמאה','דלעת חמאת','דלעת ספגטי'] },

  // ── Other vegetables ──────────────────────────────────────────────────────
  { canonical:'תירס',           aliases:['תירס','תירס מתוק','קלח תירס','קלחי תירס'] },
  { canonical:'אפונה',          aliases:['אפונה','אפונה ירוקה','אפונה טרייה','אפונות'] },
  { canonical:'שעועית ירוקה',   aliases:['שעועית ירוקה','שעועית אספרגוס','שעועית צהובה','פאסוליה ירוקה'] },
  { canonical:'אספרגוס',        aliases:['אספרגוס','אספרגוסים'] },
  { canonical:'ארטישוק',        aliases:['ארטישוק','ארטישוקים'] },
  { canonical:'שומר',           aliases:['שומר','שומרים','שומר פלורנטין'] },
  { canonical:'אבוקדו',         aliases:['אבוקדו','אבוקדואים','אבוקדו האס','אבוקדו שחור'] },
  { canonical:'פטריות',         aliases:['פטריות','פטרייה','שמפיניון','פטריות שמן','פטריות שיטאקה','פטריות פורטובלו','פטריות אוסטר','פטריות מעורבות','פטריות יער','פטריות ממולאות'] },

  // ── Citrus fruits ─────────────────────────────────────────────────────────
  { canonical:'לימון',          aliases:['לימון','לימונים','לימון צהוב','לימון ירוק','ליים'] },
  { canonical:'תפוז',           aliases:['תפוז','תפוזים','תפוזי שתייה'] },
  { canonical:'קלמנטינה',       aliases:['קלמנטינה','קלמנטינות','מנדרינה','מנדרינות'] },
  { canonical:'אשכולית',        aliases:['אשכולית','אשכוליות','גרייפ פרוט','גרייפ','פומלה','פומלו'] },

  // ── Apple / Pear ──────────────────────────────────────────────────────────
  { canonical:'תפוח',           aliases:['תפוח','תפוחים','תפוח גאלה','תפוח פינק ליידי','תפוח גרני','תפוח עץ','תפוחים ירוקים','תפוחים אדומים','תפוח אדום','תפוח ירוק'] },
  { canonical:'אגס',            aliases:['אגס','אגסים','אגס בושק','אגס ירוק','אגס צהוב'] },
  { canonical:'חבוש',           aliases:['חבוש','חבושים'] },

  // ── Stone fruits ──────────────────────────────────────────────────────────
  { canonical:'אפרסק',          aliases:['אפרסק','אפרסקים','אפרסק לבן','אפרסק צהוב'] },
  { canonical:'נקטרינה',        aliases:['נקטרינה','נקטרינות','נקטרין'] },
  { canonical:'שזיף',           aliases:['שזיף','שזיפים','שזיף שחור','שזיף אדום','פלאם'] },
  { canonical:'מישמיש',         aliases:['מישמיש','מישמישים','אפריקוט'] },
  { canonical:'דובדבן',         aliases:['דובדבן','דובדבנים','צ״רי','צ’רי'] },

  // ── Tropical fruits ───────────────────────────────────────────────────────
  { canonical:'בננה',           aliases:['בננה','בננות','בננה צהובה','בננה קטנה'] },
  { canonical:'מנגו',           aliases:['מנגו','מנגואים','מנגו ישראלי'] },
  { canonical:'אננס',           aliases:['אננס','אננסים'] },
  { canonical:'פפאיה',          aliases:['פפאיה','פפאיות'] },
  { canonical:'קוקוס',          aliases:['קוקוס'] },
  { canonical:'קיווי',          aliases:['קיווי','קיוויים'] },
  { canonical:'ג״קפרוט',    aliases:['ג״קפרוט','ג’קפרוט','ג׳קפרוט'] },
  { canonical:'ליצ״י',      aliases:['ליצ״י','ליצ״ים','ליצ’י','ליצ’ים','לוקומי','ליצי'] },
  { canonical:'ספחי',           aliases:['ספחי','ספחיות'] },

  // ── Berries ───────────────────────────────────────────────────────────────
  { canonical:'תות שדה',        aliases:['תות שדה','תותי שדה','תות','תותים','תות ים','תות גן'] },
  { canonical:'אוכמניות',       aliases:['אוכמניות','בלוברי','אוכמנייה'] },
  { canonical:'פטל',            aliases:['פטל','פטלים','פטל אדום','פטל שחור'] },
  { canonical:'דומדמניות',      aliases:['דומדמניות','קראנברי','חמוציות'] },

  // ── Melons ────────────────────────────────────────────────────────────────
  { canonical:'מלון',           aliases:['מלון','מלונים','מלון ירוק','מלון כתום','מלון נטף','קנטלופ'] },
  { canonical:'אבטיח',          aliases:['אבטיח','אבטיחים','אבטיח מיני','מיני אבטיח'] },

  // ── Other fruits ──────────────────────────────────────────────────────────
  { canonical:'רימון',          aliases:['רימון','רימונים'] },
  { canonical:'ענבים',          aliases:['ענבים','ענב','ענבים לבנים','ענבים אדומים','ענבים שחורים','ענבי גינה','ענבים בלי גרעינים'] },
  { canonical:'תמר',            aliases:['תמר','תמרים','תמר מג״הול','תמר מג’הול','תמר דבש'] },
  { canonical:'תאנה',           aliases:['תאנה','תאנים','תאנה טרייה','תאנים טריות'] },
  { canonical:'שסק',            aliases:['שסק','שסקים','נספולה'] },
  { canonical:'פאסיפלורה',      aliases:['פאסיפלורה','פסיפלורה','גרנדילה','פרי פסיפלורה'] },
  { canonical:'לוטוס',          aliases:['לוטוס','שורש לוטוס'] },
  { canonical:'צבר',            aliases:['צבר','פרי צבר','תאנת שועל'] },

  // ── Generic terms (exact match only; substring behavior intentionally not restored) ─
  { canonical:'ירקות',          aliases:['ירק','ירקות','ירק טרי'] },
  { canonical:'פירות',          aliases:['פרי','פירות','פירות טריים'] },
];

// ── Internal: safe normalization for produce exact matching ───────────────────
// Normalizes for alias Set lookup: lowercase, trim, collapse spaces, hyphen→space,
// normalize gershayim variants, strip trailing weight suffixes (unit REQUIRED).
// A trailing bare number without a recognized unit is NOT stripped.
function _normForProduce(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[״"]/g, '"')                                        // normalize gershayim
    .replace(/-/g, ' ')                                           // hyphen → space
    .replace(/\s+/g, ' ')                                         // collapse spaces
    .replace(/\s+\d[\d.,]*\s*(גרם|ג"ר|ג׳ר|ג״ר|ק"ג|ק׳ג|ק״ג|קג|ליטר|מ"ל|מ׳ל|מ״ל|יח'|יחידות?|יחידה|יח׳|מ"ג|מ״ג|ס"מ|ס״מ|גר)\s*$/i, '')
    .trim()
    .replace(/\s+/g, ' ');
}

// ── Internal: Set of all normalized aliases for O(1) produce lookup ───────────
const _produceAliasSet = new Set(
  PRODUCE_TAXONOMY.flatMap(entry => entry.aliases.map(_normForProduce))
);

export const DEPT_KEYWORDS = {
  produce:  [], // intentionally empty — all produce matching via _produceAliasSet
  bakery:   ['לחם','לחמניה','לחמנייה','פיתה','בגט','חלה','עוגה','עוגת','עוגייה','עוגיות','מאפה','קרואסון','רוגלך','מאפינס'],
  seasonal: ['פרח','פרחים','עציץ','צמח','זר פרחים','קישוט','קישוטים'],
  deli:     ['גבינה','מוצרלה','קשקבל','פרמזן','ריקוטה','בולגרית','צפתית','גאודה','קולבי','פסטרמה','נקניק פרוס','סלמי','קוטג','סלטים'],
  meat:     ['עוף','בשר','שניצל','קציצות','דג','דגים','סלמון','טונה טרייה','הודו','פרגית','כנפיים','שוקיים','סטייק','קבב','בשר טחון','פילה','כבד','לברק','קרפיון','פורל','בקלה'],
  dairy:    ['חלב','ביצים','ביצה','יוגורט','שמנת','חמאה','שוקו','מעדן','אשל','מרגרינה'],
  pantry:   ['אורז','פסטה','פתיתים','קוסקוס','שמן','רוטב','עגבניות מרוסקות','קמח','סוכר','מלח','תבלין','תבלינים','כורכום','קטניות','עדשים','שעועית','שימורים','טונה שימורים','מיונז','דבש','ריבה','ריבת','זיתים','פסטו','קמח תפוח אדמה','אטריות','קינואה'],
  snacks:   ['במבה','ביסלי','תפוציפס','שוקולד','עוגיות','חטיף','סוכריות','קרמבו','ופל','חלבה','פופקורן','אגוזים','שקדים','בוטנים','פיסטוק','גרנולה'],
  drinks:   ['מים','קולה','ספרייט','מיץ','שתייה','בירה','סודה','משקה','קפה','תה','יין','רד בול','טוויסטר','שייק'],
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
  // 2. Produce exact alias match on item.name only (not concatenated text).
  //    attached.name/brand are intentionally excluded: they can contain words like
  //    "מרוסקות", "קפוא", "מיץ" that change classification and must not promote an
  //    item to Produce before the keyword scan has a chance to run.
  if (_produceAliasSet.has(_normForProduce(_normText(item.name || '')))) {
    return DEPARTMENTS.find(d => d.id === 'produce');
  }
  // 3. Keyword rules in department order (deterministic: DEPARTMENTS array order)
  for (const dept of DEPARTMENTS) {
    if (dept.id === 'other') continue;
    const kws = DEPT_KEYWORDS[dept.id] || [];
    if (kws.some(kw => text.includes(_normText(kw)))) return dept;
  }
  // 4. Fallback
  return DEPARTMENTS.find(d => d.id === 'other');
}

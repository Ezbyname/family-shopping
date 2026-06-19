// api/prices.js — v6.3.0
// GET /api/prices?barcode=&q=&lat=&lng=&radiusKm=&groupId=&userId=&debug=1
//
// Price priority (deterministic):
//   A. userPriceOverrides/{userId}/{barcode}/{key}   — personal only
//   B. prices/{barcode}/{chainId_storeId}            — official XML (primary)
//   C. proxyCache/{barcode}/{chainKey}               — proxy TTL 1h, only if no official
//   D. manualPrices/{groupId}/{barcode}/{entryId}    — family scoped, only if no official/proxy
//   E. priceReports — warning signal only, never shown as real price
//
// v6.2.0: ALL Firebase reads via fetch() REST API — eliminates Admin SDK WebSocket hang
// v6.3.0: storeCoords index support — lightweight {lat,lng,city} read instead of full stores node

import { restGet, getDbUrl, getAdminToken, haversine, setCors, isValidBarcode, isValidPrice } from './_firebase.js';

// ── Constants ────────────────────────────────────────────────────────────────
const INIT_TIMEOUT_MS  = 8_000;   // admin token fetch budget
const READ_TIMEOUT_MS  = 5_000;   // per restGet call
const BUILD_TIMEOUT_MS = 10_000;  // whole buildLayeredPrices budget
const STALE_MS         = 36 * 3_600_000; // 36 h
const MAX_PRICES       = 50;      // cap price list per barcode response
const STORE_CACHE_MS   = 5 * 60_000;     // 5 min store index cache

// ── Timeout helper ───────────────────────────────────────────────────────────
function withTimeout(promise, ms, label = '') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error(`timeout:${label}`), { isTimeout: true })),
        ms
      )
    ),
  ]);
}

// ── Store index cache (module-level, reused across requests) ─────────────────
// Prefers lightweight storeCoords/{key}={lat,lng,city} (~28 KB) over full
// stores node (~141 KB). Falls back to stores/ if storeCoords doesn't exist yet.
let _storeCache    = null;
let _storeCacheExp = 0;

async function getStoreIndex(dbUrl) {
  const now = Date.now();
  if (_storeCache && _storeCacheExp > now) return _storeCache;

  // Try storeCoords first (lightweight index written by price sync worker)
  try {
    const coordsData = await restGet(dbUrl, 'storeCoords', READ_TIMEOUT_MS);
    if (coordsData && typeof coordsData === 'object' && Object.keys(coordsData).length > 0) {
      // Normalize storeCoords {lat,lng,city} → stores-compatible shape
      _storeCache = Object.fromEntries(
        Object.entries(coordsData).map(([k, v]) => [k, {
          hasCoords: true,
          latitude:  v.lat ?? v.latitude ?? null,
          longitude: v.lng ?? v.longitude ?? null,
          city:      v.city || '',
        }])
      );
      _storeCacheExp = now + STORE_CACHE_MS;
      return _storeCache;
    }
  } catch (_) {}

  // Fallback: full stores node (pre-storeCoords deploy)
  const data = await restGet(dbUrl, 'stores', READ_TIMEOUT_MS);
  _storeCache    = (data && typeof data === 'object') ? data : {};
  _storeCacheExp = now + STORE_CACHE_MS;
  return _storeCache;
}

// ── Hebrew → English for Open Food Facts search ──────────────────────────────
// ~300 most popular ingredients in Israeli supermarkets, grouped by category.
// Plural forms are listed explicitly where the stem-stripping heuristic would
// produce a wrong or ambiguous result (e.g. ביצים, עגבניות).
const HE_EN = {
  // ── Dairy ────────────────────────────────────────────────────────────────
  'חלב':'milk','חלב 3%':'milk 3%','חלב 1%':'milk 1%','חלב 3 אחוז':'milk 3%',
  'חלב עיזים':'goat milk','חלב כבשים':'sheep milk','חלב סויה':'soy milk',
  'חלב שקדים':'almond milk','חלב קוקוס':'coconut milk',
  'גבינה':'cheese','גבינה לבנה':'white cheese','גבינה צהובה':'yellow cheese',
  'גבינה קשה':'hard cheese','גבינה מלוחה':'salty cheese',
  'גבינת עיזים':'goat cheese','גבינת פטה':'feta cheese',
  'גבינת מוצרלה':'mozzarella','גבינת עמק':'emek cheese',
  "קוטג'":'cottage cheese','קוטג':'cottage cheese',
  'שמנת':'cream','שמנת חמוצה':'sour cream','שמנת מתוקה':'heavy cream',
  'שמנת לבישול':'cooking cream',
  'יוגורט':'yogurt','יוגורט טבעי':'plain yogurt','יוגורט יווני':'greek yogurt',
  'לבן':'leben','גבינת ריקוטה':'ricotta',
  'חמאה':'butter','חמאה מלוחה':'salted butter','חמאה ללא מלח':'unsalted butter',
  'מרגרינה':'margarine',
  'ביצים':'eggs','ביצה':'egg','ביצי חופש':'free range eggs',
  'ביצים גדולות':'large eggs','ביצים קטנות':'small eggs',
  'גלידה':'ice cream','שמנת קפואה':'frozen cream',
  // ── Produce — Vegetables ──────────────────────────────────────────────────
  'עגבניות':'tomatoes','עגבנייה':'tomato','עגבניות שרי':'cherry tomatoes',
  'מלפפון':'cucumber','מלפפונים':'cucumbers','מלפפון חמוץ':'pickle',
  'בצל':'onion','בצלים':'onions','בצל סגול':'red onion','בצל ירוק':'green onion',
  'שום':'garlic','שיני שום':'garlic cloves',
  'גזר':'carrot','גזרים':'carrots',
  'תפוח אדמה':'potato','תפוחי אדמה':'potatoes','בטטה':'sweet potato',
  'ברוקולי':'broccoli','כרובית':'cauliflower','כרוב':'cabbage',
  'פלפל':'pepper','פלפל אדום':'red pepper','פלפל ירוק':'green pepper',
  'פלפל צהוב':'yellow pepper','פלפל חריף':'chili pepper',
  'חציל':'eggplant','קישוא':'zucchini','דלעת':'pumpkin','דלורית':'butternut squash',
  'תירס':'corn','תירס מתוק':'sweet corn',
  'אפונה':'peas','שעועית ירוקה':'green beans','שעועית':'beans',
  'גרגיר הנחלים':'watercress','תרד':'spinach','מנגולד':'chard',
  'חסה':'lettuce','רוקט':'arugula','עלי בייבי':'baby leaves',
  'כוסברה':'cilantro','פטרוזיליה':'parsley','שמיר':'dill',
  'בזיליקום':'basil','נענע':'mint','טימין':'thyme','רוזמרין':'rosemary',
  'כרישה':'leek','סלרי':'celery','פטריות':'mushrooms','פטריית שמפיניון':'mushroom',
  'אבוקדו':'avocado','ארטישוק':'artichoke','אספרגוס':'asparagus',
  'ג׳ינג׳ר':'ginger','כורכום':'turmeric','צנון':'radish',
  // ── Produce — Fruit ───────────────────────────────────────────────────────
  'תפוח':'apple','תפוחים':'apples','תפוח אדום':'red apple','תפוח ירוק':'green apple',
  'בננה':'banana','בננות':'banana',
  'תפוז':'orange','תפוזים':'oranges',
  'לימון':'lemon','לימונים':'lemons','ליים':'lime',
  'מנגו':'mango','ענבים':'grapes','אבטיח':'watermelon','מלון':'melon',
  'תות שדה':'strawberry','תותים':'strawberries','אוכמניות':'blueberries',
  'פטל':'raspberry','דובדבן':'cherry','משמש':'apricot',
  'אפרסק':'peach','שזיף':'plum','אגס':'pear','רימון':'pomegranate',
  'קיווי':'kiwi','אננס':'pineapple','פפאיה':'papaya','ליצ׳י':'lychee',
  'תמר':'date','תמרים':'dates','צימוקים':'raisins','שזיפים מיובשים':'prunes',
  'משמשים מיובשים':'dried apricots',
  // ── Pantry — Grains & Bread ───────────────────────────────────────────────
  'לחם':'bread','לחם מלא':'whole wheat bread','לחם שיפון':'rye bread',
  'לחם פיתה':'pita bread','פיתה':'pita','לחמניות':'rolls','בגט':'baguette',
  'לחם אחיד':'sliced bread',
  'קמח':'flour','קמח חיטה':'wheat flour','קמח מלא':'whole wheat flour',
  'קמח תירס':'corn flour','קמח כוסמת':'buckwheat flour','קמח שיפון':'rye flour',
  'אורז':'rice','אורז לבן':'white rice','אורז מלא':'brown rice',
  'אורז בסמטי':'basmati rice','אורז יסמין':'jasmine rice','אורז פרסי':'persian rice',
  'פסטה':'pasta','ספגטי':'spaghetti','מקרוני':'macaroni','פנה':'penne',
  'פוסילי':'fusilli','לינגוויני':'linguine','פפרדלה':'pappardelle',
  'אטריות':'noodles','כוסמת':'buckwheat','קינואה':'quinoa','בולגור':'bulgur',
  'כוסכוס':'couscous','פולנטה':'polenta','שעורה':'barley',
  'שיבולת שועל':'oatmeal','גרנולה':'granola','קורנפלקס':'cornflakes',
  'מוזלי':'muesli','דגני בוקר':'cereal',
  // ── Pantry — Oils, Sauces & Condiments ───────────────────────────────────
  'שמן זית':'olive oil','שמן זית כתית':'extra virgin olive oil',
  'שמן חמניות':'sunflower oil','שמן קנולה':'canola oil','שמן תירס':'corn oil',
  'שמן קוקוס':'coconut oil','שמן שומשום':'sesame oil',
  'שמן':'oil',
  'חומץ':'vinegar','חומץ תפוחים':'apple cider vinegar','חומץ בלסמי':'balsamic vinegar',
  'רוטב עגבניות':'tomato sauce','רוטב פסטה':'pasta sauce',
  'קטשופ':'ketchup','מיונז':'mayonnaise','חרדל':'mustard',
  'רוטב סויה':'soy sauce','רוטב טריאקי':'teriyaki sauce',
  'רוטב חריף':'hot sauce','טחינה גולמית':'raw tahini',
  'טחינה':'tahini','חומוס':'hummus','פסטו':'pesto',
  'ריבה':'jam','ריבת תות':'strawberry jam','ריבת משמש':'apricot jam',
  'ריבת תאנים':'fig jam','ריבת פירות יער':'berry jam',
  'דבש':'honey','סירופ מייפל':'maple syrup','ממרח שוקולד':'chocolate spread',
  'חמאת בוטנים':'peanut butter','ממרח שקדים':'almond butter',
  // ── Pantry — Sugar, Salt & Spices ────────────────────────────────────────
  'סוכר':'sugar','סוכר לבן':'white sugar','סוכר חום':'brown sugar',
  'סוכר דקל':'palm sugar','סטיביה':'stevia','אריתריטול':'erythritol',
  'מלח':'salt','מלח ים':'sea salt','מלח שולחן':'table salt','מלח הימלאיה':'himalayan salt',
  'פלפל שחור':'black pepper','פלפל לבן':'white pepper','פפריקה':'paprika',
  'כמון':'cumin','כורכום':'turmeric','קינמון':'cinnamon','כרכום':'saffron',
  'אגוז מוסקט':'nutmeg','הל':'cardamom','ציפורן':'cloves','אניס':'anise',
  'זעתר':'za\'atar','בהרט':'baharat','כמון טחון':'ground cumin',
  'שומשום':'sesame','פרג':'poppy seeds','זרעי פשתן':'flax seeds',
  'זרעי צ׳יה':'chia seeds','זרעי חמניות':'sunflower seeds',
  'אבקת שום':'garlic powder','אבקת בצל':'onion powder',
  'אורגנו':'oregano','בזיליקום יבש':'dried basil',
  // ── Pantry — Canned & Preserved ──────────────────────────────────────────
  'טונה':'tuna','טונה בשמן':'tuna in oil','טונה במים':'tuna in water',
  'סרדינים':'sardines','מקרל':'mackerel','סלמון משומר':'canned salmon',
  'עגבניות מרוסקות':'crushed tomatoes','רסק עגבניות':'tomato paste',
  'עגבניות שלמות משומרות':'canned whole tomatoes',
  'שעועית משומרת':'canned beans','גרגרי חומוס משומרים':'canned chickpeas',
  'עדשים':'lentils','עדשים כתומות':'red lentils','עדשים שחורות':'black lentils',
  'אפונה משומרת':'canned peas','תירס משומר':'canned corn',
  'זיתים':'olives','זיתים שחורים':'black olives','זיתים ירוקים':'green olives',
  // ── Pantry — Baking ───────────────────────────────────────────────────────
  'שוקולד':'chocolate','שוקולד מריר':'dark chocolate','שוקולד חלב':'milk chocolate',
  'שוקולד לבן':'white chocolate','טבלת שוקולד':'chocolate bar',
  'קקאו':'cocoa','אבקת קקאו':'cocoa powder',
  'אבקת אפייה':'baking powder','סודה לשתייה':'baking soda',
  'שמרים':'yeast','שמרים יבשים':'dry yeast',
  'וניל':'vanilla','תמצית וניל':'vanilla extract',
  'קמח תופח':'self-rising flour','עמילן תירס':'corn starch',
  'ג׳לטין':'gelatin','אגר אגר':'agar agar',
  'שקדים':'almonds','אגוזי מלך':'walnuts','קשיו':'cashews',
  'בוטנים':'peanuts','פיסטוקים':'pistachios','אגוזי לוז':'hazelnuts',
  'קוקוס מגורד':'shredded coconut','שמן קוקוס':'coconut oil',
  // ── Beverages ─────────────────────────────────────────────────────────────
  'קפה':'coffee','קפה טחון':'ground coffee','קפה נמס':'instant coffee',
  'קפה אספרסו':'espresso','קפסולות קפה':'coffee capsules',
  'תה':'tea','תה ירוק':'green tea','תה שחור':'black tea','תה צמחים':'herbal tea',
  'תה נענע':'mint tea','תה קמומיל':'chamomile tea',
  'מים':'water','מים מינרלים':'mineral water','מים מוגזים':'sparkling water',
  'מיץ תפוזים':'orange juice','מיץ תפוחים':'apple juice',
  'מיץ ענבים':'grape juice','מיץ גזר':'carrot juice',
  'מיץ אשכולית':'grapefruit juice','מיץ לימון':'lemon juice',
  'מיץ':'juice','מיץ טבעי':'natural juice',
  'סודה':'soda','מי ברז':'tap water',
  'שייק':'shake','שייק חלב':'milkshake',
  // ── Meat & Fish ───────────────────────────────────────────────────────────
  'עוף':'chicken','חזה עוף':'chicken breast','שוקיים':'chicken thighs',
  'כנפיים':'chicken wings','פרגית':'young chicken','שניצל עוף':'chicken schnitzel',
  'בשר בקר':'beef','בשר טחון':'ground beef','סטייק':'steak',
  'אנטריקוט':'entrecote','פילה בקר':'beef fillet',
  'כבש':'lamb','טלה':'lamb','בשר עגל':'veal',
  'הודו':'turkey','חזה הודו':'turkey breast','שניצל הודו':'turkey schnitzel',
  'נקניק':'sausage','נקניקיות':'frankfurters','קבב':'kebab',
  'המבורגר':'hamburger','פלאפל':'falafel',
  'סלמון':'salmon','דג':'fish','דג ים':'sea fish','דג מוסר':'sea bass',
  'דג ברמונדי':'barramundi','בורי':'mullet','קרפיון':'carp',
  'שרימפס':'shrimp','קלמרי':'calamari','סושי':'sushi',
  // ── Snacks & Sweets ───────────────────────────────────────────────────────
  'במבה':'bamba','ביסלי':'bisli','אפקים':'tapuchips',
  'עוגיות':'cookies','ביסקוויטים':'biscuits','קרקרים':'crackers',
  'צ׳יפס':'chips','פופקורן':'popcorn','פריכיות':'rice cakes',
  'עוגה':'cake','עוגת שוקולד':'chocolate cake','מאפינס':'muffins',
  'לחמניית מתוקה':'sweet bun','קרואסון':'croissant','דנמרקי':'danish pastry',
  'גומי':'gummy candy','סוכריות':'candy','שוקולד ממולא':'filled chocolate',
  // ── Household essentials ──────────────────────────────────────────────────
  'נייר טואלט':'toilet paper','מגבות נייר':'paper towels',
  'שקיות אשפה':'garbage bags','נייר אלומיניום':'aluminum foil',
  'ניילון נצמד':'plastic wrap','כוסות חד פעמי':'disposable cups',
  'סבון':'soap','סבון ידיים':'hand soap','סבון גוף':'body wash',
  'שמפו':'shampoo','מרכך שיער':'conditioner',
  'אבקת כביסה':'laundry detergent','נוזל כביסה':'liquid detergent',
  'מרכך כביסה':'fabric softener','נוזל כלים':'dish soap',
  'חומר ניקוי':'cleaning agent','אקונומיקה':'bleach',
};

const isHebrew = s => /[֐-׿]/.test(s);

// Dictionary-backed plural normalization — strips common Hebrew suffixes only
// when the resulting stem exists in HE_EN. Never returns a raw stem (safe).
const _singularLookup = w => {
  // Try longest suffix first: ות before ת, ים before י
  for (const sfx of ['ות', 'ים', 'יות', 'יים', 'י', 'ת']) {
    if (w.length > sfx.length + 2 && w.endsWith(sfx)) {
      const stem = w.slice(0, -sfx.length);
      if (HE_EN[stem]) return HE_EN[stem];
    }
  }
  return null;
};

const translate = q => {
  const l = q.trim();
  // 1. Exact phrase match (highest precision — covers "מיץ תפוזים" etc.)
  if (HE_EN[l]) return HE_EN[l];
  // 2. Substring / superstring match (handles "שמן זית" ↔ "שמן")
  for (const [h, e] of Object.entries(HE_EN)) if (l.includes(h) || h.includes(l)) return e;
  // 3. Plural suffix stripping — dictionary-backed only, no garbage stems
  for (const w of l.split(/\s+/)) {
    const hit = _singularLookup(w);
    if (hit) return hit;
  }
  return null;
};

// ── Relevance scoring (Hebrew-aware) ─────────────────────────────────────────
// Normalizes Hebrew/English product text so that "חלב 3%", "חלב 3 אחוז" and
// "תנובה חלב 3%" collapse to comparable token sets. Pure + deterministic so it
// can be unit-tested in isolation.
export function normalizeProductText(s) {
  if (!s) return '';
  let t = String(s).toLowerCase();
  // Hebrew final letters → standard forms
  t = t.replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ').replace(/ף/g, 'פ').replace(/ץ/g, 'צ');
  // Percent: "3 אחוז" / "3%" → "3"
  t = t.replace(/אחוז/g, '%').replace(/%/g, ' ');
  // Unit normalization → canonical tokens
  t = t.replace(/מ["'׳]?ל|ml|מיליליטר/g, ' ml ');
  t = t.replace(/ק["'׳]?ג|קילו(?:גרם)?|kg/g, ' kg ');
  t = t.replace(/ליטר|ל["'׳]/g, ' l ');
  t = t.replace(/גרם|ג["'׳]|gr?\b/g, ' g ');
  // Strip punctuation / quotes / apostrophes
  t = t.replace(/["'`׳״.,()\[\]/\\\-_+]/g, ' ');
  // Collapse whitespace
  return t.replace(/\s+/g, ' ').trim();
}

function _tokens(s) { return normalizeProductText(s).split(' ').filter(Boolean); }

// Score one product name against one query string (both pre-normalized inside).
// Returns 0–100. Head-noun (first token) match is weighted so that the product
// TYPE wins: "חלב תנובה" outranks "שוקולד חלב" for query "חלב".
function _scoreOne(query, name) {
  const qn = normalizeProductText(query);
  const nn = normalizeProductText(name);
  if (!qn || !nn) return 0;
  if (nn === qn) return 100;
  if (nn.startsWith(qn + ' ') || nn === qn) return 94;

  const qTok = qn.split(' ').filter(Boolean);
  const nTok = nn.split(' ').filter(Boolean);
  const nSet = new Set(nTok);
  const matched = qTok.filter(t => nSet.has(t)).length;
  const coverage = qTok.length ? matched / qTok.length : 0;

  let base;
  if (coverage >= 1)        base = 80;            // all query tokens present
  else if (coverage >= 0.5) base = 50 + coverage * 25;
  else if (nn.includes(qn)) base = 50;            // loose substring
  else                      base = coverage * 40; // weak

  // Head-noun bonus: query's first token IS the product's first token → it's
  // the main product type, not an incidental mention.
  if (qTok[0] && nTok[0] === qTok[0]) base += 10;
  // Starts-with the full query → strong
  if (nn.startsWith(qn)) base += 6;

  return Math.min(100, Math.round(base));
}

// Best score across Hebrew query, English query, and the product brand line.
export function scoreProductMatch(heQuery, enQuery, product, _debugOut) {
  const name  = product.name || '';
  const brand = product.brand || '';
  const nameScore = Math.max(
    _scoreOne(heQuery, name),
    enQuery && enQuery !== heQuery ? _scoreOne(enQuery, name) : 0
  );
  // Brand-only match (query is a brand like "תנובה") gives a moderate score.
  const brandScore = Math.max(
    _scoreOne(heQuery, brand),
    enQuery && enQuery !== heQuery ? _scoreOne(enQuery, brand) : 0
  );
  let score = Math.max(nameScore, brandScore * 0.6);
  if (product.isIsraeli) score += 6;   // modest tiebreaker, never dominant
  const final = Math.round(Math.min(100, score));
  if (_debugOut) {
    _debugOut.normalizedQuery = normalizeProductText(heQuery);
    _debugOut.normalizedName  = normalizeProductText(name);
    _debugOut.normalizedBrand = normalizeProductText(brand);
    _debugOut.nameScore  = nameScore;
    _debugOut.brandScore = brandScore;
    _debugOut.isIsraeli  = !!product.isIsraeli;
  }
  return final;
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const t0 = Date.now();
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { barcode, q, lat, lng, radiusKm, groupId, userId, debug, debugScore } = req.query || {};
  const isDebug      = debug === '1' || debug === 'true';
  const isDebugScore = debugScore === '1' || debugScore === 'true';
  const timings = { initMs: 0, priceReadMs: 0, storeReadMs: 0, totalMs: 0 };

  const userLat = parseFloat(lat  || '');
  const userLng = parseFloat(lng  || '');
  const radius  = parseFloat(radiusKm || '0');
  const hasLoc  = !isNaN(userLat) && !isNaN(userLng) && radius > 0;

  // ── MODE A: Direct barcode lookup ─────────────────────────────────────────
  if (barcode) {
    const clean = String(barcode).replace(/\D/g, '');
    if (!isValidBarcode(clean)) return res.status(400).json({ error: 'Invalid barcode' });

    const dbUrl = getDbUrl();
    if (!dbUrl) {
      timings.totalMs = Date.now() - t0;
      return res.status(503).json({
        barcode: clean, prices: [], source: 'none',
        error: 'Firebase not initialized (missing FIREBASE_DATABASE_URL)',
        ...(isDebug ? { timings } : {}),
      });
    }

    // Pre-warm admin token (measures cold-start OAuth2 fetch; ~0 ms on warm)
    const tInit = Date.now();
    await getAdminToken().catch(() => {});
    timings.initMs = Date.now() - tInit;

    // Build prices with hard total budget
    try {
      const result = await withTimeout(
        buildLayeredPrices(dbUrl, clean, userId, groupId, hasLoc, userLat, userLng, radius, timings),
        BUILD_TIMEOUT_MS,
        'buildLayeredPrices'
      );
      timings.totalMs = Date.now() - t0;

      const response = { version: '6.3.0', barcode: clean, ...result };
      if (isDebug) response.timings = timings;
      return res.status(200).json(response);

    } catch (e) {
      timings.totalMs = Date.now() - t0;
      const isTimeoutLike = e.isTimeout || e.name === 'TimeoutError' || e.name === 'AbortError';
      if (isTimeoutLike) {
        console.error(`[prices] build timeout ${timings.totalMs}ms barcode=${clean}`);
        return res.status(504).json({
          error: 'Firebase read timed out',
          message: 'Price lookup timed out — try again in a moment',
          barcode: clean,
          ...(isDebug ? { timings } : {}),
        });
      }
      console.error('[prices] barcode error:', e.message);
      return res.status(200).json({
        barcode: clean, prices: [], source: 'firebase_cache',
        isStale: true, lastUpdated: null,
        warning: 'Price data temporarily unavailable — please try again',
        error: e.message,
        ...(isDebug ? { timings } : {}),
      });
    }
  }

  // ── MODE B: Product name search ───────────────────────────────────────────
  if (!q || String(q).trim().length < 2)
    return res.status(400).json({ error: 'Provide ?barcode= or ?q=' });

  const query  = String(q).trim();
  const hebrew = isHebrew(query);
  const en     = hebrew ? (translate(query) || query) : query;
  console.log(`[prices v6.3] search: "${query}" → "${en}"`);

  const dbUrl = getDbUrl();

  try {
    const tInit = Date.now();
    // OFF search + token pre-warm in parallel
    const [offProducts] = await Promise.all([
      searchOFF(query, en),
      getAdminToken().catch(() => {}),
    ]);
    timings.initMs = Date.now() - tInit;

    // Load store index once for radius filtering (search mode)
    let storeIndex = {};
    if (hasLoc && dbUrl) {
      try {
        const tStore = Date.now();
        storeIndex = await getStoreIndex(dbUrl);
        timings.storeReadMs = Date.now() - tStore;
      } catch (_) {}
    }

    const enriched = await Promise.all(offProducts.map(async p => {
      if (!p.barcode || !isValidBarcode(p.barcode) || !dbUrl)
        return { ...p, prices: [], source: 'none' };
      const layered = await buildLayeredPrices(
        dbUrl, p.barcode, userId, groupId,
        hasLoc, userLat, userLng, radius, {},
        storeIndex
      ).catch(() => ({ prices: [], source: 'none', communityWarning: null }));
      return { ...p, ...layered };
    }));

    // Relevance score per product (deterministic, Hebrew-aware)
    for (const p of enriched) {
      const dbg = isDebugScore ? {} : undefined;
      p._score = scoreProductMatch(query, en, p, dbg);
      if (isDebugScore) p._debug = dbg;
    }

    // Rank: relevance first, then availability (has prices), then source quality.
    // This ensures "חלב תנובה" beats "שוקולד חלב"/"Kinder Chocolate" for query "חלב".
    const ORDER = { official: 0, override: 0, proxy: 1, manual: 2, none: 3 };
    enriched.sort((a, b) =>
      (b._score - a._score) ||
      ((b.prices?.length ? 1 : 0) - (a.prices?.length ? 1 : 0)) ||
      ((ORDER[a.source] ?? 3) - (ORDER[b.source] ?? 3)) ||
      ((b.prices?.length || 0) - (a.prices?.length || 0))
    );

    // Drop weak matches. Fallback ladder:
    //   1. strong (score ≥ 50) — preferred
    //   2. MIN_FALLBACK_SCORE threshold — blocks isIsraeli-only and weak partial-English matches
    //   3. everything — last resort so we never return empty
    const MIN_FALLBACK_SCORE = 10;
    const strong = enriched.filter(p => p._score >= 50);
    const hasAny = enriched.filter(p => p._score >  MIN_FALLBACK_SCORE);
    const ranked = strong.length >= 3 ? strong
                 : hasAny.length  >= 3 ? hasAny
                 : enriched;

    if (isDebugScore) {
      console.log(`[search-audit] query="${query}" en="${en}" ` +
        `candidates=${enriched.length} strong=${strong.length} fallback=${hasAny.length}\n` +
        enriched.slice(0, 50).map((p, i) =>
          `${i + 1}. ${p.name} score=${p._score} israeli=${!!p.isIsraeli} src=${p.source}`
        ).join('\n')
      );
    }

    let syncStatus = null;
    if (dbUrl) {
      try {
        const data = await restGet(dbUrl, 'syncSummary', 3_000);
        if (data !== null) syncStatus = data;
      } catch (_) {}
    }

    timings.totalMs = Date.now() - t0;
    const results = ranked.slice(0, 20);
    if (!isDebugScore) results.forEach(p => { delete p._score; delete p._debug; });
    const response = {
      version: '6.3.2', query, englishQuery: en,
      results, total: ranked.length,
      syncStatus,
    };
    if (isDebug) response.timings = timings;
    return res.status(200).json(response);

  } catch (e) {
    console.error('[prices] search error:', e.message);
    timings.totalMs = Date.now() - t0;
    return res.status(200).json({
      version: '6.3.0', query, results: [], error: e.message,
      ...(isDebug ? { timings } : {}),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLayeredPrices — core priority logic
// Returns { prices, source, isStale?, lastUpdated?, warning?, communityWarning }
//
// All Firebase reads go via restGet() (HTTP REST) — no Admin SDK WebSocket.
//
// Read strategy (sequential, not parallel):
//   1. Official + user-override in parallel (always needed)
//   2. If official found → read reports (for warnings), return
//   3. If no official → proxy + manual in parallel, return
//
// storeIndex: pass pre-loaded stores (search mode) or undefined to lazy-load (barcode mode)
// ─────────────────────────────────────────────────────────────────────────────
async function buildLayeredPrices(
  dbUrl, barcode, userId, groupId,
  hasLoc, lat, lng, radius,
  timings = {},           // filled by barcode-mode caller
  storeIndex = undefined  // undefined = lazy-load if hasLoc; object = already loaded
) {
  if (!dbUrl) return { prices: [], source: 'none', communityWarning: null };

  // ── Phase 1: Official + user-override (parallel, always needed) ──────────
  const tPrice = Date.now();
  const [officialData, overrideData] = await Promise.all([
    restGet(dbUrl, `prices/${barcode}`, READ_TIMEOUT_MS),
    userId
      ? restGet(dbUrl, `userPriceOverrides/${userId}/${barcode}`, READ_TIMEOUT_MS).catch(() => null)
      : Promise.resolve(null),
  ]);
  timings.priceReadMs = Date.now() - tPrice;

  const overrides = (overrideData && typeof overrideData === 'object') ? overrideData : {};

  // ── Process official prices ──────────────────────────────────────────────
  let official = [];
  if (officialData && typeof officialData === 'object') {
    official = Object.entries(officialData)
      .filter(([, p]) => p?.price > 0)
      .map(([key, p]) => ({
        ...p, _key: key, source: 'official',
        displayPrice: overrides[key]?.overridePrice ?? p.price,
        override:     overrides[key] ?? null,
      }));

    // Radius filter — use cached store index (prefers storeCoords, falls back to stores/)
    if (hasLoc && official.length > 0) {
      let idx = storeIndex;
      if (idx === undefined) {
        const tStore = Date.now();
        try {
          idx = await getStoreIndex(dbUrl);
        } catch (_) {
          idx = {};
        }
        timings.storeReadMs = Date.now() - tStore;
      }
      official = filterByRadius(official, lat, lng, radius, idx);
    }

    official.sort((a, b) => a.displayPrice - b.displayPrice);
  }

  // ── Return official result ───────────────────────────────────────────────
  if (official.length > 0) {
    let reportsData = null;
    try {
      reportsData = await restGet(dbUrl, `priceReports/${barcode}`, 3_000);
    } catch (_) {}

    const communityWarning = buildCommunityWarning(reportsData, official);
    const latestSync  = Math.max(...official.map(p => p.syncedAt || 0));
    const isStale     = !latestSync || (Date.now() - latestSync) > STALE_MS;
    const lastUpdated = latestSync ? new Date(latestSync).toISOString() : null;

    return {
      prices:    official.slice(0, MAX_PRICES),
      source:    'firebase_cache',
      isStale,
      lastUpdated,
      warning:   isStale ? 'Prices may be outdated — sync pending' : null,
      communityWarning,
    };
  }

  // ── Phase 2: No official — try proxy + manual in parallel ────────────────
  const [proxyData, manualData] = await Promise.all([
    restGet(dbUrl, `proxyCache/${barcode}`, READ_TIMEOUT_MS).catch(() => null),
    groupId
      ? restGet(dbUrl, `manualPrices/${groupId}/${barcode}`, READ_TIMEOUT_MS).catch(() => null)
      : Promise.resolve(null),
  ]);

  const now = Date.now();

  // C. Proxy cache (TTL 1 hour)
  let proxy = [];
  if (proxyData && typeof proxyData === 'object') {
    proxy = Object.values(proxyData)
      .filter(p => p?.price > 0 && (now - (p.fetchedAt || 0)) < 3_600_000)
      .map(p => ({ ...p, source: 'proxy', displayPrice: p.price }));
    if (hasLoc) {
      const idx = storeIndex ?? {};
      proxy = filterByRadius(proxy, lat, lng, radius, idx);
    }
    proxy.sort((a, b) => a.displayPrice - b.displayPrice);
  }

  if (proxy.length > 0) {
    return { prices: proxy.slice(0, MAX_PRICES), source: 'proxy', communityWarning: null };
  }

  // D. Manual family prices (groupId scoped)
  let manual = [];
  if (manualData && typeof manualData === 'object') {
    const seen = new Set();
    manual = Object.values(manualData)
      .filter(p => p?.price > 0)
      .map(p => ({ ...p, source: 'manual', displayPrice: p.price }))
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
      .filter(p => {
        const k = p.chainName || p.storeName || '';
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }

  if (manual.length > 0) {
    return { prices: manual.slice(0, MAX_PRICES), source: 'manual', communityWarning: null };
  }

  return { prices: [], source: 'none', communityWarning: null };
}

// ── Filter prices to stores within radius ────────────────────────────────────
function filterByRadius(prices, lat, lng, radius, storeIndex) {
  return prices.filter(p => {
    const key   = `${p.chainId || ''}_${p.storeId || ''}`;
    const store = storeIndex[key];
    if (!store?.hasCoords) return true; // include if no coords yet (pre-geocoding)
    const dist  = haversine(lat, lng, store.latitude, store.longitude);
    if (dist <= radius) {
      p.distanceKm  = Math.round(dist * 10) / 10;
      p.latitude    = store.latitude  ?? null;
      p.longitude   = store.longitude ?? null;
      p.address     = p.address  || store.address  || '';
      p.city        = p.city     || store.city     || '';
      return true;
    }
    return false;
  });
}

// ── Build community warning from price reports ────────────────────────────────
function buildCommunityWarning(reportsData, officialPrices) {
  if (!reportsData || typeof reportsData !== 'object') return null;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600_000;
  const warnings      = [];

  for (const [chainKey, chainReports] of Object.entries(reportsData)) {
    if (!chainReports) continue;
    const recent = Object.values(chainReports)
      .filter(r => r?.reportedAt && new Date(r.reportedAt).getTime() > thirtyDaysAgo);
    if (recent.length < 2) continue;

    const prices = recent.map(r => r.reportedPrice).filter(p => isValidPrice(p));
    if (!prices.length) continue;

    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const officialForChain = officialPrices.find(
      p => `${p.chainId || ''}_${p.storeId || ''}` === chainKey
    );
    if (officialForChain) {
      warnings.push({
        chainKey,
        chainName:     officialForChain.chainName || '',
        officialPrice: officialForChain.price,
        reportCount:   recent.length,
        reportedMin:   minP,
        reportedMax:   maxP,
        message: `${recent.length} משתמשים דיווחו מחיר שונה: ₪${minP.toFixed(2)}${minP !== maxP ? `–₪${maxP.toFixed(2)}` : ''}`,
      });
    }
  }
  return warnings.length > 0 ? warnings : null;
}

// ── Open Food Facts search — prefers Israeli products ─────────────────────────
async function searchOFF(hebrewQuery, englishQuery) {
  const seen = new Set(), results = [];
  const isHeb = isHebrew(hebrewQuery);
  const FIELDS = 'product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags';
  const OFF    = 'https://world.openfoodfacts.org/cgi/search.pl';
  const urls = [
    // 1. Hebrew query with Israel filter — highest precision for Israeli products
    isHeb ? `${OFF}?search_terms=${encodeURIComponent(hebrewQuery)}&search_simple=1&action=process&json=1&page_size=10&fields=${FIELDS}&tagtype_0=countries&tag_contains_0=contains&tag_0=israel` : null,
    // 2. English query with Israel filter
    `${OFF}?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=8&fields=${FIELDS}&tagtype_0=countries&tag_contains_0=contains&tag_0=israel`,
    // 3. Hebrew query without filter — catches products with missing country tags
    isHeb ? `${OFF}?search_terms=${encodeURIComponent(hebrewQuery)}&search_simple=1&action=process&json=1&page_size=8&fields=${FIELDS}` : null,
    // 4. English query without filter — broadest fallback
    `${OFF}?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=12&fields=${FIELDS}`,
  ].filter(Boolean);

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'FamilyShoppingIL/6.3' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const p of data?.products || []) {
        const code = p.code || '';
        if (code && seen.has(code)) continue;
        if (code) seen.add(code);
        const name = p.product_name_he || p.product_name || '';
        if (!name) continue;
        const isIsraeli = (p.countries_tags || []).some(c => c.includes('israel'));
        results.push({
          name, brand: p.brands || '', size: p.quantity || '',
          image: p.image_small_url || '', barcode: code,
          isIsraeli, prices: [], source: 'none',
        });
      }
      if (results.length >= 20) break;
    } catch (e) {
      console.warn('[OFF] search error:', e.message);
    }
  }

  results.sort((a, b) => (b.isIsraeli ? 1 : 0) - (a.isIsraeli ? 1 : 0));
  return results.slice(0, 12);
}

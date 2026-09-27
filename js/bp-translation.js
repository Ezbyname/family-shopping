// js/bp-translation.js
// Product Picker translation compatibility layer.
//
// Precedence:
//   1. Legacy exact match — preserve existing Product Picker behaviour.
//   2. Shared exact/synonym match — authoritative canonical knowledge.
//   3. Shared unordered multi-token match — word-order resilience.
//   4. Legacy substring/fuzzy fallback — preserve historical coverage.
//   5. Shared phrase/plural fallback — additional coverage only.

import { CATALOG, SYNONYMS } from './ingredients-catalog.js';
import { normalizeHe, translateIngredient } from './hebrew-product-translation.js';

export const LEGACY_BP_HE_EN = {
  'חלב':'milk',
  // Multi-word cheese phrases must appear before the generic 'גבינה' entry so the
  // substring fallback in _bpTranslate finds the specific phrase first.
  'גבינה לבנה':'white cheese','גבינה צהובה':'yellow cheese',
  'גבינה קוטג':"cottage cheese",'גבינת שמנת':'cream cheese',
  'גבינה עיזים':'goat cheese','גבינה בולגרית':'bulgarian cheese',
  'גבינה מלוחה':'salted cheese','גבינה צפתית':'tzfatit cheese',
  'גבינה':'cheese','קוטג':'cottage cheese',"קוטג'":'cottage cheese',
  'שמנת':'cream','יוגורט':'yogurt','חמאה':'butter','לחם':'bread','פיתה':'pita',
  'קמח':'flour','ביצים':'eggs','ביצה':'egg','קורנפלקס':'cornflakes',
  'שיבולת שועל':'oatmeal','גרנולה':'granola','אורז':'rice','פסטה':'pasta',
  'שמן':'oil','שמן זית':'olive oil','סוכר':'sugar','דבש':'honey','מלח':'salt',
  'טחינה':'tahini','חומוס':'hummus','קטשופ':'ketchup','מיונז':'mayonnaise',
  'טונה':'tuna','קפה':'coffee','תה':'tea','מיץ':'juice','שוקולד':'chocolate',
  'עוגיות':'cookies','במבה':'bamba','ביסלי':'bisli','גלידה':'ice cream',
  'עוף':'chicken','בשר':'beef','דג':'fish','עגבניות':'tomatoes',
  'מלפפון':'cucumber','בצל':'onion','שום':'garlic','גזר':'carrot',
  'תפוח אדמה':'potato','ברוקולי':'broccoli','תפוח':'apple','בננה':'banana',
  // household & hygiene
  'נייר טואלט':'toilet paper','נייר אסלה':'toilet paper',
  'נייר מגבת':'paper towel','מגבת נייר':'paper towel',
  'מגבונים':'wet wipes','מגבון':'wet wipe',
  'סבון':'soap','סבון ידיים':'hand soap','סבון כלים':'dish soap',
  'שמפו':'shampoo','מרכך':'conditioner','מרכך שיער':'hair conditioner',
  'אבקת כביסה':'laundry detergent','נוזל כביסה':'liquid detergent',
  'מרכך כביסה':'fabric softener','ממיס שומן':'degreaser',
  'חומר ניקוי':'cleaning product','נוזל ניקוי':'cleaning liquid',
  'אקונומיקה':'bleach','מי ברז':'water',
  'תחתיות':'diapers','חיתולים':'diapers','טיטולים':'diapers',
  'פד':'pad','תחבושת':'sanitary pad',
  'קרם שיניים':'toothpaste','מברשת שיניים':'toothbrush',
  'דאודורנט':'deodorant','קרם גוף':'body lotion','קרם פנים':'face cream',
  'תחבושת פלסטר':'bandage','כדורים':'pills',
  // kitchen & misc
  'שקיות זבל':'garbage bags','שקית זבל':'garbage bag',
  'ניילון נצמד':'cling film','נייר אלומיניום':'aluminum foil',
  'נייר אפייה':'baking paper','נייר לאפייה':'baking paper',
  'ספריי ניקוי':'cleaning spray','ספריי':'spray',
  'נוזל כלים':'dish soap',
  'כלי חד פעמי':'disposable','צלחת חד פעמית':'disposable plate',
  'כוס חד פעמית':'disposable cup',
  'מרק':'soup','מרק עוף':'chicken soup','מרק ירקות':'vegetable soup',
  'שימורים':'canned food','קופסת שימורים':'canned goods',
  'חטיפים':'snacks','חטיף':'snack',
  'מים':'water','מים מינרליים':'mineral water','סודה':'soda water',
};

function levenshtein(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length);

  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(
            dp[i - 1][j],
            dp[i][j - 1],
            dp[i - 1][j - 1]
          );
    }
  }
  return dp[a.length][b.length];
}

function sharedExactOrSynonym(q) {
  const n = normalizeHe(q);
  if (!n) return null;

  const exact = CATALOG.get(n);
  if (exact) return exact;

  const canonical = SYNONYMS.get(n);
  if (canonical) return CATALOG.get(canonical) || null;

  return null;
}

function tokenSignature(q) {
  return normalizeHe(q)
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join('\u0000');
}

function sharedUnorderedMatch(q) {
  const n = normalizeHe(q);
  const qTokens = n.split(/\s+/).filter(Boolean);
  if (qTokens.length < 2) return null;

  const signature = tokenSignature(n);

  for (const [hebrew, english] of CATALOG) {
    const tokens = normalizeHe(hebrew).split(/\s+/).filter(Boolean);
    if (tokens.length !== qTokens.length) continue;
    if (tokenSignature(hebrew) === signature) return english;
  }

  for (const [variant, canonical] of SYNONYMS) {
    const tokens = normalizeHe(variant).split(/\s+/).filter(Boolean);
    if (tokens.length !== qTokens.length) continue;
    if (tokenSignature(variant) !== signature) continue;

    return CATALOG.get(canonical) || null;
  }

  return null;
}

export function bpTranslate(q) {
  const l = String(q || '').trim();
  if (!l) return null;

  const lNorm = l.replace(/[''׳`'ʼ]/g, "'");

  // 1. Preserve historical exact Product Picker translations.
  if (LEGACY_BP_HE_EN[l]) return LEGACY_BP_HE_EN[l];
  if (LEGACY_BP_HE_EN[lNorm]) return LEGACY_BP_HE_EN[lNorm];

  // 2. Strong shared knowledge can improve queries the legacy dictionary
  //    only resolved through a broader substring.
  const sharedExact = sharedExactOrSynonym(l);
  if (sharedExact) return sharedExact;

  // 3. Same canonical phrase with different word order.
  const unordered = sharedUnorderedMatch(l);
  if (unordered) return unordered;

  // 4. Preserve the old substring behaviour.
  for (const [h, e] of Object.entries(LEGACY_BP_HE_EN)) {
    if (l.includes(h) || lNorm.includes(h)) return e;
  }

  // Preserve the old fuzzy-token behaviour.
  const lTokens = lNorm.split(/\s+/).filter(w => w.length >= 3);
  if (lTokens.length) {
    for (const [h, e] of Object.entries(LEGACY_BP_HE_EN)) {
      const hTokens = h
        .replace(/[''׳`'ʼ]/g, '')
        .split(/\s+/)
        .filter(w => w.length >= 3);

      if (!hTokens.length) continue;

      const allMatch = lTokens.every(
        lt => hTokens.some(ht => levenshtein(lt, ht) <= 1)
      );

      if (allMatch) return e;
    }
  }

  // 5. Shared phrase/plural fallback only where legacy knew nothing.
  return translateIngredient(l);
}

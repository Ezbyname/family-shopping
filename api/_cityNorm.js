// api/_cityNorm.js
// Shared Hebrew city normalization utilities.
// Used by prices-by-city.js, stores-cities.js, and nearby.js.

// ── ALIAS TABLE ───────────────────────────────────────────────────────────────
// Maps user-typed variants → canonical form used in store metadata.
// Both sides go through normalizeCity(), so hyphens are already collapsed.
export const CITY_ALIASES = {
  // Tel Aviv
  'ת"א':                 'תל אביב',
  'ת.א.':                'תל אביב',
  'תל אביב יפו':        'תל אביב',
  'תל אביב-יפו':        'תל אביב',
  'תל-אביב':            'תל אביב',
  'תל-אביב-יפו':        'תל אביב',
  // Jerusalem
  'י-ם':                 'ירושלים',
  'י"ם':                 'ירושלים',
  // Petah Tikva
  'פתח תקוה':            'פתח תקווה',
  'פ"ת':                 'פתח תקווה',
  'פ.ת.':                'פתח תקווה',
  // Beer Sheva
  'באר-שבע':             'באר שבע',
  'ב"ש':                 'באר שבע',
  // Ramat Gan
  'רמת-גן':              'רמת גן',
  // Kfar Saba
  'כפר-סבא':             'כפר סבא',
  // Rishon LeZion
  'ראשל"צ':              'ראשון לציון',
  // Bnei Brak
  'בני-ברק':             'בני ברק',
  // Bat Yam
  'בת-ים':               'בת ים',
  // Modiin variants
  'מודיעין-מכבים-רעות': 'מודיעין',
  'מודיעין מכבים רעות': 'מודיעין',
  // Kiryat prefix — official uses קריית, many stores write קרית
  'קרית מוצקין':         'קריית מוצקין',
  'קרית ים':             'קריית ים',
  'קרית ביאליק':         'קריית ביאליק',
  'קרית אתא':            'קריית אתא',
  'קרית גת':             'קריית גת',
  'קרית שמונה':          'קריית שמונה',
  'קרית מלאכי':          'קריית מלאכי',
  'קרית ארבע':           'קריית ארבע',
  'קרית עקרון':          'קריית עקרון',
  'קרית טבעון':          'קריית טבעון',
  'קרית ענבים':          'קריית ענבים',
};

// ── NORMALIZATION ─────────────────────────────────────────────────────────────

/**
 * Normalise a Hebrew city name for comparison.
 * Both the stored city and the query city are normalised identically,
 * so the mapping only needs to be consistent, not perfect.
 */
export function normalizeCity(city) {
  if (!city) return '';
  let s = String(city).trim();
  s = s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return CITY_ALIASES[s] || s;
}

/** True if storeCity normalises to the same value as queryCity. */
export function cityMatches(storeCity, queryCity) {
  if (!storeCity || !queryCity) return false;
  return normalizeCity(storeCity) === normalizeCity(queryCity);
}

/**
 * True if storeCity normalises to any of the values in queryNorms (a Set of
 * already-normalised city strings).
 */
export function cityMatchesAny(storeCity, queryNorms) {
  if (!storeCity || !queryNorms?.size) return false;
  return queryNorms.has(normalizeCity(storeCity));
}

// ── FIREBASE KEY HELPERS ──────────────────────────────────────────────────────
//
// Price sync writes keys with leading zeros from Azure blob filenames
// (e.g. shufersal_001), while the stores-only sync writes keys from XML
// content without zeros (e.g. shufersal_1).
//
// buildStoreLookup() indexes all stores by the zero-stripped key so that
// price-entry lookups always find the full city-bearing record.

/**
 * Build a lookup map keyed by zero-stripped store key.
 * When two records share a stripped key (placeholder vs full record),
 * the one with city data wins.
 *
 * @param {Object} storesData  Raw Firebase stores/* snapshot value
 * @returns {Object}           { [strippedKey]: storeRecord }
 */
export function buildStoreLookup(storesData) {
  const map = {};
  for (const [k, v] of Object.entries(storesData)) {
    // "shufersal_001" → "shufersal_1",  "shufersal_034" → "shufersal_34"
    const stripped = k.replace(/_0+(\d)/, '_$1');
    const existing = map[stripped];
    // Prefer the record that has city data (stores-only sync record)
    if (!existing || (!existing.city && v.city)) {
      map[stripped] = v;
    }
  }
  return map;
}

/** Strip leading zeros from the numeric part of a store key. */
export function stripKeyZeros(key) {
  return key.replace(/_0+(\d)/, '_$1');
}

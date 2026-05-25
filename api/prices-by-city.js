// api/prices-by-city.js — v1.0.0
// GET /api/prices-by-city?barcode=&city=
//
// Returns all price entries for a barcode whose store metadata city matches
// the requested city.  Uses official stores/{chainId}_{storeId} records written
// by the price-sync worker (--stores-only mode).
//
// City matching is fuzzy-normalized (see normalizeCity) to handle:
//   קרית/קריית prefixes, hyphen vs space, common abbreviations, ה"א variants.
//
// Response:
//   { version, barcode, city, normalizedCity, count, results: [...] }
//   Each result: { storeKey, chainId, chainName, subChainId, subChainName,
//                  storeId, storeName, address, city, zipCode,
//                  barcode, productName, price, currency, source, syncedAt, isStale }
//
// Sort: cheapest → chainName → storeName → storeId

import { getDB, setCors, isValidBarcode } from './_firebase.js';

// ── CITY NORMALIZATION ────────────────────────────────────────────────────────
// Strategy:
//   1. trim + collapse whitespace
//   2. replace hyphens with space
//   3. map known abbreviations/aliases to canonical form
//   4. compare lowercased
//
// Final-letter normalization (מנצפכ) is intentionally NOT done — comparing
// normalised strings pairwise means both sides get the same treatment.

const CITY_ALIASES = {
  // Tel Aviv variants
  'ת"א':             'תל אביב',
  'ת.א.':            'תל אביב',
  'תל אביב יפו':    'תל אביב',
  'תל אביב-יפו':    'תל אביב',
  'תל-אביב':        'תל אביב',
  'תל-אביב-יפו':    'תל אביב',
  // Jerusalem
  'ירושלים':         'ירושלים',
  'י-ם':             'ירושלים',
  'י"ם':             'ירושלים',
  // Petah Tikva
  'פתח תקוה':        'פתח תקווה',
  'פ"ת':             'פתח תקווה',
  'פ.ת.':            'פתח תקווה',
  'פת"ת':            'פתח תקווה',
  // Beer Sheva
  'באר-שבע':         'באר שבע',
  'ב"ש':             'באר שבע',
  // Ramat Gan
  'רמת-גן':          'רמת גן',
  // Kfar Saba
  'כפר-סבא':         'כפר סבא',
  // Kiryat prefix — official form uses קריית but many stores write קרית
  'קרית מוצקין':     'קריית מוצקין',
  'קרית ים':         'קריית ים',
  'קרית ביאליק':     'קריית ביאליק',
  'קרית אתא':        'קריית אתא',
  'קרית גת':         'קריית גת',
  'קרית שמונה':      'קריית שמונה',
  'קרית מלאכי':      'קריית מלאכי',
  'קרית ארבע':       'קריית ארבע',
  'קרית עקרון':      'קריית עקרון',
  'קרית טבעון':      'קריית טבעון',
  'קרית ענבים':      'קריית ענבים',
  // Rishon LeZion
  'ראשון לציון':     'ראשון לציון',
  'ראשל"צ':          'ראשון לציון',
  // Bnei Brak
  'בני-ברק':         'בני ברק',
  // Holon
  'חולון':           'חולון',
  // Bat Yam
  'בת-ים':           'בת ים',
  // Rehovot
  'רחובות':          'רחובות',
  // Netanya
  'נתניה':           'נתניה',
  // Hadera
  'חדרה':            'חדרה',
  // Modiin
  'מודיעין':         'מודיעין',
  'מודיעין-מכבים-רעות': 'מודיעין',
  'מודיעין מכבים רעות': 'מודיעין',
  // Herzliya
  'הרצליה':          'הרצליה',
  // Ra\'anana
  'רעננה':           'רעננה',
  // Hod HaSharon
  'הוד השרון':       'הוד השרון',
  // Givatayim
  'גבעתיים':         'גבעתיים',
  // Ashkelon/Ashdod
  'אשקלון':          'אשקלון',
  'אשדוד':           'אשדוד',
  // Haifa
  'חיפה':            'חיפה',
};

/**
 * Normalise a Hebrew city name for comparison.
 * Both the query city and stored city go through this, so the transforms
 * only need to be consistent — not perfect.
 */
export function normalizeCity(city) {
  if (!city) return '';
  let s = String(city).trim();
  s = s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return CITY_ALIASES[s] || s;
}

function cityMatches(storeCity, queryCity) {
  if (!storeCity || !queryCity) return false;
  return normalizeCity(storeCity) === normalizeCity(queryCity);
}

/**
 * Firebase has two key formats for the same physical store because two
 * different processes write to stores/:
 *
 *   Price sync placeholder:  shufersal_001  (storeId from filename, with leading zeros)
 *   Stores-only sync:        shufersal_1    (storeId from XML content, no leading zeros)
 *
 * The price entries use the leading-zero keys (shufersal_001).
 * The full city/address records landed under the no-zero keys (shufersal_1).
 *
 * This function builds a lookup map indexed by the zero-STRIPPED key so that
 *   findStore("shufersal_001")  →  the full record from shufersal_1.
 *
 * When two records share a stripped key, the record WITH city data wins (the
 * stores-only sync record always has city; the price placeholder never does).
 */
function buildStoreLookup(storesData) {
  const map = {};
  for (const [k, v] of Object.entries(storesData)) {
    // "shufersal_001" → "shufersal_1", "shufersal_034" → "shufersal_34"
    const stripped = k.replace(/_0+(\d)/, '_$1');
    const existing = map[stripped];
    // City-bearing record beats a placeholder without city
    if (!existing || (!existing.city && v.city)) {
      map[stripped] = v;
    }
  }
  return map;
}

/** Strip leading zeros from the numeric part of a store key for lookup. */
function stripKeyZeros(storeKey) {
  return storeKey.replace(/_0+(\d)/, '_$1');
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

const STALE_MS = 36 * 3600 * 1000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { barcode, city } = req.query || {};

  // ── Validate barcode ──
  const clean = String(barcode || '').replace(/\D/g, '');
  if (!isValidBarcode(clean)) {
    return res.status(400).json({
      error: 'Missing or invalid barcode (8–14 digits required)',
    });
  }

  // ── Validate city ──
  const cityRaw = String(city || '').trim();
  if (!cityRaw || cityRaw.length < 2) {
    return res.status(400).json({ error: 'city is required (min 2 chars)' });
  }
  if (cityRaw.length > 60) {
    return res.status(400).json({ error: 'city too long (max 60 chars)' });
  }
  const cityNorm = normalizeCity(cityRaw);

  try {
    const db = await getDB();
    if (!db) {
      return res.status(200).json({
        version: '1.0.0', barcode: clean, city: cityRaw,
        normalizedCity: cityNorm, count: 0, results: [],
        warning: 'Database unavailable',
      });
    }

    // Parallel fetch: prices for this barcode + all store metadata
    const [pricesSnap, storesSnap] = await Promise.all([
      db.ref(`prices/${clean}`).once('value'),
      db.ref('stores').once('value'),
    ]);

    const pricesData = pricesSnap.val() || {};
    const storesData = storesSnap.val() || {};

    // Build a zero-normalised store lookup so that price keys like
    // "shufersal_001" resolve to the full store record at "shufersal_1".
    const storeLookup = buildStoreLookup(storesData);

    const results = [];

    for (const [storeKey, priceEntry] of Object.entries(pricesData)) {
      if (!priceEntry?.price || priceEntry.price <= 0) continue;

      // Try both the raw key and the zero-stripped key
      const store = storeLookup[stripKeyZeros(storeKey)] || storesData[storeKey];

      // Require a known store record with city data
      if (!store?.city) continue;

      // City filter — normalised comparison
      if (!cityMatches(store.city, cityRaw)) continue;

      const syncedAt = priceEntry.syncedAt
        ? new Date(priceEntry.syncedAt).toISOString()
        : null;
      const isStale = priceEntry.syncedAt
        ? (Date.now() - priceEntry.syncedAt) > STALE_MS
        : true;

      results.push({
        storeKey,
        chainId:      priceEntry.chainId      || store.chainId      || '',
        chainName:    priceEntry.chainName    || store.chainName    || '',
        subChainId:   store.subChainId  || '',
        subChainName: store.subChainName || '',
        storeId:      priceEntry.storeId      || store.storeId      || '',
        storeName:    priceEntry.storeName    || store.storeName    || '',
        address:      store.address    || '',
        city:         store.city       || '',
        zipCode:      store.zipCode    || '',
        barcode:      clean,
        productName:  priceEntry.name  || '',
        price:        priceEntry.price,
        currency:     'ILS',
        source:       priceEntry.source || 'official',
        syncedAt,
        isStale,
      });
    }

    // Sort: cheapest → chainName → storeName → storeId
    results.sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      const cn = (a.chainName || '').localeCompare(b.chainName || '');
      if (cn !== 0) return cn;
      const sn = (a.storeName || '').localeCompare(b.storeName || '');
      if (sn !== 0) return sn;
      return String(a.storeId).localeCompare(String(b.storeId));
    });

    return res.status(200).json({
      version:       '1.0.0',
      barcode:       clean,
      city:          cityRaw,
      normalizedCity: cityNorm,
      count:         results.length,
      results,
    });

  } catch (e) {
    console.error('[prices-by-city] error:', e.message);
    return res.status(500).json({ error: 'Internal error', message: e.message });
  }
}

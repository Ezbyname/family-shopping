// api/prices-by-city.js — v2.1.0
// GET /api/prices-by-city?barcode=&city=חיפה
// GET /api/prices-by-city?barcode=&city=חיפה&city=נשר        (repeated param)
// GET /api/prices-by-city?barcode=&cities=חיפה,נשר,קריית מוצקין  (comma-joined)
//
// Returns price entries whose store metadata city matches ANY of the selected cities.
//
// City matching uses normalizeCity() from _cityNorm.js:
//   קרית מוצקין = קריית מוצקין
//   ת"א = תל אביב
//   באר-שבע = באר שבע   (hyphens collapsed)
//
// Firebase key mismatch handled by buildStoreLookup():
//   price key  shufersal_001  →  finds store record at  shufersal_1
//
// Sort: cheapest → chainName → storeName → storeId
//
// v2.1.0: reads via fetch() REST API (no Admin SDK WebSocket hang)

import { restGet, getDbUrl, getAdminToken, setCors, isValidBarcode } from './_firebase.js';
import {
  normalizeCity, cityMatchesAny,
  buildStoreLookup, stripKeyZeros,
} from './_cityNorm.js';

// ── Parse city/cities query params into a deduplicated array ─────────────────
function parseCityParams(query) {
  const cities = [];

  // ?city=X&city=Y  (array when repeated, string when single)
  const cityParam = query.city;
  if (Array.isArray(cityParam)) cities.push(...cityParam);
  else if (cityParam) cities.push(String(cityParam));

  // ?cities=X,Y,Z  (comma-joined convenience form)
  const citiesParam = query.cities;
  if (citiesParam) {
    cities.push(...String(citiesParam).split(','));
  }

  // Deduplicate after trimming
  return [...new Set(cities.map(c => c.trim()).filter(Boolean))];
}

const STALE_MS        = 36 * 3600 * 1000;
const READ_TIMEOUT_MS = 5_000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // ── Validate barcode ──
  const clean = String(req.query?.barcode || '').replace(/\D/g, '');
  if (!isValidBarcode(clean)) {
    return res.status(400).json({
      error: 'Missing or invalid barcode (8–14 digits required)',
    });
  }

  // ── Parse and validate city list ──
  const cities = parseCityParams(req.query || {});
  if (cities.length === 0) {
    return res.status(400).json({ error: 'At least one city is required (city= or cities=)' });
  }
  if (cities.some(c => c.length < 2)) {
    return res.status(400).json({ error: 'Each city must be at least 2 characters' });
  }
  if (cities.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 cities per request' });
  }

  // Build a Set of normalised city names for O(1) matching
  const cityNorms = new Set(cities.map(normalizeCity));

  const dbUrl = getDbUrl();
  if (!dbUrl) {
    return res.status(200).json({
      version: '2.1.0', barcode: clean, cities, count: 0, results: [],
      warning: 'Database unavailable',
    });
  }

  try {
    // Pre-warm admin token
    await getAdminToken().catch(() => {});

    // Parallel fetch: prices for this barcode + all store metadata
    const [pricesData, storesData] = await Promise.all([
      restGet(dbUrl, `prices/${clean}`, READ_TIMEOUT_MS).catch(() => null),
      restGet(dbUrl, 'stores',          READ_TIMEOUT_MS).catch(() => null),
    ]);

    const prices = (pricesData && typeof pricesData === 'object') ? pricesData : {};
    const stores = (storesData && typeof storesData === 'object') ? storesData : {};

    // Build normalised store lookup (handles shufersal_001 → shufersal_1 mismatch)
    const storeLookup = buildStoreLookup(stores);

    const results = [];

    for (const [storeKey, priceEntry] of Object.entries(prices)) {
      if (!priceEntry?.price || priceEntry.price <= 0) continue;

      const store = storeLookup[stripKeyZeros(storeKey)] || stores[storeKey];

      // Require a store record with city data
      if (!store?.city) continue;

      // City filter — matches any of the selected cities
      if (!cityMatchesAny(store.city, cityNorms)) continue;

      const syncedAt = priceEntry.syncedAt
        ? new Date(priceEntry.syncedAt).toISOString()
        : null;
      const isStale = priceEntry.syncedAt
        ? (Date.now() - priceEntry.syncedAt) > STALE_MS
        : true;

      results.push({
        storeKey,
        chainId:      priceEntry.chainId    || store.chainId      || '',
        chainName:    priceEntry.chainName  || store.chainName    || '',
        subChainId:   store.subChainId  || '',
        subChainName: store.subChainName || '',
        storeId:      priceEntry.storeId   || store.storeId      || '',
        storeName:    priceEntry.storeName || store.storeName    || '',
        address:      store.address  || '',
        city:         store.city     || '',
        zipCode:      store.zipCode  || '',
        barcode:      clean,
        productName:  priceEntry.name || '',
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
      version: '2.1.0',
      barcode: clean,
      cities,
      count:   results.length,
      results,
    });

  } catch (e) {
    console.error('[prices-by-city] error:', e.message);
    return res.status(500).json({ error: 'Internal error', message: e.message });
  }
}

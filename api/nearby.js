// api/nearby.js — v1.1.0
// GET /api/nearby?barcode=&lat=&lng=&radiusKm=
//
// Returns all stores within radiusKm that carry the requested barcode,
// sorted cheapest-first then nearest-first.
//
// Requires stores/{chainId}_{storeId} records to have hasCoords:true.
// If a store has no coordinates it is silently skipped (radius filter requires coords).
// The existing /api/prices endpoint already has graceful fall-back (include-all
// when hasCoords is false). This endpoint is strict: no coords → not shown.
//
// Response:
//   { version, barcode, userLat, userLng, radiusKm, count, results: [ ...store+price rows ] }
//
// v1.1.0: reads via fetch() REST API (no Admin SDK WebSocket hang)

import { restGet, getDbUrl, getAdminToken, haversine, setCors, isValidBarcode } from './_firebase.js';

const READ_TIMEOUT_MS = 5_000;
const STALE_MS        = 36 * 3600 * 1000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { barcode, lat, lng, radiusKm } = req.query || {};

  // ── Input validation ──────────────────────────────────────────────────────
  const clean = String(barcode || '').replace(/\D/g, '');
  if (!isValidBarcode(clean)) {
    return res.status(400).json({
      error: 'Missing or invalid barcode (8–14 digits required)',
    });
  }

  const userLat = parseFloat(lat  || '');
  const userLng = parseFloat(lng  || '');
  const radius  = parseFloat(radiusKm || '5');

  if (isNaN(userLat) || isNaN(userLng)) {
    return res.status(400).json({ error: 'lat and lng are required numbers' });
  }
  if (userLat < 29 || userLat > 34 || userLng < 33 || userLng > 36) {
    return res.status(400).json({ error: 'Coordinates appear to be outside Israel' });
  }
  if (isNaN(radius) || radius <= 0 || radius > 50) {
    return res.status(400).json({ error: 'radiusKm must be between 0.1 and 50' });
  }

  const dbUrl = getDbUrl();
  if (!dbUrl) {
    return res.status(200).json({
      version: '1.1.0', barcode: clean,
      userLat, userLng, radiusKm: radius,
      count: 0, results: [],
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

    const results = [];

    for (const [storeKey, priceEntry] of Object.entries(prices)) {
      if (!priceEntry?.price || priceEntry.price <= 0) continue;

      const store = stores[storeKey];

      // Strict: skip stores without confirmed coordinates
      if (!store?.hasCoords || store.latitude == null || store.longitude == null) continue;

      const distanceKm = haversine(userLat, userLng, store.latitude, store.longitude);
      if (distanceKm > radius) continue;

      const syncedAt = priceEntry.syncedAt ? new Date(priceEntry.syncedAt).toISOString() : null;
      const isStale  = priceEntry.syncedAt
        ? (Date.now() - priceEntry.syncedAt) > STALE_MS
        : true;

      results.push({
        storeKey,
        chainId:     priceEntry.chainId    || store.chainId    || '',
        chainName:   priceEntry.chainName  || store.chainName  || '',
        storeId:     priceEntry.storeId    || store.storeId    || '',
        storeName:   priceEntry.storeName  || store.storeName  || '',
        address:     store.address         || '',
        city:        store.city            || '',
        latitude:    store.latitude,
        longitude:   store.longitude,
        distanceKm:  Math.round(distanceKm * 10) / 10,
        barcode:     clean,
        productName: priceEntry.name       || '',
        price:       priceEntry.price,
        currency:    'ILS',
        source:      priceEntry.source     || 'official',
        syncedAt,
        isStale,
      });
    }

    // Sort: cheapest → nearest → chain name
    results.sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
      return (a.chainName || '').localeCompare(b.chainName || '');
    });

    return res.status(200).json({
      version:  '1.1.0',
      barcode:  clean,
      userLat,
      userLng,
      radiusKm: radius,
      count:    results.length,
      results,
    });

  } catch (e) {
    console.error('[nearby] error:', e.message);
    return res.status(500).json({ error: 'Internal error', message: e.message });
  }
}

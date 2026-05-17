// api/basket-compare.js — v1.0.0
// POST /api/basket-compare
// Compares full shopping basket price across nearby stores

import { getDB, haversine, cors } from './_firebase.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { items, lat, lng, radiusKm } = body || {};

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'items array required' });

  const userLat  = parseFloat(lat  || '');
  const userLng  = parseFloat(lng  || '');
  const radius   = parseFloat(radiusKm || '10');
  const hasLoc   = !isNaN(userLat) && !isNaN(userLng);

  // Validate items
  const validItems = items
    .map(i => ({ barcode: String(i.barcode||'').replace(/\D/g,''), quantity: parseInt(i.quantity||1) }))
    .filter(i => i.barcode.length >= 4 && i.quantity > 0);

  if (!validItems.length) return res.status(400).json({ error: 'No valid items' });

  const db = getDB();

  // 1. Load store index (only stores with coordinates if location provided)
  const storeIndex = await loadStores(db);
  const nearbyStores = hasLoc
    ? Object.entries(storeIndex)
        .filter(([, s]) => s.hasCoords)
        .map(([key, s]) => ({ key, ...s, distanceKm: haversine(userLat, userLng, s.latitude, s.longitude) }))
        .filter(s => s.distanceKm <= radius)
        .sort((a, b) => a.distanceKm - b.distanceKm)
    : Object.entries(storeIndex).map(([key, s]) => ({ key, ...s, distanceKm: null }));

  if (nearbyStores.length === 0)
    return res.status(200).json({ radiusKm: radius, results: [], message: 'No stores found in radius' });

  // 2. Fetch prices for all barcodes in parallel
  const priceMap = {}; // barcode → { storeKey → price }
  await Promise.all(validItems.map(async ({ barcode }) => {
    try {
      const snap = await db.ref(`prices/${barcode}`).get();
      if (snap.exists()) priceMap[barcode] = snap.val();
    } catch (_) {}
  }));

  // 3. Calculate basket total per store
  const storeResults = nearbyStores.map(store => {
    const storeKey = store.key;
    const foundItems = [], missingBarcodes = [];
    let total = 0;

    validItems.forEach(({ barcode, quantity }) => {
      const storePrice = priceMap[barcode]?.[storeKey];
      if (storePrice?.price > 0) {
        const unitPrice = storePrice.price;
        const totalPrice = Math.round(unitPrice * quantity * 100) / 100;
        total += totalPrice;
        foundItems.push({ barcode, name: storePrice.name, quantity, unitPrice, totalPrice });
      } else {
        missingBarcodes.push(barcode);
      }
    });

    total = Math.round(total * 100) / 100;

    return {
      chainId:        store.chainId,
      chainName:      store.chainName,
      storeId:        store.storeId,
      storeName:      store.storeName,
      city:           store.city || '',
      address:        store.address || '',
      distanceKm:     store.distanceKm ? Math.round(store.distanceKm * 10) / 10 : null,
      total,
      availableItems: foundItems.length,
      missingItems:   missingBarcodes.length,
      totalItems:     validItems.length,
      completeness:   Math.round((foundItems.length / validItems.length) * 100),
      items:          foundItems,
      missingBarcodes,
    };
  });

  // 4. Sort: full basket first by price, then partial by completeness+price
  const full    = storeResults.filter(s => s.missingItems === 0).sort((a,b) => a.total - b.total);
  const partial = storeResults.filter(s => s.missingItems > 0  && s.availableItems > 0)
    .sort((a, b) => b.completeness - a.completeness || a.total - b.total);

  return res.status(200).json({
    radiusKm: radius,
    itemsRequested: validItems.length,
    bestFullBasket: full[0] || null,
    results: [...full, ...partial].slice(0, 20),
  });
}

async function loadStores(db) {
  try {
    const snap = await db.ref('stores').get();
    return snap.exists() ? snap.val() : {};
  } catch (_) { return {}; }
}

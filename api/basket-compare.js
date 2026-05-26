// api/basket-compare.js — v2.1.0
// POST /api/basket-compare
// Uses official XML prices first.
// Clearly marks items using proxy/manual fallback.
//
// v2.1.0: all Firebase reads via fetch() REST API (no Admin SDK WebSocket hang)

import { restGet, getDbUrl, getAdminToken, haversine, setCors, isValidBarcode } from './_firebase.js';

const READ_TIMEOUT_MS = 5_000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { items, lat, lng, radiusKm, groupId, includeApproximate } = body || {};
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'items array required' });

  const userLat         = parseFloat(lat || '');
  const userLng         = parseFloat(lng || '');
  const radius          = parseFloat(radiusKm || '10');
  const hasLoc          = !isNaN(userLat) && !isNaN(userLng);
  const wantApproximate = includeApproximate === true || includeApproximate === 'true';

  const validItems = items
    .map(i => ({
      barcode: String(i.barcode || '').replace(/\D/g, ''),
      qty:     Math.max(1, parseInt(i.quantity || 1)),
      name:    String(i.name || '').trim().slice(0, 100),
    }))
    .filter(i => isValidBarcode(i.barcode));

  if (!validItems.length) return res.status(400).json({ error: 'No valid barcodes' });

  const dbUrl = getDbUrl();
  if (!dbUrl) return res.status(503).json({ error: 'Database unavailable (missing FIREBASE_DATABASE_URL)' });

  // Pre-warm admin token so parallel reads below don't all race to generate it
  await getAdminToken().catch(() => {});

  // Load stores (with timeout; errors are tolerated — basket still works, just no distance)
  let storeIndex = {};
  try {
    const data = await restGet(dbUrl, 'stores', READ_TIMEOUT_MS);
    if (data && typeof data === 'object') storeIndex = data;
  } catch (_) {}

  // Filter nearby stores — APPROXIMATE locations excluded by default
  const allStoreKeys = Object.keys(storeIndex);
  const nearbyKeys = hasLoc
    ? allStoreKeys.filter(k => {
        const s = storeIndex[k];
        if (!s?.hasCoords) return false;
        if (!wantApproximate && s.approximateLocation === true) return false;
        return haversine(userLat, userLng, s.latitude, s.longitude) <= radius;
      })
    : allStoreKeys.filter(k => wantApproximate || storeIndex[k]?.approximateLocation !== true);

  // Fetch all prices for all barcodes in parallel
  const priceMap = {}; // barcode → { storeKey → priceEntry }
  await Promise.all(validItems.map(async ({ barcode }) => {
    const results = await Promise.allSettled([
      restGet(dbUrl, `prices/${barcode}`,       READ_TIMEOUT_MS),  // official
      restGet(dbUrl, `proxyCache/${barcode}`,    READ_TIMEOUT_MS),  // proxy
      groupId
        ? restGet(dbUrl, `manualPrices/${groupId}/${barcode}`, READ_TIMEOUT_MS)
        : Promise.resolve(null),                                    // manual (groupId-scoped)
    ]);

    priceMap[barcode] = {};
    const now = Date.now();

    // Official (highest priority per store)
    const officialData = results[0].status === 'fulfilled' ? results[0].value : null;
    if (officialData && typeof officialData === 'object') {
      Object.entries(officialData).forEach(([k, p]) => {
        if (p?.price > 0) priceMap[barcode][k] = { ...p, source: 'official' };
      });
    }

    // Proxy — only fill gaps not covered by official
    const proxyData = results[1].status === 'fulfilled' ? results[1].value : null;
    if (proxyData && typeof proxyData === 'object') {
      Object.entries(proxyData).forEach(([k, p]) => {
        if (p?.price > 0 && !priceMap[barcode][k] && (now - (p.fetchedAt || 0)) < 3_600_000) {
          priceMap[barcode][k] = { ...p, source: 'proxy' };
        }
      });
    }

    // Manual — only fill gaps not covered by official or proxy; group by chain, use cheapest
    const manualData = results[2].status === 'fulfilled' ? results[2].value : null;
    if (manualData && typeof manualData === 'object') {
      const byChain = {};
      Object.values(manualData).forEach(p => {
        if (!p?.price) return;
        const k = (p.chainName || '').replace(/\s/g, '_') + '_0';
        if (!byChain[k] || p.price < byChain[k].price) byChain[k] = { ...p, source: 'manual' };
      });
      Object.entries(byChain).forEach(([k, p]) => {
        if (!priceMap[barcode][k]) priceMap[barcode][k] = p;
      });
    }
  }));

  // Calculate basket total per store
  const storeResults = nearbyKeys.map(storeKey => {
    const store = storeIndex[storeKey] || {};
    const foundItems = [], missingItems = [];
    let total = 0, hasFallback = false;

    validItems.forEach(({ barcode, qty, name: reqName }) => {
      const p = priceMap[barcode]?.[storeKey];
      if (p?.price > 0) {
        const lineTotal = Math.round(p.price * qty * 100) / 100;
        total += lineTotal;
        if (p.source !== 'official') hasFallback = true;
        foundItems.push({
          barcode, name: p.name || reqName || barcode, quantity: qty,
          unitPrice: p.price, totalPrice: lineTotal,
          source: p.source || 'official',
          isFallback: p.source !== 'official',
        });
      } else {
        missingItems.push({ barcode, name: reqName || barcode });
      }
    });

    total = Math.round(total * 100) / 100;
    if (!foundItems.length) return null;

    const dist = (hasLoc && store.hasCoords)
      ? Math.round(haversine(userLat, userLng, store.latitude, store.longitude) * 10) / 10
      : null;

    return {
      chainId:         store.chainId    || '',
      chainName:       store.chainName  || storeKey,
      storeId:         store.storeId    || '',
      storeName:       store.storeName  || '',
      city:            store.city       || '',
      address:         store.address    || '',
      latitude:        store.latitude   ?? null,
      longitude:       store.longitude  ?? null,
      distanceKm:      dist,
      total,
      availableItems:  foundItems.length,
      missingItems,
      totalItems:      validItems.length,
      completeness:    Math.round(foundItems.length / validItems.length * 100),
      hasFallbackData: hasFallback,
      items:           foundItems,
    };
  }).filter(Boolean);

  // Sort: full basket by price first, then partial by completeness then price
  const full    = storeResults.filter(s => !s.missingItems.length).sort((a, b) => a.total - b.total);
  const partial = storeResults
    .filter(s => s.missingItems.length > 0 && s.availableItems > 0)
    .sort((a, b) => b.completeness - a.completeness || a.total - b.total);

  return res.status(200).json({
    version:        '2.1.0',
    radiusKm:       radius,
    itemsRequested: validItems.length,
    bestFullBasket: full[0] || null,
    results:        [...full, ...partial].slice(0, 20),
    note: 'Items marked isFallback:true use proxy/manual prices — official XML sync pending',
  });
}

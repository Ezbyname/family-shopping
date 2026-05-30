// api/basket-compare.js — v2.0.0
// POST /api/basket-compare
// Uses official XML prices first.
// Clearly marks items using proxy/manual fallback.

import { getDB, haversine, setCors, isValidBarcode } from './_firebase.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { items, lat, lng, radiusKm, groupId } = body || {};
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'items array required' });

  const userLat = parseFloat(lat || '');
  const userLng = parseFloat(lng || '');
  const radius  = parseFloat(radiusKm || '10');
  const hasLoc  = !isNaN(userLat) && !isNaN(userLng);

  const validItems = items
    .map(i => ({ barcode: String(i.barcode || '').replace(/\D/g, ''), qty: Math.max(1, parseInt(i.quantity || 1)) }))
    .filter(i => isValidBarcode(i.barcode));

  if (!validItems.length) return res.status(400).json({ error: 'No valid barcodes' });

  const db = await getDB();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  // Load stores
  let storeIndex = {};
  try {
    const snap = await db.ref('stores').get();
    if (snap.exists()) storeIndex = snap.val();
  } catch (_) {}

  // Filter nearby stores
  const allStoreKeys = Object.keys(storeIndex);
  const nearbyKeys = hasLoc
    ? allStoreKeys.filter(k => {
        const s = storeIndex[k];
        if (!s?.hasCoords) return false;
        return haversine(userLat, userLng, s.latitude, s.longitude) <= radius;
      })
    : allStoreKeys;

  // Fetch all prices for all barcodes in parallel
  const priceMap = {}; // barcode → { storeKey → priceEntry }
  await Promise.all(validItems.map(async ({ barcode }) => {
    const snaps = await Promise.allSettled([
      db.ref(`prices/${barcode}`).get(),                          // official
      db.ref(`proxyCache/${barcode}`).get(),                      // proxy
      groupId ? db.ref(`manualPrices/${groupId}/${barcode}`).get() : Promise.resolve(null), // manual
    ]);

    priceMap[barcode] = {};
    const now = Date.now();

    // Official (highest priority per store)
    if (snaps[0].status === 'fulfilled' && snaps[0].value?.exists()) {
      Object.entries(snaps[0].value.val()).forEach(([k, p]) => {
        if (p?.price > 0) priceMap[barcode][k] = { ...p, source: 'official' };
      });
    }

    // Proxy — only for stores not covered by official
    if (snaps[1].status === 'fulfilled' && snaps[1].value?.exists()) {
      Object.entries(snaps[1].value.val()).forEach(([k, p]) => {
        if (p?.price > 0 && !priceMap[barcode][k] && (now - (p.fetchedAt||0)) < 3_600_000) {
          priceMap[barcode][k] = { ...p, source: 'proxy' };
        }
      });
    }

    // Manual — only for stores not covered by official or proxy
    if (snaps[2].status === 'fulfilled' && snaps[2].value?.exists()) {
      // Group by chain, use cheapest
      const byChain = {};
      Object.values(snaps[2].value.val()).forEach(p => {
        if (!p?.price) return;
        const k = (p.chainName || '').replace(/\s/g, '_') + '_0';
        if (!byChain[k] || p.price < byChain[k].price) {
          byChain[k] = { ...p, source: 'manual' };
        }
      });
      Object.entries(byChain).forEach(([k, p]) => {
        if (!priceMap[barcode][k]) priceMap[barcode][k] = p;
      });
    }
  }));

  // Calculate basket per store
  const storeResults = nearbyKeys.map(storeKey => {
    const store = storeIndex[storeKey] || {};
    const foundItems = [], missingBarcodes = [];
    let total = 0, hasFallback = false;

    validItems.forEach(({ barcode, qty }) => {
      const p = priceMap[barcode]?.[storeKey];
      if (p?.price > 0) {
        const lineTotal = Math.round(p.price * qty * 100) / 100;
        total += lineTotal;
        if (p.source !== 'official') hasFallback = true;
        foundItems.push({
          barcode, name: p.name || barcode, quantity: qty,
          unitPrice: p.price, totalPrice: lineTotal,
          source: p.source || 'official',
          isFallback: p.source !== 'official',
        });
      } else {
        missingBarcodes.push(barcode);
      }
    });

    total = Math.round(total * 100) / 100;
    if (!foundItems.length) return null;

    const dist = (hasLoc && store.hasCoords)
      ? Math.round(haversine(userLat, userLng, store.latitude, store.longitude) * 10) / 10
      : null;

    return {
      chainId:        store.chainId    || '',
      chainName:      store.chainName  || storeKey,
      storeId:        store.storeId    || '',
      storeName:      store.storeName  || '',
      city:           store.city       || '',
      address:        store.address    || '',
      distanceKm:     dist,
      total,
      availableItems: foundItems.length,
      missingItems:   missingBarcodes.length,
      totalItems:     validItems.length,
      completeness:   Math.round(foundItems.length / validItems.length * 100),
      hasFallbackData: hasFallback,
      items:          foundItems,
      missingBarcodes,
    };
  }).filter(Boolean);

  // Sort: full basket by price first, then partial
  const full    = storeResults.filter(s => s.missingItems === 0).sort((a, b) => a.total - b.total);
  const partial = storeResults.filter(s => s.missingItems > 0 && s.availableItems > 0)
    .sort((a, b) => b.completeness - a.completeness || a.total - b.total);

  const sorted = [...full, ...partial];

  // ── Travel Cost Awareness ─────────────────────────────────────────────────
  // Cost model: ₪0.80/km × 2 (round trip) — Israeli average fuel + running cost
  const COST_PER_KM = 0.80;
  if (hasLoc) {
    sorted.forEach(r => {
      if (r.distanceKm !== null) {
        r.travelCostILS = Math.round(r.distanceKm * 2 * COST_PER_KM * 100) / 100;
      }
    });
  }

  // ── Summary object ────────────────────────────────────────────────────────
  let summary = null;
  if (sorted.length >= 1) {
    const cheapest = sorted[0];
    const priciest = sorted[sorted.length - 1];
    const maxSavings = Math.round((priciest.total - cheapest.total) * 100) / 100;
    const maxSavingsPct = priciest.total > 0
      ? Math.round((maxSavings / priciest.total) * 100)
      : 0;

    // Closest store (by distanceKm — may differ from cheapest)
    const withDist = sorted.filter(r => r.distanceKm !== null);
    const closest  = withDist.length
      ? withDist.reduce((a, b) => a.distanceKm < b.distanceKm ? a : b)
      : null;

    // Best *full* basket — first complete store
    const bestFull = full[0] || null;

    // Net savings after travel for cheapest full store vs. closest full store
    let netSavingsVsClosest = null;
    if (bestFull && closest && bestFull !== closest && closest.travelCostILS !== undefined) {
      const grossSaving = closest.total - bestFull.total;
      const extraTravel = (bestFull.travelCostILS ?? 0) - (closest.travelCostILS ?? 0);
      netSavingsVsClosest = Math.round((grossSaving - extraTravel) * 100) / 100;
    }

    summary = {
      cheapestTotal:       cheapest.total,
      priciestTotal:       priciest.total,
      maxSavings,
      maxSavingsPct,
      cheapestChain:       cheapest.chainName,
      priciestChain:       priciest.chainName,
      bestFullChain:       bestFull?.chainName ?? null,
      bestFullTotal:       bestFull?.total     ?? null,
      closestChain:        closest?.chainName  ?? null,
      closestKm:           closest?.distanceKm ?? null,
      netSavingsVsClosest,
      costPerKm:           COST_PER_KM,
      storesFound:         sorted.length,
    };
  }

  return res.status(200).json({
    version:        '2.1.0',
    radiusKm:       radius,
    itemsRequested: validItems.length,
    bestFullBasket: full[0] || null,
    summary,
    results:        sorted.slice(0, 20),
    note: 'Items marked isFallback:true use proxy/manual prices — official XML sync pending',
  });
}

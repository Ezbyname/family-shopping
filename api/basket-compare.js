// api/basket-compare.js — v2.3.0
// POST /api/basket-compare
//
// Uses official XML prices first.
// Clearly marks items using proxy/manual fallback.
//
// v2.1.0: all Firebase reads via fetch() REST API (no Admin SDK WebSocket hang)
// v2.2.0: selective store loading, storeCoords pre-filter, travel cost, caps, logError
// v2.3.0: merged — REST bypass (v2.1) + all hardening features (v2.2)

import {
  restGet, getDbUrl, getAdminToken,
  haversine, setCors, isValidBarcode, logError,
} from './_firebase.js';

// ── Travel cost model ────────────────────────────────────────────────────────
const COST_PER_KM = parseFloat(process.env.COST_PER_KM_ILS || '1.50');

// ── Timeout budgets ──────────────────────────────────────────────────────────
const READ_TIMEOUT_MS   = 5_000;
const COORDS_TIMEOUT_MS = 4_000;
const STORE_TIMEOUT_MS  = 4_000;

// ── Safety caps ──────────────────────────────────────────────────────────────
const MAX_ITEMS          = 50;
const MAX_STORES_TO_LOAD = 100;

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

  if (items.length > MAX_ITEMS)
    return res.status(400).json({ error: `Max ${MAX_ITEMS} items per request` });

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

  // Pre-warm admin token so parallel reads don't all race to generate it
  await getAdminToken().catch(() => {});

  // ── 1. Fetch prices for all barcodes in parallel ──────────────────────────
  // Prices first → we know exactly which stores matter before loading store records.
  const priceMap = {}; // barcode → { storeKey → priceEntry }
  await Promise.all(validItems.map(async ({ barcode }) => {
    const results = await Promise.allSettled([
      restGet(dbUrl, `prices/${barcode}`,       READ_TIMEOUT_MS),
      restGet(dbUrl, `proxyCache/${barcode}`,    READ_TIMEOUT_MS),
      groupId
        ? restGet(dbUrl, `manualPrices/${groupId}/${barcode}`, READ_TIMEOUT_MS)
        : Promise.resolve(null),
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

    // Manual — only fill gaps; group by chain, use cheapest
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

  // ── 2. Collect the set of storeKeys that actually have prices ─────────────
  const relevantStoreKeys = new Set();
  for (const storeEntries of Object.values(priceMap)) {
    for (const key of Object.keys(storeEntries)) relevantStoreKeys.add(key);
  }
  let candidateKeys = [...relevantStoreKeys].slice(0, MAX_STORES_TO_LOAD);

  // ── 3. storeCoords pre-filter (lightweight radius filter) ─────────────────
  // storeCoords/{key} = { lat, lng, city } ~28 KB vs ~141 KB for full stores node.
  // Gracefully skipped if the index doesn't exist yet (first deploy / not synced).
  let usedCoordsPrefilt = false;
  if (hasLoc && candidateKeys.length > 0) {
    try {
      const coordsData = await restGet(dbUrl, 'storeCoords', COORDS_TIMEOUT_MS);
      if (coordsData && typeof coordsData === 'object') {
        candidateKeys = candidateKeys.filter(k => {
          const c = coordsData[k];
          if (!c) return true; // not in storeCoords yet → include (safe default)
          const clat = c.lat ?? c.latitude ?? null;
          const clng = c.lng ?? c.longitude ?? null;
          if (clat == null || clng == null) return true;
          return haversine(userLat, userLng, clat, clng) <= radius;
        });
        usedCoordsPrefilt = true;
      }
    } catch (e) {
      logError('basket-compare:storeCoords', e, { phase: 'coords-prefilt' });
      // storeCoords read failed → fall through to post-load radius filter
    }
  }

  // ── 4. Load only relevant stores in parallel (REST, no WebSocket) ─────────
  const storeIndex = {};
  await Promise.allSettled(
    candidateKeys.map(async key => {
      try {
        const data = await restGet(dbUrl, `stores/${key}`, STORE_TIMEOUT_MS);
        if (data && typeof data === 'object') storeIndex[key] = data;
      } catch (_) {}
    })
  );

  // ── 5. Radius filter using loaded store coordinates ───────────────────────
  // Only needed when storeCoords pre-filter was unavailable.
  const nearbyKeys = (hasLoc && !usedCoordsPrefilt)
    ? candidateKeys.filter(k => {
        const s = storeIndex[k];
        if (!s?.hasCoords) return !wantApproximate ? s?.approximateLocation !== true : true;
        if (!wantApproximate && s.approximateLocation === true) return false;
        return haversine(userLat, userLng, s.latitude, s.longitude) <= radius;
      })
    : candidateKeys.filter(k => wantApproximate || storeIndex[k]?.approximateLocation !== true);

  // ── 6. Calculate basket per store ─────────────────────────────────────────
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

  // Sort: full basket cheapest first, then partial by completeness then price
  const full    = storeResults.filter(s => !s.missingItems.length).sort((a, b) => a.total - b.total);
  const partial = storeResults
    .filter(s => s.missingItems.length > 0 && s.availableItems > 0)
    .sort((a, b) => b.completeness - a.completeness || a.total - b.total);
  const sorted  = [...full, ...partial];

  // ── 7. Travel cost awareness ──────────────────────────────────────────────
  if (hasLoc) {
    sorted.forEach(r => {
      if (r.distanceKm !== null) {
        r.travelCostILS = Math.round(r.distanceKm * 2 * COST_PER_KM * 100) / 100;
      }
    });
  }

  // ── 8. Summary object ─────────────────────────────────────────────────────
  let summary = null;
  if (sorted.length >= 1) {
    const cheapest = sorted[0];
    const priciest = sorted[sorted.length - 1];
    const maxSavings    = Math.round((priciest.total - cheapest.total) * 100) / 100;
    const maxSavingsPct = priciest.total > 0
      ? Math.round((maxSavings / priciest.total) * 100) : 0;

    const withDist = sorted.filter(r => r.distanceKm !== null);
    const closest  = withDist.length
      ? withDist.reduce((a, b) => a.distanceKm < b.distanceKm ? a : b) : null;

    const bestFull = full[0] || null;

    // Net savings: gross price saving − extra round-trip cost vs closest
    let netSavingsVsClosest = null;
    if (bestFull && closest && bestFull !== closest && closest.travelCostILS !== undefined) {
      const grossSaving = closest.total - bestFull.total;
      const extraTravel = Math.max(0, (bestFull.travelCostILS ?? 0) - (closest.travelCostILS ?? 0));
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
    version:        '2.3.0',
    radiusKm:       radius,
    itemsRequested: validItems.length,
    bestFullBasket: full[0] || null,
    summary,
    results:        sorted.slice(0, 20),
    note: 'Items marked isFallback:true use proxy/manual prices — official XML sync pending',
  });
}

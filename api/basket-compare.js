// api/basket-compare.js — v2.2.0
// POST /api/basket-compare
//
// Uses official XML prices first.
// Clearly marks items using proxy/manual fallback.
//
// v2.2.0 changes:
//   - Selective store loading: prices fetched first → only relevant storeKeys loaded.
//     Eliminates the full stores-node read (was 5-10 MB at scale).
//   - storeCoords pre-filter: if the lightweight storeCoords index exists it is read
//     first (< 500 KB) to narrow per-key reads before loading full store records.
//   - withTimeout on every Firebase read; graceful degradation on timeout.
//   - COST_PER_KM now driven by COST_PER_KM_ILS env var (default 1.50 ₪/km).
//   - Travel-cost per-card math fixed: compares net benefit of driving to cheapest
//     vs. staying at current store (was comparing absolute travel vs. price delta).
//   - Input cap: max 50 items per request.
//   - Structured error logging via logError.

import {
  getDB,
  haversine,
  setCors,
  isValidBarcode,
  withTimeout,
  logError,
} from './_firebase.js';

// ── Travel cost model ────────────────────────────────────────────────────────
// Israeli average fuel + running cost per km (one way).
// Override with COST_PER_KM_ILS env var so the rate can be updated without redeploy.
const COST_PER_KM = parseFloat(process.env.COST_PER_KM_ILS || '1.50');

// ── Timeout budgets ──────────────────────────────────────────────────────────
const INIT_TIMEOUT_MS   = 8_000;  // Firebase SDK init
const PRICE_TIMEOUT_MS  = 5_000;  // per-barcode Firebase reads
const STORE_TIMEOUT_MS  = 4_000;  // per-storeKey read
const COORDS_TIMEOUT_MS = 4_000;  // storeCoords index (lightweight)

// ── Safety caps ──────────────────────────────────────────────────────────────
const MAX_ITEMS          = 50;   // max barcodes per request
const MAX_STORES_TO_LOAD = 100;  // max individual store reads

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

  if (items.length > MAX_ITEMS)
    return res.status(400).json({ error: `Max ${MAX_ITEMS} items per request` });

  const userLat = parseFloat(lat || '');
  const userLng = parseFloat(lng || '');
  const radius  = parseFloat(radiusKm || '10');
  const hasLoc  = !isNaN(userLat) && !isNaN(userLng);

  const validItems = items
    .map(i => ({ barcode: String(i.barcode || '').replace(/\D/g, ''), qty: Math.max(1, parseInt(i.quantity || 1)) }))
    .filter(i => isValidBarcode(i.barcode));

  if (!validItems.length) return res.status(400).json({ error: 'No valid barcodes' });

  // ── 1. Firebase init (with timeout) ─────────────────────────────────────────
  let db;
  try {
    db = await withTimeout(getDB(), INIT_TIMEOUT_MS, 'init');
  } catch (e) {
    logError('basket-compare', e, { phase: 'init' });
    return res.status(504).json({ error: 'Firebase connection timed out', retryAfter: 30 });
  }
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  // ── 2. Fetch prices for all barcodes in parallel ─────────────────────────────
  // Prices are fetched BEFORE stores so we know exactly which stores matter.
  const priceMap = {}; // barcode → { storeKey → priceEntry }
  await Promise.all(validItems.map(async ({ barcode }) => {
    const snaps = await Promise.allSettled([
      withTimeout(db.ref(`prices/${barcode}`).get(),                          PRICE_TIMEOUT_MS, `prices:${barcode}`),
      withTimeout(db.ref(`proxyCache/${barcode}`).get(),                       PRICE_TIMEOUT_MS, `proxy:${barcode}`),
      groupId
        ? withTimeout(db.ref(`manualPrices/${groupId}/${barcode}`).get(),      PRICE_TIMEOUT_MS, `manual:${barcode}`)
        : Promise.resolve(null),
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
        if (p?.price > 0 && !priceMap[barcode][k] && (now - (p.fetchedAt || 0)) < 3_600_000) {
          priceMap[barcode][k] = { ...p, source: 'proxy' };
        }
      });
    }

    // Manual — only for stores not covered by official or proxy
    if (snaps[2]?.status === 'fulfilled' && snaps[2].value?.exists()) {
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

  // ── 3. Collect the set of storeKeys that actually have prices ────────────────
  const relevantStoreKeys = new Set();
  for (const storeEntries of Object.values(priceMap)) {
    for (const key of Object.keys(storeEntries)) {
      relevantStoreKeys.add(key);
    }
  }
  let candidateKeys = [...relevantStoreKeys].slice(0, MAX_STORES_TO_LOAD);

  // ── 4. storeCoords pre-filter (lightweight radius filter before loading full records)
  // storeCoords/{key} = { lat, lng, city } written by the price sync worker.
  // At 10 000 stores this is ~500 KB vs ~5 MB for the full stores node.
  // If the index doesn't exist yet (first deploy), skip pre-filter gracefully.
  let usedCoordsPrefilt = false;
  if (hasLoc && candidateKeys.length > 0) {
    try {
      const coordsSnap = await withTimeout(
        db.ref('storeCoords').get(), COORDS_TIMEOUT_MS, 'storeCoords'
      );
      if (coordsSnap?.exists()) {
        const coordsIndex = coordsSnap.val();
        candidateKeys = candidateKeys.filter(k => {
          const c = coordsIndex[k];
          if (!c) return true; // not in storeCoords yet → include (safe default)
          const clat = c.lat ?? c.latitude ?? null;
          const clng = c.lng ?? c.longitude ?? null;
          if (!clat || !clng) return true; // no coords in lightweight index → include
          return haversine(userLat, userLng, clat, clng) <= radius;
        });
        usedCoordsPrefilt = true;
      }
    } catch (_) {
      // storeCoords read failed/timed out → fall through to post-load radius filter
    }
  }

  // ── 5. Load only relevant stores in parallel ─────────────────────────────────
  // This replaces db.ref('stores').get() — which loaded the entire stores node.
  const storeIndex = {};
  await Promise.allSettled(
    candidateKeys.map(async key => {
      try {
        const snap = await withTimeout(db.ref(`stores/${key}`).get(), STORE_TIMEOUT_MS, `store:${key}`);
        if (snap?.exists()) storeIndex[key] = snap.val();
      } catch (_) {}
    })
  );

  // ── 6. Radius filter using loaded store coordinates ──────────────────────────
  // Only needed when storeCoords pre-filter was unavailable.
  const nearbyKeys = (hasLoc && !usedCoordsPrefilt)
    ? candidateKeys.filter(k => {
        const s = storeIndex[k];
        if (!s?.hasCoords) return true; // include stores without coords (pre-geocoding)
        return haversine(userLat, userLng, s.latitude, s.longitude) <= radius;
      })
    : candidateKeys;

  // ── 7. Calculate basket per store ────────────────────────────────────────────
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
      chainId:         store.chainId    || '',
      chainName:       store.chainName  || storeKey,
      storeId:         store.storeId    || '',
      storeName:       store.storeName  || '',
      city:            store.city       || '',
      address:         store.address    || '',
      distanceKm:      dist,
      total,
      availableItems:  foundItems.length,
      missingItems:    missingBarcodes.length,
      totalItems:      validItems.length,
      completeness:    Math.round(foundItems.length / validItems.length * 100),
      hasFallbackData: hasFallback,
      items:           foundItems,
      missingBarcodes,
    };
  }).filter(Boolean);

  // Sort: full basket cheapest first, then partial by completeness then price
  const full    = storeResults.filter(s => s.missingItems === 0).sort((a, b) => a.total - b.total);
  const partial = storeResults.filter(s => s.missingItems > 0 && s.availableItems > 0)
    .sort((a, b) => b.completeness - a.completeness || a.total - b.total);

  const sorted = [...full, ...partial];

  // ── 8. Travel Cost Awareness ─────────────────────────────────────────────────
  // Round-trip cost = distance × 2 × COST_PER_KM
  if (hasLoc) {
    sorted.forEach(r => {
      if (r.distanceKm !== null) {
        r.travelCostILS = Math.round(r.distanceKm * 2 * COST_PER_KM * 100) / 100;
      }
    });
  }

  // ── 9. Summary object ────────────────────────────────────────────────────────
  let summary = null;
  if (sorted.length >= 1) {
    const cheapest = sorted[0];
    const priciest = sorted[sorted.length - 1];
    const maxSavings = Math.round((priciest.total - cheapest.total) * 100) / 100;
    const maxSavingsPct = priciest.total > 0
      ? Math.round((maxSavings / priciest.total) * 100)
      : 0;

    // Closest store (may differ from cheapest)
    const withDist = sorted.filter(r => r.distanceKm !== null);
    const closest  = withDist.length
      ? withDist.reduce((a, b) => a.distanceKm < b.distanceKm ? a : b)
      : null;

    // Best *full* basket
    const bestFull = full[0] || null;

    // Net savings: choosing the cheapest full store vs. the closest full store.
    // = gross price saving − extra round-trip cost to reach cheapest instead of closest.
    // Positive = worth the extra drive; negative = closest is cheaper after travel.
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
    version:        '2.2.0',
    radiusKm:       radius,
    itemsRequested: validItems.length,
    bestFullBasket: full[0] || null,
    summary,
    results:        sorted.slice(0, 20),
    note: 'Items marked isFallback:true use proxy/manual prices — official XML sync pending',
  });
}

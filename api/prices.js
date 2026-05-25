// api/prices.js — v6.0.0
// GET /api/prices?barcode=&q=&lat=&lng=&radiusKm=&groupId=&userId=
//
// Price priority (deterministic):
//   A. userPriceOverrides/{userId}/{barcode}/{key}   — personal only
//   B. prices/{barcode}/{chainId_storeId}            — official XML (primary)
//   C. proxyCache/{barcode}/{chainKey}               — proxy TTL 1h, only if no official
//   D. manualPrices/{groupId}/{barcode}/{entryId}    — family scoped, only if no official/proxy
//   E. priceReports — warning signal only, never shown as real price

import { getDB, getLastError, haversine, setCors, isValidBarcode, isValidPrice } from './_firebase.js';

// Hebrew → English dictionary for Open Food Facts search
const HE_EN = {
  'חלב':'milk','חלב 3%':'milk 3%','חלב 1%':'milk 1%','חלב עיזים':'goat milk',
  'גבינה':'cheese','גבינה לבנה':'white cheese',"קוטג'":'cottage cheese','קוטג':'cottage cheese',
  'שמנת':'cream','יוגורט':'yogurt','חמאה':'butter','לחם':'bread','פיתה':'pita',
  'קמח':'flour','ביצים':'eggs','ביצה':'egg','קורנפלקס':'cornflakes',
  'שיבולת שועל':'oatmeal','גרנולה':'granola','אורז':'rice','פסטה':'pasta',
  'ספגטי':'spaghetti','מקרוני':'macaroni','שמן':'oil','שמן זית':'olive oil',
  'שמן חמניות':'sunflower oil','סוכר':'sugar','דבש':'honey','מלח':'salt',
  'טחינה':'tahini','חומוס':'hummus','קטשופ':'ketchup','מיונז':'mayonnaise',
  'טונה':'tuna','קפה':'coffee','תה':'tea','מיץ':'juice','מים':'water',
  'שוקולד':'chocolate','עוגיות':'cookies','במבה':'bamba','ביסלי':'bisli',
  'גלידה':'ice cream','עוף':'chicken','בשר טחון':'ground beef',
  'עגבניות':'tomatoes','מלפפון':'cucumber','בצל':'onion','שום':'garlic',
  'גזר':'carrot','תפוח אדמה':'potato','ברוקולי':'broccoli',
  'תפוח':'apple','בננה':'banana','תפוז':'orange','לימון':'lemon',
  'נייר טואלט':'toilet paper','סבון':'soap','שמפו':'shampoo',
  'אבקת כביסה':'laundry detergent','נוזל כלים':'dish soap',
};

const isHebrew = s => /[\u0590-\u05FF]/.test(s);
const translate = q => {
  const l = q.trim();
  if (HE_EN[l]) return HE_EN[l];
  for (const [h, e] of Object.entries(HE_EN)) if (l.includes(h) || h.includes(l)) return e;
  return null;
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { barcode, q, lat, lng, radiusKm, groupId, userId, includeStale } = req.query || {};
  const wantStale = includeStale === 'true';

  const userLat  = parseFloat(lat  || '');
  const userLng  = parseFloat(lng  || '');
  const radius   = parseFloat(radiusKm || '0');
  const hasLoc   = !isNaN(userLat) && !isNaN(userLng) && radius > 0;

  // ── MODE A: Direct barcode lookup ──
  if (barcode) {
    const clean = String(barcode).replace(/\D/g, '');
    if (!isValidBarcode(clean)) return res.status(400).json({ error: 'Invalid barcode' });

    try {
      const db = await getDB();
      if (!db) {
        const lastError = getLastError();
        return res.status(200).json({
          barcode: clean, prices: [], source: 'none',
          isStale: true, lastUpdated: null,
          warning: 'Firebase not initialized',
          error: lastError || 'database_unavailable',
        });
      }
      // Load store index for distance annotation + radius filtering
      let storeIndex = {};
      if (hasLoc) {
        try {
          const snap = await db.ref('stores').get();
          if (snap.exists()) storeIndex = snap.val();
        } catch (_) {}
      }
      const result = await buildLayeredPrices(db, clean, userId, groupId, hasLoc, userLat, userLng, radius, storeIndex, wantStale);
      return res.status(200).json({ version: '6.0.0', barcode: clean, ...result });
    } catch (e) {
      console.error('[prices] barcode error:', e.message);
      return res.status(200).json({
        barcode, prices: [], source: 'firebase_cache',
        isStale: true, lastUpdated: null,
        warning: 'Price data temporarily unavailable — please try again',
        error: e.message,
      });
    }
  }

  // ── MODE B: Product name search ──
  if (!q || String(q).trim().length < 2)
    return res.status(400).json({ error: 'Provide ?barcode= or ?q=' });

  const query = String(q).trim();
  const hebrew = isHebrew(query);
  const en = hebrew ? (translate(query) || query) : query;
  console.log(`[prices v6] search: "${query}" → "${en}"`);

  try {
    const [offProducts, db] = await Promise.all([
      searchOFF(query, en),
      getDB(),
    ]);

    // Load store index for radius filtering
    let storeIndex = {};
    if (hasLoc && db) {
      try {
        const snap = await db.ref('stores').get();
        if (snap.exists()) storeIndex = snap.val();
      } catch (_) {}
    }

    const enriched = await Promise.all(offProducts.map(async p => {
      if (!p.barcode || !isValidBarcode(p.barcode)) {
        return { ...p, prices: [], source: 'none' };
      }
      const layered = await buildLayeredPrices(
        db, p.barcode, userId, groupId,
        hasLoc, userLat, userLng, radius, storeIndex, wantStale
      );
      return { ...p, ...layered };
    }));

    // Sort: official prices first, then proxy, then manual, then none
    const ORDER = { official: 0, override: 0, proxy: 1, manual: 2, none: 3 };
    enriched.sort((a, b) =>
      (ORDER[a.source] ?? 3) - (ORDER[b.source] ?? 3) ||
      (b.prices?.length || 0) - (a.prices?.length || 0)
    );

    let syncStatus = null;
    if (db) {
      try {
        const s = await db.ref('syncSummary').get();
        if (s.exists()) syncStatus = s.val();
      } catch (_) {}
    }

    return res.status(200).json({
      version: '6.0.0', query, englishQuery: en,
      results: enriched.slice(0, 20), total: enriched.length,
      syncStatus,
    });

  } catch (e) {
    console.error('[prices] search error:', e.message);
    return res.status(200).json({ version: '6.0.0', query, results: [], error: e.message });
  }
}

// ─────────────────────────────────────────────
// buildLayeredPrices — core priority logic
// Returns { prices, source, communityWarning }
// ─────────────────────────────────────────────
async function buildLayeredPrices(db, barcode, userId, groupId, hasLoc, lat, lng, radius, storeIndex = {}, includeStale = false) {
  if (!db) return { prices: [], source: 'none', communityWarning: null };

  // Fetch all layers in parallel
  const tasks = {
    official: db.ref(`prices/${barcode}`).get(),
    proxy:    db.ref(`proxyCache/${barcode}`).get(),
    reports:  db.ref(`priceReports/${barcode}`).get(),
  };
  if (userId) tasks.override = db.ref(`userPriceOverrides/${userId}/${barcode}`).get();
  if (groupId) tasks.manual  = db.ref(`manualPrices/${groupId}/${barcode}`).get();

  const snaps = {};
  await Promise.all(
    Object.entries(tasks).map(async ([key, promise]) => {
      try { snaps[key] = await promise; } catch (_) { snaps[key] = null; }
    })
  );

  const now = Date.now();

  // A. Personal overrides (userId scoped)
  const overrides = snaps.override?.exists() ? snaps.override.val() : {};

  // B. Official XML prices
  let official = [];
  if (snaps.official?.exists()) {
    official = Object.entries(snaps.official.val())
      .filter(([, p]) => p?.price > 0)
      .map(([key, p]) => ({
        ...p, _key: key, source: 'official',
        // Apply personal override if exists
        displayPrice: overrides[key]?.overridePrice ?? p.price,
        override:     overrides[key] ?? null,
      }));
    if (hasLoc) official = filterByRadius(official, lat, lng, radius, storeIndex);
    official.sort((a, b) => a.displayPrice - b.displayPrice);
  }

  if (official.length > 0) {
    const STALE_MS = 36 * 3600 * 1000;

    // Tag each row with its own isStale flag.
    // syncedAt is stored as Date.now() (unix ms) by the price worker.
    official = official.map(p => ({
      ...p,
      isStale: !p.syncedAt || (now - Number(p.syncedAt)) > STALE_MS,
    }));

    // Partition into fresh / stale
    const freshRows = official.filter(p => !p.isStale);
    const staleRows = official.filter(p =>  p.isStale);

    // Sort each partition cheapest-first
    freshRows.sort((a, b) => a.displayPrice - b.displayPrice);
    staleRows.sort((a, b) => a.displayPrice - b.displayPrice);

    // By default exclude stale rows; caller opts in with ?includeStale=true
    const prices = includeStale ? [...freshRows, ...staleRows] : freshRows;

    // Response-level flags
    const allStale       = freshRows.length === 0;          // true only when every row is stale
    const hasStaleEntries = staleRows.length > 0;            // true when any mix exists

    // lastUpdated = most recent syncedAt among fresh rows; fall back to stale
    const bestFresh = freshRows.length ? Math.max(...freshRows.map(p => Number(p.syncedAt))) : 0;
    const bestStale = staleRows.length ? Math.max(...staleRows.map(p => Number(p.syncedAt))) : 0;
    const lastUpdatedMs = bestFresh || bestStale;
    const lastUpdated   = lastUpdatedMs ? new Date(lastUpdatedMs).toISOString() : null;

    const warning = buildCommunityWarning(snaps.reports, official);
    return {
      prices,
      source: 'firebase_cache',
      isStale: allStale,
      hasStaleEntries,
      lastUpdated,
      warning: allStale ? 'Prices may be outdated — sync pending' : null,
      communityWarning: warning,
    };
  }

  // C. Proxy cache (TTL 1 hour) — only if no official
  let proxy = [];
  if (snaps.proxy?.exists()) {
    proxy = Object.values(snaps.proxy.val())
      .filter(p => p?.price > 0 && (now - (p.fetchedAt || 0)) < 3_600_000)
      .map(p => ({ ...p, source: 'proxy', displayPrice: p.price }));
    if (hasLoc) proxy = filterByRadius(proxy, lat, lng, radius, storeIndex);
    proxy.sort((a, b) => a.displayPrice - b.displayPrice);
  }

  if (proxy.length > 0) {
    return { prices: proxy, source: 'proxy', communityWarning: null };
  }

  // D. Manual family prices (groupId scoped) — only if no official or proxy
  let manual = [];
  if (snaps.manual?.exists()) {
    manual = Object.values(snaps.manual.val())
      .filter(p => p?.price > 0)
      .map(p => ({ ...p, source: 'manual', displayPrice: p.price }))
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    // De-dup by chain — keep latest per chain
    const seen = new Set();
    manual = manual.filter(p => {
      const k = p.chainName || p.storeName || '';
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  if (manual.length > 0) {
    return { prices: manual, source: 'manual', communityWarning: null };
  }

  return { prices: [], source: 'none', communityWarning: null };
}

// Filter prices to stores within radius and annotate each entry with distanceKm
function filterByRadius(prices, lat, lng, radius, storeIndex) {
  return prices
    .map(p => {
      const key = `${p.chainId || ''}_${p.storeId || ''}`;
      const store = storeIndex[key];
      if (!store?.hasCoords) return p; // no coords — keep without distance
      const dist = Math.round(haversine(lat, lng, store.latitude, store.longitude) * 10) / 10;
      return { ...p, distanceKm: dist };
    })
    .filter(p => {
      if (p.distanceKm == null) return true; // include when no coords available
      return p.distanceKm <= radius;
    });
}

// Build community warning from reports
function buildCommunityWarning(reportsSnap, officialPrices) {
  if (!reportsSnap?.exists()) return null;
  const reports = reportsSnap.val();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
  const warnings = [];

  for (const [chainKey, chainReports] of Object.entries(reports)) {
    if (!chainReports) continue;
    const recent = Object.values(chainReports)
      .filter(r => r?.reportedAt && new Date(r.reportedAt).getTime() > thirtyDaysAgo);
    if (recent.length < 2) continue;

    const prices = recent.map(r => r.reportedPrice).filter(p => isValidPrice(p));
    if (!prices.length) continue;

    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const officialForChain = officialPrices.find(p => `${p.chainId||''}_${p.storeId||''}` === chainKey);
    if (officialForChain) {
      warnings.push({
        chainKey,
        chainName: officialForChain.chainName || '',
        officialPrice: officialForChain.price,
        reportCount: recent.length,
        reportedMin: minP,
        reportedMax: maxP,
        message: `${recent.length} משתמשים דיווחו מחיר שונה: ₪${minP.toFixed(2)}${minP !== maxP ? `–₪${maxP.toFixed(2)}` : ''}`,
      });
    }
  }
  return warnings.length > 0 ? warnings : null;
}

// Open Food Facts search — prefers Israeli products
async function searchOFF(hebrewQuery, englishQuery) {
  const seen = new Set(), results = [];
  const isHeb = isHebrew(hebrewQuery);
  const urls = [
    // Israeli products first
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags&tagtype_0=countries&tag_contains_0=contains&tag_0=israel`,
    // Hebrew search
    isHeb ? `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(hebrewQuery)}&search_simple=1&action=process&json=1&page_size=6&fields=product_name,product_name_he,brands,quantity,image_small_url,code` : null,
    // Global fallback
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=12&fields=product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags`,
  ].filter(Boolean);

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'FamilyShoppingIL/6.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const p of data?.products || []) {
        const code = p.code || '';
        if (code && seen.has(code)) continue;
        if (code) seen.add(code);
        const name = p.product_name_he || p.product_name || '';
        if (!name) continue;
        const isIsraeli = (p.countries_tags || []).some(c => c.includes('israel'));
        results.push({
          name, brand: p.brands || '', size: p.quantity || '',
          image: p.image_small_url || '', barcode: code,
          isIsraeli, prices: [], source: 'none',
        });
      }
      if (results.length >= 10) break;
    } catch (e) {
      console.warn('[OFF] search error:', e.message);
    }
  }

  // Israeli products first
  results.sort((a, b) => (b.isIsraeli ? 1 : 0) - (a.isIsraeli ? 1 : 0));
  return results.slice(0, 12);
}

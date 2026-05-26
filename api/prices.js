// api/prices.js — v6.2.0
// GET /api/prices?barcode=&q=&lat=&lng=&radiusKm=&groupId=&userId=&debug=1
//
// Price priority (deterministic):
//   A. userPriceOverrides/{userId}/{barcode}/{key}   — personal only
//   B. prices/{barcode}/{chainId_storeId}            — official XML (primary)
//   C. proxyCache/{barcode}/{chainKey}               — proxy TTL 1h, only if no official
//   D. manualPrices/{groupId}/{barcode}/{entryId}    — family scoped, only if no official/proxy
//   E. priceReports — warning signal only, never shown as real price
//
// v6.2.0 changes (over v6.1.0):
//   - ALL Firebase reads now use fetch() REST API — eliminates Admin SDK WebSocket hang
//   - OAuth2 admin token generated from service-account credentials (cached 50 min)
//   - Store index cached 5 min in module scope (reduces redundant stores/ fetches)
//   - buildLayeredPrices takes dbUrl (string) instead of db (Admin SDK handle)
//   - initMs now measures admin token acquisition (was: SDK init + auth token)
//   - Target: barcode lookup < 2 s (was: 5 s+ timeout)

import { restGet, getDbUrl, getAdminToken, haversine, setCors, isValidBarcode, isValidPrice } from './_firebase.js';

// ── Constants ────────────────────────────────────────────────────────────────
const INIT_TIMEOUT_MS  = 8_000;   // admin token fetch budget
const READ_TIMEOUT_MS  = 5_000;   // per restGet call
const BUILD_TIMEOUT_MS = 10_000;  // whole buildLayeredPrices budget
const STALE_MS         = 36 * 3_600_000; // 36 h
const MAX_PRICES       = 50;      // cap price list per barcode response
const STORE_CACHE_MS   = 5 * 60_000;     // 5 min store index cache

// ── Timeout helper ───────────────────────────────────────────────────────────
function withTimeout(promise, ms, label = '') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error(`timeout:${label}`), { isTimeout: true })),
        ms
      )
    ),
  ]);
}

// ── Store index cache (module-level, reused across requests) ─────────────────
let _storeCache    = null;
let _storeCacheExp = 0;

async function getStoreIndex(dbUrl) {
  const now = Date.now();
  if (_storeCache && _storeCacheExp > now) return _storeCache;
  const data = await restGet(dbUrl, 'stores', READ_TIMEOUT_MS);
  _storeCache    = (data && typeof data === 'object') ? data : {};
  _storeCacheExp = now + STORE_CACHE_MS;
  return _storeCache;
}

// ── Hebrew → English for Open Food Facts search ──────────────────────────────
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

const isHebrew  = s => /[֐-׿]/.test(s);
const translate = q => {
  const l = q.trim();
  if (HE_EN[l]) return HE_EN[l];
  for (const [h, e] of Object.entries(HE_EN)) if (l.includes(h) || h.includes(l)) return e;
  return null;
};

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const t0 = Date.now();
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { barcode, q, lat, lng, radiusKm, groupId, userId, debug } = req.query || {};
  const isDebug = debug === '1' || debug === 'true';
  const timings = { initMs: 0, priceReadMs: 0, storeReadMs: 0, totalMs: 0 };

  const userLat = parseFloat(lat  || '');
  const userLng = parseFloat(lng  || '');
  const radius  = parseFloat(radiusKm || '0');
  const hasLoc  = !isNaN(userLat) && !isNaN(userLng) && radius > 0;

  // ── MODE A: Direct barcode lookup ─────────────────────────────────────────
  if (barcode) {
    const clean = String(barcode).replace(/\D/g, '');
    if (!isValidBarcode(clean)) return res.status(400).json({ error: 'Invalid barcode' });

    const dbUrl = getDbUrl();
    if (!dbUrl) {
      timings.totalMs = Date.now() - t0;
      return res.status(503).json({
        barcode: clean, prices: [], source: 'none',
        error: 'Firebase not initialized (missing FIREBASE_DATABASE_URL)',
        ...(isDebug ? { timings } : {}),
      });
    }

    // Pre-warm admin token (measures cold-start OAuth2 fetch; ~0 ms on warm)
    const tInit = Date.now();
    await getAdminToken().catch(() => {});
    timings.initMs = Date.now() - tInit;

    // Build prices with hard total budget
    try {
      const result = await withTimeout(
        buildLayeredPrices(dbUrl, clean, userId, groupId, hasLoc, userLat, userLng, radius, timings),
        BUILD_TIMEOUT_MS,
        'buildLayeredPrices'
      );
      timings.totalMs = Date.now() - t0;

      const response = { version: '6.2.0', barcode: clean, ...result };
      if (isDebug) response.timings = timings;
      return res.status(200).json(response);

    } catch (e) {
      timings.totalMs = Date.now() - t0;
      const isTimeoutLike = e.isTimeout || e.name === 'TimeoutError' || e.name === 'AbortError';
      if (isTimeoutLike) {
        console.error(`[prices] build timeout ${timings.totalMs}ms barcode=${clean}`);
        return res.status(504).json({
          error: 'Firebase read timed out',
          message: 'Price lookup timed out — try again in a moment',
          barcode: clean,
          ...(isDebug ? { timings } : {}),
        });
      }
      console.error('[prices] barcode error:', e.message);
      return res.status(200).json({
        barcode: clean, prices: [], source: 'firebase_cache',
        isStale: true, lastUpdated: null,
        warning: 'Price data temporarily unavailable — please try again',
        error: e.message,
        ...(isDebug ? { timings } : {}),
      });
    }
  }

  // ── MODE B: Product name search ───────────────────────────────────────────
  if (!q || String(q).trim().length < 2)
    return res.status(400).json({ error: 'Provide ?barcode= or ?q=' });

  const query  = String(q).trim();
  const hebrew = isHebrew(query);
  const en     = hebrew ? (translate(query) || query) : query;
  console.log(`[prices v6.2] search: "${query}" → "${en}"`);

  const dbUrl = getDbUrl();

  try {
    const tInit = Date.now();
    // OFF search + token pre-warm in parallel
    const [offProducts] = await Promise.all([
      searchOFF(query, en),
      getAdminToken().catch(() => {}),
    ]);
    timings.initMs = Date.now() - tInit;

    // Load store index once for radius filtering (search mode)
    let storeIndex = {};
    if (hasLoc && dbUrl) {
      try {
        const tStore = Date.now();
        storeIndex = await getStoreIndex(dbUrl);
        timings.storeReadMs = Date.now() - tStore;
      } catch (_) {}
    }

    const enriched = await Promise.all(offProducts.map(async p => {
      if (!p.barcode || !isValidBarcode(p.barcode) || !dbUrl)
        return { ...p, prices: [], source: 'none' };
      const layered = await buildLayeredPrices(
        dbUrl, p.barcode, userId, groupId,
        hasLoc, userLat, userLng, radius, {},
        storeIndex
      ).catch(() => ({ prices: [], source: 'none', communityWarning: null }));
      return { ...p, ...layered };
    }));

    const ORDER = { official: 0, override: 0, proxy: 1, manual: 2, none: 3 };
    enriched.sort((a, b) =>
      (ORDER[a.source] ?? 3) - (ORDER[b.source] ?? 3) ||
      (b.prices?.length || 0) - (a.prices?.length || 0)
    );

    let syncStatus = null;
    if (dbUrl) {
      try {
        const data = await restGet(dbUrl, 'syncSummary', 3_000);
        if (data !== null) syncStatus = data;
      } catch (_) {}
    }

    timings.totalMs = Date.now() - t0;
    const response = {
      version: '6.2.0', query, englishQuery: en,
      results: enriched.slice(0, 20), total: enriched.length,
      syncStatus,
    };
    if (isDebug) response.timings = timings;
    return res.status(200).json(response);

  } catch (e) {
    console.error('[prices] search error:', e.message);
    timings.totalMs = Date.now() - t0;
    return res.status(200).json({
      version: '6.2.0', query, results: [], error: e.message,
      ...(isDebug ? { timings } : {}),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLayeredPrices — core priority logic
// Returns { prices, source, isStale?, lastUpdated?, warning?, communityWarning }
//
// All Firebase reads go via restGet() (HTTP REST) — no Admin SDK WebSocket.
//
// Read strategy (sequential, not parallel):
//   1. Official + user-override in parallel (always needed)
//   2. If official found → read reports (for warnings), return
//   3. If no official → proxy + manual in parallel, return
//
// storeIndex: pass pre-loaded stores (search mode) or undefined to lazy-load (barcode mode)
// ─────────────────────────────────────────────────────────────────────────────
async function buildLayeredPrices(
  dbUrl, barcode, userId, groupId,
  hasLoc, lat, lng, radius,
  timings = {},           // filled by barcode-mode caller
  storeIndex = undefined  // undefined = lazy-load if hasLoc; object = already loaded
) {
  if (!dbUrl) return { prices: [], source: 'none', communityWarning: null };

  // ── Phase 1: Official + user-override (parallel, always needed) ──────────
  const tPrice = Date.now();
  const [officialData, overrideData] = await Promise.all([
    restGet(dbUrl, `prices/${barcode}`, READ_TIMEOUT_MS),
    userId
      ? restGet(dbUrl, `userPriceOverrides/${userId}/${barcode}`, READ_TIMEOUT_MS).catch(() => null)
      : Promise.resolve(null),
  ]);
  timings.priceReadMs = Date.now() - tPrice;

  const overrides = (overrideData && typeof overrideData === 'object') ? overrideData : {};

  // ── Process official prices ──────────────────────────────────────────────
  let official = [];
  if (officialData && typeof officialData === 'object') {
    official = Object.entries(officialData)
      .filter(([, p]) => p?.price > 0)
      .map(([key, p]) => ({
        ...p, _key: key, source: 'official',
        displayPrice: overrides[key]?.overridePrice ?? p.price,
        override:     overrides[key] ?? null,
      }));

    // Radius filter — use cached store index in barcode mode
    if (hasLoc && official.length > 0) {
      let idx = storeIndex;
      if (idx === undefined) {
        const tStore = Date.now();
        try {
          idx = await getStoreIndex(dbUrl);
        } catch (_) {
          idx = {};
        }
        timings.storeReadMs = Date.now() - tStore;
      }
      official = filterByRadius(official, lat, lng, radius, idx);
    }

    official.sort((a, b) => a.displayPrice - b.displayPrice);
  }

  // ── Return official result ───────────────────────────────────────────────
  if (official.length > 0) {
    let reportsData = null;
    try {
      reportsData = await restGet(dbUrl, `priceReports/${barcode}`, 3_000);
    } catch (_) {}

    const communityWarning = buildCommunityWarning(reportsData, official);
    const latestSync  = Math.max(...official.map(p => p.syncedAt || 0));
    const isStale     = !latestSync || (Date.now() - latestSync) > STALE_MS;
    const lastUpdated = latestSync ? new Date(latestSync).toISOString() : null;

    return {
      prices:    official.slice(0, MAX_PRICES),
      source:    'firebase_cache',
      isStale,
      lastUpdated,
      warning:   isStale ? 'Prices may be outdated — sync pending' : null,
      communityWarning,
    };
  }

  // ── Phase 2: No official — try proxy + manual in parallel ────────────────
  const [proxyData, manualData] = await Promise.all([
    restGet(dbUrl, `proxyCache/${barcode}`, READ_TIMEOUT_MS).catch(() => null),
    groupId
      ? restGet(dbUrl, `manualPrices/${groupId}/${barcode}`, READ_TIMEOUT_MS).catch(() => null)
      : Promise.resolve(null),
  ]);

  const now = Date.now();

  // C. Proxy cache (TTL 1 hour)
  let proxy = [];
  if (proxyData && typeof proxyData === 'object') {
    proxy = Object.values(proxyData)
      .filter(p => p?.price > 0 && (now - (p.fetchedAt || 0)) < 3_600_000)
      .map(p => ({ ...p, source: 'proxy', displayPrice: p.price }));
    if (hasLoc) {
      const idx = storeIndex ?? {};
      proxy = filterByRadius(proxy, lat, lng, radius, idx);
    }
    proxy.sort((a, b) => a.displayPrice - b.displayPrice);
  }

  if (proxy.length > 0) {
    return { prices: proxy.slice(0, MAX_PRICES), source: 'proxy', communityWarning: null };
  }

  // D. Manual family prices (groupId scoped)
  let manual = [];
  if (manualData && typeof manualData === 'object') {
    const seen = new Set();
    manual = Object.values(manualData)
      .filter(p => p?.price > 0)
      .map(p => ({ ...p, source: 'manual', displayPrice: p.price }))
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
      .filter(p => {
        const k = p.chainName || p.storeName || '';
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }

  if (manual.length > 0) {
    return { prices: manual.slice(0, MAX_PRICES), source: 'manual', communityWarning: null };
  }

  return { prices: [], source: 'none', communityWarning: null };
}

// ── Filter prices to stores within radius ────────────────────────────────────
function filterByRadius(prices, lat, lng, radius, storeIndex) {
  return prices.filter(p => {
    const key   = `${p.chainId || ''}_${p.storeId || ''}`;
    const store = storeIndex[key];
    if (!store?.hasCoords) return true; // include if no coords yet (pre-geocoding)
    const dist  = haversine(lat, lng, store.latitude, store.longitude);
    if (dist <= radius) {
      p.distanceKm  = Math.round(dist * 10) / 10;
      p.latitude    = store.latitude  ?? null;
      p.longitude   = store.longitude ?? null;
      p.address     = p.address  || store.address  || '';
      p.city        = p.city     || store.city     || '';
      return true;
    }
    return false;
  });
}

// ── Build community warning from price reports ────────────────────────────────
function buildCommunityWarning(reportsData, officialPrices) {
  if (!reportsData || typeof reportsData !== 'object') return null;
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600_000;
  const warnings      = [];

  for (const [chainKey, chainReports] of Object.entries(reportsData)) {
    if (!chainReports) continue;
    const recent = Object.values(chainReports)
      .filter(r => r?.reportedAt && new Date(r.reportedAt).getTime() > thirtyDaysAgo);
    if (recent.length < 2) continue;

    const prices = recent.map(r => r.reportedPrice).filter(p => isValidPrice(p));
    if (!prices.length) continue;

    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const officialForChain = officialPrices.find(
      p => `${p.chainId || ''}_${p.storeId || ''}` === chainKey
    );
    if (officialForChain) {
      warnings.push({
        chainKey,
        chainName:     officialForChain.chainName || '',
        officialPrice: officialForChain.price,
        reportCount:   recent.length,
        reportedMin:   minP,
        reportedMax:   maxP,
        message: `${recent.length} משתמשים דיווחו מחיר שונה: ₪${minP.toFixed(2)}${minP !== maxP ? `–₪${maxP.toFixed(2)}` : ''}`,
      });
    }
  }
  return warnings.length > 0 ? warnings : null;
}

// ── Open Food Facts search — prefers Israeli products ─────────────────────────
async function searchOFF(hebrewQuery, englishQuery) {
  const seen = new Set(), results = [];
  const isHeb = isHebrew(hebrewQuery);
  const urls = [
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=8&fields=product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags&tagtype_0=countries&tag_contains_0=contains&tag_0=israel`,
    isHeb ? `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(hebrewQuery)}&search_simple=1&action=process&json=1&page_size=6&fields=product_name,product_name_he,brands,quantity,image_small_url,code` : null,
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(englishQuery)}&search_simple=1&action=process&json=1&page_size=12&fields=product_name,product_name_he,brands,quantity,image_small_url,code,countries_tags`,
  ].filter(Boolean);

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'FamilyShoppingIL/6.2' },
        signal: AbortSignal.timeout(10_000),
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

  results.sort((a, b) => (b.isIsraeli ? 1 : 0) - (a.isIsraeli ? 1 : 0));
  return results.slice(0, 12);
}

// api/prices.js — v3.0.0
// GET /api/prices?barcode=&lat=&lng=&radiusKm=
// GET /api/prices?q=&lat=&lng=&radiusKm=
// Priority: official prices > manual prices

import { getDB, haversine, cors } from './_firebase.js';

const HE_EN = {
  'חלב':'milk','חלב טרי':'fresh milk','חלב מלא':'whole milk','חלב 3%':'milk 3%',
  'חלב 1%':'milk 1%','חלב עיזים':'goat milk','גבינה':'cheese',
  'גבינה לבנה':'white cheese','גבינה צהובה':'yellow cheese',
  "קוטג'":'cottage cheese','קוטג':'cottage cheese',
  'שמנת':'cream','שמנת חמוצה':'sour cream','יוגורט':'yogurt',
  'יוגורט יווני':'greek yogurt','חמאה':'butter',
  'לחם':'bread','לחם אחיד':'whole wheat bread','פיתה':'pita',
  'קמח':'flour','ביצים':'eggs','ביצה':'egg',
  'קורנפלקס':'cornflakes','שיבולת שועל':'oatmeal','גרנולה':'granola',
  'אורז':'rice','פסטה':'pasta','ספגטי':'spaghetti','מקרוני':'macaroni',
  'שמן':'oil','שמן זית':'olive oil','שמן חמניות':'sunflower oil',
  'סוכר':'sugar','דבש':'honey','מלח':'salt',
  'טחינה':'tahini','חומוס':'hummus','קטשופ':'ketchup','מיונז':'mayonnaise',
  'טונה':'tuna','קפה':'coffee','קפה נמס':'instant coffee','תה':'tea',
  'מיץ':'juice','מים':'water','קולה':'cola',
  'שוקולד':'chocolate','עוגיות':'cookies','במבה':'bamba','ביסלי':'bisli',
  'גלידה':'ice cream','עוף':'chicken','בשר טחון':'ground beef',
  'עגבניות':'tomatoes','מלפפון':'cucumber','בצל':'onion','שום':'garlic',
  'גזר':'carrot','תפוח אדמה':'potato','ברוקולי':'broccoli',
  'תפוח':'apple','בננה':'banana','תפוז':'orange','לימון':'lemon',
  'נייר טואלט':'toilet paper','סבון':'soap','שמפו':'shampoo',
  'אבקת כביסה':'laundry detergent','נוזל כלים':'dish soap',
};

const isHebrew = s => /[\u0590-\u05FF]/.test(s);
const translateHebrew = q => {
  const l = q.trim();
  if (HE_EN[l]) return HE_EN[l];
  for (const [h, e] of Object.entries(HE_EN)) if (l.includes(h) || h.includes(l)) return e;
  return null;
};

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { barcode, q, lat, lng, radiusKm } = req.query;
  const userLat = parseFloat(lat || '');
  const userLng = parseFloat(lng || '');
  const radius  = parseFloat(radiusKm || '0');
  const hasLocation = !isNaN(userLat) && !isNaN(userLng) && radius > 0;

  // Load store index if radius filtering needed
  let storeIndex = {};
  if (hasLocation) storeIndex = await loadStoreIndex(getDB());

  if (barcode) {
    const clean = String(barcode).replace(/\D/g, '');
    if (!clean || clean.length < 4) return res.status(400).json({ error: 'Invalid barcode' });
    const { prices, source } = await getPricesForBarcode(getDB(), clean, hasLocation, userLat, userLng, radius, storeIndex);
    return res.status(200).json({ barcode: clean, source, radiusKm: radius || null, prices });
  }

  if (q) {
    const query = q.trim();
    const hebrew = isHebrew(query);
    const en = hebrew ? (translateHebrew(query) || query) : query;
    const offProducts = await searchOFF(en);

    const db = getDB();
    const enriched = await Promise.all(offProducts.map(async p => {
      if (!p.barcode) return { ...p, storePrices: [], priceSource: 'none' };
      const { prices, source } = await getPricesForBarcode(db, p.barcode, hasLocation, userLat, userLng, radius, storeIndex);
      return { ...p, storePrices: prices, priceSource: source };
    }));

    enriched.sort((a, b) => {
      const o = { official: 0, manual: 1, none: 2 };
      return (o[a.priceSource]??2) - (o[b.priceSource]??2) || (b.storePrices?.length||0) - (a.storePrices?.length||0);
    });

    let syncStatus = null;
    try { const s = await db.ref('syncSummary').get(); if (s.exists()) syncStatus = s.val(); } catch (_) {}

    return res.status(200).json({ version: '3.0.0', query, englishQuery: en, results: enriched.slice(0,20), syncStatus });
  }

  return res.status(400).json({ error: 'Provide ?barcode= or ?q=' });
}

async function getPricesForBarcode(db, barcode, hasLocation, lat, lng, radius, storeIndex) {
  // Official prices
  try {
    const snap = await db.ref(`prices/${barcode}`).get();
    if (snap.exists()) {
      let prices = Object.entries(snap.val())
        .map(([storeKey, p]) => {
          if (!p?.price || p.price <= 0) return null;
          const store = storeIndex[storeKey] || storeIndex[`${p.chainId}_${p.storeId}`] || null;
          const dist  = (store?.hasCoords && hasLocation)
            ? haversine(lat, lng, store.latitude, store.longitude)
            : null;
          // Exclude from radius filter if no coords or outside radius
          if (hasLocation && (dist === null || dist > radius)) return null;
          return {
            store:     p.chainName || p.chainId,
            chainId:   p.chainId,
            storeId:   p.storeId,
            storeName: p.storeName || store?.storeName || '',
            city:      store?.city || '',
            distanceKm: dist ? Math.round(dist * 10) / 10 : null,
            price:     p.price,
            unit:      p.unit || '',
            updatedAt: p.updatedAt,
            source:    'official',
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.price - b.price);

      if (prices.length > 0) return { prices, source: 'official' };
    }
  } catch (e) { console.warn('official lookup:', e.message); }

  // Manual fallback
  try {
    const snap = await db.ref(`manualPrices/${barcode}`).get();
    if (snap.exists()) {
      const prices = Object.values(snap.val())
        .filter(p => p?.price > 0)
        .map(p => ({ store: p.chainName || 'User submitted', chainId: 'manual', price: p.price, note: p.note || '', submittedAt: p.submittedAt, source: 'manual' }))
        .sort((a, b) => a.price - b.price);
      if (prices.length > 0) return { prices, source: 'manual' };
    }
  } catch (_) {}

  return { prices: [], source: 'none' };
}

async function loadStoreIndex(db) {
  try {
    const snap = await db.ref('stores').get();
    if (!snap.exists()) return {};
    return snap.val() || {};
  } catch (_) { return {}; }
}

async function searchOFF(query) {
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=12&fields=product_name,product_name_he,brands,quantity,image_small_url,code`;
    const res = await fetch(url, { headers: { 'User-Agent': 'FamilyShoppingIL/3.0' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.products || []).map(p => ({ name: p.product_name_he||p.product_name||'', brand: p.brands||'', size: p.quantity||'', image: p.image_small_url||'', barcode: p.code||'', storePrices: [] })).filter(p => p.name.length > 1);
  } catch (_) { return []; }
}

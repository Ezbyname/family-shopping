// Netlify Function: netlify/functions/prices.js
// Uses Open Food Facts API + Israeli supermarket APIs

exports.handler = async function(event, context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const query = (event.queryStringParameters?.q || '').trim();
  if (!query || query.length < 2) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'חסר פרמטר חיפוש' })
    };
  }

  console.log(`Searching: "${query}"`);

  // Run all fetches in parallel
  const [offRes, shufRes, ramiRes, vicRes, yeinotRes, osherRes] = await Promise.allSettled([
    searchOpenFoodFacts(query),
    fetchShufersal(query),
    fetchRamiLevy(query),
    fetchVictory(query),
    fetchYeinotBitan(query),
    fetchOsherAd(query),
  ]);

  const offProducts  = offRes.status    === 'fulfilled' ? offRes.value    : [];
  const shufPrices   = shufRes.status   === 'fulfilled' ? shufRes.value   : [];
  const ramiPrices   = ramiRes.status   === 'fulfilled' ? ramiRes.value   : [];
  const vicPrices    = vicRes.status    === 'fulfilled' ? vicRes.value    : [];
  const yeinotPrices = yeinotRes.status === 'fulfilled' ? yeinotRes.value : [];
  const osherPrices  = osherRes.status  === 'fulfilled' ? osherRes.value  : [];

  const allStorePrices = [...shufPrices, ...ramiPrices, ...vicPrices, ...yeinotPrices, ...osherPrices];

  // Build results: products from Open Food Facts enriched with store prices where possible
  // Plus store-only results grouped by product name
  const results = [];

  // 1. Products from Open Food Facts (have images + details)
  for (const p of offProducts) {
    const storePrices = allStorePrices.filter(sp =>
      nameSimilarity(sp.name, p.name) > 0.35
    );
    results.push({ ...p, storePrices });
  }

  // 2. Store price results that didn't match an OFF product - group by name
  const matched = new Set();
  allStorePrices.forEach(sp => {
    if (offProducts.some(p => nameSimilarity(sp.name, p.name) > 0.35)) {
      matched.add(sp.name);
    }
  });

  const unmatched = allStorePrices.filter(sp => !matched.has(sp.name));
  const priceGroups = {};
  unmatched.forEach(sp => {
    const key = sp.name.trim().toLowerCase().substring(0, 50);
    if (!priceGroups[key]) {
      priceGroups[key] = {
        name: sp.name,
        brand: sp.brand || '',
        size: sp.size || '',
        image: sp.image || '',
        barcode: '',
        storePrices: [],
      };
    }
    priceGroups[key].storePrices.push({
      store: sp.store,
      price: sp.price,
      unit: sp.unit || '',
    });
  });

  results.push(...Object.values(priceGroups));

  // Sort: items with store prices first
  results.sort((a, b) => (b.storePrices?.length || 0) - (a.storePrices?.length || 0));

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      query,
      results: results.slice(0, 15),
      total: results.length,
      storeCounts: {
        'שופרסל': shufPrices.length,
        'רמי לוי': ramiPrices.length,
        'ויקטורי': vicPrices.length,
        'יינות ביתן': yeinotPrices.length,
        'אושר עד': osherPrices.length,
      }
    })
  };
};

// ── Open Food Facts ──
async function searchOpenFoodFacts(query) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?` +
    `search_terms=${encodeURIComponent(query)}&` +
    `search_simple=1&action=process&json=1&page_size=8&` +
    `fields=product_name,product_name_he,brands,quantity,image_small_url,code`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FamilyShoppingIL/1.0 (contact@example.com)' },
    signal: AbortSignal.timeout(9000)
  });
  const data = await res.json();
  return (data?.products || [])
    .map(p => ({
      name: p.product_name_he || p.product_name || '',
      brand: p.brands || '',
      size: p.quantity || '',
      image: p.image_small_url || '',
      barcode: p.code || '',
      storePrices: [],
    }))
    .filter(p => p.name.length > 1);
}

// ── Shufersal ──
async function fetchShufersal(query) {
  const res = await fetch(
    `https://www.shufersal.co.il/online/he/search?q=${encodeURIComponent(query)}&format=json`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/javascript, */*',
        'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
        'Referer': 'https://www.shufersal.co.il/online/he/homePage',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(7000)
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const products = data?.results || data?.data || [];
  return products.slice(0, 6).map(p => ({
    name: p.name || '',
    store: 'שופרסל',
    price: parseFloat(p.price || p.pricePerUnit || 0),
    unit: p.unitOfMeasure || '',
    brand: p.brand || '',
    size: p.size || p.quantity || '',
    image: p.thumbnail || '',
  })).filter(p => p.price > 0 && p.name);
}

// ── Rami Levy ──
async function fetchRamiLevy(query) {
  const res = await fetch(
    `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(query)}&store=1`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'he-IL,he;q=0.9',
        'Referer': 'https://www.rami-levy.co.il/',
        'Origin': 'https://www.rami-levy.co.il',
      },
      signal: AbortSignal.timeout(7000)
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const products = data?.data || [];
  return products.slice(0, 6).map(p => ({
    name: p.name || '',
    store: 'רמי לוי',
    price: parseFloat(p.price?.regular || p.price || 0),
    unit: p.unit_of_measure || '',
    brand: p.group_name || '',
    size: p.weight || p.size || '',
    image: p.media?.m ? `https://static.rami-levy.co.il/storage/images/${p.media.m}/medium.jpg` : '',
  })).filter(p => p.price > 0 && p.name);
}

// ── Victory ──
async function fetchVictory(query) {
  const res = await fetch(
    `https://www.victoryonline.co.il/api/products/search?query=${encodeURIComponent(query)}&pageSize=6`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'he-IL,he;q=0.9',
        'Referer': 'https://www.victoryonline.co.il/',
      },
      signal: AbortSignal.timeout(7000)
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const products = data?.SearchResults || data?.products || data?.data || [];
  return products.slice(0, 6).map(p => ({
    name: p.Name || p.name || '',
    store: 'ויקטורי',
    price: parseFloat(p.Price || p.price || 0),
    unit: p.UnitOfMeasure || '',
    brand: p.Brand || p.brand || '',
    size: p.Size || p.size || '',
    image: p.ImageUrl || '',
  })).filter(p => p.price > 0 && p.name);
}

// ── Yeinot Bitan ──
async function fetchYeinotBitan(query) {
  const res = await fetch(
    `https://yeinotbitan.co.il/umbraco/api/catalog/search?query=${encodeURIComponent(query)}&pageSize=6`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'he-IL,he;q=0.9',
        'Referer': 'https://yeinotbitan.co.il/',
      },
      signal: AbortSignal.timeout(7000)
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const products = data?.products || data?.Products || data?.items || [];
  return products.slice(0, 6).map(p => ({
    name: p.Name || p.name || '',
    store: 'יינות ביתן',
    price: parseFloat(p.Price || p.SellingPrice || p.price || 0),
    unit: p.UnitOfMeasure || '',
    brand: p.ManufacturerName || p.Brand || '',
    size: p.UnitQuantity || p.Size || '',
    image: p.PictureUrl || p.ImageUrl || '',
  })).filter(p => p.price > 0 && p.name);
}

// ── Osher Ad ──
async function fetchOsherAd(query) {
  try {
    const res = await fetch(
      `https://www.osherad.co.il/search?q=${encodeURIComponent(query)}&format=json`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
          'Accept': 'application/json, text/html, */*',
          'Accept-Language': 'he-IL,he;q=0.9',
          'Referer': 'https://www.osherad.co.il/',
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(7000)
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const products = data?.results || data?.products || data?.data || data?.items || [];
    return products.slice(0, 6).map(p => ({
      name: p.name || p.title || '',
      store: 'אושר עד',
      price: parseFloat(p.price || p.regularPrice || p.finalPrice || 0),
      unit: p.unitOfMeasure || p.unit || '',
      brand: p.brand || p.manufacturer || '',
      size: p.size || p.quantity || p.weight || '',
      image: p.image || p.thumbnail || p.imageUrl || '',
    })).filter(p => p.price > 0 && p.name);
  } catch (e) { return []; }
}

// ── Hebrew-aware string similarity ──
function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().trim().replace(/['"]/g, '');
  b = b.toLowerCase().trim().replace(/['"]/g, '');
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const wordsA = new Set(a.split(/[\s\-,]+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/[\s\-,]+/).filter(w => w.length > 1));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

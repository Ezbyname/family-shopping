// Netlify Function: netlify/functions/prices.js
// Fetches live prices from Israeli supermarket APIs

const STORES = {
  shufersal: {
    name: 'שופרסל',
    search: q => `https://www.shufersal.co.il/online/he/search?q=${encodeURIComponent(q)}&format=json`,
  },
  ramilevi: {
    name: 'רמי לוי',
    search: q => `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(q)}`,
  },
  victory: {
    name: 'ויקטורי',
    search: q => `https://www.victoryonline.co.il/api/products/search?query=${encodeURIComponent(q)}`,
  },
  yeinot: {
    name: 'יינות ביתן',
    search: q => `https://www.yeinotbitan.co.il/umbraco/api/search/getProductsByPage?query=${encodeURIComponent(q)}`,
  },
  mahsane: {
    name: 'מחסני להב',
    search: q => `https://www.mahsanei-lahav.co.il/api/search?q=${encodeURIComponent(q)}`,
  }
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.google.com/',
};

async function fetchShufersal(query) {
  try {
    const res = await fetch(
      `https://www.shufersal.co.il/online/he/search?q=${encodeURIComponent(query)}&format=json`,
      { headers: HEADERS, signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const products = data?.results || data?.data || [];
    return products.slice(0, 6).map(p => ({
      store: 'שופרסל',
      name: p.name || p.title || '',
      price: parseFloat(p.price || p.pricePerUnit || 0),
      unit: p.unitOfMeasure || p.unit || '',
      image: p.thumbnail || p.image || '',
      brand: p.brand || '',
      size: p.size || p.quantity || '',
    })).filter(p => p.price > 0);
  } catch(e) {
    return [];
  }
}

async function fetchRamiLevy(query) {
  try {
    const res = await fetch(
      `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(query)}&store=1`,
      { headers: { ...HEADERS, 'Referer': 'https://www.rami-levy.co.il/' }, signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const products = data?.data || data?.items || data?.results || [];
    return products.slice(0, 6).map(p => ({
      store: 'רמי לוי',
      name: p.name || p.title || '',
      price: parseFloat(p.price?.regular || p.price || 0),
      unit: p.unit_of_measure || '',
      image: p.media?.m || p.image || '',
      brand: p.group_name || p.brand || '',
      size: p.weight || p.size || '',
    })).filter(p => p.price > 0);
  } catch(e) {
    return [];
  }
}

async function fetchVictory(query) {
  try {
    const res = await fetch(
      `https://www.victoryonline.co.il/api/products/search?query=${encodeURIComponent(query)}&pageSize=6`,
      { headers: { ...HEADERS, 'Referer': 'https://www.victoryonline.co.il/' }, signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const products = data?.SearchResults || data?.products || data?.data || [];
    return products.slice(0, 6).map(p => ({
      store: 'ויקטורי',
      name: p.Name || p.name || '',
      price: parseFloat(p.Price || p.price || 0),
      unit: p.UnitOfMeasure || '',
      image: p.ImageUrl || p.image || '',
      brand: p.Brand || p.brand || '',
      size: p.Size || p.size || '',
    })).filter(p => p.price > 0);
  } catch(e) {
    return [];
  }
}

async function fetchYeinotBitan(query) {
  try {
    const res = await fetch(
      `https://yeinotbitan.co.il/umbraco/api/catalog/search?query=${encodeURIComponent(query)}&pageSize=6`,
      { headers: { ...HEADERS, 'Referer': 'https://yeinotbitan.co.il/' }, signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const products = data?.products || data?.Products || data?.items || [];
    return products.slice(0, 6).map(p => ({
      store: 'יינות ביתן',
      name: p.Name || p.name || p.title || '',
      price: parseFloat(p.Price || p.SellingPrice || p.price || 0),
      unit: p.UnitOfMeasure || '',
      image: p.PictureUrl || p.ImageUrl || p.image || '',
      brand: p.Brand || p.ManufacturerName || '',
      size: p.Size || p.UnitQuantity || '',
    })).filter(p => p.price > 0);
  } catch(e) {
    return [];
  }
}

async function fetchMahsanei(query) {
  try {
    const res = await fetch(
      `https://www.mahsanei-lahav.co.il/catalogsearch/result/?q=${encodeURIComponent(query)}&ajax=1`,
      { headers: { ...HEADERS, 'Referer': 'https://www.mahsanei-lahav.co.il/' }, signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    const products = data?.items || data?.products || data?.data || [];
    return products.slice(0, 6).map(p => ({
      store: 'מחסני להב',
      name: p.name || p.title || '',
      price: parseFloat(p.price || p.final_price || 0),
      unit: p.unit || '',
      image: p.image || p.thumbnail || '',
      brand: p.brand || '',
      size: p.size || p.weight || '',
    })).filter(p => p.price > 0);
  } catch(e) {
    return [];
  }
}

// Government open data fallback - prices.gov.il API
async function fetchGovPrices(query) {
  try {
    const res = await fetch(
      `https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=20&page=1`,
      { headers: HEADERS, signal: AbortSignal.timeout(8000) }
    );
    // This is a placeholder - the actual gov API uses XML files
    return [];
  } catch(e) {
    return [];
  }
}

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

  const query = event.queryStringParameters?.q || '';
  if (!query || query.length < 2) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'חסר פרמטר חיפוש' })
    };
  }

  console.log(`Searching prices for: ${query}`);

  // Fetch from all stores in parallel
  const [shufersal, ramiLevy, victory, yeinotBitan, mahsanei] = await Promise.allSettled([
    fetchShufersal(query),
    fetchRamiLevy(query),
    fetchVictory(query),
    fetchYeinotBitan(query),
    fetchMahsanei(query),
  ]);

  const allResults = [
    ...(shufersal.status === 'fulfilled' ? shufersal.value : []),
    ...(ramiLevy.status === 'fulfilled' ? ramiLevy.value : []),
    ...(victory.status === 'fulfilled' ? victory.value : []),
    ...(yeinotBitan.status === 'fulfilled' ? yeinotBitan.value : []),
    ...(mahsanei.status === 'fulfilled' ? mahsanei.value : []),
  ];

  // Group by product name similarity for comparison
  const grouped = {};
  allResults.forEach(item => {
    const key = item.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!grouped[key]) grouped[key] = { name: item.name, brand: item.brand, size: item.size, image: item.image, stores: [] };
    grouped[key].stores.push({ store: item.store, price: item.price, unit: item.unit });
  });

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      query,
      results: allResults,
      grouped: Object.values(grouped),
      counts: {
        shufersal: shufersal.status === 'fulfilled' ? shufersal.value.length : 0,
        ramiLevy: ramiLevy.status === 'fulfilled' ? ramiLevy.value.length : 0,
        victory: victory.status === 'fulfilled' ? victory.value.length : 0,
        yeinotBitan: yeinotBitan.status === 'fulfilled' ? yeinotBitan.value.length : 0,
        mahsanei: mahsanei.status === 'fulfilled' ? mahsanei.value.length : 0,
      }
    })
  };
};

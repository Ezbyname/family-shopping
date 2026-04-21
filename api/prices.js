export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const query = (req.query?.q || '').trim();
  if (!query || query.length < 2) return res.status(400).json({ error: 'חסר פרמטר חיפוש' });
  console.log(`[prices] Searching: "${query}"`);
  const [offRes,shufRes,ramiRes,vicRes,yeinotRes,osherRes] = await Promise.allSettled([
    searchOpenFoodFacts(query), fetchShufersal(query), fetchRamiLevy(query),
    fetchVictory(query), fetchYeinotBitan(query), fetchOsherAd(query),
  ]);
  const offProducts  = offRes.status==='fulfilled'    ? offRes.value    : [];
  const shufPrices   = shufRes.status==='fulfilled'   ? shufRes.value   : [];
  const ramiPrices   = ramiRes.status==='fulfilled'   ? ramiRes.value   : [];
  const vicPrices    = vicRes.status==='fulfilled'    ? vicRes.value    : [];
  const yeinotPrices = yeinotRes.status==='fulfilled' ? yeinotRes.value : [];
  const osherPrices  = osherRes.status==='fulfilled'  ? osherRes.value  : [];
  console.log(`[prices] OFF:${offProducts.length} Shuf:${shufPrices.length} Rami:${ramiPrices.length} Vic:${vicPrices.length} Yeinot:${yeinotPrices.length} Osher:${osherPrices.length}`);
  const allStorePrices = [...shufPrices,...ramiPrices,...vicPrices,...yeinotPrices,...osherPrices];
  const results = [];
  for (const p of offProducts) {
    const storePrices = allStorePrices.filter(sp => nameSimilarity(sp.name, p.name) > 0.3);
    results.push({ ...p, storePrices });
  }
  const matched = new Set();
  allStorePrices.forEach(sp => { if (offProducts.some(p => nameSimilarity(sp.name,p.name) > 0.3)) matched.add(sp.name); });
  const unmatched = allStorePrices.filter(sp => !matched.has(sp.name));
  const priceGroups = {};
  unmatched.forEach(sp => {
    const key = sp.name.trim().toLowerCase().substring(0,50);
    if (!priceGroups[key]) priceGroups[key] = { name:sp.name, brand:sp.brand||'', size:sp.size||'', image:sp.image||'', barcode:'', storePrices:[] };
    priceGroups[key].storePrices.push({ store:sp.store, price:sp.price, unit:sp.unit||'' });
  });
  results.push(...Object.values(priceGroups));
  results.sort((a,b) => (b.storePrices?.length||0) - (a.storePrices?.length||0));
  return res.status(200).json({ query, results:results.slice(0,15), total:results.length,
    storeCounts:{ 'שופרסל':shufPrices.length, 'רמי לוי':ramiPrices.length, 'ויקטורי':vicPrices.length, 'יינות ביתן':yeinotPrices.length, 'אושר עד':osherPrices.length } });
}

// Helper: ensure we got JSON, not an HTML error page
async function safeJson(r) {
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json') && !ct.includes('javascript')) {
    const t = await r.text();
    console.log('[prices] Non-JSON response:', t.substring(0,120));
    throw new Error('Expected JSON, got: ' + ct);
  }
  return r.json();
}

async function searchOpenFoodFacts(query) {
  const urls = [
    `https://il.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,product_name_he,brands,quantity,image_small_url,code`,
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=10&countries=israel&fields=product_name,product_name_he,brands,quantity,image_small_url,code`,
  ];
  let all = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers:{'User-Agent':'FamilyShoppingIL/1.0 (contact@example.com)'}, signal:AbortSignal.timeout(9000) });
      const d = await r.json();
      all.push(...(d?.products||[]).map(p => ({ name:p.product_name_he||p.product_name||'', brand:p.brands||'', size:p.quantity||'', image:p.image_small_url||'', barcode:p.code||'', storePrices:[] })).filter(p => p.name.length > 1));
    } catch(e) { console.log('[prices] OFF:', e.message); }
  }
  const seen = new Set();
  return all.filter(p => { const k = p.barcode || p.name.toLowerCase().substring(0,40); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function fetchShufersal(query) {
  const urls = [
    `https://www.shufersal.co.il/online/he/search?q=${encodeURIComponent(query)}&format=json`,
    `https://www.shufersal.co.il/online/he/api/products/search?q=${encodeURIComponent(query)}&start=0&count=6`,
  ];
  const h = { 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept':'application/json,*/*', 'Accept-Language':'he-IL,he;q=0.9', 'Referer':'https://www.shufersal.co.il/', 'X-Requested-With':'XMLHttpRequest' };
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers:h, signal:AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const d = await safeJson(r);
      const p = d?.results||d?.data||d?.products||[];
      const m = p.slice(0,6).map(p => ({ name:p.name||p.title||'', store:'שופרסל', price:parseFloat(p.price||p.pricePerUnit||p.regularPrice||0), unit:p.unitOfMeasure||'', brand:p.brand||'', size:p.size||p.quantity||'', image:p.thumbnail||p.imageUrl||'' })).filter(p => p.price>0 && p.name);
      if (m.length) return m;
    } catch(e) { console.log('[prices] Shufersal:', e.message); }
  }
  return [];
}

async function fetchRamiLevy(query) {
  const urls = [
    `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(query)}&store=331`,
    `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(query)}&store=1`,
    `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(query)}`,
  ];
  const h = { 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept':'application/json', 'Accept-Language':'he-IL,he;q=0.9', 'Referer':'https://www.rami-levy.co.il/', 'Origin':'https://www.rami-levy.co.il' };
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers:h, signal:AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const d = await safeJson(r);
      const p = d?.data||d?.results||d?.products||[];
      if (!p.length) continue;
      const m = p.slice(0,6).map(p => ({ name:p.name||'', store:'רמי לוי', price:parseFloat(p.price?.regular||p.price?.sale||p.price||0), unit:p.unit_of_measure||'', brand:p.group_name||p.brand||'', size:p.weight||p.size||'', image:p.media?.m?`https://static.rami-levy.co.il/storage/images/${p.media.m}/medium.jpg`:(p.image||'') })).filter(p => p.price>0 && p.name);
      if (m.length) return m;
    } catch(e) { console.log('[prices] RamiLevy:', e.message); }
  }
  return [];
}

async function fetchVictory(query) {
  const urls = [
    `https://www.victoryonline.co.il/api/products/search?query=${encodeURIComponent(query)}&pageSize=6`,
    `https://www.victoryonline.co.il/umbraco/api/catalogapi/search?term=${encodeURIComponent(query)}&pageSize=6`,
  ];
  const h = { 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept':'application/json', 'Accept-Language':'he-IL,he;q=0.9', 'Referer':'https://www.victoryonline.co.il/' };
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers:h, signal:AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const d = await safeJson(r);
      const p = d?.SearchResults||d?.products||d?.data||d?.items||[];
      if (!p.length) continue;
      const m = p.slice(0,6).map(p => ({ name:p.Name||p.name||'', store:'ויקטורי', price:parseFloat(p.Price||p.SellingPrice||p.price||0), unit:p.UnitOfMeasure||'', brand:p.Brand||p.brand||'', size:p.Size||p.size||'', image:p.ImageUrl||p.imageUrl||'' })).filter(p => p.price>0 && p.name);
      if (m.length) return m;
    } catch(e) { console.log('[prices] Victory:', e.message); }
  }
  return [];
}

async function fetchYeinotBitan(query) {
  const urls = [
    `https://yeinotbitan.co.il/umbraco/api/catalog/search?query=${encodeURIComponent(query)}&pageSize=6`,
    `https://www.ybitan.co.il/umbraco/api/catalog/search?query=${encodeURIComponent(query)}&pageSize=6`,
  ];
  const h = { 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept':'application/json', 'Accept-Language':'he-IL,he;q=0.9', 'Referer':'https://yeinotbitan.co.il/' };
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers:h, signal:AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const d = await safeJson(r);
      const p = d?.products||d?.Products||d?.items||d?.data||[];
      if (!p.length) continue;
      const m = p.slice(0,6).map(p => ({ name:p.Name||p.name||'', store:'יינות ביתן', price:parseFloat(p.Price||p.SellingPrice||p.price||0), unit:p.UnitOfMeasure||'', brand:p.ManufacturerName||p.Brand||p.brand||'', size:p.UnitQuantity||p.Size||p.size||'', image:p.PictureUrl||p.ImageUrl||'' })).filter(p => p.price>0 && p.name);
      if (m.length) return m;
    } catch(e) { console.log('[prices] Yeinot:', e.message); }
  }
  return [];
}

async function fetchOsherAd(query) {
  const urls = [
    `https://www.osherad.co.il/search?q=${encodeURIComponent(query)}&format=json`,
    `https://www.osherad.co.il/api/catalog/search?term=${encodeURIComponent(query)}&pageSize=6`,
  ];
  const h = { 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept':'application/json,*/*', 'Accept-Language':'he-IL,he;q=0.9', 'Referer':'https://www.osherad.co.il/', 'X-Requested-With':'XMLHttpRequest' };
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers:h, signal:AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const d = await safeJson(r);
      const p = d?.results||d?.products||d?.data||d?.items||[];
      if (!p.length) continue;
      const m = p.slice(0,6).map(p => ({ name:p.name||p.title||'', store:'אושר עד', price:parseFloat(p.price||p.regularPrice||p.finalPrice||0), unit:p.unitOfMeasure||'', brand:p.brand||p.manufacturer||'', size:p.size||p.quantity||'', image:p.image||p.thumbnail||'' })).filter(p => p.price>0 && p.name);
      if (m.length) return m;
    } catch(e) { /* silent */ }
  }
  return [];
}

function nameSimilarity(a, b) {
  if (!a||!b) return 0;
  a = a.toLowerCase().trim().replace(/['"״׳]/g,'').replace(/\s+/g,' ');
  b = b.toLowerCase().trim().replace(/['"״׳]/g,'').replace(/\s+/g,' ');
  if (a===b) return 1;
  if (a.includes(b)||b.includes(a)) return 0.8;
  const wA = new Set(a.split(/[\s\-,()]+/).filter(w=>w.length>1));
  const wB = new Set(b.split(/[\s\-,()]+/).filter(w=>w.length>1));
  const inter = [...wA].filter(w=>wB.has(w)).length;
  const union = new Set([...wA,...wB]).size;
  return union > 0 ? inter/union : 0;
}

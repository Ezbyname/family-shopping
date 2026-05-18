// api/proxy-prices.js — v2.0.0 — EXPERIMENTAL ONLY
// Vercel Edge Function — attempts live price fetch from Israeli supermarkets
// - Fail silently on any error
// - Save to proxyCache/{barcode}/{chainKey} with TTL timestamp
// - NEVER writes to prices/ (official XML path)
// - Source always marked as "proxy"

export const config = { runtime: 'edge' };

const STORES = {
  shufersal: {
    name: 'שופרסל',
    search: q => `https://www.shufersal.co.il/online/he/search?q=${encodeURIComponent(q)}&format=json`,
    parse: d => (d?.results || []).slice(0, 5).map(p => ({
      name: p.name || '', price: parseFloat(p.price || 0),
      chainName: 'שופרסל', source: 'proxy',
    })).filter(p => p.price > 0),
  },
  ramilevi: {
    name: 'רמי לוי',
    search: q => `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(q)}&store=1`,
    parse: d => (d?.data || []).slice(0, 5).map(p => ({
      name: p.name || '', price: parseFloat(p.price?.regular || p.price || 0),
      chainName: 'רמי לוי', source: 'proxy',
    })).filter(p => p.price > 0),
  },
};

const IL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const q       = searchParams.get('q') || '';
  const barcode = searchParams.get('barcode') || '';
  const store   = searchParams.get('store') || 'shufersal';

  if (!q && !barcode) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing q or barcode' }), { headers: CORS });
  }

  const query = q || barcode;
  const storeConfig = STORES[store] || STORES.shufersal;

  try {
    const res = await fetch(storeConfig.search(query), {
      headers: {
        ...IL_HEADERS,
        'Referer': `https://www.${store}.co.il/`,
        'Origin':  `https://www.${store}.co.il`,
      },
      signal: AbortSignal.timeout(6000),
    });

    const text = await res.text();
    let results = [];
    let blocked = false;

    try {
      const data = JSON.parse(text);
      results = storeConfig.parse(data);
    } catch (_) {
      blocked = true; // HTML response = blocked
    }

    // Add fetchedAt for TTL tracking
    const enriched = results.map(p => ({ ...p, fetchedAt: Date.now() }));

    return new Response(JSON.stringify({
      ok:      res.ok && enriched.length > 0,
      status:  res.status,
      store:   storeConfig.name,
      blocked,
      results: enriched,
      // Note: caller should save results to proxyCache/{barcode} with TTL
      message: enriched.length > 0
        ? `${enriched.length} results from ${storeConfig.name}`
        : blocked
          ? 'Blocked by supermarket — use manual entry'
          : 'No results found',
    }), { headers: CORS });

  } catch (e) {
    // Fail silently — return empty, app continues normally
    return new Response(JSON.stringify({
      ok: false, blocked: true, results: [],
      store: storeConfig.name,
      message: 'Proxy failed silently — app continues with official/manual data',
    }), { headers: CORS });
  }
}

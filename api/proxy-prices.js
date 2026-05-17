// api/proxy-prices.js — Vercel Edge Function
// Attempts to fetch Israeli supermarket prices with Israeli-looking headers
// Deploy as Edge function for lower latency from Europe/Israel

export const config = { runtime: 'edge' };

const STORES = {
  shufersal: {
    name: 'שופרסל',
    search: q => `https://www.shufersal.co.il/online/he/search?q=${encodeURIComponent(q)}&format=json`,
  },
  ramilevi: {
    name: 'רמי לוי',
    search: q => `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(q)}&store=1`,
  },
};

// Headers that mimic a real Israeli browser
const IL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en-IL;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.shufersal.co.il/',
  'Origin': 'https://www.shufersal.co.il',
  'X-Requested-With': 'XMLHttpRequest',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q') || '';
  const store = searchParams.get('store') || 'shufersal';

  if (!q) return new Response(JSON.stringify({ error: 'Missing q' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  const storeConfig = STORES[store] || STORES.shufersal;

  try {
    const res = await fetch(storeConfig.search(q), {
      headers: { ...IL_HEADERS, 'Referer': `https://www.${store}.co.il/` },
      signal: AbortSignal.timeout(8000),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500), status: res.status }; }

    return new Response(JSON.stringify({
      store: storeConfig.name,
      status: res.status,
      ok: res.ok,
      data,
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, store: storeConfig.name }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

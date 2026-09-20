// api/openfoodfacts-search.js — v2.0.0
// GET /api/openfoodfacts-search?q=<normalized>&translatedQ=<translated>&pageSize=<n>
//
// Server-side proxy for Open Food Facts — batches three strategies and returns
// raw OFF product objects with preserved field shape.
//
// Response:
//   { status: 'ok'|'REMOTE_FAILURE'|'SUCCESS_WITH_ZERO_RESULTS', batches: [...] }
//
// Batch shape:
//   { strategy: 'original_il'|'translated_il'|'translated_broad',
//     products: [raw OFF objects],
//     error: null | 'off_http_4xx'|'off_http_5xx'|'off_timeout'|'off_parse'|'off_network' }
//
// Partial-success rules:
//   A. ≥1 batch has products         → status:'ok'
//   B. All batches succeed + 0 total → status:'SUCCESS_WITH_ZERO_RESULTS'
//   C. 0 products + ≥1 failure       → status:'REMOTE_FAILURE'
//   D. All batches fail              → status:'REMOTE_FAILURE'

import { setCors } from './_firebase.js';

const OFF_BASE   = 'https://world.openfoodfacts.org/cgi/search.pl';
const OFF_FIELDS = 'product_name,product_name_he,product_name_ar,brands,quantity,image_small_url,code,countries_tags';
const OFF_IL     = '&tagtype_0=countries&tag_contains_0=contains&tag_0=israel';
const OFF_UA     = 'FamilyShoppingIL/7.0';
const OFF_TIMEOUT_MS = 7_500;

export const OFF_ERR = {
  HTTP_4XX: 'off_http_4xx',
  HTTP_5XX: 'off_http_5xx',
  TIMEOUT:  'off_timeout',
  PARSE:    'off_parse',
  NETWORK:  'off_network',
};

function buildOffUrl(q, pageSize, ilFilter) {
  const enc    = encodeURIComponent(q);
  const filter = ilFilter ? OFF_IL : '';
  return `${OFF_BASE}?search_terms=${enc}&search_simple=1&action=process&json=1&page_size=${pageSize}&fields=${OFF_FIELDS}${filter}`;
}

async function fetchBatch(strategy, url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': OFF_UA },
      signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
    });
    if (!r.ok) {
      const code = r.status >= 500 ? OFF_ERR.HTTP_5XX : OFF_ERR.HTTP_4XX;
      return { strategy, products: [], error: code };
    }
    let data;
    try {
      data = await r.json();
    } catch (_) {
      return { strategy, products: [], error: OFF_ERR.PARSE };
    }
    if (!data || !Array.isArray(data.products)) {
      return { strategy, products: [], error: OFF_ERR.PARSE };
    }
    return { strategy, products: data.products, error: null };
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    return { strategy, products: [], error: isTimeout ? OFF_ERR.TIMEOUT : OFF_ERR.NETWORK };
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const q          = String(req.query?.q          || '').trim();
  const translatedQ = String(req.query?.translatedQ || '').trim() || q;
  const pageSize   = Math.min(40, Math.max(1, parseInt(req.query?.pageSize, 10) || 20));

  if (!q || q.length < 1)  return res.status(400).json({ error: 'q required' });
  if (q.length > 200)      return res.status(400).json({ error: 'q too long' });
  if (/[\n\r]/.test(q))    return res.status(400).json({ error: 'invalid q' });

  // Build ordered strategy list — translated_il only when translation differs
  const strategyDefs = [
    { strategy: 'original_il',      url: buildOffUrl(q,          pageSize, true)  },
    ...(translatedQ !== q
      ? [{ strategy: 'translated_il', url: buildOffUrl(translatedQ, 15,       true) }]
      : []),
    { strategy: 'translated_broad', url: buildOffUrl(translatedQ, 20,       false) },
  ];

  // Sequential fetch — preserves order, avoids OFF rate-limit burst
  const batches = [];
  for (const def of strategyDefs) {
    batches.push(await fetchBatch(def.strategy, def.url));
  }

  // Classify result (Rules A–D)
  const totalProducts = batches.reduce((n, b) => n + b.products.length, 0);
  const anyFailure    = batches.some(b => b.error !== null);

  let status;
  if (totalProducts > 0) {
    status = 'ok';
  } else if (!anyFailure) {
    status = 'SUCCESS_WITH_ZERO_RESULTS';
  } else {
    status = 'REMOTE_FAILURE';
  }

  return res.status(200).json({ status, batches });
}

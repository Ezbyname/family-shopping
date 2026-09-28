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
//   A. >=1 batch has products         -> status:'ok'
//   B. All batches succeed + 0 total  -> status:'SUCCESS_WITH_ZERO_RESULTS'
//   C. 0 products + >=1 failure       -> status:'REMOTE_FAILURE'
//   D. All batches fail               -> status:'REMOTE_FAILURE'

import { setCors } from './_firebase.js';
import { searchOpenFoodFacts } from './_openfoodfacts.js';

export { OFF_ERR } from './_openfoodfacts.js';

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const q = String(req.query?.q || '').trim();
  const translatedQ =
    String(req.query?.translatedQ || '').trim() || q;

  const pageSize = Math.min(
    40,
    Math.max(
      1,
      parseInt(req.query?.pageSize, 10) || 20
    )
  );

  if (!q || q.length < 1) {
    return res.status(400).json({ error: 'q required' });
  }

  if (q.length > 200) {
    return res.status(400).json({ error: 'q too long' });
  }

  if (/[\n\r]/.test(q)) {
    return res.status(400).json({ error: 'invalid q' });
  }

  const result = await searchOpenFoodFacts({
    q,
    translatedQ,
    pageSize,
  });

  return res.status(200).json(result);
}

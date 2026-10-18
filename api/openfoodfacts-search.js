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

import { setCors, getDbUrl, getAdminToken } from './_firebase.js';
import { searchOpenFoodFacts } from './_openfoodfacts.js';
import { createSearchLkgRuntime } from './_search-lkg-runtime.js';
import { buildPickerLkgKey, resolvePickerSearch } from './_off-picker-lkg.js';

export { OFF_ERR } from './_openfoodfacts.js';

// Response additions (all optional for older clients):
//   offStatus    status reported by OFF for THIS request
//   cacheStatus  'fresh' | 'stale-if-error' | 'none' (REMOTE_FAILURE and no usable LKG)
//   cachedAt     epoch ms of the stored LKG   (stale-if-error only)
//   ageSeconds   age of that LKG              (stale-if-error only)
//
// Last-Known-Good uses the existing Search LKG runtime. While
// SEARCH_LKG_PERSISTENCE_APPROVED=false (api/_search-lkg-config.js) no repository
// exists, so this endpoint performs no Firebase reads or writes.

let _pickerLkgTestConfig = null;

// Test-only injection (mirrors _setSearchLkgRepositoryForTests in prices.js).
export function _setPickerLkgForTests(repository = null, ttlMs = null) {
  if (repository === null) {
    _pickerLkgTestConfig = null;
    return;
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('positive LKG ttlMs required for test injection');
  }
  _pickerLkgTestConfig = { repository, ttlMs };
}

function getActiveLkg() {
  if (_pickerLkgTestConfig) return _pickerLkgTestConfig;

  const runtime = createSearchLkgRuntime({
    dbUrl: getDbUrl(),
    tokenProvider: getAdminToken,
  });

  return runtime.enabled
    ? { repository: runtime.repository, ttlMs: runtime.ttlMs }
    : null;
}

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

  const lkg = getActiveLkg();

  const response = await resolvePickerSearch({
    result,
    repository: lkg?.repository || null,
    ttlMs: lkg?.ttlMs || null,
    key: lkg ? buildPickerLkgKey({ q, translatedQ, pageSize }) : null,
  });

  return res.status(200).json(response);
}

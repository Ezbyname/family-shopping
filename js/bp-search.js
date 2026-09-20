// js/bp-search.js — v2.0.0
// Client-side corpus helpers: name selection, batch consumption, transport + cache.
// Imported by app.js (production) and tests/bp-search.test.js (tests).
// No DOM access. No Firebase. No app.js globals.

const FRESH_TTL      = 5  * 60 * 1000;   // 5 minutes
const STALE_IF_ERROR = 30 * 60 * 1000;   // 30 minutes

let _CLIENT_TIMEOUT_MS = 26_000;          // overridable by tests only

// key -> { data: {status, batches}, fetchedAt }
const _corpusCache = new Map();

// ── Name selection ────────────────────────────────────────────────────────────

// Pick the most appropriate name field based on the query's language.
// Exact semantics match _bpSelectName in dfb0623.
// he:    he || en          (Arabic intentionally excluded for Hebrew queries)
// ar:    ar || he || en
// other: en || he || ar
export function bpSelectName(p, queryLang) {
  const he = (p.product_name_he || '').trim();
  const ar = (p.product_name_ar || '').trim();
  const en = (p.product_name    || '').trim();
  if (queryLang === 'he') return he || en;
  if (queryLang === 'ar') return ar || he || en;
  return en || he || ar;
}

// ── Batch consumption ─────────────────────────────────────────────────────────

// Consume ordered proxy batches into the raw[] corpus array (mutated in place).
//
// Early-stop: checked BEFORE each batch (not inside the product loop).
// A batch that begins when raw.length < 55 is fully processed — it may finish
// above 55. This matches the dfb0623 per-URL break behavior exactly.
//
// Dedup: products with no code (code === '') are NEVER blocked by the seen Set.
// Multiple codeless products from different batches all survive. This matches
// the dfb0623 production behavior:
//   const code = p.code || '';
//   if (code && seen.has(code)) continue;
//   if (code) seen.add(code);
export function bpConsumeBatches(batches, seen, raw, queryLang) {
  for (const batch of batches) {
    if (raw.length >= 55) return;
    for (const p of batch.products) {
      const code = p.code || '';
      if (code && seen.has(code)) continue;
      if (code) seen.add(code);
      const name = bpSelectName(p, queryLang) || '';
      if (!name) continue;
      raw.push({
        name,
        brand:     p.brands          || '',
        size:      p.quantity        || '',
        image:     p.image_small_url || '',
        barcode:   code,
        isIsraeli: (p.countries_tags || []).some(c => c.includes('israel')),
        nameHe:    p.product_name_he || '',
        nameAr:    p.product_name_ar || '',
        nameEn:    p.product_name    || '',
      });
    }
  }
}

// ── Transport ─────────────────────────────────────────────────────────────────

// Fetch with an internal AbortController so we can distinguish:
//   - caller abort  → re-throw as AbortError
//   - transport timeout → throw with isRemoteFailure: true
//   - other network error → throw with isRemoteFailure: true
async function _fetchWithTimeout(url, init, callerSignal, timeoutMs) {
  const internalCtrl = new AbortController();
  // Locked to the FIRST source that aborts — never overwritten after set.
  let abortSource = null; // 'caller' | 'timeout' | null

  const onCallerAbort = () => {
    if (abortSource === null) { abortSource = 'caller';  internalCtrl.abort(); }
  };
  const timer = setTimeout(() => {
    if (abortSource === null) { abortSource = 'timeout'; internalCtrl.abort(); }
  }, timeoutMs);

  if (callerSignal?.aborted) {
    clearTimeout(timer);
    abortSource = 'caller';
    const e = new Error('aborted'); e.name = 'AbortError'; throw e;
  }
  if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const r = await fetch(url, { ...init, signal: internalCtrl.signal });
    return r;
  } catch (e) {
    if (abortSource === 'caller') {
      const ae = new Error('aborted'); ae.name = 'AbortError'; throw ae;
    }
    if (abortSource === 'timeout') {
      throw Object.assign(new Error('transport timeout'), { isRemoteFailure: true });
    }
    throw Object.assign(new Error(e.message || 'fetch failed'), { isRemoteFailure: true });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function _fetchFromProxy(normQ, translatedQ, pageSize, signal) {
  const params = new URLSearchParams({
    q:          normQ,
    translatedQ: translatedQ,
    pageSize:    String(pageSize),
  });

  let r;
  try {
    r = await _fetchWithTimeout(
      `/api/openfoodfacts-search?${params}`,
      {},
      signal,
      _CLIENT_TIMEOUT_MS,
    );
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw Object.assign(new Error(`proxy fetch failed: ${e.message}`), { isRemoteFailure: true });
  }

  if (!r.ok) {
    throw Object.assign(
      new Error(`proxy HTTP ${r.status}`),
      { isRemoteFailure: true }
    );
  }

  let data;
  try {
    data = await r.json();
  } catch (_) {
    throw Object.assign(new Error('proxy parse error'), { isRemoteFailure: true });
  }

  if (!data || typeof data.status !== 'string' || !Array.isArray(data.batches)) {
    throw Object.assign(new Error('proxy invalid contract'), { isRemoteFailure: true });
  }

  return data;
}

// ── Cache-aware corpus fetch ──────────────────────────────────────────────────

// Fetch corpus from same-origin proxy with in-memory FRESH/STALE-IF-ERROR cache.
//
// cacheKey: pass '' to bypass cache entirely (non-Hebrew or single-char root).
//           pass 'he:<rootToken>' for cacheable Hebrew queries.
//
// Returns: { status, batches, fromCache, stale, partialFailure? }
// Throws:  AbortError (propagated — caller must handle)
//
// Cache contract:
//   FRESH (age < FRESH_TTL):         return cached, no network call
//   STALE (FRESH_TTL ≤ age < STALE): try refresh;
//     - complete success  → update cache, return fresh
//     - partial/failure   → serve stale (DON'T overwrite cache)
//   EXPIRED (age ≥ STALE_IF_ERROR):  try refresh; on failure return REMOTE_FAILURE
//   Cache writes: only complete successes (no anyFailure). Partials never cached.
//   SUCCESS_WITH_ZERO_RESULTS (no failures → complete) → cached
export async function bpFetchCorpus(normQ, translatedQ, cacheKey, pageSize, { signal } = {}) {
  const now    = Date.now();
  const cached = cacheKey ? _corpusCache.get(cacheKey) : undefined;

  if (cached) {
    const age = now - cached.fetchedAt;
    if (age < FRESH_TTL) {
      return { ...cached.data, fromCache: true, stale: false };
    }
    // Stale — attempt refresh
    try {
      const fresh = await _fetchFromProxy(normQ, translatedQ, pageSize, signal);
      if (fresh.status === 'REMOTE_FAILURE') {
        if (age < STALE_IF_ERROR) {
          return { ...cached.data, fromCache: true, stale: true };
        }
        return { status: 'REMOTE_FAILURE', batches: [], fromCache: false, stale: false };
      }
      // Check if result is complete (no batch failures)
      const hasPartialFailure = fresh.batches.some(b => b.error !== null);
      if (hasPartialFailure) {
        if (age < STALE_IF_ERROR) {
          // Eligible stale complete cache — serve it, do not overwrite
          return { ...cached.data, fromCache: true, stale: true };
        }
        // Expired cache + partial fresh — return partial fresh, do not cache
        return { ...fresh, fromCache: false, stale: false, partialFailure: true };
      }
      if (cacheKey) _corpusCache.set(cacheKey, { data: fresh, fetchedAt: now });
      return { ...fresh, fromCache: false, stale: false };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (age < STALE_IF_ERROR) {
        return { ...cached.data, fromCache: true, stale: true };
      }
      return { status: 'REMOTE_FAILURE', batches: [], fromCache: false, stale: false };
    }
  }

  // No cache entry
  try {
    const result = await _fetchFromProxy(normQ, translatedQ, pageSize, signal);
    if (result.status === 'REMOTE_FAILURE') {
      return { ...result, fromCache: false, stale: false };
    }
    const hasPartialFailure = result.batches.some(b => b.error !== null);
    if (!hasPartialFailure) {
      if (cacheKey) _corpusCache.set(cacheKey, { data: result, fetchedAt: now });
      return { ...result, fromCache: false, stale: false };
    }
    // Partial failure — don't cache; signal caller
    return { ...result, fromCache: false, stale: false, partialFailure: true };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { status: 'REMOTE_FAILURE', batches: [], fromCache: false, stale: false };
  }
}

// ── Test helpers (do not use in production) ───────────────────────────────────
export function _testOnlyGetCache()              { return _corpusCache; }
export function _testOnlyClearCache()            { _corpusCache.clear(); }
export function _testOnlySetClientTimeout(ms)    { _CLIENT_TIMEOUT_MS = ms; }

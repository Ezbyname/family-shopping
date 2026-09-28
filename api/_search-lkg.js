// api/_search-lkg.js

import { createHash } from 'crypto';
//
// Pure Last-Known-Good decision logic.
// No storage access and no external side effects.
//
// Rules:
// 1. Complete success with products may become new LKG.
// 2. Partial success must not overwrite an existing complete LKG.
// 3. REMOTE_FAILURE must never overwrite LKG.
// 4. REMOTE_FAILURE may serve an existing non-expired LKG.
// 5. Authoritative clean zero remains distinct from REMOTE_FAILURE.
// 6. Authoritative clean zero atomically replaces older GOOD with a ZERO tombstone.

export function buildSearchLkgKey({
  normalizedQuery,
  normalizedTranslatedQuery = normalizedQuery,
}) {
  const query = String(normalizedQuery || '').trim();

  if (!query) {
    throw new Error('normalizedQuery required');
  }

  const translated =
    String(normalizedTranslatedQuery || '').trim() || query;

  // Keep source + translated identity separate.
  // This avoids accidentally sharing cached results between distinct
  // source queries that happen to resolve to the same translation.
  const identity =
    `v1\nquery:${query}\ntranslated:${translated}`;

  const digest = createHash('sha256')
    .update(identity, 'utf8')
    .digest('hex');

  // Firebase-safe and explicitly versioned for future key migrations.
  return `v1_${digest}`;
}

export function decideSearchLkg({
  current,
  cached = null,
  now = Date.now(),
  ttlMs,
}) {
  if (!current || !current.status) {
    throw new Error('current search result required');
  }

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('positive ttlMs required');
  }

  const cachedUsable =
    cached &&
    Array.isArray(cached.products) &&
    cached.products.length > 0 &&
    Number.isFinite(cached.savedAt) &&
    (now - cached.savedAt) <= ttlMs;

  const currentProducts = Array.isArray(current.products)
    ? current.products
    : [];

  const partialFailure =
    current.status === 'ok' &&
    current.partialFailure === true;

  if (current.status === 'REMOTE_FAILURE') {
    if (cachedUsable) {
      return {
        source: 'last_known_good',
        products: cached.products,
        cacheAction: 'keep',
        degraded: true,
      };
    }

    return {
      source: 'remote_failure',
      products: [],
      cacheAction: 'keep',
      degraded: true,
    };
  }

  if (current.status === 'SUCCESS_WITH_ZERO_RESULTS') {
    return {
      source: 'authoritative_zero',
      products: [],
      cacheAction: 'write_zero',
      degraded: false,
    };
  }

  if (current.status === 'ok' && partialFailure) {
    if (cachedUsable) {
      return {
        source: 'last_known_good',
        products: cached.products,
        cacheAction: 'keep',
        degraded: true,
      };
    }

    return {
      source: 'partial_success',
      products: currentProducts,
      cacheAction: 'keep',
      degraded: true,
    };
  }

  if (current.status === 'ok' && currentProducts.length > 0) {
    return {
      source: 'fresh',
      products: currentProducts,
      cacheAction: 'write',
      degraded: false,
    };
  }

  return {
    source: 'empty',
    products: currentProducts,
    cacheAction: 'keep',
    degraded: false,
  };
}

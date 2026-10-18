// api/_off-picker-lkg.js
//
// Adapter that connects the product-picker proxy (/api/openfoodfacts-search)
// to the EXISTING Search LKG infrastructure:
//   key       -> buildSearchLkgKey()        (searchLkg/v1_<sha256>)
//   decision  -> decideSearchLkg()          (via resolveSearchWithLkg)
//   storage   -> injected repository        (Firebase adapter stays hard-gated)
//
// This module performs no storage access of its own. With no repository
// (the default while SEARCH_LKG_PERSISTENCE_APPROVED=false) it is never reached.
//
// What is stored: the flat list of raw OFF products of a trustworthy search,
// each tagged with the batch strategy it came from, so the batch structure the
// client expects can be rebuilt exactly. Nothing is invented or enriched.

import { buildSearchLkgKey } from './_search-lkg.js';
import { resolveSearchWithLkg } from './_search-lkg-service.js';
import { LKG_REPOSITORY_STATUS } from './_search-lkg-repository.js';

const KEY_NAMESPACE = 'picker:v1';
const STRATEGY_TAG = '__strategy';

function norm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Namespaced so picker records can never be confused with the /api/prices
// search records that share the same searchLkg/ root. pageSize is part of the
// identity because it changes the corpus.
export function buildPickerLkgKey({ q, translatedQ, pageSize }) {
  return buildSearchLkgKey({
    normalizedQuery: `${KEY_NAMESPACE}|ps=${pageSize}|${norm(q)}`,
    normalizedTranslatedQuery: norm(translatedQ) || norm(q),
  });
}

export function flattenBatches(batches) {
  const out = [];
  for (const batch of batches || []) {
    for (const product of batch.products || []) {
      out.push({ ...product, [STRATEGY_TAG]: batch.strategy });
    }
  }
  return out;
}

export function rebuildBatches(products) {
  const order = [];
  const byStrategy = new Map();

  for (const tagged of products || []) {
    const { [STRATEGY_TAG]: strategy, ...product } = tagged;
    if (!strategy) continue;
    if (!byStrategy.has(strategy)) {
      byStrategy.set(strategy, []);
      order.push(strategy);
    }
    byStrategy.get(strategy).push(product);
  }

  return order.map(strategy => ({
    strategy,
    products: byStrategy.get(strategy),
    error: null,
  }));
}

// A search is only trustworthy enough to become LKG when the primary
// Israel-filtered batch (the user's own words) succeeded. A corpus that
// survived only through translated_il / translated_broad is degraded: for a
// Hebrew query it is typically loosely matched English products.
export function isTrustworthyPickerResult(result) {
  const primary = (result?.batches || []).find(b => b.strategy === 'original_il');
  return !!primary && primary.error === null;
}

function toLkgCurrent(result) {
  return {
    status: result.status,
    partialFailure: result.status === 'ok' && !isTrustworthyPickerResult(result),
    products: flattenBatches(result.batches),
  };
}

function withCacheFields(result, cacheStatus) {
  return {
    ...result,
    offStatus: result.status,
    cacheStatus,
  };
}

// result: { status, batches } from searchOpenFoodFacts().
// Always resolves; any LKG failure degrades to the plain, uncached response.
export async function resolvePickerSearch({
  result,
  repository,
  ttlMs,
  key,
  now = Date.now(),
}) {
  const plain = withCacheFields(
    result,
    result.status === 'REMOTE_FAILURE' ? 'none' : 'fresh'
  );

  if (!repository) return plain;

  // Capture the stored record so the response can report its age.
  let seenRecord = null;
  const spy = {
    ...repository,
    async get(k) {
      const r = await repository.get(k);
      if (r.status === LKG_REPOSITORY_STATUS.HIT) seenRecord = r.record;
      return r;
    },
  };

  let resolution;
  try {
    resolution = await resolveSearchWithLkg({
      repository: spy,
      key,
      current: toLkgCurrent(result),
      ttlMs,
      now,
    });
  } catch (_) {
    return plain;
  }

  if (resolution.source === 'last_known_good' && seenRecord) {
    return {
      status: 'ok',
      batches: rebuildBatches(resolution.products),
      offStatus: result.status,
      cacheStatus: 'stale-if-error',
      cachedAt: seenRecord.savedAt,
      ageSeconds: Math.max(0, Math.round((now - seenRecord.savedAt) / 1000)),
      lkgSource: resolution.source,
      lkgMutationStatus: resolution.mutationStatus,
    };
  }

  return {
    ...plain,
    lkgSource: resolution.source,
    lkgMutationStatus: resolution.mutationStatus,
  };
}

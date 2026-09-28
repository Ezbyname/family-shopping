// api/_openfoodfacts.js
//
// Shared server-side Open Food Facts transport + result classification.
// No HTTP handler logic and no application-specific ranking/filtering.

const OFF_BASE = 'https://world.openfoodfacts.org/cgi/search.pl';
const OFF_FIELDS =
  'product_name,product_name_he,product_name_ar,brands,quantity,image_small_url,code,countries_tags';
const OFF_IL =
  '&tagtype_0=countries&tag_contains_0=contains&tag_0=israel';

const OFF_UA = 'FamilyShoppingIL/7.0';
const OFF_TIMEOUT_MS = 7_500;

// One bounded retry only for upstream HTTP 5xx responses.
//
// We intentionally do NOT retry:
// - 4xx: request/client condition, not expected to recover immediately
// - timeout: retrying can push the sequential OFF search too close to the
//   serverless execution budget
// - parse/network errors: preserve existing bounded failure semantics
//
// The short delay gives transient OFF failures a chance to recover without
// introducing an unbounded retry loop or request burst.
const OFF_5XX_RETRY_COUNT = 1;
const OFF_5XX_RETRY_DELAY_MS = 500;

export const OFF_ERR = {
  HTTP_4XX: 'off_http_4xx',
  HTTP_5XX: 'off_http_5xx',
  TIMEOUT: 'off_timeout',
  PARSE: 'off_parse',
  NETWORK: 'off_network',
};

export function buildOffUrl(q, pageSize, ilFilter) {
  const enc = encodeURIComponent(q);
  const filter = ilFilter ? OFF_IL : '';

  return (
    `${OFF_BASE}?search_terms=${enc}` +
    `&search_simple=1` +
    `&action=process` +
    `&json=1` +
    `&page_size=${pageSize}` +
    `&fields=${OFF_FIELDS}` +
    filter
  );
}

export async function fetchOffBatch(strategy, url) {
  for (
    let attempt = 0;
    attempt <= OFF_5XX_RETRY_COUNT;
    attempt++
  ) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': OFF_UA,
        },
        signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
      });

      if (!response.ok) {
        const is5xx = response.status >= 500;

        if (
          is5xx &&
          attempt < OFF_5XX_RETRY_COUNT
        ) {
          await new Promise(resolve =>
            setTimeout(resolve, OFF_5XX_RETRY_DELAY_MS)
          );
          continue;
        }

        return {
          strategy,
          products: [],
          error: is5xx
            ? OFF_ERR.HTTP_5XX
            : OFF_ERR.HTTP_4XX,
        };
      }

      let data;

      try {
        data = await response.json();
      } catch (_) {
        return {
          strategy,
          products: [],
          error: OFF_ERR.PARSE,
        };
      }

      if (!data || !Array.isArray(data.products)) {
        return {
          strategy,
          products: [],
          error: OFF_ERR.PARSE,
        };
      }

      return {
        strategy,
        products: data.products,
        error: null,
      };
    } catch (error) {
      const isTimeout =
        error?.name === 'TimeoutError' ||
        error?.name === 'AbortError';

      return {
        strategy,
        products: [],
        error: isTimeout
          ? OFF_ERR.TIMEOUT
          : OFF_ERR.NETWORK,
      };
    }
  }

  // Defensive fallback. The loop always returns before reaching here.
  return {
    strategy,
    products: [],
    error: OFF_ERR.HTTP_5XX,
  };
}

export function classifyOffBatches(batches) {
  const totalProducts = batches.reduce(
    (count, batch) => count + batch.products.length,
    0
  );

  const anyFailure = batches.some(
    batch => batch.error !== null
  );

  if (totalProducts > 0) {
    return 'ok';
  }

  if (!anyFailure) {
    return 'SUCCESS_WITH_ZERO_RESULTS';
  }

  return 'REMOTE_FAILURE';
}

export async function searchOpenFoodFacts({
  q,
  translatedQ = q,
  pageSize = 20,
}) {
  const strategyDefs = [
    {
      strategy: 'original_il',
      url: buildOffUrl(q, pageSize, true),
    },

    ...(translatedQ !== q
      ? [
          {
            strategy: 'translated_il',
            url: buildOffUrl(translatedQ, 15, true),
          },
        ]
      : []),

    {
      strategy: 'translated_broad',
      url: buildOffUrl(translatedQ, 20, false),
    },
  ];

  // Sequential intentionally:
  // preserves deterministic order and avoids OFF request bursts.
  const batches = [];

  for (const def of strategyDefs) {
    batches.push(
      await fetchOffBatch(def.strategy, def.url)
    );
  }

  return {
    status: classifyOffBatches(batches),
    batches,
  };
}

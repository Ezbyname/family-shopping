// chain-factory.js — Dynamic chain / store / product generator
//
// All generated names are generic (רשת 1, סניף 1, …) so tests remain valid
// regardless of which real supermarket chains are deployed.
//
// Used by:
//   tests/pw-bc-chains.mjs          — large-scale standalone validation
//   tests/e2e/15-chain-onboarding.spec.js — Playwright chain onboarding tests

export const CITIES  = ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע', 'ראשון לציון', 'פתח תקווה'];
export const STREETS = ['הרצל', 'ויצמן', 'בן גוריון', 'ז׳בוטינסקי', 'רוטשילד', 'אלנבי'];

const ITEMS_TEMPLATE = [
  { barcode:'7290000001', name:'מוצר א', quantity:1, unitPrice:10 },
  { barcode:'7290000002', name:'מוצר ב', quantity:2, unitPrice:15 },
  { barcode:'7290000003', name:'מוצר ג', quantity:1, unitPrice:20 },
  { barcode:'7290000004', name:'מוצר ד', quantity:1, unitPrice:12 },
  { barcode:'7290000005', name:'מוצר ה', quantity:1, unitPrice:8  },
];

/**
 * Build a basket-compare results array for chainCount chains × storesPerChain stores.
 *
 * Stores are INTERLEAVED across chains so the first PAGE_SIZE (10) results already
 * contain stores from every chain. This tests chain diversity in the initial render,
 * not just after full pagination.
 *
 *   slot 0 → chain-0 store-0   (cheapest)
 *   slot 1 → chain-1 store-0
 *   …
 *   slot C → chain-0 store-1   (C = chainCount)
 *
 * Total stores = chainCount × storesPerChain, sorted cheapest-first.
 */
export function makeChainMatrix(chainCount, storesPerChain, priceStep = 1.5) {
  const totalStores = chainCount * storesPerChain;
  const results     = [];

  for (let i = 0; i < totalStores; i++) {
    const chainIdx = i % chainCount;
    const storeIdx = Math.floor(i / chainCount);
    const total    = parseFloat((80 + i * priceStep).toFixed(2));

    results.push({
      chainId:         `chain-${chainIdx}`,
      chainName:       `רשת ${chainIdx + 1}`,
      storeId:         `chain-${chainIdx}-store-${storeIdx}`,
      storeName:       `סניף ${storeIdx + 1}`,
      city:            CITIES[i % CITIES.length],
      address:         `${STREETS[i % STREETS.length]} ${i + 1}`,
      latitude:        32.08 + i * 0.001,
      longitude:       34.78 + i * 0.001,
      distanceKm:      parseFloat((1 + i * 0.1).toFixed(1)),
      total,
      availableItems:  5,
      missingItems:    [],
      totalItems:      5,
      completeness:    100,
      hasFallbackData: false,
      items: ITEMS_TEMPLATE.map(it => ({
        ...it,
        unitPrice:  parseFloat((it.unitPrice + i * 0.05).toFixed(2)),
        totalPrice: parseFloat(((it.unitPrice + i * 0.05) * it.quantity).toFixed(2)),
      })),
    });
  }

  const best     = results[0];
  const priciest = results[totalStores - 1];
  const maxSavings = parseFloat((priciest.total - best.total).toFixed(2));

  return {
    // Raw results array — useful for inspection
    results,
    // Full API payload — pass to mockRoute or _bcRenderForTest
    payload: {
      version:        '2.3.0',
      radiusKm:       10,
      itemsRequested: 5,
      bestFullBasket: best,
      summary: {
        cheapestTotal:  best.total,
        priciestTotal:  priciest.total,
        maxSavings,
        maxSavingsPct:  Math.round((maxSavings / priciest.total) * 100),
        storesFound:    totalStores,
      },
      results,
    },
    // Convenience properties
    chainCount,
    storesPerChain,
    totalStores,
    cheapestTotal:  best.total,
    maxSavings,
    chainIds: [...new Set(results.map(r => r.chainId))],
  };
}

/**
 * Generate a /api/coverage response for chainCount chains.
 * The last chain always has errors:1 to validate error-indicator rendering.
 */
export function makeCoverageMatrix(chainCount) {
  const chains = Array.from({ length: chainCount }, (_, i) => ({
    id:              `chain-${i}`,
    name:            `רשת ${i + 1}`,
    itemsProcessed:  10_000,
    storesProcessed: 50,
    errors:          i === chainCount - 1 ? 1 : 0,
  }));
  return {
    lastSync:        new Date(Date.now() - 3_600_000).toISOString(),
    totalProducts:   chainCount * 10_000,
    chainsSucceeded: chainCount - 1,
    chainsFailed:    1,
    chains,
  };
}

/**
 * Generate a /api/prices?q= response with chainCount chains.
 * Each chain contributes one product result.
 */
export function makePriceSearchMatrix(chainCount) {
  return {
    results: Array.from({ length: chainCount }, (_, i) => ({
      name:       'חלב טרה 3%',
      barcode:    '7290000066614',
      chainId:    `chain-${i}`,
      chainName:  `רשת ${i + 1}`,
      chainPrice: parseFloat((5.49 + i * 0.5).toFixed(2)),
      prices: [{
        price:     parseFloat((5.49 + i * 0.5).toFixed(2)),
        chainId:   `chain-${i}`,
        chainName: `רשת ${i + 1}`,
        storeId:   `chain-${i}-store-0`,
        storeName: `סניף ראשי`,
        address:   `${STREETS[i % STREETS.length]} ${i + 1}`,
        city:      CITIES[i % CITIES.length],
        source:    'official',
        syncedAt:  Date.now() - 3_600_000,
        isStale:   false,
      }],
    })),
  };
}

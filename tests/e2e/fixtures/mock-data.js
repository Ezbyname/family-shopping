// mock-data.js — Chain-agnostic mock data factory
// Deliberately avoids real chain names so tests survive any chain onboarding.

/**
 * Build an array of mock basket-compare results.
 * Chain names are generic (רשת 1, רשת 2, ...) — tests must never assert on them.
 */
export function makeBasketResults(n, { priceStep = 1.5, baseTotal = 80 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    chainId:        `chain-${i % 5}`,
    chainName:      `רשת ${(i % 5) + 1}`,
    storeId:        `store-${i}`,
    storeName:      `סניף ${i + 1}`,
    city:           ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע'][i % 4],
    address:        `רחוב הרצל ${i + 1}`,
    latitude:       32.08 + i * 0.01,
    longitude:      34.78 + i * 0.01,
    distanceKm:     Math.round((1 + i * 0.3) * 10) / 10,
    total:          parseFloat((baseTotal + i * priceStep).toFixed(2)),
    availableItems: 5,
    missingItems:   [],
    totalItems:     5,
    completeness:   100,
    hasFallbackData:false,
    items: [
      { barcode:'7290000001', name:'מוצר א', quantity:1, unitPrice:10 + i,    totalPrice:10 + i    },
      { barcode:'7290000002', name:'מוצר ב', quantity:2, unitPrice:15,         totalPrice:30        },
      { barcode:'7290000003', name:'מוצר ג', quantity:1, unitPrice:20,         totalPrice:20        },
      { barcode:'7290000004', name:'מוצר ד', quantity:1, unitPrice:12,         totalPrice:12        },
      { barcode:'7290000005', name:'מוצר ה', quantity:1, unitPrice:8+i*0.1,   totalPrice:8+i*0.1   },
    ],
  }));
}

/**
 * Build a basket-compare API response payload from N results.
 */
export function makeBasketPayload(n, opts = {}) {
  const results  = makeBasketResults(n, opts);
  const best     = results[0];
  const priciest = results[n - 1];
  const maxSavings = parseFloat((priciest.total - best.total).toFixed(2));
  return {
    version:        '2.3.0',
    radiusKm:       10,
    itemsRequested: 5,
    bestFullBasket: best,
    summary: {
      cheapestTotal:  best.total,
      priciestTotal:  priciest.total,
      maxSavings,
      maxSavingsPct:  Math.round((maxSavings / priciest.total) * 100),
      storesFound:    n,
    },
    results,
  };
}

/**
 * Build a mock /api/prices?q= response.
 * Each result belongs to a different generic chain so chain-agnostic rendering is tested.
 */
export function makePriceSearchResults(chainCount = 3) {
  const chains = Array.from({ length: chainCount }, (_, i) => ({
    chainId:   `chain-${i}`,
    chainName: `רשת ${i + 1}`,
  }));

  return {
    results: chains.map(({ chainId, chainName }, i) => ({
      name:      'חלב טרה 3%',
      barcode:   '7290000066614',
      chainId,
      chainName,
      chainPrice: parseFloat((5.49 + i * 0.5).toFixed(2)),
      prices: [
        {
          price:      parseFloat((5.49 + i * 0.5).toFixed(2)),
          chainId,
          chainName,
          storeId:   `${chainId}-1`,
          storeName: `סניף ראשי ${i + 1}`,
          address:   `רחוב אלנבי ${i + 1}`,
          city:      ['תל אביב', 'ירושלים', 'חיפה'][i % 3],
          source:    'official',
          syncedAt:  Date.now() - 3_600_000,
          isStale:   false,
        },
      ],
    })),
  };
}

/**
 * Build a /api/coverage response with N chains (generic names).
 * Inject an error chain to verify error-indicator rendering.
 */
export function makeCoveragePayload(chainCount = 3) {
  const chains = Array.from({ length: chainCount }, (_, i) => ({
    id:              `chain-${i}`,
    name:            `רשת ${i + 1}`,
    itemsProcessed:  10_000 * (i + 1),
    storesProcessed: 50 * (i + 1),
    errors:          i === chainCount - 1 ? 1 : 0,
  }));
  return {
    lastSync:        new Date(Date.now() - 3_600_000).toISOString(),
    totalProducts:   chains.reduce((s, c) => s + c.itemsProcessed, 0),
    chainsSucceeded: chainCount - 1,
    chainsFailed:    1,
    chains,
  };
}

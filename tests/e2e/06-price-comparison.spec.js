// 06-price-comparison.spec.js — Price lookup and basket compare APIs
// @critical: "prices API returns valid response", "basket-compare accepts POST"
//
// Confirmed API response shapes (api/prices.js v6.3.0):
//   barcode mode  → { version, barcode, prices: [...], source, ... }
//   missing param → HTTP 400 { error }
//   unknown barcode → HTTP 200 { barcode, prices: [], ... }
//   basket-compare → POST /api/basket-compare (HTTP 200/400, not 500)
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('Price comparison', () => {

  test('prices API returns valid response for known barcode @critical', async ({ page }) => {
    // Tnuva milk — widely present in price database
    const res = await page.request.get('/api/prices?barcode=7290000066614');
    expect(res.status()).toBe(200);

    const body = await res.json();
    // Response is an object, not an array
    expect(body).toHaveProperty('barcode');
    expect(body).toHaveProperty('prices');
    expect(Array.isArray(body.prices)).toBe(true);
  });

  test('prices API returns 400 when barcode and q are both missing', async ({ page }) => {
    const res = await page.request.get('/api/prices');
    // API explicitly returns 400 for missing params (api/prices.js line 247)
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  test('prices API handles unknown barcode gracefully', async ({ page }) => {
    const res = await page.request.get('/api/prices?barcode=0000000000001');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('prices');
    expect(Array.isArray(body.prices)).toBe(true);
    // Unknown barcode returns empty prices array — not a 500
    expect(body.prices.length).toBe(0);
  });

  test('basket-compare API accepts POST with empty basket @critical', async ({ page }) => {
    const res = await page.request.post('/api/basket-compare', {
      data: { items: [] },
      headers: { 'Content-Type': 'application/json' },
    });
    // Must not 500 — empty basket is a valid degenerate case
    expect(res.status()).not.toBe(500);
    expect(res.status()).not.toBe(405);
  });

  test('health API confirms Firebase connectivity @critical', async ({ page }) => {
    const res = await page.request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('timings');
  });

});

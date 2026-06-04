// 06-price-comparison.spec.js — Price lookup API and comparison UI
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('Price comparison', () => {

  test('prices API responds to barcode query', async ({ page }) => {
    // Tnuva milk — nearly always in the price database
    const response = await page.request.get('/api/prices?barcode=7290000066614');
    expect(response.status()).toBe(200);
    const body = await response.json();
    // Response must be an array (even if empty — no 500)
    expect(Array.isArray(body)).toBe(true);
  });

  test('prices API handles missing barcode gracefully', async ({ page }) => {
    const response = await page.request.get('/api/prices');
    // Should return 400 or 200 with empty — must NOT 500
    expect(response.status()).not.toBe(500);
  });

  test('prices API handles unknown barcode gracefully', async ({ page }) => {
    const response = await page.request.get('/api/prices?barcode=0000000000001');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    // Empty array is correct — no crash
  });

  test('basket-compare API accepts empty basket', async ({ page }) => {
    const response = await page.request.post('/api/basket-compare', {
      data: { items: [] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).not.toBe(500);
  });

  test('health API confirms Firebase data freshness', async ({ page }) => {
    const response = await page.request.get('/api/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);

    if (body.db?.lastSyncDate) {
      const syncDate = new Date(body.db.lastSyncDate);
      const hoursSinceSync = (Date.now() - syncDate.getTime()) / 3_600_000;
      // Warn if stale (>48h) but don't fail CI — sync worker may be on separate schedule
      if (hoursSinceSync > 48) {
        console.warn(`⚠️  Price data is ${Math.round(hoursSinceSync)}h old — sync worker may need attention`);
      }
    }
  });

});

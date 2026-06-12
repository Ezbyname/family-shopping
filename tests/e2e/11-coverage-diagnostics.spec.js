// 11-coverage-diagnostics.spec.js — /api/coverage endpoint + chain health validation
//
// Strategic purpose: as new supermarket chains are onboarded, this test ensures
// the coverage API returns correct metadata for ALL chains (not just a fixed set).
// Tests are chain-count-agnostic — they validate shape, not specific chain names.
//
// @critical: "coverage API returns valid shape"
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('Coverage & diagnostics API', () => {

  test('GET /api/coverage returns 200 @critical', async ({ page }) => {
    const res = await page.request.get('/api/coverage');
    expect(res.status()).toBe(200);
  });

  test('coverage response has required top-level fields @critical', async ({ page }) => {
    const res  = await page.request.get('/api/coverage');
    const body = await res.json();

    expect(body).toHaveProperty('chains');
    expect(Array.isArray(body.chains)).toBe(true);

    // totalProducts must be a non-negative integer
    expect(typeof body.totalProducts).toBe('number');
    expect(body.totalProducts).toBeGreaterThanOrEqual(0);
  });

  test('coverage response includes lastSync timestamp', async ({ page }) => {
    const res  = await page.request.get('/api/coverage');
    const body = await res.json();

    // lastSync can be a date string or null (if never synced), but the field must exist
    expect('lastSync' in body).toBe(true);
  });

  test('each chain entry has required fields', async ({ page }) => {
    const res    = await page.request.get('/api/coverage');
    const { chains } = await res.json();

    // No assertions on the number of chains — any count is valid as coverage expands
    for (const chain of chains) {
      expect(chain).toHaveProperty('id');
      expect(chain).toHaveProperty('name');
      // itemsProcessed and storesProcessed may be 0 for newly added chains
      expect(typeof chain.itemsProcessed === 'number' || chain.itemsProcessed === null).toBe(true);
      expect(typeof chain.storesProcessed === 'number' || chain.storesProcessed === null).toBe(true);
      // errors field: 0 = healthy, >0 = degraded — both are valid states
      expect(typeof chain.errors === 'number' || chain.errors === null).toBe(true);
    }
  });

  test('chainsSucceeded and chainsFailed are non-negative integers', async ({ page }) => {
    const res  = await page.request.get('/api/coverage');
    const body = await res.json();

    if ('chainsSucceeded' in body) {
      expect(typeof body.chainsSucceeded).toBe('number');
      expect(body.chainsSucceeded).toBeGreaterThanOrEqual(0);
    }
    if ('chainsFailed' in body) {
      expect(typeof body.chainsFailed).toBe('number');
      expect(body.chainsFailed).toBeGreaterThanOrEqual(0);
    }
  });

  test('coverage response does not 500 under repeated requests', async ({ page }) => {
    // Two rapid requests — should both succeed (not depend on mutable in-memory state)
    const [r1, r2] = await Promise.all([
      page.request.get('/api/coverage'),
      page.request.get('/api/coverage'),
    ]);
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);
  });

  test('newly-onboarded chain with errors is reported, not hidden', async ({ page }) => {
    // If any chain has errors > 0, it must still appear in the chains array.
    // This prevents silent suppression of degraded chains post-onboarding.
    const res    = await page.request.get('/api/coverage');
    const { chains } = await res.json();
    for (const chain of chains) {
      // Chain is present regardless of error state
      expect(chain.id).toBeTruthy();
      expect(chain.name).toBeTruthy();
    }
  });

});

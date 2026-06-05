// 01-app-loads.spec.js — App shell, Firebase auth, service worker, health API
// @critical: "setup or main screen becomes visible", "health API responds ok"
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('App shell & Firebase init', () => {

  test('page loads without JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await page.waitForTimeout(4000);

    const fatal = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('Non-Error promise rejection')
    );
    expect(fatal, `Unexpected JS errors:\n${fatal.join('\n')}`).toHaveLength(0);
  });

  test('splash overlay disappears within 5 seconds @critical', async ({ page }) => {
    await page.goto('/');
    // Must hide — if it stays visible the app is stuck on loading
    await expect(page.locator('#splash-overlay')).toBeHidden({ timeout: 5_000 });
  });

  test('setup or main screen becomes visible @critical', async ({ page, appPage }) => {
    await appPage.goto();
    await appPage.waitForAppReady();

    const setup = await page.locator('#setup-screen.active').isVisible();
    const main  = await page.locator('#main-screen.active').isVisible();

    expect(setup || main, 'Either setup-screen or main-screen must have .active class').toBe(true);
  });

  test('manifest.json is accessible and valid', async ({ page }) => {
    const res = await page.request.get('/manifest.json');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('name');
    expect(body).toHaveProperty('icons');
  });

  test('health API responds ok @critical', async ({ page }) => {
    const res = await page.request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

});

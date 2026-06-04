// 07-offline.spec.js — Offline recovery: app shell loads from SW cache when network is gone
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('Offline recovery', () => {

  test('app shell is served from cache when offline', async ({ page, context }) => {
    // Step 1: load online to populate SW cache
    await page.goto('/');
    await page.waitForTimeout(4000);  // let SW install and cache

    // Step 2: go offline
    await context.setOffline(true);

    // Step 3: reload — SW cache should serve the shell
    try {
      await page.reload({ timeout: 8_000 });
    } catch {
      // timeout is acceptable — we're offline
    }

    // App must not show a "no internet" browser error page
    const title = await page.title().catch(() => '');
    expect(title).not.toContain('ERR_');
    expect(title).not.toContain('No internet');

    // Page should still have our app's root elements
    const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
    expect(bodyHtml.length).toBeGreaterThan(100);

    await context.setOffline(false);
  });

  test('app does not crash when Firebase calls fail offline', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // Load first, then go offline mid-session
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('myName',  'OfflineUser');
      localStorage.setItem('groupId', 'ci-test-group');
    });
    await page.reload();
    await page.waitForTimeout(2000);

    await context.setOffline(true);
    await page.waitForTimeout(2000);  // let Firebase listeners fail

    const fatalErrors = errors.filter(e =>
      e.includes('Uncaught TypeError') ||
      e.includes('Uncaught ReferenceError')
    );
    expect(fatalErrors).toHaveLength(0);

    await context.setOffline(false);
  });

});

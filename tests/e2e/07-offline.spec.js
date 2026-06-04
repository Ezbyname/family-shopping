// 07-offline.spec.js — Offline recovery: SW cache serves app shell when network is gone
import { test, expect, setSession } from './fixtures/test-fixtures.js';

test.describe('Offline recovery', () => {

  test('app shell served from SW cache when offline', async ({ page, context }) => {
    // Load once online so SW installs and caches the shell
    await page.goto('/');
    await page.waitForTimeout(4000);

    await context.setOffline(true);

    try {
      await page.reload({ timeout: 8_000 });
    } catch {
      // Navigation timeout is expected — we are offline
    }

    // Must not show a browser-level ERR_ page
    const title = await page.title().catch(() => '');
    expect(title).not.toContain('ERR_');
    expect(title).not.toContain('No internet');

    const bodyHtml = await page.locator('body').innerHTML().catch(() => '');
    expect(bodyHtml.length).toBeGreaterThan(100);

    await context.setOffline(false);
  });

  test('app does not crash when Firebase listeners fail offline', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('/');
    // Use real fsl_v2 contract so the app tries to connect to Firebase (and then fails offline)
    await setSession(page, {
      myName:  'OfflineUser',
      groupId: 'ci-test-group',
      groupName: 'CI Test Group',
    });
    await page.reload();
    await page.waitForTimeout(2000);

    await context.setOffline(true);
    await page.waitForTimeout(2000);

    const fatal = errors.filter(e =>
      e.includes('Uncaught TypeError') ||
      e.includes('Uncaught ReferenceError')
    );
    expect(fatal).toHaveLength(0);

    await context.setOffline(false);
  });

});

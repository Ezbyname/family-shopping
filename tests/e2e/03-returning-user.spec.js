// 03-returning-user.spec.js — Returning user / session restore flow
import { test, expect, setSession, clearSession } from './fixtures/test-fixtures.js';

test.describe('Returning user login', () => {

  test('returning user with fsl_v2 reaches main-screen', async ({ page, appPage }) => {
    await page.goto('/');
    // Seed the exact localStorage key the app reads on startup
    await setSession(page, {
      myName:    'TestReturning',
      groupId:   'test-group-001',
      groupName: 'Test Family',
    });
    await page.reload();
    await appPage.waitForAppReady();

    // App reads fsl_v2, finds groupId, calls connectToGroup(), shows main-screen
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#setup-screen.active')).toBeHidden();
  });

  test('page reload does not reset to setup screen', async ({ page, appPage }) => {
    await page.goto('/');
    await setSession(page, {
      myName:    'ReloadTest',
      groupId:   'test-group-002',
      groupName: 'Family B',
    });
    await page.reload();
    await appPage.waitForAppReady();

    // Second reload — session must persist
    await page.reload();
    await appPage.waitForAppReady();

    await expect(page.locator('#setup-screen.active')).toBeHidden();
  });

  test('new user with no fsl_v2 sees setup screen', async ({ page, appPage }) => {
    await page.goto('/');
    await clearSession(page);
    await page.reload();
    await appPage.waitForAppReady();

    await expect(page.locator('#setup-screen.active')).toBeVisible({ timeout: 10_000 });
  });

});

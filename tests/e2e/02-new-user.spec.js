// 02-new-user.spec.js — New user registration and create-group flow
// @critical: "full new user → create group flow"
import { test, expect, clearSession } from './fixtures/test-fixtures.js';

test.describe('New user registration', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearSession(page);
    await page.reload();
  });

  test('setup screen shown to new user (no fsl_v2)', async ({ appPage }) => {
    await appPage.goto();
    await appPage.waitForAppReady();
    await expect(appPage.page.locator('#setup-screen.active')).toBeVisible({ timeout: 10_000 });
  });

  test('create-group tab is present and clickable', async ({ appPage }) => {
    await appPage.goto();
    await appPage.waitForAppReady();
    await expect(appPage.page.locator('#stab-create')).toBeVisible({ timeout: 8_000 });
  });

  test('cn-name input accepts text', async ({ appPage, testUserName }) => {
    await appPage.goto();
    await appPage.waitForAppReady();
    await appPage.clickCreateTab();
    await appPage.page.locator('#cn-name').fill(testUserName);
    await expect(appPage.page.locator('#cn-name')).toHaveValue(testUserName);
  });

  test('full new user => create group flow @critical', async ({ appPage, testUserName, page }) => {
    await appPage.goto();
    await appPage.waitForAppReady();

    await appPage.clickCreateTab();
    await appPage.fillCreateName(testUserName);
    await appPage.submitCreateGroup();

    // After Firebase write completes, app transitions to main-screen
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 15_000 });
    await appPage.expectNoErrorBanner();
  });

});

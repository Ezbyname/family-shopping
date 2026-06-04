// 02-new-user.spec.js — New user registration + group creation flow
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('New user registration', () => {

  test.beforeEach(async ({ page }) => {
    // Fresh state: clear storage to simulate brand-new user
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
  });

  test('setup screen is shown to new user', async ({ appPage }) => {
    await appPage.goto();
    await appPage.waitForAppReady();
    await expect(appPage.page.locator('#setup-screen')).toBeVisible({ timeout: 10_000 });
  });

  test('user can enter their name', async ({ appPage, testUserName }) => {
    await appPage.goto();
    await appPage.waitForAppReady();

    const nameInput = appPage.page.locator(
      '#setup-name, input[type="text"]'
    ).first();
    await expect(nameInput).toBeVisible({ timeout: 8_000 });
    await nameInput.fill(testUserName);
    await expect(nameInput).toHaveValue(testUserName);
  });

  test('create group button is present on setup screen', async ({ appPage }) => {
    await appPage.goto();
    await appPage.waitForAppReady();

    const createBtn = appPage.page.locator(
      '#btn-create-group, button:has-text("צור"), button:has-text("Create")'
    ).first();
    await expect(createBtn).toBeVisible({ timeout: 8_000 });
  });

  test('full new user → create group flow', async ({ appPage, testUserName, page }) => {
    await appPage.goto();
    await appPage.waitForAppReady();

    // Fill name
    await appPage.fillName(testUserName);

    // Click create group
    await appPage.clickCreateGroup();

    // After group creation, main app should appear
    await expect(page.locator('#main-app')).toBeVisible({ timeout: 15_000 });

    // No error banner
    await appPage.expectNoErrorBanner();
  });

});

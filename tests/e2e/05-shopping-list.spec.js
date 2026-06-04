// 05-shopping-list.spec.js — Add item + Firebase write round-trip
// @critical: "item appears in list after add"
import { test, expect, setSession } from './fixtures/test-fixtures.js';

test.describe('Shopping list operations', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Use the real fsl_v2 contract to land in main-screen
    await setSession(page, {
      myName:    'ListTester',
      groupId:   'ci-test-group',
      groupName: 'CI Test Group',
    });
    await page.reload();
  });

  test('new-item-input is visible in main-screen', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#new-item-input')).toBeVisible({ timeout: 8_000 });
  });

  test('add-item button is visible ([data-testid="add-item-btn"])', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('[data-testid="add-item-btn"]')).toBeVisible({ timeout: 8_000 });
  });

  test('typing in new-item-input does not crash @critical', async ({ appPage, page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await appPage.waitForAppReady();
    const input = page.locator('#new-item-input');
    await expect(input).toBeVisible({ timeout: 8_000 });

    await input.fill('חלב');
    await input.fill('');
    await input.fill('לחם');

    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);
  });

  test('item appears in list after add — Firebase round-trip @critical', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const itemName = `חלב_${Date.now()}`;
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();

    // Firebase write + realtime listener should surface the item within 8 seconds
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });
  });

});

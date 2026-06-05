// 05-shopping-list.spec.js — Add item + Firebase write round-trip + persistence
// @critical: "item appears in list after add", "item persists after reload"
import { test, expect, setSession } from './fixtures/test-fixtures.js';

const SESSION = {
  myName:    'ListTester',
  groupId:   'ci-test-group',
  groupName: 'CI Test Group',
};

test.describe('Shopping list operations', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSession(page, SESSION);
    await page.reload();
  });

  test('new-item-input is visible in main-screen', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#new-item-input')).toBeVisible({ timeout: 8_000 });
  });

  test('add-item button is visible', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('[data-testid="add-item-btn"]')).toBeVisible({ timeout: 8_000 });
  });

  test('typing in input does not crash @critical', async ({ appPage, page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await appPage.waitForAppReady();
    const input = page.locator('#new-item-input');
    await expect(input).toBeVisible({ timeout: 8_000 });
    await input.fill('חלב');
    await input.fill('');
    await input.fill('לחם');

    expect(errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'))).toHaveLength(0);
  });

  test('item appears in list after add — Firebase round-trip @critical', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const itemName = `חלב_${Date.now()}`;
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();

    // Confirms Firebase write + onValue listener delivery
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });
  });

  test('item persists after full page reload — Firebase persistence @critical', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const itemName = `לחם_persist_${Date.now()}`;
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    // Reload: fsl_v2 still in localStorage, app reconnects to Firebase
    await page.reload();
    await appPage.waitForAppReady();

    // If item is missing here: Firebase write failed, permissions denied, or local-only state bug
    await expect(
      page.locator(`text=${itemName}`).first(),
      'Item must survive a reload — failure means Firebase write did not persist'
    ).toBeVisible({ timeout: 10_000 });
  });

});

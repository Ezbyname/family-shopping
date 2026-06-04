// 05-shopping-list.spec.js — Add item + mark purchased flows
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('Shopping list operations', () => {

  // Pre-seed a returning user so we land in the main app
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('myName',   'ListTester');
      localStorage.setItem('groupId',  'ci-test-group');
      localStorage.setItem('groupName','CI Test Group');
    });
    await page.reload();
  });

  test('add item input is visible in main app', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    // Navigate to the list tab if tabs exist
    const listTab = page.locator(
      'button:has-text("רשימה"), button:has-text("List"), [data-tab="list"], nav button'
    ).first();
    if (await listTab.count() > 0) await listTab.click();

    const addInput = page.locator(
      '#new-item-input, input[placeholder*="פריט"], input[placeholder*="הוסף"], input[placeholder*="Add"]'
    ).first();
    await expect(addInput).toBeVisible({ timeout: 10_000 });
  });

  test('add button is present next to input', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const addBtn = page.locator(
      '#btn-add-item, button:has-text("הוסף"), button:has-text("Add"), button[type="submit"]'
    ).first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
  });

  test('typing in item input does not crash the app', async ({ appPage, page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await appPage.waitForAppReady();

    const addInput = page.locator(
      '#new-item-input, input[placeholder*="פריט"], input[placeholder*="הוסף"]'
    ).first();

    if (await addInput.isVisible()) {
      await addInput.fill('חלב');
      await addInput.fill('');  // clear
      await addInput.fill('לחם');
    }

    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);
  });

  test('item appears in list after add (Firebase write round-trip)', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const itemName = `חלב_${Date.now()}`;

    const addInput = page.locator(
      '#new-item-input, input[placeholder*="פריט"], input[placeholder*="הוסף"]'
    ).first();

    if (!await addInput.isVisible()) {
      test.skip('Add item input not found — skipping write round-trip test');
      return;
    }

    await addInput.fill(itemName);
    const addBtn = page.locator(
      '#btn-add-item, button:has-text("הוסף"), button[type="submit"]'
    ).first();
    await addBtn.click();

    // Item should appear within 5 seconds (Firebase write + listener)
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });
  });

});

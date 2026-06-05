// 08-purchased-item.spec.js — Mark item as purchased + Firebase persistence
//
// Strategy (no arbitrary sleeps, no mocked Firebase):
//   1. Add item → wait for it to appear (Firebase write confirmed by onValue listener)
//   2. Click the pending-tag button (calls toggleBought → Firebase update)
//   3. Wait for button to become .bought-tag (class change driven by Firebase onValue)
//      — this confirms the Firebase write + listener round-trip succeeded
//   4. Reload app with same fsl_v2 session
//   5. Assert bought-tag is still present — proves Firebase persisted the state
//
// @critical: "purchased item state persists after reload"
import { test, expect, setSession } from './fixtures/test-fixtures.js';

const CI_GROUP = 'ci-test-group';

test.describe('Purchased item persistence', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSession(page, {
      myName:    'BuyTester',
      groupId:   CI_GROUP,
      groupName: 'CI Test Group',
    });
    await page.reload();
  });

  test('mark item purchased — Firebase round-trip @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();

    const itemName = `מוצר_${Date.now()}`;

    // Step 1: Add item and wait for Firebase onValue to surface it
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    // Step 2: Click the pending-tag button (toggleBought → Firebase write)
    // The button is inside the item-card for this item
    const itemCard = page.locator(`.item-card:has-text("${itemName}")`).first();
    const pendingBtn = itemCard.locator('.pending-tag').first();
    await expect(pendingBtn).toBeVisible({ timeout: 5_000 });
    await pendingBtn.click();

    // Step 3: Wait for the button to become .bought-tag
    // This is driven by the Firebase onValue listener — confirms write + round-trip
    const boughtBtn = itemCard.locator('.bought-tag').first();
    await expect(boughtBtn).toBeVisible({ timeout: 8_000 });

    // Also confirm the item-card itself has the .bought class
    await expect(itemCard).toHaveClass(/bought/, { timeout: 5_000 });
  });

  test('purchased state persists after full page reload @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();

    const itemName = `מוצר_persist_${Date.now()}`;

    // Add item
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    // Mark as bought — wait for Firebase round-trip confirmation
    const itemCard = page.locator(`.item-card:has-text("${itemName}")`).first();
    await itemCard.locator('.pending-tag').first().click();
    await expect(itemCard.locator('.bought-tag').first()).toBeVisible({ timeout: 8_000 });

    // Reload — same fsl_v2 session still in localStorage
    await page.reload();
    await appPage.waitForAppReady();

    // After reload, Firebase onValue re-delivers the data
    // Item must appear with .bought class and .bought-tag button
    const reloadedCard = page.locator(`.item-card:has-text("${itemName}")`).first();
    await expect(reloadedCard).toBeVisible({ timeout: 10_000 });
    await expect(reloadedCard).toHaveClass(/bought/, { timeout: 8_000 });
    await expect(reloadedCard.locator('.bought-tag').first()).toBeVisible({ timeout: 5_000 });
  });

  test('bought item appears on the Bought tab @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();

    const itemName = `מוצר_tab_${Date.now()}`;

    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    const itemCard = page.locator(`.item-card:has-text("${itemName}")`).first();
    await itemCard.locator('.pending-tag').first().click();
    await expect(itemCard.locator('.bought-tag').first()).toBeVisible({ timeout: 8_000 });

    // Switch to the bought tab
    await page.locator('#tab-bought').click();

    // Item must appear in the bought list
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 5_000 });
  });

});

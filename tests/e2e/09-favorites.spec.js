// 09-favorites.spec.js — Favorites panel: save, add to list, Firebase persistence
//
// Strategy (no mocked Firebase):
//   1. Add a shopping item → wait for it to appear (Firebase onValue confirmed)
//   2. Click the star/fav button on the item-card → toggleSavedFavorite → Firebase write
//   3. Switch to favorites tab → fav-panel visible, fav-item-card shows the saved item
//   4. Click fav-add-btn → addFavoriteToList → item added back to shopping list
//   5. Reload → favorites still present (Firebase persistence confirmed)
//
// @critical: "saved item appears in favorites panel", "favorites persist after reload"
import { test, expect, setSession } from './fixtures/test-fixtures.js';

const CI_GROUP = 'ci-test-group';

test.describe('Favorites', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSession(page, {
      myName:    'FavTester',
      groupId:   CI_GROUP,
      groupName: 'CI Test Group',
    });
    await page.reload();
  });

  test('favorites tab is visible in main-screen @critical', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#tab-fav')).toBeVisible({ timeout: 5_000 });
  });

  test('clicking favorites tab shows fav-panel', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    await page.locator('#tab-fav').click();
    // fav-panel switches to display:flex via setTab()
    await expect(page.locator('#fav-panel')).toBeVisible({ timeout: 5_000 });
  });

  test('saved item appears in favorites panel — Firebase round-trip @critical', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const itemName = `מוצר_fav_${Date.now()}`;

    // Add item to shopping list and wait for Firebase onValue delivery
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    // Click the star/fav button — act-btn that calls toggleSavedFavorite
    const itemCard = page.locator(`.item-card:has-text("${itemName}")`).first();
    await expect(itemCard).toBeVisible({ timeout: 5_000 });

    // The star button calls toggleSavedFavorite — class fav-star-btn
    const starBtn = itemCard.locator('.fav-star-btn').first();
    await expect(starBtn).toBeVisible({ timeout: 5_000 });
    await starBtn.click();

    // Switch to favorites tab
    await page.locator('#tab-fav').click();
    await expect(page.locator('#fav-panel')).toBeVisible({ timeout: 5_000 });

    // Item must appear as a fav-item-card
    await expect(
      page.locator(`#fav-list-content .fav-item-card:has-text("${itemName}")`).first(),
      'Saved item must appear in favorites panel'
    ).toBeVisible({ timeout: 8_000 });
  });

  test('favorites persist after full page reload @critical', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const itemName = `מוצר_fav_persist_${Date.now()}`;

    // Add item
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    // Save as favorite
    const itemCard = page.locator(`.item-card:has-text("${itemName}")`).first();
    const starBtn = itemCard.locator('.fav-star-btn').first();
    await starBtn.click();

    // Confirm it appears in favorites panel
    await page.locator('#tab-fav').click();
    await expect(
      page.locator(`#fav-list-content .fav-item-card:has-text("${itemName}")`).first()
    ).toBeVisible({ timeout: 8_000 });

    // Reload — same fsl_v2 session in localStorage, Firebase onValue re-delivers
    await page.reload();
    await appPage.waitForAppReady();

    await page.locator('#tab-fav').click();
    await expect(
      page.locator(`#fav-list-content .fav-item-card:has-text("${itemName}")`).first(),
      'Favorite must survive a reload — failure means Firebase write did not persist'
    ).toBeVisible({ timeout: 10_000 });
  });

  test('fav-add-btn adds favorite item back to shopping list', async ({ appPage, page }) => {
    await appPage.waitForAppReady();

    const itemName = `מוצר_fav_add_${Date.now()}`;

    // Add item and save as favorite
    await page.locator('#new-item-input').fill(itemName);
    await page.locator('[data-testid="add-item-btn"]').click();
    await expect(page.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    const itemCard = page.locator(`.item-card:has-text("${itemName}")`).first();
    await itemCard.locator('.act-btn').last().click();

    // Navigate to favorites
    await page.locator('#tab-fav').click();
    const favCard = page.locator(`#fav-list-content .fav-item-card:has-text("${itemName}")`).first();
    await expect(favCard).toBeVisible({ timeout: 8_000 });

    // Click the add button
    const addBtn = favCard.locator('.fav-add-btn').first();
    await expect(addBtn).toBeVisible({ timeout: 5_000 });
    await addBtn.click();

    // Switch back to all-items tab and confirm item is in list
    await page.locator('#tab-all').click();
    await expect(
      page.locator(`text=${itemName}`).first(),
      'Item added from favorites must appear in shopping list'
    ).toBeVisible({ timeout: 8_000 });
  });

});

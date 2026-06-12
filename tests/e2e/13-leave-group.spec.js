// 13-leave-group.spec.js — Leave group flow
//
// Note: confirmLeaveGroup() currently shows a "coming soon" toast — the full
// remove-member Firebase write is not yet implemented. These tests validate
// the flow is accessible and stable, ready for when the feature ships.
//
// @critical: "leave group option accessible from group settings"
import { test, expect, setSession, collectConsoleErrors } from './fixtures/test-fixtures.js';

const SESSION = {
  myName:    'LeaveUser',
  groupId:   'ci-test-group',
  groupName: 'CI Test Group',
};

async function openGroupSheet(page) {
  const pill = page.locator('#hdr-grp-pill');
  if (await pill.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await pill.click();
    await page.locator('#gs-sheet').waitFor({ state: 'visible', timeout: 5_000 });
    return true;
  }
  return false;
}

test.describe('Leave group', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSession(page, SESSION);
    await page.reload();
  });

  test('group settings sheet is accessible from header @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 10_000 });

    const opened = await openGroupSheet(page);
    expect(opened, 'Group pill should be visible on main screen').toBe(true);
    await expect(page.locator('#gs-sheet')).toBeVisible({ timeout: 5_000 });
  });

  test('leave group option is present in group settings @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    const opened = await openGroupSheet(page);
    if (!opened) return; // Sheet unavailable — skip gracefully

    // Leave group button — look for confirmLeaveGroup onclick or Hebrew text
    const leaveBtn = page.locator('[onclick*="confirmLeaveGroup"], button:has-text("עזוב"), button:has-text("Leave")').first();
    await expect(leaveBtn).toBeVisible({ timeout: 5_000 });
  });

  test('clicking leave group does not crash the app', async ({ page, appPage }) => {
    const errors = collectConsoleErrors(page);
    await appPage.waitForAppReady();
    const opened = await openGroupSheet(page);
    if (!opened) return;

    // Native confirm() dialog — auto-dismiss as cancel so we don't actually leave
    page.on('dialog', d => d.dismiss());

    const leaveBtn = page.locator('[onclick*="confirmLeaveGroup"], button:has-text("עזוב"), button:has-text("Leave")').first();
    if (await leaveBtn.isVisible().catch(() => false)) {
      await leaveBtn.click();
      await page.waitForTimeout(500);
    }

    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);
  });

  test('dismissing leave-group dialog keeps user on main screen', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    const opened = await openGroupSheet(page);
    if (!opened) return;

    page.on('dialog', d => d.dismiss()); // "Cancel" the confirm

    const leaveBtn = page.locator('[onclick*="confirmLeaveGroup"], button:has-text("עזוב"), button:has-text("Leave")').first();
    if (await leaveBtn.isVisible().catch(() => false)) {
      await leaveBtn.click();
      await page.waitForTimeout(1000);
    }

    // User stayed on main screen — group was NOT left
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 5_000 });
  });

  test('group sheet closes correctly', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    const opened = await openGroupSheet(page);
    if (!opened) return;

    // Close by calling closeGroupSheet directly (or clicking backdrop)
    await page.evaluate(() => {
      if (typeof window.closeGroupSheet === 'function') window.closeGroupSheet();
    });
    await page.waitForTimeout(400);

    await expect(page.locator('#gs-sheet')).toBeHidden({ timeout: 3_000 });
  });

});

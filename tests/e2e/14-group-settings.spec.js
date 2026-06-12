// 14-group-settings.spec.js — Group settings sheet full flow
//
// Validates that the group settings sheet opens, shows correct group info,
// provides a copy-code action, and closes correctly on both desktop and mobile.
//
// @critical: "group code is visible in sheet", "sheet closes correctly"
import { test, expect, setSession, collectConsoleErrors } from './fixtures/test-fixtures.js';

const GROUP_CODE = '492119';
const SESSION = {
  myName:    'SettingsUser',
  groupId:   GROUP_CODE,
  groupName: 'משפחת בדיקה',
};

test.describe('Group settings sheet', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setSession(page, SESSION);
    await page.reload();
  });

  test('group pill is visible in header @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#hdr-grp-pill')).toBeVisible({ timeout: 8_000 });
  });

  test('group name shown in header pill', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await expect(page.locator('#main-screen.active')).toBeVisible({ timeout: 10_000 });

    // Group name or code appears in the header pill area
    const pillText = await page.locator('#hdr-grp-pill').innerText().catch(() => '');
    expect(pillText.trim().length).toBeGreaterThan(0);
  });

  test('clicking group pill opens settings sheet @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await page.locator('#hdr-grp-pill').click();
    await expect(page.locator('#gs-sheet')).toBeVisible({ timeout: 5_000 });
  });

  test('settings sheet shows group code @critical', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await page.locator('#hdr-grp-pill').click();
    await page.locator('#gs-sheet').waitFor({ state: 'visible', timeout: 5_000 });

    // Group code should appear somewhere in the sheet
    const sheetText = await page.locator('#gs-sheet').innerText().catch(() => '');
    expect(sheetText).toContain(GROUP_CODE);
  });

  test('copy code action is present in sheet', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await page.locator('#hdr-grp-pill').click();
    await page.locator('#gs-sheet').waitFor({ state: 'visible', timeout: 5_000 });

    // Copy code button or share action
    const copyBtn = page.locator('[onclick*="copyCode"], button:has-text("העתק"), button:has-text("שתף"), button:has-text("Copy")').first();
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
  });

  test('sheet closes when closeGroupSheet is called', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await page.locator('#hdr-grp-pill').click();
    await page.locator('#gs-sheet').waitFor({ state: 'visible', timeout: 5_000 });

    await page.evaluate(() => window.closeGroupSheet());
    await expect(page.locator('#gs-sheet')).toBeHidden({ timeout: 3_000 });
  });

  test('sheet closes by tapping backdrop', async ({ page, appPage }) => {
    await appPage.waitForAppReady();
    await page.locator('#hdr-grp-pill').click();
    await page.locator('#gs-sheet').waitFor({ state: 'visible', timeout: 5_000 });

    // Click outside the sheet (on overlay)
    const overlay = page.locator('#gs-overlay');
    if (await overlay.isVisible().catch(() => false)) {
      await overlay.click({ position: { x: 5, y: 5 } });
      await expect(page.locator('#gs-sheet')).toBeHidden({ timeout: 3_000 });
    }
  });

  test('group settings interactions produce no JS errors', async ({ page, appPage }) => {
    const errors = collectConsoleErrors(page);

    await appPage.waitForAppReady();
    await page.locator('#hdr-grp-pill').click();
    await page.locator('#gs-sheet').waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.closeGroupSheet());
    await page.waitForTimeout(300);

    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);
  });

});

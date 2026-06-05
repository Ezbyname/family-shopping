// 04-join-group.spec.js — Join group flow
// @critical: "clicking join tab shows code input"
import { test, expect, clearSession } from './fixtures/test-fixtures.js';

test.describe('Join group', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearSession(page);
    await page.reload();
  });

  test('join tab (#stab-join) is visible on setup screen @critical', async ({ appPage }) => {
    await appPage.goto();
    await appPage.waitForAppReady();
    await expect(appPage.page.locator('#stab-join')).toBeVisible({ timeout: 8_000 });
  });

  test('clicking join tab reveals jn-code input', async ({ appPage, page }) => {
    await appPage.goto();
    await appPage.waitForAppReady();

    await appPage.clickJoinTab();

    // Join pane (#spane-join) becomes active; jn-code input is inside it
    await expect(page.locator('#jn-code')).toBeVisible({ timeout: 5_000 });
  });

  test('jn-name and jn-code inputs accept text', async ({ appPage, page }) => {
    await appPage.goto();
    await appPage.waitForAppReady();
    await appPage.clickJoinTab();

    await page.locator('#jn-name').fill('TestMember');
    await page.locator('#jn-code').fill('123456');

    await expect(page.locator('#jn-name')).toHaveValue('TestMember');
    await expect(page.locator('#jn-code')).toHaveValue('123456');
  });

  test('invalid code does not crash the app', async ({ appPage, page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await appPage.goto();
    await appPage.waitForAppReady();
    await appPage.clickJoinTab();
    await appPage.fillJoinName('TestUser');
    await appPage.fillGroupCode('BADCODE');
    await appPage.submitJoinGroup();

    await page.waitForTimeout(3000);
    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);
  });

});

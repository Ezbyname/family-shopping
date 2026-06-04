// 03-returning-user.spec.js — Returning user / continue session flow
import { test, expect } from './fixtures/test-fixtures.js';

test.describe('Returning user login', () => {

  test('returning user sees main app, not setup screen', async ({ page, appPage }) => {
    // Simulate a returning user: pre-seed localStorage with a saved session
    await page.goto('/');
    await page.evaluate(() => {
      // Mirror the keys app.js reads on startup
      localStorage.setItem('myName',   'TestReturning');
      localStorage.setItem('groupId',  'test-group-001');
      localStorage.setItem('groupName','Test Family');
    });
    await page.reload();
    await appPage.waitForAppReady();

    // Either: main app is shown directly, OR the continue card is shown
    const mainApp    = page.locator('#main-app');
    const continueCard = page.locator('[class*="continue"], [id*="continue"], button:has-text("המשך")');

    const mainVisible     = await mainApp.isVisible().catch(() => false);
    const continueVisible = await continueCard.first().isVisible().catch(() => false);

    expect(mainVisible || continueVisible,
      'Returning user must see main app or continue card, not setup screen'
    ).toBe(true);

    const setupVisible = await page.locator('#setup-screen').isVisible().catch(() => false);
    expect(setupVisible, 'Setup screen must NOT be shown to returning user').toBe(false);
  });

  test('continue card shows correct user name', async ({ page, appPage }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('myName',  'AvivTest');
      localStorage.setItem('groupId', 'test-group-001');
    });
    await page.reload();
    await appPage.waitForAppReady();

    // If a continue card exists, it should mention the user's name
    const continueCard = page.locator('[class*="continue"], [id*="continue-card"]');
    if (await continueCard.count() > 0 && await continueCard.first().isVisible()) {
      const cardText = await continueCard.first().textContent();
      expect(cardText).toContain('AvivTest');
    }
    // If no continue card, we're already in main app — that's fine too
  });

  test('page reload does not reset to setup screen mid-session', async ({ page, appPage }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('myName',   'ReloadTest');
      localStorage.setItem('groupId',  'test-group-002');
      localStorage.setItem('groupName','Family B');
    });
    await page.reload();
    await appPage.waitForAppReady();

    // Reload again — should still be in app
    await page.reload();
    await appPage.waitForAppReady();

    const setupVisible = await page.locator('#setup-screen').isVisible().catch(() => false);
    expect(setupVisible, 'Setup screen appeared after reload for returning user').toBe(false);
  });

});

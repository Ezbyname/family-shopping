// test-fixtures.js — shared Playwright fixtures
import { test as base } from '@playwright/test';
import { AppPage } from '../pages/AppPage.js';

// Unique suffix per test run so tests don't stomp on each other in Firebase
const RUN_ID = Date.now().toString(36).slice(-4).toUpperCase();

export const test = base.extend({
  appPage: async ({ page }, use) => {
    const appPage = new AppPage(page);
    await use(appPage);
  },

  // Provides a fresh name unique to this test run
  testUserName: async ({}, use) => {
    await use(`TestUser_${RUN_ID}`);
  },

  // Clears localStorage + sessionStorage between tests to simulate new user
  freshPage: async ({ page }, use) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await use(page);
  },
});

export { expect } from '@playwright/test';

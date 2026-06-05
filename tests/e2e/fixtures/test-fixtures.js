// test-fixtures.js — shared Playwright fixtures and session helpers
import { test as base } from '@playwright/test';
import { AppPage } from '../pages/AppPage.js';

const RUN_ID = Date.now().toString(36).slice(-4).toUpperCase();

// Writes the exact localStorage contract the app reads on startup (fsl_v2).
// myId is a placeholder — the app overwrites it with the real Firebase UID on auth.
export async function setSession(page, { myName = 'TestUser', myId = 'test-uid', groupId = '', groupName = '' } = {}) {
  await page.evaluate(({ myName, myId, groupId, groupName }) => {
    localStorage.setItem('fsl_v2', JSON.stringify({ myName, myId, groupId, groupName }));
  }, { myName, myId, groupId, groupName });
}

export async function clearSession(page) {
  await page.evaluate(() => {
    localStorage.removeItem('fsl_v2');
    sessionStorage.clear();
  });
}

export const test = base.extend({
  appPage: async ({ page }, use) => { await use(new AppPage(page)); },
  testUserName: async ({}, use) => { await use(`TestUser_${RUN_ID}`); },
});

export { expect } from '@playwright/test';

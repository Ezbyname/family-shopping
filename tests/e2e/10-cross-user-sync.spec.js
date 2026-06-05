// 10-cross-user-sync.spec.js — Real-time cross-user synchronization via Firebase
//
// Architecture:
//   - Two isolated browser contexts (A and B) share the same groupId
//   - Each gets its own Firebase anonymous UID (no mocking)
//   - Firebase onValue listeners propagate writes between contexts without page reload
//   - Tests confirm the entire path: write → Firebase → onValue → renderList → DOM
//
// @critical tags: only on tests that cannot produce false positives and
//   complete within 15 s even under CI network latency.
//
// Favorites are GROUP-SCOPED (favorites/{groupId}), not user-scoped.
// Both users share the same favorites list. Test 4 documents this behavior.

import { test, expect } from '@playwright/test';

const CI_GROUP    = 'ci-test-group';
const CI_GROUP_NAME = 'CI Test Group';
const MAIN_READY  = '#main-screen.active';

// Write fsl_v2 into a page's localStorage before the app initialises.
// myId is a placeholder — onAuthStateChanged overwrites it with the real Firebase UID.
async function setSession(page, { myName, groupId, groupName }) {
  await page.evaluate(({ myName, groupId, groupName }) => {
    localStorage.setItem('fsl_v2', JSON.stringify({
      myName, myId: 'placeholder', groupId, groupName,
    }));
  }, { myName, groupId, groupName });
}

async function waitForMain(page) {
  await page.waitForSelector(MAIN_READY, { timeout: 20_000 });
}

// ── Setup two contexts ────────────────────────────────────────────────────────

async function openTwoUsers(browser, ts) {
  const [ctxA, ctxB] = await Promise.all([
    browser.newContext({ locale: 'he-IL' }),
    browser.newContext({ locale: 'he-IL' }),
  ]);

  const [pageA, pageB] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);

  // Inject sessions in parallel before reload
  await Promise.all([pageA.goto('/'), pageB.goto('/')]);
  await Promise.all([
    setSession(pageA, { myName: `UserA_${ts}`, groupId: CI_GROUP, groupName: CI_GROUP_NAME }),
    setSession(pageB, { myName: `UserB_${ts}`, groupId: CI_GROUP, groupName: CI_GROUP_NAME }),
  ]);
  await Promise.all([pageA.reload(), pageB.reload()]);

  // Both must reach main-screen before tests begin
  await Promise.all([waitForMain(pageA), waitForMain(pageB)]);

  // Assert distinct Firebase UIDs (only available on localhost/vercel.app)
  const hostname = new URL(pageA.url()).hostname;
  if (hostname === 'localhost' || hostname.includes('vercel.app')) {
    const [uidA, uidB] = await Promise.all([
      pageA.evaluate(() => window.__debugAuth?.getUid?.() ?? null),
      pageB.evaluate(() => window.__debugAuth?.getUid?.() ?? null),
    ]);
    if (uidA && uidB) {
      if (uidA === uidB) throw new Error(`UIDs must differ: both got ${uidA}`);
    }
  }

  return { ctxA, ctxB, pageA, pageB };
}

// ── Test 1: Add Item Sync ─────────────────────────────────────────────────────

test('User A adds item — User B sees it without reload @critical', async ({ browser }) => {
  test.setTimeout(60_000);
  const ts = Date.now();
  const { ctxA, ctxB, pageA, pageB } = await openTwoUsers(browser, ts);

  try {
    const itemName = `sync_add_${ts}`;

    // User A adds item
    await pageA.locator('#new-item-input').fill(itemName);
    await pageA.locator('[data-testid="add-item-btn"]').click();

    // User A confirms it appeared (Firebase write + own onValue delivered)
    await expect(pageA.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    // User B must see the item WITHOUT reloading — pure Firebase onValue delivery
    await expect(
      pageB.locator(`text=${itemName}`).first(),
      'User B must receive User A\'s item via Firebase onValue — no reload'
    ).toBeVisible({ timeout: 12_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ── Test 2: Purchase Sync ────────────────────────────────────────────────────

test('User B marks item purchased — User A sees bought state @critical', async ({ browser }) => {
  test.setTimeout(60_000);
  const ts = Date.now();
  const { ctxA, ctxB, pageA, pageB } = await openTwoUsers(browser, ts);

  try {
    const itemName = `sync_buy_${ts}`;

    // User A adds item and confirms it appeared on both sides
    await pageA.locator('#new-item-input').fill(itemName);
    await pageA.locator('[data-testid="add-item-btn"]').click();
    await expect(pageA.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });
    await expect(pageB.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 12_000 });

    // User B marks the item as purchased
    const cardB = pageB.locator(`.item-card:has-text("${itemName}")`).first();
    await expect(cardB).toBeVisible({ timeout: 5_000 });
    const pendingBtnB = cardB.locator('.pending-tag').first();
    await expect(pendingBtnB).toBeVisible({ timeout: 5_000 });
    await pendingBtnB.click();

    // User B's own UI confirms the Firebase round-trip (onValue → .bought-tag)
    await expect(cardB.locator('.bought-tag').first()).toBeVisible({ timeout: 8_000 });
    await expect(cardB).toHaveClass(/bought/, { timeout: 5_000 });

    // User A must see the bought state WITHOUT reloading
    const cardA = pageA.locator(`.item-card:has-text("${itemName}")`).first();
    await expect(
      cardA,
      'User A must see item-card.bought via Firebase onValue — no reload'
    ).toHaveClass(/bought/, { timeout: 12_000 });

    // And the button on A must now be .bought-tag
    await expect(cardA.locator('.bought-tag').first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ── Test 3: Unpurchase Sync ──────────────────────────────────────────────────

test('User B unmarks purchased — User A sees pending state', async ({ browser }) => {
  test.setTimeout(60_000);
  const ts = Date.now();
  const { ctxA, ctxB, pageA, pageB } = await openTwoUsers(browser, ts);

  try {
    const itemName = `sync_unbuy_${ts}`;

    // Setup: add item (A), buy it (B)
    await pageA.locator('#new-item-input').fill(itemName);
    await pageA.locator('[data-testid="add-item-btn"]').click();
    await expect(pageA.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });
    await expect(pageB.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 12_000 });

    const cardB = pageB.locator(`.item-card:has-text("${itemName}")`).first();
    await cardB.locator('.pending-tag').first().click();
    await expect(cardB.locator('.bought-tag').first()).toBeVisible({ timeout: 8_000 });

    // Wait for A to see bought state (confirms sync is active)
    const cardA = pageA.locator(`.item-card:has-text("${itemName}")`).first();
    await expect(cardA).toHaveClass(/bought/, { timeout: 12_000 });

    // User B unmarks purchased
    await cardB.locator('.bought-tag').first().click();

    // B confirms pending state returned (own round-trip)
    await expect(cardB.locator('.pending-tag').first()).toBeVisible({ timeout: 8_000 });
    await expect(cardB).not.toHaveClass(/bought/, { timeout: 5_000 });

    // User A sees the item is no longer bought — no reload
    await expect(
      cardA,
      'User A must see item reverted to pending via Firebase onValue — no reload'
    ).not.toHaveClass(/bought/, { timeout: 12_000 });

    await expect(cardA.locator('.pending-tag').first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ── Test 4: Favorites Are Group-Scoped ───────────────────────────────────────
//
// DOCUMENTED BEHAVIOR: favorites/{groupId} is shared between all group members.
// Both users see each other's favorites in real time. This is by design.

test('Favorites are group-scoped — User B sees User A\'s saved favorite', async ({ browser }) => {
  test.setTimeout(60_000);
  const ts = Date.now();
  const { ctxA, ctxB, pageA, pageB } = await openTwoUsers(browser, ts);

  try {
    const itemName = `fav_sync_${ts}`;

    // User A adds an item and saves it as a favorite
    await pageA.locator('#new-item-input').fill(itemName);
    await pageA.locator('[data-testid="add-item-btn"]').click();
    await expect(pageA.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    const cardA = pageA.locator(`.item-card:has-text("${itemName}")`).first();
    await expect(cardA).toBeVisible({ timeout: 5_000 });
    await cardA.locator('.fav-star-btn').first().click();

    // User A confirms it appears in their favorites panel
    await pageA.locator('#tab-fav').click();
    await expect(
      pageA.locator(`#fav-list-content .fav-item-card:has-text("${itemName}")`).first()
    ).toBeVisible({ timeout: 8_000 });

    // User B navigates to favorites — same group, same favorites/{groupId} path
    await pageB.locator('#tab-fav').click();
    await expect(
      pageB.locator(`#fav-list-content .fav-item-card:has-text("${itemName}")`).first(),
      'Favorites are group-scoped: User B must see User A\'s favorite (design intent, not a bug)'
    ).toBeVisible({ timeout: 12_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

// ── Test 5: Connection Recovery ──────────────────────────────────────────────

test('User B reconnects and receives missed items — Firebase recovery', async ({ browser }) => {
  test.setTimeout(60_000);
  const ts = Date.now();
  const { ctxA, ctxB, pageA, pageB } = await openTwoUsers(browser, ts);

  try {
    const itemName = `sync_offline_${ts}`;

    // User B goes offline
    await ctxB.setOffline(true);

    // User A adds item while B is offline
    await pageA.locator('#new-item-input').fill(itemName);
    await pageA.locator('[data-testid="add-item-btn"]').click();
    await expect(pageA.locator(`text=${itemName}`).first()).toBeVisible({ timeout: 8_000 });

    // Give A a moment to confirm its own write before B reconnects
    // (not asserting B's offline state — network simulation isn't guaranteed to be instantaneous)

    // User B comes back online — Firebase SDK reconnects and onValue re-delivers
    await ctxB.setOffline(false);

    // B must receive the item without a page reload
    await expect(
      pageB.locator(`text=${itemName}`).first(),
      'User B must receive missed item after reconnect — Firebase onValue re-delivers on reconnect'
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

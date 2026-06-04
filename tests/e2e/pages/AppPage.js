// AppPage.js — base page object for the Family Shopping PWA
// All selectors are resilience-first: prefer data-testid, then ARIA, then text

export class AppPage {
  constructor(page) {
    this.page = page;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async goto() {
    await this.page.goto('/');
    // Wait for Firebase auth to initialize (anonymous sign-in)
    await this.page.waitForFunction(
      () => !document.querySelector('#splash-screen') ||
            document.querySelector('#splash-screen').style.display === 'none',
      { timeout: 15_000 }
    );
  }

  async waitForAppReady() {
    // App is ready when setup-screen or main-app is visible
    await this.page.waitForSelector(
      '#setup-screen:not([style*="display: none"]), #main-app:not([style*="display: none"])',
      { timeout: 15_000 }
    );
  }

  // ── Setup screen helpers ──────────────────────────────────────────────────

  isOnSetupScreen() {
    return this.page.locator('#setup-screen').isVisible();
  }

  isOnMainApp() {
    return this.page.locator('#main-app').isVisible();
  }

  async fillName(name) {
    const input = this.page.locator('#setup-name, input[placeholder*="שם"], input[type="text"]').first();
    await input.fill(name);
  }

  async clickCreateGroup() {
    await this.page.locator('#btn-create-group, button:has-text("צור קבוצה"), button:has-text("Create")').first().click();
  }

  async clickJoinGroup() {
    await this.page.locator('#btn-join-group, button:has-text("הצטרף"), button:has-text("Join")').first().click();
  }

  async fillGroupCode(code) {
    const input = this.page.locator('#join-code-input, input[placeholder*="קוד"], input[placeholder*="code"]').first();
    await input.fill(code);
  }

  async confirmJoin() {
    await this.page.locator('button:has-text("אישור"), button:has-text("Confirm"), button:has-text("הצטרף")').last().click();
  }

  // ── Main app helpers ──────────────────────────────────────────────────────

  async addShoppingItem(itemName) {
    const input = this.page.locator(
      '#new-item-input, input[placeholder*="פריט"], input[placeholder*="item"], input[placeholder*="הוסף"]'
    ).first();
    await input.fill(itemName);
    const addBtn = this.page.locator(
      'button:has-text("הוסף"), button:has-text("Add"), #btn-add-item'
    ).first();
    await addBtn.click();
  }

  async markItemPurchased(itemName) {
    // Find the checkbox or bought button next to the item
    const row = this.page.locator(`text=${itemName}`).first();
    const checkbox = row.locator('.. input[type="checkbox"], .. button[class*="check"], .. button[class*="bought"]').first();
    if (await checkbox.count() > 0) {
      await checkbox.click();
    } else {
      // Fallback: tap the item row itself (some UIs use click-to-toggle)
      await row.click();
    }
  }

  async getGroupCode() {
    // The group code is usually shown in settings or share dialog
    const settingsTab = this.page.locator('button:has-text("הגדרות"), button:has-text("Settings"), [data-tab="settings"]').first();
    if (await settingsTab.count() > 0) await settingsTab.click();
    const codeEl = this.page.locator('[class*="group-code"], [class*="invite-code"], text=/[A-Z0-9]{4,8}/').first();
    return codeEl.textContent();
  }

  // ── Assertion helpers ─────────────────────────────────────────────────────

  async expectItemInList(itemName) {
    await this.page.locator(`text=${itemName}`).first().waitFor({ state: 'visible', timeout: 8_000 });
  }

  async expectNoErrorBanner() {
    const errorBanner = this.page.locator('[class*="error"], [class*="alert-danger"], text=/שגיאה|Error/i');
    const count = await errorBanner.count();
    if (count > 0) {
      const text = await errorBanner.first().textContent();
      throw new Error(`Unexpected error banner: "${text}"`);
    }
  }
}

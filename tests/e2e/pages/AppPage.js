// AppPage.js — Page Object for Family Shopping PWA
// All selectors verified against index.html DOM on 2026-06-04.

export class AppPage {
  constructor(page) {
    this.page = page;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  async goto() {
    await this.page.goto('/');
    // Wait for splash overlay to disappear (CSS fade-out + display:none)
    await this.page.waitForSelector('#splash-overlay', { state: 'hidden', timeout: 10_000 });
  }

  async waitForAppReady() {
    // Screens are shown via .screen.active (CSS class, not inline style)
    await this.page.waitForSelector(
      '#setup-screen.active, #main-screen.active, #profile-screen.active',
      { timeout: 15_000 }
    );
  }

  // ── Setup screen helpers ──────────────────────────────────────────────────

  async isOnSetupScreen() {
    return this.page.locator('#setup-screen.active').isVisible();
  }

  async isOnMainScreen() {
    return this.page.locator('#main-screen.active').isVisible();
  }

  // Fill name on the CREATE tab (input id="cn-name")
  async fillCreateName(name) {
    await this.page.locator('#cn-name').fill(name);
  }

  // Fill name on the JOIN tab (input id="jn-name")
  async fillJoinName(name) {
    await this.page.locator('#jn-name').fill(name);
  }

  // Click the "Create group" setup tab (#stab-create)
  async clickCreateTab() {
    await this.page.locator('#stab-create').click();
  }

  // Click the "Join group" setup tab (#stab-join)
  async clickJoinTab() {
    await this.page.locator('#stab-join').click();
  }

  // Submit the create-group form
  async submitCreateGroup() {
    await this.page.locator('button[onclick="createGroup()"]').click();
  }

  // Fill the join-code input (input id="jn-code")
  async fillGroupCode(code) {
    await this.page.locator('#jn-code').fill(code);
  }

  // Submit the join-group form
  async submitJoinGroup() {
    await this.page.locator('button[onclick="joinGroup()"]').click();
  }

  // ── Shopping list helpers ─────────────────────────────────────────────────

  async addShoppingItem(itemName) {
    await this.page.locator('#new-item-input').fill(itemName);
    await this.page.locator('[data-testid="add-item-btn"]').click();
  }

  async expectItemInList(itemName) {
    await this.page.locator(`text=${itemName}`).first().waitFor({ state: 'visible', timeout: 8_000 });
  }

  // ── Assertion helpers ─────────────────────────────────────────────────────

  async expectNoErrorBanner() {
    const banner = this.page.locator('[class*="error-banner"], [class*="alert-danger"]');
    if (await banner.count() > 0 && await banner.first().isVisible()) {
      throw new Error(`Unexpected error banner: "${await banner.first().textContent()}"`);
    }
  }
}

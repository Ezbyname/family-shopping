// 16-green-button-contrast.spec.js
// Regression suite: every green CTA button must render white (#fff) foreground text/icons.
// Tests computed color via getComputedStyle — catches both CSS class and inline-style regressions.
import { test, expect, setSession, stubFirebase } from './fixtures/test-fixtures.js';

const SESSION = {
  myName:    'ContrastTester',
  groupId:   'ci-test-group',
  groupName: 'CI Test Group',
};

/** Returns the computed color of the first element matching `selector` as an rgb(...) string. */
async function computedColor(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return window.getComputedStyle(el).color;
  }, selector);
}

/** rgb(r,g,b) → { r, g, b } */
function parseRgb(str) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(str);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3] };
}

/** True when the color is white or near-white (each channel ≥ 240). */
function isWhite(rgb) {
  return rgb && rgb.r >= 240 && rgb.g >= 240 && rgb.b >= 240;
}

test.describe('Green button contrast — white foreground text', () => {

  test.beforeEach(async ({ page }) => {
    await stubFirebase(page);
    await page.goto('/');
    await setSession(page, SESSION);
    await page.reload();
  });

  // ── Add button (+) ──────────────────────────────────────────────────────────
  test('add-item button (+) has white text', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    const color = await computedColor(page, '.add-btn');
    expect(color, 'add-btn color').not.toBeNull();
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── "קניתי" Buy button ──────────────────────────────────────────────────────
  test('"קניתי" pending-tag button has white text', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    // Inject a pending-tag into the DOM so we can measure its style without needing
    // a live Firebase item (style is determined purely by the CSS class).
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'pending-tag';
      btn.textContent = 'קניתי';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Price Search / Compare Prices button ────────────────────────────────────
  test('price-search-btn has white text', async ({ appPage, page }) => {
    await appPage.waitForAppReady();
    // Navigate to price tab to render the search bar
    const priceTab = page.locator('.tab').filter({ hasText: /מחיר|מחירים|חיפוש/ }).first();
    if (await priceTab.isVisible()) await priceTab.click();

    const color = await computedColor(page, '.price-search-btn');
    if (color === null) {
      // Fallback: measure via injected element
      const fallback = await page.evaluate(() => {
        const btn = document.createElement('button');
        btn.className = 'price-search-btn';
        btn.textContent = 'חפש';
        document.body.appendChild(btn);
        const c = window.getComputedStyle(btn).color;
        btn.remove();
        return c;
      });
      expect(isWhite(parseRgb(fallback)), `expected white, got ${fallback}`).toBe(true);
      return;
    }
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Save button (.mp2-save-btn) ─────────────────────────────────────────────
  test('mp2-save-btn (Save) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'mp2-save-btn';
      btn.textContent = 'שמור';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Primary modal button (.mbtn.primary) — used for Join Group ─────────────
  test('mbtn.primary (Join Group / primary modal action) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'mbtn primary';
      btn.textContent = 'הצטרף';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Setup primary action button (.btn-p) ────────────────────────────────────
  test('btn-p (setup primary) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'btn-p';
      btn.textContent = 'המשך';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Filter apply button (.fd-apply) ────────────────────────────────────────
  test('fd-apply (filter apply) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'fd-apply';
      btn.textContent = 'החל';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Store details nav button (.sd-nav-btn) ──────────────────────────────────
  test('sd-nav-btn (store navigation) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'sd-nav-btn';
      btn.textContent = 'נווט';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Basket compare hero button (.bc-hero-btn) ───────────────────────────────
  test('bc-hero-btn (basket compare CTA) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'bc-hero-btn';
      btn.textContent = 'השווה';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Basket compare primary action (.bc-action-btn.primary) ─────────────────
  test('bc-action-btn.primary has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'bc-action-btn primary';
      btn.textContent = 'פעולה';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Add-all favorites button (.add-all-btn) ─────────────────────────────────
  test('add-all-btn (add all favorites) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'add-all-btn';
      btn.textContent = 'הוסף הכל';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── Nearby no-results primary (.nnr-btn.primary) ────────────────────────────
  test('nnr-btn.primary has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'nnr-btn primary';
      btn.textContent = 'שנה מיקום';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── bp-add-btn (brand picker add) ───────────────────────────────────────────
  test('bp-add-btn (brand picker add) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'bp-add-btn';
      btn.textContent = 'הוסף';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── fav-add-btn (favorite add) ───────────────────────────────────────────────
  test('fav-add-btn (favorite add) has white text', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'fav-add-btn';
      btn.textContent = '+';
      document.body.appendChild(btn);
      const c = window.getComputedStyle(btn).color;
      btn.remove();
      return c;
    });
    expect(isWhite(parseRgb(color)), `expected white, got ${color}`).toBe(true);
  });

  // ── No dark color (#111 or #000) remains on any .btn-p, .add-btn, .mbtn.primary ──
  test('CSS custom property --accent does not produce #111 text on primary buttons', async ({ page }) => {
    const results = await page.evaluate(() => {
      const selectors = [
        '.btn-p', '.add-btn', '.bp-add-btn', '.pending-tag',
        '.price-search-btn', '.fd-apply', '.mbtn.primary',
        '.nnr-btn.primary', '.add-all-btn', '.fav-add-btn',
        '.mp2-save-btn', '.sd-nav-btn', '.bc-hero-btn',
        '.bc-action-btn.primary',
      ];
      return selectors.map(sel => {
        const btn = document.createElement('button');
        btn.className = sel.replace(/^\./,'').replace(/\./,' ');
        document.body.appendChild(btn);
        const color = window.getComputedStyle(btn).color;
        btn.remove();
        return { sel, color };
      });
    });

    for (const { sel, color } of results) {
      const rgb = parseRgb(color);
      const dark = rgb && (rgb.r < 50 && rgb.g < 50 && rgb.b < 50);
      expect(dark, `${sel} has dark text: ${color}`).toBe(false);
    }

    function parseRgb(str) {
      const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(str);
      if (!m) return null;
      return { r: +m[1], g: +m[2], b: +m[3] };
    }
  });
});

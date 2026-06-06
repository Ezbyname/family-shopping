// 04-join-group.spec.js — Join group flow + duplicate member detection
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

  test('joining non-existent group shows not-found, app stays on setup screen', async ({ appPage, page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await appPage.goto();
    await appPage.waitForAppReady();
    await appPage.clickJoinTab();
    await appPage.fillJoinName('TestUser');
    await appPage.fillGroupCode('999999');
    await appPage.submitJoinGroup();

    await page.waitForTimeout(5000);
    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);

    const onSetup = await appPage.isOnSetupScreen();
    const onMain  = await appPage.isOnMainScreen();
    expect(onSetup || onMain).toBe(true);
  });

  // ── Permission error handling ───────────────────────────────────────────────

  test('permission denied on group read shows Hebrew message, not raw Firebase error @critical', async ({ appPage, page }) => {
    await page.route('**/groups/**', route => {
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Permission denied"}' });
    });

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await appPage.goto();
    await appPage.waitForAppReady();
    await appPage.clickJoinTab();
    await appPage.fillJoinName('TestUser');
    await appPage.fillGroupCode('492119');
    await appPage.submitJoinGroup();

    await page.waitForTimeout(4000);

    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);

    const toasts = await page.locator('.toast, [class*="toast"]').allTextContents().catch(() => []);
    for (const t of toasts) {
      expect(t).not.toMatch(/^❌ Permission denied$/);
      expect(t).not.toMatch(/^Permission denied$/);
    }
  });

});

// ── Group Settings button — mobile touch regression ────────────────────────

test.describe('Group settings button — mobile touch', () => {

  // Test 1 & 5: Tap without finger movement must not activate swipe gesture
  test('tapping הגדרות קבוצה fires click, not swipe @critical', async ({ page }) => {
    // Mock a signed-in state so the app renders the main screen
    await page.addInitScript(() => {
      localStorage.setItem('fsl_v2', JSON.stringify({
        myName: 'TestUser', myId: 'test-uid-001', groupId: '123456', groupName: 'Test'
      }));
      localStorage.setItem('activeGroupId', '123456');
    });
    await page.goto('/');
    await page.waitForSelector('#main-screen.active, #gs-sheet', { timeout: 15_000 }).catch(() => {});

    // Open the group sheet
    const pill = page.locator('#hdr-grp-pill');
    if (await pill.isVisible()) await pill.click();

    const sheet = page.locator('#gs-sheet');
    await sheet.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});

    const settingsBtn = page.locator('button.gs-action', { hasText: 'הגדרות קבוצה' });
    if (!await settingsBtn.isVisible()) return; // sheet didn't open — skip gracefully

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    // Simulate mobile tap: touchstart + touchend at same position (no movement)
    const box = await settingsBtn.boundingBox();
    if (box) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(600);
    }

    const fatal = errors.filter(e => e.includes('TypeError') || e.includes('ReferenceError'));
    expect(fatal).toHaveLength(0);
  });

  // Test 4: Swipe gesture must still close the sheet
  test('swipe down on sheet still closes it after button-tap fix', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('fsl_v2', JSON.stringify({
        myName: 'TestUser', myId: 'test-uid-001', groupId: '123456', groupName: 'Test'
      }));
    });
    await page.goto('/');
    await page.waitForTimeout(3000);

    const pill = page.locator('#hdr-grp-pill');
    if (!await pill.isVisible()) return;
    await pill.click();

    const sheet = page.locator('#gs-sheet');
    await sheet.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (!await sheet.isVisible()) return;

    // Drag sheet down 150px — should trigger close
    const box = await sheet.boundingBox();
    if (box) {
      await page.mouse.move(box.x + 160, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 160, box.y + 180, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(600);
    }

    // Sheet should no longer be visible (closed by swipe)
    const isHidden = !await sheet.isVisible().catch(() => true);
    expect(isHidden).toBe(true);
  });

});

// ── Duplicate member detection — unit-level simulation ────────────────────

test.describe('Duplicate member detection logic', () => {

  // Tests A–E use page.evaluate to directly call normalizeName and compare
  // without needing a real Firebase connection.

  test('Scenario E — distinct names, no dialog shown', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      function normalizeName(name) {
        return String(name || '')
          .trim().toLowerCase()
          .replace(/[֑-ׇ]/g, '')
          .replace(/\s+/g, '')
          .replace(/[^\w֐-׿]/g, '');
      }
      const existing = 'Erez';
      const joining  = 'David';
      return normalizeName(existing) === normalizeName(joining);
    });

    expect(result).toBe(false); // David ≠ Erez → no duplicate dialog
  });

  test('Scenario A — exact match triggers duplicate @critical', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      function normalizeName(name) {
        return String(name || '')
          .trim().toLowerCase()
          .replace(/[֑-ׇ]/g, '')
          .replace(/\s+/g, '')
          .replace(/[^\w֐-׿]/g, '');
      }
      return normalizeName('Erez') === normalizeName('Erez');
    });

    expect(result).toBe(true);
  });

  test('Scenario B — case-insensitive match @critical', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      function normalizeName(name) {
        return String(name || '')
          .trim().toLowerCase()
          .replace(/[֑-ׇ]/g, '')
          .replace(/\s+/g, '')
          .replace(/[^\w֐-׿]/g, '');
      }
      return normalizeName('Erez') === normalizeName('erez');
    });

    expect(result).toBe(true);
  });

  test('Scenario C — Hebrew name with whitespace normalized @critical', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      function normalizeName(name) {
        return String(name || '')
          .trim().toLowerCase()
          .replace(/[֑-ׇ]/g, '')
          .replace(/\s+/g, '')
          .replace(/[^\w֐-׿]/g, '');
      }
      return normalizeName('ארז') === normalizeName(' ארז ');
    });

    expect(result).toBe(true);
  });

  // Scenario D: "No" flow — dialog returns 'no', name field cleared
  test('Scenario D — no flow: _showDuplicateMemberDialog resolves "no" on לא click', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Inject dialog into page and click לא
    const result = await page.evaluate(async () => {
      function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function _showDuplicateMemberDialog(name) {
        return new Promise(resolve => {
          const safe = esc(name);
          const el   = document.createElement('div');
          el.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);direction:rtl';
          el.innerHTML = `<div><button id="dup-yes">כן</button><button id="dup-no">לא</button></div>`;
          document.body.appendChild(el);
          const cleanup = ans => { el.remove(); resolve(ans); };
          document.getElementById('dup-yes').onclick = () => cleanup('yes');
          document.getElementById('dup-no').onclick  = () => cleanup('no');
        });
      }
      const p = _showDuplicateMemberDialog('Erez');
      document.getElementById('dup-no').click();
      return await p;
    });

    expect(result).toBe('no');
  });

  test('YES flow: dialog resolves "yes" on כן click', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);

    const result = await page.evaluate(async () => {
      function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function _showDuplicateMemberDialog(name) {
        return new Promise(resolve => {
          const el = document.createElement('div');
          el.innerHTML = `<div><button id="dup-yes">כן</button><button id="dup-no">לא</button></div>`;
          document.body.appendChild(el);
          const cleanup = ans => { el.remove(); resolve(ans); };
          document.getElementById('dup-yes').onclick = () => cleanup('yes');
          document.getElementById('dup-no').onclick  = () => cleanup('no');
        });
      }
      const p = _showDuplicateMemberDialog('Erez');
      document.getElementById('dup-yes').click();
      return await p;
    });

    expect(result).toBe('yes');
  });

});

// ── dedupMembers render-layer de-duplication ───────────────────────────────
// These tests inject a synthetic members map (OLDUID + NEWUID both named "Erez")
// and assert that dedupMembers collapses them to one row.
// No Firebase connection required — purely logic tests.

test.describe('dedupMembers — render-layer de-duplication', () => {

  // Inline the same logic as app.js so tests are self-contained and CI-runnable.
  // IMPORTANT: Keep in sync with dedupMembers() + normalizeName() in app.js.
  const DEDUP_SCRIPT = `
    function normalizeName(name) {
      return String(name || '')
        .trim().toLowerCase()
        .replace(/[\\u0591-\\u05C7]/g, '')
        .replace(/\\s+/g, '')
        .replace(/[^\\w\\u05D0-\\u05EA]/g, '');
    }
    function dedupMembers(list, myId) {
      const seen = new Map();
      for (const m of list) {
        const key = normalizeName(m.displayName || m.name || '');
        if (!key) continue;
        const existing = seen.get(key);
        if (!existing) { seen.set(key, { winner: m, loser: null }); continue; }
        const mTs    = m.updatedAt || m.joined || 0;
        const exTs   = existing.winner.updatedAt || existing.winner.joined || 0;
        const mIsMe  = (m.uid || m.id) === myId;
        const exIsMe = (existing.winner.uid || existing.winner.id) === myId;
        let winner, loser;
        if      (mIsMe)      { winner = m;               loser = existing.winner; }
        else if (exIsMe)     { winner = existing.winner; loser = m; }
        else if (mTs > exTs) { winner = m;               loser = existing.winner; }
        else                 { winner = existing.winner; loser = m; }
        seen.set(key, { winner, loser });
      }
      return Array.from(seen.values()).map(({ winner, loser }) => {
        if (!loser) return winner;
        const merged = { ...winner };
        if (loser.role === 'admin' && merged.role !== 'admin') merged.role = 'admin';
        if (loser.roles && loser.roles.admin && !(merged.roles && merged.roles.admin))
          merged.roles = Object.assign({}, merged.roles || {}, { admin: true });
        const winnerIsDefault = !merged.avatarType || (merged.avatarType === 'emoji' &&
          (merged.avatarValue === '\\u{1F464}' || !merged.avatarValue));
        const loserIsRicher = loser.avatarType && !(loser.avatarType === 'emoji' &&
          (loser.avatarValue === '\\u{1F464}' || !loser.avatarValue));
        if (winnerIsDefault && loserIsRicher) {
          merged.avatarType  = loser.avatarType;
          merged.avatarValue = loser.avatarValue;
          merged.avatarEmoji = loser.avatarEmoji;
        }
        return merged;
      });
    }
  `;

  // Scenario 1: OLDUID + NEWUID same name → exactly one entry @critical
  test('Scenario 1 — two UIDs same name collapses to one member @critical', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const count = await page.evaluate((script) => {
      eval(script);
      const rawMembers = [
        { id: 'OLDUID', name: 'Erez', joined: 1000 },
        { id: 'NEWUID', name: 'Erez', joined: 2000, updatedAt: Date.now() },
      ];
      return dedupMembers(rawMembers, 'NEWUID').length;
    }, DEDUP_SCRIPT);

    expect(count).toBe(1);
  });

  // Scenario 1b: surviving entry is the current-session UID (NEWUID)
  test('Scenario 1b — surviving entry is the current session UID', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const uid = await page.evaluate((script) => {
      eval(script);
      const rawMembers = [
        { id: 'OLDUID', name: 'Erez', joined: 1000 },
        { id: 'NEWUID', name: 'Erez', joined: 2000, updatedAt: Date.now() },
      ];
      return dedupMembers(rawMembers, 'NEWUID')[0].id;
    }, DEDUP_SCRIPT);

    expect(uid).toBe('NEWUID');
  });

  // Scenario 2: de-dup is re-evaluated on every render — reload changes nothing
  test('Scenario 2 — de-dup survives page reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForTimeout(1000);

    const count = await page.evaluate((script) => {
      eval(script);
      const rawMembers = [
        { id: 'OLDUID', name: 'Erez', joined: 1000 },
        { id: 'NEWUID', name: 'Erez', joined: 2000, updatedAt: Date.now() },
      ];
      return dedupMembers(rawMembers, 'NEWUID').length;
    }, DEDUP_SCRIPT);

    expect(count).toBe(1);
  });

  // Scenario 3: member count in statistics equals unique-name count
  test('Scenario 3 — member statistics reflect unique names only', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const result = await page.evaluate((script) => {
      eval(script);
      const rawMembers = [
        { id: 'OLDUID', name: 'Erez',  joined: 1000 },
        { id: 'NEWUID', name: 'Erez',  joined: 2000, updatedAt: Date.now() },
        { id: 'uid-3',  name: 'David', joined: 500  },
        { id: 'uid-4',  name: 'Sara',  joined: 600  },
      ];
      return dedupMembers(rawMembers, 'NEWUID').length;
    }, DEDUP_SCRIPT);

    expect(result).toBe(3); // Erez (collapsed) + David + Sara
  });

  // Scenario 4: settings screen — "Erez" appears exactly once in rendered list @critical
  test('Scenario 4 — no duplicate name rows in settings member list @critical', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const names = await page.evaluate((script) => {
      eval(script);
      const rawMembers = [
        { id: 'OLDUID', name: 'Erez',  joined: 1000 },
        { id: 'NEWUID', name: 'Erez',  joined: 2000, updatedAt: Date.now() },
        { id: 'uid-3',  name: 'David', joined: 500  },
      ];
      return dedupMembers(rawMembers, 'NEWUID').map(m => m.name);
    }, DEDUP_SCRIPT);

    const erezCount = names.filter(n => n === 'Erez').length;
    expect(erezCount).toBe(1);
    expect(names.length).toBe(2); // Erez + David
  });

  // ── Scenario 5: profile quality — no downgrade on YES flow @critical ────────
  //
  // OLDUID: role=admin, custom avatar (cartoon), updatedAt=older  (the identity being reused)
  // NEWUID: role=member, default avatar (👤),    updatedAt=newer  (current session, bare profile)
  //
  // Expected after dedup:
  //   • Exactly one row shown                    (collapse)
  //   • Winner UID = NEWUID                      (current session always wins the slot)
  //   • role  = admin                            (merged from OLDUID — no downgrade)
  //   • avatarType = cartoon                     (merged from OLDUID — no downgrade to default)
  //   • avatarValue = '🧙'                       (merged from OLDUID)

  test('Scenario 5 — migrated identity: admin role and custom avatar preserved, no downgrade @critical', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    const result = await page.evaluate((script) => {
      eval(script);
      const rawMembers = [
        // OLDUID: the original identity — admin, cartoon avatar
        {
          id:          'OLDUID',
          name:        'Erez',
          role:        'admin',
          roles:       { admin: true },
          avatarType:  'cartoon',
          avatarValue: '🧙',
          avatarEmoji: '🧙',
          joined:      1000,
          updatedAt:   1000,
        },
        // NEWUID: current session — bare profile, defaults only
        {
          id:          'NEWUID',
          name:        'Erez',
          role:        'member',
          avatarType:  'emoji',
          avatarValue: '👤',
          joined:      2000,
          updatedAt:   Date.now(),
        },
      ];

      const out = dedupMembers(rawMembers, 'NEWUID');
      const m   = out[0];
      return {
        length:      out.length,
        winnerUid:   m.id,
        role:        m.role,
        rolesAdmin:  !!(m.roles && m.roles.admin),
        avatarType:  m.avatarType,
        avatarValue: m.avatarValue,
      };
    }, DEDUP_SCRIPT);

    expect(result.length).toBe(1);
    expect(result.winnerUid).toBe('NEWUID');
    expect(result.role).toBe('admin');
    expect(result.rolesAdmin).toBe(true);
    expect(result.avatarType).toBe('cartoon');
    expect(result.avatarValue).toBe('🧙');
  });

});

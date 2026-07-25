# Android Standalone Back-Button Exit Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the app runs installed as a TWA/PWA (`display-mode: standalone`), make the Android physical Back button close overlays → return to the main screen → only then ask "לצאת מהאפליקציה?" before actually exiting, instead of silently kicking the user out of the app.

**Architecture:** A single new classic script, `back-guard.js`, arms a one-entry History-API "trap" on load (standalone only) and intercepts `popstate` to run a three-branch decision (close highest-priority visible overlay → return to `main-screen` → show exit-confirm dialog), re-arming the trap after every branch except a confirmed exit. It calls into the app's *existing* overlay close functions and `showScreen`, never manipulates their DOM directly. Full rationale, the overlay→close-function table, and the priority tier list live in the design spec — this plan implements it exactly as specified there.

**Tech Stack:** Vanilla JS (no build step, no framework), plain `<script>` tags in `index.html`, existing `styles.css` conventions.

**Reference spec:** [`docs/superpowers/specs/2026-07-23-android-standalone-back-button-exit-guard-design.md`](../specs/2026-07-23-android-standalone-back-button-exit-guard-design.md) — read this first; this plan does not repeat its rationale, only the concrete steps.

**No automated frontend test suite exists in this repo** (confirmed in `CLAUDE.md`: "Frontend: no automated tests; manual QA via browser"). This plan substitutes an isolated logic-harness (Task 5) for the "write failing test" step the writing-plans skill normally expects, plus a real-browser manual pass (Task 6). A genuine Android/TWA hardware Back-button pass is **not achievable from this environment** and is called out explicitly as a follow-up the user must do on a real device before shipping.

---

### Task 1: Expose `showScreen` on `window`

`back-guard.js` (a plain classic script) needs to call the app's existing `showScreen('main-screen')` function, but `app.js` is loaded as `type="module"`, so its top-level `function showScreen(id){...}` (app.js:163) is **not** currently reachable from outside the module — confirmed by grepping `app.js` for `window.showScreen`, which finds nothing, unlike every other cross-boundary function (`closeConfirmDelete`, `closeScanner`, etc.) which are all explicitly assigned to `window`.

**Files:**
- Modify: `app.js:163`

- [ ] **Step 1: Add the `window` exposure right after the existing function**

Current line 163:
```js
function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active')}
```

Change to:
```js
function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active')}
window.showScreen = showScreen;
```

- [ ] **Step 2: Verify no existing global named `showScreen` is clobbered**

Run:
```bash
grep -n "window.showScreen" app.js
```
Expected: exactly one match, the line just added.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "expose showScreen on window for cross-script back-button handling"
```

---

### Task 2: Add the exit-confirmation modal markup

**Files:**
- Modify: `index.html` (insert after the existing delete-confirmation modal, which currently ends at line 729, right before the `<!-- ═══ ADMIN OVERLAY ═══...` comment on line 731)

- [ ] **Step 1: Insert the new overlay markup**

Insert immediately after this existing block (do not modify the existing block itself):
```html
<!-- ═══ DELETE CONFIRMATION MODAL ═══ -->
<div class="confirm-modal-overlay" id="confirm-delete-overlay"
  onclick="if(event.target===this)closeConfirmDelete()">
  <div class="confirm-modal">
    <div class="confirm-modal-handle"></div>
    <div class="confirm-modal-icon">🗑</div>
    <div class="confirm-modal-title">מחיקת פריט</div>
    <div class="confirm-modal-item" id="confirm-item-name"></div>
    <div class="confirm-modal-by" id="confirm-item-by"></div>
    <div class="confirm-btns">
      <button class="confirm-btn-cancel" onclick="closeConfirmDelete()">ביטול</button>
      <button class="confirm-btn-delete" id="confirm-delete-btn" onclick="confirmDeleteItem()">
        🗑 מחק
      </button>
    </div>
  </div>
</div>
```

New markup to add right after it:
```html

<!-- ═══ EXIT CONFIRMATION MODAL (standalone/TWA Android back-button guard) ═══ -->
<div class="confirm-modal-overlay" id="exit-confirm-overlay"
  onclick="if(event.target===this)closeExitConfirm()">
  <div class="confirm-modal">
    <div class="confirm-modal-handle"></div>
    <div class="confirm-modal-icon">👋</div>
    <div class="confirm-modal-title">לצאת מהאפליקציה?</div>
    <div class="confirm-modal-item">האם ברצונך לסגור את האפליקציה?</div>
    <div class="confirm-btns">
      <button class="confirm-btn-cancel" onclick="closeExitConfirm()">ביטול</button>
      <button class="confirm-btn-exit" id="exit-confirm-btn" onclick="confirmAppExit()">
        יציאה
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Verify the markup is well-formed and doesn't collide with existing ids**

Run:
```bash
grep -n 'id="exit-confirm' index.html
```
Expected: two matches — the overlay `id="exit-confirm-overlay"` and the button `id="exit-confirm-btn"` — and no pre-existing element used either id before this change.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add exit-confirmation modal markup for back-button guard"
```

---

### Task 3: Add the `.confirm-btn-exit` button style

**Files:**
- Modify: `styles.css` (right after the existing `.confirm-btn-delete` rules, which currently end at line 1061)

- [ ] **Step 1: Add the new class, mirroring `.confirm-btn-delete` but with the app's accent green**

Current (do not change):
```css
.confirm-btn-delete{flex:1;background:var(--red);border:none;
  border-radius:13px;padding:13px;font-family:'Rubik',sans-serif;font-size:15px;
  font-weight:700;color:#fff;cursor:pointer;transition:all .12s}
.confirm-btn-delete:active{opacity:.8;transform:scale(.97)}
```

Add immediately after it:
```css

.confirm-btn-exit{flex:1;background:var(--accent);border:none;
  border-radius:13px;padding:13px;font-family:'Rubik',sans-serif;font-size:15px;
  font-weight:700;color:#fff;cursor:pointer;transition:all .12s}
.confirm-btn-exit:active{opacity:.8;transform:scale(.97)}
```

- [ ] **Step 2: Verify the rule parses (no stray brace, correct var reference)**

Run:
```bash
grep -n "confirm-btn-exit" styles.css
```
Expected: two matches, `.confirm-btn-exit{...}` and `.confirm-btn-exit:active{...}`.

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "Add green confirm-btn-exit style for exit-confirmation dialog"
```

---

### Task 4: Create `back-guard.js`

**Files:**
- Create: `back-guard.js`

- [ ] **Step 1: Write the file**

```js
// back-guard.js
// Android physical Back-button guard for standalone/TWA installs.
// No-ops entirely outside display-mode:standalone — browser/tab behavior is untouched.
// See docs/superpowers/specs/2026-07-23-android-standalone-back-button-exit-guard-design.md
(function() {
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  if (!isStandalone) return;

  var backTrapArmed  = false;
  var exitDialogOpen  = false;
  var exitInProgress  = false;

  function overlay(id, fnName) {
    return { id: id, close: function() {
      if (typeof window[fnName] === 'function') window[fnName]();
    }};
  }
  function overlayGeneric(id) {
    return { id: id, close: function() {
      if (typeof window.closeOL2 === 'function') window.closeOL2(id);
    }};
  }

  // Deterministic close priority (highest first). See spec's
  // "Overlay close-function map and priority" section for why this is a
  // hand-authored tier list rather than derived from CSS z-index.
  var OVERLAY_TIERS = [
    [ overlay('admin-overlay', 'closeAdminOverlay') ],
    [ overlay('scanner-overlay', 'closeScanner') ],
    [ overlay('confirm-delete-overlay', 'closeConfirmDelete') ],
    [ overlay('exit-confirm-overlay', 'closeExitConfirm') ],
    [
      overlay('gs-overlay', 'closeGroupSheet'),
      overlay('fd-overlay', 'closeFilterDrawer')
    ],
    [
      overlay('addr-overlay', 'closeManualAddressModal'),
      overlay('pm-overlay', 'closeProductModal'),
      overlay('bp-overlay', 'closeBrandPicker'),
      overlay('price-detail-overlay', 'closePriceDetail'),
      overlay('sd-overlay', 'closeStoreDetail'),
      overlay('bc-overlay', 'closeBasketCompare'),
      overlay('notif-overlay', 'closeNotifications'),
      overlay('import-overlay', 'closeImportModal'),
      overlay('mp2-overlay', 'closeMp2'),
      overlayGeneric('members-overlay'),
      overlayGeneric('share-overlay'),
      overlayGeneric('basket-overlay'),
      overlayGeneric('price-submit-overlay'),
      overlayGeneric('override-overlay'),
      overlayGeneric('report-overlay'),
      overlayGeneric('profile-edit-overlay'),
      overlayGeneric('add-group-overlay')
    ]
  ];

  function isOverlayVisible(el) {
    if (!el) return false;
    var cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' &&
           cs.opacity !== '0' && cs.pointerEvents !== 'none';
  }

  function findOverlayToClose() {
    for (var t = 0; t < OVERLAY_TIERS.length; t++) {
      var tier = OVERLAY_TIERS[t];
      for (var i = 0; i < tier.length; i++) {
        if (isOverlayVisible(document.getElementById(tier[i].id))) return tier[i];
      }
    }
    return null;
  }

  function armBackTrap() {
    if (backTrapArmed) return;
    history.pushState({ backGuard: true }, '', location.href);
    backTrapArmed = true;
  }

  function handleExitEsc(e) {
    if (e.key === 'Escape') window.closeExitConfirm();
  }

  function showExitConfirm() {
    if (exitDialogOpen) return;
    exitDialogOpen = true;
    document.getElementById('exit-confirm-overlay').classList.add('show');
    document.addEventListener('keydown', handleExitEsc, { once: true });
  }

  // Official close path for the exit dialog — the ONLY way it closes.
  // Called by: the ביטול button, Esc, backdrop click, and (via the
  // overlay tier above) a Back press while the dialog is open.
  window.closeExitConfirm = function() {
    document.getElementById('exit-confirm-overlay').classList.remove('show');
    exitDialogOpen = false;
  };

  window.confirmAppExit = function() {
    exitInProgress = true;
    window.closeExitConfirm();
    history.back(); // exactly once — see spec's Non-goals section
  };

  window.addEventListener('popstate', function() {
    if (exitInProgress) return;
    backTrapArmed = false; // the dummy entry we armed was just consumed

    var toClose = findOverlayToClose();
    if (toClose) {
      toClose.close();
      armBackTrap();
      return;
    }

    var mainScreen = document.getElementById('main-screen');
    if (!mainScreen || !mainScreen.classList.contains('active')) {
      if (typeof window.showScreen === 'function') window.showScreen('main-screen');
      armBackTrap();
      return;
    }

    showExitConfirm();
    armBackTrap();
  });

  armBackTrap();
})();
```

- [ ] **Step 2: Verify the file has no syntax errors**

Run:
```bash
node --check back-guard.js
```
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add back-guard.js
git commit -m "Add back-guard.js: standalone Android back-button exit guard"
```

---

### Task 5: Logic harness — verify the state machine in isolation

Since there is no test framework, this task builds a throwaway HTML harness in the scratchpad directory (never committed) that stubs `matchMedia` to force standalone mode and provides minimal DOM stand-ins for `main-screen` and two overlays, then drives `back-guard.js`'s real behavior through the Browser tool to check every branch of the spec's decision order and the race-condition rules.

**Files:**
- Create (scratchpad only, not committed): `C:\Users\erezg\AppData\Local\Temp\claude\C--Codes-family-shopping--claude-worktrees-modest-hamilton-0350ac\b132072d-a7b1-44b7-8482-7bad2d28e14a\scratchpad\back-guard-harness.html`
- Create (scratchpad only, not committed): `C:\Users\erezg\AppData\Local\Temp\claude\C--Codes-family-shopping--claude-worktrees-modest-hamilton-0350ac\b132072d-a7b1-44b7-8482-7bad2d28e14a\scratchpad\back-guard.js` (a copy of Task 4's file, so `<script src="back-guard.js">` resolves next to the harness)

- [ ] **Step 1: Write the harness**

```html
<!DOCTYPE html>
<html><head><title>back-guard harness</title>
<style>
/* Reproduces styles.css:1033-1036 verbatim (the real .confirm-modal-overlay
   show/hide convention). No inline style on #exit-confirm-overlay below —
   an inline style would always beat this stylesheet rule and permanently
   hide the element from getComputedStyle regardless of the .show class,
   producing a false-negative "back-guard.js is broken" result that is
   actually a fixture bug, not a back-guard.js bug. */
.confirm-modal-overlay{opacity:0;pointer-events:none}
.confirm-modal-overlay.show{opacity:1;pointer-events:all}
</style>
</head>
<body>
<div class="screen active" id="main-screen">MAIN</div>
<div class="screen" id="profile-screen">PROFILE</div>

<div id="confirm-delete-overlay" style="display:none">
  <button onclick="log('closeConfirmDelete called'); document.getElementById('confirm-delete-overlay').style.display='none'">x</button>
</div>
<div id="exit-confirm-overlay" class="confirm-modal-overlay">exit dialog</div>

<div id="log"></div>
<script>
  function log(msg) {
    document.getElementById('log').textContent += msg + '\n';
    console.log(msg);
  }
  window.matchMedia = function() { return { matches: true }; }; // force standalone
  window.closeConfirmDelete = function() {
    log('closeConfirmDelete called');
    document.getElementById('confirm-delete-overlay').style.display = 'none';
  };
  window.showScreen = function(id) {
    log('showScreen(' + id + ') called');
    document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
    document.getElementById(id).classList.add('active');
  };
  // exit-confirm-overlay uses the real .confirm-modal-overlay show/hide
  // convention (opacity + pointer-events), matching styles.css exactly via
  // the <style> block above, so isOverlayVisible() and the real
  // window.closeExitConfirm from back-guard.js exercise the actual
  // production logic unmodified.
</script>
<script src="back-guard.js"></script>
</body></html>
```

Serve the scratchpad directory over HTTP rather than opening the harness via a `file://` URL — this repo's own local-dev convention already uses `python -m http.server` (see `CLAUDE.md`), and `file://` navigation is unreliable in some browser-automation tools:
```bash
cd "C:\Users\erezg\AppData\Local\Temp\claude\C--Codes-family-shopping--claude-worktrees-modest-hamilton-0350ac\b132072d-a7b1-44b7-8482-7bad2d28e14a\scratchpad"
python -m http.server 8934
```
Then navigate to `http://127.0.0.1:8934/back-guard-harness.html`. Stop the server (Ctrl+C / kill the process) once verification is complete.

Copy the real `back-guard.js` next to this harness file so the `<script src="back-guard.js">` reference resolves:
```bash
cp back-guard.js "C:\Users\erezg\AppData\Local\Temp\claude\C--Codes-family-shopping--claude-worktrees-modest-hamilton-0350ac\b132072d-a7b1-44b7-8482-7bad2d28e14a\scratchpad\back-guard.js"
```

- [ ] **Step 2: Open the harness and confirm the trap arms on load**

Use the Browser tool to navigate to the harness file, then check history grew by exactly one entry:
```js
history.length // note this value as N
```
Expected: the page loaded without console errors, and `history.length` is 1 more than it would be if `back-guard.js` were absent (verify by comparing against a copy of the harness with the `<script src="back-guard.js">` line removed, or simply confirm going back once does NOT leave the page — see next step).

- [ ] **Step 3: Verify branch 1 — overlay closes first, no dialog, no screen change**

In the harness, show the fake overlay, then simulate a physical Back press:
```js
document.getElementById('confirm-delete-overlay').style.display = 'block';
history.back();
```
Expected (check the `#log` div / console): `closeConfirmDelete called` logged; `exit-confirm-overlay` never got its `show` class; `main-screen` still `.active`.

- [ ] **Step 4: Verify branch 2 — secondary screen returns to main, no dialog**

```js
document.getElementById('main-screen').classList.remove('active');
document.getElementById('profile-screen').classList.add('active');
history.back();
```
Expected: `showScreen(main-screen) called` logged; `exit-confirm-overlay` never shown.

- [ ] **Step 5: Verify branch 3 — main screen, nothing open → exit dialog appears**

```js
history.back();
```
Expected: `document.getElementById('exit-confirm-overlay').classList.contains('show')` is now `true`.

- [ ] **Step 6: Verify rapid Back presses while the dialog is open only ever cancel, never duplicate**

```js
history.back(); // should close the dialog (cancel), per the overlay-tier path
document.getElementById('exit-confirm-overlay').classList.contains('show') // expect false
history.back(); // main screen, nothing open again -> dialog re-opens
document.getElementById('exit-confirm-overlay').classList.contains('show') // expect true
```
Expected: dialog toggles cleanly each time; at no point are there two overlapping dialogs or duplicate `history.pushState` calls (spot-check via `history.length` staying flat/bounded across repeated presses rather than growing without limit).

- [ ] **Step 7: Verify confirmed exit calls `history.back()` exactly once and does not re-arm**

```js
var backCalls = 0;
var realBack = history.back.bind(history);
history.back = function() { backCalls++; return realBack(); };
window.confirmAppExit();
backCalls // expect exactly 1
document.getElementById('exit-confirm-overlay').classList.contains('show') // expect false
```

- [ ] **Step 8: Delete the scratch harness (never commit it)**

```bash
rm -f "C:\Users\erezg\AppData\Local\Temp\claude\C--Codes-family-shopping--claude-worktrees-modest-hamilton-0350ac\b132072d-a7b1-44b7-8482-7bad2d28e14a\scratchpad\back-guard-harness.html" "C:\Users\erezg\AppData\Local\Temp\claude\C--Codes-family-shopping--claude-worktrees-modest-hamilton-0350ac\b132072d-a7b1-44b7-8482-7bad2d28e14a\scratchpad\back-guard.js"
```

No commit for this task — it produces no repo changes, only confidence that Task 4's code is correct.

---

### Task 6: Real-app manual verification + version bump

**Files:**
- Modify: `index.html` (wire the new script tag, bump version comment)

- [ ] **Step 1: Add the script tag and bump the version comment**

Current (index.html:15 and :429-430):
```html
<!-- App Version: 3.1.0 | search relevance + price stability + radius/pagination + clickable store details -->
```
```html
<script src="appinline.js"></script>
<script type="module" src="app.js"></script>
```

Change to:
```html
<!-- App Version: 3.2.0 | Android standalone back-button exit guard -->
```
```html
<script src="appinline.js"></script>
<script src="back-guard.js"></script>
<script type="module" src="app.js"></script>
```

- [ ] **Step 2: Serve the app locally**

```bash
python -m http.server 8080
```

- [ ] **Step 3: Load it in the Browser tool (normal tab, non-standalone) and confirm zero regressions**

Navigate to `http://localhost:8080`, open the console, and confirm:
- No JavaScript errors on load.
- `window.matchMedia('(display-mode: standalone)').matches` is `false` (normal desktop/mobile browser tab).
- Pressing the browser's own Back button after navigating away and back behaves exactly as before this change (no dialog, no interception) — confirming the standalone gate correctly makes this a no-op outside standalone mode, per the spec's Scope section.

- [ ] **Step 4: Visually verify the new modal's styling/RTL layout**

With the app loaded, run in the console:
```js
document.getElementById('exit-confirm-overlay').classList.add('show');
```
Take a screenshot. Confirm: Hebrew RTL text renders correctly ("לצאת מהאפליקציה?" / "האם ברצונך לסגור את האפליקציה?"), the ביטול button matches the existing cancel style, the יציאה button is green (`var(--accent)`) and matches the existing modal's shape/spacing. Then run `document.getElementById('exit-confirm-overlay').classList.remove('show');` to close it.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Wire back-guard.js into index.html, bump to v3.2.0"
```

- [ ] **Step 6: Flag the remaining real-device gap to the user**

This environment cannot install the app as an Android TWA or send a genuine hardware Back-button event, so the actual "does this really change what happens when I press Back on my phone" behavior is unverified until tested there. Tell the user explicitly: before considering this done, install/update the TWA on an Android device (or open the deployed site and "Add to Home Screen") and manually run through the spec's manual test checklist (main screen → dialog; cancel; confirm exits; overlay-open → closes overlay only; secondary screen → returns to main; rapid presses don't duplicate).

---

### Task 7: Service Worker App Shell Integration (release-readiness follow-up)

Discovered during Task 6's code-quality review, not part of the original 6-task scope: `back-guard.js` was never added to `sw.js`'s offline precache. Under the existing cache-first strategy, a user who updates the installed PWA/TWA and goes offline before `back-guard.js` is ever fetched once over the network would silently get no back-button guard at all — reproducing the exact bug this feature exists to fix, for exactly the offline-first standalone/TWA users who are its target audience.

**Files:**
- Modify: `sw.js` only

- [ ] **Step 1: Add `/back-guard.js` to `APP_SHELL` and bump `CACHE_VERSION`**

Current (`sw.js:4-17`):
```js
const CACHE_VERSION = 'fsl-v6';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/appinline.js',
  '/sw-killer.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/splash.png',
];
```

Change to:
```js
const CACHE_VERSION = 'fsl-v7';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/appinline.js',
  '/back-guard.js',
  '/sw-killer.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/splash.png',
];
```

(`/back-guard.js` placed next to `/appinline.js`, matching the two files' load-order adjacency in `index.html`.)

- [ ] **Step 2: Verify**

```bash
grep -n "back-guard.js\|CACHE_VERSION" sw.js
```
Expected: `CACHE_VERSION = 'fsl-v7'` and `/back-guard.js` present in `APP_SHELL`, and nothing else in the file changed (fetch handler, install/activate listeners, `NETWORK_ONLY_PATTERNS` all untouched).

- [ ] **Step 3: Commit**

```bash
git add sw.js
git commit -m "Add back-guard.js to service worker app-shell precache (v3.2.0 offline delivery)"
```

- [ ] **Step 4: Document the runtime-verification boundary**

Full "clear cache → load online → go offline → reload → confirm back-guard.js still runs" verification requires a real browser with persistent Cache Storage across a simulated offline toggle. State plainly whatever subset of this was actually achievable in this environment versus what remains for the user to confirm on a real device/browser profile.

---

### Task 8: Align app.js APP_VERSION (release-readiness follow-up)

Discovered during the final holistic review: `app.js:22`'s `APP_VERSION` constant was never bumped when `index.html`/`sw.js` moved to the 3.2.0/fsl-v7 release, so the settings sheet, the Firebase `appVersion` write, and the diagnostics clipboard copy all still reported `3.1.0`.

**Files:** `app.js` only — one line, `const APP_VERSION = '3.1.0';` → `'3.2.0';`, comment text unchanged.

Executed and approved (commit `829160b`).

### Task 9: Protect onboarding/pre-main screens in back-guard.js

Discovered during the final holistic review: `back-guard.js`'s "not on `main-screen` → `showScreen('main-screen')`" branch doesn't distinguish genuine secondary screens from onboarding gates. See the design spec's new "Protected pre-main screens" section for the full rationale and the evidence (`profile-screen` has exactly one call site in the whole codebase — the onboarding-gate check — and never serves as a normal secondary screen).

**Files:**
- Modify: `back-guard.js` only

- [ ] **Step 1: Add the protected-screen list and check, and insert the new branch**

Current `popstate` handler body (unchanged since Task 4):
```js
  window.addEventListener('popstate', function() {
    if (exitInProgress) return;
    backTrapArmed = false; // the dummy entry we armed was just consumed

    var toClose = findOverlayToClose();
    if (toClose) {
      toClose.close();
      armBackTrap();
      return;
    }

    var mainScreen = document.getElementById('main-screen');
    if (!mainScreen || !mainScreen.classList.contains('active')) {
      if (typeof window.showScreen === 'function') window.showScreen('main-screen');
      armBackTrap();
      return;
    }

    showExitConfirm();
    armBackTrap();
  });

  armBackTrap();
})();
```

Change to (add the `PROTECTED_SCREENS` list/helper above the listener, and insert one new branch between the overlay check and the main-screen check):
```js
  // Screens that are pre-main onboarding gates, not normal secondary screens.
  // See the design spec's "Protected pre-main screens" section: verified via a
  // repo-wide search that profile-screen has exactly one call site (the
  // onboarding-gate check in app.js) and never serves a second role, so this
  // is a static list, not a runtime app-state readiness check — back-guard.js
  // still never reads business/session state, only DOM screen ids.
  var PROTECTED_SCREENS = ['setup-screen', 'profile-screen'];

  function isProtectedScreenActive() {
    for (var i = 0; i < PROTECTED_SCREENS.length; i++) {
      var el = document.getElementById(PROTECTED_SCREENS[i]);
      if (el && el.classList.contains('active')) return true;
    }
    return false;
  }

  window.addEventListener('popstate', function() {
    if (exitInProgress) return;
    backTrapArmed = false; // the dummy entry we armed was just consumed

    var toClose = findOverlayToClose();
    if (toClose) {
      toClose.close();
      armBackTrap();
      return;
    }

    if (isProtectedScreenActive()) {
      showExitConfirm();
      armBackTrap();
      return;
    }

    var mainScreen = document.getElementById('main-screen');
    if (!mainScreen || !mainScreen.classList.contains('active')) {
      if (typeof window.showScreen === 'function') window.showScreen('main-screen');
      armBackTrap();
      return;
    }

    showExitConfirm();
    armBackTrap();
  });

  armBackTrap();
})();
```

- [ ] **Step 2: Verify the file has no syntax errors**

```bash
node --check back-guard.js
```
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add back-guard.js
git commit -m "Protect onboarding/pre-main screens (setup-screen, profile-screen) from Back-to-main routing"
```

---

## Self-Review Notes

- **Spec coverage:** Standalone gating (Task 4 Step 1's early return) · idempotent trap (`backTrapArmed` guard in `armBackTrap`) · three-branch order (popstate handler body) · overlay tier list with corrected `mp2-overlay`/`price-detail-overlay` ids (Task 4) · exit dialog official close function used everywhere (Task 4 + markup in Task 2) · single `history.back()` on confirm, no re-arm (`confirmAppExit`) · race protection (`exitInProgress` short-circuit, dialog-as-overlay reduction) · Hebrew copy exact match (Task 2) · manual test checklist (Task 6 Step 3-4, plus spec's own checklist handed to the user for on-device follow-up). No spec section is without a corresponding task.
- **Placeholders:** none — every step has literal, runnable code or an exact command with an expected result.
- **Type/name consistency:** `closeExitConfirm`, `confirmAppExit`, `showScreen`, and every overlay id/close-function pair in Task 4's `OVERLAY_TIERS` match the spec's corrected table exactly (including the `price-detail-overlay` id fix and `mp2-overlay` → `closeMp2` fix caught during spec review).

## Deferred Hardening (Post-Integration)

Task 4 (`back-guard.js`) passed spec compliance, the Special Gate checklist, all four invariants, and code quality review with **zero Critical/Important issues**. The code-quality reviewer surfaced four Minor, non-blocking observations. These are accepted improvement opportunities, not release blockers, and are intentionally **not** being implemented now — re-evaluate after Task 6 integration and real-device (Android/TWA) testing, since on-device behavior may clarify whether any of these actually warrant a change versus remaining quality-only polish:

- Add a defensive `if (exitInProgress) return;` as the first line of `confirmAppExit()`, so the "exactly once" `history.back()` invariant is self-enforcing regardless of call site, not solely protected by the `popstate` listener's own guard.
- Consider an optional dev-only `console.warn` when `OVERLAY_TIERS` maps an id to a close-function name that no longer exists on `window` (guards against silent no-ops if a future `app.js` rename isn't mirrored here).
- Re-evaluate the ~200ms CSS opacity-transition window on the `.confirm-modal-overlay` convention (shared by `confirm-delete-overlay`/`exit-confirm-overlay`) after real-device testing — a very rapid repeated Back press could theoretically read a mid-fade computed style and trigger one extra idempotent close call; self-corrects on the next press, not a functional bug today.
- Consider retaining a reusable (rather than throwaway) verification harness for `back-guard.js`'s state machine if frontend test automation is ever introduced for this repo — Task 5's harness is intentionally scratch-only today, consistent with this codebase having no frontend test framework.

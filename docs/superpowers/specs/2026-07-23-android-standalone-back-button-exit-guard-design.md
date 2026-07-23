# Android Standalone Back-Button Exit Guard

## Problem

When the PWA runs installed (Android TWA / "Add to Home Screen", `display-mode: standalone`), pressing
the phone's physical Back button immediately exits the Custom Tab / TWA activity, kicking the user out
to the home screen. There is no confirmation and no in-app Back handling — the very first Back press
consumes the browser's (empty) history and the OS closes the activity.

Desired behavior: Back should behave like a native app — close overlays first, then return to the main
screen, and only ask "close the app?" when the user is already at the root with nothing else open.

## Core Goal

1. Back first resolves *application UI state* (close overlay → return to main screen).
2. Only when already on the main screen with nothing else open does Back show an exit-confirmation dialog.
3. Exit happens only on explicit user confirmation, via a single `history.back()`.
4. Nothing here changes normal browser/tab behavior — this is standalone-only.
5. Browser history is used purely as the Back-interception mechanism, never as the source of navigation
   truth. Which screen/overlay is "active" is always read from the existing DOM/state conventions
   already in the app, never inferred from `history.length` or history contents.

## Scope

Gate everything behind:

```js
window.matchMedia('(display-mode: standalone)').matches
```

The codebase has no existing "is installed" check to reuse (confirmed via search) — this is the correct
one, and it already matches `manifest.json`'s `"display": "standalone"`. If this check is `false` (normal
mobile/desktop browser tab), none of this code runs and Back behaves exactly as it does today.

## Non-goals

- No new routing/history framework, no rewrite of the existing 20+ overlays.
- No forced-closing of the Android task — a `history.back()` call is the only exit mechanism, and it is
  called exactly once, with no `history.go(-2)`, no double `back()`, no `setTimeout` force-close hacks.
  If the stack ever contains more than our one dummy entry (future deep links, etc.), that single
  `back()` does the standards-correct thing; we don't try to guarantee closure beyond native behavior.
- No changes to non-standalone (browser tab) behavior.

## Where this lives

New file: **`back-guard.js`**, loaded as a plain classic script (not a module) right after
`appinline.js` and before `app.js` in `index.html`. Rationale:
- It must run and arm the trap immediately on load, before user interaction — same reasoning as
  `appinline.js`'s splash-screen IIFE.
- The overlay-close functions it needs to call (`closeConfirmDelete`, `closeScanner`, `closeOL2`, etc.)
  are attached to `window` by `app.js` (a `type="module"` script), but only ever *invoked* later, inside
  event handlers that fire long after `app.js` has finished evaluating — so load order between
  `back-guard.js` and `app.js` doesn't matter for correctness, only that `back-guard.js`'s own IIFE runs
  once at parse time to arm the trap.
- `showScreen('main-screen')` and `document.getElementById('main-screen').classList.contains('active')`
  are read directly against the existing `.screen` / `.screen.active` convention in `app.js:163`
  (`function showScreen(id){...classList.add('active')}`) — no new state model introduced.

## Back-trap mechanism

```js
let backTrapArmed  = false;   // exactly one outstanding dummy history entry, or none
let exitDialogOpen  = false;  // exit-confirm dialog currently visible
let exitInProgress  = false;  // user confirmed exit; suppress further handling
```

- On load (standalone only): `armBackTrap()` → `history.pushState({backGuard: true}, '', location.href)`,
  guarded by `if (!backTrapArmed)`.
- `popstate` listener: fires when the dummy entry is consumed by a physical Back press. Ignored entirely
  if `exitInProgress` is true (exit already confirmed and underway — see Race Conditions below).

## Back-press handling order

On every qualifying `popstate`, handle in this exact order, then perform **exactly one** state
transition:

1. **Visible overlay/modal/bottom-sheet** → close the highest-priority one via its *existing* close
   function (never a blind `style.display='none'`), re-arm the trap, return. No exit dialog.
2. **Not on `main-screen`** (e.g. `profile-screen` active) → `showScreen('main-screen')`, re-arm the
   trap, return. No exit dialog. History is not used to infer this — only `.screen.active` is checked.
3. **Main screen, nothing open** → show the exit-confirmation dialog, re-arm the trap (see Exit Dialog
   below for why re-arming here is safe), return.

### Overlay detection

A conservative, convention-agnostic visibility check (the app's ~20 overlays use at least three
different show/hide conventions — plain `display:none`↔`.show{display:flex}`, opacity/pointer-events
transitions, and the generic `.overlay`/`closeOL2` pattern — so detection must not assume one):

```js
function isOverlayVisible(el) {
  const cs = window.getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' &&
         cs.opacity !== '0' && cs.pointerEvents !== 'none';
}
```

Applied to every `[id$="-overlay"]` element (excluding `#splash-overlay`, which isn't a modal).

### Overlay close-function map and priority

Detection only decides *what's* open; closing always goes through the overlay's own existing close
function so side effects are preserved (camera stream teardown, clearing pending-delete state, etc.):

| Overlay id | Close function | Notes |
|---|---|---|
| `scanner-overlay` | `closeScanner()` | releases `getUserMedia` camera stream — highest priority |
| `confirm-delete-overlay` | `closeConfirmDelete()` | |
| `admin-overlay` | `closeAdminOverlay()` | |
| `gs-overlay` | `closeGroupSheet()` | bottom sheet |
| `fd-overlay` | `closeFilterDrawer()` | bottom sheet |
| `addr-overlay` | `closeManualAddressModal()` | |
| `pm-overlay` | `closeProductModal()` | |
| `bp-overlay` | `closeBrandPicker()` | |
| `pd-overlay` | `closePriceDetail()` | |
| `sd-overlay` | `closeStoreDetail()` | |
| `bc-overlay` | `closeBasketCompare()` | |
| `notif-overlay` | `closeNotifications()` | |
| `import-overlay` | `closeImportModal()` | |
| `mp2-overlay`, `members-overlay`, `share-overlay`, `basket-overlay`, `price-submit-overlay`, `override-overlay`, `report-overlay`, `profile-edit-overlay`, `add-group-overlay` | `closeOL2('<id>')` | generic `.overlay` convention |
| `exit-confirm-overlay` | `cancelExitDialog()` | the exit dialog itself — see below |

Priority when more than one is (unexpectedly) visible at once: reuse each overlay's own CSS `z-index`
(already authored per-overlay, e.g. `admin-overlay: 9000`, `import-overlay: 1100`, `notif-overlay: 700`,
`bc-overlay: 610`, `scanner-overlay`/`sd-overlay: 600`, `pm-overlay: 450`, generic `.overlay`: 200) —
sort visible overlays by computed z-index descending and close only the top one. This piggybacks on an
ordering the app already maintains instead of hand-authoring a second, parallel priority list that could
drift out of sync.

## Exit-confirmation dialog

New markup in `index.html`, next to the existing `confirm-delete-overlay`, reusing the same
`.confirm-modal-overlay` / `.confirm-modal` visual pattern:

- Title: **לצאת מהאפליקציה?**
- Body: **האם ברצונך לסגור את האפליקציה?**
- Buttons: **ביטול** (reuses `.confirm-btn-cancel`) / **יציאה** (new `.confirm-btn-exit`, green variant
  of `.confirm-btn-delete` using `var(--accent)`)

Behavior:
- **Cancel** (button, Esc, or backdrop click all call one `cancelExitDialog()`): hide dialog,
  `exitDialogOpen = false`, re-arm the trap.
- A **Back press while the dialog is open** needs no special-case code: `exit-confirm-overlay` is
  itself matched by the generic `[id$="-overlay"]` visibility scan, so it is simply the highest-priority
  visible overlay at that moment (see priority table above — give it the highest z-index of all
  overlays) and step 1 of the normal handling order closes it via `cancelExitDialog()`, same as any
  other overlay. This is what keeps "exactly one state transition per Back press" true without a
  parallel code path: every `popstate` always maps to exactly one of {close overlay, return to main,
  open dialog}, and "cancel the exit dialog" is just a instance of "close overlay."
- **Confirm (יציאה)**: hide dialog, `exitInProgress = true`, do **not** re-arm the trap, call
  `history.back()` exactly once. Whether this closes the TWA outright or lands on a prior real history
  entry is between the browser and the OS — both outcomes are correct per the Non-goals section.

## Race-condition protection

- `armBackTrap()` is a no-op unless `backTrapArmed === false`, so rapid Back presses can never stack up
  more than one outstanding dummy entry.
- Rapid Back presses while the dialog is open never open a second dialog: each one closes the
  (already-open) `exit-confirm-overlay` via the overlay path above, which is a terminal action per
  press — there is nothing left open afterward for a following press to re-trigger the dialog from
  (the next Back after that lands back on "main screen, nothing open" and opens a fresh single dialog).
- Once `exitInProgress === true`, the `popstate` listener returns immediately on any further event —
  no repeated `history.back()` calls, no re-opened dialog.

## Files touched

- `index.html` — new `exit-confirm-overlay` markup; new `<script src="back-guard.js">` tag; version
  comment bump.
- `back-guard.js` **(new)** — all logic above, self-contained, no dependency on Firebase or `app.js`
  internals beyond calling the already-`window`-exposed close/navigation functions.
- `styles.css` — one new `.confirm-btn-exit` class.

## Manual test checklist (standalone/TWA only)

- Back on main screen → exit dialog appears.
- Cancel (button / Esc / backdrop / Back) → dialog closes, app stays open, next Back re-opens it.
- Confirm (יציאה) → exactly one `history.back()` fires; no duplicate dialogs, no repeated calls.
- Rapid repeated Back presses on main screen → still only one dialog, one eventual exit.
- Back on `profile-screen` → returns to `main-screen`, no dialog.
- Back with scanner overlay open → scanner closes, camera stream releases, no dialog.
- Back with confirm-delete modal open → only that modal closes, no dialog.
- Back with a bottom sheet (`gs-overlay`/`fd-overlay`) open → only the sheet closes, no dialog.
- After any overlay closes via Back, a subsequent Back on main screen still opens the exit dialog.
- Normal (non-standalone) mobile browser tab → Back behavior is completely unchanged.

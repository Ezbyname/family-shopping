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

### First-interaction defensive re-arm

Real-device testing found the exit dialog sometimes doesn't appear at all until the user has interacted
with the page at least once (e.g. added an item to the cart) — pressing Back before any interaction just
exits immediately, as if the guard weren't installed. The most likely explanation: some Android
WebView/TWA implementations don't reliably wire a JS-initiated `pushState` made at page load into the
native back-stack the hardware button consults until the page has received a genuine user gesture.

Mitigation: in addition to the load-time arm, attach one-time listeners for the first `pointerdown`,
`touchstart`, and `click` (whichever fires first) that call `armBackTrap()` again. This is purely
defensive — `armBackTrap()` is already idempotent (no-ops if `backTrapArmed` is already true), so this
cannot create a duplicate history entry regardless of how many of these three events fire for the same
physical tap. It only has any effect if the load-time arm was, for whatever platform reason, not
actually honored.

## Back-press handling order

On every qualifying `popstate`, handle in this exact order, then perform **exactly one** state
transition:

1. **Visible overlay/modal/bottom-sheet** → close the highest-priority one via its *existing* close
   function (never a blind `style.display='none'`), re-arm the trap, return. No exit dialog.
2. **Protected pre-main/onboarding screen active** (`setup-screen` or `profile-screen` — see "Protected
   pre-main screens" below) → show the exit-confirmation dialog, re-arm the trap, return. Do **not**
   call `showScreen('main-screen')` — that would silently drop the user onto a screen that expects
   group/list data they don't have yet.
3. **Normal secondary screen** (any `.screen` other than `main-screen` that isn't a protected screen) →
   `showScreen('main-screen')`, re-arm the trap, return. No exit dialog. History is not used to infer
   this — only `.screen.active` is checked.
4. **Main screen, nothing open** → show the exit-confirmation dialog, re-arm the trap (see Exit Dialog
   below for why re-arming here is safe), return.

### Protected pre-main screens

Some `.screen`s are not "secondary screens reached from an already-usable main app" — they are
onboarding gates the user must complete *before* `main-screen` is meaningful at all. Routing Back to
`main-screen` from one of these would silently drop a first-run user onto a screen expecting group/list
data that doesn't exist yet. These screens are **statically** protected — always, unconditionally:

- `setup-screen` — shown whenever there's no saved local session, or anonymous auth failed
  (`app.js`, the `onAuthStateChanged` handler).
- `profile-screen` — shown when the user has a saved group session but no `displayName` yet
  (`app.js`, `_patchConnectToGroup`, guarded by `if (!myProfile || !myProfile.displayName)`).

**Evidence this list is exhaustive, not a heuristic:** a repo-wide search found exactly **one** call
site for `showScreen('profile-screen')` in the entire codebase — the onboarding-gate check above. There
is no other code path that opens it. In particular, **`profile-screen` is not a normal secondary screen
in the current codebase.** The "edit my profile while using the app" feature is a *different* UI
element entirely — `profile-edit-overlay`, a modal in the generic `.overlay`/`closeOL2` family, already
handled correctly by the existing overlay-tier logic above. Because `profile-screen` never serves a
second role, it is protected unconditionally, with no readiness-state branching required.

This is a deliberate, evidence-driven choice over the alternative (checking app state like
`myProfile?.displayName` or `groupId` directly inside `back-guard.js` to decide protection dynamically):
consistent with this doc's Core Goal #5 (history is a mechanism, never the source of navigation truth),
`back-guard.js` should likewise never reach into business/session state to infer readiness — it reads
only `.screen.active`/overlay DOM, exactly as it already does everywhere else. A static, DOM-id-based
protected list keeps that boundary intact; if a screen is ever added that genuinely needs conditional
protection, that would be a new design decision, not an extension of this static list.

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
function so side effects are preserved (camera stream teardown, clearing pending-delete state, etc.).
This table is a plain id→close-function lookup — row order carries no meaning. The authoritative
close-priority order is the explicit tier list below the table, not this list's row order:

| Overlay id | Close function | Notes |
|---|---|---|
| `scanner-overlay` | `closeScanner()` | releases `getUserMedia` camera stream |
| `confirm-delete-overlay` | `closeConfirmDelete()` | |
| `admin-overlay` | `closeAdminOverlay()` | |
| `gs-overlay` | `closeGroupSheet()` | bottom sheet |
| `fd-overlay` | `closeFilterDrawer()` | bottom sheet |
| `addr-overlay` | `closeManualAddressModal()` | |
| `pm-overlay` | `closeProductModal()` | |
| `bp-overlay` | `closeBrandPicker()` | |
| `price-detail-overlay` | `closePriceDetail()` | DOM `id` is `price-detail-overlay`; its CSS class is `pd-overlay` — do not confuse the two |
| `sd-overlay` | `closeStoreDetail()` | |
| `bc-overlay` | `closeBasketCompare()` | |
| `notif-overlay` | `closeNotifications()` | |
| `import-overlay` | `closeImportModal()` | |
| `mp2-overlay` | `closeMp2()` | own dedicated close function, not `closeOL2` |
| `members-overlay`, `share-overlay`, `basket-overlay`, `price-submit-overlay`, `override-overlay`, `report-overlay`, `profile-edit-overlay`, `add-group-overlay` | `closeOL2('<id>')` | generic `.overlay` convention |
| `exit-confirm-overlay` | `closeExitConfirm()` | the exit dialog itself — its **official** close path; used by the Cancel button, Esc, backdrop click, *and* the Back-press overlay path below. Nothing closes this overlay any other way (no direct `style.display`/class manipulation), so `exitDialogOpen` can never go stale. |

**Priority is an explicit, hand-authored tier list, not raw CSS `z-index`.** `z-index` governs visual
paint order, which is a different concern from "what should Back close first" — conflating the two was
the risk flagged during spec review (e.g. `confirm-delete-overlay` and `exit-confirm-overlay` currently
share the same CSS class and would tie on raw z-index). When more than one overlay is visible at once,
close only the topmost tier's overlay, in this deterministic order:

1. `admin-overlay` (`closeAdminOverlay`) — security-sensitive, always wins
2. `scanner-overlay` (`closeScanner`) — holds a live camera stream
3. `confirm-delete-overlay` (`closeConfirmDelete`) — destructive-action confirm
4. `exit-confirm-overlay` (`closeExitConfirm`)
5. Bottom sheets — `gs-overlay` (`closeGroupSheet`), `fd-overlay` (`closeFilterDrawer`)
6. Generic overlays/modals — everything else in the table above

This tier list is the single source of truth for close priority; CSS `z-index` is left as-is for
rendering only and is not read by the back-guard logic.

## Exit-confirmation dialog

New markup in `index.html`, next to the existing `confirm-delete-overlay`, reusing the same
`.confirm-modal-overlay` / `.confirm-modal` visual pattern:

- Title: **לצאת מהאפליקציה?**
- Body: **האם ברצונך לסגור את האפליקציה?**
- Buttons: **ביטול** (reuses `.confirm-btn-cancel`) / **יציאה** (new `.confirm-btn-exit`, green variant
  of `.confirm-btn-delete` using `var(--accent)`)

Behavior:
- **Cancel** (button, Esc, or backdrop click — all call the one official `closeExitConfirm()`): hide
  dialog, `exitDialogOpen = false`, re-arm the trap, stay on `main-screen`.
- A **Back press while the dialog is open** needs no special-case code: `exit-confirm-overlay` is
  itself matched by the generic `[id$="-overlay"]` visibility scan, so per the tier list above it is
  simply "the visible overlay" at that moment, and step 1 of the normal handling order closes it via
  `closeExitConfirm()` — the exact same function and the exact same result as pressing Cancel:
  `exitDialogOpen = false`, trap re-armed, `main-screen` stays active. This `popstate` is **fully
  consumed by the cancel action** — it must not also fall through and be treated as if the user had
  pressed יציאה. This is what keeps "exactly one state transition per Back press" true without a
  parallel code path: every `popstate` always maps to exactly one of {close overlay, return to main,
  open dialog}, and "Back while the exit dialog is open" is just an instance of "close overlay," never
  a distinct branch.

  > **The exit confirmation dialog participates in the same overlay stack as all other overlays. Back
  > while it is visible closes it through its official close function and is treated as cancel. No
  > separate Back-dialog special case is allowed.**

- **Confirm (יציאה)**: hide dialog, `exitInProgress = true`, do **not** re-arm the trap, call
  `history.back()` exactly once. Whether this closes the TWA outright or lands on a prior real history
  entry is between the browser and the OS — both outcomes are correct per the Non-goals section.

### Accepted tradeoff: the exit dialog intentionally stays armed while open

The exit dialog intentionally keeps the Back trap armed the entire time it is visible (both branches
that call `showExitConfirm()` also call `armBackTrap()` immediately after).

**Reason:** Back while the exit dialog is visible must be interceptable and must behave like Cancel —
this was verified empirically (see below), not just assumed. For a `popstate` event to fire at all when
Back is pressed, there must be a dummy history entry above the current position for that press to
consume; with nothing armed, a Back press at the bottom of the page's own history is a silent no-op (in
a browser tab) or likely finishes the Activity directly (in a TWA) — `findOverlayToClose()` never runs,
and "Back while dialog open" could not be treated as Cancel at all.

**Consequence:** because the dialog keeps one dummy entry armed, `confirmAppExit()`'s single
`history.back()` call may just consume *that* entry, landing back on the app's own true root/launch
entry rather than exiting the TWA outright. In that case, one additional native Back press (a second,
genuine press by the user, not anything this code issues) is needed to actually leave the app. This is
an accepted platform/History-API tradeoff, not a bug: within the constraints below, it is mathematically
impossible to guarantee both "Back while the dialog is open is interceptable as Cancel" *and*
"`confirmAppExit()`'s single `history.back()` always exits immediately" — satisfying the first requires
an armed entry at the moment the dialog is shown; satisfying the second requires no armed entry at that
same moment. There is no way to have both without violating one of the hard rules below.

**The implementation must not** work around this by introducing `history.go()`, a second
`history.back()` call, a `setTimeout`-based forced exit, or any other forced-close mechanism.
"Back = Cancel" while the dialog is open is the higher-priority invariant — it is not to be traded away
to make the Exit button close on the very first attempt in every possible history-stack state.

### Investigated and rejected: dynamic `history.go()` for immediate exit

Before settling on the tradeoff above, a dynamic (not hardcoded) `history.go(-N)` approach was
investigated: record `exitBaselineLength = history.length` once, right after the load-time
`armBackTrap()` call, and have `confirmAppExit()` call `history.go(-exitBaselineLength)` instead of a
plain `history.back()`. Because the re-arm discipline provably pins `history.length` at that baseline
for the app's whole lifetime (verified empirically three separate times — synthetic harness, real-app
local test, and a dedicated probe), this value is a real, dynamically-computed target, not a magic
constant — it would automatically adjust if a future launch context ever had more real entries beneath
the trap.

**This was rejected after direct empirical testing**, not on suspicion alone: `history.go()` targeting
an index outside the document's own pushed-entry stack was tested directly and produces **no `popstate`,
no URL change, no navigation of any kind** — behavior indistinguishable from a plain `history.back()`
already sitting at the bottom of history. The critical insight this confirmed: **the JS History API and
native Android hardware-Back-button behavior are not the same mechanism.** Whatever causes a genuine
hardware Back press at the bottom of a TWA's history to finish the Activity is native-platform
escalation tied to the physical key event — there is no evidence a JS-initiated `history.go()`/
`history.back()` call reaching the same boundary triggers that same escalation, and this environment
cannot verify on-device whether it ever does. Introducing it would add real risk (a second history API
surface to reason about) for a benefit that could not be demonstrated. **`history.go()` remains
off the table** for this feature unless a future investigation produces genuine on-device evidence that
it behaves differently on a real TWA than it does in a standard browser context.

## Race-condition protection

- `armBackTrap()` is a no-op unless `backTrapArmed === false`, so rapid Back presses can never stack up
  more than one outstanding dummy entry.
- Rapid Back presses while the dialog is open never open a second dialog: each one closes the
  (already-open) `exit-confirm-overlay` via `closeExitConfirm()` (the same cancel path), which is a
  terminal action per press — there is nothing left open afterward for a following press to re-trigger
  the dialog from (the next Back after that lands back on "main screen, nothing open" and opens a fresh
  single dialog).
- Once `exitInProgress === true`, the `popstate` listener returns immediately on any further event —
  no repeated `history.back()` calls, no re-opened dialog.

### Recovery after an incomplete exit attempt

`confirmAppExit()`'s single `history.back()` call does not always finish the TWA (see "Accepted
tradeoff" above) — the app can remain alive, sitting at the entry `history.back()` landed on. Real-device
testing surfaced a genuine latent defect here, distinct from the accepted tradeoff: the first line of the
`popstate` handler (`if (exitInProgress) return;`) exits *before* the line that resets `backTrapArmed`,
and nothing anywhere ever resets `exitInProgress` back to `false`. If the app survives the exit attempt
(the common case) and the user doesn't immediately press Back again, **every subsequent Back press for
the rest of that session is silently swallowed** — the guard never recovers, identical to the original
pre-fix bug, even though the user never actually left.

Fix: if a `popstate` is ever observed while `exitInProgress` is still `true`, that is proof the app is
still alive to receive it (a genuinely finished TWA never runs more JS). Treat it as "the exit attempt
didn't complete" — reset `exitInProgress = false` and `backTrapArmed = false`, then re-arm normally, so
the guard resumes protecting the very next Back press instead of staying permanently disabled. This does
not change the exit-immediacy tradeoff — it only prevents the guard from silently dying when that
tradeoff's "one more press" doesn't happen right away.

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
- Back on `setup-screen` (protected pre-main screen) → exit dialog appears; `main-screen` is never shown.
- Back on `profile-screen` (protected pre-main screen) → exit dialog appears; `main-screen` is never shown.
- Back on any other secondary screen (i.e. anything besides `main-screen`/`setup-screen`/`profile-screen`,
  should one ever be added) → returns to `main-screen`, no dialog.
- Back with scanner overlay open → scanner closes, camera stream releases, no dialog.
- Back with confirm-delete modal open → only that modal closes, no dialog.
- Back with a bottom sheet (`gs-overlay`/`fd-overlay`) open → only the sheet closes, no dialog.
- After any overlay closes via Back, a subsequent Back on main screen still opens the exit dialog.
- Normal (non-standalone) mobile browser tab → Back behavior is completely unchanged.

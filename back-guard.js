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
    // Do NOT recover here. This popstate may just be the async echo of
    // confirmAppExit()'s own history.back() call, not a new user action -
    // recovering on it would re-arm the trap before the user's genuine next
    // Back press, reopening the exit dialog in a loop (proven by direct
    // reproduction - see spec's "Recovery after an incomplete exit attempt").
    // Recovery happens only via a real subsequent user interaction, in
    // handleUserInteraction() below.
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

  // A genuine user interaction (pointerdown/touchstart/click) serves two
  // purposes depending on state, and is the ONLY trigger for either - never
  // popstate/pageshow/visibilitychange/focus/DOMContentLoaded/load, which
  // cannot distinguish "the app is still alive" from "the user resumed using
  // it": (1) if a confirmed-exit attempt didn't complete (exitInProgress still
  // true), this interaction proves the user gave up and resumed using the
  // app - reset both flags and re-arm; (2) otherwise, the same defensive
  // backstop from Task 10, in case the load-time arm below wasn't honored by
  // the native back-stack. Persistent (not {once:true}) since purpose (1) can
  // matter at any point in the session, not just the first interaction.
  // armBackTrap() remains the only function that ever calls
  // history.pushState(), so this can never create a duplicate trap entry.
  function handleUserInteraction() {
    if (exitInProgress) {
      exitInProgress = false;
      backTrapArmed = false;
      armBackTrap();
      return;
    }
    armBackTrap();
  }
  ['pointerdown', 'touchstart', 'click'].forEach(function(evt) {
    document.addEventListener(evt, handleUserInteraction, { passive: true });
  });

  // Bug 3 hardening (defensive, NOT a confirmed fix): real-device testing
  // found the load-time arm above can go unhonored by the native back-stack
  // if the user's very first action is the hardware Back button itself
  // (which never fires pointerdown/touchstart/click, so
  // handleUserInteraction can't help in that exact case). None of these are
  // genuine user gestures either, so this may not fully close the gap, but
  // re-arming through the existing idempotent armBackTrap() on these
  // lifecycle signals is free and safe to add.
  document.addEventListener('DOMContentLoaded', function() { armBackTrap(); });
  window.addEventListener('load', function() { armBackTrap(); });
  window.addEventListener('pageshow', function() { armBackTrap(); });
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') armBackTrap();
  });
  window.addEventListener('focus', function() { armBackTrap(); });
})();

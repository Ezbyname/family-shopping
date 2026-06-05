// ── Splash screen: show for 4 s then fade out ──
// Runs inline (no module delay) so the timer starts the instant HTML parses.
(function() {
  var el = document.getElementById('splash-overlay');
  if (!el) return;
  var DISPLAY_MS  = 4000;   // how long the splash is fully visible
  var FADE_MS     = 550;    // must match CSS transition duration
  setTimeout(function() {
    el.classList.add('fade-out');
    setTimeout(function() { el.remove(); }, FADE_MS);
  }, DISPLAY_MS);
})();

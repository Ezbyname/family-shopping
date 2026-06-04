// Unregister stale service workers so new split-file app loads correctly.
// Safe to remove after all users have updated (a few weeks).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => {
      reg.registration && reg.registration.waiting && reg.registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.unregister();
    });
  });
}

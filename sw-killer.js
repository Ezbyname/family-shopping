// Unregister stale service workers so new split-file app loads correctly.
// Uses sessionStorage flag to prevent reload loops.
// Safe to remove after all users have updated (a few weeks).
if ('serviceWorker' in navigator && !sessionStorage.getItem('sw-killed')) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    if (regs.length === 0) return;
    sessionStorage.setItem('sw-killed', '1');
    Promise.all(regs.map(reg => reg.unregister())).then(() => {
      window.location.reload();
    });
  });
}

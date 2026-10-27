// tests/sw-release-gate.test.mjs
// SERVICE WORKER RELEASE GATE — sw.js serves app.js / modules cache-first, so a tab
// opened under the old worker keeps running old code (observed on the phone: the
// clear-location button missing until an Incognito session). The release must:
//   - bump CACHE_VERSION (new sw.js bytes → browser installs the new worker)
//   - reload an already-controlled tab ONCE when the new worker takes control
//   - never reload on first-ever install, never loop
//   - keep skipWaiting / clients.claim / old-cache cleanup / fetch strategy
//
// Runs the REAL _installSwUpdateReload from app.js and the REAL sw.js inside a fake
// service-worker scope. APP_SRC / SW_SRC=<path> point the suite at other copies
// (negative control against the pre-gate baseline).
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const app = readFileSync(process.env.APP_SRC || new URL('../app.js', import.meta.url), 'utf8');
const sw  = readFileSync(process.env.SW_SRC  || new URL('../sw.js',  import.meta.url), 'utf8');

function sliceBody(src, start, label) {
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${label}`);
}
function extractFn(name) {
  const start = app.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  return sliceBody(app, start, name);
}

// ── Page side: the controllerchange reload guard ────────────────────────────
const KEY_DECL = app.match(/const SW_RELOAD_SESSION_KEY\s*=\s*'([^']+)';/);
function makeGuard() {
  if (!KEY_DECL) throw new Error('SW_RELOAD_SESSION_KEY not found in app.js');
  const factory = new Function(`${KEY_DECL[0]}\n${extractFn('_installSwUpdateReload')}
    return { install: _installSwUpdateReload, KEY: SW_RELOAD_SESSION_KEY };`);
  return factory();
}
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}
// One page load: optional existing controller, shared session storage.
function pageLoad({ controller, storage, storageThrows = false }) {
  const { install, KEY } = makeGuard();
  const listeners = [];
  const sw = { controller, addEventListener: (t, fn) => { if (t === 'controllerchange') listeners.push(fn); } };
  let reloads = 0;
  install(sw, () => { if (storageThrows) throw new Error('SecurityError'); return storage; }, () => { reloads++; });
  return { fire: () => listeners.forEach(fn => fn()), reloads: () => reloads, KEY, listeners };
}

// ── Worker side: run sw.js in a fake ServiceWorkerGlobalScope ───────────────
function runSw({ existingCaches = [], cached = {} } = {}) {
  const handlers = {};
  const log = { skipWaiting: 0, claim: 0, deleted: [], opened: [], added: [], put: [], fetched: [] };
  const store = new Map(existingCaches.map(k => [k, new Map()]));
  const caches = {
    open: async name => {
      log.opened.push(name);
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name);
      return { addAll: async urls => { log.added.push(...urls); urls.forEach(u => c.set(u, `shell:${u}`)); },
               put: async (req, res) => { log.put.push(req.url || req); c.set(req.url || req, res); } };
    },
    keys: async () => [...store.keys()],
    delete: async k => { log.deleted.push(k); return store.delete(k); },
    match: async req => {
      const url = typeof req === 'string' ? req : req.url;
      return cached[url] ?? null;
    },
  };
  const self = {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => { log.skipWaiting++; return Promise.resolve(); },
    clients: { claim: () => { log.claim++; return Promise.resolve(); } },
  };
  const fetch = async req => {
    log.fetched.push(typeof req === 'string' ? req : req.url);
    return { ok: true, clone() { return this; }, body: `net:${req.url || req}` };
  };
  new Function('self', 'caches', 'fetch', sw)(self, caches, fetch);
  const cacheVersion = sw.match(/const CACHE_VERSION\s*=\s*'([^']+)'/)?.[1];
  async function dispatch(type, extra = {}) {
    let p = null;
    const ev = { ...extra, waitUntil: x => { p = x; }, respondWith: x => { p = x; } };
    handlers[type](ev);
    return p ? await p : undefined;
  }
  return { handlers, log, store, cacheVersion, dispatch };
}

console.log('\nSERVICE WORKER RELEASE GATE');

// Versions
await test('CACHE_VERSION is fsl-v49', async () => {
  eq(sw.match(/const CACHE_VERSION\s*=\s*'([^']+)'/)?.[1], 'fsl-v49', 'CACHE_VERSION');
});
await test('APP_VERSION is 3.2.5', async () => {
  eq(app.match(/const APP_VERSION\s*=\s*'([^']+)'/)?.[1], '3.2.5', 'APP_VERSION');
});

// Reload guard
await test('existing controller + controllerchange → exactly one reload', async () => {
  const storage = fakeStorage();
  const p = pageLoad({ controller: { id: 'old-sw' }, storage });
  p.fire();
  eq(p.reloads(), 1, 'reloads');
  eq(storage.getItem(p.KEY), '1', 'guard key set');
});
await test('repeated controllerchange in the same page → no second reload', async () => {
  const p = pageLoad({ controller: { id: 'old-sw' }, storage: fakeStorage() });
  p.fire(); p.fire(); p.fire();
  eq(p.reloads(), 1, 'reloads');
});
await test('session guard: reloaded page that sees another controllerchange → no loop', async () => {
  const storage = fakeStorage();
  const first = pageLoad({ controller: { id: 'old-sw' }, storage });
  first.fire();
  eq(first.reloads(), 1, 'first page reloads');
  const second = pageLoad({ controller: { id: 'new-sw' }, storage });  // after reload, same tab session
  second.fire();
  eq(second.reloads(), 0, 'second page must not reload');
});
await test('guard key already set at load → no reload', async () => {
  const { KEY } = makeGuard();
  const p = pageLoad({ controller: { id: 'old-sw' }, storage: fakeStorage({ [KEY]: '1' }) });
  p.fire();
  eq(p.reloads(), 0, 'reloads');
});
await test('no existing controller (first-ever install) → no forced reload', async () => {
  const storage = fakeStorage();
  const p = pageLoad({ controller: null, storage });
  p.fire();
  eq(p.reloads(), 0, 'reloads');
  eq(storage.map.size, 0, 'guard key not consumed');
});
await test('sessionStorage unavailable → no reload (cannot guard against loops)', async () => {
  const p = pageLoad({ controller: { id: 'old-sw' }, storage: null, storageThrows: true });
  p.fire();
  eq(p.reloads(), 0, 'reloads');
});
await test('no controllerchange event → no reload', async () => {
  const p = pageLoad({ controller: { id: 'old-sw' }, storage: fakeStorage() });
  eq(p.listeners.length, 1, 'one listener registered');
  eq(p.reloads(), 0, 'reloads');
});

// Registration wiring
await test('registration still occurs, guard installed BEFORE register()', async () => {
  const block = app.match(/if\s*\(\s*'serviceWorker' in navigator\s*\)\s*\{\s*\n\s*_installSwUpdateReload\([\s\S]*?\n\}/)?.[0];
  ok(block, 'SW block with _installSwUpdateReload not found');
  const iGuard = block.indexOf('_installSwUpdateReload(');
  const iReg   = block.indexOf("navigator.serviceWorker.register('sw.js')");
  ok(iReg > 0, "register('sw.js') missing");
  ok(iGuard >= 0 && iGuard < iReg, 'guard must capture the controller before register()');
  ok(block.includes('window.sessionStorage') && block.includes('window.location.reload()'), 'real storage + reload wired');
});

// sw.js lifecycle (executed)
await test('install: pre-caches app shell into the new cache, then skipWaiting()', async () => {
  const w = runSw();
  await w.dispatch('install');
  eq(w.log.opened[0], 'fsl-v49', 'cache opened');
  for (const a of ['/', '/index.html', '/styles.css', '/app.js', '/appinline.js', '/manifest.json']) {
    ok(w.log.added.includes(a), `app shell missing ${a}`);
  }
  eq(w.log.skipWaiting, 1, 'skipWaiting');
});
await test('app shell includes every ./js/*.js module app.js imports statically', async () => {
  const w = runSw();
  await w.dispatch('install');
  const imported = [...new Set([...app.matchAll(/from '\.\/js\/([a-z0-9-]+\.js)'/g)].map(m => `/js/${m[1]}`))];
  ok(imported.length >= 5, `expected several module imports, got ${imported.length}`);
  const missing = imported.filter(u => !w.log.added.includes(u));
  eq(missing.length, 0, `missing from APP_SHELL: ${missing.join(', ')}`);
});
await test('activate: deletes every old cache, keeps fsl-v49, then clients.claim()', async () => {
  const w = runSw({ existingCaches: ['fsl-v44', 'fsl-v48', 'fsl-v49', 'other'] });
  await w.dispatch('activate');
  eq(JSON.stringify(w.log.deleted.sort()), JSON.stringify(['fsl-v44', 'fsl-v48', 'other']), 'deleted');
  ok(w.store.has('fsl-v49'), 'current cache kept');
  eq(w.log.claim, 1, 'clients.claim');
});
await test('fetch strategy unchanged: navigation network-first, assets cache-first, /api/ bypassed', async () => {
  const origin = 'https://fs.example';
  const w = runSw({ cached: { [`${origin}/app.js`]: 'cached-app-js' } });
  const nav = await w.dispatch('fetch', { request: { method: 'GET', url: `${origin}/`, mode: 'navigate' } });
  eq(nav.body, `net:${origin}/`, 'navigation from network');
  const asset = await w.dispatch('fetch', { request: { method: 'GET', url: `${origin}/app.js`, mode: 'no-cors' } });
  eq(asset, 'cached-app-js', 'asset from cache');
  ok(!w.log.fetched.includes(`${origin}/app.js`), 'cached asset must not hit network');
  let responded = false;
  w.handlers.fetch({ request: { method: 'GET', url: `${origin}/api/prices?x=1` }, respondWith: () => { responded = true; } });
  eq(responded, false, '/api/ not intercepted');
});
await test('GET_CACHE_VERSION diag reply reports fsl-v49', async () => {
  const w = runSw();
  let reply = null;
  w.handlers.message({ data: { type: 'GET_CACHE_VERSION' }, source: { postMessage: m => { reply = m; } } });
  eq(reply?.version, 'fsl-v49', 'reply');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

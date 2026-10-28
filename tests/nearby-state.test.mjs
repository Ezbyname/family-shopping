// tests/nearby-state.test.mjs
// FS-RADIUS-001 — _nearbyMode was never saved, so every app restart silently reset the
// nearby toggle to OFF while the saved location and radius survived; list price chips
// then fetched nationwide prices for a user who had configured a radius.
//
// Runs the REAL _initNearbyState IIFE, toggleNearbyMode and clearLocation extracted from
// app.js against a fake localStorage, plus the pure helpers from js/nearby-state.js.
// APP_SRC=<path> runs the wiring tests against another copy of app.js (negative control);
// the helper module is always taken from this tree so failures there are app.js wiring.
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const app = readFileSync(process.env.APP_SRC || new URL('../app.js', import.meta.url), 'utf8');
const ns  = await import('../js/nearby-state.js');

function sliceBody(start, label) {
  let i = app.indexOf('{', app.indexOf(')', start)), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${label}`);
}
function extractWindowFn(name) {
  const start = app.search(new RegExp(`window\\.${name}\\s*=\\s*(async\\s+)?function\\s*\\(`));
  if (start < 0) throw new Error(`window.${name} not found in app.js`);
  return sliceBody(start, name) + ';';
}
function extractInit() {
  const start = app.indexOf('(function _initNearbyState()');
  if (start < 0) throw new Error('_initNearbyState not found in app.js');
  return sliceBody(start + 1, '_initNearbyState').replace(/^/, '(') + ')();';
}

const LOC   = { label: 'הרצל 1, חיפה', address: 'הרצל 1 חיפה', lat: 32.794, lng: 34.9896, source: 'manual' };
const GPS   = { label: 'המיקום שלי עכשיו', lat: 32.08, lng: 34.78, source: 'gps' };

function fakeStorage(init = {}, { throws = false } = {}) {
  const m = new Map(Object.entries(init).filter(([, v]) => v !== undefined));
  const log = { reads: [], writes: [] };
  return {
    map: m, log,
    getItem: k => { if (throws) throw new Error('SecurityError'); log.reads.push(k); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error('SecurityError'); log.writes.push(k); m.set(k, String(v)); },
    removeItem: k => { if (throws) throw new Error('SecurityError'); log.writes.push(k); m.delete(k); },
  };
}

// One app start: the real module-level declarations + _initNearbyState, then the real
// toggle / clear handlers sharing that scope.
function boot(storage) {
  const win = {}, ui = { syncs: 0, dropdowns: 0, searches: 0, timers: [] };
  const factory = new Function('localStorage', 'window', 'ui', 'NEARBY_MODE_KEY', 'restoreNearbyMode', 'persistNearbyMode', `
    const NEARBY_COORDS_READY = true;
    let _nearbyMode = false, _selectedLocation = null, _nearbyRadius = 3;
    let _radiusExplicitlySet = localStorage.getItem('nearbyRadius') !== null;
    let _recentLocations = [];
    let _pdGpsState = 'idle', _pdGpsError = null;
    const _pdBarcode = null, lastSearchQuery = '';
    const document = { getElementById: () => null };
    const setTimeout = (fn) => { ui.timers.push(fn); };
    const _hasLoc = () => Boolean(_nearbyMode && _selectedLocation?.lat);
    const _syncNearbyUI = () => { ui.syncs++; };
    const toggleLocDropdown = () => { ui.dropdowns++; };
    const toast = () => {};
    const searchPrices = () => { ui.searches++; };
    ${extractInit()}
    ${extractWindowFn('toggleNearbyMode')}
    ${extractWindowFn('clearLocation')}
    return () => ({ mode: _nearbyMode, loc: _selectedLocation, radius: _nearbyRadius,
                    radiusExplicit: _radiusExplicitlySet, recents: _recentLocations });`);
  const state = factory(storage, win, ui, ns.NEARBY_MODE_KEY, ns.restoreNearbyMode, ns.persistNearbyMode);
  ui.timers.splice(0).forEach(fn => fn());
  return { state, win, ui, storage };
}
const saved = (loc) => JSON.stringify(loc);

console.log('\nFS-RADIUS-001 — nearby mode persists across restarts');

// ── Restore on restart ──────────────────────────────────────────────────────
await test('nearbyMode=true + valid saved location → restored ON after restart', async () => {
  const a = boot(fakeStorage({ nearbyMode: 'true', selectedLocation: saved(LOC), nearbyRadius: '10' }));
  eq(a.state().mode, true, 'mode');
  eq(a.state().loc.label, LOC.label, 'location');
  ok(a.ui.syncs >= 1, 'nearby UI synced so the toggle shows ON');
});
await test('GPS saved location is restored the same way', async () => {
  eq(boot(fakeStorage({ nearbyMode: 'true', selectedLocation: saved(GPS) })).state().mode, true);
});
await test('nearbyMode absent (OFF) → stays OFF', async () => {
  const a = boot(fakeStorage({ selectedLocation: saved(LOC) }));
  eq(a.state().mode, false, 'mode'); eq(a.ui.syncs, 0, 'no startup UI change');
});
await test('nearbyMode="false" → stays OFF', async () => {
  eq(boot(fakeStorage({ nearbyMode: 'false', selectedLocation: saved(LOC) })).state().mode, false);
});
await test('saved nearbyMode=true but NO saved location → nearby mode does not activate', async () => {
  const a = boot(fakeStorage({ nearbyMode: 'true' }));
  eq(a.state().mode, false, 'mode'); eq(a.state().loc, null, 'location');
  eq(a.storage.map.get('nearbyMode'), 'true', 'preference itself is kept, not erased at startup');
});
await test('saved nearbyMode=true + corrupt / coordinate-less location → OFF, no throw', async () => {
  for (const sl of ['{not json', saved({ label: 'x' }), saved({ lat: '32.1', lng: '34.8' }), saved({ lat: NaN, lng: 1 }), 'null']) {
    eq(boot(fakeStorage({ nearbyMode: 'true', selectedLocation: sl })).state().mode, false, `location ${sl}`);
  }
});
await test('malformed / unknown stored nearbyMode values fail safe to OFF', async () => {
  for (const v of ['TRUE', 'True', '1', 'yes', 'on', '{}', '', ' true', 'true ']) {
    eq(boot(fakeStorage({ nearbyMode: v, selectedLocation: saved(LOC) })).state().mode, false, `value ${JSON.stringify(v)}`);
  }
});
await test('first-time user (empty storage) → current defaults: OFF, radius 3, no location, nothing written', async () => {
  const a = boot(fakeStorage());
  const s = a.state();
  eq(s.mode, false); eq(s.radius, 3); eq(s.loc, null); eq(s.radiusExplicit, false);
  eq(a.storage.log.writes.length, 0, 'startup writes nothing');
});
await test('reading the nearbyMode key throws → OFF, startup does not throw', async () => {
  const st = fakeStorage({ selectedLocation: saved(LOC), nearbyRadius: '10' });
  const get = st.getItem;
  st.getItem = k => { if (k === 'nearbyMode') throw new Error('SecurityError'); return get(k); };
  const s = boot(st).state();
  eq(s.mode, false, 'mode'); eq(s.radius, 10, 'rest of startup intact'); eq(s.loc.label, LOC.label);
});

// ── Radius / city independence ──────────────────────────────────────────────
await test('radius preference is preserved independently of nearby mode', async () => {
  const off = boot(fakeStorage({ nearbyRadius: '25', selectedLocation: saved(LOC) })).state();
  eq(off.mode, false); eq(off.radius, 25); eq(off.radiusExplicit, true);
  const on = boot(fakeStorage({ nearbyMode: 'true', nearbyRadius: '10', selectedLocation: saved(LOC) })).state();
  eq(on.mode, true); eq(on.radius, 10);
  const bad = boot(fakeStorage({ nearbyMode: 'true', nearbyRadius: '7', selectedLocation: saved(LOC) })).state();
  eq(bad.mode, true, 'invalid radius does not affect mode'); eq(bad.radius, 3, 'invalid radius → default');
});
await test('city mode unaffected: startup never reads or writes city keys', async () => {
  const st = fakeStorage({ nearbyMode: 'true', selectedLocation: saved(LOC), priceFilterCities: '["חיפה"]' });
  boot(st);
  ok(!st.log.reads.includes('priceFilterCities'), 'cities not read by nearby init');
  ok(!st.log.writes.includes('priceFilterCities'), 'cities not written');
  eq(st.map.get('priceFilterCities'), '["חיפה"]', 'cities intact');
});

// ── Persist on toggle ───────────────────────────────────────────────────────
await test('toggle ON persists "true"; toggle OFF removes the key', async () => {
  const a = boot(fakeStorage({ selectedLocation: saved(LOC) }));
  a.win.toggleNearbyMode();
  eq(a.state().mode, true); eq(a.storage.map.get('nearbyMode'), 'true', 'stored ON');
  a.win.toggleNearbyMode();
  eq(a.state().mode, false); ok(!a.storage.map.has('nearbyMode'), 'key removed when OFF');
});
await test('toggle → restart round trip keeps the user choice', async () => {
  const st = fakeStorage({ selectedLocation: saved(LOC), nearbyRadius: '5' });
  boot(st).win.toggleNearbyMode();
  const s = boot(st).state();
  eq(s.mode, true, 'restored ON'); eq(s.radius, 5, 'radius kept');
  boot(st).win.toggleNearbyMode();   // restored ON → OFF
  eq(boot(st).state().mode, false, 'restored OFF');
});
await test('toggle ON without a location still opens the location picker (unchanged)', async () => {
  const a = boot(fakeStorage());
  a.win.toggleNearbyMode();
  eq(a.ui.dropdowns, 1, 'dropdown opened');
});
await test('toggle never throws when storage writes fail', async () => {
  const st = fakeStorage({ selectedLocation: saved(LOC) });
  const a = boot(st);
  st.setItem = () => { throw new Error('QuotaExceeded'); };
  a.win.toggleNearbyMode();
  eq(a.state().mode, true, 'in-memory toggle still works');
});

// ── clearLocation keeps the preference (3.2.5 behaviour) ───────────────────
await test('clearLocation keeps nearby mode and the stored preference; restart then waits for a location', async () => {
  const st = fakeStorage({ nearbyMode: 'true', selectedLocation: saved(LOC), nearbyRadius: '10' });
  const a = boot(st);
  a.win.clearLocation();
  eq(a.state().loc, null, 'location cleared'); ok(!st.map.has('selectedLocation'), 'location key removed');
  eq(a.state().mode, true, 'in-session nearby mode unchanged');
  eq(st.map.get('nearbyMode'), 'true', 'stored preference unchanged');
  eq(st.map.get('nearbyRadius'), '10', 'radius unchanged');
  eq(boot(st).state().mode, false, 'restart without location → not active');
  st.setItem('selectedLocation', saved(GPS));         // user picks a location again
  eq(boot(st).state().mode, true, 'preference applies once a location exists');
});
await test('clearLocation source does not touch nearby mode', async () => {
  const body = extractWindowFn('clearLocation');
  ok(!/_nearbyMode\s*=/.test(body), 'clearLocation assigns _nearbyMode');
  ok(!body.includes('nearbyMode') && !body.includes('NEARBY_MODE_KEY'), 'clearLocation touches the nearby key');
});

// ── Pure helpers ────────────────────────────────────────────────────────────
await test('helpers: key, validation, restore, persist', async () => {
  eq(ns.NEARBY_MODE_KEY, 'nearbyMode');
  eq(ns.nearbyHasValidLocation(LOC), true); eq(ns.nearbyHasValidLocation(null), false);
  eq(ns.nearbyHasValidLocation({ lat: Infinity, lng: 1 }), false);
  eq(ns.restoreNearbyMode('true', LOC), true); eq(ns.restoreNearbyMode('true', null), false);
  eq(ns.restoreNearbyMode(null, LOC), false);
  const st = fakeStorage();
  ns.persistNearbyMode(st, true);  eq(st.map.get('nearbyMode'), 'true');
  ns.persistNearbyMode(st, false); ok(!st.map.has('nearbyMode'));
  ns.persistNearbyMode(fakeStorage({}, { throws: true }), true);   // must not throw
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

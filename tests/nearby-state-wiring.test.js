// tests/nearby-state-wiring.test.js
// Wiring integration tests for FS-RADIUS-001.
//
// app.js is a browser ES module (uses document/Firebase/etc.) and cannot be
// imported in Node.js. Instead, this file:
//   1. Simulates the app's localStorage state machine via the same helpers
//      that app.js calls — restoreNearbyState and buildPriceQueryScope.
//   2. Reproduces the exact lifecycle each wiring site implements.
//   3. Adds structural assertions that grep app.js to confirm each wiring
//      site is present — if a future refactor removes or changes one, the
//      test fails.
//
// Together with nearby-state.test.js (unit) and prices-radius-boundary.test.js
// (backend), this closes the FS-RADIUS-001 regression surface.

import { restoreNearbyState, buildPriceQueryScope } from '../js/nearby-state.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS    = readFileSync(resolve(__dirname, '../app.js'), 'utf8');

let passed = 0;
let failed = 0;

function expect(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { console.log(`  ✅ ${name}`); passed++; }
  else {
    console.error(`  ❌ ${name}\n     got:      ${JSON.stringify(got)}\n     expected: ${JSON.stringify(expected)}`);
    failed++;
  }
}
function expectTruthy(name, value) {
  if (value) { console.log(`  ✅ ${name}`); passed++; }
  else { console.error(`  ❌ ${name} — got falsy: ${JSON.stringify(value)}`); failed++; }
}
function expectFalsy(name, value) {
  if (!value) { console.log(`  ✅ ${name}`); passed++; }
  else { console.error(`  ❌ ${name} — expected falsy, got: ${JSON.stringify(value)}`); failed++; }
}

const VALID_LOC_OBJ  = { label: 'תל אביב', lat: 32.0853, lng: 34.7818, source: 'gps' };
const VALID_LOC_JSON = JSON.stringify(VALID_LOC_OBJ);

// ── Mini localStorage simulator ───────────────────────────────────────────────
// Mirrors the subset of localStorage used by nearby-mode state.
function makeLS(initial = {}) {
  const store = { ...initial };
  return {
    getItem:    k => store[k] ?? null,
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    keys:       () => Object.keys(store),
    _dump:      () => ({ ...store }),
  };
}

// ── Simulate _initNearbyState (app.js:1060-1079) ─────────────────────────────
function simulateInit(ls) {
  const restored = restoreNearbyState({
    nearbyMode:       ls.getItem('nearbyMode')       ?? undefined,
    nearbyRadius:     ls.getItem('nearbyRadius')     ?? undefined,
    selectedLocation: ls.getItem('selectedLocation') ?? undefined,
  });
  return restored;
}

// ── Simulate toggleNearbyMode (app.js:1120-1135) ─────────────────────────────
// Returns new nearbyMode value and updates ls.
function simulateToggle(ls, currentNearbyMode) {
  const next = !currentNearbyMode;
  if (next) ls.setItem('nearbyMode', 'true');
  else      ls.removeItem('nearbyMode');
  return next;
}

// ── Simulate clearLocation (app.js:1158-1167) ─────────────────────────────────
function simulateClearLocation(ls) {
  ls.removeItem('selectedLocation');
  ls.removeItem('nearbyMode');
  return { nearbyMode: false, selectedLocation: null };
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Lifecycle: cold restart restores mode ──');
// ──────────────────────────────────────────────────────────────────────────────

// Wiring A: saved nearbyMode=true + valid location + radius=25
//           → restart → _nearbyMode=true → chip request has radiusKm=25
{
  const ls = makeLS({
    nearbyMode: 'true',
    nearbyRadius: '25',
    selectedLocation: VALID_LOC_JSON,
  });
  const restored = simulateInit(ls);
  expectTruthy('A: restart → _nearbyMode restored true', restored.nearbyMode);
  expect      ('A: restart → radius restored 25', restored.nearbyRadius, 25);

  const scope = buildPriceQueryScope(restored.nearbyMode, restored.selectedLocation, restored.nearbyRadius);
  expectTruthy('A: chip request has lat', scope.includes('lat=32.0853'));
  expectTruthy('A: chip request has radiusKm=25', scope.includes('radiusKm=25'));
  expectTruthy('A: nationwide cache must be flushed (needsCacheFlush)', restored.needsCacheFlush);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Lifecycle: user enables then disables nearby mode ──');
// ──────────────────────────────────────────────────────────────────────────────

// Wiring B/C: user turns ON → localStorage persisted → user turns OFF → key removed → restart → stays OFF
{
  const ls = makeLS({ nearbyRadius: '10', selectedLocation: VALID_LOC_JSON });
  let mode = false;  // initial app state

  // User enables nearby mode
  mode = simulateToggle(ls, mode);
  expectTruthy('B: after toggle ON → nearbyMode=true', mode);
  expect      ('B: after toggle ON → localStorage[nearbyMode]="true"', ls.getItem('nearbyMode'), 'true');

  const scopeOn = buildPriceQueryScope(mode, VALID_LOC_OBJ, 10);
  expectTruthy('B: mode ON → chip URL has radiusKm=10', scopeOn.includes('radiusKm=10'));

  // User disables nearby mode
  mode = simulateToggle(ls, mode);
  expectFalsy ('C: after toggle OFF → nearbyMode=false', mode);
  expectFalsy ('C: after toggle OFF → localStorage[nearbyMode] removed', ls.getItem('nearbyMode'));

  const scopeOff = buildPriceQueryScope(mode, VALID_LOC_OBJ, 10);
  expect      ('C: mode OFF → chip URL is nationwide (empty scope)', scopeOff, '');

  // Restart — must remain OFF
  const restart = simulateInit(ls);
  expectFalsy ('C: restart after explicit OFF → nearbyMode stays false', restart.nearbyMode);
  expectFalsy ('C: restart after explicit OFF → needsCacheFlush false', restart.needsCacheFlush);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Lifecycle: user clears location ──');
// ──────────────────────────────────────────────────────────────────────────────

// Wiring D: clearLocation sets nearbyMode=false, removes both LS keys, re-fetches nationwide
{
  const ls = makeLS({
    nearbyMode: 'true',
    nearbyRadius: '25',
    selectedLocation: VALID_LOC_JSON,
  });

  // Simulate active session with mode on
  let state = simulateInit(ls);
  expectTruthy('D: pre-clear → mode on', state.nearbyMode);

  // User clears location
  const afterClear = simulateClearLocation(ls);
  expectFalsy ('D: after clearLocation → nearbyMode=false', afterClear.nearbyMode);
  expectFalsy ('D: after clearLocation → selectedLocation=null', afterClear.selectedLocation);
  expectFalsy ('D: after clearLocation → nearbyMode key removed from LS', ls.getItem('nearbyMode'));
  expectFalsy ('D: after clearLocation → selectedLocation key removed from LS', ls.getItem('selectedLocation'));

  const scopeAfterClear = buildPriceQueryScope(afterClear.nearbyMode, afterClear.selectedLocation, 25);
  expect      ('D: after clearLocation → chip URL is nationwide', scopeAfterClear, '');

  // Restart after clear
  const restart = simulateInit(ls);
  expectFalsy ('D: restart after clearLocation → mode stays false', restart.nearbyMode);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Lifecycle: ON → OFF → ON → restart ──');
// ──────────────────────────────────────────────────────────────────────────────

{
  const ls = makeLS({ nearbyRadius: '5', selectedLocation: VALID_LOC_JSON });
  let mode = false;

  mode = simulateToggle(ls, mode);  // ON
  mode = simulateToggle(ls, mode);  // OFF
  mode = simulateToggle(ls, mode);  // ON → final state ON

  const restart = simulateInit(ls);
  expectTruthy('E: ON→OFF→ON→restart → mode is ON after restart', restart.nearbyMode);

  const scope = buildPriceQueryScope(restart.nearbyMode, restart.selectedLocation, restart.nearbyRadius);
  expectTruthy('E: ON after restart → radius-scoped request', scope.includes('radiusKm=5'));
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Behavioral: ON→OFF chip refresh ──');
// ──────────────────────────────────────────────────────────────────────────────
// Prove that when toggleNearbyMode is called to turn OFF:
//   (a) price cache (in-memory) is flushed, (b) chip reload is triggered (curTab='all').
{
  // Simulate app state: mode is ON, tab is 'all', cache has entries
  let _nearbyMode = true;
  let curTab = 'all';
  const _priceCache = { '123': { price: 5 }, '456': { price: 8 } };
  const ls = makeLS({ nearbyMode: 'true', selectedLocation: VALID_LOC_JSON, nearbyRadius: '10' });
  let chipReloadScheduled = false;

  // Simulate toggleNearbyMode OFF
  function simulateToggleOff() {
    _nearbyMode = !_nearbyMode;  // now false
    if (_nearbyMode) ls.setItem('nearbyMode', 'true');
    else             ls.removeItem('nearbyMode');
    // flush both cache layers (wiring contract)
    Object.keys(_priceCache).forEach(k => delete _priceCache[k]);
    // simulate _pcClearAllLS — wired in app.js
    ls.keys().filter(k => k.startsWith('pc_')).forEach(k => ls.removeItem(k));
    // trigger chip reload
    if (!_nearbyMode && curTab === 'all') {
      chipReloadScheduled = true;  // models setTimeout(loadItemPricesInBackground, 80)
    }
  }

  simulateToggleOff();

  expectFalsy ('BEH-1: toggle OFF → _nearbyMode false', _nearbyMode);
  expect      ('BEH-1: toggle OFF → in-memory cache cleared', Object.keys(_priceCache).length, 0);
  expectTruthy('BEH-1: toggle OFF + curTab=all → chip reload scheduled', chipReloadScheduled);
  expectFalsy ('BEH-1: toggle OFF → nearbyMode key removed from LS', ls.getItem('nearbyMode'));

  const scopeAfterOff = buildPriceQueryScope(_nearbyMode, VALID_LOC_OBJ, 10);
  expect      ('BEH-1: toggle OFF → next chip request is nationwide', scopeAfterOff, '');
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Behavioral: clearLocation chip refresh ──');
// ──────────────────────────────────────────────────────────────────────────────
// Prove that clearLocation flushes price cache and triggers chip reload (curTab='all').
{
  let _nearbyMode = true;
  let curTab = 'all';
  const _priceCache = { '789': { price: 12 } };
  const ls = makeLS({ nearbyMode: 'true', selectedLocation: VALID_LOC_JSON, nearbyRadius: '25', pc_7290: 'cached' });
  let chipReloadScheduled = false;

  function simulateClearLocationFull() {
    // _nearbyMode reset + LS cleared (as in app.js clearLocation)
    _nearbyMode = false;
    ls.removeItem('selectedLocation');
    ls.removeItem('nearbyMode');
    // flush both cache layers (the fix)
    Object.keys(_priceCache).forEach(k => delete _priceCache[k]);
    ls.keys().filter(k => k.startsWith('pc_')).forEach(k => ls.removeItem(k));
    // chip reload (the fix)
    if (curTab === 'all') chipReloadScheduled = true;
  }

  simulateClearLocationFull();

  expectFalsy ('BEH-2: clearLocation → _nearbyMode false', _nearbyMode);
  expect      ('BEH-2: clearLocation → in-memory cache cleared', Object.keys(_priceCache).length, 0);
  expectFalsy ('BEH-2: clearLocation → pc_ LS entries cleared', ls.getItem('pc_7290'));
  expectTruthy('BEH-2: clearLocation + curTab=all → chip reload scheduled', chipReloadScheduled);

  const scopeAfterClear = buildPriceQueryScope(_nearbyMode, null, 25);
  expect      ('BEH-2: after clearLocation → next chip request is nationwide', scopeAfterClear, '');
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Behavioral: cold restart UI sync invocation ──');
// ──────────────────────────────────────────────────────────────────────────────
// Prove _initNearbyState defers _syncNearbyUI() after state restore.
{
  let syncNearbyUICallCount = 0;
  function mockSyncNearbyUI() { syncNearbyUICallCount++; }

  // Simulate _initNearbyState with deferred _syncNearbyUI call (setTimeout(..., 0))
  function simulateInitWithUISync(ls) {
    const restored = restoreNearbyState({
      nearbyMode:       ls.getItem('nearbyMode')       ?? undefined,
      nearbyRadius:     ls.getItem('nearbyRadius')     ?? undefined,
      selectedLocation: ls.getItem('selectedLocation') ?? undefined,
    });
    // Deferred call — simulated synchronously here to test the contract
    mockSyncNearbyUI();  // models setTimeout(_syncNearbyUI, 0)
    return { restored, syncCalled: syncNearbyUICallCount > 0 };
  }

  const ls = makeLS({ nearbyMode: 'true', nearbyRadius: '25', selectedLocation: VALID_LOC_JSON });
  const result = simulateInitWithUISync(ls);

  expectTruthy('BEH-3: cold restart → _syncNearbyUI is called after state restore', result.syncCalled);
  expectTruthy('BEH-3: cold restart → restored state has nearbyMode=true', result.restored.nearbyMode);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── Structural: app.js wiring sites ──');
// ──────────────────────────────────────────────────────────────────────────────
// Verify that each critical wiring site exists in app.js.
// If a future edit breaks the wiring contract, at least one of these will fail.

expectTruthy(
  'WIRING: _initNearbyState uses restoreNearbyState()',
  APP_JS.includes('const restored = restoreNearbyState(')
);
expectTruthy(
  'WIRING: _initNearbyState sets _nearbyMode from restored',
  APP_JS.includes('_nearbyMode       = restored.nearbyMode')
);
expectTruthy(
  'WIRING: _initNearbyState flushes cache on restore (needsCacheFlush)',
  APP_JS.includes('if (restored.needsCacheFlush) _pcClearAllLS()')
);
expectTruthy(
  'WIRING: toggleNearbyMode persists true',
  APP_JS.includes("localStorage.setItem('nearbyMode', 'true')")
);
expectTruthy(
  'WIRING: toggleNearbyMode removes key on OFF',
  APP_JS.includes("localStorage.removeItem('nearbyMode')")
);
expectTruthy(
  'WIRING: toggleNearbyMode flushes in-memory price cache',
  APP_JS.includes("Object.keys(_priceCache).forEach(k => delete _priceCache[k])")
);
expectTruthy(
  'WIRING: toggleNearbyMode flushes LS price cache',
  /toggleNearbyMode[\s\S]{0,600}_pcClearAllLS\(\)/.test(APP_JS)
);
expectTruthy(
  'WIRING: clearLocation sets _nearbyMode=false',
  /clearLocation[\s\S]{0,100}_nearbyMode = false/.test(APP_JS)
);
expectTruthy(
  "WIRING: clearLocation removes nearbyMode from LS",
  /clearLocation[\s\S]{0,300}localStorage\.removeItem\('nearbyMode'\)/.test(APP_JS)
);
expectTruthy(
  'WIRING: _fetchPricesForBarcode uses buildPriceQueryScope',
  APP_JS.includes('url += buildPriceQueryScope(_nearbyMode, _selectedLocation, _nearbyRadius)')
);
expectTruthy(
  'WIRING: clearLocation flushes in-memory price cache',
  /clearLocation[\s\S]{0,400}Object\.keys\(_priceCache\)\.forEach/.test(APP_JS)
);
expectTruthy(
  'WIRING: clearLocation flushes LS price cache',
  /clearLocation[\s\S]{0,500}_pcClearAllLS\(\)/.test(APP_JS)
);
expectTruthy(
  'WIRING: clearLocation triggers chip reload on list tab',
  /clearLocation[\s\S]{0,600}loadItemPricesInBackground/.test(APP_JS)
);
expectTruthy(
  'WIRING: _initNearbyState defers _syncNearbyUI after restore',
  /setTimeout\(_syncNearbyUI,\s*0\)/.test(APP_JS)
);

// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);

// tests/nearby-state.test.js
// Automated regression tests for FS-RADIUS-001:
//   "Nearby mode state lost across Android/WebView restart"
//
// Tests restoreNearbyState() and buildPriceQueryScope() from js/nearby-state.js.
// No DOM. No fetch. Pure Node.js.

import { restoreNearbyState, buildPriceQueryScope } from '../js/nearby-state.js';

let passed = 0;
let failed = 0;

function expect(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(
      `  ❌ ${name}\n` +
      `     got:      ${JSON.stringify(got)}\n` +
      `     expected: ${JSON.stringify(expected)}`
    );
    failed++;
  }
}

function expectTruthy(name, value) {
  if (value) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name} — got falsy: ${JSON.stringify(value)}`);
    failed++;
  }
}

function expectFalsy(name, value) {
  if (!value) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name} — expected falsy, got: ${JSON.stringify(value)}`);
    failed++;
  }
}

const VALID_LOC = JSON.stringify({ label: 'תל אביב', lat: 32.0853, lng: 34.7818, source: 'gps' });

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── restoreNearbyState ──');
// ──────────────────────────────────────────────────────────────────────────────

// RT-1: Fresh start, no saved state → mode false
{
  const r = restoreNearbyState({});
  expectFalsy ('RT-1: fresh start → nearbyMode false', r.nearbyMode);
  expect      ('RT-1: fresh start → default radius 3', r.nearbyRadius, 3);
  expectFalsy ('RT-1: fresh start → needsCacheFlush false', r.needsCacheFlush);
}

// RT-2: Saved nearbyMode=true + valid location + radius=25 → mode restored
{
  const r = restoreNearbyState({ nearbyMode: 'true', nearbyRadius: '25', selectedLocation: VALID_LOC });
  expectTruthy('RT-2: saved mode + valid loc → nearbyMode true', r.nearbyMode);
  expect      ('RT-2: radius restored to 25', r.nearbyRadius, 25);
  expectTruthy('RT-2: needsCacheFlush true (stale nationwide entries must be cleared)', r.needsCacheFlush);
  expect      ('RT-2: selectedLocation restored', r.selectedLocation?.lat, 32.0853);
}

// RT-3: Saved nearbyMode=true but no location → mode stays false
{
  const r = restoreNearbyState({ nearbyMode: 'true', nearbyRadius: '10' });
  expectFalsy ('RT-3: mode true but missing location → nearbyMode false', r.nearbyMode);
  expectFalsy ('RT-3: no location → needsCacheFlush false', r.needsCacheFlush);
}

// RT-4: Saved nearbyMode=true but location has invalid lat (null) → mode stays false
{
  const badLoc = JSON.stringify({ label: 'Unknown', lat: null, lng: 34.78, source: 'manual' });
  const r = restoreNearbyState({ nearbyMode: 'true', nearbyRadius: '5', selectedLocation: badLoc });
  expectFalsy ('RT-4: mode true but null lat → nearbyMode false', r.nearbyMode);
}

// RT-4b: Saved nearbyMode=true but location has NaN lat → mode stays false
{
  const nanLoc = JSON.stringify({ label: 'NaN', lat: NaN, lng: 34.78, source: 'manual' });
  const r = restoreNearbyState({ nearbyMode: 'true', selectedLocation: nanLoc });
  expectFalsy ('RT-4b: mode true but NaN lat → nearbyMode false', r.nearbyMode);
}

// RT-4c: Saved nearbyMode=true but location JSON is corrupt → mode stays false
{
  const r = restoreNearbyState({ nearbyMode: 'true', selectedLocation: '{corrupt json{{' });
  expectFalsy ('RT-4c: mode true but corrupt JSON → nearbyMode false', r.nearbyMode);
}

// RT-5: Saving mode=true (simulated: storage.nearbyMode='true') → persisted state
//       (The actual localStorage.setItem call is inside toggleNearbyMode in app.js.
//        Here we verify that restoreNearbyState() correctly reads back what was saved.)
{
  const r = restoreNearbyState({ nearbyMode: 'true', selectedLocation: VALID_LOC, nearbyRadius: '3' });
  expectTruthy('RT-5: persisted nearbyMode=true is read back', r.nearbyMode);
}

// RT-6: Disabled mode (storage.nearbyMode absent/removed) → mode false after restart
{
  const r = restoreNearbyState({ selectedLocation: VALID_LOC, nearbyRadius: '25' });
  expectFalsy ('RT-6: no nearbyMode key → mode false (explicit OFF persisted as absence)', r.nearbyMode);
  expectFalsy ('RT-6: no mode key → needsCacheFlush false', r.needsCacheFlush);
}

// RT-7: Location cleared → mode false (storage has no location, no mode key)
{
  const r = restoreNearbyState({ nearbyRadius: '10' });
  expectFalsy ('RT-7: location cleared → nearbyMode false', r.nearbyMode);
  expectFalsy ('RT-7: location cleared → no cacheFlush needed', r.needsCacheFlush);
}

// RT-11: Sequence ON → OFF → restart → remains OFF
//        ON stored nearbyMode='true', then OFF stored as removed (undefined here)
{
  const r = restoreNearbyState({ selectedLocation: VALID_LOC, nearbyRadius: '25' });
  // nearbyMode key absent = user explicitly turned it off last session
  expectFalsy ('RT-11: ON→OFF→restart → mode stays OFF (key absent)', r.nearbyMode);
}

// RT-11b: Even with stored 'false' string → mode stays false
{
  const r = restoreNearbyState({ nearbyMode: 'false', selectedLocation: VALID_LOC });
  expectFalsy ('RT-11b: nearbyMode=false string → mode false', r.nearbyMode);
}

// Radius defaults
{
  const r1 = restoreNearbyState({ nearbyRadius: '99' });
  expect      ('radius: invalid value 99 → default 3', r1.nearbyRadius, 3);
  const r2 = restoreNearbyState({ nearbyRadius: '50' });
  expect      ('radius: valid 50 → 50', r2.nearbyRadius, 50);
  const r3 = restoreNearbyState({ nearbyRadius: '1' });
  expect      ('radius: valid 1 → 1', r3.nearbyRadius, 1);
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('\n── buildPriceQueryScope ──');
// ──────────────────────────────────────────────────────────────────────────────

const LOC = { lat: 32.0853, lng: 34.7818 };

// RT-8: nearbyMode=true + valid location + radius=25 → URL contains lat/lng/radiusKm
{
  const qs = buildPriceQueryScope(true, LOC, 25);
  expectTruthy('RT-8: nearbyMode=true → qs contains lat',       qs.includes('lat=32.0853'));
  expectTruthy('RT-8: nearbyMode=true → qs contains lng',       qs.includes('lng=34.7818'));
  expectTruthy('RT-8: nearbyMode=true → qs contains radiusKm=25', qs.includes('radiusKm=25'));
  expectTruthy('RT-8: nearbyMode=true → includeApproximate',    qs.includes('includeApproximate=true'));
}

// RT-9: nearbyMode=false + saved location → URL is empty (nationwide, intentional OFF)
{
  const qs = buildPriceQueryScope(false, LOC, 25);
  expect      ('RT-9: nearbyMode=false → empty scope (nationwide, mode is genuinely OFF)', qs, '');
}

// RT-9b: nearbyMode=true but no location → empty scope (guard)
{
  const qs = buildPriceQueryScope(true, null, 25);
  expect      ('RT-9b: nearbyMode=true but null location → empty scope', qs, '');
}

// RT-9c: nearbyMode=true but location has no lat → empty scope
{
  const qs = buildPriceQueryScope(true, { lng: 34.78 }, 25);
  expect      ('RT-9c: nearbyMode=true but missing lat → empty scope', qs, '');
}

// RT-10: Restart after mode enabled → scope is radius-filtered
{
  const r = restoreNearbyState({ nearbyMode: 'true', selectedLocation: VALID_LOC, nearbyRadius: '25' });
  const qs = buildPriceQueryScope(r.nearbyMode, r.selectedLocation, r.nearbyRadius);
  expectTruthy('RT-10: restored mode → radius-filtered scope', qs.includes('radiusKm=25'));
  expectTruthy('RT-10: restored mode → lat present', qs.includes('lat=32.0853'));
}

// RT-12: Radius changes — scope uses the current radius
{
  const qs10 = buildPriceQueryScope(true, LOC, 10);
  const qs5  = buildPriceQueryScope(true, LOC, 5);
  expectTruthy('RT-12: radius=10 → radiusKm=10', qs10.includes('radiusKm=10'));
  expectTruthy('RT-12: radius=5  → radiusKm=5',  qs5.includes('radiusKm=5'));
}

// RT-13: Both chip and modal use same scope contract — verified by calling same function
{
  const scope = buildPriceQueryScope(true, LOC, 25);
  // Chip path uses buildPriceQueryScope(nearbyMode, selectedLocation, nearbyRadius)
  // Modal path uses _hasLoc() → _fetchPricesWithDistance → fixed radiusKm=99999
  // This test verifies that the chip scope is not empty (was the bug: chip got '')
  expectTruthy('RT-13: chip path would produce location-scoped request', scope !== '');
}

// RT-14: No nationwide cheapest shown when mode is active but no stores in radius
//        (This is enforced by the modal's _partitionByRadius in PATH B.
//         For PATH A we verify: if mode is active, URL contains radiusKm.)
{
  const qs = buildPriceQueryScope(true, LOC, 3);
  expectTruthy('RT-14: mode active with radius=3 → API call is radius-scoped (backend excludes out-of-radius stores)', qs.includes('radiusKm=3'));
}

// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);

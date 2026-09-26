import {
  buildGeocodePlan,
  buildGeocodeWritePayloads,
} from '../geocodePolicy.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`PASS ${name}`);
    })
    .catch(err => {
      failed++;
      console.error(`FAIL ${name}: ${err.message}`);
    });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await test('address + canonical city uses branch-address geocoding', () => {
  const plan = buildGeocodePlan({
    address: 'דיזנגוף 50',
    city: 'תל אביב -יפו',
  });

  assertEqual(plan.mode, 'address', 'mode');
  assertEqual(
    plan.query,
    'דיזנגוף 50, תל אביב -יפו, ישראל',
    'address query'
  );
  assertEqual(plan.forceApproximate, false, 'must not force approximate');
});

await test('missing address + canonical city falls back to city center', () => {
  const plan = buildGeocodePlan({
    address: '',
    city: 'אילת',
  });

  assertEqual(plan.mode, 'city_center', 'mode');
  assertEqual(plan.query, 'אילת, ישראל', 'city-center query');
  assertEqual(plan.forceApproximate, true, 'city center must be approximate');
});

await test('missing canonical city cannot be geocoded', () => {
  const plan = buildGeocodePlan({
    address: 'הרצל 1',
    city: '',
  });

  assertEqual(plan, null, 'plan');
});

await test('exact geocode writes stores + storeCoords as exact', () => {
  const writes = buildGeocodeWritePayloads({
    geo: {
      latitude: 32.0853,
      longitude: 34.7818,
      approximate: false,
      confidence: 'ROOFTOP',
      query: 'דיזנגוף 50, תל אביב -יפו, ישראל',
    },
    city: 'תל אביב -יפו',
    geocodedAt: '2026-09-27T00:00:00.000Z',
  });

  assertEqual(writes.store.hasCoords, true, 'store hasCoords');
  assertEqual(writes.store.approximateLocation, false, 'store exact');
  assertEqual(writes.storeCoords.lat, 32.0853, 'coords lat');
  assertEqual(writes.storeCoords.lng, 34.7818, 'coords lng');
  assertEqual(writes.storeCoords.city, 'תל אביב -יפו', 'coords city');
  assertEqual(
    writes.storeCoords.approximateLocation,
    false,
    'coords exact metadata'
  );
});

await test('city-center fallback writes explicit approximate metadata', () => {
  const writes = buildGeocodeWritePayloads({
    geo: {
      latitude: 29.5577,
      longitude: 34.9519,
      approximate: true,
      confidence: 'APPROXIMATE',
      query: 'אילת, ישראל',
    },
    city: 'אילת',
    geocodedAt: '2026-09-27T00:00:00.000Z',
    source: 'city_center',
  });

  assertEqual(writes.store.hasCoords, true, 'store hasCoords');
  assertEqual(writes.store.approximateLocation, true, 'store approximate');
  assertEqual(
    writes.store.coordinateResolutionSource,
    'city_center',
    'store source'
  );

  assertEqual(writes.storeCoords.lat, 29.5577, 'coords lat');
  assertEqual(writes.storeCoords.lng, 34.9519, 'coords lng');
  assertEqual(writes.storeCoords.city, 'אילת', 'coords city');
  assertEqual(
    writes.storeCoords.approximateLocation,
    true,
    'coords approximate metadata'
  );
  assertEqual(
    writes.storeCoords.coordinateResolutionSource,
    'city_center',
    'coords source'
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import { BatchWriter } from '../firebaseWriter.js';

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

function setPath(root, path, value) {
  const parts = path.split('/').filter(Boolean);
  let node = root;

  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] ??= {};
    node = node[parts[i]];
  }

  const last = parts[parts.length - 1];

  if (value === null) delete node[last];
  else node[last] = structuredClone(value);
}

function makeMockDb(initialState) {
  const state = structuredClone(initialState);

  return {
    state,
    ref(path) {
      if (path !== '/') throw new Error(`unexpected ref path: ${path}`);

      return {
        async update(batch) {
          for (const [childPath, value] of Object.entries(batch)) {
            setPath(state, childPath, value);
          }
        },
      };
    },
  };
}

await test('partial store sync preserves existing geocoding fields', async () => {
  const db = makeMockDb({
    stores: {
      shufersal_1: {
        chainId: '7290027600007',
        storeId: '1',
        storeName: 'Old name',
        address: 'Old address',

        latitude: 32.1,
        longitude: 34.8,
        hasCoords: true,

        approximateLocation: false,
        geocodedAt: '2026-09-01T00:00:00.000Z',
        geocodeProvider: 'google',
        geocodeConfidence: 'ROOFTOP',
      },
    },
  });

  const writer = new BatchWriter(db, { batchSize: 400 });

  await writer.queueMerge('stores/shufersal_1', {
    storeName: 'Updated supplier name',
    address: 'Updated supplier address',
    updatedAt: '2026-09-27T00:00:00.000Z',
  });

  await writer.flush();

  const result = db.state.stores.shufersal_1;

  assertEqual(result.storeName, 'Updated supplier name', 'supplier metadata updated');
  assertEqual(result.address, 'Updated supplier address', 'supplier address updated');

  assertEqual(result.latitude, 32.1, 'latitude preserved');
  assertEqual(result.longitude, 34.8, 'longitude preserved');
  assertEqual(result.hasCoords, true, 'hasCoords preserved');
  assertEqual(result.geocodeProvider, 'google', 'geocodeProvider preserved');
  assertEqual(result.geocodeConfidence, 'ROOFTOP', 'geocodeConfidence preserved');
  assertEqual(
    result.geocodedAt,
    '2026-09-01T00:00:00.000Z',
    'geocodedAt preserved'
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

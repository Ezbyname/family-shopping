import { Readable } from 'node:stream';

import { parseXMLStream } from '../parseXml.js';
import { safeKey } from '../normalizeProduct.js';
import {
  buildStorePayload,
  buildStoreCoordsPayload,
  buildStoreMergePayload,
} from '../storeWritePayload.js';

const chain = {
  id: 'shufersal',
  chainId: '7290027600007',
  name: 'Shufersal',
};

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`PASS ${name}`);
    })
    .catch(error => {
      failed++;
      console.error(`FAIL ${name}: ${error.message}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function makeStoresXml({
  storeId,
  storeName = 'test branch',
  address = 'test address',
  city,
  zipCode = '12345',
  latitude,
  longitude,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Root>
  <Store>
    <StoreId>${storeId}</StoreId>
    <StoreName>${storeName}</StoreName>
    <Address>${address}</Address>
    <City>${city}</City>
    <ZipCode>${zipCode}</ZipCode>
    ${latitude !== undefined ? `<Latitude>${latitude}</Latitude>` : ''}
    ${longitude !== undefined ? `<Longitude>${longitude}</Longitude>` : ''}
  </Store>
</Root>`;
}

async function parseSingleStore(xml) {
  let captured = null;

  const result = await parseXMLStream(
    Readable.from([xml]),
    null,
    store => {
      captured = store;
    },
    {
      chainId: chain.chainId,
      chainName: chain.name,
    },
  );

  assertEqual(result.storeCount, 1, 'storeCount');
  assert(captured !== null, 'store callback must fire');

  return captured;
}

await test('real pipeline resolves 001 / 5000', async () => {
  const store = await parseSingleStore(
    makeStoresXml({
      storeId: '001',
      city: '5000',
      latitude: '32.1',
      longitude: '34.8',
    }),
  );

  const key = safeKey(`${chain.id}_${store.storeId}`);
  const payload = buildStorePayload(store, chain);
  const coords = buildStoreCoordsPayload(store);

  assertEqual(store.storeId, '1', 'normalized storeId');
  assertEqual(key, 'shufersal_1', 'store key');
  assertEqual(payload.rawCityCode, '5000', 'rawCityCode');
  assertEqual(payload.cityId, '5000', 'cityId');
  assertEqual(payload.cityName, 'תל אביב -יפו', 'cityName');
  assertEqual(payload.city, 'תל אביב -יפו', 'city');
  assertEqual(
    payload.cityResolutionSource,
    'data.gov.il_localities_2023',
    'resolution source',
  );

  assert(coords !== null, 'coords payload must exist');
  assertEqual(coords.city, 'תל אביב -יפו', 'coords city');

  assertEqual(
    coords.approximateLocation,
    false,
    'supplier storeCoords must be explicitly exact'
  );

  assertEqual(
    coords.coordinateResolutionSource,
    'official',
    'supplier storeCoords must preserve official coordinate ownership'
  );
});

await test('real pipeline supports unseen StoreID 99991', async () => {
  const store = await parseSingleStore(
    makeStoresXml({
      storeId: '99991',
      city: '3000',
    }),
  );

  const key = safeKey(`${chain.id}_${store.storeId}`);

  assertEqual(store.storeId, '99991', 'storeId');
  assertEqual(key, 'shufersal_99991', 'store key');
});

await test('real pipeline keeps 10098 unresolved', async () => {
  const store = await parseSingleStore(
    makeStoresXml({
      storeId: '788',
      city: '10098',
      latitude: '32.5',
      longitude: '35.0',
    }),
  );

  const payload = buildStorePayload(store, chain);
  const coords = buildStoreCoordsPayload(store);

  assertEqual(payload.rawCityCode, '10098', 'rawCityCode');
  assertEqual(payload.cityResolutionSource, 'unresolved', 'resolution source');

  assert(!Object.hasOwn(payload, 'cityId'), 'payload cityId must be absent');
  assert(!Object.hasOwn(payload, 'cityName'), 'payload cityName must be absent');
  assert(!Object.hasOwn(payload, 'city'), 'payload city must be absent');

  assert(coords !== null, 'coords payload must exist');
  assert(!Object.hasOwn(coords, 'city'), 'coords city must be absent');
  assert(coords.city !== '10098', 'coords city must never be numeric raw code');
});

await test('parser callback receives already-normalized store', async () => {
  const store = await parseSingleStore(
    makeStoresXml({
      storeId: '001',
      city: '5000',
    }),
  );

  assertEqual(store.storeId, '1', 'callback storeId');
  assertEqual(store.rawCityCode, '5000', 'callback rawCityCode');
  assertEqual(store.city, 'תל אביב -יפו', 'callback city');
});


await test('supplier merge without coords preserves existing geocoding ownership', async () => {
  const store = await parseSingleStore(
    makeStoresXml({
      storeId: '123',
      city: '5000',
      latitude: '',
      longitude: '',
    }),
  );

  const payload = buildStoreMergePayload(store, chain);

  assertEqual(store.hasCoords, false, 'fixture must have no supplier coords');

  assert(
    !Object.hasOwn(payload, 'latitude'),
    'latitude must be omitted when supplier has no coords'
  );
  assert(
    !Object.hasOwn(payload, 'longitude'),
    'longitude must be omitted when supplier has no coords'
  );
  assert(
    !Object.hasOwn(payload, 'hasCoords'),
    'hasCoords must be omitted when supplier has no coords'
  );

  assert(
    !Object.hasOwn(payload, 'approximateLocation'),
    'existing approximateLocation must remain untouched'
  );
  assert(
    !Object.hasOwn(payload, 'geocodedAt'),
    'existing geocodedAt must remain untouched'
  );
  assert(
    !Object.hasOwn(payload, 'geocodeProvider'),
    'existing geocodeProvider must remain untouched'
  );
  assert(
    !Object.hasOwn(payload, 'geocodeQuery'),
    'existing geocodeQuery must remain untouched'
  );
  assert(
    !Object.hasOwn(payload, 'geocodeConfidence'),
    'existing geocodeConfidence must remain untouched'
  );
});

await test('supplier exact coords take coordinate ownership and clear stale geocoding metadata', async () => {
  const store = await parseSingleStore(
    makeStoresXml({
      storeId: '124',
      city: '5000',
      latitude: '32.1234',
      longitude: '34.9876',
    }),
  );

  const payload = buildStoreMergePayload(store, chain);

  assertEqual(store.hasCoords, true, 'fixture must have supplier coords');

  assertEqual(payload.latitude, 32.1234, 'supplier latitude');
  assertEqual(payload.longitude, 34.9876, 'supplier longitude');
  assertEqual(payload.hasCoords, true, 'supplier hasCoords');

  assertEqual(
    payload.approximateLocation,
    false,
    'supplier coordinates must not remain marked approximate'
  );

  assertEqual(payload.geocodedAt, null, 'stale geocodedAt must be cleared');
  assertEqual(payload.geocodeProvider, null, 'stale geocodeProvider must be cleared');
  assertEqual(payload.geocodeQuery, null, 'stale geocodeQuery must be cleared');
  assertEqual(
    payload.geocodeConfidence,
    null,
    'stale geocodeConfidence must be cleared'
  );

  assertEqual(
    payload.coordinateResolutionSource,
    'official',
    'supplier exact coordinates must own coordinateResolutionSource'
  );
});

console.log(`\n${passed} / ${passed + failed} PASS`);

if (failed > 0) {
  process.exit(1);
}

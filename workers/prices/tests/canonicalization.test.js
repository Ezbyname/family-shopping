import {
  normalizeStoreId,
  normalizeStore,
} from '../normalizeProduct.js';

import { resolveLocality } from '../localityResolver.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
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

// StoreID normalization

test('001 -> 1', () => {
  assertEqual(normalizeStoreId('001'), '1', 'StoreID');
});

test('0001 -> 1', () => {
  assertEqual(normalizeStoreId('0001'), '1', 'StoreID');
});

test('010 -> 10', () => {
  assertEqual(normalizeStoreId('010'), '10', 'StoreID');
});

test('700 -> 700', () => {
  assertEqual(normalizeStoreId('700'), '700', 'StoreID');
});

test('ABC001 preserved', () => {
  assertEqual(normalizeStoreId('ABC001'), 'ABC001', 'StoreID');
});

test('001A preserved', () => {
  assertEqual(normalizeStoreId('001A'), '001A', 'StoreID');
});

test('0 -> 0', () => {
  assertEqual(normalizeStoreId('0'), '0', 'StoreID');
});

test('000 -> 0', () => {
  assertEqual(normalizeStoreId('000'), '0', 'StoreID');
});

// Resolver behavior

test('5000 resolves to Tel Aviv-Yafo', () => {
  const r = resolveLocality('5000');
  assert(r.resolved === true, 'expected resolved=true');
  assertEqual(r.rawCityCode, '5000', 'rawCityCode');
  assertEqual(r.cityId, '5000', 'cityId');
  assertEqual(r.cityName, 'תל אביב -יפו', 'cityName');
  assertEqual(r.city, 'תל אביב -יפו', 'city');
  assertEqual(
    r.cityResolutionSource,
    'data.gov.il_localities_2023',
    'resolution source'
  );
});

test('10098 remains unresolved', () => {
  const r = resolveLocality('10098');
  assert(r.resolved === false, 'expected resolved=false');
  assertEqual(r.rawCityCode, '10098', 'rawCityCode');
  assertEqual(r.cityResolutionSource, 'unresolved', 'resolution source');
  assert(!Object.hasOwn(r, 'cityId'), 'cityId must be absent');
  assert(!Object.hasOwn(r, 'cityName'), 'cityName must be absent');
  assert(!Object.hasOwn(r, 'city'), 'city must be absent');
});

// normalizeStore resolved case

test('normalizeStore resolves city and normalizes StoreID', () => {
  const store = normalizeStore({
    storeId: '001',
    storeName: 'test branch',
    address: 'test address',
    city: '5000',
    zipCode: '12345',
  }, {
    chainId: '7290027600007',
    chainName: 'Shufersal',
  });

  assert(store !== null, 'store must exist');
  assertEqual(store.storeId, '1', 'storeId');
  assertEqual(store.rawCityCode, '5000', 'rawCityCode');
  assertEqual(store.cityId, '5000', 'cityId');
  assertEqual(store.cityName, 'תל אביב -יפו', 'cityName');
  assertEqual(store.city, 'תל אביב -יפו', 'city');
  assertEqual(
    store.cityResolutionSource,
    'data.gov.il_localities_2023',
    'resolution source'
  );
});

// normalizeStore unresolved cases

test('unresolved city does not expose canonical city fields', () => {
  const store = normalizeStore({
    storeId: '99991',
    storeName: 'new branch',
    city: '10098',
  }, {
    chainId: '7290027600007',
    chainName: 'Shufersal',
  });

  assertEqual(store.storeId, '99991', 'storeId');
  assertEqual(store.rawCityCode, '10098', 'rawCityCode');
  assertEqual(store.cityResolutionSource, 'unresolved', 'resolution source');
  assert(!Object.hasOwn(store, 'cityId'), 'cityId must be absent');
  assert(!Object.hasOwn(store, 'cityName'), 'cityName must be absent');
  assert(!Object.hasOwn(store, 'city'), 'city must be absent');
});

test('numeric zero city is preserved as rawCityCode', () => {
  const store = normalizeStore({
    storeId: '002',
    city: 0,
  });

  assertEqual(store.storeId, '2', 'storeId');
  assertEqual(store.rawCityCode, '0', 'rawCityCode');
  assertEqual(store.cityResolutionSource, 'unresolved', 'resolution source');
  assert(!Object.hasOwn(store, 'city'), 'city must be absent');
});

test('string zero city is preserved as rawCityCode', () => {
  const store = normalizeStore({
    storeId: '002',
    city: '0',
  });

  assertEqual(store.rawCityCode, '0', 'rawCityCode');
  assert(!Object.hasOwn(store, 'city'), 'city must be absent');
});

test('empty city remains unresolved with empty rawCityCode', () => {
  const store = normalizeStore({
    storeId: '002',
    city: '',
  });

  assertEqual(store.rawCityCode, '', 'rawCityCode');
  assertEqual(store.cityResolutionSource, 'unresolved', 'resolution source');
  assert(!Object.hasOwn(store, 'city'), 'city must be absent');
});

test('missing city remains unresolved with empty rawCityCode', () => {
  const store = normalizeStore({
    storeId: '002',
  });

  assertEqual(store.rawCityCode, '', 'rawCityCode');
  assertEqual(store.cityResolutionSource, 'unresolved', 'resolution source');
  assert(!Object.hasOwn(store, 'city'), 'city must be absent');
});

// Metadata preservation

test('store metadata fields are preserved', () => {
  const store = normalizeStore({
    storeId: '003',
    storeName: 'Branch',
    address: 'Main 1',
    city: '6300',
    zipCode: '1234567',
    subChainId: '10',
    subChainName: 'Express',
    latitude: '32.1',
    longitude: '34.8',
  }, {
    chainId: 'chain-x',
    chainName: 'Chain X',
  });

  assertEqual(store.chainId, 'chain-x', 'chainId');
  assertEqual(store.chainName, 'Chain X', 'chainName');
  assertEqual(store.subChainId, '10', 'subChainId');
  assertEqual(store.subChainName, 'Express', 'subChainName');
  assertEqual(store.storeName, 'Branch', 'storeName');
  assertEqual(store.address, 'Main 1', 'address');
  assertEqual(store.zipCode, '1234567', 'zipCode');
  assertEqual(store.latitude, 32.1, 'latitude');
  assertEqual(store.longitude, 34.8, 'longitude');
  assert(store.hasCoords === true, 'hasCoords');
});

test('zero coordinates are treated as missing', () => {
  const store = normalizeStore({
    storeId: '004',
    city: '3000',
    latitude: '0',
    longitude: '0',
  });

  assert(store.hasCoords === false, 'hasCoords must be false');
  assert(store.latitude === null, 'latitude must be null');
  assert(store.longitude === null, 'longitude must be null');
});

console.log(`\n${passed} / ${passed + failed} PASS`);

if (failed > 0) {
  process.exit(1);
}

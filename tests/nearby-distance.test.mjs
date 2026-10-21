// tests/nearby-distance.test.mjs
// FS-LOC-DIST-001 — System-1 nearby price view returned 0 stores.
//
// Root cause: _fetchPricesWithDistance asked /api/prices for radiusKm=99999.
// The server filters by radius, sorts by price and caps at MAX_PRICES (50),
// so it returned the 50 cheapest stores nationwide; the client 3 km partition
// then found none (Haifa: 50 → 0, while a direct radiusKm=3 call returns 14).
//
// These tests extract the REAL functions from app.js (same pattern as
// ui-fixes.test.mjs) and run them against a stubbed fetch / server.
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

// Extract a top-level function declaration (async or not) by brace matching.
function extractFn(name) {
  const start = app.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  let i = app.indexOf('{', app.indexOf(')', start)), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const fetchSrc     = extractFn('_fetchPricesWithDistance');
const partitionSrc = extractFn('_partitionByRadius');
const viewSrc      = extractFn('_buildNearbyView');
const outsideConst = app.match(/const OUTSIDE_CANDIDATE_RADIUS_KM\s*=\s*\d+;/)?.[0];
if (!outsideConst) throw new Error('OUTSIDE_CANDIDATE_RADIUS_KM not found in app.js');

// Build the real functions with an injected environment.
function load({ hasLoc = true, lat = 32.794, lng = 34.9896, radius = 3, online = true, fetchImpl }) {
  const calls = [];
  const fetchStub = async (url, opts) => { calls.push(url); return fetchImpl(url, opts); };
  const factory = new Function(
    '_hasLoc', '_locLat', '_locLng', '_nearbyRadius', 'navigator', 'fetch',
    `${outsideConst}\n${fetchSrc}\n${partitionSrc}\n${viewSrc}\n` +
    `return { _fetchPricesWithDistance, _partitionByRadius, _buildNearbyView, OUTSIDE_CANDIDATE_RADIUS_KM };`
  );
  const fns = factory(() => hasLoc, () => lat, () => lng, radius, { onLine: online }, fetchStub);
  // Mirrors the System-1 call site in showProductPricesEnhanced (asserted in test 6).
  const system1 = async barcode => {
    const [nearbyRows, outsideRows] = await Promise.all([
      fns._fetchPricesWithDistance(barcode),
      fns._fetchPricesWithDistance(barcode, fns.OUTSIDE_CANDIDATE_RADIUS_KM),
    ]);
    return fns._buildNearbyView(nearbyRows, outsideRows, radius);
  };
  return { ...fns, system1, calls };
}

const jsonRes = body => ({ ok: true, json: async () => body });
const radiusOf = url => new URL(url, 'http://x').searchParams.get('radiusKm');

// Fake /api/prices that mirrors the server order: radius filter → price sort → cap 50.
function fakeServer(stores) {
  return async url => {
    const r = parseFloat(radiusOf(url));
    const rows = stores.filter(s => s.distanceKm <= r)
      .sort((a, b) => a.price - b.price)
      .slice(0, 50)
      .map(s => ({ ...s }));
    return jsonRes({ prices: rows });
  };
}
// Haifa-like fixture: 60 cheap stores far away (≥ 6 km), 14 pricier stores ≤ 3 km.
const HAIFA = [
  ...Array.from({ length: 60 }, (_, i) => ({ chainId: 'far', storeId: String(i), price: 4 + i * 0.01, distanceKm: 6 + i })),
  ...Array.from({ length: 14 }, (_, i) => ({ chainId: 'near', storeId: String(i), price: 6 + i * 0.01, distanceKm: 0.5 + i * 0.15 })),
];

console.log('\nFS-LOC-DIST-001 — System-1 nearby radius');

await test('1. nearby radius 3 km sends radiusKm=3 to /api/prices', async () => {
  const { _fetchPricesWithDistance, calls } = load({ radius: 3, fetchImpl: async () => jsonRes({ prices: [] }) });
  await _fetchPricesWithDistance('7290004131074');
  eq(calls.length, 1, 'one request');
  ok(calls[0].startsWith('/api/prices?barcode=7290004131074'), 'targets /api/prices');
  eq(radiusOf(calls[0]), '3');
});

await test('2. each other selectable radius is sent exactly', async () => {
  for (const r of [1, 5, 10, 25, 50]) {
    const { _fetchPricesWithDistance, calls } = load({ radius: r, fetchImpl: async () => jsonRes({ prices: [] }) });
    await _fetchPricesWithDistance('7290004131074');
    eq(radiusOf(calls[0]), String(r), `radius ${r}`);
  }
});

await test('3. nearby-list request no longer uses radiusKm=99999', async () => {
  ok(!/radiusKm=99999/.test(fetchSrc), '_fetchPricesWithDistance must not hard-code 99999');
  ok(!/radiusKm=99999/.test(app), 'no hard-coded 99999 radius request left in app.js');
  const { system1, calls } = load({ radius: 3, fetchImpl: async () => jsonRes({ prices: [] }) });
  await system1('7290004131074');
  eq(calls.length, 2, 'nearby + outside-candidate requests');
  eq(calls.filter(u => radiusOf(u) === '3').length, 1, 'exactly one request at the real radius');
  eq(calls.filter(u => radiusOf(u) === '99999').length, 1, '99999 only for the outside candidate');
});

await test('4. stores inside the requested radius are preserved through the partition', async () => {
  const { _fetchPricesWithDistance, _partitionByRadius } = load({ radius: 3, fetchImpl: fakeServer(HAIFA) });
  const rows = await _fetchPricesWithDistance('7290004131074');
  eq(rows.length, 14, 'server returns the 14 in-radius stores');
  const part = _partitionByRadius(rows, 3);
  eq(part.nearby.length, 14, 'all 14 survive into the nearby list');
  ok(part.nearby.every(p => p.chainId === 'near'), 'only in-radius stores');
});

await test('4b. [REGRESSION] old 99999 request on the same data yields 0 nearby (50 → 0)', async () => {
  const { _partitionByRadius } = load({ fetchImpl: async () => jsonRes({ prices: [] }) });
  const capped = await (await fakeServer(HAIFA)('/api/prices?radiusKm=99999')).json();
  eq(capped.prices.length, 50, 'cap reached with far, cheaper stores');
  eq(_partitionByRadius(capped.prices, 3).nearby.length, 0, 'reproduces the phone symptom');
});

await test('5a. non-nearby mode (no location): no request, caller keeps full list', async () => {
  const { _fetchPricesWithDistance, calls } = load({ hasLoc: false, fetchImpl: async () => jsonRes({ prices: [] }) });
  eq(await _fetchPricesWithDistance('7290004131074'), null);
  eq(calls.length, 0, 'no distance request issued');
});

await test('5b. offline: no request, returns null (unchanged)', async () => {
  const { _fetchPricesWithDistance, calls } = load({ online: false, fetchImpl: async () => jsonRes({ prices: [] }) });
  eq(await _fetchPricesWithDistance('7290004131074'), null);
  eq(calls.length, 0);
});

await test('5c. HTTP error / zero-price rows handling unchanged', async () => {
  const bad = load({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  eq(await bad._fetchPricesWithDistance('7290004131074'), null, 'non-ok → null');
  const zero = load({ fetchImpl: async () => jsonRes({ prices: [{ price: 0, distanceKm: 1 }, { price: 5, distanceKm: 1 }] }) });
  eq((await zero._fetchPricesWithDistance('7290004131074')).length, 1, 'zero-price rows filtered');
});

await test('5d. other request params unchanged (lat/lng/includeApproximate)', async () => {
  const { _fetchPricesWithDistance, calls } = load({ lat: 31.25, lng: 34.79, radius: 10, fetchImpl: async () => jsonRes({ prices: [] }) });
  await _fetchPricesWithDistance('7290000042435');
  const sp = new URL(calls[0], 'http://x').searchParams;
  eq(sp.get('lat'), '31.25'); eq(sp.get('lng'), '34.79'); eq(sp.get('includeApproximate'), 'true');
});

console.log('\nOutside-area card ("🔭 הזול ביותר מחוץ לאזור שלך") preserved');

await test('6. call site: parallel nearby + outside reads feed _buildNearbyView', async () => {
  ok(/_fetchPricesWithDistance\(barcode\),\s*_fetchPricesWithDistance\(barcode, OUTSIDE_CANDIDATE_RADIUS_KM\)/.test(app),
    'System-1 issues the nearby read and the outside-candidate read');
  ok(/_buildNearbyView\(nearbyRows, outsideRows, _nearbyRadius\)/.test(app), 'combined via _buildNearbyView');
});

await test('7. Haifa fixture: 14 nearby rows kept AND outside card gets a valid candidate', async () => {
  const { system1 } = load({ radius: 3, fetchImpl: fakeServer(HAIFA) });
  const v = await system1('7290004131074');
  eq(v.active, true);
  eq(v.nearby.length, 14, 'nearby list = the 14 in-radius rows');
  ok(v.nearby.every(p => p.chainId === 'near'), 'nearby rows come only from the real-radius read');
  ok(v.outsideCard, 'outside card present (far store at 4.00 < nearby min 6.00)');
  eq(v.outsideCard.chainId, 'far'); eq(v.outsideCard.price, 4);
  ok(v.outsideCard.distanceKm > 3, 'card candidate is outside the radius');
});

await test('8. card hidden when the nearest stores are already the cheapest (existing rule)', async () => {
  const stores = [
    { chainId: 'near', storeId: '1', price: 3, distanceKm: 1 },
    { chainId: 'far',  storeId: '2', price: 5, distanceKm: 20 },
  ];
  const v = await load({ radius: 3, fetchImpl: fakeServer(stores) }).system1('x');
  eq(v.nearby.length, 1); eq(v.outsideCard, null);
});

await test('9. nothing within radius: active, empty nearby, card shows cheapest outside', async () => {
  const stores = [{ chainId: 'far', storeId: '1', price: 7, distanceKm: 12 }, { chainId: 'far', storeId: '2', price: 6, distanceKm: 30 }];
  const v = await load({ radius: 3, fetchImpl: fakeServer(stores) }).system1('x');
  eq(v.active, true, 'radius view stays active (no silent national fallback)');
  eq(v.nearby.length, 0);
  eq(v.outsideCard.price, 6);
});

await test('10. outside read cannot replace or zero nearby rows', async () => {
  // Outside read returns rows that would all be "nearby" by distance — they must not enter the list.
  const fetchImpl = async url => radiusOf(url) === '3'
    ? jsonRes({ prices: [{ chainId: 'near', storeId: '1', price: 9, distanceKm: 1 }] })
    : jsonRes({ prices: [{ chainId: 'intruder', storeId: '9', price: 1, distanceKm: 0.5 }] });
  const v = await load({ radius: 3, fetchImpl }).system1('x');
  eq(v.nearby.length, 1); eq(v.nearby[0].chainId, 'near', 'nearby list untouched by outside read');
  eq(v.outsideCard, null, 'in-radius row is never an outside candidate');
});

await test('11. outside read failing leaves nearby intact, no card', async () => {
  const fetchImpl = async url => radiusOf(url) === '3'
    ? jsonRes({ prices: [{ chainId: 'near', storeId: '1', price: 9, distanceKm: 1 }] })
    : { ok: false, json: async () => ({}) };
  const v = await load({ radius: 3, fetchImpl }).system1('x');
  eq(v.active, true); eq(v.nearby.length, 1); eq(v.outsideCard, null);
});

await test('12. nearby read failing → inactive (full-list fallback), outside read cannot force a false zero', async () => {
  const fetchImpl = async url => radiusOf(url) === '3'
    ? { ok: false, json: async () => ({}) }
    : jsonRes({ prices: [{ chainId: 'far', storeId: '1', price: 2, distanceKm: 40 }] });
  const v = await load({ radius: 3, fetchImpl }).system1('x');
  eq(v.active, false, 'falls back exactly like the old failed read');
});

await test('13. no location / offline: no requests, inactive (unchanged)', async () => {
  for (const opts of [{ hasLoc: false }, { online: false }]) {
    const l = load({ ...opts, fetchImpl: async () => jsonRes({ prices: [] }) });
    const v = await l.system1('x');
    eq(l.calls.length, 0, 'no requests'); eq(v.active, false);
  }
});

await test('14. both reads empty (no geocoded stores) → inactive, same as old empty read', async () => {
  const v = await load({ radius: 3, fetchImpl: async () => jsonRes({ prices: [] }) }).system1('x');
  eq(v.active, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

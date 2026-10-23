// tests/pd-gps-feedback.test.mjs
// FS-LOC-DIST-003 — System-2 (price-detail sheet) "השתמש במיקום הנוכחי" looked like
// a no-op on the phone. selectLocGPS() did request geolocation, but every outcome
// was reported only via the global toast and the search-strip label — both covered
// by #price-detail-overlay (same z-index 500, later in the DOM).
//
// Runs the REAL selectLocGPS, _pdUseCurrentLocation, _setLocation, _pdRefreshPrices
// and _renderPriceDetail extracted from app.js into one shared scope (same pattern
// as pd-no-location / nearby-distance) against a controllable geolocation stub.
import { readFileSync } from 'fs';
import * as pd from '../js/pd-location.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function sliceBody(start, label) {
  let i = app.indexOf('{', app.indexOf(')', start)), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${label}`);
}
function extractFn(name) {
  const start = app.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  return sliceBody(start, name);
}
function extractWindowFn(name) {
  const start = app.search(new RegExp(`window\\.${name}\\s*=\\s*(async\\s+)?function\\s*\\(`));
  if (start < 0) throw new Error(`window.${name} not found in app.js`);
  return sliceBody(start, name) + ';';
}

const GENERIC  = 'אין מחירים זמינים';
const LOCATING = 'מאתר מיקום...';
const ERROR    = 'pd-gps-error';  // marker class on every GPS failure panel
const RETRY    = '📍 נסה שוב<';
const ADDR_ALT = 'הזן כתובת במקום';
const GPS_CTA  = 'onclick="_pdUseCurrentLocation()"';
const ADDR_CTA = 'onclick="openManualAddressModal()"';
const MSG = {
  denied:      ['לאפליקציה אין הרשאה להשתמש במיקום שלך', 'כדי להשתמש בחיפוש לפי מרחק, יש לאפשר ל-Chrome גישה למיקום.',
                'הגדרות &gt; אפליקציות &gt; Chrome &gt; הרשאות &gt; מיקום &gt; אפשר בזמן השימוש',
                'ודא שגם הרשאת המיקום לאתר הזה מאופשרת ב-Chrome.'],
  unavailable: ['לא הצלחנו לזהות את המיקום כרגע.', 'ודא ששירותי המיקום במכשיר פעילים ונסה שוב.'],
  timeout:     ['איתור המיקום ארך יותר מדי זמן.', 'נסה שוב.'],
  unknown:     ['לא הצלחנו לקבל את המיקום הנוכחי'],
};
const PERM_HELP = 'pd-gps-help';
const HAIFA_POS = { coords: { latitude: 32.794, longitude: 34.9896 } };

// Geolocation stub: records each request and lets the test settle it later.
function geoStub() {
  const g = { calls: 0, opts: null, ok: null, err: null,
    getCurrentPosition(ok, err, opts) { g.calls++; g.opts = opts; g.ok = ok; g.err = err; } };
  return g;
}

// Price-detail sheet open in radius mode with no saved location.
function makeSheet({ geo, mode = 'radius' } = {}) {
  const body = { innerHTML: '' };
  const els = { 'pd-body': body, 'price-detail-overlay': { classList: { contains: c => c === 'show' } } };
  const store = {};
  const log = { fetches: [], toasts: [] };
  const fetchImpl = loc => Promise.resolve(loc ? { prices: [], blocked: null } : { prices: [], blocked: 'no-location' });
  const win = {};
  const factory = new Function(
    'document', 'localStorage', 'navigator', 'window', 'log', 'fetchImpl', 'pdEmptyStateKind', 'pdGpsErrorKind', `
    let _selectedLocation = null, _pdPrices = [], _pdFromCache = false, _pdBlocked = 'no-location',
        _pdGpsState = 'idle', _pdGpsError = null, _pdMode = ${JSON.stringify(mode)}, _pdLastUpdateBy = null;
    const _pdBarcode = '7290004131074', _pdName = 'חלב', PRICE_CACHE_TTL = 0, lastSearchQuery = '';
    const _pcGet = () => null, esc = s => s, _jsAttr = s => JSON.stringify(s);
    const _syncNearbyUI = () => {}, _syncPdLocationUI = () => {}, closeLocDropdown = () => {}, _pdCacheInvalidate = () => {};
    const toast = m => log.toasts.push(m);
    function selectLocGPS() { return window.selectLocGPS(); }
    function _pdFetchPrices() { log.fetches.push(_selectedLocation); return fetchImpl(_selectedLocation); }
    ${extractFn('_renderPriceDetail')}
    ${extractFn('_setLocation')}
    ${extractFn('_pdRefreshPrices')}
    ${extractFn('_pdUseCurrentLocation')}
    ${extractFn('_pdGpsErrorHtml')}
    ${extractWindowFn('selectLocGPS')}
    return { render: _renderPriceDetail, useCurrent: _pdUseCurrentLocation,
             state: () => ({ gps: _pdGpsState, loc: _selectedLocation }) };`);
  const s = factory({ getElementById: id => els[id] || null },
    { setItem: (k, v) => { store[k] = v; }, getItem: k => store[k] ?? null, removeItem: k => { delete store[k]; } },
    { onLine: true, geolocation: geo }, win, log, fetchImpl, pd.pdEmptyStateKind, pd.pdGpsErrorKind);
  s.render();
  return { ...s, body, store, log, win };
}
const tick = () => new Promise(r => setTimeout(r, 0));

console.log('\nFS-LOC-DIST-003 — System-2 current-location feedback');

await test('pdEmptyStateKind: GPS states apply only to radius mode; idle keeps prior behaviour', () => {
  eq(pd.pdEmptyStateKind('no-location', 'radius', 'locating'), 'locating');
  eq(pd.pdEmptyStateKind('no-location', 'radius', 'location-error'), 'location-error');
  eq(pd.pdEmptyStateKind('no-location', 'radius', 'idle'), 'location-required');
  eq(pd.pdEmptyStateKind('no-location', 'radius'), 'location-required');
  eq(pd.pdEmptyStateKind(null, 'all', 'location-error'), 'no-prices');
  eq(pd.pdEmptyStateKind('no-cities', 'city', 'locating'), 'no-prices');
});

await test('idle sheet: GPS CTA routes to _pdUseCurrentLocation, address CTA present', () => {
  const s = makeSheet({ geo: geoStub() });
  ok(s.body.innerHTML.includes(GPS_CTA), 'GPS CTA'); ok(s.body.innerHTML.includes(ADDR_CTA), 'address CTA');
  ok(!s.body.innerHTML.includes(GENERIC), 'no generic');
});

await test('click → visible in-sheet locating state; geolocation requested once with unchanged options', async () => {
  const g = geoStub(); const s = makeSheet({ geo: g });
  s.useCurrent();
  ok(s.body.innerHTML.includes(LOCATING), 'locating text visible');
  ok(!s.body.innerHTML.includes(GENERIC), 'no generic while locating');
  ok(!s.body.innerHTML.includes(GPS_CTA), 'GPS CTA hidden while locating (no double request)');
  ok(s.body.innerHTML.includes(ADDR_CTA), 'address CTA still available');
  eq(g.calls, 1, 'getCurrentPosition calls');
  eq(JSON.stringify(g.opts), JSON.stringify({ timeout: 8000, maximumAge: 60000, enableHighAccuracy: false }), 'options');
  eq(s.state().gps, 'locating');
});

await test('pdGpsErrorKind maps GeolocationPositionError codes; anything else is unknown', () => {
  eq(pd.pdGpsErrorKind({ code: 1 }), 'denied');
  eq(pd.pdGpsErrorKind({ code: 2 }), 'unavailable');
  eq(pd.pdGpsErrorKind({ code: 3 }), 'timeout');
  eq(pd.pdGpsErrorKind({ code: 99 }), 'unknown');
  eq(pd.pdGpsErrorKind(new Error('boom')), 'unknown');
  eq(pd.pdGpsErrorKind(null), 'unknown');
});

const others = kind => Object.entries(MSG).filter(([k]) => k !== kind).map(([, m]) => m[0]);
for (const [kind, code] of [['denied', 1], ['unavailable', 2], ['timeout', 3], ['unknown', 0]]) {
  await test(`${kind} (code ${code}) → its own in-sheet message, retry + address, never generic`, async () => {
    const g = geoStub(); const s = makeSheet({ geo: g });
    const p = s.useCurrent();
    g.err({ code, message: kind });
    await p;
    const html = s.body.innerHTML;
    ok(html.includes(ERROR), 'error panel');
    for (const m of MSG[kind]) ok(html.includes(m), `message: ${m}`);
    for (const m of others(kind)) ok(!html.includes(m), `must not show other reason: ${m}`);
    eq(html.includes(PERM_HELP), kind === 'denied', 'permission instructions only on denial');
    ok(html.includes(RETRY), 'retry label'); ok(html.includes(GPS_CTA), 'retry wired');
    ok(html.includes(ADDR_ALT), 'address label'); ok(html.includes(ADDR_CTA), 'address CTA');
    ok(!/פתח הגדרות|open settings/i.test(html), 'no fake settings button');
    ok(!html.includes(GENERIC), 'no generic'); ok(!html.includes(LOCATING), 'locating cleared');
    eq(s.state().gps, 'location-error'); eq(s.state().loc, null, 'no location saved');
    eq(s.store.selectedLocation, undefined, 'localStorage untouched');
    eq(s.log.fetches.length, 0, 'no price request');
    s.render();  // any later re-render keeps the same error, not generic
    ok(s.body.innerHTML.includes(MSG[kind][0]) && !s.body.innerHTML.includes(GENERIC), 'stable on re-render');
  });
}

await test('geolocation API missing → inline error (not a silent no-op)', async () => {
  const s = makeSheet({ geo: undefined });
  await s.useCurrent();
  ok(s.body.innerHTML.includes(ERROR), 'error panel'); ok(s.body.innerHTML.includes(MSG.unknown[0]), 'fallback message');
  ok(!s.body.innerHTML.includes(PERM_HELP), 'no permission instructions');
  ok(!s.body.innerHTML.includes(GENERIC), 'no generic');
});

await test('denied → retry times out → message follows latest reason; retry then success clears it', async () => {
  const g = geoStub(); const s = makeSheet({ geo: g });
  let p = s.useCurrent(); g.err({ code: 1 }); await p;
  p = s.useCurrent(); ok(s.body.innerHTML.includes(LOCATING), 'locating on retry'); g.err({ code: 3 }); await p;
  ok(s.body.innerHTML.includes(MSG.timeout[0]) && !s.body.innerHTML.includes(PERM_HELP), 'reason follows latest failure');
  p = s.useCurrent(); g.ok(HAIFA_POS); await p; await tick();
  ok(!s.body.innerHTML.includes(ERROR), 'error cleared after success');
});

await test('retry after failure → locating again, second request, success clears error', async () => {
  const g = geoStub(); const s = makeSheet({ geo: g });
  let p = s.useCurrent(); g.err({ code: 1 }); await p;
  p = s.useCurrent();
  ok(s.body.innerHTML.includes(LOCATING), 'locating on retry'); eq(g.calls, 2, 'second request');
  g.ok(HAIFA_POS); await p; await tick();
  eq(s.state().gps, 'idle'); ok(!s.body.innerHTML.includes(ERROR), 'error cleared');
  eq(s.state().loc.lat, 32.794);
});

await test('success → coordinates saved (state + localStorage) and distance results refreshed', async () => {
  const g = geoStub(); const s = makeSheet({ geo: g });
  const p = s.useCurrent(); g.ok(HAIFA_POS); await p;
  const loc = s.state().loc;
  eq(loc.lat, 32.794); eq(loc.lng, 34.9896); eq(loc.source, 'gps');
  eq(JSON.parse(s.store.selectedLocation).lat, 32.794, 'persisted');
  eq(s.state().gps, 'idle', 'state reset before refresh');
  eq(s.log.fetches.length, 1, 'refresh issued'); eq(s.log.fetches[0].lng, 34.9896, 'refresh used GPS coords');
  await tick();
  ok(!s.body.innerHTML.includes(LOCATING), 'locating replaced by refresh result');
  ok(!s.body.innerHTML.includes(ERROR), 'no error');
});

await test('System-1 selectLocGPS failure leaves the sheet GPS state untouched', async () => {
  const g = geoStub(); const s = makeSheet({ geo: g });
  const p = s.win.selectLocGPS(); g.err({ code: 1 });
  eq(await p, 'denied', 'reports failure reason'); eq(s.state().gps, 'idle');
  ok(s.log.toasts.length === 1, 'existing toast still fires');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

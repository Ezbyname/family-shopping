// tests/geocode-i18n.test.mjs
// FS-I18N-ADDR-001 — the manual-address modal showed the backend's English
// `data.error` ("Address too vague — please include a street number and city") in
// the Hebrew UI. Errors must be mapped to Hebrew by HTTP status; `data.error` must
// never reach the UI; the "אולי התכוונת" suggestion and the success path stay intact.
//
// Runs the REAL window.submitManualAddress (+ its Hebrew map) extracted from app.js.
// APP_SRC=<path> runs the suite against another copy of app.js (negative control).
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const app = readFileSync(process.env.APP_SRC || new URL('../app.js', import.meta.url), 'utf8');
function sliceBody(start, label) {
  let i = app.indexOf('{', app.indexOf(')', start)), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${label}`);
}
function extractFn(name) {
  const start = app.search(new RegExp(`function\\s+${name}\\s*\\(`));
  return start < 0 ? '' : sliceBody(start, name);
}
function extractWindowFn(name) {
  const start = app.search(new RegExp(`window\\.${name}\\s*=\\s*(async\\s+)?function\\s*\\(`));
  if (start < 0) throw new Error(`window.${name} not found in app.js`);
  return sliceBody(start, name) + ';';
}
const heMap     = app.match(/const _GEOCODE_ERROR_HE = \{[\s\S]*?\n\};/)?.[0] || '';
const heDefault = app.match(/const _GEOCODE_ERROR_HE_DEFAULT = '[^']*';/)?.[0] || '';

const SRC = [heMap, heDefault, extractFn('_geocodeErrorMessage'), extractWindowFn('submitManualAddress')].join('\n');

const HE = {
  422:   'הכתובת כללית מדי — יש להזין רחוב, מספר ועיר',
  404:   'לא הצלחנו למצוא את הכתובת — בדוק את הפרטים ונסה שוב',
  429:   'בוצעו יותר מדי ניסיונות — המתן מעט ונסה שוב',
  503:   'שירות איתור הכתובת אינו זמין כרגע — נסה שוב מאוחר יותר',
  other: 'לא הצלחנו לאתר את הכתובת — נסה שוב',
};
// Exact English bodies api/geocode.js returns today
const BACKEND = {
  422: { error: 'Address too vague — please include a street number and city', confidence: 'APPROXIMATE', suggestion: 'חיפה, ישראל' },
  404: { error: 'No geocoding result', address: 'xyz' },
  429: { error: 'Geocoding rate limit — try again in a moment' },
  503: { error: 'Geocoding service unavailable' },
  502: { error: 'Geocoding failed: UNKNOWN_ERROR' },
  400: { error: 'address required (min 3 chars)' },
};
const hasLatin = s => /[A-Za-z]/.test(s);

function el() {
  const classes = new Set();
  return { textContent: '', value: '', disabled: false, classes,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } };
}

// response: { status, body } | { status, rawText } (non-JSON) | { throws: true }
function makeApp(response, { address = 'פישמן 4 חיפה', query = '' } = {}) {
  const els = { 'addr-input': el(), 'addr-error': el(), 'addr-result': el(), 'addr-submit-btn': el() };
  els['addr-input'].value = address;
  const calls = { saved: [], set: [], closed: 0, toasts: [], searched: 0, fetched: [] };
  const env = {
    window: {},
    document: { getElementById: id => els[id] || null },
    fetch: async url => {
      calls.fetched.push(url);
      if (response.throws) throw new TypeError('Failed to fetch');
      const status = response.status;
      return {
        ok: status >= 200 && status < 300, status,
        json: async () => {
          if ('rawText' in response) throw new SyntaxError('Unexpected token <');
          return response.body;
        },
      };
    },
    _saveRecentLocation: loc => calls.saved.push(loc),
    _setLocation: loc => calls.set.push(loc),
    closeManualAddressModal: () => { calls.closed++; },
    toast: m => calls.toasts.push(m),
    lastSearchQuery: query,
    searchPrices: () => { calls.searched++; },
  };
  const factory = new Function(...Object.keys(env), `${SRC}\nreturn window.submitManualAddress;`);
  const submit = factory(...Object.values(env));
  return { submit, els, calls };
}

async function runError(status, body) {
  const a = makeApp({ status, body });
  await a.submit();
  return a;
}

console.log('\nFS-I18N-ADDR-001 — manual-address geocode errors in Hebrew');

for (const status of [422, 404, 429, 503]) {
  await test(`${status} → Hebrew message, backend English hidden`, async () => {
    const a = await runError(status, BACKEND[status]);
    eq(a.els['addr-error'].textContent, HE[status], 'error text');
    ok(!a.els['addr-error'].textContent.includes(BACKEND[status].error), 'backend data.error leaked');
    ok(!hasLatin(a.els['addr-error'].textContent), 'Latin characters in error');
    ok(a.els['addr-input'].classes.has('error'), 'input marked error');
    eq(a.els['addr-submit-btn'].disabled, false, 'button re-enabled');
    eq(a.els['addr-submit-btn'].textContent, 'חפש כתובת', 'button label restored');
    eq(a.calls.set.length, 0, 'no location set');
    eq(a.calls.saved.length, 0, 'nothing saved');
  });
}

for (const status of [502, 400, 500]) {
  await test(`unexpected ${status} → generic Hebrew message`, async () => {
    const a = await runError(status, BACKEND[status] || { error: 'Internal Server Error' });
    eq(a.els['addr-error'].textContent, HE.other, 'error text');
    ok(!hasLatin(a.els['addr-error'].textContent), 'Latin characters in error');
  });
}

await test('non-JSON error body (platform 502 page) → generic Hebrew, not "connection error"', async () => {
  const a = makeApp({ status: 502, rawText: '<html>Bad Gateway</html>' });
  await a.submit();
  eq(a.els['addr-error'].textContent, HE.other, 'error text');
});

await test('backend English never reaches any UI field (all statuses)', async () => {
  for (const [status, body] of Object.entries(BACKEND)) {
    const a = await runError(Number(status), body);
    for (const id of ['addr-error', 'addr-result']) {
      ok(!a.els[id].textContent.includes(body.error), `${status}: data.error leaked into #${id}`);
    }
    ok(a.calls.toasts.every(t => !t.includes(body.error)), `${status}: data.error leaked into toast`);
  }
});

await test('422 with suggestion → "אולי התכוונת" still shown', async () => {
  const a = await runError(422, BACKEND[422]);
  eq(a.els['addr-result'].textContent, 'אולי התכוונת: חיפה, ישראל', 'suggestion');
});

await test('422 partial-match body (English "did you mean") → Hebrew + suggestion', async () => {
  const a = await runError(422, { error: 'Address not found precisely — did you mean: פישמן 4, חיפה?', suggestion: 'פישמן 4, חיפה, ישראל', lat: 32.79, lng: 34.99 });
  eq(a.els['addr-error'].textContent, HE[422], 'error text');
  eq(a.els['addr-result'].textContent, 'אולי התכוונת: פישמן 4, חיפה, ישראל', 'suggestion');
  eq(a.calls.set.length, 0, 'partial match is not auto-accepted');
});

await test('error without suggestion → result line stays empty', async () => {
  const a = await runError(404, BACKEND[404]);
  eq(a.els['addr-result'].textContent, '', 'result');
});

await test('success → location saved, set, modal closed, toast, re-search', async () => {
  const a = makeApp({ status: 200, body: {
    address: 'פישמן 4 חיפה', formattedAddress: 'פישמן 4, חיפה, ישראל', lat: 32.79, lng: 34.99, confidence: 'ROOFTOP', source: 'google',
  } }, { query: 'חלב' });
  await a.submit();
  eq(a.els['addr-error'].textContent, '', 'no error');
  eq(a.els['addr-result'].textContent, '✅ פישמן 4, חיפה, ישראל', 'result line');
  eq(a.calls.set.length, 1, '_setLocation called');
  eq(a.calls.saved.length, 1, '_saveRecentLocation called');
  const loc = a.calls.set[0];
  eq(loc.label, 'פישמן 4, חיפה, ישראל', 'label');
  eq(loc.address, 'פישמן 4 חיפה', 'address');
  eq(loc.lat, 32.79, 'lat'); eq(loc.lng, 34.99, 'lng');
  eq(loc.source, 'manual', 'source');
  ok(!Number.isNaN(Date.parse(loc.createdAt)), 'createdAt ISO');
  eq(a.calls.saved[0], loc, 'same object saved and set');
  eq(a.calls.closed, 1, 'modal closed');
  ok(a.calls.toasts[0]?.startsWith('📌 מיקום נבחר: פישמן 4'), `toast: ${a.calls.toasts[0]}`);
  eq(a.calls.searched, 1, 're-search when a query is active');
  ok(a.calls.fetched[0] === `/api/geocode?address=${encodeURIComponent('פישמן 4 חיפה')}`, `url: ${a.calls.fetched[0]}`);
});

await test('success without formattedAddress → label falls back to typed address', async () => {
  const a = makeApp({ status: 200, body: { lat: 32.1, lng: 34.8 } }, { address: 'הרצל 1 חיפה' });
  await a.submit();
  eq(a.calls.set[0]?.label, 'הרצל 1 חיפה', 'label');
});

await test('network failure → existing "שגיאת חיבור" message kept', async () => {
  const a = makeApp({ throws: true });
  await a.submit();
  eq(a.els['addr-error'].textContent, 'שגיאת חיבור — נסה שוב', 'error text');
  eq(a.els['addr-submit-btn'].disabled, false, 'button re-enabled');
});

await test('too-short input → local Hebrew validation, no fetch', async () => {
  const a = makeApp({ status: 200, body: {} }, { address: 'ab' });
  await a.submit();
  eq(a.els['addr-error'].textContent, 'נא להזין כתובת (לפחות 3 תווים)', 'error text');
  eq(a.calls.fetched.length, 0, 'no fetch');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// pw-bc-chains.mjs — Chain-expansion large-scale validation
//
// Tests the basket-compare feature against a matrix of chain × store counts to
// ensure the UI remains correct as supermarket coverage grows.
//
// Matrix tested:
//   5  chains ×  5 stores/chain =  25 stores  (mobile + desktop)
//   5  chains × 10 stores/chain =  50 stores  (mobile)
//  10  chains × 10 stores/chain = 100 stores  (mobile)
//  25  chains × 10 stores/chain = 250 stores  (mobile)
//
// Each scenario validates:
//   • All stores rendered after exhausting pagination
//   • No duplicate store IDs in the DOM
//   • Rank-0 is always the cheapest store (sorting invariant)
//   • Status line stays accurate at every pagination step
//   • All C chains are represented in results (no chain silently dropped)
//   • Savings calculation correct
//   • No app-level JS errors
//   • bc-sheet fits viewport
//
// Run: node tests/pw-bc-chains.mjs  (from family-shopping/ root)
// Requires: local static server on port 3333
//           npx serve . -l 3333 --no-clipboard

import { chromium } from 'playwright';
import { makeChainMatrix } from './e2e/fixtures/chain-factory.js';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE   = 'http://localhost:3333';
let passed = 0, failed = 0;
const ok   = label        => { console.log('  ✅', label); passed++; };
const fail = (label, why) => { console.log('  ❌', label, '—', why);  failed++; };

// ── Firebase stubs ──────────────────────────────────────────────────────────
const DBSTUB   = 'const noop=()=>{};export const getDatabase=()=>({}),ref=()=>({}),get=async()=>({exists:()=>false,val:()=>null}),set=async()=>{},update=async()=>{},push=async()=>({key:"k"}),remove=async()=>{},onValue=(r,cb)=>{cb({exists:()=>false,val:()=>null});return noop;},off=noop,query=(r)=>r,limitToFirst=()=>null,orderByChild=()=>null,equalTo=()=>null,orderByKey=()=>null,serverTimestamp=()=>Date.now(),increment=(v)=>v;';
const AUTHSTUB = 'const noop=()=>{};export const getAuth=()=>({}),signInAnonymously=async()=>({user:{uid:"stub",isAnonymous:true}}),onAuthStateChanged=(auth,cb)=>{setTimeout(()=>cb({uid:"stub",isAnonymous:true}),100);return noop;},signOut=async()=>{};';
const APPSTUB  = 'export const initializeApp=()=>({name:"stub",options:{}});';
const STORSTUB = 'export const getStorage=()=>({}),ref=()=>({}),uploadBytes=async()=>({}),getDownloadURL=async()=>"";';

async function waitForFn(page, name, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(n => typeof window[n] === 'function', name)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function setupPage(ctx, matrix) {
  const page = await ctx.newPage();
  const consoleErrors = [], failedReqs = [];
  page.on('console',       m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', r => failedReqs.push(r.url()));

  // Inject test hooks into app.js (production file stays clean)
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    const body     = await response.text();
    const patched  = body.replace(
      'function _bcRenderCard(s, rank, bestTotal, isChampion) {',
      // Expose render entrypoint + result accessor for chain-coverage checks
      'window._bcRenderForTest=(data)=>_renderBasketCompare(data,[]);\n' +
      'window._getBcAllResults=()=>_bcAllResults;\n' +
      'function _bcRenderCard(s, rank, bestTotal, isChampion) {'
    );
    await route.fulfill({ response, body: patched });
  });

  await page.route('https://www.gstatic.com/**firebase-app.js',     r => r.fulfill({ contentType:'application/javascript', body:APPSTUB  }));
  await page.route('https://www.gstatic.com/**firebase-database.js',r => r.fulfill({ contentType:'application/javascript', body:DBSTUB   }));
  await page.route('https://www.gstatic.com/**firebase-auth.js',    r => r.fulfill({ contentType:'application/javascript', body:AUTHSTUB }));
  await page.route('https://www.gstatic.com/**firebase-storage.js', r => r.fulfill({ contentType:'application/javascript', body:STORSTUB }));
  await page.route('**firebaseio.com**',  r => r.abort());
  await page.route('**identitytoolkit**', r => r.abort());

  await page.route('**/api/basket-compare', r =>
    r.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(matrix.payload) })
  );

  return { page, consoleErrors, failedReqs };
}

// ── Exhaust pagination, verify count + status at every step ────────────────
async function exhaustPagination(page, totalExpected, L) {
  const PAGE_SIZE  = 10;
  let shown        = 10;
  let clickCount   = 0;
  const maxClicks  = Math.ceil(totalExpected / PAGE_SIZE) + 2;

  while (shown < totalExpected && clickCount < maxClicks) {
    const btn = page.locator('#bc-show-more');
    if (!await btn.isVisible().catch(() => false)) break;

    await btn.click();
    await page.waitForTimeout(150);
    clickCount++;

    const expected = Math.min(shown + PAGE_SIZE, totalExpected);
    const count    = await page.locator('.bc-rank-card').count();
    const status   = await page.locator('#bc-status').innerText().catch(() => '');

    count === expected
      ? ok(`${L} click ${clickCount}: ${count} cards`)
      : fail(`${L} click ${clickCount} count`, `exp ${expected} got ${count}`);

    status.includes(`1–${expected}`) && status.includes(`${totalExpected}`)
      ? ok(`${L} click ${clickCount}: status accurate`)
      : fail(`${L} click ${clickCount} status`, `"${status.trim()}"`);

    shown = expected;
  }

  return shown;
}

// ── Run one scenario ────────────────────────────────────────────────────────
async function runScenario(browser, viewport, vpLabel, matrix) {
  const { chainCount, storesPerChain, totalStores, cheapestTotal, maxSavings, chainIds } = matrix;
  const L = `[${vpLabel}][${chainCount}C×${storesPerChain}S=${totalStores}]`;

  console.log(`\n── ${L} ──`);
  const ctx = await browser.newContext({ viewport, locale:'he-IL' });
  const { page, consoleErrors } = await setupPage(ctx, matrix);

  await page.goto(BASE, { waitUntil:'domcontentloaded', timeout:20000 });
  const ready = await waitForFn(page, 'openBasketCompare', 15000);
  if (!ready) { fail(`${L} init`, 'openBasketCompare not defined'); await ctx.close(); return; }
  ok(`${L} app loaded`);

  // Render via test hook
  await page.evaluate(data => {
    const overlay = document.getElementById('bc-overlay');
    const sub     = document.getElementById('bc-sub');
    if (overlay) { overlay.classList.add('show'); document.body.classList.add('sheet-open'); }
    if (sub) sub.textContent = '5 מוצרים · כל הארץ';
    if (typeof window._bcRenderForTest === 'function') window._bcRenderForTest(data);
  }, matrix.payload);
  await page.waitForTimeout(500);

  // [1] Savings banner
  const bannerOk = await page.locator('.bc-savings-banner').isVisible().catch(() => false);
  bannerOk ? ok(`${L} [1] savings banner`) : fail(`${L} [1] savings banner`, 'not visible');
  if (bannerOk) {
    const txt = await page.locator('.bc-savings-banner').innerText();
    txt.includes(maxSavings.toFixed(2))
      ? ok(`${L} [1] savings ₪${maxSavings.toFixed(2)} correct`)
      : fail(`${L} [1] savings amount`, `"${txt}"`);
  }

  // [2] Hero = cheapest store
  const heroOk = await page.locator('.bc-hero').isVisible().catch(() => false);
  heroOk ? ok(`${L} [2] hero card visible`) : fail(`${L} [2] hero card`, 'not visible');
  if (heroOk) {
    const price = await page.locator('.bc-hero-price').innerText().catch(() => '');
    price.includes(cheapestTotal.toFixed(2))
      ? ok(`${L} [2] hero = cheapest ₪${cheapestTotal.toFixed(2)}`)
      : fail(`${L} [2] hero price`, `"${price}" exp "${cheapestTotal.toFixed(2)}"`);
  }

  // [3] Initial render: 10 cards (pagination active for >10 stores)
  const initCards = await page.locator('.bc-rank-card').count();
  initCards === 10
    ? ok(`${L} [3] initial 10 cards`)
    : fail(`${L} [3] initial count`, `exp 10 got ${initCards}`);

  const status0 = await page.locator('#bc-status').innerText().catch(() => '');
  status0.includes('1–10') && status0.includes(`${totalStores}`)
    ? ok(`${L} [3] status "מציג 1–10 מתוך ${totalStores}"`)
    : fail(`${L} [3] status`, `"${status0}"`);

  // [4] Chain diversity in first 10 cards (interleaved store order)
  // For chainCount ≤ 10: first 10 results contain stores from each chain
  if (chainCount <= 10) {
    const firstIds = await page.locator('.bc-rank-card').evaluateAll(cs => cs.map(c => c.id));
    // card IDs are bc-card-0..bc-card-9; we check chain distribution via _getBcAllResults
    const first10 = await page.evaluate(() => {
      const all = typeof window._getBcAllResults === 'function' ? window._getBcAllResults() : [];
      return all.slice(0, 10).map(r => r.chainId);
    });
    const chainsInFirst10 = new Set(first10).size;
    chainsInFirst10 === chainCount
      ? ok(`${L} [4] all ${chainCount} chains in first 10 results`)
      : fail(`${L} [4] chain diversity`, `${chainsInFirst10}/${chainCount} chains in first 10`);
  } else {
    // For >10 chains, first 10 results still represent 10 unique chains (min guarantee)
    const first10 = await page.evaluate(() => {
      const all = typeof window._getBcAllResults === 'function' ? window._getBcAllResults() : [];
      return all.slice(0, 10).map(r => r.chainId);
    });
    new Set(first10).size === 10
      ? ok(`${L} [4] 10 distinct chains in first 10 results`)
      : fail(`${L} [4] chain diversity`, `${new Set(first10).size} chains in first 10`);
  }

  // [5] Exhaust pagination
  const showOk = await page.locator('#bc-show-more').isVisible().catch(() => false);
  if (showOk) {
    const shown = await exhaustPagination(page, totalStores, L);

    const finalCards = await page.locator('.bc-rank-card').count();
    finalCards === totalStores
      ? ok(`${L} [5] all ${totalStores} cards after pagination`)
      : fail(`${L} [5] final count`, `exp ${totalStores} got ${finalCards}`);

    // Show More hidden
    const gone = await page.locator('#bc-show-more').isVisible().catch(() => false);
    !gone ? ok(`${L} [5] Show More hidden`) : fail(`${L} [5] Show More hidden`, 'still visible');

    // [6] No duplicate store IDs
    const ids    = await page.locator('.bc-rank-card').evaluateAll(cs => cs.map(c => c.id));
    const unique = new Set(ids);
    unique.size === ids.length
      ? ok(`${L} [6] no duplicate cards (${ids.length} unique)`)
      : fail(`${L} [6] duplicates`, `${ids.length - unique.size} duplicate(s)`);

    // [7] All chains represented in full results
    const allResults = await page.evaluate(() =>
      typeof window._getBcAllResults === 'function' ? window._getBcAllResults() : []
    );
    const renderedChains = new Set(allResults.map(r => r.chainId));
    renderedChains.size === chainCount
      ? ok(`${L} [7] all ${chainCount} chains represented`)
      : fail(`${L} [7] chain coverage`, `${renderedChains.size}/${chainCount} chains`);

    // [8] Sorting: rank-0 has cheapest total
    const rank0Price = await page.locator('#bc-card-0 .bc-rank-price').innerText().catch(() => '');
    rank0Price.includes(cheapestTotal.toFixed(2))
      ? ok(`${L} [8] rank-0 is cheapest ₪${cheapestTotal.toFixed(2)}`)
      : fail(`${L} [8] rank-0 sort`, `"${rank0Price}" exp "${cheapestTotal.toFixed(2)}"`);
  }

  // [9] No app-level JS errors
  const appErrors = consoleErrors.filter(e =>
    !e.includes('firebaseio') && !e.includes('identitytoolkit') &&
    !e.includes('favicon')   && !e.includes('404') && !e.includes('ERR_ABORTED') &&
    !e.includes('fonts.google') && !e.includes('gstatic')
  );
  appErrors.length === 0
    ? ok(`${L} [9] no console errors`)
    : fail(`${L} [9] console errors`, appErrors.slice(0,2).join(' | '));

  // [10] Sheet fits viewport
  const box = await page.locator('.bc-sheet').boundingBox().catch(() => null);
  if (box) {
    box.width <= viewport.width
      ? ok(`${L} [10] sheet (${Math.round(box.width)}px) fits viewport (${viewport.width}px)`)
      : fail(`${L} [10] overflow`, `${Math.round(box.width)}px > ${viewport.width}px`);
  }

  await ctx.close();
}

// ── Test matrix ─────────────────────────────────────────────────────────────
const MOBILE  = { width:393,  height:851,  isMobile:true,  deviceScaleFactor:2.75 };
const DESKTOP = { width:1280, height:800,  isMobile:false, deviceScaleFactor:1    };

const SCENARIOS = [
  // [chainCount, storesPerChain, viewports]
  [ 5,  5,  [['Mobile',  MOBILE], ['Desktop', DESKTOP]] ],  // 25 stores — both viewports
  [ 5,  10, [['Mobile',  MOBILE]                      ] ],  // 50 stores
  [10,  10, [['Mobile',  MOBILE]                      ] ],  // 100 stores
  [25,  10, [['Mobile',  MOBILE]                      ] ],  // 250 stores
];

(async () => {
  console.log('\n━━━ Chain Expansion — Large-Scale Validation ━━━\n');

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--ignore-certificate-errors','--disable-web-security'],
    headless: true,
  });

  for (const [chainCount, storesPerChain, viewports] of SCENARIOS) {
    const matrix = makeChainMatrix(chainCount, storesPerChain);
    for (const [vpLabel, viewport] of viewports) {
      await runScenario(browser, viewport, vpLabel, matrix);
    }
  }

  await browser.close();

  const total = passed + failed;
  console.log(`\n━━━ Final: ${passed} passed, ${failed} failed (${total} total) ━━━\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

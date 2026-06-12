// pw-bc-large.mjs — Large dataset validation for basket compare (50 & 100 stores)
//
// Strategic purpose: ensures that as supermarket coverage grows (more chains, more stores)
// the pagination, sorting, deduplication, and rendering remain correct at scale.
//
// Shares setup helpers with pw-bc-validate.mjs but focuses on scale-specific checks:
//   • Pagination exhaustion at 50 and 100 stores
//   • No duplicate store IDs in the DOM
//   • Rank-0 is always the cheapest (sorting correctness)
//   • Status line stays accurate throughout pagination
//   • UI remains stable and responsive (no crashes)
//
// Run: node tests/pw-bc-large.mjs (from family-shopping/)
// Requires: local static server on port 3333 (npx serve . -l 3333)

import { chromium } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE   = 'http://localhost:3333';
let passed = 0, failed = 0;
const ok   = label        => { console.log('  ✅', label); passed++; };
const fail = (label, why) => { console.log('  ❌', label, '—', why);  failed++; };

// ── Firebase stubs (same as pw-bc-validate.mjs) ────────────────────────────
const DBSTUB   = 'const noop=()=>{};export const getDatabase=()=>({}),ref=()=>({}),get=async()=>({exists:()=>false,val:()=>null}),set=async()=>{},update=async()=>{},push=async()=>({key:"k"}),remove=async()=>{},onValue=(r,cb)=>{cb({exists:()=>false,val:()=>null});return noop;},off=noop,query=(r)=>r,limitToFirst=()=>null,orderByChild=()=>null,equalTo=()=>null,orderByKey=()=>null,serverTimestamp=()=>Date.now(),increment=(v)=>v;';
const AUTHSTUB = 'const noop=()=>{};export const getAuth=()=>({}),signInAnonymously=async()=>({user:{uid:"stub",isAnonymous:true}}),onAuthStateChanged=(auth,cb)=>{setTimeout(()=>cb({uid:"stub",isAnonymous:true}),100);return noop;},signOut=async()=>{};';
const APPSTUB  = 'export const initializeApp=()=>({name:"stub",options:{}});';
const STORSTUB = 'export const getStorage=()=>({}),ref=()=>({}),uploadBytes=async()=>({}),getDownloadURL=async()=>"";';

// ── Chain-agnostic mock data ────────────────────────────────────────────────
// Uses generic chain names (רשת 1…5) — tests are valid regardless of which
// real chains are present.
function makeResults(n) {
  return Array.from({ length: n }, (_, i) => ({
    chainId:        `chain-${i % 5}`,
    chainName:      `רשת ${(i % 5) + 1}`,
    storeId:        `store-${i}`,
    storeName:      `סניף ${i + 1}`,
    city:           ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע'][i % 4],
    address:        `רחוב הרצל ${i + 1}`,
    latitude:       32.08 + i * 0.01,
    longitude:      34.78 + i * 0.01,
    distanceKm:     Math.round((1 + i * 0.3) * 10) / 10,
    total:          parseFloat((80 + i * 1.5).toFixed(2)),
    availableItems: 5,
    missingItems:   [],
    totalItems:     5,
    completeness:   100,
    hasFallbackData:false,
    items: [
      { barcode:'7290000001', name:'מוצר א', quantity:1, unitPrice:10+i,   totalPrice:10+i   },
      { barcode:'7290000002', name:'מוצר ב', quantity:2, unitPrice:15,      totalPrice:30     },
      { barcode:'7290000003', name:'מוצר ג', quantity:1, unitPrice:20,      totalPrice:20     },
      { barcode:'7290000004', name:'מוצר ד', quantity:1, unitPrice:12,      totalPrice:12     },
      { barcode:'7290000005', name:'מוצר ה', quantity:1, unitPrice:8+i*0.1, totalPrice:8+i*0.1},
    ],
  }));
}

async function waitForFn(page, name, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(n => typeof window[n] === 'function', name)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function setupPage(ctx, resultCount) {
  const page = await ctx.newPage();
  const consoleErrors = [], failedReqs = [];
  page.on('console',       m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('requestfailed', r => failedReqs.push(r.url()));

  // Inject test hook into app.js — production file untouched
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    const body     = await response.text();
    const patched  = body.replace(
      'function _bcRenderCard(s, rank, bestTotal, isChampion) {',
      'window._bcRenderForTest=(data)=>_renderBasketCompare(data,[]);\nfunction _bcRenderCard(s, rank, bestTotal, isChampion) {'
    );
    await route.fulfill({ response, body: patched });
  });

  await page.route('https://www.gstatic.com/**firebase-app.js',     r => r.fulfill({ contentType:'application/javascript', body:APPSTUB  }));
  await page.route('https://www.gstatic.com/**firebase-database.js',r => r.fulfill({ contentType:'application/javascript', body:DBSTUB   }));
  await page.route('https://www.gstatic.com/**firebase-auth.js',    r => r.fulfill({ contentType:'application/javascript', body:AUTHSTUB }));
  await page.route('https://www.gstatic.com/**firebase-storage.js', r => r.fulfill({ contentType:'application/javascript', body:STORSTUB }));
  await page.route('**firebaseio.com**',  r => r.abort());
  await page.route('**identitytoolkit**', r => r.abort());

  const results    = makeResults(resultCount);
  const best       = results[0];
  const maxTotal   = results[resultCount - 1].total;
  const maxSavings = parseFloat((maxTotal - best.total).toFixed(2));

  await page.route('**/api/basket-compare', r => r.fulfill({
    status:200, contentType:'application/json',
    body: JSON.stringify({
      version:'2.3.0', radiusKm:10, itemsRequested:5,
      bestFullBasket: best,
      summary: { cheapestTotal:best.total, priciestTotal:maxTotal, maxSavings, maxSavingsPct:15, storesFound:resultCount },
      results,
    }),
  }));

  return { page, consoleErrors, failedReqs, results, best, maxSavings };
}

// ── Exhaustive pagination helper ────────────────────────────────────────────
// Clicks Show More until it disappears, counting cards after each click.
async function exhaustPagination(page, totalExpected, L) {
  const PAGE_SIZE = 10;
  let shown = 10; // initial render

  let clickCount = 0;
  const maxClicks = Math.ceil(totalExpected / PAGE_SIZE) + 2; // safety ceiling

  while (shown < totalExpected && clickCount < maxClicks) {
    const btn = page.locator('#bc-show-more');
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;

    await btn.click();
    await page.waitForTimeout(200);
    clickCount++;

    const nextShown = Math.min(shown + PAGE_SIZE, totalExpected);
    const count = await page.locator('.bc-rank-card').count();
    const status = await page.locator('#bc-status').innerText().catch(() => '');

    // Verify count grows correctly each time
    count === nextShown
      ? ok(`${L} after click ${clickCount}: ${count} cards shown`)
      : fail(`${L} after click ${clickCount}: card count`, `exp ${nextShown} got ${count}`);

    // Verify status line is accurate
    status.includes(`1–${nextShown}`) && status.includes(`${totalExpected}`)
      ? ok(`${L} status line accurate: "${status.trim()}"`)
      : fail(`${L} status line at click ${clickCount}`, `got:"${status}"`);

    shown = nextShown;
  }

  return { shown, clickCount };
}

(async () => {
  console.log('\n━━━ Basket Compare — Large Dataset Validation ━━━\n');

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--ignore-certificate-errors','--disable-web-security'],
    headless: true,
  });

  for (const [vpLabel, viewport] of [
    ['Mobile (393×851)',  { width:393,  height:851,  isMobile:true,  deviceScaleFactor:2.75 }],
    ['Desktop (1280×800)', { width:1280, height:800,  isMobile:false, deviceScaleFactor:1    }],
  ]) {
    for (const resultCount of [50, 100]) {
      const L = `[${vpLabel}][${resultCount} stores]`;
      console.log(`\n── ${L} ──`);

      const ctx = await browser.newContext({ viewport, locale:'he-IL' });
      const { page, consoleErrors, failedReqs, results, best, maxSavings } = await setupPage(ctx, resultCount);
      const maxTotal = results[resultCount - 1].total;

      await page.goto(BASE, { waitUntil:'domcontentloaded', timeout:20000 });
      const ready = await waitForFn(page, 'openBasketCompare', 15000);
      if (!ready) { fail(`${L} init`, 'openBasketCompare not defined'); await ctx.close(); continue; }
      ok(`${L} app loaded`);

      // Open modal and render via test hook
      await page.evaluate((data) => {
        const overlay = document.getElementById('bc-overlay');
        const sub     = document.getElementById('bc-sub');
        if (overlay) { overlay.classList.add('show'); document.body.classList.add('sheet-open'); }
        if (sub) sub.textContent = '5 מוצרים · כל הארץ';
        if (typeof window._bcRenderForTest === 'function') window._bcRenderForTest(data);
      }, {
        version:'2.3.0', radiusKm:10, itemsRequested:5, bestFullBasket:best,
        summary:{ cheapestTotal:best.total, priciestTotal:maxTotal, maxSavings, maxSavingsPct:15, storesFound:resultCount },
        results,
      });
      await page.waitForTimeout(600);

      // [1] Savings banner visible and correct
      const bannerOk = await page.locator('.bc-savings-banner').isVisible().catch(() => false);
      bannerOk ? ok(`${L} [1] savings banner visible`) : fail(`${L} [1] savings banner`, 'not visible');
      if (bannerOk) {
        const txt = await page.locator('.bc-savings-banner').innerText();
        txt.includes(maxSavings.toFixed(2))
          ? ok(`${L} [1] savings amount ₪${maxSavings.toFixed(2)} correct`)
          : fail(`${L} [1] savings amount`, `text:"${txt}"`);
      }

      // [2] Hero card
      const heroOk = await page.locator('.bc-hero').isVisible().catch(() => false);
      heroOk ? ok(`${L} [2] hero card visible`) : fail(`${L} [2] hero card`, 'not visible');

      // [3] Initial 10 cards rendered (pagination active for >10)
      const initialCards = await page.locator('.bc-rank-card').count();
      initialCards === 10
        ? ok(`${L} [3] initial 10 cards rendered`)
        : fail(`${L} [3] initial card count`, `exp 10 got ${initialCards}`);

      // [4] Status line shows correct initial state
      const status0 = await page.locator('#bc-status').innerText().catch(() => '');
      status0.includes('1–10') && status0.includes(`${resultCount}`)
        ? ok(`${L} [4] status: "${status0.trim()}"`)
        : fail(`${L} [4] status line`, `got:"${status0}"`);

      // [5] Show More button present
      const showOk = await page.locator('#bc-show-more').isVisible().catch(() => false);
      showOk ? ok(`${L} [5] Show More button present`) : fail(`${L} [5] Show More`, 'not visible');

      // [6] Rank-0 is the cheapest (sorting invariant regardless of store count)
      const rankZeroPrice = await page.locator('#bc-card-0 .bc-rank-price').innerText().catch(() => '');
      rankZeroPrice.includes(best.total.toFixed(2))
        ? ok(`${L} [6] rank-0 is cheapest (₪${best.total.toFixed(2)})`)
        : fail(`${L} [6] rank-0 sorting`, `got:"${rankZeroPrice}" exp:"${best.total.toFixed(2)}"`);

      // [7] Exhaust pagination — click Show More until all stores shown
      if (showOk) {
        const { shown } = await exhaustPagination(page, resultCount, L);

        // Final count matches total
        const finalCards = await page.locator('.bc-rank-card').count();
        finalCards === resultCount
          ? ok(`${L} [7] all ${resultCount} cards shown after full pagination`)
          : fail(`${L} [7] final card count`, `exp ${resultCount} got ${finalCards}`);

        // Show More hidden when exhausted
        const gone = await page.locator('#bc-show-more').isVisible().catch(() => false);
        !gone
          ? ok(`${L} [7] Show More hidden after exhaustion`)
          : fail(`${L} [7] Show More hidden`, 'still visible');

        // [8] No duplicate store IDs in the DOM
        const ids = await page.locator('.bc-rank-card').evaluateAll(cards =>
          cards.map(c => c.id)
        );
        const unique = new Set(ids);
        unique.size === ids.length
          ? ok(`${L} [8] no duplicate cards (${ids.length} unique IDs)`)
          : fail(`${L} [8] duplicates`, `${ids.length - unique.size} duplicate(s)`);
      }

      // [9] No app-level JS errors
      const appErrors = consoleErrors.filter(e =>
        !e.includes('firebaseio') && !e.includes('identitytoolkit') &&
        !e.includes('favicon')   && !e.includes('404') && !e.includes('ERR_ABORTED') &&
        !e.includes('fonts.google') && !e.includes('gstatic')
      );
      appErrors.length === 0
        ? ok(`${L} [9] no app-level console errors`)
        : fail(`${L} [9] console errors`, appErrors.slice(0,2).join(' | '));

      // [10] Viewport: bc-sheet fits within screen width
      const sheetBox = await page.locator('.bc-sheet').boundingBox().catch(() => null);
      if (sheetBox) {
        sheetBox.width <= viewport.width
          ? ok(`${L} [10] bc-sheet (${Math.round(sheetBox.width)}px) fits viewport (${viewport.width}px)`)
          : fail(`${L} [10] bc-sheet overflow`, `${Math.round(sheetBox.width)}px > ${viewport.width}px`);
      }

      await ctx.close();
    }
  }

  await browser.close();

  const total = passed + failed;
  console.log(`\n━━━ Final: ${passed} passed, ${failed} failed (${total} total) ━━━\n`);
  process.exit(failed > 0 ? 1 : 0);
})();

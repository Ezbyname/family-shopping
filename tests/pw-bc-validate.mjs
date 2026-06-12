import { chromium, devices } from 'playwright';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE   = 'http://localhost:3333';
let passed = 0, failed = 0;
const ok   = label        => { console.log('  ✅', label); passed++; };
const fail = (label, why) => { console.log('  ❌', label, '—', why);  failed++; };

const DBSTUB   = 'const noop=()=>{};export const getDatabase=()=>({}),ref=()=>({}),get=async()=>({exists:()=>false,val:()=>null}),set=async()=>{},update=async()=>{},push=async()=>({key:"k"}),remove=async()=>{},onValue=(r,cb)=>{cb({exists:()=>false,val:()=>null});return noop;},off=noop,query=(r)=>r,limitToFirst=()=>null,orderByChild=()=>null,equalTo=()=>null,orderByKey=()=>null,serverTimestamp=()=>Date.now(),increment=(v)=>v;';
const AUTHSTUB = 'const noop=()=>{};export const getAuth=()=>({}),signInAnonymously=async()=>({user:{uid:"stub",isAnonymous:true}}),onAuthStateChanged=(auth,cb)=>{setTimeout(()=>cb({uid:"stub",isAnonymous:true}),100);return noop;},signOut=async()=>{};';
const APPSTUB  = 'export const initializeApp=()=>({name:"stub",options:{}});';
const STORSTUB = 'export const getStorage=()=>({}),ref=()=>({}),uploadBytes=async()=>({}),getDownloadURL=async()=>"";';

function makeResults(n) {
  const chains = ['שופרסל','רמי לוי','ויקטורי','יוחננוף','קרפור'];
  return Array.from({ length: n }, (_, i) => ({
    chainId:`00${(i%chains.length)+1}`, chainName:chains[i%chains.length],
    storeId:`store-${i+1}`, storeName:`סניף ${i+1}`,
    city:['תל אביב','ירושלים','חיפה','באר שבע'][i%4], address:`רחוב הרצל ${i+1}`,
    latitude:32.08+i*0.01, longitude:34.78+i*0.01,
    distanceKm:Math.round((1+i*0.3)*10)/10,
    total:80+i*2.5, availableItems:5, missingItems:[], totalItems:5,
    completeness:100, hasFallbackData:false,
    items:[
      {barcode:'7290000001',name:'חלב תנובה',  quantity:2,unitPrice:5.5, totalPrice:11},
      {barcode:'7290000002',name:'לחם אחיד',    quantity:1,unitPrice:8,   totalPrice:8},
      {barcode:'7290000003',name:'גבינה צהובה', quantity:1,unitPrice:25,  totalPrice:25},
      {barcode:'7290000004',name:'ביצים L',     quantity:1,unitPrice:18,  totalPrice:18},
      {barcode:'7290000005',name:'שמן זית',     quantity:1,unitPrice:18+i,totalPrice:18+i},
    ],
  }));
}

async function waitForFn(page, name, ms=15000) {
  const t0=Date.now();
  while(Date.now()-t0<ms){
    if(await page.evaluate(n=>typeof window[n]==='function',name)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function setupPage(ctx, resultCount) {
  const page = await ctx.newPage();
  const consoleErrors=[], failedReqs=[];
  page.on('console',m=>{ if(m.type()==='error') consoleErrors.push(m.text()); });
  page.on('requestfailed',r=>failedReqs.push(r.url()));

  await page.route('https://www.gstatic.com/**firebase-app.js',    r=>r.fulfill({contentType:'application/javascript',body:APPSTUB}));
  await page.route('https://www.gstatic.com/**firebase-database.js',r=>r.fulfill({contentType:'application/javascript',body:DBSTUB}));
  await page.route('https://www.gstatic.com/**firebase-auth.js',   r=>r.fulfill({contentType:'application/javascript',body:AUTHSTUB}));
  await page.route('https://www.gstatic.com/**firebase-storage.js',r=>r.fulfill({contentType:'application/javascript',body:STORSTUB}));
  await page.route('**firebaseio.com**',r=>r.abort());
  await page.route('**identitytoolkit**',r=>r.abort());

  const results=makeResults(resultCount), best=results[0];
  const maxTotal=results[resultCount-1].total;
  const maxSavings=Math.round((maxTotal-best.total)*100)/100;

  await page.route('**/api/basket-compare', r=>r.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({
      version:'2.3.0',radiusKm:10,itemsRequested:5,
      bestFullBasket:best,
      summary:{cheapestTotal:best.total,priciestTotal:maxTotal,maxSavings,maxSavingsPct:15,storesFound:resultCount},
      results,
    }),
  }));
  await page.route('**/api/coverage', r=>r.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({
      lastSync:'2026-06-12',totalProducts:125000,chainsSucceeded:3,chainsFailed:0,
      chains:[
        {id:'shufersal',name:'שופרסל',itemsProcessed:50000,storesProcessed:280,errors:0},
        {id:'rami-levy',name:'רמי לוי',itemsProcessed:30000,storesProcessed:87, errors:0},
        {id:'victory',  name:'ויקטורי',itemsProcessed:20000,storesProcessed:60, errors:1},
      ],
    }),
  }));

  return { page, consoleErrors, failedReqs, results, best, maxSavings };
}

(async () => {
  console.log('\n━━━ Compare Prices V2 — Manual Validation Checklist ━━━\n');

  const browser = await chromium.launch({
    executablePath:CHROME,
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
          '--ignore-certificate-errors','--disable-web-security'],
    headless:true,
  });

  for (const [vpLabel, viewport] of [
    ['Mobile (Pixel 5 — 393×851)',  {width:393, height:851, isMobile:true,  deviceScaleFactor:2.75}],
    ['Desktop (1280×800)',           {width:1280,height:800, isMobile:false, deviceScaleFactor:1   }],
  ]) {
    for (const resultCount of [10, 25]) {
      const L=`[${vpLabel}][${resultCount} stores]`;
      console.log(`\n── ${L} ──`);

      const ctx = await browser.newContext({viewport,locale:'he-IL'});
      const {page,consoleErrors,failedReqs,results,best,maxSavings} = await setupPage(ctx,resultCount);
      const maxTotal=results[resultCount-1].total;

      await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:20000});
      const ready=await waitForFn(page,'openBasketCompare',15000);
      if(!ready){ fail(`${L} app init`,'openBasketCompare not defined'); await ctx.close(); continue; }
      ok(`${L} app loaded & openBasketCompare defined`);

      // Open modal + inject rendered data directly via test hook
      // (bypasses Firebase-dependent items state; tests rendering logic only)
      await page.evaluate((data) => {
        const overlay = document.getElementById('bc-overlay');
        const sub     = document.getElementById('bc-sub');
        if (overlay) { overlay.classList.add('show'); document.body.classList.add('sheet-open'); }
        if (sub) sub.textContent = '5 מוצרים · כל הארץ';
        if (typeof window._bcRenderForTest === 'function') window._bcRenderForTest(data);
      }, { version:'2.3.0', radiusKm:10, itemsRequested:5, bestFullBasket:best,
           summary:{cheapestTotal:best.total,priciestTotal:maxTotal,maxSavings,maxSavingsPct:15,storesFound:resultCount},
           results });
      await page.waitForTimeout(600);

      // [1] Savings banner
      const bannerOk=await page.locator('.bc-savings-banner').isVisible().catch(()=>false);
      bannerOk ? ok(`${L} [1] savings banner visible`) : fail(`${L} [1] savings banner`,'not visible');
      if(bannerOk){
        const txt=await page.locator('.bc-savings-banner').innerText();
        txt.includes(maxSavings.toFixed(2))
          ? ok(`${L} [1] savings amount ₪${maxSavings.toFixed(2)} correct`)
          : fail(`${L} [1] savings amount`,`text:"${txt}"`);
      }

      // [2] Hero card + correct price
      const heroOk=await page.locator('.bc-hero').isVisible().catch(()=>false);
      heroOk ? ok(`${L} [2] hero card visible`) : fail(`${L} [2] hero card`,'not visible');
      if(heroOk){
        const price=await page.locator('.bc-hero-price').innerText().catch(()=>'');
        price.includes(best.total.toFixed(2))
          ? ok(`${L} [2] hero price ${price.trim()} correct`)
          : fail(`${L} [2] hero price`,`got:"${price}"`);
      }

      // [3] Medals for top 3
      for(const [r,medal] of [[0,'🥇'],[1,'🥈'],[2,'🥉']]){
        const html=await page.locator(`#bc-card-${r} .bc-rank-num`).innerHTML().catch(()=>'');
        html.includes(medal) ? ok(`${L} [3] ${medal} rank-${r}`) : fail(`${L} [3] ${medal}`,`got:"${html.trim()}"`);
      }

      // [4] Price diff on rank-1
      const delta=await page.locator('#bc-card-1 .bc-rank-delta').innerText().catch(()=>'');
      const expectedDelta=(results[1].total-best.total).toFixed(2);
      (delta.startsWith('+₪')&&delta.includes(expectedDelta))
        ? ok(`${L} [4] price diff +₪${expectedDelta} on rank-1`)
        : fail(`${L} [4] price diff`,`got:"${delta}" exp:"+₪${expectedDelta}"`);

      // [5] Address in card meta
      const meta=await page.locator('#bc-card-1 .bc-rank-meta').innerText().catch(()=>'');
      (meta.includes('רחוב')||meta.includes('תל')||meta.includes('ירושלים'))
        ? ok(`${L} [5] address in card meta: "${meta.trim()}"`)
        : fail(`${L} [5] address meta`,`got:"${meta}"`);

      // [6] Nav button still present
      const navTxt=await page.locator('.bc-hero-btn').first().innerText().catch(()=>'');
      navTxt.includes('נווט') ? ok(`${L} [6] nav button present`) : fail(`${L} [6] nav button`,`got:"${navTxt}"`);

      // [7-8] Pagination
      const cards=await page.locator('.bc-rank-card').count();
      if(resultCount<=10){
        cards===resultCount ? ok(`${L} [7] all ${resultCount} cards rendered (no paging)`) : fail(`${L} [7] card count`,`exp ${resultCount} got ${cards}`);
      } else {
        cards===10 ? ok(`${L} [7] initial 10 cards (paging active)`) : fail(`${L} [7] initial cards`,`exp 10 got ${cards}`);
        const status=await page.locator('#bc-status').innerText().catch(()=>'');
        (status.includes('1–10')&&status.includes(`${resultCount}`))
          ? ok(`${L} [7] status: "${status.trim()}"`)
          : fail(`${L} [7] status line`,`got:"${status}"`);

        const showBtn=page.locator('#bc-show-more');
        const showOk=await showBtn.isVisible().catch(()=>false);
        showOk ? ok(`${L} [8] Show More button present`) : fail(`${L} [8] Show More`,'not visible');

        if(showOk){
          await showBtn.click(); await page.waitForTimeout(400);
          const after=await page.locator('.bc-rank-card').count();
          after===20 ? ok(`${L} [8] Show More → 20 cards`) : fail(`${L} [8] Show More click`,`exp 20 got ${after}`);
          const s2=await page.locator('#bc-status').innerText().catch(()=>'');
          s2.includes('1–20') ? ok(`${L} [8] status updated: "${s2.trim()}"`) : fail(`${L} [8] status update`,`got:"${s2}"`);
          const still=await page.locator('#bc-show-more').isVisible().catch(()=>false);
          still ? ok(`${L} [8] Show More still visible (5 left)`) : fail(`${L} [8] Show More persist`,'gone too early');
          // Last click — show remaining 5
          await page.locator('#bc-show-more').click(); await page.waitForTimeout(300);
          const final=await page.locator('.bc-rank-card').count();
          final===25 ? ok(`${L} [8] all 25 cards shown after 3rd click`) : fail(`${L} [8] final count`,`exp 25 got ${final}`);
          const gone=await page.locator('#bc-show-more').isVisible().catch(()=>false);
          !gone ? ok(`${L} [8] Show More hidden when no more stores`) : fail(`${L} [8] Show More hidden`,'still visible at end');
        }
      }

      // [9] Breakdown toggle (existing functionality)
      const expBtn=page.locator('.bc-expand-btn').first();
      if(await expBtn.isVisible().catch(()=>false)){
        await expBtn.click(); await page.waitForTimeout(200);
        const open=await page.locator('#bc-breakdown-0').evaluate(el=>el.classList.contains('show')).catch(()=>false);
        open ? ok(`${L} [9] breakdown opens`) : fail(`${L} [9] breakdown open`,'no .show class');
        await expBtn.click(); await page.waitForTimeout(150);
        const shut=await page.locator('#bc-breakdown-0').evaluate(el=>!el.classList.contains('show')).catch(()=>false);
        shut ? ok(`${L} [9] breakdown closes`) : fail(`${L} [9] breakdown close`,'still open');
      }

      // [10] Diagnostics panel — open, verify content, close & restore
      const diagBtn=page.locator('.bc-diag-btn');
      if(await diagBtn.isVisible().catch(()=>false)){
        await diagBtn.click(); await page.waitForTimeout(800);
        const panelOk=await page.locator('.bc-diag-panel').isVisible().catch(()=>false);
        panelOk ? ok(`${L} [10] diagnostics panel opens`) : fail(`${L} [10] diag panel`,'not visible');
        if(panelOk){
          const rows=await page.locator('.bc-diag-row').count();
          rows===3 ? ok(`${L} [10] 3 chain rows shown`) : fail(`${L} [10] chain rows`,`got ${rows}`);
          const diagTxt=await page.locator('.bc-diag-panel').innerText();
          diagTxt.includes('⚠️') ? ok(`${L} [10] error chain shows ⚠️`) : fail(`${L} [10] error flag`,'no ⚠️');
          diagTxt.includes('125,000')||diagTxt.includes('125000')
            ? ok(`${L} [10] total products displayed`)
            : fail(`${L} [10] total products`,`text:"${diagTxt.substring(0,80)}"`);
          const closeBtn=page.locator('.bc-close-diag');
          if(await closeBtn.isVisible().catch(()=>false)){
            await closeBtn.click(); await page.waitForTimeout(300);
            const heroBack=await page.locator('.bc-hero').isVisible().catch(()=>false);
            heroBack ? ok(`${L} [10] diagnostics closed, results restored`) : fail(`${L} [10] diag close`,'results not back');
          }
        }
      }

      // [10b] Viewport sanity — modal fits screen
      const sheetBox=await page.locator('.bc-sheet').boundingBox().catch(()=>null);
      if(sheetBox){
        sheetBox.width<=viewport.width
          ? ok(`${L} [10b] bc-sheet width (${Math.round(sheetBox.width)}px) fits viewport (${viewport.width}px)`)
          : fail(`${L} [10b] bc-sheet overflow`,`${Math.round(sheetBox.width)}px > ${viewport.width}px`);
      }

      // [11] Console errors (ignore Firebase/font network failures we deliberately caused)
      const appErrors=consoleErrors.filter(e=>
        !e.includes('firebaseio')&&!e.includes('identitytoolkit')&&
        !e.includes('favicon')&&!e.includes('404')&&!e.includes('ERR_ABORTED')&&
        !e.includes('fonts.google')&&!e.includes('gstatic'));
      appErrors.length===0
        ? ok(`${L} [11] no app-level console errors`)
        : fail(`${L} [11] console errors`,appErrors.slice(0,2).join(' | '));

      // [12] Failed requests
      const appFails=failedReqs.filter(u=>
        !u.includes('firebaseio')&&!u.includes('identitytoolkit')&&
        !u.includes('fonts.google')&&!u.includes('gstatic'));
      appFails.length===0
        ? ok(`${L} [12] no unexpected failed requests`)
        : fail(`${L} [12] failed reqs`,appFails.slice(0,2).join(' | '));

      await ctx.close();
    }
  }

  await browser.close();
  console.log(`\n━━━ Final: ${passed} passed, ${failed} failed ━━━\n`);
  process.exit(failed>0?1:0);
})();

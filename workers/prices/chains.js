// workers/prices/chains.js
// Israeli supermarket price transparency feed configuration.
// Under Israeli law (חוק המזון), all chains must publish daily price files.
//
// To add a chain: add one object to CHAINS and restart the worker.

export const CHAINS = [
  {
    id:       'shufersal',
    name:     'שופרסל',
    chainId:  '7290027600007',
    enabled:  true,
    status:   'enabled',           // ✅ Verified 2026-05-24: multi-store, 422 stores in Firebase; PriceFull preferred over PriceUpdate
    lastVerified: '2026-05-24',
    sanityRequired: true,
    knownIssue: null,
    // Paginated Azure Blob index — one Price*.gz per store (NOT a single chain-wide PriceFull).
    // catID=0 → PriceUpdate files (incremental changes, ~40 items/store, published many/day)
    // catID=2 → PriceFull files  (complete catalog, 5000+ items/store, published once/day)
    // catID=5 → Stores files     (confirmed 2026-05-24)
    // resolveAllPriceUrls() scans catID=0 first, then pricefullCatIds to find PriceFull.
    // PAGE token is replaced with the page number.  SAS tokens stripped before .gz check.
    indexUrl:        'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=50&page=PAGE',
    pricefullCatIds: ['2', '1', '3'],  // catIDs to try when catID=0 yields no PriceFull files
    baseUrl:         'https://prices.shufersal.co.il',
    indexType:       'html',
    multiStore:      true,  // resolveAllPriceUrls() used instead of resolveFileUrls()
    maxStoresToSync: 422,   // fully verified 2026-05-25: 100→456k rows in 12min; all 422 stores enabled
    maxIndexPages:   10,    // pages to scan for store discovery
  },
  {
    id:       'rami-levy',
    name:     'רמי לוי',
    chainId:  '7290058140886',
    enabled:  false,
    // Phase 3 implementation complete 2026-06-22. Enable only after dry-run passes on VPS.
    // To enable: DRY_RUN=true node index.js rami-levy → confirm items > 1000, errors = 0
    //            then set enabled: true, status: 'enabled', lastVerified: today
    status:   'pending-dry-run',
    sanityRequired: false,
    knownIssue: null,
    // Auth: POST https://url.retail.publishedprices.co.il/login, username=RamiLevi, password=''
    // Files: PriceFull{chainId}-{storeId}-{YYYYMMDDHHmm}.gz listed at /file after login
    // Handled by rami-levy-auth.js + rami-levy-discovery.js + rami-levy.js
    syncModule: './rami-levy.js',  // custom module dispatch in index.js
    indexUrl:   'https://url.retail.publishedprices.co.il/file',
    baseUrl:    'https://url.retail.publishedprices.co.il',
    indexType:  'html',
  },
  {
    id:       'victory',
    name:     'ויקטורי',
    chainId:  '7290696200003',
    enabled:  false,
    status:   'pending',
    sanityRequired: false,
    knownIssue: 'matrixcatalog.co.il times out. Candidate: laibcatalog.co.il — not yet verified on VM.',
    indexUrl: 'https://laibcatalog.co.il/NBCompetitionRegulations.aspx',
    baseUrl:  'https://laibcatalog.co.il',
    indexType: 'html',
  },
  {
    id:       'yeinot-bitan',
    name:     'יינות ביתן / קרפור',
    chainId:  '7290873255550',
    enabled:  false,
    status:   'pending',
    sanityRequired: false,
    knownIssue: 'Rebranded as Carrefour IL. publishprice.ybitan.co.il ENOTFOUND. Candidate: prices.carrefour.co.il — not yet verified on VM.',
    indexUrl: 'https://prices.carrefour.co.il/',
    baseUrl:  'https://prices.carrefour.co.il',
    indexType: 'html',
  },
  {
    id:       'osher-ad',
    name:     'אושר עד',
    chainId:  '7290058179504',
    enabled:  false,
    status:   'pending',
    sanityRequired: false,
    knownIssue: 'osherad.co.il/prices/ returns HTTP 403. New URL unknown.',
    indexUrl: 'https://osherad.co.il/prices/',
    baseUrl:  'https://osherad.co.il',
    indexType: 'html',
  },
  {
    id:       'mahsanei-lahav',
    name:     'מחסני להב',
    chainId:  '7290055755557',
    enabled:  false,
    status:   'pending',
    sanityRequired: false,
    knownIssue: 'mega-market.co.il ENOTFOUND. Likely merged into Carrefour. New URL unknown.',
    indexUrl: 'https://prices.mega.co.il/',
    baseUrl:  'https://prices.mega.co.il',
    indexType: 'html',
  },
];

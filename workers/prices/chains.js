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
    // Paginated Azure Blob index — one Price*.gz per store (NOT a single PriceFull).
    // PAGE token is replaced with the page number in resolveAllPriceUrls().
    // SAS token URLs end with ?sv=... — gzip detection strips query string before .gz check.
    indexUrl: 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=50&page=PAGE',
    baseUrl:  'https://prices.shufersal.co.il',
    indexType: 'html',
    multiStore:      true,  // resolveAllPriceUrls() used instead of resolveFileUrls()
    maxStoresToSync: 5,     // ⬆ raise to 999 only after full end-to-end verification
    maxIndexPages:   10,    // pages to scan for store discovery
  },
  {
    id:       'rami-levy',
    name:     'רמי לוי',
    chainId:  '7290058140886',
    enabled:  false,
    status:   'pending',
    sanityRequired: false,
    knownIssue: 'url.retail.pe.il ENOTFOUND. Chain uses FTP (url.retail.publishedprices.co.il) — no confirmed HTTP index URL.',
    indexUrl: 'https://url.retail.publishedprices.co.il/MF/latest/7290058140886/',
    baseUrl:  'https://url.retail.publishedprices.co.il',
    indexType: 'html',
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

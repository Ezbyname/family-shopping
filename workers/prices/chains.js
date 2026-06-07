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
    status:   'needs-ftp',
    sanityRequired: false,
    // Verified 2026-06-07: domain resolves (194.90.26.22), geo-blocked from non-IL IPs (403 x-deny-reason: host_not_allowed).
    // Primary access is FTP port 21 (Cerberus engine), not HTTP.
    // HTTP index at /RamiLevi/ also available from IL IP.
    // Requires FTP client support in fetchPrices.js — not yet implemented.
    knownIssue: 'Requires FTP (port 21). Domain url.retail.publishedprices.co.il is alive and geo-blocked. HTTP index also available from IL IP. Worker needs FTP support before enabling.',
    indexUrl: 'https://url.retail.publishedprices.co.il/RamiLevi/',
    ftpHost:  'url.retail.publishedprices.co.il',
    ftpUser:  'RamiLevi',
    baseUrl:  'https://url.retail.publishedprices.co.il',
    indexType: 'html',
  },
  {
    id:       'victory',
    name:     'ויקטורי',
    chainId:  '7290696200003',
    enabled:  false,
    status:   'needs-json-parser',
    sanityRequired: false,
    // Verified 2026-06-07: matrixcatalog.co.il is dead. New source: laibcatalog.co.il.
    // Uses REST JSON API (not HTML directory listing): GET /webapi/api/getfiles?edi={chainId}
    // Returns JSON array of file objects. Domain is alive, geo-blocked from non-IL IPs.
    // Also used by chain ID 7290058103393.
    // Requires new indexType: 'json-api' handler in the worker — not yet implemented.
    knownIssue: 'laibcatalog.co.il is alive and geo-blocked. Uses JSON REST API (not HTML), needs new indexType handler. GET /webapi/api/getfiles?edi=7290696200003 returns file list.',
    indexUrl: 'https://laibcatalog.co.il/webapi/api/getfiles?edi=7290696200003',
    baseUrl:  'https://laibcatalog.co.il',
    indexType: 'json-api',  // not yet implemented in worker
  },
  {
    id:       'carrefour',
    name:     'קרפור / יינות ביתן',
    chainId:  '7290055700007',  // corrected from 7290873255550 — verified via OpenIsraeliSupermarkets scraper
    enabled:  false,
    status:   'ready-to-test',
    sanityRequired: false,
    // Verified 2026-06-07: Yeinot Bitan and Mega rebranded to Carrefour IL ~2022-2023.
    // prices.carrefour.co.il is alive (HTTP 403 from non-IL — geo-blocked, not dead).
    // Uses standard HTML directory listing (PublishPrice engine) — same format as other chains.
    // Covers all former Yeinot Bitan AND Mega branches.
    // Previously listed chainId 7290873255550 was wrong; 7290055700007 is the correct Mega/Bitan GS1 id.
    knownIssue: 'Needs verification from Israeli IP. Domain is alive. HTML index — existing parser should work.',
    indexUrl: 'https://prices.carrefour.co.il/',
    baseUrl:  'https://prices.carrefour.co.il',
    indexType: 'html',
  },
  {
    id:       'osher-ad',
    name:     'אושר עד',
    chainId:  '7290103152017',  // corrected from 7290058179504 — verified via OpenIsraeliSupermarkets scraper
    enabled:  false,
    status:   'needs-ftp',
    sanityRequired: false,
    // Verified 2026-06-07: uses same Cerberus/FTP server as Rami Levy.
    // FTP host: url.retail.publishedprices.co.il, path: /osherad/
    // osherad.co.il/prices/ is a redirect/mirror, not the primary source.
    // Requires FTP client support in fetchPrices.js — same work as Rami Levy.
    knownIssue: 'Same FTP server as Rami Levy (url.retail.publishedprices.co.il/osherad/). Needs FTP support in worker. Enable together with Rami Levy.',
    indexUrl: 'https://url.retail.publishedprices.co.il/osherad/',
    ftpHost:  'url.retail.publishedprices.co.il',
    ftpUser:  'osherad',
    baseUrl:  'https://url.retail.publishedprices.co.il',
    indexType: 'html',
  },
  {
    id:       'mahsanei-lahav',
    name:     'מחסני להב',
    chainId:  '7290055755557',
    enabled:  false,
    status:   'dead',
    sanityRequired: false,
    // Verified 2026-06-07: brand absorbed into Carrefour IL. No active price feed.
    // Mega stores (same operator) now publish under prices.carrefour.co.il.
    // The OpenIsraeliSupermarkets Mega scraper was commented out as of mid-2025.
    knownIssue: 'Brand no longer exists. Former Mega/Lahav stores now operate as Carrefour and publish under prices.carrefour.co.il. This entry can be removed.',
    indexUrl: 'https://prices.carrefour.co.il/',  // redirect to Carrefour for reference
    baseUrl:  'https://prices.carrefour.co.il',
    indexType: 'html',
  },
];

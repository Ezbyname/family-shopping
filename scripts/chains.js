// scripts/chains.js — v5.1.0
// Israeli supermarket price transparency feeds
// Source: Israeli Consumer Protection Authority / OpenIsraeliSupermarkets
//
// CHAIN STATUS LIFECYCLE:
//   pending          → URL not yet verified on Israeli VM
//   needs-ftp        → domain alive but requires FTP client support (not yet implemented)
//   needs-json-parser → domain alive but uses JSON API index (not yet implemented)
//   ready-to-test    → URL confirmed alive; run test-chain-source.js from Israeli VM
//   url-ok           → index URL resolves and returns price file links
//   dry-run-ok       → test-chain-source.js passes (download + parse + storeId)
//   enabled          → writing to Firebase production
//   deprecated       → brand defunct; do not enable
//
// To test a chain from the Israeli VM:
//   node test-chain-source.js <chain-id>
//   node test-chain-source.js --list

export const CHAINS = [
  {
    id: 'shufersal',
    name: 'שופרסל',
    chainId: '7290027600007',
    enabled: true,
    status: 'enabled',            // ✅ Verified 2026-05-24: 1,000 prices / 5 stores
    lastVerified: '2026-05-24',
    knownIssue: null,
    // Per-store files on paginated Azure Blob index (no single PriceFull)
    // SAS token URLs end with ?sv=... so gzip detection uses url.split('?')[0]
    indexUrl: 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=50&page=PAGE',
    baseUrl: 'https://prices.shufersal.co.il',
    indexType: 'html',
    multiStore: true,       // download a separate Price*.gz file per store
    maxStoresToSync: 5,     // ⬆ raise to 999 only after full end-to-end verification
    maxIndexPages: 10,
  },
  {
    id: 'rami-levy',
    name: 'רמי לוי',
    chainId: '7290058140886',
    enabled: false,
    status: 'needs-ftp',
    lastVerified: '2026-06-07',
    // Verified 2026-06-07: domain resolves (194.90.26.22), geo-blocked from non-IL IPs.
    // Primary access is FTP port 21 (Cerberus engine). HTTP index also available from IL IP.
    // Requires FTP client support in downloader.js before this can be enabled.
    knownIssue: 'Requires FTP (port 21). Domain url.retail.publishedprices.co.il is alive and geo-blocked. Enable together with osher-ad once FTP support is added.',
    indexUrl: 'https://url.retail.publishedprices.co.il/RamiLevi/',
    ftpHost:  'url.retail.publishedprices.co.il',
    ftpUser:  'RamiLevi',
    baseUrl:  'https://url.retail.publishedprices.co.il',
    indexType: 'html',
  },
  {
    id: 'victory',
    name: 'ויקטורי',
    chainId: '7290696200003',
    enabled: false,
    status: 'needs-json-parser',
    lastVerified: '2026-06-07',
    // Verified 2026-06-07: matrixcatalog.co.il is dead. laibcatalog.co.il is the new source.
    // Uses JSON REST API — GET /webapi/api/getfiles?edi=7290696200003 returns file list.
    // File download: GET /webapi/{chainId}/{filename}
    // Requires new indexType: 'json-api' handler. Domain is alive, geo-blocked.
    knownIssue: 'Uses JSON REST API (not HTML listing). Needs new indexType handler. GET /webapi/api/getfiles?edi=7290696200003 returns file list.',
    indexUrl: 'https://laibcatalog.co.il/webapi/api/getfiles?edi=7290696200003',
    baseUrl:  'https://laibcatalog.co.il',
    indexType: 'json-api',  // not yet implemented in downloader.js
  },
  {
    id: 'carrefour',
    name: 'קרפור / יינות ביתן',
    chainId: '7290055700007',  // corrected from 7290873255550 — verified via OpenIsraeliSupermarkets
    enabled: false,
    status: 'ready-to-test',
    lastVerified: '2026-06-07',
    // Verified 2026-06-07: Yeinot Bitan and Mega rebranded to Carrefour IL ~2022-2023.
    // prices.carrefour.co.il is alive (HTTP 403 from non-IL — geo-blocked, not dead).
    // Standard HTML directory listing (PublishPrice engine) — existing parser should work.
    // Covers all former Yeinot Bitan AND Mega branches.
    // NEXT STEP: run from Israeli VM: node test-chain-source.js carrefour
    // Verify: chainId in downloaded XML matches 7290055700007.
    knownIssue: null,
    indexUrl: 'https://prices.carrefour.co.il/',
    baseUrl:  'https://prices.carrefour.co.il',
    indexType: 'html',
  },
  {
    id: 'osher-ad',
    name: 'אושר עד',
    chainId: '7290103152017',  // corrected from 7290058179504 — verified via OpenIsraeliSupermarkets
    enabled: false,
    status: 'needs-ftp',
    lastVerified: '2026-06-07',
    // Verified 2026-06-07: same Cerberus FTP server as Rami Levy.
    // HTTP index at /osherad/ also available from IL IP.
    // Enable together with rami-levy once FTP support is added.
    knownIssue: 'Same FTP server as rami-levy. Enable both when FTP support lands.',
    indexUrl: 'https://url.retail.publishedprices.co.il/osherad/',
    ftpHost:  'url.retail.publishedprices.co.il',
    ftpUser:  'osherad',
    baseUrl:  'https://url.retail.publishedprices.co.il',
    indexType: 'html',
  },
  {
    id: 'mahsanei-lahav',
    name: 'מחסני להב',
    chainId: '7290055755557',
    enabled: false,
    deprecated: true,
    status: 'deprecated',
    lastVerified: '2026-06-07',
    // Verified 2026-06-07: brand absorbed into Carrefour IL. No active price feed.
    // Former Mega/Lahav stores now publish under prices.carrefour.co.il (chainId 7290055700007).
    // OpenIsraeliSupermarkets Mega scraper commented out since mid-2025.
    knownIssue: 'Brand defunct. Stores now operate as Carrefour. Do not enable.',
    indexUrl: 'https://prices.carrefour.co.il/',
    baseUrl:  'https://prices.carrefour.co.il',
    indexType: 'html',
  },
];

// scripts/chains.js — v5.0.0
// Israeli supermarket price transparency feeds
// Source: Israeli Consumer Protection Authority / OpenIsraeliSupermarkets
//
// CHAIN STATUS LIFECYCLE:
//   pending      → URL not yet verified on Israeli VM
//   url-ok       → index URL resolves and returns price file links
//   dry-run-ok   → test-chain-source.js passes (download + parse + storeId)
//   enabled      → writing to Firebase production
//
// To enable a chain: status must be 'dry-run-ok' and all acceptance criteria met.
// Run: node test-chain-source.js <chain-id>

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
    status: 'pending',
    lastVerified: null,
    knownIssue: 'Old URL (url.retail.pe.il) is ENOTFOUND. Chain uses FTP host url.retail.publishedprices.co.il — no confirmed HTTP index URL yet.',
    indexUrl: 'https://url.retail.publishedprices.co.il/MF/latest/7290058140886/',
    baseUrl: 'https://url.retail.publishedprices.co.il',
    indexType: 'html',
  },
  {
    id: 'victory',
    name: 'ויקטורי',
    chainId: '7290696200003',
    enabled: false,
    status: 'pending',
    lastVerified: null,
    knownIssue: 'matrixcatalog.co.il times out. Candidate URL: laibcatalog.co.il/NBCompetitionRegulations.aspx — not yet verified on VM.',
    indexUrl: 'https://laibcatalog.co.il/NBCompetitionRegulations.aspx',
    baseUrl: 'https://laibcatalog.co.il',
    indexType: 'html',
  },
  {
    id: 'yeinot-bitan',
    name: 'יינות ביתן / קרפור',
    chainId: '7290873255550',
    enabled: false,
    status: 'pending',
    lastVerified: null,
    knownIssue: 'Chain rebranded as Carrefour IL. Old URL (publishprice/prices.ybitan.co.il) ENOTFOUND. Candidate: prices.carrefour.co.il — not yet verified on VM.',
    indexUrl: 'https://prices.carrefour.co.il/',
    baseUrl: 'https://prices.carrefour.co.il',
    indexType: 'html',
  },
  {
    id: 'osher-ad',
    name: 'אושר עד',
    chainId: '7290058179504',
    enabled: false,
    status: 'pending',
    lastVerified: null,
    knownIssue: 'osherad.co.il/prices/ returns HTTP 403. New URL unknown.',
    indexUrl: 'https://osherad.co.il/prices/',
    baseUrl: 'https://osherad.co.il',
    indexType: 'html',
  },
  {
    id: 'mahsanei-lahav',
    name: 'מחסני להב',
    chainId: '7290055755557',
    enabled: false,
    status: 'pending',
    lastVerified: null,
    knownIssue: 'mega-market.co.il is ENOTFOUND. Chain may have merged with Carrefour. New URL unknown.',
    indexUrl: 'https://prices.mega.co.il/',
    baseUrl: 'https://prices.mega.co.il',
    indexType: 'html',
  },
];

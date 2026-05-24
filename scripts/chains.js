// scripts/chains.js — v4.0.0
// Israeli supermarket price transparency feeds
// Source: Israeli Consumer Protection Authority / OpenIsraeliSupermarkets
// Last verified: 2026-05-24

export const CHAINS = [
  {
    id: 'shufersal',
    name: 'שופרסל',
    chainId: '7290027600007',
    enabled: true,
    // Per-store files on paginated Azure Blob index (no single PriceFull)
    indexUrl: 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=50&page=PAGE',
    baseUrl: 'https://prices.shufersal.co.il',
    indexType: 'html',
    multiStore: true,       // download a separate Price*.gz file per store
    maxStoresToSync: 5,     // ⬆ raise to 999 once multi-store is verified end-to-end
    maxIndexPages: 10,      // pages to scan for store discovery
  },
  {
    id: 'rami-levy',
    name: 'רמי לוי',
    chainId: '7290058140886',
    enabled: false, // url.retail.pe.il is ENOTFOUND; Rami Levy uses FTP (url.retail.publishedprices.co.il)
    // TODO: find working HTTP index URL or add FTP support
    indexUrl: 'https://url.retail.publishedprices.co.il/MF/latest/7290058140886/',
    baseUrl: 'https://url.retail.publishedprices.co.il',
    indexType: 'html',
  },
  {
    id: 'victory',
    name: 'ויקטורי',
    chainId: '7290696200003',
    enabled: true,
    // matrixcatalog.co.il → laibcatalog.co.il (new domain, same ASPX listing format)
    indexUrl: 'https://laibcatalog.co.il/NBCompetitionRegulations.aspx',
    baseUrl: 'https://laibcatalog.co.il',
    indexType: 'html',
  },
  {
    id: 'yeinot-bitan',
    name: 'יינות ביתן / קרפור',
    chainId: '7290873255550',
    enabled: true,
    // Rebranded as Carrefour Israel; PublishPrice engine uses prices.{site_infix}.co.il
    // site_infix="carrefour" → https://prices.carrefour.co.il/
    indexUrl: 'https://prices.carrefour.co.il/',
    baseUrl: 'https://prices.carrefour.co.il',
    indexType: 'html',
  },
  {
    id: 'osher-ad',
    name: 'אושר עד',
    chainId: '7290058179504',
    enabled: false, // returns HTTP 403; URL may have changed or requires auth
    indexUrl: 'https://osherad.co.il/prices/',
    baseUrl: 'https://osherad.co.il',
    indexType: 'html',
  },
  {
    id: 'mahsanei-lahav',
    name: 'מחסני להב',
    chainId: '7290055755557',
    enabled: false, // mega-market.co.il is ENOTFOUND; may have rebranded to Carrefour
    indexUrl: 'https://prices.mega.co.il/',
    baseUrl: 'https://prices.mega.co.il',
    indexType: 'html',
  },
];

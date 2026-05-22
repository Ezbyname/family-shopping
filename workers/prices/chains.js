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
    sanityRequired: true,
    knownIssue: null,
    indexUrl: 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=10&page=1',
    baseUrl:  'https://prices.shufersal.co.il',
    indexType: 'html',   // Changed from 'json' — API now returns HTML table (as of 2026-05-19)
  },
  {
    id:       'rami-levy',
    name:     'רמי לוי',
    chainId:  '7290058140886',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'URL needs verification from Israeli VM - live sanity 2026-05-21 failed',
    indexUrl: 'https://url.retail.pe.il/MF/latest/7290058140886/',
    baseUrl:  'https://url.retail.pe.il',
    indexType: 'html',
  },
  {
    id:       'victory',
    name:     'ויקטורי',
    chainId:  '7290696200003',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'URL needs verification from Israeli VM - live sanity 2026-05-21 failed',
    indexUrl: 'https://matrixcatalog.co.il/NBcompetitionRegulations.aspx',
    baseUrl:  'https://matrixcatalog.co.il',
    indexType: 'html',
  },
  {
    id:       'yeinot-bitan',
    name:     'יינות ביתן',
    chainId:  '7290873255550',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'URL needs verification from Israeli VM - live sanity 2026-05-21 failed',
    indexUrl: 'https://publishprice.ybitan.co.il/',
    baseUrl:  'https://publishprice.ybitan.co.il',
    indexType: 'html',
  },
  {
    id:       'osher-ad',
    name:     'אושר עד',
    chainId:  '7290058179504',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'URL needs verification from Israeli VM - live sanity 2026-05-21 failed',
    indexUrl: 'https://osherad.co.il/prices/',
    baseUrl:  'https://osherad.co.il',
    indexType: 'html',
  },
  {
    id:       'mahsanei-lahav',
    name:     'מחסני להב',
    chainId:  '7290055755557',
    enabled:  false,
    sanityRequired: false,
    knownIssue: 'URL needs verification from Israeli VM - live sanity 2026-05-21 failed',
    indexUrl: 'https://www.mega-market.co.il/prices/',
    baseUrl:  'https://www.mega-market.co.il',
    indexType: 'html',
  },
];

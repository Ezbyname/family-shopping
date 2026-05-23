// scripts/chains.js — v3.0.0
// Updated URLs based on current Israeli supermarket price transparency feeds
// Source: Israeli Consumer Protection Authority requirements

export const CHAINS = [
  {
    id: 'shufersal',
    name: 'שופרסל',
    chainId: '7290027600007',
    enabled: true,
    // Shufersal: HTML index page with Azure Blob Storage signed URLs (Price*.gz per store)
    indexUrl: 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=50&page=1',
    baseUrl: 'https://prices.shufersal.co.il',
    indexType: 'html',
  },
  {
    id: 'rami-levy',
    name: 'רמי לוי',
    chainId: '7290058140886',
    enabled: true,
    // Rami Levy uses a different host
    indexUrl: 'https://url.retail.pe.il/MF/latest/7290058140886/',
    baseUrl: 'https://url.retail.pe.il',
    indexType: 'html',
  },
  {
    id: 'victory',
    name: 'ויקטורי',
    chainId: '7290696200003',
    enabled: true,
    indexUrl: 'https://matrixcatalog.co.il/NBcompetitionRegulations.aspx',
    baseUrl: 'https://matrixcatalog.co.il',
    indexType: 'html',
  },
  {
    id: 'yeinot-bitan',
    name: 'יינות ביתן',
    chainId: '7290873255550',
    enabled: true,
    // Updated URL
    indexUrl: 'https://publishprice.ybitan.co.il/',
    baseUrl: 'https://publishprice.ybitan.co.il',
    indexType: 'html',
  },
  {
    id: 'osher-ad',
    name: 'אושר עד',
    chainId: '7290058179504',
    enabled: true,
    indexUrl: 'https://osherad.co.il/prices/',
    baseUrl: 'https://osherad.co.il',
    indexType: 'html',
  },
  {
    id: 'mahsanei-lahav',
    name: 'מחסני להב',
    chainId: '7290055755557',
    enabled: true,
    indexUrl: 'https://www.mega-market.co.il/prices/',
    baseUrl: 'https://www.mega-market.co.il',
    indexType: 'html',
  },
];

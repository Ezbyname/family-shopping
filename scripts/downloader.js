// scripts/downloader.js — v2.0.0
import fetch from 'node-fetch';
import { createReadStream, createWriteStream, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger, withRetry, formatBytes } from './utils.js';

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/xml,text/xml,application/gzip,text/html,*/*',
  'Accept-Language': 'he-IL,he;q=0.9',
  'Referer': 'https://prices.shufersal.co.il/',
};

// Decode HTML entities in URLs extracted from href attributes
const decodeHtml = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

// Extract storeId from Shufersal Azure Blob filename:
// Price7290027600007-001-034-20260522-020000.gz  →  '034'
function extractStoreIdFromUrl(url) {
  const m = url.match(/\/Price\d+-\d+-(\d+)-\d{8}/);
  return m ? m[1] : null;
}

export async function resolveFileUrls(chain) {
  return withRetry(async () => {
    const res = await fetch(chain.indexUrl, { headers: HDRS, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (!res.ok) throw new Error(`Index ${res.status}`);
    const body = await res.text();
    return extractUrls(body, chain);
  }, { retries: 3, delayMs: 2000, label: `[${chain.name}] index` });
}

function extractUrls(body, chain) {
  const candidates = { price: [], store: [] };
  const patterns = [
    /href=["']([^"']*(?:PriceFull)[^"']*(?:\.gz|\.xml\.gz|\.xml))["']/gi,
    /href=["']([^"']*(?:Stores)[^"']*(?:\.gz|\.xml\.gz|\.xml))["']/gi,
    /https?:\/\/[^\s"'<>]+(?:PriceFull|Stores)[^\s"'<>]+(?:\.gz|\.xml)/gi,
  ];

  // Try JSON index first
  try {
    const json = JSON.parse(body);
    const items = Array.isArray(json) ? json : json.items || json.files || [];
    items.forEach(item => {
      const url = makeAbs(item.url || item.link || item.FileName || '', chain);
      if (/PriceFull/i.test(url)) candidates.price.push(url);
      if (/Stores/i.test(url)) candidates.store.push(url);
    });
  } catch (_) {}

  if (!candidates.price.length) {
    // HTML parsing — PriceFull (standard) + Azure Blob Price*.gz (Shufersal)
    let m;
    const priceRe    = /href=["']([^"']*PriceFull[^"']*(?:\.gz|\.xml))["']/gi;
    const azurePriceRe = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/Price[^"']*\.gz(?:\?[^"']*)?)["']/gi;
    const storeRe    = /href=["']([^"']*Stores[^"']*(?:\.gz|\.xml))["']/gi;
    const azureStoreRe = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/Stores[^"']*\.gz(?:\?[^"']*)?)["']/gi;
    while ((m = priceRe.exec(body)))     candidates.price.push(makeAbs(m[1], chain));
    while ((m = azurePriceRe.exec(body))) candidates.price.push(decodeHtml(m[1]));
    while ((m = storeRe.exec(body)))     candidates.store.push(makeAbs(m[1], chain));
    while ((m = azureStoreRe.exec(body))) candidates.store.push(decodeHtml(m[1]));
  }

  candidates.price.sort().reverse();
  candidates.store.sort().reverse();

  logger.info(`  PriceFull: ${candidates.price.length} | Stores: ${candidates.store.length}`);
  return { priceUrl: candidates.price[0] || null, storeUrl: candidates.store[0] || null };
}

// Resolve ALL per-store Price URLs from a paginated index (for multiStore chains).
// Returns Map<storeId, signedUrl> — newest file per store (page 1 = most recent).
export async function resolveAllPriceUrls(chain, maxStores = 50, maxPages = 10) {
  const priceByStore = new Map(); // storeId → url
  const storeByStore = new Map(); // storeId → url (Stores*.gz)
  const azurePriceRe = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/Price[^"']*\.gz(?:\?[^"']*)?)["']/gi;
  const azureStoreRe = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/Stores[^"']*\.gz(?:\?[^"']*)?)["']/gi;

  for (let page = 1; page <= maxPages && priceByStore.size < maxStores; page++) {
    const pageUrl = chain.indexUrl.replace('PAGE', String(page));
    try {
      const res = await fetch(pageUrl, { headers: HDRS, signal: AbortSignal.timeout(30000), redirect: 'follow' });
      if (!res.ok) { logger.warn(`[${chain.name}] Index page ${page}: HTTP ${res.status}`); break; }
      const body = await res.text();

      let m, newPrice = 0, newStore = 0;
      azurePriceRe.lastIndex = 0;
      while ((m = azurePriceRe.exec(body))) {
        const url = decodeHtml(m[1]);
        const storeId = extractStoreIdFromUrl(url);
        if (storeId && !priceByStore.has(storeId)) { priceByStore.set(storeId, url); newPrice++; }
      }
      azureStoreRe.lastIndex = 0;
      while ((m = azureStoreRe.exec(body))) {
        const url = decodeHtml(m[1]);
        const storeId = extractStoreIdFromUrl(url);
        if (storeId && !storeByStore.has(storeId)) { storeByStore.set(storeId, url); newStore++; }
      }

      logger.info(`[${chain.name}] Page ${page}: +${newPrice} price files, +${newStore} store files (total ${priceByStore.size}/${maxStores})`);
      if (newPrice === 0 && newStore === 0) break; // no new data on this page
    } catch (e) {
      logger.warn(`[${chain.name}] Index page ${page} failed: ${e.message}`);
      break;
    }
  }

  logger.info(`[${chain.name}] Discovered ${priceByStore.size} stores, ${storeByStore.size} store-metadata files`);
  return { priceByStore, storeByStore };
}

const makeAbs = (url, chain) => {
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return chain.baseUrl + url;
  return chain.baseUrl + '/' + url;
};

export async function downloadToStream(url, label) {
  const isGz = /\.gz$/i.test(url);
  const tmp = join(tmpdir(), `sync-${Date.now()}-${Math.random().toString(36).slice(2)}.xml${isGz ? '.gz' : ''}`);

  await withRetry(async () => {
    const res = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(90000), redirect: 'follow' });
    if (!res.ok) throw new Error(`Download ${res.status}`);
    await pipeline(res.body, createWriteStream(tmp));
    logger.info(`  [${label}] ${formatBytes(statSync(tmp).size)}`);
  }, { retries: 2, delayMs: 3000, label: `[${label}]` });

  const fs = createReadStream(tmp);
  const stream = isGz ? fs.pipe(createGunzip()) : fs;
  const cleanup = () => unlink(tmp).catch(() => {});
  stream.on('end', cleanup); stream.on('error', cleanup);
  return stream;
}

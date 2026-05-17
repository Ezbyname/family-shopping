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
  'User-Agent': 'FamilyShoppingBot/2.0 (Israel price transparency compliance)',
  'Accept': 'application/xml,text/xml,application/gzip,text/html,*/*',
  'Accept-Language': 'he-IL,he;q=0.9',
};

export async function resolveFileUrls(chain) {
  return withRetry(async () => {
    const res = await fetch(chain.indexUrl, { headers: HDRS, signal: AbortSignal.timeout(15000), redirect: 'follow' });
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
    // HTML parsing
    let m;
    const priceRe = /href=["']([^"']*PriceFull[^"']*(?:\.gz|\.xml))["']/gi;
    const storeRe = /href=["']([^"']*Stores[^"']*(?:\.gz|\.xml))["']/gi;
    while ((m = priceRe.exec(body))) candidates.price.push(makeAbs(m[1], chain));
    while ((m = storeRe.exec(body))) candidates.store.push(makeAbs(m[1], chain));
  }

  candidates.price.sort().reverse();
  candidates.store.sort().reverse();

  logger.info(`  PriceFull: ${candidates.price.length} | Stores: ${candidates.store.length}`);
  return { priceUrl: candidates.price[0] || null, storeUrl: candidates.store[0] || null };
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

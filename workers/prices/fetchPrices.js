// workers/prices/fetchPrices.js
// Downloads XML price/store files from Israeli supermarket chains.
// Runs on a VPS with an Israeli IP — that is why this works.
// DO NOT run this from Vercel/GitHub Actions — non-Israeli IPs are blocked.

import fetch from 'node-fetch';
import { createReadStream, createWriteStream, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per file
const INDEX_TIMEOUT_MS   = 20_000;  // 20 seconds for index page

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (compatible; IsraeliPriceBot/1.0; +https://github.com/Ezbyname/family-shopping)',
  'Accept':          'application/xml, text/xml, application/gzip, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
};

// ── RETRY WRAPPER ──
async function withRetry(fn, { retries = 3, delayMs = 2000, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.warn(`${label} attempt ${attempt}/${retries} failed`, { error: err.message });
      if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

// ── RESOLVE LATEST FILE URLS from chain index ──
export async function resolveFileUrls(chain, timeoutMs = INDEX_TIMEOUT_MS) {
  return withRetry(async () => {
    logger.info(`[${chain.name}] Fetching index`, { url: chain.indexUrl });

    const res = await fetch(chain.indexUrl, {
      headers: HEADERS,
      signal:  AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Index HTTP ${res.status}`);

    const body = await res.text();
    return extractFileUrls(body, chain);
  }, { retries: 3, delayMs: 2000, label: `[${chain.name}] index` });
}

function extractFileUrls(body, chain) {
  const candidates = { price: [], store: [] };

  // Try JSON index (Shufersal style)
  try {
    const json = JSON.parse(body);
    const items = Array.isArray(json) ? json : json.items || json.files || [];
    items.forEach(item => {
      const url = makeAbsolute(item.url || item.link || item.FileName || '', chain);
      if (/(?:PriceFull|Price\d+)/i.test(url)) candidates.price.push(url);
      if (/Stores/i.test(url))    candidates.store.push(url);
    });
  } catch (_) {
    // Not JSON — parse HTML
  }

  if (!candidates.price.length) {
    // HTML href extraction
    const priceRe = /href=["'][^"']*(?:PriceFull|Price\d+)[^"']*(?:\.gz|\.xml\.gz|\.xml)["']/gi;
    const storeRe = /href=["']([^"']*Stores[^"']*(?:\.gz|\.xml\.gz|\.xml))["']/gi;
    let m;
    while ((m = priceRe.exec(body)) !== null) candidates.price.push(makeAbsolute(m[1], chain));
    while ((m = storeRe.exec(body)) !== null) candidates.store.push(makeAbsolute(m[1], chain));

    // Plain-text URL scan
    const urlRe = /https?:\/\/[^\s"'<>]+(?:PriceFull|Price\d+|Stores)[^\s"'<>]+(?:\.gz|\.xml)/gi;
    while ((m = urlRe.exec(body)) !== null) {
      const url = m[0];
      if (/(?:PriceFull|Price\d+)/i.test(url)) candidates.price.push(url);
      if (/Stores/i.test(url))    candidates.store.push(url);
    }
  }

  // Sort descending — most chains embed date in filename, latest = last alphabetically
  candidates.price.sort().reverse();
  candidates.store.sort().reverse();

  logger.info(`[${chain.name}] URLs resolved`, {
    priceFiles: candidates.price.length,
    storeFiles: candidates.store.length,
    bestPrice:  candidates.price[0] || null,
    bestStore:  candidates.store[0] || null,
  });

  return {
    priceUrl: candidates.price[0] || null,
    storeUrl: candidates.store[0] || null,
  };
}

function makeAbsolute(url, chain) {
  if (!url) return '';
  if (url.startsWith('http'))  return url;
  if (url.startsWith('//'))    return 'https:' + url;
  if (url.startsWith('/'))     return chain.baseUrl + url;
  return chain.baseUrl + '/' + url;
}

// ── DOWNLOAD FILE TO TEMP PATH → RETURN READABLE STREAM ──
// Downloads to disk first to avoid holding 50MB in memory.
// Returns a readable stream (decompressed if .gz).
export async function downloadToStream(url, label, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 3) {
  const isGz  = /\.gz$/i.test(url);
  const tmpFile = join(tmpdir(), `price-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);

  await withRetry(async () => {
    logger.info(`[${label}] Downloading`, { url, isGz });

    const res = await fetch(url, {
      headers:  HEADERS,
      signal:   AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    if (!res.body) throw new Error('Empty response body');

    const writer = createWriteStream(tmpFile);
    await pipeline(res.body, writer);

    const size = statSync(tmpFile).size;
    if (size < 100) throw new Error(`File too small (${size} bytes) — likely blocked or empty`);

    logger.info(`[${label}] Downloaded`, { bytes: size, url });
  }, { retries, delayMs: 3000, label: `[${label}] download` });

  // Create stream, decompress if needed
  const fileStream = createReadStream(tmpFile);
  const outStream  = isGz ? fileStream.pipe(createGunzip()) : fileStream;

  // Cleanup temp file after stream ends
  const cleanup = () => unlink(tmpFile).catch(() => {});
  outStream.on('end',   cleanup);
  outStream.on('close', cleanup);
  outStream.on('error', cleanup);

  return outStream;
}

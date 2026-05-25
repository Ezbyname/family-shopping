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
const SAS_EXPIRY_PATTERN = /AuthenticationFailed|Signed expiry time/i; // SAS token expired

const HEADERS = {
  // Browser UA required — Shufersal silently blocks bot User-Agent strings.
  // Verified 2026-05-24: bot UA returns empty/403; browser UA returns full index.
  'User-Agent':      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept':          'application/xml, text/xml, application/gzip, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer':         'https://prices.shufersal.co.il/',
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
  const decodeHtml = (str) => str.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x([0-9A-Fa-f]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

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
    // HTML href extraction — capture full URLs including SAS token query params
    const priceRe = /href=["']([^"']*Price\d+[^"']*\.gz[^"']*)["']/gi;
    const storeRe = /href=["']([^"']*Stores[^"']*\.gz[^"']*)["']/gi;
    let m;
    while ((m = priceRe.exec(body)) !== null) candidates.price.push(makeAbsolute(decodeHtml(m[1]), chain));
    while ((m = storeRe.exec(body)) !== null) candidates.store.push(makeAbsolute(decodeHtml(m[1]), chain));

    // Plain-text URL scan (fallback)
    const urlRe = /https?:\/\/[^\s"'<>]+(?:PriceFull|Price\d+|Stores)[^\s"'<>]+(?:\.gz|\.xml)/gi;
    while ((m = urlRe.exec(body)) !== null) {
      const url = decodeHtml(m[0]);
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
  const isGz  = /\.gz(?:\?|$)/i.test(url); // Match .gz before query string or at end
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

// ── ATOMIC FETCH + DOWNLOAD (with SAS token expiry retry) ──
// Shufersal SAS URLs expire in ~2 minutes. Fetch index → download immediately.
// On SAS auth failure, re-fetch index for a fresh token and retry.
export async function fetchAndDownloadLatest(chain, label, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 1. Fetch fresh index (with fresh SAS tokens)
      logger.debug(`${label} [attempt ${attempt}/${maxRetries}] fetching index for fresh URLs`);
      const urls = await resolveFileUrls(chain, INDEX_TIMEOUT_MS);

      if (!urls.priceUrl) {
        throw new Error('No price URL found in index');
      }

      // 2. Immediately download using fresh URL (no delay)
      logger.debug(`${label} [attempt ${attempt}] downloading immediately`, {
        url: redactSasToken(urls.priceUrl)
      });

      const stream = await downloadToStream(urls.priceUrl, label, timeoutMs, 1); // retries=1 for download itself
      logger.info(`${label} [attempt ${attempt}] download succeeded`);
      return { stream, priceUrl: urls.priceUrl };

    } catch (err) {
      lastError = err;
      const isSasExpiry = SAS_EXPIRY_PATTERN.test(err.message);
      const isAuthError = /AuthenticationFailed|401|403/.test(err.message);

      if ((isSasExpiry || isAuthError) && attempt < maxRetries) {
        logger.warn(`${label} [attempt ${attempt}] SAS token expired or auth failed, will re-fetch index`, {
          error: err.message.split('\n')[0] // first line only
        });
        // Loop back to re-fetch index with fresh SAS token
        continue;
      }

      logger.error(`${label} [attempt ${attempt}] fetch+download failed`, {
        error: err.message.split('\n')[0],
        isSasExpiry,
        isAuthError
      });

      if (attempt < maxRetries && !isSasExpiry && !isAuthError) {
        // Non-SAS errors: regular retry with backoff
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }

      break;
    }
  }

  throw new Error(`Failed to fetch and download after ${maxRetries} attempts: ${lastError?.message}`);
}

function redactSasToken(url) {
  return url.replace(/\?.*$/i, '?[SAS-TOKEN-REDACTED]');
}

// ── MULTI-STORE: EXTRACT STORE ID FROM AZURE BLOB FILENAME ────────────────
// Price7290027600007-001-034-20260522-020000.gz  →  '034'
// Stores7290027600007-001-034-20260522-020000.gz →  '034'
function extractStoreIdFromUrl(url) {
  const pathname = url.split('?')[0]; // strip SAS token query string
  // Matches both Price*.gz and Stores*.gz Azure Blob filenames
  const m = pathname.match(/\/(?:Price|Stores)\d+-\d+-(\d+)-\d{8}/i);
  return m ? m[1] : null;
}

// ── MULTI-STORE: RESOLVE STORES.GZ METADATA FILES FROM PAGINATED INDEX ───────
// SEPARATE from price discovery — scans ALL pages without stopping when price
// files are found. Tries catID=0 first, then catID=1,2 as fallback (Shufersal
// may publish Stores files under a different category than prices).
// Returns Map<storeId, signedUrl>
export async function resolveStoreMetaUrls(chain, maxPages = 20) {
  const storeByStore = new Map();
  const azureStoreRe = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/Stores[^"']*\.gz(?:\?[^"']*)?)["']/gi;
  const decodeHtml   = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  // catID=5 is where Shufersal publishes Stores*.gz (confirmed 2026-05-24).
  // Try catID=5 first, then fall back through the rest in case it changes.
  // Stop as soon as any catID yields at least one store file.
  for (const catId of ['5', '0', '1', '2', '3', '4', '6', '7', '8', '9']) {
    if (storeByStore.size > 0) break;

    for (let page = 1; page <= maxPages; page++) {
      // Replace PAGE token AND catID (allows trying alternate categories)
      const pageUrl = chain.indexUrl
        .replace('PAGE', String(page))
        .replace(/catID=\d+/, `catID=${catId}`);

      try {
        const res = await fetch(pageUrl, {
          headers:  HEADERS,
          signal:   AbortSignal.timeout(INDEX_TIMEOUT_MS),
          redirect: 'follow',
        });
        if (!res.ok) {
          logger.warn(`[${chain.name}] stores catID=${catId} page ${page}: HTTP ${res.status}`);
          break;
        }
        const body = await res.text();

        let m, newStore = 0;
        azureStoreRe.lastIndex = 0;
        while ((m = azureStoreRe.exec(body))) {
          const url     = decodeHtml(m[1]);
          // Chain-wide Stores file (e.g. Stores7290027600007-000-202605240201.gz) has a
          // 12-digit datetime, not 8-digit date — extractStoreIdFromUrl returns null for it.
          // Use 'full' as the key so the file isn't silently dropped.
          const storeId = extractStoreIdFromUrl(url) || 'full';
          if (!storeByStore.has(storeId)) {
            storeByStore.set(storeId, url);
            newStore++;
          }
        }

        logger.info(`[${chain.name}] stores catID=${catId} page ${page}`, {
          newStore, totalFound: storeByStore.size,
        });

        // Stop scanning this catID when a page returns nothing new
        // (skip this rule on page 1 — stores may start on page 2+)
        if (newStore === 0 && page > 1) break;
      } catch (e) {
        logger.warn(`[${chain.name}] stores catID=${catId} page ${page} failed`, { error: e.message });
        break;
      }
    }
  }

  logger.info(`[${chain.name}] store meta discovery complete`, { storeFiles: storeByStore.size });
  return storeByStore;
}

// ── MULTI-STORE: RESOLVE ALL PER-STORE PRICE URLs FROM PAGINATED INDEX ─────
// Used by multiStore chains (Shufersal) where each store has its own Price*.gz.
//
// File type preference (CRITICAL for data completeness):
//   PriceFull*.gz   — complete store catalog (5,000–15,000 items/store) ← PREFERRED
//   PriceUpdate*.gz — only recent price changes (< 100 items/store)      ← fallback
//
// The index at catID=0 lists both types. PriceUpdate files are published
// multiple times per day; PriceFull is published once. We scan all pages
// to collect PriceFull URLs first, then fall back to PriceUpdate for stores
// that have no PriceFull in the index.
//
// Returns { priceByStore: Map<storeId, signedUrl>, storeByStore: Map<storeId, signedUrl> }
export async function resolveAllPriceUrls(chain, maxStores = 50, maxPages = 10) {
  const priceFullByStore   = new Map(); // storeId → PriceFull url  (preferred: full catalog)
  const priceUpdateByStore = new Map(); // storeId → PriceUpdate url (fallback: recent changes only)
  const storeByStore       = new Map(); // storeId → Stores metadata url

  // Separate regexes so we can prefer PriceFull over PriceUpdate per store.
  const azureFullRe   = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/PriceFull[^"']*\.gz(?:\?[^"']*)?)["']/gi;
  const azureUpdateRe = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/PriceUpdate[^"']*\.gz(?:\?[^"']*)?)["']/gi;
  const azureStoreRe  = /href=["'](https?:\/\/[^"']*\.blob\.core\.windows\.net\/[^"']*\/Stores[^"']*\.gz(?:\?[^"']*)?)["']/gi;
  const decodeHtml    = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  for (let page = 1; page <= maxPages; page++) {
    // Stop only when we have enough PriceFull files — don't stop early for PriceUpdate.
    if (priceFullByStore.size >= maxStores) break;

    const pageUrl = chain.indexUrl.replace('PAGE', String(page));
    try {
      const res = await fetch(pageUrl, {
        headers: HEADERS,
        signal:  AbortSignal.timeout(INDEX_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!res.ok) {
        logger.warn(`[${chain.name}] index page ${page}: HTTP ${res.status}`);
        break;
      }
      const body = await res.text();

      let m, newFull = 0, newUpdate = 0, newStore = 0;

      // Collect PriceFull URLs (preferred — complete store catalog)
      azureFullRe.lastIndex = 0;
      while ((m = azureFullRe.exec(body))) {
        const url     = decodeHtml(m[1]);
        const storeId = extractStoreIdFromUrl(url);
        if (storeId && !priceFullByStore.has(storeId)) {
          priceFullByStore.set(storeId, url);
          newFull++;
        }
      }

      // Collect PriceUpdate URLs (fallback — only for stores without PriceFull)
      azureUpdateRe.lastIndex = 0;
      while ((m = azureUpdateRe.exec(body))) {
        const url     = decodeHtml(m[1]);
        const storeId = extractStoreIdFromUrl(url);
        if (storeId && !priceUpdateByStore.has(storeId)) {
          priceUpdateByStore.set(storeId, url);
          newUpdate++;
        }
      }

      // Collect Stores metadata URLs (passed through to caller)
      azureStoreRe.lastIndex = 0;
      while ((m = azureStoreRe.exec(body))) {
        const url     = decodeHtml(m[1]);
        const storeId = extractStoreIdFromUrl(url);
        if (storeId && !storeByStore.has(storeId)) {
          storeByStore.set(storeId, url);
          newStore++;
        }
      }

      logger.info(`[${chain.name}] index page ${page}`, {
        newFull, newUpdate, newStore,
        totalFull: priceFullByStore.size, totalUpdate: priceUpdateByStore.size, maxStores,
      });

      // Stop scanning if this page had no new entries at all
      if (newFull === 0 && newUpdate === 0 && newStore === 0) break;
    } catch (e) {
      logger.warn(`[${chain.name}] index page ${page} failed`, { error: e.message });
      break;
    }
  }

  // Build final map: PriceFull first (complete catalog), then PriceUpdate fallback
  // for any stores that have no PriceFull entry in the current index.
  const priceByStore = new Map();
  for (const [storeId, url] of priceFullByStore) {
    if (priceByStore.size >= maxStores) break;
    priceByStore.set(storeId, url);
  }
  for (const [storeId, url] of priceUpdateByStore) {
    if (priceByStore.size >= maxStores) break;
    if (!priceByStore.has(storeId)) {
      priceByStore.set(storeId, url);
      logger.warn(`[${chain.name}] store ${storeId}: no PriceFull found — using PriceUpdate (incomplete catalog)`);
    }
  }

  logger.info(`[${chain.name}] multi-store discovery complete`, {
    priceFullFound:   priceFullByStore.size,
    priceUpdateFound: priceUpdateByStore.size,
    usingPriceUpdate: priceByStore.size - priceFullByStore.size > 0
                        ? priceByStore.size - priceFullByStore.size : 0,
    priceStores:      priceByStore.size,
    storeMetaFiles:   storeByStore.size,
  });
  return { priceByStore, storeByStore };
}

// workers/prices/rami-levy-discovery.js
// Discovers PriceFull files for all Rami Levy stores from the Cerberus portal.
//
// File listing URL: https://url.retail.publishedprices.co.il/file
// File naming:      PriceFull{chainId}-{storeId}-{YYYYMMDDHHmm}.gz
// Example:          PriceFull7290058140886-020-202606221306.gz
//
// For each storeId, returns only the latest PriceFull file (by timestamp in filename).
// Requires a valid session cookie from rami-levy-auth.js.

import fetch from 'node-fetch';
import { logger } from './logger.js';

const FILE_LIST_URL = 'https://url.retail.publishedprices.co.il/file';
const BASE_FILE_URL = 'https://url.retail.publishedprices.co.il/file';

// PriceFull7290058140886-020-202606221306.gz
// Groups: [1]=chainId [2]=storeId [3]=timestamp (YYYYMMDDHHmm)
const PRICE_FULL_RE = /PriceFull(\d+)-(\d+)-(\d{12})\.gz/i;

/**
 * Fetch the /file listing page and extract all PriceFull entries.
 * Returns Map<storeId, { url, filename, storeId, timestamp }>
 * with only the latest file per store.
 */
async function fetchFileListing(cookie, chainId, timeoutMs) {
  const res = await fetch(FILE_LIST_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; price-worker/1.0)',
      'Accept':     'text/html,*/*',
      'Cookie':     cookie,
    },
    signal:   AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`File listing HTTP ${res.status}`);
  return await res.text();
}

function parseFileListing(html, chainId) {
  // Extract all PriceFull*.gz hrefs from the HTML listing
  // Cerberus renders <a href="...">filename.gz</a> for each file
  const allFiles = [];

  // Match href="PriceFull..." or href="/file/PriceFull..."
  const hrefRe = /href=["']([^"']*PriceFull[^"']*\.gz[^"']*)["']/gi;
  // Fallback: plain text links or filenames in table cells
  const textRe  = />(PriceFull\d[^<]*\.gz)</gi;

  let m;
  const seen = new Set();

  const addUrl = (raw) => {
    const filename = raw.split('/').pop().split('?')[0];
    const match    = PRICE_FULL_RE.exec(filename);
    if (!match) return;
    if (match[1] !== chainId) return; // wrong chain
    if (seen.has(filename)) return;
    seen.add(filename);

    const storeId   = match[2];
    const timestamp = match[3]; // YYYYMMDDHHmm — lexicographic sort = chronological

    // Build absolute URL
    let url = raw;
    if (!url.startsWith('http')) {
      url = url.startsWith('/') ? `https://url.retail.publishedprices.co.il${url}` : `${BASE_FILE_URL}/${filename}`;
    }

    allFiles.push({ storeId, timestamp, filename, url });
  };

  while ((m = hrefRe.exec(html)) !== null) addUrl(m[1]);

  if (allFiles.length === 0) {
    // Fallback: look for filenames in table cells
    while ((m = textRe.exec(html)) !== null) addUrl(m[1]);
  }

  // Keep only latest PriceFull per store (sort descending by timestamp, take first)
  const byStore = new Map();
  for (const f of allFiles) {
    const existing = byStore.get(f.storeId);
    if (!existing || f.timestamp > existing.timestamp) {
      byStore.set(f.storeId, f);
    }
  }

  return byStore;
}

/**
 * Discover all PriceFull files for the given chainId.
 *
 * @param {string} cookie    - Session cookie from getSession()
 * @param {string} chainId   - e.g. '7290058140886'
 * @param {Object} opts
 * @returns {{ byStore: Map, metrics: Object }}
 */
export async function discoverPriceFullFiles(cookie, chainId, {
  timeoutMs = 20_000,
  retries   = 3,
} = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const html    = await fetchFileListing(cookie, chainId, timeoutMs);
      const byStore = parseFileListing(html, chainId);

      // Count all PriceFull mentions (before dedup) for metrics
      const allMatches = [...html.matchAll(/PriceFull\d+/gi)].length;

      const metrics = {
        storesFound:          byStore.size,
        totalPriceFullInHtml: allMatches,
      };

      if (byStore.size === 0) {
        logger.warn('[rami-levy] Discovery: no PriceFull files found in listing', {
          htmlLength: html.length,
          sample: html.slice(0, 500),
        });
      } else {
        logger.info('[rami-levy] Discovery complete', {
          stores: byStore.size,
          storeIds: [...byStore.keys()].sort(),
        });
      }

      return { byStore, metrics };
    } catch (err) {
      lastErr = err;
      logger.warn(`[rami-levy] Discovery attempt ${attempt}/${retries} failed`, { error: err.message });
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  throw new Error(`[rami-levy] Discovery failed after ${retries} attempts: ${lastErr?.message}`);
}

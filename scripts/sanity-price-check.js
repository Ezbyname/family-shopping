#!/usr/bin/env node
// scripts/sanity-price-check.js
// CI/CD sanity test: verify each enabled chain's price source is accessible and parseable
// Exit 0 only if every enabled chain yields at least one valid official price
// Exit 1 if any chain fails (unless ALLOW_PARTIAL_SANITY=true)

import fetch from 'node-fetch';
import { createReadStream, createWriteStream, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';
import sax from 'sax';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAINS = [
  {
    id: 'shufersal',
    name: 'שופרסל',
    chainId: '7290027600007',
    enabled: true,
    indexUrl: 'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=0&storeId=0&sort=None&order=None&size=10&page=1',
    baseUrl: 'https://prices.shufersal.co.il',
    indexType: 'html',
  },
  {
    id: 'rami-levy',
    name: 'רמי לוי',
    chainId: '7290058140886',
    enabled: true,
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
];

const HEADERS = {
  'User-Agent': 'FamilyShopping/SanityCheck/1.0',
  'Accept': 'application/xml, text/xml, application/gzip, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
};

const TIMEOUT_MS = 30_000;
const ALLOW_PARTIAL = process.env.ALLOW_PARTIAL_SANITY === 'true';

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log('\n🔍 SANITY CHECK: Price Source Access & Parsing\n');
  console.log(`Allow partial: ${ALLOW_PARTIAL ? 'yes' : 'no'}\n`);

  const enabledChains = CHAINS.filter(c => c.enabled);
  if (!enabledChains.length) {
    console.error('❌ No enabled chains found');
    process.exit(1);
  }

  const results = [];
  for (const chain of enabledChains) {
    try {
      const result = await checkChain(chain);
      results.push(result);
      if (result.passed) {
        console.log(`✅ ${result.chainId} PASS`);
        console.log(`   barcode: ${result.item.barcode}`);
        console.log(`   name: ${result.item.name}`);
        console.log(`   price: ₪${result.item.price?.toFixed(2)}`);
        if (result.item.storeId) console.log(`   storeId: ${result.item.storeId}`);
        console.log(`   source: ${result.source}`);
      } else {
        console.log(`❌ ${result.chainId} FAIL`);
        console.log(`   reason: ${result.failReason}`);
      }
      console.log();
    } catch (err) {
      results.push({
        chainId: chain.id,
        passed: false,
        failReason: err.message,
      });
      console.log(`❌ ${chain.id} FAIL`);
      console.log(`   reason: ${err.message}`);
      console.log();
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log('═'.repeat(50));
  console.log(`📊 SUMMARY`);
  console.log(`Tested: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Duration: ${elapsed}s`);
  console.log('═'.repeat(50));

  if (failed > 0) {
    if (ALLOW_PARTIAL) {
      console.warn(`\n⚠️  ${failed} chain(s) failed but ALLOW_PARTIAL_SANITY=true`);
      console.warn('Continuing with warning...\n');
      process.exit(0);
    } else {
      console.error(`\n❌ Sanity check FAILED: ${failed} chain(s) cannot produce valid prices`);
      process.exit(1);
    }
  }

  console.log('\n✅ All chains passed sanity check!\n');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────
// Check one chain
// ─────────────────────────────────────────────────────────────────
async function checkChain(chain) {
  const label = `[${chain.id}]`;

  // Step 1: Fetch index
  console.log(`${label} Fetching index...`);
  let priceUrl;
  try {
    priceUrl = await fetchPriceUrl(chain);
    if (!priceUrl) throw new Error('No price URL found in index');
    console.log(`${label} Found price URL: ${redact(priceUrl)}`);
  } catch (err) {
    throw new Error(`fetch index failed: ${err.message}`);
  }

  // Step 2: Download and parse
  console.log(`${label} Downloading price file...`);
  let item;
  try {
    item = await downloadAndFindFirstItem(priceUrl, label);
    if (!item) throw new Error('No valid item found in price file');
    validateItem(item);
    console.log(`${label} Found valid item: ${item.barcode}`);
  } catch (err) {
    throw new Error(`download/parse failed: ${err.message}`);
  }

  return {
    chainId: chain.id,
    passed: true,
    item,
    source: 'official',
  };
}

// ─────────────────────────────────────────────────────────────────
// Fetch the price file URL from chain's index page
// ─────────────────────────────────────────────────────────────────
async function fetchPriceUrl(chain) {
  const res = await fetch(chain.indexUrl, {
    headers: HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const body = await res.text();

  // HTML regex for price file URLs (handle SAS tokens, gzip extensions)
  const priceRe = /href=["']([^"']*(?:PriceFull|Price\d+)[^"']*\.gz[^"']*)["']/gi;
  let match;
  const candidates = [];

  while ((match = priceRe.exec(body)) !== null) {
    const url = decodeHtmlEntities(match[1]);
    if (url.startsWith('http')) {
      candidates.push(url);
    } else if (url.startsWith('/')) {
      candidates.push(chain.baseUrl + url);
    } else {
      candidates.push(chain.baseUrl + '/' + url);
    }
  }

  if (!candidates.length) {
    // Fallback: plain-text URL scan
    const urlRe = /https?:\/\/[^\s"'<>]+(?:PriceFull|Price\d+)[^\s"'<>]+\.gz/gi;
    while ((match = urlRe.exec(body)) !== null) {
      candidates.push(match[0]);
    }
  }

  if (!candidates.length) throw new Error('No price file URLs found');

  // Sort descending (most chains embed date in filename)
  candidates.sort().reverse();
  return candidates[0];
}

// ─────────────────────────────────────────────────────────────────
// Download file and find first valid item
// ─────────────────────────────────────────────────────────────────
async function downloadAndFindFirstItem(url, label) {
  const isGz = /\.gz(?:\?|$)/i.test(url);
  const tmpFile = join(tmpdir(), `sanity-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);

  try {
    // Download
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('Empty response body');

    const writer = createWriteStream(tmpFile);
    await pipeline(res.body, writer);

    const size = statSync(tmpFile).size;
    if (size < 100) throw new Error(`File too small (${size} bytes)`);

    console.log(`${label} Downloaded ${size} bytes`);

    // Decompress if needed
    let readStream = createReadStream(tmpFile);
    if (isGz) {
      readStream = readStream.pipe(createGunzip());
    }

    // Parse with sax stream
    return new Promise((resolve, reject) => {
      let foundItem = null;
      let currentItem = {};
      let currentText = '';
      let inItem = false;

      const parser = sax.createStream(false, {
        lowercase: true,
        trim: true,
        normalize: true,
      });

      parser.on('opentag', (node) => {
        if (node.name === 'item') {
          inItem = true;
          currentItem = {};
        }
        currentText = '';
      });

      parser.on('text', (text) => {
        currentText += text;
      });

      parser.on('cdata', (text) => {
        currentText += text;
      });

      parser.on('closetag', (tagName) => {
        const tag = tagName.toLowerCase();
        const text = currentText.trim();
        currentText = '';

        if (!inItem) return;

        // Map tag names across different chain formats
        if ((tag === 'itemcode' || tag === 'barcode' || tag === 'sku') && text) {
          currentItem.barcode = text;
        } else if ((tag === 'itemnm' || tag === 'name' || tag === 'itemname') && text) {
          currentItem.name = text;
        } else if ((tag === 'itemprice' || tag === 'price') && text) {
          const p = parseFloat(text);
          if (!isNaN(p) && p > 0) currentItem.price = p;
        } else if ((tag === 'storeid') && text) {
          currentItem.storeId = text;
        } else if ((tag === 'unitofmeasure' || tag === 'unit') && text) {
          currentItem.unit = text;
        }

        // End of item tag
        if (tag === 'item') {
          inItem = false;
          if (currentItem.barcode && currentItem.name && currentItem.price > 0) {
            foundItem = currentItem;
            // Stop reading from the stream
            readStream.unpipe(parser);
            return resolve(foundItem);
          }
        }
      });

      parser.on('error', (err) => {
        reject(err);
      });

      parser.on('end', () => {
        resolve(foundItem);
      });

      readStream.pipe(parser);
      readStream.on('error', reject);
    });
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────
// Validate item structure
// ─────────────────────────────────────────────────────────────────
function validateItem(item) {
  if (!item.barcode || String(item.barcode).replace(/\D/g, '').length < 8) {
    throw new Error('Invalid or missing barcode');
  }
  if (!item.name || item.name.length < 2) {
    throw new Error('Invalid or missing product name');
  }
  if (!item.price || item.price <= 0 || item.price > 10000) {
    throw new Error(`Invalid price: ${item.price}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function redact(url) {
  return url.replace(/\?.*$/i, '?[SAS-TOKEN-REDACTED]');
}

// ─────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error('❌ FATAL:', err.message);
  process.exit(1);
});

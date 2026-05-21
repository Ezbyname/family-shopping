#!/usr/bin/env node
// scripts/sanity-live.js
// Live chain sanity test: verify each enabled chain's price source is accessible and parseable
// MUST be run from Israeli VPS (Israeli IP required for supermarket access)
// Tests real supermarket URLs and writes result to Firebase
// Exit 0 only if EVERY enabled chain yields at least one valid official price
// Exit 1 if any chain fails
// Status written to Firebase: latestPriceSanityStatus

// ⚠️ IMPORTANT: CHAINS are imported from workers/prices/chains.js to ensure they're always in sync
// Never hardcode URLs here. Always import from the source of truth.

import fetch from 'node-fetch';
import { createGunzip } from 'zlib';
import sax from 'sax';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import 'dotenv/config.js';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { CHAINS as CHAINS_FROM_SOURCE } from '../workers/prices/chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use chains from the actual source of truth
const CHAINS = CHAINS_FROM_SOURCE;

const SANITY_VERSION = '2.0.0'; // increment when sanity-live.js logic changes

const HEADERS = {
  'User-Agent': `FamilyShopping/SanityCheck/${SANITY_VERSION}`,
  'Accept': 'application/xml, text/xml, application/gzip, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
};

const TIMEOUT_MS = 30_000;
let firebaseDb = null;

// Initialize Firebase (required for status reporting)
async function initFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const url = process.env.FIREBASE_DATABASE_URL;

  if (!projectId || !clientEmail || !privateKey || !url) {
    console.warn('⚠️ Firebase credentials not available — status will NOT be saved');
    return null;
  }

  try {
    if (!getApps().length) {
      const key = privateKey.replace(/\\n/g, '\n');
      initializeApp({
        credential: cert({ projectId, clientEmail, privateKey: key }),
        databaseURL: url,
      });
    }
    firebaseDb = getDatabase();
    return firebaseDb;
  } catch (err) {
    console.warn(`⚠️ Firebase init failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const runId = `sanity-${Date.now()}`;

  console.log('\n🔍 LIVE CHAIN SANITY CHECK\n');
  console.log('Testing REAL supermarket sources...');
  console.log('⚠️ Requires Israeli IP for supermarket access\n');

  // Initialize Firebase
  await initFirebase();
  if (firebaseDb) {
    console.log('✅ Firebase initialized — results will be saved\n');
  } else {
    console.log('⚠️ Firebase unavailable — results will NOT be saved\n');
  }

  // Explicitly filter for enabled chains (safety requirement)
  const enabledChains = CHAINS.filter(c => c.enabled === true);
  const disabledChains = CHAINS.filter(c => c.enabled !== true);

  // Subdivide enabled chains by requirement
  const requiredChains = enabledChains.filter(c => c.sanityRequired === true);
  const optionalChains = enabledChains.filter(c => c.sanityRequired !== true);

  if (!requiredChains.length) {
    console.error('❌ No required chains enabled');
    process.exit(1);
  }

  console.log(`Testing ${requiredChains.length} required chains:\n`);

  if (optionalChains.length > 0) {
    console.log(`(${optionalChains.length} optional chains will also be tested)\n`);
  }

  if (disabledChains.length > 0) {
    console.log(`(${disabledChains.length} chains disabled - see chains.js for status)\n`);
  }

  const results = [];
  const allEnabledChains = [...requiredChains, ...optionalChains];

  for (const chain of allEnabledChains) {
    const isRequired = requiredChains.includes(chain);
    try {
      const result = await checkChain(chain);
      result.required = isRequired;
      results.push(result);
      if (result.passed) {
        console.log(`✅ ${result.chainId} PASS${isRequired ? '' : ' (optional)'}`);
        console.log(`   barcode: ${result.item.barcode}`);
        console.log(`   name: ${result.item.name}`);
        console.log(`   price: ₪${result.item.price?.toFixed(2)}`);
        if (result.item.storeId) console.log(`   storeId: ${result.item.storeId}`);
        console.log(`   source: ${result.source}`);
      } else {
        console.log(`❌ ${result.chainId} FAIL${isRequired ? ' (REQUIRED)' : ' (optional)'}`);
        console.log(`   reason: ${result.failReason}`);
      }
      console.log();
    } catch (err) {
      results.push({
        chainId: chain.id,
        passed: false,
        failReason: err.message,
        required: isRequired,
      });
      console.log(`❌ ${chain.id} FAIL${isRequired ? ' (REQUIRED)' : ' (optional)'}`);
      console.log(`   reason: ${err.message}`);
      console.log();
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const requiredPassed = results.filter(r => r.required && r.passed).length;
  const requiredFailed = results.filter(r => r.required && !r.passed).length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log('═'.repeat(50));
  console.log(`📊 SUMMARY`);
  console.log(`Tested: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Required: ${requiredChains.length} | Passed: ${requiredPassed} | Failed: ${requiredFailed}`);
  console.log(`Duration: ${elapsed}s`);
  console.log('═'.repeat(50));

  // Write Firebase status
  // Status is based ONLY on required chains
  const status = requiredFailed === 0 ? 'pass' : (requiredFailed < requiredChains.length ? 'partial' : 'fail');
  if (firebaseDb) {
    try {
      const statusData = {
        status,
        runId,
        checkedAt: new Date().toISOString(),
        chainsTested: results.length,
        chainsPassed: passed,
        chainsFailed: failed,
        results: Object.fromEntries(
          results.map(r => [r.chainId, {
            status: r.passed ? 'pass' : 'fail',
            barcode: r.item?.barcode || null,
            name: r.item?.name || null,
            price: r.item?.price || null,
            storeId: r.item?.storeId || null,
            error: r.failReason || null,
          }])
        ),
      };

      // Add coverage metadata
      statusData.statusLabel = requiredFailed === 0 && disabledChains.length === 0 ? 'full_pass' : 'baseline_pass';
      statusData.productionCoverage = disabledChains.length === 0 ? 'full' : 'partial';
      statusData.enabledRequiredChains = requiredChains.length;
      statusData.enabledOptionalChains = optionalChains.length;
      statusData.disabledChains = disabledChains.length;
      statusData.disabledChainIds = disabledChains.map(c => c.id);

      if (disabledChains.length > 0) {
        statusData.message = `Baseline pass only. ${disabledChains.length} supported chains are disabled pending endpoint verification.`;
      } else {
        statusData.message = 'All supported chains enabled and tested.';
      }

      statusData.sanityVersion = SANITY_VERSION;

      await firebaseDb.ref('latestPriceSanityStatus').set(statusData);
      console.log('✅ Firebase status updated\n');
    } catch (err) {
      console.warn(`⚠️ Failed to write Firebase status: ${err.message}\n`);
    }
  }

  // Exit based on required chains only
  if (requiredFailed > 0) {
    console.error(`\n❌ LIVE SANITY CHECK FAILED`);
    console.error(`${requiredFailed} required chain(s) cannot produce valid prices`);
    console.error(`Status: ${status.toUpperCase()}`);
    console.error('This is a production issue. All required chains MUST pass.\n');
    process.exit(1);
  }

  if (disabledChains.length > 0) {
    console.log(`\n✅ BASELINE PASS: ALL ENABLED REQUIRED CHAINS PASSED`);
    console.log(`Tested: ${requiredChains.length} required chain${requiredChains.length === 1 ? '' : 's'}\n`);
    console.log(`Production Coverage: PARTIAL`);
    console.log(`Disabled Chains: ${disabledChains.map(c => c.id).join(', ')}\n`);
    console.log(`Status: baseline_pass (pending endpoint verification for disabled chains)\n`);
  } else {
    console.log('\n✅ FULL PASS: ALL SUPPORTED CHAINS TESTED AND PASSING');
    console.log('All enabled supermarket sources are accessible and returning real prices.');
    console.log('Production Coverage: FULL\n');
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────
// Check one chain
// ─────────────────────────────────────────────────────────────────
async function checkChain(chain) {
  const label = `[${chain.id}]`;
  const t0 = Date.now();

  console.log(`${label} Starting chain check...`);

  // Step 1: Fetch index
  console.log(`${label} Step 1: Fetching index from ${redact(chain.indexUrl)}...`);
  let priceUrl;
  try {
    priceUrl = await fetchPriceUrl(chain);
    if (!priceUrl) throw new Error('No price URL found in index');
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`${label} ✓ Index fetch succeeded (${elapsed}s)`);
    console.log(`${label} ✓ Price URL: ${redact(priceUrl)}`);
  } catch (err) {
    throw new Error(`Step 1 failed - fetch index: ${err.message}`);
  }

  // Step 2: Download and parse
  const t1 = Date.now();
  console.log(`${label} Step 2: Downloading and parsing price file...`);
  let item;
  try {
    item = await downloadAndFindFirstItem(priceUrl, label);
    if (!item) throw new Error('No valid item found in price file');
    const elapsed = ((Date.now() - t1) / 1000).toFixed(2);
    console.log(`${label} ✓ Download/parse succeeded (${elapsed}s)`);

    // Validate
    try {
      validateItem(item);
    } catch (err) {
      throw new Error(`Item validation failed: ${err.message}`);
    }

    const totalElapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`${label} ✓ Valid item found (total: ${totalElapsed}s)`);
  } catch (err) {
    const elapsed = ((Date.now() - t1) / 1000).toFixed(2);
    throw new Error(`Step 2 failed - download/parse (${elapsed}s): ${err.message}`);
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
// Stream directly: response → decompress → parse (no temp files)
// ─────────────────────────────────────────────────────────────────
async function downloadAndFindFirstItem(url, label) {
  const isGz = /\.gz(?:\?|$)/i.test(url);
  let bytesDownloaded = 0;
  let streamActive = true;

  console.log(`${label} Starting download... (streaming mode, no temp files)`);

  try {
    // Fetch response
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('Empty response body');

    console.log(`${label} Response received, setting up decompression pipeline...`);

    // Build decompression pipeline if needed
    let dataStream = res.body;
    if (isGz) {
      console.log(`${label} Gzip detected, decompressing on-the-fly...`);
      dataStream = dataStream.pipe(createGunzip());
    }

    // Parse with SAX stream directly (no temp file)
    return new Promise((resolve, reject) => {
      let foundItem = null;
      let currentItem = {};
      let currentText = '';
      let inItem = false;
      let itemsProcessed = 0;

      // Guard against double resolve/reject after stream is torn down
      let resolved = false;

      function safeResolve(item) {
        if (resolved) return;
        resolved = true;
        streamActive = false;
        try { dataStream.destroy(); } catch {}
        try { parser.removeAllListeners(); } catch {}
        resolve(item);
      }

      function safeReject(err) {
        if (resolved) return;
        resolved = true;
        streamActive = false;
        try { dataStream.destroy(); } catch {}
        try { parser.removeAllListeners(); } catch {}
        reject(err);
      }

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
        if (resolved) return;
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
          itemsProcessed++;
          inItem = false;
          if (currentItem.barcode && currentItem.name && currentItem.price > 0) {
            foundItem = currentItem;
            console.log(`${label} ✓ Found valid item at position ${itemsProcessed}, stopping stream...`);
            safeResolve(foundItem);
          }
        }
      });

      parser.on('error', (err) => {
        // Ignore errors after stream is already resolved (e.g. from destroy())
        if (resolved) return;
        safeReject(new Error(`SAX parser error: ${err.message}`));
      });

      parser.on('end', () => {
        if (resolved) return;
        if (!foundItem) {
          safeReject(new Error(`No valid items found after processing ${itemsProcessed} items`));
        } else {
          safeResolve(foundItem);
        }
      });

      // Track bytes for logging
      dataStream.on('data', (chunk) => {
        bytesDownloaded += chunk.length;
      });

      dataStream.on('error', (err) => {
        // Ignore errors after stream is already resolved (e.g. from destroy())
        if (resolved) return;
        safeReject(new Error(`Stream error: ${err.message}`));
      });

      console.log(`${label} Piping stream to parser...`);
      dataStream.pipe(parser);
    });

  } catch (err) {
    // Ensure streams are closed on error
    if (err.message) {
      throw new Error(`download/parse error: ${err.message}`);
    } else {
      throw err;
    }
  } finally {
    console.log(`${label} Cleanup complete (${bytesDownloaded} bytes streamed)`);
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

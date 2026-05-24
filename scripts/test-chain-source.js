// scripts/test-chain-source.js — v1.0.0
// Dry-run chain verification — NO Firebase writes.
//
// Usage:
//   node test-chain-source.js <chain-id>
//   node test-chain-source.js victory
//   node test-chain-source.js --list
//
// Exit codes:
//   0 = index resolved + price file downloaded + at least 1 product parsed
//   1 = any step failed
//
// Does NOT require Firebase credentials — purely HTTP + XML.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Auto-load .env (same as sync-prices.js — needed only if utils imports fail)
try {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const env = readFileSync(resolve(__dir, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([\s\S]*?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\\n/g, '\n');
  }
} catch (_) {}

import { CHAINS } from './chains.js';
import { resolveFileUrls, resolveAllPriceUrls, downloadToStream } from './downloader.js';
import { parseXMLStream } from './xml-parser.js';
import { logger } from './utils.js';

const args = process.argv.slice(2);
const chainArg = args.find(a => !a.startsWith('--'));
const VERBOSE = args.includes('--verbose');
const MAX_PRODUCTS = 10;

// ── --list ─────────────────────────────────────────────────────────────────
if (chainArg === '--list' || args.includes('--list')) {
  console.log('\nAvailable chains:\n');
  CHAINS.forEach(c => {
    const badge = c.enabled ? '✅ enabled' : `⏸  ${c.status || 'disabled'}`;
    console.log(`  ${badge.padEnd(20)} ${c.id.padEnd(20)} ${c.name}`);
    if (c.knownIssue) console.log(`                           ⚠  ${c.knownIssue}`);
  });
  console.log('');
  process.exit(0);
}

if (!chainArg) {
  console.error('Usage: node test-chain-source.js <chain-id>  [--verbose]');
  console.error('       node test-chain-source.js --list');
  process.exit(1);
}

const chain = CHAINS.find(c => c.id === chainArg);
if (!chain) {
  console.error(`Unknown chain: "${chainArg}"`);
  console.error('Run with --list to see available chains.');
  process.exit(1);
}

// ── Main test ──────────────────────────────────────────────────────────────
async function testChain(chain) {
  const sep = '═'.repeat(55);
  console.log(`\n${sep}`);
  console.log(`DRY-RUN TEST: ${chain.name}  (${chain.id})`);
  console.log(`Chain ID : ${chain.chainId}`);
  console.log(`Index URL: ${chain.indexUrl}`);
  console.log(`Status   : ${chain.status || 'unknown'}`);
  if (chain.knownIssue) console.log(`⚠  Issue : ${chain.knownIssue}`);
  console.log(`${sep}\n`);

  const result = {
    chain: chain.id,
    indexResolved: false,
    priceFileUrl: null,
    storeIds: [],
    downloaded: false,
    productsFound: 0,
    sampleProducts: [],
    errors: [],
  };

  // ── Step 1: Resolve index ──────────────────────────────────────────────
  console.log('Step 1 — Resolving index...');
  try {
    if (chain.multiStore) {
      const { priceByStore } = await resolveAllPriceUrls(
        chain,
        Math.min(chain.maxStoresToSync || 5, 3), // test: max 3 stores
        2                                          // test: max 2 pages
      );
      result.storeIds = [...priceByStore.keys()];
      if (priceByStore.size === 0) {
        result.errors.push('No per-store price files found in index');
        return result;
      }
      result.indexResolved = true;
      console.log(`  ✅ Found ${priceByStore.size} stores: ${result.storeIds.join(', ')}`);
      // Pick first store for download test
      const [firstStoreId, firstUrl] = [...priceByStore.entries()][0];
      result.priceFileUrl = firstUrl;
      console.log(`  Testing store: ${firstStoreId}`);
    } else {
      const { priceUrl, storeUrl } = await resolveFileUrls(chain);
      if (!priceUrl) {
        result.errors.push('No PriceFull URL found in index page');
        return result;
      }
      result.indexResolved = true;
      result.priceFileUrl = priceUrl;
      if (VERBOSE) console.log(`  PriceFull: ${priceUrl}`);
      else         console.log(`  ✅ PriceFull URL resolved`);
      if (storeUrl) console.log(`  Stores URL: ${storeUrl}`);
    }
    console.log(`  File URL (truncated): ${result.priceFileUrl?.split('?')[0]}`);
  } catch (e) {
    result.errors.push(`Index fetch failed: ${e.message}`);
    console.log(`  ❌ ${e.message}`);
    return result;
  }

  // ── Step 2: Download ───────────────────────────────────────────────────
  console.log('\nStep 2 — Downloading price file...');
  let stream;
  try {
    stream = await downloadToStream(result.priceFileUrl, chain.name);
    result.downloaded = true;
    console.log('  ✅ Downloaded and decompressed');
  } catch (e) {
    result.errors.push(`Download failed: ${e.message}`);
    console.log(`  ❌ ${e.message}`);
    return result;
  }

  // ── Step 3: Parse first N products ────────────────────────────────────
  console.log(`\nStep 3 — Parsing (first ${MAX_PRODUCTS} products)...`);
  try {
    const products = [];
    await parseXMLStream(
      stream,
      async (product) => {
        if (products.length < MAX_PRODUCTS) products.push(product);
      },
      null,
      { chainId: chain.chainId, chainName: chain.name }
    );

    result.productsFound = products.length;
    result.sampleProducts = products;

    if (products.length === 0) {
      result.errors.push('Parser extracted 0 products — wrong XML structure or empty file');
      console.log('  ❌ 0 products parsed');
    } else {
      console.log(`  ✅ ${products.length} products parsed. Samples:`);
      products.slice(0, 5).forEach(p => {
        console.log(
          `     barcode=${p.barcode}  ` +
          `price=₪${p.price}  ` +
          `store=${p.storeId || '(none)'}  ` +
          `name="${p.name?.substring(0, 30)}"`
        );
      });
    }
  } catch (e) {
    result.errors.push(`Parse failed: ${e.message}`);
    console.log(`  ❌ ${e.message}`);
  }

  return result;
}

// ── Run & Report ───────────────────────────────────────────────────────────
testChain(chain).then(result => {
  const sep = '─'.repeat(55);
  console.log(`\n${sep}`);
  console.log('SUMMARY');
  console.log(`  Chain        : ${result.chain}`);
  console.log(`  Index        : ${result.indexResolved ? '✅ resolved' : '❌ failed'}`);
  console.log(`  Price file   : ${result.priceFileUrl ? '✅ found' : '❌ not found'}`);
  if (result.storeIds.length) console.log(`  Stores found : ${result.storeIds.join(', ')}`);
  console.log(`  Download     : ${result.downloaded ? '✅ ok' : '❌ failed'}`);
  console.log(`  Products     : ${result.productsFound > 0 ? `✅ ${result.productsFound}` : '❌ 0'}`);
  if (result.errors.length) {
    console.log('  Errors:');
    result.errors.forEach(e => console.log(`    ⚠  ${e}`));
  }

  const passed = result.indexResolved && result.priceFileUrl && result.downloaded && result.productsFound > 0;
  console.log(`\n${passed ? '✅ PASS' : '❌ FAIL'}  — ${result.chain}`);
  console.log(sep);
  process.exit(passed ? 0 : 1);
}).catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});

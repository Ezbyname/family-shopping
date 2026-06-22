/**
 * verify-rami-levy.mjs — Phase 1: Rami Levy source verification
 *
 * Run this on the Israeli VPS BEFORE enabling Rami Levy in production.
 * Non-Israeli IPs will receive HTTP 403 or empty HTML from publishedprices.co.il.
 *
 * Usage:
 *   node verify-rami-levy.mjs               # full check (downloads 1 MB sample)
 *   node verify-rami-levy.mjs --index-only  # skip download, check index only
 *
 * Exit codes:
 *   0 = source verified — safe to enable in chains.js
 *   1 = source not reachable or validation failed
 *   2 = index reachable but no price files found (naming pattern mismatch)
 */

import fetch from 'node-fetch';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { unlink } from 'fs/promises';
import { createGunzip } from 'zlib';
import { tmpdir } from 'os';
import { join } from 'path';

const CHAIN_ID   = '7290058140886';
const INDEX_URL  = `https://url.retail.publishedprices.co.il/MF/latest/${CHAIN_ID}/`;
const BASE_URL   = 'https://url.retail.publishedprices.co.il';
const SAMPLE_BYTES = 1_048_576; // 1 MB for XML structure sampling

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept':          'application/xml, text/xml, application/gzip, text/html, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
};

const INDEX_ONLY = process.argv.includes('--index-only');
const W = 68;
const BAR = '═'.repeat(W);
const SEP = '─'.repeat(W);

// ── Helpers ───────────────────────────────────────────────────────────────────
function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function makeAbsolute(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//'))   return 'https:' + url;
  if (url.startsWith('/'))    return BASE_URL + url;
  return BASE_URL + '/' + url;
}

function pass(msg) { console.log(`  ✓ PASS  ${msg}`); }
function fail(msg) { console.log(`  ✗ FAIL  ${msg}`); }
function info(msg) { console.log(`  ·       ${msg}`); }
function warn(msg) { console.log(`  ⚠       ${msg}`); }

// ── Section 1: Index accessibility ───────────────────────────────────────────
console.log('\n' + BAR);
console.log('RAMI LEVY — SOURCE VERIFICATION REPORT');
console.log(`Chain ID : ${CHAIN_ID}`);
console.log(`Index URL: ${INDEX_URL}`);
console.log(`Date     : ${new Date().toISOString()}`);
console.log(BAR);

console.log('\n── 1. INDEX ACCESSIBILITY ───────────────────────────────────');

let indexBody = '';
let indexStatus = 0;
try {
  const res = await fetch(INDEX_URL, {
    headers: HEADERS,
    signal:  AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  indexStatus = res.status;
  indexBody   = await res.text();

  if (res.ok) {
    pass(`HTTP ${res.status} — index reachable`);
    info(`Content-Type : ${res.headers.get('content-type') || '(none)'}`);
    info(`Body length  : ${indexBody.length} bytes`);
  } else {
    fail(`HTTP ${res.status} — index NOT reachable`);
    console.log('\n' + BAR);
    console.log('VERDICT: ✗ BLOCKED — verify Israeli IP and URL');
    console.log(BAR + '\n');
    process.exit(1);
  }
} catch (e) {
  fail(`Network error: ${e.message}`);
  if (/ENOTFOUND/i.test(e.message)) {
    warn('DNS resolution failed. The old url.retail.pe.il alias is dead.');
    warn('Candidate URL may have changed. Check: https://consumers.gov.il/ for current URLs.');
  }
  console.log('\n' + BAR);
  console.log('VERDICT: ✗ UNREACHABLE — source not available from this IP');
  console.log(BAR + '\n');
  process.exit(1);
}

// ── Section 2: File listing ───────────────────────────────────────────────────
console.log('\n── 2. FILE LISTING ──────────────────────────────────────────');

// Patterns expected from publishedprices.co.il for Rami Levy:
//   PriceFull7290058140886-20260622-020000.gz
//   Stores7290058140886-20260622-020000.gz
const priceRe = /href=["']([^"']*Price[^"']*\.gz[^"']*)["']/gi;
const storeRe = /href=["']([^"']*Stores?[^"']*\.gz[^"']*)["']/gi;
const plainRe = /https?:\/\/[^\s"'<>]+(?:PriceFull|Price\d+|Stores)[^\s"'<>]+(?:\.gz|\.xml)/gi;

const priceUrls = [];
const storeUrls = [];
let m;

while ((m = priceRe.exec(indexBody)) !== null) priceUrls.push(makeAbsolute(decodeHtml(m[1])));
while ((m = storeRe.exec(indexBody)) !== null) storeUrls.push(makeAbsolute(decodeHtml(m[1])));

if (priceUrls.length === 0) {
  // Fallback: plain-text URL scan
  while ((m = plainRe.exec(indexBody)) !== null) {
    const url = decodeHtml(m[0]);
    if (/(?:PriceFull|Price\d+)/i.test(url)) priceUrls.push(url);
    if (/Stores/i.test(url))    storeUrls.push(url);
  }
}

// Sort descending (date in filename → latest first)
priceUrls.sort().reverse();
storeUrls.sort().reverse();

if (priceUrls.length > 0) {
  pass(`Found ${priceUrls.length} price file(s)`);
  priceUrls.slice(0, 5).forEach(u => info(`Price: ${u.split('/').pop()}`));
  if (priceUrls.length > 5) info(`... and ${priceUrls.length - 5} more`);
} else {
  fail('No price files found in index HTML');
  warn('Expected links matching: PriceFull<chainId>-<date>-<time>.gz');
  warn('Raw index excerpt:');
  console.log(indexBody.slice(0, 800).split('\n').map(l => '    ' + l).join('\n'));
  console.log('\n' + BAR);
  console.log('VERDICT: ✗ NO FILES — naming pattern mismatch or wrong URL');
  console.log(BAR + '\n');
  process.exit(2);
}

if (storeUrls.length > 0) {
  pass(`Found ${storeUrls.length} store file(s)`);
  storeUrls.slice(0, 3).forEach(u => info(`Store: ${u.split('/').pop()}`));
} else {
  warn('No Stores*.gz files found — store metadata will be missing (not a blocker)');
}

// ── Section 3: Naming pattern validation ─────────────────────────────────────
console.log('\n── 3. NAMING PATTERN VALIDATION ─────────────────────────────');

// Expected: PriceFull{chainId}-{YYYYMMDD}-{HHMMSS}.gz
const expectedPattern = new RegExp(`PriceFull${CHAIN_ID}-\\d{8}-\\d{6}\\.gz`, 'i');
const bestPrice = priceUrls[0];
const filename  = bestPrice.split('/').pop().split('?')[0];

if (expectedPattern.test(filename)) {
  pass(`Filename matches expected pattern: ${filename}`);
} else if (/PriceFull/i.test(filename)) {
  warn(`PriceFull found but pattern differs from expected: ${filename}`);
  warn(`Expected: PriceFull${CHAIN_ID}-YYYYMMDD-HHMMSS.gz`);
  info('Parser should still work — investigate XML structure after download.');
} else if (/Price\d+/i.test(filename)) {
  warn(`Non-Full price file (no PriceFull): ${filename}`);
  warn('This may be a price-update file (incremental only). Check if PriceFull exists at a different path.');
} else {
  warn(`Unrecognised filename format: ${filename}`);
}

// Confirm chainId is embedded in filename
if (filename.includes(CHAIN_ID)) {
  pass(`Chain ID ${CHAIN_ID} found in filename — matches chains.js`);
} else {
  warn(`Chain ID ${CHAIN_ID} NOT found in filename: ${filename}`);
  warn('Verify chainId against IL Ministry of Economy registry: https://consumers.gov.il/');
}

// ── Section 4: Sample download + XML structure check ─────────────────────────
if (INDEX_ONLY) {
  console.log('\n── 4. DOWNLOAD SKIPPED (--index-only) ───────────────────────');
  info('Re-run without --index-only to validate XML structure.');
} else {
  console.log('\n── 4. SAMPLE DOWNLOAD + XML STRUCTURE ──────────────────────');

  const tmpFile = join(tmpdir(), `rami-levy-verify-${Date.now()}.tmp`);
  let xmlSample = '';

  try {
    info(`Downloading (Range: first ${SAMPLE_BYTES / 1024} KB): ${filename}`);
    const res = await fetch(bestPrice, {
      headers: { ...HEADERS, 'Range': `bytes=0-${SAMPLE_BYTES - 1}` },
      signal:  AbortSignal.timeout(60_000),
      redirect: 'follow',
    });

    if (!res.ok && res.status !== 206) {
      // Range not supported — download full file but stop after 1 MB
      warn(`Range request not supported (${res.status}) — will download and truncate`);
    }

    const isGz = /\.gz(?:\?|$)/i.test(bestPrice);
    const writer = createWriteStream(tmpFile);
    if (isGz) {
      await pipeline(res.body.pipe(createGunzip()), writer);
    } else {
      await pipeline(res.body, writer);
    }

    // Read the XML sample
    const { readFileSync } = await import('fs');
    xmlSample = readFileSync(tmpFile, 'utf8').slice(0, 4096);
    await unlink(tmpFile).catch(() => {});

    pass(`Download succeeded (${xmlSample.length} bytes of decompressed XML)`);
  } catch (e) {
    await unlink(tmpFile).catch(() => {});
    fail(`Download error: ${e.message}`);
    info('Skipping XML structure check.');
  }

  if (xmlSample) {
    console.log('\n  XML excerpt (first 1000 chars):');
    console.log(xmlSample.slice(0, 1000).split('\n').map(l => '    ' + l).join('\n'));

    // Check key fields that parseXml.js FIELD_MAP expects
    const checks = [
      ['<Item',        'Item element  (product container)'],
      ['ItemCode',     'ItemCode      (barcode)'],
      ['ItemPrice',    'ItemPrice     (price)'],
      ['ItemName',     'ItemName      (product name)'],
      ['StoreId',      'StoreId       (store ID)'],
    ];

    console.log('');
    let xmlOk = true;
    for (const [pattern, label] of checks) {
      const found = new RegExp(pattern, 'i').test(xmlSample);
      if (found) {
        pass(`${label}`);
      } else {
        fail(`${label} — NOT found in first 4KB`);
        warn('  File may use different tag names — check full XML and update parseXml.js FIELD_MAP if needed.');
        xmlOk = false;
      }
    }

    if (xmlOk) {
      pass('XML structure matches parseXml.js FIELD_MAP — no parser changes needed');
    } else {
      warn('Some fields missing from sample. Check full XML before enabling.');
    }
  }
}

// ── Section 5: Go / No-Go checklist ──────────────────────────────────────────
console.log('\n── 5. GO / NO-GO CHECKLIST ──────────────────────────────────');
console.log('');
console.log('  Manual steps still required on Israeli VPS:');
console.log('');
console.log('  [ ] HTTP 200 confirmed (this script)');
console.log('  [ ] PriceFull*.gz files listed in index (this script)');
console.log('  [ ] XML structure matches FIELD_MAP (this script, section 4)');
console.log('  [ ] In chains.js: set enabled: true, status: "enabled", lastVerified: today');
console.log('  [ ] Dry-run:  DRY_RUN=true node index.js rami-levy');
console.log('         → confirm items > 1000, errors = 0');
console.log('  [ ] Live run: node index.js rami-levy');
console.log('         → confirm Firebase prices/rami-levy* has entries');
console.log('  [ ] syncStatus/rami-levy.errors < 5% of itemsProcessed');
console.log('  [ ] node tests/search-health.mjs — Precision@3 unchanged');
console.log('  [ ] set sanityRequired: true in chains.js');
console.log('');

console.log(BAR);
console.log('VERDICT: ✓ INDEX VERIFIED — run dry-run next on Israeli VPS');
console.log(BAR + '\n');
process.exit(0);

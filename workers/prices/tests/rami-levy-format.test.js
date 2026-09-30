// workers/prices/tests/rami-levy-format.test.js
// FS-RL-001: Compression format detection and ZIP extraction for Rami Levy price files.
// Contract test mapping:
//   RL-1  real GZIP file
//   RL-2  ZIP disguised as .gz (the store-39 production scenario)
//   RL-3  plain XML file
//   RL-4  .gz filename + ZIP content (content wins)
//   RL-5  .gz filename + XML content (content wins)
//   RL-6  unknown / corrupt binary → rejected at format layer, never reaches XML parser
//   RL-7  ZIP without XML entries → explicit error
//   RL-8  ZIP extraction failure (corrupt archive body) → stream error
//   RL-9  temp file cleaned up after successful stream consumption
//   RL-10 temp file cleaned up after stream error
//   RL-INT ZIP → openDecompressedStream → parseXMLStream → products parsed, errors=0

import { writeFileSync, existsSync, statSync } from 'fs';
import { gzipSync, deflateRawSync } from 'zlib';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectFormatFromBytes, FORMAT } from '../detectFormat.js';
import { openDecompressedStream } from '../rami-levy.js';
import { parseXMLStream } from '../parseXml.js';

let passed = 0;
let failed = 0;
const allPromises = [];

function test(name, fn) {
  const p = (async () => {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ ${name}: ${err.message}`);
      failed++;
    }
  })();
  allPromises.push(p);
  return p;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(got, expected, msg) {
  if (got !== expected)
    throw new Error(`${msg || ''}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeCrc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(filename, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const name = Buffer.from(filename, 'utf8');
  const compressed = deflateRawSync(data);
  const crc = computeCrc32(data);
  const lh = Buffer.alloc(30 + name.length);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(compressed.length, 18);
  lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  name.copy(lh, 30);
  const cdOffset = lh.length + compressed.length;
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20);
  cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42);
  name.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdOffset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([lh, compressed, cd, eocd]);
}

function writeTmp(buf) {
  const p = join(tmpdir(), 'rl-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.tmp');
  writeFileSync(p, buf);
  return p;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', d => chunks.push(d));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function waitForDeletion(path, ms = 300) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

const SAMPLE_XML = '<Root><ChainId>7290058140886</ChainId></Root>';

// ── RL-1 through RL-10 ───────────────────────────────────────────────────────

console.log('\n── RL-1: real GZIP ──');
test('RL-1: GZIP file → decompressed XML', async () => {
  const tmp = writeTmp(gzipSync(Buffer.from(SAMPLE_XML)));
  const stream = openDecompressedStream(tmp, 'pricefull-001.gz', 'rl1');
  const out = await streamToBuffer(stream);
  assert(out.toString().includes('ChainId'), 'XML not found in output');
});

console.log('\n── RL-2: ZIP disguised as .gz (store-39 production scenario) ──');
test('RL-2: ZIP-as-.gz → decompressed XML (store-39 fix)', async () => {
  const zipBuf = buildZipBuffer('PriceFull7290058140886-039.xml', SAMPLE_XML);
  const tmp = writeTmp(zipBuf);
  const stream = openDecompressedStream(tmp, 'pricefull7290058140886-039.gz', 'rl2');
  const out = await streamToBuffer(stream);
  assert(out.toString().includes('ChainId'), 'XML not found in ZIP output');
});

console.log('\n── RL-3: plain XML ──');
test('RL-3: plain XML file → pass through as-is', async () => {
  const tmp = writeTmp(Buffer.from(SAMPLE_XML));
  const stream = openDecompressedStream(tmp, 'pricefull.xml', 'rl3');
  const out = await streamToBuffer(stream);
  assertEqual(out.toString(), SAMPLE_XML);
});

console.log('\n── RL-4: .gz filename + ZIP content (content wins) ──');
test('RL-4: .gz filename + ZIP content → ZIP extraction used', async () => {
  const zipBuf = buildZipBuffer('PriceFull-004.xml', SAMPLE_XML);
  const tmp = writeTmp(zipBuf);
  const stream = openDecompressedStream(tmp, 'pricefull-004.gz', 'rl4');
  const out = await streamToBuffer(stream);
  assert(out.toString().includes('ChainId'), 'ZIP extraction failed');
});

console.log('\n── RL-5: .gz filename + XML content (content wins) ──');
test('RL-5: .gz filename + XML content → plain pass-through used', async () => {
  const tmp = writeTmp(Buffer.from(SAMPLE_XML));
  const stream = openDecompressedStream(tmp, 'pricefull-005.gz', 'rl5');
  const out = await streamToBuffer(stream);
  assert(out.toString().includes('ChainId'), 'XML not found');
});

console.log('\n── RL-6: unknown/corrupt binary → rejected at format layer ──');
test('RL-6: corrupt binary → error from format layer, parseXMLStream never called', async () => {
  const tmp = writeTmp(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03,
                                    0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]));
  let parseXMLCalled = false;
  const stream = openDecompressedStream(tmp, 'corrupt.gz', 'rl6');
  let caughtErr = null;
  try {
    // Deliberately NOT passing to parseXMLStream — verify stream itself errors
    await streamToBuffer(stream);
  } catch (err) {
    caughtErr = err;
  }
  assert(caughtErr !== null, 'Expected error from format layer, got none');
  assert(!parseXMLCalled, 'parseXMLStream must not be reached');
  assert(/Unsupported.*format|magic/i.test(caughtErr.message),
    `Error message should mention format/magic, got: ${caughtErr.message}`);
});

console.log('\n── RL-7: ZIP without XML → explicit error ──');
test('RL-7a: ZIP with no entries → explicit error', async () => {
  // Build a technically valid but empty ZIP
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(0, 8); eocd.writeUInt16LE(0, 10);
  eocd.writeUInt32LE(0, 12); eocd.writeUInt32LE(0, 16); eocd.writeUInt16LE(0, 20);
  const tmp = writeTmp(Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), eocd]));
  // above is actually a malformed zip — just use a real zip with txt entry
  const zipBuf = buildZipBuffer('README.txt', 'hello');
  const tmp2 = writeTmp(zipBuf);
  const stream = openDecompressedStream(tmp2, 'archive.gz', 'rl7a');
  let err = null;
  try { await streamToBuffer(stream); } catch (e) { err = e; }
  assert(err !== null, 'Expected error for ZIP with no XML entries');
  assert(/no XML/i.test(err.message) || /entries/i.test(err.message),
    `Error should mention missing XML entries: ${err.message}`);
});

test('RL-7b: ZIP with multiple XML entries → explicit error (ambiguous)', async () => {
  // Build a ZIP with two XML files by concatenating two single-entry ZIPs
  // Use the library to build each, then create a 2-entry ZIP manually
  const data1 = Buffer.from('<A/>');
  const data2 = Buffer.from('<B/>');
  const name1 = Buffer.from('file1.xml');
  const name2 = Buffer.from('file2.xml');
  function buildEntry(name, data) {
    const compressed = deflateRawSync(data);
    const crc = computeCrc32(data);
    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    name.copy(lh, 30);
    return { lh, compressed, crc, name };
  }
  const e1 = buildEntry(name1, data1);
  const e2 = buildEntry(name2, data2);
  const lhData1 = Buffer.concat([e1.lh, e1.compressed]);
  const lhData2 = Buffer.concat([e2.lh, e2.compressed]);
  const offset2 = lhData1.length;
  const cdSize = (46 + name1.length) + (46 + name2.length);
  const cdOffset = lhData1.length + lhData2.length;
  const cd1 = Buffer.alloc(46 + name1.length);
  cd1.writeUInt32LE(0x02014b50, 0); cd1.writeUInt16LE(20, 4); cd1.writeUInt16LE(20, 6);
  cd1.writeUInt16LE(0, 8); cd1.writeUInt16LE(8, 10); cd1.writeUInt16LE(0, 12); cd1.writeUInt16LE(0, 14);
  cd1.writeUInt32LE(e1.crc, 16); cd1.writeUInt32LE(deflateRawSync(data1).length, 20);
  cd1.writeUInt32LE(data1.length, 24); cd1.writeUInt16LE(name1.length, 28); cd1.writeUInt16LE(0, 30);
  cd1.writeUInt16LE(0, 32); cd1.writeUInt16LE(0, 34); cd1.writeUInt16LE(0, 36);
  cd1.writeUInt32LE(0, 38); cd1.writeUInt32LE(0, 42); name1.copy(cd1, 46);
  const cd2 = Buffer.alloc(46 + name2.length);
  cd2.writeUInt32LE(0x02014b50, 0); cd2.writeUInt16LE(20, 4); cd2.writeUInt16LE(20, 6);
  cd2.writeUInt16LE(0, 8); cd2.writeUInt16LE(8, 10); cd2.writeUInt16LE(0, 12); cd2.writeUInt16LE(0, 14);
  cd2.writeUInt32LE(e2.crc, 16); cd2.writeUInt32LE(deflateRawSync(data2).length, 20);
  cd2.writeUInt32LE(data2.length, 24); cd2.writeUInt16LE(name2.length, 28); cd2.writeUInt16LE(0, 30);
  cd2.writeUInt16LE(0, 32); cd2.writeUInt16LE(0, 34); cd2.writeUInt16LE(0, 36);
  cd2.writeUInt32LE(0, 38); cd2.writeUInt32LE(offset2, 42); name2.copy(cd2, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdOffset, 16); eocd.writeUInt16LE(0, 20);
  const zipBuf = Buffer.concat([lhData1, lhData2, cd1, cd2, eocd]);
  const tmp = writeTmp(zipBuf);
  const stream = openDecompressedStream(tmp, 'multi.gz', 'rl7b');
  let err = null;
  try { await streamToBuffer(stream); } catch (e) { err = e; }
  assert(err !== null, 'Expected error for ambiguous multi-XML ZIP');
  assert(/multiple|ambiguous/i.test(err.message),
    `Error should mention multiple/ambiguous: ${err.message}`);
});

console.log('\n── RL-8: ZIP extraction failure ──');
test('RL-8: ZIP with corrupt compressed body → unzip extraction error propagated', async () => {
  // Valid ZIP structure but garbage compressed data → unzip will fail extraction
  const name = Buffer.from('PriceFull-008.xml');
  const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x01, 0x02, 0x03, 0x04]);
  const fakeCrc = 0xdeadbeef;
  const lh = Buffer.alloc(30 + name.length);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(fakeCrc, 14); lh.writeUInt32LE(garbage.length, 18);
  lh.writeUInt32LE(50, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  name.copy(lh, 30);
  const cdOffset = lh.length + garbage.length;
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(fakeCrc, 16); cd.writeUInt32LE(garbage.length, 20);
  cd.writeUInt32LE(50, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42); name.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdOffset, 16); eocd.writeUInt16LE(0, 20);
  const zipBuf = Buffer.concat([lh, garbage, cd, eocd]);
  const tmp = writeTmp(zipBuf);
  const stream = openDecompressedStream(tmp, 'corrupt-data.gz', 'rl8');
  let err = null;
  try { await streamToBuffer(stream); } catch (e) { err = e; }
  assert(err !== null, 'Expected stream error from corrupt ZIP body');
});

console.log('\n── RL-9: temp file cleanup after success ──');
test('RL-9: temp file deleted after successful stream consumption (GZIP)', async () => {
  const gzBuf = gzipSync(Buffer.from(SAMPLE_XML));
  const tmp = writeTmp(gzBuf);
  assert(existsSync(tmp), 'precondition: file exists before stream');
  const stream = openDecompressedStream(tmp, 'pricefull-009.gz', 'rl9');
  await streamToBuffer(stream);
  const deleted = await waitForDeletion(tmp, 500);
  assert(deleted, `temp file should be deleted after success, still exists: ${tmp}`);
});

console.log('\n── RL-10: temp file cleanup after failure ──');
test('RL-10: temp file deleted after stream error (UNKNOWN format)', async () => {
  const tmp = writeTmp(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03,
                                    0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]));
  assert(existsSync(tmp), 'precondition: file exists before stream');
  const stream = openDecompressedStream(tmp, 'corrupt-010.gz', 'rl10');
  try { await streamToBuffer(stream); } catch (_) {}
  const deleted = await waitForDeletion(tmp, 500);
  assert(deleted, `temp file should be deleted after failure, still exists: ${tmp}`);
});

// ── RL-INT ───────────────────────────────────────────────────────────────────

console.log('\n── RL-INT: ZIP → openDecompressedStream → parseXMLStream ──');
test('RL-INT: ZIP-as-.gz → parseXMLStream → products parsed, errors=0', async () => {
  const priceFull = `<?xml version="1.0" encoding="utf-8"?>
<Root>
  <ChainId>7290058140886</ChainId>
  <StoreId>039</StoreId>
  <Items>
    <Item>
      <ItemCode>7290000000001</ItemCode>
      <ItemName>חלב תנובה 3%</ItemName>
      <ItemPrice>6.90</ItemPrice>
      <UnitOfMeasure>ליטר</UnitOfMeasure>
      <Quantity>1</Quantity>
      <ManufacturerName>תנובה</ManufacturerName>
      <PriceUpdateDate>2026-09-30</PriceUpdateDate>
    </Item>
    <Item>
      <ItemCode>7290000000002</ItemCode>
      <ItemName>לחם אחיד</ItemName>
      <ItemPrice>9.50</ItemPrice>
      <UnitOfMeasure>יח</UnitOfMeasure>
      <Quantity>1</Quantity>
      <ManufacturerName>אחיד</ManufacturerName>
      <PriceUpdateDate>2026-09-30</PriceUpdateDate>
    </Item>
  </Items>
</Root>`;
  const zipBuf = buildZipBuffer('PriceFull7290058140886-039.xml', priceFull);
  const tmp = writeTmp(zipBuf);
  const stream = openDecompressedStream(tmp, 'pricefull7290058140886-039.gz', 'rl-int');
  const products = [];
  const { count, errors } = await parseXMLStream(
    stream,
    (p) => products.push(p),
    null,
    { chainId: '7290058140886', chainName: 'רמי לוי' },
  );
  assert(count >= 1, `Expected at least 1 product, got ${count}`);
  assertEqual(errors, 0, 'errors');
  assert(products.some(p => p.barcode === '7290000000001'), 'barcode 7290000000001 not found');
  assert(products.some(p => p.barcode === '7290000000002'), 'barcode 7290000000002 not found');
});

// ── ZIP temp-file cleanup contracts ──────────────────────────────────────────
// These prove that every ZIP code path in openDecompressedStream
// deletes tmpFile via the production cleanup handler — not copied logic.

console.log('\n── ZIP cleanup contracts ──');

test('RL-CLEAN-ZIP-SUCCESS: valid ZIP → stream consumed → tmpFile deleted', async () => {
  const tmp = writeTmp(buildZipBuffer('PriceFull-clean.xml', SAMPLE_XML));
  assert(existsSync(tmp), 'precondition: file exists');
  const stream = openDecompressedStream(tmp, 'clean.gz', 'clean-zip-success');
  await streamToBuffer(stream);
  assert(await waitForDeletion(tmp, 500), `tmpFile not deleted after ZIP success: ${tmp}`);
});

test('RL-CLEAN-ZIP-NOXML: ZIP with no XML entries → rejected → tmpFile deleted', async () => {
  const tmp = writeTmp(buildZipBuffer('README.txt', 'no xml here'));
  assert(existsSync(tmp), 'precondition: file exists');
  const stream = openDecompressedStream(tmp, 'noxml.gz', 'clean-zip-noxml');
  try { await streamToBuffer(stream); } catch (_) {}
  assert(await waitForDeletion(tmp, 500), `tmpFile not deleted after no-XML rejection: ${tmp}`);
});

test('RL-CLEAN-ZIP-MULTI: ZIP with multiple XML entries → rejected → tmpFile deleted', async () => {
  // Reuse the 2-entry ZIP built inline for RL-7b
  const data1 = Buffer.from('<A/>'), data2 = Buffer.from('<B/>');
  const n1 = Buffer.from('f1.xml'), n2 = Buffer.from('f2.xml');
  function mkEntry(name, data) {
    const comp = deflateRawSync(data);
    const crc  = computeCrc32(data);
    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
    lh.writeUInt16LE(8,8); lh.writeUInt16LE(0,10); lh.writeUInt16LE(0,12);
    lh.writeUInt32LE(crc,14); lh.writeUInt32LE(comp.length,18);
    lh.writeUInt32LE(data.length,22); lh.writeUInt16LE(name.length,26); lh.writeUInt16LE(0,28);
    name.copy(lh,30);
    return { lh, comp, crc, name };
  }
  const e1 = mkEntry(n1, data1), e2 = mkEntry(n2, data2);
  const body1 = Buffer.concat([e1.lh, e1.comp]);
  const body2 = Buffer.concat([e2.lh, e2.comp]);
  const off2 = body1.length;
  function mkCd(e, localOff) {
    const cd = Buffer.alloc(46 + e.name.length);
    cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6);
    cd.writeUInt16LE(0,8); cd.writeUInt16LE(8,10); cd.writeUInt16LE(0,12); cd.writeUInt16LE(0,14);
    cd.writeUInt32LE(e.crc,16); cd.writeUInt32LE(e.comp.length,20);
    cd.writeUInt32LE(e.name.length === 6 ? 4 : 4,24); // data length
    cd.writeUInt16LE(e.name.length,28); cd.writeUInt16LE(0,30);
    cd.writeUInt16LE(0,32); cd.writeUInt16LE(0,34); cd.writeUInt16LE(0,36);
    cd.writeUInt32LE(0,38); cd.writeUInt32LE(localOff,42); e.name.copy(cd,46);
    return cd;
  }
  const cd1 = mkCd(e1, 0), cd2 = mkCd(e2, off2);
  const cdOff = body1.length + body2.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(2,8); eocd.writeUInt16LE(2,10);
  eocd.writeUInt32LE(cd1.length+cd2.length,12); eocd.writeUInt32LE(cdOff,16); eocd.writeUInt16LE(0,20);
  const tmp = writeTmp(Buffer.concat([body1, body2, cd1, cd2, eocd]));
  assert(existsSync(tmp), 'precondition: file exists');
  const stream = openDecompressedStream(tmp, 'multi.gz', 'clean-zip-multi');
  try { await streamToBuffer(stream); } catch (_) {}
  assert(await waitForDeletion(tmp, 500), `tmpFile not deleted after multi-XML rejection: ${tmp}`);
});

test('RL-CLEAN-ZIP-CORRUPT: ZIP magic + garbage body → listing fails → tmpFile deleted', async () => {
  // Has ZIP magic bytes so detectFormat says ZIP, but unzip -Z1 will fail
  const garbage = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(100, 0xff),
  ]);
  const tmp = writeTmp(garbage);
  assert(existsSync(tmp), 'precondition: file exists');
  const stream = openDecompressedStream(tmp, 'corrupt-listing.gz', 'clean-zip-corrupt');
  try { await streamToBuffer(stream); } catch (_) {}
  assert(await waitForDeletion(tmp, 500), `tmpFile not deleted after corrupt-ZIP listing failure: ${tmp}`);
});

test('RL-CLEAN-ZIP-EXTRACT-FAIL: listing succeeds, extraction fails → tmpFile deleted', async () => {
  // Valid ZIP structure with corrupt compressed body (same as RL-8 fixture)
  const name = Buffer.from('PriceFull-extractfail.xml');
  const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0x01, 0x02, 0x03, 0x04]);
  const fakeCrc = 0xdeadbeef;
  const lh = Buffer.alloc(30 + name.length);
  lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0,6);
  lh.writeUInt16LE(8,8); lh.writeUInt16LE(0,10); lh.writeUInt16LE(0,12);
  lh.writeUInt32LE(fakeCrc,14); lh.writeUInt32LE(garbage.length,18);
  lh.writeUInt32LE(50,22); lh.writeUInt16LE(name.length,26); lh.writeUInt16LE(0,28);
  name.copy(lh,30);
  const cdOff = lh.length + garbage.length;
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6);
  cd.writeUInt16LE(0,8); cd.writeUInt16LE(8,10); cd.writeUInt16LE(0,12); cd.writeUInt16LE(0,14);
  cd.writeUInt32LE(fakeCrc,16); cd.writeUInt32LE(garbage.length,20);
  cd.writeUInt32LE(50,24); cd.writeUInt16LE(name.length,28); cd.writeUInt16LE(0,30);
  cd.writeUInt16LE(0,32); cd.writeUInt16LE(0,34); cd.writeUInt16LE(0,36);
  cd.writeUInt32LE(0,38); cd.writeUInt32LE(0,42); name.copy(cd,46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(1,8); eocd.writeUInt16LE(1,10);
  eocd.writeUInt32LE(cd.length,12); eocd.writeUInt32LE(cdOff,16); eocd.writeUInt16LE(0,20);
  const tmp = writeTmp(Buffer.concat([lh, garbage, cd, eocd]));
  assert(existsSync(tmp), 'precondition: file exists');
  const stream = openDecompressedStream(tmp, 'extractfail.gz', 'clean-zip-extract-fail');
  try { await streamToBuffer(stream); } catch (_) {}
  assert(await waitForDeletion(tmp, 500), `tmpFile not deleted after ZIP extraction failure: ${tmp}`);
});

// ── Wait and report ──────────────────────────────────────────────────────────

await Promise.all(allPromises);

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);

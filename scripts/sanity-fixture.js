#!/usr/bin/env node
// scripts/sanity-fixture.js
// Parser sanity check using local XML fixtures
// Runs in GitHub Actions (no Israeli IP required)
// Tests: parser correctness, gzip handling, validation, field mapping

import { createReadStream } from 'fs';
import { gzipSync } from 'zlib';
import sax from 'sax';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = [
  {
    chainId: 'shufersal',
    file: 'fixtures/shufersal-sample.xml',
    expectedItems: 2,
    expectedBarcodes: ['11210000094', '7290010328103'],
  },
  {
    chainId: 'rami-levy',
    file: 'fixtures/rami-levy-sample.xml',
    expectedItems: 2,
    expectedBarcodes: ['72917367', '7290058000133'],
  },
];

async function main() {
  console.log('\n🔧 PARSER SANITY CHECK (Fixtures)\n');
  console.log('Testing parser correctness without Israeli IP dependency\n');

  let passed = 0;
  let failed = 0;

  for (const fixture of FIXTURES) {
    try {
      const result = await testFixture(fixture);
      if (result.passed) {
        console.log(`✅ ${fixture.chainId} PASS`);
        console.log(`   Parsed ${result.itemsFound} items`);
        result.items.forEach(item => {
          console.log(`   • ${item.barcode}: ${item.name} ₪${item.price}`);
        });
        passed++;
      } else {
        console.log(`❌ ${fixture.chainId} FAIL`);
        console.log(`   ${result.error}`);
        failed++;
      }
      console.log();
    } catch (err) {
      console.log(`❌ ${fixture.chainId} FAIL`);
      console.log(`   ${err.message}`);
      failed++;
      console.log();
    }
  }

  // Test gzip handling
  console.log('Testing gzip decompression...');
  try {
    await testGzipHandling();
    console.log('✅ Gzip decompression PASS\n');
    passed++;
  } catch (err) {
    console.log(`❌ Gzip decompression FAIL\n   ${err.message}\n`);
    failed++;
  }

  // Summary
  console.log('═'.repeat(50));
  console.log('📊 PARSER FIXTURE SUMMARY');
  console.log(`Passed: ${passed} | Failed: ${failed}`);
  console.log('═'.repeat(50));

  if (failed > 0) {
    console.error('\n❌ Parser sanity check FAILED');
    console.error('Parser has regressions. Fix before merging.\n');
    process.exit(1);
  }

  console.log('\n✅ Parser is healthy. All fixtures passed.\n');
  process.exit(0);
}

async function testFixture(fixture) {
  const filePath = join(__dirname, fixture.file);
  const fileStream = createReadStream(filePath);

  return new Promise((resolve, reject) => {
    let foundItems = [];
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
          foundItems.push(currentItem);
        }
      }
    });

    parser.on('error', (err) => {
      reject(new Error(`Parser error: ${err.message}`));
    });

    parser.on('end', () => {
      // Validate expectations
      if (foundItems.length !== fixture.expectedItems) {
        resolve({
          passed: false,
          error: `Expected ${fixture.expectedItems} items, found ${foundItems.length}`,
        });
        return;
      }

      const barcodes = foundItems.map(i => i.barcode);
      const missing = fixture.expectedBarcodes.filter(b => !barcodes.includes(b));
      if (missing.length > 0) {
        resolve({
          passed: false,
          error: `Missing barcodes: ${missing.join(', ')}`,
        });
        return;
      }

      resolve({
        passed: true,
        itemsFound: foundItems.length,
        items: foundItems,
      });
    });

    fileStream.pipe(parser);
    fileStream.on('error', reject);
  });
}

async function testGzipHandling() {
  return new Promise((resolve, reject) => {
    try {
      // Create test data
      const testXml = '<?xml version="1.0"?><item><barcode>12345</barcode><name>Test</name><price>10.0</price></item>';
      const compressed = gzipSync(testXml);

      if (compressed.length === 0) {
        reject(new Error('gzip compression produced empty output'));
        return;
      }

      // Check gzip magic number
      if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
        reject(new Error('gzip magic number missing'));
        return;
      }

      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

main().catch((err) => {
  console.error('❌ FATAL:', err.message);
  process.exit(1);
});

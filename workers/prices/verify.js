#!/usr/bin/env node
// verify.js — End-to-end verification of price sync
// Usage: node verify.js

import 'dotenv/config.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const config = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
};

console.log('\n🔍 VERIFICATION: End-to-End Price Sync\n');
console.log(`Firebase Project: ${config.projectId}`);
console.log(`Database: ${config.databaseURL}\n`);

try {
  const app = initializeApp({
    credential: cert(config),
    databaseURL: config.databaseURL,
  });

  const db = getDatabase(app);

  // 1. Fetch sync summary
  console.log('📊 SYNC METRICS');
  console.log('═'.repeat(50));
  const summarySnap = await db.ref('syncSummary').get();
  if (summarySnap.exists()) {
    const summary = summarySnap.val();
    console.log(`Last Sync: ${summary.lastSyncAt}`);
    console.log(`Total Products: ${summary.totalProducts}`);
    console.log(`Chains Succeeded: ${summary.chainsSucceeded}`);
    console.log(`Chains Failed: ${summary.chainsFailed}`);
    console.log(`Elapsed: ${summary.elapsedMinutes} min\n`);
  } else {
    console.log('❌ No sync summary found\n');
  }

  // 2. Fetch Shufersal chain status
  console.log('📈 SHUFERSAL CHAIN STATUS');
  console.log('═'.repeat(50));
  const shufersalSnap = await db.ref('syncStatus/shufersal').get();
  if (shufersalSnap.exists()) {
    const status = shufersalSnap.val();
    console.log(`Last Sync Date: ${status.lastSyncDate}`);
    console.log(`Items Processed: ${status.itemsProcessed}`);
    console.log(`Errors: ${status.errors}`);
    console.log(`Skipped: ${status.skipped}\n`);
  } else {
    console.log('❌ No Shufersal status found\n');
  }

  // 3. Find a real barcode
  console.log('🔎 SEARCHING FOR SAMPLE BARCODE');
  console.log('═'.repeat(50));
  const pricesSnap = await db.ref('prices').limitToFirst(100).get();
  let sampleBarcode = null;
  let sampleData = null;

  if (pricesSnap.exists()) {
    const prices = pricesSnap.val();
    for (const [barcode, storeData] of Object.entries(prices)) {
      if (storeData && typeof storeData === 'object') {
        const firstStore = Object.values(storeData)[0];
        if (firstStore && firstStore.barcode) {
          sampleBarcode = barcode;
          sampleData = firstStore;
          break;
        }
      }
    }
  }

  if (!sampleBarcode) {
    console.log('❌ No price data found in Firebase\n');
    process.exit(1);
  }

  console.log(`✅ Found Sample Barcode: ${sampleBarcode}\n`);

  // 4. Display full product data
  console.log('📦 SAMPLE PRODUCT DATA');
  console.log('═'.repeat(50));
  console.log(JSON.stringify(sampleData, null, 2));
  console.log();

  // 5. Fetch all entries for this barcode
  console.log('🏪 ALL STORES FOR THIS BARCODE');
  console.log('═'.repeat(50));
  const barcodeSnap = await db.ref(`prices/${sampleBarcode}`).get();
  if (barcodeSnap.exists()) {
    const storeData = barcodeSnap.val();
    let count = 0;
    for (const [key, data] of Object.entries(storeData)) {
      if (data && data.price !== undefined) {
        console.log(`  ${data.chainName} | ${data.storeName || 'N/A'} | ₪${data.price} | ${data.updatedAt}`);
        count++;
      }
    }
    console.log(`\nTotal stores: ${count}\n`);
  }

  // 6. Validation checks
  console.log('✅ VALIDATION CHECKS');
  console.log('═'.repeat(50));

  const checks = [
    {
      name: 'Firebase Connected',
      pass: !!sampleData,
      detail: sampleData ? 'Data retrieved successfully' : 'Failed to retrieve data',
    },
    {
      name: 'Barcode Present',
      pass: !!sampleData.barcode,
      detail: `Barcode: ${sampleData.barcode || 'MISSING'}`,
    },
    {
      name: 'Product Name',
      pass: !!sampleData.name,
      detail: `Name: ${sampleData.name || 'MISSING'}`,
    },
    {
      name: 'Price Value',
      pass: sampleData.price > 0 && sampleData.price < 10000,
      detail: `Price: ₪${sampleData.price} (should be 0.01-10,000)`,
    },
    {
      name: 'Chain Data',
      pass: !!sampleData.chainId && !!sampleData.chainName,
      detail: `${sampleData.chainId} / ${sampleData.chainName}`,
    },
    {
      name: 'Source Field',
      pass: sampleData.source === 'official',
      detail: `Source: ${sampleData.source || 'MISSING'}`,
    },
    {
      name: 'Updated Timestamp',
      pass: !!sampleData.updatedAt,
      detail: `Updated: ${sampleData.updatedAt || 'MISSING'}`,
    },
    {
      name: 'Synced Timestamp',
      pass: !!sampleData.syncedAt,
      detail: `Synced: ${new Date(sampleData.syncedAt).toISOString()}`,
    },
  ];

  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? '✅' : '❌';
    console.log(`${icon} ${check.name}`);
    console.log(`   ${check.detail}`);
    if (!check.pass) allPass = false;
  }

  console.log();
  if (allPass) {
    console.log('🎉 ALL VERIFICATION CHECKS PASSED\n');
    console.log('Summary:');
    console.log(`  • Real price data is in Firebase`);
    console.log(`  • Product information is complete`);
    console.log(`  • Timestamps are present`);
    console.log(`  • Data integrity verified\n`);
    process.exit(0);
  } else {
    console.log('⚠️ SOME CHECKS FAILED — Review details above\n');
    process.exit(1);
  }
} catch (err) {
  console.error('❌ VERIFICATION FAILED');
  console.error(`Error: ${err.message}\n`);
  process.exit(1);
}

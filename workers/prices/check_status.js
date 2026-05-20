import { loadConfig } from './config.js';
import { initFirebase, getDB } from './firebaseWriter.js';

const config = await loadConfig();
initFirebase(config.firebase);
const db = getDB();

const sync = await db.ref('syncSummary').get();
console.log('=== SYNC SUMMARY ===');
console.log(JSON.stringify(sync.val(), null, 2));

const status = await db.ref('syncStatus').get();
console.log('\n=== SYNC STATUS BY CHAIN ===');
if (status.val()) {
  Object.entries(status.val()).forEach(([k, v]) => {
    const date = v.lastSyncDate || 'never';
    const items = v.itemsProcessed || 0;
    const err = v.errors ? 'YES' : 'no';
    console.log(`${k}: ${date} | Items: ${items} | Errors: ${err}`);
  });
}
process.exit(0);

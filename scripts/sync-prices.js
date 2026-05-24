// scripts/sync-prices.js — v2.0.0
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Auto-load .env from the scripts/ directory (no dotenv package needed)
try {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const env = readFileSync(resolve(__dir, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([\s\S]*?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\\n/g, '\n');
  }
} catch (_) { /* .env optional — env vars may be set externally (PM2, shell) */ }

import { initFirebase, BatchWriter, getDB } from './firebase.js';
import { CHAINS } from './chains.js';
import { parseXMLStream } from './xml-parser.js';
import { resolveFileUrls, resolveAllPriceUrls, downloadToStream } from './downloader.js';
import { logger, safeKey } from './utils.js';

// ── Multi-store sync (Shufersal: one Price*.gz per store) ──────────────────
async function syncChainMultiStore(chain, writer) {
  logger.info(`\n${'━'.repeat(50)}\n[${chain.name}] Multi-store sync`);
  const result = { chainId: chain.id, chainName: chain.name, count: 0, storeCount: 0, errors: 0, failed: false, skipped: false };

  const maxStores = chain.maxStoresToSync || 50;
  const maxPages  = chain.maxIndexPages   || 10;

  let priceByStore, storeByStore;
  try {
    ({ priceByStore, storeByStore } = await resolveAllPriceUrls(chain, maxStores, maxPages));
  } catch (e) {
    logger.fail(`[${chain.name}] Index discovery failed: ${e.message}`);
    result.failed = true; return result;
  }

  if (priceByStore.size === 0) {
    logger.warn(`[${chain.name}] No store price files found`);
    result.failed = true; return result;
  }

  const db = getDB();
  const chainMeta = { chainId: chain.chainId, chainName: chain.name };

  // 1. Sync Stores metadata files (lat/lng) if available
  for (const [storeId, url] of storeByStore) {
    try {
      const stream = await downloadToStream(url, `${chain.name}-stores-${storeId}`);
      await parseXMLStream(stream, () => {}, async (store) => {
        const key = safeKey(`${chain.id}_${store.storeId || storeId}`);
        await writer.queue(`stores/${key}`, { ...store, chainId: chain.chainId, chainName: chain.name });
        result.storeCount++;
      }, chainMeta);
      await writer.flush();
    } catch (e) { logger.warn(`[${chain.name}] Store-meta ${storeId} failed: ${e.message}`); }
  }

  // 2. Sync Price files per store
  for (const [storeId, url] of priceByStore) {
    logger.info(`[${chain.name}] Syncing store ${storeId} …`);
    try {
      const stream = await downloadToStream(url, `${chain.name}-${storeId}`);
      let storeNameSeen = '';

      const { count, errors } = await parseXMLStream(stream,
        async (product) => {
          if (!storeNameSeen && product.storeName) storeNameSeen = product.storeName;
          const sid  = product.storeId || storeId;
          const key  = safeKey(`${chain.id}_${sid}`);
          await writer.queue(`prices/${product.barcode}/${key}`, {
            barcode:   product.barcode,
            name:      product.name,
            chainId:   chain.id,
            chainName: chain.name,
            storeId:   sid,
            storeName: product.storeName || '',
            price:     product.price,
            unit:      product.unit      || '',
            quantity:  product.quantity  || '',
            brand:     product.brand     || '',
            updatedAt: product.updatedAt,
            source:    'official',
            syncedAt:  Date.now(),
          });
        },
        null,
        { ...chainMeta, storeId }
      );
      await writer.flush();
      result.count += count;
      result.errors += errors;

      // Write basic store metadata (will be enriched with coords when Stores files available)
      if (!storeByStore.has(storeId)) {
        const key = safeKey(`${chain.id}_${storeId}`);
        await db.ref(`stores/${key}`).update({
          chainId: chain.chainId, chainName: chain.name,
          storeId, storeName: storeNameSeen,
          updatedAt: new Date().toISOString(),
        });
        result.storeCount++;
      }

      logger.ok(`[${chain.name}] Store ${storeId}: ${count} prices`);
    } catch (e) {
      logger.warn(`[${chain.name}] Store ${storeId} failed: ${e.message}`);
      result.errors++;
    }
  }

  // Write sync status
  try {
    await writer.writeSyncStatus(chain.id, {
      chainId: chain.id, chainName: chain.name,
      lastSyncDate:    new Date().toISOString().split('T')[0],
      lastSuccessAt:   new Date().toISOString(),
      storesSynced:    priceByStore.size,
      itemsProcessed:  result.count,
      storesProcessed: result.storeCount,
      errors: result.errors,
    });
  } catch (_) {}

  logger.ok(`[${chain.name}] ${result.count.toLocaleString()} prices across ${priceByStore.size} stores`);
  return result;
}

// ── Single-file sync (PriceFull*.gz — Rami Levy, Victory, etc.) ────────────
async function syncChain(chain, writer) {
  if (chain.multiStore) return syncChainMultiStore(chain, writer);

  logger.info(`\n${'━'.repeat(50)}\n[${chain.name}] Starting`);
  const result = { chainId: chain.id, chainName: chain.name, count: 0, storeCount: 0, errors: 0, failed: false, skipped: false };

  try {
    const { priceUrl, storeUrl } = await resolveFileUrls(chain);
    if (!priceUrl) { logger.warn(`[${chain.name}] No PriceFull URL`); result.failed = true; return result; }

    // Skip if already synced today with same file
    const db = getDB();
    const snap = await db.ref(`syncStatus/${safeKey(chain.id)}`).get();
    if (snap.exists()) {
      const s = snap.val();
      const today = new Date().toISOString().split('T')[0];
      if (s.lastSyncDate === today && s.lastPriceUrl === priceUrl) {
        logger.skip(`[${chain.name}] Already synced today`);
        result.skipped = true; result.count = s.itemsProcessed || 0;
        return result;
      }
    }

    const chainMeta = { chainId: chain.chainId, chainName: chain.name };

    // --- Sync Stores XML (if available) ---
    if (storeUrl) {
      try {
        logger.info(`[${chain.name}] Syncing stores: ${storeUrl}`);
        const storeStream = await downloadToStream(storeUrl, chain.name + '-stores');
        await parseXMLStream(storeStream,
          () => {}, // no products in stores file
          async (store) => {
            const key = safeKey(`${chain.id}_${store.storeId}`);
            await writer.queue(`stores/${key}`, store);
            result.storeCount++;
          },
          chainMeta
        );
        await writer.flush();
        logger.ok(`[${chain.name}] ${result.storeCount} stores written`);
      } catch (e) {
        logger.warn(`[${chain.name}] Store sync failed: ${e.message}`);
      }
    }

    // --- Sync Prices XML ---
    logger.info(`[${chain.name}] Syncing prices: ${priceUrl}`);
    const priceStream = await downloadToStream(priceUrl, chain.name);
    const { count, skipped: sk, errors } = await parseXMLStream(
      priceStream,
      async (product) => {
        const storeKey = safeKey(`${chain.id}_${product.storeId || '0'}`);
        await writer.queue(`prices/${product.barcode}/${storeKey}`, {
          barcode:   product.barcode,
          name:      product.name,
          chainId:   chain.id,
          chainName: chain.name,
          storeId:   product.storeId   || '',
          storeName: product.storeName || '',
          price:     product.price,
          unit:      product.unit      || '',
          quantity:  product.quantity  || '',
          brand:     product.brand     || '',
          updatedAt: product.updatedAt,
          source:    'official',
          syncedAt:  Date.now(),
        });
      },
      null,
      chainMeta
    );
    await writer.flush();

    result.count = count; result.errors = errors;

    const now = new Date();
    await writer.writeSyncStatus(chain.id, {
      chainId: chain.id, chainName: chain.name,
      lastSyncDate:   now.toISOString().split('T')[0],
      lastSuccessAt:  now.toISOString(),
      lastPriceUrl:   priceUrl,
      lastStoreUrl:   storeUrl || null,
      itemsProcessed: count, storesProcessed: result.storeCount,
      skipped: sk, errors,
    });

    logger.ok(`[${chain.name}] ${count.toLocaleString()} prices, ${result.storeCount} stores, ${errors} errors`);

  } catch (e) {
    result.failed = true;
    logger.fail(`[${chain.name}] FAILED: ${e.message}`);
    try { await getDB().ref(`syncStatus/${safeKey(chain.id)}/lastError`).set({ message: e.message, at: new Date().toISOString() }); } catch (_) {}
  }
  return result;
}

async function main() {
  const t0 = Date.now();
  logger.info('🛒 Israeli Supermarket Price Sync v2.0.0');
  try { initFirebase(); } catch (e) { logger.fail('Firebase init:', e.message); process.exit(1); }

  const writer = new BatchWriter(getDB());
  const chains = CHAINS.filter(c => c.enabled);
  const results = [];

  for (const chain of chains) results.push(await syncChain(chain, writer));

  const elapsed   = ((Date.now() - t0) / 60000).toFixed(1);
  const total     = results.reduce((s, r) => s + r.count, 0);
  const failed    = results.filter(r => r.failed).length;
  const succeeded = results.filter(r => !r.failed && !r.skipped).length;

  logger.info(`\n${'═'.repeat(50)}`);
  results.forEach(r => logger.info(`  ${r.failed?'❌':r.skipped?'⏭':'✅'} ${r.chainName}: ${r.count.toLocaleString()} prices, ${r.storeCount||0} stores`));
  logger.info(`Total: ${total.toLocaleString()} | Time: ${elapsed}min | Failed: ${failed}/${chains.length}`);

  await writer.writeSyncSummary({
    lastSync: Date.now(), lastSyncDate: new Date().toISOString().split('T')[0],
    totalProducts: total, chainsEnabled: chains.length, chainsSucceeded: succeeded, chainsFailed: failed,
  });

  // Exit 0 (success) unless ALL chains failed
// Partial success is OK — prices from some chains are better than nothing
if (failed === chains.length) {
  logger.fail('All chains failed — check network connectivity and URLs');
  process.exit(1);
} else {
  if (failed > 0) logger.warn(`${failed} chain(s) failed but ${succeeded} succeeded — partial sync OK`);
  process.exit(0);
}
}

main().catch(e => { logger.fail('Fatal:', e); process.exit(1); });

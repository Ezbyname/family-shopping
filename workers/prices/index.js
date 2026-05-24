// workers/prices/index.js — v3.0.0 (hardened)
// Israeli supermarket price sync orchestrator.
// Runs on Israeli VPS via cron. DO NOT run from non-Israeli IPs.
//
// Usage:
//   node index.js              — sync all enabled chains
//   node index.js shufersal   — sync one chain
//   DRY_RUN=true node index.js — parse but do not write to Firebase
//
// Exit codes:
//   0 = success (all or partial chains synced)
//   1 = all chains failed
//   2 = config/env validation error
//   3 = IP safety gate failure
//   4 = Firebase write failure
//   5 = source fetch failure (all chains blocked/unreachable)

import 'dotenv/config.js';
import { loadConfig }                        from './config.js';
import { checkIsraeliIP }                    from './check-ip.js';
import { CHAINS }                            from './chains.js';
import { resolveFileUrls, downloadToStream, fetchAndDownloadLatest,
         resolveAllPriceUrls } from './fetchPrices.js';
import { parseXMLStream }                    from './parseXml.js';
import { safeKey }                           from './normalizeProduct.js';
import { initFirebase, BatchWriter, getDB,
         getPriceLastSync, sendAlert }       from './firebaseWriter.js';
import { logger }                            from './logger.js';

// ── MULTI-STORE SYNC (Shufersal: one Price*.gz per store) ──────────────────
async function syncChainMultiStore(chain, writer, config) {
  const label = `[${chain.name}]`;
  const result = {
    chainId:      chain.id,
    chainName:    chain.name,
    count:        0,
    storeCount:   0,
    skipped:      0,
    errors:       0,
    failed:       false,
    alreadySynced: false,
    failReason:   null,
  };

  const maxStores = chain.maxStoresToSync || 5;
  const maxPages  = chain.maxIndexPages   || 10;

  logger.info(`${label} Multi-store sync starting`, {
    chainId: chain.id, maxStores, maxPages, dryRun: config.dryRun,
  });

  // ── Resolve per-store price URLs from paginated index ──
  let priceByStore, storeByStore;
  try {
    ({ priceByStore, storeByStore } = await resolveAllPriceUrls(chain, maxStores, maxPages));
  } catch (e) {
    result.failed    = true;
    result.failReason = `Index discovery failed: ${e.message}`;
    logger.fail(`${label} Index discovery failed`, { error: e.message });
    return result;
  }

  if (priceByStore.size === 0) {
    result.failed    = true;
    result.failReason = 'No per-store price files found in index';
    logger.fail(`${label} No store price files found`);
    return result;
  }

  const db        = getDB();
  const chainMeta = { chainId: chain.chainId, chainName: chain.name };
  const storeIdsSynced = [];

  // ── Sync each store's price file ──
  for (const [storeId, url] of priceByStore) {
    logger.info(`${label} Syncing store ${storeId}`, { url: url.split('?')[0] });
    try {
      const stream = await downloadToStream(
        url,
        `${chain.name}-${storeId}`,
        config.worker.downloadTimeout,
        config.worker.downloadRetries,
      );

      let storeNameSeen = '';
      const { count, skipped, errors } = await parseXMLStream(
        stream,
        async (product) => {
          if (!storeNameSeen && product.storeName) storeNameSeen = product.storeName;
          const sid      = product.storeId || storeId;
          const storeKey = safeKey(`${chain.id}_${sid}`);
          await writer.queue(`prices/${product.barcode}/${storeKey}`, {
            barcode:     product.barcode,
            name:        product.name,
            price:       product.price,
            chainId:     chain.id,
            chainName:   chain.name,
            storeId:     sid,
            storeName:   product.storeName || '',
            unit:        product.unit      || '',
            quantity:    product.quantity  || '',
            brand:       product.brand     || '',
            updatedAt:   product.updatedAt,
            currency:    'ILS',
            source:      'official',
            syncedAt:    Date.now(),
            lastUpdated: new Date().toISOString(),
          });
        },
        null,
        { ...chainMeta, storeId },
      );
      await writer.flush();

      result.count   += count;
      result.skipped += skipped;
      result.errors  += errors;
      storeIdsSynced.push(storeId);

      // Write basic store metadata (no lat/lng from Price files — needs Stores files)
      // Note: radius filtering requires lat/lng; this is a placeholder until Stores.gz available.
      if (!config.dryRun) {
        const storeKey = safeKey(`${chain.id}_${storeId}`);
        await db.ref(`stores/${storeKey}`).update({
          chainId:   chain.chainId,
          chainName: chain.name,
          storeId,
          storeName: storeNameSeen || '',
          updatedAt: new Date().toISOString(),
        });
        result.storeCount++;
      }

      logger.ok(`${label} Store ${storeId} done`, { items: count, skipped, errors });
    } catch (e) {
      logger.warn(`${label} Store ${storeId} failed`, { error: e.message });
      result.errors++;
    }
  }

  // ── Write sync status ──
  const now = new Date();
  try {
    await writer.writeSyncStatus(chain.id, {
      chainId:         chain.id,
      chainName:       chain.name,
      lastSyncDate:    now.toISOString().split('T')[0],
      lastSuccessAt:   now.toISOString(),
      itemsProcessed:  result.count,
      storesProcessed: result.storeCount,
      storeIds:        storeIdsSynced,
      maxStoresToSync: maxStores,
      errors:          result.errors,
    });
  } catch (_) {}

  logger.ok(`${label} Multi-store sync complete`, {
    items:   result.count,
    stores:  storeIdsSynced.length,
    errors:  result.errors,
    dryRun:  config.dryRun,
  });
  return result;
}

// ── SYNC ONE CHAIN ──
async function syncChain(chain, writer, config) {
  // Route multi-store chains (Shufersal) to dedicated handler
  if (chain.multiStore) return syncChainMultiStore(chain, writer, config);
  const label  = `[${chain.name}]`;
  const result = {
    chainId:      chain.id,
    chainName:    chain.name,
    count:        0,
    storeCount:   0,
    skipped:      0,
    errors:       0,
    failed:       false,
    alreadySynced: false,
    failReason:   null,
  };

  logger.info(`${label} Starting`, { chainId: chain.id, dryRun: config.dryRun });

  try {
    // ── Step 1: Atomic fetch + download (with SAS expiry retry) ──
    let priceUrl, priceStream;
    try {
      ({ stream: priceStream, priceUrl } = await fetchAndDownloadLatest(
        chain, label,
        config.worker.downloadTimeout,
        config.worker.downloadRetries
      ));
    } catch (err) {
      result.failed = true;
      result.failReason = `fetch+download failed: ${err.message}`;
      logger.fail(`${label} Fetch+download failed`, { error: err.message });
      return result;
    }

    // ── Step 2: Skip if already synced today (same file) ──
    if (!config.dryRun) {
      const lastSync = await getPriceLastSync(getDB(), chain.id);
      if (lastSync) {
        const today = new Date().toISOString().split('T')[0];
        if (lastSync.lastSyncDate === today && lastSync.lastPriceUrl === priceUrl) {
          logger.skip(`${label} Already synced today`, { date: today });
          result.alreadySynced = true;
          result.count = lastSync.itemsProcessed || 0;
          return result;
        }
      }
    }

    const chainMeta = { chainId: chain.chainId, chainName: chain.name };

    // ── Step 3: Parse Prices XML ──
    logger.info(`${label} Parsing prices`);

    const { count, skipped, errors } = await parseXMLStream(
      priceStream,
      async (product) => {
        const storeKey = safeKey(`${chain.id}_${product.storeId || '0'}`);
        await writer.queue(`prices/${product.barcode}/${storeKey}`, {
          barcode:     product.barcode,
          name:        product.name,
          price:       product.price,
          chainId:     chain.id,
          chainName:   chain.name,
          storeId:     product.storeId   || '',
          storeName:   product.storeName || '',
          unit:        product.unit      || '',
          quantity:    product.quantity  || '',
          brand:       product.brand     || '',
          updatedAt:   product.updatedAt,
          currency:    'ILS',
          source:      'official',
          syncedAt:    Date.now(),
          lastUpdated: new Date().toISOString(),
        });
      },
      null,
      chainMeta
    );

    await writer.flush();
    result.count   = count;
    result.skipped = skipped;
    result.errors  = errors;

    // ── Step 4: Write sync status ──
    const now = new Date();
    await writer.writeSyncStatus(chain.id, {
      chainId:         chain.id,
      chainName:       chain.name,
      lastSyncDate:    now.toISOString().split('T')[0],
      lastSuccessAt:   now.toISOString(),
      lastPriceUrl:    priceUrl,
      itemsProcessed:  count,
      skipped,
      errors,
    });

    logger.ok(`${label} Done`, { items: count, stores: result.storeCount, skipped, errors });

  } catch (err) {
    result.failed = true;
    result.failReason = err.message;

    // Exit code 4 — Firebase write failure
    if (err.exitCode === 4) throw err;

    logger.fail(`${label} Sync failed`, { error: err.message });

    try {
      await getDB().ref(`syncStatus/${safeKey(chain.id)}/lastError`)
        .set({ message: err.message, at: new Date().toISOString() });
    } catch (_) {}
  }

  return result;
}

// ── MAIN ──
async function main() {
  const t0 = Date.now();
  logger.info('🛒 Israeli Price Worker starting', {
    version: '3.0.0', pid: process.pid, nodeVersion: process.version,
    NODE_ENV: process.env.NODE_ENV || 'development',
  });

  // ── Step A: Load and validate config ──
  let config;
  try {
    config = loadConfig();
    logger.info('Config loaded', {
      env: config.env, dryRun: config.dryRun,
      projectId: config.firebase.projectId,
    });
  } catch (err) {
    logger.fail('Config error', { error: err.message });
    process.exit(2);
  }

  // ── Step B: Israeli IP safety gate ──
  try {
    const ipResult = await checkIsraeliIP({ silent: false });
    if (!ipResult.passed) {
      const reason = ipResult.allProvidersFailed
        ? 'All IP providers failed — cannot confirm Israeli IP'
        : `Server IP is ${ipResult.country || 'unknown'}, expected IL`;
      logger.fail('SAFETY GATE: Price sync blocked', { reason, ip: ipResult.ip });
      await sendAlert(config.slackWebhook,
        `🚫 Sync BLOCKED — ${reason}. ` +
        `Use Google Cloud me-west1 or AWS il-central-1.`
      );
      process.exit(3);
    }
    if (!ipResult.bypassed) {
      logger.ok('IP gate passed', { ip: ipResult.ip, country: ipResult.country });
    }
  } catch (err) {
    logger.fail('IP check threw unexpectedly — failing closed', { error: err.message });
    process.exit(3);
  }

  // ── Step C: Init Firebase ──
  try {
    initFirebase(config.firebase);
  } catch (err) {
    logger.fail('Firebase init failed', { error: err.message });
    process.exit(4);
  }

  // ── Step D: Select chains ──
  const chainArg = process.argv[2];
  let chains = CHAINS.filter(c => c.enabled);

  if (chainArg) {
    chains = chains.filter(c => c.id === chainArg || c.name === chainArg);
    if (!chains.length) {
      logger.fail(`Unknown chain: ${chainArg}`,
        { available: CHAINS.map(c => c.id).join(', ') });
      process.exit(2);
    }
  }

  if (config.worker.enabledChains.length > 0) {
    chains = chains.filter(c => config.worker.enabledChains.includes(c.id));
  }

  if (!chains.length) {
    logger.fail('No chains selected to sync');
    process.exit(2);
  }

  logger.info('Chains selected', {
    chains: chains.map(c => c.name),
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    logger.warn('DRY RUN MODE — fetching and parsing only, no Firebase writes');
  }

  const writer = new BatchWriter(getDB(), {
    batchSize: config.worker.batchSize,
    dryRun:    config.dryRun,
  });

  // ── Step E: Sync chains (sequential) ──
  const results = [];
  let firebaseWriteError = false;

  for (const chain of chains) {
    try {
      const result = await syncChain(chain, writer, config);
      results.push(result);
    } catch (err) {
      if (err.exitCode === 4) {
        firebaseWriteError = true;
        logger.fail('Firebase write error — stopping sync', { error: err.message });
        break;
      }
      results.push({ chainId: chain.id, chainName: chain.name, failed: true, failReason: err.message, count: 0 });
    }
  }

  // ── Step F: Summary ──
  const elapsed   = ((Date.now() - t0) / 60000).toFixed(2);
  const total     = results.reduce((s, r) => s + (r.count || 0), 0);
  const failed    = results.filter(r => r.failed).length;
  const succeeded = results.filter(r => !r.failed && !r.alreadySynced).length;
  const cached    = results.filter(r => r.alreadySynced).length;

  const summary = {
    lastSync:        Date.now(),
    lastSyncDate:    new Date().toISOString().split('T')[0],
    lastSyncAt:      new Date().toISOString(),
    totalProducts:   total,
    chainsEnabled:   chains.length,
    chainsSucceeded: succeeded,
    chainsCached:    cached,
    chainsFailed:    failed,
    elapsedMinutes:  parseFloat(elapsed),
    dryRun:          config.dryRun,
    workerVersion:   '3.0.0',
  };

  logger.info('══ SYNC SUMMARY ══');
  results.forEach(r => {
    const icon = r.failed ? '❌' : r.alreadySynced ? '⏭' : '✅';
    logger.info(`${icon} ${r.chainName}`, {
      items: r.count, stores: r.storeCount || 0,
      status: r.failed ? `failed: ${r.failReason}` : r.alreadySynced ? 'cached' : 'ok',
    });
  });
  logger.info('Summary', { total, succeeded, cached, failed, elapsed, dryRun: config.dryRun, ...writer.stats() });

  try { await writer.writeSyncSummary(summary); } catch (_) {}

  // ── Step G: Exit codes ──
  if (firebaseWriteError) {
    await sendAlert(config.slackWebhook, `Firebase write error after ${elapsed}min.`);
    process.exit(4);
  }

  const allFetched   = results.every(r => r.failReason?.includes('fetch') || r.failReason?.includes('download') || r.failReason?.includes('blocked'));
  const allFailed    = failed > 0 && failed === chains.length;

  if (allFailed && allFetched) {
    await sendAlert(config.slackWebhook, `All chains unreachable (exit 5). IP may be blocked.`);
    process.exit(5);
  }

  if (allFailed) {
    await sendAlert(config.slackWebhook, `All ${failed} chains failed (exit 1). Elapsed: ${elapsed}min`);
    process.exit(1);
  }

  if (failed > 0) {
    await sendAlert(config.slackWebhook, `${failed}/${chains.length} chains failed. ${succeeded} ok.`);
  }

  logger.ok(`Worker completed in ${elapsed} minutes`);
  process.exit(0);
}

main().catch(err => {
  logger.fail('Unhandled fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});

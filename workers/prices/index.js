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
         resolveAllPriceUrls, resolveStoreMetaUrls } from './fetchPrices.js';
import { parseXMLStream }                    from './parseXml.js';
import { safeKey }                           from './normalizeProduct.js';
import { initFirebase, BatchWriter, getDB,
         getPriceLastSync, sendAlert }       from './firebaseWriter.js';
import { logger }                            from './logger.js';

// ── STORE METADATA SYNC ──────────────────────────────────────────────────────
// Downloads Stores.gz files, parses lat/lng + address, writes to
// Firebase stores/{chainId}_{storeId}.  Non-blocking: failure here does NOT
// abort the price sync — it just means radius filtering will fall back to
// include-all until the next run that finds store files.
//
// Usage:
//   node index.js shufersal --stores-only    (DRY_RUN or live)
//   Called automatically after a successful price sync.
async function syncChainStores(chain, writer, config) {
  const label  = `[${chain.name}] [stores]`;
  const result = { count: 0, withCoords: 0, withoutCoords: 0, failed: false, failReason: null };

  logger.info(`${label} Starting store metadata sync`, { dryRun: config.dryRun });

  // Step 1: Discover Stores.gz files in index (independent of price scan)
  let storeByStore;
  try {
    storeByStore = await resolveStoreMetaUrls(chain);
  } catch (e) {
    result.failed = true;
    result.failReason = `Store discovery failed: ${e.message}`;
    logger.warn(`${label} Discovery failed`, { error: e.message });
    return result;
  }

  if (storeByStore.size === 0) {
    logger.warn(`${label} No Stores.gz files found in index (tried catID 5,0-4,6-9)`);
    logger.warn(`${label} → stores/{key} not populated → city/radius filter has no store metadata`);
    result.failed    = true;
    result.failReason = 'No Stores.gz files found';
    return result;
  }

  logger.info(`${label} Found ${storeByStore.size} store file(s) — downloading`);

  const db = getDB();
  const _report       = {};
  let   _total        = 0;
  let   _withCoords   = 0;
  let   _withoutCoords = 0;

  // Step 2: Download + parse each Stores.gz file
  for (const [storeFileId, url] of storeByStore) {
    try {
      const stream = await downloadToStream(
        url,
        `${chain.name}-stores-${storeFileId}`,
        config.worker.downloadTimeout,
        config.worker.downloadRetries,
      );

      await parseXMLStream(
        stream,
        null, // no product callback — store-only parse
        async (store) => {
          _total++;
          if (store.hasCoords) _withCoords++; else _withoutCoords++;
          _report[store.storeId] = {
            storeName: store.storeName,
            city:      store.city,
            hasCoords: store.hasCoords,
            lat:       store.latitude,
            lng:       store.longitude,
          };

          if (!config.dryRun) {
            const storeKey = safeKey(`${chain.id}_${store.storeId}`);
            await writer.queue(`stores/${storeKey}`, {
              chainId:      chain.chainId,
              chainName:    chain.name,
              subChainId:   store.subChainId   || '',
              subChainName: store.subChainName || '',
              storeId:      store.storeId,
              storeName:    store.storeName,
              address:      store.address,
              city:         store.city,
              zipCode:      store.zipCode,
              latitude:     store.latitude,
              longitude:    store.longitude,
              hasCoords:    store.hasCoords,
              active:       true,
              updatedAt:    new Date().toISOString(),
              source:       'official',
            });
            // storeCoords/{storeKey} = { lat, lng, city } — lightweight index (~28 KB total)
            // read by basket-compare.js and prices.js to avoid loading the full stores node.
            if (store.hasCoords) {
              await writer.queue(`storeCoords/${storeKey}`, {
                lat:  store.latitude,
                lng:  store.longitude,
                city: store.city || '',
              });
            }
          }
        },
        { chainId: chain.chainId, chainName: chain.name },
      );
      await writer.flush();
      logger.ok(`${label} Parsed store file ${storeFileId}`, { entries: _total });
    } catch (e) {
      logger.warn(`${label} Store file ${storeFileId} failed`, { error: e.message });
    }
  }

  // Step 3: Validation report
  logger.info(`${label} ── STORE VALIDATION REPORT ──`);
  logger.info(`${label}   Total stores found  : ${_total}`);
  logger.info(`${label}   With coordinates    : ${_withCoords}`);
  logger.info(`${label}   Without coordinates : ${_withoutCoords}`);
  const sample = Object.entries(_report).slice(0, 8);
  for (const [sid, s] of sample) {
    const coord = s.hasCoords ? `${s.lat?.toFixed(4)}, ${s.lng?.toFixed(4)}` : 'NO COORDS';
    logger.info(`${label}   store ${sid}: ${s.storeName} (${s.city}) [${coord}]`);
  }

  // Step 4: Gate — warn but don't fail on missing coords
  if (_total === 0) {
    logger.warn(`${label} No stores parsed`);
    result.failed    = true;
    result.failReason = 'Parsed 0 stores from files';
    return result;
  }
  if (_withCoords === 0) {
    logger.warn(`${label} ⚠ No stores have lat/lng — nearby filtering will show all results until coords arrive`);
  } else {
    logger.ok(`${label} STORE VALIDATION PASSED`, {
      total: _total, withCoords: _withCoords, withoutCoords: _withoutCoords,
    });
  }

  if (config.dryRun) {
    logger.info(`${label} DRY-RUN COMPLETE — store data NOT written to Firebase`);
    return result;
  }

  result.count        = _total;
  result.withCoords   = _withCoords;
  result.withoutCoords = _withoutCoords;
  return result;
}

// ── LEGACY KEY CLEANUP ────────────────────────────────────────────────────────
// When storeId normalisation changed ("034" → "34"), Firebase accumulated
// orphaned keys.  This finds them via the cheap stores/ index, then batch-
// deletes matching price entries for every barcode written in this sync run.
// Safe to run on every sync — no-ops instantly if no legacy keys exist.
async function cleanupLegacyStoreKeys(db, chainId, syncedStoreIds, syncedBarcodes, dryRun) {
  // Enumerate padded-zero variants that may have been written by old code
  const candidates = new Set();
  for (const storeId of syncedStoreIds) {
    const numId = parseInt(storeId, 10);
    if (isNaN(numId)) continue;
    for (const padLen of [2, 3, 4]) {
      const paddedSid = String(numId).padStart(padLen, '0');
      if (paddedSid === storeId) continue;         // same format → skip
      candidates.add(safeKey(`${chainId}_${paddedSid}`));
    }
  }
  if (candidates.size === 0) return { deleted: 0, legacyKeys: [] };

  // Verify which candidates actually exist in stores/ (avoids scanning all prices)
  const legacyKeys = [];
  for (const oldKey of candidates) {
    const snap = await db.ref(`stores/${oldKey}`).get();
    if (snap.exists()) legacyKeys.push(oldKey);
  }
  if (legacyKeys.length === 0) {
    logger.info('[cleanup] No legacy store keys found in Firebase — skipping');
    return { deleted: 0, legacyKeys: [] };
  }
  logger.info('[cleanup] Legacy store keys confirmed — will remove price entries', { keys: legacyKeys, barcodes: syncedBarcodes.size, dryRun });

  // Batch-delete prices/{barcode}/{oldKey} for every barcode written this run
  const BATCH_LIMIT = 400;
  let batch = {}, totalDeleted = 0;

  const flushBatch = async () => {
    const n = Object.keys(batch).length;
    if (n === 0) return;
    if (!dryRun) await db.ref('/').update(batch);
    totalDeleted += n;
    batch = {};
  };

  for (const barcode of syncedBarcodes) {
    for (const oldKey of legacyKeys) {
      batch[`prices/${barcode}/${oldKey}`] = null;
      if (Object.keys(batch).length >= BATCH_LIMIT) await flushBatch();
    }
  }
  await flushBatch();

  // Remove the orphaned stores/ entries
  for (const oldKey of legacyKeys) {
    if (!dryRun) {
      await db.ref(`stores/${oldKey}`).remove();
      logger.info(`[cleanup] Removed stores/${oldKey}`);
    } else {
      logger.info(`[cleanup] [dry-run] Would remove stores/${oldKey}`);
    }
  }

  logger.info('[cleanup] Legacy cleanup complete', {
    priceEntries: dryRun ? `${totalDeleted} would-be-deleted` : `${totalDeleted} deleted`,
    storeKeysRemoved: legacyKeys.length,
    dryRun,
  });
  return { deleted: totalDeleted, legacyKeys };
}

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

  // ── Stats for validation report (collected in both dry-run and live mode) ──
  const _perStore          = {}; // storeId → { count, sampleBarcode, fileType }
  const _uniqueBarcodes    = new Set();
  let   _totalRows         = 0;
  let   _invalidRows       = 0;   // rows missing barcode | price | storeId
  let   _updateFallbacks   = 0;   // stores served by PriceUpdate instead of PriceFull

  // ── Sync each store's price file ──
  for (const [rawStoreId, url] of priceByStore) {
    // Strip leading zeros so price keys match the stores sync key format.
    // Filename gives "034"; XML / stores sync gives "34" — normalise to "34".
    const storeId = String(parseInt(rawStoreId, 10) || rawStoreId);

    const urlPath  = url.split('?')[0];
    const isPriceFull   = urlPath.includes('/PriceFull');
    const isPriceUpdate = urlPath.includes('/PriceUpdate');
    const fileType = isPriceFull ? 'PriceFull' : isPriceUpdate ? 'PriceUpdate(!)' : 'Price';
    if (isPriceUpdate) _updateFallbacks++;

    logger.info(`${label} Syncing store ${storeId} [${fileType}]`, { url: urlPath });
    try {
      const stream = await downloadToStream(
        url,
        `${chain.name}-${storeId}`,
        config.worker.downloadTimeout,
        config.worker.downloadRetries,
      );

      let storeNameSeen = '';
      if (!_perStore[storeId]) _perStore[storeId] = { count: 0, sampleBarcode: null, fileType };

      const { count, skipped, errors } = await parseXMLStream(
        stream,
        async (product) => {
          if (!storeNameSeen && product.storeName) storeNameSeen = product.storeName;
          // Also strip leading zeros from product.storeId if the XML provides one
          const sidRaw   = product.storeId || storeId;
          const sid      = String(parseInt(sidRaw, 10) || sidRaw);
          const storeKey = safeKey(`${chain.id}_${sid}`);
          const row = {
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
          };
          await writer.queue(`prices/${product.barcode}/${storeKey}`, row);

          // ── Stat collection ──
          _uniqueBarcodes.add(product.barcode);
          _totalRows++;
          _perStore[storeId].count++;
          if (!_perStore[storeId].sampleBarcode) _perStore[storeId].sampleBarcode = product.barcode;
          if (!row.barcode || !row.price || !row.storeId || row.source !== 'official') _invalidRows++;
        },
        null,
        { ...chainMeta, storeId },
      );
      await writer.flush();

      result.count   += count;
      result.skipped += skipped;
      result.errors  += errors;
      storeIdsSynced.push(storeId);

      // Write basic store metadata placeholder (no lat/lng from Price files).
      // storeId already has leading zeros stripped — matches the stores sync key.
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

  // ── Validation report (printed in both dry-run and live mode) ──────────────
  logger.info(`${label} ── VALIDATION REPORT ──`);
  for (const [sid, s] of Object.entries(_perStore)) {
    logger.info(`${label}   store ${sid} [${s.fileType || '?'}]: ${s.count} prices | sample barcode: ${s.sampleBarcode || 'NONE'}`);
  }
  logger.info(`${label}   Unique barcodes : ${_uniqueBarcodes.size}`);
  logger.info(`${label}   Total price rows: ${_totalRows}`);
  logger.info(`${label}   Invalid rows    : ${_invalidRows}`);
  if (_updateFallbacks > 0) {
    logger.warn(`${label} ⚠ ${_updateFallbacks} store(s) used PriceUpdate fallback — catalog is incomplete for those stores`);
    logger.warn(`${label}   Expected: PriceFull files with 5,000+ items/store; got ~40 items/store from PriceUpdate`);
  }

  // ── Validation gate ──────────────────────────────────────────────────────────
  // Real write is only safe when all criteria pass.
  // In dry-run: failing here sets result.failed → exit code 1.
  // In live mode: failing here aborts after prices are written but before
  //   syncStatus is committed (next run will re-sync from scratch).
  //
  // Thresholds (proportional to stores synced — we deliberately cap at maxStoresToSync):
  //   stores — at least 1 successful store (not 3, since we cap)
  //   rows   — at least 30 items per store on average, minimum 50 total
  //            PriceFull:  5,000+/store → easily passes
  //            PriceUpdate:  ~40/store  → 5 stores × 30 = 150; 204 passes
  const _minStores = 1;
  const _minRows   = Math.max(50, storeIdsSynced.length * 30);

  const _issues = [];
  if (storeIdsSynced.length < _minStores)
    _issues.push(`No stores synced`);
  if (_totalRows < _minRows)
    _issues.push(`Only ${_totalRows} price rows (need >= ${_minRows} for ${storeIdsSynced.length} store(s))`);
  if (_invalidRows > 0)
    _issues.push(`${_invalidRows} row(s) missing barcode | price | storeId`);
  const _emptyStoreIds = Object.keys(_perStore).filter(s => !s || s === '0');
  if (_emptyStoreIds.length > 0)
    _issues.push(`Empty/zero storeId detected: ${_emptyStoreIds.join(', ')}`);

  if (_issues.length > 0) {
    logger.fail(`${label} VALIDATION FAILED — ${config.dryRun ? 'do NOT proceed to real write' : 'aborting sync status write'}`, { issues: _issues });
    result.failed    = true;
    result.failReason = `Validation: ${_issues.join('; ')}`;
    return result;
  }

  logger.ok(`${label} VALIDATION PASSED`, {
    stores: storeIdsSynced.length, uniqueBarcodes: _uniqueBarcodes.size, totalRows: _totalRows,
    dryRun: config.dryRun,
  });

  // ── Clean up legacy padded-zero store keys ──────────────────────────────────
  // Runs in both dry-run (logging only) and live mode (actual deletes).
  // When storeId normalisation changed ("034" → "34"), old Firebase keys like
  // shufersal_034 became orphaned.  We detect them by checking stores/{oldKey},
  // then batch-delete matching price entries for all barcodes from this run.
  try {
    const cleanupRes = await cleanupLegacyStoreKeys(
      db, chain.id, storeIdsSynced, _uniqueBarcodes, config.dryRun,
    );
    if (cleanupRes.deleted > 0 || (config.dryRun && cleanupRes.legacyKeys.length > 0)) {
      logger.ok(`${label} Legacy key cleanup`, {
        priceEntriesDeleted: cleanupRes.deleted,
        storeKeysRemoved:    cleanupRes.legacyKeys,
        dryRun:              config.dryRun,
      });
    }
  } catch (e) {
    logger.warn(`${label} Legacy key cleanup failed (non-blocking)`, { error: e.message });
  }

  if (config.dryRun) {
    logger.info(`${label} DRY-RUN COMPLETE — safe to proceed with real write`);
    return result;
  }

  // ── Sync store metadata (non-blocking — failure does NOT abort price sync) ──
  if (!config.storesOnly) {
    try {
      const storeRes = await syncChainStores(chain, writer, config);
      if (!storeRes.failed) {
        logger.ok(`${label} Store metadata synced`, {
          total: storeRes.count, withCoords: storeRes.withCoords,
        });
      }
    } catch (e) {
      logger.warn(`${label} Store sync threw (non-blocking)`, { error: e.message });
    }
  }

  // ── Write sync status (only on live run after validation passes) ──
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
    items:  result.count,
    stores: storeIdsSynced.length,
    errors: result.errors,
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
  const chainArg   = process.argv.slice(2).find(a => !a.startsWith('--'));
  const storesOnly = process.argv.includes('--stores-only');
  let chains = CHAINS.filter(c => c.enabled);

  if (chainArg) {
    chains = chains.filter(c => c.id === chainArg || c.name === chainArg);
    if (!chains.length) {
      logger.fail(`Unknown chain: ${chainArg}`,
        { available: CHAINS.map(c => c.id).join(', ') });
      process.exit(2);
    }
  }

  if (storesOnly) {
    logger.info('--stores-only mode: skipping price sync, running store metadata only');
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

  // Attach storesOnly flag to config so syncChain* functions can read it
  config.storesOnly = storesOnly;

  // ── Step E: Sync chains (sequential) ──
  const results = [];
  let firebaseWriteError = false;

  for (const chain of chains) {
    try {
      let result;
      if (storesOnly) {
        // --stores-only: skip price sync, run store metadata only
        result = await syncChainStores(chain, writer, config);
        result = { chainId: chain.id, chainName: chain.name, count: result.count || 0,
                   failed: result.failed, failReason: result.failReason };
      } else {
        result = await syncChain(chain, writer, config);
      }
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

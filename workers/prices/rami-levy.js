// workers/prices/rami-levy.js
// Rami Levy price sync — Phase 3 importer.
// Called from index.js via chain.syncModule when chain.id === 'rami-levy'.

import { createReadStream, createWriteStream, statSync } from 'fs';
import { unlink }   from 'fs/promises';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { tmpdir }   from 'os';
import { join }     from 'path';
import https        from 'https';
import { execFile } from 'child_process';

const SSL_AGENT = new https.Agent({ rejectUnauthorized: false });

import { discoverPriceFullFiles } from './rami-levy-discovery.js';
import { parseXMLStream }         from './parseXml.js';
import { safeKey }                from './normalizeProduct.js';
import { getDB }                  from './firebaseWriter.js';
import { logger }                 from './logger.js';

const DOWNLOAD_TIMEOUT = 120_000;

async function downloadFTP(url, label, timeoutMs) {
  const filename = url.split('/').pop();
  const tmpFile = join(tmpdir(), 'rl-' + Date.now() + '.tmp');
  await new Promise((resolve, reject) => {
    execFile('curl', ['-sk', '--max-time', String(Math.ceil(timeoutMs/1000)),
      url, '--user', 'RamiLevi:', '-o', tmpFile],
      (err) => err ? reject(new Error('FTP failed: ' + err.message)) : resolve());
  });
  const size = statSync(tmpFile).size;
  if (size < 100) throw new Error('File too small (' + size + ' bytes)');
  logger.info('[rami-levy] Downloaded ' + label, { bytes: size });
  const fileStream = createReadStream(tmpFile);
  const isGz = /\.gz$/i.test(filename);
  const outStream = isGz ? fileStream.pipe(createGunzip()) : fileStream;
  const cleanup = () => unlink(tmpFile).catch(() => {});
  outStream.on('end', cleanup); outStream.on('close', cleanup); outStream.on('error', cleanup);
  return outStream;
}


export async function sync(chain, writer, config) {
  const label = `[${chain.name}]`;
  const result = {
    chainId: chain.id, chainName: chain.name,
    count: 0, storeCount: 0, skipped: 0, errors: 0,
    failed: false, alreadySynced: false, failReason: null,
  };

  logger.info(`${label} Starting Rami Levy sync`, { dryRun: config.dryRun });

  let byStore, metrics;
  try {
    ({ byStore, metrics } = await discoverPriceFullFiles(null, chain.chainId, { retries: 3 }));
  } catch (err) {
    result.failed = true; result.failReason = `Discovery failed: ${err.message}`;
    logger.fail(`${label} File discovery failed`, { error: err.message });
    return result;
  }

  if (byStore.size === 0) {
    result.failed = true; result.failReason = 'No PriceFull files found in Cerberus listing';
    logger.fail(`${label} No PriceFull files found`);
    return result;
  }

  logger.info(`${label} Found ${byStore.size} stores with PriceFull files`, metrics);

  const db        = getDB();
  const chainMeta = { chainId: chain.chainId, chainName: chain.name };
  const _perStore       = {};
  const _uniqueBarcodes = new Set();
  let   _totalRows      = 0;
  let   _invalidRows    = 0;
  const storeIdsSynced  = [];

  for (const [rawStoreId, fileInfo] of byStore) {
    const storeId    = String(parseInt(rawStoreId, 10) || rawStoreId);
    const storeLabel = `${label} store ${storeId}`;
    logger.info(`${storeLabel} Syncing`, { file: fileInfo.filename });

    try {
      const stream = await downloadFTP(
        fileInfo.url, `rami-levy-${storeId}`,
        config.worker?.downloadTimeout || DOWNLOAD_TIMEOUT,
      );

      if (!_perStore[storeId]) _perStore[storeId] = { count: 0, sampleBarcode: null };
      let storeNameSeen = '';

      const { count, skipped, errors } = await parseXMLStream(
        stream,
        async (product) => {
          if (!storeNameSeen && product.storeName) storeNameSeen = product.storeName;
          const sid      = product.storeId ? String(parseInt(product.storeId, 10) || product.storeId) : storeId;
          const storeKey = safeKey(`${chain.id}_${sid}`);
          const row = {
            barcode: product.barcode, name: product.name, price: product.price,
            chainId: chain.id, chainName: chain.name, storeId: sid,
            storeName: product.storeName || '', unit: product.unit || '',
            quantity: product.quantity || '', brand: product.brand || '',
            updatedAt: product.updatedAt, currency: 'ILS', source: 'official',
            syncedAt: Date.now(), lastUpdated: new Date().toISOString(),
          };
          await writer.queue(`prices/${product.barcode}/${storeKey}`, row);
          _uniqueBarcodes.add(product.barcode);
          _totalRows++;
          _perStore[storeId].count++;
          if (!_perStore[storeId].sampleBarcode) _perStore[storeId].sampleBarcode = product.barcode;
          if (!row.barcode || !row.price || !row.storeId) _invalidRows++;
        },
        null,
        { ...chainMeta, storeId },
      );

      await writer.flush();
      result.count   += count;
      result.skipped += skipped;
      result.errors  += errors;
      storeIdsSynced.push(storeId);

      if (!config.dryRun) {
        const storeKey = safeKey(`${chain.id}_${storeId}`);
        await db.ref(`stores/${storeKey}`).update({
          chainId: chain.chainId, chainName: chain.name,
          storeId, storeName: storeNameSeen || '', updatedAt: new Date().toISOString(),
        });
        result.storeCount++;
      }

      logger.ok(`${storeLabel} Done`, { items: count, skipped, errors });
    } catch (err) {
      logger.warn(`${storeLabel} Failed (isolated)`, { error: err.message });
      result.errors++;
    }
  }

  logger.info(`${label} ── VALIDATION REPORT ──`);
  for (const [sid, s] of Object.entries(_perStore)) {
    logger.info(`${label}   store ${sid}: ${s.count} prices | sample: ${s.sampleBarcode || 'NONE'}`);
  }
  logger.info(`${label}   Unique barcodes : ${_uniqueBarcodes.size}`);
  logger.info(`${label}   Total price rows: ${_totalRows}`);
  logger.info(`${label}   Invalid rows    : ${_invalidRows}`);
  logger.info(`${label}   Stores synced   : ${storeIdsSynced.length} / ${byStore.size}`);

  const _minRows = Math.max(50, storeIdsSynced.length * 30);
  const issues   = [];
  if (storeIdsSynced.length === 0) issues.push('No stores synced');
  if (_totalRows < _minRows)       issues.push(`Only ${_totalRows} rows (need >= ${_minRows})`);
  if (_invalidRows > 0)            issues.push(`${_invalidRows} rows missing barcode/price/storeId`);

  if (issues.length > 0) {
    logger.fail(`${label} VALIDATION FAILED`, { issues });
    result.failed = true; result.failReason = `Validation: ${issues.join('; ')}`;
    return result;
  }

  logger.ok(`${label} VALIDATION PASSED`, {
    stores: storeIdsSynced.length, uniqueBarcodes: _uniqueBarcodes.size,
    totalRows: _totalRows, dryRun: config.dryRun,
  });

  if (config.dryRun) {
    logger.info(`${label} DRY-RUN COMPLETE — safe to proceed with real write`);
    return result;
  }

  const now = new Date();
  try {
    await writer.writeSyncStatus(chain.id, {
      chainId: chain.id, chainName: chain.name,
      lastSyncDate: now.toISOString().split('T')[0],
      lastSuccessAt: now.toISOString(),
      itemsProcessed: result.count, storesProcessed: result.storeCount,
      storeIds: storeIdsSynced, errors: result.errors,
    });
  } catch (_) {}

  logger.ok(`${label} Sync complete`, { items: result.count, stores: storeIdsSynced.length, errors: result.errors });
  return result;
}

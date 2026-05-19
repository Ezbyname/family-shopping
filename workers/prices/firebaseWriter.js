// workers/prices/firebaseWriter.js — v2.0.0 (hardened)
// Firebase Admin SDK writer.
// Exit code 4 = Firebase write failure.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase }                   from 'firebase-admin/database';
import { logger }                        from './logger.js';
import { safeKey }                       from './normalizeProduct.js';

const BATCH_SIZE        = 400;  // safe under Firebase 500-path limit
const WRITE_RETRY_MAX   = 3;
const WRITE_RETRY_DELAY = 1000; // ms, multiplied by attempt number

let _db = null;

export function initFirebase(config) {
  if (getApps().length > 0) {
    _db = getDatabase();
    logger.info('Firebase Admin reusing existing app');
    return _db;
  }
  try {
    initializeApp({
      credential:  cert({
        projectId:   config.projectId,
        clientEmail: config.clientEmail,
        privateKey:  config.privateKey,
      }),
      databaseURL: config.databaseURL,
    });
    _db = getDatabase();
    logger.ok('Firebase Admin initialized', { projectId: config.projectId });
    return _db;
  } catch (err) {
    logger.fail('Firebase init failed', { error: err.message });
    throw err;
  }
}

export function getDB() {
  if (!_db) throw new Error('Firebase not initialized — call initFirebase() first');
  return _db;
}

// ── BATCH WRITER ──
export class BatchWriter {
  constructor(db, { batchSize = BATCH_SIZE, dryRun = false } = {}) {
    this.db           = db;
    this.batchSize    = batchSize;
    this.dryRun       = dryRun;
    this._batch       = {};
    this._count       = 0;
    this.totalWritten = 0;
    this.totalDryRun  = 0;
    this.errors       = 0;
  }

  async queue(path, value) {
    this._batch[path] = value;
    this._count++;
    if (this._count >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this._count === 0) return;
    const n     = this._count;
    const batch = this._batch;
    this._batch = {};
    this._count = 0;

    if (this.dryRun) {
      this.totalDryRun += n;
      logger.debug('[dry-run] Would write batch', { count: n, totalDryRun: this.totalDryRun });
      return;
    }

    try {
      await this._writeWithRetry(batch, n);
      this.totalWritten += n;
    } catch (err) {
      this.errors += n;
      logger.fail('Firebase batch write failed', { count: n, error: err.message });
      // Re-throw so caller can catch and use exit code 4
      throw Object.assign(err, { exitCode: 4 });
    }
  }

  async _writeWithRetry(batch, count) {
    let lastErr;
    for (let attempt = 1; attempt <= WRITE_RETRY_MAX; attempt++) {
      try {
        await this.db.ref('/').update(batch);
        logger.debug('Batch written', { count, attempt });
        return;
      } catch (err) {
        lastErr = err;
        logger.warn(`Firebase write attempt ${attempt}/${WRITE_RETRY_MAX} failed`,
          { error: err.message, count });
        if (attempt < WRITE_RETRY_MAX) {
          await new Promise(r => setTimeout(r, WRITE_RETRY_DELAY * attempt));
        }
      }
    }
    throw lastErr;
  }

  async writeSyncStatus(chainId, data) {
    if (this.dryRun) {
      logger.debug('[dry-run] Would write syncStatus', { chainId });
      return;
    }
    await this.db.ref(`syncStatus/${safeKey(chainId)}`).set(data);
  }

  async writeSyncSummary(data) {
    if (this.dryRun) {
      logger.debug('[dry-run] Would write syncSummary');
      return;
    }
    await this.db.ref('syncSummary').set(data);
  }

  stats() {
    return {
      totalWritten: this.totalWritten,
      totalDryRun:  this.totalDryRun,
      errors:       this.errors,
      dryRun:       this.dryRun,
    };
  }
}

// ── READ LAST SYNC STATUS ──
export async function getPriceLastSync(db, chainId) {
  try {
    const snap = await db.ref(`syncStatus/${safeKey(chainId)}`).get();
    return snap.exists() ? snap.val() : null;
  } catch (err) {
    logger.warn('Failed to read syncStatus', { chainId, error: err.message });
    return null;
  }
}

// ── SLACK ALERT (optional) ──
export async function sendAlert(webhookUrl, message) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: `🚨 IsraeliPriceWorker: ${message}` }),
      signal:  AbortSignal.timeout(8_000),
    });
    logger.info('Slack alert sent');
  } catch (err) {
    logger.warn('Slack alert failed', { error: err.message });
  }
}

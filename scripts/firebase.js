// scripts/firebase.js — v3.0.0
// Firebase Admin for the price-sync worker (sync init + BatchWriter)
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase }                   from 'firebase-admin/database';
import { logger, safeKey }               from './utils.js';

let _db = null;

/** Call once at startup — throws if credentials are missing or malformed. */
export function initFirebase() {
  if (_db) return;

  const url = process.env.FIREBASE_DATABASE_URL;
  if (!url) throw new Error('FIREBASE_DATABASE_URL not set');

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Single JSON blob (workers/prices style)
    credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  } else {
    // Individual env vars (scripts/.env style)
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
      throw new Error(
        'Firebase credentials missing. Need FIREBASE_SERVICE_ACCOUNT (JSON blob) ' +
        'or all three of FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY'
      );
    }
    credential = cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    });
  }

  if (!getApps().length) {
    initializeApp({ credential, databaseURL: url });
  }
  _db = getDatabase();
  logger.info('[firebase] initialized');
}

/** Synchronous — must call initFirebase() first. */
export function getDB() {
  if (!_db) throw new Error('Firebase not initialized — call initFirebase() first');
  return _db;
}

// ── BatchWriter ────────────────────────────────────────────────────────────────
// Accumulates writes and flushes as multi-path updates (max 400 per batch,
// well below Firebase's 500-node limit).

const BATCH_MAX = 400;

export class BatchWriter {
  constructor(db, batchSize = BATCH_MAX) {
    this._db    = db;
    this._max   = batchSize;
    this._queue = {};
  }

  async queue(path, data) {
    this._queue[path] = data;
    if (Object.keys(this._queue).length >= this._max) await this.flush();
  }

  async flush() {
    const keys = Object.keys(this._queue);
    if (!keys.length) return;
    await this._db.ref('/').update(this._queue);
    this._queue = {};
  }

  async writeSyncStatus(chainId, data) {
    await this._db.ref(`syncStatus/${safeKey(chainId)}`).update(data);
  }

  async writeSyncSummary(data) {
    await this._db.ref('syncSummary').update(data);
  }
}

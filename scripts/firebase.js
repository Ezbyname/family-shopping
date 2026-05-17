// scripts/firebase.js — v2.0.0
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { logger, safeKey } from './utils.js';

const BATCH_SIZE = 400;
let _db = null;

export function initFirebase() {
  if (getApps().length) { _db = getDatabase(); return _db; }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT missing');
  const sa = JSON.parse(raw);
  const url = process.env.FIREBASE_DATABASE_URL;
  if (!url) throw new Error('FIREBASE_DATABASE_URL missing');
  initializeApp({ credential: cert(sa), databaseURL: url });
  _db = getDatabase();
  logger.info('Firebase initialized');
  return _db;
}

export const getDB = () => { if (!_db) throw new Error('Firebase not initialized'); return _db; };

export class BatchWriter {
  constructor(db) {
    this.db = db;
    this._b = {}; this._n = 0;
    this.totalWritten = 0;
  }
  async queue(path, value) {
    this._b[path] = value; this._n++;
    if (this._n >= BATCH_SIZE) await this.flush();
  }
  async flush() {
    if (!this._n) return;
    const n = this._n;
    await this.db.ref('/').update(this._b);
    this.totalWritten += n;
    logger.info(`  flushed ${n} (total ${this.totalWritten})`);
    this._b = {}; this._n = 0;
  }
  async writeSyncStatus(chainId, data) {
    await this.db.ref(`syncStatus/${safeKey(chainId)}`).set(data);
  }
  async writeSyncSummary(data) {
    await this.db.ref('syncSummary').set(data);
  }
}

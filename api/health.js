// api/health.js — v1.0.0
// GET /api/health  — lightweight Firebase connectivity probe
// Returns: { ok, timestamp, timings: { initMs, pingMs, totalMs } }

import { getDB, setCors } from './_firebase.js';

const INIT_TIMEOUT_MS = 8_000;
const PING_TIMEOUT_MS = 5_000;

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(Object.assign(new Error(`timeout:${label}`), { isTimeout: true })), ms)
    ),
  ]);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const t0 = Date.now();
  const timings = { initMs: null, pingMs: null, totalMs: null };

  // ── 1. Firebase init ─────────────────────────────────────────────────────────
  let db;
  try {
    const tInit = Date.now();
    db = await withTimeout(getDB(), INIT_TIMEOUT_MS, 'init');
    timings.initMs = Date.now() - tInit;
  } catch (e) {
    timings.totalMs = Date.now() - t0;
    return res.status(503).json({
      ok: false,
      error: e.isTimeout ? 'Firebase init timed out' : `Firebase init failed: ${e.message}`,
      timestamp: new Date().toISOString(),
      timings,
    });
  }

  if (!db) {
    timings.totalMs = Date.now() - t0;
    return res.status(503).json({
      ok: false,
      error: 'Firebase not initialized (missing env vars)',
      timestamp: new Date().toISOString(),
      timings,
    });
  }

  // ── 2. Firebase ping — read syncSummary (tiny node, always exists) ───────────
  let pingOk = false;
  let pingData = null;
  try {
    const tPing = Date.now();
    const snap = await withTimeout(db.ref('syncSummary').get(), PING_TIMEOUT_MS, 'ping');
    timings.pingMs = Date.now() - tPing;
    pingOk = true;
    if (snap?.exists()) {
      const d = snap.val();
      pingData = { lastSyncDate: d.lastSyncDate, totalProducts: d.totalProducts };
    }
  } catch (e) {
    timings.pingMs = Date.now() - t0 - (timings.initMs || 0);
    timings.totalMs = Date.now() - t0;
    return res.status(503).json({
      ok: false,
      error: e.isTimeout ? 'Firebase ping timed out' : `Firebase read error: ${e.message}`,
      timestamp: new Date().toISOString(),
      timings,
    });
  }

  timings.totalMs = Date.now() - t0;
  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    timings,
    db: pingData,
  });
}

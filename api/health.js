// api/health.js — v1.1.0
// GET /api/health  — lightweight Firebase connectivity probe
// Returns: { ok, timestamp, timings: { initMs, pingMs, totalMs } }
//
// v1.1.0: reads via fetch() REST API (no Admin SDK WebSocket) — fast on Vercel

import { getDbUrl, getAdminToken, restGet, setCors } from './_firebase.js';

const INIT_TIMEOUT_MS = 8_000;
const PING_TIMEOUT_MS = 5_000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const t0 = Date.now();
  const timings = { initMs: null, pingMs: null, totalMs: null };

  // ── 1. Config check ───────────────────────────────────────────────────────
  const dbUrl = getDbUrl();
  if (!dbUrl) {
    timings.totalMs = Date.now() - t0;
    return res.status(503).json({
      ok: false,
      error: 'Firebase not initialized (missing FIREBASE_DATABASE_URL)',
      timestamp: new Date().toISOString(),
      timings,
    });
  }

  // ── 2. Admin token (measures cold-start OAuth2 fetch; ~0 ms warm) ─────────
  try {
    const tInit = Date.now();
    await Promise.race([
      getAdminToken(),
      new Promise((_, rej) =>
        setTimeout(() => rej(Object.assign(new Error('timeout:init'), { isTimeout: true })), INIT_TIMEOUT_MS)
      ),
    ]);
    timings.initMs = Date.now() - tInit;
  } catch (e) {
    timings.totalMs = Date.now() - t0;
    return res.status(503).json({
      ok: false,
      error: e.isTimeout ? 'Admin token fetch timed out' : `Token error: ${e.message}`,
      timestamp: new Date().toISOString(),
      timings,
    });
  }

  // ── 3. Firebase ping — read syncSummary via REST ──────────────────────────
  let pingData = null;
  try {
    const tPing = Date.now();
    const data  = await restGet(dbUrl, 'syncSummary', PING_TIMEOUT_MS);
    timings.pingMs = Date.now() - tPing;
    if (data !== null) {
      pingData = { lastSyncDate: data.lastSyncDate, totalProducts: data.totalProducts };
    }
  } catch (e) {
    timings.pingMs  = Date.now() - t0 - (timings.initMs || 0);
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

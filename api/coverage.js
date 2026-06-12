// api/coverage.js — v1.0.0
// GET /api/coverage — chain coverage diagnostics
// Returns syncSummary + per-chain syncStatus for the diagnostics panel

import { getDbUrl, getAdminToken, restGet, setCors } from './_firebase.js';

const TIMEOUT_MS = 6_000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const dbUrl = getDbUrl();
  if (!dbUrl) return res.status(503).json({ error: 'Firebase not configured' });

  try {
    await getAdminToken();
  } catch (e) {
    return res.status(503).json({ error: 'Auth failed' });
  }

  const [summary, chainStatus] = await Promise.all([
    restGet(dbUrl, 'syncSummary', TIMEOUT_MS).catch(() => null),
    restGet(dbUrl, 'syncStatus',  TIMEOUT_MS).catch(() => null),
  ]);

  const chains = chainStatus
    ? Object.entries(chainStatus).map(([id, v]) => ({
        id,
        name:         v.chainName  || id,
        lastSyncDate: v.lastSyncDate     || null,
        itemsProcessed: v.itemsProcessed ?? null,
        storesProcessed: v.storesProcessed ?? null,
        errors:       v.errors       ?? 0,
        ok:           !v.errors || v.errors === 0,
      }))
    : [];

  return res.status(200).json({
    lastSync:      summary?.lastSyncDate    || null,
    totalProducts: summary?.totalProducts   || null,
    chainsSucceeded: summary?.chainsSucceeded ?? null,
    chainsFailed:    summary?.chainsFailed    ?? null,
    chains,
    timestamp: new Date().toISOString(),
  });
}

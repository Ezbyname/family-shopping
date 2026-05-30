// api/store-details.js — v1.0
// GET /api/store-details?storeKey={chainId}_{storeId}
//
// Returns enriched store data for the Store Details Sheet.
// Reads: stores/{storeKey}  +  syncStatus/{chainId}
//
// Response shape:
//   { storeKey, chainId, storeId, chainName, storeName,
//     address, city, zipCode, latitude, longitude, hasCoords,
//     phone, hours, hoursSource, hoursConfidence,
//     lastSyncDate, itemsProcessed,
//     source: 'firebase' | 'not_found' }
//
// Phase-B enrichment contract:
//   - Phone / hours are null until a store-enrichment worker populates
//     stores/{storeKey}/enriched (via Google Places / Waze / Open Data)
//   - hoursConfidence: 'high' | 'medium' | 'low' | 'none'
//   - The sheet opens immediately with basic data; this endpoint is called
//     lazily after the sheet is visible (skeleton → real data)

import { getDB, setCors } from './_firebase.js';

const READ_TIMEOUT_MS = 5_000;

function withTimeout(promise, ms, label = '') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`timeout:${label}`), { isTimeout: true })), ms)
    ),
  ]);
}

// storeKey must be "{digits}_{digits}" — matches Firebase path segment format
const STORE_KEY_RE = /^\d{1,14}_\d{1,8}$/;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { storeKey } = req.query || {};

  if (!storeKey || !STORE_KEY_RE.test(String(storeKey))) {
    return res.status(400).json({
      error: 'Invalid storeKey — expected format: {chainId}_{storeId}',
    });
  }

  const key = String(storeKey);
  const [chainId, storeId] = key.split('_');

  let db;
  try {
    db = await withTimeout(getDB(), 8_000, 'init');
  } catch (e) {
    return res.status(504).json({ error: 'Firebase connection timed out', storeKey: key });
  }

  if (!db) {
    return res.status(503).json({ error: 'Firebase not initialized (missing env vars)', storeKey: key });
  }

  // Parallel reads: store record + chain sync status
  let storeSnap = null, syncSnap = null;
  try {
    [storeSnap, syncSnap] = await Promise.all([
      withTimeout(db.ref(`stores/${key}`).get(),           READ_TIMEOUT_MS, 'store'),
      withTimeout(db.ref(`syncStatus/${chainId}`).get(),   READ_TIMEOUT_MS, 'sync'),
    ]);
  } catch (e) {
    if (e.isTimeout) {
      return res.status(504).json({ error: 'Firebase read timed out', storeKey: key });
    }
    console.error('[store-details] read error:', e.message);
    return res.status(500).json({ error: 'Unexpected read error', storeKey: key });
  }

  if (!storeSnap?.exists()) {
    return res.status(404).json({
      storeKey: key, chainId, storeId,
      source: 'not_found',
      message: 'Store not found in database — it will appear after the next price sync',
    });
  }

  const store = storeSnap.val();
  const sync  = syncSnap?.exists() ? syncSnap.val() : null;

  // Pull enrichment fields if the store-enrichment worker has run
  const enriched = store.enriched || {};

  const response = {
    storeKey:    key,
    chainId:     store.chainId   || chainId,
    storeId:     store.storeId   || storeId,
    chainName:   store.chainName || '',
    storeName:   store.storeName || '',
    address:     store.address   || '',
    city:        store.city      || '',
    zipCode:     store.zipCode   || '',
    latitude:    store.latitude  ?? null,
    longitude:   store.longitude ?? null,
    hasCoords:   store.hasCoords ?? false,

    // Enrichment fields (null until store-enrichment worker populates)
    phone:           enriched.phone          ?? null,
    hours:           enriched.hours          ?? null,  // { mon: '08:00-22:00', … }
    hoursSource:     enriched.hoursSource    ?? null,  // 'google_places' | 'waze' | 'manual'
    hoursConfidence: enriched.hoursConfidence ?? 'none', // 'high'|'medium'|'low'|'none'
    enrichedAt:      enriched.enrichedAt     ?? null,

    // Sync metadata (useful for Availability Confidence badges)
    lastSyncDate:    sync?.lastSyncDate    ?? null,
    lastSuccessAt:   sync?.lastSuccessAt   ?? null,
    itemsProcessed:  sync?.itemsProcessed  ?? null,

    source: 'firebase',
  };

  // Cache aggressively — store data changes only on sync (≤2×/day)
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.status(200).json(response);
}

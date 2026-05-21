// api/admin-status.js
// GET /api/admin-status
// Returns latestPriceSanityStatus from Firebase, gated behind server-side
// admin role verification. Never exposes SANITY_ADMIN_TOKEN to frontend.
//
// Header:  Authorization: Bearer <firebase-id-token>
// Returns: { ok: true, status: {...} } | { ok: false, error: 'Access denied' }

import { getDB } from './_firebase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Never cache admin data
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ── Extract ID token ───────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ ok: false, error: 'Access denied' });

  try {
    // ── Verify Firebase ID token server-side ────────────────────────
    const { getAuth } = await import('firebase-admin/auth');
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'Access denied' });
    }

    const uid = decoded.uid;

    // ── Re-check admin role in Firebase DB ───────────────────────────
    const db = await getDB();
    if (!db) return res.status(503).json({ ok: false, error: 'Service unavailable' });

    const roleSnap = await db.ref(`users/${uid}/roles/admin`).once('value');
    if (roleSnap.val() !== true) {
      console.warn(`[admin-status] DENIED uid=${uid} — not admin`);
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    // ── Read latestPriceSanityStatus ──────────────────────────────────
    const statusSnap = await db.ref('latestPriceSanityStatus').once('value');
    const status = statusSnap.val();

    if (!status) {
      return res.status(404).json({ ok: false, error: 'No sanity status found' });
    }

    console.log(`[admin-status] served to uid=${uid} status=${status.status}`);
    return res.status(200).json({ ok: true, status });

  } catch (err) {
    console.error('[admin-status] unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'Access denied' });
  }
}

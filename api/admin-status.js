// api/admin-status.js
// GET /api/admin-status
// Returns latestPriceSanityStatus from Firebase, gated behind server-side
// admin role verification. latestPriceSanityStatus is never publicly readable.
//
// Header:  Authorization: Bearer <firebase-id-token>
// Returns: { ok: true, status: {...} } | { ok: false, error: 'Access denied' }

import { getDB, checkOrigin } from './_firebase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Never cache admin data
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ── CSRF: reject requests from disallowed browser origins ───────────
  if (!checkOrigin(req)) {
    console.warn(`[admin-status] CSRF_REJECTED origin=${req.headers['origin']}`);
    return res.status(403).json({ ok: false, error: 'Access denied' });
  }

  // ── Extract ID token ────────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ ok: false, error: 'Access denied' });

  try {
    // ── Initialize Firebase first — required before getAuth() ───────────
    // BUG FIX: getAuth() requires the Firebase app to be initialized.
    // getDB() handles initializeApp(); must be called before getAuth().
    const db = await getDB();
    if (!db) return res.status(503).json({ ok: false, error: 'Service unavailable' });

    // ── Verify Firebase ID token server-side ────────────────────────────
    const { getAuth } = await import('firebase-admin/auth');
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'Access denied' });
    }

    const uid = decoded.uid;

    // ── Re-check admin role directly in DB on every request ─────────────
    const roleSnap = await db.ref(`users/${uid}/roles/admin`).once('value');
    if (roleSnap.val() !== true) {
      console.warn(`[admin-status] DENIED uid=${uid}`);
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    // ── Read latestPriceSanityStatus ────────────────────────────────────
    const statusSnap = await db.ref('latestPriceSanityStatus').once('value');
    const status = statusSnap.val();

    if (!status) {
      return res.status(404).json({ ok: false, error: 'No sanity status found' });
    }

    console.log(`[admin-status] served uid=${uid} status=${status.status} label=${status.statusLabel}`);
    return res.status(200).json({
      ok: true,
      status,
      // Build metadata — populated by Vercel system env vars at deploy time
      meta: {
        deployedSha: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 7),
        deployedEnv: process.env.VERCEL_ENV || 'local',
      },
    });

  } catch (err) {
    console.error('[admin-status] unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'Access denied' });
  }
}

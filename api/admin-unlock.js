// api/admin-unlock.js
// POST /api/admin-unlock
// Validates: Firebase ID token + Firebase admin role + ADMIN_PIN env var.
// Never reveals which check failed — always returns generic "Access denied".
//
// Body:    { pin: string }
// Header:  Authorization: Bearer <firebase-id-token>
// Returns: { ok: true } | { ok: false, error: 'Access denied' }

import { getDB } from './_firebase.js';

const ADMIN_PIN = process.env.ADMIN_PIN;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ── Fail fast if PIN not configured ───────────────────────────────
  if (!ADMIN_PIN || ADMIN_PIN.length < 4) {
    console.error('[admin-unlock] ADMIN_PIN not configured');
    return res.status(503).json({ ok: false, error: 'Access denied' });
  }

  // ── Extract ID token from Authorization header ─────────────────────
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ ok: false, error: 'Access denied' });

  // ── Extract PIN from body ──────────────────────────────────────────
  let pin;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    pin = String(body?.pin ?? '');
  } catch {
    return res.status(400).json({ ok: false, error: 'Access denied' });
  }

  try {
    // ── Verify Firebase ID token server-side ────────────────────────
    const { getAuth } = await import('firebase-admin/auth');
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch {
      // Invalid/expired token — same generic error
      return res.status(401).json({ ok: false, error: 'Access denied' });
    }

    const uid = decoded.uid;

    // ── Re-check admin role in Firebase DB (prevent claims spoofing) ──
    const db = await getDB();
    if (!db) return res.status(503).json({ ok: false, error: 'Access denied' });

    const roleSnap = await db.ref(`users/${uid}/roles/admin`).once('value');
    const isAdmin = roleSnap.val() === true;

    // ── Constant-time PIN comparison (prevent timing attacks) ─────────
    const pinMatch = timingSafeEqual(pin, ADMIN_PIN);

    // ── Both checks must pass — never reveal which failed ────────────
    if (!isAdmin || !pinMatch) {
      // Log for server-side audit (never sent to client)
      console.warn(`[admin-unlock] DENIED uid=${uid} role=${isAdmin} pin=${pinMatch}`);
      return res.status(401).json({ ok: false, error: 'Access denied' });
    }

    console.log(`[admin-unlock] GRANTED uid=${uid}`);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[admin-unlock] unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'Access denied' });
  }
}

// Prevent timing attacks when comparing PINs
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still iterate to avoid length leak — dummy compare
    let dummy = 0;
    for (let i = 0; i < b.length; i++) dummy |= b.charCodeAt(i);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

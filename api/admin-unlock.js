// api/admin-unlock.js
// POST /api/admin-unlock
// Validates: Firebase ID token + Firebase admin role + ADMIN_PIN env var.
// Never reveals which check failed — always returns generic "Access denied".
//
// Body:    { pin: string }
// Header:  Authorization: Bearer <firebase-id-token>
// Returns: { ok: true } | { ok: false, error: 'Access denied' }

import { timingSafeEqual } from 'crypto';
import { getDB } from './_firebase.js';

const ADMIN_PIN = process.env.ADMIN_PIN;

// Compare strings in constant time using Node.js native crypto.
// Pads shorter input to equal length to prevent length-based timing leaks,
// then always calls timingSafeEqual on same-length buffers.
function safeComparePin(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const bufA = Buffer.from(supplied, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) {
    // Run a dummy comparison so timing is not length-dependent
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ── Fail fast if PIN not configured ────────────────────────────────
  if (!ADMIN_PIN || ADMIN_PIN.length < 4) {
    console.error('[admin-unlock] ADMIN_PIN env var not set or too short');
    return res.status(503).json({ ok: false, error: 'Access denied' });
  }

  // ── Extract ID token from Authorization header ──────────────────────
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) return res.status(401).json({ ok: false, error: 'Access denied' });

  // ── Extract PIN from body ───────────────────────────────────────────
  let pin;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    pin = String(body?.pin ?? '');
  } catch {
    return res.status(400).json({ ok: false, error: 'Access denied' });
  }

  try {
    // ── Initialize Firebase first — required before getAuth() ───────────
    // BUG FIX: getAuth() requires the Firebase app to be initialized.
    // getDB() handles initializeApp(); must be called before getAuth().
    const db = await getDB();
    if (!db) return res.status(503).json({ ok: false, error: 'Access denied' });

    // ── Verify Firebase ID token server-side ────────────────────────────
    const { getAuth } = await import('firebase-admin/auth');
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch {
      // Invalid or expired token — generic error, no detail to client
      return res.status(401).json({ ok: false, error: 'Access denied' });
    }

    const uid = decoded.uid;

    // ── Re-check admin role directly in DB (prevents custom claims spoofing) ──
    const roleSnap = await db.ref(`users/${uid}/roles/admin`).once('value');
    const isAdmin = roleSnap.val() === true;

    // ── Constant-time PIN comparison ────────────────────────────────────
    const pinMatch = safeComparePin(pin, ADMIN_PIN);

    // ── Both checks must pass — evaluate both before branching ─────────
    // Evaluate both unconditionally to prevent short-circuit timing leaks.
    const granted = isAdmin && pinMatch;

    if (!granted) {
      // Server-side audit log only — never sent to client.
      // Log combined result, not individual check, to avoid revealing which failed.
      console.warn(`[admin-unlock] DENIED uid=${uid} granted=false`);
      return res.status(401).json({ ok: false, error: 'Access denied' });
    }

    console.log(`[admin-unlock] GRANTED uid=${uid}`);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[admin-unlock] unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'Access denied' });
  }
}

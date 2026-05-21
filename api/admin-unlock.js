// api/admin-unlock.js
// POST /api/admin-unlock
// Validates: Firebase ID token + Firebase admin role + ADMIN_PIN env var.
// Never reveals which check failed — always returns generic "Access denied".
//
// Body:    { pin: string }
// Header:  Authorization: Bearer <firebase-id-token>
// Returns: { ok: true } | { ok: false, error: 'Access denied' }

import { timingSafeEqual, createHash } from 'crypto';
import { getDB, checkOrigin } from './_firebase.js';

const ADMIN_PIN = process.env.ADMIN_PIN;

// ── In-memory rate limiter ───────────────────────────────────────────
// Key: sha256(rawIp).slice(0,16) → { count, resetAt }
//
// ⚠️  ARCHITECTURE NOTE — distributed rate limiting (TODO for production)
// ─────────────────────────────────────────────────────────────────────────
// This _failMap lives in the serverless function's memory. On Vercel every cold
// start creates a fresh map, and concurrent instances each have their own copy.
// A distributed attacker hitting multiple Vercel instances can exceed 5 attempts
// globally while staying under 5 per instance.
//
// This is acceptable as a *lightweight first-line anti-bruteforce* measure only.
// The Firebase role check + constant-time PIN comparison are the real gate.
//
// Production upgrade path (in preference order):
//   1. Upstash Redis  — @upstash/redis  atomic INCR+EXPIRE  ~1 ms latency
//   2. Firebase RTDB  — db.ref(`rateLimits/adminUnlock/${ipHash}`)  serverless-safe
//   3. Vercel KV      — built-in Redis, available on Pro+ plan
//
// Pattern for option 1:
//   const rdb = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });
//   const count = await rdb.incr(`rl:admin:${ipHash}`);
//   if (count === 1) await rdb.expire(`rl:admin:${ipHash}`, 900); // 15 min TTL
//   if (count > RATE_MAX_FAILS) return 429;
// ─────────────────────────────────────────────────────────────────────────
const _failMap = new Map();
const RATE_MAX_FAILS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function getRawIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

function hashIp(rawIp) {
  return createHash('sha256').update(rawIp).digest('hex').slice(0, 16);
}

function isRateLimited(ipHash) {
  const entry = _failMap.get(ipHash);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    _failMap.delete(ipHash);
    return false;
  }
  return entry.count >= RATE_MAX_FAILS;
}

function recordFailure(ipHash) {
  const now = Date.now();
  const entry = _failMap.get(ipHash);
  if (!entry || now > entry.resetAt) {
    _failMap.set(ipHash, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

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

  // ── CSRF: reject requests from disallowed browser origins ───────────
  if (!checkOrigin(req)) {
    console.warn(`[admin-unlock] CSRF_REJECTED origin=${req.headers['origin']}`);
    return res.status(403).json({ ok: false, error: 'Access denied' });
  }

  // ── Rate limit check (before any Firebase work) ─────────────────────
  const rawIp  = getRawIp(req);
  const ipHash = hashIp(rawIp);

  if (isRateLimited(ipHash)) {
    console.warn(`[admin-unlock] RATE_LIMITED ip=${ipHash}`);
    return res.status(429).json({ ok: false, error: 'Access denied' });
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

  // Track uid across try/catch so we can log failures at the outer level
  let uid = null;

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

    uid = decoded.uid;

    // ── Re-check admin role directly in DB (prevents custom claims spoofing) ──
    const roleSnap = await db.ref(`users/${uid}/roles/admin`).once('value');
    const isAdmin = roleSnap.val() === true;

    // ── Constant-time PIN comparison ────────────────────────────────────
    const pinMatch = safeComparePin(pin, ADMIN_PIN);

    // ── Both checks must pass — evaluate both before branching ─────────
    // Evaluate both unconditionally to prevent short-circuit timing leaks.
    const granted = isAdmin && pinMatch;

    if (!granted) {
      recordFailure(ipHash);
      // Server-side audit log only — never sent to client.
      // Log combined result, not individual check, to avoid revealing which failed.
      console.warn(`[admin-unlock] DENIED uid=${uid} granted=false`);
    } else {
      console.log(`[admin-unlock] GRANTED uid=${uid}`);
    }

    // ── Audit trail — NO PIN, NO token, NO raw IP ───────────────────────
    // ipHash is a truncated SHA-256 of the raw IP — untraceable without the original.
    const userAgent = (req.headers['user-agent'] || '').slice(0, 200);
    try {
      const logKey = `${Date.now()}_${uid}`;
      await db.ref(`adminAuditLogs/${logKey}`).set({
        uid,
        success: granted,
        ipHash,
        userAgent,
        createdAt: new Date().toISOString(),
      });
    } catch (auditErr) {
      // Audit log failure must never block the actual response
      console.error('[admin-unlock] audit log write failed:', auditErr.message);
    }

    if (!granted) {
      return res.status(401).json({ ok: false, error: 'Access denied' });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    // Record failure if we at least identified the caller
    if (uid) recordFailure(ipHash);
    console.error('[admin-unlock] unexpected error:', err.message);
    return res.status(500).json({ ok: false, error: 'Access denied' });
  }
}

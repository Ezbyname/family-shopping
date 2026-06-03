// api/_firebase.js — v2.3.0 — lazy Firebase init, REST bypass, shared validators, timeouts, logging
//
// v2.3.0 merged:
//   main  (v2.1): REST bypass (getAdminToken/restGet), CSRF checkOrigin, getLastError/getDbUrl
//   branch (v2.2): withTimeout, logError, sanitizePhone, strict isValidBarcode, cors alias
let _db = null;
let _lastError = null;

export async function getDB() {
  if (_db) return _db;
  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = process.env.FIREBASE_PRIVATE_KEY;
  const url         = process.env.FIREBASE_DATABASE_URL;

  if (!projectId || !clientEmail || !privateKey || !url) {
    _lastError = 'Missing env vars: ' + [
      !projectId   && 'PROJECT_ID',
      !clientEmail && 'CLIENT_EMAIL',
      !privateKey  && 'PRIVATE_KEY',
      !url         && 'DB_URL',
    ].filter(Boolean).join(', ');
    return null;
  }

  try {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getDatabase }                  = await import('firebase-admin/database');
    if (!getApps().length) {
      initializeApp({
        credential:  cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }),
        databaseURL: url,
      });
    }
    _db = getDatabase();
    return _db;
  } catch (e) {
    _lastError = `Firebase init failed: ${e.message}`;
    console.error('[firebase] init error:', e.message);
    return null;
  }
}

export function getLastError() { return _lastError; }

// ── REST bypass — avoids Admin SDK WebSocket hang in Vercel ─────────────────
let _adminToken    = null;
let _adminTokenExp = 0;
let _tokenPromise  = null;

export function getDbUrl() {
  return process.env.FIREBASE_DATABASE_URL || null;
}

async function _generateAdminToken() {
  const email = process.env.FIREBASE_CLIENT_EMAIL || '';
  const key   = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) return null;
  try {
    const now    = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claim  = Buffer.from(JSON.stringify({
      iss:   email,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
      aud:   'https://oauth2.googleapis.com/token',
      iat:   now,
      exp:   now + 3600,
    })).toString('base64url');
    const { createSign } = await import('crypto');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    const jwt = `${header}.${claim}.${signer.sign(key, 'base64url')}`;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
      signal:  AbortSignal.timeout(6_000),
    });
    if (!r.ok) { console.error('[firebase] token HTTP', r.status); return null; }
    return (await r.json()).access_token || null;
  } catch (e) {
    console.error('[firebase] token error:', e.message);
    return null;
  }
}

export async function getAdminToken() {
  const now = Date.now();
  if (_adminToken && _adminTokenExp > now) return _adminToken;
  if (!_tokenPromise) {
    _tokenPromise = _generateAdminToken().then(t => {
      _adminToken    = t;
      _adminTokenExp = Date.now() + 50 * 60_000;
      _tokenPromise  = null;
      return t;
    }).catch(() => { _tokenPromise = null; return null; });
  }
  return _tokenPromise;
}

/** Fetch a Firebase RTDB node via REST (bypasses Admin SDK WebSocket hang). */
export async function restGet(dbUrl, path, timeoutMs = 5_000) {
  const token = await getAdminToken();
  const auth  = token ? `?access_token=${encodeURIComponent(token)}` : '';
  const url   = `${dbUrl.replace(/\/$/, '')}/${path}.json${auth}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`REST HTTP ${r.status} for ${path}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw Object.assign(new Error(`timeout:rest:${path}`), { isTimeout: true });
    }
    throw e;
  }
}

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

/** Set permissive CORS headers. */
export const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};
/** Alias for cors() — used by older API modules. */
export const setCors = cors;

// ── CSRF: Origin validation ──────────────────────────────────────────────────
export function checkOrigin(req) {
  const origin  = req.headers['origin'];
  if (!origin) return true;
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(origin);
}

// ── Validators ───────────────────────────────────────────────────────────────

/**
 * Accept barcodes with exactly 8, 12, 13, or 14 digits (EAN-8, UPC-A, EAN-13, ITF-14).
 * Rejects empty strings, all-zeros, non-string inputs.
 */
export function isValidBarcode(code) {
  if (!code || typeof code !== 'string') return false;
  const s = code.replace(/\D/g, '');
  if (!/^(8|12|13|14)$/.test(String(s.length))) return false;
  if (/^0+$/.test(s)) return false;
  return true;
}

/** Accept prices in the range 0.01 – 10 000 ILS. */
export function isValidPrice(p) {
  const n = parseFloat(p);
  return isFinite(n) && n >= 0.01 && n <= 10_000;
}

// ── Shared utilities (hardening sprint) ─────────────────────────────────────

/**
 * Race a promise against a timeout.
 * Rejects with { isTimeout: true } so callers can distinguish timeouts from errors.
 */
export function withTimeout(promise, ms = 8000, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`timeout:${label} after ${ms}ms`), { isTimeout: true })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Emit a structured JSON error log line indexed by Vercel.
 */
export function logError(context, err, meta = {}) {
  console.error(JSON.stringify({
    ts:  new Date().toISOString(),
    ctx: context,
    err: err?.message ?? String(err),
    ...(process.env.NODE_ENV !== 'production' && err?.stack
      ? { stack: err.stack.split('\n').slice(0, 4).join(' | ') }
      : {}),
    ...meta,
  }));
}

/**
 * Sanitize a phone number for use in a tel: URI.
 * Allowlist: digits, +, -, spaces, parentheses only.
 * Returns null if the value cannot be an E.164 phone number (prevents tel: injection).
 */
export function sanitizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.replace(/[^\d+\-\s()]/g, '').trim();
  const digits   = stripped.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return stripped;
}

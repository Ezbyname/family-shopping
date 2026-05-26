// api/_firebase.js — v2.1.0 — lazy Firebase init + REST bypass for public reads
let _db = null;
let _lastError = null;

export async function getDB() {
  if (_db) return _db;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const url = process.env.FIREBASE_DATABASE_URL;

  if (!projectId || !clientEmail || !privateKey || !url) {
    _lastError = 'Missing env vars: ' + [!projectId && 'PROJECT_ID', !clientEmail && 'CLIENT_EMAIL', !privateKey && 'PRIVATE_KEY', !url && 'DB_URL'].filter(Boolean).join(', ');
    return null;
  }

  try {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getDatabase } = await import('firebase-admin/database');

    if (!getApps().length) {
      const key = privateKey.replace(/\\n/g, '\n');
      initializeApp({
        credential: cert({ projectId, clientEmail, privateKey: key }),
        databaseURL: url
      });
    }
    _db = getDatabase();
    return _db;
  } catch (e) {
    _lastError = `Firebase init failed: ${e.message}`;
    return null;
  }
}

export function getLastError() {
  return _lastError;
}

// ── REST bypass — avoids Admin SDK WebSocket hang in Vercel ─────────────────
// Uses fetch() directly against the Firebase RTDB REST API.
// A service-account OAuth2 token is generated once and cached 50 min, giving
// full admin access (bypasses all database security rules, same as Admin SDK).
let _adminToken    = null;
let _adminTokenExp = 0;
let _tokenPromise  = null;   // deduplicates concurrent cold-start requests

export function getDbUrl() {
  return process.env.FIREBASE_DATABASE_URL || null;
}

async function _generateAdminToken() {
  const email = process.env.FIREBASE_CLIENT_EMAIL || '';
  const key   = (process.env.FIREBASE_PRIVATE_KEY  || '').replace(/\\n/g, '\n');
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

// Returns a valid Google OAuth2 access token (or null if credentials missing/broken).
// Cached for 50 minutes; concurrent callers share one in-flight request.
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

// restGet — fetch a Firebase RTDB node via HTTP (bypasses Admin SDK WebSocket).
// Returns the node value (any JSON type), or null if the node is missing.
// Throws on network error; throws { isTimeout: true } on timeout.
export async function restGet(dbUrl, path, timeoutMs = 5_000) {
  const token = await getAdminToken();
  const auth  = token ? `?access_token=${encodeURIComponent(token)}` : '';
  const url   = `${dbUrl.replace(/\/$/, '')}/${path}.json${auth}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`REST HTTP ${r.status} for ${path}`);
    return await r.json(); // Firebase returns JSON null for missing nodes
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

export const setCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

// ── CSRF: Origin validation ──────────────────────────────────────────────────
// Returns true when the request is safe to proceed.
//
// Non-browser callers (curl, server-to-server) never send Origin → always allowed.
// Browser callers always include Origin for cross-origin fetches → we check it.
//
// Configure: set ALLOWED_ORIGINS env var to comma-separated list of permitted
// origins, e.g. "https://example.com,https://staging.example.com".
// If ALLOWED_ORIGINS is empty/unset: all origins are permitted (dev/preview fallback).
//
// Note: Authorization: Bearer already mitigates most CSRF risk because a
// cross-site attacker cannot read the victim's Firebase token (same-origin policy).
// This check adds defence-in-depth for unexpected future auth changes.
export function checkOrigin(req) {
  const origin = req.headers['origin'];
  if (!origin) return true; // non-browser caller — no Origin header → allow
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true; // not configured → allow all (dev fallback)
  return allowed.includes(origin);
}

export const isValidBarcode = (str) => {
  const clean = String(str).replace(/\D/g, '');
  return clean.length >= 8 && clean.length <= 14;
};

export const isValidPrice = (p) => {
  const n = parseFloat(p);
  return !isNaN(n) && n > 0.01 && n < 10000;
};

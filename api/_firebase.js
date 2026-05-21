// api/_firebase.js — v2.0 — lazy Firebase init, no top-level imports
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

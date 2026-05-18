// api/_firebase.js — v3.0.0
// Shared Firebase Admin — lazy init, no top-level imports, no secrets in logs

let _db = null;

export async function getDB() {
  if (_db) return _db;
  const sa  = process.env.FIREBASE_SERVICE_ACCOUNT;
  const url = process.env.FIREBASE_DATABASE_URL;
  if (!sa || !url) {
    console.warn('[firebase] env vars missing — Firebase disabled');
    return null;
  }
  try {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getDatabase }                  = await import('firebase-admin/database');
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(sa)), databaseURL: url });
    }
    _db = getDatabase();
    console.log('[firebase] initialized OK');
    return _db;
  } catch (e) {
    console.error('[firebase] init error:', e.message);
    return null;
  }
}

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Validation helpers — shared across all API routes
export function isValidBarcode(b) {
  const s = String(b || '').replace(/\D/g, '');
  return s.length >= 4 && s.length <= 20;
}
export function isValidPrice(p) {
  const n = parseFloat(p);
  return !isNaN(n) && n > 0 && n < 10000;
}
export function sanitize(s, max = 200) {
  return String(s || '').trim().replace(/[<>]/g, '').substring(0, max);
}

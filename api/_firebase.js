// api/_firebase.js — v2.1 — lazy Firebase init, shared validators and CORS helpers
let _db = null;

export async function getDB() {
  if (_db) return _db;
  const sa  = process.env.FIREBASE_SERVICE_ACCOUNT;
  const url = process.env.FIREBASE_DATABASE_URL;
  if (!sa || !url) return null;
  try {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getDatabase } = await import('firebase-admin/database');
    if (!getApps().length) {
      initializeApp({ credential: cert(JSON.parse(sa)), databaseURL: url });
    }
    _db = getDatabase();
    return _db;
  } catch (e) {
    console.error('[firebase] init error:', e.message);
    return null;
  }
}

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

/** Set permissive CORS headers on a Vercel response object. */
export const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

/** Alias used by newer API modules (same behaviour as cors()). */
export const setCors = cors;

/**
 * Accept barcodes with 8, 12, 13, or 14 digits (EAN-8, UPC-A, EAN-13, ITF-14).
 * Rejects empty strings, all-zeros, and anything with non-digit characters.
 */
export function isValidBarcode(code) {
  if (!code || typeof code !== 'string') return false;
  const s = code.replace(/\D/g, '');
  if (!/^(8|12|13|14)$/.test(String(s.length))) return false;
  if (/^0+$/.test(s)) return false;
  return true;
}

/**
 * Accept prices in the range 0.01 – 10 000 ILS.
 * Handles both number and string inputs.
 */
export function isValidPrice(p) {
  const n = parseFloat(p);
  return isFinite(n) && n >= 0.01 && n <= 10_000;
}

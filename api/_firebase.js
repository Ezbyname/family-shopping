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

export const isValidBarcode = (str) => {
  const clean = String(str).replace(/\D/g, '');
  return clean.length >= 8 && clean.length <= 14;
};

export const isValidPrice = (p) => {
  const n = parseFloat(p);
  return !isNaN(n) && n > 0.01 && n < 10000;
};

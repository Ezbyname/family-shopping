// api/_firebase.js — v2.0 — lazy Firebase init, no top-level imports
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

export const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

// api/_firebase.js — v2.2 — lazy Firebase init, shared validators, CORS, timeouts, logging
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

/**
 * Race a promise against a timeout.
 * Rejects with { isTimeout: true } on expiry so callers can distinguish timeouts
 * from real errors.
 *
 * @param {Promise}  promise
 * @param {number}   ms      Milliseconds before rejection
 * @param {string}   label   Included in the rejection message for logging
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
 * Emit a structured JSON error log line.
 * Vercel indexes console.error output as structured JSON when the value is valid JSON.
 *
 * @param {string} context  Short identifier for the calling module (e.g. 'basket-compare')
 * @param {Error}  err      The error object
 * @param {object} meta     Additional key→value pairs to include
 */
export function logError(context, err, meta = {}) {
  console.error(JSON.stringify({
    ts:  new Date().toISOString(),
    ctx: context,
    err: err?.message ?? String(err),
    // Omit stack in production to keep logs concise
    ...(process.env.NODE_ENV !== 'production' && err?.stack
      ? { stack: err.stack.split('\n').slice(0, 4).join(' | ') }
      : {}),
    ...meta,
  }));
}

/**
 * Sanitize a phone number for use in a tel: URI.
 *
 * Allowlist: digits, +, -, spaces, parentheses only.
 * Returns null for anything that cannot be a real E.164 phone number
 * (prevents tel: injection / XSS via crafted phone values in Firebase).
 *
 * @param {*} raw  Raw value from untrusted source (e.g. Firebase store record)
 * @returns {string|null}  Clean phone string or null
 */
export function sanitizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.replace(/[^\d+\-\s()]/g, '').trim();
  const digits   = stripped.replace(/\D/g, '');
  // ITU-T E.164: 7–15 digits; reject trivially short or long values
  if (digits.length < 7 || digits.length > 15) return null;
  return stripped;
}

// scripts/utils.js — v2.0.0
export const logger = {
  info:  (...a) => console.log(`[${ts()}] INFO  `, ...a),
  warn:  (...a) => console.warn(`[${ts()}] WARN  `, ...a),
  error: (...a) => console.error(`[${ts()}] ERROR `, ...a),
  ok:    (...a) => console.log(`[${ts()}] ✅    `, ...a),
  skip:  (...a) => console.log(`[${ts()}] ⏭    `, ...a),
  fail:  (...a) => console.error(`[${ts()}] ❌    `, ...a),
};
const ts = () => new Date().toISOString();

export async function withRetry(fn, { retries = 3, delayMs = 2000, label = '' } = {}) {
  let last;
  for (let i = 1; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      logger.warn(`${label} attempt ${i}/${retries}: ${e.message}`);
      if (i < retries) await sleep(delayMs * i);
    }
  }
  throw last;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const isValidBarcode = b => { const s = String(b||'').replace(/\D/g,''); return s.length >= 4 && s.length <= 20; };
export const isValidPrice   = p => { const n = parseFloat(p); return !isNaN(n) && n > 0 && n < 10000; };
export const normalizeBarcode = b => String(b||'').replace(/\D/g,'').trim();
export const normalizePrice   = p => { const n = parseFloat(String(p||'0').replace(',','.')); return isNaN(n) ? null : Math.round(n*100)/100; };
export const safeKey = s => String(s||'').replace(/[.#$[\]/]/g,'_').substring(0,768);
export const formatBytes = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(1)}KB` : `${(b/1048576).toFixed(1)}MB`;

// Haversine distance in km
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

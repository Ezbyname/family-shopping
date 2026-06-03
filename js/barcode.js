/**
 * js/barcode.js — v1.0.0
 *
 * Shared barcode and price validation utilities.
 * Single source of truth for the frontend — mirrors api/_firebase.js exactly.
 *
 * Export pattern: plain ES module so it can be imported by the main
 * <script type="module"> in index.html and by any future separate modules.
 *
 * Validation rules match the API (_firebase.js isValidBarcode / isValidPrice):
 *   - EAN-8 (8 digits), UPC-A (12), EAN-13 (13), ITF-14 (14)
 *   - All-zero barcodes rejected
 *   - Prices: 0.01 – 10 000 ILS
 */

/**
 * Returns true for valid retail barcodes (EAN-8, UPC-A, EAN-13, ITF-14).
 * Strips non-digit characters before checking length so callers can pass
 * raw scanner output (e.g. "1234-5678-9012-3" → cleaned to 13 digits).
 *
 * @param {*} b  Raw barcode value (string or number)
 * @returns {boolean}
 */
export function isValidBarcode(b) {
  const s = String(b || '').replace(/\D/g, '');
  if (!/^(?:8|12|13|14)$/.test(String(s.length))) return false;
  if (/^0+$/.test(s)) return false;
  return true;
}

/**
 * Returns true for prices in the range 0.01 – 10 000 ILS.
 * Accepts both number and string inputs.
 *
 * @param {*} p  Raw price value
 * @returns {boolean}
 */
export function isValidPrice(p) {
  const n = parseFloat(p);
  return isFinite(n) && n >= 0.01 && n <= 10_000;
}

/**
 * Sanitize a phone number for use in a tel: URI.
 *
 * Allowlist: digits, +, -, spaces, parentheses only.
 * Returns null if the value cannot be a real phone number.
 * Prevents tel: URI injection via crafted Firebase values.
 *
 * @param {*} raw  Raw value (may come from Firebase / API response)
 * @returns {string|null}
 */
export function sanitizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.replace(/[^\d+\-\s()]/g, '').trim();
  const digits   = stripped.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return stripped;
}

// workers/prices/normalizeProduct.js
// Validates and normalizes raw parsed product/store data before writing to Firebase.

// ── BARCODE ──
export function normalizeBarcode(raw) {
  return String(raw || '').replace(/\D/g, '').trim();
}
export function isValidBarcode(b) {
  const s = normalizeBarcode(b);
  return s.length >= 4 && s.length <= 20;
}

// ── PRICE ──
export function normalizePrice(raw) {
  const n = parseFloat(String(raw || '0').replace(',', '.'));
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}
export function isValidPrice(p) {
  return p !== null && p > 0 && p < 50000;
}

// ── DATE ──
export function toISO(raw) {
  if (!raw) return new Date().toISOString();
  const s = String(raw).trim();
  // Format: 20260516 → 2026-05-16
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00.000Z`;
  }
  try {
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString();
  } catch (_) {}
  return new Date().toISOString();
}

// ── FIREBASE KEY SANITIZATION ──
// Firebase keys cannot contain . # $ [ ] /
export function safeKey(str) {
  return String(str || '')
    .replace(/[.#$[\]/]/g, '_')
    .substring(0, 768)
    || '_empty_';
}

// ── PRODUCT ──
export function normalizeProduct(raw, header = {}) {
  const barcode = normalizeBarcode(raw.barcode);
  if (!isValidBarcode(barcode)) return null;

  const price = normalizePrice(raw.price);
  if (!isValidPrice(price)) return null;

  const name = String(raw.name || '').trim();
  if (name.length < 1) return null;

  return {
    barcode,
    name,
    price,
    chainId:   String(raw.chainId   || header.chainId   || '').trim(),
    chainName: String(raw.chainName || header.chainName || '').trim(),
    storeId:   String(raw.storeId   || header.storeId   || '').trim(),
    storeName: String(raw.storeName || header.storeName || '').trim(),
    unit:      String(raw.unit      || '').trim(),
    quantity:  String(raw.quantity  || raw.unitQty || '').trim(),
    brand:     String(raw.brand     || '').trim(),
    updatedAt: toISO(raw.updatedAt),
    source:    'official',
    currency:  'ILS',
  };
}

// ── STORE ──
export function normalizeStore(raw, chainMeta = {}) {
  const storeId = String(raw.storeId || '').trim();
  if (!storeId) return null;

  const lat = parseFloat(raw.latitude  || '');
  const lng = parseFloat(raw.longitude || '');
  const hasCoords = !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0;

  return {
    chainId:      String(chainMeta.chainId   || raw.chainId   || '').trim(),
    chainName:    String(chainMeta.chainName || raw.chainName || '').trim(),
    subChainId:   String(raw.subChainId   || '').trim(),
    subChainName: String(raw.subChainName || '').trim(),
    storeId,
    storeName: String(raw.storeName || '').trim(),
    address:   String(raw.address   || '').trim(),
    city:      String(raw.city      || '').trim(),
    zipCode:   String(raw.zipCode   || '').trim(),
    latitude:  hasCoords ? lat : null,
    longitude: hasCoords ? lng : null,
    hasCoords,
    updatedAt: new Date().toISOString(),
  };
}

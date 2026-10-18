// js/bp-results.js
// Result-set helpers for the Product Picker: dedup, "show first N", pagination.
// Pure: no DOM, Firebase, network, or app.js globals.

export const PICKER_INITIAL = 10;   // rows shown in the bottom sheet
export const MORE_PAGE_SIZE = 12;   // rows per page in the expanded view
export const RESULT_CAP     = 200;  // safety cap on the in-memory ranked list

function dedupeKey(p) {
  if (p.barcode) return `b:${p.barcode}`;
  return `n:${[p.name, p.brand, p.size].map(v => String(v || '').trim().toLowerCase()).join('|')}`;
}

// Keeps the first (best-ranked) occurrence; order is preserved.
export function bpDedupeProducts(products) {
  const seen = new Set();
  const out = [];
  for (const p of products) {
    const k = dedupeKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function bpPickerView(products) {
  const total = products.length;
  return {
    total,
    shown: products.slice(0, PICKER_INITIAL),
    remaining: Math.max(0, total - PICKER_INITIAL),
  };
}

export function bpPage(products, page, pageSize = MORE_PAGE_SIZE) {
  const total = products.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const start = (current - 1) * pageSize;
  return {
    total,
    pages,
    page: current,
    start,                                   // index of the first item in the full list
    items: products.slice(start, start + pageSize),
    hasPrev: current > 1,
    hasNext: current < pages,
  };
}

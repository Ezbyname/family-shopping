// js/store-ui.js
// Pure helpers for store identity and navigation destinations.
// No DOM, Firebase, network, or app.js globals.

// ── Store identity ───────────────────────────────────────────────────────────

// Chain identity comes from ids (internal id, GS1 company id, or the key prefix
// of prices/{barcode}/{chainId_storeId}) — not from fuzzy matching on branch names.
const SHUFERSAL_IDS = new Set(['shufersal', '7290027600007']);

export function isShufersal(p) {
  if (!p) return false;
  const id = String(p.chainId || '').toLowerCase();
  if (SHUFERSAL_IDS.has(id)) return true;
  const keyPrefix = String(p._key || '').split('_')[0].toLowerCase();
  if (SHUFERSAL_IDS.has(keyPrefix)) return true;
  return String(p.chainName || '').trim() === 'שופרסל';
}

// Visible title of a price row. Shufersal branches always carry the parent chain
// ("שופרסל · דיל אילת הסתת"); every other chain keeps its existing title.
export function storeRowTitle(p) {
  const chainName = p.chainName || p.chainId || '';
  const primary   = p.storeName || chainName;
  if (!isShufersal(p)) return primary;
  const parent = 'שופרסל';
  if (!primary || primary === chainName) return parent;
  if (primary.includes(parent)) return primary;
  return `${parent} · ${primary}`;
}

// ── Navigation ───────────────────────────────────────────────────────────────

// Rough Israel bounding box — rejects 0/0, swapped or garbage coordinates.
export function hasUsableCoords(lat, lng) {
  const la = Number(lat), ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) &&
         la > 29.3 && la < 33.5 && ln > 34.1 && ln < 36.0;
}

// One canonical destination shared by every provider.
//   1. trusted coordinates, when present
//   2. full address INCLUDING city (never street + number alone when a city is known)
//   3. store/chain name + city
export function navDestination({ lat, lng, address, city, name } = {}) {
  if (hasUsableCoords(lat, lng)) {
    return { kind: 'coords', lat: Number(lat), lng: Number(lng) };
  }
  const addr = String(address || '').trim();
  const c    = String(city || '').trim();
  if (addr) {
    const parts = [addr];
    // avoid "הזגג 11, אילת, אילת" when the address already ends with the city
    if (c && !addr.includes(c)) parts.push(c);
    parts.push('ישראל');
    return { kind: 'address', query: parts.join(', ') };
  }
  const label = [String(name || '').trim(), c].filter(Boolean);
  if (!label.length) return null;
  label.push('ישראל');
  return { kind: 'name', query: label.join(', ') };
}

export function googleMapsUrl(dest) {
  if (!dest) return null;
  if (dest.kind === 'coords') {
    return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest.query)}`;
}

export function wazeUrl(dest) {
  if (!dest) return null;
  if (dest.kind === 'coords') {
    return `https://waze.com/ul?ll=${dest.lat},${dest.lng}&navigate=yes`;
  }
  return `https://waze.com/ul?q=${encodeURIComponent(dest.query)}&navigate=yes`;
}

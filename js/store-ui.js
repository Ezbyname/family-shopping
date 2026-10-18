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

// Visible title of a price row. The chain is ALWAYS part of it, so a branch is never
// shown without its parent chain:
//   רמי לוי · מרכול אינטרנט      שופרסל · דיל אילת      שופרסל (no branch name)
export function storeRowTitle(p) {
  const chainName = isShufersal(p) ? 'שופרסל' : String(p.chainName || p.chainId || '').trim();
  const branch    = String(p.storeName || '').trim();
  if (!branch || branch === chainName || branch === String(p.chainId || '')) return chainName || branch;
  if (!chainName || branch.includes(chainName)) return branch;
  return `${chainName} · ${branch}`;
}

// "הזגג 11, אילת" — full address with the city exactly once.
export function storeAddressLine(p) {
  const addr = String(p.address || '').trim();
  const city = String(p.city || '').trim();
  if (addr && city && !addr.includes(city)) return `${addr}, ${city}`;
  return addr || city;
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

// ── Navigation provider app tiles ────────────────────────────────────────────
// Large app-icon tiles (96x96) for the Google Maps / Waze chooser. The Waze bubble and
// the Google Maps pin are the providers' brand glyphs (Simple Icons, CC0); the tile
// artwork around them is drawn here.
export const NAV_ICON_GOOGLE = '<svg class="nav-ico" viewBox="0 0 96 96" aria-hidden="true">'
  + '<defs><clipPath id="nvg"><rect width="96" height="96" rx="21"/></clipPath></defs>'
  + '<g clip-path="url(#nvg)"><rect width="96" height="96" fill="#E6EDF3"/>'
  + '<path d="M0 0H60L0 60Z" fill="#34A853"/><path d="M0 60L44 96H0Z" fill="#4285F4"/>'
  + '<path d="M96 24V96H44L96 24Z" fill="#FBBC04" opacity=".9"/><path d="M0 70L70 0H82L0 82Z" fill="#fff"/>'
  + '<path d="M96 60V96H66Z" fill="#4285F4"/></g>'
  + '<text x="9" y="43" font-family="Arial,Helvetica,sans-serif" font-size="36" font-weight="700" fill="#fff">G</text>'
  + '<g transform="translate(44 20) scale(2.2)"><path fill="#EA4335" d="M19.527 4.799c1.212 2.608.937 5.678-.405 8.173-1.101 2.047-2.744 3.74-4.098 5.614-.619.858-1.244 1.75-1.669 2.727-.141.325-.263.658-.383.992-.121.333-.224.673-.34 1.008-.109.314-.236.684-.627.687h-.007c-.466-.001-.579-.53-.695-.887-.284-.874-.581-1.713-1.019-2.525-.51-.944-1.145-1.817-1.79-2.671L19.527 4.799zM8.545 7.705l-3.959 4.707c.724 1.54 1.821 2.863 2.871 4.18.247.31.494.622.737.936l4.984-5.925-.029.01c-1.741.601-3.691-.291-4.392-1.987a3.377 3.377 0 0 1-.209-.716c-.063-.437-.077-.761-.004-1.198l.001-.007zM5.492 3.149l-.003.004c-1.947 2.466-2.281 5.88-1.117 8.77l4.785-5.689-.058-.05-3.607-3.035zM14.661.436l-3.838 4.563a.295.295 0 0 1 .027-.01c1.6-.551 3.403.15 4.22 1.626.176.319.323.683.377 1.045.068.446.085.773.012 1.22l-.003.016 3.836-4.561A8.382 8.382 0 0 0 14.67.439l-.009-.003zM9.466 5.868L14.162.285l-.047-.012A8.31 8.31 0 0 0 11.986 0a8.439 8.439 0 0 0-6.169 2.766l-.016.018 3.665 3.084z"/></g>'
  + '</svg>';
export const NAV_ICON_WAZE = '<svg class="nav-ico" viewBox="0 0 96 96" aria-hidden="true">'
  + '<rect width="96" height="96" rx="21" fill="#5BD0EE"/>'
  + '<g transform="translate(14 14) scale(2.8)"><path fill="#fff" d="M13.218 0C9.915 0 6.835 1.49 4.723 4.148c-1.515 1.913-2.31 4.272-2.31 6.706v1.739c0 .894-.62 1.738-1.862 1.813-.298.025-.547.224-.547.522-.05.82.82 2.31 2.012 3.502.82.844 1.788 1.515 2.832 2.036a3 3 0 0 0 2.955 3.528 2.966 2.966 0 0 0 2.931-2.385h2.509c.323 1.689 2.086 2.856 3.974 2.21 1.64-.546 2.36-2.409 1.763-3.924a12.84 12.84 0 0 0 1.838-1.465 10.73 10.73 0 0 0 3.18-7.65c0-2.882-1.118-5.589-3.155-7.625A10.899 10.899 0 0 0 13.218 0zm0 1.217c2.558 0 4.967.994 6.78 2.807a9.525 9.525 0 0 1 2.807 6.78A9.526 9.526 0 0 1 20 17.585a9.647 9.647 0 0 1-6.78 2.807h-2.46a3.008 3.008 0 0 0-2.93-2.41 3.03 3.03 0 0 0-2.534 1.367v.024a8.945 8.945 0 0 1-2.41-1.788c-.844-.844-1.316-1.614-1.515-2.11a2.858 2.858 0 0 0 1.441-.846 2.959 2.959 0 0 0 .795-2.036v-1.789c0-2.11.696-4.197 2.012-5.861 1.863-2.385 4.62-3.726 7.6-3.726zm-2.41 5.986a1.192 1.192 0 0 0-1.191 1.192 1.192 1.192 0 0 0 1.192 1.193A1.192 1.192 0 0 0 12 8.395a1.192 1.192 0 0 0-1.192-1.192zm7.204 0a1.192 1.192 0 0 0-1.192 1.192 1.192 1.192 0 0 0 1.192 1.193 1.192 1.192 0 0 0 1.192-1.193 1.192 1.192 0 0 0-1.192-1.192zm-7.377 4.769a.596.596 0 0 0-.546.845 4.813 4.813 0 0 0 4.346 2.757 4.77 4.77 0 0 0 4.347-2.757.596.596 0 0 0-.547-.845h-.025a.561.561 0 0 0-.521.348 3.59 3.59 0 0 1-3.254 2.061 3.591 3.591 0 0 1-3.254-2.061.64.64 0 0 0-.546-.348z"/></g>'
  + '</svg>';

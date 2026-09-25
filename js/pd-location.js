/**
 * Pure price-detail location helpers — no DOM, no Firebase, no global state.
 * Imported by app.js (browser) and tests/pd-location.test.js (Node).
 *
 * DESIGN NOTE: city-mode barcode lookup with zero results returns NO name-search
 * fallback results. The name-search endpoint is national; injecting its results
 * into a city-filtered view would silently contaminate that view with unrelated
 * stores from across the country.
 *
 * SECURITY: userId / groupId are passed through to API URLs here for query
 * construction only. Server-side auth hardening (verifying identity via Firebase
 * ID token and validating group membership) is tracked in a separate security
 * commit and must not be changed inside this module.
 */

/**
 * Returns true when location has valid coordinates, independent of nearbyMode.
 * This is the correct check for price-detail — _hasLoc() in the main app checks
 * nearbyMode as well, which caused national results to appear when the mode
 * toggle was off but a location was stored.
 *
 * @param {object|null} location  { lat, lng, ... }
 */
export function pdHasLoc(location) {
  return location?.lat != null && location?.lng != null;
}

/**
 * Compute initial PD mode from current filter state.
 * City takes priority, then radius if a location is available, else national.
 *
 * @param {string[]} selectedCities
 * @param {object|null} location
 * @returns {'city'|'radius'|'all'}
 */
export function pdInitialMode(selectedCities, location) {
  if (selectedCities.length > 0) return 'city';
  if (pdHasLoc(location)) return 'radius';
  return 'all';
}

/**
 * Effective radius for price-detail. New users (no explicit selection) default
 * to 10 km; after any explicit selection the stored value is used.
 *
 * @param {boolean} radiusExplicitlySet
 * @param {number}  nearbyRadius  stored radius in km
 * @returns {number}
 */
export function pdEffectiveRadius(radiusExplicitlySet, nearbyRadius) {
  return radiusExplicitlySet ? nearbyRadius : 10;
}

/**
 * Context-aware cache key for a barcode. Encodes mode + location + cities so
 * switching between modes never serves a stale result from a different context.
 *
 * @param {string}   barcode
 * @param {'city'|'radius'|'all'} mode
 * @param {object|null} location
 * @param {string[]} selectedCities
 * @param {boolean}  radiusExplicitlySet
 * @param {number}   nearbyRadius
 * @returns {string}
 */
export function pdCacheKey(barcode, mode, location, selectedCities, radiusExplicitlySet, nearbyRadius) {
  if (mode === 'radius' && pdHasLoc(location)) {
    const r = pdEffectiveRadius(radiusExplicitlySet, nearbyRadius);
    return `pd_${barcode}_r_${location.lat.toFixed(5)}_${location.lng.toFixed(5)}_${r}`;
  }
  if (mode === 'city' && selectedCities.length > 0) {
    return `pd_${barcode}_c_${[...selectedCities].sort().join(',')}`;
  }
  return `pd_${barcode}_all`;
}

/**
 * Whether a price row should be kept after the API response in radius mode.
 * Rows without known store coordinates (distanceKm == null) are excluded so
 * only stores within the radius appear.
 *
 * @param {{ distanceKm?: number|null }} row
 * @param {'city'|'radius'|'all'} mode
 * @returns {boolean}
 */
export function pdRowEligible(row, mode) {
  if (mode === 'radius') return row.distanceKm != null;
  return true;
}

/**
 * Build the primary fetch URL for a barcode lookup.
 *
 * Returns { url, isCityMode } on success, or { url: null, isCityMode, blocked } when
 * the current mode cannot be fulfilled:
 *   - city mode with no selected cities  → blocked: 'no-cities'
 *   - radius mode with no location       → blocked: 'no-location'
 *
 * Callers MUST check url === null and skip the fetch entirely.
 * A blocked filtered mode must never fall through to a national request.
 *
 * @param {string}   barcode
 * @param {'city'|'radius'|'all'} mode
 * @param {object|null} location
 * @param {string[]} selectedCities
 * @param {boolean}  radiusExplicitlySet
 * @param {number}   nearbyRadius
 * @param {string|null} userId
 * @param {string|null} groupId
 * @returns {{ url: string|null, isCityMode: boolean, blocked?: string }}
 */
export function pdBuildRequestUrl(barcode, mode, location, selectedCities, radiusExplicitlySet, nearbyRadius, userId, groupId) {
  if (mode === 'city') {
    if (selectedCities.length === 0) return { url: null, isCityMode: true, blocked: 'no-cities' };
    const params = new URLSearchParams({ barcode });
    for (const city of selectedCities) params.append('city', city);
    if (userId)  params.set('userId', userId);
    if (groupId) params.set('groupId', groupId);
    return { url: `/api/prices-by-city?${params.toString()}`, isCityMode: true };
  }
  if (mode === 'radius') {
    if (!pdHasLoc(location)) return { url: null, isCityMode: false, blocked: 'no-location' };
    const r = pdEffectiveRadius(radiusExplicitlySet, nearbyRadius);
    let url = `/api/prices?barcode=${encodeURIComponent(barcode)}`
      + `&lat=${location.lat}&lng=${location.lng}&radiusKm=${r}&includeApproximate=true`;
    if (userId)  url += `&userId=${encodeURIComponent(userId)}`;
    if (groupId) url += `&groupId=${encodeURIComponent(groupId)}`;
    return { url, isCityMode: false };
  }
  // all mode — intentional national request
  let url = `/api/prices?barcode=${encodeURIComponent(barcode)}`;
  if (userId)  url += `&userId=${encodeURIComponent(userId)}`;
  if (groupId) url += `&groupId=${encodeURIComponent(groupId)}`;
  return { url, isCityMode: false };
}

/**
 * Normalize the API response body into a flat price rows array.
 * - prices-by-city returns { results: [...] }
 * - prices        returns { prices:  [...] }
 *
 * @param {object} data        parsed JSON response
 * @param {boolean} isCityMode
 * @returns {Array}
 */
export function pdExtractRows(data, isCityMode) {
  return isCityMode ? (data.results || []) : (data.prices || []);
}

/**
 * Build the name-search fallback URL, or null if the fallback should not run.
 * The fallback is suppressed in city mode to prevent national result contamination.
 * In radius mode, location parameters are included so results are distance-filtered.
 *
 * @param {string}   name   product name (Hebrew)
 * @param {'city'|'radius'|'all'} mode
 * @param {object|null} location
 * @param {boolean}  radiusExplicitlySet
 * @param {number}   nearbyRadius
 * @returns {string|null}  URL string, or null if fallback must not run
 */
export function pdNameFallbackUrl(name, mode, location, radiusExplicitlySet, nearbyRadius) {
  if (mode === 'city') return null;  // suppress — see module docstring
  let url = `/api/prices?q=${encodeURIComponent(name)}`;
  if (mode === 'radius' && pdHasLoc(location)) {
    const r = pdEffectiveRadius(radiusExplicitlySet, nearbyRadius);
    url += `&lat=${location.lat}&lng=${location.lng}&radiusKm=${r}`;
  }
  return url;
}

/**
 * Should the name-search fallback run?
 *
 * @param {Array}  prices  result array from primary fetch (may be empty)
 * @param {string|null} pdName  known product name
 * @param {'city'|'radius'|'all'} mode
 * @returns {boolean}
 */
export function pdShouldUseFallback(prices, pdName, mode) {
  return prices.length === 0 && Boolean(pdName) && mode !== 'city';
}

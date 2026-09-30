// js/nearby-state.js
// Pure helpers for nearby-mode state persistence and price-query scope construction.
// Extracted for deterministic testing without DOM dependency.

const VALID_RADII = [1, 3, 5, 10, 25, 50];

/**
 * Restore nearby mode from persistent storage values.
 *
 * Rules (per FS-RADIUS-001):
 *  - nearbyMode is restored to true ONLY when:
 *      (a) storage.nearbyMode === 'true', AND
 *      (b) selectedLocation is present with valid lat/lng
 *  - If location is absent or invalid, nearbyMode stays false even if stored as true.
 *  - needsCacheFlush is true when nearbyMode is restored so the caller can
 *    invalidate stale nationwide price-cache entries from the previous session.
 *
 * @param {Object} storage  Key/value pairs from localStorage (raw strings).
 * @returns {{ nearbyMode: boolean, nearbyRadius: number, selectedLocation: object|null, needsCacheFlush: boolean }}
 */
export function restoreNearbyState(storage) {
  const r = parseInt(storage.nearbyRadius || '3', 10);
  const nearbyRadius = VALID_RADII.includes(r) ? r : 3;

  let selectedLocation = null;
  try {
    if (storage.selectedLocation) selectedLocation = JSON.parse(storage.selectedLocation);
  } catch (_) {}

  const hasValidLocation = Boolean(
    selectedLocation &&
    typeof selectedLocation.lat === 'number' && isFinite(selectedLocation.lat) &&
    typeof selectedLocation.lng === 'number' && isFinite(selectedLocation.lng)
  );

  const nearbyMode = storage.nearbyMode === 'true' && hasValidLocation;

  return { nearbyMode, nearbyRadius, selectedLocation, needsCacheFlush: nearbyMode };
}

/**
 * Build the location query-string fragment for /api/prices.
 *
 * CONTRACT (per FS-RADIUS-001):
 *  - When nearbyMode=true:  returns '&lat=...&lng=...&radiusKm=...&includeApproximate=true'
 *  - When nearbyMode=false: returns '' (no location params → nationwide results, intentionally)
 *  - There is NO silent auto-reactivation here. The caller is responsible for ensuring
 *    nearbyMode reflects the user's explicit choice.
 *
 * @param {boolean}      nearbyMode
 * @param {object|null}  selectedLocation  { lat, lng, ... }
 * @param {number}       nearbyRadius      km
 * @returns {string}
 */
export function buildPriceQueryScope(nearbyMode, selectedLocation, nearbyRadius) {
  if (!nearbyMode || !selectedLocation?.lat || !selectedLocation?.lng) return '';
  return `&lat=${selectedLocation.lat}&lng=${selectedLocation.lng}&radiusKm=${nearbyRadius}&includeApproximate=true`;
}

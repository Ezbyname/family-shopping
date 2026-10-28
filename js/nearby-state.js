// js/nearby-state.js
// FS-RADIUS-001 — pure helpers for persisting the nearby-mode toggle across app restarts.
// Extracted for deterministic testing without DOM dependency.
//
// Storage contract: localStorage[NEARBY_MODE_KEY] === 'true' means the user left nearby
// mode ON; the key is absent when it is OFF. Any other value is treated as OFF.
// Clearing the saved location does NOT touch this key (3.2.5 clear-location behaviour).

export const NEARBY_MODE_KEY = 'nearbyMode';

export function nearbyHasValidLocation(loc) {
  return Boolean(loc && typeof loc === 'object' &&
    typeof loc.lat === 'number' && Number.isFinite(loc.lat) &&
    typeof loc.lng === 'number' && Number.isFinite(loc.lng));
}

// Nearby mode is restored ON only when the stored flag is exactly 'true' AND a valid
// saved location exists — without a location there is nothing to filter by.
export function restoreNearbyMode(storedValue, selectedLocation) {
  return storedValue === 'true' && nearbyHasValidLocation(selectedLocation);
}

export function persistNearbyMode(storage, on) {
  try {
    if (on) storage.setItem(NEARBY_MODE_KEY, 'true');
    else    storage.removeItem(NEARBY_MODE_KEY);
  } catch (_) {}
}

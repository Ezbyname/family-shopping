// api/_search-lkg-config.js
//
// Runtime configuration for persistent Search LKG.
//
// Safety contract:
// - Persistent LKG is DISABLED unless explicitly enabled.
// - Enabling requires a valid positive TTL.
// - Merely importing this module causes no reads/writes.

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// HARD SAFETY GATE
//
// Persistent Search LKG access must remain disabled until explicitly approved.
// Even if SEARCH_LKG_ENABLED=true already exists in a remote environment,
// this source-controlled gate prevents activation.
//
// Change to true only in a separately reviewed/approved activation change.
export const SEARCH_LKG_PERSISTENCE_APPROVED = false;

function isExplicitlyEnabled(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

export function getSearchLkgConfig(env = process.env) {
  const requested = isExplicitlyEnabled(
    env.SEARCH_LKG_ENABLED
  );

  if (!requested) {
    return {
      enabled: false,
      ttlMs: null,
    };
  }

  if (!SEARCH_LKG_PERSISTENCE_APPROVED) {
    return {
      enabled: false,
      ttlMs: null,
      blockedByApprovalGate: true,
    };
  }

  const rawTtl = env.SEARCH_LKG_TTL_MS;

  const ttlMs =
    rawTtl === undefined || rawTtl === ''
      ? DEFAULT_TTL_MS
      : Number(rawTtl);

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return {
      enabled: false,
      ttlMs: null,
      error: 'invalid_search_lkg_ttl',
    };
  }

  return {
    enabled: true,
    ttlMs,
  };
}

export { DEFAULT_TTL_MS as SEARCH_LKG_DEFAULT_TTL_MS };

// ── Product Picker (/api/openfoodfacts-search) activation ────────────────────
//
// Independent from the gate above, which keeps controlling /api/prices search.
// Enabling one never enables the other:
//   /api/prices            -> SEARCH_LKG_PERSISTENCE_APPROVED + SEARCH_LKG_ENABLED
//   /api/openfoodfacts-search -> PICKER_LKG_PERSISTENCE_APPROVED + PICKER_LKG_ENABLED
//
// Change to true only in a separately reviewed/approved activation change.
export const PICKER_LKG_PERSISTENCE_APPROVED = false;

export function getPickerLkgConfig(env = process.env) {
  if (!isExplicitlyEnabled(env.PICKER_LKG_ENABLED)) {
    return { enabled: false, ttlMs: null };
  }

  if (!PICKER_LKG_PERSISTENCE_APPROVED) {
    return { enabled: false, ttlMs: null, blockedByApprovalGate: true };
  }

  const rawTtl = env.PICKER_LKG_TTL_MS;
  const ttlMs =
    rawTtl === undefined || rawTtl === ''
      ? DEFAULT_TTL_MS
      : Number(rawTtl);

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { enabled: false, ttlMs: null, error: 'invalid_picker_lkg_ttl' };
  }

  return { enabled: true, ttlMs };
}

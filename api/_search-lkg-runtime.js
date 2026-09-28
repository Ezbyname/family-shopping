// api/_search-lkg-runtime.js
//
// Constructs the persistent Search LKG runtime.
//
// Safety properties:
// - Runtime config is evaluated before any Firebase adapter/repository exists.
// - When persistence is disabled/blocked, repository is null.
// - Construction itself performs no network or database access.
// - Concrete storage operations happen only when repository methods are called.

import { getSearchLkgConfig } from './_search-lkg-config.js';
import { createFirebaseSearchLkgStorage } from './_search-lkg-firebase.js';
import { createSearchLkgRepository } from './_search-lkg-repository.js';

export function createSearchLkgRuntime({
  env = process.env,
  dbUrl = null,
  tokenProvider,
  fetchImpl = globalThis.fetch,
  configProvider = getSearchLkgConfig,
} = {}) {
  const config = configProvider(env);

  if (!config?.enabled) {
    return {
      enabled: false,
      ttlMs: null,
      repository: null,
      reason:
        config?.blockedByApprovalGate === true
          ? 'approval_gate'
          : config?.error || 'disabled',
    };
  }

  if (!dbUrl) {
    return {
      enabled: false,
      ttlMs: null,
      repository: null,
      reason: 'missing_db_url',
    };
  }

  const storage = createFirebaseSearchLkgStorage({
    dbUrl,
    tokenProvider,
    fetchImpl,
  });

  const repository = createSearchLkgRepository({
    read: storage.read,
    write: storage.write,
    remove: storage.remove,
  });

  return {
    enabled: true,
    ttlMs: config.ttlMs,
    repository,
    reason: null,
  };
}

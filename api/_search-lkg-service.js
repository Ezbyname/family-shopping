// api/_search-lkg-service.js
//
// Orchestrates LKG repository + pure decision logic.
// Storage backend is injected through the repository.
// No Firebase-specific behavior exists here.

import { decideSearchLkg } from './_search-lkg.js';
import { LKG_REPOSITORY_STATUS } from './_search-lkg-repository.js';

export async function resolveSearchWithLkg({
  repository,
  key,
  current,
  ttlMs,
  now = Date.now(),
}) {
  if (!repository) {
    throw new Error('repository required');
  }

  const cachedResult = await repository.get(key);

  const cached =
    cachedResult.status === LKG_REPOSITORY_STATUS.HIT
      ? cachedResult.record
      : null;

  const decision = decideSearchLkg({
    current,
    cached,
    now,
    ttlMs,
  });

  let mutationStatus = 'none';

  if (decision.cacheAction === 'write') {
    const result = await repository.put(
      key,
      decision.products,
      now
    );

    mutationStatus = result.status;
  }

  if (decision.cacheAction === 'write_zero') {
    const result = await repository.putZero(key, now);
    mutationStatus = result.status;
  }

  return {
    ...decision,
    repositoryReadStatus: cachedResult.status,
    mutationStatus,
  };
}

// api/_search-lkg-firebase.js
//
// Firebase RTDB adapter for Search Last-Known-Good storage.
//
// IMPORTANT:
// - This module does not run by itself.
// - It performs no work until its returned functions are called.
// - Main Search is NOT wired to this adapter yet.
// - Tests inject mocked fetch/token providers.
//
// Storage path:
//   searchLkg/{versioned-key}
//
// Record shape:
//   {
//     products: [...],
//     savedAt: <epoch-ms>
//   }

const DEFAULT_TIMEOUT_MS = 5_000;
const ROOT_PATH = 'searchLkg';

function assertDbUrl(dbUrl) {
  if (!dbUrl || typeof dbUrl !== 'string') {
    throw new Error('Firebase dbUrl required');
  }
}

function assertKey(key) {
  if (!/^v1_[a-f0-9]{64}$/.test(String(key || ''))) {
    throw new Error('invalid LKG key');
  }
}

function buildUrl(dbUrl, key, token) {
  assertDbUrl(dbUrl);
  assertKey(key);

  const base = dbUrl.replace(/\/$/, '');
  const auth = token
    ? `?access_token=${encodeURIComponent(token)}`
    : '';

  return `${base}/${ROOT_PATH}/${key}.json${auth}`;
}

async function getToken(tokenProvider) {
  if (typeof tokenProvider !== 'function') return null;
  return await tokenProvider();
}

export function createFirebaseSearchLkgStorage({
  dbUrl,
  tokenProvider,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  assertDbUrl(dbUrl);

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation required');
  }

  return {
    async read(key) {
      const token = await getToken(tokenProvider);
      const url = buildUrl(dbUrl, key, token);

      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Firebase LKG GET HTTP ${response.status}`);
      }

      return await response.json();
    },

    async write(key, record) {
      const token = await getToken(tokenProvider);
      const url = buildUrl(dbUrl, key, token);

      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Firebase LKG PUT HTTP ${response.status}`);
      }
    },

    async remove(key) {
      const token = await getToken(tokenProvider);
      const url = buildUrl(dbUrl, key, token);

      const response = await fetchImpl(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Firebase LKG DELETE HTTP ${response.status}`);
      }
    },
  };
}

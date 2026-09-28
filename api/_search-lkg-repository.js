// api/_search-lkg-repository.js
//
// Storage-agnostic Last-Known-Good repository.
//
// This module does NOT know about Firebase, Redis, Vercel or any other backend.
// A concrete backend is injected through read/write/remove functions.
//
// Read contract:
//   hit         -> valid stored LKG
//   miss        -> no stored value
//   invalid     -> stored value exists but is not a valid LKG record
//   unavailable -> backend read failed
//
// Mutation contract:
//   ok          -> mutation completed
//   unavailable -> backend mutation failed

export const LKG_REPOSITORY_STATUS = {
  HIT: 'hit',
  MISS: 'miss',
  INVALID: 'invalid',
  OK: 'ok',
  UNAVAILABLE: 'unavailable',
};

function assertKey(key) {
  if (!/^v1_[a-f0-9]{64}$/.test(String(key || ''))) {
    throw new Error('invalid LKG key');
  }
}

export function isValidLkgRecord(record) {
  if (
    !record ||
    typeof record !== 'object' ||
    !Array.isArray(record.products) ||
    !Number.isFinite(record.savedAt)
  ) {
    return false;
  }

  if (record.state === 'good') {
    return record.products.length > 0;
  }

  if (record.state === 'zero') {
    return record.products.length === 0;
  }

  return false;
}

export function createSearchLkgRepository({
  read,
  write,
  remove,
}) {
  if (typeof read !== 'function') {
    throw new Error('read function required');
  }

  if (typeof write !== 'function') {
    throw new Error('write function required');
  }

  if (typeof remove !== 'function') {
    throw new Error('remove function required');
  }

  return {
    async get(key) {
      assertKey(key);

      try {
        const record = await read(key);

        if (record === null || record === undefined) {
          return {
            status: LKG_REPOSITORY_STATUS.MISS,
            record: null,
            error: null,
          };
        }

        if (!isValidLkgRecord(record)) {
          return {
            status: LKG_REPOSITORY_STATUS.INVALID,
            record: null,
            error: 'lkg_invalid_record',
          };
        }

        return {
          status: LKG_REPOSITORY_STATUS.HIT,
          record,
          error: null,
        };
      } catch (_) {
        return {
          status: LKG_REPOSITORY_STATUS.UNAVAILABLE,
          record: null,
          error: 'lkg_read_failed',
        };
      }
    },

    async put(key, products, savedAt = Date.now()) {
      assertKey(key);

      const record = {
        state: 'good',
        products,
        savedAt,
      };

      if (!isValidLkgRecord(record)) {
        throw new Error('invalid LKG record');
      }

      try {
        await write(key, record);

        return {
          status: LKG_REPOSITORY_STATUS.OK,
          error: null,
        };
      } catch (_) {
        return {
          status: LKG_REPOSITORY_STATUS.UNAVAILABLE,
          error: 'lkg_write_failed',
        };
      }
    },

    async putZero(key, savedAt = Date.now()) {
      assertKey(key);

      const record = {
        state: 'zero',
        products: [],
        savedAt,
      };

      try {
        await write(key, record);

        return {
          status: LKG_REPOSITORY_STATUS.OK,
          error: null,
        };
      } catch (_) {
        return {
          status: LKG_REPOSITORY_STATUS.UNAVAILABLE,
          error: 'lkg_write_zero_failed',
        };
      }
    },

    async clear(key) {
      assertKey(key);

      try {
        await remove(key);

        return {
          status: LKG_REPOSITORY_STATUS.OK,
          error: null,
        };
      } catch (_) {
        return {
          status: LKG_REPOSITORY_STATUS.UNAVAILABLE,
          error: 'lkg_clear_failed',
        };
      }
    },
  };
}

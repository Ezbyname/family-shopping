import {
  createSearchLkgRepository,
  LKG_REPOSITORY_STATUS,
} from '../api/_search-lkg-repository.js';

let passed = 0;
let failed = 0;

function ok(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function equal(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected));

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error('    actual:  ', JSON.stringify(actual));
    console.error('    expected:', JSON.stringify(expected));
  }
}

const KEY = `v1_${'a'.repeat(64)}`;
const PRODUCTS = [
  { barcode: '7290000000001', name: 'Black Coffee' },
];

function makeMemoryRepository() {
  const map = new Map();

  const repo = createSearchLkgRepository({
    read: async key => map.get(key) ?? null,
    write: async (key, value) => {
      map.set(key, value);
    },
    remove: async key => {
      map.delete(key);
    },
  });

  return { repo, map };
}

console.log('\n── Search LKG repository contract ──');

{
  const { repo } = makeMemoryRepository();

  const result = await repo.get(KEY);

  equal(
    '1. missing key returns miss',
    result,
    {
      status: LKG_REPOSITORY_STATUS.MISS,
      record: null,
      error: null,
    }
  );
}

{
  const { repo } = makeMemoryRepository();

  const put = await repo.put(KEY, PRODUCTS, 12345);

  equal(
    '2. valid record writes successfully',
    put,
    {
      status: LKG_REPOSITORY_STATUS.OK,
      error: null,
    }
  );

  const get = await repo.get(KEY);

  equal(
    '3. written record can be read back',
    get,
    {
      status: LKG_REPOSITORY_STATUS.HIT,
      record: {
        state: 'good',
        products: PRODUCTS,
        savedAt: 12345,
      },
      error: null,
    }
  );
}

{
  const { repo } = makeMemoryRepository();

  await repo.put(KEY, PRODUCTS, 12345);
  const clear = await repo.clear(KEY);

  equal(
    '4. clear succeeds',
    clear,
    {
      status: LKG_REPOSITORY_STATUS.OK,
      error: null,
    }
  );

  const get = await repo.get(KEY);

  ok(
    '5. cleared record becomes miss',
    get.status === LKG_REPOSITORY_STATUS.MISS
  );
}

{
  const { repo } = makeMemoryRepository();

  const putZero = await repo.putZero(KEY, 23456);

  equal(
    '6. authoritative zero tombstone writes successfully',
    putZero,
    {
      status: LKG_REPOSITORY_STATUS.OK,
      error: null,
    }
  );

  const get = await repo.get(KEY);

  equal(
    '7. zero tombstone is a valid stored record',
    get,
    {
      status: LKG_REPOSITORY_STATUS.HIT,
      record: {
        state: 'zero',
        products: [],
        savedAt: 23456,
      },
      error: null,
    }
  );
}

{
  const repo = createSearchLkgRepository({
    read: async () => ({
      products: [],
      savedAt: 12345,
    }),
    write: async () => {},
    remove: async () => {},
  });

  const get = await repo.get(KEY);

  equal(
    '8. invalid stored record is bounded',
    get,
    {
      status: LKG_REPOSITORY_STATUS.INVALID,
      record: null,
      error: 'lkg_invalid_record',
    }
  );
}

{
  const repo = createSearchLkgRepository({
    read: async () => {
      throw new Error('backend down');
    },
    write: async () => {
      throw new Error('backend down');
    },
    remove: async () => {
      throw new Error('backend down');
    },
  });

  equal(
    '9. read failure returns unavailable',
    await repo.get(KEY),
    {
      status: LKG_REPOSITORY_STATUS.UNAVAILABLE,
      record: null,
      error: 'lkg_read_failed',
    }
  );

  equal(
    '10. write failure returns unavailable',
    await repo.put(KEY, PRODUCTS, 12345),
    {
      status: LKG_REPOSITORY_STATUS.UNAVAILABLE,
      error: 'lkg_write_failed',
    }
  );

  equal(
    '11. clear failure returns unavailable',
    await repo.clear(KEY),
    {
      status: LKG_REPOSITORY_STATUS.UNAVAILABLE,
      error: 'lkg_clear_failed',
    }
  );
}

{
  const { repo } = makeMemoryRepository();

  let rejected = false;

  try {
    await repo.get('not-a-valid-key');
  } catch (_) {
    rejected = true;
  }

  ok('12. malformed key is rejected', rejected);
}

console.log(
  `\nsearch-lkg-repository: ${passed} passed, ${failed} failed`
);

if (failed > 0) {
  process.exit(1);
}

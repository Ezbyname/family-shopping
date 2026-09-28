import {
  fetchOffBatch,
  OFF_ERR,
} from '../api/_openfoodfacts.js';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}`);
    console.error('    actual:  ', actual);
    console.error('    expected:', expected);
    failed++;
  }
}

const originalFetch = globalThis.fetch;

console.log('\n── OpenFoodFacts bounded 5xx retry ──');

try {
  // ----------------------------------------------------------
  // 1. 5xx -> retry -> success
  // ----------------------------------------------------------
  {
    let calls = 0;

    globalThis.fetch = async () => {
      calls++;

      if (calls === 1) {
        return {
          ok: false,
          status: 503,
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          products: [{ code: '123', product_name: 'Milk' }],
        }),
      };
    };

    const result = await fetchOffBatch(
      'translated_broad',
      'https://example.test/off'
    );

    eq(
      '1. first 5xx is retried exactly once',
      calls,
      2
    );

    eq(
      '2. retry success clears error',
      result.error,
      null
    );

    eq(
      '3. retry success preserves products',
      result.products.length,
      1
    );
  }

  // ----------------------------------------------------------
  // 2. 5xx -> retry -> 5xx
  // ----------------------------------------------------------
  {
    let calls = 0;

    globalThis.fetch = async () => {
      calls++;

      return {
        ok: false,
        status: 503,
      };
    };

    const result = await fetchOffBatch(
      'translated_broad',
      'https://example.test/off'
    );

    eq(
      '4. persistent 5xx is attempted only twice',
      calls,
      2
    );

    eq(
      '5. persistent 5xx remains bounded off_http_5xx',
      result.error,
      OFF_ERR.HTTP_5XX
    );
  }

  // ----------------------------------------------------------
  // 3. 4xx -> no retry
  // ----------------------------------------------------------
  {
    let calls = 0;

    globalThis.fetch = async () => {
      calls++;

      return {
        ok: false,
        status: 404,
      };
    };

    const result = await fetchOffBatch(
      'translated_broad',
      'https://example.test/off'
    );

    eq(
      '6. 4xx is not retried',
      calls,
      1
    );

    eq(
      '7. 4xx classification is preserved',
      result.error,
      OFF_ERR.HTTP_4XX
    );
  }

  // ----------------------------------------------------------
  // 4. timeout -> no retry
  // ----------------------------------------------------------
  {
    let calls = 0;

    globalThis.fetch = async () => {
      calls++;

      throw Object.assign(
        new Error('timeout'),
        { name: 'TimeoutError' }
      );
    };

    const result = await fetchOffBatch(
      'translated_broad',
      'https://example.test/off'
    );

    eq(
      '8. timeout is not retried',
      calls,
      1
    );

    eq(
      '9. timeout classification is preserved',
      result.error,
      OFF_ERR.TIMEOUT
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(
  `\noff-retry: ${passed} passed, ${failed} failed`
);

if (failed > 0) process.exit(1);

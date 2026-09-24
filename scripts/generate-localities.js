// Generates the static Israeli locality map used by the price worker.
//
// Source of truth:
// data.gov.il — "יישובים בישראל - קובצי יישובים (2023)"
// Resource: d47a54ff-87f0-44b3-b33a-f284c0c38e5a
//
// Runtime code must use the generated static artifact and must NOT depend
// on data.gov.il being reachable.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOURCE_ID = 'd47a54ff-87f0-44b3-b33a-f284c0c38e5a';
const EXPECTED_TOTAL = 1484;
const PAGE_SIZE = 500;

const CODE_FIELD = 'סמל יישוב';
const NAME_FIELD = 'שם יישוב';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_FILE = path.resolve(
  __dirname,
  '../workers/prices/data/localities-2023.js',
);

function normalizeCode(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeName(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

async function fetchPage(offset) {
  const url = new URL('https://data.gov.il/api/3/action/datastore_search');
  url.searchParams.set('resource_id', RESOURCE_ID);
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(offset));

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    headers: {
      accept: 'application/json',
      'user-agent': 'family-shopping-locality-generator/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`data.gov.il HTTP ${response.status}`);
  }

  const body = await response.json();

  if (!body?.success || !body?.result) {
    throw new Error('data.gov.il returned an unsuccessful response');
  }

  return body.result;
}

function assertKnownMappings(localities) {
  const expected = new Map([
    ['5000', 'תל אביב -יפו'],
    ['3000', 'ירושלים'],
    ['6300', 'גבעתיים'],
    ['7700', 'עפולה'],
    ['2600', 'אילת'],
    ['7900', 'פתח תקווה'],
    ['6900', 'כפר סבא'],
    ['8700', 'רעננה'],
    ['1139', 'כרמיאל'],
    ['31', 'אופקים'],
  ]);

  for (const [code, expectedName] of expected) {
    const actual = localities.get(code);
    if (actual !== expectedName) {
      throw new Error(
        `Known mapping mismatch for ${code}: expected ${JSON.stringify(expectedName)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  const expectedUnresolved = [
    '0',
    '50',
    '1306',
    '10018',
    '10044',
    '10098',
  ];

  for (const code of expectedUnresolved) {
    if (localities.has(code)) {
      throw new Error(
        `Expected unresolved locality code ${code} unexpectedly exists in official dataset`,
      );
    }
  }
}

async function main() {
  const first = await fetchPage(0);

  const fields = new Set((first.fields || []).map(field => field.id));

  if (!fields.has(CODE_FIELD)) {
    throw new Error(`Missing required field: ${CODE_FIELD}`);
  }

  if (!fields.has(NAME_FIELD)) {
    throw new Error(`Missing required field: ${NAME_FIELD}`);
  }

  if (first.total !== EXPECTED_TOTAL) {
    throw new Error(
      `Unexpected source record count: expected ${EXPECTED_TOTAL}, got ${first.total}`,
    );
  }

  const records = [...(first.records || [])];

  for (let offset = records.length; offset < first.total; offset += PAGE_SIZE) {
    const page = await fetchPage(offset);
    records.push(...(page.records || []));
  }

  if (records.length !== EXPECTED_TOTAL) {
    throw new Error(
      `Fetch count mismatch: expected ${EXPECTED_TOTAL}, got ${records.length}`,
    );
  }

  const localities = new Map();

  for (const record of records) {
    const code = normalizeCode(record[CODE_FIELD]);
    const name = normalizeName(record[NAME_FIELD]);

    if (!code || !name) {
      throw new Error(
        `Invalid locality record: code=${JSON.stringify(code)}, name=${JSON.stringify(name)}`,
      );
    }

    if (localities.has(code)) {
      throw new Error(`Duplicate locality code in official dataset: ${code}`);
    }

    localities.set(code, name);
  }

  if (localities.size !== EXPECTED_TOTAL) {
    throw new Error(
      `Map size mismatch: expected ${EXPECTED_TOTAL}, got ${localities.size}`,
    );
  }

  assertKnownMappings(localities);

  const entries = [...localities.entries()].sort((a, b) => {
    const aNum = Number(a[0]);
    const bNum = Number(b[0]);

    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
      return aNum - bNum;
    }

    return a[0].localeCompare(b[0], 'en');
  });

  const generated =
`// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
// Source: data.gov.il
// Dataset: יישובים בישראל - קובצי יישובים (2023)
// Resource ID: ${RESOURCE_ID}
// Records: ${EXPECTED_TOTAL}

export const LOCALITIES_2023_RESOURCE_ID = ${JSON.stringify(RESOURCE_ID)};

export const LOCALITIES_2023 = new Map([
${entries.map(([code, name]) => `  [${JSON.stringify(code)}, ${JSON.stringify(name)}],`).join('\n')}
]);

export default LOCALITIES_2023;
`;

  await fs.writeFile(OUTPUT_FILE, generated, 'utf8');

  console.log(`Source records: ${records.length}`);
  console.log(`Map entries: ${localities.size}`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log('Known mappings: PASS');
  console.log('Known unresolved codes: PASS');
}

main().catch(error => {
  console.error(`Generation failed: ${error.message}`);
  process.exitCode = 1;
});

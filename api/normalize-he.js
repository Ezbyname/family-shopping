// api/normalize-he.js — Hebrew ingredient normalization pipeline
//
// Pipeline (applied in order):
//   1. Whitespace cleanup
//   2. Quote / apostrophe normalization  ׳ ״ ' " → stripped
//   3. Hebrew plural suffix stripping    validated against CATALOG only
//
// Lookup order (exported as `translateIngredient`):
//   1. normalizedInput → CATALOG exact
//   2. normalizedInput → SYNONYMS → CATALOG
//   3. phrase substring scan on CATALOG keys (longest key wins)
//   4. word-level singular suffix strip → CATALOG (safe: no free-form stems)
//   Returns null if none match.

import { CATALOG, SYNONYMS } from './ingredients.js';

// ── Step 1-2: surface normalization (no semantic changes) ─────────────────────
export function normalizeHe(s) {
  if (!s) return '';
  let t = String(s).trim();
  // Unify apostrophe-like characters: ׳ ʼ ' ` → nothing (they modify letters: ג׳ → גʼ kept as-is by design)
  // We keep the modified letter but drop standalone decorative quotes
  t = t.replace(/״/g, '').replace(/"/g, '').replace(/"/g, '');
  // Collapse internal whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// Hebrew plural suffixes to try, longest first to avoid prefix collisions
const PLURAL_SUFFIXES = ['יות', 'יים', 'ות', 'ים', 'י', 'ת'];

// ── Step 3: dictionary-backed singular lookup ─────────────────────────────────
// Returns the English value from CATALOG if stripping a known plural suffix from
// ANY word in the phrase produces a key that exists in CATALOG.
// Never returns a raw generated stem — if the stem isn't in CATALOG, returns null.
function singularScan(normalized) {
  for (const word of normalized.split(' ')) {
    if (word.length < 3) continue;
    for (const sfx of PLURAL_SUFFIXES) {
      if (word.length > sfx.length + 2 && word.endsWith(sfx)) {
        const stem = word.slice(0, -sfx.length);
        if (CATALOG.has(stem)) return CATALOG.get(stem);
      }
    }
  }
  return null;
}

// ── Phrase substring scan ─────────────────────────────────────────────────────
// Find the longest CATALOG key that appears as a substring of the query.
// Longest-match prevents "שמן" from winning over "שמן זית".
function phraseScan(normalized) {
  let best = null, bestLen = 0;
  for (const [key, en] of CATALOG) {
    if (normalized.includes(key) && key.length > bestLen) {
      best = en;
      bestLen = key.length;
    }
  }
  return best;
}

// ── Main translate function ───────────────────────────────────────────────────
// Accepts raw Hebrew query, applies full pipeline, returns English string or null.
export function translateIngredient(raw) {
  const n = normalizeHe(raw);
  if (!n) return null;

  // 1. Exact canonical match
  const exact = CATALOG.get(n);
  if (exact) return exact;

  // 2. Synonym → canonical → english
  const synKey = SYNONYMS.get(n);
  if (synKey) {
    const synEn = CATALOG.get(synKey);
    if (synEn) return synEn;
  }

  // 3. Phrase substring (longest CATALOG key present in query)
  const phrase = phraseScan(n);
  if (phrase) return phrase;

  // 4. Word-level singular suffix stripping (dictionary-backed only)
  const singular = singularScan(n);
  if (singular) return singular;

  return null;
}

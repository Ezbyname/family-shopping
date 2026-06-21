// api/normalize-he.js — Hebrew ingredient normalization pipeline
//
// Surface normalization:
//   1. Whitespace cleanup
//   2. ״ / " / " stripped (decorative quotes, not ׳ which modifies letters like ג׳)
//
// Lookup order (translateIngredient):
//   1. exact  → CATALOG
//   2. synonym → SYNONYMS → CATALOG
//   3. phrase  → contiguous-token scan on CATALOG keys, longest match wins
//              ("מיץ תפוזים" matches before "מיץ"; "שמן זית" before "שמן")
//   4. plural  → per-word suffix strip, stem must exist in CATALOG (safe, no garbage stems)
//
// Why phrase before plural:
//   "מיץ תפוזים" must not singularize "תפוזים"→"תפוז" before the phrase is matched,
//   or we'd return "orange" instead of "orange juice".
//
// Why token-sequence (not substring) for phrase scan:
//   Substring matching caused "אגסים".includes("אגס")=true to shadow the
//   plural-strip path for ALL single-word plurals, making plural strip unreachable.
//   Token-sequence matching only fires when a catalog key aligns on word boundaries,
//   so "אגסים" (one token) cannot match the two-token key "... ..." or the
//   one-token key "אגס" (different string).

import { CATALOG, SYNONYMS } from './ingredients.js';

// ── Surface normalization ─────────────────────────────────────────────────────
// Strips decorative quotes/apostrophes that appear in product names:
//   ״  (U+05F4 Hebrew double punctuation)
//   "  " (typographic double quotes)
//   '  ' (typographic single quotes)
//   '  (ASCII apostrophe) — e.g. "קוטג'" colloquial spelling
// Does NOT strip ׳ (U+05F3 Hebrew geresh) when embedded mid-word (ג׳ = "j" sound).
// Trailing geresh (decorative, not phonetic) is handled by SYNONYMS entries.
export function normalizeHe(s) {
  if (!s) return '';
  let t = String(s).trim();
  t = t.replace(/[״""'']/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

// ── Exported internals (for unit testing) ────────────────────────────────────
export const PLURAL_SUFFIXES = ['יות', 'יים', 'ות', 'ים', 'י', 'ת'];

// After stripping a plural suffix, the last letter of the stem is often a
// regular form (e.g. נ U+05E0) that the CATALOG stores as a final form (ן U+05DF).
// This map converts regular → final so CATALOG.has(stem) succeeds.
const TO_FINAL = new Map([
  ['כ', 'ך'],  // כ → ך
  ['מ', 'ם'],  // מ → ם
  ['נ', 'ן'],  // נ → ן
  ['פ', 'ף'],  // פ → ף
  ['צ', 'ץ'],  // צ → ץ
]);

// Contiguous-token phrase scan.
// Splits normalized query into words, then checks every contiguous sub-sequence
// against CATALOG. Returns the English value for the longest matching key.
export function phraseScan(normalized) {
  const words = normalized.split(' ');
  let best = null, bestLen = 0;
  // Try all sub-sequences from longest to shortest for early exit on ties
  for (let len = words.length; len >= 1; len--) {
    for (let start = 0; start <= words.length - len; start++) {
      const candidate = words.slice(start, start + len).join(' ');
      if (candidate.length > bestLen && CATALOG.has(candidate)) {
        best = CATALOG.get(candidate);
        bestLen = candidate.length;
      }
    }
  }
  return best;
}

// Per-word plural suffix strip. Returns English value for the first word whose
// de-suffixed stem exists in CATALOG. Never returns a stem not in CATALOG.
// Tries both the raw stem and a final-letter-corrected stem, because Hebrew
// plurals strip the final form of the last consonant (דובדבנים → stem "דובדבנ"
// with regular נ, but CATALOG stores "דובדבן" with final ן).
export function singularScan(normalized) {
  for (const word of normalized.split(' ')) {
    if (word.length < 3) continue;
    for (const sfx of PLURAL_SUFFIXES) {
      if (word.length > sfx.length + 2 && word.endsWith(sfx)) {
        const stem = word.slice(0, -sfx.length);
        if (CATALOG.has(stem)) return CATALOG.get(stem);
        // Try with final-letter correction on last character
        const lastChar = stem[stem.length - 1];
        const finalChar = TO_FINAL.get(lastChar);
        if (finalChar) {
          const stemFinal = stem.slice(0, -1) + finalChar;
          if (CATALOG.has(stemFinal)) return CATALOG.get(stemFinal);
        }
      }
    }
  }
  return null;
}

// ── Main entry point ─────────────────────────────────────────────────────────
export function translateIngredient(raw) {
  const n = normalizeHe(raw);
  if (!n) return null;

  // 1. Exact
  const exact = CATALOG.get(n);
  if (exact) return exact;

  // 2. Synonym
  const synKey = SYNONYMS.get(n);
  if (synKey) {
    const synEn = CATALOG.get(synKey);
    if (synEn) return synEn;
  }

  // 3. Phrase (token-sequence, longest match, word-boundary safe)
  const phrase = phraseScan(n);
  if (phrase) return phrase;

  // 4. Plural strip (dictionary-backed, safe)
  return singularScan(n);
}

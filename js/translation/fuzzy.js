// js/translation/fuzzy.js
// Layer 2: Lightweight fuzzy matching — pure JS, zero dependencies
// Handles spelling mistakes, partial words, singular/plural, Hebrew variations

import { GLOBAL_DICTIONARY } from './dictionary.js';

const CONFIDENCE_THRESHOLD = 0.55; // minimum score to suggest a match

// Hebrew normalization: handle common spelling variations
function normalizeHebrew(str) {
  return str
    .trim()
    .toLowerCase()
    // ו variations
    .replace(/וו/g, 'ו')
    // י variations
    .replace(/יי/g, 'י')
    // final letters → regular (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ)
    .replace(/ך/g, 'כ')
    .replace(/ם/g, 'מ')
    .replace(/ן/g, 'נ')
    .replace(/ף/g, 'פ')
    .replace(/ץ/g, 'צ')
    // remove niqqud (vowel marks)
    .replace(/[\u05B0-\u05C7]/g, '')
    // normalize apostrophes
    .replace(/[''`]/g, "'");
}

// Levenshtein distance — edit distance between two strings
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Token overlap score — how many words match
function tokenOverlap(a, b) {
  const ta = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const tb = new Set(b.split(/\s+/).filter(w => w.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter(w => tb.has(w)).length;
  return inter / Math.max(ta.size, tb.size);
}

// Combined confidence score
function scoreMatch(query, dictKey) {
  const qNorm = normalizeHebrew(query);
  const kNorm = normalizeHebrew(dictKey);

  // Exact match after normalization
  if (qNorm === kNorm) return 1.0;

  // Contains match
  if (kNorm.includes(qNorm) || qNorm.includes(kNorm)) {
    return 0.85;
  }

  // Token overlap
  const tokenScore = tokenOverlap(qNorm, kNorm);

  // Edit distance score (normalized)
  const maxLen = Math.max(qNorm.length, kNorm.length);
  const editScore = maxLen > 0 ? 1 - (levenshtein(qNorm, kNorm) / maxLen) : 0;

  // Weighted combination
  return (tokenScore * 0.6) + (editScore * 0.4);
}

export function fuzzyMatch(hebrewQuery, userDict = {}) {
  const allEntries = {
    ...GLOBAL_DICTIONARY,
    ...userDict, // user dict overlaps with higher priority
  };

  const results = Object.entries(allEntries)
    .map(([key, value]) => ({
      hebrewKey: key,
      englishValue: value,
      confidence: scoreMatch(hebrewQuery, key),
    }))
    .filter(r => r.confidence >= CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  return results;
  // Returns: [{ hebrewKey, englishValue, confidence }]
}
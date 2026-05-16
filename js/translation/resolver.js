// js/translation/resolver.js
// Main pipeline: User Dict → Global Dict → Fuzzy → AI → User Confirmation
// Returns a resolved English term or triggers UI confirmation flow

import { lookupDictionary } from './dictionary.js';
import { fuzzyMatch } from './fuzzy.js';
import { getAISuggestions } from './aiResolver.js';
import { getCachedDict, saveUserMapping, addToCache } from './memory.js';

function isHebrew(str) { return /[\u0590-\u05FF]/.test(str); }

// ── MAIN RESOLVE FUNCTION ──
// Returns: { resolved: 'english term' } immediately
//      OR: { needsConfirmation: true, suggestions: [...], originalTerm: '...' }
export async function resolveProductTerm(hebrewTerm) {
  if (!isHebrew(hebrewTerm)) {
    // Already English — use as-is
    return { resolved: hebrewTerm, source: 'passthrough' };
  }

  const userDict = getCachedDict();

  // ── LAYER 1: Exact dictionary lookup ──
  const exact = lookupDictionary(hebrewTerm, userDict);
  if (exact.found) {
    console.log(`[L1] Exact match: "${hebrewTerm}" → "${exact.result}" (${exact.source})`);
    return { resolved: exact.result, source: exact.source };
  }

  // ── LAYER 2: Fuzzy matching ──
  const fuzzyResults = fuzzyMatch(hebrewTerm, userDict);
  if (fuzzyResults.length > 0) {
    const best = fuzzyResults[0];
    // High confidence → auto-resolve
    if (best.confidence >= 0.88) {
      console.log(`[L2] Auto-resolved: "${hebrewTerm}" → "${best.englishValue}" (${best.confidence.toFixed(2)})`);
      return { resolved: best.englishValue, source: 'fuzzy', confidence: best.confidence };
    }
    // Medium confidence → show to user as suggestions
    console.log(`[L2] Fuzzy suggestions for "${hebrewTerm}":`, fuzzyResults.map(r => r.englishValue));
    return {
      needsConfirmation: true,
      originalTerm: hebrewTerm,
      suggestions: fuzzyResults.map(r => ({
        label: r.englishValue,
        confidence: r.confidence,
        source: 'fuzzy',
      })),
    };
  }

  // ── LAYER 3: AI fallback ──
  console.log(`[L3] No match found, calling AI for: "${hebrewTerm}"`);
  const aiResult = await getAISuggestions(hebrewTerm);

  if (aiResult.success && aiResult.suggestions.length > 0) {
    return {
      needsConfirmation: true,
      originalTerm: hebrewTerm,
      suggestions: aiResult.suggestions.map(s => ({
        label: s,
        confidence: null,
        source: 'ai',
      })),
    };
  }

  // ── LAYER 4: Complete failure → manual entry ──
  return {
    needsConfirmation: true,
    originalTerm: hebrewTerm,
    suggestions: [],
    manualOnly: true,
  };
}

// Called when user confirms a suggestion or enters manually
export async function confirmResolution(hebrewTerm, englishTerm) {
  addToCache(hebrewTerm, englishTerm);
  await saveUserMapping(hebrewTerm, englishTerm);
  console.log(`[Memory] Saved: "${hebrewTerm}" → "${englishTerm}"`);
  return englishTerm;
}
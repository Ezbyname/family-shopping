// js/bp-strict.js
// Pure strict-candidate selection for Product Picker.
// No DOM, Firebase, network, or app.js globals.

function hebrewStrictMatch(field, queryTokens) {
  if (!field) return false;

  const fieldTokens = String(field).toLowerCase().split(/\s+/).filter(Boolean);
  const lead = queryTokens.slice(0, -1);
  const last = queryTokens[queryTokens.length - 1];

  return lead.every(t => fieldTokens.some(ft => ft === t)) &&
         fieldTokens.some(ft => ft.startsWith(last));
}

function englishTokens(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function englishTokenMatch(queryToken, candidateToken) {
  if (queryToken === candidateToken) return true;

  // Small morphology tolerance:
  // tomato <-> tomatoes, product <-> products, etc.
  return queryToken.length >= 4 &&
         candidateToken.length >= 4 &&
         (queryToken.startsWith(candidateToken) ||
          candidateToken.startsWith(queryToken));
}

function translatedStrictMatch(nameEn, enQuery) {
  const qTokens = [...new Set(englishTokens(enQuery))];
  const nTokens = [...new Set(englishTokens(nameEn))];

  // Safety gate: a broad one-word translation is not specific enough
  // to replace a 2+ token Hebrew query.
  if (qTokens.length < 2 || !nTokens.length) return false;

  const allQueryTokensMatch = qTokens.every(qt =>
    nTokens.some(nt => englishTokenMatch(qt, nt))
  );

  if (!allQueryTokensMatch) return false;

  // Keep the translated fallback narrow:
  // query + at most one descriptive token.
  // "Italian Cherry Tomatoes" -> allowed
  // "Mozzarella Semi Dried Cherry Tomato Pizza" -> rejected
  if (nTokens.length > qTokens.length + 1) return false;

  return true;
}

export function bpSelectStrictCandidates(eligible, {
  queryLang,
  normQ,
  enQuery,
} = {}) {
  if (queryLang !== 'he') {
    return { used: false, mode: null, candidates: [] };
  }

  const heTokens = String(normQ || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (heTokens.length < 2) {
    return { used: false, mode: null, candidates: [] };
  }

  const hebrew = eligible.filter(p =>
    hebrewStrictMatch(p.name, heTokens) ||
    hebrewStrictMatch(p.nameHe, heTokens)
  );

  if (hebrew.length) {
    return { used: true, mode: 'hebrew', candidates: hebrew };
  }

  const translated = eligible.filter(p =>
    translatedStrictMatch(p.nameEn, enQuery)
  );

  if (translated.length) {
    return { used: true, mode: 'translated', candidates: translated };
  }

  return { used: true, mode: 'empty', candidates: [] };
}

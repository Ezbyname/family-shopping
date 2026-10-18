// js/bp-strict.js
// Pure strict-candidate selection for Product Picker.
// No DOM, Firebase, network, or app.js globals.

import { IL_BRAND_TOKENS, bpCategoryMatches, bpEnglishParts } from './bp-intent.js';

const NUMERIC_TOKEN = /^[\d.,]+%?$/;

function nameTokens(field) {
  return String(field || '').toLowerCase().replace(/['"׳״`´]/g, '').split(/\s+/).filter(Boolean);
}

function splitQuery(queryTokens) {
  const core = [], extras = [];
  for (const t of queryTokens) {
    (NUMERIC_TOKEN.test(t) || IL_BRAND_TOKENS.has(t) ? extras : core).push(t);
  }
  return { core, extras };
}

// The product words of the query ("גבינה לבנה") must form ONE phrase in the name, in
// order, with only numbers/percentages allowed in between ("גבינה 5% לבנה").
// A different word right after the head ("גבינה בולגרית לבנה") means a different
// subtype, so it does not match even though both query words appear in the name.
function phraseAt(tokens, start, core) {
  let pos = start;
  for (let k = 0; k < core.length; k++) {
    while (k > 0 && pos < tokens.length && NUMERIC_TOKEN.test(tokens[pos])) pos++;
    const t = tokens[pos];
    if (t === undefined) return false;
    const last = k === core.length - 1;
    if (!(last ? t.startsWith(core[k]) : t === core[k])) return false;
    pos++;
  }
  return true;
}

function hasCorePhrase(tokens, core) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === core[0] || (core.length === 1 && tokens[i].startsWith(core[0]))) {
      if (phraseAt(tokens, i, core)) return true;
    }
  }
  return false;
}

function hebrewStrictMatch(field, queryTokens) {
  if (!field) return false;

  const tokens = nameTokens(field);
  const { core, extras } = splitQuery(queryTokens);
  const lastQ = queryTokens[queryTokens.length - 1];

  // Brand / number filters: exact for inner ones, prefix for the last query token.
  const extrasOk = extras.every(e =>
    e === lastQ ? tokens.some(t => t.startsWith(e)) : tokens.includes(e));
  if (!extrasOk) return false;
  if (!core.length) return true;

  // A single product word plus filters ("חלב 3%") needs no phrase.
  if (core.length === 1) return tokens.some(t => t === core[0] || t.startsWith(core[0]));
  return hasCorePhrase(tokens, core);
}

// Products whose Hebrew name does not mention the head word at all can still belong to
// the subtype through the OFF category taxonomy ("לבנה 5% תנובה" tagged en:white-cheeses).
function taxonomyMatch(p, queryTokens, enQuery) {
  const { core } = splitQuery(queryTokens);
  if (core.length < 2) return false;
  const mentionsHead = [p.name, p.nameHe].some(f => nameTokens(f).includes(core[0]));
  if (mentionsHead) return false; // the name's own wording decides
  const en = bpEnglishParts(enQuery).filter(t => t.length > 1);
  return bpCategoryMatches(p.categories, en);
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

  if (!qTokens.length || !nTokens.length) return false;

  // A one-word English translation can still be authoritative for a
  // multi-word Hebrew query (e.g. "משחת שיניים" -> "toothpaste").
  // Keep this path extremely narrow: only an exact single-token product
  // name may match. This intentionally rejects broader products such as
  // "Instant Coffee" for "קפה שחור" -> "coffee".
  if (qTokens.length === 1) {
    return nTokens.length === 1 &&
           englishTokenMatch(qTokens[0], nTokens[0]);
  }

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
    hebrewStrictMatch(p.nameHe, heTokens) ||
    taxonomyMatch(p, heTokens, enQuery)
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

// js/bp-intent.js
// Query-specificity semantics for the Product Picker. Pure: no DOM, Firebase,
// network, or app.js globals.
//
//   one Hebrew word  ("גבינה")        -> BROAD category: the whole product family
//   two+ Hebrew words ("גבינה לבנה")  -> SPECIFIC intent: handled by bp-strict.js
//
// The family test uses the product's own data only (its names and the Open Food
// Facts category taxonomy tags) — there is no hand-written list of product types.

function hebrewTokens(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['"׳״`´]/g, '')
    .split(/[^֐-׿a-z0-9%]+/)
    .filter(Boolean);
}

// Inflections of a single Hebrew word that still denote the same thing:
//   גבינה -> גבינה, גבינת (construct), גבינות (plural), גבינים
//   חלב   -> חלב, חלבים
// Deliberately NOT a prefix match, so "חלב" never matches "חלבה" or "חלבון".
export function bpHebrewForms(word) {
  const w = hebrewTokens(word).join('');
  if (!w) return new Set();
  const forms = new Set([w]);
  if (/[הת]$/.test(w) && w.length >= 3) {
    const base = w.slice(0, -1);
    forms.add(base + 'ה').add(base + 'ת').add(base + 'ות').add(base + 'ים');
  } else {
    forms.add(w + 'ים').add(w + 'ות');
  }
  return forms;
}

export function bpIsBroadCategoryQuery(normQ, queryLang) {
  if (queryLang !== 'he') return false;
  return hebrewTokens(normQ).length === 1;
}

function englishParts(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^[a-z]{2}:/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function enMatch(queryToken, candidateToken) {
  if (queryToken === candidateToken) return true;
  return queryToken.length >= 4 && candidateToken.length >= 4 &&
         (queryToken.startsWith(candidateToken) || candidateToken.startsWith(queryToken));
}

// OFF taxonomy tags are head-final ("en:cottage-cheeses", "en:white-cheeses"):
// the category IS a kind of its last word. So the query's English head must be the
// tag's last word, and any further query words must appear in the tag.
// "milk-chocolates" is therefore not a kind of milk; "chocolate-milks" is.
function categoryMatches(categories, enTokens) {
  if (!enTokens.length) return false;
  const head = enTokens[enTokens.length - 1];
  const rest = enTokens.slice(0, -1);
  return (categories || []).some(tag => {
    const parts = englishParts(tag);
    if (!parts.length || !enMatch(head, parts[parts.length - 1])) return false;
    return rest.every(t => parts.some(p => enMatch(t, p)));
  });
}

function hebrewNameMatches(name, forms) {
  return hebrewTokens(name).some(t => forms.has(t));
}

export function bpIsInProductFamily(p, { forms, enTokens }) {
  if (hebrewNameMatches(p.name, forms) || hebrewNameMatches(p.nameHe, forms)) return true;
  if (categoryMatches(p.categories, enTokens)) return true;
  // Latin-only names: trust only Israeli products (non-Israeli Latin results are the
  // loose-English noise the picker must not surface for a Hebrew query).
  const hasHebrewName = /[֐-׿]/.test(`${p.name || ''}${p.nameHe || ''}`);
  if (!hasHebrewName && p.isIsraeli && enTokens.length) {
    const nameTokens = englishParts(p.nameEn || p.name);
    const head = enTokens[enTokens.length - 1];
    return enTokens.every(t => nameTokens.some(n => enMatch(t, n))) &&
           nameTokens.some(n => enMatch(head, n));
  }
  return false;
}

// -> { used, candidates }.  used=false means "not a broad query": caller keeps its
// existing path. An empty candidate list also lets the caller keep its existing path.
export function bpSelectBroadCandidates(eligible, { queryLang, normQ, enQuery } = {}) {
  if (!bpIsBroadCategoryQuery(normQ, queryLang)) return { used: false, candidates: [] };
  const forms = bpHebrewForms(normQ);
  const enTokens = englishParts(enQuery).filter(t => t.length > 1);
  const candidates = eligible.filter(p => bpIsInProductFamily(p, { forms, enTokens }));
  return { used: true, candidates };
}

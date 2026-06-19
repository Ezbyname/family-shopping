// 16-search-quality.spec.js — Search ranking regression guard
//
// These tests call the real /api/prices endpoint and assert on result ordering.
// They catch regressions where irrelevant products (score≈0 + isIsraeli bonus)
// leak into the top results because the fallback threshold was too low.
//
// Each test:
//   • Checks that top results contain the query token
//   • Checks that known irrelevant products are NOT in top-3
//
// @critical: "search returns relevant products for common Hebrew queries"

import { test, expect } from './fixtures/test-fixtures.js';

// Queries and their quality contracts
const SEARCH_CASES = [
  {
    query:      'חלב',
    mustMatch:  'חלב',          // top-3 names must contain this
    mustNotTop3: ['cream cheese', 'perly', 'jaouda', 'kri kri'],
  },
  {
    query:      'אורז',
    mustMatch:  'אורז',
    mustNotTop3: ['pasta', 'flour', 'quinoa'],
  },
  {
    query:      "קוטג'",
    mustMatch:  'קוטג',
    mustNotTop3: ['cream cheese', 'butter', 'margarine'],
  },
  {
    query:      'יוגורט',
    mustMatch:  'יוגורט',
    mustNotTop3: ['cream', 'ice cream', 'pudding'],
  },
  {
    query:      'שמן זית',
    mustMatch:  'שמן',
    mustNotTop3: ['butter', 'margarine', 'tahini'],
  },
  {
    query:      'גבינה צהובה',
    mustMatch:  'גבינ',
    mustNotTop3: ['cream cheese', 'chocolate'],
  },
];

test.describe('Search quality — Hebrew query ranking', () => {

  for (const { query, mustMatch, mustNotTop3 } of SEARCH_CASES) {

    test(`"${query}" — top results contain "${mustMatch}" @critical`, async ({ page }) => {
      const res  = await page.request.get(`/api/prices?q=${encodeURIComponent(query)}`);

      // API must respond successfully
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.results)).toBe(true);

      // Must return at least one result
      expect(body.results.length).toBeGreaterThan(0);

      // Top-3 results must all contain the query token in their name
      const top3 = body.results.slice(0, 3);
      const allRelevant = top3.every(p => {
        const name = (p.name || '').toLowerCase();
        return name.includes(mustMatch.toLowerCase());
      });
      expect(allRelevant, `top-3 for "${query}" should all contain "${mustMatch}". Got: ${top3.map(p => p.name).join(', ')}`).toBe(true);
    });

    test(`"${query}" — irrelevant products not in top-3`, async ({ page }) => {
      const res  = await page.request.get(`/api/prices?q=${encodeURIComponent(query)}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      if (!body.results?.length) return; // no results → skip (covered by above test)

      const top3Names = body.results.slice(0, 3).map(p => (p.name || '').toLowerCase());

      for (const forbidden of mustNotTop3) {
        const leaked = top3Names.some(n => n.includes(forbidden.toLowerCase()));
        expect(leaked, `"${forbidden}" should not appear in top-3 for query "${query}". Got: ${top3Names.join(', ')}`).toBe(false);
      }
    });

  }

  test('score=0 products never appear when relevant results exist', async ({ page }) => {
    // "חלב" must return products whose names actually contain "חלב",
    // not products that scored 6 purely from the isIsraeli bonus.
    const res  = await page.request.get('/api/prices?q=%D7%97%D7%9C%D7%91'); // "חלב"
    expect(res.status()).toBe(200);
    const { results } = await res.json();
    if (!results?.length) return;

    // Every result in the top-5 must have a name containing "חלב" OR "milk" OR "dairy"
    const top5 = results.slice(0, 5);
    const DAIRY_TERMS = ['חלב', 'milk', 'dairy', 'לקטוז'];
    for (const p of top5) {
      const name = (p.name || '').toLowerCase();
      const relevant = DAIRY_TERMS.some(t => name.includes(t));
      expect(relevant, `"${p.name}" in top-5 for "חלב" — not a milk product`).toBe(true);
    }
  });

});

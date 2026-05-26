// api/stores-cities.js — v1.1.0
// GET /api/stores-cities?q=חי
//
// Returns up to 10 city autocomplete suggestions built from the live stores/
// collection in Firebase. Only cities that exist in store metadata are returned.
//
// Matching: substring match on the normalised city name (contains, not prefix-only).
// Ranking:
//   1. exact normalised match
//   2. starts-with match
//   3. contains match
//   4. higher store count
//   5. alphabetical
//
// Response: [{ city, count }, ...]   (display city + store count)
//
// Cache: 5 min CDN, 10 min stale-while-revalidate (city list changes only on
// store sync runs, which happen at most twice per day).
//
// v1.1.0: reads via fetch() REST API (no Admin SDK WebSocket hang)

import { restGet, getDbUrl, getAdminToken, setCors } from './_firebase.js';
import { normalizeCity } from './_cityNorm.js';

const MAX_SUGGESTIONS = 10;
const CACHE_HEADER    = 's-maxage=300, stale-while-revalidate=600';
const READ_TIMEOUT_MS = 5_000;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const q = String(req.query?.q || '').trim();

  const dbUrl = getDbUrl();
  if (!dbUrl) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json([]);
  }

  try {
    await getAdminToken().catch(() => {});

    const storesRaw = await restGet(dbUrl, 'stores', READ_TIMEOUT_MS);
    const storesData = (storesRaw && typeof storesRaw === 'object') ? storesRaw : {};

    // Aggregate: normalised city → { display city (most complete form), count }
    const cityMap = new Map();

    for (const store of Object.values(storesData)) {
      const rawCity = store.city?.trim();
      if (!rawCity || rawCity.length < 2) continue;

      // Exclude obvious placeholder / no-city records
      if (rawCity === '0' || rawCity === 'null') continue;

      const norm = normalizeCity(rawCity);
      if (!cityMap.has(norm)) {
        cityMap.set(norm, { display: rawCity, count: 0 });
      }
      const entry = cityMap.get(norm);
      entry.count++;
      // Prefer the longer / most descriptive display form
      if (rawCity.length > entry.display.length) entry.display = rawCity;
    }

    // ── Filter ───────────────────────────────────────────────────────────────
    const queryNorm = q ? normalizeCity(q) : '';

    let results = [];
    for (const [norm, { display, count }] of cityMap) {
      if (q) {
        // Substring match on the normalised city string
        const matchesNorm    = norm.includes(queryNorm);
        // Also match on raw query string in the display form (catches דיל in חיפה etc.)
        const matchesDisplay = display.includes(q);
        if (!matchesNorm && !matchesDisplay) continue;
      }
      results.push({ city: display, norm, count });
    }

    // ── Sort ──────────────────────────────────────────────────────────────────
    if (q) {
      results.sort((a, b) => {
        // Rank 0 = exact, 1 = startsWith, 2 = contains
        const rank = (r) => {
          if (r.norm === queryNorm) return 0;
          if (r.norm.startsWith(queryNorm) || r.display.startsWith(q)) return 1;
          return 2;
        };
        const rd = rank(a) - rank(b);
        if (rd !== 0) return rd;
        if (b.count !== a.count) return b.count - a.count;
        return a.city.localeCompare(b.city);
      });
    } else {
      // No query: most stores first, then alpha
      results.sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
    }

    const out = results.slice(0, MAX_SUGGESTIONS).map(({ city, count }) => ({ city, count }));

    res.setHeader('Cache-Control', CACHE_HEADER);
    return res.status(200).json(out);

  } catch (e) {
    console.error('[stores-cities] error:', e.message);
    return res.status(500).json({ error: 'Internal error', message: e.message });
  }
}

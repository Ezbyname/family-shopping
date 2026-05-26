// api/geocode.js — v1.0.0
// GET /api/geocode?address=...
//
// Server-side address geocoding — keeps GOOGLE_MAPS_API_KEY out of the browser.
// Used by the frontend manual-address flow to convert a typed address into lat/lng.
//
// Response 200:
//   { address, formattedAddress, lat, lng, confidence, source: "google" }
// Response 404:
//   { error: "Address not found", address }
// Response 422:
//   { error: "Address too vague", confidence }
// Response 503:
//   { error: "Geocoding not configured" }  ← GOOGLE_MAPS_API_KEY missing

import { setCors } from './_firebase.js';

// Google location_type values we consider precise enough for store/user location
const TRUSTED = new Set(['ROOFTOP', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER']);

// Loose rate-limit: reject suspiciously long or multi-line address strings
const MAX_ADDR_LEN = 200;

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'GET only' });

  const raw = String(req.query?.address || '').trim();
  if (!raw || raw.length < 3)          return res.status(400).json({ error: 'address required (min 3 chars)' });
  if (raw.length > MAX_ADDR_LEN)       return res.status(400).json({ error: `address too long (max ${MAX_ADDR_LEN} chars)` });
  if (/[\n\r]/.test(raw))             return res.status(400).json({ error: 'invalid address' });

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Geocoding not configured on server' });

  // Append "ישראל" if not already present — improves result quality for Hebrew addresses
  const query = /ישראל|israel/i.test(raw) ? raw : `${raw}, ישראל`;

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('language', 'he');
  url.searchParams.set('region', 'il');

  let data;
  try {
    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    data = await r.json();
  } catch (e) {
    console.error('[geocode] fetch error:', e.message);
    return res.status(503).json({ error: 'Geocoding request failed', detail: e.message });
  }

  switch (data.status) {
    case 'OK':
      break; // continue
    case 'ZERO_RESULTS':
      return res.status(404).json({ error: 'Address not found — try adding city name', address: raw });
    case 'REQUEST_DENIED':
      console.error('[geocode] REQUEST_DENIED — check GOOGLE_MAPS_API_KEY');
      return res.status(503).json({ error: 'Geocoding service unavailable' });
    case 'OVER_QUERY_LIMIT':
      return res.status(429).json({ error: 'Geocoding rate limit — try again in a moment' });
    default:
      return res.status(502).json({ error: `Geocoding failed: ${data.status}` });
  }

  const result  = data.results?.[0];
  if (!result) return res.status(404).json({ error: 'No geocoding result', address: raw });

  const locType = result.geometry?.location_type;

  // Reject city-level results (APPROXIMATE) — not precise enough for store radius filtering
  if (!TRUSTED.has(locType)) {
    return res.status(422).json({
      error: 'Address too vague — please include a street number and city',
      confidence: locType,
      suggestion: result.formatted_address,
    });
  }

  // Reject partial matches — Google resolved something different than what was asked
  if (result.partial_match === true) {
    return res.status(422).json({
      error: 'Address not found precisely — did you mean: ' + result.formatted_address + '?',
      confidence: locType,
      suggestion: result.formatted_address,
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
    });
  }

  return res.status(200).json({
    address:          raw,
    formattedAddress: result.formatted_address,
    lat:              result.geometry.location.lat,
    lng:              result.geometry.location.lng,
    confidence:       locType,
    source:           'google',
  });
}

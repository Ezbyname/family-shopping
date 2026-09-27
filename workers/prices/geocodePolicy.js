export function buildGeocodePlan(store = {}) {
  const status = String(store.status || '').trim();
  const address = String(store.address || '').trim();
  const city = String(store.city || '').trim();
  const cityResolutionSource = String(
    store.cityResolutionSource || ''
  ).trim();

  // Closed / suspect-closed stores must not receive new geocoding data.
  if (status === 'closed' || status === 'possibly_closed') return null;

  // Canonical city is mandatory and must be proven to come from the
  // approved locality resolver. Never fall back to raw locality codes,
  // ZIP codes, store names, numeric supplier codes, or address inference.
  if (
    !city ||
    /^\d+$/.test(city) ||
    cityResolutionSource !== 'data.gov.il_localities_2023'
  ) {
    return null;
  }

  if (address) {
    return {
      mode: 'address',
      query: `${address}, ${city}, ישראל`,
      forceApproximate: false,
    };
  }

  // No branch address, but a canonical city exists:
  // use the city center only as an explicitly approximate location.
  return {
    mode: 'city_center',
    query: `${city}, ישראל`,
    forceApproximate: true,
  };
}

export function buildGeocodeWritePayloads({
  geo,
  city,
  geocodedAt,
  source,
}) {
  if (!geo || geo.latitude == null || geo.longitude == null) {
    throw new TypeError('geo with latitude/longitude is required');
  }

  const canonicalCity = String(city || '').trim();
  const approximate = geo.approximate === true;

  const coordinateResolutionSource =
    source || (approximate ? 'google_approximate' : 'google_geocode');

  const store = {
    latitude: geo.latitude,
    longitude: geo.longitude,
    hasCoords: true,
    approximateLocation: approximate,
    geocodedAt,
    geocodeProvider: 'google',
    geocodeQuery: geo.query,
    geocodeConfidence: geo.confidence,
    coordinateResolutionSource,
  };

  const storeCoords = {
    lat: geo.latitude,
    lng: geo.longitude,
    approximateLocation: approximate,
    geocodeConfidence: geo.confidence,
    coordinateResolutionSource,
  };

  if (canonicalCity) {
    storeCoords.city = canonicalCity;
  }

  return { store, storeCoords };
}

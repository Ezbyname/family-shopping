export function buildStorePayload(store, chain) {
  const payload = {
    chainId:      chain.chainId,
    chainName:    chain.name,
    subChainId:   store.subChainId || '',
    subChainName: store.subChainName || '',
    storeId:      store.storeId,
    storeName:    store.storeName,
    address:      store.address,
    rawCityCode:  store.rawCityCode,
    zipCode:      store.zipCode,
    latitude:     store.latitude,
    longitude:    store.longitude,
    hasCoords:    store.hasCoords,
    active:       true,
    updatedAt:    store.updatedAt,
    source:       'official',
    cityResolutionSource: store.cityResolutionSource,
  };

  if (store.cityId !== undefined) {
    payload.cityId = store.cityId;
  }

  if (store.cityName !== undefined) {
    payload.cityName = store.cityName;
  }

  if (store.city !== undefined) {
    payload.city = store.city;
  }

  return payload;
}

export function buildStoreMergePayload(store, chain) {
  const payload = buildStorePayload(store, chain);

  // Coordinate ownership:
  // If the supplier did not provide usable coordinates, do not write any
  // coordinate fields. Existing geocoded coordinates and metadata must survive.
  if (!store.hasCoords) {
    delete payload.latitude;
    delete payload.longitude;
    delete payload.hasCoords;
    return payload;
  }

  // Supplier coordinates are authoritative exact coordinates.
  // Clear stale Google-geocoding metadata that may belong to older coordinates.
  payload.approximateLocation = false;
  payload.geocodedAt = null;
  payload.geocodeProvider = null;
  payload.geocodeQuery = null;
  payload.geocodeConfidence = null;
  payload.coordinateResolutionSource = 'official';

  return payload;
}

export function buildStoreCoordsPayload(store) {
  if (!store.hasCoords) return null;

  const payload = {
    lat: store.latitude,
    lng: store.longitude,
    approximateLocation: false,
    coordinateResolutionSource: 'official',
  };

  if (store.city !== undefined) {
    payload.city = store.city;
  }

  return payload;
}

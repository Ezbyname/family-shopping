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

export function buildStoreCoordsPayload(store) {
  if (!store.hasCoords) return null;

  const payload = {
    lat: store.latitude,
    lng: store.longitude,
  };

  if (store.city !== undefined) {
    payload.city = store.city;
  }

  return payload;
}

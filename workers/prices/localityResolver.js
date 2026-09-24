import { LOCALITIES_2023 } from './data/localities-2023.js';

export const LOCALITY_RESOLUTION_SOURCE = 'data.gov.il_localities_2023';
export const UNRESOLVED_RESOLUTION_SOURCE = 'unresolved';

function normalizeRawCityCode(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function resolveLocality(rawCode) {
  const rawCityCode = normalizeRawCityCode(rawCode);

  if (!rawCityCode) {
    return {
      resolved: false,
      rawCityCode,
      cityResolutionSource: UNRESOLVED_RESOLUTION_SOURCE,
    };
  }

  const cityName = LOCALITIES_2023.get(rawCityCode);

  if (!cityName) {
    return {
      resolved: false,
      rawCityCode,
      cityResolutionSource: UNRESOLVED_RESOLUTION_SOURCE,
    };
  }

  return {
    resolved: true,
    rawCityCode,
    cityId: rawCityCode,
    cityName,
    city: cityName,
    cityResolutionSource: LOCALITY_RESOLUTION_SOURCE,
  };
}

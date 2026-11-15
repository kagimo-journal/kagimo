/**
 * On-device reverse geocoding against the GeoNames dataset in /places/ (SPEC §8).
 * Coordinates are used only in memory for the lookup: they are never stored or sent anywhere.
 * The dataset is fetched as one file, so the request itself reveals nothing about location.
 */

export type LocationPrecision = 'city' | 'neighbourhood';

export interface EntryLocation {
  label: string;
  precision: LocationPrecision;
}

interface Dataset {
  admin1: string[];
  tiles: Record<string, unknown[]>;
}

interface Place {
  name: string;
  lat: number;
  lon: number;
  popClass: number; // -1 = section of a city (neighbourhood)
  admin1: string | null;
  country: string;
  km: number;
}

let datasetPromise: Promise<Dataset | null> | null = null;

/** Lazily loads the places dataset; resolves to null if it's missing or malformed. */
export function loadPlaces(): Promise<Dataset | null> {
  datasetPromise ??= fetch('/places/places.v1.json', { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
      const data = (await res.json()) as Dataset;
      return data && data.tiles && Array.isArray(data.admin1) ? data : null;
    })
    .catch(() => null)
    .then((d) => {
      if (!d) datasetPromise = null; // allow a later retry
      return d;
    });
  return datasetPromise;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function placesNear(ds: Dataset, lat: number, lon: number): Place[] {
  const out: Place[] = [];
  const tlat = Math.floor(lat);
  const tlon = Math.floor(lon);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const y = tlat + dy;
      let x = tlon + dx;
      if (x < -180) x += 360;
      if (x >= 180) x -= 360;
      const tile = ds.tiles[`${y},${x}`];
      if (!tile || !Array.isArray(tile[0])) continue;
      const countries = tile[0] as string[];
      for (let i = 1; i + 5 < tile.length; i += 6) {
        const plat = y + (tile[i + 1] as number) / 1000;
        const plon = x + (tile[i + 2] as number) / 1000;
        const a1 = tile[i + 4] as number;
        out.push({
          name: tile[i] as string,
          lat: plat,
          lon: plon,
          popClass: tile[i + 3] as number,
          admin1: a1 >= 0 ? ds.admin1[a1] ?? null : null,
          country: countries[tile[i + 5] as number] ?? '',
          km: haversineKm(lat, lon, plat, plon),
        });
      }
    }
  }
  return out;
}

let regionNames: Intl.DisplayNames | null = null;
function countryName(cc: string): string {
  try {
    regionNames ??= new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' });
    return regionNames.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

/** The settlement you're "in": population weighted against distance. */
function pickCity(places: Place[]): Place | null {
  let best: Place | null = null;
  let bestScore = 0;
  for (const p of places) {
    if (p.popClass < 0 || p.km > 40) continue;
    const pop = p.popClass > 0 ? 10 ** (p.popClass / 2) : 1000;
    const score = pop / (p.km + 2) ** 3;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

export function describeLocation(ds: Dataset, lat: number, lon: number, precision: LocationPrecision): EntryLocation | null {
  const places = placesNear(ds, lat, lon);
  const city = pickCity(places);
  if (!city) return null;
  const region = city.admin1 && city.admin1 !== city.name ? city.admin1 : countryName(city.country);
  const cityLabel = `${city.name}, ${region}`;
  if (precision === 'city') return { label: cityLabel, precision };

  let nearest: Place | null = null;
  for (const p of places) if (p.km <= 3 && (!nearest || p.km < nearest.km)) nearest = p;
  if (!nearest || nearest === city || nearest.name === city.name) return { label: cityLabel, precision };
  return { label: `${nearest.name}, ${city.name}`, precision };
}

export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Geolocation unavailable'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 15000,
      maximumAge: 10 * 60 * 1000,
    });
  });
}

/**
 * Finds a place label for "here". Returns null when location is off, permission is denied,
 * the dataset is missing, or nothing is nearby. Never throws.
 */
export async function locateHere(precision: LocationPrecision | 'off'): Promise<EntryLocation | null> {
  if (precision === 'off') return null;
  try {
    const [pos, ds] = await Promise.all([currentPosition(), loadPlaces()]);
    if (!ds) return null;
    return describeLocation(ds, pos.coords.latitude, pos.coords.longitude, precision);
  } catch {
    return null;
  }
}

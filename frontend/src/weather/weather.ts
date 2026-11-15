/**
 * Current weather for new entries (opt-in, SPEC §8). Unlike place names this can't be done on
 * the device: the browser asks Open-Meteo directly (no key, no cookies, no referrer) with the
 * position rounded to 0.1° (about 11 km). Our server never sees the coordinates; only the
 * result is kept, encrypted in the entry header.
 */

import { recordSent } from '../api/sentLog';
import { currentPosition } from '../location/geocode';

/** What an entry stores: the WMO weather code, day or night, and the temperature in °C. */
export interface EntryWeather {
  code: number;
  day: boolean;
  tempC: number;
}

export type WeatherKind = 'sun' | 'moon' | 'partly' | 'partly-night' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';

/** Icon and a one- or two-word description for a WMO weather code. */
export function describeWeather(w: Pick<EntryWeather, 'code' | 'day'>): { kind: WeatherKind; label: string } {
  const c = w.code;
  if (c === 0) return w.day ? { kind: 'sun', label: 'Sunny' } : { kind: 'moon', label: 'Clear' };
  if (c === 1) return { kind: w.day ? 'partly' : 'partly-night', label: 'Mostly clear' };
  if (c === 2) return { kind: w.day ? 'partly' : 'partly-night', label: 'Partly cloudy' };
  if (c === 3) return { kind: 'cloud', label: 'Overcast' };
  if (c === 45 || c === 48) return { kind: 'fog', label: 'Foggy' };
  if (c >= 51 && c <= 55) return { kind: 'drizzle', label: 'Drizzle' };
  if (c === 56 || c === 57) return { kind: 'drizzle', label: 'Freezing drizzle' };
  if (c === 61 || c === 63) return { kind: 'rain', label: 'Rain' };
  if (c === 65) return { kind: 'rain', label: 'Heavy rain' };
  if (c === 66 || c === 67) return { kind: 'rain', label: 'Freezing rain' };
  if (c === 71 || c === 73 || c === 77) return { kind: 'snow', label: 'Snow' };
  if (c === 75) return { kind: 'snow', label: 'Heavy snow' };
  if (c === 80 || c === 81) return { kind: 'rain', label: 'Showers' };
  if (c === 82) return { kind: 'rain', label: 'Heavy showers' };
  if (c === 85 || c === 86) return { kind: 'snow', label: 'Snow showers' };
  if (c === 95 || c === 96 || c === 99) return { kind: 'storm', label: 'Thunderstorm' };
  return { kind: 'cloud', label: 'Cloudy' };
}

/** Fahrenheit for the few regions that use it, Celsius everywhere else. */
function usesFahrenheit(): boolean {
  try {
    const region = new Intl.Locale(navigator.language || 'en').maximize().region;
    return ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH'].includes(region ?? '');
  } catch {
    return false;
  }
}

export function formatTemp(tempC: number): string {
  return usesFahrenheit() ? `${Math.round(tempC * 1.8 + 32)}°F` : `${Math.round(tempC)}°C`;
}

export function isEntryWeather(v: unknown): v is EntryWeather {
  const w = v as EntryWeather | null;
  return !!w && typeof w === 'object' && Number.isInteger(w.code) && typeof w.day === 'boolean' && Number.isFinite(w.tempC);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Weather "here, now". Returns null when permission is denied, offline, or anything fails. Never throws. */
export async function weatherHere(): Promise<EntryWeather | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let answered: ((status: number | 'failed') => void) | null = null;
  try {
    const pos = await currentPosition();
    const q = new URLSearchParams({
      latitude: String(round1(pos.coords.latitude)),
      longitude: String(round1(pos.coords.longitude)),
      current: 'temperature_2m,weather_code,is_day',
    });
    const url = `https://api.open-meteo.com/v1/forecast?${q}`;
    answered = recordSent('GET', url);
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctrl.signal });
    answered(res.status);
    answered = null;
    if (!res.ok) return null;
    const cur = ((await res.json()) as { current?: { temperature_2m?: number; weather_code?: number; is_day?: number } }).current;
    const w = { code: cur?.weather_code, day: cur?.is_day === 1, tempC: cur?.temperature_2m };
    return isEntryWeather(w) ? { code: w.code, day: w.day, tempC: Math.round(w.tempC * 10) / 10 } : null;
  } catch {
    answered?.('failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

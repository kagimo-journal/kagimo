import { describe, expect, it } from 'vitest';
import { describeWeather, isEntryWeather } from './weather';

describe('describeWeather', () => {
  it('names clear skies by day and night', () => {
    expect(describeWeather({ code: 0, day: true })).toEqual({ kind: 'sun', label: 'Sunny' });
    expect(describeWeather({ code: 0, day: false })).toEqual({ kind: 'moon', label: 'Clear' });
    expect(describeWeather({ code: 2, day: false }).kind).toBe('partly-night');
  });

  it('maps rain, snow and storms', () => {
    expect(describeWeather({ code: 63, day: true }).label).toBe('Rain');
    expect(describeWeather({ code: 75, day: true })).toEqual({ kind: 'snow', label: 'Heavy snow' });
    expect(describeWeather({ code: 99, day: true }).kind).toBe('storm');
    expect(describeWeather({ code: 12345, day: true }).label).toBe('Cloudy');
  });
});

describe('isEntryWeather', () => {
  it('rejects malformed values', () => {
    expect(isEntryWeather({ code: 3, day: true, tempC: 11.4 })).toBe(true);
    expect(isEntryWeather({ code: '3', day: true, tempC: 11 })).toBe(false);
    expect(isEntryWeather({ code: 3, day: 1, tempC: 11 })).toBe(false);
    expect(isEntryWeather(null)).toBe(false);
  });
});

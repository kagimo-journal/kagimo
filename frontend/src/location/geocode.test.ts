import { describe, expect, it } from 'vitest';
import { describeLocation } from './geocode';

// A tiny dataset in the build-places.mjs format around Bristol, UK.
const ds = {
  admin1: ['England'],
  tiles: {
    '51,-3': [
      ['GB'],
      'Bristol', 455, 404, 11, 0, 0, // 51.455,-2.596 pop ~316k
      'Clifton', 459, 380, -1, 0, 0, // neighbourhood
      'Yatton', 388, 176, 8, 0, 0, // small town 15 km away
    ],
  },
};

describe('describeLocation', () => {
  it('finds the city and neighbourhood', () => {
    expect(describeLocation(ds, 51.4585, -2.6185, 'city')).toEqual({ label: 'Bristol, England', precision: 'city' });
    expect(describeLocation(ds, 51.4585, -2.6185, 'neighbourhood')).toEqual({ label: 'Clifton, Bristol', precision: 'neighbourhood' });
  });

  it('prefers a nearby small town over a distant city', () => {
    expect(describeLocation(ds, 51.389, -2.824, 'city')?.label).toBe('Yatton, England');
  });

  it('returns null in the middle of nowhere', () => {
    expect(describeLocation(ds, 10.5, 10.5, 'city')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { countWords, formatDay, formatLongDate, formatTime, localIsoWithOffset, monthLabel } from './format';

describe('format', () => {
  it('formats dates in the entry time zone', () => {
    const iso = '2026-11-11T21:40:00+00:00';
    expect(formatLongDate(iso, 'Europe/London')).toBe('Wednesday · 11 November 2026');
    expect(formatTime(iso, 'Europe/London')).toBe('21:40');
    expect(formatTime(iso, 'Asia/Tokyo')).toBe('06:40');
    expect(formatDay('2026-11-09T10:00:00+00:00', 'Europe/London')).toBe('09');
    expect(monthLabel(iso, 'Europe/London')).toBe('November 2026');
  });

  it('produces ISO strings with an offset', () => {
    expect(localIsoWithOffset(new Date())).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });

  it('counts words', () => {
    expect(countWords("The river was higher than I'd expected — really.")).toBe(8);
    expect(countWords('   ')).toBe(0);
  });
});

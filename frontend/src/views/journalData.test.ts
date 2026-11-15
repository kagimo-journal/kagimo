import { describe, expect, it } from 'vitest';
import type { EntrySummary } from '../editor/entriesStore';
import type { EntryHeader } from '../editor/types';
import { bookMonths, datedEntries, dayInfo, daysBetween, dayStrip, hasViews, inYear, monthSections, totals, totalsLine, yearsOf } from './journalData';

let n = 0;
function entry(createdAt: string, extra: Partial<EntryHeader> = {}, tz = 'Europe/London'): EntrySummary {
  n++;
  return {
    id: `e${n}`,
    createdAt,
    updatedAt: createdAt,
    version: 1,
    conflict: false,
    header: { v: 1, title: `Entry ${n}`, snippet: '', createdAt, tz, location: null, wordCount: 100, imageCount: 0, ...extra },
  };
}

describe('dayInfo', () => {
  it('uses the entry time zone', () => {
    // 23:30 UTC on 31 Dec is already 1 January in Berlin.
    expect(dayInfo('2025-12-31T23:30:00Z', 'Europe/Berlin')).toMatchObject({ key: '2026-01-01', year: 2026, month: 0, day: 1, weekday: 'Thu', time: '00:30' });
    expect(dayInfo('2025-12-31T23:30:00Z', 'Europe/London')?.key).toBe('2025-12-31');
  });
  it('falls back for an unknown time zone and rejects bad dates', () => {
    expect(dayInfo('2026-03-01T12:00:00Z', 'Not/AZone')?.year).toBe(2026);
    expect(dayInfo('nope', 'UTC')).toBeNull();
  });
});

describe('hasViews', () => {
  it('needs entries on two different days', () => {
    expect(hasViews([])).toBe(false);
    expect(hasViews([entry('2026-11-11T09:00:00Z'), entry('2026-11-11T20:00:00Z')])).toBe(false);
    expect(hasViews([entry('2026-11-11T09:00:00Z'), entry('2026-11-12T09:00:00Z')])).toBe(true);
  });
  it('ignores entries that could not be decrypted', () => {
    const locked: EntrySummary = { ...entry('2026-11-10T09:00:00Z'), header: null };
    expect(hasViews([locked, entry('2026-11-11T09:00:00Z')])).toBe(false);
  });
});

describe('totals', () => {
  it('counts entries, words, distinct places and photos (old headers use imageCount)', () => {
    const list = datedEntries([
      entry('2026-11-11T09:00:00Z', { wordCount: 400, location: { label: 'Clifton, Bristol', precision: 'neighbourhood' }, photoCount: 2, imageCount: 2 }),
      entry('2026-11-10T09:00:00Z', { wordCount: 12, location: { label: 'clifton, bristol', precision: 'neighbourhood' }, imageCount: 1 }),
      entry('2026-11-09T09:00:00Z', { wordCount: 900, location: { label: 'Reading', precision: 'city' } }),
    ]);
    const t = totals(list);
    expect(t).toEqual({ entries: 3, words: 1312, places: 2, photos: 3 });
    expect(totalsLine(t)).toBe('3 entries · 1,312 words · 2 places · 3 photos');
    expect(totalsLine({ entries: 1, words: 1, places: 0, photos: 0 })).toBe('1 entry · 1 word');
  });
});

describe('dayStrip', () => {
  it('marks written, empty and future days', () => {
    const strip = dayStrip(2026, new Set(['2026-11-06', '2026-02-28']), '2026-11-11');
    expect(strip).toHaveLength(12);
    expect(strip[1].days).toHaveLength(28);
    expect(strip[1].days[27].state).toBe('written');
    expect(strip[10].days[5].state).toBe('written');
    expect(strip[10].days[10].state).toBe('empty'); // today, not written
    expect(strip[10].days[11].state).toBe('future');
    expect(strip[11].future).toBe(true);
    expect(strip[10].written).toBe(1);
  });
  it('knows leap years', () => {
    expect(dayStrip(2028, new Set(), '2028-12-31')[1].days).toHaveLength(29);
  });
});

describe('monthSections', () => {
  it('groups by month, newest first, with quiet stretches over a week', () => {
    const list = datedEntries([
      entry('2026-11-11T21:40:00Z'),
      entry('2026-11-09T10:15:00Z'),
      entry('2026-11-06T08:05:00Z'),
      entry('2026-10-28T07:30:00Z'),
      entry('2026-10-21T22:10:00Z'),
    ]);
    const s = monthSections(inYear(list, 2026));
    expect(s.map((m) => m.name)).toEqual(['November', 'October']);
    expect(s[0].items.map((i) => i.kind)).toEqual(['entry', 'entry', 'entry', 'gap']);
    expect(s[0].items[3]).toMatchObject({ kind: 'gap', days: 9 });
    // 21 → 28 October is exactly 7 days: no quiet stretch.
    expect(s[1].items.map((i) => i.kind)).toEqual(['entry', 'entry']);
    expect(s[0].totals.entries).toBe(3);
    expect(s[1].totals.words).toBe(200);
  });
  it('flags only the first entry of each day', () => {
    const s = monthSections(datedEntries([entry('2026-05-02T20:00:00Z'), entry('2026-05-02T08:00:00Z'), entry('2026-05-01T08:00:00Z')]));
    expect(s[0].items.map((i) => i.kind === 'entry' && i.firstOfDay)).toEqual([true, false, true]);
  });
});

describe('years and book months', () => {
  it('lists years newest first and reads a year oldest first', () => {
    const list = datedEntries([entry('2026-03-14T20:00:00Z'), entry('2025-12-01T20:00:00Z'), entry('2026-01-02T20:00:00Z'), entry('2026-03-01T20:00:00Z')]);
    expect(yearsOf(list)).toEqual([2026, 2025]);
    const months = bookMonths(inYear(list, 2026));
    expect(months.map((m) => [m.name, m.entries.length])).toEqual([
      ['January', 1],
      ['March', 2],
    ]);
    expect(months[1].entries[0].header.createdAt).toBe('2026-03-01T20:00:00Z');
  });
  it('counts days between keys', () => {
    expect(daysBetween('2026-10-28', '2026-11-06')).toBe(9);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // across a DST change
  });
});

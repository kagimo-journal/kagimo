/**
 * Timeline and book data, computed in the browser from decrypted entry headers (nothing new on
 * the server). Dates are the entry's own: `createdAt` in the entry's time zone.
 */
import type { EntrySummary } from '../editor/entriesStore';
import type { EntryHeader } from '../editor/types';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface DayInfo {
  /** YYYY-MM-DD */
  key: string;
  year: number;
  /** 0–11 */
  month: number;
  day: number;
  /** "Tue" */
  weekday: string;
  /** "21:40" */
  time: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      f = formatter(undefined);
    }
    formatters.set(key, f);
  }
  return f;
}

/** The calendar day of an instant in a time zone (the entry's own, or the browser's). */
export function dayInfo(iso: string, tz?: string | null): DayInfo | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = formatter(tz || undefined).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month')) - 1;
  const day = Number(get('day'));
  return {
    key: `${get('year')}-${get('month')}-${get('day')}`,
    year,
    month,
    day,
    weekday: get('weekday'),
    time: `${get('hour')}:${get('minute')}`,
  };
}

export interface DatedEntry {
  id: string;
  header: EntryHeader;
  date: DayInfo;
}

/** Entries that could be decrypted, with their calendar day, newest first. */
export function datedEntries(items: EntrySummary[]): DatedEntry[] {
  const out: DatedEntry[] = [];
  for (const e of items) {
    if (!e.header) continue;
    const date = dayInfo(e.header.createdAt || e.createdAt, e.header.tz);
    if (date) out.push({ id: e.id, header: e.header, date });
  }
  return out.sort((a, b) => Date.parse(b.header.createdAt) - Date.parse(a.header.createdAt) || (a.id < b.id ? -1 : 1));
}

/** Timeline and Books appear once entries exist on at least two different days. */
export function hasViews(items: EntrySummary[]): boolean {
  const days = new Set<string>();
  for (const e of datedEntries(items)) {
    days.add(e.date.key);
    if (days.size >= 2) return true;
  }
  return false;
}

/** Years with at least one entry, newest first. */
export function yearsOf(entries: DatedEntry[]): number[] {
  return [...new Set(entries.map((e) => e.date.year))].sort((a, b) => b - a);
}

export function inYear(entries: DatedEntry[], year: number): DatedEntry[] {
  return entries.filter((e) => e.date.year === year);
}

export const photosOf = (h: EntryHeader): number => h.photoCount ?? h.imageCount ?? 0;

export interface Totals {
  entries: number;
  words: number;
  places: number;
  photos: number;
}

export function totals(entries: DatedEntry[]): Totals {
  const places = new Set<string>();
  let words = 0;
  let photos = 0;
  for (const { header: h } of entries) {
    words += h.wordCount || 0;
    photos += photosOf(h);
    const label = h.location?.label?.trim();
    if (label) places.add(label.toLowerCase());
  }
  return { entries: entries.length, words, places: places.size, photos };
}

export const num = (n: number) => n.toLocaleString('en-GB');
export const count = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** "142 entries · 61,300 words · 23 places · 48 photos" (places and photos only when there are some). */
export function totalsLine(t: Totals, opts: { places?: boolean; photos?: boolean } = {}): string {
  const bits = [count(t.entries, 'entry', 'entries'), count(t.words, 'word')];
  if (opts.places !== false && t.places) bits.push(count(t.places, 'place'));
  if (opts.photos !== false && t.photos) bits.push(count(t.photos, 'photo'));
  return bits.join(' · ');
}

// ---- day strip -------------------------------------------------------------------------------

export type DayState = 'written' | 'empty' | 'future';

export interface StripMonth {
  month: number;
  label: string;
  written: number;
  future: boolean;
  days: { key: string; day: number; state: DayState }[];
}

const pad = (n: number) => String(n).padStart(2, '0');

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** One dot per day of the year: written, not written, or still to come (after `todayKey`). */
export function dayStrip(year: number, written: Set<string>, todayKey: string): StripMonth[] {
  return MONTHS.map((name, month) => {
    const days = [];
    let n = 0;
    for (let d = 1; d <= daysInMonth(year, month); d++) {
      const key = `${year}-${pad(month + 1)}-${pad(d)}`;
      const state: DayState = written.has(key) ? 'written' : key > todayKey ? 'future' : 'empty';
      if (state === 'written') n++;
      days.push({ key, day: d, state });
    }
    return { month, label: name.slice(0, 3), written: n, future: `${year}-${pad(month + 1)}-01` > todayKey, days };
  });
}

// ---- month sections ----------------------------------------------------------------------------

/** Whole days between two YYYY-MM-DD keys (b after a gives a positive number). */
export function daysBetween(a: string, b: string): number {
  const t = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** Entries more than this many days apart get "A quiet stretch: N days" between them. */
export const QUIET_DAYS = 7;

export type TimelineItem = { kind: 'entry'; entry: DatedEntry; firstOfDay: boolean } | { kind: 'gap'; days: number; key: string };

export interface MonthSection {
  month: number;
  name: string;
  totals: Totals;
  items: TimelineItem[];
}

/**
 * A year's entries (newest first) grouped by month, newest month first. A quiet stretch sits
 * after the newer of two entries that are more than a week apart, even across months.
 */
export function monthSections(yearEntries: DatedEntry[]): MonthSection[] {
  const sections: MonthSection[] = [];
  let prev: DatedEntry | null = null;
  let current: MonthSection | null = null;
  const byMonth = new Map<number, DatedEntry[]>();
  for (const e of yearEntries) {
    if (prev) {
      const gap = daysBetween(e.date.key, prev.date.key);
      if (gap > QUIET_DAYS && current) current.items.push({ kind: 'gap', days: gap, key: `gap-${prev.id}` });
    }
    if (!current || current.month !== e.date.month) {
      current = { month: e.date.month, name: MONTHS[e.date.month], totals: totals([]), items: [] };
      sections.push(current);
      byMonth.set(e.date.month, []);
    }
    byMonth.get(e.date.month)!.push(e);
    current.items.push({ kind: 'entry', entry: e, firstOfDay: !prev || prev.date.key !== e.date.key });
    prev = e;
  }
  for (const s of sections) s.totals = totals(byMonth.get(s.month)!);
  return sections;
}

/** Entries of a year in reading order (oldest first) grouped by month, for the year book. */
export function bookMonths(yearEntries: DatedEntry[]): { month: number; name: string; entries: DatedEntry[] }[] {
  const out: { month: number; name: string; entries: DatedEntry[] }[] = [];
  for (const e of [...yearEntries].reverse()) {
    const last = out[out.length - 1];
    if (last && last.month === e.date.month) last.entries.push(e);
    else out.push({ month: e.date.month, name: MONTHS[e.date.month], entries: [e] });
  }
  return out;
}

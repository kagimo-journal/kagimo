/** Date, size and text helpers. */

export function localIsoWithOffset(d = new Date()): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

export function currentTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function safeTz(tz: string | null | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function parts(iso: string, tz: string | null | undefined, opts: Intl.DateTimeFormatOptions) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: safeTz(tz), ...opts }).formatToParts(d);
}

const pick = (p: Intl.DateTimeFormatPart[] | null, type: string) => p?.find((x) => x.type === type)?.value ?? '';

/** "Tuesday · 11 November 2026" */
export function formatLongDate(iso: string, tz?: string | null): string {
  const p = parts(iso, tz, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return p ? `${pick(p, 'weekday')} · ${pick(p, 'day')} ${pick(p, 'month')} ${pick(p, 'year')}` : '';
}

/** "Wed · 12 Nov · 07:15" (mobile) */
export function formatShortDateTime(iso: string, tz?: string | null): string {
  const p = parts(iso, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return p ? `${pick(p, 'weekday')} · ${pick(p, 'day')} ${pick(p, 'month')} · ${pick(p, 'hour')}:${pick(p, 'minute')}` : '';
}

export function formatShortDate(iso: string, tz?: string | null): string {
  const p = parts(iso, tz, { weekday: 'short', day: 'numeric', month: 'short' });
  return p ? `${pick(p, 'weekday')} · ${pick(p, 'day')} ${pick(p, 'month')}` : '';
}

/** "21:40" */
export function formatTime(iso: string, tz?: string | null): string {
  const p = parts(iso, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return p ? `${pick(p, 'hour')}:${pick(p, 'minute')}` : '';
}

/** Day of month, zero-padded: "09" */
export function formatDay(iso: string, tz?: string | null): string {
  return pick(parts(iso, tz, { day: '2-digit' }), 'day');
}

/** Grouping key and label: "November 2026" */
export function monthLabel(iso: string, tz?: string | null): string {
  const p = parts(iso, tz, { month: 'long', year: 'numeric' });
  return p ? `${pick(p, 'month')} ${pick(p, 'year')}` : 'Undated';
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  const v = n / 1000 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 90) return 'Now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 14) return 'Last week';
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function countWords(text: string): number {
  const m = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Normalises a 6-digit code typed with spaces. */
export function cleanCode(s: string): string {
  return s.replace(/\D/g, '').slice(0, 6);
}

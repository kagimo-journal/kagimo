import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { BookIcon, ChevronLeftIcon, ChevronRightIcon, ImageIcon, PinIcon, SearchIcon, XIcon } from '../../components/Icons';
import { LoadingScreen } from '../../components/Spinner';
import { entriesStore, useEntries } from '../../editor/entriesStore';
import { thumbnailUrl } from '../../images/thumbs';
import { currentTimeZone } from '../../lib/format';
import {
  count,
  type DatedEntry,
  datedEntries,
  dayInfo,
  dayStrip,
  hasViews,
  inYear,
  MONTHS,
  monthSections,
  num,
  photosOf,
  totals,
  totalsLine,
  yearsOf,
} from '../../views/journalData';
import { AppHeader } from '../../views/ViewNav';
import { ViewsEmpty } from '../../views/ViewsEmpty';
import { describeWeather, type EntryWeather, isEntryWeather } from '../../weather/weather';
import { WeatherIcon } from '../../weather/WeatherIcon';
import './timeline.css';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function matches(e: DatedEntry, terms: string[]): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const hay = norm([e.header.title, e.header.snippet, e.header.location?.label ?? ''].join(' '));
  return terms.every((t) => hay.includes(norm(t)));
}

export default function TimelinePage() {
  const { year: yearParam } = useParams();
  const navigate = useNavigate();
  const { items, status, error } = useEntries();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void entriesStore.load();
  }, []);

  const all = useMemo(() => datedEntries(items), [items]);
  const years = useMemo(() => yearsOf(all), [all]);
  const available = useMemo(() => hasViews(items), [items]);
  const today = dayInfo(new Date().toISOString(), currentTimeZone())!;
  const year = yearParam ? Number(yearParam) : (years[0] ?? today.year);
  const yearEntries = useMemo(() => inYear(all, year), [all, year]);
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => (terms.length ? yearEntries.filter((e) => matches(e, terms)) : yearEntries), [yearEntries, terms.join(' ')]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => monthSections(shown), [shown]);
  const stats = useMemo(() => totals(yearEntries), [yearEntries]);
  const strip = useMemo(() => dayStrip(year, new Set(yearEntries.map((e) => e.date.key)), today.key), [year, yearEntries, today.key]);

  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);

  if (yearParam && !/^\d{4}$/.test(yearParam)) return <Navigate to="/timeline" replace />;

  const older = years.find((y) => y < year);
  const newer = [...years].reverse().find((y) => y > year);
  const loading = status !== 'ready' && status !== 'error' && !items.length;

  const jumpTo = (key: string) => {
    if (terms.length) setQuery('');
    requestAnimationFrame(() => {
      const row = document.getElementById(`day-${key}`);
      if (!row) return;
      row.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      row.querySelector<HTMLAnchorElement>('a.tl-card')?.focus({ preventScroll: true });
    });
  };
  const jumpToMonth = (month: number) => {
    if (terms.length) setQuery('');
    requestAnimationFrame(() => {
      const el = document.getElementById(`month-${month}`);
      el?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      el?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    });
  };

  const writtenDays = strip.reduce((n, m) => n + m.written, 0);
  const busiest = strip.reduce((a, b) => (b.written > a.written ? b : a), strip[0]);
  const summary = `Written on ${count(writtenDays, 'day')} in ${year}${busiest.written > 1 ? `, most often in ${MONTHS[busiest.month]} (${count(busiest.written, 'day')})` : ''}.`;

  return (
    <div className="page views-page">
      <AppHeader
        actions={
          available && (
            <button
              type="button"
              className="icon-btn"
              aria-label={searching ? 'Close search' : 'Search entries'}
              aria-expanded={searching}
              aria-controls="timeline-search"
              onClick={() => {
                setSearching(!searching);
                setQuery('');
              }}
            >
              {searching ? <XIcon size={16} /> : <SearchIcon size={17} />}
            </button>
          )
        }
      />
      <main className="timeline" id="main">
        {loading ? (
          <LoadingScreen label="Decrypting entries…" />
        ) : status === 'error' && !items.length ? (
          <p className="error-text" role="alert">{error ?? "Couldn't load your entries."}</p>
        ) : !available ? (
          <ViewsEmpty view="timeline" />
        ) : (
          <>
            <section className="tl-year" aria-labelledby="tl-year-title">
              <div className="tl-year-head">
                <div className="stack" style={{ gap: 6 }}>
                  <h1 className="tl-year-title" id="tl-year-title">{year}</h1>
                  <p className="tl-totals">{yearEntries.length ? totalsLine(stats) : 'Nothing written this year.'}</p>
                </div>
                <div role="group" aria-label="Year" className="year-steps">
                  <button
                    type="button"
                    className="step-btn"
                    aria-label={older ? `Previous year, ${older}` : 'Previous year'}
                    disabled={!older}
                    onClick={() => older && navigate(`/timeline/${older}`)}
                  >
                    <ChevronLeftIcon size={16} />
                  </button>
                  <button
                    type="button"
                    className="step-btn"
                    aria-label={newer ? `Next year, ${newer}` : 'Next year'}
                    disabled={!newer}
                    onClick={() => newer && navigate(`/timeline/${newer}`)}
                  >
                    <ChevronRightIcon size={16} />
                  </button>
                </div>
              </div>

              {yearEntries.length > 0 && (
                <>
                <figure className="day-strip" role="img" aria-label={`Days written in ${year}, by month`} aria-describedby="strip-summary">
                  <figcaption id="strip-summary" className="visually-hidden">
                    {summary}
                  </figcaption>
                  {strip.map((m) => (
                    <div className="strip-month" key={m.month}>
                      <div className="strip-days" aria-hidden>
                        {m.days.map((d) => (
                          <span
                            key={d.key}
                            className={`dot ${d.state}`}
                            title={d.state === 'written' ? `${d.day} ${MONTHS[m.month]}` : undefined}
                            onClick={d.state === 'written' ? () => jumpTo(d.key) : undefined}
                          />
                        ))}
                      </div>
                      <span className={`strip-label${m.future ? ' future' : ''}`} aria-hidden>
                        {m.label}
                      </span>
                    </div>
                  ))}
                </figure>
                <nav className="month-jump" aria-label={`Months of ${year}`}>
                  {strip
                    .filter((m) => m.written)
                    .map((m) => (
                      <button key={m.month} type="button" className="month-jump-btn" onClick={() => jumpToMonth(m.month)}>
                        {MONTHS[m.month]}
                        <span className="visually-hidden">, {count(m.written, 'day')} written</span>
                      </button>
                    ))}
                </nav>
                </>
              )}
            </section>

            {searching && (
              <label className="search tl-search" id="timeline-search">
                <SearchIcon size={15} />
                <span className="visually-hidden">Search {year}</span>
                <input
                  ref={searchInput}
                  type="search"
                  placeholder={`Search ${year} on this device`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearching(false);
                      setQuery('');
                    }
                  }}
                />
              </label>
            )}
            {terms.length > 0 && (
              <p className="tl-note" role="status">
                {shown.length ? `${count(shown.length, 'entry', 'entries')} match “${query.trim()}”.` : `Nothing in ${year} matches “${query.trim()}”.`}
              </p>
            )}

            {sections.map((s) => (
              <section className="tl-month" key={s.month} id={`month-${s.month}`} aria-labelledby={`month-h-${s.month}`}>
                <h2 className="tl-month-head" id={`month-h-${s.month}`} tabIndex={-1}>
                  <span>{s.name}</span>
                  <span className="tl-month-sum">{totalsLine(s.totals, { places: false, photos: false })}</span>
                </h2>
                <div className="tl-spine">
                  <div className="tl-spine-line" aria-hidden />
                  {s.items.map((it) =>
                    it.kind === 'gap' ? (
                      <div className="tl-gap" key={it.key}>
                        <span />
                        <span className="tl-gap-line" aria-hidden />
                        <span className="tl-gap-text">A quiet stretch: {count(it.days, 'day')}</span>
                      </div>
                    ) : (
                      <TimelineRow key={it.entry.id} entry={it.entry} firstOfDay={it.firstOfDay} />
                    ),
                  )}
                </div>
              </section>
            ))}

            {yearEntries.length > 0 && (
              <Link to={`/books/${year}`} className="btn btn-secondary tl-book-link">
                <BookIcon size={16} />
                Open the {year} book
              </Link>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function TimelineRow({ entry, firstOfDay }: { entry: DatedEntry; firstOfDay: boolean }) {
  const { header: h, date } = entry;
  const photos = photosOf(h);
  return (
    <div className="tl-row" id={firstOfDay ? `day-${date.key}` : undefined}>
      <div className="tl-date" aria-hidden>
        {firstOfDay && (
          <>
            <span className="tl-day">{String(date.day).padStart(2, '0')}</span>
            <span className="tl-weekday">{date.weekday}</span>
          </>
        )}
      </div>
      <span className="tl-node" aria-hidden />
      <Link to={`/e/${entry.id}`} className="tl-card">
        <span className="tl-text">
          <span className="visually-hidden">
            {date.weekday} {date.day} {MONTHS[date.month]}:{' '}
          </span>
          <span className="tl-title">{h.title || 'Untitled'}</span>
          {h.snippet && <span className="tl-snippet">{h.snippet}</span>}
          <span className="tl-meta">
            {h.location?.label && (
              <span className="tl-place">
                <PinIcon size={12} />
                {h.location.label}
              </span>
            )}
            {h.weather && <TimelineWeather weather={h.weather} />}
            <span>{date.time}</span>
            <span>{count(h.wordCount || 0, 'word')}</span>
          </span>
        </span>
        {h.coverBlobId && photos > 0 && <Thumb blobId={h.coverBlobId} photos={photos} />}
      </Link>
    </div>
  );
}

/** The entry's first photo, decrypted only once it scrolls near the viewport. */
function Thumb({ blobId, photos }: { blobId: string; photos: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const load = () => {
      thumbnailUrl(blobId)
        .then((u) => alive && setUrl(u))
        .catch(() => alive && setFailed(true));
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        alive = false;
      };
    }
    const io = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: '300px 0px' },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [blobId]);

  return (
    <span ref={ref} className="tl-thumb" role="img" aria-label={`Photo from this entry; ${count(photos, 'photo')} in all`}>
      {url ? <img src={url} alt="" /> : <ImageIcon size={22} strokeWidth={1.5} className={failed ? 'failed' : undefined} />}
      <span className="tl-thumb-count" aria-hidden>
        {photos === 1 ? '1 photo' : `${num(photos)} photos`}
      </span>
    </span>
  );
}

function TimelineWeather({ weather }: { weather: EntryWeather }) {
  if (!isEntryWeather(weather)) return null;
  const { kind, label } = describeWeather(weather);
  return (
    <span className="tl-place">
      <WeatherIcon kind={kind} size={13} />
      {label}
    </span>
  );
}

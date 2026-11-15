import type { JSONContent } from '@tiptap/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { getEntry } from '../../local/repo';
import { requireVault } from '../../local/vault';
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/Icons';
import { LoadingScreen, Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { decryptEntryPart } from '../../crypto/content';
import { collectBlobIds } from '../../editor/docText';
import { entriesStore, useEntries } from '../../editor/entriesStore';
import type { EntryBody } from '../../editor/types';
import { exportEntriesZip } from '../../export/exporter';
import { acquireImageUrl, releaseImageUrl } from '../../images/blobs';
import { formatLongDate } from '../../lib/format';
import { useIdentity } from '../../state/identity';
import { coverFor, useSettings } from '../../state/settings';
import { bookMonths, count, type DatedEntry, datedEntries, inYear, totals, totalsLine } from '../../views/journalData';
import { renderDoc } from './renderDoc';
import './yearbook.css';

interface Geometry {
  spread: boolean;
  pageW: number;
  pageH: number;
  padX: number;
  padTop: number;
  padBottom: number;
  /** content box of one page */
  cw: number;
  ch: number;
  gap: number;
}

function geometry(frameW: number, viewportH: number): Geometry {
  const spread = frameW >= 860;
  const pageW = spread ? frameW / 2 : frameW;
  const padX = Math.round(Math.min(72, Math.max(22, pageW * 0.12)));
  const padTop = spread ? 64 : 36;
  const padBottom = spread ? 56 : 44;
  const pageH = Math.round(Math.min(940, Math.max(spread ? 560 : 440, viewportH - (spread ? 230 : 200))));
  const cw = Math.max(160, Math.floor(pageW - 2 * padX));
  const ch = pageH - padTop - padBottom - 28; // 28: the folio (page number) line
  return { spread, pageW, pageH, padX, padTop, padBottom, cw, ch, gap: 2 * padX };
}

/** Typing in a field must not turn pages. */
function typingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** "Saturday 14 March · Southville, Bristol" */
function dateLine(e: DatedEntry): string {
  const long = formatLongDate(e.header.createdAt, e.header.tz); // "Saturday · 14 March 2026"
  const [weekday, rest] = long.split(' · ');
  const dayMonth = rest ? rest.replace(/\s\d{4}$/, '') : '';
  return [weekday && dayMonth ? `${weekday} ${dayMonth}` : long, e.header.location?.label].filter(Boolean).join(' · ');
}

type Bodies = Map<string, JSONContent | null>;

export default function YearBookPage() {
  const { year: yearParam = '' } = useParams();
  const year = Number(yearParam);
  const valid = /^\d{4}$/.test(yearParam);
  const me = useIdentity();
  const toast = useToast();
  const { settings } = useSettings();
  const { items, status } = useEntries();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    void entriesStore.load();
  }, []);

  const yearEntries = useMemo(() => (valid ? inYear(datedEntries(items), year) : []), [items, year, valid]);
  const months = useMemo(() => bookMonths(yearEntries), [yearEntries]);
  const stats = useMemo(() => totals(yearEntries), [yearEntries]);
  const cover = coverFor(settings.books, year);

  // ---- decrypt every entry of the year (memory only, gone when this page closes) --------------
  const [bodies, setBodies] = useState<Bodies | null>(null);
  const [progress, setProgress] = useState('');
  const idKey = yearEntries.map((e) => `${e.id}:${items.find((i) => i.id === e.id)?.updatedAt ?? ''}`).join(',');
  useEffect(() => {
    if (status !== 'ready' || !valid) return;
    let alive = true;
    const list = yearEntries;
    (async () => {
      const out: Bodies = new Map();
      let done = 0;
      const queue = [...list];
      const worker = async () => {
        for (let e = queue.shift(); e; e = queue.shift()) {
          try {
            const full = await getEntry(requireVault().id, e.id);
            if (!full) throw new Error('missing');
            const body = await decryptEntryPart<EntryBody>(e.id, 'body', full.body);
            out.set(e.id, body.doc ?? null);
          } catch {
            out.set(e.id, null);
          }
          done++;
          if (alive) setProgress(`Decrypting ${done} of ${list.length}…`);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (alive) setBodies(out);
    })();
    return () => {
      alive = false;
    };
  }, [status, idKey, valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- geometry -------------------------------------------------------------------------------
  const frameRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const g = geometry(frame.clientWidth, window.innerHeight);
      setGeo((old) => (old && old.cw === g.cw && old.ch === g.ch && old.spread === g.spread && old.padX === g.padX ? old : g));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [bodies]);

  // ---- pagination: measure where each month starts and how many columns (pages) there are -------
  const [total, setTotal] = useState(1);
  const [monthPages, setMonthPages] = useState<number[]>([]);
  const measurePages = useCallback(() => {
    const flow = flowRef.current;
    // While printing the flow is one long column: keep the screen pagination as it was.
    if (!flow || !geo || window.matchMedia('print').matches) return;
    const origin = flow.getBoundingClientRect().left;
    const step = geo.cw + geo.gap;
    const pageOf = (el: Element) => Math.floor((el.getBoundingClientRect().left - origin + 1) / step) + 1;
    const end = flow.querySelector('.yb-end');
    setTotal(end ? pageOf(end) : 1);
    setMonthPages([...flow.querySelectorAll('.yb-month-mark')].map(pageOf));
  }, [geo]);
  useLayoutEffect(() => {
    measurePages();
    let alive = true;
    void document.fonts?.ready.then(() => alive && measurePages());
    return () => {
      alive = false;
    };
  }, [measurePages, bodies, settings.writing]);

  // ---- current page (?page=N deep link) -------------------------------------------------------------
  const requested = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const page = Math.min(requested, total);
  const perView = geo?.spread ? 2 : 1;
  const first = geo?.spread ? (page % 2 === 1 ? page : page - 1) : page; // left page of the spread
  const goTo = useCallback(
    (p: number) => {
      const n = Math.min(Math.max(1, p), total);
      setParams(n === 1 ? {} : { page: String(n) }, { replace: true });
    },
    [setParams, total],
  );
  const next = useCallback(() => goTo(first + perView), [goTo, first, perView]);
  const prev = useCallback(() => goTo(first - perView), [goTo, first, perView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') next();
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
      else if (e.key === 'Home') goTo(1);
      else if (e.key === 'End') goTo(total);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, goTo, total]);

  // Tabbing to a link on another page turns to that page (and undoes the browser's attempt to
  // scroll the clipped flow into view).
  const onFocusIn = (e: React.FocusEvent<HTMLDivElement>) => {
    const flow = flowRef.current;
    if (!flow || !geo || e.target === e.currentTarget) return;
    e.currentTarget.scrollLeft = 0;
    e.currentTarget.scrollTop = 0;
    const p = Math.floor((e.target.getBoundingClientRect().left - flow.getBoundingClientRect().left + 1) / (geo.cw + geo.gap)) + 1;
    if (p < first || p >= first + perView) goTo(p);
  };

  // swipe (touch and pen); vertical movement still scrolls the page
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) next();
      else prev();
    }
  };

  // ---- export and print --------------------------------------------------------------------------
  const [busy, setBusy] = useState<null | 'export' | 'print'>(null);
  const [eager, setEager] = useState(false);
  const [status2, setStatus2] = useState('');

  const exportYear = async () => {
    setBusy('export');
    try {
      const res = await exportEntriesZip({ from: `${year}-01-01`, to: `${year}-12-31`, includeImages: true, combined: false, onProgress: setStatus2 });
      toast.show(
        res.failed.length
          ? `Exported ${count(res.count, 'entry', 'entries')}; skipped: ${res.failed.join('; ')}. The files are not encrypted; store them carefully.`
          : `Exported ${count(res.count, 'entry', 'entries')}. The Markdown files are not encrypted; store them carefully.`,
      );
    } catch (e) {
      toast.show(`Export failed: ${errorMessage(e)}`);
    } finally {
      setStatus2('');
      setBusy(null);
    }
  };

  const print = async () => {
    if (!bodies) return;
    setBusy('print');
    setStatus2('Preparing the pages…');
    setEager(true);
    const ids = [...new Set([...bodies.values()].flatMap((d) => collectBlobIds(d)))];
    try {
      // Every photo must be decrypted before the print dialog takes its snapshot.
      await Promise.allSettled(ids.map((id) => acquireImageUrl(id)));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.allSettled([...document.querySelectorAll<HTMLImageElement>('.yb-flow img')].map((img) => img.decode()));
      document.body.classList.add('print-book');
      const done = () => {
        document.body.classList.remove('print-book');
        window.removeEventListener('afterprint', done);
      };
      window.addEventListener('afterprint', done);
      window.print();
      // Some browsers return from print() before afterprint; keep the class until then.
      setTimeout(() => window.matchMedia('print').matches || done(), 1000);
    } finally {
      for (const id of ids) releaseImageUrl(id);
      setStatus2('');
      setBusy(null);
    }
  };

  // ---- render -----------------------------------------------------------------------------------------
  if (!valid) return <Navigate to="/books" replace />;
  const loadingEntries = status !== 'ready' && status !== 'error' && !items.length;
  const noEntries = !loadingEntries && status === 'ready' && yearEntries.length === 0;

  const pageNumber = (p: number) => (p <= total ? String(p) : '');
  const pageStatus = geo?.spread
    ? first + 1 <= total
      ? `Pages ${first}–${first + 1} of ${total}`
      : `Page ${first} of ${total}`
    : `Page ${page} of ${total}`;

  const vars = geo
    ? ({
        '--page-w': `${geo.pageW}px`,
        '--page-h': `${geo.pageH}px`,
        '--pad-x': `${geo.padX}px`,
        '--pad-top': `${geo.padTop}px`,
        '--cw': `${geo.cw}px`,
        '--ch': `${geo.ch}px`,
        '--gap': `${geo.gap}px`,
      } as React.CSSProperties)
    : undefined;

  return (
    <div className="page yearbook">
      <header className="yb-header">
        <Link to="/books" className="yb-back">
          <ChevronLeftIcon size={16} />
          Books
        </Link>
        <div className="yb-actions">
          {status2 && (
            <span className="hint" role="status">
              {status2}
            </span>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void print()} disabled={!bodies || !!busy}>
            {busy === 'print' && <Spinner />}
            Print
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void exportYear()} disabled={!yearEntries.length || !!busy}>
            {busy === 'export' && <Spinner />}
            Export this year
          </button>
        </div>
      </header>

      <main className="yb-main" id="main">
        {status === 'error' && !items.length ? (
          <p className="error-text" role="alert">
            Couldn’t load your entries. Check your connection and reload.
          </p>
        ) : loadingEntries || (!noEntries && !bodies) ? (
          <LoadingScreen label={progress || 'Decrypting entries…'} />
        ) : noEntries ? (
          <div className="views-empty">
            <h1 className="page-title">Nothing written in {year}</h1>
            <p className="lede">This book has no pages yet.</p>
            <Link to="/books" className="btn btn-secondary">
              Back to your books
            </Link>
          </div>
        ) : (
          <>
            <div
              className={`yb-frame${geo?.spread ? ' spread' : ''}`}
              ref={frameRef}
              style={vars}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (swipe.current = null)}
            >
              <div className="yb-sheet" aria-hidden />
              {geo && (
                <div className="yb-clip" onFocus={onFocusIn} onScroll={(e) => (e.currentTarget.scrollLeft = 0)}>
                  <div
                    className="yb-flow"
                    ref={flowRef}
                    style={{ transform: `translateX(${-(first - 1) * (geo.cw + geo.gap)}px)` }}
                  >
                    <section className="yb-front" aria-label="Contents">
                      <div className="yb-front-head">
                        <span className="yb-eyebrow">
                          {me.name} · {year}
                        </span>
                        <h1 className={cover.title ? 'yb-book-title' : 'yb-book-title plain'}>{cover.title || String(year)}</h1>
                        <span className="yb-book-stats">{totalsLine(stats, { photos: false })}</span>
                      </div>
                      <nav className="yb-contents" aria-label="Contents">
                        <span className="yb-eyebrow">Contents</span>
                        {months.map((m, i) => {
                          const p = monthPages[i];
                          return (
                            <a
                              key={m.month}
                              href={`?page=${p ?? 1}`}
                              className="yb-toc-row"
                              onClick={(e) => {
                                e.preventDefault();
                                if (p) goTo(p);
                              }}
                            >
                              <span>{m.name}</span>
                              <span className="yb-leader" aria-hidden />
                              <span className="yb-toc-count">{count(m.entries.length, 'entry', 'entries')}</span>
                              <span className="yb-toc-page">
                                <span className="visually-hidden">, page </span>
                                {p ?? ''}
                              </span>
                            </a>
                          );
                        })}
                      </nav>
                    </section>

                    {months.map((m) => (
                      <section className="yb-month" key={m.month} aria-label={m.name}>
                        <span className="yb-month-mark" aria-hidden />
                        <span className="yb-eyebrow yb-month-name">{m.name}</span>
                        {m.entries.map((e) => {
                          const doc = bodies!.get(e.id);
                          return (
                            <article className="yb-entry" key={e.id} aria-labelledby={`yb-${e.id}`}>
                              <header className="yb-entry-head">
                                <h2 id={`yb-${e.id}`}>{e.header.title || 'Untitled'}</h2>
                                <span className="yb-entry-date">{dateLine(e)}</span>
                              </header>
                              <div className="yb-body">
                                {doc === null ? <p className="yb-missing">This entry couldn’t be decrypted.</p> : renderDoc(doc, { eager, entry: e.header })}
                              </div>
                            </article>
                          );
                        })}
                      </section>
                    ))}
                    <span className="yb-end" aria-hidden />
                  </div>
                </div>
              )}
              {geo && (
                <div className="yb-folios" aria-hidden>
                  <span>{pageNumber(first)}</span>
                  {geo.spread && <span>{pageNumber(first + 1)}</span>}
                </div>
              )}
            </div>

            <nav className="yb-pager" aria-label="Pages">
              <button type="button" className="yb-turn" aria-label="Previous page" onClick={prev} disabled={first <= 1}>
                <ChevronLeftIcon size={16} />
              </button>
              <span className="yb-page-status" aria-live="polite">
                {pageStatus}
              </span>
              <button type="button" className="yb-turn" aria-label="Next page" onClick={next} disabled={first + perView > total}>
                <ChevronRightIcon size={16} />
              </button>
            </nav>
            <p className="yb-hint">Arrow keys turn pages{geo?.spread ? '' : ', or swipe'}. Pages are laid out in your writing font.</p>
          </>
        )}
      </main>
    </div>
  );
}

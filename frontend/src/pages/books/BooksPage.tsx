import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoadingScreen } from '../../components/Spinner';
import { entriesStore, useEntries } from '../../editor/entriesStore';
import { currentTimeZone } from '../../lib/format';
import { useIdentity } from '../../state/identity';
import { BOOK_TITLE_MAX, CLOTHS, type ClothId, coverFor, useSettings } from '../../state/settings';
import { datedEntries, dayInfo, hasViews, inYear, totals, totalsLine, yearsOf } from '../../views/journalData';
import { AppHeader } from '../../views/ViewNav';
import { ViewsEmpty } from '../../views/ViewsEmpty';
import { BookCover } from './BookCover';
import './books.css';

export default function BooksPage() {
  const me = useIdentity();
  const { items, status, error } = useEntries();
  const { settings, update, loadError, saveError } = useSettings();
  const [editing, setEditing] = useState<number | null>(null);
  const editorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void entriesStore.load();
  }, []);

  const all = useMemo(() => datedEntries(items), [items]);
  const years = useMemo(() => yearsOf(all), [all]);
  const available = useMemo(() => hasViews(items), [items]);
  const thisYear = dayInfo(new Date().toISOString(), currentTimeZone())!.year;
  const selected = editing ?? years[0];
  const loading = status !== 'ready' && status !== 'error' && !items.length;

  const editCover = (year: number) => {
    setEditing(year);
    requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      editorRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  };

  return (
    <div className="page views-page">
      <AppHeader />
      <main className="books" id="main">
        {loading ? (
          <LoadingScreen label="Decrypting entries…" />
        ) : status === 'error' && !items.length ? (
          <p className="error-text" role="alert">{error ?? "Couldn't load your entries."}</p>
        ) : !available ? (
          <ViewsEmpty view="books" />
        ) : (
          <>
            <div className="stack" style={{ gap: 8 }}>
              <h1 className="books-title">Books</h1>
              <p className="lede">Each year you write becomes a book. Open one to read it start to finish, or to export it.</p>
            </div>

            <ul className="shelf" aria-label="Your books">
              {years.map((y) => {
                const cover = coverFor(settings.books, y);
                const t = totals(inYear(all, y));
                return (
                  <li key={y} className="shelf-book">
                    <Link to={`/books/${y}`} className="book-link" aria-label={`${y}${cover.title ? `, ${cover.title}` : ''}: open the book. ${totalsLine(t, { places: false, photos: false })}`}>
                      <BookCover year={y} cover={cover} username={me.name} inProgress={y === thisYear} />
                      <span className="book-caption" aria-hidden>
                        <span className="book-caption-year">{y}</span>
                        <span className="book-caption-stats">{totalsLine(t, { places: false, photos: false })}</span>
                      </span>
                    </Link>
                    <button type="button" className="btn-link small book-edit" onClick={() => editCover(y)} aria-label={`Edit the ${y} cover`}>
                      Edit cover
                    </button>
                  </li>
                );
              })}
            </ul>

            {selected !== undefined && (
              <CoverEditor
                sectionRef={editorRef}
                year={selected}
                title={coverFor(settings.books, selected).title}
                cloth={coverFor(settings.books, selected).cloth}
                disabledReason={loadError}
                saveError={saveError}
                onChange={(next) =>
                  update((s) => ({ ...s, books: { ...s.books, [String(selected)]: { ...coverFor(s.books, selected), ...next } } }))
                }
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

interface EditorProps {
  year: number;
  title: string;
  cloth: ClothId;
  disabledReason: string | null;
  saveError: string | null;
  onChange: (c: { title?: string; cloth?: ClothId }) => void;
  sectionRef: React.Ref<HTMLElement>;
}

function CoverEditor({ year, title, cloth, disabledReason, saveError, onChange, sectionRef }: EditorProps) {
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  const pick = (i: number) => {
    const c = CLOTHS[(i + CLOTHS.length) % CLOTHS.length];
    onChange({ cloth: c.id });
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[CLOTHS.indexOf(c)]?.focus();
  };
  const current = Math.max(0, CLOTHS.findIndex((c) => c.id === cloth));
  return (
    <section className="cover-editor" ref={sectionRef} aria-labelledby={`${id}-h`}>
      <div className="cover-editor-intro">
        <h2 id={`${id}-h`}>Edit the {year} cover</h2>
        <p>Give a year a title and a cloth. It's stored encrypted with the rest of your settings.</p>
        {(disabledReason || saveError) && (
          <p className="error-text" role="alert">
            {disabledReason ?? saveError}
          </p>
        )}
      </div>
      <div className="cover-editor-fields">
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor={`${id}-title`}>Title</label>
          <input
            id={`${id}-title`}
            className="input cover-title-input"
            type="text"
            value={title}
            maxLength={BOOK_TITLE_MAX}
            placeholder="Untitled"
            disabled={!!disabledReason}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </div>
        <div className="field" style={{ flex: '1 1 220px', gap: 8 }}>
          <span className="label" id={`${id}-cloth`}>
            Cloth
          </span>
          <div
            role="radiogroup"
            aria-labelledby={`${id}-cloth`}
            className="cloths"
            ref={group}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pick(current + 1);
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pick(current - 1);
              else if (e.key === 'Home') pick(0);
              else if (e.key === 'End') pick(CLOTHS.length - 1);
              else return;
              e.preventDefault();
            }}
          >
            {CLOTHS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={c.id === cloth}
                aria-label={c.name}
                title={c.name}
                tabIndex={c.id === cloth ? 0 : -1}
                className="cloth"
                disabled={!!disabledReason}
                onClick={() => onChange({ cloth: c.id })}
              >
                <span style={{ background: c.hex }} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

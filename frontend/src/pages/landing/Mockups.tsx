/**
 * Illustrations of the app for the landing page, drawn from the design boards (design/Editor,
 * Timeline, Books and Mobile .dc.html). Decorative: each is one labelled image to assistive tech.
 */
import { BookCover } from '../books/BookCover';
import { Brand } from '../../components/Brand';
import { LockIcon, PinIcon, SearchIcon } from '../../components/Icons';

export function EditorMock() {
  const groups = [
    {
      label: 'November',
      items: [
        ['11', 'A long walk after the rain', 'Clifton · 412 words', true],
        ['09', 'Sunday, slowly', '268 words', false],
        ['06', 'The new desk', 'Home · 190 words', false],
      ],
    },
    {
      label: 'October',
      items: [
        ['30', 'First frost', '341 words', false],
        ['24', 'Letters from Ana', '522 words', false],
      ],
    },
  ] as const;
  return (
    <div className="mock mock-window" role="img" aria-label="The writing screen: a list of entries beside an open entry">
      <div className="mock-chrome" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="mock-editor" aria-hidden>
        <aside className="mock-side">
          <div className="mock-side-brand">
            <Brand to={null} size={17} />
          </div>
          <div className="mock-search">
            <SearchIcon size={12} /> Search entries
          </div>
          {groups.map((g) => (
            <div key={g.label} className="mock-group">
              <div className="mock-group-label">{g.label}</div>
              {g.items.map(([day, title, meta, on]) => (
                <div key={title} className={`mock-item${on ? ' on' : ''}`}>
                  <span className="mock-day">{day}</span>
                  <span className="mock-item-text">
                    <span className="mock-item-title">{title}</span>
                    <span className="mock-item-meta">{meta}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </aside>
        <div className="mock-entry">
          <div className="mock-status">
            <LockIcon size={11} /> Encrypted · saved
          </div>
          <div className="mock-meta">
            <span>Tuesday · 11 November</span>
            <span>21:40</span>
            <span className="mock-place">
              <PinIcon size={11} /> Clifton, Bristol
            </span>
          </div>
          <div className="mock-title">A long walk after the rain</div>
          <p className="mock-body">
            The river was higher than I expected. I stood on the footbridge for a long time, not thinking about anything in particular, which is{' '}
            <em>exactly</em> what I came for.
          </p>
          <p className="mock-body">
            By the time I turned back the lamps were on along the towpath, and the water had gone the colour of slate.
          </p>
          <p className="mock-body">
            I want to remember this feeling of having nowhere to be<span className="mock-caret" />
          </p>
        </div>
      </div>
    </div>
  );
}

/** Deterministic "days written" for the year strip. */
function stripDays(month: number, len: number) {
  return Array.from({ length: len }, (_, d) => {
    const v = Math.sin((month + 1) * 12.9898 + (d + 1) * 78.233) * 43758.5453;
    const r = v - Math.floor(v);
    if (month > 10 || (month === 10 && d > 11)) return 0; // the rest of the year hasn't happened yet
    return r > 0.82 ? 3 : r > 0.62 ? 2 : r > 0.42 ? 1 : 0;
  });
}

export function TimelineMock() {
  const months = 'JFMAMJJASOND'.split('');
  const entries = [
    ['11', 'Tue', 'A long walk after the rain', 'The river was higher than I expected…', 'Clifton'],
    ['09', 'Sun', 'Sunday, slowly', 'Pancakes, the crossword, and nowhere to be.', ''],
    ['06', 'Thu', 'The new desk', 'It fits under the window, just about.', 'Home'],
  ] as const;
  return (
    <div className="mock mock-card mock-timeline" role="img" aria-label="The timeline: a year of writing at a glance, then entries by month">
      <div aria-hidden>
        <div className="mock-tl-head">
          <span className="mock-tl-year">2026</span>
          <span className="mock-tl-stats">142 entries · 61,300 words · 23 places</span>
        </div>
        <div className="mock-strip">
          {months.map((m, i) => (
            <div key={i} className="mock-strip-month">
              <div className="mock-strip-days">
                {stripDays(i, 28).map((v, d) => (
                  <span key={d} className={`l${v}`} />
                ))}
              </div>
              <span className="mock-strip-label">{m}</span>
            </div>
          ))}
        </div>
        <div className="mock-tl-month">November</div>
        <div className="mock-tl-list">
          {entries.map(([day, wd, title, snippet, place]) => (
            <div key={title} className="mock-tl-row">
              <div className="mock-tl-date">
                <span className="mock-tl-day">{day}</span>
                <span className="mock-tl-wd">{wd}</span>
              </div>
              <span className="mock-tl-dot" />
              <div className="mock-tl-entry">
                <div className="mock-tl-text">
                  <span className="mock-tl-title">{title}</span>
                  <span className="mock-tl-snippet">{snippet}</span>
                  {place && (
                    <span className="mock-tl-place">
                      <PinIcon size={10} /> {place}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ShelfMock() {
  return (
    <div className="mock mock-shelf" role="img" aria-label="Books: each year bound as a cloth-covered book on a shelf">
      <div className="mock-shelf-books" aria-hidden>
        <BookCover year={2024} cover={{ title: '', cloth: 'bottle' }} username="you" inProgress={false} />
        <BookCover year={2025} cover={{ title: 'The year we moved', cloth: 'oxblood' }} username="you" inProgress={false} />
        <BookCover year={2026} cover={{ title: '', cloth: 'ink' }} username="you" inProgress={false} />
      </div>
      <div className="mock-shelf-plank" aria-hidden />
    </div>
  );
}

export function PhoneMock() {
  return (
    <div className="mock mock-phone" role="img" aria-label="Writing on a phone, in a dark theme">
      <div className="mock-phone-screen" aria-hidden>
        <div className="mock-phone-notch" />
        <div className="mock-phone-bar">
          <span>‹</span>
          <span className="mock-phone-saved">
            <LockIcon size={10} /> Saved
          </span>
          <span>···</span>
        </div>
        <div className="mock-phone-meta">
          Wed · 12 Nov · 07:15 · <PinIcon size={10} /> Home
        </div>
        <div className="mock-phone-title">Early, before anyone</div>
        <p className="mock-phone-body">
          The kettle, the grey light, the radiator ticking as it warms. I like the house best like this, when it hasn't decided what kind of day it is
          yet.
        </p>
        <p className="mock-phone-body">
          Three things for today<span className="mock-caret" />
        </p>
        <div className="mock-phone-tools">
          <b>B</b>
          <i>I</i>
          <span>H</span>
          <span>“</span>
        </div>
      </div>
    </div>
  );
}

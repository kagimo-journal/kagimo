import { Link } from 'react-router-dom';
import { BookIcon } from '../components/Icons';

/** Shown on /timeline and /books before entries exist on two different days. */
export function ViewsEmpty({ view }: { view: 'timeline' | 'books' }) {
  return (
    <div className="views-empty">
      <span className="badge-circle" aria-hidden>
        <BookIcon size={26} />
      </span>
      <h1 className="page-title">{view === 'timeline' ? 'Your timeline starts soon' : 'Your books start soon'}</h1>
      <p className="lede">
        {view === 'timeline'
          ? 'Once you’ve written on two different days, your entries appear here on a timeline, year by year.'
          : 'Once you’ve written on two different days, each year you write becomes a book you can read cover to cover.'}
      </p>
      <Link to="/" className="btn btn-primary">
        Write an entry
      </Link>
    </div>
  );
}

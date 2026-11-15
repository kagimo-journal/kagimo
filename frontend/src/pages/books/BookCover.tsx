import { CLOTHS, type BookCover as Cover } from '../../state/settings';

export function clothOf(cover: Cover) {
  return CLOTHS.find((c) => c.id === cover.cloth) ?? CLOTHS[0];
}

/** A cloth-bound cover (design/Books.dc.html): spine, "journal", year, title, owner, ribbon. */
export function BookCover({ year, cover, username, inProgress }: { year: number; cover: Cover; username: string; inProgress: boolean }) {
  const cloth = clothOf(cover);
  return (
    <span className="book-cover" style={{ background: cloth.hex, color: cloth.foil }}>
      <span className="book-spine" aria-hidden />
      <span className="book-spine-edge" aria-hidden />
      <span className="book-imprint">journal</span>
      <span className="book-centre">
        <span className="book-year">{year}</span>
        <span className="book-rule" style={{ background: cloth.foil }} aria-hidden />
        <span className="book-title">{cover.title}</span>
      </span>
      <span className="book-owner">{username}</span>
      {inProgress && <span className="book-ribbon">In progress</span>}
    </span>
  );
}

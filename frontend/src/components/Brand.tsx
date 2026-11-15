import { Link } from 'react-router-dom';

/**
 * The Kagimo lockup: the 「・」 mark followed by the lowercase wordmark. `size` is the wordmark's
 * font size; the mark scales with it (see .brand in global.css). Both mark variants are rendered
 * and CSS shows the one that suits the current theme, since the theme can change after render.
 */
export function Brand({ size = 24, to = '/' }: { size?: number; to?: string | null }) {
  const inner = (
    <>
      <img className="brand-mark brand-mark-on-light" src="/brand/kagimo-mark.svg" alt="" width={31} height={33} />
      <img className="brand-mark brand-mark-on-dark" src="/brand/kagimo-mark-light.svg" alt="" width={31} height={33} />
      <span className="brand-word">kagimo</span>
    </>
  );
  if (to === null) return <div className="brand" style={{ fontSize: size }}>{inner}</div>;
  return (
    <Link className="brand" to={to} style={{ fontSize: size }} aria-label="Kagimo, home">
      {inner}
    </Link>
  );
}

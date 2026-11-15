import { Link } from 'react-router-dom';
import { Brand } from '../../components/Brand';
import { CloudIcon, KeyIcon, LockIcon, ShieldIcon } from '../../components/Icons';
import { signUpDialog } from '../../components/SignUpDialog';
import { priceLabel } from '../../billing/paywallState';
import { CRYPTO_SOURCE_URL, SUPPORT_EMAIL } from '../../lib/support';
import { useVault } from '../../local/vault';
import { useAuth, useReturningVisitor } from '../../state/auth';
import { useUnlocked } from '../../state/lock';
import { BurnDemo } from './BurnDemo';
import { DesktopDownload } from './DesktopDownload';
import { EditorMock, PhoneMock, ShelfMock, TimelineMock } from './Mockups';
import '../books/books.css';
import './landing.css';

/** Sections the header menu jumps to. */
const SECTIONS = [
  ['privacy', 'Privacy'],
  ['no-tracking', 'No tracking'],
  ['burn', 'Burn it'],
  ['features', 'Features'],
  ['sync', 'Sync'],
] as const;

/** A "page" of journal: about 300 words, which encrypts to roughly 2.7 KB on the server (measured: 348 words stored as 3.2 KB with the settings). */
const PAGE_BYTES = 2700;

/**
 * Sync space in writing rather than bytes: "~170" pages (the free 450 KB) or "~37,000" pages and
 * "over 100 years" of a page a day (the paid 100 MB). The time comes from the unrounded count.
 */
function inWriting(bytes: number): { pages: string; time: string } {
  const exact = bytes / PAGE_BYTES;
  const step = exact >= 10_000 ? 1000 : exact >= 1000 ? 100 : 10;
  const pages = Math.max(10, Math.round(exact / step) * step).toLocaleString('en');
  const months = Math.max(1, Math.round(exact / 30.44));
  if (months < 24) return { pages, time: `${months} ${months === 1 ? 'month' : 'months'}` };
  const years = Math.floor(months / 12);
  // "over 100 years" rather than a falsely precise "109 years"
  return { pages, time: years >= 20 ? `over ${Math.floor(years / 10) * 10} years` : `${years} years` };
}

/**
 * The front page for new visitors (`/` when signed out and this browser is new, and `/welcome`): one
 * page whose header menu jumps between sections. Wording mirrors design/landing-copy.md; every claim
 * must stay true of the code. "Start writing" scrolls to the closing section, which holds the real
 * "Write now" link (a journal on this device only), a "Sign up" button (the sign-up dialog: a sync
 * account, optionally a subscription) and a plain "Sign in" link. Someone who has been here before
 * (signed in on this browser, or carrying the device cookie) is greeted with "Welcome back." instead.
 */
export default function LandingPage() {
  const vault = useVault();
  const unlocked = useUnlocked();
  const home = vault ? (unlocked ? '/' : '/unlock') : null;
  const returning = useReturningVisitor();
  const { config } = useAuth();
  const plan = config?.billing?.enabled ? config.billing : null;
  const free = plan ? inWriting(plan.freeBytes) : null;
  const paid = plan ? inWriting(plan.paidBytes) : null;
  const price = priceLabel(plan ?? undefined);

  return (
    <div className="page landing">
      <header className="landing-header">
        <div className="landing-header-inner">
          <a href="#top" className="landing-brand" aria-label="Kagimo, back to top">
            <Brand to={null} />
          </a>
          <nav className="landing-menu" aria-label="Sections">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
          {home ? (
            <Link to={home} className="btn btn-primary btn-sm landing-signin">
              Open your journal
            </Link>
          ) : (
            <Link to="/signin" className="btn btn-secondary btn-sm landing-signin">
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main id="main" className="landing-main">
        <section id="top" className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <span className="landing-eyebrow">
              <LockIcon size={13} /> Private by default · no tracking · works offline
            </span>
            <h1 id="landing-title">A journal only you can read.</h1>
            <p className="landing-lede">
              A quiet place to write, with places and a book for every year. Your journal is stored on your device, and nothing is sent
              anywhere unless you turn on sync. Sync is end-to-end encrypted, so the copy on our server is unreadable to us and to anyone else.
            </p>
            <div className="landing-ctas">
              {home ? (
                <Link to={home} className="btn btn-primary btn-lg">
                  Open your journal
                </Link>
              ) : (
                <a href="#start" className="btn btn-primary btn-lg">
                  Start writing
                </a>
              )}
              <a href="#privacy" className="btn btn-secondary btn-lg">
                How privacy works
              </a>
            </div>
            <DesktopDownload downloads={config?.downloads} />
          </div>
          <div className="landing-hero-art">
            <EditorMock />
          </div>
        </section>

        <section id="privacy" className="landing-band" aria-labelledby="landing-privacy-title">
          <div className="landing-band-inner">
            <h2 id="landing-privacy-title">Only your passphrase can decrypt your journal, and we never see it.</h2>
            <ul className="landing-points">
              <li>
                <LockIcon size={20} />
                <strong>Completely on your device</strong>
                <span>Your journal is stored, encrypted, in your browser. Unless you turn on sync, none of it ever reaches our server.</span>
              </li>
              <li>
                <KeyIcon size={20} />
                <strong>Only your passphrase opens it</strong>
                <span>It never leaves your device. Without it, the stored journal can’t be decrypted by anyone.</span>
              </li>
              <li>
                <CloudIcon size={20} />
                <strong>Sync, if you want it</strong>
                <span>
                  Turn it on to write on all your devices and keep a backup. Everything is encrypted before upload, and you can add a passkey or
                  authenticator app to sign-in.
                </span>
              </li>
            </ul>
            <div className="landing-more-row">
              <Link to="/about" className="landing-more">
                The full details →
              </Link>
              <a href={CRYPTO_SOURCE_URL} className="landing-more" target="_blank" rel="noopener noreferrer">
                Read the encryption code →
              </a>
            </div>
          </div>
        </section>

        <section id="no-tracking" className="landing-section" aria-labelledby="landing-tracking-title">
          <div className="landing-section-head">
            <span className="landing-kicker">
              <ShieldIcon size={14} /> No tracking
            </span>
            <h2 id="landing-tracking-title">No tracking of any kind. Not a single tag.</h2>
            <p>
              Nothing on this page watches what you do: not what you read, where you click or how long you stay. There is no code here that
              reports on you, to us or to anyone else.
            </p>
          </div>
          <ul className="landing-nots">
            <li>
              <strong>No analytics</strong>
              <span>No analytics scripts, heatmaps, session recordings or “product insights”.</span>
            </li>
            <li>
              <strong>No ad or social tags</strong>
              <span>No pixels, no like or share buttons, no embedded widgets that report back to anyone.</span>
            </li>
            <li>
              <strong>No third-party code</strong>
              <span>
                Every script and font comes from our own server. The page tells your browser to refuse scripts from anywhere else, so none can
                slip in.
              </span>
            </li>
            <li>
              <strong>No tracking cookies</strong>
              <span>The only cookies keep you signed in to sync and recognise this device at sign-in. Neither is shared with anyone.</span>
            </li>
          </ul>
          <p className="landing-fine landing-section-fine">
            Only three things ever talk to another site, and only when you ask: the weather, if you turn it on (Open-Meteo is sent your location
            rounded to about 10 km, with no cookies), Stripe’s checkout, which opens in its own tab if you subscribe to sync, and the desktop app’s
            download, which comes from GitHub. Our server keeps only the totals any
            service needs to stay healthy, such as how many requests it handled and how many people synced recently: never who, and never
            what.
          </p>
        </section>

        <section id="burn" className="landing-feature flip" aria-labelledby="landing-burn-title">
          <div className="landing-feature-copy">
            <span className="landing-kicker">Burn it</span>
            <h2 id="landing-burn-title">Some thoughts are for writing, not keeping.</h2>
            <p>
              Write out the thing that’s keeping you up, then burn it. The page drifts off as ash, crumbles away or goes up in smoke, and the entry is
              deleted for good: from this device and, with sync on, from our server and your other devices.
            </p>
            <p>There’s no trash folder and no undo. Once it burns, nobody can bring it back, including us.</p>
          </div>
          <div className="landing-feature-art">
            <BurnDemo />
          </div>
        </section>

        <div id="features" className="landing-features">
          <section className="landing-feature" aria-labelledby="f-look-back">
            <div className="landing-feature-copy">
              <h2 id="f-look-back">Look back on a whole year</h2>
              <p>The timeline shows every day you wrote at a glance, then your entries month by month, with the places you were.</p>
            </div>
            <div className="landing-feature-art">
              <TimelineMock />
            </div>
          </section>

          <section className="landing-feature flip" aria-labelledby="f-books">
            <div className="landing-feature-copy">
              <h2 id="f-books">A book for every year</h2>
              <p>
                Each year you write becomes a book you can read start to finish. Give it a title and a cloth cover, then print it or export it.
              </p>
            </div>
            <div className="landing-feature-art">
              <ShelfMock />
            </div>
          </section>

          <section className="landing-feature" aria-labelledby="f-anywhere">
            <div className="landing-feature-copy">
              <h2 id="f-anywhere">Write wherever you are</h2>
              <p>
                It works in the browser on your laptop and your phone, online or off, in light and dark themes. You can export everything as
                Markdown at any time.
              </p>
            </div>
            <div className="landing-feature-art">
              <PhoneMock />
            </div>
          </section>
        </div>

        <section className="landing-pledge" aria-labelledby="landing-pledge-title">
          <h2 id="landing-pledge-title" className="landing-kicker">Our pledge</h2>
          <p>No AI anywhere, and zero enshittification for life.</p>
        </section>

        <section id="sync" className="landing-band" aria-labelledby="landing-sync-title">
          <div className="landing-band-inner landing-sync">
            <div className="landing-section-head">
              <span className="landing-kicker">
                <CloudIcon size={14} /> Sync
              </span>
              <h2 id="landing-sync-title">{plan ? `Try sync free for ${plan.freeDays} days.` : 'Sync is optional.'}</h2>
              <p>
                Writing on one device is free, with no limit. Turn on sync when you want your journal on your phone and laptop at once, with an
                encrypted backup on our server.
              </p>
            </div>
            {free && paid && (
              <div className="landing-plans">
                <div className="landing-plan">
                  <h3>Free trial</h3>
                  <p className="landing-plan-price">Free, no card needed</p>
                  <p className="landing-plan-room">
                    <span className="landing-plan-num">{plan!.freeDays}</span> days
                  </p>
                  <p className="landing-plan-time">Of sync, from when you turn it on, for up to ~{free.pages} pages</p>
                  <ul>
                    <li>Sync between all your devices, as many as you like</li>
                    <li>An encrypted backup on our server</li>
                    <li>
                      When the trial ends, keep writing: new changes wait on your device until you subscribe, and everything already synced
                      stays yours
                    </li>
                  </ul>
                </div>
                <div className="landing-plan featured">
                  <h3>Subscription</h3>
                  <p className="landing-plan-price">{price || 'Paid'}</p>
                  <p className="landing-plan-room">
                    <span className="landing-plan-num">~{paid.pages}</span> pages
                  </p>
                  <p className="landing-plan-time">A page a day for {paid.time}</p>
                  <ul>
                    <li>Sync between all your devices and an encrypted backup, for as long as you subscribe</li>
                    <li>Room for a lifetime of writing (a fair-use limit)</li>
                    <li>Cancel any time: everything already synced stays yours to read, edit and export</li>
                  </ul>
                </div>
              </div>
            )}
            {free && (
              <p className="landing-fine landing-section-fine">
                A page here is about 300 words. Journals are text only, so writing goes a long way.
              </p>
            )}
          </div>
        </section>

        <section id="start" className="landing-start" aria-labelledby="landing-ready">
          {home ? (
            <>
              <h2 id="landing-ready">Your journal is on this device.</h2>
              <Link to={home} className="btn btn-primary btn-lg landing-big">
                Open your journal
              </Link>
            </>
          ) : (
            <>
              <h2 id="landing-ready">{returning ? 'Welcome back.' : 'Ready when you are.'}</h2>
              <div className="landing-start-actions">
                <Link to="/signup" className="btn btn-primary btn-lg landing-big">
                  Write now
                </Link>
                <button type="button" className="btn btn-secondary btn-lg landing-big" onClick={() => signUpDialog.open()}>
                  Sign up
                </button>
              </div>
              <p className="landing-start-signin">
                Already sync on another device? <Link to="/signin">Sign in</Link>
              </p>
              <p className="landing-fine">
                <strong>Write now</strong> sets up a journal on this device in about a minute, with no account or email. Turn on sync from
                inside it whenever you like. <strong>Sign up</strong> makes a sync account straight away
                {plan ? `: free for ${plan.freeDays} days, then ${price}` : ''}.
              </p>
            </>
          )}
        </section>
      </main>

      <footer className="landing-footer">
        <Brand to={null} size={18} />
        <nav aria-label="Footer">
          <Link to="/about">How it works</Link>
          <Link to="/terms">Terms</Link>
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </nav>
      </footer>
    </div>
  );
}

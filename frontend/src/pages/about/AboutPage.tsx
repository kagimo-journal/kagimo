import { Link } from 'react-router-dom';
import { Brand } from '../../components/Brand';
import { CheckIcon, XIcon } from '../../components/Icons';
import { CRYPTO_SOURCE_URL, SOURCE_URL, SUPPORT_EMAIL } from '../../lib/support';
import { useVault } from '../../local/vault';
import { useReturningVisitor } from '../../state/auth';
import { useUnlocked } from '../../state/lock';
import './about.css';

/**
 * How it works: the safety and privacy page (no sign-in). The wording mirrors design/about-copy.md.
 * Every claim must stay true of the code: change the copy file and this page together.
 */
export default function AboutPage() {
  const vault = useVault();
  const unlocked = useUnlocked();
  const home = vault ? (unlocked ? '/' : '/unlock') : null;
  const returning = useReturningVisitor();
  const signUp = 'Start writing';

  return (
    <div className="page about">
      <header className="page-header">
        <Brand to={home ?? '/welcome'} />
        <nav className="header-links" aria-label="Account">
          {home ? (
            <Link to={home}>Open your journal</Link>
          ) : returning ? (
            <Link to="/signin" className="btn btn-primary btn-sm about-signup">
              Sign in
            </Link>
          ) : (
            <>
              <Link to="/signin">Sign in to sync</Link>
              <Link to="/signup" className="btn btn-primary btn-sm about-signup">
                {signUp}
              </Link>
            </>
          )}
        </nav>
      </header>

      <main id="main" className="about-main">
        <section className="about-hero" aria-labelledby="about-title">
          <span className="about-eyebrow">How it works</span>
          <h1 id="about-title">How your journal stays private</h1>
          <p className="about-lede">
            Kagimo runs entirely on your device. Your journal is stored there, encrypted, and nothing is sent anywhere unless you turn on sync.
            With sync on, everything is encrypted before it leaves your device. Our server stores it but never has the key, so neither we nor anyone
            else can read it.
          </p>
        </section>

        <figure className="about-flow" aria-labelledby="flow-caption">
          <div className="about-flow-steps">
            <div className="about-flow-box">
              <span className="about-flow-label">Your device</span>
              <span className="about-flow-plain">A long walk after the rain</span>
              <span className="about-flow-note">You write. Your key, unlocked by your passphrase, encrypts it here.</span>
            </div>
            <span className="about-flow-arrow" aria-hidden>
              →
            </span>
            <div className="about-flow-box">
              <span className="about-flow-label">Stored on your device</span>
              <span className="about-flow-cipher" aria-hidden>
                kq9T·xR2v·8fLm·Zc0w·Ue7j·H4pN
              </span>
              <span className="about-flow-note">Saved encrypted in your browser. Works offline. This is where it stays.</span>
            </div>
            <span className="about-flow-arrow" aria-hidden>
              ⇢
            </span>
            <div className="about-flow-box">
              <span className="about-flow-label">Our server, only with sync</span>
              <span className="about-flow-cipher" aria-hidden>
                ▒▒▒▒▒▒ ▒▒▒▒ ▒▒▒▒▒ ▒▒▒
              </span>
              <span className="about-flow-note">If you turn sync on, it keeps the same scrambled copy for your other devices. It has no key.</span>
            </div>
          </div>
          <figcaption id="flow-caption">Your words are readable only on a device where you've unlocked your journal.</figcaption>
        </figure>

        <section className="about-section" aria-labelledby="how">
          <h2 id="how">What keeps it private</h2>
          <ol className="about-steps">
            <li>
              <h3>It all happens on your device.</h3>
              <p>No account needed. Your journal is written, stored and searched in your browser, and works without a connection.</p>
            </li>
            <li>
              <h3>Your passphrase stays on your device.</h3>
              <p>It locks your journal key. Even what's stored in your browser is unreadable without it.</p>
            </li>
            <li>
              <h3>Sync is optional, and encrypted.</h3>
              <p>
                Turn it on to use your journal on all your devices and keep a copy safe. Entries, titles, places and settings are encrypted
                before upload, so our server only ever receives encrypted data.
              </p>
            </li>
            <li>
              <h3>Places stay private.</h3>
              <p>Place names are looked up on your device, so your coordinates never leave it.</p>
            </li>
            <li>
              <h3>Optional two-factor sign-in.</h3>
              <p>Add a passkey or authenticator app to your sync account, so a stolen password alone isn't enough to sign in.</p>
            </li>
            <li>
              <h3>Locked when you step away.</h3>
              <p>Keys live in memory. They're forgotten when you lock, close the tab, or after a few idle minutes (you choose how many). Reloading the page keeps the journal open.</p>
            </li>
          </ol>
          <p className="about-extensions">
            <strong>Tip:</strong> browser extensions can read any page. For the most privacy, write in a window without them.
          </p>
        </section>

        <section className="about-section" aria-labelledby="server-sees">
          <h2 id="server-sees">What we can and can't see</h2>
          <p>Without sync: nothing at all. Your journal never reaches us. With sync on:</p>
          <div className="about-compare">
            <div className="about-box">
              <h3>
                <XIcon size={16} /> Never
              </h3>
              <ul>
                <li>What you write, and entry titles</li>
                <li>The places you tag</li>
                <li>Your settings and book titles</li>
                <li>Your passphrase or recovery key</li>
              </ul>
            </div>
            <div className="about-box">
              <h3>
                <CheckIcon size={16} /> We can see
              </h3>
              <ul>
                <li>Your sync username</li>
                <li>How many entries you have, and their sizes</li>
                <li>Connection details like your IP address</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="about-section about-tradeoff" aria-labelledby="tradeoff">
          <h2 id="tradeoff">The trade-off</h2>
          <p>
            <strong>Nobody can reset your passphrase.</strong> Keep the recovery key you get when you start your journal somewhere safe. Lose
            both, and your journal is gone for good.
          </p>
          <p>
            <strong>Without sync, your journal exists in one place.</strong> If the browser's data is cleared or the device is lost, it goes too.
            Export it now and then, or turn on sync.
          </p>
          <p>The app itself is delivered by our server (then kept on your device), so you are trusting us not to change that code.</p>
        </section>

        <details className="about-details">
          <summary>For the curious</summary>
          <ul>
            <li>
              Passphrase stretched with <strong>Argon2id</strong> (64 MiB, 3 passes); keys derived with <strong>HKDF-SHA-256</strong>.
            </li>
            <li>
              Content encrypted with <strong>AES-256-GCM</strong>, a fresh nonce per item, each ciphertext bound to its own entry or
              setting.
            </li>
            <li>Passkeys can unlock your journal where the WebAuthn PRF extension is supported.</li>
            <li>The recovery key is 160 random bits, shown as 32 characters.</li>
            <li>
              On your device, the journal is kept in IndexedDB in the same encrypted form the server would store; the app itself is cached by a
              service worker so it opens offline.
            </li>
            <li>Edits made on two devices at once are merged paragraph by paragraph on your device; only clashing passages ask you to choose.</li>
            <li>
              The encryption code is also published on its own (MIT), with its design and threat model:{' '}
              <a href={CRYPTO_SOURCE_URL} target="_blank" rel="noopener noreferrer">
                github.com/kagimo-journal/crypto
              </a>
              .
            </li>
            <li>
              The whole app is open source (AGPL):{' '}
              <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
                github.com/kagimo-journal/kagimo
              </a>
              . It reaches your browser as readable code, not minified: open your browser’s developer tools to read exactly what runs.
              Review is welcome. Tell us what you find at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
            </li>
            <li>
              With sync on, Settings → Sync &amp; backup shows your latest entry beside what our server stores for it, and every request
              your device has sent.
            </li>
          </ul>
        </details>

        {!home && (
          <section className="about-cta" aria-labelledby="ready">
            <h2 id="ready">{returning ? 'Sign in to open your journal' : 'Ready to start writing?'}</h2>
            <div className="about-ctas">
              <Link to={returning ? '/signin' : '/signup'} className="btn btn-primary btn-lg">
                {returning ? 'Sign in' : signUp}
              </Link>
              <Link to="/welcome" className="btn btn-secondary btn-lg">
                Take the tour
              </Link>
            </div>
            {!returning && <p>No account needed. You can turn on sync later.</p>}
          </section>
        )}
      </main>

      <footer className="about-footer">
        <Link to="/terms">Terms of Service</Link>
        <span>
          Questions or problems? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </span>
      </footer>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { Brand } from '../../components/Brand';
import { useVault } from '../../local/vault';
import { useUnlocked } from '../../state/lock';
import { SOURCE_URL, SUPPORT_EMAIL } from '../../lib/support';
import '../about/about.css';
import './terms.css';

const TERMS_UPDATED = '16 November 2026';

const Mail = () => <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

/**
 * Terms of Service (no sign-in). Plain words, but they are the contract: keep them true of the
 * code (what the server can see, what happens on cancellation) and bump TERMS_UPDATED on any change.
 */
export default function TermsPage() {
  const vault = useVault();
  const unlocked = useUnlocked();
  const home = vault ? (unlocked ? '/' : '/unlock') : null;

  return (
    <div className="page about terms">
      <header className="page-header">
        <Brand to={home ?? '/welcome'} />
        <nav className="header-links" aria-label="Site">
          {home ? <Link to={home}>Open your journal</Link> : <Link to="/about">How it works</Link>}
        </nav>
      </header>

      <main id="main" className="about-main terms-main">
        <section className="about-hero" aria-labelledby="terms-title">
          <span className="about-eyebrow">Legal</span>
          <h1 id="terms-title">Terms of Service</h1>
          <p className="terms-updated">Last updated {TERMS_UPDATED}</p>
          <p className="about-lede">
            These terms are the agreement between you and Kagimo (“we”, “us”) for using the Kagimo app and website at kagimo.com and the
            optional sync service (together, “the Service”). By using the Service you agree to them. If you don’t agree, don’t use it.
          </p>
        </section>

        <nav className="terms-toc" aria-label="Contents">
          <ol>
            <li><a href="#t-service">The Service</a></li>
            <li><a href="#t-eligibility">Who can use it</a></li>
            <li><a href="#t-content">Your content</a></li>
            <li><a href="#t-acceptable">Acceptable use</a></li>
            <li><a href="#t-encryption">Encryption, monitoring and reports</a></li>
            <li><a href="#t-enforcement">Suspension and termination</a></li>
            <li><a href="#t-accounts">Accounts and security</a></li>
            <li><a href="#t-billing">Plans and payment</a></li>
            <li><a href="#t-ip">Our software</a></li>
            <li><a href="#t-disclaimer">No warranty</a></li>
            <li><a href="#t-liability">Limitation of liability</a></li>
            <li><a href="#t-indemnity">Indemnity</a></li>
            <li><a href="#t-changes">Changes</a></li>
            <li><a href="#t-law">Governing law and general</a></li>
            <li><a href="#t-contact">Contact</a></li>
          </ol>
        </nav>

        <section className="about-section terms-section" aria-labelledby="t-service">
          <h2 id="t-service">1. The Service</h2>
          <p>
            Kagimo is a private, text-only journal. It runs in your browser and stores your journal on your device, encrypted. If you turn on
            sync, an encrypted copy of your writing is stored on our server so you can use it on your other devices. The Service does not accept
            photos or other files. How this works, and what we can and can’t see, is
            described on <Link to="/about">How it works</Link>, which forms part of these terms.
          </p>
          <p>
            We may change, add or remove features, and may stop offering the Service. If we stop offering sync, we’ll give you reasonable notice
            where we can so you can export your journal.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-eligibility">
          <h2 id="t-eligibility">2. Who can use it</h2>
          <p>
            You must be at least 16 years old to use the Service. If you are under 18, you confirm that a parent or guardian has agreed to these
            terms for you. You must not use the Service if you are barred from doing so by law.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-content">
          <h2 id="t-content">3. Your content</h2>
          <p>
            Everything you write, upload or store with the Service (“your content”) belongs to you. You give us only the permission we need to
            store and transmit it in encrypted form to run the Service. We don’t use your content for anything else, and we can’t read it.
          </p>
          <p>
            <strong>You are solely responsible for your content</strong> and for making sure you have the right to store it. We don’t create,
            review, endorse or control it, and nothing in your journal is published or shared by the Service.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-acceptable">
          <h2 id="t-acceptable">4. Acceptable use</h2>
          <p>You must not use the Service, or let anyone else use it, to create, store, upload, sync or transmit anything that:</p>
          <ul className="terms-list">
            <li>
              is <strong>child sexual abuse material</strong> or otherwise sexualises, exploits or endangers children. We have zero tolerance for
              this, will close any account involved, and will report it to the authorities;
            </li>
            <li>is unlawful in Australia or in the place where you use the Service, or that you don’t have the right to possess;</li>
            <li>promotes, facilitates or plans terrorism, violent extremism, or serious harm to any person;</li>
            <li>is intimate imagery of someone shared or kept without their consent;</li>
            <li>infringes anyone’s copyright, trade marks, privacy or other rights;</li>
            <li>contains malware, or is meant to harm, disrupt or gain unauthorised access to any system.</li>
          </ul>
          <p>You also must not:</p>
          <ul className="terms-list">
            <li>
              add images, video, audio or other files to the Service, including by encoding them as text or otherwise disguising them as
              journal entries;
            </li>
            <li>use sync storage as a general file host, a backup service for others, or a way to distribute files to other people;</li>
            <li>probe, scan, overload or attack the Service, or bypass its limits, rate limits or security;</li>
            <li>copy, resell, sublicense or offer the Service to others, or access it by automated means except through the app;</li>
            <li>impersonate anyone, or give false information when asking for an account;</li>
            <li>use the Service in breach of any law, or help anyone else do any of the above.</li>
          </ul>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-encryption">
          <h2 id="t-encryption">5. Encryption, monitoring and reports</h2>
          <p>
            Your journal is end-to-end encrypted, so we cannot see what it contains. Because of this,{' '}
            <strong>we do not and cannot monitor, screen or moderate content</strong>, and we have no obligation to. We are not responsible for
            content stored by users, and storing it on our server does not mean we know of it or approve of it.
          </p>
          <p>
            If you believe the Service is being used for illegal content or in breach of these terms, report it to <Mail />. Child sexual abuse
            material should also be reported to the{' '}
            <a href="https://www.accce.gov.au/report" target="_blank" rel="noopener noreferrer">Australian Centre to Counter Child Exploitation</a>{' '}
            or your local police.
          </p>
          <p>
            We may act on reports, on information from authorities, and on metadata we can see (such as account details, storage use and
            connection details). We will comply with valid legal requests and may preserve and disclose account information and the encrypted data
            we hold where the law requires it or where we believe in good faith it is needed to prevent serious harm, protect our rights, or
            investigate a breach. We cannot decrypt your journal for anyone, including the police, because we never have your key.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-enforcement">
          <h2 id="t-enforcement">6. Suspension and termination</h2>
          <p>
            We may suspend, restrict or close your sync account and delete the data stored with it, at any time and without notice, if we
            reasonably believe you have broken these terms or the law, your use creates risk or legal exposure for us or others, or we are required
            to by law. Where we reasonably can, and it is lawful and safe to do so, we will tell you and give you a chance to export your journal
            first. We are not required to do so where the suspected breach involves illegal content.
          </p>
          <p>
            You can stop using the Service at any time, and can delete your sync account by contacting us. Your journal stays on your device
            until you clear it. Sections 3 to 6 and 9 to 14 continue after your use ends.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-accounts">
          <h2 id="t-accounts">7. Accounts and security</h2>
          <p>
            You are responsible for keeping your passphrase, recovery key, passkeys and devices secure, and for everything done with your account.
            Tell us promptly at <Mail /> if you think your account has been misused.
          </p>
          <p>
            <strong>We cannot reset your passphrase or recover your journal.</strong> If you lose both your passphrase and your recovery key, your
            journal cannot be decrypted by anyone and is lost. A journal without sync exists only in your browser, and is lost if that browser’s
            data is cleared or the device is lost. Keeping backups (for example with the Markdown export) is your responsibility.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-billing">
          <h2 id="t-billing">8. Plans and payment</h2>
          <p>
            Sync is free up to a set amount of storage. The paid plan is billed yearly in advance, in Australian dollars, through our payment
            provider Stripe, and renews automatically each year until cancelled. Prices are shown before you pay and include any GST that
            applies.
          </p>
          <p>
            You can cancel at any time from Settings. Your plan then runs to the end of the period you’ve paid for and does not renew; after that
            your account returns to the free plan and everything already synced stays yours to read, edit and export. Except as required by law, we
            don’t give refunds or credits for partial periods, unused storage, or accounts closed for breach of these terms.
          </p>
          <p>
            The paid plan includes fair-use storage of 100 MB of writing. We may change prices or plan limits with at least 30 days’ notice; a change takes effect
            from your next billing period, and you can cancel before then.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-ip">
          <h2 id="t-ip">9. Our software</h2>
          <p>
            The Kagimo name and the service at kagimo.com belong to us. The app’s source code is published at{' '}
            <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
              github.com/kagimo-journal/kagimo
            </a>{' '}
            under the GNU Affero General Public License, version 3; that licence, not these terms, says what you may do with the code,
            including running your own copy. These terms cover your use of the service we run. Third-party components remain under their
            own licences.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-disclaimer">
          <h2 id="t-disclaimer">10. No warranty</h2>
          <p>
            Nothing in these terms excludes, restricts or modifies any right or remedy you have under the Australian Consumer Law or other law
            that cannot lawfully be excluded. Subject to that, the Service is provided “as is” and “as available”, without warranties of any kind,
            express or implied. We don’t promise that it will be uninterrupted, error-free or secure, or that data will never be lost.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-liability">
          <h2 id="t-liability">11. Limitation of liability</h2>
          <p>To the maximum extent permitted by law:</p>
          <ul className="terms-list">
            <li>
              we are not liable for any indirect, incidental, special or consequential loss, or for loss of data, profits, revenue or goodwill,
              however caused;
            </li>
            <li>
              we are not liable for content stored by any user, for anything users do with the Service, or for any loss caused by a lost passphrase
              or recovery key;
            </li>
            <li>
              our total liability to you for all claims relating to the Service is limited to the greater of the amount you paid us in the 12
              months before the claim arose and A$50.
            </li>
          </ul>
          <p>
            Where our liability for failing to meet a consumer guarantee can be limited, it is limited to supplying the services again or paying
            the cost of having them supplied again.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-indemnity">
          <h2 id="t-indemnity">12. Indemnity</h2>
          <p>
            You indemnify us against any claim, loss, liability, penalty or expense (including reasonable legal costs) brought by a third party
            or authority arising from your content, your use of the Service, or your breach of these terms or the law, except to the extent it was
            caused by our own wrongdoing.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-changes">
          <h2 id="t-changes">13. Changes</h2>
          <p>
            We may update these terms. The date at the top shows when they last changed. For changes that significantly affect you we will give
            reasonable notice in the app or by other means before they take effect. If you keep using the Service after a change takes effect,
            you accept the new terms; if you don’t, stop using it and cancel any paid plan.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-law">
          <h2 id="t-law">14. Governing law and general</h2>
          <p>
            These terms are governed by the law of the Australian Capital Territory, Australia, and you and we submit to the non-exclusive
            jurisdiction of its courts. If any part of these terms is invalid or unenforceable, it is read down or severed and the rest continues
            to apply. If we don’t enforce a right straight away, we haven’t waived it. You may not transfer your rights under these terms; we may
            transfer ours as part of a sale or reorganisation of the Service. These terms are the whole agreement between us about the Service.
          </p>
        </section>

        <section className="about-section terms-section" aria-labelledby="t-contact">
          <h2 id="t-contact">15. Contact</h2>
          <p>
            Questions, support, reports of misuse and legal notices: <Mail />.
          </p>
        </section>
      </main>
    </div>
  );
}

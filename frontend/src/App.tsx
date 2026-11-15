import { type ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Paywall } from './billing/Paywall';
import { SignUpDialog } from './components/SignUpDialog';
import { SubscribeBanner } from './billing/SubscribeBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ReauthPrompt } from './components/ReauthPrompt';
import { UpdateBanner } from './components/UpdateBanner';
import { LoadingScreen } from './components/Spinner';
import { desktop } from './desktop/bridge';
import { DesktopEvents } from './desktop/DesktopEvents';
import { useFolder } from './desktop/folder';
import SignIn from './pages/SignIn';
import SignUp from './pages/SignUp';
import Unlock from './pages/Unlock';
import { lazyPage as lazy } from './lib/lazyPage';
import { useVault, vaultLoadError } from './local/vault';
import { isReturningBrowser, useAuth } from './state/auth';
import { useUnlocked } from './state/lock';

const Journal = lazy(() => import('./pages/journal/JournalPage'));
const SettingsLayout = lazy(() => import('./pages/settings/SettingsLayout'));
const Appearance = lazy(() => import('./pages/settings/Appearance'));
const Security = lazy(() => import('./pages/settings/Security'));
const SyncSettings = lazy(() => import('./pages/settings/Sync'));
const Export = lazy(() => import('./pages/settings/Export'));
const Admin = lazy(() => import('./pages/Admin'));
const Timeline = lazy(() => import('./pages/timeline/TimelinePage'));
const Books = lazy(() => import('./pages/books/BooksPage'));
const YearBook = lazy(() => import('./pages/books/YearBookPage'));
const About = lazy(() => import('./pages/about/AboutPage'));
const Terms = lazy(() => import('./pages/terms/TermsPage'));
const Landing = lazy(() => import('./pages/landing/LandingPage'));
const Subscription = lazy(() => import('./pages/settings/Subscription'));
const DesktopApp = lazy(() => import('./pages/settings/DesktopApp'));
const BillingDone = lazy(() => import('./pages/BillingDone'));
const DesktopStart = lazy(() => import('./pages/desktop/Start'));

type Need = 'start' | 'signin' | 'unlock-page' | 'journal' | 'admin';

/**
 * Route guard (SPEC §8, §10). The journal on this device decides almost everything: it opens with
 * no network and no account. The server session only matters for signing in to sync and for admin.
 */
function Guard({ need, children }: { need: Need; children: ReactNode }) {
  const vault = useVault();
  const { me, config } = useAuth();
  const unlocked = useUnlocked();
  const folder = useFolder();
  const location = useLocation();
  const here = location.pathname + location.search;

  if (vault === undefined) return <LoadingScreen />;
  const home = unlocked ? '/' : '/unlock';

  if (!vault && desktop) {
    // The desktop app keeps the journal in a folder. Until one is chosen there is only the page
    // that asks for it; with an empty folder chosen, a journal can be started or signed in to.
    if (folder === undefined) return <LoadingScreen />;
    if (folder && !vaultLoadError() && (need === 'start' || need === 'signin')) return <>{children}</>;
    return here === '/' ? <DesktopStart /> : <Navigate to="/" replace />;
  }

  if (!vault) {
    // No journal on this device. A browser still signed in to an account from before journals
    // lived on devices unlocks it into one.
    if (me === undefined && need !== 'start' && need !== 'signin') return <LoadingScreen />;
    if (me && (need === 'unlock-page' || need === 'journal' || need === 'admin')) {
      return need === 'unlock-page' ? <>{children}</> : <Navigate to="/unlock" replace state={{ from: here }} />;
    }
    if (need === 'start' || need === 'signin') return <>{children}</>;
    // A link to an entry (shared from another browser) can't be opened without that journal here:
    // go to the front door rather than carrying it through "Start writing" into a blank new entry.
    if (here.startsWith('/e/')) return <Navigate to="/" replace />;
    // A first visit to the bare address is most likely someone new: show the landing page.
    if (here === '/' && !isReturningBrowser()) {
      if (config === undefined) return <LoadingScreen />;
      if (!config?.returning) return <Landing />;
    }
    return <Navigate to={isReturningBrowser() || config?.returning ? '/signin' : '/signup'} replace state={{ from: here }} />;
  }

  switch (need) {
    case 'start':
      // "Start writing" with a journal here (or one just made): straight into a new entry.
      return unlocked ? <Navigate to={`/e/${crypto.randomUUID()}`} replace state={{ fresh: true }} /> : <Navigate to={home} replace />;
    case 'signin':
      // Signing in again to resume sync (the session ended), or to an existing account in place of
      // a journal that's only on this device (the page warns before replacing it).
      if (vault.account && me) return <Navigate to={home} replace />;
      break;
    case 'unlock-page':
      if (unlocked) return <Navigate to="/" replace />;
      break;
    case 'journal':
      if (!unlocked) return <Navigate to="/unlock" replace state={{ from: here }} />;
      break;
    case 'admin':
      if (!unlocked) return <Navigate to="/unlock" replace state={{ from: here }} />;
      if (!vault.account?.isAdmin) return <Navigate to="/" replace />;
      if (me === undefined) return <LoadingScreen />;
      if (!me) return <Navigate to="/settings/sync" replace />;
      break;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <ReauthPrompt />
        <DesktopEvents />
        <UpdateBanner />
        <Paywall />
        <SignUpDialog />
        <SubscribeBanner />
        <Routes>
          <Route path="/signin" element={<Guard need="signin"><SignIn /></Guard>} />
          <Route path="/signup" element={<Guard need="start"><SignUp /></Guard>} />
          <Route path="/unlock" element={<Guard need="unlock-page"><Unlock /></Guard>} />
          <Route path="/" element={<Guard need="journal"><Journal /></Guard>} />
          <Route path="/e/:id" element={<Guard need="journal"><Journal /></Guard>} />
          <Route path="/timeline" element={<Guard need="journal"><Timeline /></Guard>} />
          <Route path="/timeline/:year" element={<Guard need="journal"><Timeline /></Guard>} />
          <Route path="/books" element={<Guard need="journal"><Books /></Guard>} />
          <Route path="/books/:year" element={<Guard need="journal"><YearBook /></Guard>} />
          <Route path="/about" element={<About />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/welcome" element={desktop ? <Navigate to="/" replace /> : <Landing />} />
          {/* Where Stripe sends people back to (in the checkout tab, which has no keys). */}
          <Route path="/billing/done" element={<BillingDone />} />
          <Route path="/settings" element={<Guard need="journal"><SettingsLayout /></Guard>}>
            {/* The desktop app opens on the folder: its sync page talks to the server. */}
            <Route index element={<Navigate to={desktop ? 'sync/device' : 'sync'} replace />} />
            <Route path="appearance/:sub?" element={<Appearance />} />
            <Route path="security/:sub?" element={<Security />} />
            <Route path="sync/:sub?" element={<SyncSettings />} />
            <Route path="export" element={<Export />} />
            <Route path="subscription" element={<Subscription />} />
            <Route path="desktop" element={desktop ? <Navigate to="/settings" replace /> : <DesktopApp />} />
          </Route>
          <Route path="/admin" element={<Guard need="admin"><Admin /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

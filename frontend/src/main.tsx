import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/newsreader/400.css';
import '@fontsource/newsreader/400-italic.css';
import '@fontsource/newsreader/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
// Wordmark face: only the Latin subset, since the wordmark is always the lowercase "kagimo".
import '@fontsource/zen-maru-gothic/latin-500.css';
import './styles/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ToastProvider } from './components/Toast';
import { desktop } from './desktop/bridge';
import { initFolder } from './desktop/folder';
import { dropForUnload, isUnlocked, onBeforeLock, setSessionPersistence } from './crypto/session';
import { flushAll } from './editor/saver';
import { resumePersistence } from './local/resume';
import { currentVault, initVault, reopen, subscribeVault } from './local/vault';
import { registerServiceWorker } from './lib/serviceWorker';
import { pushPending, refreshSyncPhase, startSync } from './sync/engine';
import { AuthProvider } from './state/auth';
import { SettingsProvider } from './state/settings';
import { initTheme } from './theme/apply';

initTheme();
// The desktop app has no tab to reload, so nothing keeps the journal open across one.
if (!desktop) setSessionPersistence(resumePersistence);
void initFolder();
// The journal on this device loads before anything renders (guards depend on it); then sync
// runs in the background whenever it's unlocked.
void initVault().then(() => {
  startSync();
  subscribeVault(refreshSyncPhase);
});
onBeforeLock(() => flushAll());
// Leaving the tab (switching away, closing it): save open editors, then push what's waiting
// rather than leave it for the next visit.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushAll().then(pushPending);
});
// The desktop app's files are on the computer already; and its window waits for open entries
// to be saved (and what's waiting to be pushed, briefly) before it closes.
if (!desktop) registerServiceWorker();
desktop?.onClosing(async () => {
  await flushAll();
  await Promise.race([pushPending(), new Promise((r) => setTimeout(r, 2500))]);
});

// Closing, reloading or navigating away drops the keys from memory. A reload that follows within
// seconds reopens the journal from this tab's reload copy (local/resume.ts) as long as it wasn't
// locked; a tab closed and reopened later asks for the passphrase.
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) dropForUnload();
});
// Back from the back/forward cache (which dropped the keys): reopen it the same way.
window.addEventListener('pageshow', (e) => {
  const v = currentVault();
  if (e.persisted && v && !isUnlocked()) void reopen(v, 'bfcache').catch(() => {});
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <AuthProvider>
          <SettingsProvider>
            <App />
          </SettingsProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);

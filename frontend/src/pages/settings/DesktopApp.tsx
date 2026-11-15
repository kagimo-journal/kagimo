import type { Download } from '../../api/types';
import { formatBytes } from '../../lib/format';
import { useAuth } from '../../state/auth';
import { useIdentity } from '../../state/identity';
import { PLATFORM_NAMES, visitorPlatform } from '../landing/DesktopDownload';
import { SettingsPage } from './SettingsPage';

/**
 * Settings → Desktop app (in a browser, when the server offers installers: /api/config `downloads`).
 * The front page has the same downloads, but someone with a journal here never sees it: `/` opens
 * the journal.
 */
export default function DesktopApp() {
  const { config } = useAuth();
  const { synced } = useIdentity();
  const mine = visitorPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  // This computer's first, then the others.
  const downloads = [...(config?.downloads ?? [])].sort((a, b) => Number(b.platform === mine) - Number(a.platform === mine));
  const href = (d: Download) => d.url ?? `/download/${encodeURIComponent(d.name)}`;

  return (
    <SettingsPage
      title="Desktop app"
      lede="Kagimo for your computer keeps your journal in a folder you choose, as encrypted files, with nothing stored in a browser."
    >
      {downloads.length === 0 ? (
        <p className="hint">There's no desktop app to download from this server right now.</p>
      ) : (
        <div className="settings-box">
          {downloads.map((d) => (
            <div className="settings-row" key={d.name}>
              <span className="label-stack">
                <span className="t">{PLATFORM_NAMES[d.platform]}</span>
                <span className="d">
                  {d.name} · {formatBytes(d.size)}
                  {d.platform === mine && ' · for this computer'}
                </span>
              </span>
              <a href={href(d)} download={d.name} className={`btn ${d.platform === mine ? 'btn-primary' : 'btn-secondary'}`}>
                Download
              </a>
            </div>
          ))}
        </div>
      )}
      <p className="hint" style={{ marginTop: 16, maxWidth: 620 }}>
        {synced
          ? 'To bring this journal to it: choose an empty folder when the app first opens, then "Sign in to a sync account" with your username and passphrase (and authenticator code, if you use one). Passkeys don’t work in the desktop app.'
          : 'To use this journal there as well, turn on sync first (Settings → Sync & backup), then sign in from the app.'}
      </p>
    </SettingsPage>
  );
}

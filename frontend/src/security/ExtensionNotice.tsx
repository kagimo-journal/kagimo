import { useState, useSyncExternalStore } from 'react';
import { Dialog } from '../components/Dialog';
import { ShieldIcon, XIcon } from '../components/Icons';
import { extensionStore } from './extensions';
import './extensions.css';

/** Non-secret, per-device preference. */
const DISMISS_KEY = 'journal.extensionNotice.dismissed';

function dismissedOnDevice(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Closed with the X: hidden until the page is reloaded. */
let dismissedThisSession = false;

function namesText(names: string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A calm notice in the editor when a browser extension shows signs of being active on the page. */
export function ExtensionNotice() {
  const detections = useSyncExternalStore(extensionStore.subscribe, extensionStore.get);
  const [hidden, setHidden] = useState(() => dismissedThisSession || dismissedOnDevice());
  const [howTo, setHowTo] = useState(false);

  if (!detections.length || (hidden && !howTo)) return null;

  const names = [...new Set(detections.map((d) => d.name).filter((n): n is string => !!n))];
  const unnamed = detections.some((d) => !d.name);
  const named = namesText(names);
  const subject = named ? (unnamed ? `${named} and another browser extension` : named) : 'A browser extension';
  const plural = names.length > 1 || (names.length === 1 && unnamed);

  const dontShowAgain = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage unavailable: hide for this session only */
    }
    dismissedThisSession = true;
    setHidden(true);
  };

  return (
    <>
      {!hidden && (
        <div className="notice extension-notice" role="status">
          <ShieldIcon size={18} />
          <div className="extension-notice-body">
            <p>
              <strong>{subject}</strong> {plural ? 'are' : 'is'} active on this page and may be able to read what you write. For the most privacy,
              write in a private window or a browser profile without extensions.
            </p>
            <div className="extension-notice-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setHowTo(true)}>
                How to
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={dontShowAgain}>
                Don't show again on this device
              </button>
            </div>
          </div>
          <button
            type="button"
            className="icon-btn extension-notice-close"
            aria-label="Dismiss"
            onClick={() => {
              dismissedThisSession = true;
              setHidden(true);
            }}
          >
            <XIcon size={12} />
          </button>
        </div>
      )}
      <Dialog
        open={howTo}
        title="Writing without extensions"
        onClose={() => setHowTo(false)}
        className="extension-howto"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setHowTo(false)} autoFocus>
            Done
          </button>
        }
      >
        <ol className="extension-steps">
          <li>
            <strong>Use a private window.</strong> Most browsers turn extensions off in private windows unless you have allowed one there.
          </li>
          <li>
            <strong>Or use a separate browser profile</strong> with no extensions installed, just for your journal.
          </li>
          <li>
            <strong>Or limit what an extension can see.</strong>
            <ul>
              <li>Chrome and Edge: right-click the extension's icon, then under “This can read and change site data” choose “When you click the extension” or limit it to specific sites.</li>
              <li>Safari: Settings → Extensions, select the extension, and set this website to “Deny” under its website access.</li>
              <li>Firefox: add this site to the quarantined domains (<span className="mono">extensions.quarantinedDomains.list</span> in about:config), and turn off “Run on sites with restrictions” for the extension in Manage Extensions.</li>
            </ul>
          </li>
        </ol>
        <p className="hint">No notice doesn't guarantee there are no extensions.</p>
      </Dialog>
    </>
  );
}

import { desktop } from '../../desktop/bridge';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { XIcon } from '../Icons';
import { useIdentity } from '../../state/identity';

const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the banner just comes back next time */
  }
}

/**
 * A quiet suggestion, for journals that live only on this device, to turn on sync: the journal is
 * lost with the browser's storage, and sync lets you write anywhere. "Not now" hides it for two
 * weeks; "Don't show this again" for good (on this device). Sync stays one click away in Settings.
 */
export function SyncNudge({ entryCount }: { entryCount: number }) {
  const { synced, vault } = useIdentity();
  const key = `kagimo.syncNudge.${vault?.id ?? ''}`;
  const [pref, setPref] = useState(() => readPref(key));
  useEffect(() => setPref(readPref(key)), [key]);

  if (synced || !vault || entryCount < 1) return null;
  if (pref === 'never') return null;
  if (pref && Date.now() - Number(pref) < SNOOZE_MS) return null;

  const dismiss = (value: string) => {
    writePref(key, value);
    setPref(value);
  };

  return (
    <aside className="sync-nudge" aria-label="Sync suggestion">
      <div className="sync-nudge-head">
        <strong>{desktop ? 'Your journal lives only in its folder' : 'Your journal lives only in this browser'}</strong>
        <button type="button" className="icon-btn" aria-label="Not now" title="Not now" onClick={() => dismiss(String(Date.now()))}>
          <XIcon size={12} />
        </button>
      </div>
      <p>
        {desktop ? 'If the folder is deleted or this computer is lost' : 'If this browser’s data is cleared or the device is lost'}, your entries go with it. Sync keeps an encrypted copy that only you can
        read, so you can write on your phone, laptop, anywhere.
      </p>
      <div className="sync-nudge-actions">
        <Link to="/settings/sync" className="btn btn-primary btn-sm">Set up sync</Link>
        <button type="button" className="btn-link small" onClick={() => dismiss('never')}>
          Don’t show this again
        </button>
      </div>
    </aside>
  );
}

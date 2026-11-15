import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useSyncStatus } from '../../sync/engine';
import { useIdentity } from '../../state/identity';

function ago(iso: string | null, now: number): string {
  if (!iso) return 'not yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** A one-line sync status ("Synced · 2 min ago", "Only on this device") linking to Sync settings. */
export function SyncIndicator({ className = '' }: { className?: string }) {
  const s = useSyncStatus();
  const { synced } = useIdentity();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  let text: string;
  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  if (!synced) text = 'Only on this device';
  else if (s.conflicts) {
    text = s.conflicts === 1 ? '1 entry needs attention' : `${s.conflicts} entries need attention`;
    tone = 'warn';
  } else
    switch (s.phase) {
      case 'syncing':
        text = 'Syncing…';
        break;
      case 'offline':
        text = s.pending ? 'Offline · will sync later' : 'Offline';
        break;
      case 'signed-out':
        text = 'Sign in to keep syncing';
        tone = 'warn';
        break;
      case 'waiting':
        text = 'Sync not set up yet';
        tone = 'warn';
        break;
      case 'full':
        text = 'Sync space full · on this device';
        tone = 'warn';
        break;
      case 'error':
        text = 'Sync problem';
        tone = 'warn';
        break;
      default:
        text = `Synced · ${ago(s.lastSyncAt, now)}`;
        tone = 'ok';
    }
  return (
    <Link to="/settings/sync" className={`sync-indicator ${tone} ${className}`} title={s.message ?? 'Sync settings'}>
      <span className="sync-dot" aria-hidden />
      {text}
    </Link>
  );
}

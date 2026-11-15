import { useSyncExternalStore } from 'react';
import { type SentRequest, sentLog, sentTotal, subscribeSent } from '../../api/sentLog';
import { formatBytes, plural } from '../../lib/format';
import { useIdentity } from '../../state/identity';
import { SettingsPage } from './SettingsPage';

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Status({ status }: { status: SentRequest['status'] }) {
  if (status === null) return <span className="sd-none">Waiting</span>;
  if (status === 'failed') return <span className="sent-bad">No answer</span>;
  return <span className={status >= 400 ? 'sent-bad' : undefined}>{status}</span>;
}

function Row({ r }: { r: SentRequest }) {
  const outside = /^https?:/.test(r.url);
  return (
    <li className="sent-row">
      <div className="sent-line">
        <time dateTime={new Date(r.at).toISOString()}>{clock(r.at)}</time>
        <span className="sent-method">{r.method}</span>
        <code className="sent-url">{r.url}</code>
        {outside && <span className="sd-tag">Another server</span>}
        <span className="sent-meta">
          {r.bytes > 0 ? formatBytes(r.bytes) : 'No body'} · <Status status={r.status} />
        </span>
      </div>
      {r.body !== null && (
        <details>
          <summary>What was sent</summary>
          <pre className="sent-body">{typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}

export default function SentLogPage() {
  const log = useSyncExternalStore(subscribeSent, sentLog);
  const { synced } = useIdentity();
  const total = sentTotal();
  return (
    <SettingsPage
      title="What this device sent"
      lede="Every request this tab has made since it was opened, newest first, with what was in it. The list is kept in memory only and starts again when the page reloads."
    >
      <div className="card sd-card">
        <p className="small" role="status">
          {plural(total, 'request')} since this tab loaded
          {total > log.length ? `. The last ${log.length} are listed.` : '.'}
          {!synced && ' Sync is off, so none of them carries anything from your journal.'}
        </p>
        <ol className="sent-list" reversed>
          {[...log].reverse().map((r) => (
            <Row key={r.n} r={r} />
          ))}
        </ol>
        <p className="hint">
          Values longer than 40 characters (keys, encrypted entries) are cut to their first 16, with their full length. The app’s own
          files, such as scripts and fonts, are loaded by the browser and aren’t listed. This list is the app reporting on itself: to
          check it, open your browser’s developer tools and compare with the Network tab.
        </p>
      </div>
    </SettingsPage>
  );
}

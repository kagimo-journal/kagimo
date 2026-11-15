import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { entries } from '../../api/endpoints';
import type { EntryFull } from '../../api/types';
import { Spinner } from '../../components/Spinner';
import { decryptEntryPart } from '../../crypto/content';
import { fromBase64 } from '../../crypto/encoding';
import { docText } from '../../editor/docText';
import type { EntryBody, EntryHeader } from '../../editor/types';
import { formatLongDate, plural } from '../../lib/format';
import { listEntries } from '../../local/repo';
import { useIdentity } from '../../state/identity';
import { SettingsPage } from './SettingsPage';

interface Pair {
  /** The entry as this device has it, decrypted here. */
  header: EntryHeader;
  text: string;
  /** This device has changes the server hasn't received yet. */
  unsynced: boolean;
  /** The same entry as the server stores it, fetched just now. */
  server: EntryFull;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The most recently changed entry that is on the server: this device's copy, and the server's. */
async function latestPair(vaultId: string): Promise<Pair | null> {
  const synced = (await listEntries(vaultId)).filter((e) => e.version > 0).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const rec = synced[0];
  if (!rec) return null;
  const [server, header, body] = await Promise.all([
    entries.get(rec.id),
    decryptEntryPart<EntryHeader>(rec.id, 'header', rec.header),
    decryptEntryPart<EntryBody>(rec.id, 'body', rec.body),
  ]);
  return { header, text: docText(body.doc), unsynced: rec.dirty, server };
}

function Stored({ label, ct }: { label: string; ct: string }) {
  return (
    <div className="sbs-stored">
      <p className="small">
        {label} <span className="sbs-muted">· {plural(fromBase64(ct).length, 'byte')}, encrypted</span>
      </p>
      <code className="sbs-ct" tabIndex={0}>
        {ct}
      </code>
    </div>
  );
}

export default function ServerDataPage() {
  const { vault } = useIdentity();
  const vaultId = vault?.id;
  const [pair, setPair] = useState<Pair | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!vaultId) return;
    setLoading(true);
    setError(null);
    try {
      setPair(await latestPair(vaultId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [vaultId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SettingsPage
      title="What the server sees"
      lede="Your most recent entry, as it is on this device and as it is on our server. The server’s copy was fetched just now."
    >
      {error && (
        <div className="notice danger" role="alert">
          <span>{error}</span>
        </div>
      )}
      {pair === undefined && loading && (
        <p className="hint" role="status">
          <Spinner /> Asking the server…
        </p>
      )}
      {pair === null && <p className="hint">Nothing has synced yet. Write an entry, wait for it to sync, and come back.</p>}
      {pair && (
        <>
          <div className="sbs">
            <section className="card sbs-card" aria-labelledby="sbs-device">
              <div>
                <h2 className="card-title" id="sbs-device">On this device</h2>
                <p className="hint">Decrypted here, with your key.</p>
              </div>
              <div className="sbs-entry">
                <p className="sbs-title">{pair.header.title.trim() || 'Untitled'}</p>
                <p className="sbs-muted small">
                  {[formatLongDate(pair.header.createdAt, pair.header.tz), pair.header.location?.label, plural(pair.header.wordCount, 'word')]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="sbs-text">{pair.text || <span className="sbs-muted">No text yet.</span>}</p>
              </div>
            </section>
            <section className="card sbs-card" aria-labelledby="sbs-server">
              <div>
                <h2 className="card-title" id="sbs-server">On our server</h2>
                <p className="hint">Everything we store for this entry. We don’t have the key.</p>
              </div>
              <Stored label="Title, date and place" ct={pair.server.header.ct} />
              <Stored label="Text" ct={pair.server.body.ct} />
              <dl className="kv">
                <dt>Entry id</dt>
                <dd className="mono sbs-id">{pair.server.id}</dd>
                <dt>First saved</dt>
                <dd>{when(pair.server.createdAt)}</dd>
                <dt>Last saved</dt>
                <dd>{when(pair.server.updatedAt)}</dd>
                <dt>Times saved</dt>
                <dd>{pair.server.version}</dd>
              </dl>
            </section>
          </div>
          {pair.unsynced && <p className="hint">This device has newer changes to this entry that haven’t synced yet.</p>}
          <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => void load()} disabled={loading}>
            {loading && <Spinner />}
            Fetch again
          </button>
        </>
      )}
    </SettingsPage>
  );
}

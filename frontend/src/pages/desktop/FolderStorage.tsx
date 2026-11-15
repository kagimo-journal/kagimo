import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { desktop } from '../../desktop/bridge';
import { chooseFolder, useFolder } from '../../desktop/folder';
import { formatBytes, plural } from '../../lib/format';
import type { JournalSize } from '../../local/db';
import { journalSize } from '../../local/repo';
import { useIdentity } from '../../state/identity';
import { SettingsPage } from '../settings/SettingsPage';

function when(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Desktop app, Settings → Sync & backup → Journal folder: where the journal is kept, and opening another. */
export default function FolderStorage() {
  const { vault, synced } = useIdentity();
  const folder = useFolder();
  const navigate = useNavigate();
  const toast = useToast();
  const [js, setJs] = useState<JournalSize | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (vault) void journalSize(vault.id).then(setJs, () => setJs(null));
  }, [vault]);

  const other = async () => {
    setBusy(true);
    try {
      if (await chooseFolder()) navigate('/', { replace: true });
    } catch (e) {
      toast.show(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage
      title="Journal folder"
      lede="Your journal is kept in this folder as encrypted files. It opens and saves without a connection, and backing up the folder backs up the journal."
    >
      <div className="card">
        <dl className="kv">
          <dt>Folder</dt>
          <dd style={{ overflowWrap: 'anywhere' }}>
            {folder}
            {' · '}
            <button type="button" className="btn-link small" style={{ minHeight: 0 }} onClick={() => void desktop?.folder.reveal().catch((e) => toast.show(errorMessage(e)))}>
              Show
            </button>
          </dd>
          <dt>Your journal</dt>
          <dd>
            {js ? (
              <>
                {js.textBytes > 0 && js.textBytes < 1000 ? '1 KB' : formatBytes(js.textBytes)} · {plural(js.entries, 'entry', 'entries')}
                {js.photos > 0 && <> · {formatBytes(js.photoBytes)} of photos</>}
              </>
            ) : (
              '…'
            )}
          </dd>
          {!synced && (
            <>
              <dt>Last full export</dt>
              <dd>
                {when(vault?.exportedAt ?? null)} · <Link to="/settings/export">Export now</Link>
              </dd>
            </>
          )}
        </dl>
        {vault && !vault.wrappedMkPass && (
          <p className="hint">
            This journal has no password, so its key is kept on this computer and the folder opens only here. Set a password before moving the
            folder to another computer or relying on a copy of it.
          </p>
        )}
      </div>
      <div className="card">
        <p className="lede" style={{ fontSize: 14 }}>
          Open the journal in another folder, or start a new one in an empty folder. This journal stays where it is. To move it, close Kagimo,
          move the folder, then open it from its new place.
        </p>
        <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => void other()} disabled={busy}>
          {busy && <Spinner />}Open a different folder…
        </button>
      </div>
    </SettingsPage>
  );
}

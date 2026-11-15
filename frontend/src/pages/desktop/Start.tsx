import { useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { Brand } from '../../components/Brand';
import { Spinner } from '../../components/Spinner';
import { chooseFolder, useFolder } from '../../desktop/folder';
import { useVault, vaultLoadError } from '../../local/vault';

/**
 * Desktop app, no journal open: choose the folder to keep it in. A folder that already holds a
 * journal opens it; an empty one offers a new journal, or signing in to bring a synced one here.
 */
export default function DesktopStart() {
  const folder = useFolder();
  useVault(); // re-render when a folder's journal has been read (or couldn't be)
  const loadError = vaultLoadError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setError(null);
    setBusy(true);
    try {
      await chooseFolder();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = !!folder && !loadError;
  return (
    <div className="page">
      <header className="page-header">
        <Brand to={null} />
      </header>
      <main className="page-main centered" id="main">
        <div className="stack" style={{ width: '100%', maxWidth: 460, gap: 28 }}>
          <div className="stack center-text" style={{ gap: 10 }}>
            <h1 className="page-title">{ready ? 'Start your journal' : 'Choose a folder for your journal'}</h1>
            <p className="lede">
              {ready
                ? 'This folder has no journal in it yet. Start a new one here, or sign in to bring a journal you already sync to this computer.'
                : 'Kagimo keeps your journal in a folder on this computer, as encrypted files. Pick an empty folder to start a new journal, or the folder of one you already have.'}
            </p>
          </div>
          <div className="card stack" style={{ gap: 16 }}>
            {folder && (
              <p className="hint center-text" style={{ overflowWrap: 'anywhere' }}>{folder}</p>
            )}
            {(loadError || error) && <p className="error-text" role="alert">{error ?? loadError}</p>}
            {ready ? (
              <>
                <Link to="/signup" className="btn btn-primary btn-lg">Start writing</Link>
                <Link to="/signin" className="btn btn-secondary">Sign in to a sync account</Link>
                <button type="button" className="btn btn-ghost" onClick={() => void choose()} disabled={busy}>
                  {busy && <Spinner />}Choose a different folder…
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary btn-lg" onClick={() => void choose()} disabled={busy}>
                {busy && <Spinner />}Choose folder…
              </button>
            )}
          </div>
          <p className="hint center-text">No account needed. Nothing leaves this computer unless you set up sync.</p>
        </div>
      </main>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { Spinner } from '../components/Spinner';
import { useAuth } from '../state/auth';
import { desktop } from './bridge';

const host = (url: string) => url.replace(/^https:\/\//, '');

/**
 * Desktop app: which server sync talks to. kagimo.com unless changed, for people who run their
 * own. `locked` shows it without the option (a journal that already syncs belongs to its server).
 */
export function ServerChoice({ locked = false }: { locked?: boolean }) {
  const { reloadConfig, refresh } = useAuth();
  const [server, setServer] = useState<{ url: string; isDefault: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void desktop?.server.get().then(setServer, () => {});
    // This is where the app first has a reason to talk to the server: what it offers (free
    // period, price) is part of the form.
    if (desktop) void reloadConfig();
  }, [reloadConfig]);

  if (!desktop || !server) return null;

  const save = async (url: string) => {
    setError(null);
    setBusy(true);
    try {
      setServer(await desktop!.server.set(url));
      setEditing(false);
      // The new server has its own settings and knows nothing of the old one's session.
      await reloadConfig();
      await refresh().catch(() => {});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <p className="hint" style={{ margin: 0 }}>
        Sync server: {host(server.url)}
        {!locked && (
          <>
            {' · '}
            <button
              type="button"
              className="btn-link small"
              style={{ minHeight: 0 }}
              onClick={() => {
                setValue(server.isDefault ? '' : server.url);
                setEditing(true);
              }}
            >
              Change
            </button>
          </>
        )}
      </p>
    );
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <label className="hint" htmlFor="sync-server" style={{ margin: 0 }}>
        Sync server (leave empty for kagimo.com)
      </label>
      <div className="row" style={{ gap: 8 }}>
        <input
          id="sync-server"
          className="input"
          type="url"
          placeholder="https://journal.example.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault(); // inside the sign-in form: don't submit that
            void save(value);
          }}
          spellCheck={false}
          autoCapitalize="none"
          autoFocus
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void save(value)} disabled={busy}>
          {busy && <Spinner />}Save
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}

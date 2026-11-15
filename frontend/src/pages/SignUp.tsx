import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { Brand } from '../components/Brand';
import { LoadingScreen } from '../components/Spinner';
import { createPasswordlessVault } from '../local/vault';

/** One journal per "Start writing", even when React mounts this page twice (StrictMode). */
let creating: Promise<unknown> | null = null;

/**
 * "Start writing": makes a journal on this device, with no account, no server and no password yet,
 * and goes straight to the editor (SPEC §10). A banner there offers a password, then sync.
 */
export default function SignUp() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    creating ??= createPasswordlessVault().finally(() => {
      creating = null;
    });
    let alive = true;
    creating.then(
      // Straight into a new entry (on phones "/" is the list).
      () => alive && navigate(`/e/${crypto.randomUUID()}`, { replace: true, state: { fresh: true } }),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [navigate, attempt]);

  if (!error) return <LoadingScreen label="Making your journal…" />;
  return (
    <div className="page">
      <header className="page-header">
        <Brand to="/welcome" />
      </header>
      <main className="page-main" id="main">
        <div className="card stack" style={{ maxWidth: 480, gap: 16 }}>
          <h1 className="page-title">Couldn't start your journal</h1>
          <p className="error-text" role="alert">{error}</p>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
            <Link to="/signin" className="btn btn-secondary">Sign in to sync</Link>
          </div>
        </div>
      </main>
    </div>
  );
}

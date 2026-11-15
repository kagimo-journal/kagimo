import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, isApiError } from '../../api/client';
import { totp } from '../../api/endpoints';
import type { TotpSetup } from '../../api/types';
import { cleanCode } from '../../lib/format';
import { useAuth, useMe } from '../../state/auth';
import { CodeField } from '../Fields';
import { CheckIcon } from '../Icons';
import { Spinner } from '../Spinner';
import { QrCode } from './QrCode';

function groupSecret(s: string): string {
  return s.replace(/\s+/g, '').replace(/=+$/, '').match(/.{1,4}/g)?.join(' ') ?? s;
}

/** Authenticator-app enrolment with a client-rendered QR code; disable when allowed. */
export function TotpPanel({ autoStart = false, allowDisable = false }: { autoStart?: boolean; allowDisable?: boolean }) {
  const me = useMe();
  const { refresh } = useAuth();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setSetup(await totp.setup());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const started = useRef(false);
  useEffect(() => {
    // Once per mount, even under StrictMode's double effects: each setup call issues a new secret.
    if (!autoStart || started.current || me.totpEnabled) return;
    started.current = true;
    void start();
  }, [autoStart, me.totpEnabled, start]);

  const verify = async () => {
    const c = cleanCode(code);
    if (c.length !== 6) {
      setError('Enter the 6-digit code from your app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await totp.enable(c);
      await refresh();
      setSetup(null);
      setCode('');
    } catch (e) {
      setError(isApiError(e, 'invalid_totp') ? "That code didn't match, or was already used. Codes change every 30 seconds." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const c = cleanCode(code);
    if (c.length !== 6) {
      setError('Enter the current 6-digit code to turn it off.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await totp.disable(c);
      await refresh();
      setDisabling(false);
      setCode('');
    } catch (e) {
      setError(
        isApiError(e, 'last_second_factor')
          ? "This is your only second factor, so it can't be turned off. Add a passkey first."
          : isApiError(e, 'invalid_totp')
            ? "That code didn't match, or was already used."
            : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  if (me.totpEnabled) {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <p className="row" style={{ gap: 10, fontSize: 14 }}>
          <CheckIcon size={16} strokeWidth={2} style={{ color: 'var(--accent-text)' }} />
          Authenticator app is on. We'll ask for a code when you sign in with your passphrase.
        </p>
        {allowDisable &&
          (disabling ? (
            <form
              className="stack"
              style={{ gap: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                void disable();
              }}
            >
              <CodeField label="Current code" value={code} onChange={setCode} autoFocus />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setDisabling(false)}>Cancel</button>
                <button type="submit" className="btn btn-danger" disabled={busy}>{busy && <Spinner />}Turn off</button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setDisabling(true)}>
              Turn off authenticator app
            </button>
          ))}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <button type="button" className="btn btn-secondary" onClick={start} disabled={busy}>
          {busy && <Spinner />}Set up authenticator app
        </button>
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <form
      className="stack"
      style={{ gap: 18 }}
      onSubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
    >
      <div className="row" style={{ gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* No padding: the code brings its own quiet zone. */}
        <div className="qr" style={{ padding: 0, overflow: 'hidden' }}>
          <QrCode text={setup.otpauthUrl} label="QR code for your authenticator app" />
        </div>
        <div className="stack" style={{ flex: '1 1 160px', gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <span className="small muted">Or enter this key</span>
            <span className="mono" style={{ fontSize: 14, letterSpacing: '0.04em', lineHeight: 1.5, overflowWrap: 'anywhere', userSelect: 'all' }}>
              {groupSecret(setup.secret)}
            </span>
          </div>
          <CodeField label="Code" value={code} onChange={setCode} />
        </div>
      </div>
      <button type="submit" className="btn btn-secondary" disabled={busy}>
        {busy && <Spinner />}Verify code
      </button>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>
  );
}

import { useEffect, useRef, useState } from 'react';
import { errorMessage, isApiError, setReauthHandler } from '../api/client';
import { DecryptError } from '../crypto/aead';
import { useAuth } from '../state/auth';
import { reauthenticate } from '../state/flows';
import { Dialog } from './Dialog';
import { Spinner } from './Spinner';

/**
 * Answers the server's `reauth_required` (SPEC §5.1): asks for the passphrase, re-proves it for
 * this session and lets the API client retry the original request. Mounted once in the app.
 */
export function ReauthPrompt() {
  const { refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setPass('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => {
      setReauthHandler(null);
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  const finish = (ok: boolean) => {
    setOpen(false);
    setPass('');
    resolver.current?.(ok);
    resolver.current = null;
  };

  const submit = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Fresh /api/me: the passphrase (and its salt) may have changed on another device.
      const me = await refresh();
      if (!me) return finish(false);
      await reauthenticate(me, pass);
      finish(true);
    } catch (e) {
      setError(
        e instanceof DecryptError || isApiError(e, 'invalid_credentials')
          ? "That passphrase isn't right."
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Confirm it's you"
      onClose={() => !busy && finish(false)}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => finish(false)} disabled={busy}>Cancel</button>
          <button type="submit" form="reauth-form" className="btn btn-primary" disabled={busy || !pass}>
            {busy && <Spinner />}Continue
          </button>
        </>
      }
    >
      <form
        id="reauth-form"
        className="stack"
        style={{ gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="lede" style={{ fontSize: 14 }}>
          Changes to how you sign in or recover your account need your passphrase again.
        </p>
        <div className="field">
          <label htmlFor="reauth-pass">Passphrase</label>
          <input
            id="reauth-pass"
            className="input"
            type="password"
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'reauth-err' : undefined}
            autoFocus
          />
          {error && <span id="reauth-err" className="error-text" role="alert">{error}</span>}
        </div>
      </form>
    </Dialog>
  );
}

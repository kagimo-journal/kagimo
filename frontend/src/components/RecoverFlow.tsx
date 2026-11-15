import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, isApiError } from '../api/client';
import type { Me } from '../api/types';
import { DecryptError } from '../crypto/aead';
import { RecoveryKeyFormatError } from '../crypto/recovery';
import { loadStrengthData, passphraseStrength } from '../lib/strength';
import { resetPassphrase, verifyRecoveryKey } from '../state/flows';
import { CodeField, PassphraseField, TextField } from './Fields';
import { Spinner } from './Spinner';
import { cleanCode } from '../lib/format';

/** Lifetime of the server's recovery token (SPEC §5). */
const RECOVERY_TTL_MS = 10 * 60 * 1000;

/**
 * Recovery-key path: verify the key (and TOTP if the account has it), decrypt the master key
 * locally, then choose a new passphrase. Entries stay readable because the MK is unchanged.
 */
export function RecoverFlow({ initialUsername = '', onDone, onCancel }: { initialUsername?: string; onDone: (me: Me) => void; onCancel: () => void }) {
  const [username, setUsername] = useState(initialUsername);
  const [key, setKey] = useState('');
  const [code, setCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  // The recovered master key lives outside the session key store until a new passphrase is set,
  // so it is kept in a ref (never in React state) and zeroed on cancel, expiry, unmount and pagehide.
  const [verified, setVerifiedState] = useState(false);
  const recovered = useRef<{ token: string; mk: Uint8Array } | null>(null);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = useCallback(() => {
    recovered.current?.mk.fill(0);
    recovered.current = null;
    setVerifiedState(false);
  }, []);

  useEffect(() => {
    if (!verified) return;
    // The server-side token expires after 10 minutes; the key copy goes with it.
    const expiry = setTimeout(() => {
      forget();
      setError('This recovery session expired. Start again.');
    }, RECOVERY_TTL_MS);
    const onHide = () => forget();
    window.addEventListener('pagehide', onHide);
    return () => {
      clearTimeout(expiry);
      window.removeEventListener('pagehide', onHide);
    };
  }, [verified, forget]);

  useEffect(() => forget, [forget]);

  const verify = async () => {
    setError(null);
    if (!username.trim()) return setError('Enter your username.');
    setBusy(true);
    try {
      const res = await verifyRecoveryKey(username.trim().toLowerCase(), key, needTotp ? cleanCode(code) : undefined);
      recovered.current?.mk.fill(0);
      recovered.current = res;
      setKey('');
      setVerifiedState(true);
    } catch (e) {
      if (e instanceof RecoveryKeyFormatError) setError(e.message);
      else if (e instanceof DecryptError) setError("That recovery key doesn't match this account.");
      else if (isApiError(e, 'totp_required') || isApiError(e, 'invalid_totp')) {
        if (needTotp) setError("That authenticator code didn't match.");
        else setError('This account uses an authenticator app. Enter its code too.');
        setNeedTotp(true);
      } else if (isApiError(e, undefined, 401) || isApiError(e, undefined, 404) || isApiError(e, undefined, 403)) {
        setError("That username and recovery key don't match.");
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const rec = recovered.current;
    if (!rec) return;
    setError(null);
    await loadStrengthData().catch(() => {}); // the built-in list still applies if it can't load
    const s = passphraseStrength(pass, username);
    if (!s.acceptable) return setError(s.label);
    if (pass !== pass2) return setError("The passphrases don't match.");
    setBusy(true);
    try {
      const me = await resetPassphrase(rec.token, rec.mk, pass);
      forget();
      onDone(me);
    } catch (e) {
      const expired = isApiError(e, 'invalid_token');
      setError(expired ? 'This recovery session expired. Start again.' : errorMessage(e));
      if (expired) forget();
    } finally {
      setBusy(false);
    }
  };

  if (verified) {
    return (
      <form
        className="stack"
        style={{ gap: 18 }}
        onSubmit={(e) => {
          e.preventDefault();
          void reset();
        }}
      >
        <div className="notice">
          <span>Recovery key accepted. Choose a new passphrase. Your entries stay exactly as they are.</span>
        </div>
        <PassphraseField label="New passphrase" value={pass} onChange={setPass} username={username} autoFocus />
        <PassphraseField label="Repeat new passphrase" value={pass2} onChange={setPass2} showMeter={false} />
        {error && <p className="error-text" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy && <Spinner />}
          {busy ? 'Encrypting…' : 'Set passphrase and unlock'}
        </button>
      </form>
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
      {!initialUsername && <TextField label="Username" value={username} onChange={setUsername} autoComplete="username" autoCapitalize="none" spellCheck={false} />}
      <TextField
        label="Recovery key"
        value={key}
        onChange={(v) => setKey(v.toUpperCase())}
        inputClassName="input-key"
        placeholder="XXXX-XXXX-XXXX-XXXX-…"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        hint="32 characters. Dashes and spaces are optional."
        autoFocus={!!initialUsername}
      />
      {needTotp && <CodeField label="Authenticator code" value={code} onChange={setCode} hint="This account uses an authenticator app." autoFocus />}
      {error && <p className="error-text" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || key.replace(/[\s-]/g, '').length < 32}>
        {busy && <Spinner />}
        {busy ? 'Checking…' : 'Continue'}
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          forget();
          onCancel();
        }}
      >
        Cancel
      </button>
    </form>
  );
}

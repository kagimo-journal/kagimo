import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import { DecryptError } from '../crypto/aead';
import { RecoveryKeyFormatError } from '../crypto/recovery';
import type { VaultRecord } from '../local/db';
import { openWithRecoveryKey, resetLocalPassphrase } from '../local/vault';
import { loadStrengthData, passphraseStrength } from '../lib/strength';
import { PassphraseField, TextField } from './Fields';
import { Spinner } from './Spinner';

/**
 * Recovery for a journal without sync, entirely on this device: the recovery key unwraps the master
 * key, then a new passphrase re-wraps it. Entries stay as they are.
 */
export function LocalRecoverFlow({ vault, onDone, onCancel }: { vault: VaultRecord; onDone: () => void; onCancel: () => void }) {
  const [key, setKey] = useState('');
  // Kept in a ref (never React state) and zeroed on cancel, unmount and pagehide.
  const mk = useRef<Uint8Array | null>(null);
  const [verified, setVerified] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forget = useCallback(() => {
    mk.current?.fill(0);
    mk.current = null;
    setVerified(false);
  }, []);

  useEffect(() => {
    const onHide = () => forget();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      forget();
    };
  }, [forget]);

  const verify = async () => {
    setError(null);
    setBusy(true);
    try {
      mk.current?.fill(0);
      mk.current = await openWithRecoveryKey(vault, key);
      setKey('');
      setVerified(true);
    } catch (e) {
      if (e instanceof RecoveryKeyFormatError) setError(e.message);
      else if (e instanceof DecryptError) setError("That recovery key doesn't open this journal.");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!mk.current) return;
    setError(null);
    await loadStrengthData().catch(() => {});
    const s = passphraseStrength(pass, vault.name);
    if (!s.acceptable) return setError(s.label);
    if (pass !== pass2) return setError("The passphrases don't match.");
    setBusy(true);
    try {
      await resetLocalPassphrase(vault, mk.current, pass);
      forget();
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (verified) {
    return (
      <form className="stack" style={{ gap: 18 }} onSubmit={(e) => (e.preventDefault(), void reset())}>
        <div className="notice">
          <span>Recovery key accepted. Choose a new passphrase. Your entries stay exactly as they are.</span>
        </div>
        <PassphraseField label="New passphrase" value={pass} onChange={setPass} username={vault.name} autoFocus />
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
    <form className="stack" style={{ gap: 18 }} onSubmit={(e) => (e.preventDefault(), void verify())}>
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
        autoFocus
      />
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

import { desktop, TAB } from '../desktop/bridge';
import { chooseFolder } from '../desktop/folder';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { unlockWithPasskey, webauthnSupported } from '../api/webauthn';
import { DecryptError } from '../crypto/aead';
import { PIN_MAX, PIN_MIN_ENTRY } from '../crypto/pin';
import { pinAttemptsLeft, unlock, unlockWithPin } from '../crypto/session';
import { Brand } from '../components/Brand';
import { KeyIcon, LockIcon } from '../components/Icons';
import { LocalRecoverFlow } from '../components/LocalRecoverFlow';
import { RecoverFlow } from '../components/RecoverFlow';
import { LoadingScreen, Spinner } from '../components/Spinner';
import { greeting } from '../lib/format';
import { currentVault, hasPassword, unlockVaultWithPassphrase, unlockWithDeviceKey, useVault, vaultName } from '../local/vault';
import { useAuth } from '../state/auth';
import { adoptAccountWithPassphrase } from '../state/flows';
import { usePinLocked } from '../state/lock';
import { AUTO_LOCK_OPTIONS, storedAutoLock } from '../state/settings';

/**
 * Unlocks the journal on this device. Works offline: the passphrase (or a passkey with a PRF wrap)
 * unwraps the master key stored here. A browser still signed in to an account from before journals
 * lived on devices gets its own copy of the journal here too.
 */
export default function Unlock() {
  const vault = useVault();
  const { me, refresh, setMe } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<null | 'passkey' | 'pass'>(null);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const pinLocked = usePinLocked();
  const [preferPassphrase, setPreferPassphrase] = useState(false);
  const [pin, setPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  /** Set when the PIN stopped working while this page was open. */
  const [pinEnded, setPinEnded] = useState<string | null>(null);
  const showPin = pinLocked && !preferPassphrase && !recovering;
  const wraps = vault?.passkeyWraps ?? me?.keys.passkeyWraps ?? [];
  const canPasskey = webauthnSupported() && wraps.length > 0 && !!vault;
  const name = vaultName(vault) || me?.username || '';
  const autoLock = storedAutoLock();
  const lockLabel = AUTO_LOCK_OPTIONS.find((o) => o.minutes === autoLock);

  // A synced journal's passphrase may have been changed on another device: refresh the keys
  // (when online) so the new one works here too.
  useEffect(() => {
    if (vault?.account) refresh().catch(() => {});
  }, [vault?.account, refresh]);

  const go = () => navigate(from && from !== '/unlock' ? from : '/', { replace: true });

  // A journal without a password has nothing to ask for: open it.
  const passwordless = !!vault && !hasPassword(vault);
  useEffect(() => {
    if (!vault || hasPassword(vault)) return;
    unlockWithDeviceKey(vault).then(go, (e) => setError(errorMessage(e)));
  }, [vault]);

  // The inactivity limit can pass while this page is open.
  const [wasPinLocked, setWasPinLocked] = useState(pinLocked);
  if (wasPinLocked !== pinLocked) {
    setWasPinLocked(pinLocked);
    if (!pinLocked && !pinEnded) setPinEnded('It has been a while, so your PIN no longer unlocks the journal. Use your passphrase.');
  }

  const viaPin = async () => {
    if (pin.length < PIN_MIN_ENTRY) return;
    setPinError(null);
    setPinBusy(true);
    try {
      const r = await unlockWithPin(pin);
      setPin('');
      if (r === 'ok') return go();
      if (r !== 'wrong') {
        setPinError(null);
        setPinEnded(
          r === 'too-many'
            ? 'Too many wrong PINs. Use your passphrase to unlock the journal.'
            : 'Your PIN no longer unlocks the journal. Use your passphrase.',
        );
        return;
      }
      const left = pinAttemptsLeft();
      setPinError(`That PIN isn't right. ${left === 1 ? '1 try left' : `${left} tries left`} before your passphrase is needed.`);
    } catch (e) {
      setPinError(errorMessage(e));
    } finally {
      setPinBusy(false);
    }
  };

  const viaPasskey = async () => {
    const v = currentVault();
    if (!v) return;
    setError(null);
    setBusy('passkey');
    try {
      const mk = await unlockWithPasskey(v.passkeyWraps);
      await unlock(v.id, mk);
      mk.fill(0);
      go();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const viaPassphrase = async () => {
    if (!pass) return;
    setError(null);
    setBusy('pass');
    try {
      const v = currentVault();
      if (!v) {
        if (!me) throw new Error('Nothing to unlock on this device.');
        await adoptAccountWithPassphrase(me, pass);
      } else {
        try {
          await unlockVaultWithPassphrase(v, pass);
        } catch (e) {
          if (!(e instanceof DecryptError) || !v.account) throw e;
          // Maybe the passphrase was changed on another device: retry once with the latest keys.
          const latest = await refresh();
          const now = currentVault();
          if (!latest || !now || JSON.stringify(now.wrappedMkPass) === JSON.stringify(v.wrappedMkPass)) throw e;
          await unlockVaultWithPassphrase(now, pass);
        }
      }
      setPass('');
      go();
    } catch (e) {
      setError(e instanceof DecryptError ? "That passphrase didn't unlock your journal." : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (passwordless) {
    return error ? (
      <div className="page">
        <main className="page-main" id="main">
          <p className="error-text" role="alert">{error}</p>
          {desktop && (
            // Most likely a folder copied from another computer before it had a password.
            <button type="button" className="btn btn-secondary" onClick={() => void chooseFolder().then((changed) => changed && navigate('/', { replace: true }))}>
              Open a different folder…
            </button>
          )}
        </main>
      </div>
    ) : (
      <LoadingScreen label="Opening your journal…" />
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <Brand to={null} />
      </header>
      <main className="page-main centered" id="main">
        <div className="stack" style={{ width: '100%', maxWidth: recovering ? 420 : 380, alignItems: 'center', gap: 28 }}>
          <div className="badge-circle outline">
            <LockIcon size={24} strokeWidth={1.5} />
          </div>
          <div className="stack center-text" style={{ gap: 10 }}>
            <h1 className="page-title">{recovering ? 'Use your recovery key' : name ? `${greeting()}, ${name}` : greeting()}</h1>
            <p className="lede">
              {recovering
                ? 'Your recovery key unlocks the journal and lets you set a new passphrase.'
                : showPin
                  ? 'Your journal is locked. Enter your PIN to open it again.'
                  : vault
                  ? 'Your journal is locked. Unlock it to decrypt your entries on this device.'
                  : 'Unlock your journal once to keep an encrypted copy on this device. After that it opens even without a connection.'}
            </p>
          </div>

          {recovering ? (
            <div className="card" style={{ width: '100%' }}>
              {vault && !vault.account ? (
                <LocalRecoverFlow vault={vault} onDone={go} onCancel={() => setRecovering(false)} />
              ) : (
                <RecoverFlow
                  initialUsername={vault?.account?.username ?? me?.username ?? ''}
                  onDone={(m) => {
                    setMe(m);
                    go();
                  }}
                  onCancel={() => setRecovering(false)}
                />
              )}
            </div>
          ) : showPin ? (
            <div className="stack" style={{ width: '100%', gap: 14 }}>
              <form
                className="row"
                style={{ gap: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void viaPin();
                }}
              >
                <label htmlFor="ul-pin" className="visually-hidden">PIN</label>
                <input
                  id="ul-pin"
                  className="input input-code"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  placeholder="PIN"
                  maxLength={PIN_MAX}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                  aria-invalid={pinError ? true : undefined}
                  style={{ flex: 1 }}
                />
                <button type="submit" className="btn btn-primary" disabled={pinBusy || pin.length < PIN_MIN_ENTRY}>
                  {pinBusy && <Spinner />}Unlock
                </button>
              </form>
              {pinError && <p className="error-text center-text" role="alert">{pinError}</p>}
              <button type="button" className="btn-link small" style={{ alignSelf: 'center' }} onClick={() => setPreferPassphrase(true)}>
                Use passphrase{canPasskey ? ' or passkey' : ''} instead
              </button>
            </div>
          ) : (
            <div className="stack" style={{ width: '100%', gap: 14 }}>
              {pinEnded && (
                <div className="notice" role="status">
                  <span>{pinEnded}</span>
                </div>
              )}
              {canPasskey && (
                <>
                  <button type="button" className="btn btn-primary btn-lg" onClick={viaPasskey} disabled={!!busy}>
                    {busy === 'passkey' ? <Spinner /> : <KeyIcon />}
                    Unlock with passkey
                  </button>
                  <div className="divider-or">or</div>
                </>
              )}
              <form
                className="row"
                style={{ gap: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void viaPassphrase();
                }}
              >
                <label htmlFor="ul-pass" className="visually-hidden">Passphrase</label>
                <input
                  id="ul-pass"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Passphrase"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  autoFocus={!canPasskey}
                  aria-invalid={error ? true : undefined}
                  style={{ flex: 1 }}
                />
                <button type="submit" className={`btn ${canPasskey ? 'btn-secondary' : 'btn-primary'}`} disabled={!!busy || !pass}>
                  {busy === 'pass' && <Spinner />}Unlock
                </button>
              </form>
              {error && <p className="error-text center-text" role="alert">{error}</p>}
              <button type="button" className="btn-link small" style={{ alignSelf: 'center' }} onClick={() => setRecovering(true)}>
                Use recovery key
              </button>
              {pinLocked && (
                <button type="button" className="btn-link small" style={{ alignSelf: 'center' }} onClick={() => setPreferPassphrase(false)}>
                  Use PIN instead
                </button>
              )}
              {desktop && (
                <button
                  type="button"
                  className="btn-link small"
                  style={{ alignSelf: 'center' }}
                  onClick={() => void chooseFolder().then((changed) => changed && navigate('/', { replace: true }), (e) => setError(errorMessage(e)))}
                >
                  Open a different folder…
                </button>
              )}
            </div>
          )}
          <p className="hint center-text">
            {autoLock === 0 || !lockLabel
              ? `Locks again when you close the ${TAB}.`
              : `Locks again after ${lockLabel.label} without activity, or when you close the ${TAB}.`}
          </p>
        </div>
      </main>
    </div>
  );
}

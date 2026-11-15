import { desktop } from '../desktop/bridge';
import { ServerChoice } from '../desktop/ServerChoice';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { errorMessage, isApiError } from '../api/client';
import type { Me } from '../api/types';
import { signInWithPasskey, webauthnSupported } from '../api/webauthn';
import { DecryptError } from '../crypto/aead';
import { Brand } from '../components/Brand';
import { CodeField, TextField } from '../components/Fields';
import { KeyIcon, LockIcon } from '../components/Icons';
import { RecoverFlow } from '../components/RecoverFlow';
import { Spinner } from '../components/Spinner';
import { cleanCode } from '../lib/format';
import { listEntries } from '../local/repo';
import { useVault } from '../local/vault';
import { useAuth } from '../state/auth';
import { ensureAccountJournal, loginWithPassphrase, openAccountJournal } from '../state/flows';

type SecondStep = { kind: 'second'; method: 'totp' | 'passkey'; totp: boolean; passkey: boolean; completeTotp: (code: string) => Promise<Me>; completePasskey: () => Promise<Me> };
type Step = { kind: 'start' } | SecondStep | { kind: 'recover' };

/** "14:05", or "14:05 on 12 Nov" when the lock ends on another day. */
function untilText(iso: unknown): string | null {
  if (typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${time} on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

export default function SignIn() {
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [username, setUsername] = useState('');
  const [pass, setPass] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'passkey' | 'pass' | 'totp' | 'second-passkey'>(null);
  const [error, setError] = useState<string | null>(null);

  // A journal that's only on this device (started with "Start writing") is replaced by the
  // account's when signing in. With entries in it, that needs a yes first.
  const vault = useVault();
  const local = vault && !vault.account ? vault : null;
  const [localEntries, setLocalEntries] = useState<number | null>(null);
  const [replaceOk, setReplaceOk] = useState(false);
  useEffect(() => {
    if (!local) return;
    let alive = true;
    listEntries(local.id).then(
      (e) => alive && setLocalEntries(e.length),
      () => alive && setLocalEntries(null),
    );
    return () => {
      alive = false;
    };
  }, [local?.id]);
  const blocked = !!local && localEntries !== 0 && !replaceOk;

  /** Signed in; the journal is open on this device (or, after a passkey without PRF, waits to be unlocked). */
  const done = (me: Me, unlocked: boolean) => {
    setMe(me);
    navigate(unlocked ? (from && from !== '/signin' ? from : '/') : '/unlock', { replace: true });
  };

  const restart = (message: string) => {
    setStep({ kind: 'start' });
    setCode('');
    setError(message);
  };

  const passkey = async () => {
    setError(null);
    setBusy('passkey');
    try {
      const { me, mk } = await signInWithPasskey();
      if (mk) {
        try {
          await openAccountJournal(me, mk);
        } finally {
          mk.fill(0);
        }
      } else await ensureAccountJournal(me);
      done(me, !!mk);
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? null : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submitPass = async () => {
    setError(null);
    if (!username.trim() || !pass) return setError('Enter your username and passphrase.');
    setBusy('pass');
    try {
      const res = await loginWithPassphrase(username.trim().toLowerCase(), pass);
      if (res.status === 'second_step') {
        setCode('');
        setStep({ kind: 'second', method: res.totp ? 'totp' : 'passkey', ...res });
      } else {
        setPass('');
        done(res.me, true);
      }
    } catch (e) {
      if (isApiError(e, 'invalid_credentials')) setError("That username and passphrase don't match.");
      else if (isApiError(e, 'account_disabled')) setError('This account has been disabled by the administrator.');
      else if (e instanceof DecryptError) setError("Signed in, but your passphrase didn't decrypt the journal keys.");
      else setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  /** Errors shared by both second steps. Returns true when handled. */
  const secondStepError = (e: unknown): boolean => {
    if (isApiError(e, 'no_mfa_pending') || isApiError(e, 'unauthenticated')) {
      restart('This sign-in expired (too slow, or too many wrong attempts). Sign in again.');
      return true;
    }
    if (e instanceof DecryptError) {
      restart("Signed in, but your passphrase didn't decrypt the journal keys.");
      return true;
    }
    return false;
  };

  const submitTotp = async () => {
    if (step.kind !== 'second') return;
    setError(null);
    const c = cleanCode(code);
    if (c.length !== 6) return setError('Enter the 6-digit code from your authenticator app.');
    setBusy('totp');
    try {
      const me = await step.completeTotp(c);
      setPass('');
      done(me, true);
    } catch (e) {
      if (secondStepError(e)) return;
      if (isApiError(e, 'invalid_totp')) {
        setError("That code didn't match, or was already used. Codes change every 30 seconds.");
      } else if (isApiError(e, 'totp_locked')) {
        const until = untilText(e.extra.lockedUntil);
        setError(
          `Too many wrong codes, so codes are paused${until ? ` until ${until}` : ' for a while'}. ` +
            (step.passkey ? 'You can use a passkey instead.' : 'You can still get in with your recovery key.'),
        );
      } else setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submitSecondPasskey = async () => {
    if (step.kind !== 'second') return;
    setError(null);
    setBusy('second-passkey');
    try {
      const me = await step.completePasskey();
      setPass('');
      done(me, true);
    } catch (e) {
      if (secondStepError(e)) return;
      if (e instanceof DOMException && e.name === 'NotAllowedError') setError('The passkey request was cancelled or timed out. Try again when you’re ready.');
      else if (isApiError(e, 'passkey_failed')) setError("That passkey didn't work for this account. Try again, or use another of your passkeys.");
      else if (isApiError(e, 'challenge_expired')) setError('That took a little too long. Try again.');
      else if (isApiError(e, 'no_passkey')) {
        if (step.totp) {
          setStep({ ...step, method: 'totp' });
          setError('This account has no passkeys any more. Use your authenticator app.');
        } else restart('This account has no passkeys any more. Sign in again.');
      } else setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const heading = step.kind === 'recover' ? 'Use your recovery key' : step.kind === 'second' ? 'One more step' : 'Sign in to sync';
  const lede =
    step.kind === 'recover'
      ? 'Enter the key you saved when you created your account.'
      : step.kind === 'second'
        ? step.method === 'totp'
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Confirm it’s you with one of your passkeys.'
        : 'Sign in to your sync account to bring your journal to this device. It’s downloaded, still encrypted, and then works offline too.';

  return (
    <div className="page">
      <header className="page-header">
        <Brand to="/welcome" />
        <nav className="header-links" aria-label="Account">
          <Link to="/about">How it works</Link>
          {local ? <Link to="/">Back to your journal</Link> : <Link to="/signup">Start a journal</Link>}
        </nav>
      </header>
      <main className="page-main centered" id="main">
        <div className="stack" style={{ width: '100%', maxWidth: 400, gap: 28 }}>
          <div className="stack center-text" style={{ gap: 10 }}>
            <h1 className="page-title">{heading}</h1>
            <p className="lede">{lede}</p>
          </div>

          {local && step.kind !== 'second' && (
            <div className="notice stack" role="status" style={{ gap: 10 }}>
              {localEntries === 0 ? (
                <span>The journal you started on this device is empty. Signing in replaces it with your account’s journal.</span>
              ) : (
                <>
                  <span>
                    This device has a journal that isn’t synced
                    {localEntries ? ` (${localEntries === 1 ? '1 entry' : `${localEntries} entries`})` : ''}. Signing in replaces it with your
                    account’s journal and deletes it from {desktop ? 'its folder' : 'this browser'}. To keep its entries, <Link to="/settings/export">export them</Link> first.
                  </span>
                  <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
                    <input type="checkbox" checked={replaceOk} onChange={(e) => setReplaceOk(e.target.checked)} style={{ marginTop: 0 }} />
                    <span>Delete the journal on this device and sign in</span>
                  </label>
                </>
              )}
            </div>
          )}

          <div className="card">
            {step.kind === 'start' && (
              <>
                {webauthnSupported() && (
                  <>
                    <button type="button" className="btn btn-primary btn-lg" onClick={passkey} disabled={!!busy || blocked}>
                      {busy === 'passkey' ? <Spinner /> : <KeyIcon />}
                      Sign in with a passkey
                    </button>
                    <div className="divider-or">or</div>
                  </>
                )}
                <form
                  className="stack"
                  style={{ gap: 18 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitPass();
                  }}
                >
                  <TextField label="Username" value={username} onChange={setUsername} autoComplete="username" autoCapitalize="none" spellCheck={false} />
                  <TextField label="Passphrase" type="password" value={pass} onChange={setPass} autoComplete="current-password" />
                  <button type="submit" className="btn btn-secondary" disabled={!!busy || blocked}>
                    {busy === 'pass' && <Spinner />}
                    {busy === 'pass' ? 'Deriving keys…' : 'Continue'}
                  </button>
                </form>
                {error && <p className="error-text center-text" role="alert">{error}</p>}
                <p className="hint center-text">If you've added a passkey or authenticator app, we'll ask for it next.</p>
                {desktop && (
                  <div className="center-text">
                    <ServerChoice locked={!!vault?.account} />
                  </div>
                )}
                {!local && (
                  <p className="hint center-text" style={{ borderTop: '1px solid var(--hairline)', paddingTop: 16 }}>
                    New here? <Link to="/signup">Start a journal on this device</Link>. No account needed.
                  </p>
                )}
              </>
            )}

            {step.kind === 'second' && step.method === 'totp' && (
              <form
                className="stack"
                style={{ gap: 18 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitTotp();
                }}
              >
                <CodeField label="Authenticator code" value={code} onChange={setCode} autoFocus />
                {error && <p className="error-text" role="alert">{error}</p>}
                <button type="submit" className="btn btn-primary btn-lg" disabled={!!busy}>
                  {busy === 'totp' && <Spinner />}Verify
                </button>
                {step.passkey && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!!busy}
                    onClick={() => {
                      setError(null);
                      setStep({ ...step, method: 'passkey' });
                    }}
                  >
                    <KeyIcon />
                    Use a passkey instead
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={() => restart('')}>
                  Back
                </button>
              </form>
            )}

            {step.kind === 'second' && step.method === 'passkey' && (
              <div className="stack" style={{ gap: 18 }}>
                {webauthnSupported() ? (
                  <button type="button" className="btn btn-primary btn-lg" onClick={() => void submitSecondPasskey()} disabled={!!busy} autoFocus>
                    {busy === 'second-passkey' ? <Spinner /> : <KeyIcon />}
                    Continue with your passkey
                  </button>
                ) : (
                  <p className="notice" role="status">
                    {desktop ? 'The desktop app' : 'This browser'} can’t use passkeys. Sign in on a device that has your passkey{step.totp ? ', use your authenticator app' : ''}, or use your recovery key.
                  </p>
                )}
                {error && <p className="error-text" role="alert">{error}</p>}
                <p className="hint center-text">Your device will ask for your fingerprint, face, PIN or security key.</p>
                {step.totp && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!!busy}
                    onClick={() => {
                      setError(null);
                      setStep({ ...step, method: 'totp' });
                    }}
                  >
                    Use your authenticator app instead
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={() => restart('')}>
                  Back
                </button>
              </div>
            )}

            {step.kind === 'recover' && <RecoverFlow onDone={(me) => done(me, true)} onCancel={() => setStep({ kind: 'start' })} />}
          </div>

          {step.kind !== 'recover' && (
            <button type="button" className="btn-link small" style={{ alignSelf: 'center' }} disabled={blocked} onClick={() => setStep({ kind: 'recover' })}>
              Forgot your passphrase? Use your recovery key
            </button>
          )}
          <p className="trust-line">
            <LockIcon size={14} />
            Your passphrase never leaves this device.
          </p>
        </div>
      </main>
    </div>
  );
}

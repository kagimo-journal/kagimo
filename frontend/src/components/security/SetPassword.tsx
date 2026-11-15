import { desktop, HERE } from '../../desktop/bridge';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { loadStrengthData, passphraseStrength } from '../../lib/strength';
import { hasPassword, setLocalPassword } from '../../local/vault';
import { useIdentity } from '../../state/identity';
import { Dialog } from '../Dialog';
import { PassphraseField, TextField } from '../Fields';
import { CloudIcon, LockIcon, XIcon } from '../Icons';
import { Spinner } from '../Spinner';
import { RecoveryKeyDisplay } from './RecoveryKey';

/** True when the journal on this device has no password yet. */
export function useNeedsPassword(): boolean {
  const { vault } = useIdentity();
  return !!vault && !hasPassword(vault);
}

const SNOOZE_KEY = 'kagimo.passwordBanner';
const SNOOZE_MS = 24 * 60 * 60 * 1000;

function snoozedUntil(): number {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
  } catch {
    return 0;
  }
}

/**
 * For a journal without a password: a slim banner saying anyone using this browser can read it,
 * with a link to set one. Hiding it lasts a day.
 */
export function PasswordBanner({ className = '' }: { className?: string }) {
  const needs = useNeedsPassword();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => snoozedUntil() > Date.now());
  // The dialog outlives the banner: setting the password hides the banner, and the dialog then
  // shows the recovery key.
  if (!needs && !open) return null;
  return (
    <>
      {needs && !hidden && (
        <div className={`password-banner ${className}`} role="region" aria-label="No password">
          <LockIcon size={14} />
          <span>
            No password yet: anyone using this {HERE} can read your journal.{' '}
            <button type="button" className="btn-link small" onClick={() => setOpen(true)}>
              Set a password
            </button>
            {' · '}
            <Link to="/signin" className="btn-link small">
              Sign in to an existing account
            </Link>
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Hide for today"
            title="Hide for today"
            onClick={() => {
              try {
                localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
              } catch {
                /* storage blocked: hidden until the page reloads */
              }
              setHidden(true);
            }}
          >
            <XIcon size={12} />
          </button>
        </div>
      )}
      <SetPasswordDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * Sets a password on a journal that has none, then shows its new recovery key and offers the two
 * ways to keep the journal: here only, or synced.
 */
export function SetPasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { name } = useIdentity();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ pass?: string; pass2?: string; form?: string }>({});
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) return;
    setPass('');
    setPass2('');
    setUnderstood(false);
    setErrors({});
    setRecoveryKey(null);
    setSaved(false);
  }, [open]);

  const submit = async () => {
    const next: typeof errors = {};
    await loadStrengthData().catch(() => {}); // the built-in list still applies if it can't load
    const s = passphraseStrength(pass, name);
    if (!s.acceptable) next.pass = s.label;
    if (pass !== pass2) next.pass2 = "The passwords don't match.";
    if (!understood) next.form = 'Please confirm you understand nobody can reset your password.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      setRecoveryKey(await setLocalPassword(pass));
      setPass('');
      setPass2('');
    } catch (e) {
      setErrors({ form: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  // Once the password is set, closing without saving the recovery key is still allowed: it can be
  // replaced any time in Settings → Security.
  const finish = (to: string | null) => {
    onClose();
    if (to) navigate(to);
  };

  if (recoveryKey) {
    return (
      <Dialog open={open} title="Save your recovery key" onClose={() => finish(null)} className="set-password-dialog">
        <p className="lede" style={{ fontSize: 14 }}>
          Your journal is locked with your password now. If you forget it, this key is the only way back in. Keep it somewhere safe,
          away from this device. It won't be shown again.
        </p>
        <RecoveryKeyDisplay value={recoveryKey} username={name || 'journal'} />
        <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ marginTop: 0 }} />
          <span>I've saved my recovery key somewhere safe.</span>
        </label>
        <div className="set-password-choices">
          <button type="button" className="choice" disabled={!saved} onClick={() => finish(null)}>
            <LockIcon size={18} />
            <span>
              <strong>Save locally</strong>
              <span>{desktop ? 'Keep the journal in its folder only.' : 'Keep the journal in this browser only.'} You can turn on sync later.</span>
            </span>
          </button>
          <button type="button" className="choice" disabled={!saved} onClick={() => finish('/settings/sync')}>
            <CloudIcon size={18} />
            <span>
              <strong>Set up sync</strong>
              <span>An end-to-end encrypted copy on the server, for your other devices and in case this one is lost.</span>
            </span>
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      title="Set a password"
      onClose={onClose}
      className="set-password-dialog"
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button type="submit" form="set-password-form" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />}
            {busy ? 'Creating your keys…' : 'Set password'}
          </button>
        </>
      }
    >
      <form
        id="set-password-form"
        className="stack"
        style={{ gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <p className="lede" style={{ fontSize: 14 }}>
          Your journal is encrypted, but without a password it opens for anyone using this {HERE}. A password locks it, and you need one to
          sync it to your other devices.
        </p>
        <PassphraseField label="Password" value={pass} onChange={setPass} username={name} required autoFocus />
        {errors.pass && <p className="error-text" role="alert" style={{ marginTop: -12 }}>{errors.pass}</p>}
        <TextField label="Repeat password" type="password" value={pass2} onChange={setPass2} autoComplete="new-password" error={errors.pass2} required />
        <label className="checkbox" style={{ paddingTop: 0 }}>
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>I understand nobody can reset my password for me.</span>
        </label>
        {errors.form && <p className="error-text" role="alert">{errors.form}</p>}
      </form>
    </Dialog>
  );
}

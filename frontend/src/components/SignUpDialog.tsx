import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage, isApiError } from '../api/client';
import { paywall, priceLabel } from '../billing/paywallState';
import { DecryptError } from '../crypto/aead';
import { formatBytes } from '../lib/format';
import { loadStrengthData, passphraseStrength } from '../lib/strength';
import { createPasswordlessVault, currentVault, hasPassword, setLocalPassword } from '../local/vault';
import { useAuth } from '../state/auth';
import { enableSync } from '../state/flows';
import { Dialog } from './Dialog';
import { PassphraseField, TextField } from './Fields';
import { CloudIcon, LockIcon } from './Icons';
import { Spinner } from './Spinner';
import { RecoveryKeyDisplay } from './security/RecoveryKey';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

// Open state lives outside React: the landing page that opens the dialog is replaced by the
// journal as soon as sign-up makes one on this device, and the dialog has to outlive that.
let isOpen = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const signUpDialog = {
  open() {
    isOpen = true;
    emit();
  },
  close() {
    isOpen = false;
    emit();
  },
};

function useSignUpOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => isOpen,
  );
}

/** form → recovery key → (free plan, billing on) subscribe now or later. */
type Step = 'form' | 'key' | 'plan';

/**
 * "Sign up": a journal on this device with a password, a sync account for it, and (when billing is
 * on) the choice to subscribe now or use the free period first. An admin's invite code makes the
 * account free, so that last step is skipped. "Write now" (/signup) stays the no-account path.
 */
export function SignUpDialog() {
  const open = useSignUpOpen();
  const navigate = useNavigate();
  const { config, setMe } = useAuth();
  const plan = config?.billing?.enabled ? config.billing : null;

  const [step, setStep] = useState<Step>('form');
  const [username, setUsername] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [invite, setInvite] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ username?: string; pass?: string; pass2?: string; invite?: string; form?: string }>({});
  // Set as soon as the journal has a password, so a later failure (username taken, bad invite)
  // can't lose it: the key is shown before the dialog closes, whatever happens to the account.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [passwordSet, setPasswordSet] = useState(false);
  const [saved, setSaved] = useState(false);
  const [adminSetup, setAdminSetup] = useState(false);
  const [freePlan, setFreePlan] = useState(false);

  useEffect(() => {
    if (open) return;
    setStep('form');
    setUsername('');
    setPass('');
    setPass2('');
    setInvite('');
    setUnderstood(false);
    setErrors({});
    setRecoveryKey(null);
    setPasswordSet(false);
    setSaved(false);
    setAdminSetup(false);
    setFreePlan(false);
  }, [open]);

  const submit = async () => {
    const u = username.trim().toLowerCase();
    const next: typeof errors = {};
    if (!USERNAME_RE.test(u)) next.username = '3–32 characters: lowercase letters, numbers, dots, dashes or underscores.';
    if (!passwordSet) {
      await loadStrengthData().catch(() => {}); // the built-in list still applies if it can't load
      const s = passphraseStrength(pass, u);
      if (!s.acceptable) next.pass = s.label;
      if (pass !== pass2) next.pass2 = "The passwords don't match.";
      if (!understood) next.form = 'Please confirm you understand nobody can reset your password.';
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      let key = recoveryKey;
      if (!currentVault()) await createPasswordlessVault();
      const v = currentVault();
      if (v && !hasPassword(v)) {
        key = await setLocalPassword(pass);
        setRecoveryKey(key);
        setPasswordSet(true);
      }
      const res = await enableSync(u, pass, invite.trim() || undefined);
      setMe(res.me);
      if (res.newRecoveryKey) setRecoveryKey(res.newRecoveryKey);
      setPass('');
      setPass2('');
      setAdminSetup(res.me.isAdmin && !res.me.hasSecondFactor);
      setFreePlan(res.me.billing.enabled && res.me.billing.plan === 'free');
      setStep('key');
    } catch (e) {
      if (e instanceof DecryptError) setErrors({ form: "That isn't the password this journal was just given." });
      else if (isApiError(e, 'invalid_invite')) setErrors({ invite: "That invite code isn't valid, or it's been used." });
      else if (isApiError(e, undefined, 409) || (isApiError(e) && /taken|exists/.test(e.code))) setErrors({ username: 'That username is taken.' });
      else if (isApiError(e, undefined, 400) && /username/.test(e.code)) setErrors({ username: e.message });
      else setErrors({ form: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Into the journal; optionally straight to the upgrade dialog. */
  const finish = (subscribe = false) => {
    signUpDialog.close();
    if (adminSetup) navigate('/settings/sync');
    else navigate(`/e/${crypto.randomUUID()}`, { state: { fresh: true } });
    if (subscribe) paywall.open('settings');
  };

  // Closing part-way: a journal that already has a password must show its recovery key first.
  const close = () => {
    if (busy) return;
    if (step === 'form' && recoveryKey) setStep('key');
    else if (step === 'form') signUpDialog.close();
    else finish();
  };

  if (step === 'key' && recoveryKey) {
    const synced = !!currentVault()?.account;
    return (
      <Dialog open={open} title="Save your recovery key" onClose={close} className="set-password-dialog">
        <p className="lede" style={{ fontSize: 14 }}>
          {synced ? 'Your journal and sync account are ready. ' : 'Your journal is on this device, locked with your password. Sync isn’t on yet: you can turn it on in Settings → Sync. '}
          If you forget your password, this key is the only way back in. Keep it somewhere safe, away from this device. It won't be shown again.
        </p>
        <RecoveryKeyDisplay value={recoveryKey} username={username || 'journal'} />
        <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ marginTop: 0 }} />
          <span>I've saved my recovery key somewhere safe.</span>
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!saved}
            onClick={() => (synced && freePlan && plan ? setStep('plan') : finish())}
          >
            Continue
          </button>
        </div>
      </Dialog>
    );
  }

  if (step === 'plan' && plan) {
    return (
      <Dialog open={open} title="Sync is on" onClose={close} className="set-password-dialog">
        <p className="lede" style={{ fontSize: 14 }}>
          Sync is free for {plan.freeDays} days, up to {formatBytes(plan.freeBytes)}. After that it's {priceLabel(plan)}. You can subscribe
          now or any time from Settings → Subscription.
        </p>
        <div className="set-password-choices">
          <button type="button" className="choice" onClick={() => finish(false)}>
            <LockIcon size={18} />
            <span>
              <strong>Start writing</strong>
              <span>Use the free {plan.freeDays} days first.</span>
            </span>
          </button>
          <button type="button" className="choice" onClick={() => finish(true)}>
            <CloudIcon size={18} />
            <span>
              <strong>Subscribe now</strong>
              <span>{priceLabel(plan)}, cancel any time.</span>
            </span>
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      title="Sign up"
      onClose={close}
      className="set-password-dialog"
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="sign-up-form" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />}
            {busy ? 'Creating your keys…' : 'Create account'}
          </button>
        </>
      }
    >
      <form
        id="sign-up-form"
        className="stack"
        style={{ gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <p className="lede" style={{ fontSize: 14 }}>
          {config?.bootstrap
            ? 'This is the first account on this server, so it becomes the administrator. '
            : 'A sync account keeps an end-to-end encrypted copy of your journal on the server, for your other devices and in case this one is lost. '}
          {plan && !config?.bootstrap && `Free for ${plan.freeDays} days, then ${priceLabel(plan)}.`}
        </p>
        <TextField
          label="Username"
          value={username}
          onChange={(v) => setUsername(v.toLowerCase())}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          hint="You sign in with it on your other devices. No email needed."
          error={errors.username}
          required
          autoFocus
        />
        {passwordSet ? (
          <p className="hint">Your journal's password is set. Fix the details above and try again.</p>
        ) : (
          <>
            <PassphraseField label="Password" value={pass} onChange={setPass} username={username} required />
            {errors.pass && <p className="error-text" role="alert" style={{ marginTop: -12 }}>{errors.pass}</p>}
            <TextField label="Repeat password" type="password" value={pass2} onChange={setPass2} autoComplete="new-password" error={errors.pass2} required />
          </>
        )}
        {plan && !config?.bootstrap && (
          <TextField
            label="Invite code (optional)"
            value={invite}
            onChange={setInvite}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            hint="If you were given one, sync is free for this account."
            error={errors.invite}
          />
        )}
        {!passwordSet && (
          <label className="checkbox" style={{ paddingTop: 0 }}>
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>I understand nobody can reset my password for me.</span>
          </label>
        )}
        {errors.form && <p className="error-text" role="alert">{errors.form}</p>}
      </form>
    </Dialog>
  );
}

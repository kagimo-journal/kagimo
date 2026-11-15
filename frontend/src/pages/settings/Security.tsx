import { HERE, TAB } from '../../desktop/bridge';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, isApiError } from '../../api/client';
import { DecryptError } from '../../crypto/aead';
import { PIN_ATTEMPTS, PIN_MAX, PIN_MIN, pinProblem, wrapWithPin } from '../../crypto/pin';
import { masterKeyCopy } from '../../crypto/session';
import { ConfirmDialog } from '../../components/Dialog';
import { PassphraseField, TextField } from '../../components/Fields';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { PasskeysPanel } from '../../components/security/PasskeysPanel';
import { RecoveryKeyDisplay, regenerateRecoveryKey } from '../../components/security/RecoveryKey';
import { SetPasswordDialog, useNeedsPassword } from '../../components/security/SetPassword';
import { TotpPanel } from '../../components/security/TotpPanel';
import { loadStrengthData, passphraseStrength } from '../../lib/strength';
import { changeLocalPassphrase, checkLocalPassphrase, regenerateLocalRecovery } from '../../local/vault';
import { useAuth } from '../../state/auth';
import { changePassphrase } from '../../state/flows';
import { useIdentity } from '../../state/identity';
import { AUTO_LOCK_OPTIONS, DEFAULT_PIN_GRACE, PIN_GRACE_OPTIONS, useSettings } from '../../state/settings';
import { SettingsPage, useSubPage } from './SettingsPage';

function AutoLock() {
  const { settings, update } = useSettings();
  const id = useId();
  const index = Math.max(0, AUTO_LOCK_OPTIONS.findIndex((o) => o.minutes === settings.autoLock));
  const current = AUTO_LOCK_OPTIONS[index];
  return (
    <div className="card autolock">
      <label htmlFor={id} style={{ fontWeight: 500 }}>
        Lock after {current.minutes === 0 ? `…never (only when you close the ${TAB})` : `${current.label} without activity`}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={AUTO_LOCK_OPTIONS.length - 1}
        step={1}
        value={index}
        aria-valuetext={current.label}
        onChange={(e) => update((s) => ({ ...s, autoLock: AUTO_LOCK_OPTIONS[Number(e.target.value)].minutes }))}
      />
      <div className="autolock-ticks" aria-hidden>
        {AUTO_LOCK_OPTIONS.map((o, i) => (
          <span key={o.label} className={i === index ? 'on' : ''}>
            {o.minutes === 0 ? 'Never' : o.label.replace(' minutes', ' min').replace(' minute', ' min')}
          </span>
        ))}
      </div>
      {current.minutes === 0 && (
        <p className="hint">Anyone who picks up this device while the {TAB} is open can read your journal. Lock it yourself when you step away.</p>
      )}
    </div>
  );
}

function PinUnlock() {
  const { settings, update, loadError } = useSettings();
  const toast = useToast();
  const graceId = useId();
  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = settings.pin;
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_MAX);

  const close = () => {
    setEditing(false);
    setPin('');
    setPin2('');
    setPass('');
    setError(null);
  };

  const save = async () => {
    setError(null);
    const problem = pinProblem(pin);
    if (problem) return setError(problem);
    if (pin !== pin2) return setError("The PINs don't match.");
    if (!pass) return setError('Enter your passphrase.');
    setBusy(true);
    try {
      // A PIN is another way in, so setting one takes the passphrase, not just an unlocked journal.
      await checkLocalPassphrase(pass);
      const mk = masterKeyCopy();
      try {
        const wrap = await wrapWithPin(pin, mk);
        update((s) => ({ ...s, pin: { ...wrap, fullUnlockAfter: s.pin?.fullUnlockAfter ?? DEFAULT_PIN_GRACE } }));
      } finally {
        mk.fill(0);
      }
      toast.show(current ? 'PIN changed.' : 'PIN unlock is on.');
      close();
    } catch (e) {
      setError(e instanceof DecryptError ? "Your passphrase isn't right." : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = () => {
    update((s) => ({ ...s, pin: null }));
    close();
    toast.show('PIN unlock is off. Your passphrase is needed every time the journal locks.');
  };

  if (loadError) {
    return (
      <div className="card">
        <p className="hint">Your settings couldn't be loaded, so PIN unlock can't be changed right now.</p>
      </div>
    );
  }

  const graceIndex = current ? Math.max(0, PIN_GRACE_OPTIONS.findIndex((o) => o.minutes === current.fullUnlockAfter)) : 0;
  const grace = PIN_GRACE_OPTIONS[graceIndex];
  const autoLock = settings.autoLock;

  return (
    <div className="card autolock">
      {editing ? (
        <form
          className="stack"
          style={{ gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField
            label={current ? 'New PIN' : 'PIN'}
            hint={`${PIN_MIN} to ${PIN_MAX} digits.`}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="new-password"
            inputClassName="input-code"
            value={pin}
            onChange={(v) => setPin(digits(v))}
            autoFocus
          />
          <TextField
            label="Repeat PIN"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="new-password"
            inputClassName="input-code"
            value={pin2}
            onChange={(v) => setPin2(digits(v))}
          />
          <PassphraseField label="Your passphrase" autoComplete="current-password" showMeter={false} value={pass} onChange={setPass} />
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={busy || !pin || !pin2 || !pass}>
              {busy && <Spinner />}
              {current ? 'Change PIN' : 'Turn on PIN unlock'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : current ? (
        <>
          <label htmlFor={graceId} style={{ fontWeight: 500 }}>
            Ask for the passphrase after {grace.label} without activity
          </label>
          <input
            id={graceId}
            type="range"
            min={0}
            max={PIN_GRACE_OPTIONS.length - 1}
            step={1}
            value={graceIndex}
            aria-valuetext={grace.label}
            onChange={(e) =>
              update((s) => (s.pin ? { ...s, pin: { ...s.pin, fullUnlockAfter: PIN_GRACE_OPTIONS[Number(e.target.value)].minutes } } : s))
            }
          />
          <div className="autolock-ticks" aria-hidden>
            {PIN_GRACE_OPTIONS.map((o, i) => (
              <span key={o.label} className={i === graceIndex ? 'on' : ''}>
                {o.label.replace(' minutes', ' min').replace(' hours', ' h').replace(' hour', ' h')}
              </span>
            ))}
          </div>
          <p className="hint">
            {autoLock === 0
              ? "The journal doesn't lock by itself, so the PIN applies when you lock it yourself."
              : autoLock >= grace.minutes
                ? `Auto-lock is set to ${AUTO_LOCK_OPTIONS.find((o) => o.minutes === autoLock)?.label}, which is as long as this, so the passphrase is needed whenever the journal locks by itself. The PIN still works when you lock it yourself.`
                : `After locking, the PIN opens the journal until it has been ${grace.label} since you last used it. After ${PIN_ATTEMPTS} wrong PINs, or once the tab is closed or reloaded while locked, the passphrase is needed.`}
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
              Change PIN
            </button>
            <button type="button" className="btn btn-ghost" onClick={turnOff}>
              Turn off
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lede" style={{ fontSize: 14 }}>
            Your passphrase is still needed once the journal has been inactive for a while, after {PIN_ATTEMPTS} wrong PINs, and whenever you
            open it in a new tab.
          </p>
          <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing(true)}>
            Set up a PIN
          </button>
        </>
      )}
    </div>
  );
}

function ChangePassphrase() {
  const identity = useIdentity();
  const { me, refresh } = useAuth();
  const synced = identity.synced;
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    await loadStrengthData().catch(() => {}); // the built-in list still applies if it can't load
    const s = passphraseStrength(next, me?.username ?? identity.name);
    if (!current) return setError('Enter your current passphrase.');
    if (!s.acceptable) return setError(s.label);
    if (next !== next2) return setError("The new passphrases don't match.");
    if (next === current) return setError('Choose a passphrase different from the current one.');
    if (synced && !me) return setError('Your journal syncs, so its passphrase changes on the server too. Connect to the internet (and sign in) first.');
    setBusy(true);
    try {
      if (synced && me) {
        await changePassphrase(me, current, next);
        await refresh();
      } else {
        await changeLocalPassphrase(current, next);
      }
      setCurrent('');
      setNext('');
      setNext2('');
      toast.show('Passphrase changed. Use the new one next time you sign in or unlock.');
    } catch (e) {
      if (e instanceof DecryptError || isApiError(e, undefined, 401) || isApiError(e, undefined, 403)) setError("Your current passphrase isn't right.");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card"
      style={{ maxWidth: 520 }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField label="Current passphrase" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
      <PassphraseField label="New passphrase" value={next} onChange={setNext} username={me?.username ?? identity.name} />
      <TextField label="Repeat new passphrase" type="password" value={next2} onChange={setNext2} autoComplete="new-password" />
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="hint">Your entries aren't re-encrypted: only the copy of your key that the passphrase protects is replaced.</p>
      <button type="submit" className="btn btn-primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
        {busy && <Spinner />}
        {busy ? 'Re-wrapping keys…' : 'Change passphrase'}
      </button>
    </form>
  );
}

function RecoverySection() {
  const identity = useIdentity();
  const { me } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A journal without sync has no server to ask for the passphrase again, so it's asked here.
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState('');

  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      if (identity.synced && !me) throw new Error('Your journal syncs, so its recovery key is kept with your account. Connect to the internet (and sign in) first.');
      setKey(identity.synced ? await regenerateRecoveryKey() : await regenerateLocalRecovery(pass));
      setSaved(false);
      setAsking(false);
      setPass('');
    } catch (e) {
      setError(e instanceof DecryptError ? "Your passphrase isn't right." : errorMessage(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <div className="card">
      {key ? (
        <>
          <div className="notice">
            <span>This is your new recovery key. The old one no longer works. We won't show this again.</span>
          </div>
          <RecoveryKeyDisplay value={key} username={me?.username ?? (identity.name || 'journal')} />
          <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ marginTop: 0 }} />
            <span>I've saved my recovery key somewhere safe.</span>
          </label>
          <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} disabled={!saved} onClick={() => setKey(null)}>
            Done
          </button>
        </>
      ) : asking ? (
        <form
          className="stack"
          style={{ gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (pass) void regenerate();
          }}
        >
          <p className="lede" style={{ fontSize: 14 }}>
            Your current recovery key will stop working immediately. Save the new one before you leave this page.
          </p>
          <PassphraseField label="Your passphrase" autoComplete="current-password" showMeter={false} value={pass} onChange={setPass} autoFocus />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={busy || !pass}>
              {busy && <Spinner />}
              Make new key
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setAsking(false);
                setPass('');
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="lede" style={{ fontSize: 14 }}>
            If you've lost your recovery key, or think someone else has seen it, make a new one. The old key stops working straight away.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => (identity.synced ? setConfirm(true) : setAsking(true))}
          >
            Make a new recovery key
          </button>
        </>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      <ConfirmDialog
        open={confirm}
        title="Make a new recovery key?"
        body="Your current recovery key will stop working immediately. Save the new one before you leave this page."
        confirmLabel="Make new key"
        busy={busy}
        onConfirm={regenerate}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

export default function Security() {
  const { me } = useAuth();
  const needsPassword = useNeedsPassword();
  const { sub, redirect } = useSubPage('security');
  const [settingPassword, setSettingPassword] = useState(false);
  if (redirect) return redirect;

  if (needsPassword) {
    return (
      <SettingsPage
        title="Password"
        lede={`Your journal is encrypted on this device, but it has no password yet, so it opens for anyone using this ${HERE}.`}
      >
        <div className="card" style={{ maxWidth: 520 }}>
          <p className="lede" style={{ fontSize: 14 }}>
            Set a password to lock the journal. Then you can choose when it locks by itself, unlock with a PIN, and turn on sync.
          </p>
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setSettingPassword(true)}>
            Set a password
          </button>
        </div>
        <SetPasswordDialog open={settingPassword} onClose={() => setSettingPassword(false)} />
      </SettingsPage>
    );
  }

  switch (sub) {
    case 'pin':
      return (
        <SettingsPage
          title="PIN unlock"
          lede={`Open the journal with a short PIN after it locks, instead of typing your passphrase. The PIN only works in a ${TAB} where you've already unlocked with your passphrase or a passkey.`}
        >
          <PinUnlock />
        </SettingsPage>
      );
    case 'passphrase':
      return (
        <SettingsPage title="Passphrase" lede="Your passphrase never leaves this device. Nobody can reset it for you.">
          <ChangePassphrase />
        </SettingsPage>
      );
    case 'recovery-key':
      return (
        <SettingsPage title="Recovery key" lede="The only way back in if you forget your passphrase.">
          <RecoverySection />
        </SettingsPage>
      );
    case 'sign-in':
      return (
        <SettingsPage
          title="Two-factor sign-in"
          lede={
            <>
              Passkeys and authenticator apps protect a sync account. Your journal is only on this device, so there's no account to sign in to
              yet. <Link to="/settings/sync">Turn on sync</Link> to set them up.
            </>
          }
        />
      );
    case 'passkeys':
      return (
        <SettingsPage
          title="Passkeys"
          lede="Sign in with your fingerprint, face or security key. Passkeys marked “can unlock journal” also decrypt it, so you don't have to type your passphrase."
        >
          {me ? (
            <div className="card">
              <PasskeysPanel allowDelete />
            </div>
          ) : (
            <OfflineFactors />
          )}
        </SettingsPage>
      );
    case 'authenticator':
      return (
        <SettingsPage title="Authenticator app" lede="A 6-digit code from an app on your phone, asked for after your passphrase.">
          {me ? (
            <div className="card">
              <TotpPanel allowDisable />
            </div>
          ) : (
            <OfflineFactors />
          )}
        </SettingsPage>
      );
    default:
      return (
        <SettingsPage
          title="Auto-lock"
          lede="When the journal locks, its keys are wiped from memory and your passphrase (or PIN, if you set one) is needed again."
        >
          <AutoLock />
        </SettingsPage>
      );
  }
}

function OfflineFactors() {
  return <p className="hint">Connect to the internet and sign in to manage your passkeys and authenticator app.</p>;
}

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage, isApiError } from '../../api/client';
import { isFull, paywall, priceLabel } from '../../billing/paywallState';
import { DecryptError } from '../../crypto/aead';
import { signOutBody, useSignOutOfDevice } from '../../components/AccountButton';
import { ConfirmDialog } from '../../components/Dialog';
import { desktop } from '../../desktop/bridge';
import { ServerChoice } from '../../desktop/ServerChoice';
import FolderStorage from '../desktop/FolderStorage';
import { TextField } from '../../components/Fields';
import { CheckIcon, CircleIcon } from '../../components/Icons';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { PasskeysPanel } from '../../components/security/PasskeysPanel';
import { RecoveryKeyDisplay } from '../../components/security/RecoveryKey';
import { SetPasswordDialog, useNeedsPassword } from '../../components/security/SetPassword';
import { TotpPanel } from '../../components/security/TotpPanel';
import { formatBytes, plural } from '../../lib/format';
import type { JournalSize } from '../../local/db';
import { journalSize } from '../../local/repo';
import { forgetVault, storageStatus, requestPersistentStorage } from '../../local/vault';
import { useAuth } from '../../state/auth';
import { enableSync, removeJournalFromDevice } from '../../state/flows';
import { useIdentity } from '../../state/identity';
import { syncNow, useSyncStatus } from '../../sync/engine';
import SentLogPage from './SentLog';
import ServerDataPage from './ServerData';
import { SettingsPage, useSubPage } from './SettingsPage';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function when(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Sizes as sync measures them (decimal), never "0 B" for something that exists. */
function size(n: number): string {
  return n > 0 && n < 1000 ? '1 KB' : formatBytes(n);
}

/** This browser's storage: kept for good, or evictable; and how much the journal takes. */
function DeviceStorage() {
  const { vault, synced } = useIdentity();
  const [st, setSt] = useState<Awaited<ReturnType<typeof storageStatus>> | null>(null);
  const [asking, setAsking] = useState(false);
  const [js, setJs] = useState<JournalSize | null>(null);
  useEffect(() => {
    void storageStatus().then(setSt);
  }, []);
  useEffect(() => {
    if (vault) void journalSize(vault.id).then(setJs, () => setJs(null));
  }, [vault]);
  const ask = async () => {
    setAsking(true);
    await requestPersistentStorage();
    setSt(await storageStatus());
    setAsking(false);
  };
  return (
    <SettingsPage title="On this device" lede="Your journal is stored in this browser, encrypted. It opens and saves without a connection.">
      <div className="card">
        <dl className="kv">
          <dt>Storage</dt>
          <dd>
            {st?.persisted ? 'Kept until you remove it' : st?.persisted === false ? 'The browser may clear it when space runs low' : 'Unknown'}
            {st?.persisted === false && (
              <>
                {' · '}
                <button type="button" className="btn-link small" style={{ minHeight: 0 }} onClick={() => void ask()} disabled={asking}>
                  Ask to keep it
                </button>
              </>
            )}
          </dd>
          <dt>Your journal</dt>
          <dd>
            {js ? (
              <>
                {size(js.textBytes)} · {plural(js.entries, 'entry', 'entries')}
                {js.photos > 0 && <> · {size(js.photoBytes)} of photos</>}
              </>
            ) : (
              '…'
            )}
          </dd>
          {!synced && (
            <>
              <dt>Last full export</dt>
              <dd>
                {when(vault?.exportedAt ?? null)} · <Link to="/settings/export">Export now</Link>
              </dd>
            </>
          )}
        </dl>
        {st?.persisted === false && (
          <p className="hint">
            Installing Kagimo (Add to Home Screen, or Install in the address bar) also helps: browsers, Safari especially, clear the data of
            sites you don’t visit for a while.
          </p>
        )}
      </div>
    </SettingsPage>
  );
}

/** Journal only on this device: what sync is, and turning it on. */
function TurnOnSync() {
  const { config, setMe } = useAuth();
  const { vault } = useIdentity();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ username?: string; pass?: string; form?: string }>({});
  const [newKey, setNewKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState(false);
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const needsPassword = useNeedsPassword();
  const [settingPassword, setSettingPassword] = useState(false);

  const submit = async () => {
    const u = username.trim().toLowerCase();
    const next: typeof errors = {};
    if (!USERNAME_RE.test(u)) next.username = '3–32 characters: lowercase letters, numbers, dots, dashes or underscores.';
    if (!pass) next.pass = 'Enter the passphrase you unlock this journal with.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const res = await enableSync(u, pass);
      setPass('');
      setMe(res.me);
      if (res.newRecoveryKey) setNewKey(res.newRecoveryKey);
      else toast.show(res.me.isAdmin && !res.me.hasSecondFactor ? 'Sync account created. One more step: add a second factor.' : 'Sync account created.');
    } catch (e) {
      if (e instanceof DecryptError) setErrors({ pass: "That isn't this journal's passphrase." });
      else if (isApiError(e, undefined, 409) || (isApiError(e) && /taken|exists/.test(e.code))) setErrors({ username: 'That username is taken.' });
      else if (isApiError(e, undefined, 400) && /username/.test(e.code)) setErrors({ username: e.message });
      else setErrors({ form: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  if (newKey) {
    return (
      <div className="card">
        <div className="notice">
          <span>Your journal has a new recovery key that works with your sync account too. The old one no longer works. Save this one now.</span>
        </div>
        <RecoveryKeyDisplay value={newKey} username={username || 'journal'} />
        <label className="checkbox" style={{ paddingTop: 0, alignItems: 'center' }}>
          <input type="checkbox" checked={savedKey} onChange={(e) => setSavedKey(e.target.checked)} style={{ marginTop: 0 }} />
          <span>I've saved my recovery key somewhere safe.</span>
        </label>
        <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={!savedKey} onClick={() => setNewKey(null)}>
          Continue
        </button>
      </div>
    );
  }

  return (
    <>
      <SetPasswordDialog open={settingPassword} onClose={() => setSettingPassword(false)} />
      {needsPassword ? (
        <div className="card" style={{ maxWidth: 520 }}>
          <h3 className="card-title">Turn on sync</h3>
          <p className="hint" style={{ marginTop: -6 }}>
            First, give your journal a password. It encrypts the key your entries are locked with, and it's what you'll unlock the journal
            with on your other devices.
          </p>
          <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setSettingPassword(true)}>
            Set a password
          </button>
        </div>
      ) : (
        <form
          className="card"
          style={{ maxWidth: 520 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          <h3 className="card-title">Turn on sync</h3>
          <p className="hint" style={{ marginTop: -6 }}>
            {config?.bootstrap
              ? 'This is the first account on this server, so it becomes the administrator.'
              : 'This creates a sync account on this server.'}
            {!config?.bootstrap &&
              config?.billing?.enabled &&
              ` Sync is free for ${config.billing.freeDays} days (up to ${formatBytes(config.billing.freeBytes)}), then ${priceLabel(config.billing)}.`}
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
          />
          <TextField
            label="Your passphrase"
            type="password"
            value={pass}
            onChange={setPass}
            autoComplete="current-password"
            hint="The one you unlock this journal with. It stays the same and never leaves this device."
            error={errors.pass}
            required
          />
          {errors.form && <p className="error-text" role="alert">{errors.form}</p>}
          {!online && <p className="hint">You’re offline. Connect to the internet to turn on sync.</p>}
          <ServerChoice />
          <p className="hint" style={{ margin: 0 }}>
            By turning on sync you agree to the <Link to="/terms" target="_blank">Terms of Service</Link>.
          </p>
          <button type="submit" className="btn btn-primary" disabled={busy || !online || !vault} style={{ alignSelf: 'flex-start' }}>
            {busy && <Spinner />}
            {busy ? 'Creating your sync account…' : 'Turn on sync'}
          </button>
        </form>
      )}
      <p className="hint" style={{ maxWidth: 520 }}>
        Already have a sync account? <Link to="/signin">Sign in to it</Link> instead. That replaces the journal on this device with your
        account’s.
      </p>
      <div className="sync-points">
        <div className="sync-point">
          <strong>A backup if this device goes</strong>
          {desktop
            ? 'Right now your journal exists only in its folder on this computer. If the folder is deleted or the computer is lost, every entry goes with it.'
            : 'Right now your journal exists only in this browser. Clearing its data, losing the device or resetting the browser would delete every entry.'}
        </div>
        <div className="sync-point">
          <strong>Write wherever you are</strong>
          Your phone, your laptop, a borrowed browser: sign in and your journal is there, and works offline too.
        </div>
        <div className="sync-point">
          <strong>Still private</strong>
          Entries are encrypted on your devices before they’re sent. The server stores them without the key, so it can’t read them.
        </div>
      </div>
    </>
  );
}

/** Account exists but can't sync yet: disabled, or an administrator without a second factor. */
function FinishSetup() {
  const { me } = useAuth();
  const { vault } = useIdentity();
  const isAdmin = me?.isAdmin ?? vault?.account?.isAdmin ?? false;
  // Only administrators must add one before syncing; for members it's optional (Security).
  const hasFactor = !isAdmin || (me?.hasSecondFactor ?? vault?.account?.hasSecondFactor ?? false);

  if (vault?.account?.status === 'disabled') {
    return (
      <div className="notice danger" role="status">
        <span>The administrator has disabled this sync account. Your journal on this device is unaffected.</span>
      </div>
    );
  }

  return (
    <>
      <ul className="checklist">
        <li><CheckIcon strokeWidth={2} />Sync account created</li>
        {isAdmin && (
          <li className={hasFactor ? '' : 'todo'}>
            {hasFactor ? <CheckIcon strokeWidth={2} /> : <CircleIcon />}A passkey or authenticator app (required for administrators)
          </li>
        )}
      </ul>
      {!me ? (
        <p className="hint">Connect to the internet to finish setting up sync.</p>
      ) : !hasFactor ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 24, alignItems: 'stretch' }}>
          <section className="card" style={{ flex: '1 1 320px' }} aria-labelledby="sec-passkey">
            <h3 className="card-title" id="sec-passkey">Passkey</h3>
            <p className="lede" style={{ fontSize: 14, lineHeight: 1.55 }}>
              Sign in with your fingerprint, face or security key. It can also unlock the journal, so you won't type your passphrase every time.
            </p>
            <PasskeysPanel />
          </section>
          <section className="card" style={{ flex: '1 1 320px' }} aria-labelledby="sec-totp">
            <h3 className="card-title" id="sec-totp">Authenticator app</h3>
            <p className="lede" style={{ fontSize: 14, lineHeight: 1.55 }}>Scan with any authenticator app, then enter the 6-digit code it shows.</p>
            <TotpPanel />
          </section>
        </div>
      ) : (
        <p className="hint" aria-live="polite">Finishing setup…</p>
      )}
    </>
  );
}

/** Sync on: status and sync now. */
function SyncOn() {
  const s = useSyncStatus();
  const { vault } = useIdentity();
  const { me, refresh } = useAuth();
  const billing = me?.billing;
  const limited = !!billing && billing.limitBytes > 0;

  // The server's figure for space used changes with every sync; re-read it when one finishes.
  useEffect(() => {
    if (limited && s.phase !== 'syncing') void refresh().catch(() => {});
  }, [s.lastSyncAt, s.phase, limited, refresh]);

  const status =
    s.phase === 'syncing'
      ? 'Syncing…'
      : s.phase === 'offline'
        ? 'Offline. Changes sync when you’re back online.'
        : s.phase === 'signed-out'
          ? 'Signed out on this device.'
          : s.phase === 'full'
            ? billing?.plan === 'free'
              ? 'Your free sync space is full. New changes stay on this device until you subscribe.'
              : 'You’ve reached the fair-use limit. New changes stay on this device until you free some space.'
            : s.phase === 'error'
              ? `Sync problem: ${s.message ?? 'unknown error'}`
              : 'Up to date';

  return (
    <>
      <div className="card">
        <div className="sync-status-line">
          <strong>{status}</strong>
          {s.phase !== 'signed-out' && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={s.phase === 'syncing'} onClick={() => void syncNow()}>
              {s.phase === 'syncing' && <Spinner />}Sync now
            </button>
          )}
          {s.phase === 'signed-out' && (
            <Link to="/signin" className="btn btn-primary btn-sm">
              Sign in again
            </Link>
          )}
        </div>
        <dl className="kv">
          <dt>Account</dt>
          <dd>{vault?.account?.username}</dd>
          <dt>Last synced</dt>
          <dd>{when(s.lastSyncAt)}</dd>
          <dt>Waiting to sync</dt>
          <dd>{s.pending ? `${s.pending} change${s.pending === 1 ? '' : 's'}` : 'Nothing'}</dd>
          {billing && billing.limitBytes > 0 && (
            <>
              <dt>Space on the server</dt>
              <dd className={isFull(billing) || s.phase === 'full' ? 'error-text' : undefined}>
                {formatBytes(billing.usedBytes)} of {formatBytes(billing.limitBytes)}
                {billing.plan === 'free' && (
                  <>
                    {' '}free ·{' '}
                    <button type="button" className="btn-link small" style={{ minHeight: 0 }} onClick={() => paywall.open('settings')}>
                      Get more space
                    </button>
                  </>
                )}
              </dd>
            </>
          )}
          {s.conflicts > 0 && (
            <>
              <dt>Needs attention</dt>
              <dd className="error-text">
                {s.conflicts === 1 ? '1 entry was' : `${s.conflicts} entries were`} changed on two devices at once. Open it in your journal to choose.
              </dd>
            </>
          )}
        </dl>
      </div>
    </>
  );
}

/** Sync on: taking the journal off a shared or borrowed device. */
function RemoveFromDevice() {
  const s = useSyncStatus();
  const [confirm, setConfirm] = useState(false);
  const { busy, run: remove } = useSignOutOfDevice();
  return (
    <SettingsPage
      title="Remove from this device"
      lede="For a shared or borrowed device. The copy here is deleted and this device is signed out; your journal stays on your sync account and your other devices."
    >
      <div className="card">
        <button type="button" className="btn btn-danger" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirm(true)}>
          Remove from this device
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Remove the journal from this device?"
        body={
          signOutBody(s.pending)
        }
        confirmLabel="Remove"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirm(false)}
      />
    </SettingsPage>
  );
}

/** Journal without sync: deleting it from this device for good. */
function DeleteLocal() {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <SettingsPage
      title="Delete journal"
      lede={`Deletes every entry and photo from ${desktop ? 'the journal folder' : 'this browser'}. There’s no other copy, so this can’t be undone. Export first if you want to keep anything.`}
    >
      <div className="card">
        <button type="button" className="btn btn-danger" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirm(true)}>
          Delete this journal…
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Delete your journal for good?"
        body={
          <>
            <p>Every entry and photo on this device will be deleted. Nobody can bring them back.</p>
            <TextField label='Type "delete" to confirm' value={typed} onChange={setTyped} autoComplete="off" />
          </>
        }
        confirmLabel="Delete everything"
        danger
        busy={busy}
        onConfirm={() => {
          if (typed.trim().toLowerCase() !== 'delete') return;
          setBusy(true);
          void removeJournalFromDevice(forgetVault).then(() => navigate('/welcome', { replace: true }));
        }}
        onCancel={() => {
          setConfirm(false);
          setTyped('');
        }}
      />
    </SettingsPage>
  );
}

export default function SyncSettings() {
  const { vault, synced } = useIdentity();
  const s = useSyncStatus();
  const { sub, redirect } = useSubPage('sync');
  if (redirect) return redirect;
  if (sub === 'device') return desktop ? <FolderStorage /> : <DeviceStorage />;
  if (sub === 'server') return <ServerDataPage />;
  if (sub === 'sent') return <SentLogPage />;
  if (sub === 'remove') return <RemoveFromDevice />;
  if (sub === 'delete') return <DeleteLocal />;
  const account = vault?.account;
  const ready = !!account && account.status === 'active' && (account.hasSecondFactor || !account.isAdmin);
  return (
    <SettingsPage
      title="Sync"
      lede={
        !synced
          ? 'Off. Your journal lives only on this device, and nothing is sent anywhere.'
          : ready
            ? 'On. An encrypted copy of your journal is kept on the server and on every device you sign in on.'
            : 'Not syncing yet.'
      }
    >
      <div className="sync-body">{!synced ? <TurnOnSync /> : ready && s.phase !== 'waiting' ? <SyncOn /> : <FinishSetup />}</div>
    </SettingsPage>
  );
}

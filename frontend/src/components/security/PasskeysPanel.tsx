import { desktop } from '../../desktop/bridge';
import { useState } from 'react';
import { errorMessage, isApiError } from '../../api/client';
import { passkeys as passkeyApi } from '../../api/endpoints';
import type { Passkey } from '../../api/types';
import { defaultPasskeyName, enablePasskeyUnlock, registerPasskey, webauthnSupported } from '../../api/webauthn';
import { isUnlocked, masterKeyCopy } from '../../crypto/session';
import { useAuth, useMe } from '../../state/auth';
import { relativeTime } from '../../lib/format';
import { ConfirmDialog, Dialog } from '../Dialog';
import { TextField } from '../Fields';
import { KeyIcon, PlusIcon } from '../Icons';
import { Spinner } from '../Spinner';
import { useToast } from '../Toast';

function describe(p: Passkey): string {
  const added = relativeTime(p.createdAt);
  const when = added === 'Now' ? 'Added just now' : `Added ${added.toLowerCase()}`;
  return `${when} · ${p.prf ? 'can unlock journal' : 'sign-in only'}`;
}

/** Lists passkeys with rename (and optionally delete), and adds new ones with PRF unlock. */
export function PasskeysPanel({ allowDelete = false }: { allowDelete?: boolean }) {
  const me = useMe();
  const { refresh } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<Passkey | null>(null);
  const supported = webauthnSupported();

  const add = async () => {
    setError(null);
    setBusy(true);
    const mk = isUnlocked() ? masterKeyCopy() : null;
    try {
      const existing = new Set(me.passkeys.map((p) => p.name));
      let name = defaultPasskeyName();
      for (let i = 2; existing.has(name); i++) name = `${defaultPasskeyName()} ${i}`;
      const res = await registerPasskey(name, mk);
      await refresh();
      toast.show(
        res.canUnlock
          ? `Passkey added. "${res.passkey.name}" can also unlock your journal.`
          : `Passkey added. This authenticator can sign you in, but can't unlock the journal, so you'll still type your passphrase.`,
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      mk?.fill(0);
      setBusy(false);
    }
  };

  const enableUnlock = async (p: Passkey) => {
    setError(null);
    setBusy(true);
    const mk = masterKeyCopy();
    try {
      const ok = await enablePasskeyUnlock(p, mk);
      if (ok) {
        await refresh();
        toast.show(`"${p.name}" can now unlock your journal.`);
      } else {
        setError("This passkey's authenticator can't unlock the journal (no PRF support). It still works for signing in.");
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) setError(errorMessage(e));
    } finally {
      mk.fill(0);
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!renaming) return;
    const name = newName.trim();
    if (!name) return;
    try {
      await passkeyApi.rename(renaming.id, name.slice(0, 64));
      await refresh();
      setRenaming(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await passkeyApi.remove(deleting.id);
      await refresh();
      setDeleting(null);
    } catch (e) {
      setDeleting(null);
      setError(
        isApiError(e, 'last_second_factor')
          ? "You can't remove your last second factor. Add another passkey or an authenticator app first."
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      {me.passkeys.length > 0 && (
        <ul className="rows" aria-label="Your passkeys">
          {me.passkeys.map((p) => (
            <li key={p.id}>
              <KeyIcon className="lead" size={18} />
              <span className="row-main">
                <span className="row-title">{p.name || 'Passkey'}</span>
                <span className="row-sub">
                  {describe(p)}
                  {p.lastUsedAt ? ` · last used ${relativeTime(p.lastUsedAt).toLowerCase()}` : ''}
                </span>
              </span>
              {!p.prf && p.credentialId && supported && isUnlocked() && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void enableUnlock(p)}>
                  Use to unlock<span className="visually-hidden"> with {p.name}</span>
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setRenaming(p);
                  setNewName(p.name);
                }}
              >
                Rename<span className="visually-hidden"> {p.name}</span>
              </button>
              {allowDelete && (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setDeleting(p)}>
                  Remove<span className="visually-hidden"> {p.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!supported && (
        <p className="hint">
          {desktop ? "The desktop app can't use passkeys: add and use them on the website." : "This browser doesn't support passkeys."} You can use an
          authenticator app instead.
        </p>
      )}
      <button type="button" className={`btn ${me.passkeys.length ? 'btn-secondary' : 'btn-primary'}`} onClick={add} disabled={busy || !supported}>
        {busy ? <Spinner /> : me.passkeys.length ? <PlusIcon /> : <KeyIcon />}
        {me.passkeys.length ? 'Add another passkey' : 'Add a passkey'}
      </button>
      {error && <p className="error-text" role="alert">{error}</p>}

      <Dialog
        open={!!renaming}
        title="Rename passkey"
        onClose={() => setRenaming(null)}
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRenaming(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={saveName} disabled={!newName.trim()}>Save</button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
        >
          <TextField label="Name" value={newName} onChange={setNewName} maxLength={64} autoFocus />
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        title="Remove this passkey?"
        body={
          <>
            <strong>{deleting?.name}</strong> will no longer sign you in or unlock the journal. Your entries aren't affected.
          </>
        }
        confirmLabel="Remove passkey"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

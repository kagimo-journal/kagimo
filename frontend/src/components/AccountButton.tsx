import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { forgetVault } from '../local/vault';
import { useAuth } from '../state/auth';
import { removeJournalFromDevice } from '../state/flows';
import { useIdentity } from '../state/identity';
import { useSyncStatus } from '../sync/engine';
import { ConfirmDialog } from './Dialog';
import { SignInIcon, SignOutIcon } from './Icons';
import { useToast } from './Toast';

/**
 * Signing out of this device: ends the session and deletes the copy here (the account keeps the
 * journal). Unsent changes would be lost, so the dialog says how many.
 */
export function useSignOutOfDevice() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await signOut().catch(() => {});
      await removeJournalFromDevice(forgetVault);
      navigate('/signin', { replace: true });
    } catch (e) {
      toast.show(errorMessage(e));
      setBusy(false);
    }
  };
  return { busy, run };
}

/** The dialog body for signing out / removing a synced journal from this device. */
export function signOutBody(pending: number): string {
  return pending
    ? `${pending} change${pending === 1 ? " hasn't" : "s haven't"} reached the server yet and would be lost. Sync first, unless you're sure.`
    : 'Your journal stays on your sync account and your other devices. The copy on this device is deleted; sign in again to get it back.';
}

/**
 * Bottom of the side nav: "Sign out" for a synced journal; "Sign in" for one that's only on this
 * device (it replaces it with an account's journal, see SignIn).
 */
export function AccountButton({ variant }: { variant: 'icon' | 'link' }) {
  const { synced } = useIdentity();
  const { pending } = useSyncStatus();
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useSignOutOfDevice();

  if (!synced) {
    return variant === 'icon' ? (
      <Link to="/signin" className="icon-btn" aria-label="Sign in to an existing account" title="Sign in to an existing account">
        <SignInIcon size={16} />
      </Link>
    ) : (
      <Link to="/signin" className="settings-link signout">Sign in to an existing account</Link>
    );
  }
  return (
    <>
      {variant === 'icon' ? (
        <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={() => setConfirm(true)}>
          <SignOutIcon size={16} />
        </button>
      ) : (
        <button type="button" className="settings-link signout" onClick={() => setConfirm(true)}>
          Sign out
        </button>
      )}
      <ConfirmDialog
        open={confirm}
        title="Sign out of this device?"
        body={signOutBody(pending)}
        confirmLabel="Sign out"
        danger={pending > 0}
        busy={busy}
        onConfirm={() => void run()}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

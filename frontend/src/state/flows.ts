/**
 * Client-side flows that combine key derivation with the sync account (SPEC §3, §5, §10).
 * Passphrases and derived roots never leave this module except as `authKey`.
 */
import { isApiError } from '../api/client';
import { auth, account, signup as signupApi } from '../api/endpoints';
import type { Me } from '../api/types';
import { decryptSettings, encryptSettings } from '../crypto/content';
import { toBase64 } from '../crypto/encoding';
import { newKdfParams } from '../crypto/kdf';
import { derivePassphraseKeys, deriveRecoveryKeys, unwrapMasterKey, wrapMasterKey } from '../crypto/keys';
import { generateRecoveryKey, parseRecoveryKey } from '../crypto/recovery';
import { lockNow, masterKeyCopy, unlock } from '../crypto/session';
import { desktop } from '../desktop/bridge';
import { passkeySecondStep } from '../api/webauthn';
import type { VaultRecord } from '../local/db';
import { deleteVault, getSettingsRecord } from '../local/repo';
import {
  accountLink,
  changeVault,
  createVaultFromAccount,
  currentVault,
  recoveryAuthKey,
  refreshVaultFromMe,
  requireVault,
} from '../local/vault';
import { refreshSyncPhase, syncNow } from '../sync/engine';

/** True when the account may sync (journal, settings and admin endpoints, SPEC §5.1). */
export function canUseJournal(me: Me | null | undefined): boolean {
  return !!me && me.status === 'active' && secondFactorOk(me);
}

/** Only administrators must have a passkey or authenticator app; for members it's optional. */
export function secondFactorOk(a: { isAdmin: boolean; hasSecondFactor: boolean }): boolean {
  return a.hasSecondFactor || !a.isAdmin;
}

export class OtherJournalError extends Error {
  constructor() {
    super('This browser already holds a journal synced with a different account. Remove it from this device in Settings → Sync before signing in to another one.');
    this.name = 'OtherJournalError';
  }
}

/**
 * After signing in to a sync account: makes this device's journal that account's, setting up its
 * copy when needed. A device holds one journal: a journal that was only on this device (no sync)
 * is replaced and deleted (the sign-in page warns first); one synced with another account is refused.
 */
export async function ensureAccountJournal(me: Me): Promise<VaultRecord> {
  const v = currentVault();
  if (v?.account) {
    if (v.account.userId !== String(me.id)) throw new OtherJournalError();
    await refreshVaultFromMe(me);
    return requireVault();
  }
  if (v) lockNow(); // the local journal's keys
  // A folder holds one journal, so in the desktop app the local one goes before the account's arrives.
  if (v && desktop) await deleteVault(v.id);
  const vault = await createVaultFromAccount(me);
  if (v && !desktop) await deleteVault(v.id);
  return vault;
}

/** After signing in to a sync account: ensureAccountJournal, then unlocks it. */
export async function openAccountJournal(me: Me, mk: Uint8Array): Promise<void> {
  const vault = await ensureAccountJournal(me);
  await unlock(vault.id, mk);
  refreshSyncPhase();
  void syncNow();
}

/**
 * Result of the passphrase step (SPEC §5.1 "Passphrase sign-in"). When a second step is needed,
 * `totp` / `passkey` say which ones the account allows; either completes the sign-in.
 */
export type PassphraseLogin =
  | { status: 'ok'; me: Me }
  | {
      status: 'second_step';
      totp: boolean;
      passkey: boolean;
      completeTotp: (code: string) => Promise<Me>;
      completePasskey: () => Promise<Me>;
    };

/** prelogin → argon2id → login; opens the account's journal on this device on success. */
export async function loginWithPassphrase(username: string, passphrase: string): Promise<PassphraseLogin> {
  const { kdf } = await auth.prelogin(username);
  const { authKey, kek } = await derivePassphraseKeys(passphrase, kdf);
  let res: Awaited<ReturnType<typeof auth.login>>;
  try {
    res = await auth.login(username, toBase64(authKey));
  } finally {
    authKey.fill(0);
  }
  const finish = async (me: Me) => {
    const mk = await unwrapMasterKey(kek, me.keys.wrappedMkPass);
    try {
      await openAccountJournal(me, mk);
    } finally {
      mk.fill(0);
    }
    return me;
  };
  if (res.status === 'ok') return { status: 'ok', me: await finish(res.me) };
  const totp = res.status === 'totp_required';
  const passkey = res.status === 'passkey_required' || (res.status === 'totp_required' && res.passkeyAllowed === true);
  return {
    status: 'second_step',
    totp,
    passkey,
    completeTotp: async (code: string) => finish((await auth.loginTotp(code)).me),
    completePasskey: async () => finish(await passkeySecondStep()),
  };
}

/**
 * A browser signed in to an account from before journals lived on devices: the passphrase unlocks
 * the account's keys and this device gets its own copy of the journal.
 */
export async function adoptAccountWithPassphrase(me: Me, passphrase: string): Promise<void> {
  const { kek, authKey } = await derivePassphraseKeys(passphrase, me.keys.kdf);
  authKey.fill(0);
  const mk = await unwrapMasterKey(kek, me.keys.wrappedMkPass);
  try {
    await openAccountJournal(me, mk);
  } finally {
    mk.fill(0);
  }
}

// ---- turning sync on -------------------------------------------------------------------------------

export interface EnableSyncResult {
  me: Me;
  /** Set when the journal had no recovery credential to carry over and got a new recovery key. */
  newRecoveryKey: string | null;
}

/**
 * Creates a sync account for the journal on this device. The same master key, passphrase wrap and
 * recovery wrap go to the server, so nothing is re-encrypted; entries upload with the first sync.
 */
export async function enableSync(username: string, passphrase: string, invite?: string): Promise<EnableSyncResult> {
  const v = requireVault();
  if (v.account) throw new Error('Sync is already on for this journal.');
  if (!v.wrappedMkPass) throw new Error('Set a password for this journal before turning on sync.');
  const { authKey, kek } = await derivePassphraseKeys(passphrase, v.kdf);
  try {
    (await unwrapMasterKey(kek, v.wrappedMkPass)).fill(0); // a wrong passphrase stops here (DecryptError)

    let recoveryAuth = await recoveryAuthKey(v);
    let wrappedMkRecovery = v.wrappedMkRecovery;
    let newRecoveryKey: string | null = null;
    if (!recoveryAuth || !wrappedMkRecovery) {
      const rec = generateRecoveryKey();
      const mk = masterKeyCopy();
      try {
        const keys = await deriveRecoveryKeys(rec.bytes);
        wrappedMkRecovery = await wrapMasterKey(keys.kek, mk);
        recoveryAuth = toBase64(keys.authKey);
        keys.authKey.fill(0);
        newRecoveryKey = rec.formatted;
      } finally {
        mk.fill(0);
        rec.bytes.fill(0);
      }
    }

    let me: Me;
    try {
      ({ me } = await signupApi({
        username,
        note: '',
        kdf: v.kdf,
        authKey: toBase64(authKey),
        recoveryAuthKey: recoveryAuth,
        wrappedMkPass: v.wrappedMkPass,
        wrappedMkRecovery: wrappedMkRecovery!,
        ...(invite ? { invite } : {}),
      }));
    } catch (e) {
      if (!isApiError(e, 'username_taken')) throw e;
      // Taken, perhaps by this journal: an earlier try that made the account and was cut short
      // before this device recorded it. The account that holds this journal's own wrapped key is
      // that one; signing in to it carries on from there. Anyone else's stays "taken".
      const mine = await auth.login(username, toBase64(authKey)).catch(() => null);
      if (mine?.status !== 'ok' || JSON.stringify(mine.me.keys.wrappedMkPass) !== JSON.stringify(v.wrappedMkPass)) throw e;
      me = mine.me;
      // The recovery key made on that try was never shown: the one made now replaces it.
      if (newRecoveryKey) await account.regenerateRecovery(recoveryAuth, wrappedMkRecovery!);
    }
    const userId = String(me.id);

    // Settings are bound to the account id from now on (AAD `settings:<userId>`). They and the
    // vault's link to the account are written together: one without the other can't be read.
    const s = await getSettingsRecord(v.id);
    const resealed = s?.sealed
      ? { ...s, sealed: await encryptSettings(userId, await decryptSettings<unknown>(v.aadId, s.sealed)), dirty: true, rev: s.rev + 1 }
      : undefined;
    await changeVault(
      (x) => ({
        ...x,
        account: accountLink(me),
        aadId: userId,
        wrappedMkRecovery,
        sync: { cursor: 0, lastSyncAt: null, full: false },
      }),
      resealed,
    );
    refreshSyncPhase();
    return { me, newRecoveryKey };
  } finally {
    authKey.fill(0);
  }
}

// ---- recovery with the server (synced journals) ---------------------------------------------------------

/** Step 1 of recovery: proves the recovery key and decrypts the MK locally. */
export async function verifyRecoveryKey(username: string, recoveryKey: string, totpCode?: string) {
  const bytes = parseRecoveryKey(recoveryKey);
  const { authKey, kek } = await deriveRecoveryKeys(bytes);
  bytes.fill(0);
  try {
    const { token, wrappedMkRecovery } = await auth.recoverVerify(username, toBase64(authKey), totpCode);
    const mk = await unwrapMasterKey(kek, wrappedMkRecovery);
    return { token, mk };
  } finally {
    authKey.fill(0);
  }
}

/** Step 2 of recovery: sets a new passphrase (re-wraps the MK) and opens the journal. */
export async function resetPassphrase(token: string, mk: Uint8Array, passphrase: string): Promise<Me> {
  const kdf = newKdfParams();
  const { authKey, kek } = await derivePassphraseKeys(passphrase, kdf);
  try {
    const { me } = await auth.recoverReset(token, kdf, toBase64(authKey), await wrapMasterKey(kek, mk));
    await openAccountJournal(me, mk);
    mk.fill(0);
    return me;
  } finally {
    authKey.fill(0);
  }
}

/**
 * Re-proves the passphrase for the current session, which the server requires shortly before
 * security changes (adding passkeys or TOTP, replacing the recovery key, SPEC §5.1).
 */
export async function reauthenticate(me: Me, passphrase: string): Promise<void> {
  const { authKey, kek } = await derivePassphraseKeys(passphrase, me.keys.kdf);
  try {
    // Check locally first so a typo gives a clear message without a server round-trip.
    const check = await unwrapMasterKey(kek, me.keys.wrappedMkPass);
    check.fill(0);
    await auth.reauth(toBase64(authKey));
  } finally {
    authKey.fill(0);
  }
}

/** Changes the passphrase of a synced journal: on the server, then on this device. */
export async function changePassphrase(me: Me, current: string, next: string): Promise<void> {
  const cur = await derivePassphraseKeys(current, me.keys.kdf);
  // Verify locally first so a typo gives a clear message without a server round-trip.
  const check = await unwrapMasterKey(cur.kek, me.keys.wrappedMkPass);
  check.fill(0);
  const kdf = newKdfParams();
  const fresh = await derivePassphraseKeys(next, kdf);
  const mk = masterKeyCopy();
  try {
    const wrapped = await wrapMasterKey(fresh.kek, mk);
    await account.changePassphrase(toBase64(cur.authKey), kdf, toBase64(fresh.authKey), wrapped);
    await changeVault((x) => ({ ...x, kdf, wrappedMkPass: wrapped }));
  } finally {
    mk.fill(0);
    cur.authKey.fill(0);
    fresh.authKey.fill(0);
  }
}

/** Locks and deletes this device's copy of the journal (the server copy, if any, stays). */
export async function removeJournalFromDevice(forget: () => Promise<void>): Promise<void> {
  lockNow();
  await forget();
  refreshSyncPhase();
}

/**
 * The journal on this device ("vault"): its wrapped keys and, when sync is on, its account. Every
 * flow here works offline; only the sync account itself needs the server (SPEC §10).
 */
import { useSyncExternalStore } from 'react';
import type { Me } from '../api/types';
import { openBytes, openJSON, sealBytes, sealJSON, type Sealed } from '../crypto/aead';
import { fromBase64, toBase64 } from '../crypto/encoding';
import { newKdfParams } from '../crypto/kdf';
import { derivePassphraseKeys, deriveRecoveryKeys, generateMasterKey, unwrapMasterKey, wrapMasterKey } from '../crypto/keys';
import { generateRecoveryKey, parseRecoveryKey } from '../crypto/recovery';
import { desktop } from '../desktop/bridge';
import { contentKey, idleTimeoutMs, masterKeyCopy, setAutoLockEnabled, unlock } from '../crypto/session';
import type { AccountLink, SettingsRecord, VaultRecord } from './db';
import {
  deleteVault,
  getDeviceKey,
  loadActiveVault,
  saveVault,
  saveVaultWithDeviceKey,
  updateVault,
  updateVaultDroppingDeviceKey,
} from './repo';
import { pruneResumeKeys, takeResumedKey } from './resume';

// ---- current vault -------------------------------------------------------------------------------

/** undefined while loading, null when this device has no journal. */
let current: VaultRecord | null | undefined;
let loadError: string | null = null;
const listeners = new Set<() => void>();

function set(v: VaultRecord | null) {
  current = v;
  // A journal without a password has nothing to lock it with.
  setAutoLockEnabled(!v || hasPassword(v));
  listeners.forEach((l) => l());
}

export function subscribeVault(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function currentVault(): VaultRecord | null | undefined {
  return current;
}

export function vaultLoadError(): string | null {
  return loadError;
}

/** The current vault; throws when there is none (callers are behind the journal guard). */
export function requireVault(): VaultRecord {
  if (!current) throw new Error('No journal on this device');
  return current;
}

export function useVault(): VaultRecord | null | undefined {
  return useSyncExternalStore(subscribeVault, currentVault);
}

/** True when the journal is protected by a passphrase (false: it opens on this device by itself). */
export function hasPassword(v: VaultRecord): boolean {
  return v.wrappedMkPass !== null;
}

/**
 * Loads the journal on this device and, where it can, opens it before anything renders: a journal
 * without a password always; one with a password when this tab had it open before a reload.
 */
export async function initVault(): Promise<void> {
  let v: VaultRecord | null;
  loadError = null;
  try {
    v = await loadActiveVault();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
    set(null);
    return;
  }
  if (v) await reopen(v).catch(() => {});
  set(v);
  if (!desktop) void pruneResumeKeys();
}

/** Opens the journal without asking, when that's possible (see initVault). Returns whether it did. */
export async function reopen(v: VaultRecord, how: 'reload' | 'bfcache' = 'reload'): Promise<boolean> {
  if (!hasPassword(v)) {
    await unlockWithDeviceKey(v);
    return true;
  }
  const mk = await takeResumedKey(v.id, idleTimeoutMs(), how);
  if (!mk) return false;
  try {
    await unlock(v.id, mk);
    return true;
  } finally {
    mk.fill(0);
  }
}

/** Applies a change to the current vault record, in storage and in memory. */
export async function changeVault(fn: (v: VaultRecord) => VaultRecord, settings?: SettingsRecord): Promise<VaultRecord> {
  const v = requireVault();
  const next = await updateVault(v.id, fn, settings);
  if (!next) throw new Error('This journal is no longer on this device');
  if (current?.id === next.id) set(next);
  return next;
}

/** Like changeVault, for a vault that may no longer be the current one (background sync). */
export async function updateVaultById(id: string, fn: (v: VaultRecord) => VaultRecord): Promise<VaultRecord | null> {
  const next = await updateVault(id, fn);
  if (next && current?.id === id) set(next);
  return next;
}

/** Re-reads the vault record (another tab or the sync engine changed it). */
export async function reloadVault(): Promise<void> {
  set(await loadActiveVault());
}

export async function forgetVault(): Promise<void> {
  const v = current;
  if (v) await deleteVault(v.id);
  set(null);
}

/** The name the journal greets you with. */
export function vaultName(v: VaultRecord | null | undefined): string {
  return v?.name || v?.account?.username || '';
}

// ---- recovery credential kept for turning sync on later -----------------------------------------------

const recoveryAuthAad = (vaultId: string) => `vault:${vaultId}:recovery-auth`;

async function sealRecoveryAuth(vaultId: string, authKey: Uint8Array): Promise<Sealed> {
  return sealJSON(contentKey(), { k: toBase64(authKey) }, recoveryAuthAad(vaultId));
}

/** The recovery key's server credential (base64), when this journal kept one. Needs the journal unlocked. */
export async function recoveryAuthKey(v: VaultRecord): Promise<string | null> {
  if (!v.recoveryAuth) return null;
  const { k } = await openJSON<{ k: string }>(contentKey(), v.recoveryAuth, recoveryAuthAad(v.id));
  return k;
}

// ---- creating and unlocking ----------------------------------------------------------------------------

const deviceAad = (vaultId: string) => `vault:${vaultId}:device`;

/**
 * Creates a journal on this device without a password, entirely offline, and unlocks it. Its master
 * key is wrapped under a non-extractable device key (in the desktop app: kept in the computer's
 * keychain), so it opens by itself here until a password is set (setLocalPassword). There's no
 * recovery key yet: nothing to recover from without a password.
 */
export async function createPasswordlessVault(): Promise<VaultRecord> {
  const mk = generateMasterKey();
  const id = crypto.randomUUID();
  try {
    const vault: VaultRecord = {
      id,
      name: '',
      createdAt: new Date().toISOString(),
      kdf: newKdfParams(),
      wrappedMkPass: null,
      wrappedMkRecovery: null,
      recoveryAuth: null,
      passkeyWraps: [],
      aadId: id,
      account: null,
      sync: { cursor: 0, lastSyncAt: null, full: false },
      exportedAt: null,
    };
    if (desktop) {
      // The key first: a journal whose key was never stored could not be opened again.
      await desktop.keys.save(id, mk);
      await saveVault(vault, true);
    } else {
      const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const { nonce, ct } = await sealBytes(cryptoKey, mk, deviceAad(id));
      await saveVaultWithDeviceKey(vault, { cryptoKey, nonce: toBase64(nonce), ct: toBase64(ct) });
    }
    await unlock(id, mk);
    set(vault);
    void requestPersistentStorage();
    return vault;
  } finally {
    mk.fill(0);
  }
}

/** Thrown when a journal without a password is opened somewhere its key isn't. */
export class MissingKeyError extends Error {
  constructor() {
    super(
      desktop
        ? 'This journal has no password, so it only opens on the computer it was made on, and its key isn’t on this one.'
        : 'This journal’s key is missing from this browser.',
    );
    this.name = 'MissingKeyError';
  }
}

async function deviceMasterKey(v: VaultRecord): Promise<Uint8Array> {
  if (desktop) {
    const mk = await desktop.keys.load(v.id);
    if (!mk) throw new MissingKeyError();
    return mk;
  }
  const key = await getDeviceKey(v.id);
  if (!key) throw new MissingKeyError();
  return openBytes(key.cryptoKey, fromBase64(key.nonce), fromBase64(key.ct), deviceAad(v.id));
}

export async function unlockWithDeviceKey(v: VaultRecord): Promise<void> {
  const mk = await deviceMasterKey(v);
  try {
    await unlock(v.id, mk);
  } finally {
    mk.fill(0);
  }
}

/**
 * Protects a journal that has no password yet: wraps the MK under the passphrase, makes a recovery
 * key, and deletes the device key. Nothing is re-encrypted. Returns the recovery key, to show once.
 */
export async function setLocalPassword(passphrase: string): Promise<string> {
  const v = requireVault();
  if (hasPassword(v)) throw new Error('This journal already has a password.');
  const kdf = newKdfParams();
  const rec = generateRecoveryKey();
  const mk = masterKeyCopy();
  try {
    const pass = await derivePassphraseKeys(passphrase, kdf);
    pass.authKey.fill(0);
    const recKeys = await deriveRecoveryKeys(rec.bytes);
    const wrappedMkPass = await wrapMasterKey(pass.kek, mk);
    const wrappedMkRecovery = await wrapMasterKey(recKeys.kek, mk);
    const recoveryAuth = await sealRecoveryAuth(v.id, recKeys.authKey);
    recKeys.authKey.fill(0);
    const next = await updateVaultDroppingDeviceKey(v.id, (x) => ({ ...x, kdf, wrappedMkPass, wrappedMkRecovery, recoveryAuth }));
    if (!next) throw new Error('This journal is no longer on this device');
    set(next);
    return rec.formatted;
  } finally {
    mk.fill(0);
    rec.bytes.fill(0);
  }
}

export function accountLink(me: Me): AccountLink {
  return { userId: String(me.id), username: me.username, status: me.status, isAdmin: me.isAdmin, hasSecondFactor: me.hasSecondFactor };
}

/**
 * Sets this device up for an account that already syncs (signing in on a new device, or an
 * account from before journals lived on devices). The MK must already be unlocked.
 */
export async function createVaultFromAccount(me: Me): Promise<VaultRecord> {
  const userId = String(me.id);
  const vault: VaultRecord = {
    id: crypto.randomUUID(),
    name: '',
    createdAt: new Date().toISOString(),
    kdf: me.keys.kdf,
    wrappedMkPass: me.keys.wrappedMkPass,
    wrappedMkRecovery: null,
    recoveryAuth: null,
    passkeyWraps: me.keys.passkeyWraps ?? [],
    aadId: userId,
    account: accountLink(me),
    sync: { cursor: 0, lastSyncAt: null, full: false },
    exportedAt: null,
  };
  await saveVault(vault, true);
  set(vault);
  void requestPersistentStorage();
  return vault;
}

/**
 * Keeps the local copy of the account's keys and status current after reading /api/me.
 * Returns true if anything changed (e.g. the account was approved).
 */
export async function refreshVaultFromMe(me: Me): Promise<boolean> {
  const v = current;
  if (!v?.account || v.account.userId !== String(me.id)) return false;
  const link = accountLink(me);
  const same =
    JSON.stringify(link) === JSON.stringify(v.account) &&
    JSON.stringify(me.keys.kdf) === JSON.stringify(v.kdf) &&
    JSON.stringify(me.keys.wrappedMkPass) === JSON.stringify(v.wrappedMkPass) &&
    JSON.stringify(me.keys.passkeyWraps ?? []) === JSON.stringify(v.passkeyWraps);
  if (same) return false;
  await changeVault((cur) => ({ ...cur, account: link, kdf: me.keys.kdf, wrappedMkPass: me.keys.wrappedMkPass, passkeyWraps: me.keys.passkeyWraps ?? [] }));
  return true;
}

export async function unlockVaultWithPassphrase(v: VaultRecord, passphrase: string): Promise<void> {
  if (!v.wrappedMkPass) return unlockWithDeviceKey(v);
  const { kek, authKey } = await derivePassphraseKeys(passphrase, v.kdf);
  authKey.fill(0);
  const mk = await unwrapMasterKey(kek, v.wrappedMkPass);
  try {
    await unlock(v.id, mk);
  } finally {
    mk.fill(0);
  }
}

// ---- local passphrase and recovery key (journals without sync) ---------------------------------------------

/** Checks the current passphrase and re-wraps the MK under a new one (nothing is re-encrypted). */
export async function changeLocalPassphrase(current: string, next: string): Promise<void> {
  const v = requireVault();
  if (!v.wrappedMkPass) throw new Error('This journal has no password yet.');
  const cur = await derivePassphraseKeys(current, v.kdf);
  cur.authKey.fill(0);
  (await unwrapMasterKey(cur.kek, v.wrappedMkPass)).fill(0); // throws DecryptError when wrong
  const kdf = newKdfParams();
  const fresh = await derivePassphraseKeys(next, kdf);
  fresh.authKey.fill(0);
  const mk = masterKeyCopy();
  try {
    const wrapped = await wrapMasterKey(fresh.kek, mk);
    await changeVault((x) => ({ ...x, kdf, wrappedMkPass: wrapped }));
  } finally {
    mk.fill(0);
  }
}

/**
 * Checks `passphrase` against this device's wrapped master key; throws DecryptError when it's
 * wrong. Asked before changes that would let someone at an unlocked journal keep a way in (a new
 * recovery key, a PIN). A journal without a password has nothing to check.
 */
export async function checkLocalPassphrase(passphrase: string): Promise<void> {
  const v = requireVault();
  if (!v.wrappedMkPass) return;
  const { kek, authKey } = await derivePassphraseKeys(passphrase, v.kdf);
  authKey.fill(0);
  (await unwrapMasterKey(kek, v.wrappedMkPass)).fill(0);
}

/**
 * Replaces the recovery key of a journal without sync, after checking the passphrase. Returns the
 * new key, to show once.
 */
export async function regenerateLocalRecovery(passphrase: string): Promise<string> {
  await checkLocalPassphrase(passphrase);
  const v = requireVault();
  const rec = generateRecoveryKey();
  const mk = masterKeyCopy();
  try {
    const keys = await deriveRecoveryKeys(rec.bytes);
    const wrapped = await wrapMasterKey(keys.kek, mk);
    const recoveryAuth = await sealRecoveryAuth(v.id, keys.authKey);
    keys.authKey.fill(0);
    await changeVault((x) => ({ ...x, wrappedMkRecovery: wrapped, recoveryAuth }));
    return rec.formatted;
  } finally {
    mk.fill(0);
    rec.bytes.fill(0);
  }
}

/** Unwraps the MK with the recovery key (journal without sync). The caller zeroes it. */
export async function openWithRecoveryKey(v: VaultRecord, recoveryKey: string): Promise<Uint8Array> {
  if (!v.wrappedMkRecovery) throw new Error('This journal’s recovery key is kept with its sync account. Connect to the internet to use it.');
  const bytes = parseRecoveryKey(recoveryKey);
  try {
    const { kek, authKey } = await deriveRecoveryKeys(bytes);
    authKey.fill(0);
    return await unwrapMasterKey(kek, v.wrappedMkRecovery);
  } finally {
    bytes.fill(0);
  }
}

/** After the recovery key opened the journal: set a new passphrase and unlock. */
export async function resetLocalPassphrase(v: VaultRecord, mk: Uint8Array, passphrase: string): Promise<void> {
  const kdf = newKdfParams();
  const { kek, authKey } = await derivePassphraseKeys(passphrase, kdf);
  authKey.fill(0);
  const wrapped = await wrapMasterKey(kek, mk);
  await updateVault(v.id, (x) => ({ ...x, kdf, wrappedMkPass: wrapped }));
  await unlock(v.id, mk);
  await reloadVault();
}

// ---- storage durability ---------------------------------------------------------------------------------

/** Asks the browser not to evict this site's storage (SPEC §10 "Durability"). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageStatus(): Promise<{ persisted: boolean | null; usage: number | null; quota: number | null }> {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
  } catch {
    return { persisted: null, usage: null, quota: null };
  }
}


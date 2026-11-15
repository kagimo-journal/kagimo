/**
 * The on-device database (SPEC §10). IndexedDB holds the journal as ciphertext, in exactly the
 * shapes the server stores: encrypted entry headers and bodies, encrypted images, encrypted
 * settings, and the wrapped (encrypted) master key. The only keys in it are non-extractable
 * CryptoKeys (see repo.ts `DeviceKey` and resume.ts), whose bytes scripts can't read.
 */
import type { Sealed } from '../crypto/aead';
import type { KdfParams } from '../crypto/kdf';
import type { PasskeyWrap } from '../api/types';

export const DB_NAME = 'kagimo';
const DB_VERSION = 1;

export interface AccountLink {
  userId: string;
  username: string;
  status: 'pending' | 'active' | 'disabled';
  isAdmin: boolean;
  hasSecondFactor: boolean;
}

export interface VaultRecord {
  id: string;
  /** What the journal greets you with. */
  name: string;
  createdAt: string;
  kdf: KdfParams;
  /** null for a journal without a password: its MK is wrapped under the device key instead (repo.ts). */
  wrappedMkPass: Sealed | null;
  /** null for journals that started on the server: their recovery goes through it. */
  wrappedMkRecovery: Sealed | null;
  /**
   * The recovery key's server credential, sealed with the content key (AAD
   * `vault:<id>:recovery-auth`), so sync can be turned on later without asking for the recovery
   * key. null for journals that started on the server.
   */
  recoveryAuth: Sealed | null;
  passkeyWraps: PasskeyWrap[];
  /** The id bound into the settings AAD: the vault id, or the server user id once synced. */
  aadId: string;
  /** The sync account, when sync is on. */
  account: AccountLink | null;
  sync: { cursor: number; lastSyncAt: string | null; full: boolean };
  /** When the journal was last exported (backup reminders for journals without sync). */
  exportedAt: string | null;
}

export interface RemoteCopy {
  header: Sealed;
  body: Sealed;
  version: number;
  updatedAt: string;
}

export interface EntryConflict {
  /** The other device's copy, as on the server (null when it was deleted there). */
  theirs: RemoteCopy | null;
  /** The last copy both sides agreed on (null: none, e.g. it was deleted on the other device). */
  base: { header: Sealed; body: Sealed } | null;
  /** 'deleted': the other device burned this entry while this one still had changes to it. */
  kind: 'edit' | 'deleted';
}

export interface EntryRecord {
  vaultId: string;
  id: string;
  header: Sealed;
  body: Sealed;
  createdAt: string;
  /** Last change, local or pulled. */
  updatedAt: string;
  /** Server version this copy is based on; 0 = not on the server yet. */
  version: number;
  /** The server copy at `version`, the base for a three-way merge. */
  base: { header: Sealed; body: Sealed } | null;
  /** Local changes not pushed yet. */
  dirty: boolean;
  /** Bumped on every local save, so a push can tell whether the record changed meanwhile. */
  rev: number;
  /** A newer server copy waiting for the open editor to take it in. */
  incoming: RemoteCopy | null;
  conflict: EntryConflict | null;
}

export interface BlobRecord {
  vaultId: string;
  id: string;
  entryId: string;
  nonce: Uint8Array | null;
  /** null until downloaded. */
  ct: Uint8Array | null;
  size: number;
  /** On the server. */
  synced: boolean;
}

export interface SettingsRecord {
  vaultId: string;
  sealed: Sealed | null;
  dirty: boolean;
  rev: number;
}

/** A deletion still to be sent to the server. */
export interface OutboxRecord {
  vaultId: string;
  kind: 'entry' | 'blob';
  id: string;
  /** Entries only: when the server took the deletion. The record stays so the entry can't return. */
  sent?: string;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

export type StoreName = 'vaults' | 'entries' | 'blobs' | 'settings' | 'outbox' | 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no on-device storage (IndexedDB), so Kagimo can’t keep a journal here.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('vaults', { keyPath: 'id' });
      db.createObjectStore('entries', { keyPath: ['vaultId', 'id'] });
      const blobs = db.createObjectStore('blobs', { keyPath: ['vaultId', 'id'] });
      blobs.createIndex('byEntry', ['vaultId', 'entryId']);
      db.createObjectStore('settings', { keyPath: 'vaultId' });
      db.createObjectStore('outbox', { keyPath: ['vaultId', 'kind', 'id'] });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema: let it, and reopen next time.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Could not open on-device storage'));
    req.onblocked = () => reject(new Error('Kagimo is being updated in another tab. Close the other tabs and reload.'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Closes the connection (tests, deleting the database). */
export async function closeDb(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (p) (await p.catch(() => null))?.close();
}

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Runs `fn` in one transaction and resolves with its result once the transaction has committed.
 * `fn` must only await IDB requests of this transaction (anything else lets it auto-commit).
 */
export async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new Error('Storage transaction aborted'));
    t.onerror = () => reject(t.error ?? new Error('Storage transaction failed'));
  });
  let result: T;
  try {
    result = await fn(t);
  } catch (e) {
    try {
      t.abort();
    } catch {
      /* already finished */
    }
    await done.catch(() => {});
    throw e;
  }
  await done;
  return result;
}

/** All records of a vault in a store keyed by [vaultId, …]. */
export function vaultRange(vaultId: string): IDBKeyRange {
  return IDBKeyRange.bound([vaultId], [vaultId, []]);
}

/** Bytes a base64 string decodes to, without decoding it. */
function b64Bytes(s: string | undefined): number {
  if (!s) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}

export const sealedBytes = (s: Sealed | null | undefined) => (s ? b64Bytes(s.nonce) + b64Bytes(s.ct) : 0);

export interface JournalSize {
  entries: number;
  /** The entries and settings, encrypted: what sync counts against a storage limit (SPEC §5.6). */
  textBytes: number;
  photos: number;
  photoBytes: number;
}

/**
 * How big the journal itself is, measured the way the server measures it: each entry's current
 * encrypted header and body plus the settings, without the merge bookkeeping kept beside them.
 * Photos (only ones added before uploads stopped) are counted separately.
 */
export async function journalSize(vaultId: string): Promise<JournalSize> {
  return tx(['entries', 'blobs', 'settings'], 'readonly', async (t) => {
    const [entries, blobs, settings] = await Promise.all([
      req(t.objectStore('entries').getAll(vaultRange(vaultId))) as Promise<EntryRecord[]>,
      req(t.objectStore('blobs').getAll(vaultRange(vaultId))) as Promise<BlobRecord[]>,
      req(t.objectStore('settings').get(vaultId)) as Promise<SettingsRecord | undefined>,
    ]);
    const kept = blobs.filter((b) => b.ct);
    return {
      entries: entries.length,
      textBytes: entries.reduce((n, e) => n + sealedBytes(e.header) + sealedBytes(e.body), 0) + sealedBytes(settings?.sealed),
      photos: kept.length,
      photoBytes: kept.reduce((n, b) => n + (b.nonce?.length ?? 0) + (b.ct?.length ?? 0), 0),
    };
  });
}

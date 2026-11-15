/**
 * Reads and writes of the on-device journal (ciphertext only), plus change notifications so the
 * entry list, open editors and settings follow along when sync brings something new.
 *
 * Where the journal is kept depends on where the app runs: IndexedDB in a browser (idbRepo.ts), a
 * folder of files in the desktop app (folderRepo.ts). Both hold the same records.
 */
import { desktop } from '../desktop/bridge';
import { journalSize as idbJournalSize } from './db';
import * as folder from './folderRepo';
import * as idb from './idbRepo';

// ---- change events ---------------------------------------------------------------------------

export type LocalEvent =
  | { type: 'entries'; ids: string[]; origin: 'local' | 'sync' }
  | { type: 'entries-reset' }
  | { type: 'incoming'; id: string }
  | { type: 'settings'; origin: 'local' | 'sync' }
  | { type: 'blobs'; ids: string[] };

const listeners = new Set<(e: LocalEvent) => void>();

export function onLocalEvent(l: (e: LocalEvent) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function emitLocal(e: LocalEvent) {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch (err) {
      console.error(err);
    }
  }
}

// ---- per-entry lock ----------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/** Serialises read-modify-write of one entry (local saves, sync merges) across async crypto. */
export function withEntryLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  void tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

// ---- storage -------------------------------------------------------------------------------------

/** What both kinds of storage provide. */
type Storage = Omit<typeof idb, 'getDeviceKey' | 'saveVaultWithDeviceKey' | 'DeviceKey'> & { journalSize: typeof idbJournalSize };

const storage: Storage = desktop ? folder : { ...idb, journalSize: idbJournalSize };

export const {
  loadActiveVault,
  getVault,
  saveVault,
  updateVault,
  deleteVault,
  updateVaultDroppingDeviceKey,
  listEntries,
  getEntry,
  putEntry,
  saveLocalEntry,
  deleteLocalEntry,
  dropEntry,
  getBlob,
  putBlob,
  listBlobs,
  listBlobMeta,
  saveLocalBlob,
  deleteLocalBlob,
  dropBlob,
  getSettingsRecord,
  saveLocalSettings,
  putSettingsRecord,
  listOutbox,
  removeOutbox,
  isQueuedForDeletion,
  burnAgain,
  journalSize,
} = storage;

// A browser keeps the key of a journal without a password in IndexedDB; the desktop app keeps it
// in the computer's keychain (vault.ts).
export { type DeviceKey, getDeviceKey, saveVaultWithDeviceKey } from './idbRepo';

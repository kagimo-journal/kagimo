/**
 * The on-device journal in a browser: reads and writes of IndexedDB (ciphertext only). The app
 * reaches these through repo.ts.
 */
import type { Sealed } from '../crypto/aead';
import { resumeKeyRange } from './resume';
import {
  type BlobRecord,
  type EntryRecord,
  type OutboxRecord,
  req,
  type SettingsRecord,
  tx,
  type VaultRecord,
  vaultRange,
} from './db';

// ---- vaults -----------------------------------------------------------------------------------

const ACTIVE_KEY = 'activeVault';

export async function loadActiveVault(): Promise<VaultRecord | null> {
  return tx(['meta', 'vaults'], 'readonly', async (t) => {
    const meta = await req(t.objectStore('meta').get(ACTIVE_KEY));
    const id = (meta as { value?: string } | undefined)?.value;
    if (id) {
      const v = (await req(t.objectStore('vaults').get(id))) as VaultRecord | undefined;
      if (v) return v;
    }
    // No pointer (or a stale one): the only vault, if there is exactly one.
    const all = (await req(t.objectStore('vaults').getAll())) as VaultRecord[];
    return all.length === 1 ? all[0] : null;
  });
}

export async function getVault(id: string): Promise<VaultRecord | null> {
  return ((await tx(['vaults'], 'readonly', (t) => req(t.objectStore('vaults').get(id)))) as VaultRecord | undefined) ?? null;
}

export async function saveVault(v: VaultRecord, makeActive = false): Promise<void> {
  await tx(['vaults', 'meta'], 'readwrite', async (t) => {
    await req(t.objectStore('vaults').put(v));
    if (makeActive) await req(t.objectStore('meta').put({ key: ACTIVE_KEY, value: v.id }));
  });
}

/**
 * Read-modify-write of a vault record; returns the new record (null if it no longer exists).
 * With `settings`, that record is written in the same transaction (turning sync on changes the id
 * the settings are sealed to, and the two must never disagree).
 */
export async function updateVault(id: string, fn: (v: VaultRecord) => VaultRecord, settings?: SettingsRecord): Promise<VaultRecord | null> {
  return tx(settings ? ['vaults', 'settings'] : ['vaults'], 'readwrite', async (t) => {
    const store = t.objectStore('vaults');
    const v = (await req(store.get(id))) as VaultRecord | undefined;
    if (!v) return null;
    const next = fn(v);
    await req(store.put(next));
    if (settings) await req(t.objectStore('settings').put(settings));
    return next;
  });
}

/** Deletes a journal and everything in it from this device. */
export async function deleteVault(id: string): Promise<void> {
  await tx(['vaults', 'entries', 'blobs', 'settings', 'outbox', 'meta'], 'readwrite', async (t) => {
    await req(t.objectStore('vaults').delete(id));
    await req(t.objectStore('entries').delete(vaultRange(id)));
    await req(t.objectStore('blobs').delete(vaultRange(id)));
    await req(t.objectStore('outbox').delete(vaultRange(id)));
    await req(t.objectStore('settings').delete(id));
    const meta = (await req(t.objectStore('meta').get(ACTIVE_KEY))) as { value?: string } | undefined;
    if (meta?.value === id) await req(t.objectStore('meta').delete(ACTIVE_KEY));
    await req(t.objectStore('meta').delete(deviceKeyId(id)));
    // Every tab's reload key (resume.ts): none may outlive the journal on this device.
    await req(t.objectStore('meta').delete(resumeKeyRange()));
  });
}

// ---- device key (journals without a password) ----------------------------------------------------

/**
 * A journal without a password keeps its master key wrapped under a non-extractable AES key stored
 * here: scripts on this site can use it, but its bytes can't be read out. It goes away when a
 * password is set.
 */
export interface DeviceKey {
  cryptoKey: CryptoKey;
  nonce: string;
  ct: string;
}

const deviceKeyId = (vaultId: string) => `device:${vaultId}`;

export async function getDeviceKey(vaultId: string): Promise<DeviceKey | null> {
  const rec = (await tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').get(deviceKeyId(vaultId))))) as { value?: DeviceKey } | undefined;
  return rec?.value ?? null;
}

/** Saves a new journal without a password together with its device key, and makes it the active one. */
export async function saveVaultWithDeviceKey(v: VaultRecord, key: DeviceKey): Promise<void> {
  await tx(['vaults', 'meta'], 'readwrite', async (t) => {
    await req(t.objectStore('meta').put({ key: deviceKeyId(v.id), value: key }));
    await req(t.objectStore('vaults').put(v));
    await req(t.objectStore('meta').put({ key: ACTIVE_KEY, value: v.id }));
  });
}

/** Applies a change to a vault and deletes its device key, in one transaction (setting a password). */
export async function updateVaultDroppingDeviceKey(id: string, fn: (v: VaultRecord) => VaultRecord): Promise<VaultRecord | null> {
  return tx(['vaults', 'meta'], 'readwrite', async (t) => {
    const store = t.objectStore('vaults');
    const v = (await req(store.get(id))) as VaultRecord | undefined;
    if (!v) return null;
    const next = fn(v);
    await req(store.put(next));
    await req(t.objectStore('meta').delete(deviceKeyId(id)));
    return next;
  });
}

// ---- entries -----------------------------------------------------------------------------------

export async function listEntries(vaultId: string): Promise<EntryRecord[]> {
  return tx(['entries'], 'readonly', (t) => req(t.objectStore('entries').getAll(vaultRange(vaultId)))) as Promise<EntryRecord[]>;
}

export async function getEntry(vaultId: string, id: string): Promise<EntryRecord | null> {
  return ((await tx(['entries'], 'readonly', (t) => req(t.objectStore('entries').get([vaultId, id])))) as EntryRecord | undefined) ?? null;
}

export async function putEntry(rec: EntryRecord): Promise<void> {
  await tx(['entries'], 'readwrite', (t) => req(t.objectStore('entries').put(rec)));
}

/** Saves this device's edit of an entry (creating it), marking it for the next push. */
export async function saveLocalEntry(vaultId: string, id: string, header: Sealed, body: Sealed, now = new Date().toISOString()): Promise<EntryRecord> {
  return tx(['entries'], 'readwrite', async (t) => {
    const store = t.objectStore('entries');
    const cur = (await req(store.get([vaultId, id]))) as EntryRecord | undefined;
    const rec: EntryRecord = cur
      ? { ...cur, header, body, updatedAt: now, dirty: true, rev: cur.rev + 1 }
      : { vaultId, id, header, body, createdAt: now, updatedAt: now, version: 0, base: null, dirty: true, rev: 1, incoming: null, conflict: null };
    await req(store.put(rec));
    return rec;
  });
}

/**
 * Burns an entry on this device: the record and its images go now; if the server has a copy, its
 * deletion is queued (the server deletes the entry's images with it).
 */
export async function deleteLocalEntry(vaultId: string, id: string): Promise<void> {
  await tx(['entries', 'blobs', 'outbox'], 'readwrite', async (t) => {
    const cur = (await req(t.objectStore('entries').get([vaultId, id]))) as EntryRecord | undefined;
    await req(t.objectStore('entries').delete([vaultId, id]));
    const blobs = (await req(t.objectStore('blobs').index('byEntry').getAll([vaultId, id]))) as BlobRecord[];
    for (const b of blobs) {
      await req(t.objectStore('blobs').delete([vaultId, b.id]));
      // The server deletes an entry's blobs with the entry; a blob of an entry that never reached
      // it must be deleted on its own.
      if (b.synced && !cur?.version) await req(t.objectStore('outbox').put({ vaultId, kind: 'blob', id: b.id } satisfies OutboxRecord));
    }
    if (cur && cur.version > 0) await req(t.objectStore('outbox').put({ vaultId, kind: 'entry', id } satisfies OutboxRecord));
  });
}

/** Removes an entry and its images locally without queuing anything (deleted on the server). */
export async function dropEntry(vaultId: string, id: string): Promise<void> {
  await tx(['entries', 'blobs'], 'readwrite', async (t) => {
    await req(t.objectStore('entries').delete([vaultId, id]));
    const keys = await req(t.objectStore('blobs').index('byEntry').getAllKeys([vaultId, id]));
    for (const k of keys) await req(t.objectStore('blobs').delete(k));
  });
}

// ---- blobs -------------------------------------------------------------------------------------

export async function getBlob(vaultId: string, id: string): Promise<BlobRecord | null> {
  return ((await tx(['blobs'], 'readonly', (t) => req(t.objectStore('blobs').get([vaultId, id])))) as BlobRecord | undefined) ?? null;
}

export async function putBlob(rec: BlobRecord): Promise<void> {
  await tx(['blobs'], 'readwrite', (t) => req(t.objectStore('blobs').put(rec)));
}

export async function listBlobs(vaultId: string): Promise<BlobRecord[]> {
  return tx(['blobs'], 'readonly', (t) => req(t.objectStore('blobs').getAll(vaultRange(vaultId)))) as Promise<BlobRecord[]>;
}

/** Blob ids and state without the bytes (for sync bookkeeping). */
export async function listBlobMeta(vaultId: string): Promise<Omit<BlobRecord, 'ct' | 'nonce'>[]> {
  const out: Omit<BlobRecord, 'ct' | 'nonce'>[] = [];
  await tx(['blobs'], 'readonly', (t) => {
    return new Promise<void>((resolve, reject) => {
      const cur = t.objectStore('blobs').openCursor(vaultRange(vaultId));
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const { ct, nonce, ...rest } = c.value as BlobRecord;
        void ct;
        void nonce;
        out.push({ ...rest, size: rest.size });
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
  });
  return out;
}

/** Stores a new image of this device's (ciphertext), to be uploaded by the next push. */
export async function saveLocalBlob(vaultId: string, id: string, entryId: string, nonce: Uint8Array, ct: Uint8Array): Promise<void> {
  await tx(['blobs'], 'readwrite', async (t) => {
    const store = t.objectStore('blobs');
    if (await req(store.get([vaultId, id]))) return; // already stored (a retried save)
    await req(store.put({ vaultId, id, entryId, nonce, ct, size: ct.length, synced: false } satisfies BlobRecord));
  });
}

/** Deletes an image on this device, queuing its deletion on the server if it got there. */
export async function deleteLocalBlob(vaultId: string, id: string): Promise<void> {
  await tx(['blobs', 'outbox'], 'readwrite', async (t) => {
    const cur = (await req(t.objectStore('blobs').get([vaultId, id]))) as BlobRecord | undefined;
    await req(t.objectStore('blobs').delete([vaultId, id]));
    if (cur?.synced) await req(t.objectStore('outbox').put({ vaultId, kind: 'blob', id } satisfies OutboxRecord));
  });
}

export async function dropBlob(vaultId: string, id: string): Promise<void> {
  await tx(['blobs'], 'readwrite', (t) => req(t.objectStore('blobs').delete([vaultId, id])));
}

// ---- settings ----------------------------------------------------------------------------------

export async function getSettingsRecord(vaultId: string): Promise<SettingsRecord | null> {
  return ((await tx(['settings'], 'readonly', (t) => req(t.objectStore('settings').get(vaultId)))) as SettingsRecord | undefined) ?? null;
}

export async function saveLocalSettings(vaultId: string, sealed: Sealed): Promise<void> {
  await tx(['settings'], 'readwrite', async (t) => {
    const store = t.objectStore('settings');
    const cur = (await req(store.get(vaultId))) as SettingsRecord | undefined;
    await req(store.put({ vaultId, sealed, dirty: true, rev: (cur?.rev ?? 0) + 1 } satisfies SettingsRecord));
  });
}

export async function putSettingsRecord(rec: SettingsRecord): Promise<void> {
  await tx(['settings'], 'readwrite', (t) => req(t.objectStore('settings').put(rec)));
}

// ---- outbox ------------------------------------------------------------------------------------

/** Deletions waiting to be sent. */
export async function listOutbox(vaultId: string): Promise<OutboxRecord[]> {
  const all = (await tx(['outbox'], 'readonly', (t) => req(t.objectStore('outbox').getAll(vaultRange(vaultId))))) as OutboxRecord[];
  return all.filter((o) => !o.sent);
}

/**
 * The server has taken the deletion. A burned entry's record stays as a marker, so the entry
 * can't come back if the server ever serves it again (burnAgain); an image's is dropped.
 */
export async function removeOutbox(r: OutboxRecord): Promise<void> {
  await tx(['outbox'], 'readwrite', (t) => {
    const store = t.objectStore('outbox');
    return r.kind === 'entry'
      ? req(store.put({ vaultId: r.vaultId, kind: r.kind, id: r.id, sent: new Date().toISOString() } satisfies OutboxRecord))
      : req(store.delete([r.vaultId, r.kind, r.id]));
  });
}

/** True for anything deleted here: waiting to be sent, or (entries) burned and already sent. */
export async function isQueuedForDeletion(vaultId: string, kind: 'entry' | 'blob', id: string): Promise<boolean> {
  return !!(await tx(['outbox'], 'readonly', (t) => req(t.objectStore('outbox').get([vaultId, kind, id]))));
}

/** A burned entry turned up on the server again: queue its deletion once more. */
export async function burnAgain(vaultId: string, id: string): Promise<void> {
  await tx(['outbox'], 'readwrite', async (t) => {
    const store = t.objectStore('outbox');
    const cur = (await req(store.get([vaultId, 'entry', id]))) as OutboxRecord | undefined;
    if (cur?.sent) await req(store.put({ vaultId, kind: 'entry', id } satisfies OutboxRecord));
  });
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, FolderCollection, FolderDoc } from '../desktop/bridge';
import type { VaultRecord } from './db';

/** A journal folder in memory, as desktop/src/store.ts keeps one on disk. */
const disk = {
  docs: new Map<FolderDoc, unknown>(),
  items: { entries: new Map<string, unknown>(), blobs: new Map<string, unknown>() } as Record<FolderCollection, Map<string, unknown>>,
  bytes: new Map<string, Uint8Array>(),
  keys: new Map<string, Uint8Array>(),
  folder: { path: '/journal', available: true } as { path: string; available: boolean } | null,
  /** Every write, in order. */
  log: [] as string[],
  lists: 0,
};
const copy = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v)) as T));

vi.mock('../desktop/bridge', () => {
  const files: DesktopBridge['files'] = {
    readDoc: async (n) => copy(disk.docs.get(n) ?? null),
    writeDoc: async (n, v) => {
      disk.log.push(`${v === null ? 'delete' : 'write'} ${n}`);
      if (v === null) disk.docs.delete(n);
      else disk.docs.set(n, copy(v));
    },
    list: async (c) => {
      disk.lists++;
      return [...disk.items[c].values()].map(copy);
    },
    read: async (c, id) => copy(disk.items[c].get(id) ?? null),
    write: async (c, id, v) => {
      disk.log.push(`${v === null ? 'delete' : 'write'} ${c}/${id}`);
      if (v === null) disk.items[c].delete(id);
      else disk.items[c].set(id, copy(v));
    },
    readBytes: async (id) => disk.bytes.get(id) ?? null,
    writeBytes: async (id, b) => {
      disk.log.push(`${b === null ? 'delete' : 'write'} bytes/${id}`);
      if (b === null) disk.bytes.delete(id);
      else disk.bytes.set(id, b);
    },
    wipe: async () => {
      disk.log.push('wipe');
      disk.docs.clear();
      disk.items.entries.clear();
      disk.items.blobs.clear();
      disk.bytes.clear();
    },
  };
  const desktop = {
    files,
    folder: { current: async () => disk.folder },
    keys: {
      save: async (id: string, mk: Uint8Array) => void disk.keys.set(id, mk),
      load: async (id: string) => disk.keys.get(id) ?? null,
      delete: async (id: string) => void disk.keys.delete(id),
    },
  } as unknown as DesktopBridge;
  return { desktop };
});

const repo = await import('./folderRepo');

const sealed = (s: string) => ({ nonce: 'AAAAAAAAAAAAAAAA', ct: btoa(s) });
const vault = (id: string): VaultRecord => ({
  id,
  name: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  kdf: { alg: 'argon2id', m: 1, t: 1, p: 1, salt: '' } as unknown as VaultRecord['kdf'],
  wrappedMkPass: null,
  wrappedMkRecovery: null,
  recoveryAuth: null,
  passkeyWraps: [],
  aadId: id,
  account: null,
  sync: { cursor: 0, lastSyncAt: null, full: false },
  exportedAt: null,
});

const V = 'vault-1';
const E1 = '3f2b6c1e-9d4a-4e8b-a1c7-5b0e2f9d8a61';
const E2 = '7a1d0c55-2b3e-4f60-9c8d-1e2f3a4b5c6d';
const B1 = '0c9f8e7d-6b5a-4c3d-8e2f-1a0b9c8d7e6f';

beforeEach(async () => {
  disk.docs.clear();
  disk.items.entries.clear();
  disk.items.blobs.clear();
  disk.bytes.clear();
  disk.keys.clear();
  disk.folder = { path: '/journal', available: true };
  disk.log.length = 0;
  disk.lists = 0;
  await repo.loadActiveVault(); // forget what the last test read
});

describe('the journal in a folder', () => {
  it('has no journal until one is saved, then loads it back', async () => {
    expect(await repo.loadActiveVault()).toBeNull();
    await repo.saveVault(vault(V), true);
    expect(disk.docs.get('vault')).toMatchObject({ format: 'kagimo-journal', version: 1, vault: { id: V } });
    expect((await repo.loadActiveVault())?.id).toBe(V);
    expect((await repo.getVault(V))?.id).toBe(V);
    expect(await repo.getVault('other')).toBeNull();
  });

  it('has no journal when no folder is chosen, and says when the folder is out of reach', async () => {
    await repo.saveVault(vault(V), true);
    disk.folder = null;
    expect(await repo.loadActiveVault()).toBeNull();
    disk.folder = { path: '/media/usb/journal', available: false };
    await expect(repo.loadActiveVault()).rejects.toThrow('/media/usb/journal');
  });

  it('refuses a file that is not a journal, or is from a newer version', async () => {
    disk.docs.set('vault', { some: 'json' });
    await expect(repo.loadActiveVault()).rejects.toThrow('isn’t a Kagimo journal');
    disk.docs.set('vault', { format: 'kagimo-journal', version: 2, vault: vault(V) });
    await expect(repo.loadActiveVault()).rejects.toThrow('newer version');
  });

  it('holds one journal: another cannot be saved over it', async () => {
    await repo.saveVault(vault(V), true);
    await expect(repo.saveVault(vault('vault-2'), true)).rejects.toThrow('another journal');
    expect((await repo.loadActiveVault())?.id).toBe(V);
  });

  it('updates the vault record, with settings when given', async () => {
    await repo.saveVault(vault(V), true);
    const next = await repo.updateVault(V, (v) => ({ ...v, name: 'Ada' }), { vaultId: V, sealed: sealed('s'), dirty: true, rev: 3 });
    expect(next?.name).toBe('Ada');
    expect(await repo.getSettingsRecord(V)).toEqual({ vaultId: V, sealed: sealed('s'), dirty: true, rev: 3 });
    expect(await repo.updateVault('other', (v) => v)).toBeNull();
  });

  it('setting a password drops the key kept on the computer', async () => {
    await repo.saveVault(vault(V), true);
    disk.keys.set(V, new Uint8Array(32));
    await repo.updateVaultDroppingDeviceKey(V, (v) => ({ ...v, wrappedMkPass: sealed('mk') }));
    expect(disk.keys.has(V)).toBe(false);
    expect((await repo.loadActiveVault())?.wrappedMkPass).toEqual(sealed('mk'));
  });

  it('saves entries as local changes and reads them back', async () => {
    await repo.saveVault(vault(V), true);
    const a = await repo.saveLocalEntry(V, E1, sealed('h1'), sealed('b1'), '2026-02-01T10:00:00.000Z');
    expect(a).toMatchObject({ vaultId: V, id: E1, version: 0, dirty: true, rev: 1, createdAt: '2026-02-01T10:00:00.000Z' });
    const b = await repo.saveLocalEntry(V, E1, sealed('h2'), sealed('b2'), '2026-02-01T11:00:00.000Z');
    expect(b).toMatchObject({ rev: 2, createdAt: '2026-02-01T10:00:00.000Z', updatedAt: '2026-02-01T11:00:00.000Z', header: sealed('h2') });
    expect(disk.items.entries.get(E1)).not.toHaveProperty('vaultId');
    await repo.loadActiveVault(); // as after a restart
    expect(await repo.getEntry(V, E1)).toEqual(b);
    expect(await repo.listEntries(V)).toEqual([b]);
    expect(await repo.getEntry(V, E2)).toBeNull();
  });

  it('reads the entries from the folder once', async () => {
    await repo.saveVault(vault(V), true);
    await repo.saveLocalEntry(V, E1, sealed('h'), sealed('b'));
    await repo.listEntries(V);
    await repo.getEntry(V, E1);
    await repo.listEntries(V);
    expect(disk.lists).toBe(1);
  });

  it('fills in what an entry file leaves out, and skips files that are not entries', async () => {
    await repo.saveVault(vault(V), true);
    disk.items.entries.set(E1, { id: E1, header: sealed('h'), body: sealed('b'), createdAt: '2026-02-01T10:00:00.000Z' });
    disk.items.entries.set(E2, { something: 'else' });
    expect(await repo.listEntries(V)).toEqual([
      { vaultId: V, id: E1, header: sealed('h'), body: sealed('b'), createdAt: '2026-02-01T10:00:00.000Z', updatedAt: '2026-02-01T10:00:00.000Z', version: 0, base: null, dirty: false, rev: 0, incoming: null, conflict: null },
    ]);
  });

  it('burning an entry the server has queues its deletion before the file goes', async () => {
    await repo.saveVault(vault(V), true);
    const rec = await repo.saveLocalEntry(V, E1, sealed('h'), sealed('b'));
    await repo.putEntry({ ...rec, version: 4, dirty: false });
    await repo.putBlob({ vaultId: V, id: B1, entryId: E1, nonce: new Uint8Array(12), ct: new Uint8Array(5), size: 5, synced: true });
    disk.log.length = 0;
    await repo.deleteLocalEntry(V, E1);
    expect(disk.log).toEqual(['write outbox', `delete blobs/${B1}`, `delete bytes/${B1}`, `delete entries/${E1}`]);
    // The server deletes an entry's photos with it: only the entry is queued.
    expect(await repo.listOutbox(V)).toEqual([{ vaultId: V, kind: 'entry', id: E1 }]);
    expect(await repo.getEntry(V, E1)).toBeNull();
    expect(await repo.getBlob(V, B1)).toBeNull();
  });

  it('burning an entry the server never had queues only its uploaded photos', async () => {
    await repo.saveVault(vault(V), true);
    await repo.saveLocalEntry(V, E1, sealed('h'), sealed('b'));
    await repo.putBlob({ vaultId: V, id: B1, entryId: E1, nonce: new Uint8Array(12), ct: new Uint8Array(5), size: 5, synced: true });
    await repo.saveLocalBlob(V, E2, E1, new Uint8Array(12), new Uint8Array(7));
    await repo.deleteLocalEntry(V, E1);
    expect(await repo.listOutbox(V)).toEqual([{ vaultId: V, kind: 'blob', id: B1 }]);
    expect(await repo.listBlobMeta(V)).toEqual([]);
  });

  it('keeps a burned entry marked once the server took the deletion, and can queue it again', async () => {
    await repo.saveVault(vault(V), true);
    const rec = await repo.saveLocalEntry(V, E1, sealed('h'), sealed('b'));
    await repo.putEntry({ ...rec, version: 1, dirty: false });
    await repo.deleteLocalEntry(V, E1);
    const [queued] = await repo.listOutbox(V);
    await repo.removeOutbox(queued);
    expect(await repo.listOutbox(V)).toEqual([]);
    expect(await repo.isQueuedForDeletion(V, 'entry', E1)).toBe(true);
    await repo.burnAgain(V, E1);
    expect(await repo.listOutbox(V)).toEqual([{ vaultId: V, kind: 'entry', id: E1 }]);
    // A photo's record just goes.
    await repo.putBlob({ vaultId: V, id: B1, entryId: E2, nonce: null, ct: null, size: 9, synced: true });
    await repo.deleteLocalBlob(V, B1);
    await repo.removeOutbox({ vaultId: V, kind: 'blob', id: B1 });
    expect(await repo.isQueuedForDeletion(V, 'blob', B1)).toBe(false);
  });

  it('keeps photos as a record plus bytes, downloaded or not', async () => {
    await repo.saveVault(vault(V), true);
    const nonce = new Uint8Array(12).fill(7);
    const ct = new Uint8Array([9, 8, 7]);
    await repo.saveLocalBlob(V, B1, E1, nonce, ct);
    await repo.saveLocalBlob(V, B1, E1, nonce, new Uint8Array([0])); // a retried save changes nothing
    expect(await repo.getBlob(V, B1)).toEqual({ vaultId: V, id: B1, entryId: E1, nonce, ct, size: 3, synced: false });
    await repo.putBlob({ vaultId: V, id: E2, entryId: E1, nonce: null, ct: null, size: 40, synced: true });
    expect(await repo.getBlob(V, E2)).toEqual({ vaultId: V, id: E2, entryId: E1, nonce: null, ct: null, size: 40, synced: true });
    expect((await repo.listBlobMeta(V)).map((b) => b.id).sort()).toEqual([B1, E2].sort());
    expect((await repo.listBlobs(V)).find((b) => b.id === B1)?.ct).toEqual(ct);
    await repo.dropEntry(V, E1);
    expect(await repo.listBlobMeta(V)).toEqual([]);
    expect(disk.bytes.size).toBe(0);
  });

  it('counts settings saves and measures the journal', async () => {
    await repo.saveVault(vault(V), true);
    expect(await repo.getSettingsRecord(V)).toBeNull();
    await repo.saveLocalSettings(V, sealed('one'));
    await repo.saveLocalSettings(V, sealed('two'));
    expect(await repo.getSettingsRecord(V)).toEqual({ vaultId: V, sealed: sealed('two'), dirty: true, rev: 2 });
    await repo.putSettingsRecord({ vaultId: V, sealed: sealed('two'), dirty: false, rev: 2 });
    expect((await repo.getSettingsRecord(V))?.dirty).toBe(false);
    await repo.saveLocalEntry(V, E1, sealed('head'), sealed('body'));
    await repo.saveLocalBlob(V, B1, E1, new Uint8Array(12), new Uint8Array(100));
    // 12-byte nonces; ciphertexts of 4, 4 and 3 bytes.
    expect(await repo.journalSize(V)).toEqual({ entries: 1, textBytes: 12 + 4 + 12 + 4 + 12 + 3, photos: 1, photoBytes: 112 });
  });

  it('deleting the journal wipes its files and its key, and leaves the folder chosen', async () => {
    await repo.saveVault(vault(V), true);
    await repo.saveLocalEntry(V, E1, sealed('h'), sealed('b'));
    disk.keys.set(V, new Uint8Array(32));
    await repo.deleteVault('some-other-journal');
    expect(await repo.listEntries(V)).toHaveLength(1);
    await repo.deleteVault(V);
    expect(disk.docs.size + disk.items.entries.size).toBe(0);
    expect(disk.keys.has(V)).toBe(false);
    expect(await repo.loadActiveVault()).toBeNull();
    await repo.saveVault(vault('vault-2'), true); // the folder can take a new journal
    expect(await repo.listEntries('vault-2')).toEqual([]);
  });

  it('work left over for a journal that is no longer open reads nothing and writes nothing', async () => {
    await repo.saveVault(vault(V), true);
    await repo.saveLocalEntry(V, E1, sealed('h'), sealed('b'));
    disk.log.length = 0;
    const stale = 'journal-in-the-last-folder';
    expect(await repo.listEntries(stale)).toEqual([]);
    expect(await repo.getEntry(stale, E1)).toBeNull();
    expect(await repo.getSettingsRecord(stale)).toBeNull();
    expect(await repo.listOutbox(stale)).toEqual([]);
    await expect(repo.saveLocalEntry(stale, E2, sealed('h'), sealed('b'))).rejects.toThrow('no longer open');
    await expect(repo.deleteLocalEntry(stale, E1)).rejects.toThrow('no longer open');
    await expect(repo.saveLocalSettings(stale, sealed('s'))).rejects.toThrow('no longer open');
    expect(disk.log).toEqual([]);
  });

  it('runs operations one at a time, in the order they were asked for', async () => {
    await repo.saveVault(vault(V), true);
    const saves = [1, 2, 3, 4, 5].map((n) => repo.saveLocalEntry(V, E1, sealed(`h${n}`), sealed('b')));
    const revs = (await Promise.all(saves)).map((r) => r.rev);
    expect(revs).toEqual([1, 2, 3, 4, 5]);
    expect((await repo.getEntry(V, E1))?.header).toEqual(sealed('h5'));
  });
});

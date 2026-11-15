import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { type BlobRecord, type EntryRecord, journalSize, req, tx } from './db';

// A 12-byte nonce and `ctBytes` of ciphertext, as base64.
const sealed = (ctBytes: number) => ({ nonce: btoa('x'.repeat(12)), ct: btoa('y'.repeat(ctBytes)) });

const entry = (vaultId: string, id: string, ct: number): EntryRecord => ({
  vaultId, id, header: sealed(ct), body: sealed(ct), createdAt: '', updatedAt: '', version: 1,
  // The merge base is bookkeeping, not content: it must not be counted.
  base: { header: sealed(500), body: sealed(500) },
  dirty: false, rev: 1, incoming: null, conflict: null,
});

describe('journalSize', () => {
  it('counts each entry’s current ciphertext and the settings, like the server, and photos apart', async () => {
    await tx(['entries', 'blobs', 'settings'], 'readwrite', async (t) => {
      await req(t.objectStore('entries').put(entry('v1', 'a', 100)));
      await req(t.objectStore('entries').put(entry('v1', 'b', 101)));
      await req(t.objectStore('entries').put(entry('other', 'c', 999)));
      await req(t.objectStore('settings').put({ vaultId: 'v1', sealed: sealed(50), dirty: false, rev: 1 }));
      const blob = (id: string, ct: Uint8Array | null): BlobRecord => ({ vaultId: 'v1', id, entryId: 'a', nonce: new Uint8Array(12), ct, size: 0, synced: true });
      await req(t.objectStore('blobs').put(blob('p1', new Uint8Array(1000))));
      await req(t.objectStore('blobs').put(blob('p2', null))); // not downloaded
    });
    expect(await journalSize('v1')).toEqual({
      entries: 2,
      textBytes: 2 * (12 + 100) + 2 * (12 + 101) + (12 + 50),
      photos: 1,
      photoBytes: 12 + 1000,
    });
  });
});

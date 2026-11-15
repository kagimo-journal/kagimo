import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/react';
import { ApiError } from '../api/client';
import type { Sealed } from '../crypto/aead';
import type { EntryHeader } from '../editor/types';

// ---- an in-memory server with the semantics of SPEC §5 / §5.2 ----------------------------------------

interface SrvEntry {
  id: string;
  version: number;
  header: Sealed;
  body: Sealed;
  seq: number;
  createdAt: string;
  updatedAt: string;
}
const srv = vi.hoisted(() => ({
  seq: 0,
  entries: new Map<string, SrvEntry>(),
  blobs: new Map<string, { entryId: string; nonce: Uint8Array; ct: Uint8Array; seq: number }>(),
  tombs: new Map<string, { kind: 'entry' | 'blob'; seq: number }>(),
  settings: null as null | { sealed: Sealed; seq: number },
  /** Free space used up: new entries and images are refused with 402 storage_full (SPEC §5.6). */
  full: false,
}));

function conflict(code: string, status = 409) {
  return new ApiError(status, code, code);
}

vi.mock('../api/endpoints', () => {
  const now = () => new Date().toISOString();
  return {
    entries: {
      create: vi.fn(async (id: string, header: Sealed, body: Sealed) => {
        if (srv.entries.has(id)) throw conflict('entry_exists');
        if (srv.full) throw conflict('storage_full', 402);
        const e = { id, version: 1, header, body, seq: ++srv.seq, createdAt: now(), updatedAt: now() };
        srv.entries.set(id, e);
        srv.tombs.delete(`entry:${id}`);
        return { id, version: 1, createdAt: e.createdAt, updatedAt: e.updatedAt, seq: e.seq };
      }),
      update: vi.fn(async (id: string, header: Sealed, body: Sealed, baseVersion: number) => {
        const e = srv.entries.get(id);
        if (!e) throw new ApiError(404, 'not_found', 'nf');
        if (e.version !== baseVersion) throw conflict('version_conflict');
        Object.assign(e, { header, body, version: e.version + 1, seq: ++srv.seq, updatedAt: now() });
        return { version: e.version, updatedAt: e.updatedAt, seq: e.seq };
      }),
      get: vi.fn(async (id: string) => {
        const e = srv.entries.get(id);
        if (!e) throw new ApiError(404, 'not_found', 'nf');
        return { ...e };
      }),
      remove: vi.fn(async (id: string) => {
        if (!srv.entries.delete(id)) throw new ApiError(404, 'not_found', 'nf');
        for (const [bid, b] of srv.blobs) if (b.entryId === id) srv.blobs.delete(bid);
        srv.tombs.set(`entry:${id}`, { kind: 'entry', seq: ++srv.seq });
        return { seq: srv.seq };
      }),
    },
    blobs: {
      upload: vi.fn(async (id: string, entryId: string, nonce: Uint8Array, ct: Uint8Array) => {
        if (srv.blobs.has(id)) throw conflict('blob_exists');
        if (srv.full) throw conflict('storage_full', 402);
        srv.blobs.set(id, { entryId, nonce, ct, seq: ++srv.seq });
        return { id, size: ct.length };
      }),
      get: vi.fn(async (id: string) => {
        const b = srv.blobs.get(id);
        if (!b) throw new ApiError(404, 'not_found', 'nf');
        return { nonce: b.nonce, ct: b.ct };
      }),
      remove: vi.fn(async (id: string) => {
        if (!srv.blobs.delete(id)) throw new ApiError(404, 'not_found', 'nf');
        srv.tombs.set(`blob:${id}`, { kind: 'blob', seq: ++srv.seq });
        return { seq: srv.seq };
      }),
    },
    settings: {
      put: vi.fn(async (sealed: Sealed) => {
        srv.settings = { sealed, seq: ++srv.seq };
        return { seq: srv.seq };
      }),
      get: vi.fn(async () => srv.settings?.sealed ?? null),
    },
    syncChanges: vi.fn(async (since: number) => {
      // A cursor ahead of the feed: the database was restored from a backup.
      if (since > srv.seq) throw new ApiError(410, 'cursor_expired', 'cursor_expired');
      const entries = [...srv.entries.values()].filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
      return {
        cursor: srv.seq,
        more: false,
        entries: entries.map(({ seq, ...e }) => (void seq, e)),
        blobs: [...srv.blobs.entries()].filter(([, b]) => b.seq > since).map(([id, b]) => ({ id, entryId: b.entryId, size: b.ct.length })),
        deleted: {
          entries: since ? [...srv.tombs.entries()].filter(([, t]) => t.kind === 'entry' && t.seq > since).map(([k]) => k.slice(6)) : [],
          blobs: since ? [...srv.tombs.entries()].filter(([, t]) => t.kind === 'blob' && t.seq > since).map(([k]) => k.slice(5)) : [],
        },
        settings: srv.settings && srv.settings.seq > since ? srv.settings.sealed : null,
      };
    }),
  };
});

const { paywall } = await import('../billing/paywallState');
const session = await import('../crypto/session');
const repo = await import('../local/repo');
const vault = await import('../local/vault');
const { closeDb, DB_NAME } = await import('../local/db');
const engine = await import('./engine');
const api = await import('../api/endpoints');
const integrate = await import('./integrate');

// ---- helpers ---------------------------------------------------------------------------------------------------

const VAULT = 'device-a';
const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...t: string[]): JSONContent => ({ type: 'doc', content: t.map(p) });
const header = (title: string): EntryHeader => ({
  v: 1, title, snippet: '', createdAt: '2026-11-11T21:40:00+00:00', tz: 'Europe/London', location: null, wordCount: 0, imageCount: 0,
});
const texts = (d: JSONContent) => (d.content ?? []).map((b) => b.content?.[0]?.text);

async function writeLocal(id: string, title: string, ...paras: string[]) {
  const sealed = await integrate.encryptCopy(id, { header: header(title), doc: doc(...paras) });
  await repo.saveLocalEntry(VAULT, id, sealed.header, sealed.body);
}

/** Another device saving through the server. */
async function writeRemote(id: string, title: string, ...paras: string[]) {
  const sealed = await integrate.encryptCopy(id, { header: header(title), doc: doc(...paras) });
  const cur = srv.entries.get(id);
  const now = new Date(Date.now() + 1000).toISOString();
  if (cur) Object.assign(cur, { ...sealed, version: cur.version + 1, seq: ++srv.seq, updatedAt: now });
  else srv.entries.set(id, { id, ...sealed, version: 1, seq: ++srv.seq, createdAt: now, updatedAt: now });
}

async function local(id: string) {
  const r = await repo.getEntry(VAULT, id);
  return r ? { rec: r, plain: await integrate.decryptCopy(id, r) } : null;
}

async function remote(id: string) {
  const e = srv.entries.get(id);
  return e ? integrate.decryptCopy(id, e) : null;
}

beforeEach(async () => {
  srv.seq = 0;
  srv.entries.clear();
  srv.blobs.clear();
  srv.tombs.clear();
  srv.settings = null;
  srv.full = false;
  session.lockNow();
  await closeDb();
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = () => resolve();
  });
  await repo.saveVault(
    {
      id: VAULT, name: 'Test', createdAt: '', kdf: { salt: '', m: 65536, t: 3, p: 1 }, wrappedMkPass: { nonce: '', ct: '' },
      wrappedMkRecovery: null, recoveryAuth: null, passkeyWraps: [], aadId: 'user-1',
      account: { userId: 'user-1', username: 'alice', status: 'active', isAdmin: false, hasSecondFactor: true },
      sync: { cursor: 0, lastSyncAt: null, full: false }, exportedAt: null,
    },
    true,
  );
  await vault.initVault();
  await session.unlock(VAULT, new Uint8Array(32).fill(7));
  await engine.syncNow();
});

// ---- tests ------------------------------------------------------------------------------------------------------

describe('sync engine: requests', () => {
  it('an idle sync asks the feed once', async () => {
    vi.mocked(api.syncChanges).mockClear();
    await engine.syncNow();
    expect(api.syncChanges).toHaveBeenCalledTimes(1);
  });

  it("steps the cursor past its own writes instead of downloading them again", async () => {
    await writeLocal('e1', 'Hello', 'first');
    await writeLocal('e2', 'Again', 'second');
    vi.mocked(api.syncChanges).mockClear();
    await engine.syncNow();
    expect(api.syncChanges).toHaveBeenCalledTimes(1); // the pull before pushing, none after
    expect(vault.currentVault()?.sync.cursor).toBe(srv.seq);
    const next = await vi.mocked(api.syncChanges)(srv.seq);
    expect(next.entries).toEqual([]);
  });

  it('pulls again when another device wrote during the push', async () => {
    await writeLocal('e1', 'Mine', 'a');
    const create = vi.mocked(api.entries.create);
    const real = create.getMockImplementation()!;
    create.mockImplementationOnce(async (...args) => {
      await writeRemote('e2', 'Theirs', 'b'); // takes a seq first: a gap in ours
      return real(...args);
    });
    vi.mocked(api.syncChanges).mockClear();
    await engine.syncNow();
    expect(api.syncChanges).toHaveBeenCalledTimes(2);
    expect((await local('e2'))?.plain.header.title).toBe('Theirs');
    expect(vault.currentVault()?.sync.cursor).toBe(srv.seq);
  });

  it('pulls again when the server sends no seq (older server)', async () => {
    await writeLocal('e1', 'Mine', 'a');
    const create = vi.mocked(api.entries.create);
    const real = create.getMockImplementation()!;
    create.mockImplementationOnce(async (...args) => ({ ...(await real(...args)), seq: undefined }));
    vi.mocked(api.syncChanges).mockClear();
    await engine.syncNow();
    expect(api.syncChanges).toHaveBeenCalledTimes(2);
    expect((await local('e1'))?.rec.dirty).toBe(false);
  });
});

describe('sync engine', () => {
  it('pushes a new local entry and marks it clean', async () => {
    await writeLocal('e1', 'Hello', 'first');
    await engine.syncNow();
    expect((await remote('e1'))?.header.title).toBe('Hello');
    const l = await local('e1');
    expect(l?.rec).toMatchObject({ version: 1, dirty: false });
    expect(engine.syncStatus.get().phase).toBe('idle');
  });

  it('takes in a remote edit of an untouched entry', async () => {
    await writeRemote('e1', 'From phone', 'a');
    await engine.syncNow();
    expect((await local('e1'))?.plain.header.title).toBe('From phone');
    await writeRemote('e1', 'Edited on phone', 'a', 'b');
    await engine.syncNow();
    const l = await local('e1');
    expect(l?.rec.version).toBe(2);
    expect(texts(l!.plain.doc)).toEqual(['a', 'b']);
  });

  it('merges edits to different paragraphs made on two devices', async () => {
    await writeRemote('e1', 'Day', 'one', 'two', 'three');
    await engine.syncNow();
    await writeLocal('e1', 'Day', 'ONE', 'two', 'three');
    await writeRemote('e1', 'Day', 'one', 'two', 'THREE');
    await engine.syncNow();
    expect(texts((await remote('e1'))!.doc)).toEqual(['ONE', 'two', 'THREE']);
    const l = await local('e1');
    expect(l?.rec).toMatchObject({ dirty: false, conflict: null, version: 3 });
    expect(texts(l!.plain.doc)).toEqual(['ONE', 'two', 'THREE']);
  });

  it('keeps a conflict for the same paragraph and pushes the resolution', async () => {
    await writeRemote('e1', 'Day', 'one', 'two');
    await engine.syncNow();
    await writeLocal('e1', 'Day', 'one', 'mine');
    await writeRemote('e1', 'Day', 'one', 'theirs');
    await engine.syncNow();
    let l = await local('e1');
    expect(l?.rec.conflict?.kind).toBe('edit');
    expect(texts((await remote('e1'))!.doc)).toEqual(['one', 'theirs']); // nothing pushed meanwhile
    expect(engine.syncStatus.get().conflicts).toBe(1);

    await integrate.resolveConflict(VAULT, 'e1', { header: header('Day'), doc: doc('one', 'mine', 'theirs') });
    await engine.syncNow();
    expect(texts((await remote('e1'))!.doc)).toEqual(['one', 'mine', 'theirs']);
    l = await local('e1');
    expect(l?.rec).toMatchObject({ conflict: null, dirty: false });
  });

  it('merges after a 409 on push', async () => {
    await writeRemote('e1', 'Day', 'one', 'two');
    await engine.syncNow();
    await writeLocal('e1', 'Day', 'ONE', 'two');
    // The other device saves between our pull and push: the server answers 409.
    const sync = (await import('../api/endpoints')).syncChanges as unknown as ReturnType<typeof vi.fn>;
    const original = sync.getMockImplementation()!;
    sync.mockImplementationOnce(async (since: number) => {
      const page = await original(since);
      await writeRemote('e1', 'Day', 'one', 'TWO');
      return page;
    });
    await engine.syncNow();
    expect(texts((await remote('e1'))!.doc)).toEqual(['ONE', 'TWO']);
  });

  it('keeps entries the server lost in a rollback and sends them again (security review 2026-11-14)', async () => {
    await writeRemote('old', 'In the backup', 'a');
    await engine.syncNow();
    const backup = { seq: srv.seq, entries: new Map([...srv.entries].map(([k, e]) => [k, { ...e }])) };
    await writeLocal('new', 'Written since', 'only copy');
    await engine.syncNow();
    expect((await local('new'))?.rec).toMatchObject({ version: 1, dirty: false });

    // The operator restores the backup: the entry written since is gone from the server.
    srv.seq = backup.seq;
    srv.entries.clear();
    for (const [k, e] of backup.entries) srv.entries.set(k, e);
    await engine.syncNow();

    expect(texts((await local('new'))!.plain.doc)).toEqual(['only copy']);
    expect(texts((await remote('new'))!.doc)).toEqual(['only copy']);
    expect((await local('new'))?.rec).toMatchObject({ dirty: false, conflict: null });
    expect((await local('old'))?.plain.header.title).toBe('In the backup');
  });

  it('keeps a readable copy when the server sends one that does not decrypt, and repairs the server', async () => {
    await writeRemote('e1', 'Readable', 'a');
    await engine.syncNow();
    const e = srv.entries.get('e1')!;
    const other = await integrate.encryptCopy('some-other-entry', { header: header('x'), doc: doc('x') });
    Object.assign(e, { header: other.header, body: other.body, version: e.version + 1, seq: ++srv.seq });
    await engine.syncNow();
    expect((await local('e1'))?.plain.header.title).toBe('Readable');
    expect((await remote('e1'))?.header.title).toBe('Readable');
    expect((await local('e1'))?.rec).toMatchObject({ dirty: false, version: 3 });
  });

  it('refuses settings older than the ones on this device, and puts its own back', async () => {
    const { encryptSettings, decryptSettings } = await import('../crypto/content');
    const old = await encryptSettings('user-1', { autoLock: 0, n: 1 });
    await repo.putSettingsRecord({ vaultId: VAULT, sealed: await encryptSettings('user-1', { autoLock: 5, n: 2 }), dirty: false, rev: 1 });
    // The server replays the older copy as if it were a new change.
    srv.settings = { sealed: old, seq: ++srv.seq };
    await engine.syncNow();
    const mine = await repo.getSettingsRecord(VAULT);
    expect(await decryptSettings('user-1', mine!.sealed!)).toMatchObject({ autoLock: 5, n: 2 });
    expect(await decryptSettings('user-1', srv.settings!.sealed)).toMatchObject({ autoLock: 5, n: 2 });

    // A newer copy from another device is taken as before.
    srv.settings = { sealed: await encryptSettings('user-1', { autoLock: 15, n: 3 }), seq: ++srv.seq };
    await engine.syncNow();
    expect(await decryptSettings('user-1', (await repo.getSettingsRecord(VAULT))!.sealed!)).toMatchObject({ autoLock: 15, n: 3 });
  });

  it('drops an entry deleted elsewhere, unless it has unpushed changes here', async () => {
    await writeRemote('e1', 'Gone', 'x');
    await writeRemote('e2', 'Kept', 'y');
    await engine.syncNow();
    await writeLocal('e2', 'Kept', 'y', 'more');
    // Deleted on the other device:
    for (const id of ['e1', 'e2']) {
      srv.entries.delete(id);
      srv.tombs.set(`entry:${id}`, { kind: 'entry', seq: ++srv.seq });
    }
    await engine.syncNow();
    expect(await local('e1')).toBeNull();
    const kept = await local('e2');
    expect(kept?.rec.conflict?.kind).toBe('deleted');

    // Keeping it puts it back on the server.
    await integrate.resolveConflict(VAULT, 'e2', kept!.plain);
    await engine.syncNow();
    expect(texts((await remote('e2'))!.doc)).toEqual(['y', 'more']);
  });

  it('sends a burn to the server and never resurrects the entry', async () => {
    await writeLocal('e1', 'Burn me', 'x');
    await engine.syncNow();
    await repo.deleteLocalEntry(VAULT, 'e1');
    await engine.syncNow();
    expect(srv.entries.has('e1')).toBe(false);
    expect(await local('e1')).toBeNull();

    // The server has it again (a restored backup, a replay): it stays burned, and is deleted there again.
    await writeRemote('e1', 'Burn me', 'x');
    await engine.syncNow();
    expect(await local('e1')).toBeNull();
    await engine.syncNow();
    expect(srv.entries.has('e1')).toBe(false);
    expect(engine.syncStatus.get().pending).toBe(0);
  });

  it('never uploads images, keeps local-only ones here, and still downloads existing ones', async () => {
    await writeLocal('e1', 'Pic', 'x');
    await repo.saveLocalBlob(VAULT, 'b1', 'e1', new Uint8Array(12), new Uint8Array([1, 2, 3]));
    await engine.syncNow();
    expect(srv.blobs.has('b1')).toBe(false);
    expect((await repo.getBlob(VAULT, 'b1'))?.ct).toEqual(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(engine.syncStatus.get().pending).toBe(0));

    srv.blobs.set('b2', { entryId: 'e1', nonce: new Uint8Array(12), ct: new Uint8Array([9]), seq: ++srv.seq });
    await engine.syncNow();
    await vi.waitFor(async () => expect((await repo.getBlob(VAULT, 'b2'))?.ct).toEqual(new Uint8Array([9])));
  });

  it('holds remote changes for an entry open in an editor until it asks', async () => {
    await writeRemote('e1', 'Day', 'one');
    await engine.syncNow();
    const release = integrate.holdEntry('e1');
    await writeRemote('e1', 'Day', 'one', 'two');
    await engine.syncNow();
    let l = await local('e1');
    expect(texts(l!.plain.doc)).toEqual(['one']);
    expect(l?.rec.incoming?.version).toBe(2);
    expect(await integrate.integrateIncoming(VAULT, 'e1')).toBe('replaced');
    l = await local('e1');
    expect(texts(l!.plain.doc)).toEqual(['one', 'two']);
    release();
  });

  it('keeps refused changes on the device when the free space is full, and sends them after subscribing', async () => {
    const offer = vi.spyOn(paywall, 'open');
    await writeLocal('e1', 'Old', 'a');
    await engine.syncNow();
    srv.full = true;
    await writeLocal('e1', 'Old', 'a', 'edited');
    await writeLocal('e2', 'New', 'b');
    await engine.syncNow();
    // The edit still goes (it doesn't need new space here); the new entry waits on the device.
    expect(texts((await remote('e1'))!.doc)).toEqual(['a', 'edited']);
    expect(srv.entries.has('e2')).toBe(false);
    expect((await local('e2'))?.rec.dirty).toBe(true);
    expect(engine.syncStatus.get().phase).toBe('full');
    // The subscribe banner carries the offer; sync no longer interrupts with the dialog.
    expect(offer).not.toHaveBeenCalled();
    // Offered once per page load, not on every sync.
    await engine.syncNow();
    expect(offer).not.toHaveBeenCalled();

    srv.full = false;
    paywall.subscribed();
    await engine.syncNow();
    expect((await remote('e2'))?.header.title).toBe('New');
    expect(engine.syncStatus.get().phase).toBe('idle');
    offer.mockRestore();
  });

  it('does nothing for a journal without an account', async () => {
    await vault.changeVault((v) => ({ ...v, account: null }));
    await writeLocal('e1', 'Private', 'x');
    await engine.syncNow();
    expect(srv.entries.size).toBe(0);
    expect(engine.syncStatus.get().phase).toBe('off');
  });
});

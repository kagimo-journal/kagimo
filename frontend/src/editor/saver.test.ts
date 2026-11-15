import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryHeader } from './types';

vi.mock('../crypto/content', () => ({
  encryptEntryPart: vi.fn(async (_id: string, part: string, v: unknown) => ({ nonce: part, ct: JSON.stringify(v) })),
}));

const { EntrySaver, AUTOSAVE_DELAY, hasUnsavedDrafts } = await import('./saver');
const repo = await import('../local/repo');
const vault = await import('../local/vault');

const header = (title: string): EntryHeader => ({
  v: 1, title, snippet: '', createdAt: '2026-11-11T21:40:00+00:00', tz: 'Europe/London', location: null, wordCount: 1, imageCount: 0,
});

function setup(exists = false, title: string | null = 'x') {
  let current = title;
  const cb = {
    snapshot: vi.fn(() => (current === null ? null : { header: header(current), body: { v: 1 as const, doc: { type: 'doc' } } })),
    onStatus: vi.fn(),
    onSaved: vi.fn(),
  };
  const saver = new EntrySaver('e1', exists, cb);
  return { saver, cb, set: (t: string | null) => (current = t) };
}

const stored = async () => {
  const r = await repo.getEntry('v1', 'e1');
  return r ? (JSON.parse(r.header.ct) as EntryHeader).title : null;
};

beforeEach(async () => {
  await repo.deleteVault('v1');
  await repo.saveVault(
    {
      id: 'v1', name: '', createdAt: '', kdf: { salt: '', m: 65536, t: 3, p: 1 }, wrappedMkPass: { nonce: '', ct: '' }, wrappedMkRecovery: null,
      recoveryAuth: null, passkeyWraps: [], aadId: 'v1', account: null, sync: { cursor: 0, lastSyncAt: null, full: false }, exportedAt: null,
    },
    true,
  );
  await vault.initVault();
});
afterEach(() => vi.useRealTimers());

describe('EntrySaver', () => {
  it('debounces edits and writes the entry to the device once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { saver, cb } = setup();
    saver.change();
    saver.change();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY - 1);
    expect(cb.snapshot).not.toHaveBeenCalled();
    vi.useRealTimers();
    await saver.flush();
    expect(cb.snapshot).toHaveBeenCalledTimes(1);
    expect(await stored()).toBe('x');
    expect(cb.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', dirty: true, version: 0 }), expect.objectContaining({ title: 'x' }));
    expect(saver.status).toBe('saved');
    expect(saver.exists).toBe(true);
  });

  it('does not store an empty, never-saved entry', async () => {
    const { saver } = setup(false, null);
    saver.change();
    await saver.flush();
    expect(await repo.getEntry('v1', 'e1')).toBeNull();
    expect(saver.status).toBe('idle');
  });

  it('saves the final snapshot when the view closes', async () => {
    const { saver, set } = setup();
    const release = saver.retain();
    saver.change();
    set('ignored');
    const final = await release({ header: header('final'), body: { v: 1, doc: { type: 'doc' } } });
    expect(final).toBe(true);
    expect(await stored()).toBe('final');
    expect(hasUnsavedDrafts()).toBe(false);
  });

  it('bumps the local revision on every save', async () => {
    const { saver, set } = setup();
    saver.change();
    await saver.flush();
    set('y');
    saver.change();
    await saver.flush();
    expect((await repo.getEntry('v1', 'e1'))?.rev).toBe(2);
  });

  it('reports a failed write and keeps the edit unsaved', async () => {
    const { saver, cb } = setup();
    const spy = vi.spyOn(repo, 'saveLocalEntry').mockRejectedValueOnce(new Error('Quota exceeded'));
    saver.change();
    await saver.flush();
    expect(cb.onStatus).toHaveBeenLastCalledWith('error', 'Quota exceeded');
    expect(saver.hasUnsaved).toBe(true);
    spy.mockRestore();
    await saver.flush();
    expect(await stored()).toBe('x');
  });
});

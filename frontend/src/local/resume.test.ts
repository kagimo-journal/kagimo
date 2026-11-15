import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { req, tx } from './db';
import { META_PREFIX, pruneResumeKeys, RELOAD_WINDOW_MS, resumeKeyRange, resumePersistence, takeResumedKey } from './resume';

// The tab's sessionStorage, and what kind of page load this is.
const session = new Map<string, string>();
let navType = 'reload';

beforeEach(() => {
  session.clear();
  navType = 'reload';
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  });
  vi.spyOn(performance, 'getEntriesByType').mockImplementation(() => [{ type: navType } as unknown as PerformanceEntry]);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await tx(['meta'], 'readwrite', (t) => req(t.objectStore('meta').delete(resumeKeyRange())));
});

const mk = () => new Uint8Array(32).fill(7);
const keys = async () => ((await tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').getAll(resumeKeyRange())))) as { key: string }[]).map((r) => r.key);

/** Unlocks (saves the reload copy) and waits for it to be written. */
async function saved(userId = 'v1') {
  resumePersistence.save(userId, mk());
  await vi.waitFor(() => expect(session.size).toBe(1));
}

describe('reload copy of the master key (security review 2026-11-14)', () => {
  it('reopens for a reload that follows the unload', async () => {
    await saved();
    resumePersistence.suspend(Date.now());
    expect(await takeResumedKey('v1', 5 * 60_000)).toEqual(mk());
  });

  it('is refused and deleted when the page never unloaded cleanly (crash, restored session)', async () => {
    await saved();
    expect(await takeResumedKey('v1', null)).toBeNull();
    expect(session.size).toBe(0);
    await vi.waitFor(async () => expect(await keys()).toEqual([]));
  });

  it('is refused for a tab reopened later, even with auto-lock set to never', async () => {
    await saved();
    resumePersistence.suspend(Date.now());
    vi.useFakeTimers({ now: Date.now() + RELOAD_WINDOW_MS + 1, toFake: ['Date'] });
    expect(await takeResumedKey('v1', null)).toBeNull();
    expect(session.size).toBe(0);
  });

  it('is refused when the load is not a reload (reopen closed tab, duplicate tab)', async () => {
    await saved();
    resumePersistence.suspend(Date.now());
    navType = 'back_forward';
    expect(await takeResumedKey('v1', null)).toBeNull();
    expect(session.size).toBe(0);
  });

  it('still honours the inactivity limit and the journal it was saved for', async () => {
    await saved();
    resumePersistence.suspend(Date.now() - 6 * 60_000);
    expect(await takeResumedKey('v1', 5 * 60_000)).toBeNull();
    await saved();
    resumePersistence.suspend(Date.now());
    expect(await takeResumedKey('other', null)).toBeNull();
  });

  it('comes back from the back/forward cache within the inactivity limit', async () => {
    await saved();
    resumePersistence.suspend(Date.now());
    navType = 'back_forward';
    expect(await takeResumedKey('v1', 5 * 60_000, 'bfcache')).toEqual(mk());
  });

  it('locking deletes both halves', async () => {
    await saved();
    resumePersistence.clear();
    expect(session.size).toBe(0);
    await vi.waitFor(async () => expect(await keys()).toEqual([]));
  });

  it('prunes keys left by closed tabs, keeping this tab’s own and those of live tabs', async () => {
    await saved();
    const own = (await keys())[0];
    const put = (token: string) =>
      tx(['meta'], 'readwrite', (t) => req(t.objectStore('meta').put({ key: META_PREFIX + token, value: { cryptoKey: null, createdAt: Date.now() - (token === 'fresh' ? 0 : 5 * 60_000) } })));
    await put('closed');
    await put('live');
    await put('fresh');
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: 'kagimo.resume.live' }] }), request: async () => {} } });
    await pruneResumeKeys();
    expect((await keys()).sort()).toEqual([own, `${META_PREFIX}live`, `${META_PREFIX}fresh`].sort());
  });
});

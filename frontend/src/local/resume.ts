/**
 * Keeps the journal open across a reload of the same tab, within the inactivity limit.
 *
 * While the journal is unlocked, the master key is kept wrapped under a fresh AES key that is
 * non-extractable (scripts can use it but never read its bytes). The key goes in IndexedDB, the
 * wrapped master key and the last activity time in this tab's sessionStorage. Both are needed,
 * and locking (by hand or for inactivity) deletes both. A new tab still needs the passphrase.
 *
 * Closing the tab does not end its sessionStorage for good: "reopen closed tab" and session
 * restore bring it back. So the copy only opens the journal for an actual reload: the page notes
 * when it unloads, and the copy is used only by a reload that starts within RELOAD_WINDOW_MS of
 * that. A restored tab, a crashed one, or anything later needs the passphrase. Keys left behind
 * by closed tabs are deleted the next time the app starts (pruneResumeKeys).
 */
import { openBytes, sealBytes } from '../crypto/aead';
import { fromBase64, randomBytes, toBase64 } from '../crypto/encoding';
import type { SessionPersistence } from '../crypto/session';
import { req, tx } from './db';

const SESSION_KEY = 'kagimo.resume';
export const META_PREFIX = 'resume:';
/** Every reload key in the meta store (deleteVault clears them all). */
export const resumeKeyRange = () => IDBKeyRange.bound(META_PREFIX, `${META_PREFIX}\uffff`);
/** How long after the page unloads a reload may still reopen the journal. */
export const RELOAD_WINDOW_MS = 15_000;
/** A key this new may belong to a tab that is still taking its lock, or is mid-reload: left alone. */
const FRESH_MS = 60_000;
/** Without the Web Locks API, leftovers from closed tabs are deleted after this long. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** Each tab holds a Web Lock named after its reload key while it's unlocked, so others can tell it's alive. */
const LOCK_PREFIX = 'kagimo.resume.';

interface TabRecord {
  token: string;
  userId: string;
  nonce: string;
  ct: string;
  lastActivity: number;
  /** When the page unloaded with the journal open; absent while the page is alive. */
  unloadedAt?: number;
}

interface KeyRecord {
  key: string;
  value: { cryptoKey: CryptoKey; createdAt: number };
}

const aad = (userId: string) => `resume:${userId}`;

function readTab(): TabRecord | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as TabRecord) : null;
  } catch {
    return null;
  }
}

function writeTab(r: TabRecord | null) {
  try {
    if (r) sessionStorage.setItem(SESSION_KEY, JSON.stringify(r));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage blocked: a reload asks for the passphrase, as before */
  }
}

async function deleteKey(token: string) {
  await tx(['meta'], 'readwrite', (t) => req(t.objectStore('meta').delete(META_PREFIX + token))).catch(() => {});
}

/** Bumped by every save and clear, so a slow save can tell that it has been overtaken. */
let generation = 0;

let releaseLock: (() => void) | null = null;

/** Holds (or, with null, lets go of) the Web Lock that marks this tab's reload key as in use. */
function holdLock(token: string | null) {
  releaseLock?.();
  releaseLock = null;
  if (!token || typeof navigator === 'undefined' || !navigator.locks) return;
  let done!: () => void;
  const held = new Promise<void>((r) => (done = r));
  void navigator.locks.request(LOCK_PREFIX + token, () => held).catch(() => {});
  releaseLock = done;
}

async function save(userId: string, mk: Uint8Array) {
  const gen = ++generation;
  const old = readTab();
  const token = toBase64(randomBytes(16)).replace(/[^A-Za-z0-9]/g, '');
  const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const { nonce, ct } = await sealBytes(cryptoKey, mk, aad(userId));
  if (gen !== generation) return;
  const rec: KeyRecord = { key: META_PREFIX + token, value: { cryptoKey, createdAt: Date.now() } };
  // Taken before the key is stored, so another tab starting up now doesn't prune it.
  holdLock(token);
  // The key this one replaces goes in the same transaction, so it can't be left behind.
  await tx(['meta'], 'readwrite', async (t) => {
    const store = t.objectStore('meta');
    await req(store.put(rec));
    if (old && old.token !== token) await req(store.delete(META_PREFIX + old.token));
  });
  if (gen !== generation) return void deleteKey(token);
  writeTab({ token, userId, nonce: toBase64(nonce), ct: toBase64(ct), lastActivity: Date.now() });
}

function clear() {
  generation++;
  const old = readTab();
  writeTab(null);
  holdLock(null);
  if (old) void deleteKey(old.token);
}

function touch(lastActivity: number) {
  const r = readTab();
  if (r) writeTab({ ...r, lastActivity });
}

/** The page is unloading with the journal open: note when, so only a prompt reload can use the copy. */
function suspend(lastActivity: number) {
  const r = readTab();
  if (r) writeTab({ ...r, lastActivity, unloadedAt: Date.now() });
}

export const resumePersistence: SessionPersistence = {
  save: (userId, mk) => void save(userId, new Uint8Array(mk)).catch(() => {}),
  touch,
  suspend,
  clear,
};

/** True when this page load is a reload (not a restored, duplicated or newly opened tab). */
function isReload(): boolean {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) return nav.type === 'reload';
    // Older browsers: the deprecated form (1 = reload).
    return (performance as { navigation?: { type?: number } }).navigation?.type === 1;
  } catch {
    return false;
  }
}

/**
 * The master key this tab had unlocked, if it's for `userId`, the inactivity limit (`idleMs`,
 * null for never) hasn't passed, and the page is coming back the way `how` says:
 *  - 'reload': this load is a reload that began within RELOAD_WINDOW_MS of the page unloading;
 *  - 'bfcache': the same page, back from the back/forward cache.
 * Anything else (a restored or duplicated tab, a crash) deletes the copy. The caller zeroes the key.
 */
export async function takeResumedKey(userId: string, idleMs: number | null, how: 'reload' | 'bfcache' = 'reload'): Promise<Uint8Array | null> {
  const r = readTab();
  if (!r) return null;
  const now = Date.now();
  const sinceUnload = typeof r.unloadedAt === 'number' ? now - r.unloadedAt : NaN;
  const prompt = how === 'bfcache' || (isReload() && sinceUnload >= 0 && sinceUnload <= RELOAD_WINDOW_MS);
  if (!prompt || r.userId !== userId || (idleMs !== null && now - r.lastActivity >= idleMs)) {
    clear();
    return null;
  }
  try {
    const rec = (await tx(['meta'], 'readonly', (t) => req(t.objectStore('meta').get(META_PREFIX + r.token)))) as KeyRecord | undefined;
    if (!rec) {
      clear();
      return null;
    }
    return await openBytes(rec.value.cryptoKey, fromBase64(r.nonce), fromBase64(r.ct), aad(userId));
  } catch {
    clear();
    return null;
  }
}

/**
 * Deletes reload keys left behind by closed tabs: every key but this tab's own and those of tabs
 * that are open and unlocked right now (they hold a Web Lock). Keys made in the last minute are
 * left for the next start. Without Web Locks, keys go by age.
 */
export async function pruneResumeKeys(): Promise<void> {
  let alive: Set<string> | null = null;
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const { held = [] } = await navigator.locks.query();
      alive = new Set(held.map((l) => l.name ?? ''));
    }
  } catch {
    alive = null;
  }
  await tx(['meta'], 'readwrite', async (t) => {
    const store = t.objectStore('meta');
    const all = (await req(store.getAll(resumeKeyRange()))) as KeyRecord[];
    const own = readTab()?.token;
    for (const r of all) {
      const age = Date.now() - r.value.createdAt;
      if (r.key === META_PREFIX + own || age < FRESH_MS) continue;
      const token = r.key.slice(META_PREFIX.length);
      const stale = alive ? !alive.has(LOCK_PREFIX + token) : age > STALE_MS;
      if (stale) await req(store.delete(r.key));
    }
  }).catch(() => {});
}

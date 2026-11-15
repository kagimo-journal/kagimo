/**
 * Sync (SPEC §5.2): an optional mirror of the on-device journal on the server, for journals with
 * an approved account. The device is the source of truth for what it shows; sync runs in the
 * background whenever the journal is unlocked and the network is there:
 *
 *   1. pull the change feed since the last cursor and take each change in (integrate.ts);
 *   2. push deletions, then changed entries (409 → take the newer copy in, push again), then
 *      settings. Each write answers with the change-feed seq it took; while those follow the
 *      cursor one by one, nobody else wrote in between and the cursor steps past our own changes.
 *      Otherwise (or if nothing was pushed) …
 *   3. … pull again, for whatever arrived meanwhile;
 *   4. download the images this device doesn't have yet.
 *
 * When it runs: every PERIOD_MS while the tab is visible (never in a hidden tab), on unlock, on
 * coming back online or into view, and after local changes: PUSH_DELAY_MS after the latest, but
 * no later than PUSH_MAX_WAIT_MS after the first one still unpushed. Hiding the tab pushes at once.
 *
 * Only ciphertext moves. Merges need the content key, so sync only runs while unlocked.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, isApiError, NetworkError } from '../api/client';
import { blobs as blobApi, entries as entriesApi, settings as settingsApi, syncChanges, type SyncPage } from '../api/endpoints';
import { paywall } from '../billing/paywallState';
import { DecryptError, type Sealed } from '../crypto/aead';
import { decryptSettings } from '../crypto/content';
import { isUnlocked, subscribe as subscribeLock } from '../crypto/session';
import type { VaultRecord } from '../local/db';
import {
  dropBlob,
  emitLocal,
  getBlob,
  getEntry,
  getSettingsRecord,
  listBlobMeta,
  listEntries,
  listOutbox,
  onLocalEvent,
  putBlob,
  putEntry,
  putSettingsRecord,
  removeOutbox,
  withEntryLock,
} from '../local/repo';
import { currentVault, updateVaultById as updateVaultRecord } from '../local/vault';
import { receiveRemote, receiveRemoteDelete } from './integrate';

export type SyncPhase =
  /** No account: a journal on this device only. */
  | 'off'
  /** Account exists but can't sync yet (administrator without a second factor, or disabled). */
  | 'waiting'
  /** The session ended: sign in again to keep syncing. */
  | 'signed-out'
  | 'idle'
  | 'syncing'
  | 'offline'
  /** The account's free space on the server is used up: changes stay on this device (SPEC §5.6). */
  | 'full'
  | 'error';

export interface SyncState {
  phase: SyncPhase;
  lastSyncAt: string | null;
  message: string | null;
  /** Entries with a conflict waiting for the person. */
  conflicts: number;
  /** Local changes not on the server yet (entries, images, deletions, settings). */
  pending: number;
}

let state: SyncState = { phase: 'off', lastSyncAt: null, message: null, conflicts: 0, pending: 0 };
const listeners = new Set<() => void>();

function setState(next: Partial<SyncState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const syncStatus = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,
};

export function useSyncStatus(): SyncState {
  return useSyncExternalStore(syncStatus.subscribe, syncStatus.get);
}

// ---- scheduling -------------------------------------------------------------------------------------

const PERIOD_MS = 60_000;
/** Quiet time after the latest local change before it's pushed. */
const PUSH_DELAY_MS = 10_000;
/** The longest a local change waits while writing goes on. */
const PUSH_MAX_WAIT_MS = 30_000;
const MAX_PUSH_ROUNDS = 5;
const BLOB_DOWNLOADS = 3;

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** When the oldest local change not yet taken up by a sync run was made. */
let pendingSince: number | null = null;
let started = false;
/** Set while the server session is gone, so we don't hammer it. */
let signedOut = false;
/** The upgrade dialog opens by itself once per page load, not on every sync. */

function canSync(v: VaultRecord | null | undefined): v is VaultRecord & { account: NonNullable<VaultRecord['account']> } {
  // Same rule as canUseJournal: only administrators need a second factor.
  return !!v?.account && v.account.status === 'active' && (v.account.hasSecondFactor || !v.account.isAdmin);
}

function phaseFor(v: VaultRecord | null | undefined): SyncPhase {
  if (!v?.account) return 'off';
  if (signedOut) return 'signed-out';
  if (!canSync(v)) return 'waiting';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  return state.phase === 'syncing' || state.phase === 'error' || state.phase === 'full' ? state.phase : 'idle';
}

/** Recomputes the status line (e.g. after the vault or account changed). */
export function refreshSyncPhase() {
  const v = currentVault();
  setState({ phase: phaseFor(v), lastSyncAt: v?.sync.lastSyncAt ?? null });
  void countPending();
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, ms);
}

function unschedule() {
  if (timer) clearTimeout(timer);
  timer = null;
}

const tabVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Next run: soon if local changes are waiting, else the periodic pull (only while visible). */
function scheduleNext() {
  if (!isUnlocked()) return unschedule();
  if (pendingSince !== null) {
    const now = Date.now();
    schedule(Math.max(0, Math.min(PUSH_DELAY_MS, pendingSince + PUSH_MAX_WAIT_MS - now)));
  } else if (tabVisible()) {
    schedule(PERIOD_MS);
  } else {
    unschedule();
  }
}

/** Pushes waiting local changes now, if any (the tab is being hidden or closed). */
export function pushPending(): Promise<void> {
  if (pendingSince === null || !isUnlocked()) return Promise.resolve();
  return syncNow();
}

/** Runs a sync now (or right after the one in progress). */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await runOnce();
      } while (again);
    } finally {
      running = null;
      scheduleNext();
    }
  })();
  return running;
}

/**
 * /api/me answered for this device's account. Syncs if that's news: the session was signed out,
 * or the account changed (approved, new keys). A routine re-read (e.g. for space used) doesn't
 * sync, or Settings → Sync, which re-reads after each sync, would loop.
 */
export function sessionRestored(accountChanged = false) {
  const wasSignedOut = signedOut;
  signedOut = false;
  refreshSyncPhase();
  if (wasSignedOut || accountChanged) void syncNow();
}

/** Starts background sync for the app's lifetime (called once at boot). */
export function startSync() {
  if (started || typeof window === 'undefined') return;
  started = true;
  subscribeLock(() => {
    if (isUnlocked()) void syncNow();
    else unschedule();
  });
  window.addEventListener('online', () => {
    refreshSyncPhase();
    void syncNow();
  });
  window.addEventListener('offline', () => refreshSyncPhase());
  paywall.onSubscribed(() => void syncNow());
  // Hidden: stop polling. Changes still waiting are pushed by main.tsx, after open editors save.
  document.addEventListener('visibilitychange', () => {
    if (!isUnlocked()) return;
    if (document.visibilityState === 'visible') void syncNow();
    else if (pendingSince === null && !running) unschedule();
  });
  onLocalEvent((e) => {
    if ((e.type === 'entries' && e.origin === 'local') || (e.type === 'settings' && e.origin === 'local') || e.type === 'blobs') {
      void countPending();
      if (isUnlocked() && canSync(currentVault())) {
        pendingSince ??= Date.now();
        if (!running) scheduleNext();
      }
    }
  });
  refreshSyncPhase();
  // A reload reopens the journal before this runs (local/resume.ts), so that unlock was missed.
  if (isUnlocked()) void syncNow();
}

// ---- one run --------------------------------------------------------------------------------------------

async function runOnce(): Promise<void> {
  // This run takes up every change made so far; later ones schedule the next.
  pendingSince = null;
  const v = currentVault();
  if (!isUnlocked() || !canSync(v) || signedOut) {
    refreshSyncPhase();
    return;
  }
  if (navigator.onLine === false) {
    setState({ phase: 'offline' });
    return;
  }
  setState({ phase: 'syncing', message: null });
  try {
    const pulledTo = await pull(v);
    // Free accounts that fill up see the subscribe banner turn into a warning (SubscribeBanner).
    const { full, wrote, cursor } = await push(v, pulledTo);
    if (cursor !== null) {
      // Our writes followed the cursor one by one: nothing else arrived, and there's no need to
      // download our own changes again.
      await updateVaultRecord(v.id, (x) => ({ ...x, sync: { ...x.sync, cursor } }));
    } else if (wrote) {
      await pull(v); // anything that arrived meanwhile
    }
    const now = new Date().toISOString();
    await updateVaultRecord(v.id, (x) => ({ ...x, sync: { ...x.sync, lastSyncAt: now } }));
    if (full) {
      setState({ phase: 'full', lastSyncAt: now, message: full });
    } else {
      setState({ phase: 'idle', lastSyncAt: now, message: null });
    }
    void downloadBlobs(v.id);
  } catch (e) {
    if (!isUnlocked()) {
      setState({ phase: phaseFor(currentVault()) });
    } else if (e instanceof NetworkError || isApiError(e, 'unavailable')) {
      setState({ phase: 'offline', message: null });
    } else if (isApiError(e, 'unauthenticated') || isApiError(e, 'account_disabled')) {
      signedOut = true;
      setState({ phase: 'signed-out', message: null });
    } else if (isApiError(e, 'second_factor_required')) {
      setState({ phase: 'waiting', message: null });
    } else {
      setState({ phase: 'error', message: e instanceof Error ? e.message : 'Sync failed' });
    }
  } finally {
    void countPending();
  }
}

// ---- pull -------------------------------------------------------------------------------------------------

/** Takes in the change feed; returns the cursor it reached. */
async function pull(v: VaultRecord): Promise<number> {
  let rec = currentVault() ?? v;
  let cursor = rec.sync.cursor;
  let full = rec.sync.full || cursor === 0;
  const seenEntries = new Set<string>();
  const seenBlobs = new Set<string>();
  /** The cursor the server refused, if it did (see reconcileFull). */
  let expiredFrom: number | null = null;
  for (let guard = 0; guard < 10_000; guard++) {
    let page: SyncPage;
    try {
      page = await syncChanges(cursor);
    } catch (e) {
      if (isApiError(e, 'cursor_expired')) {
        // Away too long (or the server was restored): start over and reconcile everything.
        expiredFrom = Math.max(expiredFrom ?? 0, cursor);
        cursor = 0;
        full = true;
        seenEntries.clear();
        seenBlobs.clear();
        continue;
      }
      throw e;
    }
    for (const e of page.entries) {
      seenEntries.add(e.id);
      await receiveRemote(v.id, { id: e.id, createdAt: e.createdAt, updatedAt: e.updatedAt, version: e.version, header: e.header, body: e.body });
    }
    for (const id of page.deleted.entries) await receiveRemoteDelete(v.id, id);
    for (const b of page.blobs) {
      seenBlobs.add(b.id);
      const local = await getBlob(v.id, b.id);
      if (!local) await putBlob({ vaultId: v.id, id: b.id, entryId: b.entryId ?? '', nonce: null, ct: null, size: b.size, synced: true });
      else if (!local.synced) await putBlob({ ...local, synced: true });
    }
    if (page.deleted.blobs.length) {
      for (const id of page.deleted.blobs) await dropBlob(v.id, id);
      emitLocal({ type: 'blobs', ids: page.deleted.blobs });
    }
    if (page.settings) await receiveSettings(v.id, page.settings);
    cursor = page.cursor;
    if (!page.more) break;
    // Keep the cursor mid-way, so a long first sync resumes where it stopped.
    if (!full) rec = (await updateVaultRecord(v.id, (x) => ({ ...x, sync: { ...x.sync, cursor } }))) ?? rec;
  }
  // The feed ends before the point this device had already reached: the server went back in time
  // (restored from a backup, or worse). What's missing there was not deleted; it was lost.
  const rolledBack = expiredFrom !== null && cursor < expiredFrom;
  if (full) await reconcileFull(v.id, seenEntries, seenBlobs, rolledBack);
  await updateVaultRecord(v.id, (x) => ({ ...x, sync: { ...x.sync, cursor, full: false } }));
  return cursor;
}

/**
 * After a full pull: whatever this device thinks is on the server but wasn't in the feed was
 * deleted there while we weren't looking (the deletion's record has expired).
 *
 * Unless the server rolled back: then this device may hold the only copy of what was written
 * since, so nothing is deleted. Entries go back in the queue as new ones, and photos stay here.
 */
async function reconcileFull(vaultId: string, seenEntries: Set<string>, seenBlobs: Set<string>, rolledBack: boolean) {
  const restored: string[] = [];
  for (const e of await listEntries(vaultId)) {
    if (e.version === 0 || seenEntries.has(e.id)) continue;
    if (!rolledBack) {
      await receiveRemoteDelete(vaultId, e.id);
      continue;
    }
    await withEntryLock(e.id, async () => {
      const cur = await getEntry(vaultId, e.id);
      if (cur && cur.version > 0) await putEntry({ ...cur, version: 0, base: null, incoming: null, dirty: true });
    });
    restored.push(e.id);
  }
  if (restored.length) emitLocal({ type: 'entries', ids: restored, origin: 'sync' });
  const gone: string[] = [];
  for (const b of await listBlobMeta(vaultId)) {
    if (!b.synced || seenBlobs.has(b.id)) continue;
    const local = rolledBack ? await getBlob(vaultId, b.id) : null;
    if (local?.ct) {
      // Downloaded already: it now lives on this device only.
      await putBlob({ ...local, synced: false });
      continue;
    }
    await dropBlob(vaultId, b.id);
    gone.push(b.id);
  }
  if (gone.length) emitLocal({ type: 'blobs', ids: gone });
}

async function receiveSettings(vaultId: string, sealed: SyncPage['settings']) {
  if (!sealed) return;
  const local = await getSettingsRecord(vaultId);
  // Unpushed changes here win (pushed next); otherwise take the server's.
  if (local?.dirty) return;
  if (local?.sealed && !(await settingsAreNewer(vaultId, local.sealed, sealed))) {
    // Unreadable, or older than what this device has (a replayed copy): ours goes back up.
    await putSettingsRecord({ ...local, dirty: true });
    return;
  }
  await putSettingsRecord({ vaultId, sealed, dirty: false, rev: local?.rev ?? 0 });
  emitLocal({ type: 'settings', origin: 'sync' });
}

/** Whether `theirs` opens and is at least as new as `mine`, by the change counter inside (Settings.n). */
async function settingsAreNewer(vaultId: string, mine: Sealed, theirs: Sealed): Promise<boolean> {
  const aadId = currentVault()?.id === vaultId ? currentVault()!.aadId : null;
  if (!aadId) return true;
  const count = async (s: Sealed) => {
    const n = (await decryptSettings<{ n?: unknown }>(aadId, s))?.n;
    return typeof n === 'number' ? n : 0;
  };
  let ours: number;
  try {
    ours = await count(mine);
  } catch (e) {
    if (!(e instanceof DecryptError)) throw e;
    return true; // ours doesn't open: nothing to protect
  }
  try {
    return (await count(theirs)) >= ours;
  } catch (e) {
    if (!(e instanceof DecryptError)) throw e;
    return false;
  }
}

// ---- push -------------------------------------------------------------------------------------------------

/**
 * Follows the seqs our writes take. While each is the cursor + 1, no other device wrote in
 * between, so the cursor can move past it without pulling. A gap, or a write without a seq (an
 * older server), breaks the chain for the rest of the push.
 */
class SeqChain {
  wrote = false;
  constructor(private cursor: number | null) {}
  note(seq: number | undefined) {
    this.wrote = true;
    this.cursor = this.cursor !== null && seq === this.cursor + 1 ? seq : null;
  }
  /** The cursor to store, if anything was written and the chain held. */
  get result(): number | null {
    return this.wrote ? this.cursor : null;
  }
}

/**
 * Sends local changes. A change the server refuses because the account's space is full (402
 * `storage_full` on the free plan, 413 `storage_limit` at the paid fair-use cap) stays queued here, and the rest still go: deletions free space, and edits that
 * don't grow an entry are always accepted. Returns the server's message if anything was refused,
 * whether anything was written, and the cursor past our own writes (see SeqChain).
 */
async function push(v: VaultRecord, cursor: number): Promise<{ full: string | null; wrote: boolean; cursor: number | null }> {
  let full: string | null = null;
  const chain = new SeqChain(cursor);
  /** Runs one upload; a full account is noted instead of failing the whole sync. */
  const send = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      // storage_limit: a paid account at its fair-use cap. Same handling.
      if (!isApiError(e, 'storage_full') && !isApiError(e, 'storage_limit')) throw e;
      full = e instanceof Error ? e.message : 'Sync space is full';
      return false;
    }
  };

  // 1. deletions
  for (const o of await listOutbox(v.id)) {
    try {
      const ack = o.kind === 'entry' ? await entriesApi.remove(o.id) : await blobApi.remove(o.id);
      chain.note(ack?.seq);
    } catch (e) {
      if (!isApiError(e, undefined, 404)) throw e;
    }
    await removeOutbox(o);
  }

  // 2. entries (a 409 takes the newer copy in, then the merged result goes out next round)
  for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
    const dirty = (await listEntries(v.id)).filter((e) => e.dirty && !e.conflict && !e.incoming);
    if (!dirty.length) break;
    let retry = false;
    for (const e of dirty) {
      let again = false;
      await send(async () => {
        again = await pushEntry(v.id, e.id, chain);
      });
      retry = again || retry;
    }
    if (!retry) break;
  }

  // 3. images: no longer uploaded (the server stores text only). Photos already on the server
  // still sync down; ones that only ever lived on this device stay here.

  // 4. settings
  const s = await getSettingsRecord(v.id);
  if (s?.dirty && s.sealed && (await send(async () => chain.note((await settingsApi.put(s.sealed!))?.seq)))) {
    const cur = await getSettingsRecord(v.id);
    if (cur && cur.rev === s.rev) await putSettingsRecord({ ...cur, dirty: false });
  }
  return { full, wrote: chain.wrote, cursor: chain.result };
}

/** Pushes one entry. Returns true when it needs another round (it was merged after a 409). */
async function pushEntry(vaultId: string, id: string, chain: SeqChain): Promise<boolean> {
  const e = await getEntry(vaultId, id);
  if (!e || !e.dirty || e.conflict || e.incoming) return false;
  let version: number;
  let updatedAt: string;
  try {
    if (e.version === 0) {
      const meta = await entriesApi.create(id, e.header, e.body);
      version = meta.version;
      updatedAt = meta.updatedAt;
      chain.note(meta.seq);
    } else {
      const res = await entriesApi.update(id, e.header, e.body, e.version);
      version = res.version;
      updatedAt = res.updatedAt;
      chain.note(res.seq);
    }
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'version_conflict' || err.code === 'entry_exists')) {
      const latest = await entriesApi.get(id);
      await receiveRemote(vaultId, { id, createdAt: latest.createdAt, updatedAt: latest.updatedAt, version: latest.version, header: latest.header, body: latest.body });
      return true;
    }
    if (isApiError(err, undefined, 404)) {
      // Deleted on the server since our last pull.
      await receiveRemoteDelete(vaultId, id);
      return false;
    }
    throw err;
  }
  await withEntryLock(id, async () => {
    const cur = await getEntry(vaultId, id);
    if (!cur) return;
    const unchanged = cur.rev === e.rev;
    await putEntry({
      ...cur,
      version,
      base: { header: e.header, body: e.body },
      dirty: unchanged ? false : cur.dirty,
      updatedAt: unchanged ? updatedAt : cur.updatedAt,
    });
  });
  return false;
}

// ---- image downloads ----------------------------------------------------------------------------------------

let downloading = false;

async function downloadBlobs(vaultId: string) {
  if (downloading) return;
  downloading = true;
  try {
    const missing = (await listBlobMeta(vaultId)).filter((b) => b.synced);
    const queue: string[] = [];
    for (const m of missing) {
      const b = await getBlob(vaultId, m.id);
      if (b && !b.ct) queue.push(m.id);
    }
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        if (!isUnlocked()) return;
        try {
          await fetchBlobToLocal(vaultId, id);
        } catch (e) {
          if (e instanceof NetworkError) return;
        }
      }
    };
    await Promise.all(Array.from({ length: BLOB_DOWNLOADS }, worker));
  } finally {
    downloading = false;
  }
}

/** Downloads one image's ciphertext into local storage and returns it. */
export async function fetchBlobToLocal(vaultId: string, id: string): Promise<{ nonce: Uint8Array; ct: Uint8Array }> {
  const { nonce, ct } = await blobApi.get(id);
  const cur = await getBlob(vaultId, id);
  await putBlob({ vaultId, id, entryId: cur?.entryId ?? '', nonce, ct, size: ct.length, synced: true });
  return { nonce, ct };
}

// ---- counts -------------------------------------------------------------------------------------------------

async function countPending() {
  const v = currentVault();
  if (!v) return setState({ pending: 0, conflicts: 0 });
  try {
    const [entries, outbox, settings] = await Promise.all([listEntries(v.id), listOutbox(v.id), getSettingsRecord(v.id)]);
    const conflicts = entries.filter((e) => e.conflict).length;
    const pending = entries.filter((e) => e.dirty).length + outbox.length + (settings?.dirty ? 1 : 0);
    if (conflicts !== state.conflicts || pending !== state.pending) setState({ conflicts, pending });
  } catch {
    /* storage unavailable: leave the counts */
  }
}

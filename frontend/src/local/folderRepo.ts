/**
 * The on-device journal in the desktop app: the same records as idbRepo.ts, kept as files in the
 * folder the person chose (desktop/src/store.ts has the layout). The app reaches these through
 * repo.ts.
 *
 * A folder holds one journal. IndexedDB's transactions become: every operation here runs alone,
 * one after another, and where one touches several files they are written in the order that
 * leaves the journal right if the app stops halfway.
 */
import type { Sealed } from '../crypto/aead';
import { fromBase64, toBase64 } from '../crypto/encoding';
import { desktop, type DesktopBridge } from '../desktop/bridge';
import { type BlobRecord, type EntryRecord, type JournalSize, type OutboxRecord, sealedBytes, type SettingsRecord, type VaultRecord } from './db';

const FORMAT = 'kagimo-journal';
const VERSION = 1;

function bridge(): DesktopBridge {
  if (!desktop) throw new Error('The journal folder is only available in the desktop app.');
  return desktop;
}

// ---- one at a time ---------------------------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

// ---- what's in memory --------------------------------------------------------------------------------

/** The folder's journal as last read or written; undefined before the first read. */
let vault: VaultRecord | null | undefined;
/** Every entry record (ciphertext), read once: the app is the only writer while it's open. */
let entries: Map<string, EntryRecord> | null = null;

type StoredEntry = Omit<EntryRecord, 'vaultId'>;
type StoredOutbox = Omit<OutboxRecord, 'vaultId'>;
interface StoredBlob {
  id: string;
  entryId: string;
  /** base64; null until downloaded. */
  nonce: string | null;
  size: number;
  synced: boolean;
  /** Whether blobs/<id>.bin holds the ciphertext. */
  stored: boolean;
}
type StoredSettings = Omit<SettingsRecord, 'vaultId'>;

async function readVault(): Promise<VaultRecord | null> {
  if (vault !== undefined) return vault;
  const raw = (await bridge().files.readDoc('vault')) as { format?: unknown; version?: unknown; vault?: VaultRecord } | null;
  if (raw) {
    if (raw.format !== FORMAT || typeof raw.version !== 'number' || typeof raw.vault?.id !== 'string') {
      throw new Error('kagimo.json in this folder isn’t a Kagimo journal.');
    }
    if (raw.version > VERSION) throw new Error('This journal was last opened by a newer version of Kagimo. Update the app to open it.');
  }
  vault = raw?.vault ?? null;
  return vault;
}

async function writeVault(v: VaultRecord): Promise<void> {
  await bridge().files.writeDoc('vault', { format: FORMAT, version: VERSION, vault: v });
  vault = v;
}

/** True when `vaultId` is the journal in the open folder. */
async function isOpen(vaultId: string): Promise<boolean> {
  return (await readVault())?.id === vaultId;
}

/** Writes are refused for a journal that isn't the one in the folder (work left over from before a switch). */
async function mustBeOpen(vaultId: string): Promise<void> {
  if (!(await isOpen(vaultId))) throw new Error('That journal is no longer open.');
}

async function entryMap(vaultId: string): Promise<Map<string, EntryRecord>> {
  if (entries) return entries;
  const map = new Map<string, EntryRecord>();
  for (const raw of (await bridge().files.list('entries')) as Partial<StoredEntry>[]) {
    if (typeof raw?.id !== 'string' || !raw.header || !raw.body) continue; // not an entry record
    map.set(raw.id, {
      vaultId,
      id: raw.id,
      header: raw.header,
      body: raw.body,
      createdAt: raw.createdAt ?? new Date(0).toISOString(),
      updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
      version: raw.version ?? 0,
      base: raw.base ?? null,
      dirty: raw.dirty ?? false,
      rev: raw.rev ?? 0,
      incoming: raw.incoming ?? null,
      conflict: raw.conflict ?? null,
    });
  }
  entries = map;
  return map;
}

async function storeEntry(rec: EntryRecord): Promise<void> {
  const { vaultId, ...stored } = rec;
  await bridge().files.write('entries', rec.id, stored satisfies StoredEntry);
  (await entryMap(vaultId)).set(rec.id, rec);
}

async function removeEntry(vaultId: string, id: string): Promise<void> {
  await bridge().files.write('entries', id, null);
  (await entryMap(vaultId)).delete(id);
}

async function blobMetas(): Promise<StoredBlob[]> {
  return ((await bridge().files.list('blobs')) as Partial<StoredBlob>[]).filter(
    (b): b is StoredBlob => typeof b?.id === 'string' && typeof b.entryId === 'string',
  );
}

async function removeBlob(id: string): Promise<void> {
  // The record goes first: bytes without a record are ignored, a record without bytes isn't.
  await bridge().files.write('blobs', id, null);
  await bridge().files.writeBytes(id, null);
}

async function readOutbox(): Promise<StoredOutbox[]> {
  const raw = await bridge().files.readDoc('outbox');
  return Array.isArray(raw) ? (raw as StoredOutbox[]) : [];
}

async function writeOutbox(list: StoredOutbox[]): Promise<void> {
  await bridge().files.writeDoc('outbox', list.length ? list : null);
}

const same = (a: StoredOutbox, kind: OutboxRecord['kind'], id: string) => a.kind === kind && a.id === id;

/** Adds deletions to send, replacing any record of the same thing. */
async function queueDeletions(add: StoredOutbox[]): Promise<void> {
  if (!add.length) return;
  const list = (await readOutbox()).filter((o) => !add.some((a) => same(o, a.kind, a.id)));
  await writeOutbox([...list, ...add]);
}

// ---- vaults --------------------------------------------------------------------------------------------

/** The journal in the chosen folder; null when no folder is chosen or it holds no journal yet. */
export function loadActiveVault(): Promise<VaultRecord | null> {
  return serial(async () => {
    vault = undefined;
    entries = null;
    const cur = await bridge().folder.current();
    if (!cur) return null;
    if (!cur.available) throw new Error(`The journal folder can’t be reached: ${cur.path}`);
    return readVault();
  });
}

export function getVault(id: string): Promise<VaultRecord | null> {
  return serial(async () => {
    const v = await readVault();
    return v?.id === id ? v : null;
  });
}

export function saveVault(v: VaultRecord, _makeActive = false): Promise<void> {
  return serial(async () => {
    const cur = await readVault();
    if (cur && cur.id !== v.id) throw new Error('This folder already holds another journal.');
    if (!cur) entries = null;
    await writeVault(v);
  });
}

export function updateVault(id: string, fn: (v: VaultRecord) => VaultRecord, settings?: SettingsRecord): Promise<VaultRecord | null> {
  return serial(async () => {
    const v = await readVault();
    if (!v || v.id !== id) return null;
    const next = fn(v);
    await writeVault(next);
    if (settings) {
      const { vaultId: _, ...stored } = settings;
      await bridge().files.writeDoc('settings', stored satisfies StoredSettings);
    }
    return next;
  });
}

/** Deletes the journal's files from the folder, and its key from this computer. The folder stays chosen. */
export function deleteVault(id: string): Promise<void> {
  return serial(async () => {
    if (!(await isOpen(id))) return;
    await bridge().files.wipe();
    vault = null;
    entries = null;
    await bridge().keys.delete(id).catch(() => {});
  });
}

/** Applies a change to the vault, then deletes its key from this computer's keychain (setting a password). */
export async function updateVaultDroppingDeviceKey(id: string, fn: (v: VaultRecord) => VaultRecord): Promise<VaultRecord | null> {
  const next = await updateVault(id, fn);
  if (next) await bridge().keys.delete(id);
  return next;
}

// ---- entries -------------------------------------------------------------------------------------------

export function listEntries(vaultId: string): Promise<EntryRecord[]> {
  return serial(async () => ((await isOpen(vaultId)) ? [...(await entryMap(vaultId)).values()] : []));
}

export function getEntry(vaultId: string, id: string): Promise<EntryRecord | null> {
  return serial(async () => ((await isOpen(vaultId)) ? ((await entryMap(vaultId)).get(id) ?? null) : null));
}

export function putEntry(rec: EntryRecord): Promise<void> {
  return serial(async () => {
    await mustBeOpen(rec.vaultId);
    await storeEntry(rec);
  });
}

export function saveLocalEntry(vaultId: string, id: string, header: Sealed, body: Sealed, now = new Date().toISOString()): Promise<EntryRecord> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    const cur = (await entryMap(vaultId)).get(id);
    const rec: EntryRecord = cur
      ? { ...cur, header, body, updatedAt: now, dirty: true, rev: cur.rev + 1 }
      : { vaultId, id, header, body, createdAt: now, updatedAt: now, version: 0, base: null, dirty: true, rev: 1, incoming: null, conflict: null };
    await storeEntry(rec);
    return rec;
  });
}

export function deleteLocalEntry(vaultId: string, id: string): Promise<void> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    const cur = (await entryMap(vaultId)).get(id);
    const blobs = (await blobMetas()).filter((b) => b.entryId === id);
    // What the server must delete is written down before anything goes, so a burned entry can't
    // come back from it. (The server deletes an entry's photos with the entry.)
    const queue: StoredOutbox[] = [];
    if (cur && cur.version > 0) queue.push({ kind: 'entry', id });
    else for (const b of blobs) if (b.synced) queue.push({ kind: 'blob', id: b.id });
    await queueDeletions(queue);
    for (const b of blobs) await removeBlob(b.id);
    await removeEntry(vaultId, id);
  });
}

export function dropEntry(vaultId: string, id: string): Promise<void> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    for (const b of await blobMetas()) if (b.entryId === id) await removeBlob(b.id);
    await removeEntry(vaultId, id);
  });
}

// ---- blobs ---------------------------------------------------------------------------------------------

const metaOf = (vaultId: string, b: StoredBlob): Omit<BlobRecord, 'ct' | 'nonce'> => ({ vaultId, id: b.id, entryId: b.entryId, size: b.size, synced: b.synced });

async function fullBlob(vaultId: string, b: StoredBlob): Promise<BlobRecord> {
  const ct = b.stored ? await bridge().files.readBytes(b.id) : null;
  return { ...metaOf(vaultId, b), nonce: b.nonce && ct ? fromBase64(b.nonce) : null, ct };
}

async function storeBlob(rec: BlobRecord): Promise<void> {
  const stored = !!(rec.ct && rec.nonce);
  // Bytes first: the record is what says they are there.
  await bridge().files.writeBytes(rec.id, stored ? rec.ct : null);
  await bridge().files.write('blobs', rec.id, {
    id: rec.id,
    entryId: rec.entryId,
    nonce: stored ? toBase64(rec.nonce!) : null,
    size: rec.size,
    synced: rec.synced,
    stored,
  } satisfies StoredBlob);
}

export function getBlob(vaultId: string, id: string): Promise<BlobRecord | null> {
  return serial(async () => {
    if (!(await isOpen(vaultId))) return null;
    const b = (await bridge().files.read('blobs', id)) as StoredBlob | null;
    return b ? fullBlob(vaultId, b) : null;
  });
}

export function putBlob(rec: BlobRecord): Promise<void> {
  return serial(async () => {
    await mustBeOpen(rec.vaultId);
    await storeBlob(rec);
  });
}

export function listBlobs(vaultId: string): Promise<BlobRecord[]> {
  return serial(async () => {
    if (!(await isOpen(vaultId))) return [];
    const out: BlobRecord[] = [];
    for (const b of await blobMetas()) out.push(await fullBlob(vaultId, b));
    return out;
  });
}

export function listBlobMeta(vaultId: string): Promise<Omit<BlobRecord, 'ct' | 'nonce'>[]> {
  return serial(async () => ((await isOpen(vaultId)) ? (await blobMetas()).map((b) => metaOf(vaultId, b)) : []));
}

export function saveLocalBlob(vaultId: string, id: string, entryId: string, nonce: Uint8Array, ct: Uint8Array): Promise<void> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    if (await bridge().files.read('blobs', id)) return; // already stored (a retried save)
    await storeBlob({ vaultId, id, entryId, nonce, ct, size: ct.length, synced: false });
  });
}

export function deleteLocalBlob(vaultId: string, id: string): Promise<void> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    const cur = (await bridge().files.read('blobs', id)) as StoredBlob | null;
    if (cur?.synced) await queueDeletions([{ kind: 'blob', id }]);
    await removeBlob(id);
  });
}

export function dropBlob(vaultId: string, id: string): Promise<void> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    await removeBlob(id);
  });
}

// ---- settings ------------------------------------------------------------------------------------------

async function readSettings(vaultId: string): Promise<SettingsRecord | null> {
  const raw = (await bridge().files.readDoc('settings')) as Partial<StoredSettings> | null;
  return raw ? { vaultId, sealed: raw.sealed ?? null, dirty: raw.dirty ?? false, rev: raw.rev ?? 0 } : null;
}

export function getSettingsRecord(vaultId: string): Promise<SettingsRecord | null> {
  return serial(async () => ((await isOpen(vaultId)) ? readSettings(vaultId) : null));
}

export function saveLocalSettings(vaultId: string, sealed: Sealed): Promise<void> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    const cur = await readSettings(vaultId);
    await bridge().files.writeDoc('settings', { sealed, dirty: true, rev: (cur?.rev ?? 0) + 1 } satisfies StoredSettings);
  });
}

export function putSettingsRecord(rec: SettingsRecord): Promise<void> {
  return serial(async () => {
    await mustBeOpen(rec.vaultId);
    const { vaultId: _, ...stored } = rec;
    await bridge().files.writeDoc('settings', stored satisfies StoredSettings);
  });
}

// ---- outbox --------------------------------------------------------------------------------------------

export function listOutbox(vaultId: string): Promise<OutboxRecord[]> {
  return serial(async () => ((await isOpen(vaultId)) ? (await readOutbox()).filter((o) => !o.sent).map((o) => ({ vaultId, ...o })) : []));
}

export function removeOutbox(r: OutboxRecord): Promise<void> {
  return serial(async () => {
    await mustBeOpen(r.vaultId);
    const rest = (await readOutbox()).filter((o) => !same(o, r.kind, r.id));
    // A burned entry's record stays as a marker, so the entry can't come back (burnAgain).
    await writeOutbox(r.kind === 'entry' ? [...rest, { kind: r.kind, id: r.id, sent: new Date().toISOString() }] : rest);
  });
}

export function isQueuedForDeletion(vaultId: string, kind: 'entry' | 'blob', id: string): Promise<boolean> {
  return serial(async () => (await isOpen(vaultId)) && (await readOutbox()).some((o) => same(o, kind, id)));
}

export function burnAgain(vaultId: string, id: string): Promise<void> {
  return serial(async () => {
    await mustBeOpen(vaultId);
    const list = await readOutbox();
    if (!list.some((o) => same(o, 'entry', id) && o.sent)) return;
    await writeOutbox(list.map((o) => (same(o, 'entry', id) ? { kind: o.kind, id: o.id } : o)));
  });
}

// ---- size ----------------------------------------------------------------------------------------------

/** As db.ts `journalSize`: the journal the way the server would measure it. */
export function journalSize(vaultId: string): Promise<JournalSize> {
  return serial(async () => {
    if (!(await isOpen(vaultId))) return { entries: 0, textBytes: 0, photos: 0, photoBytes: 0 };
    const all = [...(await entryMap(vaultId)).values()];
    const kept = (await blobMetas()).filter((b) => b.stored);
    const settings = await readSettings(vaultId);
    return {
      entries: all.length,
      textBytes: all.reduce((n, e) => n + sealedBytes(e.header) + sealedBytes(e.body), 0) + sealedBytes(settings?.sealed),
      photos: kept.length,
      // The ciphertext plus its 12-byte nonce, as the browser's copy counts it.
      photoBytes: kept.reduce((n, b) => n + b.size + 12, 0),
    };
  });
}

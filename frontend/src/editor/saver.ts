/**
 * Autosave for one entry (SPEC §8): 800 ms after typing stops, the header and body are encrypted
 * and written to the on-device journal. That never needs the network; sync picks the change up
 * from there. A save still running when the editor closes finishes in the background, and the
 * journal waits for it before locking.
 */
import { encryptEntryPart } from '../crypto/content';
import type { EntryRecord } from '../local/db';
import { emitLocal, saveLocalEntry, withEntryLock } from '../local/repo';
import { requireVault } from '../local/vault';
import type { EntryBody, EntryHeader } from './types';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface SaverCallbacks {
  /** Current plaintext, or null when the entry is empty and was never saved. */
  snapshot: () => { header: EntryHeader; body: EntryBody } | null;
  onStatus: (s: SaveStatus, message?: string) => void;
  onSaved: (rec: EntryRecord, header: EntryHeader) => void;
}

type Snapshot = NonNullable<ReturnType<SaverCallbacks['snapshot']>>;

export const AUTOSAVE_DELAY = 800;

/** Savers with an open editor or a save still running, by entry id. */
const registry = new Map<string, EntrySaver>();

export class EntrySaver {
  private saved: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private dirty = false;
  /** Snapshot taken as the view closed, used instead of asking the (destroyed) editor. */
  private finalSnap: Snapshot | null = null;
  private disposed = false;
  private holders = 0;
  /** A view held it and let go: it goes away once its last save is done. */
  private released = false;
  status: SaveStatus;

  constructor(
    readonly id: string,
    exists: boolean,
    private cb: SaverCallbacks,
  ) {
    this.saved = exists;
    this.status = exists ? 'saved' : 'idle';
  }

  /** The saver for `id`: one still finishing a save from an earlier view, or a new one. */
  static attach(id: string, exists: boolean, cb: SaverCallbacks): EntrySaver {
    const live = registry.get(id);
    if (live && !live.disposed) {
      live.cb = cb;
      return live;
    }
    return new EntrySaver(id, exists, cb);
  }

  /** Whether the entry is stored on this device. */
  get exists(): boolean {
    return this.saved;
  }

  get hasUnsaved(): boolean {
    return this.dirty || this.inflight !== null;
  }

  private setStatus(s: SaveStatus, msg?: string) {
    this.status = s;
    this.cb.onStatus(s, msg);
  }

  /** Call on every edit. */
  change() {
    if (this.disposed) return;
    this.dirty = true;
    this.setStatus('dirty');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.save(), AUTOSAVE_DELAY);
  }

  /** Saves now (if anything is unsaved) and waits for completion. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight;
    if (this.dirty) await this.save();
  }

  /** Makes sure the entry is stored (before images are attached to it). */
  async ensureCreated(): Promise<void> {
    if (this.saved) return;
    this.dirty = true;
    await this.flush();
    if (!this.saved) throw new Error("The entry couldn't be saved yet, so the image wasn't added.");
  }

  /** The editor reloaded the stored copy (sync brought a newer one): nothing is unsaved. */
  rebase() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.saved = true;
    this.setStatus('saved');
  }

  private save(): Promise<void> {
    if (this.inflight) {
      return this.inflight.then(() => (this.dirty ? this.save() : undefined));
    }
    this.inflight = this.doSave().finally(() => {
      this.inflight = null;
      this.releaseIfDone();
    });
    return this.inflight;
  }

  private async doSave(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    const snap = this.finalSnap ?? this.cb.snapshot();
    this.finalSnap = null;
    this.dirty = false;
    if (!snap) {
      this.setStatus(this.saved ? 'saved' : 'idle');
      return;
    }
    this.setStatus('saving');
    try {
      const vaultId = requireVault().id;
      const [header, body] = await Promise.all([encryptEntryPart(this.id, 'header', snap.header), encryptEntryPart(this.id, 'body', snap.body)]);
      const rec = await withEntryLock(this.id, () => saveLocalEntry(vaultId, this.id, header, body));
      this.saved = true;
      this.cb.onSaved(rec, snap.header);
      emitLocal({ type: 'entries', ids: [this.id], origin: 'local' });
      this.setStatus(this.dirty ? 'dirty' : 'saved');
    } catch (e) {
      // Usually storage is full or the journal locked mid-save; the text is still in the editor.
      this.dirty = true;
      this.setStatus('error', e instanceof Error ? e.message : 'Not saved');
    }
  }

  /**
   * Marks the saver as in use by a mounted view. The returned release function takes the view's
   * final snapshot, saves it and reports whether this was the final release (StrictMode mounts,
   * unmounts and remounts components in development).
   */
  retain(): (finalSnapshot?: Snapshot | null) => Promise<boolean> {
    this.holders++;
    this.disposed = false;
    this.released = false;
    this.finalSnap = null;
    registry.set(this.id, this);
    return async (finalSnapshot) => {
      this.holders--;
      if (this.holders === 0 && finalSnapshot && this.dirty) this.finalSnap = finalSnapshot;
      await this.flush();
      if (this.holders > 0) return false;
      this.finalSnap = null;
      this.released = true;
      this.cb = { snapshot: () => null, onStatus: () => {}, onSaved: this.cb.onSaved };
      this.releaseIfDone();
      return true;
    };
  }

  private releaseIfDone() {
    if (this.released && this.holders === 0 && !this.dirty && !this.inflight) this.teardown();
  }

  /** The entry was deleted: drop pending edits and stop saving. */
  abandon() {
    this.dirty = false;
    this.finalSnap = null;
    this.teardown();
  }

  private teardown() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (registry.get(this.id) === this) registry.delete(this.id);
  }

  /** The live saver of an entry, if any (sync asks it to save before taking in a remote copy). */
  static get(id: string): EntrySaver | undefined {
    return registry.get(id);
  }
}

/** True while any entry has edits not yet written to the device. */
export function hasUnsavedDrafts(): boolean {
  for (const s of registry.values()) if (s.hasUnsaved) return true;
  return false;
}

/** Saves every open entry now (before locking). */
export async function flushAll(): Promise<void> {
  await Promise.allSettled([...registry.values()].map((s) => s.flush()));
}

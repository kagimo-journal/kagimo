/**
 * Decrypted entry list (headers only), shared by the sidebar, mobile list and editor, read from
 * the on-device journal. Lives in memory only and is cleared when the journal locks; follows
 * changes that sync brings in.
 */
import { useSyncExternalStore } from 'react';
import { decryptEntryPart } from '../crypto/content';
import { isUnlocked, subscribe as subscribeLock } from '../crypto/session';
import type { EntryRecord } from '../local/db';
import { getEntry, listEntries, onLocalEvent } from '../local/repo';
import { currentVault } from '../local/vault';
import type { EntryHeader } from './types';

export interface EntrySummary {
  id: string;
  createdAt: string;
  /** Last change on this device or pulled in; changes whenever the content does. */
  updatedAt: string;
  version: number;
  header: EntryHeader | null; // null if it couldn't be decrypted
  /** A conflict between devices waits to be settled on this entry. */
  conflict: boolean;
}

async function summarise(r: EntryRecord): Promise<EntrySummary> {
  let header: EntryHeader | null = null;
  try {
    header = await decryptEntryPart<EntryHeader>(r.id, 'header', r.header);
  } catch {
    header = null;
  }
  return { id: r.id, createdAt: r.createdAt, updatedAt: r.updatedAt, version: r.version, header, conflict: !!r.conflict };
}

interface State {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  items: EntrySummary[];
}

let state: State = { status: 'idle', items: [] };
const listeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

subscribeLock(() => {
  if (!isUnlocked()) {
    loadPromise = null;
    set({ status: 'idle', items: [], error: undefined });
  }
});

onLocalEvent((e) => {
  if (e.type === 'entries') void entriesStore.refresh(e.ids).catch(() => {});
  if (e.type === 'entries-reset' && state.status !== 'idle') void entriesStore.load(true);
});

export function sortKey(e: EntrySummary): string {
  const t = e.header?.createdAt ? Date.parse(e.header.createdAt) : NaN;
  return new Date(Number.isNaN(t) ? Date.parse(e.createdAt) : t).toISOString();
}

function sorted(items: EntrySummary[]): EntrySummary[] {
  return [...items].sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
}

export const entriesStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => state,

  load(force = false): Promise<void> {
    if (loadPromise && !force) return loadPromise;
    if (state.status !== 'ready') set({ status: 'loading' });
    loadPromise = (async () => {
      try {
        const v = currentVault();
        if (!v) throw new Error('No journal on this device');
        const items = await Promise.all((await listEntries(v.id)).map(summarise));
        set({ status: 'ready', items: sorted(items), error: undefined });
      } catch (e) {
        loadPromise = null;
        set({ status: state.items.length ? 'ready' : 'error', error: e instanceof Error ? e.message : 'Could not load entries' });
      }
    })();
    return loadPromise;
  },

  /** After a local save: the new header, without decrypting again. */
  upsert(rec: Pick<EntryRecord, 'id' | 'createdAt' | 'updatedAt' | 'version' | 'conflict'>, header: EntryHeader) {
    const merged: EntrySummary = { id: rec.id, version: rec.version, updatedAt: rec.updatedAt, createdAt: rec.createdAt, header, conflict: !!rec.conflict };
    set({ items: sorted([merged, ...state.items.filter((i) => i.id !== rec.id)]) });
  },

  /** Re-reads some entries from the device (sync changed them). */
  async refresh(ids: string[]) {
    const v = currentVault();
    if (!v || state.status === 'idle') return;
    let items = state.items;
    for (const id of ids) {
      const r = await getEntry(v.id, id);
      if (!isUnlocked()) return;
      items = items.filter((i) => i.id !== id);
      if (r) items = [...items, await summarise(r)];
    }
    set({ items: sorted(items) });
  },

  remove(id: string) {
    set({ items: state.items.filter((i) => i.id !== id) });
  },
};

export function useEntries(): State {
  return useSyncExternalStore(entriesStore.subscribe, entriesStore.get);
}

/** Case- and accent-insensitive search over decrypted headers. */
export function searchEntries(items: EntrySummary[], query: string): EntrySummary[] {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((e) => {
    if (!e.header) return false;
    const hay = norm([e.header.title, e.header.snippet, e.header.location?.label ?? ''].join(' '));
    return terms.every((t) => hay.includes(t));
  });
}

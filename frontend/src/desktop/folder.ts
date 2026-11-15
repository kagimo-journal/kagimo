/** Desktop app: which folder the journal is kept in, and switching to another one. */
import { useSyncExternalStore } from 'react';
import { lock } from '../crypto/session';
import { initVault } from '../local/vault';
import { desktop } from './bridge';

/** undefined while loading, null when no folder has been chosen. */
let folder: string | null | undefined = desktop ? undefined : null;
const listeners = new Set<() => void>();

function set(path: string | null) {
  folder = path;
  listeners.forEach((l) => l());
}

export async function initFolder(): Promise<void> {
  if (!desktop) return;
  set((await desktop.folder.current().catch(() => null))?.path ?? null);
}

export function useFolder(): string | null | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => folder,
  );
}

/**
 * Asks for a folder and switches to it: the open journal is saved and locked, then the one in the
 * new folder (if it holds one) is loaded. The journal left behind stays in its folder untouched.
 * Returns false when the dialog was cancelled or the same folder was picked.
 */
export async function chooseFolder(): Promise<boolean> {
  if (!desktop) return false;
  const picked = await desktop.folder.pick();
  if (!picked || picked.path === folder) return false;
  await lock({ full: true });
  await desktop.folder.open();
  set(picked.path);
  await initVault();
  return true;
}

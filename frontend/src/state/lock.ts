import { useSyncExternalStore } from 'react';
import { getVersion, isPinLocked, isUnlocked, subscribe } from '../crypto/session';

/** Re-renders when the journal locks or unlocks. */
export function useUnlocked(): boolean {
  useSyncExternalStore(subscribe, getVersion);
  return isUnlocked();
}

/** True while the journal is locked but its PIN can still open it. Re-renders when that changes. */
export function usePinLocked(): boolean {
  useSyncExternalStore(subscribe, getVersion);
  return isPinLocked();
}

/**
 * Registers the service worker that keeps the app itself available offline (SPEC §10), and
 * reports when a new version is ready. Switching to it reloads the page (the journal stays open), so
 * it only happens when the person chooses to, after open entries are saved.
 */
import { useSyncExternalStore } from 'react';

let waiting: ServiceWorker | null = null;
let updateRequested = false;
let reloading = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function registerServiceWorker() {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only when the person chose to update. The first install also changes the controller
    // (clients.claim), and reloading then would throw away whatever they were doing.
    if (!updateRequested || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        const track = (w: ServiceWorker | null) => {
          if (!w) return;
          w.addEventListener('statechange', () => {
            // A first install isn't an update: only a worker replacing an existing one is.
            if (w.state === 'installed' && navigator.serviceWorker.controller) {
              waiting = w;
              emit();
            }
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) {
          waiting = reg.waiting;
          emit();
        }
        reg.addEventListener('updatefound', () => track(reg.installing));
        // Check for a new version now and then (and whenever the tab comes back).
        setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => {});
        });
      })
      .catch(() => {
        /* no offline support in this browser; the app still works online */
      });
  });
}

export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => waiting !== null,
  );
}

/** Switches to the waiting version (the page reloads when it takes over). */
export function applyUpdate() {
  if (!waiting) return;
  updateRequested = true;
  waiting.postMessage('skip-waiting');
}

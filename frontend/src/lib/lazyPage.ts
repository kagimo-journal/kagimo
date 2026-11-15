import { type ComponentType, lazy } from 'react';

const RELOADED_KEY = 'kagimo.chunkReload';

/**
 * React.lazy for route pages, surviving a deploy. A tab opened before a deploy still asks for the
 * old content-hashed chunk, which no longer exists, and the import fails. Without this the whole
 * app unmounts to a blank screen. Reload once instead, so the new index.html and chunks load; if
 * the import fails again right after that, give up and let the error boundary show it.
 */
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const mod = await load();
      forget();
      return mod;
    } catch (e) {
      if (!alreadyReloaded()) {
        remember();
        window.location.reload();
        return new Promise<never>(() => {}); // keep the fallback up while the page reloads
      }
      forget();
      throw e;
    }
  });
}

function alreadyReloaded(): boolean {
  try {
    return sessionStorage.getItem(RELOADED_KEY) === location.pathname;
  } catch {
    return true; // storage blocked: don't risk a reload loop
  }
}

function remember() {
  try {
    sessionStorage.setItem(RELOADED_KEY, location.pathname);
  } catch {
    /* ignore */
  }
}

function forget() {
  try {
    sessionStorage.removeItem(RELOADED_KEY);
  } catch {
    /* ignore */
  }
}

import { type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}

export const MOBILE_QUERY = '(max-width: 640px)';

/** A non-sensitive UI preference persisted in localStorage (e.g. sidebar open). */
export function useLocalPref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}

/**
 * Sizes a `position: fixed; top: 0` app shell to the visible area on phones, so its header stays
 * on screen with the keyboard up and its content scrolls inside it.
 *
 * iOS doesn't shrink the layout viewport for the keyboard: it pans the visible area (the visual
 * viewport) over the page, which carries anything pinned to the top off screen, and moving the
 * header to follow it lags and drifts. Instead the shell takes the visual viewport's height, and
 * any pan iOS makes is scrolled back to the top. `onResize` runs after a resize so the caller can
 * bring the caret back into view inside the smaller shell.
 */
export function useVisualViewportShell(ref: RefObject<HTMLElement>, enabled: boolean, onResize?: () => void) {
  const resized = useRef(onResize);
  resized.current = onResize;
  useEffect(() => {
    const vv = window.visualViewport;
    const el = ref.current;
    if (!enabled || !vv || !el) return;
    let height = -1;
    const unpan = () => {
      if (vv.scale > 1.01) return; // pinch zoom: leave the user's pan alone
      if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0);
    };
    const resize = () => {
      const h = Math.round(vv.height);
      if (vv.scale <= 1.01 && h !== height) {
        height = h;
        el.style.height = `${h}px`;
        resized.current?.();
      }
      unpan();
    };
    vv.addEventListener('resize', resize);
    vv.addEventListener('scroll', unpan);
    window.addEventListener('scroll', unpan, { passive: true });
    resize();
    return () => {
      vv.removeEventListener('resize', resize);
      vv.removeEventListener('scroll', unpan);
      window.removeEventListener('scroll', unpan);
      el.style.height = '';
    };
  }, [ref, enabled]);
}

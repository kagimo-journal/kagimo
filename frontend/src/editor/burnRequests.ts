/**
 * Lets the entry list ask the open editor to burn its own entry, so the editor can stop its
 * saver and play the full-page burn instead of the list deleting it underneath.
 */
const handlers = new Map<string, () => void>();

export const burnRequests = {
  register(id: string, fn: () => void): () => void {
    handlers.set(id, fn);
    return () => {
      if (handlers.get(id) === fn) handlers.delete(id);
    };
  },
  /** True when an open editor took the request. */
  request(id: string): boolean {
    const fn = handlers.get(id);
    fn?.();
    return !!fn;
  },
};

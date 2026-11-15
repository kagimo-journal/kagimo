/**
 * Image uploads in flight or waiting to be retried, so node views can show progress / failure and
 * the editor can tell whether everything is saved. Uploads live at module level: they keep going
 * (and keep retrying, with backoff and when the browser comes back online) after the editor that
 * started them is closed.
 */
import { errorMessage, isApiError, NetworkError } from '../api/client';

export type UploadState =
  | { state: 'uploading'; entryId: string }
  | { state: 'failed'; entryId: string; error: string; retry: () => void };

interface Task {
  entryId: string;
  run: () => Promise<void>;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  cancelled: boolean;
  stored: boolean;
}

const RETRY_MIN = 5000;
const RETRY_MAX = 60000;

const states = new Map<string, UploadState>();
const tasks = new Map<string, Task>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  listeners.forEach((l) => l());
}

function setState(blobId: string, s: UploadState | null) {
  if (s) states.set(blobId, s);
  else states.delete(blobId);
  emit();
}

/** Offline, server trouble or rate limiting: worth retrying on its own. */
function transient(e: unknown): boolean {
  return e instanceof NetworkError || isApiError(e, 'unavailable') || (isApiError(e) && (e.status >= 500 || e.status === 429));
}

function attempt(blobId: string, task: Task): Promise<void> {
  if (task.inflight) return task.inflight;
  if (task.timer) clearTimeout(task.timer);
  task.timer = null;
  setState(blobId, { state: 'uploading', entryId: task.entryId });
  task.inflight = task
    .run()
    .then(() => {
      task.stored = true;
      if (tasks.get(blobId) === task) tasks.delete(blobId);
      setState(blobId, null);
    })
    .catch((e: unknown) => {
      if (task.cancelled) return;
      task.attempt++;
      setState(blobId, { state: 'failed', entryId: task.entryId, error: errorMessage(e), retry: () => void attempt(blobId, task) });
      if (transient(e)) {
        const delay = Math.min(RETRY_MIN * 2 ** (task.attempt - 1), RETRY_MAX);
        task.timer = setTimeout(() => void attempt(blobId, task), delay);
      }
    })
    .finally(() => {
      task.inflight = null;
    });
  return task.inflight;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    for (const [blobId, task] of tasks) if (!task.inflight) void attempt(blobId, task);
  });
}

export const uploads = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  version: () => version,
  get: (blobId: string) => states.get(blobId),

  /** Starts uploading `blobId` for `entryId`; `run` performs one attempt and is retried on failure. */
  start(blobId: string, entryId: string, run: () => Promise<void>) {
    const task: Task = { entryId, run, attempt: 0, timer: null, inflight: null, cancelled: false, stored: false };
    tasks.set(blobId, task);
    void attempt(blobId, task);
  },

  /** Records a failure that happened before an upload could start (e.g. encryption failed). */
  fail(blobId: string, entryId: string, error: string, retry: () => void) {
    setState(blobId, { state: 'failed', entryId, error, retry });
  },

  /** Images not yet stored on the server (uploading or failed), optionally for one entry. */
  unsaved(entryId?: string): number {
    let n = 0;
    states.forEach((s) => (entryId === undefined || s.entryId === entryId) && n++);
    return n;
  },

  /** Failed images of an entry. */
  failed(entryId: string): number {
    let n = 0;
    states.forEach((s) => s.state === 'failed' && s.entryId === entryId && n++);
    return n;
  },

  /**
   * Stops retrying `blobId` and resolves once any attempt in flight has finished, reporting
   * whether the blob may now exist on the server (so the caller can delete it).
   */
  async cancel(blobId: string): Promise<boolean> {
    const task = tasks.get(blobId);
    tasks.delete(blobId);
    if (!task) {
      const had = states.has(blobId);
      setState(blobId, null);
      return !had;
    }
    task.cancelled = true;
    if (task.timer) clearTimeout(task.timer);
    if (task.inflight) await task.inflight;
    setState(blobId, null);
    return task.stored;
  },

  /** Cancels every upload for an entry (it is being deleted) and waits for those in flight. */
  async cancelEntry(entryId: string): Promise<void> {
    const ids = [...states].filter(([, s]) => s.entryId === entryId).map(([id]) => id);
    await Promise.all(ids.map((id) => uploads.cancel(id)));
  },
};

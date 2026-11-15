/**
 * A record of every request this tab has sent, for Settings → "What this device sent". Kept
 * in memory only (a reload starts it again), and long values are cut short when they are
 * recorded, so the log never holds a whole key, credential or ciphertext.
 */

export interface SentRequest {
  n: number;
  at: number;
  method: string;
  /** Path and query for our own server, the full URL for anything else. */
  url: string;
  /** Size of the request body in bytes; 0 when there was none. */
  bytes: number;
  /** The body as sent, with long strings cut short. Null for no body; a string describes a binary one. */
  body: unknown;
  /** HTTP status, 'failed' when no answer came, null while waiting. */
  status: number | 'failed' | null;
}

const MAX_KEPT = 300;
/** Strings up to this long are kept whole (a username, a code, an id). */
const KEEP_WHOLE = 40;
const KEEP_HEAD = 16;

let log: SentRequest[] = [];
let total = 0;
const listeners = new Set<() => void>();

function changed() {
  log = log.slice();
  for (const l of listeners) l();
}

/** `value` with every string longer than KEEP_WHOLE reduced to its start and its length. */
export function clipLong(value: unknown): unknown {
  if (typeof value === 'string') return value.length > KEEP_WHOLE ? `${value.slice(0, KEEP_HEAD)}… (${value.length} characters)` : value;
  if (Array.isArray(value)) return value.map(clipLong);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipLong(v)]));
  return value;
}

function describe(body: BodyInit | undefined, json: unknown): { bytes: number; body: unknown } {
  if (json !== undefined) return { bytes: new TextEncoder().encode(JSON.stringify(json)).length, body: clipLong(json) };
  if (body == null) return { bytes: 0, body: null };
  if (typeof body === 'string') return { bytes: new TextEncoder().encode(body).length, body: clipLong(body) };
  const size = body instanceof Blob ? body.size : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body.byteLength : null;
  return { bytes: size ?? 0, body: size == null ? 'Data of unknown size' : `Binary data, ${size} bytes` };
}

/**
 * Records a request that is about to be sent. Call the returned function with the HTTP
 * status once the answer arrives, or with 'failed' if none does.
 */
export function recordSent(method: string, url: string, body?: BodyInit, json?: unknown): (status: number | 'failed') => void {
  const entry: SentRequest = { n: ++total, at: Date.now(), method, url, status: null, ...describe(body, json) };
  log.push(entry);
  if (log.length > MAX_KEPT) log.splice(0, log.length - MAX_KEPT);
  changed();
  return (status) => {
    entry.status = status;
    changed();
  };
}

/** The recorded requests, oldest first. A new array whenever anything changes. */
export function sentLog(): SentRequest[] {
  return log;
}

/** How many requests were sent since the page loaded (the log keeps only the last MAX_KEPT). */
export function sentTotal(): number {
  return total;
}

export function subscribeSent(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

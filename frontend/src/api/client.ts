/**
 * Low-level HTTP client. All requests are same-origin and carry `X-Journal: 1` (SPEC §5). In the
 * desktop app there is no server behind the page: the app sends them to the sync server.
 */
import { desktop } from '../desktop/bridge';
import { recordSent } from './sentLog';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Extra fields of the error body besides `error` and `message` (e.g. `lockedUntil`). */
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the request never reached the server (offline, DNS, CORS…). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("Can't reach the server. Check your connection.");
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

type UnauthorizedHandler = (err: ApiError) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** Lets the app react globally when the session disappears (expired, revoked, disabled). */
export function setUnauthorizedHandler(h: UnauthorizedHandler | null) {
  onUnauthorized = h;
}

/**
 * Called when the server answers 403 `second_factor_required`: the account is active but has
 * neither a passkey nor TOTP yet (SPEC §5.1 "Second factor"). The app re-reads /api/me and sends
 * the user to second-factor setup.
 */
let onSecondFactorRequired: ((err: ApiError) => void) | null = null;

export function setSecondFactorHandler(h: ((err: ApiError) => void) | null) {
  onSecondFactorRequired = h;
}

/**
 * Asked to re-confirm the passphrase when the server answers 403 `reauth_required` (security
 * changes need a recent proof of a credential, SPEC §5.1). Resolves true once the session has
 * been re-authenticated, false if the user declined.
 */
type ReauthHandler = () => Promise<boolean>;
let onReauth: ReauthHandler | null = null;
let reauthInFlight: Promise<boolean> | null = null;

export function setReauthHandler(h: ReauthHandler | null) {
  onReauth = h;
}

/** Runs the reauth prompt once for any number of concurrent requests that need it. */
function requestReauth(): Promise<boolean> {
  if (!onReauth) return Promise.resolve(false);
  if (!reauthInFlight) {
    reauthInFlight = onReauth()
      .catch(() => false)
      .finally(() => {
        reauthInFlight = null;
      });
  }
  return reauthInFlight;
}

export interface RequestOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Don't fire the global 401 handler (used by /api/me probing and login flows). */
  quiet401?: boolean;
  /** Don't prompt for re-authentication on `reauth_required` (used by the prompt itself). */
  noReauth?: boolean;
}

/** `503 busy`: the server is at its limit of key hashes at once and did nothing. Tried again this many times. */
const BUSY_RETRIES = 2;

export async function request(path: string, opts: RequestOptions = {}): Promise<Response> {
  for (let attempt = 0; attempt < BUSY_RETRIES; attempt++) {
    try {
      return await attemptRequest(path, opts);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 503 && e.code === 'busy')) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return attemptRequest(path, opts);
}

async function attemptRequest(path: string, opts: RequestOptions): Promise<Response> {
  try {
    return await send(path, opts);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'reauth_required' && !opts.noReauth && (await requestReauth())) {
      return send(path, opts);
    }
    throw e;
  }
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { 'X-Journal': '1', Accept: 'application/json', ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const method = opts.method ?? (body !== undefined ? 'POST' : 'GET');
  const answered = recordSent(method, path, opts.body, opts.json);
  let res: Response;
  try {
    res = desktop
      ? await desktop.api(path, { method, headers, body, signal: opts.signal })
      : await fetch(path, { method, headers, body, credentials: 'same-origin', cache: 'no-store', signal: opts.signal });
  } catch (e) {
    answered('failed');
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new NetworkError(e);
  }
  answered(res.status);
  if (!res.ok) {
    const err = await toApiError(res);
    // Only a missing/revoked session means "signed out"; other 401s (wrong code, wrong
    // passphrase) are ordinary form errors.
    const sessionGone = (err.status === 401 && err.code === 'unauthenticated') || err.code === 'account_disabled';
    if (sessionGone && !opts.quiet401) onUnauthorized?.(err);
    if (err.status === 403 && err.code === 'second_factor_required') onSecondFactorRequired?.(err);
    throw err;
  }
  return res;
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || 'Request failed';
  let extra: Record<string, unknown> = {};
  try {
    const data = (await res.json()) as { error?: string; message?: string } & Record<string, unknown>;
    if (data && typeof data === 'object') {
      const { error, message: m, ...rest } = data;
      if (typeof error === 'string' && error) code = error;
      if (typeof m === 'string' && m) message = m;
      extra = rest;
    }
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 429 && code !== 'totp_locked') message = 'Too many attempts. Wait a minute and try again.';
  if (res.status >= 502 && res.status <= 504) return new ApiError(res.status, 'unavailable', "The server isn't responding right now.");
  return new ApiError(res.status, code, message, extra);
}

export async function getJSON<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, { ...opts, method: 'GET' });
  return (await res.json()) as T;
}

/** Sends JSON and parses a JSON response; returns undefined for empty bodies (204). */
export async function sendJSON<T = void>(method: string, path: string, json?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, { ...opts, method, json: json ?? (method === 'DELETE' ? undefined : {}) });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function isApiError(e: unknown, code?: string, status?: number): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code) && (status === undefined || e.status === status);
}

/** A human message for any error thrown by the API layer or crypto. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof NetworkError) return e.message;
  if (e instanceof DOMException && e.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out.';
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}

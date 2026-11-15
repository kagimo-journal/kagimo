/**
 * In-memory key store. The master key and content key live in this module's scope.
 *
 * Reloading the tab keeps it unlocked: while unlocked, a persistence hook (local/resume.ts) keeps
 * the master key wrapped under a non-extractable key, tied to this tab's session storage, so a
 * reload can reopen it within the inactivity limit. Locking (by hand or for inactivity) deletes
 * that copy; only a reload that follows the unload within seconds can use it, so a closed tab
 * that is reopened later needs the passphrase.
 *
 * With PIN unlock on, locking drops the keys but keeps the PIN-wrapped master key (from the
 * encrypted settings) in memory, so a PIN reopens the journal. That lasts until the journal has been
 * inactive for the configured time, a few wrong PINs, or the tab closing; after that the full
 * passphrase (or a passkey) is needed again.
 */
import { DecryptError } from './aead';
import { deriveContentKey } from './keys';
import { PIN_ATTEMPTS, type PinWrap, unwrapWithPin } from './pin';

/** Default auto-lock after inactivity (the setting overrides it once settings are decrypted). */
export const IDLE_LOCK_MS = 5 * 60 * 1000;

interface Unlocked {
  userId: string;
  mk: Uint8Array;
  ck: CryptoKey;
}

type Listener = () => void;
type BeforeLockHook = () => Promise<void> | void;

/** Keeps the unlocked journal across a reload (see local/resume.ts); null in tests. */
export interface SessionPersistence {
  save(userId: string, mk: Uint8Array): void;
  touch(lastActivity: number): void;
  /** The page is unloading while unlocked: only a prompt reload may use the saved copy. */
  suspend(lastActivity: number): void;
  clear(): void;
}

let state: Unlocked | null = null;
let persistence: SessionPersistence | null = null;
/** False for a journal without a password: there's nothing to lock it with. */
let autoLockEnabled = true;
let version = 0;
const listeners = new Set<Listener>();
const beforeLockHooks = new Set<BeforeLockHook>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivity = 0;
/** null: never lock for inactivity (closing the tab still locks). */
let idleMs: number | null = IDLE_LOCK_MS;

/** PIN unlock as configured in the (decrypted) settings; only set while unlocked. */
let pinConfig: { wrap: PinWrap; graceMs: number } | null = null;
/** Set while the journal is locked but a PIN can still open it. */
let pinLocked: { userId: string; wrap: PinWrap; attemptsLeft: number; until: number } | null = null;
let pinTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  version++;
  for (const l of listeners) l();
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Snapshot value for useSyncExternalStore: changes whenever lock state changes. */
export function getVersion(): number {
  return version;
}

export function isUnlocked(): boolean {
  return state !== null;
}

export function unlockedUserId(): string | null {
  return state?.userId ?? null;
}

/** Puts the master key into memory. The caller's copy is not retained. */
export async function unlock(userId: string | number, mk: Uint8Array): Promise<void> {
  const copy = new Uint8Array(mk);
  const ck = await deriveContentKey(copy);
  if (state) state.mk.fill(0);
  clearPinLock();
  state = { userId: String(userId), mk: copy, ck };
  lastActivity = Date.now();
  startIdleWatch();
  persistence?.save(state.userId, copy);
  emit();
}

export function setSessionPersistence(p: SessionPersistence | null): void {
  persistence = p;
}

/** Turns locking for inactivity on or off (off for a journal without a password). */
export function setAutoLockEnabled(on: boolean): void {
  autoLockEnabled = on;
}

/** The current inactivity limit in ms (null: never). */
export function idleTimeoutMs(): number | null {
  return idleMs;
}

/**
 * Turns PIN unlock on (or off, with null) for the journal that is unlocked now. `graceMs` is how long
 * the journal may sit inactive before a PIN is no longer enough.
 */
export function setPinUnlock(cfg: { wrap: PinWrap; graceMs: number } | null): void {
  pinConfig = cfg;
}

/** True while the journal is locked but its PIN can still open it. */
export function isPinLocked(): boolean {
  return pinLocked !== null && Date.now() < pinLocked.until;
}

export function pinAttemptsLeft(): number {
  return pinLocked?.attemptsLeft ?? 0;
}

export type PinResult = 'ok' | 'wrong' | 'too-many' | 'expired';

/**
 * Tries a PIN. A wrong one uses up an attempt; after the last, or once the inactivity limit has
 * passed, the PIN no longer works ('too-many' / 'expired') and the passphrase is needed.
 */
export async function unlockWithPin(pin: string): Promise<PinResult> {
  const attempt = pinLocked;
  if (!attempt || !isPinLocked()) {
    endPinLock();
    return 'expired';
  }
  // Counted before the (slow) derivation, so attempts made in parallel each use one up.
  attempt.attemptsLeft--;
  try {
    const mk = await unwrapWithPin(pin, attempt.wrap);
    try {
      if (pinLocked !== attempt || Date.now() >= attempt.until) return 'expired';
      await unlock(attempt.userId, mk);
      return 'ok';
    } finally {
      mk.fill(0);
    }
  } catch (e) {
    if (!(e instanceof DecryptError)) throw e;
    if (pinLocked !== attempt) return 'expired';
    if (attempt.attemptsLeft <= 0) {
      endPinLock();
      return 'too-many';
    }
    emit();
    return 'wrong';
  }
}

export function contentKey(): CryptoKey {
  if (!state) throw new LockedError();
  return state.ck;
}

/** Returns a copy of the master key (for re-wrapping). Callers should zero it after use. */
export function masterKeyCopy(): Uint8Array {
  if (!state) throw new LockedError();
  return new Uint8Array(state.mk);
}

export class LockedError extends Error {
  constructor() {
    super('Kagimo is locked');
    this.name = 'LockedError';
  }
}

/** Registers work (e.g. flushing an unsaved draft) to run before the keys are dropped. */
export function onBeforeLock(hook: BeforeLockHook): () => void {
  beforeLockHooks.add(hook);
  return () => beforeLockHooks.delete(hook);
}

/**
 * Locks the journal after running the before-lock hooks. With PIN unlock on (and the inactivity
 * limit not yet reached) the PIN can reopen it; `full: true` always needs the passphrase.
 */
export async function lock(opts: { flush?: boolean; full?: boolean } = {}): Promise<void> {
  if (!state) return;
  if (opts.flush !== false) {
    const hooks = [...beforeLockHooks];
    await Promise.race([
      Promise.allSettled(hooks.map((h) => h())),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  }
  if (!state) return;
  const userId = state.userId;
  const cfg = pinConfig;
  const until = lastActivity + (cfg?.graceMs ?? 0);
  dropKeys();
  persistence?.clear();
  if (cfg && !opts.full && Date.now() < until) startPinLock({ userId, wrap: cfg.wrap, attemptsLeft: PIN_ATTEMPTS, until });
  emit();
}

/** Drops keys synchronously without flushing (tab close / sign-out). The PIN no longer works either. */
export function lockNow(): void {
  persistence?.clear();
  if (!state && !pinLocked) return;
  dropKeys();
  clearPinLock();
  emit();
}

/**
 * The page is unloading (reload, close, navigating away): drop the keys from memory but keep the
 * reload copy, marked with the time, so a prompt reload reopens the journal. A tab closed and
 * restored later can't use it.
 */
export function dropForUnload(): void {
  if (state) persistence?.suspend(lastActivity);
  if (!state && !pinLocked) return;
  dropKeys();
  clearPinLock();
  emit();
}

function dropKeys() {
  if (state) state.mk.fill(0);
  state = null;
  pinConfig = null;
  stopIdleWatch();
}

// ---- PIN lock ---------------------------------------------------------------

function startPinLock(p: NonNullable<typeof pinLocked>) {
  pinLocked = p;
  if (typeof window === 'undefined') return;
  pinTimer = setTimeout(checkPinExpiry, Math.max(0, p.until - Date.now()));
  document.addEventListener('visibilitychange', checkPinExpiry);
  window.addEventListener('pagehide', onPageHide);
}

/** Timers can be throttled in background tabs or while asleep; compare wall-clock time. */
function checkPinExpiry() {
  if (!pinLocked) return;
  if (Date.now() >= pinLocked.until) endPinLock();
  else {
    if (pinTimer) clearTimeout(pinTimer);
    pinTimer = setTimeout(checkPinExpiry, pinLocked.until - Date.now());
  }
}

/** Ends a PIN lock: the passphrase is needed from now on. */
function endPinLock() {
  if (!pinLocked) return;
  clearPinLock();
  emit();
}

function clearPinLock() {
  pinLocked = null;
  if (pinTimer) clearTimeout(pinTimer);
  pinTimer = null;
  if (typeof window === 'undefined') return;
  document.removeEventListener('visibilitychange', checkPinExpiry);
  if (!state) window.removeEventListener('pagehide', onPageHide);
}

export function setIdleTimeout(ms: number | null): void {
  idleMs = ms;
  if (state) scheduleIdle();
}

// ---- idle auto-lock -------------------------------------------------------

/**
 * What counts as activity. Beyond pointer and keys: `input`/`change` (a choice made in a native
 * select's popup, autofill, a password manager filling a field: none of these reach the page as
 * pointer or key events) and `focusin` (tabbing between fields).
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll', 'input', 'change', 'focusin'] as const;

let lastScheduled = 0;

function onActivity() {
  const now = Date.now();
  // Always note the time (cheap); only reschedule now and then, since mousemove fires constantly.
  lastActivity = now;
  if (now - lastScheduled < 5000) return;
  lastScheduled = now;
  scheduleIdle();
  persistence?.touch(now);
}

function scheduleIdle(delay = idleMs) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = idleMs === null || delay === null ? null : setTimeout(checkIdle, Math.max(1000, delay));
}

function checkIdle() {
  if (idleMs === null) return;
  if (!autoLockEnabled) return scheduleIdle();
  // Timers can be throttled in background tabs; compare wall-clock time.
  const idleFor = Date.now() - lastActivity;
  if (idleFor >= idleMs - 1000) {
    void lock();
  } else {
    scheduleIdle(idleMs - idleFor);
  }
}

function onVisibility() {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'visible' && state && autoLockEnabled && idleMs !== null && Date.now() - lastActivity >= idleMs) {
    void lock();
  }
}

function onPageHide(e: PageTransitionEvent) {
  // Entering the back/forward cache must not keep keys around.
  if (e.persisted) dropForUnload();
}

function startIdleWatch() {
  if (typeof window === 'undefined') return;
  lastActivity = lastScheduled = Date.now();
  for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true, capture: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  scheduleIdle();
}

function stopIdleWatch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (typeof window === 'undefined') return;
  for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, { capture: true });
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
}

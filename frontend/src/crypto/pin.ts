/**
 * PIN unlock (SPEC §3). The master key wrapped under a key derived from a short PIN. The wrap is
 * stored only inside the encrypted settings (so reading it already needs the content key), and while
 * the journal is PIN-locked it is held in memory alone; nothing PIN-related is written in plain.
 */
import { type Sealed, open, seal } from './aead';
import { type Bytes, fromBase64, randomBytes, toBase64 } from './encoding';
import { argon2Root, DEFAULT_KDF } from './kdf';

export interface PinWrap {
  /** Argon2id salt (standard base64); the parameters are SPEC §3's defaults. */
  salt: string;
  nonce: string;
  ct: string;
}

/** Shortest PIN that can be set. */
export const PIN_MIN = 6;
/** Shortest PIN that can be entered: PINs set before the minimum was raised still open the journal. */
export const PIN_MIN_ENTRY = 4;
export const PIN_MAX = 8;
/** Wrong PINs allowed before the PIN stops working and the passphrase is needed. */
export const PIN_ATTEMPTS = 5;

const AAD_PIN = 'pin-unlock:v1';

/** Returns why a PIN can't be used, or null if it's fine. */
export function pinProblem(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return 'Use digits only.';
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) return `Use ${PIN_MIN} to ${PIN_MAX} digits.`;
  if (/^(\d)\1+$/.test(pin)) return "That's the same digit repeated. Choose something harder to guess.";
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) {
    return "That's a simple sequence. Choose something harder to guess.";
  }
  return null;
}

async function pinKey(pin: string, salt: string): Promise<CryptoKey> {
  const raw = await argon2Root(pin, { salt, ...DEFAULT_KDF });
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

export async function wrapWithPin(pin: string, mk: Uint8Array): Promise<PinWrap> {
  const salt = toBase64(randomBytes(16));
  const key = await pinKey(pin, salt);
  const sealed = await seal(key, mk, AAD_PIN);
  return { salt, ...sealed };
}

/** Throws DecryptError if the PIN is wrong. */
export async function unwrapWithPin(pin: string, wrap: PinWrap): Promise<Bytes> {
  const key = await pinKey(pin, wrap.salt);
  return open(key, { nonce: wrap.nonce, ct: wrap.ct } satisfies Sealed, AAD_PIN);
}

export function isPinWrap(v: unknown): v is PinWrap {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  if (typeof w.salt !== 'string' || typeof w.nonce !== 'string' || typeof w.ct !== 'string') return false;
  try {
    return fromBase64(w.salt).length === 16 && fromBase64(w.nonce).length === 12 && fromBase64(w.ct).length === 48;
  } catch {
    return false;
  }
}

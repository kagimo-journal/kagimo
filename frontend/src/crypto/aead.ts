import { type Bytes, fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from './encoding';

/** Ciphertext object as it appears in JSON: standard base64 with padding. */
export interface Sealed {
  nonce: string;
  ct: string;
}

export class DecryptError extends Error {
  constructor(message = 'Decryption failed (wrong key or tampered data)') {
    super(message);
    this.name = 'DecryptError';
  }
}

export interface RawSealed {
  nonce: Bytes;
  ct: Bytes;
}

/** AES-256-GCM with a fresh random 96-bit nonce and the given AAD string. */
export async function sealBytes(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<RawSealed> {
  const nonce = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 },
    key,
    new Uint8Array(plaintext),
  );
  return { nonce, ct: new Uint8Array(ct) };
}

export async function openBytes(key: CryptoKey, nonce: Uint8Array, ct: Uint8Array, aad: string): Promise<Bytes> {
  if (nonce.length !== 12) throw new DecryptError('Invalid nonce length');
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(nonce), additionalData: utf8(aad), tagLength: 128 },
      key,
      new Uint8Array(ct),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError();
  }
}

export async function seal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<Sealed> {
  const { nonce, ct } = await sealBytes(key, plaintext, aad);
  return { nonce: toBase64(nonce), ct: toBase64(ct) };
}

export async function open(key: CryptoKey, sealed: Sealed, aad: string): Promise<Bytes> {
  if (!sealed || typeof sealed.nonce !== 'string' || typeof sealed.ct !== 'string') {
    throw new DecryptError('Malformed ciphertext object');
  }
  return openBytes(key, fromBase64(sealed.nonce), fromBase64(sealed.ct), aad);
}

export async function sealJSON(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  const bytes = utf8(JSON.stringify(value));
  try {
    return await seal(key, bytes, aad);
  } finally {
    bytes.fill(0);
  }
}

export async function openJSON<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  const bytes = await open(key, sealed, aad);
  try {
    return JSON.parse(fromUtf8(bytes)) as T;
  } finally {
    bytes.fill(0);
  }
}

/**
 * Accepts a wrapped-key value from the server. The canonical shape is a {nonce, ct}
 * object; a JSON string of that object is tolerated too.
 */
export function asSealed(v: unknown): Sealed {
  let val = v;
  if (typeof val === 'string') {
    try {
      val = JSON.parse(val);
    } catch {
      throw new DecryptError('Malformed wrapped key');
    }
  }
  if (val && typeof val === 'object' && 'nonce' in val && 'ct' in val) {
    const s = val as Sealed;
    if (typeof s.nonce === 'string' && typeof s.ct === 'string') return s;
  }
  throw new DecryptError('Malformed wrapped key');
}

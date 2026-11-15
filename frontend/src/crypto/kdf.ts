import { argon2id } from 'hash-wasm';
import { type Bytes, fromBase64, randomBytes, toBase64, utf8 } from './encoding';

/** KDF parameters exactly as exchanged with the server (salt is standard base64). */
export interface KdfParams {
  salt: string;
  m: number;
  t: number;
  p: number;
}

/** Argon2id parameters from SPEC §3: m=64 MiB, t=3, p=1. */
export const DEFAULT_KDF = { m: 65536, t: 3, p: 1 } as const;

export function newKdfParams(): KdfParams {
  return { salt: toBase64(randomBytes(16)), ...DEFAULT_KDF };
}

/**
 * Bounds for KDF parameters received from the server (SPEC §3). The floor is the spec's own
 * parameters: a hostile or compromised server could otherwise answer prelogin with cheap
 * parameters (e.g. m=8, t=1) and brute-force the authKey it receives offline. The ceiling
 * stops a server from making the browser allocate unbounded memory.
 */
export const KDF_LIMITS = { minM: 65536, maxM: 1 << 20, minT: 3, maxT: 16, minP: 1, maxP: 16, minSalt: 16, maxSalt: 64 } as const;

export class KdfParamsError extends Error {
  constructor() {
    super('The server sent unsafe key-derivation settings, so your passphrase was not used. Contact the administrator.');
    this.name = 'KdfParamsError';
  }
}

/** Returns the decoded salt if `kdf` is within KDF_LIMITS; throws KdfParamsError otherwise. */
export function checkKdfParams(kdf: KdfParams): Bytes {
  const L = KDF_LIMITS;
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  let salt: Bytes;
  try {
    salt = fromBase64(kdf.salt);
  } catch {
    throw new KdfParamsError();
  }
  if (!int(kdf.m, L.minM, L.maxM) || !int(kdf.t, L.minT, L.maxT) || !int(kdf.p, L.minP, L.maxP) || salt.length < L.minSalt || salt.length > L.maxSalt) {
    throw new KdfParamsError();
  }
  return salt;
}

/** root = Argon2id(passphrase, salt, m, t, p, len=32). Refuses parameters outside KDF_LIMITS. */
export async function argon2Root(passphrase: string, kdf: KdfParams): Promise<Bytes> {
  const salt = checkKdfParams(kdf);
  const out = await argon2id({
    password: utf8(passphrase.normalize('NFC')),
    salt,
    memorySize: kdf.m,
    iterations: kdf.t,
    parallelism: kdf.p,
    hashLength: 32,
    outputType: 'binary',
  });
  return new Uint8Array(out);
}

const EMPTY = new Uint8Array(0);

async function hkdfBase(ikm: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(ikm), 'HKDF', false, ['deriveBits', 'deriveKey']);
}

/** HKDF-SHA256. `salt` of null/empty means "no salt" (RFC 5869: HashLen zero bytes). */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array | string | null,
  info: Uint8Array | string,
  length = 32,
): Promise<Bytes> {
  const base = await hkdfBase(ikm);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt == null ? EMPTY : typeof salt === 'string' ? utf8(salt) : new Uint8Array(salt),
      info: typeof info === 'string' ? utf8(info) : new Uint8Array(info),
    },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Derives a non-extractable AES-256-GCM key via HKDF-SHA256. */
export async function hkdfAesKey(
  ikm: Uint8Array,
  salt: Uint8Array | string | null,
  info: string,
): Promise<CryptoKey> {
  const raw = await hkdf(ikm, salt, info, 32);
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

export async function sha256(data: Uint8Array | string): Promise<Bytes> {
  const input = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

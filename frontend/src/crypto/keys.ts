/**
 * Key hierarchy (SPEC §3). Everything here runs in the browser only.
 *
 *   passphrase --argon2id--> root --HKDF--> authKey (sent to server)
 *                                  \--HKDF--> kek  --AES-GCM--> wrappedMkPass
 *   recovery bytes --HKDF(salt=journal/recovery/v1)--> recoveryAuthKey, recKek
 *   passkey PRF output --HKDF--> prfKek
 *   MK --HKDF--> content key (entries, blobs, settings)
 */
import { asSealed, open, seal, type Sealed } from './aead';
import { type Bytes, randomBytes } from './encoding';
import { argon2Root, hkdf, hkdfAesKey, type KdfParams, sha256 } from './kdf';

export const INFO_AUTH = 'journal/auth/v1';
export const INFO_KEK = 'journal/kek/v1';
export const INFO_PRF_KEK = 'journal/prf-kek/v1';
export const INFO_CONTENT = 'journal/content/v1';
export const RECOVERY_SALT = 'journal/recovery/v1';
export const PRF_SALT_LABEL = 'journal/prf-salt/v1';
export const AAD_MK = 'journal/mk/v1';

export const aad = {
  entryHeader: (entryId: string) => `entry:${entryId}:header`,
  entryBody: (entryId: string) => `entry:${entryId}:body`,
  blob: (blobId: string) => `blob:${blobId}`,
  settings: (userId: string | number) => `settings:${userId}`,
};

export interface PassphraseKeys {
  authKey: Bytes;
  kek: CryptoKey;
}

export async function derivePassphraseKeys(passphrase: string, kdf: KdfParams): Promise<PassphraseKeys> {
  const root = await argon2Root(passphrase, kdf);
  try {
    const authKey = await hkdf(root, null, INFO_AUTH, 32);
    const kek = await hkdfAesKey(root, null, INFO_KEK);
    return { authKey, kek };
  } finally {
    root.fill(0);
  }
}

export async function deriveRecoveryKeys(recRoot: Uint8Array): Promise<PassphraseKeys> {
  const authKey = await hkdf(recRoot, RECOVERY_SALT, 'auth', 32);
  const kek = await hkdfAesKey(recRoot, RECOVERY_SALT, 'kek');
  return { authKey, kek };
}

let prfSaltCache: Promise<Bytes> | null = null;
/** Constant PRF salt for all credentials: SHA-256("journal/prf-salt/v1"). */
export function prfSalt(): Promise<Bytes> {
  prfSaltCache ??= sha256(PRF_SALT_LABEL);
  return prfSaltCache;
}

export function derivePrfKek(prfOutput: Uint8Array): Promise<CryptoKey> {
  return hkdfAesKey(prfOutput, null, INFO_PRF_KEK);
}

export function generateMasterKey(): Bytes {
  return randomBytes(32);
}

export function wrapMasterKey(kek: CryptoKey, mk: Uint8Array): Promise<Sealed> {
  return seal(kek, mk, AAD_MK);
}

export async function unwrapMasterKey(kek: CryptoKey, wrapped: unknown): Promise<Bytes> {
  const mk = await open(kek, asSealed(wrapped), AAD_MK);
  if (mk.length !== 32) throw new Error('Unexpected master key length');
  return mk;
}

export function deriveContentKey(mk: Uint8Array): Promise<CryptoKey> {
  return hkdfAesKey(mk, null, INFO_CONTENT);
}

/**
 * Encrypted image storage. Decrypted images only ever exist as in-memory object URLs. Each URL is
 * reference-counted by the views showing it and revoked shortly after the last one goes away, and
 * all of them are revoked when the journal locks.
 */
import { decryptBlob, encryptBlob } from '../crypto/content';
import { deleteLocalBlob, emitLocal, saveLocalBlob } from '../local/repo';
import { requireVault } from '../local/vault';
import { loadBlobCipher } from './source';
import { subscribe as subscribeLock, isUnlocked } from '../crypto/session';
import { processImage, type ProcessedImage, sniffImageType } from './process';

/** How long an unused object URL is kept (an entry re-opened right away needn't re-decrypt). */
const REVOKE_GRACE_MS = 30_000;
/**
 * How long a removed image's ciphertext is kept before it is deleted. Long enough for
 * an image cut from one entry to be pasted into another, which copies it (see copyImage).
 */
const DELETE_GRACE_MS = 2 * 60_000;

interface CachedUrl {
  url: Promise<string>;
  refs: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const cache = new Map<string, CachedUrl>();
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

function revokeEntry(blobId: string, entry: CachedUrl) {
  if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
  if (cache.get(blobId) === entry) cache.delete(blobId);
  entry.url.then((u) => URL.revokeObjectURL(u)).catch(() => {});
}

function scheduleRevoke(blobId: string, entry: CachedUrl) {
  if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
  entry.revokeTimer = setTimeout(() => {
    if (entry.refs <= 0) revokeEntry(blobId, entry);
  }, REVOKE_GRACE_MS);
}

function cacheUrl(blobId: string, url: Promise<string>): CachedUrl {
  const previous = cache.get(blobId);
  if (previous) revokeEntry(blobId, previous);
  const entry: CachedUrl = { url, refs: 0, revokeTimer: null };
  cache.set(blobId, entry);
  url.catch(() => {
    if (cache.get(blobId) === entry) cache.delete(blobId);
  });
  scheduleRevoke(blobId, entry);
  return entry;
}

subscribeLock(() => {
  if (isUnlocked()) return;
  for (const [id, entry] of [...cache]) revokeEntry(id, entry);
});

async function fetchDecrypted(blobId: string): Promise<Uint8Array> {
  const { nonce, ct } = await loadBlobCipher(blobId);
  return decryptBlob(blobId, nonce, ct);
}

function objectUrl(bytes: Uint8Array, type = sniffImageType(bytes)): string {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
}

/**
 * Returns an object URL for a decrypted image, fetching and decrypting it at most once while it is
 * in use. Every call must be paired with releaseImageUrl().
 */
export function acquireImageUrl(blobId: string): Promise<string> {
  let entry = cache.get(blobId);
  if (!entry) entry = cacheUrl(blobId, fetchDecrypted(blobId).then((b) => objectUrl(b)));
  entry.refs++;
  if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
  entry.revokeTimer = null;
  return entry.url;
}

export function releaseImageUrl(blobId: string) {
  const entry = cache.get(blobId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0) scheduleRevoke(blobId, entry);
}

export interface PreparedImage extends ProcessedImage {
  blobId: string;
}

/** Ciphertext of an image, ready to upload (and to re-upload after a failure). */
export interface SealedImage {
  blobId: string;
  nonce: Uint8Array;
  ct: Uint8Array;
}

/** Re-encodes (strips metadata) and makes a local preview; nothing leaves the device yet. */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const img = await processImage(file);
  const blobId = crypto.randomUUID();
  cacheUrl(blobId, Promise.resolve(objectUrl(img.bytes, img.mime)));
  return { ...img, blobId };
}

/**
 * Encrypts a prepared image once and wipes the plaintext bytes, so retries never need the
 * content key (or keep plaintext around) again.
 */
export async function sealImage(img: PreparedImage): Promise<SealedImage> {
  try {
    const { nonce, ct } = await encryptBlob(img.blobId, img.bytes);
    return { blobId: img.blobId, nonce, ct };
  } finally {
    img.bytes.fill(0);
  }
}

/** Stores sealed image bytes for an entry on this device (sync uploads them later). */
export async function sendImage(entryId: string, img: SealedImage): Promise<void> {
  await saveLocalBlob(requireVault().id, img.blobId, entryId, img.nonce, img.ct);
  emitLocal({ type: 'blobs', ids: [img.blobId] });
}

/**
 * Copies an existing image under a new blob ID (used when an image is pasted from another entry:
 * each blob belongs to exactly one entry and is deleted with it). The returned ID can be shown
 * right away; `seal()` resolves to the re-encrypted copy for upload.
 */
export function copyImage(sourceBlobId: string): { blobId: string; seal: () => Promise<SealedImage> } {
  const blobId = crypto.randomUUID();
  // The source ciphertext is still stored: removed images are only deleted after a grace period
  // (deleteImageLater). Object URLs can't be read back under the CSP (connect-src 'self').
  const first = fetchDecrypted(sourceBlobId);
  cacheUrl(blobId, first.then((b) => objectUrl(b)));
  let bytes: Promise<Uint8Array> | null = first;
  let sealed: Promise<SealedImage> | null = null;
  // Retried uploads call seal() again: a failed fetch or encryption is attempted afresh, a
  // successful one is reused.
  const seal = () => {
    if (!sealed) {
      const source = bytes ?? fetchDecrypted(sourceBlobId);
      bytes = null;
      sealed = source.then(async (b) => {
        try {
          const { nonce, ct } = await encryptBlob(blobId, b);
          return { blobId, nonce, ct };
        } finally {
          b.fill(0);
        }
      });
      sealed.catch(() => {
        sealed = null;
      });
    }
    return sealed;
  };
  return { blobId, seal };
}

/** Deletes an image's ciphertext (here, and on the server with the next sync) and forgets its decrypted copy. */
export async function deleteImage(blobId: string): Promise<void> {
  const timer = pendingDeletes.get(blobId);
  if (timer) clearTimeout(timer);
  pendingDeletes.delete(blobId);
  await deleteLocalBlob(requireVault().id, blobId);
  emitLocal({ type: 'blobs', ids: [blobId] });
  const entry = cache.get(blobId);
  if (entry && entry.refs === 0) revokeEntry(blobId, entry);
}

/** Deletes an image after DELETE_GRACE_MS, unless cancelled (e.g. it was pasted back). */
export function deleteImageLater(blobId: string) {
  if (pendingDeletes.has(blobId)) return;
  pendingDeletes.set(
    blobId,
    setTimeout(() => {
      pendingDeletes.delete(blobId);
      void deleteImage(blobId).catch(() => {});
    }, DELETE_GRACE_MS),
  );
}

/** Keeps an image that was scheduled for deletion (it is in use again). */
export function cancelImageDelete(blobId: string) {
  const timer = pendingDeletes.get(blobId);
  if (timer) clearTimeout(timer);
  pendingDeletes.delete(blobId);
}

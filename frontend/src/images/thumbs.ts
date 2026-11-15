/**
 * Timeline thumbnails: an entry's first image (header `coverBlobId`), read as ciphertext,
 * decrypted, downscaled to 264×200 (the 132×100 card at 2×) and kept only in memory as an object
 * URL. All of them are revoked when the journal locks. Nothing new is stored anywhere.
 */
import { decryptBlob } from '../crypto/content';
import { isUnlocked, subscribe as subscribeLock } from '../crypto/session';
import { sniffImageType } from './process';
import { loadBlobCipher } from './source';

export const THUMB_WIDTH = 264;
export const THUMB_HEIGHT = 200;
const MAX_PARALLEL = 3;

const cache = new Map<string, Promise<string>>();
let generation = 0;
let running = 0;
const queue: (() => void)[] = [];

function runLimited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < MAX_PARALLEL) start();
    else queue.push(start);
  });
}

async function downscale(bytes: Uint8Array): Promise<Blob> {
  const source = new Blob([new Uint8Array(bytes)], { type: sniffImageType(bytes) });
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, Math.max(THUMB_WIDTH / bitmap.width, THUMB_HEIGHT / bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const cw = Math.min(w, THUMB_WIDTH);
    const ch = Math.min(h, THUMB_HEIGHT);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.imageSmoothingQuality = 'high';
    // Centre crop to the card's shape.
    ctx.drawImage(bitmap, (cw - w) / 2, (ch - h) / 2, w, h);
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    canvas.width = canvas.height = 0;
    if (!out) throw new Error('Could not make a thumbnail');
    return out;
  } finally {
    bitmap.close();
  }
}

/** Object URL of a blob's thumbnail; decrypted at most once while unlocked. */
export function thumbnailUrl(blobId: string): Promise<string> {
  const hit = cache.get(blobId);
  if (hit) return hit;
  const gen = generation;
  const p = runLimited(async () => {
    const { nonce, ct } = await loadBlobCipher(blobId);
    const bytes = await decryptBlob(blobId, nonce, ct);
    try {
      const small = await downscale(bytes);
      if (gen !== generation) throw new Error('Locked');
      return URL.createObjectURL(small);
    } finally {
      bytes.fill(0);
    }
  });
  cache.set(blobId, p);
  p.catch(() => {
    if (cache.get(blobId) === p) cache.delete(blobId);
  });
  return p;
}

export function clearThumbnails(): void {
  generation++;
  for (const p of cache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  cache.clear();
}

subscribeLock(() => {
  if (!isUnlocked()) clearThumbnails();
});

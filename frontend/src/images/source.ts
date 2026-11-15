/** Where image ciphertext comes from: the device, or (synced journals) the server on first use. */
import { getBlob } from '../local/repo';
import { requireVault } from '../local/vault';
import { fetchBlobToLocal } from '../sync/engine';

export async function loadBlobCipher(blobId: string): Promise<{ nonce: Uint8Array; ct: Uint8Array }> {
  const v = requireVault();
  const b = await getBlob(v.id, blobId);
  if (b?.ct && b.nonce) return { nonce: b.nonce, ct: b.ct };
  // Synced but not downloaded yet (sync fetches images in the background; this one is wanted now).
  if (v.account) return fetchBlobToLocal(v.id, blobId);
  throw new Error('This image isn’t on this device.');
}

/** Encryption of journal content with the in-memory content key. */
import { openBytes, openJSON, type RawSealed, sealBytes, sealJSON, type Sealed } from './aead';
import { aad } from './keys';
import { contentKey } from './session';

export function encryptEntryPart<T>(entryId: string, part: 'header' | 'body', value: T): Promise<Sealed> {
  return sealJSON(contentKey(), value, part === 'header' ? aad.entryHeader(entryId) : aad.entryBody(entryId));
}

export function decryptEntryPart<T>(entryId: string, part: 'header' | 'body', sealed: Sealed): Promise<T> {
  return openJSON<T>(contentKey(), sealed, part === 'header' ? aad.entryHeader(entryId) : aad.entryBody(entryId));
}

export function encryptSettings<T>(userId: string, value: T): Promise<Sealed> {
  return sealJSON(contentKey(), value, aad.settings(userId));
}

export function decryptSettings<T>(userId: string, sealed: Sealed): Promise<T> {
  return openJSON<T>(contentKey(), sealed, aad.settings(userId));
}

export function encryptBlob(blobId: string, data: Uint8Array): Promise<RawSealed> {
  return sealBytes(contentKey(), data, aad.blob(blobId));
}

export function decryptBlob(blobId: string, nonce: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  return openBytes(contentKey(), nonce, ct, aad.blob(blobId));
}

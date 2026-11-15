/**
 * Taking another device's copy of an entry into this one (SPEC §5.2 "Conflicts"). Untouched local
 * copies are simply replaced; copies with unpushed changes are merged three ways (see merge.ts);
 * overlapping edits are kept as a conflict for the person to settle on the entry itself.
 *
 * An entry open in an editor is never changed underneath it: the remote copy waits in `incoming`
 * until the editor has saved its last keystrokes and asks for it (integrateIncoming).
 */
import type { JSONContent } from '@tiptap/react';
import { DecryptError, type Sealed } from '../crypto/aead';
import { decryptBlob, decryptEntryPart, encryptBlob, encryptEntryPart } from '../crypto/content';
import { loadBlobCipher } from '../images/source';
import type { EntryRecord, RemoteCopy } from '../local/db';
import { burnAgain, dropEntry, emitLocal, getEntry, isQueuedForDeletion, putEntry, saveLocalBlob, saveLocalEntry, withEntryLock } from '../local/repo';
import type { EntryBody, EntryHeader } from '../editor/types';
import { blocksOf, mergeBlocks, mergeHeader, resolveSegments, withBodyStats } from './merge';

export type IntegrateResult = 'none' | 'replaced' | 'merged' | 'conflict' | 'deleted';

// ---- entries held open by an editor ------------------------------------------------------------------

const held = new Map<string, number>();

/** Marks an entry as open in an editor; returns the release function. */
export function holdEntry(id: string): () => void {
  held.set(id, (held.get(id) ?? 0) + 1);
  return () => {
    const n = (held.get(id) ?? 1) - 1;
    if (n <= 0) held.delete(id);
    else held.set(id, n);
  };
}

export const isHeld = (id: string) => held.has(id);

// ---- decrypting ------------------------------------------------------------------------------------------

export interface Plain {
  header: EntryHeader;
  doc: JSONContent;
}

export async function decryptCopy(id: string, c: { header: Sealed; body: Sealed }): Promise<Plain> {
  const [header, body] = await Promise.all([
    decryptEntryPart<EntryHeader>(id, 'header', c.header),
    decryptEntryPart<EntryBody>(id, 'body', c.body),
  ]);
  return { header, doc: body.doc };
}

export async function encryptCopy(id: string, p: Plain): Promise<{ header: Sealed; body: Sealed }> {
  const [header, body] = await Promise.all([
    encryptEntryPart(id, 'header', p.header),
    encryptEntryPart(id, 'body', { v: 1, doc: p.doc } satisfies EntryBody),
  ]);
  return { header, body };
}

// ---- receiving -------------------------------------------------------------------------------------------

export interface RemoteEntry extends RemoteCopy {
  id: string;
  createdAt: string;
}

const fromRemote = (vaultId: string, r: RemoteEntry, rev = 0): EntryRecord => ({
  vaultId,
  id: r.id,
  header: r.header,
  body: r.body,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  version: r.version,
  base: { header: r.header, body: r.body },
  dirty: false,
  rev,
  incoming: null,
  conflict: null,
});

/** A copy of an entry from the server (change feed, or the current one after a 409). */
export async function receiveRemote(vaultId: string, remote: RemoteEntry): Promise<IntegrateResult> {
  return withEntryLock(remote.id, async () => {
    const local = await getEntry(vaultId, remote.id);
    if (!local) {
      // Burned here: the burn wins, whether its deletion is still waiting or was sent long ago
      // and the server has the entry again (a restored backup, a replay). Then it's deleted again.
      if (await isQueuedForDeletion(vaultId, 'entry', remote.id)) {
        await burnAgain(vaultId, remote.id);
        return 'none';
      }
      await putEntry(fromRemote(vaultId, remote));
      emitLocal({ type: 'entries', ids: [remote.id], origin: 'sync' });
      return 'replaced';
    }
    const known = Math.max(local.version, local.conflict?.theirs?.version ?? 0, local.incoming?.version ?? 0);
    if (remote.version <= known) return 'none';
    if (isHeld(remote.id)) {
      await putEntry({ ...local, incoming: { header: remote.header, body: remote.body, version: remote.version, updatedAt: remote.updatedAt } });
      emitLocal({ type: 'incoming', id: remote.id });
      return 'none';
    }
    const res = await integrate(local, remote);
    emitLocal({ type: 'entries', ids: [remote.id], origin: 'sync' });
    return res;
  });
}

/** Called by an open editor (after saving its last edits) to take in a waiting remote copy. */
export async function integrateIncoming(vaultId: string, id: string): Promise<IntegrateResult> {
  return withEntryLock(id, async () => {
    const local = await getEntry(vaultId, id);
    if (!local?.incoming) return 'none';
    const res = await integrate({ ...local, incoming: null }, { id, createdAt: local.createdAt, ...local.incoming });
    emitLocal({ type: 'entries', ids: [id], origin: 'sync' });
    return res;
  });
}

async function integrate(local: EntryRecord, remote: RemoteEntry): Promise<IntegrateResult> {
  const remoteCopy: RemoteCopy = { header: remote.header, body: remote.body, version: remote.version, updatedAt: remote.updatedAt };
  if (local.conflict) {
    // Still unresolved: the newest copy from the other side replaces the one shown.
    await putEntry({
      ...local,
      incoming: null,
      version: remote.version,
      base: { header: remote.header, body: remote.body },
      conflict: { ...local.conflict, kind: 'edit', theirs: remoteCopy },
    });
    return 'conflict';
  }
  if (!local.dirty) {
    // Never swap a copy that opens for one that doesn't (a damaged or tampered row on the
    // server): keep ours, and queue it to replace the server's.
    try {
      await decryptCopy(local.id, remote);
    } catch (e) {
      if (!(e instanceof DecryptError)) throw e;
      await putEntry({ ...local, incoming: null, version: remote.version, dirty: true });
      return 'none';
    }
    await putEntry(fromRemote(local.vaultId, remote, local.rev));
    return 'replaced';
  }

  const id = local.id;
  const [mine, theirs, base] = await Promise.all([
    decryptCopy(id, local),
    decryptCopy(id, remote),
    local.base ? decryptCopy(id, local.base) : Promise.resolve(null),
  ]);
  const mineIsNewer = Date.parse(local.updatedAt) >= Date.parse(remote.updatedAt);
  const header = mergeHeader(base?.header ?? null, mine.header, theirs.header, mineIsNewer);
  const body = mergeBlocks(blocksOf(base?.doc), blocksOf(mine.doc), blocksOf(theirs.doc));
  const now = new Date().toISOString();

  if (!body.clean) {
    await putEntry({
      ...local,
      incoming: null,
      version: remote.version,
      base: { header: remote.header, body: remote.body },
      conflict: { theirs: remoteCopy, base: local.base, kind: 'edit' },
      dirty: true,
    });
    return 'conflict';
  }
  const doc = resolveSegments(body.segments, []);
  const merged = withBodyStats(header, doc);
  const sameAsTheirs = JSON.stringify(merged) === JSON.stringify(theirs.header) && JSON.stringify(doc) === JSON.stringify(theirs.doc);
  if (sameAsTheirs) {
    await putEntry(fromRemote(local.vaultId, remote, local.rev + 1));
    return 'replaced';
  }
  const sealed = await encryptCopy(id, { header: merged, doc });
  await putEntry({
    ...local,
    ...sealed,
    incoming: null,
    updatedAt: now,
    version: remote.version,
    base: { header: remote.header, body: remote.body },
    dirty: true,
    rev: local.rev + 1,
  });
  return 'merged';
}

/** The entry was deleted on the server. Unpushed changes here keep it, as a conflict. */
export async function receiveRemoteDelete(vaultId: string, id: string): Promise<IntegrateResult> {
  return withEntryLock(id, async () => {
    const local = await getEntry(vaultId, id);
    if (!local) return 'none';
    // Someone has it open (possibly mid-sentence): keep it and let them decide.
    if (!local.dirty && !local.conflict && !isHeld(id)) {
      await dropEntry(vaultId, id);
      emitLocal({ type: 'entries', ids: [id], origin: 'sync' });
      return 'deleted';
    }
    await putEntry({ ...local, incoming: null, version: 0, base: null, conflict: { theirs: null, base: local.base, kind: 'deleted' }, dirty: true });
    emitLocal({ type: 'entries', ids: [id], origin: 'sync' });
    return 'conflict';
  });
}

// ---- resolving ---------------------------------------------------------------------------------------------

/** Saves the version the person settled on; the next push sends it. */
export async function resolveConflict(vaultId: string, id: string, result: Plain): Promise<void> {
  const sealed = await encryptCopy(id, { header: withBodyStats(result.header, result.doc), doc: result.doc });
  await withEntryLock(id, async () => {
    const local = await getEntry(vaultId, id);
    if (!local) return;
    const theirs = local.conflict?.theirs ?? null;
    await putEntry({
      ...local,
      ...sealed,
      conflict: null,
      incoming: null,
      dirty: true,
      rev: local.rev + 1,
      updatedAt: new Date().toISOString(),
      version: theirs ? theirs.version : 0,
      base: theirs ? { header: theirs.header, body: theirs.body } : null,
    });
  });
  emitLocal({ type: 'entries', ids: [id], origin: 'local' });
}

/**
 * "Keep both as separate entries": stores `copy` as a new entry. Its images are copied too, under
 * new ids (every image belongs to exactly one entry, SPEC §5).
 */
export async function saveAsNewEntry(vaultId: string, copy: Plain): Promise<string> {
  const newId = crypto.randomUUID();
  const ids = new Map<string, string>();
  const walk = (n: JSONContent) => {
    if (n.type === 'encryptedImage' && typeof n.attrs?.blobId === 'string') {
      if (!ids.has(n.attrs.blobId)) ids.set(n.attrs.blobId, crypto.randomUUID());
    }
    n.content?.forEach(walk);
  };
  walk(copy.doc);
  for (const [from, to] of ids) {
    try {
      const { nonce, ct } = await loadBlobCipher(from);
      const bytes = await decryptBlob(from, nonce, ct);
      const sealed = await encryptBlob(to, bytes);
      bytes.fill(0);
      await saveLocalBlob(vaultId, to, newId, sealed.nonce, sealed.ct);
    } catch {
      ids.delete(from); // not available: the copy shows it as missing
    }
  }
  const remap = (n: JSONContent): JSONContent => {
    const next: JSONContent = { ...n };
    if (n.type === 'encryptedImage' && typeof n.attrs?.blobId === 'string' && ids.has(n.attrs.blobId)) {
      next.attrs = { ...n.attrs, blobId: ids.get(n.attrs.blobId) };
    }
    if (n.content) next.content = n.content.map(remap);
    return next;
  };
  const doc = remap(copy.doc);
  const sealed = await encryptCopy(newId, { header: withBodyStats(copy.header, doc), doc });
  await saveLocalEntry(vaultId, newId, sealed.header, sealed.body);
  emitLocal({ type: 'entries', ids: [newId], origin: 'local' });
  return newId;
}

/** "It was deleted elsewhere, and that's right": drop this device's copy too. */
export async function acceptRemoteDelete(vaultId: string, id: string): Promise<void> {
  await withEntryLock(id, () => dropEntry(vaultId, id));
  emitLocal({ type: 'entries', ids: [id], origin: 'local' });
}

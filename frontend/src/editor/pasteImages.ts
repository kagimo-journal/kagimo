import { Fragment, type Node as PMNode, Slice } from '@tiptap/pm/model';

/**
 * Drops every `encryptedImage` in a pasted (or dropped) slice whose blob does not belong to this
 * entry. Each blob is owned by one entry and deleted with it, and new photos can no longer be
 * stored, so an image pasted from another entry can't be copied in: it is left out. Images moved
 * within the same entry (cut and paste, drag) keep their blob.
 */
export function dropForeignImages(slice: Slice, isOwn: (blobId: string) => boolean): Slice {
  const map = (frag: Fragment): Fragment => {
    let changed = false;
    const nodes: PMNode[] = [];
    frag.forEach((node) => {
      const blobId = node.attrs.blobId as unknown;
      if (node.type.name === 'encryptedImage' && !(typeof blobId === 'string' && blobId && isOwn(blobId))) {
        changed = true;
      } else if (node.childCount > 0) {
        const content = map(node.content);
        nodes.push(content === node.content ? node : node.copy(content));
        changed ||= content !== node.content;
      } else {
        nodes.push(node);
      }
    });
    return changed ? Fragment.fromArray(nodes) : frag;
  };
  const content = map(slice.content);
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
}

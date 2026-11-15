import type { JSONContent } from '@tiptap/react';
import { countWords } from '../lib/format';

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule']);

/** Plain text of a ProseMirror JSON doc, blocks separated by newlines. */
export function docText(doc: JSONContent | null | undefined): string {
  if (!doc) return '';
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === 'text' && n.text) out.push(n.text);
    else if (n.type === 'hardBreak') out.push('\n');
    n.content?.forEach(walk);
    if (n.type && BLOCKS.has(n.type)) out.push('\n');
  };
  walk(doc);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

export function collectBlobIds(doc: JSONContent | null | undefined): string[] {
  const ids: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === 'encryptedImage' && typeof n.attrs?.blobId === 'string') ids.push(n.attrs.blobId);
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return ids;
}

export function snippetOf(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

export function docStats(doc: JSONContent) {
  const text = docText(doc);
  const blobs = collectBlobIds(doc);
  return { text, snippet: snippetOf(text), wordCount: countWords(text), imageCount: blobs.length, coverBlobId: blobs[0] ?? null };
}

export function isDocEmpty(doc: JSONContent): boolean {
  return !docText(doc) && collectBlobIds(doc).length === 0;
}

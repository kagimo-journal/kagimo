import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { formatLongDate, formatShortDateTime, formatTime } from '../lib/format';

/**
 * Automatic "came back later" dividers (SPEC §4, settings `returnDividers`): writing more at the end
 * of an entry after a long enough pause puts a section divider, stamped with the time, between the
 * earlier writing and the new.
 */

/** How long an entry must sit untouched before new writing at its end gets a divider. */
export const RETURN_GAP_MS = 3 * 60 * 60_000;

/** Where the earlier writing ends: the last top-level block that isn't an empty paragraph. */
interface Anchor {
  /** Inside a textblock: the end of its text. Otherwise: the position just after the block. */
  pos: number;
  textblock: boolean;
  rule: boolean;
}

function isBlank(node: PMNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

function endOfWriting(doc: PMNode): Anchor | null {
  let offset = doc.content.size;
  for (let i = doc.childCount - 1; i >= 0; i--) {
    const node = doc.child(i);
    offset -= node.nodeSize;
    if (isBlank(node)) continue;
    return node.isTextblock
      ? { pos: offset + 1 + node.content.size, textblock: true, rule: false }
      : { pos: offset + node.nodeSize, textblock: false, rule: node.type.name === 'horizontalRule' };
  }
  return null;
}

export type DividerResult =
  /** The divider was added (the transaction carries it). */
  | { kind: 'added'; tr: Transaction }
  /** Only empty space was added at the end so far (e.g. Enter): decide on the next change. */
  | { kind: 'wait' }
  /** The change wasn't new writing at the end (an edit further up, a deletion): no divider this time. */
  | { kind: 'skip' };

/**
 * Given a change from `before` to `after`, adds a divider stamped `at` between the earlier writing
 * and what was just written after it, if that change was new writing at the end of the entry.
 */
export function returnDivider(before: EditorState, after: EditorState, at: string): DividerResult {
  const anchor = endOfWriting(before.doc);
  if (!anchor || anchor.rule) return { kind: 'skip' };
  const doc = after.doc;
  if (doc.content.size < anchor.pos) return { kind: 'skip' };
  // Everything up to the end of the earlier writing must be as it was.
  if (!doc.cut(0, anchor.pos).eq(before.doc.cut(0, anchor.pos))) return { kind: 'skip' };
  const added = doc.textBetween(anchor.pos, doc.content.size, '\n', '￼');
  if (!added.trim()) return { kind: 'wait' };

  const rule = after.schema.nodes.horizontalRule.create({ at });
  const tr = after.tr;
  let insertAt = anchor.pos;
  if (anchor.textblock) {
    // Typed straight on from the last line: the new words become a paragraph of their own.
    const $end = doc.resolve(anchor.pos);
    const blockEnd = $end.end();
    if (blockEnd > anchor.pos) {
      const tail = doc.textBetween(anchor.pos, blockEnd, '\n', '￼');
      const lead = tail.length - tail.trimStart().length;
      if (lead) tr.delete(anchor.pos, anchor.pos + lead);
      if (lead < tail.length) tr.split(anchor.pos);
    }
    insertAt = anchor.pos + 1;
  }
  tr.insert(insertAt, rule);
  return { kind: 'added', tr };
}

/** The stamp as shown: "21:40" on the entry's own day, "Thu · 13 Nov · 09:05" on a later one. */
export function dividerLabel(at: string, entry: { createdAt: string; tz: string | null }): string {
  const sameDay = formatLongDate(at, entry.tz) === formatLongDate(entry.createdAt, entry.tz);
  return sameDay ? formatTime(at, entry.tz) : formatShortDateTime(at, entry.tz);
}

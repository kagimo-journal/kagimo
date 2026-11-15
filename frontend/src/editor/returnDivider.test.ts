import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { dividerLabel, returnDivider } from './returnDividerRule';
import { ReturnDivider } from './ReturnDivider';

const schema = getSchema([StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, horizontalRule: false }), ReturnDivider]);
const AT = '2026-11-12T21:40:00+00:00';

const p = (text?: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
const hr = (at?: string) => ({ type: 'horizontalRule', ...(at ? { attrs: { at } } : {}) });

function stateOf(...blocks: object[]) {
  return EditorState.create({ schema, doc: schema.nodeFromJSON({ type: 'doc', content: blocks }) });
}

/** Applies an edit and runs the divider logic on it, returning the resulting doc as JSON blocks. */
function edit(before: EditorState, change: (tr: Transaction) => Transaction) {
  const after = before.apply(change(before.tr));
  const r = returnDivider(before, after, AT);
  const final = r.kind === 'added' ? after.apply(r.tr) : after;
  return { kind: r.kind, blocks: final.doc.toJSON().content, state: final };
}

/** End of the text in the n-th top-level block. */
function endOf(doc: PMNode, n: number) {
  let pos = 0;
  for (let i = 0; i < n; i++) pos += doc.child(i).nodeSize;
  return pos + 1 + doc.child(n).content.size;
}

describe('returnDivider', () => {
  it('splits new words typed straight on from the last line into a paragraph after a stamped divider', () => {
    const s = stateOf(p('First.'), p('Last line.'));
    const at = endOf(s.doc, 1);
    const r = edit(s, (tr) => tr.insertText(' Back again', at));
    expect(r.kind).toBe('added');
    expect(r.blocks).toEqual([p('First.'), p('Last line.'), hr(AT), p('Back again')]);
  });

  it('keeps the cursor after the new words', () => {
    const s = stateOf(p('Last line.'));
    const at = endOf(s.doc, 0);
    const r = edit(s, (tr) => tr.insertText('X', at).setSelection(TextSelection.create(tr.doc, at + 1)));
    const { $from } = r.state.selection;
    expect($from.parent.textContent).toBe('X');
    expect($from.parentOffset).toBe(1);
  });

  it('waits on Enter, then puts the divider before the new paragraph once something is written', () => {
    const s = stateOf(p('Last line.'));
    const at = endOf(s.doc, 0);
    const enter = edit(s, (tr) => tr.split(at));
    expect(enter.kind).toBe('wait');
    const typed = returnDivider(s, enter.state.apply(enter.state.tr.insertText('Later', at + 2)), AT);
    expect(typed.kind).toBe('added');
    const after = enter.state.apply(enter.state.tr.insertText('Later', at + 2));
    if (typed.kind !== 'added') throw new Error();
    expect(after.apply(typed.tr).doc.toJSON().content).toEqual([p('Last line.'), hr(AT), p('Later')]);
  });

  it('uses a trailing empty paragraph for the new writing', () => {
    const s = stateOf(p('Last line.'), p());
    const at = endOf(s.doc, 1);
    const r = edit(s, (tr) => tr.insertText('Hi', at));
    expect(r.blocks).toEqual([p('Last line.'), hr(AT), p('Hi')]);
  });

  it('goes after a list that ends the entry', () => {
    const list = { type: 'bulletList', content: [{ type: 'listItem', content: [p('one')] }] };
    const s = stateOf(list, p());
    const at = s.doc.child(0).nodeSize + 1;
    const r = edit(s, (tr) => tr.insertText('After', at));
    expect(r.blocks).toEqual([list, hr(AT), p('After')]);
  });

  it('skips edits further up the entry', () => {
    const s = stateOf(p('First.'), p('Last line.'));
    expect(edit(s, (tr) => tr.insertText('!', 3)).kind).toBe('skip');
  });

  it('skips deleting at the end', () => {
    const s = stateOf(p('Last line.'));
    const at = endOf(s.doc, 0);
    expect(edit(s, (tr) => tr.delete(at - 1, at)).kind).toBe('skip');
  });

  it('skips when the entry already ends with a divider', () => {
    const s = stateOf(p('Last line.'), hr(), p());
    const at = endOf(s.doc, 2);
    expect(edit(s, (tr) => tr.insertText('Hi', at)).kind).toBe('skip');
  });

  it('skips an empty entry', () => {
    const s = stateOf(p());
    expect(edit(s, (tr) => tr.insertText('Hi', 1)).kind).toBe('skip');
  });

  it('waits on a space typed at the end, and drops it from the new paragraph', () => {
    const s = stateOf(p('Last line.'));
    const at = endOf(s.doc, 0);
    expect(edit(s, (tr) => tr.insertText(' ', at)).kind).toBe('wait');
    expect(edit(s, (tr) => tr.insertText('  So', at)).blocks).toEqual([p('Last line.'), hr(AT), p('So')]);
  });
});

describe('dividerLabel', () => {
  const entry = { createdAt: '2026-11-12T08:15:00+00:00', tz: 'Europe/London' };
  it('shows just the time on the entry’s day', () => {
    expect(dividerLabel('2026-11-12T21:40:00+00:00', entry)).toBe('21:40');
  });
  it('adds the day on a later one', () => {
    expect(dividerLabel('2026-11-13T09:05:00+00:00', entry)).toBe('Fri · 13 Nov · 09:05');
  });
});

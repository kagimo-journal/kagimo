/**
 * Formatting for the entry editor: the extra TipTap extensions (highlight, alignment), paragraph
 * styles for the style picker, and the keyboard shortcuts that aren't TipTap defaults.
 */
import { type Editor, Extension } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { NodeSelection, type EditorState } from '@tiptap/pm/state';

export type BlockStyle = 'title' | 'heading' | 'subheading' | 'body' | 'quote' | 'bulleted' | 'numbered';

export const BLOCK_STYLES: { value: BlockStyle; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'heading', label: 'Heading' },
  { value: 'subheading', label: 'Subheading' },
  { value: 'body', label: 'Body' },
  { value: 'quote', label: 'Quote' },
  { value: 'bulleted', label: 'Bulleted list' },
  { value: 'numbered', label: 'Numbered list' },
];

const HEADING_LEVEL: Partial<Record<BlockStyle, 1 | 2 | 3>> = { title: 1, heading: 2, subheading: 3 };

/** The style of the block holding the cursor: its own heading level, else its nearest list or quote. */
export function currentBlockStyle(state: EditorState): BlockStyle {
  const { $from } = state.selection;
  if ($from.parent.type.name === 'heading') {
    const level = $from.parent.attrs.level as number;
    return level === 1 ? 'title' : level === 2 ? 'heading' : 'subheading';
  }
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'bulletList') return 'bulleted';
    if (name === 'orderedList') return 'numbered';
    if (name === 'blockquote') return 'quote';
  }
  return 'body';
}

/** Whether paragraph styles and alignment apply (not while an image is selected). */
export function canStyleBlocks(editor: Editor): boolean {
  return editor.isEditable && !(editor.state.selection instanceof NodeSelection);
}

/**
 * Makes the selected blocks exactly `style`: lists and quotes are taken apart first, so picking
 * "Heading" inside a list leaves a heading rather than a list of headings. Centring is kept.
 */
export function applyBlockStyle(editor: Editor, style: BlockStyle): boolean {
  if (!canStyleBlocks(editor) || currentBlockStyle(editor.state) === style) return false;
  const centred = editor.state.selection.$from.parent.attrs.textAlign === 'center';
  const chain = editor.chain().focus().clearNodes();
  const level = HEADING_LEVEL[style];
  if (level) chain.setHeading({ level });
  else if (style === 'quote') chain.setBlockquote();
  else if (style === 'bulleted') chain.toggleBulletList();
  else if (style === 'numbered') chain.toggleOrderedList();
  if (centred && (level || style === 'body')) chain.setTextAlign('center');
  return chain.run();
}

export function isCentred(editor: Editor): boolean {
  return editor.isActive({ textAlign: 'center' });
}

export const editorHighlight = Highlight.configure({ multicolor: false });

/**
 * Left and centre only, on paragraphs and headings; Mod-Shift-L / Mod-Shift-E. Left is the
 * default and is stored as no attribute at all, so only centred blocks carry `textAlign`.
 * (TipTap's Mod-Shift-R / Mod-Shift-J are not bound, so the browser's reload keeps working.)
 */
export const editorTextAlign = TextAlign.extend({
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-l': () => this.editor.commands.unsetTextAlign(),
      'Mod-Shift-e': () => this.editor.commands.setTextAlign('center'),
    };
  },
}).configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center'], defaultAlignment: null });

export interface FormatKeysOptions {
  /** Mod-K: add, edit or remove a link. */
  onLink: () => void;
  /** Mod-/: the Keyboard shortcuts dialog. */
  onHelp: () => void;
  /** Alt-F10: move focus to the format bar. */
  onToolbar: () => void;
}

/**
 * Shortcuts beyond TipTap's defaults (bold, italic, highlight, lists, quote, undo/redo keep theirs).
 * Paragraph styles *set* the style, like the style picker, rather than toggling it. (AltGr, which
 * Windows reports as Ctrl+Alt, still types its characters: ProseMirror's keymap doesn't map
 * Ctrl+Alt+<character> back to the digit key there.)
 */
export const FormatKeys = Extension.create<FormatKeysOptions>({
  name: 'formatKeys',
  priority: 1000,

  addOptions() {
    return { onLink: () => undefined, onHelp: () => undefined, onToolbar: () => undefined };
  },

  addKeyboardShortcuts() {
    const style = (s: BlockStyle) => () => {
      applyBlockStyle(this.editor, s);
      // Claim the key even when the block already has that style.
      return canStyleBlocks(this.editor);
    };
    const divider = () => this.editor.chain().focus().setHorizontalRule().run();
    return {
      'Mod-Alt-0': style('body'),
      'Mod-Alt-1': style('title'),
      'Mod-Alt-2': style('heading'),
      'Mod-Alt-3': style('subheading'),
      'Mod-Shift-Enter': divider,
      'Mod-Alt--': divider,
      'Mod-k': () => {
        this.options.onLink();
        return true;
      },
      'Mod-/': () => {
        this.options.onHelp();
        return true;
      },
      'Alt-F10': () => {
        this.options.onToolbar();
        return true;
      },
    };
  },
});

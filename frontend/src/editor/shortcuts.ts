/**
 * Editor keyboard shortcuts: one table for the key bindings' documentation, the toolbar tooltips,
 * `aria-keyshortcuts` and the Keyboard shortcuts dialog. Keys use ProseMirror's notation
 * (`Mod` = ⌘ on Apple platforms, Ctrl elsewhere).
 */

export const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export type ShortcutId =
  | 'bold'
  | 'italic'
  | 'highlight'
  | 'link'
  | 'body'
  | 'title'
  | 'heading'
  | 'subheading'
  | 'quote'
  | 'bulleted'
  | 'numbered'
  | 'alignLeft'
  | 'alignCenter'
  | 'divider'
  | 'undo'
  | 'redo'
  | 'toolbar'
  | 'help';

export interface Shortcut {
  id: ShortcutId;
  label: string;
  group: 'Text' | 'Paragraph styles' | 'Layout' | 'Editing';
  /** The first combination is the one shown; the others are alternatives. */
  keys: string[];
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'bold', label: 'Bold', group: 'Text', keys: ['Mod-b'] },
  { id: 'italic', label: 'Italic', group: 'Text', keys: ['Mod-i'] },
  { id: 'highlight', label: 'Highlight', group: 'Text', keys: ['Mod-Shift-h'] },
  { id: 'link', label: 'Add or edit link', group: 'Text', keys: ['Mod-k'] },
  { id: 'body', label: 'Body', group: 'Paragraph styles', keys: ['Mod-Alt-0'] },
  { id: 'title', label: 'Title', group: 'Paragraph styles', keys: ['Mod-Alt-1'] },
  { id: 'heading', label: 'Heading', group: 'Paragraph styles', keys: ['Mod-Alt-2'] },
  { id: 'subheading', label: 'Subheading', group: 'Paragraph styles', keys: ['Mod-Alt-3'] },
  { id: 'quote', label: 'Quote', group: 'Paragraph styles', keys: ['Mod-Shift-b'] },
  { id: 'bulleted', label: 'Bulleted list', group: 'Paragraph styles', keys: ['Mod-Shift-8'] },
  { id: 'numbered', label: 'Numbered list', group: 'Paragraph styles', keys: ['Mod-Shift-7'] },
  { id: 'alignLeft', label: 'Align left', group: 'Layout', keys: ['Mod-Shift-l'] },
  { id: 'alignCenter', label: 'Align centre', group: 'Layout', keys: ['Mod-Shift-e'] },
  { id: 'divider', label: 'Section divider', group: 'Layout', keys: ['Mod-Shift-Enter', 'Mod-Alt--'] },
  { id: 'undo', label: 'Undo', group: 'Editing', keys: ['Mod-z'] },
  { id: 'redo', label: 'Redo', group: 'Editing', keys: ['Mod-Shift-z'] },
  { id: 'toolbar', label: 'Move to the format bar', group: 'Editing', keys: ['Alt-F10'] },
  { id: 'help', label: 'Keyboard shortcuts', group: 'Editing', keys: ['Mod-/'] },
];

export function shortcut(id: ShortcutId): Shortcut {
  return SHORTCUTS.find((s) => s.id === id)!;
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const KEY_NAMES: Record<string, [apple: string, other: string]> = { Enter: ['↩', 'Enter'], '-': ['-', 'Minus'], '/': ['/', '/'] };

function parse(combo: string): { mods: string[]; key: string } {
  const parts = combo.split(/-(?!$)/);
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] };
}

function keyLabel(key: string, apple: boolean): string {
  const named = KEY_NAMES[key];
  if (named) return apple ? named[0] : named[1];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Human-readable form for the current platform: "⌘⇧H" on Apple devices, "Ctrl+Shift+H" elsewhere. */
export function formatKeys(combo: string, apple = IS_APPLE): string {
  const { mods, key } = parse(combo);
  if (apple) {
    const sorted = [...mods].sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
    return sorted.map((m) => MAC_SYMBOLS[m] ?? m).join('') + keyLabel(key, true);
  }
  return [...mods.map((m) => (m === 'Mod' ? 'Ctrl' : m)), keyLabel(key, false)].join('+');
}

/** `aria-keyshortcuts` value (WAI-ARIA key names), all alternatives space-separated. */
export function ariaKeys(id: ShortcutId, apple = IS_APPLE): string {
  return shortcut(id)
    .keys.map((combo) => {
      const { mods, key } = parse(combo);
      const names = mods.map((m) => (m === 'Mod' ? (apple ? 'Meta' : 'Control') : m === 'Ctrl' ? 'Control' : m));
      return [...names, key.length === 1 ? key.toUpperCase() : key].join('+');
    })
    .join(' ');
}

/** Tooltip text, e.g. "Bold (Ctrl+B)". */
export function withKeys(label: string, id: ShortcutId): string {
  return `${label} (${formatKeys(shortcut(id).keys[0])})`;
}

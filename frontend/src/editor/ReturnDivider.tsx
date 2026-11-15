import HorizontalRule from '@tiptap/extension-horizontal-rule';
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { NodeViewWrapper, type NodeViewProps, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { localIsoWithOffset } from '../lib/format';
import { dividerLabel, RETURN_GAP_MS, returnDivider } from './returnDividerRule';

export interface ReturnDividerOptions {
  /** Whether new automatic dividers are added (settings `returnDividers`); read on each change. */
  enabled: () => boolean;
  /** When the entry last changed before it was opened (ms since epoch); null for a new entry. */
  lastChanged: number | null;
  /** The entry's date and time zone, so a stamp on a later day shows the day too. */
  entry: () => { createdAt: string; tz: string };
  /** "Turn off" in a divider's "What's this?" popover. */
  onTurnOff: () => void;
}

const key = new PluginKey('returnDivider');

/**
 * The section divider (`horizontalRule`), with an optional `at` stamp: dividers added automatically
 * when writing resumes at the end of an entry after RETURN_GAP_MS carry the time and show it.
 */
export const ReturnDivider = HorizontalRule.extend<ReturnDividerOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      enabled: () => false,
      lastChanged: null,
      entry: () => ({ createdAt: new Date().toISOString(), tz: 'UTC' }),
      onTurnOff: () => {},
    };
  },

  addAttributes() {
    return {
      at: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-at'),
        renderHTML: (attrs: Record<string, unknown>) => (typeof attrs.at === 'string' ? { 'data-at': attrs.at } : {}),
      },
    };
  },

  addNodeView() {
    const stamped = ReactNodeViewRenderer(DividerView);
    // Plain dividers keep their plain <hr>; only stamped ones need the time and the popover.
    return (props) => {
      if (typeof props.node.attrs.at === 'string') return stamped(props);
      const dom = document.createElement('hr');
      const type = props.node.type;
      return { dom, update: (n) => n.type === type && typeof n.attrs.at !== 'string' };
    };
  },

  addProseMirrorPlugins() {
    const opts = this.options;
    let last = opts.lastChanged ?? Date.now();
    let armed = false;
    /** While waiting for words after the end (only Enter or spaces so far): the state before that began. */
    let from: EditorState | null = null;
    return [
      new Plugin({
        key,
        appendTransaction: (trs, before, after) => {
          const changes = trs.filter((t) => t.docChanged);
          if (!changes.length) return null;
          // Changes taken in from another device, and our own divider, aren't writing here.
          if (changes.some((t) => t.getMeta('preventUpdate') || t.getMeta(key))) return null;
          const now = Date.now();
          if (now - last >= RETURN_GAP_MS) armed = true;
          last = now;
          if (!armed) return null;
          if (!opts.enabled()) {
            armed = false;
            from = null;
            return null;
          }
          const r = returnDivider(from ?? before, after, localIsoWithOffset(new Date(now)));
          if (r.kind === 'wait') {
            from ??= before;
            return null;
          }
          armed = false;
          from = null;
          return r.kind === 'added' ? r.tr.setMeta(key, true) : null;
        },
      }),
    ];
  },
});

function DividerView({ node, editor, extension, selected, deleteNode }: NodeViewProps) {
  const opts = extension.options as ReturnDividerOptions;
  const at = node.attrs.at as string | null;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const why = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  if (!at) return <NodeViewWrapper as="div"><hr /></NodeViewWrapper>;

  const close = () => {
    setOpen(false);
    why.current?.focus();
  };
  const enabled = opts.enabled();
  return (
    <NodeViewWrapper
      as="div"
      ref={wrap}
      className={`return-divider${selected ? ' is-selected' : ''}${open ? ' is-open' : ''}`}
      contentEditable={false}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (open && e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <hr />
      <span className="return-divider-meta">
        <time dateTime={at}>{dividerLabel(at, opts.entry())}</time>
        {editor.isEditable && (
          <button ref={why} type="button" className="return-divider-why" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            What's this?
          </button>
        )}
      </span>
      {open && (
        <div className="return-divider-pop" role="group" aria-label="Automatic divider">
          <p>
            {enabled
              ? 'You came back to this entry after a few hours, so a divider marks where the new writing starts, with the time.'
              : 'Added when you came back to this entry after a few hours. Automatic dividers are off now; you can turn them on again in Settings → Appearance → Entry details.'}
          </p>
          <div className="return-divider-actions">
            {enabled && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                autoFocus
                onClick={() => {
                  setOpen(false);
                  opts.onTurnOff();
                }}
              >
                Turn off
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              autoFocus={!enabled}
              onClick={() => {
                setOpen(false);
                deleteNode();
                editor.commands.focus();
              }}
            >
              Remove this one
            </button>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

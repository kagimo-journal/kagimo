import { posToDOMRect } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlignCenterIcon, AlignLeftIcon, ChevronDownIcon, CheckIcon, HighlightIcon, LinkIcon } from '../../components/Icons';
import { applyBlockStyle, BLOCK_STYLES, type BlockStyle, canStyleBlocks, currentBlockStyle, isCentred } from '../../editor/formatting';
import { ariaKeys, formatKeys, shortcut, type ShortcutId, withKeys } from '../../editor/shortcuts';

function normaliseUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // javascript:, data: etc. are not allowed
  return `https://${v}`;
}

interface FormatButtonProps {
  label: string;
  active?: boolean;
  onClick: () => void;
  keys?: ShortcutId;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/** A toolbar button that keeps the editor's selection (and focus) when clicked. */
function FormatButton({ label, active, onClick, keys, disabled, className = '', children }: FormatButtonProps) {
  return (
    <button
      type="button"
      data-tb-item
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={keys ? ariaKeys(keys) : undefined}
      title={keys ? withKeys(label, keys) : label}
      disabled={disabled}
      className={`${className}${active ? ' on' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <span className="tb-sep" role="separator" aria-orientation="vertical" />;
}

/**
 * Roving tabindex for a role="toolbar": one Tab stop, Left/Right/Home/End between controls,
 * Escape back to the text.
 */
function useRovingToolbar(ref: RefObject<HTMLDivElement>, editor: Editor) {
  const current = useRef(0);
  const items = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-tb-item]') ?? []).filter((el) => !(el as HTMLButtonElement).disabled);
  const settle = (i: number) => {
    const els = items();
    current.current = Math.max(0, Math.min(i, els.length - 1));
    els.forEach((el, n) => {
      el.tabIndex = n === current.current ? 0 : -1;
    });
  };

  // Controls come and go (disabled while an image is selected), so re-apply after every render.
  useLayoutEffect(() => settle(current.current));

  const onFocus = (e: React.FocusEvent) => {
    const i = items().indexOf(e.target as HTMLElement);
    if (i >= 0) settle(i);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      editor.commands.focus();
      return;
    }
    const els = items();
    const i = els.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const next =
      e.key === 'ArrowRight' ? (i + 1) % els.length
        : e.key === 'ArrowLeft' ? (i - 1 + els.length) % els.length
          : e.key === 'Home' ? 0
            : e.key === 'End' ? els.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    els[next].focus();
  };
  return { onFocus, onKeyDown };
}

/** Focuses a format bar's current control (Alt+F10 from the editor). */
export function focusToolbar(ref: RefObject<HTMLDivElement>) {
  ref.current?.querySelector<HTMLElement>('[data-tb-item][tabindex="0"]')?.focus();
}

/** Paragraph style picker (desktop): a button that opens a listbox of styles, each set in its own style. */
function StylePicker({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = currentBlockStyle(editor.state);
  const label = BLOCK_STYLES.find((s) => s.value === current)!.label;

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const onDoc = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]);

  const show = () => {
    setActive(BLOCK_STYLES.findIndex((s) => s.value === current));
    setOpen(true);
  };
  const choose = (style: BlockStyle) => {
    setOpen(false);
    if (!applyBlockStyle(editor, style)) editor.commands.focus();
  };
  const onListKey = (e: React.KeyboardEvent) => {
    const n = BLOCK_STYLES.length;
    const move = (i: number) => {
      e.preventDefault();
      setActive(i);
    };
    if (e.key === 'ArrowDown') move((active + 1) % n);
    else if (e.key === 'ArrowUp') move((active - 1 + n) % n);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(BLOCK_STYLES[active].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
    // Left/Right belong to the listbox while it is open, not to the toolbar.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
  };

  return (
    <div className="style-picker" ref={wrap}>
      <button
        ref={btn}
        type="button"
        data-tb-item
        className="style-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`Paragraph style: ${label}`}
        title="Paragraph style"
        disabled={!canStyleBlocks(editor)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            show();
          }
        }}
      >
        <span>{label}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          className="style-list"
          role="listbox"
          tabIndex={-1}
          aria-label="Paragraph style"
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onListKey}
        >
          {BLOCK_STYLES.map((s, i) => (
            <li
              key={s.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={s.value === current}
              className={`style-opt style-${s.value}${i === active ? ' active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(s.value)}
            >
              <span className="style-check" aria-hidden>{s.value === current && <CheckIcon size={14} />}</span>
              <span className="style-name">{s.label}</span>
              <kbd className="style-keys" aria-hidden>{formatKeys(shortcut(s.value).keys[0])}</kbd>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Hides the format bar while the writer types, and brings it back when the mouse moves, the
 * selection is changed with the mouse, or focus moves into the bar.
 */
function useFadeWhileTyping(editor: Editor): [boolean, () => void] {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const dom = editor.view.dom;
    let pointer = { x: -1, y: -1 };
    let fadedAt: { x: number; y: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') {
        fadedAt = pointer;
        setFaded(true);
      }
    };
    // Browsers send a mousemove when content scrolls under a still pointer; only real movement counts.
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (fadedAt && Math.hypot(e.clientX - fadedAt.x, e.clientY - fadedAt.y) > 3) {
        fadedAt = null;
        setFaded(false);
      }
    };
    const onPointerDown = () => {
      fadedAt = null;
      setFaded(false);
    };
    dom.addEventListener('keydown', onKey);
    dom.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      dom.removeEventListener('keydown', onKey);
      dom.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onMove);
    };
  }, [editor]);
  return [faded, () => setFaded(false)];
}

/** Slim format bar above the text (desktop). */
export function FormatBar({ editor, barRef, onLink }: { editor: Editor; barRef: RefObject<HTMLDivElement>; onLink: () => void }) {
  const roving = useRovingToolbar(barRef, editor);
  const [faded, reveal] = useFadeWhileTyping(editor);
  const blocks = canStyleBlocks(editor);
  const centred = isCentred(editor);
  return (
    <div className={`format-top-wrap${faded ? ' faded' : ''}`}>
      <div
        ref={barRef}
        className="format-top"
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
        onKeyDown={roving.onKeyDown}
        onFocus={(e) => {
          reveal();
          roving.onFocus(e);
        }}
      >
        <StylePicker editor={editor} />
        <Separator />
        <FormatButton label="Bold" keys="bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} className="fmt-b">B</FormatButton>
        <FormatButton label="Italic" keys="italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} className="fmt-i">I</FormatButton>
        <FormatButton label="Highlight" keys="highlight" active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()}>
          <HighlightIcon size={17} />
        </FormatButton>
        <Separator />
        <FormatButton label="Align left" keys="alignLeft" active={blocks && !centred} disabled={!blocks} onClick={() => editor.chain().focus().unsetTextAlign().run()}>
          <AlignLeftIcon size={17} />
        </FormatButton>
        <FormatButton label="Align centre" keys="alignCenter" active={centred} disabled={!blocks} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
          <AlignCenterIcon size={17} />
        </FormatButton>
        <Separator />
        <FormatButton label="Section divider" keys="divider" onClick={() => editor.chain().focus().setHorizontalRule().run()} className="fmt-divider">⁂</FormatButton>
        <Separator />
        <FormatButton label="Link" keys="link" active={editor.isActive('link')} onClick={onLink}>
          <LinkIcon size={16} />
        </FormatButton>
      </div>
    </div>
  );
}

/**
 * Small link prompt next to the selection (Mod-K, or a Link button). On a link it edits or
 * removes that link; with nothing selected it inserts the address as a link.
 */
export function LinkPrompt({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [existing] = useState(() => (editor.getAttributes('link').href as string | undefined) ?? '');
  const [url, setUrl] = useState(existing);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (editor.isActive('link')) editor.commands.extendMarkRange('link');
    const place = () => {
      const el = box.current;
      if (!el) return;
      const { from, to } = editor.state.selection;
      const r = posToDOMRect(editor.view, from, to);
      let top = r.top - el.offsetHeight - 8;
      if (top < 8) top = r.bottom + 8;
      const left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, (r.left + r.right) / 2 - el.offsetWidth / 2));
      setPos({ top, left });
    };
    place();
    input.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [editor]);

  const apply = () => {
    const href = normaliseUrl(url);
    if (url.trim() && !href) {
      setError('Only web (https://) and email (mailto:) links can be added.');
      return;
    }
    const chain = editor.chain().focus();
    if (!href) chain.extendMarkRange('link').unsetLink();
    else if (editor.state.selection.empty) chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] });
    else chain.extendMarkRange('link').setLink({ href });
    chain.run();
    onClose();
  };

  return (
    <form
      ref={box}
      className="bubble bubble-link link-prompt"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <label className="visually-hidden" htmlFor="link-url">Link address</label>
      <input
        id="link-url"
        ref={input}
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setError(null);
        }}
        placeholder="Paste or type a link"
        aria-invalid={!!error}
        aria-describedby={error ? 'link-url-error' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            editor.commands.focus();
          }
        }}
      />
      <button type="submit" onMouseDown={(e) => e.preventDefault()}>
        {url.trim() || !existing ? 'Apply' : 'Remove'}
      </button>
      {error && (
        <span id="link-url-error" className="link-error" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

/** Format bar on phones, pinned under the header. Scrolls sideways when it doesn't fit. */
export function MobileFormatBar({ editor, barRef, onLink }: { editor: Editor; barRef: RefObject<HTMLDivElement>; onLink: () => void }) {
  const roving = useRovingToolbar(barRef, editor);
  const blocks = canStyleBlocks(editor);
  const centred = isCentred(editor);
  return (
    <div ref={barRef} className="format-bar" role="toolbar" aria-label="Formatting" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
      <div className="format-bar-scroll">
        <label className="visually-hidden" htmlFor="mobile-style">Paragraph style</label>
        <select
          id="mobile-style"
          data-tb-item
          className="style-select"
          value={currentBlockStyle(editor.state)}
          disabled={!blocks}
          onChange={(e) => applyBlockStyle(editor, e.target.value as BlockStyle)}
        >
          {BLOCK_STYLES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <FormatButton label="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} className="fmt-b">B</FormatButton>
        <FormatButton label="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} className="fmt-i">I</FormatButton>
        <FormatButton label="Highlight" active={editor.isActive('highlight')} onClick={() => editor.chain().focus().toggleHighlight().run()}>
          <HighlightIcon size={19} />
        </FormatButton>
        <FormatButton label="Align left" active={blocks && !centred} disabled={!blocks} onClick={() => editor.chain().focus().unsetTextAlign().run()}>
          <AlignLeftIcon size={19} />
        </FormatButton>
        <FormatButton label="Align centre" active={centred} disabled={!blocks} onClick={() => editor.chain().focus().setTextAlign('center').run()}>
          <AlignCenterIcon size={19} />
        </FormatButton>
        <FormatButton label="Section divider" onClick={() => editor.chain().focus().setHorizontalRule().run()} className="fmt-divider">⁂</FormatButton>
        <FormatButton label="Link" active={editor.isActive('link')} onClick={onLink}>
          <LinkIcon size={18} />
        </FormatButton>
      </div>
    </div>
  );
}

import type { JSONContent } from '@tiptap/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ImageIcon } from '../../components/Icons';
import { dividerLabel } from '../../editor/returnDividerRule';
import { acquireImageUrl, releaseImageUrl } from '../../images/blobs';

/** Only these link schemes are rendered as links (the editor accepts the same ones). */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null;
}

function renderText(node: JSONContent, key: number): ReactNode {
  let out: ReactNode = node.text ?? '';
  for (const m of node.marks ?? []) {
    if (m.type === 'bold') out = <strong>{out}</strong>;
    else if (m.type === 'italic') out = <em>{out}</em>;
    else if (m.type === 'highlight') out = <mark>{out}</mark>;
    else if (m.type === 'strike') out = <s>{out}</s>;
    else if (m.type === 'code') out = <code>{out}</code>;
  }
  const link = node.marks?.find((m) => m.type === 'link');
  const href = link ? safeHref(link.attrs?.href) : null;
  if (href) out = <a href={href} target="_blank" rel="noopener noreferrer nofollow">{out}</a>;
  return <span key={key}>{out}</span>;
}

function children(node: JSONContent, ctx: RenderContext): ReactNode[] {
  return (node.content ?? []).map((c, i) => renderNode(c, i, ctx));
}

export interface RenderContext {
  /** Load every image now (printing), not only when it scrolls into view. */
  eager: boolean;
  /** The entry's date and time zone, for the time on a divider added when writing resumed later. */
  entry?: { createdAt: string; tz: string };
}

function renderNode(node: JSONContent, key: number, ctx: RenderContext): ReactNode {
  const align = node.attrs?.textAlign === 'center' ? ({ textAlign: 'center' } as const) : undefined;
  switch (node.type) {
    case 'text':
      return renderText(node, key);
    case 'paragraph':
      return (
        <p key={key} style={align} className={align ? 'centred' : undefined}>
          {children(node, ctx)}
        </p>
      );
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 2));
      const Tag = (['h3', 'h4', 'h5'] as const)[level - 1];
      return (
        <Tag key={key} style={align} className={`yb-h${level}`}>
          {children(node, ctx)}
        </Tag>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{children(node, ctx)}</blockquote>;
    case 'bulletList':
      return <ul key={key}>{children(node, ctx)}</ul>;
    case 'orderedList':
      return (
        <ol key={key} start={Number(node.attrs?.start) || 1}>
          {children(node, ctx)}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{children(node, ctx)}</li>;
    case 'hardBreak':
      return <br key={key} />;
    case 'horizontalRule':
      return (
        <p key={key} className="yb-divider" role="separator" aria-label="Section break">
          ⁂
          {typeof node.attrs?.at === 'string' && ctx.entry && <span className="yb-divider-time">{dividerLabel(node.attrs.at, ctx.entry)}</span>}
        </p>
      );
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{children(node, ctx)}</code>
        </pre>
      );
    case 'encryptedImage':
      return typeof node.attrs?.blobId === 'string' ? (
        <BookFigure
          key={key}
          blobId={node.attrs.blobId}
          caption={String(node.attrs.caption ?? '')}
          alt={String(node.attrs.alt ?? '')}
          width={Number(node.attrs.width) || 3}
          height={Number(node.attrs.height) || 2}
          eager={ctx.eager}
        />
      ) : null;
    default:
      return node.content ? <div key={key}>{children(node, ctx)}</div> : null;
  }
}

export function renderDoc(doc: JSONContent | null | undefined, ctx: RenderContext): ReactNode[] {
  return doc ? children(doc, ctx) : [];
}

/**
 * An entry's photo in the book. Its box has the image's proportions before it loads, so the page
 * layout doesn't move; it is decrypted when it comes into view (or right away when printing).
 */
function BookFigure({ blobId, caption, alt, width, height, eager }: { blobId: string; caption: string; alt: string; width: number; height: number; eager: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (visible || eager) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((rs) => {
      if (rs.some((r) => r.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible, eager]);

  const load = visible || eager;
  useEffect(() => {
    if (!load) return;
    let alive = true;
    acquireImageUrl(blobId)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      releaseImageUrl(blobId);
    };
  }, [blobId, load]);

  return (
    <figure ref={ref} className="yb-figure" style={{ ['--ar' as string]: `${width} / ${height}`, ['--ratio' as string]: String(width / height) }}>
      <span className="yb-figure-frame">
        {url ? (
          <img src={url} alt={alt || caption || 'Photo'} />
        ) : (
          <span className="yb-figure-placeholder" role="img" aria-label={failed ? "Photo couldn't be loaded" : 'Photo, loading'}>
            <ImageIcon size={24} strokeWidth={1.5} />
          </span>
        )}
      </span>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

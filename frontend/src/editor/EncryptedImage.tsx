import { mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, type NodeViewProps, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ImageIcon, XIcon } from '../components/Icons';
import { acquireImageUrl, releaseImageUrl } from '../images/blobs';
import { EDITABLE_PRIVACY_PROPS } from '../security/extensions';
import { uploads } from './uploads';

/**
 * Custom node for encrypted images (SPEC §4): attrs {blobId, alt, caption, width, height}.
 * The node only holds the blob ID; the view fetches, decrypts and shows an object URL.
 */
export const EncryptedImage = Node.create({
  name: 'encryptedImage',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    const data = (name: string, numeric = false) => ({
      default: null,
      parseHTML: (el: HTMLElement) => {
        const v = el.getAttribute(`data-${name}`);
        return numeric ? (v ? Number(v) || null : null) : v;
      },
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] == null ? {} : { [`data-${name}`]: String(attrs[name]) }),
    });
    return {
      blobId: data('blob-id'),
      alt: { ...data('alt'), default: '' },
      caption: { ...data('caption'), default: '' },
      width: data('width', true),
      height: data('height', true),
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-encrypted-image]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes({ 'data-encrypted-image': '' }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

function ImageView({ node, updateAttributes, deleteNode, selected, editor }: NodeViewProps) {
  const { blobId, alt, caption, width, height } = node.attrs as { blobId: string; alt: string; caption: string; width: number | null; height: number | null };
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useSyncExternalStore(uploads.subscribe, uploads.version);
  const upload = uploads.get(blobId);

  // Re-run when an upload finishes: an image whose upload failed earlier (and so couldn't be
  // loaded from the server after a reload) becomes available.
  const uploading = upload !== undefined;
  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (!blobId) return;
    acquireImageUrl(blobId)
      .then((u) => alive && setUrl(u))
      .catch(() => {
        if (!alive) return;
        setUrl(null);
        setFailed(true);
      });
    return () => {
      alive = false;
      releaseImageUrl(blobId);
    };
  }, [blobId, uploading]);

  const ratio = width && height ? `${width} / ${height}` : '3 / 2';
  const editable = editor.isEditable;

  return (
    <NodeViewWrapper as="figure" className={`entry-figure${selected ? ' is-selected' : ''}`} data-drag-handle>
      <div className="figure-frame" style={{ aspectRatio: url ? undefined : ratio }}>
        {url ? (
          <img src={url} alt={alt || caption || 'Photo'} width={width ?? undefined} height={height ?? undefined} draggable={false} />
        ) : (
          <div className="figure-placeholder" role="img" aria-label={failed ? "Image couldn't be loaded" : 'Loading image'}>
            <ImageIcon size={28} strokeWidth={1.5} />
            {failed ? "Couldn't load this image" : 'Decrypting…'}
          </div>
        )}
        {upload && (
          <div className={`figure-status${upload.state === 'failed' ? ' failed' : ''}`} role="status">
            {upload.state === 'uploading' ? (
              <>
                <span className="spinner" aria-hidden /> Encrypting and uploading…
              </>
            ) : (
              <>
                Upload failed: {upload.error}
                <button type="button" className="btn btn-secondary btn-sm" onClick={upload.retry}>Retry</button>
              </>
            )}
          </div>
        )}
        {editable && (
          <button type="button" className="figure-remove" aria-label="Remove image" onClick={() => deleteNode()}>
            <XIcon size={12} />
          </button>
        )}
      </div>
      {editable ? (
        <input
          className="figure-caption"
          value={caption ?? ''}
          placeholder="Add a caption"
          aria-label="Image caption"
          {...EDITABLE_PRIVACY_PROPS}
          onChange={(e) => updateAttributes({ caption: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              editor.commands.focus(editor.state.selection.to + 1);
            }
          }}
        />
      ) : (
        caption && <figcaption className="figure-caption">{caption}</figcaption>
      )}
    </NodeViewWrapper>
  );
}

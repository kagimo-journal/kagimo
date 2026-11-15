import { desktop, TAB } from '../../desktop/bridge';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import { EditorContent, type JSONContent, useEditor } from '@tiptap/react';
import { Selection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link as RouterLink, Navigate, useNavigate } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { ConfirmDialog } from '../../components/Dialog';
import { ChevronLeftIcon, DotsIcon, FlameIcon, LockIcon, PinIcon, SidebarIcon, XIcon } from '../../components/Icons';
import { Menu } from '../../components/Menu';
import { PasswordBanner, useNeedsPassword } from '../../components/security/SetPassword';
import { ThemeToggle } from '../../components/ThemeToggle';
import { LoadingScreen } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { decryptEntryPart } from '../../crypto/content';
import { lock, onBeforeLock } from '../../crypto/session';
import { collectBlobIds, docStats, isDocEmpty } from '../../editor/docText';
import { burnElement } from '../../editor/burn';
import { burnRequests } from '../../editor/burnRequests';
import { EncryptedImage } from '../../editor/EncryptedImage';
import { ReturnDivider } from '../../editor/ReturnDivider';
import { entriesStore } from '../../editor/entriesStore';
import { dropForeignImages } from '../../editor/pasteImages';
import { editorHighlight, editorTextAlign, FormatKeys } from '../../editor/formatting';
import { EntrySaver, type SaveStatus } from '../../editor/saver';
import { EMPTY_DOC, type EntryBody, type EntryHeader } from '../../editor/types';
import '../../editor/unsaved';
import { uploads } from '../../editor/uploads';
import { exportEntriesZip } from '../../export/exporter';
import type { EntryRecord } from '../../local/db';
import { deleteLocalEntry, emitLocal, getEntry, onLocalEvent } from '../../local/repo';
import { requireVault } from '../../local/vault';
import { holdEntry, integrateIncoming } from '../../sync/integrate';
import { ConflictView } from './ConflictView';
import { currentTimeZone, formatLongDate, formatShortDateTime, formatTime, localIsoWithOffset, plural } from '../../lib/format';
import { type EntryLocation, locateHere } from '../../location/geocode';
import { describeWeather, type EntryWeather, formatTemp, isEntryWeather, weatherHere } from '../../weather/weather';
import { WeatherIcon } from '../../weather/WeatherIcon';
import { useIdentity } from '../../state/identity';
import { useSettings } from '../../state/settings';
import { EDITABLE_PRIVACY_ATTRS, EDITABLE_PRIVACY_PROPS } from '../../security/extensions';
import { ExtensionNotice } from '../../security/ExtensionNotice';
import { useVisualViewportShell } from '../../lib/hooks';
import { ShortcutsDialog } from './ShortcutsDialog';
import { focusToolbar, FormatBar, LinkPrompt, MobileFormatBar } from './Toolbars';

interface Props {
  id: string;
  fresh: boolean;
  mobile: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onDeleted: (id: string) => void;
}

interface Loaded {
  exists: boolean;
  header: Pick<EntryHeader, 'title' | 'createdAt' | 'tz' | 'location' | 'weather'>;
  doc: JSONContent;
  /** When the stored entry last changed (ms); null for a new one. */
  updatedAt: number | null;
}

async function decryptRecord(e: EntryRecord): Promise<Loaded> {
  const [header, body] = await Promise.all([
    decryptEntryPart<EntryHeader>(e.id, 'header', e.header),
    decryptEntryPart<EntryBody>(e.id, 'body', e.body),
  ]);
  return {
    exists: true,
    header: { title: header.title ?? '', createdAt: header.createdAt ?? e.createdAt, tz: header.tz ?? currentTimeZone(), location: header.location ?? null, weather: isEntryWeather(header.weather) ? header.weather : null },
    doc: body.doc ?? EMPTY_DOC,
    updatedAt: Date.parse(e.updatedAt) || null,
  };
}

/** Reads the stored entry, taking in a copy from another device that was waiting for it. */
async function loadStored(id: string): Promise<EntryRecord | null> {
  const vaultId = requireVault().id;
  const rec = await getEntry(vaultId, id);
  if (rec?.incoming && !EntrySaver.get(id)?.hasUnsaved) {
    await integrateIncoming(vaultId, id);
    return getEntry(vaultId, id);
  }
  return rec;
}

/** Loads (or starts) an entry from the device, then hands it to the editor, or to the conflict view. */
export function EntryEditor(props: Props) {
  const { id, fresh } = props;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [conflict, setConflict] = useState<EntryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  /** Bumped to read the entry again (a conflict appeared or was settled). */
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let alive = true;
    setError(null);
    loadStored(id)
      .then(async (rec) => {
        if (!alive) return;
        if (!rec) {
          const known = entriesStore.get().items.some((e) => e.id === id);
          if (fresh && !known && generation === 0) {
            setConflict(null);
            setLoaded({ exists: false, header: { title: '', createdAt: localIsoWithOffset(), tz: currentTimeZone(), location: null, weather: null }, doc: EMPTY_DOC, updatedAt: null });
          } else if (generation > 0) {
            setError('This entry was burned on another device.');
          } else {
            // Not on this device (a link from another browser, or an entry since burned): go home.
            setMissing(true);
          }
          return;
        }
        if (rec.conflict) {
          setLoaded(null);
          setConflict(rec);
          return;
        }
        const l = await decryptRecord(rec);
        if (!alive) return;
        setConflict(null);
        setLoaded(l);
      })
      .catch((e) => alive && setError(`Couldn't open this entry. ${errorMessage(e)}`));
    return () => {
      alive = false;
    };
  }, [id, fresh, generation]);

  // Sync settled or produced a conflict on this entry while it was open.
  useEffect(
    () =>
      onLocalEvent((e) => {
        if (e.type !== 'entries' || e.origin !== 'sync' || !e.ids.includes(id)) return;
        void getEntry(requireVault().id, id).then((rec) => {
          if (!rec || !!rec.conflict !== !!conflict) reload();
        });
      }),
    [id, conflict, reload],
  );

  if (missing) return <Navigate to="/" replace />;

  if (conflict && !error) {
    return <ConflictView key={`${id}:${generation}`} record={conflict} mobile={props.mobile} onSettled={reload} onDeleted={props.onDeleted} />;
  }

  if (error) {
    return (
      <main className="journal-main">
        <div className="entry-error">
          <p className="lede">{error}</p>
          <RouterLink to="/" className="btn btn-secondary">Back to journal</RouterLink>
        </div>
      </main>
    );
  }
  if (!loaded) {
    return (
      <main className="journal-main">
        <LoadingScreen label="Decrypting…" />
      </main>
    );
  }
  return <EditorView key={generation} {...props} initial={loaded} isNew={!loaded.exists} onConflict={reload} />;
}

const PILL: Record<SaveStatus, { cls: string; text: string; mobile: string } | null> = {
  idle: null,
  dirty: { cls: 'pill-saving', text: 'Saving…', mobile: 'Saving…' },
  saving: { cls: 'pill-saving', text: 'Saving…', mobile: 'Saving…' },
  saved: { cls: 'pill-saved', text: 'Encrypted · saved', mobile: 'Saved' },
  error: { cls: 'pill-offline', text: 'Not saved', mobile: 'Not saved' },
};

function EditorView({
  id,
  mobile,
  sidebarOpen,
  onToggleSidebar,
  onDeleted,
  initial,
  isNew,
  onConflict,
}: Props & { initial: Loaded; isNew: boolean; onConflict: () => void }) {
  const toast = useToast();
  const me = useIdentity();
  const navigate = useNavigate();
  const { settings, loaded: settingsLoaded, update: updateSettings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [title, setTitle] = useState(initial.header.title);
  const [meta, setMeta] = useState({
    createdAt: initial.header.createdAt,
    tz: initial.header.tz,
    location: initial.header.location as EntryLocation | null,
    weather: (initial.header.weather ?? null) as EntryWeather | null,
  });
  const [status, setStatus] = useState<SaveStatus>(isNew ? 'idle' : 'saved');
  const [statusMsg, setStatusMsg] = useState<string | undefined>();
  const [words, setWords] = useState(() => docStats(initial.doc).wordCount);
  /** Changes from another device were taken into this entry while it was open. */
  const [updated, setUpdated] = useState(false);
  const [confirmBurn, setConfirmBurn] = useState(false);
  const [burning, setBurning] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const formatBar = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);

  const titleRef = useRef(title);
  const metaRef = useRef(meta);
  titleRef.current = title;
  metaRef.current = meta;
  const titleEl = useRef<HTMLTextAreaElement>(null);
  /** Blobs uploaded while this entry was open; removed ones are deleted when it closes. */
  /** Every blob that belongs to this entry; images pasted from elsewhere are copied. */
  const [ownBlobs] = useState(() => new Set(collectBlobIds(initial.doc)));
  const saverRef = useRef<EntrySaver | null>(null);
  const turnOffDividersRef = useRef(() => {});
  turnOffDividersRef.current = () => {
    updateSettings((s) => ({ ...s, returnDividers: false }));
    toast.show('Automatic dividers are off. You can turn them on again in Settings → Appearance.', {
      action: { label: 'Undo', run: () => updateSettings((s) => ({ ...s, returnDividers: true })) },
      ms: 8000,
    });
  };
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  const snapshot = useCallback((): { header: EntryHeader; body: EntryBody } | null => {
    const ed = editorRef.current;
    if (!ed) return null;
    const doc = ed.getJSON();
    const saver = saverRef.current;
    if (saver && !saver.exists && !titleRef.current.trim() && isDocEmpty(doc)) return null;
    const stats = docStats(doc);
    const m = metaRef.current;
    return {
      header: {
        v: 1,
        title: titleRef.current.trim(),
        snippet: stats.snippet,
        createdAt: m.createdAt,
        tz: m.tz,
        location: m.location,
        weather: m.weather,
        wordCount: stats.wordCount,
        imageCount: stats.imageCount,
        coverBlobId: stats.coverBlobId,
        photoCount: stats.imageCount,
      },
      body: { v: 1, doc },
    };
  }, []);

  if (!saverRef.current) {
    saverRef.current = EntrySaver.attach(id, initial.exists, {
      snapshot: () => snapshot(),
      onStatus: (s, msg) => {
        setStatus(s);
        setStatusMsg(msg);
      },
      onSaved: (rec, header) => entriesStore.upsert(rec, header),
    });
  }
  const saver = saverRef.current;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, horizontalRule: false }),
      ReturnDivider.configure({
        enabled: () => settingsRef.current.returnDividers,
        lastChanged: initial.updatedAt,
        entry: () => metaRef.current,
        onTurnOff: () => turnOffDividersRef.current(),
      }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Typography,
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      editorHighlight,
      editorTextAlign,
      FormatKeys.configure({
        onLink: () => setLinkOpen(true),
        onHelp: () => setShortcutsOpen(true),
        onToolbar: () => focusToolbar(formatBar),
      }),
      EncryptedImage,
    ],
    content: initial.doc,
    editorProps: {
      // No browser spellcheck (cloud spellcheckers send the text away, security review L5) and the
      // opt-out attributes that writing extensions honour (brief §6).
      attributes: {
        class: 'prose',
        id: 'entry-body',
        'aria-label': 'Entry text',
        role: 'textbox',
        'aria-multiline': 'true',
        autocapitalize: 'sentences',
        ...EDITABLE_PRIVACY_ATTRS,
      },
      // Photos can't be added (only text is stored): dropped or pasted files are refused, and an
      // image pasted from another entry is left out.
      handleDrop: (_view, event, _slice, moved) => {
        if (moved || !event.dataTransfer?.files.length) return false;
        refusePhotosRef.current();
        return true;
      },
      handlePaste: (_view, event) => {
        if (!event.clipboardData?.files.length) return false;
        refusePhotosRef.current();
        return true;
      },
      transformPasted: (slice) => dropForeignImages(slice, (b) => ownBlobs.has(b)),
    },
    onUpdate: ({ editor: ed }) => {
      setWords(docStats(ed.getJSON()).wordCount);
      saver.change();
    },
  });
  editorRef.current = editor;

  // ---- images (existing ones only; new photos can't be added) -------------------------
  const refusePhotos = useCallback(() => toast.show('Photos can’t be added to entries. Kagimo stores text only.'), [toast]);
  const refusePhotosRef = useRef(refusePhotos);
  refusePhotosRef.current = refusePhotos;

  useSyncExternalStore(uploads.subscribe, uploads.version);
  const imagesFailed = uploads.failed(id);
  const imagesUploading = uploads.unsaved(id) - imagesFailed;

  // ---- changes from other devices --------------------------------------------------------------
  // Sync never rewrites an open entry: it leaves the newer copy waiting and tells us. We save the
  // last keystrokes, merge it in with the editor paused, then show the result.
  useEffect(() => holdEntry(id), [id]);
  const takingIn = useRef(false);
  const takeIncoming = useCallback(async () => {
    const ed = editorRef.current;
    if (takingIn.current || !ed) return;
    takingIn.current = true;
    const wasEditable = ed.isEditable;
    ed.setEditable(false);
    try {
      await saver.flush();
      const vaultId = requireVault().id;
      const res = await integrateIncoming(vaultId, id);
      if (res === 'conflict') return onConflict();
      if (res === 'none') return;
      const rec = await getEntry(vaultId, id);
      if (!rec || ed.isDestroyed) return;
      const l = await decryptRecord(rec);
      const sel = ed.state.selection;
      ed.commands.setContent(l.doc, false);
      const max = ed.state.doc.content.size;
      ed.commands.setTextSelection({ from: Math.min(sel.from, max), to: Math.min(sel.to, max) });
      setTitle(l.header.title);
      titleRef.current = l.header.title;
      const m = { createdAt: l.header.createdAt, tz: l.header.tz, location: l.header.location as EntryLocation | null, weather: l.header.weather ?? null };
      setMeta(m);
      metaRef.current = m;
      setWords(docStats(l.doc).wordCount);
      for (const b of collectBlobIds(l.doc)) ownBlobs.add(b);
      saver.rebase();
      if (res === 'merged' || res === 'replaced') setUpdated(true);
    } catch (e) {
      toast.show(`Couldn't take in changes from your other device: ${errorMessage(e)}`);
    } finally {
      takingIn.current = false;
      if (!ed.isDestroyed) ed.setEditable(wasEditable);
    }
  }, [id, saver, onConflict, ownBlobs, toast]);

  useEffect(() => onLocalEvent((e) => e.type === 'incoming' && e.id === id && void takeIncoming()), [id, takeIncoming]);
  useEffect(() => {
    // One may have arrived while the editor was being set up.
    if (editor) void getEntry(requireVault().id, id).then((r) => r?.incoming && void takeIncoming());
  }, [editor, id, takeIncoming]);

  // ---- lifecycle: flush on lock / unmount ------------------------------------------------
  useEffect(() => {
    // A saver kept alive with an unsaved draft reports where it stands.
    setStatus(saver.status);
    const release = saver.retain();
    const offLock = onBeforeLock(() => saver.flush());
    return () => {
      offLock();
      // Taken now, while the editor still exists: if the save fails (offline) the saver keeps
      // this draft, encrypted, and retries after the editor is gone.
      void release(snapshot());
    };
  }, [saver, snapshot]);

  // ---- location for new entries ---------------------------------------------------
  useEffect(() => {
    if (!isNew || !settingsLoaded || settings.details.location === 'off') return;
    let alive = true;
    void locateHere(settings.details.location).then((loc) => {
      if (!alive || !loc) return;
      setMeta((m) => (m.location ? m : { ...m, location: loc }));
      if (saver.exists) saver.change();
    });
    return () => {
      alive = false;
    };
    // Runs once settings are available; only new entries get a location.
  }, [settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- weather for new entries ----------------------------------------------------
  useEffect(() => {
    if (!isNew || !settingsLoaded || !settings.details.weather) return;
    let alive = true;
    void weatherHere().then((w) => {
      if (!alive || !w) return;
      setMeta((m) => (m.weather ? m : { ...m, weather: w }));
      if (saver.exists) saver.change();
    });
    return () => {
      alive = false;
    };
    // Same as location: once settings are available, new entries only.
  }, [settingsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = titleEl.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, mobile]);

  useEffect(() => {
    if (isNew) titleEl.current?.focus();
  }, [isNew]);

  // ---- actions --------------------------------------------------------------------
  // The entry list's flame button on this entry opens our confirm, so the burn plays here.
  useEffect(() => burnRequests.register(id, () => setConfirmBurn(true)), [id]);

  const removeWeather = () => {
    setMeta((m) => ({ ...m, weather: null }));
    metaRef.current = { ...metaRef.current, weather: null };
    saver.change();
  };

  const removeLocation = () => {
    setMeta((m) => ({ ...m, location: null }));
    metaRef.current = { ...metaRef.current, location: null };
    saver.change();
  };

  /** Deletes the entry for good while the page burns away. */
  const doBurn = async () => {
    setConfirmBurn(false);
    setBurning(true);
    setLinkOpen(false);
    editor?.setEditable(false);
    (document.activeElement as HTMLElement | null)?.blur();
    const burn = articleRef.current ? burnElement(articleRef.current) : null;
    try {
      await Promise.all([
        (async () => {
          // Stop retrying this entry's images and let uploads in flight land first, so none of
          // them arrives after the entry (and its blobs) are gone.
          await uploads.cancelEntry(id);
          saver.abandon();
          await deleteLocalEntry(requireVault().id, id);
          emitLocal({ type: 'entries', ids: [id], origin: 'local' });
        })(),
        burn?.finished,
      ]);
    } catch (e) {
      burn?.cancel();
      editor?.setEditable(true);
      setBurning(false);
      toast.show(`Couldn't burn this entry: ${errorMessage(e)}`);
      return;
    }
    entriesStore.remove(id);
    toast.show('Burned. It’s gone for good.');
    onDeleted(id);
    // After the route has changed, so the hidden page never flashes back.
    requestAnimationFrame(() => burn?.dispose());
  };

  const doExport = async () => {
    try {
      await saver.flush();
      if (!saver.exists) return toast.show('Write something first, then export.');
      const res = await exportEntriesZip({ ids: [id], includeImages: true, combined: false });
      toast.show(res.failed.length ? `Exported with problems: ${res.failed.join('; ')}` : 'Exported. The Markdown file is not encrypted; store it carefully.');
    } catch (e) {
      toast.show(`Export failed: ${errorMessage(e)}`);
    }
  };

  // ---- dropped files ---------------------------------------------------------------
  // A file dropped anywhere on the page would otherwise be opened by the browser, leaving the entry.
  const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files');
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    },
    onDrop: (e: React.DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      refusePhotos();
    },
  };

  const pill =
    imagesFailed > 0
      ? { cls: 'pill-offline', text: `Not saved · ${plural(imagesFailed, 'image')}`, mobile: 'Not saved' }
      : imagesUploading > 0 && (status === 'saved' || status === 'idle')
        ? PILL.saving
        : PILL[status];
  const showDateTime = settings.details.datetime;
  const needsPassword = useNeedsPassword();
  // With the keyboard up the shell shrinks; keep the caret in view inside it.
  useVisualViewportShell(shellRef, mobile, () => {
    if (editor?.isFocused) editor.commands.scrollIntoView();
  });
  const options = [
    { label: 'Export as Markdown', onSelect: () => void doExport() },
    ...(mobile ? [] : [{ label: 'Keyboard shortcuts', onSelect: () => setShortcutsOpen(true) }]),
    { label: 'Settings', onSelect: () => navigate('/settings') },
    { label: 'Appearance', onSelect: () => navigate('/settings/appearance') },
    ...(me.isAdmin ? [{ label: 'Admin', onSelect: () => navigate('/admin') }] : []),
    ...(needsPassword ? [] : [{ label: 'Lock journal', onSelect: () => void lock().then(() => navigate('/unlock')) }]),
    { label: 'Burn it', danger: true, onSelect: () => setConfirmBurn(true) },
  ];

  return (
    <main ref={shellRef} className={`journal-main${mobile ? ' is-mobile editor-shell' : ''}`} {...dropHandlers}>
      <PasswordBanner />
      <div className="editor-head">
        <div className="editor-top">
          {mobile ? (
            <RouterLink to="/" className="icon-btn" aria-label="All entries">
              <ChevronLeftIcon size={20} />
            </RouterLink>
          ) : (
            <button type="button" className="icon-btn" aria-label={sidebarOpen ? 'Hide entry list' : 'Show entry list'} aria-pressed={sidebarOpen} onClick={onToggleSidebar}>
              <SidebarIcon size={18} />
            </button>
          )}
          <div className="row" style={{ gap: 4 }}>
            <span role="status" aria-live="polite" title={statusMsg}>
              {pill && (
                <span className={`pill ${pill.cls}`}>
                  {status === 'saved' && <LockIcon size={mobile ? 12 : 13} strokeWidth={2} />}
                  {mobile ? pill.mobile : pill.text}
                </span>
              )}
            </span>
            <ThemeToggle size={mobile ? 18 : 17} />
            <button
              type="button"
              className="icon-btn burn-btn"
              aria-label="Burn this entry"
              title="Burn this entry"
              disabled={burning}
              onClick={() => setConfirmBurn(true)}
            >
              <FlameIcon size={mobile ? 18 : 17} />
            </button>
            <Menu label="Entry options" trigger={<DotsIcon />} items={options} />
          </div>
        </div>
        {mobile && editor && (
          <MobileFormatBar editor={editor} barRef={formatBar} onLink={() => setLinkOpen(true)} />
        )}
      </div>

      {editor && !mobile && <FormatBar editor={editor} barRef={formatBar} onLink={() => setLinkOpen(true)} />}

      <article ref={articleRef} className={`entry${mobile ? '' : ' with-format-bar'}`}>
        {updated && (
          <div className="notice" role="status" style={{ marginBottom: 24 }}>
            <span>This entry was also changed on another device. Those changes are now included here.</span>
            <span className="notice-actions">
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setUpdated(false)}>
                <XIcon size={12} />
              </button>
            </span>
          </div>
        )}
        {!desktop && <ExtensionNotice />}
        {status === 'error' && statusMsg && (
          <div className="notice danger" role="alert" style={{ marginBottom: 24 }}>
            <span>Not saved on this device: {statusMsg}. Your text is still here; keep this {TAB} open while we try again.</span>
          </div>
        )}
        <div className="details-line">
          {showDateTime &&
            (mobile ? (
              <span>{formatShortDateTime(meta.createdAt, meta.tz)}</span>
            ) : (
              <>
                <span>{formatLongDate(meta.createdAt, meta.tz)}</span>
                <span>{formatTime(meta.createdAt, meta.tz)}</span>
              </>
            ))}
          {meta.location && (
            <span className="location-chip">
              <PinIcon size={mobile ? 11 : 12} />
              {meta.location.label}
              <button type="button" aria-label={`Remove location ${meta.location.label}`} onClick={removeLocation}>
                <XIcon size={10} />
              </button>
            </span>
          )}
          {meta.weather && <WeatherChip weather={meta.weather} mobile={mobile} onRemove={removeWeather} />}
          {!mobile && <span className="word-count">{plural(words, 'word')}</span>}
        </div>
        <label htmlFor={`title-${id}`} className="visually-hidden">Title</label>
        <textarea
          id={`title-${id}`}
          ref={titleEl}
          className="entry-title-input"
          rows={1}
          placeholder="Title"
          value={title}
          maxLength={300}
          {...EDITABLE_PRIVACY_PROPS}
          autoCapitalize="sentences"
          onChange={(e) => {
            setTitle(e.target.value.replace(/\n/g, ' '));
            titleRef.current = e.target.value;
            saver.change();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.currentTarget.selectionStart === title.length)) {
              e.preventDefault();
              if (!editor) return;
              // Synchronously: TipTap's focus command defers to the next frame, and keys typed
              // in between would still land in the title.
              const { state, view } = editor;
              view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)).scrollIntoView());
              view.focus();
            }
          }}
        />
        <EditorContent editor={editor} />
      </article>

      {linkOpen && editor && <LinkPrompt editor={editor} onClose={() => setLinkOpen(false)} />}


      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => {
          setShortcutsOpen(false);
          editor?.commands.focus();
        }}
      />

      <ConfirmDialog
        open={confirmBurn}
        title="Burn this entry?"
        body={
          <>
            <p>
              {title.trim() ? <>“{title.trim()}”</> : 'This entry'} and all of its photos will be permanently deleted from this device
              {me.synced ? ', from the server and from your other devices' : ''}.
            </p>
            <p style={{ marginTop: 10 }}><strong>There is no undo.</strong> Once it burns, nobody can bring it back, including us.</p>
          </>
        }
        confirmLabel="Burn it"
        cancelLabel="Keep it"
        danger
        focusCancel
        busy={burning}
        onConfirm={() => void doBurn()}
        onCancel={() => setConfirmBurn(false)}
      />
    </main>
  );
}

function WeatherChip({ weather, mobile, onRemove }: { weather: EntryWeather; mobile: boolean; onRemove: () => void }) {
  const { kind, label } = describeWeather(weather);
  const temp = formatTemp(weather.tempC);
  return (
    <span className="location-chip weather-chip" title={`${label}, ${temp}`}>
      <WeatherIcon kind={kind} size={mobile ? 14 : 16} />
      {label}
      <span className="weather-temp">{temp}</span>
      <button type="button" aria-label={`Remove weather ${label}`} onClick={onRemove}>
        <XIcon size={10} />
      </button>
    </span>
  );
}

import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { Brand } from '../../components/Brand';
import { AccountButton } from '../../components/AccountButton';
import { ConfirmDialog } from '../../components/Dialog';
import { FlameIcon, LockIcon, PlusIcon, SearchIcon, ShieldIcon } from '../../components/Icons';
import { useToast } from '../../components/Toast';
import { lock } from '../../crypto/session';
import { burnElement } from '../../editor/burn';
import { burnRequests } from '../../editor/burnRequests';
import { entriesStore, type EntrySummary, searchEntries, sortKey, useEntries } from '../../editor/entriesStore';
import { uploads } from '../../editor/uploads';
import { formatDay, monthLabel, plural } from '../../lib/format';
import { SyncIndicator } from '../../components/sync/SyncIndicator';
import { SyncNudge } from '../../components/sync/SyncNudge';
import { PasswordBanner, useNeedsPassword } from '../../components/security/SetPassword';
import { deleteLocalEntry, emitLocal } from '../../local/repo';
import { requireVault } from '../../local/vault';
import { useIdentity } from '../../state/identity';
import { UserChip, ViewNav } from '../../views/ViewNav';

function metaLine(e: EntrySummary): string {
  const h = e.header;
  if (e.conflict) return 'Changed on two devices · needs attention';
  if (!h) return "Couldn't decrypt";
  const first = h.location?.label ?? (h.imageCount ? plural(h.imageCount, 'photo') : null);
  return [first, plural(h.wordCount, 'word')].filter(Boolean).join(' · ');
}

function groupByMonth(items: EntrySummary[]) {
  const groups: { label: string; items: EntrySummary[] }[] = [];
  for (const e of items) {
    const iso = e.header?.createdAt ?? sortKey(e);
    const label = monthLabel(iso, e.header?.tz);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(e);
    else groups.push({ label, items: [e] });
  }
  return groups;
}

/** Entry list: the desktop sidebar and the mobile home view. */
export function EntryList({ activeId, onNew, variant }: { activeId?: string; onNew: () => void; variant: 'sidebar' | 'mobile' }) {
  const me = useIdentity();
  const needsPassword = useNeedsPassword();
  const navigate = useNavigate();
  const { items, status, error } = useEntries();
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchEntries(items, query), [items, query]);
  const groups = useMemo(() => groupByMonth(results), [results]);
  const toast = useToast();
  const rows = useRef(new Map<string, HTMLElement>());
  const [burnTarget, setBurnTarget] = useState<EntrySummary | null>(null);
  const [burning, setBurning] = useState(false);

  const askBurn = (e: EntrySummary) => {
    // The open entry burns in its editor, which also stops it saving.
    if (!burnRequests.request(e.id)) setBurnTarget(e);
  };

  const doBurn = async () => {
    const target = burnTarget;
    if (!target) return;
    setBurnTarget(null);
    setBurning(true);
    const row = rows.current.get(target.id);
    const burn = row ? burnElement(row) : null;
    try {
      await Promise.all([
        (async () => {
          await uploads.cancelEntry(target.id);
          await deleteLocalEntry(requireVault().id, target.id);
          emitLocal({ type: 'entries', ids: [target.id], origin: 'local' });
        })(),
        burn?.finished,
      ]);
    } catch (err) {
      burn?.cancel();
      toast.show(`Couldn't burn this entry: ${errorMessage(err)}`);
      return;
    } finally {
      setBurning(false);
    }
    entriesStore.remove(target.id);
    toast.show('Burned. It’s gone for good.');
    requestAnimationFrame(() => burn?.dispose());
  };

  return (
    <aside className={`entry-list ${variant}`} aria-label="Journal entries">
      <div className="entry-list-head">
        <Brand size={22} />
        <button type="button" className="icon-btn accent new-btn" aria-label="New entry" onClick={onNew}>
          <PlusIcon size={16} strokeWidth={2} />
        </button>
      </div>
      <ViewNav variant={variant === 'mobile' ? 'segmented' : 'tabs'} className={variant === 'mobile' ? '' : 'in-sidebar'} />
      <label className="search">
        <SearchIcon size={15} />
        <span className="visually-hidden">Search entries</span>
        <input type="search" placeholder="Search on this device" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>

      {needsPassword ? variant === 'mobile' && <PasswordBanner className="in-list" /> : <SyncNudge entryCount={items.length} />}
      <nav aria-label="Entries" className="entry-groups">
        {status === 'loading' && !items.length && (
          <p className="list-note" role="status">
            <span className="spinner" aria-hidden /> Decrypting entries…
          </p>
        )}
        {status === 'error' && <p className="list-note error-text">{error ?? "Couldn't load entries."}</p>}
        {status === 'ready' && !items.length && <p className="list-note">No entries yet. Start with the + button.</p>}
        {query && status === 'ready' && items.length > 0 && !results.length && <p className="list-note">Nothing matches “{query}”.</p>}
        {groups.map((g) => (
          <div className="entry-group" key={g.label}>
            <div className="eyebrow group-label">{g.label}</div>
            {g.items.map((e) => {
              const active = e.id === activeId;
              const title = e.header ? e.header.title || 'Untitled' : 'Locked entry';
              return (
                <div
                  key={e.id}
                  className={`entry-row${active ? ' active' : ''}`}
                  ref={(el) => {
                    if (el) rows.current.set(e.id, el);
                    else rows.current.delete(e.id);
                  }}
                >
                  <Link to={`/e/${e.id}`} className={`entry-link${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
                    <span className="entry-day">{formatDay(e.header?.createdAt ?? sortKey(e), e.header?.tz)}</span>
                    <span className="entry-text">
                      <span className="entry-title">{title}</span>
                      <span className={`entry-meta${e.conflict ? ' entry-attention' : ''}`}>{metaLine(e)}</span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    className="icon-btn burn-btn entry-burn"
                    aria-label={`Burn “${title}”`}
                    title="Burn this entry"
                    disabled={burning}
                    onClick={() => askBurn(e)}
                  >
                    <FlameIcon size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      <SyncIndicator className="entry-sync" />
      <div className="entry-list-foot">
        <UserChip compact />
        <span className="row" style={{ gap: 2 }}>
          {me.isAdmin && (
            <Link to="/admin" className="icon-btn" aria-label="Admin" title="Admin">
              <ShieldIcon size={16} />
            </Link>
          )}
          {!needsPassword && (
            <button type="button" className="icon-btn" aria-label="Lock journal" title="Lock journal" onClick={() => void lock().then(() => navigate('/unlock'))}>
              <LockIcon size={16} />
            </button>
          )}
          <AccountButton variant="icon" />
        </span>
      </div>

      <ConfirmDialog
        open={!!burnTarget}
        title="Burn this entry?"
        body={
          <>
            <p>
              {burnTarget?.header?.title ? <>“{burnTarget.header.title}”</> : 'This entry'} and all of its photos will be permanently deleted from this
              device{me.synced ? ', from the server and from your other devices' : ''}.
            </p>
            <p style={{ marginTop: 10 }}><strong>There is no undo.</strong> Once it burns, nobody can bring it back, including us.</p>
          </>
        }
        confirmLabel="Burn it"
        cancelLabel="Keep it"
        danger
        focusCancel
        onConfirm={() => void doBurn()}
        onCancel={() => setBurnTarget(null)}
      />
    </aside>
  );
}

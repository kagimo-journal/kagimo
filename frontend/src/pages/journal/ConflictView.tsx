import type { JSONContent } from '@tiptap/react';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { errorMessage } from '../../api/client';
import { ChevronLeftIcon } from '../../components/Icons';
import { LoadingScreen, Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import type { EntryRecord } from '../../local/db';
import { requireVault } from '../../local/vault';
import { formatLongDate, formatTime, plural } from '../../lib/format';
import { blocksOf, type Choice, conflictCount, docOf, mergeBlocks, mergeHeader, resolveSegments, type Segment } from '../../sync/merge';
import { acceptRemoteDelete, decryptCopy, type Plain, resolveConflict, saveAsNewEntry } from '../../sync/integrate';
import { renderDoc } from '../books/renderDoc';
import './conflict.css';

interface Props {
  record: EntryRecord;
  mobile: boolean;
  /** The conflict is settled: show the entry again. */
  onSettled: () => void;
  onDeleted: (id: string) => void;
}

interface Versions {
  mine: Plain;
  theirs: Plain | null;
  base: Plain | null;
}

const RENDER = { eager: false };

function Blocks({ blocks, empty }: { blocks: JSONContent[]; empty: string }) {
  if (!blocks.length) return <p className="conflict-empty">{empty}</p>;
  return <div className="prose conflict-blocks">{renderDoc(docOf(blocks), RENDER)}</div>;
}

/**
 * Shown instead of the editor when an entry was changed on this device and on another one at the
 * same time in ways that couldn't be combined (SPEC §5.2). Everything that could be combined
 * already is; the person picks a side only for the passages both devices changed.
 */
export function ConflictView({ record, mobile, onSettled, onDeleted }: Props) {
  const toast = useToast();
  const [versions, setVersions] = useState<Versions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [busy, setBusy] = useState<null | 'save' | 'copy' | 'burn'>(null);
  const kind = record.conflict?.kind ?? 'edit';

  useEffect(() => {
    let alive = true;
    const c = record.conflict;
    Promise.all([
      decryptCopy(record.id, record),
      c?.theirs ? decryptCopy(record.id, c.theirs) : Promise.resolve(null),
      c?.base ? decryptCopy(record.id, c.base) : Promise.resolve(null),
    ])
      .then(([mine, theirs, base]) => alive && setVersions({ mine, theirs, base }))
      .catch((e) => alive && setError(`Couldn't decrypt the two versions. ${errorMessage(e)}`));
    return () => {
      alive = false;
    };
  }, [record]);

  const merged = useMemo(() => {
    if (!versions?.theirs) return null;
    const { mine, theirs, base } = versions;
    const mineNewer = Date.parse(record.updatedAt) >= Date.parse(record.conflict?.theirs?.updatedAt ?? '');
    return {
      header: mergeHeader(base?.header ?? null, mine.header, theirs.header, mineNewer),
      body: mergeBlocks(blocksOf(base?.doc), blocksOf(mine.doc), blocksOf(theirs.doc)),
    };
  }, [versions, record]);

  const count = merged ? conflictCount(merged.body.segments) : 0;
  const vaultId = requireVault().id;

  const save = async (all?: Choice) => {
    if (!merged) return;
    setBusy('save');
    try {
      const picks = all ? Array<Choice>(count).fill(all) : choices;
      await resolveConflict(vaultId, record.id, { header: merged.header, doc: resolveSegments(merged.body.segments, picks) });
      toast.show('Saved. Your other devices get this version with the next sync.');
      onSettled();
    } catch (e) {
      toast.show(`Couldn't save: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** This device's version stays here; the other device's becomes an entry of its own. */
  const keepBoth = async () => {
    if (!versions?.theirs) return;
    setBusy('copy');
    try {
      const t = versions.theirs;
      await saveAsNewEntry(vaultId, { header: { ...t.header, title: `${t.header.title || 'Untitled'} (other device)` }, doc: t.doc });
      await resolveConflict(vaultId, record.id, versions.mine);
      toast.show('Kept both. The other device’s version is now a separate entry.');
      onSettled();
    } catch (e) {
      toast.show(`Couldn't keep both: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const keepDeleted = async () => {
    if (!versions) return;
    setBusy('save');
    try {
      await resolveConflict(vaultId, record.id, versions.mine);
      onSettled();
    } catch (e) {
      toast.show(`Couldn't keep it: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const burnHere = async () => {
    setBusy('burn');
    try {
      await acceptRemoteDelete(vaultId, record.id);
      toast.show('Burned here too.');
      onDeleted(record.id);
    } catch (e) {
      toast.show(`Couldn't burn it: ${errorMessage(e)}`);
      setBusy(null);
    }
  };

  const back = mobile && (
    <div className="editor-top">
      <RouterLink to="/" className="icon-btn" aria-label="All entries">
        <ChevronLeftIcon size={20} />
      </RouterLink>
    </div>
  );

  if (error) {
    return (
      <main className="journal-main">
        {back}
        <div className="entry-error">
          <p className="lede">{error}</p>
        </div>
      </main>
    );
  }
  if (!versions) {
    return (
      <main className="journal-main">
        <LoadingScreen label="Decrypting both versions…" />
      </main>
    );
  }

  const title = versions.mine.header.title || 'Untitled';
  const when = versions.mine.header.createdAt;

  if (kind === 'deleted' || !merged) {
    return (
      <main className={`journal-main${mobile ? ' is-mobile' : ''}`}>
        {back}
        <article className="entry conflict-page">
          <p className="eyebrow">Needs your attention</p>
          <h1 className="conflict-title">{title}</h1>
          <p className="lede">
            This entry was burned on another device, but this device had changes to it that hadn’t synced yet. Keep it, or burn it here too.
          </p>
          <div className="conflict-actions">
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void keepDeleted()}>
              {busy === 'save' && <Spinner />}Keep this entry
            </button>
            <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => void burnHere()}>
              {busy === 'burn' && <Spinner />}Burn it here too
            </button>
          </div>
          <div className="conflict-preview">
            <Blocks blocks={blocksOf(versions.mine.doc)} empty="(empty)" />
          </div>
        </article>
      </main>
    );
  }

  let c = -1;
  return (
    <main className={`journal-main${mobile ? ' is-mobile' : ''}`}>
      {back}
      <article className="entry conflict-page">
        <p className="eyebrow">Needs your attention</p>
        <h1 className="conflict-title">{merged.header.title || 'Untitled'}</h1>
        <p className="details-line">
          <span>{formatLongDate(when, versions.mine.header.tz)}</span>
          <span>{formatTime(when, versions.mine.header.tz)}</span>
        </p>
        <p className="lede">
          You changed this entry on this device and on another one before they could sync. Everything that could be combined already is.{' '}
          {count === 1 ? 'One passage was changed on both' : `${plural(count, 'passage')} were changed on both`}: choose which version to keep.
        </p>

        <div className="conflict-segments">
          {merged.body.segments.map((s: Segment, i) => {
            if (s.kind === 'same') {
              return (
                <div key={i} className="conflict-same">
                  <Blocks blocks={s.blocks} empty="" />
                </div>
              );
            }
            c++;
            const n = c;
            const choice = choices[n] ?? 'mine';
            const set = (v: Choice) => setChoices((cur) => Object.assign([...cur], { [n]: v }));
            return (
              <fieldset key={i} className="conflict-choice">
                <legend className="visually-hidden">Passage {n + 1} of {count}</legend>
                <div className="conflict-sides">
                  <label className={`conflict-side${choice === 'mine' || choice === 'both' ? ' chosen' : ''}`}>
                    <span className="conflict-side-head">
                      <input type="radio" name={`c${n}`} checked={choice === 'mine'} onChange={() => set('mine')} />
                      This device
                    </span>
                    <Blocks blocks={s.mine} empty="Removed on this device." />
                  </label>
                  <label className={`conflict-side${choice === 'theirs' || choice === 'both' ? ' chosen' : ''}`}>
                    <span className="conflict-side-head">
                      <input type="radio" name={`c${n}`} checked={choice === 'theirs'} onChange={() => set('theirs')} />
                      Other device
                    </span>
                    <Blocks blocks={s.theirs} empty="Removed on the other device." />
                  </label>
                </div>
                <label className="checkbox conflict-both">
                  <input type="radio" name={`c${n}`} checked={choice === 'both'} onChange={() => set('both')} />
                  <span>Keep both, this device’s first</span>
                </label>
              </fieldset>
            );
          })}
        </div>

        <div className="conflict-actions">
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void save()}>
            {busy === 'save' && <Spinner />}Save these choices
          </button>
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void save('mine')}>
            Use this device’s throughout
          </button>
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => void save('theirs')}>
            Use the other device’s throughout
          </button>
          <button type="button" className="btn btn-ghost" disabled={!!busy} onClick={() => void keepBoth()}>
            {busy === 'copy' && <Spinner />}Keep both as separate entries
          </button>
        </div>
      </article>
    </main>
  );
}

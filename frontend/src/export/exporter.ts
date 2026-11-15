/**
 * Builds a Markdown export zip entirely in the browser (SPEC §9) from the on-device journal.
 */
import type { JSONContent } from '@tiptap/react';
import { decryptBlob, decryptEntryPart } from '../crypto/content';
import { collectBlobIds } from '../editor/docText';
import { entriesStore, type EntrySummary } from '../editor/entriesStore';
import type { EntryBody, EntryHeader } from '../editor/types';
import { sniffImageType } from '../images/process';
import { loadBlobCipher } from '../images/source';
import { getEntry } from '../local/repo';
import { changeVault, requireVault } from '../local/vault';
import { combinedEntryMarkdown, docToMarkdown, frontMatter, slugify, uniqueName } from './markdown';
import { zip } from './zip';

export interface ExportOptions {
  /** Specific entries, or all (optionally within a date range). */
  ids?: string[];
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
  includeImages: boolean;
  combined: boolean;
  onProgress?: (message: string) => void;
}

export interface ExportResult {
  count: number;
  failed: string[];
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** YYYY-MM-DD of an instant in a time zone. */
export function ymd(iso: string, tz?: string): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function hhmm(iso: string, tz?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return '';
  }
}

function selectEntries(items: EntrySummary[], o: ExportOptions): EntrySummary[] {
  if (o.ids) return items.filter((e) => o.ids!.includes(e.id));
  return items.filter((e) => {
    const day = ymd(e.header?.createdAt ?? e.createdAt, e.header?.tz);
    return (!o.from || day >= o.from) && (!o.to || day <= o.to);
  });
}

function label(e: EntrySummary): string {
  const h = e.header;
  return h ? `“${h.title || 'Untitled'}” (${ymd(h.createdAt, h.tz)})` : `entry ${e.id.slice(0, 8)}`;
}

export async function exportEntriesZip(o: ExportOptions): Promise<ExportResult> {
  await entriesStore.load();
  const selected = selectEntries(entriesStore.get().items, o).reverse(); // oldest first
  const failed: string[] = [];
  const files: Record<string, Uint8Array> = {};
  const utf8 = new TextEncoder();
  const root = `journal-export-${ymd(new Date().toISOString())}`;
  const taken = new Set<string>();
  const imageNames = new Map<string, string>(); // blobId -> images/<id>.<ext>
  const decrypted: { e: EntrySummary; header: EntryHeader; doc: JSONContent }[] = [];

  for (let i = 0; i < selected.length; i++) {
    const e = selected[i];
    o.onProgress?.(`Decrypting ${i + 1} of ${selected.length}…`);
    try {
      const full = await getEntry(requireVault().id, e.id);
      if (!full) throw new Error('missing');
      const [header, body] = await Promise.all([
        decryptEntryPart<EntryHeader>(e.id, 'header', full.header),
        decryptEntryPart<EntryBody>(e.id, 'body', full.body),
      ]);
      decrypted.push({ e, header, doc: body.doc });
    } catch {
      failed.push(label(e));
    }
  }

  if (o.includeImages) {
    const ids = [...new Set(decrypted.flatMap((d) => collectBlobIds(d.doc)))];
    for (let i = 0; i < ids.length; i++) {
      o.onProgress?.(`Decrypting image ${i + 1} of ${ids.length}…`);
      try {
        const { nonce, ct } = await loadBlobCipher(ids[i]);
        const bytes = await decryptBlob(ids[i], nonce, ct);
        const name = `images/${ids[i]}.${EXT[sniffImageType(bytes)] ?? 'bin'}`;
        files[`${root}/${name}`] = bytes;
        imageNames.set(ids[i], name);
      } catch {
        failed.push(`image ${ids[i].slice(0, 8)}`);
      }
    }
  }

  o.onProgress?.('Writing Markdown…');
  const combined: string[] = [];
  for (const { header, doc } of decrypted) {
    const date = ymd(header.createdAt, header.tz);
    const prefix = o.combined ? '' : '../';
    const body = docToMarkdown(doc, {
      imagePath: (id) => (imageNames.has(id) ? prefix + imageNames.get(id)! : null),
      entry: header,
    });
    if (o.combined) {
      combined.push(
        combinedEntryMarkdown({
          title: header.title ?? '',
          when: `${date} ${hhmm(header.createdAt, header.tz)}`.trim(),
          location: header.location?.label,
          wordCount: header.wordCount ?? 0,
          body,
        }),
      );
    } else {
      const fm = frontMatter({
        title: header.title,
        date: header.createdAt,
        timezone: header.tz,
        location: header.location?.label ?? null,
        words: header.wordCount,
      });
      const name = uniqueName(`${date.slice(0, 4)}/${date}-${slugify(header.title)}`, '.md', taken);
      files[`${root}/${name}`] = utf8.encode(`${fm}\n\n${body}\n`);
    }
  }
  if (o.combined) files[`${root}/journal.md`] = utf8.encode(`# Journal\n\n${combined.join('\n\n---\n\n')}\n`);

  if (!decrypted.length) throw new Error(selected.length ? 'None of the selected entries could be decrypted.' : 'There are no entries to export.');

  o.onProgress?.('Compressing…');
  const archive = await zip(files);
  const url = URL.createObjectURL(new Blob([archive as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  archive.fill(0); // the Blob has its own copy
  try {
    const a = Object.assign(document.createElement('a'), { href: url, download: `${root}.zip` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  for (const k of Object.keys(files)) files[k].fill(0);
  // A whole-journal export counts as a backup (backup reminders for journals without sync).
  if (!o.ids && !o.from && !o.to) await changeVault((v) => ({ ...v, exportedAt: new Date().toISOString() })).catch(() => {});
  return { count: decrypted.length, failed };
}

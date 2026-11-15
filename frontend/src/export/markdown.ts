/**
 * TipTap/ProseMirror JSON → Markdown (SPEC §9). Pure functions, unit-tested.
 */
import type { JSONContent } from '@tiptap/react';
import { dividerLabel } from '../editor/returnDividerRule';

export interface MarkdownOptions {
  /** Maps a blob ID to the relative image path used in links, or null to omit the image. */
  imagePath: (blobId: string) => string | null;
  /** The entry's date and time zone: a divider added when writing resumed later is followed by its time. */
  entry?: { createdAt: string; tz: string };
}

/** Escapes characters that would otherwise be read as Markdown syntax. */
export function escapeText(text: string): string {
  return text.replace(/([\\`*_[\]<>|~])/g, '\\$1').replace(/={2,}/g, (m) => m.replace(/=/g, '\\='));
}

/** Escapes block-level markers that are only special at the start of a line. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)([>+-])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)(\d+)([.)])(?=\s|$)/, '$1$2\\$3')
    .replace(/^(\s*)(=+|-{3,})\s*$/, '$1\\$2');
}

function escapeUrl(url: string): string {
  return url.replace(/[()\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

type Mark = NonNullable<JSONContent['marks']>[number];

function wrap(text: string, marks: Mark[] | undefined): string {
  if (!marks?.length) return escapeText(text);
  const code = marks.find((m) => m.type === 'code');
  let out = code ? '`' + text.replace(/`/g, 'ˋ') + '`' : escapeText(text);
  // Keep surrounding whitespace outside the emphasis markers, or Markdown won't parse them.
  const lead = out.match(/^\s*/)![0];
  const trail = out.match(/\s*$/)![0];
  let core = out.slice(lead.length, out.length - trail.length);
  if (!core) return out;
  for (const m of marks) {
    if (m.type === 'bold') core = `**${core}**`;
    else if (m.type === 'italic') core = `*${core}*`;
    else if (m.type === 'strike') core = `~~${core}~~`;
    else if (m.type === 'highlight') core = `==${core}==`;
  }
  const link = marks.find((m) => m.type === 'link');
  // Only the schemes the editor and the books accept become links; anything else stays as text.
  const href = typeof link?.attrs?.href === 'string' ? link.attrs.href.trim() : '';
  if (/^(https?:|mailto:)/i.test(href)) core = `[${core}](${escapeUrl(href)})`;
  out = lead + core + trail;
  return out;
}

function inline(nodes: JSONContent[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += wrap(n.text ?? '', n.marks);
    else if (n.type === 'hardBreak') out += '\\\n';
    else out += inline(n.content);
  }
  return out;
}

function inlineBlock(nodes: JSONContent[] | undefined): string {
  return inline(nodes)
    .split('\n')
    .map((l) => escapeLineStart(l))
    .join('\n');
}

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split('\n')
    .map((l, i) => (l ? (i === 0 ? first : prefix) + l : i === 0 ? first.trimEnd() : ''))
    .join('\n');
}

function imageMarkdown(n: JSONContent, opts: MarkdownOptions): string | null {
  const blobId = n.attrs?.blobId as string | undefined;
  if (!blobId) return null;
  const caption = String(n.attrs?.caption ?? '').trim();
  const alt = String(n.attrs?.alt ?? '').trim() || caption;
  const path = opts.imagePath(blobId);
  const parts: string[] = [];
  if (path) parts.push(`![${escapeText(alt)}](${escapeUrl(path)})`);
  if (caption) parts.push(`*${escapeText(caption)}*`);
  return parts.length ? parts.join('\n') : null;
}

function block(n: JSONContent, opts: MarkdownOptions): string | null {
  // Paragraph and heading alignment (attrs.textAlign) has no portable Markdown form, so a centred
  // block is written like any other.
  switch (n.type) {
    case 'paragraph': {
      const t = inlineBlock(n.content);
      return t.trim() ? t : null;
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level ?? 2)));
      return `${'#'.repeat(level)} ${inline(n.content).replace(/\n/g, ' ')}`;
    }
    case 'blockquote': {
      const inner = blocks(n.content, opts);
      return inner ? indent(inner, '> ').replace(/^$/gm, '>') : null;
    }
    case 'bulletList':
    case 'orderedList': {
      const ordered = n.type === 'orderedList';
      const start = Number(n.attrs?.start ?? 1);
      const items = (n.content ?? []).map((li, i) => {
        const marker = ordered ? `${start + i}. ` : '- ';
        const body = blocks(li.content, opts, '\n') || '';
        return indent(body, ' '.repeat(marker.length), marker);
      });
      return items.join('\n');
    }
    case 'horizontalRule':
      return typeof n.attrs?.at === 'string' && opts.entry ? `---\n\n*${escapeText(dividerLabel(n.attrs.at, opts.entry))}*` : '---';
    case 'codeBlock': {
      const text = (n.content ?? []).map((c) => c.text ?? '').join('');
      const fence = text.includes('```') ? '~~~' : '```';
      return `${fence}${n.attrs?.language ?? ''}\n${text}\n${fence}`;
    }
    case 'encryptedImage':
      return imageMarkdown(n, opts);
    default:
      return n.content ? blocks(n.content, opts) : null;
  }
}

/**
 * Joins converted blocks. A divider always gets blank lines around it, even inside a list item,
 * or `---` under a line of text would turn that line into a heading.
 */
function blocks(nodes: JSONContent[] | undefined, opts: MarkdownOptions, sep = '\n\n'): string {
  let out = '';
  let prevRule = false;
  for (const n of nodes ?? []) {
    const b = block(n, opts);
    if (b === null || b === '') continue;
    const rule = n.type === 'horizontalRule';
    if (out) out += rule || prevRule ? '\n\n' : sep;
    out += b;
    prevRule = rule;
  }
  return out;
}

export function docToMarkdown(doc: JSONContent, opts: MarkdownOptions): string {
  return blocks(doc.content, opts).replace(/\n{3,}/g, '\n\n').trim();
}

/** YAML scalar in double quotes. */
export function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export interface FrontMatter {
  title: string;
  date: string;
  timezone: string;
  location: string | null;
  words: number;
}

export function frontMatter(f: FrontMatter): string {
  const lines = ['---', `title: ${yamlString(f.title || 'Untitled')}`, `date: ${f.date}`, `timezone: ${f.timezone}`];
  if (f.location) lines.push(`location: ${yamlString(f.location)}`);
  lines.push(`words: ${f.words}`, '---');
  return lines.join('\n');
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'untitled';
}

/** Picks a unique file name, appending -2, -3… on collisions. */
export function uniqueName(base: string, ext: string, taken: Set<string>): string {
  let name = `${base}${ext}`;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}${ext}`;
  taken.add(name);
  return name;
}

/**
 * One entry of the combined `journal.md`: a `##` heading with the title, an italic line with the
 * date, time, place and word count, then the body. The title and place are user text, so they are
 * escaped like any other text (security review L6): a title can't add Markdown or HTML of its own.
 */
export function combinedEntryMarkdown(e: { title: string; when: string; location?: string | null; wordCount: number; body: string }): string {
  // One line each; entity-like `&name;` is neutralised; a leading `#` or a trailing ` #` would change the heading.
  const inline = (v: string) => escapeText(v.replace(/\s+/g, ' ').trim()).replace(/&(?=#?[a-zA-Z0-9]+;)/g, '&amp;');
  const title = inline(e.title);
  const heading = title ? title.replace(/^(#+)/, '\\$1').replace(/(\s)(#+)$/, '$1\\$2') : 'Untitled';
  const place = e.location ? inline(e.location) : '';
  const meta = [e.when, place || null, `${e.wordCount} words`].filter(Boolean);
  return `## ${heading}\n\n*${meta.join(' · ')}*\n\n${e.body}`.trim();
}

/**
 * Three-way merge of entry versions (SPEC §5.2 "Conflicts"). The server only ever sees
 * ciphertext, so merging happens here, on decrypted copies, and only in memory.
 *
 * The body is merged block by block (top-level paragraphs, headings, images, lists…) with a
 * diff3 over the base (last copy both sides agreed on), this device's copy and the other one:
 * a block changed on one side only takes that side; additions on both sides at the same place are
 * both kept; only a block changed on *both* sides becomes a conflict for the person to settle.
 * Header fields (title, date, time zone, location, weather) are merged one by one; when both sides changed
 * the same field, the more recent edit wins. Derived header fields are recomputed from the result.
 */
import type { JSONContent } from '@tiptap/react';
import { docStats } from '../editor/docText';
import { EMPTY_DOC, type EntryHeader } from '../editor/types';

export type Segment =
  | { kind: 'same'; blocks: JSONContent[] }
  | { kind: 'conflict'; base: JSONContent[]; mine: JSONContent[]; theirs: JSONContent[] };

export interface BodyMerge {
  segments: Segment[];
  clean: boolean;
}

/** Above this many cells the LCS table is too big; the whole body then becomes one conflict. */
const MAX_CELLS = 4_000_000;

const key = (b: JSONContent) => JSON.stringify(b);

export function blocksOf(doc: JSONContent | null | undefined): JSONContent[] {
  return Array.isArray(doc?.content) ? doc!.content! : [];
}

export function docOf(blocks: JSONContent[]): JSONContent {
  return blocks.length ? { type: 'doc', content: blocks } : structuredClone(EMPTY_DOC);
}

/** Longest common subsequence of two key lists, as a map from a-index to b-index. */
function lcs(a: string[], b: string[]): Map<number, number> | null {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return null;
  // Suffix lengths: dp[i][j] = LCS of a[i:], b[j:]; one flat array.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.set(i, j);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** One side's change: base blocks [s, e) replaced by `rep` (s === e: an insertion before s). */
interface Hunk {
  s: number;
  e: number;
  rep: JSONContent[];
  side: 'mine' | 'theirs';
}

function hunksOf(n: number, other: JSONContent[], match: Map<number, number>, side: Hunk['side']): Hunk[] {
  const pairs: [number, number][] = [[-1, -1], ...[...match.entries()].sort((x, y) => x[0] - y[0]), [n, other.length]];
  const out: Hunk[] = [];
  for (let p = 1; p < pairs.length; p++) {
    const [b0, o0] = pairs[p - 1];
    const [b1, o1] = pairs[p];
    if (b1 === b0 + 1 && o1 === o0 + 1) continue;
    const s = b0 + 1;
    const rep = other.slice(o0 + 1, o1);
    // n blocks rewritten into n blocks: n separate edits, so a conflict stays as small as it can.
    if (rep.length === b1 - s) rep.forEach((r, i) => out.push({ s: s + i, e: s + i + 1, rep: [r], side }));
    else out.push({ s, e: b1, rep, side });
  }
  return out;
}

/** Whether two hunks touch the same base blocks (insertions only clash with ranges around them). */
function overlaps(a: Hunk, b: Hunk): boolean {
  const ai = a.s === a.e;
  const bi = b.s === b.e;
  if (ai && bi) return a.s === b.s;
  if (ai) return b.s < a.s && a.s < b.e;
  if (bi) return a.s < b.s && b.s < a.e;
  return a.s < b.e && b.s < a.e;
}

/** Base blocks [s, e) with one side's hunks (all inside that range) applied. */
function apply(base: JSONContent[], s: number, e: number, hunks: Hunk[]): JSONContent[] {
  const out: JSONContent[] = [];
  let i = s;
  for (const h of hunks) {
    out.push(...base.slice(i, h.s), ...h.rep);
    i = h.e;
  }
  out.push(...base.slice(i, e));
  return out;
}

export function mergeBlocks(base: JSONContent[], mine: JSONContent[], theirs: JSONContent[]): BodyMerge {
  const kb = base.map(key);
  const km = mine.map(key);
  const kt = theirs.map(key);
  if (sameList(km, kt) || sameList(kb, kt)) return { segments: [{ kind: 'same', blocks: mine }], clean: true };
  if (sameList(kb, km)) return { segments: [{ kind: 'same', blocks: theirs }], clean: true };

  const toMine = lcs(kb, km);
  const toTheirs = lcs(kb, kt);
  if (!toMine || !toTheirs) {
    return { segments: [{ kind: 'conflict', base, mine, theirs }], clean: false };
  }

  // Every change from either side, in base order (an insertion before a range at the same spot).
  const all = [...hunksOf(base.length, mine, toMine, 'mine'), ...hunksOf(base.length, theirs, toTheirs, 'theirs')].sort(
    (x, y) => x.s - y.s || (x.s === x.e ? 0 : 1) - (y.s === y.e ? 0 : 1) || (x.side === 'mine' ? -1 : 1),
  );

  const segments: Segment[] = [];
  let clean = true;
  const emit = (blocks: JSONContent[]) => {
    if (!blocks.length) return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'same') last.blocks.push(...blocks);
    else segments.push({ kind: 'same', blocks: [...blocks] });
  };

  let pos = 0;
  for (let g = 0; g < all.length; ) {
    // A group: hunks linked by overlaps, transitively.
    const group = [all[g]];
    let gs = all[g].s;
    let ge = all[g].e;
    let next = g + 1;
    for (; next < all.length; next++) {
      const h = all[next];
      if (!group.some((x) => overlaps(x, h))) break;
      group.push(h);
      gs = Math.min(gs, h.s);
      ge = Math.max(ge, h.e);
    }
    g = next;
    emit(base.slice(pos, gs));
    pos = ge;
    const mineH = group.filter((h) => h.side === 'mine');
    const theirsH = group.filter((h) => h.side === 'theirs');
    const m = apply(base, gs, ge, mineH);
    const t = apply(base, gs, ge, theirsH);
    if (!theirsH.length || sameList(m.map(key), t.map(key))) emit(m);
    else if (!mineH.length) emit(t);
    else if (gs === ge) emit([...m, ...t]); // both added something at the same spot: keep both
    else {
      clean = false;
      segments.push({ kind: 'conflict', base: base.slice(gs, ge), mine: m, theirs: t });
    }
  }
  emit(base.slice(pos));
  return { segments, clean };
}

export type Choice = 'mine' | 'theirs' | 'both';

/** The body after the person chose a side for every conflict (missing choices keep this device's). */
export function resolveSegments(segments: Segment[], choices: Choice[]): JSONContent {
  const out: JSONContent[] = [];
  let c = 0;
  for (const s of segments) {
    if (s.kind === 'same') {
      out.push(...s.blocks);
      continue;
    }
    const choice = choices[c++] ?? 'mine';
    if (choice === 'mine' || choice === 'both') out.push(...s.mine);
    if (choice === 'theirs' || choice === 'both') out.push(...s.theirs);
  }
  return docOf(out);
}

export function conflictCount(segments: Segment[]): number {
  return segments.filter((s) => s.kind === 'conflict').length;
}

// ---- header ----------------------------------------------------------------------------------

/** Header fields people edit; the rest are derived from the body. */
const EDITABLE: (keyof EntryHeader)[] = ['title', 'createdAt', 'tz', 'location', 'weather'];

export function mergeHeader(base: EntryHeader | null, mine: EntryHeader, theirs: EntryHeader, mineIsNewer: boolean): EntryHeader {
  const out: EntryHeader = { ...mine };
  for (const f of EDITABLE) {
    const b = JSON.stringify(base?.[f] ?? null);
    const m = JSON.stringify(mine[f] ?? null);
    const t = JSON.stringify(theirs[f] ?? null);
    if (m === t) continue;
    const take = m === b ? theirs : t === b ? mine : mineIsNewer ? mine : theirs;
    (out as unknown as Record<string, unknown>)[f] = take[f] ?? null;
  }
  return out;
}

/** Recomputes the header fields that come from the body (snippet, counts, cover image). */
export function withBodyStats(header: EntryHeader, doc: JSONContent): EntryHeader {
  const s = docStats(doc);
  return { ...header, snippet: s.snippet, wordCount: s.wordCount, imageCount: s.imageCount, coverBlobId: s.coverBlobId, photoCount: s.imageCount };
}

import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/react';
import type { EntryHeader } from '../editor/types';
import { conflictCount, mergeBlocks, mergeHeader, resolveSegments, withBodyStats } from './merge';

const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const ps = (...t: string[]) => t.map(p);
const texts = (doc: JSONContent) => (doc.content ?? []).map((b) => b.content?.[0]?.text);

function merged(base: string[], mine: string[], theirs: string[]) {
  const r = mergeBlocks(ps(...base), ps(...mine), ps(...theirs));
  return { ...r, texts: texts(resolveSegments(r.segments, [])) };
}

describe('mergeBlocks', () => {
  it('takes the only side that changed', () => {
    expect(merged(['a', 'b'], ['a', 'b'], ['a', 'B'])).toMatchObject({ clean: true, texts: ['a', 'B'] });
    expect(merged(['a', 'b'], ['A', 'b'], ['a', 'b'])).toMatchObject({ clean: true, texts: ['A', 'b'] });
  });

  it('combines edits to different blocks', () => {
    const r = merged(['a', 'b', 'c', 'd'], ['A', 'b', 'c', 'd'], ['a', 'b', 'c', 'D']);
    expect(r).toMatchObject({ clean: true, texts: ['A', 'b', 'c', 'D'] });
  });

  it('keeps a deletion on one side and an edit elsewhere on the other', () => {
    const r = merged(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'C']);
    expect(r).toMatchObject({ clean: true, texts: ['a', 'C'] });
  });

  it('keeps both when each side appended something', () => {
    const r = merged(['a'], ['a', 'mine'], ['a', 'theirs']);
    expect(r).toMatchObject({ clean: true, texts: ['a', 'mine', 'theirs'] });
  });

  it('merges edits to neighbouring blocks', () => {
    expect(merged(['a', 'b', 'c'], ['a', 'B', 'c'], ['a', 'b', 'C'])).toMatchObject({ clean: true, texts: ['a', 'B', 'C'] });
    expect(merged(['a', 'b'], ['new', 'a', 'b'], ['A', 'b'])).toMatchObject({ clean: true, texts: ['new', 'A', 'b'] });
  });

  it('keeps clean parts around a conflict', () => {
    const r = mergeBlocks(ps('a', 'b', 'c', 'd'), ps('A', 'mine', 'c', 'd'), ps('a', 'theirs', 'c', 'D'));
    expect(conflictCount(r.segments)).toBe(1);
    expect(texts(resolveSegments(r.segments, ['theirs']))).toEqual(['A', 'theirs', 'c', 'D']);
  });

  it('accepts identical changes on both sides', () => {
    expect(merged(['a', 'b'], ['a', 'X'], ['a', 'X'])).toMatchObject({ clean: true, texts: ['a', 'X'] });
  });

  it('reports a conflict when both sides changed the same block', () => {
    const r = mergeBlocks(ps('a', 'b', 'c'), ps('a', 'mine', 'c'), ps('a', 'theirs', 'c'));
    expect(r.clean).toBe(false);
    expect(conflictCount(r.segments)).toBe(1);
    expect(texts(resolveSegments(r.segments, ['mine']))).toEqual(['a', 'mine', 'c']);
    expect(texts(resolveSegments(r.segments, ['theirs']))).toEqual(['a', 'theirs', 'c']);
    expect(texts(resolveSegments(r.segments, ['both']))).toEqual(['a', 'mine', 'theirs', 'c']);
  });

  it('reports an edit against a deletion of the same block as a conflict', () => {
    const r = mergeBlocks(ps('a', 'b'), ps('a'), ps('a', 'B'));
    expect(r.clean).toBe(false);
    expect(texts(resolveSegments(r.segments, ['theirs']))).toEqual(['a', 'B']);
    expect(texts(resolveSegments(r.segments, ['mine']))).toEqual(['a']);
  });

  it('handles a missing base (nothing in common) as one conflict', () => {
    const r = mergeBlocks([], ps('x'), ps('y'));
    // Both "added" everything: kept, this device's first.
    expect(texts(resolveSegments(r.segments, []))).toEqual(['x', 'y']);
  });

  it('never returns an empty doc', () => {
    const r = mergeBlocks(ps('a'), [], ps('a'));
    expect(resolveSegments(r.segments, []).content?.length).toBeGreaterThan(0);
  });
});

const header = (o: Partial<EntryHeader>): EntryHeader => ({
  v: 1, title: 't', snippet: '', createdAt: '2026-01-01T10:00:00+00:00', tz: 'Europe/London', location: null, wordCount: 0, imageCount: 0, ...o,
});

describe('mergeHeader', () => {
  it('merges fields independently', () => {
    const base = header({});
    const m = mergeHeader(base, header({ title: 'Mine' }), header({ location: { label: 'Bristol', precision: 'city' } }), true);
    expect(m.title).toBe('Mine');
    expect(m.location?.label).toBe('Bristol');
    const w = mergeHeader(base, header({ title: 'Mine' }), header({ weather: { code: 61, day: true, tempC: 9 } }), true);
    expect(w.weather?.code).toBe(61);
  });

  it('lets the newer edit win when both changed a field', () => {
    const base = header({});
    expect(mergeHeader(base, header({ title: 'Mine' }), header({ title: 'Theirs' }), true).title).toBe('Mine');
    expect(mergeHeader(base, header({ title: 'Mine' }), header({ title: 'Theirs' }), false).title).toBe('Theirs');
  });

  it('recomputes derived fields from the body', () => {
    const h = withBodyStats(header({ wordCount: 99 }), { type: 'doc', content: ps('two words') });
    expect(h.wordCount).toBe(2);
    expect(h.snippet).toBe('two words');
  });
});

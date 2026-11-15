import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/react';
import { combinedEntryMarkdown, docToMarkdown, escapeText, frontMatter, slugify, uniqueName } from './markdown';

const opts = { imagePath: (id: string) => `../images/${id}.jpg` };
type Mark = { type: string; attrs?: Record<string, unknown> };
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const t = (text: string, marks?: Mark[]): JSONContent => ({ type: 'text', text, ...(marks ? { marks } : {}) });

describe('docToMarkdown', () => {
  it('converts paragraphs, headings and marks', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [t('A walk')] },
        p(t('The river was '), t('higher', [{ type: 'bold' }]), t(' than '), t('expected', [{ type: 'italic' }]), t('.')),
        p(t('see '), t('this', [{ type: 'link', attrs: { href: 'https://example.com/a (b)' } }]), t(' and '), t('x*y', [{ type: 'code' }])),
      ],
    };
    expect(docToMarkdown(doc, opts)).toBe(
      '## A walk\n\nThe river was **higher** than *expected*.\n\nsee [this](https://example.com/a%20%28b%29) and `x*y`',
    );
  });

  it('keeps whitespace outside emphasis markers', () => {
    expect(docToMarkdown({ type: 'doc', content: [p(t('a'), t(' bold ', [{ type: 'bold' }]), t('b'))] }, opts)).toBe('a **bold** b');
  });

  it('converts nested lists, quotes, hard breaks and rules', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [p(t('one')), { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('nested'))] }] }] },
            { type: 'listItem', content: [p(t('two'))] },
          ],
        },
        { type: 'blockquote', content: [p(t('quoted'), { type: 'hardBreak' }, t('line'))] },
        { type: 'horizontalRule' },
      ],
    };
    expect(docToMarkdown(doc, opts)).toBe('- one\n  1. nested\n- two\n\n> quoted\\\n> line\n\n---');
  });

  it('writes highlights as ==text== and escapes stray runs of equals signs', () => {
    const doc: JSONContent = { type: 'doc', content: [p(t('a '), t('marked', [{ type: 'highlight' }]), t(' and '), t('both', [{ type: 'bold' }, { type: 'highlight' }]), t(' a==b'))] };
    expect(docToMarkdown(doc, opts)).toBe('a ==marked== and ==**both**== a\\=\\=b');
    expect(docToMarkdown({ type: 'doc', content: [p(t(' padded ', [{ type: 'highlight' }]))] }, opts)).toBe('==padded==');
  });

  it('surrounds section dividers with blank lines, also inside list items', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        p(t('before')),
        { type: 'horizontalRule' },
        p(t('after')),
        { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('item')), { type: 'horizontalRule' }, p(t('more'))] }] },
      ],
    };
    expect(docToMarkdown(doc, opts)).toBe('before\n\n---\n\nafter\n\n- item\n\n  ---\n\n  more');
  });

  it('follows a divider added on coming back later with its time', () => {
    const doc: JSONContent = { type: 'doc', content: [p(t('before')), { type: 'horizontalRule', attrs: { at: '2026-11-12T21:40:00+00:00' } }, p(t('after'))] };
    const entry = { createdAt: '2026-11-12T08:00:00+00:00', tz: 'Europe/London' };
    expect(docToMarkdown(doc, { ...opts, entry })).toBe('before\n\n---\n\n*21:40*\n\nafter');
    expect(docToMarkdown(doc, opts)).toBe('before\n\n---\n\nafter');
  });

  it('keeps centred paragraphs and headings as plain Markdown', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [t('Title')] },
        { type: 'paragraph', attrs: { textAlign: 'center' }, content: [t('Centred.')] },
        { type: 'paragraph', attrs: { textAlign: 'left' }, content: [t('Left.')] },
      ],
    };
    expect(docToMarkdown(doc, opts)).toBe('# Title\n\nCentred.\n\nLeft.');
  });

  it('renders images with captions', () => {
    const doc: JSONContent = { type: 'doc', content: [{ type: 'encryptedImage', attrs: { blobId: 'b1', caption: 'The footbridge, just before dark.', alt: '' } }] };
    expect(docToMarkdown(doc, opts)).toBe('![The footbridge, just before dark.](../images/b1.jpg)\n*The footbridge, just before dark.*');
    expect(docToMarkdown(doc, { imagePath: () => null })).toBe('*The footbridge, just before dark.*');
  });

  it('escapes Markdown-special characters', () => {
    expect(escapeText('a*b_c[d]`e`')).toBe('a\\*b\\_c\\[d\\]\\`e\\`');
    const doc: JSONContent = { type: 'doc', content: [p(t('# not a heading')), p(t('1. not a list')), p(t('- nope'))] };
    expect(docToMarkdown(doc, opts)).toBe('\\# not a heading\n\n1\\. not a list\n\n\\- nope');
  });
});

describe('front matter and names', () => {
  it('writes YAML front matter, omitting a null location', () => {
    expect(frontMatter({ title: 'A "long" walk', date: '2026-11-11T21:40:00+00:00', timezone: 'Europe/London', location: null, words: 412 })).toBe(
      '---\ntitle: "A \\"long\\" walk"\ndate: 2026-11-11T21:40:00+00:00\ntimezone: Europe/London\nwords: 412\n---',
    );
    expect(frontMatter({ title: '', date: 'd', timezone: 'UTC', location: 'Clifton, Bristol', words: 1 })).toContain('location: "Clifton, Bristol"');
  });

  it('slugifies titles and de-duplicates names', () => {
    expect(slugify('A long walk after the rain')).toBe('a-long-walk-after-the-rain');
    expect(slugify('Mum’s birthday — Café')).toBe('mum-s-birthday-cafe');
    expect(slugify('')).toBe('untitled');
    const taken = new Set<string>();
    expect(uniqueName('2026/2026-11-11-x', '.md', taken)).toBe('2026/2026-11-11-x.md');
    expect(uniqueName('2026/2026-11-11-x', '.md', taken)).toBe('2026/2026-11-11-x-2.md');
  });
});

describe('combinedEntryMarkdown (security review L6)', () => {
  const base = { when: '2026-11-11 21:40', wordCount: 3, body: 'Body text.' };

  it('writes a heading, a meta line and the body', () => {
    expect(combinedEntryMarkdown({ ...base, title: 'A long walk', location: 'Clifton, Bristol' })).toBe(
      '## A long walk\n\n*2026-11-11 21:40 · Clifton, Bristol · 3 words*\n\nBody text.',
    );
  });

  it('escapes Markdown and HTML in the title', () => {
    const md = combinedEntryMarkdown({ ...base, title: '<img src=x onerror=alert(1)> *bold* [link](http://evil) ==hi==' });
    const heading = md.split('\n')[0];
    expect(heading).toBe('## \\<img src=x onerror=alert(1)\\> \\*bold\\* \\[link\\](http://evil) \\=\\=hi\\=\\=');
    expect(heading).not.toMatch(/(^|[^\\])[<*[]/);
  });

  it('keeps the title on one line and its #s from changing the heading', () => {
    expect(combinedEntryMarkdown({ ...base, title: '# Not a level-1\n\n---\nRoom #' }).split('\n')[0]).toBe('## \\# Not a level-1 --- Room \\#');
  });

  it('escapes the location inside the italic meta line', () => {
    const md = combinedEntryMarkdown({ ...base, title: 'x', location: '*Soho* _London_ <b>&amp;</b>' });
    expect(md.split('\n')[2]).toBe('*2026-11-11 21:40 · \\*Soho\\* \\_London\\_ \\<b\\>&amp;amp;\\</b\\> · 3 words*');
  });

  it('uses "Untitled" for an empty title and omits a missing place', () => {
    expect(combinedEntryMarkdown({ ...base, title: '  ', location: null }).split('\n\n').slice(0, 2)).toEqual(['## Untitled', '*2026-11-11 21:40 · 3 words*']);
  });
});

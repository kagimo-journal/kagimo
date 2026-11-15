/**
 * Writing typography (Settings → Appearance → Writing): the face, size and line spacing of the
 * entry title and body. Applied as CSS variables (--writing-font, --writing-size,
 * --writing-leading); every face is self-hosted and its CSS is loaded only when it is needed.
 */

export type WritingFontId =
  | 'newsreader'
  | 'eb-garamond'
  | 'cormorant-garamond'
  | 'libre-caslon'
  | 'literata'
  | 'source-serif-4'
  | 'fraunces'
  | 'inter'
  | 'ibm-plex-sans'
  | 'ibm-plex-mono';
export type WritingSize = 'small' | 'medium' | 'large' | 'xlarge';
export type WritingLeading = 'compact' | 'comfortable' | 'airy';

export interface WritingSettings {
  font: WritingFontId;
  size: WritingSize;
  leading: WritingLeading;
}

export interface WritingFont {
  id: WritingFontId;
  name: string;
  group: 'Classic serifs' | 'Modern serifs' | 'Sans & mono';
  /** CSS font-family stack. */
  family: string;
  /** Optical size correction, so every face reads at about the same size at a given setting. */
  scale: number;
  /** Loads the face's @font-face rules (a separate CSS chunk per face). */
  load: () => Promise<unknown>;
}

const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";
const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', sans-serif";

export const WRITING_FONTS: WritingFont[] = [
  {
    id: 'newsreader', name: 'Newsreader', group: 'Classic serifs', family: `'Newsreader', ${SERIF_FALLBACK}`, scale: 1,
    // Regular, italic and medium are part of the main bundle (the interface uses them too).
    load: () => import('@fontsource/newsreader/700.css'),
  },
  {
    id: 'eb-garamond', name: 'EB Garamond', group: 'Classic serifs', family: `'EB Garamond Variable', ${SERIF_FALLBACK}`, scale: 1.05,
    load: () => Promise.all([import('@fontsource-variable/eb-garamond/wght.css'), import('@fontsource-variable/eb-garamond/wght-italic.css')]),
  },
  {
    id: 'cormorant-garamond', name: 'Cormorant Garamond', group: 'Classic serifs', family: `'Cormorant Garamond Variable', ${SERIF_FALLBACK}`, scale: 1.12,
    load: () => Promise.all([import('@fontsource-variable/cormorant-garamond/wght.css'), import('@fontsource-variable/cormorant-garamond/wght-italic.css')]),
  },
  {
    id: 'libre-caslon', name: 'Libre Caslon Text', group: 'Classic serifs', family: `'Libre Caslon Text', ${SERIF_FALLBACK}`, scale: 0.92,
    load: () =>
      Promise.all([
        import('@fontsource/libre-caslon-text/400.css'),
        import('@fontsource/libre-caslon-text/400-italic.css'),
        import('@fontsource/libre-caslon-text/700.css'),
      ]),
  },
  {
    id: 'literata', name: 'Literata', group: 'Modern serifs', family: `'Literata Variable', ${SERIF_FALLBACK}`, scale: 0.95,
    load: () => Promise.all([import('@fontsource-variable/literata/opsz.css'), import('@fontsource-variable/literata/opsz-italic.css')]),
  },
  {
    id: 'source-serif-4', name: 'Source Serif 4', group: 'Modern serifs', family: `'Source Serif 4 Variable', ${SERIF_FALLBACK}`, scale: 0.97,
    load: () => Promise.all([import('@fontsource-variable/source-serif-4/opsz.css'), import('@fontsource-variable/source-serif-4/opsz-italic.css')]),
  },
  {
    id: 'fraunces', name: 'Fraunces', group: 'Modern serifs', family: `'Fraunces Variable', ${SERIF_FALLBACK}`, scale: 0.97,
    load: () => Promise.all([import('@fontsource-variable/fraunces/opsz.css'), import('@fontsource-variable/fraunces/opsz-italic.css')]),
  },
  {
    id: 'inter', name: 'Inter', group: 'Sans & mono', family: `'Inter', ${SANS_FALLBACK}`, scale: 0.9,
    // 400–600 upright are part of the main bundle.
    load: () => Promise.all([import('@fontsource/inter/400-italic.css'), import('@fontsource/inter/700.css')]),
  },
  {
    id: 'ibm-plex-sans', name: 'IBM Plex Sans', group: 'Sans & mono', family: `'IBM Plex Sans Variable', ${SANS_FALLBACK}`, scale: 0.92,
    load: () => Promise.all([import('@fontsource-variable/ibm-plex-sans/wght.css'), import('@fontsource-variable/ibm-plex-sans/wght-italic.css')]),
  },
  {
    id: 'ibm-plex-mono', name: 'IBM Plex Mono', group: 'Sans & mono', family: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace", scale: 0.86,
    // 400 and 500 upright are part of the main bundle.
    load: () => Promise.all([import('@fontsource/ibm-plex-mono/400-italic.css'), import('@fontsource/ibm-plex-mono/700.css')]),
  },
];

export const WRITING_SIZES: { value: WritingSize; label: string; px: number }[] = [
  { value: 'small', label: 'Small', px: 18 },
  { value: 'medium', label: 'Medium', px: 20 },
  { value: 'large', label: 'Large', px: 21 },
  { value: 'xlarge', label: 'Extra large', px: 23 },
];

export const WRITING_LEADINGS: { value: WritingLeading; label: string; lineHeight: number }[] = [
  { value: 'compact', label: 'Compact', lineHeight: 1.55 },
  { value: 'comfortable', label: 'Comfortable', lineHeight: 1.7 },
  { value: 'airy', label: 'Airy', lineHeight: 1.85 },
];

/** Newsreader at 21px / 1.7 is the size the editor was designed at. */
export const DEFAULT_WRITING: WritingSettings = { font: 'newsreader', size: 'large', leading: 'comfortable' };

export function findWritingFont(id: string): WritingFont {
  return WRITING_FONTS.find((f) => f.id === id) ?? WRITING_FONTS[0];
}

/** Missing or unknown values fall back to the defaults (settings written before this existed). */
export function normaliseWriting(raw: unknown): WritingSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof WritingSettings, unknown>>;
  const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
  return {
    font: pick(r.font, WRITING_FONTS.map((f) => f.id), DEFAULT_WRITING.font),
    size: pick(r.size, WRITING_SIZES.map((s) => s.value), DEFAULT_WRITING.size),
    leading: pick(r.leading, WRITING_LEADINGS.map((l) => l.value), DEFAULT_WRITING.leading),
  };
}

/** The CSS variables for a writing setting (desktop size; the mobile editor scales it down in CSS). */
export function writingVariables(w: WritingSettings): Record<string, string> {
  const font = findWritingFont(w.font);
  const base = WRITING_SIZES.find((s) => s.value === w.size)?.px ?? 21;
  const leading = WRITING_LEADINGS.find((l) => l.value === w.leading)?.lineHeight ?? 1.7;
  return {
    'writing-font': font.family,
    'writing-size': `${Math.round(base * font.scale * 2) / 2}px`,
    'writing-leading': String(leading),
  };
}

/** Values that may come back from localStorage before they are set as CSS variables. */
export const SAFE_WRITING_VALUE: Record<string, RegExp> = {
  'writing-font': /^[A-Za-z0-9 ',-]+$/,
  'writing-size': /^\d{1,2}(\.\d+)?px$/,
  'writing-leading': /^\d(\.\d+)?$/,
};

const loaded = new Map<WritingFontId, Promise<unknown>>();

/** Loads a face's CSS once; failures are forgotten so a later call can retry. */
export function loadWritingFont(id: string): Promise<unknown> {
  const font = findWritingFont(id);
  let p = loaded.get(font.id);
  if (!p) {
    p = font.load().catch(() => loaded.delete(font.id));
    loaded.set(font.id, p);
  }
  return p;
}

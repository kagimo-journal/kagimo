/**
 * Import VS Code colour themes (JSON with comments) and base16 schemes (YAML) and fit them to
 * the journal's ten tokens (SPEC §8), enforcing readable contrast afterwards.
 */
import { bestOn, ensureContrast, flatten, isDark, mix, parseColor, toHex } from './color';
import type { CustomTheme, ThemeKind, ThemeTokens } from './themes';

export class ThemeImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeImportError';
  }
}

/** Removes // and /* *\/ comments and trailing commas, leaving string contents untouched. */
export function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma followed only by whitespace before } or ].
  let result = '';
  let inString = false;
  for (let k = 0; k < out.length; k++) {
    const ch = out[k];
    if (inString) {
      result += ch;
      if (ch === '\\') {
        result += out[++k] ?? '';
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ',') {
      let m = k + 1;
      while (m < out.length && /\s/.test(out[m])) m++;
      if (out[m] === '}' || out[m] === ']') continue;
    }
    result += ch;
  }
  return result;
}

interface Partial10 {
  paper?: string;
  surface?: string;
  ink?: string;
  muted?: string;
  hairline?: string;
  accent?: string;
  accentInk?: string;
  danger?: string;
}

const DEFAULTS: Record<ThemeKind, { accent: string; danger: string }> = {
  light: { accent: '#2F4F6B', danger: '#9A3B2E' },
  dark: { accent: '#9DB7CF', danger: '#D98B7E' },
};

/** Normalises a colour to opaque #RRGGBB, compositing translucent values over `bg`. */
function opaque(value: string | undefined, bg: string | undefined): string | undefined {
  if (!value) return undefined;
  const c = parseColor(value);
  if (!c) return undefined;
  const base = parseColor(bg ?? '#FFFFFF') ?? { r: 255, g: 255, b: 255, a: 1 };
  return toHex(c.a < 1 ? flatten(c, base) : c);
}

/** Fills in missing tokens from the ones we have, then enforces contrast. */
export function completeTokens(p: Partial10, kindHint?: ThemeKind): { kind: ThemeKind; tokens: ThemeTokens } {
  const paper = opaque(p.paper, '#FFFFFF');
  if (!paper) throw new ThemeImportError("This theme doesn't define a background colour.");
  const kind: ThemeKind = kindHint ?? (isDark(paper) ? 'dark' : 'light');
  const op = (v: string | undefined) => opaque(v, paper);

  let ink = op(p.ink) ?? bestOn(paper, ['#1E1C19', '#ECE7DF']);
  const surface = op(p.surface) ?? mix(paper, ink, 0.03);
  let muted = op(p.muted) ?? mix(ink, paper, 0.4);
  const hairline = op(p.hairline) ?? mix(paper, ink, 0.12);
  const accent = op(p.accent) ?? DEFAULTS[kind].accent;
  let accentInk = op(p.accentInk) ?? bestOn(accent, ['#FFFFFF', paper, '#000000']);
  // Danger colours error text, so it gets the same treatment as ink (many themes use a dim
  // errorForeground that is barely visible on their background).
  const danger = ensureContrast(op(p.danger) ?? DEFAULTS[kind].danger, paper, 4.5);

  ink = ensureContrast(ink, paper, 4.5);
  muted = ensureContrast(muted, paper, 4.5);
  accentInk = ensureContrast(accentInk, accent, 4.5);

  return {
    kind,
    tokens: {
      paper,
      surface,
      ink,
      muted,
      hairline,
      accent,
      accentInk,
      danger,
      soft: mix(paper, accent, kind === 'dark' ? 0.16 : 0.1),
      sel: mix(paper, ink, kind === 'dark' ? 0.08 : 0.06),
    },
  };
}

function newId(): string {
  return 'custom-' + crypto.randomUUID().slice(0, 8);
}

export function parseVSCodeTheme(text: string, fallbackName: string): CustomTheme {
  let data: { name?: unknown; type?: unknown; colors?: Record<string, unknown> };
  try {
    data = JSON.parse(stripJsonc(text));
  } catch {
    throw new ThemeImportError("That file isn't valid JSON.");
  }
  const colors = data?.colors;
  if (!colors || typeof colors !== 'object') throw new ThemeImportError('No "colors" section found in this VS Code theme.');
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = colors[k];
      if (typeof v === 'string' && parseColor(v)) return v;
    }
    return undefined;
  };
  const t = typeof data.type === 'string' ? data.type.toLowerCase() : '';
  const kindHint: ThemeKind | undefined = t === 'light' || t === 'hclight' ? 'light' : t === 'dark' || t === 'hc' ? 'dark' : undefined;
  const { kind, tokens } = completeTokens(
    {
      paper: get('editor.background'),
      surface: get('sideBar.background'),
      ink: get('editor.foreground', 'foreground'),
      muted: get('descriptionForeground'),
      hairline: get('panel.border', 'editorGroup.border'),
      accent: get('button.background', 'focusBorder'),
      accentInk: get('button.foreground'),
      danger: get('errorForeground'),
    },
    kindHint,
  );
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName;
  return { id: newId(), name: name.slice(0, 60), kind, tokens };
}

export function parseBase16Theme(text: string, fallbackName: string): CustomTheme {
  const colors: Record<string, string> = {};
  let name = '';
  let variant = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#(?![0-9a-fA-F]{6}\b).*$/, '');
    const c = /^\s*(base0[0-9A-Fa-f])\s*:\s*["']?#?([0-9a-fA-F]{6})["']?/.exec(line);
    if (c) {
      colors[c[1].slice(0, 5) + c[1][5].toUpperCase()] = '#' + c[2];
      continue;
    }
    const nm = /^\s*(scheme|name)\s*:\s*["']?(.*?)["']?\s*$/.exec(raw);
    if (nm && !name) name = nm[2];
    const v = /^\s*variant\s*:\s*["']?(light|dark)["']?/i.exec(raw);
    if (v) variant = v[1].toLowerCase();
  }
  if (!colors.base00 || !colors.base05) throw new ThemeImportError("This doesn't look like a base16 scheme (base00–base0F).");
  const { kind, tokens } = completeTokens(
    {
      paper: colors.base00,
      surface: colors.base01,
      ink: colors.base05,
      muted: colors.base04,
      hairline: colors.base02,
      accent: colors.base0D,
      danger: colors.base08,
    },
    variant === 'light' || variant === 'dark' ? variant : undefined,
  );
  return { id: newId(), name: (name.trim() || fallbackName).slice(0, 60), kind, tokens };
}

/** Detects the format from the file name / contents. */
export function importThemeFile(fileName: string, text: string): CustomTheme {
  const base = fileName.replace(/\.(jsonc?|ya?ml)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported theme';
  if (/\.ya?ml$/i.test(fileName) || /^\s*(scheme|base00)\s*:/m.test(text)) return parseBase16Theme(text, base);
  return parseVSCodeTheme(text, base);
}

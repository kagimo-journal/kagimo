import { bestOn, contrast, ensureContrast, isDark, isHexColor, mix, withAlpha } from './color';

export type ThemeKind = 'light' | 'dark';
export type Mode = 'system' | 'light' | 'dark';

/** The ten theme tokens from SPEC §8 (camelCase here, `--accent-ink` etc. in CSS). */
export interface ThemeTokens {
  paper: string;
  surface: string;
  ink: string;
  muted: string;
  hairline: string;
  accent: string;
  accentInk: string;
  danger: string;
  soft: string;
  sel: string;
}

export const TOKEN_KEYS: (keyof ThemeTokens)[] = [
  'paper', 'surface', 'ink', 'muted', 'hairline', 'accent', 'accentInk', 'danger', 'soft', 'sel',
];

export interface Theme {
  id: string;
  name: string;
  kind: ThemeKind;
  tokens: ThemeTokens;
  builtIn?: boolean;
}

export type CustomTheme = Omit<Theme, 'builtIn'>;

export const BUILT_IN_THEMES: Theme[] = [
  {
    id: 'paper', name: 'Paper', kind: 'light', builtIn: true,
    tokens: { paper: '#F7F4EF', surface: '#FFFDF9', ink: '#1E1C19', muted: '#615B52', hairline: '#E4DED4', accent: '#2F4F6B', accentInk: '#FFFFFF', danger: '#9A3B2E', soft: '#EAEFF3', sel: '#EFEAE2' },
  },
  {
    id: 'solarized-light', name: 'Solarized Light', kind: 'light', builtIn: true,
    tokens: { paper: '#FDF6E3', surface: '#EEE8D5', ink: '#073642', muted: '#586E75', hairline: '#DDD6C1', accent: '#1F6FA8', accentInk: '#FDF6E3', danger: '#B52B27', soft: '#E1EBEA', sel: '#E4DDC8' },
  },
  {
    id: 'quiet-light', name: 'Quiet Light', kind: 'light', builtIn: true,
    tokens: { paper: '#F5F5F5', surface: '#FFFFFF', ink: '#333333', muted: '#666666', hairline: '#E0E0E0', accent: '#4B69C6', accentInk: '#FFFFFF', danger: '#A1260D', soft: '#E7EBF6', sel: '#E9E9E9' },
  },
  {
    id: 'paper-dark', name: 'Paper Dark', kind: 'dark', builtIn: true,
    tokens: { paper: '#171614', surface: '#1F1D1A', ink: '#ECE7DF', muted: '#A39B8F', hairline: '#2E2B27', accent: '#9DB7CF', accentInk: '#171614', danger: '#D98B7E', soft: '#22303C', sel: '#2A2723' },
  },
  {
    id: 'nord', name: 'Nord', kind: 'dark', builtIn: true,
    tokens: { paper: '#2E3440', surface: '#3B4252', ink: '#ECEFF4', muted: '#AEB6C5', hairline: '#434C5E', accent: '#88C0D0', accentInk: '#2E3440', danger: '#E0939A', soft: '#3A4A58', sel: '#434C5E' },
  },
  {
    id: 'gruvbox-dark', name: 'Gruvbox Dark', kind: 'dark', builtIn: true,
    tokens: { paper: '#282828', surface: '#32302F', ink: '#EBDBB2', muted: '#A89984', hairline: '#3C3836', accent: '#FE8019', accentInk: '#282828', danger: '#FB4934', soft: '#3D3127', sel: '#3C3836' },
  },
];

export const DEFAULT_LIGHT = 'paper';
export const DEFAULT_DARK = 'paper-dark';

export function allThemes(custom: CustomTheme[] = []): Theme[] {
  return [...BUILT_IN_THEMES, ...custom.filter(isValidTheme)];
}

export function findTheme(id: string, custom: CustomTheme[], kind: ThemeKind): Theme {
  const t = allThemes(custom).find((x) => x.id === id && x.kind === kind);
  return t ?? BUILT_IN_THEMES.find((x) => x.id === (kind === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK))!;
}

export function isValidTheme(t: unknown): t is CustomTheme {
  if (!t || typeof t !== 'object') return false;
  const x = t as CustomTheme;
  return (
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    (x.kind === 'light' || x.kind === 'dark') &&
    !!x.tokens &&
    TOKEN_KEYS.every((k) => isHexColor(x.tokens[k]))
  );
}

/** Exact secondary values from the design boards for the default Paper themes. */
const DESIGN_EXTRAS: Record<string, Partial<Record<string, string>>> = {
  paper: { field: '#FFFFFF', line: '#D6CFC3', notice: '#F1ECE4', 'danger-soft': '#F6E7E3', toolbar: '#1E1C19', 'toolbar-ink': '#F7F4EF', 'sel-strong': '#3A3733' },
  'paper-dark': { field: '#1B1A17', line: '#3A3631', notice: '#211F1C', 'danger-soft': '#33231F', toolbar: '#ECE7DF', 'toolbar-ink': '#171614' },
};

/**
 * Background for highlighted text: a soft tint of the accent on paper, as strong as it can be
 * while ink on it still reads at 4.5:1 or better (a theme whose ink is already faint on paper
 * gets the lightest tint, and `--highlight-ink` makes up the difference).
 */
export function highlightColor(t: ThemeTokens, dark: boolean): string {
  const lightest = 0.08;
  for (let k = dark ? 0.28 : 0.2; k > lightest; k -= 0.02) {
    const c = mix(t.paper, t.accent, k);
    if (contrast(t.ink, c) >= 4.5) return c;
  }
  return mix(t.paper, t.accent, lightest);
}

/**
 * Full set of CSS custom properties for a theme: the ten spec tokens plus a few values
 * derived from them (input fields, stronger borders, notices, selection toolbar…).
 */
export function cssVariables(theme: Theme): Record<string, string> {
  const t = theme.tokens;
  const dark = theme.kind === 'dark' || isDark(t.paper);
  const highlight = highlightColor(t, dark);
  const vars: Record<string, string> = {
    paper: t.paper,
    surface: t.surface,
    ink: t.ink,
    muted: t.muted,
    hairline: t.hairline,
    accent: t.accent,
    'accent-ink': t.accentInk,
    // Accent used as text (links, labels, the status pill on --soft) and for selection rings must
    // stay readable even if the accent is a dim fill colour.
    'accent-text': ensureContrast(ensureContrast(t.accent, t.paper, 4.5), t.soft, 4.5),
    // Themes imported before danger was contrast-checked on import are corrected here too.
    danger: ensureContrast(t.danger, t.paper, 4.5),
    soft: t.soft,
    sel: t.sel,
    highlight,
    'highlight-ink': ensureContrast(t.ink, highlight, 4.5),
    field: dark ? mix(t.paper, t.surface, 0.5) : mix(t.surface, '#FFFFFF', 0.6),
    line: mix(t.hairline, t.ink, dark ? 0.1 : 0.08),
    notice: mix(t.paper, t.hairline, dark ? 0.35 : 0.45),
    'danger-soft': mix(t.paper, t.danger, dark ? 0.16 : 0.1),
    toolbar: t.ink,
    'toolbar-ink': bestOn(t.ink, [t.paper, '#FFFFFF', '#000000']),
    'sel-strong': mix(t.ink, t.paper, 0.18),
    ring: withAlpha(t.accent, dark ? 0.3 : 0.15),
    drop: withAlpha(t.paper, 0.92),
    'drop-tint': withAlpha(t.accent, 0.05),
    'color-scheme': dark ? 'dark' : 'light',
  };
  return { ...vars, ...(theme.builtIn ? DESIGN_EXTRAS[theme.id] : undefined) } as Record<string, string>;
}

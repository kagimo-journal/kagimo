/**
 * Applies theme tokens as CSS custom properties and keeps a non-secret copy of just the token
 * values in localStorage so /theme-boot.js can paint the right theme before React mounts.
 */
import { cssVariables, DEFAULT_DARK, DEFAULT_LIGHT, findTheme, type CustomTheme, type Mode } from './themes';
import { DEFAULT_WRITING, loadWritingFont, SAFE_WRITING_VALUE, writingVariables, type WritingSettings } from './writing';

export const THEME_STORAGE_KEY = 'journal.theme.v1';

export interface StoredTheme {
  mode: Mode;
  light: Record<string, string>;
  dark: Record<string, string>;
  /** Writing typography: the chosen face (to load its CSS) and its CSS variable values. */
  writing?: { font: string; vars: Record<string, string> };
}

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let current: StoredTheme | null = null;

export function buildStoredTheme(mode: Mode, lightId: string, darkId: string, custom: CustomTheme[], writing: WritingSettings = DEFAULT_WRITING): StoredTheme {
  return {
    mode,
    light: cssVariables(findTheme(lightId, custom, 'light')),
    dark: cssVariables(findTheme(darkId, custom, 'dark')),
    writing: { font: writing.font, vars: writingVariables(writing) },
  };
}

export function readStoredTheme(): StoredTheme | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredTheme;
    if (!v || typeof v !== 'object' || !v.light || !v.dark) return null;
    return v;
  } catch {
    return null;
  }
}

function effectiveKind(mode: Mode): 'light' | 'dark' {
  if (mode === 'system') return media?.matches ? 'dark' : 'light';
  return mode;
}

const SAFE_VALUE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\)|light|dark)$/;

function paint(theme: StoredTheme) {
  const root = document.documentElement;
  const kind = effectiveKind(theme.mode);
  const vars = kind === 'dark' ? theme.dark : theme.light;
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[a-z-]+$/.test(k) || !SAFE_VALUE.test(v)) continue;
    if (k === 'color-scheme') root.style.colorScheme = v;
    else root.style.setProperty(`--${k}`, v);
  }
  for (const [k, v] of Object.entries(theme.writing?.vars ?? {})) {
    if (SAFE_WRITING_VALUE[k]?.test(v)) root.style.setProperty(`--${k}`, v);
  }
  root.dataset.theme = kind;
  const meta = document.querySelector('meta[name="theme-color"]') ?? Object.assign(document.createElement('meta'), { name: 'theme-color' });
  meta.setAttribute('content', vars.paper ?? '');
  if (!meta.parentNode) document.head.appendChild(meta);
}

/** Applies and persists the theme. System mode follows prefers-color-scheme live. */
export function applyTheme(theme: StoredTheme, persist = true) {
  current = theme;
  paint(theme);
  void loadWritingFont(theme.writing?.font ?? DEFAULT_WRITING.font);
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
    } catch {
      /* storage may be unavailable (private mode); theming still works for this tab */
    }
  }
}

media?.addEventListener('change', () => {
  if (current?.mode === 'system') paint(current);
});

export function initTheme() {
  applyTheme(readStoredTheme() ?? buildStoredTheme('system', DEFAULT_LIGHT, DEFAULT_DARK, []), false);
}

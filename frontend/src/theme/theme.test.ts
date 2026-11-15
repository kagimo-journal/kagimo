import { describe, expect, it } from 'vitest';
import { contrast, ensureContrast, parseColor } from './color';
import { importThemeFile, parseBase16Theme, parseVSCodeTheme, stripJsonc } from './import';
import { BUILT_IN_THEMES, cssVariables } from './themes';
import { DEFAULT_WRITING, normaliseWriting, SAFE_WRITING_VALUE, WRITING_FONTS, writingVariables } from './writing';

describe('colour helpers', () => {
  it('parses hex with alpha', () => {
    expect(parseColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
    expect(parseColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });

  it('raises contrast by adjusting lightness', () => {
    const fixed = ensureContrast('#AAAAAA', '#F5F5F5', 4.5);
    expect(contrast(fixed, '#F5F5F5')).toBeGreaterThanOrEqual(4.5);
    const light = ensureContrast('#555555', '#1A1B26', 4.5);
    expect(contrast(light, '#1A1B26')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('built-in themes', () => {
  it('meet the contrast rules', () => {
    for (const t of BUILT_IN_THEMES) {
      expect(contrast(t.tokens.ink, t.tokens.paper), t.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.tokens.muted, t.tokens.paper), t.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.tokens.accentInk, t.tokens.accent), t.name).toBeGreaterThanOrEqual(4.5);
      expect(Object.keys(cssVariables(t))).toContain('accent-ink');
    }
  });
});

describe('VS Code import', () => {
  const src = `// Tokyo Night (excerpt)
  {
    "name": "Tokyo Night",
    "type": "dark", /* block comment */
    "colors": {
      "editor.background": "#1A1B26",
      "editor.foreground": "#A9B1D6",
      "descriptionForeground": "#515670", // too faint
      "panel.border": "#101014",
      "button.background": "#3D59A1dd",
      "button.foreground": "#ffffff",
      "textLink.foreground": "http://not//a/comment",
    },
  }`;

  it('strips comments and trailing commas but not string contents', () => {
    const parsed = JSON.parse(stripJsonc(src));
    expect(parsed.colors['textLink.foreground']).toBe('http://not//a/comment');
  });

  it('maps keys, derives missing tokens and enforces contrast', () => {
    const t = parseVSCodeTheme(src, 'file');
    expect(t.name).toBe('Tokyo Night');
    expect(t.kind).toBe('dark');
    expect(t.tokens.paper).toBe('#1A1B26');
    expect(t.tokens.hairline).toBe('#101014');
    expect(contrast(t.tokens.muted, t.tokens.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.tokens.accentInk, t.tokens.accent)).toBeGreaterThanOrEqual(4.5);
    expect(t.tokens.surface).toMatch(/^#[0-9A-F]{6}$/);
    // the derived text colour for links stays readable even though this accent is a dark fill
    const vars = cssVariables({ ...t, builtIn: false });
    expect(contrast(vars['accent-text'], t.tokens.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars['accent-text'], t.tokens.soft)).toBeGreaterThanOrEqual(4.5);
  });

  it('raises a dim errorForeground to a readable danger colour', () => {
    const t = parseVSCodeTheme(
      JSON.stringify({ type: 'dark', colors: { 'editor.background': '#002B36', 'editor.foreground': '#93A1A1', errorForeground: '#FFEEEE' } }),
      'x',
    );
    // #FFEEEE on a light paper would be invisible; here check the light-theme case too.
    expect(contrast(t.tokens.danger, t.tokens.paper)).toBeGreaterThanOrEqual(4.5);
    const light = parseVSCodeTheme(
      JSON.stringify({ type: 'light', colors: { 'editor.background': '#FDF6E3', 'editor.foreground': '#586E75', errorForeground: '#FFEEEE' } }),
      'y',
    );
    expect(contrast(light.tokens.danger, light.tokens.paper)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every built-in theme readable for accent text on paper and on soft', () => {
    for (const theme of BUILT_IN_THEMES) {
      const vars = cssVariables(theme);
      expect(contrast(vars['accent-text'], theme.tokens.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars['accent-text'], theme.tokens.soft)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars.danger, theme.tokens.paper)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('rejects files without colours', () => {
    expect(() => parseVSCodeTheme('{"name":"x"}', 'x')).toThrow();
  });
});

describe('base16 import', () => {
  const yaml = `scheme: "Catppuccin Latte"
author: "someone"
base00: "eff1f5" # base
base01: "e6e9ef"
base02: "ccd0da"
base03: "bcc0cc"
base04: "acb0be"
base05: "4c4f69"
base06: "dc8a78"
base07: "7287fd"
base08: "d20f39"
base09: "fe640b"
base0A: "df8e1d"
base0B: "40a02b"
base0C: "179299"
base0D: "1e66f5"
base0E: "8839ef"
base0F: "dd7878"
`;
  it('maps base16 slots and detects light', () => {
    const t = parseBase16Theme(yaml, 'file');
    expect(t.name).toBe('Catppuccin Latte');
    expect(t.kind).toBe('light');
    expect(t.tokens.paper).toBe('#EFF1F5');
    expect(t.tokens.accent).toBe('#1E66F5');
    expect(contrast(t.tokens.muted, t.tokens.paper)).toBeGreaterThanOrEqual(4.5);
  });

  it('detects the format from the file name', () => {
    expect(importThemeFile('latte.yaml', yaml).kind).toBe('light');
    expect(importThemeFile('tinted.yaml', 'name: "X"\nvariant: "dark"\npalette:\n  base00: "#101010"\n  base05: "#d0d0d0"\n').kind).toBe('dark');
  });
});

describe('highlight colour', () => {
  it('keeps ink readable on highlighted text in built-in and imported themes', () => {
    const imported = [
      parseBase16Theme('scheme: "Low contrast"\nbase00: "f0f0f0"\nbase05: "707070"\nbase0D: "ff8800"\n', 'a'),
      parseVSCodeTheme(JSON.stringify({ type: 'dark', colors: { 'editor.background': '#222222', 'editor.foreground': '#9a9a9a', 'button.background': '#e0e0ff' } }), 'b'),
    ];
    for (const theme of BUILT_IN_THEMES) {
      // built-in themes keep their own ink on highlights
      expect(cssVariables(theme)['highlight-ink'], theme.name).toBe(theme.tokens.ink);
    }
    for (const theme of [...BUILT_IN_THEMES, ...imported]) {
      const vars = cssVariables(theme);
      expect(vars.highlight, theme.name).toMatch(/^#[0-9A-F]{6}$/);
      expect(contrast(vars['highlight-ink'], vars.highlight), theme.name).toBeGreaterThanOrEqual(4.5);
      expect(vars.highlight, theme.name).not.toBe(theme.tokens.paper);
    }
  });
});

describe('writing settings', () => {
  it('falls back to the defaults for missing or unknown values', () => {
    expect(normaliseWriting(undefined)).toEqual(DEFAULT_WRITING);
    expect(normaliseWriting({ font: 'comic-sans', size: 'huge', leading: 2 })).toEqual(DEFAULT_WRITING);
    expect(normaliseWriting({ font: 'literata', size: 'small' })).toEqual({ font: 'literata', size: 'small', leading: 'comfortable' });
  });

  it('produces CSS variables that pass the boot script checks', () => {
    for (const font of WRITING_FONTS) {
      const vars = writingVariables({ font: font.id, size: 'xlarge', leading: 'airy' });
      for (const [k, v] of Object.entries(vars)) expect(SAFE_WRITING_VALUE[k].test(v), `${font.id} ${k}=${v}`).toBe(true);
    }
    expect(writingVariables(DEFAULT_WRITING)).toEqual({ 'writing-font': "'Newsreader', Georgia, 'Times New Roman', serif", 'writing-size': '21px', 'writing-leading': '1.7' });
  });
});

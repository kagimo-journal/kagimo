/** Small colour toolkit: parsing, mixing, WCAG contrast and lightness adjustment. */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RGBA extends RGB {
  a: number;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function parseColor(input: string): RGBA | null {
  const s = input.trim();
  const m = HEX_RE.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (rgb) {
    const alpha = rgb[4] ? (rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])) : 1;
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: Math.max(0, Math.min(1, alpha)) };
  }
  return null;
}

export function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex({ r, g, b }: RGB): string {
  return '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Composites a possibly-translucent colour over an opaque background. */
export function flatten(c: RGBA, bg: RGB): RGB {
  return { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) };
}

export function hexToRgb(hex: string): RGB {
  const c = parseColor(hex);
  if (!c) throw new Error(`Invalid colour ${hex}`);
  return c;
}

/** Mixes `a` towards `b` by `t` (0 = a, 1 = b), in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

export function withAlpha(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${clamp255(r)}, ${clamp255(g)}, ${clamp255(b)}, ${a})`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.18;
}

interface HSL {
  h: number;
  s: number;
  l: number;
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h / 6, s, l };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = (p: number, q: number, t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 };
}

/**
 * Adjusts the lightness of `fg` (keeping hue and saturation) until it reaches `min` contrast
 * against `bg`. Moves away from the background: darker on light backgrounds, lighter on dark.
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg.toUpperCase();
  const hsl = rgbToHsl(hexToRgb(fg));
  const darker = luminance(bg) > 0.5 || (luminance(bg) > 0.18 && contrast('#000000', bg) > contrast('#FFFFFF', bg));
  for (let i = 1; i <= 100; i++) {
    const l = darker ? hsl.l - i / 100 : hsl.l + i / 100;
    if (l < 0 || l > 1) break;
    const candidate = toHex(hslToRgb({ ...hsl, l }));
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return darker ? '#000000' : '#FFFFFF';
}

/** Whichever of the candidates reads best on `bg`. */
export function bestOn(bg: string, candidates: string[]): string {
  return candidates.reduce((best, c) => (contrast(c, bg) > contrast(best, bg) ? c : best));
}

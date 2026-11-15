/**
 * "Burn it": a one-off visual for permanently deleting an entry. The visible text (and images)
 * of the entry is copied into a fixed overlay, the real page is hidden, and the copy is
 * destroyed in one of a few ways. Purely cosmetic: deleting the entry is the caller's job.
 */

export type BurnStyle = 'drift' | 'crumble' | 'smoke' | 'fade';

export const BURN_STYLES: BurnStyle[] = ['drift', 'crumble', 'smoke'];

export interface Burn {
  style: BurnStyle;
  /** Resolves when the animation has played out (the overlay stays until `dispose`). */
  finished: Promise<void>;
  /** Removes the overlay and shows the page again (e.g. when deleting failed). */
  cancel: () => void;
  /** Removes the overlay, leaving the page hidden (call after navigating away). */
  dispose: () => void;
}

/** The bits of a computed style a glyph is drawn with (copied: computed styles are live). */
interface GlyphStyle {
  fontStyle: string;
  fontWeight: string;
  fontSize: string;
  fontFamily: string;
  letterSpacing: string;
  color: string;
}

interface Glyph {
  text: string;
  rect: DOMRect;
  style: GlyphStyle;
}

interface Picture {
  img: HTMLImageElement;
  rect: DOMRect;
}

const MAX_GLYPHS = 2500;

function visible(r: DOMRect) {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

/** Copies a textarea's text into a positioned div with the same metrics, so it can be measured. */
function mirrorTextarea(ta: HTMLTextAreaElement): HTMLDivElement {
  const cs = getComputedStyle(ta);
  const r = ta.getBoundingClientRect();
  const div = document.createElement('div');
  for (const p of ['font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'textAlign', 'padding', 'color', 'boxSizing'] as const) {
    (div.style as unknown as Record<string, string>)[p] = cs[p];
  }
  Object.assign(div.style, {
    position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: '0',
    whiteSpace: 'pre-wrap', overflowWrap: 'break-word', visibility: 'hidden', pointerEvents: 'none',
  });
  div.textContent = ta.value;
  document.body.appendChild(div);
  return div;
}

/** Every non-blank character (or word, for long pages) of `root` that is on screen. */
function collectGlyphs(root: HTMLElement): Glyph[] {
  const mirrors = Array.from(root.querySelectorAll('textarea')).filter((t) => t.value).map(mirrorTextarea);
  const roots: HTMLElement[] = [root, ...mirrors];
  const styles = new Map<Element, GlyphStyle & { upper: boolean }>();
  const styleOf = (el: Element) => {
    let s = styles.get(el);
    if (!s) {
      const c = getComputedStyle(el);
      s = {
        fontStyle: c.fontStyle, fontWeight: c.fontWeight, fontSize: c.fontSize, fontFamily: c.fontFamily,
        letterSpacing: c.letterSpacing, color: c.color, upper: c.textTransform === 'uppercase',
      };
      styles.set(el, s);
    }
    return s;
  };
  const nodes: Text[] = [];
  for (const r of roots) {
    const walk = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.nodeValue?.trim()) continue;
      if (el.closest('button, [aria-hidden="true"], .visually-hidden')) continue;
      nodes.push(n as Text);
    }
  }

  const range = document.createRange();
  const measure = (byWord: boolean) => {
    const out: Glyph[] = [];
    for (const n of nodes) {
      const s = n.nodeValue!;
      const style = styleOf(n.parentElement!);
      const upper = style.upper;
      const re = byWord ? /\S+/g : /\S/gu;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        // A word broken across lines has several rects; the first is close enough.
        const rect = range.getClientRects()[0];
        if (!rect || !visible(rect)) continue;
        out.push({ text: upper ? m[0].toUpperCase() : m[0], rect, style });
        if (out.length > MAX_GLYPHS && !byWord) return null;
      }
    }
    return out;
  };
  const glyphs = measure(false) ?? measure(true)!.slice(0, MAX_GLYPHS);
  mirrors.forEach((m) => m.remove());
  return glyphs;
}

function collectPictures(root: HTMLElement): Picture[] {
  return Array.from(root.querySelectorAll('img'))
    .filter((img) => img.complete && img.naturalWidth > 0)
    .map((img) => ({ img, rect: img.getBoundingClientRect() }))
    .filter((p) => visible(p.rect));
}

function fontOf(s: GlyphStyle, lineHeight: number) {
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize}/${lineHeight}px ${s.fontFamily}`;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function makeOverlay() {
  const el = document.createElement('div');
  el.className = 'burn-overlay';
  el.setAttribute('aria-hidden', 'true');
  // Swallows taps and scrolling while the page burns.
  Object.assign(el.style, { position: 'fixed', inset: '0', zIndex: '40', overflow: 'hidden', touchAction: 'none' });
  el.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  return el;
}

// ---- DOM styles: each letter is its own element --------------------------------------------

function domBurn(overlay: HTMLElement, glyphs: Glyph[], pictures: Picture[], style: 'drift' | 'crumble' | 'fade'): Promise<void> {
  const anims: Animation[] = [];
  const frag = document.createDocumentFragment();

  const frames = (): [Keyframe[], KeyframeAnimationOptions] => {
    if (style === 'fade') return [[{ opacity: 1 }, { opacity: 0 }], { duration: 450, easing: 'ease-out', fill: 'forwards' }];
    if (style === 'drift') {
      const dx = rand(-70, 70);
      const dy = rand(-180, -50);
      return [
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0.85, transform: `translate(${dx * 0.3}px, ${dy * 0.25}px) rotate(${rand(-10, 10)}deg)`, offset: 0.35 },
          { opacity: 0, transform: `translate(${dx}px, ${dy}px) rotate(${rand(-50, 50)}deg) scale(${rand(0.3, 0.8)})` },
        ],
        { delay: rand(0, 1300), duration: rand(900, 1500), easing: 'cubic-bezier(.3,0,.6,1)', fill: 'both' },
      ];
    }
    const fall = window.innerHeight + rand(40, 300);
    return [
      [
        { opacity: 1, transform: 'none' },
        { opacity: 1, transform: `translate(${rand(-4, 4)}px, ${rand(1, 4)}px) rotate(${rand(-8, 8)}deg)`, offset: 0.12 },
        { opacity: 0, transform: `translate(${rand(-60, 60)}px, ${fall}px) rotate(${rand(-160, 160)}deg)` },
      ],
      { delay: rand(0, 1400), duration: rand(1000, 1500), easing: 'cubic-bezier(.5,0,.9,.55)', fill: 'both' },
    ];
  };

  for (const g of glyphs) {
    const span = document.createElement('span');
    span.textContent = g.text;
    const h = g.rect.height;
    Object.assign(span.style, {
      position: 'absolute', left: `${g.rect.left}px`, top: `${g.rect.top}px`, height: `${h}px`,
      font: fontOf(g.style, h), letterSpacing: g.style.letterSpacing, color: g.style.color, whiteSpace: 'pre', willChange: 'transform, opacity',
    });
    frag.appendChild(span);
    const [k, o] = frames();
    anims.push(span.animate(k, o));
  }
  for (const p of pictures) {
    const img = document.createElement('img');
    img.src = p.img.src;
    img.alt = '';
    Object.assign(img.style, { position: 'absolute', left: `${p.rect.left}px`, top: `${p.rect.top}px`, width: `${p.rect.width}px`, height: `${p.rect.height}px` });
    frag.appendChild(img);
    const fadeOnly = style === 'fade';
    anims.push(
      img.animate(
        fadeOnly
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { opacity: 1, filter: 'none', transform: 'none' },
              { opacity: 0, filter: 'blur(12px) grayscale(1)', transform: style === 'crumble' ? `translateY(${window.innerHeight * 0.6}px) rotate(${rand(-12, 12)}deg)` : 'translateY(-60px) scale(1.05)' },
            ],
        { delay: fadeOnly ? 0 : rand(200, 700), duration: fadeOnly ? 450 : 1600, easing: 'ease-in', fill: 'both' },
      ),
    );
  }
  overlay.appendChild(frag);
  return Promise.all(anims.map((a) => a.finished)).then(() => undefined);
}

// ---- smoke: the page is painted to a canvas and carried off as particles --------------------

const EMBERS = ['#fff3c4', '#ffd166', '#ff9f43', '#ff6b2c', '#d9481c'];
const SMOKE_BINS = 8;

function smokeBurn(overlay: HTMLElement, glyphs: Glyph[], pictures: Picture[]): { finished: Promise<void>; stop: () => void } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const make = () => {
    const c = document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    return [c, ctx] as const;
  };

  // The page as it looks now.
  const [snap, sctx] = make();
  sctx.textBaseline = 'alphabetic';
  for (const p of pictures) {
    try {
      sctx.drawImage(p.img, p.rect.left, p.rect.top, p.rect.width, p.rect.height);
    } catch {
      /* not drawable; it just vanishes */
    }
  }
  for (const g of glyphs) {
    sctx.font = fontOf(g.style, g.rect.height);
    sctx.fillStyle = g.style.color;
    const m = sctx.measureText(g.text);
    const asc = m.fontBoundingBoxAscent;
    const desc = m.fontBoundingBoxDescent;
    const y = asc !== undefined && desc !== undefined ? g.rect.top + (g.rect.height - asc - desc) / 2 + asc : g.rect.top + g.rect.height * 0.8;
    sctx.fillText(g.text, g.rect.left, y);
  }

  // The same, glowing: drawn in a thin band just above the burn line.
  const [ember, ectx] = make();
  ectx.setTransform(1, 0, 0, 1, 0, 0);
  ectx.drawImage(snap, 0, 0);
  ectx.globalCompositeOperation = 'source-in';
  ectx.fillStyle = '#ff8a2b';
  ectx.fillRect(0, 0, ember.width, ember.height);

  let top = H;
  let bottom = 0;
  for (const g of [...glyphs, ...pictures]) {
    top = Math.min(top, g.rect.top);
    bottom = Math.max(bottom, g.rect.bottom);
  }
  if (bottom <= top) {
    top = 0;
    bottom = H;
  }

  // A ragged burn line that climbs from below the content to above it.
  const COL = 6;
  const cols = Math.ceil(W / COL) + 1;
  const ragged = new Float32Array(cols);
  {
    let v = 0;
    for (let i = 0; i < cols; i++) {
      v = v * 0.82 + rand(-1, 1) * 0.6;
      ragged[i] = v;
    }
    let max = 0.001;
    ragged.forEach((x) => (max = Math.max(max, Math.abs(x))));
    ragged.forEach((x, i) => (ragged[i] = x / max));
  }
  const amp = Math.min(60, (bottom - top) * 0.15 + 12);
  const span = bottom - top + amp * 4;
  const SWEEP = Math.min(2600, 1300 + (bottom - top) * 1.4);
  const lineAt = (x: number, p: number) => bottom + amp * 2 - span * p + amp * ragged[Math.min(cols - 1, Math.max(0, Math.round(x / COL)))];

  // Particles from the painted pixels, sampled on a grid.
  const data = sctx.getImageData(0, 0, snap.width, snap.height).data;
  const step = Math.max(1, Math.round(2 * dpr));
  const pts: number[] = [];
  for (let py = 0; py < snap.height; py += step) {
    for (let px = 0; px < snap.width; px += step) {
      if (data[(py * snap.width + px) * 4 + 3] > 90) pts.push(px / dpr, py / dpr);
    }
  }
  const MAX = 22000;
  const keep = Math.min(1, MAX / Math.max(1, pts.length / 2));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    if (keep < 1 && Math.random() > keep) continue;
    xs.push(pts[i]);
    ys.push(pts[i + 1]);
  }
  const n = xs.length;
  const x0 = Float32Array.from(xs);
  const y0 = Float32Array.from(ys);
  const ign = new Float32Array(n);
  const life = new Float32Array(n);
  const vx = new Float32Array(n);
  const rise = new Float32Array(n);
  const phase = new Float32Array(n);
  const grow = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // The line passes this point when lineAt(x, p) === y.
    const p = (bottom + amp * 2 + amp * ragged[Math.min(cols - 1, Math.round(x0[i] / COL))] - y0[i]) / span;
    ign[i] = Math.max(0, p * SWEEP + rand(-60, 60));
    life[i] = rand(700, 1500);
    vx[i] = rand(-25, 25);
    rise[i] = rand(60, 200);
    phase[i] = rand(0, Math.PI * 2);
    grow[i] = rand(1.5, 4);
  }
  const TOTAL = SWEEP + 1600;

  const [view, ctx] = make();
  Object.assign(view.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
  overlay.appendChild(view);
  const smoke = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';

  const emberPaths = EMBERS.map(() => new Path2D());
  const smokePaths = Array.from({ length: SMOKE_BINS }, () => new Path2D());

  let raf = 0;
  let resolve!: () => void;
  const finished = new Promise<void>((r) => (resolve = r));
  const start = performance.now();

  const frame = (now: number) => {
    const t = now - start;
    const p = t / SWEEP;
    ctx.clearRect(0, 0, W, H);

    // What hasn't caught yet: everything above the line.
    if (p < 1.05) {
      const unburnt = new Path2D();
      unburnt.moveTo(0, 0);
      unburnt.lineTo(W, 0);
      for (let x = W; x >= 0; x -= COL) unburnt.lineTo(x, lineAt(x, p));
      unburnt.closePath();
      ctx.save();
      ctx.clip(unburnt);
      ctx.drawImage(snap, 0, 0, W, H);
      const band = new Path2D();
      for (let x = 0; x <= W; x += COL) band.lineTo(x, lineAt(x, p) - 7);
      for (let x = W; x >= 0; x -= COL) band.lineTo(x, lineAt(x, p) + 2);
      ctx.clip(band);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(ember, 0, 0, W, H);
      ctx.restore();
    }

    for (let b = 0; b < EMBERS.length; b++) emberPaths[b] = new Path2D();
    for (let b = 0; b < SMOKE_BINS; b++) smokePaths[b] = new Path2D();
    for (let i = 0; i < n; i++) {
      const age = t - ign[i];
      if (age < 0 || age > life[i]) continue;
      const a = age / life[i];
      const s = 1 + grow[i] * a;
      const x = x0[i] + vx[i] * a + Math.sin(phase[i] + a * 5) * 10 * a;
      const y = y0[i] - rise[i] * (a * 0.6 + a * a * 0.6);
      if (a < 0.18) {
        const b = Math.min(EMBERS.length - 1, Math.floor((a / 0.18) * EMBERS.length));
        emberPaths[b].rect(x, y, s, s);
      } else {
        const b = Math.min(SMOKE_BINS - 1, Math.floor(((a - 0.18) / 0.82) * SMOKE_BINS));
        smokePaths[b].rect(x - s / 2, y - s / 2, s * 1.4, s * 1.4);
      }
    }
    for (let b = 0; b < SMOKE_BINS; b++) {
      ctx.globalAlpha = 0.55 * Math.pow(1 - (b + 0.5) / SMOKE_BINS, 1.4);
      ctx.fillStyle = smoke;
      ctx.fill(smokePaths[b]);
    }
    ctx.globalAlpha = 1;
    for (let b = 0; b < EMBERS.length; b++) {
      ctx.fillStyle = EMBERS[b];
      ctx.fill(emberPaths[b]);
    }

    if (t < TOTAL) raf = requestAnimationFrame(frame);
    else {
      ctx.clearRect(0, 0, W, H);
      resolve();
    }
  };
  raf = requestAnimationFrame(frame);
  return {
    finished,
    stop: () => {
      cancelAnimationFrame(raf);
      resolve();
    },
  };
}

// ---- entry point -----------------------------------------------------------------------

export function pickBurnStyle(): BurnStyle {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'fade';
  return BURN_STYLES[Math.floor(Math.random() * BURN_STYLES.length)];
}

/** Hides `root` behind a copy of itself and burns the copy. */
export function burnElement(root: HTMLElement, style: BurnStyle = pickBurnStyle()): Burn {
  const glyphs = collectGlyphs(root);
  const pictures = collectPictures(root);
  const overlay = makeOverlay();
  document.body.appendChild(overlay);
  const prevVisibility = root.style.visibility;
  root.style.visibility = 'hidden';

  let stop = () => {};
  let finished: Promise<void>;
  if (style === 'smoke') {
    const s = smokeBurn(overlay, glyphs, pictures);
    stop = s.stop;
    finished = s.finished;
  } else {
    finished = domBurn(overlay, glyphs, pictures, style).catch(() => undefined);
    stop = () => overlay.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    overlay.remove();
  };
  return {
    style,
    finished,
    dispose,
    cancel: () => {
      dispose();
      root.style.visibility = prevVisibility;
    },
  };
}

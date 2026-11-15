/**
 * Drives the desktop app (desktop/src-tauri) for end-to-end tests. Nothing like Playwright can
 * drive the system web views (WKWebView, WebKitGTK), so a debug build started with KAGIMO_E2E=1
 * takes requests on stdin and runs them in its page (desktop/src-tauri/src/e2e.rs). The helpers
 * here find elements roughly as Playwright's getByRole / getByLabel / getByText do.
 *
 * Waiting is done from here, one check per request, so a check that dies with the page during a
 * navigation is simply tried again on the next one.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './server';

export const appBinary = join(repoRoot, 'desktop', 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'kagimo.exe' : 'kagimo');

type Name = string | { re: string; flags: string };
/** What to find. `exact` matches the whole name; otherwise any part of it, ignoring case. */
export type Target =
  | { role: 'button' | 'link' | 'heading' | 'region' | 'checkbox'; name?: Name; exact?: boolean; within?: Target }
  | { label: string; exact?: boolean; within?: Target }
  | { placeholder: string; within?: Target }
  | { text: Name; exact?: boolean; within?: Target }
  | { css: string; hasText?: Name; hasNotText?: Name; within?: Target };

const name = (n: string | RegExp): Name => (n instanceof RegExp ? { re: n.source, flags: n.flags } : n);
export const role = (r: 'button' | 'link' | 'heading' | 'region' | 'checkbox', n?: string | RegExp, exact = false): Target => ({ role: r, name: n === undefined ? undefined : name(n), exact });
export const label = (l: string, exact = false): Target => ({ label: l, exact });
export const placeholder = (p: string): Target => ({ placeholder: p });
export const text = (t: string | RegExp, exact = false): Target => ({ text: name(t), exact });
export const css = (c: string, opts: { hasText?: string | RegExp; hasNotText?: string | RegExp } = {}): Target => ({
  css: c,
  hasText: opts.hasText === undefined ? undefined : name(opts.hasText),
  hasNotText: opts.hasNotText === undefined ? undefined : name(opts.hasNotText),
});
export const within = (outer: Target, inner: Target): Target => ({ ...inner, within: outer });

/** Runs in the page before every request: finds visible elements matching a Target. */
const FIND = String.raw`
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const matches = (value, n, exact) => {
  if (n === undefined || n === null) return true;
  const v = norm(value);
  if (typeof n === 'object') return new RegExp(n.re, n.flags).test(v);
  return exact ? v === n : v.toLowerCase().includes(n.toLowerCase());
};
const visible = (el) => {
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
};
const byIds = (ids) => (ids || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const accName = (el) => el.getAttribute('aria-label') || byIds(el.getAttribute('aria-labelledby')) || norm(el.tagName === 'INPUT' ? el.value : el.textContent) || el.getAttribute('title');
const ROLES = {
  button: 'button, [role=button], input[type=button], input[type=submit]',
  link: 'a[href], [role=link]',
  heading: 'h1, h2, h3, h4, h5, h6, [role=heading]',
  region: '[role=region], section[aria-label], section[aria-labelledby]',
  checkbox: 'input[type=checkbox], [role=checkbox]',
};
const labelOf = (el) => {
  const parts = [];
  if (el.id) for (const l of document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) parts.push(l.textContent);
  const wrap = el.closest('label');
  if (wrap) parts.push(wrap.textContent);
  if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
  if (el.getAttribute('aria-labelledby')) parts.push(byIds(el.getAttribute('aria-labelledby')));
  return parts;
};
const find = (t) => {
  const roots = t.within ? find(t.within) : [document];
  const out = [];
  for (const root of roots) {
    let found = [];
    if (t.role) found = [...root.querySelectorAll(ROLES[t.role])].filter((el) => matches(accName(el), t.name, t.exact));
    else if (t.label) found = [...root.querySelectorAll('input, textarea, select')].filter((el) => labelOf(el).some((l) => matches(l, t.label, t.exact)));
    else if (t.placeholder) found = [...root.querySelectorAll('[placeholder]')].filter((el) => el.getAttribute('placeholder') === t.placeholder);
    else if (t.text !== undefined) {
      const all = [...root.querySelectorAll('body *')].filter((el) => !['SCRIPT', 'STYLE'].includes(el.tagName) && matches(el.textContent, t.text, t.exact));
      // The innermost elements holding the text.
      found = all.filter((el) => ![...el.children].some((c) => matches(c.textContent, t.text, t.exact)));
    } else if (t.css) {
      found = [...root.querySelectorAll(t.css)].filter((el) => matches(el.textContent, t.hasText) && (t.hasNotText === undefined || !matches(el.textContent, t.hasNotText)));
    }
    out.push(...found.filter(visible));
  }
  return out;
};
const one = (t) => {
  const els = find(t);
  if (!els.length) throw new Error('not found: ' + JSON.stringify(t));
  return els[0];
};
const setValue = (el, value) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
`;

export class DesktopApp {
  private proc: ChildProcessWithoutNullStreams;
  private next = 1;
  private waiting = new Map<number, (r: { ok: boolean; value?: unknown; error?: string }) => void>();
  private exited: Promise<number | null>;
  /** Errors the page didn't catch. */
  readonly errors: string[] = [];
  /** Requests the page made to the sync server, as "METHOD /api/path". */
  readonly apiCalls: string[] = [];

  constructor(env: Record<string, string>) {
    this.proc = spawn(appBinary, [], { env: { ...process.env, ...env, KAGIMO_E2E: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        this.line(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    this.proc.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (process.env.E2E_VERBOSE) process.stderr.write(d);
    });
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
  }

  private line(l: string) {
    if (!l.startsWith('E2E ')) return;
    const m = JSON.parse(l.slice(4)) as { kind: string; id?: number; ok?: boolean; value?: unknown; error?: string; message?: string; method?: string; path?: string };
    if (m.kind === 'result' && m.id !== undefined) {
      this.waiting.get(m.id)?.({ ok: !!m.ok, value: m.value, error: m.error });
      this.waiting.delete(m.id);
    } else if (m.kind === 'pageerror') this.errors.push(m.message ?? '');
    else if (m.kind === 'api') this.apiCalls.push(`${m.method} ${(m.path ?? '').split('?')[0]}`);
  }

  /** Runs `body` (the body of an async function, with the helpers above in scope) in the page. */
  run<T>(body: string, timeout = 10_000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('no answer from the page'));
      }, timeout);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.value as T);
        else reject(new Error(r.error));
      });
      this.proc.stdin.write(JSON.stringify({ id, js: FIND + body }) + '\n');
    });
  }

  /** Waits until `check` (page code returning a boolean) is true. */
  async until(check: string, what: string, timeout = 15_000): Promise<void> {
    const end = Date.now() + timeout;
    let last = '';
    for (;;) {
      try {
        if (await this.run<boolean>(check, 2_000)) return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (${last})` : ''}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  waitFor(t: Target, timeout?: number) {
    return this.until(`return find(${JSON.stringify(t)}).length > 0;`, JSON.stringify(t), timeout);
  }

  waitGone(t: Target, timeout?: number) {
    return this.until(`return find(${JSON.stringify(t)}).length === 0;`, `${JSON.stringify(t)} to go`, timeout);
  }

  count(t: Target): Promise<number> {
    return this.run(`return find(${JSON.stringify(t)}).length;`);
  }

  async click(t: Target, timeout?: number) {
    await this.waitFor(t, timeout);
    await this.run(`const el = one(${JSON.stringify(t)}); el.scrollIntoView({ block: 'center' }); el.focus?.(); el.click();`);
  }

  async fill(t: Target, value: string, timeout?: number) {
    await this.waitFor(t, timeout);
    await this.run(`const el = one(${JSON.stringify(t)}); el.focus(); setValue(el, ${JSON.stringify(value)});`);
  }

  /** Types into the editor at the end of its text, as keystrokes would. */
  async typeInEditor(value: string) {
    const editor = css('.ProseMirror');
    await this.waitFor(editor);
    await this.run(
      `const el = one(${JSON.stringify(editor)}); el.focus();` +
        `const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();` +
        `await new Promise((r) => setTimeout(r, 50));` +
        `document.execCommand('insertText', false, ${JSON.stringify(value)});`,
    );
  }

  /** What the window shows, for a failure report. */
  bodyText(): Promise<string> {
    return this.run<string>('return document.body.innerText;', 2_000).catch(() => '(nothing)');
  }

  /** Closes the window as a person would (the page saves first) and waits for the app to exit. */
  async close(timeout = 15_000): Promise<void> {
    this.proc.stdin.write(JSON.stringify({ id: this.next++, close: true }) + '\n');
    const t = setTimeout(() => this.proc.kill(), timeout);
    await this.exited;
    clearTimeout(t);
  }

  kill() {
    this.proc.kill();
  }
}

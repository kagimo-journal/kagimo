// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Detection, EDITABLE_PRIVACY_ATTRS, scanTree, startExtensionDetector } from './extensions';

let found: Detection[] = [];
let stop: (() => void) | null = null;

/** MutationObserver callbacks run as microtasks. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function start() {
  stop = startExtensionDetector((d) => found.push(d));
}

function html(markup: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = markup;
  return wrap;
}

beforeEach(() => {
  found = [];
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="root"></div>';
  for (const el of [document.documentElement, document.body]) {
    for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
  }
});

afterEach(() => {
  stop?.();
  stop = null;
});

const privacyAttrs = Object.entries(EDITABLE_PRIVACY_ATTRS)
  .map(([k, v]) => `${k}="${v}"`)
  .join(' ');

/** A realistic snapshot of the editor DOM the app itself renders. */
const APP_DOM = `
  <a href="#entry-body" class="skip-link">Skip to entry</a>
  <main class="journal-main">
    <textarea id="title-1" class="entry-title-input" rows="1" placeholder="Title" ${privacyAttrs} autocapitalize="sentences"></textarea>
    <div>
      <div data-tippy-root="" id="tippy-3" style="z-index: 9999; visibility: hidden; position: absolute;">
        <div class="tippy-box" data-state="hidden" tabindex="-1" data-animation="fade" role="tooltip">
          <div class="tippy-content" data-state="hidden"><div class="bubble" role="toolbar"><button type="button" aria-label="Bold">B</button></div></div>
        </div>
      </div>
    </div>
    <div class="tiptap ProseMirror prose ProseMirror-focused" id="entry-body" contenteditable="true" role="textbox" aria-multiline="true"
      translate="no" tabindex="0" ${privacyAttrs}>
      <p class="is-empty is-editor-empty" data-placeholder="Start writing…"><br class="ProseMirror-trailingBreak"></p>
      <h2 style="text-align: center">Heading</h2>
      <div class="react-renderer node-encryptedImage" contenteditable="false" draggable="true">
        <figure data-node-view-wrapper="" class="entry-figure" data-drag-handle="" style="white-space: normal;">
          <div class="figure-frame"><img src="blob:http://localhost/0d7f0c4e-1" alt="Photo" width="800" height="600"></div>
          <input class="figure-caption" placeholder="Add a caption" aria-label="Image caption">
        </figure>
      </div>
      <figure data-encrypted-image="" data-blob-id="abc" data-alt="" data-caption="x" data-width="1" data-height="2"></figure>
      <hr class="ProseMirror-selectednode"><div class="ProseMirror-gapcursor"></div>
      <span data-node-view-content="" style="white-space: pre-wrap;"></span>
    </div>
  </main>
  <dialog class="dialog native-dialog" aria-labelledby=":r1:" open><h2 id=":r1:">Delete this entry?</h2><button class="btn">Cancel</button></dialog>
  <div class="toast-region" aria-live="polite"></div>
  <style type="text/css" data-vite-dev-id="/src/styles/global.css">.a{background:url(data:image/png;base64,AAAA)}</style>
  <link rel="stylesheet" href="/assets/index-abc123.css">
  <script type="module" src="/assets/index-abc123.js"></script>
  <x-unknown-widget data-foo="bar"></x-unknown-widget>
`;

describe('extension detector: known signatures', () => {
  const cases: [string, string][] = [
    ['Grammarly', '<div data-gramm></div>'],
    ['Grammarly', '<grammarly-desktop-integration data-grammarly-shadow-root="true"></grammarly-desktop-integration>'],
    ['Grammarly', '<textarea data-gramm="false" data-new-gr-c-s-check-loaded="14.1"></textarea>'],
    ['LanguageTool', '<lt-toolbar></lt-toolbar>'],
    ['LanguageTool', '<div data-lt-tmp-id="lt-123"></div>'],
    ['1Password', '<com-1password-button></com-1password-button>'],
    ['1Password', '<input data-1p-ignore>'],
    ['LastPass', '<div data-lastpass-icon-root=""></div>'],
    ['Bitwarden', '<input data-bwautofill="true">'],
    ['Dashlane', '<input data-dashlane-rid="abc">'],
    ['Dark Reader', '<style class="darkreader darkreader--fallback"></style>'],
    ['Microsoft Editor', '<msft-editor-squiggles></msft-editor-squiggles>'],
    ['Microsoft Editor', '<div data-ms-editor="true"></div>'],
  ];
  for (const [name, markup] of cases) {
    it(`flags ${name}: ${markup}`, async () => {
      start();
      document.body.append(...Array.from(html(markup).childNodes));
      await flush();
      expect(found.map((d) => d.name)).toEqual([name]);
    });
  }

  it('flags signatures already present before it starts (initial scan)', () => {
    document.documentElement.setAttribute('data-darkreader-mode', 'dynamic');
    start();
    expect(found).toEqual([{ name: 'Dark Reader', signal: 'attribute data-darkreader-mode' }]);
  });

  it('flags attributes added later to existing nodes', async () => {
    start();
    document.body.setAttribute('data-gr-ext-installed', '');
    await flush();
    expect(found.map((d) => d.name)).toEqual(['Grammarly']);
  });

  it('flags our opt-out attributes when an extension changes their value', async () => {
    const el = html(APP_DOM).querySelector('#entry-body')!;
    document.body.append(el);
    start();
    el.setAttribute('data-gramm', 'true');
    await flush();
    expect(found.map((d) => d.name)).toEqual(['Grammarly']);
  });
});

describe('extension detector: extension URLs', () => {
  const schemes = ['chrome-extension', 'moz-extension', 'safari-web-extension', 'ms-browser-extension'];
  for (const scheme of schemes) {
    it(`flags ${scheme}: on src and href`, async () => {
      start();
      const img = document.createElement('img');
      img.src = `${scheme}://abcdef/icon.png`;
      document.body.append(img);
      await flush();
      expect(found).toEqual([{ name: null, signal: `url ${scheme}://abcdef` }]);
    });
  }

  it('flags extension stylesheets, iframes and style text', async () => {
    start();
    document.head.append(...Array.from(html('<link rel="stylesheet" href="moz-extension://one/x.css">').childNodes));
    document.body.append(...Array.from(html('<iframe src="chrome-extension://two/frame.html"></iframe>').childNodes));
    const style = document.createElement('style');
    style.textContent = '.x{background:url("safari-web-extension://three/a.png")}';
    document.head.append(style);
    await flush();
    expect(found.map((d) => d.signal).sort()).toEqual(['url chrome-extension://two', 'url moz-extension://one', 'url safari-web-extension://three']);
  });

  it('flags CSP violations caused by an extension', () => {
    start();
    const ev = Object.assign(new Event('securitypolicyviolation', { bubbles: true }), {
      sourceFile: 'chrome-extension://abcdef/content.js',
      blockedURI: 'inline',
    });
    document.dispatchEvent(ev);
    const ev2 = Object.assign(new Event('securitypolicyviolation', { bubbles: true }), { sourceFile: '', blockedURI: 'moz-extension://zz/f.woff2' });
    document.body.dispatchEvent(ev2);
    expect(found.map((d) => d.signal)).toEqual(['url chrome-extension://abcdef', 'url moz-extension://zz']);
  });

  it('ignores CSP violations from the app itself', () => {
    start();
    const ev = Object.assign(new Event('securitypolicyviolation'), { sourceFile: 'http://localhost/assets/x.js', blockedURI: 'eval' });
    document.dispatchEvent(ev);
    expect(found).toEqual([]);
  });
});

describe('extension detector: the app itself', () => {
  it("doesn't flag the editor DOM, dialogs, portals or Vite's styles", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    expect(scanTree(html(APP_DOM))).toEqual([]);
    start();
    document.getElementById('root')!.innerHTML = APP_DOM;
    const portal = document.createElement('div');
    portal.setAttribute('data-tippy-root', '');
    document.body.append(portal);
    const ed = document.getElementById('entry-body')!;
    ed.classList.add('ProseMirror-hideselection');
    ed.setAttribute('data-placeholder', 'x');
    for (const [k, v] of Object.entries(EDITABLE_PRIVACY_ATTRS)) ed.setAttribute(k, v);
    await flush();
    expect(found).toEqual([]);
  });

  it('reports each extension once', async () => {
    start();
    document.body.append(...Array.from(html('<div data-gramm></div><div data-gr-id="1"></div><grammarly-extension></grammarly-extension>').childNodes));
    await flush();
    document.body.setAttribute('data-gr-ext-installed', '');
    const a = document.createElement('img');
    a.src = 'chrome-extension://same/a.png';
    const b = document.createElement('img');
    b.src = 'chrome-extension://same/b.png';
    document.body.append(a, b);
    await flush();
    expect(found.map((d) => d.name ?? d.signal)).toEqual(['Grammarly', 'url chrome-extension://same']);
  });

  it('stops watching when stopped', async () => {
    start();
    stop!();
    stop = null;
    document.body.append(...Array.from(html('<lt-toolbar></lt-toolbar>').childNodes));
    await flush();
    expect(found).toEqual([]);
  });
});

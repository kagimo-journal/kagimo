/**
 * Browser-extension detection (brief §6). Extensions with access to this page can read what is
 * typed into it, so while the app is open we watch for the traces the common ones leave in the DOM
 * and tell the user. This runs only in the page and reports nothing to the server: no requests, no
 * logging. Not seeing anything is no guarantee: many extensions leave no trace at all.
 */

/** Opt-out attributes for the entry title and body (spellcheck/grammar/autofill extensions). */
export const EDITABLE_PRIVACY_ATTRS = {
  spellcheck: 'false',
  autocorrect: 'off',
  autocomplete: 'off',
  'data-gramm': 'false',
  'data-gramm_editor': 'false',
  'data-enable-grammarly': 'false',
  'data-lt-active': 'false',
  'data-ms-editor': 'false',
} as const;

/** The same opt-outs as React props, for textareas and inputs rendered by React. */
export const EDITABLE_PRIVACY_PROPS = {
  spellCheck: false,
  autoCorrect: 'off',
  autoComplete: 'off',
  'data-gramm': 'false',
  'data-gramm_editor': 'false',
  'data-enable-grammarly': 'false',
  'data-lt-active': 'false',
  'data-ms-editor': 'false',
} as const;

export interface Detection {
  /** Friendly name from the signature table, or null for "a browser extension". */
  name: string | null;
  /** What gave it away, e.g. `attribute data-gr-ext-installed` (stays in the page). */
  signal: string;
}

interface Signature {
  name: string;
  /** Lower-case element name prefixes (custom elements the extension injects). */
  elements?: string[];
  /** Attribute name tests. */
  attributes?: (name: string) => boolean;
  /** Class names on injected elements (e.g. Dark Reader's style tags). */
  classes?: string[];
}

const startsWith = (...prefixes: string[]) => (n: string) => prefixes.some((p) => n.startsWith(p));

/** Known signatures. Order matters only for readability; names are unique. */
export const SIGNATURES: Signature[] = [
  {
    name: 'Grammarly',
    elements: ['grammarly-'],
    attributes: (n) =>
      n === 'data-gramm' || n === 'data-gramm_editor' || n === 'data-enable-grammarly' || n === 'data-new-gr-c-s-check-loaded' ||
      n === 'data-new-gr-c-s-loaded' || n.startsWith('data-gr-'),
  },
  { name: 'LanguageTool', elements: ['lt-'], attributes: startsWith('data-lt-') },
  { name: '1Password', elements: ['com-1password-', 'onepassword-'], attributes: startsWith('data-1p-', 'data-onepassword') },
  { name: 'LastPass', elements: ['lastpass-'], attributes: startsWith('data-lastpass', 'data-lpignore', 'data-lp-') },
  { name: 'Bitwarden', elements: ['bitwarden-'], attributes: startsWith('data-bwautofill', 'data-bitwarden', 'data-bwignore') },
  { name: 'Dashlane', elements: ['dashlane-'], attributes: startsWith('data-dashlane', 'data-kwimpalastatus', 'data-kwimpalaid') },
  { name: 'Dark Reader', attributes: startsWith('data-darkreader'), classes: ['darkreader'] },
  { name: 'Microsoft Editor', elements: ['msft-', 'ms-editor'], attributes: startsWith('data-ms-editor', 'data-msft-') },
];

/** URL schemes only extensions use. */
const EXTENSION_SCHEMES = ['chrome-extension:', 'moz-extension:', 'safari-web-extension:', 'safari-extension:', 'ms-browser-extension:'];
const SCHEME_RE = /(chrome-extension|moz-extension|safari-web-extension|safari-extension|ms-browser-extension):\/\/[^/\s"')]*/i;
const URL_ATTRS = ['src', 'href', 'data', 'srcset', 'poster', 'action', 'xlink:href'];

/**
 * The app's own attributes (TipTap/ProseMirror, Tippy, our encrypted-image node, React) never
 * match a signature, but they are listed explicitly so a future signature can't flag them.
 */
const APP_ATTRIBUTE_PREFIXES = [
  'data-node-view',
  'data-tippy',
  'data-placeholder',
  'data-encrypted-image',
  'data-blob-id',
  'data-alt',
  'data-caption',
  'data-width',
  'data-height',
  'data-drag-handle',
  'data-text-align',
  'data-type',
  'data-reactroot',
  'data-vite-dev-id',
];

function isOwnAttribute(name: string, value: string | null): boolean {
  const ours = (EDITABLE_PRIVACY_ATTRS as Record<string, string>)[name];
  if (ours !== undefined) return value === ours;
  return APP_ATTRIBUTE_PREFIXES.some((p) => name === p || name.startsWith(`${p}-`));
}

function extensionUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = SCHEME_RE.exec(value);
  return m ? m[0].toLowerCase() : null;
}

/** Checks one attribute. Returns a detection or null. */
export function checkAttribute(el: Element, name: string): Detection | null {
  const attr = name.toLowerCase();
  const value = el.getAttribute(name);
  if (URL_ATTRS.includes(attr)) {
    const url = extensionUrl(value);
    if (url) return { name: null, signal: `url ${url}` };
  }
  if (attr === 'class') {
    for (const sig of SIGNATURES) {
      if (sig.classes?.some((c) => el.classList.contains(c))) return { name: sig.name, signal: `class ${sig.classes.join(' ')}` };
    }
    return null;
  }
  if (attr === 'style') {
    const url = extensionUrl(value);
    return url ? { name: null, signal: `url ${url}` } : null;
  }
  if (isOwnAttribute(attr, value)) return null;
  for (const sig of SIGNATURES) {
    if (sig.attributes?.(attr)) return { name: sig.name, signal: `attribute ${attr}` };
  }
  return null;
}

/** Checks an element's tag, attributes and (for <style>) its text. */
export function checkElement(el: Element): Detection[] {
  const out: Detection[] = [];
  const tag = el.localName.toLowerCase();
  if (tag.includes('-')) {
    for (const sig of SIGNATURES) {
      if (sig.elements?.some((p) => tag.startsWith(p))) {
        out.push({ name: sig.name, signal: `element <${tag}>` });
        break;
      }
    }
  }
  for (const a of Array.from(el.attributes)) {
    const d = checkAttribute(el, a.name);
    if (d) out.push(d);
  }
  if (tag === 'style') {
    const url = extensionUrl(el.textContent);
    if (url) out.push({ name: null, signal: `url ${url}` });
  }
  return out;
}

/** Checks an element and everything inside it. */
export function scanTree(root: Element): Detection[] {
  const out = checkElement(root);
  for (const el of Array.from(root.querySelectorAll('*'))) out.push(...checkElement(el));
  return out;
}

function dedupeKey(d: Detection): string {
  if (d.name) return d.name;
  const url = /^url (.+)$/.exec(d.signal)?.[1];
  return url ? `url:${url}` : `signal:${d.signal}`;
}

/**
 * Watches the document for extension traces and calls `onDetect` once per distinct extension
 * (by name; unnamed ones by extension origin). Returns a function that stops watching.
 */
export function startExtensionDetector(onDetect: (d: Detection) => void, doc: Document = document): () => void {
  const seen = new Set<string>();
  const report = (list: Detection[]) => {
    for (const d of list) {
      const key = dedupeKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      onDetect(d);
    }
  };

  const observer = new MutationObserver((records) => {
    const found: Detection[] = [];
    for (const r of records) {
      if (r.type === 'attributes' && r.attributeName && r.target instanceof Element) {
        const d = checkAttribute(r.target, r.attributeName);
        if (d) found.push(d);
      } else if (r.type === 'childList') {
        r.addedNodes.forEach((n) => {
          if (n.nodeType === 1) found.push(...scanTree(n as Element));
          else if (n.nodeType === 3 && r.target instanceof Element && r.target.localName === 'style') {
            const url = extensionUrl(n.textContent);
            if (url) found.push({ name: null, signal: `url ${url}` });
          }
        });
      }
    }
    if (found.length) report(found);
  });

  const onViolation = (e: Event) => {
    const v = e as SecurityPolicyViolationEvent;
    const url = extensionUrl(v.sourceFile) ?? extensionUrl(v.blockedURI);
    if (url) report([{ name: null, signal: `url ${url}` }]);
  };

  observer.observe(doc.documentElement, { subtree: true, attributes: true, childList: true });
  doc.addEventListener('securitypolicyviolation', onViolation, true);
  report(scanTree(doc.documentElement));

  return () => {
    observer.disconnect();
    doc.removeEventListener('securitypolicyviolation', onViolation, true);
  };
}

export { EXTENSION_SCHEMES };

// ---- shared store (one detector per app session) ----------------------------------

let detections: Detection[] = [];
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

export const extensionStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    if (!stop && typeof document !== 'undefined') {
      stop = startExtensionDetector((d) => {
        detections = [...detections, d];
        listeners.forEach((fn) => fn());
      });
    }
    return () => {
      listeners.delete(l);
      if (!listeners.size && stop) {
        stop();
        stop = null;
        detections = [];
      }
    };
  },
  get: (): Detection[] => detections,
};

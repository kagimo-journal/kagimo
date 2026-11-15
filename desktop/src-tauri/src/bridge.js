// window.kagimoDesktop: the page's only way to the rest of the computer (shape in
// frontend/src/desktop/bridge.ts). Each call is a Tauri command in src/lib.rs, which checks every
// argument; capabilities/main.json lists the commands the window may call, and nothing else.
//
// Installed before the page's own scripts, in the top frame only. Bytes cross as base64.
(() => {
  if (window.top !== window || window.kagimoDesktop) return;
  const tauri = window.__TAURI_INTERNALS__;

  const toB64 = (u) => {
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const bytesOrNull = (b) => (b == null ? null : fromB64(b));

  const invoke = (cmd, args) =>
    tauri.invoke(cmd, args).catch((e) => {
      throw new Error(typeof e === 'string' ? e : (e && e.message) || String(e));
    });

  const listeners = {};
  const on = (ch) => (fn) => {
    (listeners[ch] ??= new Set()).add(fn);
    return () => listeners[ch].delete(fn);
  };
  // Called by the app (menu items, closing the window).
  Object.defineProperty(window, '__kagimoEmit', {
    value: (ch) => {
      for (const fn of listeners[ch] ?? []) {
        try {
          fn();
        } catch (e) {
          console.error(e);
        }
      }
    },
  });

  /** fetch() for the sync server's /api, sent by the app with its own cookie jar. */
  async function api(path, init = {}) {
    const signal = init.signal;
    const aborted = () => new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) throw aborted();
    let body = init.body;
    if (body != null) {
      if (typeof body === 'string') body = new TextEncoder().encode(body);
      else if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
      else if (body instanceof ArrayBuffer) body = new Uint8Array(body);
      else if (ArrayBuffer.isView(body)) body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      else throw new TypeError('Unsupported request body');
    }
    const req = {
      method: init.method ?? 'GET',
      path,
      headers: [...new Headers(init.headers ?? {}).entries()],
      body: body == null ? null : toB64(body),
    };
    const sent = tauri.invoke('api_fetch', { req }).then(
      (r) => new Response(bytesOrNull(r.body), { status: r.status, statusText: r.statusText, headers: r.headers }),
      (e) => {
        // What fetch throws when the server can't be reached.
        if (e === 'network') throw new TypeError('Failed to fetch');
        throw new Error(String(e));
      },
    );
    if (!signal) return sent;
    return new Promise((resolve, reject) => {
      const abort = () => reject(aborted());
      signal.addEventListener('abort', abort, { once: true });
      sent.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  const bridge = {
    platform: navigator.userAgent.includes('Windows') ? 'win32' : navigator.userAgent.includes('Mac') ? 'darwin' : 'linux',
    folder: {
      current: () => invoke('folder_current'),
      pick: () => invoke('folder_pick'),
      open: () => invoke('folder_open'),
      reveal: () => invoke('folder_reveal'),
    },
    files: {
      readDoc: (name) => invoke('files_read_doc', { name }),
      writeDoc: (name, value) => invoke('files_write_doc', { name, value: value ?? null }),
      list: (coll) => invoke('files_list', { coll }),
      read: (coll, id) => invoke('files_read', { coll, id }),
      write: (coll, id, value) => invoke('files_write', { coll, id, value: value ?? null }),
      readBytes: (id) => invoke('files_read_bytes', { id }).then(bytesOrNull),
      writeBytes: (id, bytes) => invoke('files_write_bytes', { id, bytes: bytes == null ? null : toB64(bytes) }),
      wipe: () => invoke('files_wipe'),
    },
    keys: {
      save: (vaultId, mk) => invoke('keys_save', { vaultId, mk: toB64(mk) }),
      load: (vaultId) => invoke('keys_load', { vaultId }).then(bytesOrNull),
      delete: (vaultId) => invoke('keys_delete', { vaultId }),
    },
    server: {
      get: () => invoke('server_get'),
      set: (url) => invoke('server_set', { url }),
    },
    api,
    openExternal: (url) => invoke('open_external', { url }),
    onChooseFolder: on('menu:choose-folder'),
    onNewEntry: on('menu:new-entry'),
    /** `save` runs when the window is closing; the window closes once it settles. */
    onClosing(save) {
      on('app:closing')(() => {
        Promise.resolve()
          .then(save)
          .catch(() => {})
          .finally(() => invoke('app_closed_ok'));
      });
      void invoke('app_listening');
    },
  };
  Object.defineProperty(window, 'kagimoDesktop', { value: Object.freeze(bridge), writable: false, configurable: false });
})();

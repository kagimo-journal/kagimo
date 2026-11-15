/*
 * Paints the saved theme before first render, so there is no flash of the wrong theme.
 * Loaded as a classic, render-blocking script from <head> because the CSP forbids inline
 * scripts. Only non-secret values (theme tokens and writing typography) are read from
 * localStorage here; the encrypted settings blob remains the source of truth once unlocked.
 */
(function () {
  try {
    var raw = localStorage.getItem('journal.theme.v1');
    if (!raw) return;
    var t = JSON.parse(raw);
    if (!t || !t.light || !t.dark) return;
    var dark = t.mode === 'dark' || (t.mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var vars = dark ? t.dark : t.light;
    var root = document.documentElement;
    var safe = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\)|light|dark)$/;
    for (var k in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, k)) continue;
      var v = vars[k];
      if (!/^[a-z-]+$/.test(k) || typeof v !== 'string' || !safe.test(v)) continue;
      if (k === 'color-scheme') root.style.colorScheme = v;
      else root.style.setProperty('--' + k, v);
    }
    // Writing typography (font stack, size, line spacing); the face itself loads with the app.
    var w = t.writing && t.writing.vars;
    var wsafe = { 'writing-font': /^[A-Za-z0-9 ',-]+$/, 'writing-size': /^\d{1,2}(\.\d+)?px$/, 'writing-leading': /^\d(\.\d+)?$/ };
    for (var wk in wsafe) {
      if (w && typeof w[wk] === 'string' && wsafe[wk].test(w[wk])) root.style.setProperty('--' + wk, w[wk]);
    }
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    /* fall back to the stylesheet defaults */
  }
})();

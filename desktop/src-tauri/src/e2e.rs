//! End-to-end test driver (e2e/src/desktop.e2e.ts), in debug builds started with KAGIMO_E2E=1 only.
//!
//! The test sends one JSON request per line on stdin: `{"id": n, "js": "<async function body>"}`
//! runs that code in the page and answers with its result; `{"id": n, "close": true}` closes the
//! window as a person would (the page saves first). Everything goes back on stdout as lines
//! starting `E2E `: results, page errors, and every /api request the page makes.

use std::io::BufRead;

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

pub fn enabled() -> bool {
    cfg!(debug_assertions) && std::env::var("KAGIMO_E2E").is_ok_and(|v| v == "1")
}

/// Installed in the page in e2e runs: reports errors the page doesn't catch.
pub const PAGE_SCRIPT: &str = r#"
  (() => {
    if (window.top !== window) return;
    const report = (message) => window.__TAURI_INTERNALS__.invoke('e2e_report', { line: { kind: 'pageerror', message: String(message) } });
    window.addEventListener('error', (e) => report(e.message));
    window.addEventListener('unhandledrejection', (e) => report(e.reason && e.reason.message ? e.reason.message : e.reason));
  })();
"#;

pub fn print(line: Value) {
    println!("E2E {line}");
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    #[serde(default)]
    js: Option<String>,
    #[serde(default)]
    close: bool,
}

/// Reads the test's requests from stdin until it closes.
pub fn listen(app: AppHandle) {
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(req) = serde_json::from_str::<Request>(&line) else {
                print(json!({ "kind": "bad-request", "line": line }));
                continue;
            };
            let Some(w) = app.get_webview_window(crate::MAIN) else { continue };
            if req.close {
                let _ = w.close();
                continue;
            }
            let Some(js) = req.js else { continue };
            let id = req.id;
            // The code runs as the body of an async function; its value comes back as JSON.
            let wrapped = format!(
                "(async () => {{ {js}\n}})().then(\
                   (v) => window.__TAURI_INTERNALS__.invoke('e2e_report', {{ line: {{ kind: 'result', id: {id}, ok: true, value: v === undefined ? null : v }} }}),\
                   (e) => window.__TAURI_INTERNALS__.invoke('e2e_report', {{ line: {{ kind: 'result', id: {id}, ok: false, error: String(e && e.message || e) }} }}));"
            );
            if w.eval(wrapped).is_err() {
                print(json!({ "kind": "result", "id": id, "ok": false, "error": "eval failed" }));
            }
        }
    });
}

#[tauri::command]
pub fn e2e_report(state: State<'_, AppState>, line: Value) {
    if state.e2e {
        print(line);
    }
}

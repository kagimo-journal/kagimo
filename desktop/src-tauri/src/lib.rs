//! Kagimo for the desktop. The window runs the same app as the website (frontend/, built with
//! `--mode desktop` into ../renderer) in the system's web view (WKWebView, WebView2, WebKitGTK),
//! with two differences that live here:
//!
//!  - The journal is kept in a folder the person chooses (store.rs) instead of the browser's own
//!    storage. The files are the same ciphertext the browser would hold.
//!  - There is no web server behind the page. Its files are built into the app, and its /api
//!    requests are sent to the sync server from here (api.rs), which only ever happens when the
//!    person turns sync on or signs in.
//!
//! The page reaches this process only through window.kagimoDesktop (bridge.js), and only the
//! commands below (capabilities/main.json).

mod api;
mod config;
mod e2e;
mod error;
mod keys;
mod store;

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::Serialize;
use serde_json::Value;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_opener::OpenerExt;

use crate::api::{ApiRequest, ApiResponse, SyncClient};
use crate::config::{Config, KAGIMO_SERVER, server_origin};
use crate::error::{Error, Result};
use crate::keys::Keys;
use crate::store::{JournalFolder, is_collection, is_id};

const MAIN: &str = "main";

/// Development and tests only: never read in a release build.
struct Dev {
    /// Keeps the app's own data (config, keys) somewhere else.
    user_data: Option<PathBuf>,
    /// Answers the "choose a folder" dialog with this path.
    pick_folder: Option<PathBuf>,
    /// The sync server used until another is chosen (tests never talk to kagimo.com).
    server: Option<String>,
}

impl Dev {
    fn from_env() -> Self {
        if !cfg!(debug_assertions) {
            return Dev {
                user_data: None,
                pick_folder: None,
                server: None,
            };
        }
        let var = |k| std::env::var(k).ok().filter(|v: &String| !v.is_empty());
        Dev {
            user_data: var("KAGIMO_USER_DATA").map(PathBuf::from),
            pick_folder: var("KAGIMO_PICK_FOLDER").map(PathBuf::from),
            server: var("KAGIMO_SERVER"),
        }
    }
}

struct AppState {
    config: Mutex<Config>,
    config_file: PathBuf,
    default_server: String,
    /// The open journal folder. Holding the lock is what makes file operations run one at a time,
    /// in the order they were asked for (tokio's mutex is first come, first served).
    folder: tokio::sync::Mutex<Option<JournalFolder>>,
    /// A folder chosen in the dialog and not opened yet. Only a folder the person picked can be opened.
    picked: Mutex<Option<PathBuf>>,
    pick_folder: Option<PathBuf>,
    sync: SyncClient,
    keys: Keys,
    /// The page has said it will answer "closing" (it saves open entries first).
    page_listens: AtomicBool,
    closing: AtomicBool,
    /// An end-to-end test is driving the app (e2e.rs).
    e2e: bool,
}

impl AppState {
    fn server(&self) -> String {
        self.config.lock().unwrap().server.clone()
    }
}

// ---- the journal folder ----------------------------------------------------------------------------

#[derive(Serialize)]
struct Current {
    path: PathBuf,
    available: bool,
}

#[tauri::command]
async fn folder_current(state: State<'_, AppState>) -> Result<Option<Current>> {
    let folder = state.folder.lock().await;
    Ok(folder.as_ref().map(|f| Current {
        path: f.dir.clone(),
        available: f.dir.is_dir(),
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Picked {
    path: PathBuf,
    has_journal: bool,
}

async fn choose_folder(window: &WebviewWindow) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_title("Choose a folder for your journal")
        .set_parent(window)
        .pick_folder(move |p| {
            let _ = tx.send(p.and_then(|p| p.into_path().ok()));
        });
    rx.await.ok().flatten()
}

enum Crowded {
    Another,
    UseIt,
    Cancel,
}

async fn ask_about_other_files(window: &WebviewWindow, dir: &std::path::Path) -> Crowded {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let (another, use_it, cancel) = ("Choose another folder", "Use it anyway", "Cancel");
    window
        .dialog()
        .message(format!(
            "Kagimo would keep the journal's files alongside them in\n{}\n\nA folder of its own is easier to back up and to move.",
            dir.display()
        ))
        .title("This folder already has files in it")
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            another.into(),
            use_it.into(),
            cancel.into(),
        ))
        .parent(window)
        .show_with_result(move |r| {
            let _ = tx.send(r);
        });
    match rx.await.unwrap_or_default() {
        MessageDialogResult::Yes => Crowded::Another,
        MessageDialogResult::No => Crowded::UseIt,
        MessageDialogResult::Custom(s) if s == another => Crowded::Another,
        MessageDialogResult::Custom(s) if s == use_it => Crowded::UseIt,
        _ => Crowded::Cancel,
    }
}

#[tauri::command]
async fn folder_pick(window: WebviewWindow, state: State<'_, AppState>) -> Result<Option<Picked>> {
    loop {
        let dir = match &state.pick_folder {
            Some(dir) => {
                std::fs::create_dir_all(dir)?;
                dir.clone()
            }
            None => match choose_folder(&window).await {
                Some(d) => d,
                None => return Ok(None),
            },
        };
        let candidate = JournalFolder::new(&dir);
        let has_journal = candidate.has_journal()?;
        if !has_journal && state.pick_folder.is_none() && candidate.has_other_files()? {
            match ask_about_other_files(&window, &dir).await {
                Crowded::Another => continue,
                Crowded::Cancel => return Ok(None),
                Crowded::UseIt => {}
            }
        }
        *state.picked.lock().unwrap() = Some(dir.clone());
        return Ok(Some(Picked { path: dir, has_journal }));
    }
}

#[derive(Serialize)]
struct Opened {
    path: PathBuf,
}

#[tauri::command]
async fn folder_open(state: State<'_, AppState>) -> Result<Opened> {
    let dir = state
        .picked
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| Error::msg("Choose a folder first."))?;
    // Whatever was queued for the old folder finishes there first.
    let mut folder = state.folder.lock().await;
    let f = JournalFolder::new(&dir);
    f.sweep(SystemTime::now());
    *folder = Some(f);
    let mut config = state.config.lock().unwrap();
    config.folder = Some(dir.clone());
    config.save(&state.config_file)?;
    Ok(Opened { path: dir })
}

#[tauri::command]
async fn folder_reveal(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let dir = state
        .folder
        .lock()
        .await
        .as_ref()
        .map(|f| f.dir.clone())
        .ok_or_else(|| Error::msg("No journal folder is open."))?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| Error::msg(e.to_string()))
}

/// Runs `f` on the open folder, after everything asked for before it.
async fn with_folder<T>(state: &AppState, f: impl FnOnce(&JournalFolder) -> Result<T>) -> Result<T> {
    let folder = state.folder.lock().await;
    f(folder.as_ref().ok_or_else(|| Error::msg("No journal folder is open."))?)
}

fn check_id(id: &str) -> Result<()> {
    if is_id(id) { Ok(()) } else { Err(Error::msg("Invalid id")) }
}

fn check_coll(coll: &str) -> Result<()> {
    if is_collection(coll) {
        Ok(())
    } else {
        Err(Error::msg("Unknown journal collection"))
    }
}

#[tauri::command]
async fn files_read_doc(state: State<'_, AppState>, name: String) -> Result<Option<Value>> {
    with_folder(&state, |f| f.read_doc(&name)).await
}

#[tauri::command]
async fn files_write_doc(state: State<'_, AppState>, name: String, value: Option<Value>) -> Result<()> {
    with_folder(&state, |f| f.write_doc(&name, value.as_ref())).await
}

#[tauri::command]
async fn files_list(state: State<'_, AppState>, coll: String) -> Result<Vec<Value>> {
    check_coll(&coll)?;
    with_folder(&state, |f| f.list(&coll)).await
}

#[tauri::command]
async fn files_read(state: State<'_, AppState>, coll: String, id: String) -> Result<Option<Value>> {
    check_coll(&coll)?;
    check_id(&id)?;
    with_folder(&state, |f| f.read(&coll, &id)).await
}

#[tauri::command]
async fn files_write(state: State<'_, AppState>, coll: String, id: String, value: Option<Value>) -> Result<()> {
    check_coll(&coll)?;
    check_id(&id)?;
    with_folder(&state, |f| f.write(&coll, &id, value.as_ref())).await
}

#[tauri::command]
async fn files_read_bytes(state: State<'_, AppState>, id: String) -> Result<Option<String>> {
    check_id(&id)?;
    Ok(with_folder(&state, |f| f.read_bytes(&id)).await?.map(|b| B64.encode(b)))
}

#[tauri::command]
async fn files_write_bytes(state: State<'_, AppState>, id: String, bytes: Option<String>) -> Result<()> {
    check_id(&id)?;
    let bytes = bytes.map(|b| B64.decode(b).map_err(|_| Error::msg("Invalid data"))).transpose()?;
    with_folder(&state, |f| f.write_bytes(&id, bytes.as_deref())).await
}

#[tauri::command]
async fn files_wipe(state: State<'_, AppState>) -> Result<()> {
    with_folder(&state, |f| f.wipe()).await
}

// ---- the key of a journal without a password ---------------------------------------------------------

#[tauri::command]
async fn keys_save(state: State<'_, AppState>, vault_id: String, mk: String) -> Result<()> {
    check_id(&vault_id)?;
    let mk = B64
        .decode(mk)
        .ok()
        .filter(|k| k.len() == 32)
        .ok_or_else(|| Error::msg("Invalid key"))?;
    state.keys.save(&vault_id, &mk)
}

#[tauri::command]
async fn keys_load(state: State<'_, AppState>, vault_id: String) -> Result<Option<String>> {
    check_id(&vault_id)?;
    Ok(state.keys.load(&vault_id)?.map(|k| B64.encode(k)))
}

#[tauri::command]
async fn keys_delete(state: State<'_, AppState>, vault_id: String) -> Result<()> {
    check_id(&vault_id)?;
    state.keys.delete(&vault_id)
}

// ---- the sync server ------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    url: String,
    is_default: bool,
}

#[tauri::command]
async fn server_get(state: State<'_, AppState>) -> Result<ServerInfo> {
    let url = state.server();
    Ok(ServerInfo {
        is_default: url == state.default_server,
        url,
    })
}

#[tauri::command]
async fn server_set(state: State<'_, AppState>, url: String) -> Result<ServerInfo> {
    let origin = if url.trim().is_empty() {
        state.default_server.clone()
    } else {
        server_origin(&url).ok_or_else(|| Error::msg("Enter the address of a Kagimo server, starting with https://"))?
    };
    let changed = {
        let mut config = state.config.lock().unwrap();
        let changed = config.server != origin;
        if changed {
            config.server = origin.clone();
            config.save(&state.config_file)?;
        }
        changed
    };
    if changed {
        // Another server: the old one's session means nothing to it.
        state.sync.reset();
    }
    Ok(ServerInfo {
        is_default: origin == state.default_server,
        url: origin,
    })
}

#[tauri::command]
async fn api_fetch(state: State<'_, AppState>, req: ApiRequest) -> Result<ApiResponse> {
    let server = state.server();
    if state.e2e {
        e2e::print(serde_json::json!({ "kind": "api", "method": req.method, "path": req.path }));
    }
    state.sync.send(&server, req).await
}

// ---- the window ------------------------------------------------------------------------------------------

#[tauri::command]
async fn open_external(app: AppHandle, url: String) -> Result<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https:") || lower.starts_with("mailto:")) {
        return Err(Error::msg("Not a link Kagimo can open."));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| Error::msg(e.to_string()))
}

#[tauri::command]
fn app_listening(state: State<'_, AppState>) {
    state.page_listens.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn app_closed_ok(window: WebviewWindow) {
    let _ = window.destroy();
}

/// The app's own pages: macOS and Linux serve them at tauri://localhost, Windows at http(s)://tauri.localhost.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// A link meant for another window or site: it opens in the browser. One of the app's own pages
/// (the terms, from a sync form) opens on the sync server, which has the same page.
fn open_outside(app: &AppHandle, url: &Url) {
    let target = if is_app_url(url) {
        let server = app.state::<AppState>().server();
        format!("{server}{}", url.path())
    } else if matches!(url.scheme(), "https" | "http" | "mailto") {
        url.to_string()
    } else {
        return;
    };
    let _ = app.opener().open_url(target, None::<&str>);
}

/// Tells the page something happened (bridge.js `__kagimoEmit`).
fn emit(app: &AppHandle, channel: &str) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.eval(format!(
            "window.__kagimoEmit && window.__kagimoEmit({})",
            serde_json::to_string(channel).unwrap()
        ));
    }
}

fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav = app.clone();
    let popup = app.clone();
    let mut b = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Kagimo")
        .inner_size(1240.0, 860.0)
        .min_inner_size(360.0, 480.0)
        .initialization_script(include_str!("bridge.js"));
    if app.state::<AppState>().e2e {
        // Wide enough for the entry list beside the editor, whatever the display.
        b = b.inner_size(1280.0, 900.0).initialization_script(e2e::PAGE_SCRIPT);
    }
    let w = b
        // The window only ever shows the app. Links elsewhere open in the browser.
        .on_navigation(move |url| {
            if is_app_url(url) {
                // A new page (a reload) has to say again that it listens for "closing".
                nav.state::<AppState>().page_listens.store(false, Ordering::SeqCst);
                return true;
            }
            open_outside(&nav, url);
            false
        })
        .on_new_window(move |url, _| {
            open_outside(&popup, &url);
            NewWindowResponse::Deny
        })
        .build()?;

    // Closing waits for the page to save what's being written (it answers within moments).
    let app = app.clone();
    let win = w.clone();
    w.on_window_event(move |e| {
        let WindowEvent::CloseRequested { api, .. } = e else { return };
        let state = app.state::<AppState>();
        if !state.page_listens.load(Ordering::SeqCst) || state.closing.swap(true, Ordering::SeqCst) {
            return;
        }
        api.prevent_close();
        emit(&app, "app:closing");
        let win = win.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(6)).await;
            let _ = win.destroy();
        });
    });
    Ok(w)
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let mac = cfg!(target_os = "macos");
    let file = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new-entry", "New Entry")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("choose-folder", "Open Journal Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "show-folder",
                if mac {
                    "Show Journal Folder in Finder"
                } else {
                    "Show Journal Folder"
                },
            )
            .build(app)?,
        )
        .separator()
        .item(&if mac {
            PredefinedMenuItem::close_window(app, None)?
        } else {
            PredefinedMenuItem::quit(app, None)?
        })
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    let mut menu = MenuBuilder::new(app);
    if mac {
        let app_menu = SubmenuBuilder::new(app, "Kagimo")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    app.set_menu(menu.item(&file).item(&edit).item(&view).item(&window).build()?)?;
    app.on_menu_event(|app, e| match e.id().as_ref() {
        "new-entry" => emit(app, "menu:new-entry"),
        "choose-folder" => emit(app, "menu:choose-folder"),
        "show-folder" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                let dir = state.folder.lock().await.as_ref().map(|f| f.dir.clone());
                if let Some(dir) = dir {
                    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
                }
            });
        }
        _ => {}
    });
    Ok(())
}

// ---- start ------------------------------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dev = Dev::from_env();
    let mut builder = tauri::Builder::default();
    // Two copies writing the same folder would overwrite each other: a second start shows the first.
    // The lock is per app, so a test run with its own data (KAGIMO_USER_DATA) leaves it out and can
    // run beside a copy someone is using.
    if dev.user_data.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let data = match &dev.user_data {
                Some(d) => d.clone(),
                None => app.path().app_data_dir()?,
            };
            let default_server = dev
                .server
                .as_deref()
                .and_then(server_origin)
                .unwrap_or_else(|| KAGIMO_SERVER.to_string());
            let config_file = data.join("config.json");
            let config = Config::load(&config_file, &default_server);
            let folder = config.folder.as_ref().map(JournalFolder::new);
            if let Some(f) = &folder {
                f.sweep(SystemTime::now());
            }
            app.manage(AppState {
                config: Mutex::new(config),
                config_file,
                default_server,
                folder: tokio::sync::Mutex::new(folder),
                picked: Mutex::new(None),
                pick_folder: dev.pick_folder.clone(),
                sync: SyncClient::new(if dev.user_data.is_some() {
                    Keys::Files(data.join("session"))
                } else {
                    Keys::System
                }),
                keys: if dev.user_data.is_some() {
                    Keys::Files(data.join("keys"))
                } else {
                    Keys::System
                },
                page_listens: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                e2e: e2e::enabled(),
            });
            if e2e::enabled() {
                e2e::listen(app.handle().clone());
            }
            build_menu(app.handle())?;
            build_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            folder_current,
            folder_pick,
            folder_open,
            folder_reveal,
            files_read_doc,
            files_write_doc,
            files_list,
            files_read,
            files_write,
            files_read_bytes,
            files_write_bytes,
            files_wipe,
            keys_save,
            keys_load,
            keys_delete,
            server_get,
            server_set,
            api_fetch,
            open_external,
            app_listening,
            app_closed_ok,
            e2e::e2e_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kagimo");
}

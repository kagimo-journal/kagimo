// The app's own commands are listed here so the window can be allowed exactly these and nothing
// else (capabilities/main.json grants each one's `allow-<name>` permission).
const COMMANDS: &[&str] = &[
    "folder_current",
    "folder_pick",
    "folder_open",
    "folder_reveal",
    "files_read_doc",
    "files_write_doc",
    "files_list",
    "files_read",
    "files_write",
    "files_read_bytes",
    "files_write_bytes",
    "files_wipe",
    "keys_save",
    "keys_load",
    "keys_delete",
    "server_get",
    "server_set",
    "api_fetch",
    "open_external",
    "app_listening",
    "app_closed_ok",
    // Answers only in a debug build started by the end-to-end test (src/e2e.rs).
    "e2e_report",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri build");
}

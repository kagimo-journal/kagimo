//! Secrets kept on this computer, in the operating system's credential store (macOS Keychain,
//! Windows Credential Manager, the Secret Service on Linux), never in the journal folder:
//!
//!  - the master key of a journal without a password (such a journal has to open by itself;
//!    setting a password deletes it), under the journal's id;
//!  - the sync server's cookies (api.rs), under "sync-session".

use std::path::PathBuf;

use crate::error::{Error, Result};

const SERVICE: &str = "com.kagimo.desktop";

pub enum Keys {
    /// The system's credential store.
    System,
    /// Development and tests only (KAGIMO_USER_DATA in a debug build): plain files in this folder,
    /// so test runs never touch the real keychain.
    Files(PathBuf),
}

fn unavailable(e: impl std::fmt::Display) -> Error {
    Error::msg(format!(
        "This computer's keychain isn't available, so Kagimo can't keep a journal without a password here. ({e})"
    ))
}

impl Keys {
    pub fn save(&self, account: &str, secret: &[u8]) -> Result<()> {
        match self {
            Keys::System => keyring::Entry::new(SERVICE, account)
                .and_then(|e| e.set_secret(secret))
                .map_err(unavailable),
            Keys::Files(dir) => crate::config::write_private(&dir.join(format!("{account}.key")), secret),
        }
    }

    pub fn load(&self, account: &str) -> Result<Option<Vec<u8>>> {
        match self {
            Keys::System => match keyring::Entry::new(SERVICE, account).and_then(|e| e.get_secret()) {
                Ok(k) => Ok(Some(k)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(unavailable(e)),
            },
            Keys::Files(dir) => match std::fs::read(dir.join(format!("{account}.key"))) {
                Ok(k) => Ok(Some(k)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
        }
    }

    pub fn delete(&self, account: &str) -> Result<()> {
        match self {
            Keys::System => match keyring::Entry::new(SERVICE, account).and_then(|e| e.delete_credential()) {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(unavailable(e)),
            },
            Keys::Files(dir) => match std::fs::remove_file(dir.join(format!("{account}.key"))) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            },
        }
    }
}

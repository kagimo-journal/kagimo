//! Errors as the page sees them: a sentence it can show (the bridge rejects with it).

use std::fmt;
use std::io;

#[derive(Debug)]
pub enum Error {
    Msg(String),
    Io(io::Error),
}

impl Error {
    pub fn msg(s: impl Into<String>) -> Self {
        Error::Msg(s.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Msg(m) => f.write_str(m),
            // The system refusing access to the journal folder, said so the person can act on it.
            // On macOS that is usually privacy protection (Documents, Desktop, Downloads, other
            // drives), not the folder's own permissions.
            Error::Io(e) if e.kind() == io::ErrorKind::PermissionDenied => f.write_str(if cfg!(target_os = "macos") {
                "macOS didn't let Kagimo open this folder. Choose it again below, or allow Kagimo in System Settings → Privacy & Security → Files and Folders."
            } else {
                "Kagimo isn't allowed to open this folder. Check its permissions, or choose another."
            }),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Msg(e.to_string())
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

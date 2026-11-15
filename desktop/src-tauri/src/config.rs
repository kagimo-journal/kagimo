//! The app's own settings, kept with its data (never in the journal folder): which folder holds
//! the journal, and which sync server /api requests go to.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::error::Result;

pub const KAGIMO_SERVER: &str = "https://kagimo.com";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub folder: Option<PathBuf>,
    pub server: String,
}

impl Config {
    pub fn defaults(default_server: &str) -> Self {
        Config {
            folder: None,
            server: default_server.to_string(),
        }
    }

    /// The saved settings, or the defaults on a first run or when the file can't be read. Values that
    /// don't pass the checks a new choice would face are dropped.
    pub fn load(file: &Path, default_server: &str) -> Self {
        let mut c = Self::defaults(default_server);
        let Ok(raw) = fs::read(file) else { return c };
        let Ok(saved) = serde_json::from_slice::<serde_json::Value>(&raw) else {
            return c;
        };
        if let Some(f) = saved
            .get("folder")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        {
            c.folder = Some(f);
        }
        if let Some(s) = saved.get("server").and_then(|v| v.as_str()).and_then(server_origin) {
            c.server = s;
        }
        c
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        write_private(file, serde_json::to_string_pretty(self)?.as_bytes())
    }
}

/// Writes a file only this user can read, replacing any old one in one step.
pub fn write_private(file: &Path, data: &[u8]) -> Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    let tmp = file.with_extension("tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    std::io::Write::write_all(&mut opts.open(&tmp)?, data)?;
    fs::rename(&tmp, file)?;
    Ok(())
}

/// The origin of a sync server address, or None when it isn't one Kagimo will talk to: https, or
/// http on this computer; no user name or password in it.
pub fn server_origin(input: &str) -> Option<String> {
    let u = Url::parse(input.trim()).ok()?;
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(u.scheme() == "https" || (u.scheme() == "http" && local)) {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    Some(u.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_origin_accepts_https_and_local_http_only() {
        assert_eq!(
            server_origin(" https://kagimo.com/some/path?q=1 ").as_deref(),
            Some("https://kagimo.com")
        );
        assert_eq!(
            server_origin("https://sync.example.org:8443").as_deref(),
            Some("https://sync.example.org:8443")
        );
        assert_eq!(server_origin("http://localhost:18187").as_deref(), Some("http://localhost:18187"));
        assert_eq!(server_origin("http://127.0.0.1:8080/").as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(server_origin("http://[::1]:8080").as_deref(), Some("http://[::1]:8080"));
        for bad in [
            "http://kagimo.com",
            "ftp://kagimo.com",
            "https://me:pw@kagimo.com",
            "kagimo.com",
            "",
            "javascript:alert(1)",
        ] {
            assert_eq!(server_origin(bad), None, "{bad}");
        }
    }

    #[test]
    fn load_keeps_valid_settings_and_drops_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("config.json");
        assert_eq!(Config::load(&file, KAGIMO_SERVER), Config::defaults(KAGIMO_SERVER));

        let c = Config {
            folder: Some(tmp.path().join("journal")),
            server: "https://sync.example.org".into(),
        };
        c.save(&file).unwrap();
        assert_eq!(Config::load(&file, KAGIMO_SERVER), c);

        fs::write(&file, r#"{"folder":"relative/path","server":"http://evil.example"}"#).unwrap();
        assert_eq!(Config::load(&file, KAGIMO_SERVER), Config::defaults(KAGIMO_SERVER));
        fs::write(&file, "not json").unwrap();
        assert_eq!(Config::load(&file, KAGIMO_SERVER), Config::defaults(KAGIMO_SERVER));
    }
}

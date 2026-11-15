//! The journal folder: the files a journal is made of, and nothing about what they mean. The app's
//! storage logic (frontend/src/local/folderRepo.ts) reads and writes whole records through this;
//! everything it hands over is already encrypted.
//!
//! ```text
//! kagimo.json          the journal: its id and wrapped (encrypted) keys
//! settings.json        encrypted settings
//! outbox.json          deletions still to be sent to a sync server
//! entries/<id>.json    one entry: encrypted header and body, plus sync bookkeeping
//! blobs/<id>.json      one photo's record (photos come only from older synced journals)
//! blobs/<id>.bin       its ciphertext
//! ```
//!
//! Every write goes to a temporary file that is then renamed over the target, so a crash or a full
//! disk leaves the old file, never half of a new one.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::error::Error;

/// The journal's single files, by the name the page uses for them.
pub fn doc_file(name: &str) -> Option<&'static str> {
    match name {
        "vault" => Some("kagimo.json"),
        "settings" => Some("settings.json"),
        "outbox" => Some("outbox.json"),
        _ => None,
    }
}
const DOC_FILES: [&str; 3] = ["kagimo.json", "settings.json", "outbox.json"];

pub const COLLECTIONS: [&str; 2] = ["entries", "blobs"];

/// A temporary file this old belongs to a write that never finished.
const STALE_TMP: Duration = Duration::from_secs(60 * 60);

/// Ids are lowercase UUIDs; nothing else ever becomes part of a file name.
pub fn is_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
        })
}

pub fn is_collection(s: &str) -> bool {
    COLLECTIONS.contains(&s)
}

/// `<name>.<12 hex>.tmp`: returns `<name>`.
fn tmp_base(name: &str) -> Option<&str> {
    let rest = name.strip_suffix(".tmp")?;
    let (base, hex) = rest.rsplit_once('.')?;
    (hex.len() == 12 && hex.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).then_some(base)
}

fn read_or_none(file: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(file) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn remove(file: &Path) -> io::Result<()> {
    match fs::remove_file(file) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn write_atomic(file: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let suffix: [u8; 6] = rand::random();
    let hex: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = PathBuf::from(format!("{}.{hex}.tmp", file.display()));
    let result = (|| {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn parse(buf: &[u8], file: &Path) -> Result<Value, Error> {
    serde_json::from_slice(buf).map_err(|_| {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Error::msg(format!("{name} in the journal folder is damaged (not valid JSON)."))
    })
}

pub struct JournalFolder {
    pub dir: PathBuf,
}

impl JournalFolder {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn doc(&self, name: &str) -> Result<PathBuf, Error> {
        doc_file(name)
            .map(|f| self.dir.join(f))
            .ok_or_else(|| Error::msg("Unknown journal file"))
    }

    fn item(&self, coll: &str, id: &str, ext: &str) -> Result<PathBuf, Error> {
        if !is_collection(coll) {
            return Err(Error::msg("Unknown journal collection"));
        }
        if !is_id(id) {
            return Err(Error::msg("Invalid id"));
        }
        Ok(self.dir.join(coll).join(format!("{id}.{ext}")))
    }

    /// True when the folder holds a journal.
    pub fn has_journal(&self) -> Result<bool, Error> {
        Ok(read_or_none(&self.doc("vault")?)?.is_some())
    }

    /// True when the folder has anything in it besides hidden files.
    pub fn has_other_files(&self) -> Result<bool, Error> {
        for e in fs::read_dir(&self.dir)? {
            if !e?.file_name().to_string_lossy().starts_with('.') {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn read_doc(&self, name: &str) -> Result<Option<Value>, Error> {
        let file = self.doc(name)?;
        read_or_none(&file)?.map(|b| parse(&b, &file)).transpose()
    }

    /// Writes a document; None deletes it.
    pub fn write_doc(&self, name: &str, value: Option<&Value>) -> Result<(), Error> {
        let file = self.doc(name)?;
        match value {
            None => Ok(remove(&file)?),
            Some(v) => Ok(write_atomic(&file, serde_json::to_string_pretty(v)?.as_bytes())?),
        }
    }

    pub fn read(&self, coll: &str, id: &str) -> Result<Option<Value>, Error> {
        let file = self.item(coll, id, "json")?;
        read_or_none(&file)?.map(|b| parse(&b, &file)).transpose()
    }

    /// Writes a record; None deletes it.
    pub fn write(&self, coll: &str, id: &str, value: Option<&Value>) -> Result<(), Error> {
        let file = self.item(coll, id, "json")?;
        match value {
            None => Ok(remove(&file)?),
            Some(v) => Ok(write_atomic(&file, serde_json::to_string(v)?.as_bytes())?),
        }
    }

    /// Every record in a collection. Files that aren't records (another program's, a sync tool's
    /// conflict copies) are ignored, and so is a record that can't be parsed: one damaged file
    /// shouldn't keep the rest of the journal shut.
    pub fn list(&self, coll: &str) -> Result<Vec<Value>, Error> {
        if !is_collection(coll) {
            return Err(Error::msg("Unknown journal collection"));
        }
        let entries = match fs::read_dir(self.dir.join(coll)) {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.into()),
        };
        let mut out = vec![];
        for e in entries {
            let name = e?.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json").filter(|id| is_id(id)) else {
                continue;
            };
            match self.read(coll, id) {
                Ok(Some(v)) => out.push(v),
                Ok(None) => {}
                Err(err) => eprintln!("Skipping {coll}/{name}: {err}"),
            }
        }
        Ok(out)
    }

    pub fn read_bytes(&self, id: &str) -> Result<Option<Vec<u8>>, Error> {
        Ok(read_or_none(&self.item("blobs", id, "bin")?)?)
    }

    /// Writes a photo's ciphertext; None deletes it.
    pub fn write_bytes(&self, id: &str, bytes: Option<&[u8]>) -> Result<(), Error> {
        let file = self.item("blobs", id, "bin")?;
        match bytes {
            None => Ok(remove(&file)?),
            Some(b) => Ok(write_atomic(&file, b)?),
        }
    }

    /// Deletes the journal from the folder: only the files listed at the top of this file. Anything
    /// else in the folder is left alone, and the folder itself stays.
    pub fn wipe(&self) -> Result<(), Error> {
        // The journal record goes first: without it the folder no longer holds a journal, whatever
        // else is still to be deleted.
        for f in DOC_FILES {
            remove(&self.dir.join(f))?;
        }
        for coll in COLLECTIONS {
            let dir = self.dir.join(coll);
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            for e in entries {
                let name = e?.file_name().to_string_lossy().into_owned();
                let ours = match name.split_once('.') {
                    Some((id, rest)) => is_id(id) && (rest == "json" || rest == "bin" || tmp_base(&name).is_some()),
                    None => false,
                };
                if ours {
                    remove(&dir.join(&name))?;
                }
            }
            let _ = fs::remove_dir(&dir); // stays if something else is in it
        }
        Ok(())
    }

    /// Deletes temporary files left by writes that never finished (a crash, a pulled drive).
    pub fn sweep(&self, now: SystemTime) {
        let mut dirs = vec![self.dir.clone()];
        dirs.extend(COLLECTIONS.iter().map(|c| self.dir.join(c)));
        for (i, dir) in dirs.iter().enumerate() {
            let Ok(entries) = fs::read_dir(dir) else { continue };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(base) = tmp_base(&name) else { continue };
                let ours = if i == 0 {
                    DOC_FILES.contains(&base)
                } else {
                    base.split_once('.')
                        .is_some_and(|(id, ext)| is_id(id) && (ext == "json" || ext == "bin"))
                };
                if !ours {
                    continue;
                }
                let old = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .is_ok_and(|t| now.duration_since(t).unwrap_or_default() > STALE_TMP);
                if old {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "3f2b6c1e-9d4a-4e8b-a1c7-5b0e2f9d8a61";
    const ID2: &str = "7a1d0c55-2b3e-4f60-9c8d-1e2f3a4b5c6d";

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn keeps_documents_and_records_as_the_files_the_layout_names() {
        let tmp = tempfile::tempdir().unwrap();
        let f = JournalFolder::new(tmp.path());
        assert!(!f.has_journal().unwrap());
        f.write_doc("vault", Some(&json!({"format": "kagimo-journal"}))).unwrap();
        f.write("entries", ID, Some(&json!({"id": ID, "header": {"nonce": "n", "ct": "c"}})))
            .unwrap();
        f.write_bytes(ID2, Some(&[1, 2, 3])).unwrap();
        assert!(f.has_journal().unwrap());
        let vault: Value = serde_json::from_slice(&fs::read(tmp.path().join("kagimo.json")).unwrap()).unwrap();
        assert_eq!(vault, json!({"format": "kagimo-journal"}));
        assert_eq!(
            f.read("entries", ID).unwrap(),
            Some(json!({"id": ID, "header": {"nonce": "n", "ct": "c"}}))
        );
        assert_eq!(f.read_bytes(ID2).unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(names(&tmp.path().join("entries")), vec![format!("{ID}.json")]);
        assert_eq!(names(&tmp.path().join("blobs")), vec![format!("{ID2}.bin")]);
    }

    #[test]
    fn reads_what_is_missing_as_none_and_deletes_with_none() {
        let tmp = tempfile::tempdir().unwrap();
        let f = JournalFolder::new(tmp.path());
        assert_eq!(f.read_doc("settings").unwrap(), None);
        assert_eq!(f.read("entries", ID).unwrap(), None);
        assert_eq!(f.read_bytes(ID).unwrap(), None);
        assert!(f.list("entries").unwrap().is_empty());
        f.write("entries", ID, Some(&json!({"id": ID}))).unwrap();
        f.write("entries", ID, None).unwrap();
        f.write_doc("outbox", Some(&json!([{"kind": "entry", "id": ID}]))).unwrap();
        f.write_doc("outbox", None).unwrap();
        f.write_bytes(ID, None).unwrap(); // deleting what isn't there is fine
        assert_eq!(f.read("entries", ID).unwrap(), None);
        assert_eq!(f.read_doc("outbox").unwrap(), None);
    }

    #[test]
    fn refuses_names_that_are_not_part_of_the_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let f = JournalFolder::new(tmp.path());
        assert!(f.read_doc("../secret").is_err());
        assert!(f.read("entries", "../../etc/passwd").is_err());
        assert!(f.read("entries", &ID.to_uppercase()).is_err());
        assert!(f.read("other", ID).is_err());
        assert!(f.write_bytes("x", Some(&[1])).is_err());
    }

    #[test]
    fn lists_records_skipping_other_files_and_damaged_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let f = JournalFolder::new(tmp.path());
        f.write("entries", ID, Some(&json!({"id": ID}))).unwrap();
        let entries = tmp.path().join("entries");
        fs::write(entries.join(format!("{ID2}.json")), "{not json").unwrap();
        fs::write(entries.join("notes.txt"), "mine").unwrap();
        fs::write(entries.join(format!("{ID} (conflict).json")), "{}").unwrap();
        assert_eq!(f.list("entries").unwrap(), vec![json!({"id": ID})]);
        assert!(f.read("entries", ID2).unwrap_err().to_string().contains("damaged"));
    }

    #[test]
    fn wipe_removes_only_the_journal() {
        let tmp = tempfile::tempdir().unwrap();
        let f = JournalFolder::new(tmp.path());
        f.write_doc("vault", Some(&json!({}))).unwrap();
        f.write_doc("settings", Some(&json!({}))).unwrap();
        f.write("entries", ID, Some(&json!({}))).unwrap();
        f.write_bytes(ID2, Some(&[9])).unwrap();
        fs::write(tmp.path().join("diary.txt"), "mine").unwrap();
        fs::write(tmp.path().join("blobs").join("keep.png"), "mine").unwrap();
        f.wipe().unwrap();
        assert!(!f.has_journal().unwrap());
        assert_eq!(names(tmp.path()), vec!["blobs", "diary.txt"]);
        assert_eq!(names(&tmp.path().join("blobs")), vec!["keep.png"]);
    }

    #[test]
    fn sweep_deletes_only_stale_temporary_files_of_its_own() {
        let tmp = tempfile::tempdir().unwrap();
        let f = JournalFolder::new(tmp.path());
        fs::create_dir(tmp.path().join("entries")).unwrap();
        let ours = tmp.path().join("kagimo.json.0123456789ab.tmp");
        let ours_entry = tmp.path().join("entries").join(format!("{ID}.json.abcdef012345.tmp"));
        let theirs = tmp.path().join("report.doc.0123456789ab.tmp");
        for p in [&ours, &ours_entry, &theirs] {
            fs::write(p, "x").unwrap();
        }
        f.sweep(SystemTime::now()); // too new to be abandoned
        assert!(ours.exists() && ours_entry.exists());
        f.sweep(SystemTime::now() + STALE_TMP + Duration::from_secs(60));
        assert!(!ours.exists() && !ours_entry.exists());
        assert!(theirs.exists());
    }

    #[test]
    fn writes_leave_no_temporary_files() {
        let tmp = tempfile::tempdir().unwrap();
        let f = JournalFolder::new(tmp.path());
        f.write_doc("vault", Some(&json!({"a": 1}))).unwrap();
        f.write_doc("vault", Some(&json!({"a": 2}))).unwrap();
        assert_eq!(names(tmp.path()), vec!["kagimo.json"]);
        assert_eq!(f.read_doc("vault").unwrap(), Some(json!({"a": 2})));
    }
}

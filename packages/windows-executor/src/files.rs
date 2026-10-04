use crate::Limits;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) fn strict_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Execution paths must be absolute local paths.".into());
    }
    let text = path.to_string_lossy().to_lowercase();
    if text.starts_with("\\\\") && !text.starts_with("\\\\?\\")
        || text.starts_with("\\\\?\\unc\\")
        || text.starts_with("\\\\.\\")
    {
        return Err("Execution paths cannot use network or device namespaces.".into());
    }
    let mut prefix = PathBuf::new();
    for part in path.components() {
        if matches!(part, std::path::Component::ParentDir) {
            return Err("Execution paths cannot traverse parents.".into());
        }
        prefix.push(part.as_os_str());
        if matches!(part, std::path::Component::Prefix(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&prefix)
            .map_err(|_| "Execution path is missing or inaccessible.")?;
        if metadata.file_type().is_symlink() {
            return Err("Execution paths cannot contain links.".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Execution paths cannot contain reparse points.".into());
            }
        }
    }
    fs::canonicalize(path).map_err(|_| "Execution path cannot be resolved.".into())
}
pub(crate) fn regular_file(file: &File) -> Result<(), String> {
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect execution file.")?
        .is_file()
    {
        return Err("Execution inputs must be regular files.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
            || info.dwFileAttributes & 0x400 != 0
            || info.nNumberOfLinks != 1
        {
            return Err("Execution files cannot be reparse points or hard links.".into());
        }
    }
    Ok(())
}
pub(crate) fn read(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    strict_path(path)?;
    #[cfg(windows)]
    let file = crate::security::locked_file(path)?;
    #[cfg(not(windows))]
    let file = File::open(path).map_err(|_| "Cannot read execution file.")?;
    regular_file(&file)?;
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read execution file.")?;
    if bytes.len() as u64 > max {
        return Err("Execution file exceeds its size limit.".into());
    }
    Ok(bytes)
}
fn relative(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or("Execution filenames must be Unicode.")?
        .replace('\\', "/");
    if text.len() > 1024
        || text.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || p.contains(['<', '>', ':', '"', '|', '?', '*'])
                || p.ends_with([' ', '.'])
                || p.chars().any(char::is_control)
                || reserved_name(p)
        })
    {
        return Err("Unsupported execution filename.".into());
    }
    Ok(text)
}
fn reserved_name(name: &str) -> bool {
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        base.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}
#[cfg(test)]
fn scan(root: &Path, limits: Limits) -> Result<BTreeMap<String, u64>, String> {
    scan_current(root, limits, &|| true)
}
fn scan_current(
    root: &Path,
    limits: Limits,
    current: &dyn Fn() -> bool,
) -> Result<BTreeMap<String, u64>, String> {
    strict_path(root)?;
    let mut files = BTreeMap::new();
    let mut stack = vec![root.to_owned()];
    let mut total = 0u64;
    let mut entries = 0usize;
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).map_err(|_| "Cannot inspect execution directory.")? {
            if !current() {
                return Err("Native execution stopped while inspecting input files.".into());
            }
            let entry = entry.map_err(|_| "Cannot inspect execution directory.")?;
            let path = entry.path();
            strict_path(&path)?;
            entries += 1;
            if entries > limits.file_count {
                return Err("Execution exceeded its file count limit.".into());
            }
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "Cannot inspect execution entry.")?;
            let name = relative(
                path.strip_prefix(root)
                    .map_err(|_| "Execution path escaped its root.")?,
            )?;
            if name.split('/').any(|p| p.eq_ignore_ascii_case(".git")) {
                return Err("Git custody files cannot enter an execution snapshot.".into());
            }
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file() {
                if metadata.len() > limits.file_bytes {
                    return Err("Execution exceeded its per-file limit.".into());
                }
                total = total
                    .checked_add(metadata.len())
                    .ok_or("Execution size overflow.")?;
                if total > limits.tree_bytes {
                    return Err("Execution exceeded its storage limit.".into());
                }
                #[cfg(windows)]
                {
                    crate::security::locked_file(&path)?;
                }
                files.insert(name, metadata.len());
            } else {
                return Err("Execution snapshots contain unsupported entries.".into());
            }
        }
    }
    Ok(files)
}
pub(crate) fn copy_tree_current(
    source: &Path,
    destination: &Path,
    limits: Limits,
    current: &dyn Fn() -> bool,
) -> Result<String, String> {
    let entries = scan_current(source, limits, current)?;
    let mut digest = Sha256::new();
    for (path, size) in entries {
        if !current() {
            return Err("Native execution stopped while staging input files.".into());
        }
        let bytes = read(&source.join(&path), limits.file_bytes)?;
        if bytes.len() as u64 != size {
            return Err("Execution input changed while being staged.".into());
        }
        let target = destination.join(&path);
        fs::create_dir_all(target.parent().ok_or("Invalid execution file.")?)
            .map_err(|_| "Cannot prepare execution files.")?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|_| "Execution input has an alias collision.")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot stage execution files.")?;
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
        digest.update(Sha256::digest(&bytes));
    }
    Ok(hex::encode(digest.finalize()))
}
pub(crate) fn tree_id(root: &Path, limits: Limits) -> Result<String, String> {
    tree_id_current(root, limits, &|| true)
}
pub(crate) fn tree_id_current(
    root: &Path,
    limits: Limits,
    current: &dyn Fn() -> bool,
) -> Result<String, String> {
    let entries = scan_current(root, limits, current)?;
    let mut digest = Sha256::new();
    for (path, _) in entries {
        if !current() {
            return Err("Native execution stopped while verifying command files.".into());
        }
        digest.update((path.len() as u64).to_le_bytes());
        digest.update(path.as_bytes());
        digest.update(Sha256::digest(read(&root.join(path), limits.file_bytes)?));
    }
    Ok(hex::encode(digest.finalize()))
}
pub(crate) struct PreparedTree {
    staged: tempfile::TempDir,
    backup: tempfile::TempDir,
    destination: PathBuf,
    pub(crate) digest: String,
}
pub(crate) fn prepare_tree(
    source: &Path,
    destination: &Path,
    limits: Limits,
    current: &dyn Fn() -> bool,
) -> Result<PreparedTree, String> {
    strict_path(destination)?;
    let parent = destination
        .parent()
        .ok_or("Invalid managed repository path.")?;
    let staged = tempfile::Builder::new()
        .prefix("native-import-")
        .tempdir_in(parent)
        .map_err(|_| "Cannot stage reviewed command changes.")?;
    let digest = copy_tree_current(source, staged.path(), limits, current)?;
    let backup = tempfile::Builder::new()
        .prefix("native-previous-")
        .tempdir_in(parent)
        .map_err(|_| "Cannot preserve managed repository during import.")?;
    Ok(PreparedTree {
        staged,
        backup,
        destination: destination.to_owned(),
        digest,
    })
}
impl PreparedTree {
    pub(crate) fn commit(self) -> Result<tempfile::TempDir, String> {
        strict_path(&self.destination)?;
        let previous = self.backup.path().join("checkout");
        fs::rename(&self.destination, &previous)
            .map_err(|_| "Cannot preserve managed checkout; no command files imported.")?;
        if fs::rename(self.staged.path(), &self.destination).is_err() {
            if fs::rename(&previous, &self.destination).is_err() {
                let path = self.backup.keep();
                return Err(format!("Managed checkout import needs recovery. Previous files retained at {}. Do not replay.",path.display()));
            }
            return Err("Cannot import command files; previous checkout restored.".into());
        }
        // Return old-tree custody so its potentially large deletion happens
        // after the caller releases the authority lock.
        Ok(self.backup)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_aliases_and_cancelled_staging_fail_closed() {
        for name in [
            "NUL.txt",
            "con",
            "LPT¹.csv",
            "COM9/file",
            "x/CON .txt",
            "x/stream:secret",
            "x/../file",
            "x/trailing.",
            "x/file?",
        ] {
            assert!(relative(Path::new(name)).is_err(), "accepted {name}");
        }
        assert!(relative(Path::new("data/complex.csv")).is_ok());
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        fs::write(source.path().join("data"), "kept").unwrap();
        assert!(
            copy_tree_current(source.path(), destination.path(), Limits::ANALYSIS, &|| {
                false
            })
            .is_err()
        );
        assert_eq!(fs::read_dir(destination.path()).unwrap().count(), 0);
        assert_eq!(
            fs::read_to_string(source.path().join("data")).unwrap(),
            "kept"
        );
    }
    #[test]
    fn snapshots_preserve_originals_and_fail_closed_on_size() {
        let source = tempfile::tempdir().unwrap();
        let staged = tempfile::tempdir().unwrap();
        fs::write(source.path().join("data.csv"), "value\n15\n").unwrap();
        let id =
            copy_tree_current(source.path(), staged.path(), Limits::ANALYSIS, &|| true).unwrap();
        assert_eq!(id, tree_id(staged.path(), Limits::ANALYSIS).unwrap());
        fs::write(staged.path().join("data.csv"), "modified").unwrap();
        assert_eq!(
            fs::read_to_string(source.path().join("data.csv")).unwrap(),
            "value\n15\n"
        );
        assert!(scan(
            source.path(),
            Limits {
                file_bytes: 2,
                ..Limits::ANALYSIS
            }
        )
        .is_err());
        let destination = tempfile::tempdir().unwrap();
        fs::write(destination.path().join("previous"), "preserved").unwrap();
        assert!(
            prepare_tree(source.path(), destination.path(), Limits::ANALYSIS, &|| {
                false
            })
            .is_err()
        );
        let prepared = prepare_tree(source.path(), destination.path(), Limits::ANALYSIS, &|| {
            true
        })
        .unwrap();
        assert_eq!(
            fs::read_to_string(destination.path().join("previous")).unwrap(),
            "preserved"
        );
        assert!(!destination.path().join("data.csv").exists());
        prepared.commit().unwrap();
        assert_eq!(
            fs::read_to_string(destination.path().join("data.csv")).unwrap(),
            "value\n15\n"
        );
    }
    #[test]
    fn git_metadata_and_links_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        assert!(scan(root.path(), Limits::ANALYSIS).is_err());
        fs::remove_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join("x"), "x").unwrap();
        fs::hard_link(root.path().join("x"), root.path().join("alias")).unwrap();
        #[cfg(windows)]
        assert!(scan(root.path(), Limits::ANALYSIS).is_err());
    }
}

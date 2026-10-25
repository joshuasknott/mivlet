//! Secure filesystem custody for artifact bytes.

use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use super::validation::{MAX_BYTES, MAX_PUBLICATIONS};

pub(crate) fn canonical(path: &Path) -> Result<PathBuf, String> {
    crate::paths::strict_canonicalize(path)
        .map_err(|_| "The artifact path is unavailable or contains a link.".into())
}

// Validate the actual opened handle before reading. Rechecking path names alone
// would allow a guest to swap a parent directory after canonicalization.
#[cfg(windows)]
pub(crate) fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("The artifact file handle could not be verified.".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    )))
}

#[cfg(target_os = "linux")]
pub(crate) fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| "The artifact file handle could not be verified.".into())
}

#[cfg(not(any(windows, target_os = "linux")))]
pub(crate) fn opened_path(_file: &File) -> Result<PathBuf, String> {
    Err("Secure artifact delivery is not supported on this operating system yet.".into())
}

pub(crate) fn read_bounded(root: &Path, path: &Path) -> Result<Vec<u8>, String> {
    read_bounded_limit(root, path, MAX_BYTES)
}

pub(crate) fn read_bounded_limit(root: &Path, path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let limit = limit.min(MAX_BYTES);
    let root = canonical(root)?;
    let source = canonical(path)?;
    if !source.starts_with(&root) {
        return Err("The artifact must remain inside its computer workspace.".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(0)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options.open(&source).map_err(|_| {
        "The artifact is unavailable or is still being written. Save it and try again."
    })?;
    if !opened_path(&file)?.starts_with(&root) || canonical(&source)? != source {
        return Err("The artifact path changed while opening it.".into());
    }
    let metadata = file
        .metadata()
        .map_err(|_| "The artifact metadata is unavailable.")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("Choose a regular file within the operation's byte limit.".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The artifact could not be read.")?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > limit {
        return Err("The file changed while publishing. Save it and try again.".into());
    }
    Ok(bytes)
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn title_for(title: Option<&str>, relative: &str) -> Result<String, String> {
    let value = title
        .unwrap_or_else(|| relative.rsplit('/').next().unwrap_or(relative))
        .trim();
    if value.is_empty()
        || value.len() > 160
        || value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err("Use an artifact title of 1–160 characters without control characters.".into());
    }
    Ok(value.to_string())
}

pub(crate) fn write_copy(
    directory: &Path,
    id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    fs::create_dir_all(directory).map_err(|_| "Mivlet could not create its artifact folder.")?;
    crate::paths::ensure_private_dir(directory)?;
    let directory = canonical(directory)?;
    if fs::read_dir(&directory)
        .map_err(|_| "The artifact folder is unavailable.")?
        .take(MAX_PUBLICATIONS + 1)
        .count()
        >= MAX_PUBLICATIONS
    {
        return Err("This computer's artifact folder is full. Remove old local artifacts before publishing more.".into());
    }
    let target = directory.join(id);
    fs::create_dir(&target).map_err(|_| "Mivlet could not reserve an artifact file.")?;
    if let Err(error) = crate::paths::ensure_private_dir(&target) {
        let _ = fs::remove_dir(&target);
        return Err(error);
    }
    let file_path = target.join(name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .map_err(|_| "Mivlet could not create the artifact copy.")?;
        crate::paths::ensure_private_file(&file_path)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Mivlet could not save the artifact copy.")?;
        Ok(file_path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&file_path);
        let _ = fs::remove_dir(&target);
    }
    result
}

//! Bounded inspection and deletion without traversing reparse points. Windows
//! directory handles exclude rename/delete while their children are inspected.
use super::*;

pub(super) fn pin(path: &Path, writable_attributes: bool) -> Result<fs::File, String> {
    crate::paths::strict_canonicalize(path)
        .map_err(|_| "Copy path contains a link or reparse point.")?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
        };
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        if writable_attributes {
            options.access_mode(0x80000000 | FILE_WRITE_ATTRIBUTES);
        }
    }
    #[cfg(not(windows))]
    let _ = writable_attributes;
    let file = options
        .open(path)
        .map_err(|_| "Copy file is locked or unreadable; retain it.")?;
    let metadata = file
        .metadata()
        .map_err(|_| "Copy file metadata is unavailable.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if crate::paths::is_windows_reparse_point(metadata.file_attributes()) {
            return Err("A reparse point protects this copy.".into());
        }
    }
    if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
        return Err("A link or special file protects this copy.".into());
    }
    Ok(file)
}

struct Scan<'a> {
    ticket: &'a OperationTicket,
    hash_contents: bool,
    entries: usize,
    bytes: u64,
    digest: Sha256,
}
impl Scan<'_> {
    fn visit(&mut self, path: &Path, relative: &Path, depth: usize) -> Result<(), String> {
        self.ticket.check()?;
        self.entries += 1;
        if self.entries > MAX_ENTRIES || depth > 128 {
            return Err("Copy exceeds the entry/depth inspection limit; retain it.".into());
        }
        let mut file = pin(path, false)?;
        let metadata = file
            .metadata()
            .map_err(|_| "Copy metadata is unreadable.")?;
        self.digest.update(relative.to_string_lossy().as_bytes());
        self.digest.update([0]);
        if metadata.is_dir() {
            self.digest.update(b"directory\0");
            let mut children: Vec<_> = fs::read_dir(path)
                .map_err(|_| "Copy directory is unreadable.")?
                .take(MAX_ENTRIES - self.entries + 1)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "Copy directory is unreadable.")?;
            if children.len() > MAX_ENTRIES - self.entries {
                return Err("Copy exceeds the entry/depth inspection limit; retain it.".into());
            }
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                self.visit(&child.path(), &relative.join(child.file_name()), depth + 1)?;
            }
        } else {
            self.bytes = self
                .bytes
                .checked_add(metadata.len())
                .ok_or("Copy byte count overflowed.")?;
            if self.hash_contents && self.bytes > 2 * 1024 * 1024 * 1024 {
                return Err(
                    "Copy exceeds the 2 GiB exact cleanup inspection limit; retain it.".into(),
                );
            }
            self.digest.update(b"file\0");
            self.digest.update(metadata.len().to_le_bytes());
            if self.hash_contents {
                let mut buffer = [0u8; 64 * 1024];
                let mut bytes = 0u64;
                loop {
                    self.ticket.check()?;
                    let read = file
                        .read(&mut buffer)
                        .map_err(|_| "Copy file is unreadable.")?;
                    if read == 0 {
                        break;
                    }
                    bytes += read as u64;
                    if bytes > metadata.len() {
                        return Err("Copy changed during inspection. Review again.".into());
                    }
                    self.digest.update(&buffer[..read]);
                }
                if bytes != metadata.len() {
                    return Err("Copy changed during inspection. Review again.".into());
                }
            }
        }
        Ok(())
    }
}
pub(super) fn scan_tree(
    root: &Path,
    ticket: &OperationTicket,
    hash_contents: bool,
) -> Result<(u64, String), String> {
    let mut scan = Scan {
        ticket,
        hash_contents,
        entries: 0,
        bytes: 0,
        digest: Sha256::new(),
    };
    scan.visit(root, Path::new(""), 0)?;
    Ok((scan.bytes, hex::encode(scan.digest.finalize())))
}

pub(super) fn remove_tree(root: &Path, ticket: &OperationTicket) -> Result<(), String> {
    remove(root, ticket, 0)
}
fn remove(path: &Path, ticket: &OperationTicket, depth: usize) -> Result<(), String> {
    ticket.check()?;
    if depth > 128 {
        return Err("Cleanup exceeds its depth limit; retain it.".into());
    }
    let file = pin(path, true)?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cleanup metadata is unreadable.")?;
    if metadata.is_dir() {
        for child in fs::read_dir(path).map_err(|_| "Cleanup directory is unreadable.")? {
            remove(
                &child
                    .map_err(|_| "Cleanup directory is unreadable.")?
                    .path(),
                ticket,
                depth + 1,
            )?;
        }
        drop(file); // Parent stays pinned; removing a substituted leaf link never follows it.
        fs::remove_dir(path)
            .map_err(|_| "Cleanup interrupted; inspect and retry retained cleanup.".into())
    } else {
        #[cfg(windows)]
        if metadata.permissions().readonly() {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            file.set_permissions(permissions)
                .map_err(|_| "Cleanup could not release a readonly file.")?;
        }
        drop(file);
        fs::remove_file(path)
            .map_err(|_| "Cleanup interrupted; inspect and retry retained cleanup.".into())
    }
}

//! Short cross-process fences and lifetime leases for the native owner/client.
//! Paths are native-owned metadata outside the agent's writable workspace.
use std::{
    fs::{File, OpenOptions, TryLockError},
    path::Path,
    time::{Duration, Instant},
};

pub(crate) fn acquire(path: &Path, wait: Duration) -> Result<File, String> {
    acquire_mode(path, wait, false)
}
pub(crate) fn acquire_shared(path: &Path, wait: Duration) -> Result<File, String> {
    acquire_mode(path, wait, true)
}
fn acquire_mode(path: &Path, wait: Duration, shared: bool) -> Result<File, String> {
    let parent = path.parent().ok_or("Invalid native lease path.")?;
    crate::paths::strict_canonicalize(parent)
        .map_err(|_| "Native lease directory failed validation.")?;
    if path.exists() {
        crate::paths::strict_canonicalize(path)
            .map_err(|_| "Native lease path failed validation.")?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Keep the inode/path stable while any process holds this handle.
        options.share_mode(
            windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
        );
    }
    let file = options
        .open(path)
        .map_err(|_| "Native lease is unavailable.")?;
    let started = Instant::now();
    loop {
        match if shared {
            file.try_lock_shared()
        } else {
            file.try_lock()
        } {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if started.elapsed() < wait => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(TryLockError::WouldBlock) => {
                return Err(
                    "Another native operation owns this resource. Wait or Stop it before retrying."
                        .into(),
                );
            }
            Err(TryLockError::Error(_)) => return Err("Native lease could not be checked.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_handles_cannot_claim_a_live_lease() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("owner.lock");
        let first = acquire(&path, Duration::ZERO).unwrap();
        assert!(acquire(&path, Duration::ZERO).is_err());
        drop(first);
        assert!(acquire(&path, Duration::ZERO).is_ok());
    }
    #[test]
    fn foreground_observers_share_a_lease_but_handoff_waits() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("handoff.lock");
        let execution = acquire_shared(&path, Duration::ZERO).unwrap();
        let stop_view = acquire_shared(&path, Duration::ZERO).unwrap();
        assert!(acquire(&path, Duration::ZERO).is_err());
        drop(execution);
        drop(stop_view);
        assert!(acquire(&path, Duration::ZERO).is_ok());
    }
}

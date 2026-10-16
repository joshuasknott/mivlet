use super::*;
use std::fs::File;

pub(super) fn fence(path: &Path) -> Result<File, String> {
    super::super::leases::acquire(&path.with_extension("lock"), Duration::from_millis(150))
}

pub(super) fn read(path: &Path) -> Result<Durable, String> {
    let saved: Durable = serde_json::from_slice(&read_state(path)?).map_err(|_| STALE)?;
    if saved.version != 1
        || saved.generation == 0
        || saved.generation > MAX_GENERATION
        || saved.next_operation > MAX_GENERATION
    {
        return Err(STALE.into());
    }
    Ok(saved)
}

pub(super) struct Lease {
    file: Option<File>,
    path: PathBuf,
}
impl Drop for Lease {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

fn directory(path: &Path) -> Result<PathBuf, String> {
    let directory = path.parent().ok_or(STALE)?.join("native-operations");
    std::fs::create_dir_all(&directory).map_err(|_| STALE)?;
    crate::paths::strict_canonicalize(&directory).map_err(|_| STALE.into())
}

pub(super) fn operation(path: &Path, generation: u64, id: u64) -> Result<Lease, String> {
    let directory = directory(path)?;
    let count = std::fs::read_dir(&directory)
        .map_err(|_| STALE)?
        .take(257)
        .count();
    if count >= 256 {
        return Err("Native operation limit reached; stop current work first.".into());
    }
    let path = directory.join(format!("{generation}-{id}.lock"));
    let file = super::super::leases::acquire(&path, Duration::ZERO)?;
    Ok(Lease {
        file: Some(file),
        path,
    })
}

/// Called under the short authority fence. A live lease in either process
/// prevents the next generation from claiming that old operations have drained.
pub(super) fn live_before(path: &Path, generation: u64) -> Result<bool, String> {
    let mut active = false;
    for (index, entry) in std::fs::read_dir(directory(path)?)
        .map_err(|_| STALE)?
        .enumerate()
    {
        if index >= 256 {
            return Err("Native operation leases need recovery.".into());
        }
        let entry = entry.map_err(|_| STALE)?;
        let name = entry.file_name().into_string().map_err(|_| STALE)?;
        let (saved_generation, operation) = name
            .strip_suffix(".lock")
            .and_then(|s| s.split_once('-'))
            .ok_or(STALE)?;
        let saved_generation = saved_generation.parse::<u64>().map_err(|_| STALE)?;
        if saved_generation == 0 || operation.parse::<u64>().ok().filter(|id| *id > 0).is_none() {
            return Err(STALE.into());
        }
        if saved_generation >= generation {
            continue;
        }
        match super::super::leases::acquire(&entry.path(), Duration::ZERO) {
            Ok(lease) => {
                drop(lease);
                let _ = std::fs::remove_file(entry.path());
            }
            Err(_) => active = true,
        }
    }
    Ok(active)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[test]
    fn remote_ticket_fixture() {
        let Some(root) = std::env::var_os("MIVLET_BACKGROUND_AUTHORITY_TEST_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let owner = ComputerAuthority::load_mode(
            &root,
            Arc::new(AtomicU8::new(crate::local_computer::plugins::COMPUTER)),
            true,
        )
        .unwrap();
        let _ticket = owner
            .begin_agent(owner.snapshot().unwrap().generation)
            .unwrap();
        std::fs::write(root.join("ready"), b"owned").unwrap();
        // The parent verifies drain against an actual foreign handle, then
        // kills only this test child to exercise abrupt lease release.
        loop {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    #[test]
    fn foreign_process_death_releases_drain_without_reusing_a_generation() {
        let root = tempfile::tempdir().unwrap();
        let owner = ComputerAuthority::load(root.path()).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "local_computer::authority::shared::tests::remote_ticket_fixture",
            ])
            .env_clear()
            .env("MIVLET_BACKGROUND_AUTHORITY_TEST_ROOT", root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000);
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = OwnedChild(command.spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(30);
        while !root.path().join("ready").is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Fixture exited before admission"
            );
            assert!(
                Instant::now() < deadline,
                "Fixture never held its native lease"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let generation = owner.revoke(1).unwrap();
        assert!(owner.drain(generation, Duration::from_millis(20)).is_err());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        owner.drain(generation, Duration::from_secs(2)).unwrap();
        assert_eq!(owner.snapshot().unwrap().generation, 2);
        assert!(owner.begin_agent(1).is_err());
        assert!(owner.begin_agent(2).is_ok());
    }
}

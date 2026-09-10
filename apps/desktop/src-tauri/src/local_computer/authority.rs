//! Durable scope generations and cancellable single-operation tickets. Desktop
//! permission is separate, transient native state and is never loaded from disk.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
const MAX_GENERATION: u64 = 9_007_199_254_740_991;
const STALE: &str =
    "Computer authority changed. Refresh before continuing; the previous result was discarded.";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Durable {
    version: u8,
    generation: u64,
    retired_docker: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct AuthoritySnapshot {
    pub generation: u64,
    pub transitioning: bool,
    pub retired_docker: bool,
}
struct Inner {
    durable: Durable,
    draining: bool,
    next: u64,
    operations: HashMap<u64, Arc<AtomicBool>>,
}
pub(crate) struct ComputerAuthority {
    plugins: Arc<AtomicU8>,
    path: PathBuf,
    inner: Mutex<Inner>,
    drained: Condvar,
}
pub(crate) struct OperationTicket {
    authority: Arc<ComputerAuthority>,
    id: u64,
    pub generation: u64,
    cancellation: Arc<AtomicBool>,
}

impl ComputerAuthority {
    pub(super) fn load_with_plugins(
        directory: &Path,
        plugins: Arc<AtomicU8>,
    ) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(directory)
            .map_err(|_| "Computer authority storage is unavailable.")?;
        crate::paths::strict_canonicalize(directory)
            .map_err(|_| "Computer authority storage failed its security check.")?;
        let path = directory.join("native-control.json");
        let legacy = directory.join("control.json");
        let durable = if path.exists() {
            let saved: Durable = serde_json::from_slice(&read_state(&path)?)
                .map_err(|_| "Computer authority needs recovery.")?;
            if saved.version != 1 || saved.generation == 0 {
                return Err("Computer authority is unsupported.".into());
            }
            Durable {
                version: 1,
                generation: next_generation(saved.generation)?,
                retired_docker: saved.retired_docker,
            }
        } else if legacy.exists() {
            // Read only compatible identity metadata. Keep the complete legacy
            // state and all workspace files/volumes unchanged for manual recovery.
            let old: serde_json::Value = serde_json::from_slice(&read_state(&legacy)?)
                .map_err(|_| "The saved computer needs recovery.")?;
            if old["version"].as_u64() != Some(1) {
                return Err("The saved computer version is unsupported.".into());
            }
            let generation = old["generation"]
                .as_u64()
                .filter(|v| *v > 0)
                .ok_or("The saved computer generation is invalid.")?;
            Durable {
                version: 1,
                generation: next_generation(generation)?,
                retired_docker: true,
            }
        } else {
            Durable {
                version: 1,
                generation: 1,
                retired_docker: false,
            }
        };
        persist(&path, &durable)?;
        Ok(Arc::new(Self {
            plugins,
            path,
            inner: Mutex::new(Inner {
                durable,
                draining: false,
                next: 0,
                operations: HashMap::new(),
            }),
            drained: Condvar::new(),
        }))
    }
    #[cfg(test)]
    pub(super) fn load(directory: &Path) -> Result<Arc<Self>, String> {
        Self::load_with_plugins(directory, Arc::new(AtomicU8::new(super::plugins::COMPUTER)))
    }
    pub(crate) fn snapshot(&self) -> Result<AuthoritySnapshot, String> {
        let inner = self.inner.lock().map_err(|_| STALE)?;
        Ok(AuthoritySnapshot {
            generation: inner.durable.generation,
            transitioning: inner.draining,
            retired_docker: inner.durable.retired_docker,
        })
    }
    pub(crate) fn check_generation(&self, generation: u64) -> Result<AuthoritySnapshot, String> {
        let snapshot = self.snapshot()?;
        if generation != snapshot.generation || snapshot.transitioning {
            return Err(STALE.into());
        }
        Ok(snapshot)
    }
    pub(crate) fn begin_agent(
        self: &Arc<Self>,
        generation: u64,
    ) -> Result<OperationTicket, String> {
        let mut inner = self.inner.lock().map_err(|_| STALE)?;
        if self.plugins.load(Ordering::Acquire) & super::plugins::COMPUTER == 0 {
            return Err("Enable Computer Use in Plugins before using this tool.".into());
        }
        if generation != inner.durable.generation || inner.draining {
            return Err(STALE.into());
        }
        inner.next = inner.next.checked_add(1).ok_or(STALE)?;
        let id = inner.next;
        let cancellation = Arc::new(AtomicBool::new(false));
        inner.operations.insert(id, cancellation.clone());
        Ok(OperationTicket {
            authority: self.clone(),
            id,
            generation,
            cancellation,
        })
    }
    pub(crate) fn begin_artifact(
        self: &Arc<Self>,
        generation: u64,
    ) -> Result<OperationTicket, String> {
        self.begin_agent(generation)
    }
    pub(crate) fn revoke(&self, expected: u64) -> Result<u64, String> {
        let mut inner = self.inner.lock().map_err(|_| STALE)?;
        if inner.durable.generation != expected {
            return Err(STALE.into());
        }
        for cancelled in inner.operations.values() {
            cancelled.store(true, Ordering::Release);
        }
        inner.draining = true;
        inner.durable.generation = next_generation(inner.durable.generation)?;
        persist(&self.path, &inner.durable)?;
        Ok(inner.durable.generation)
    }
    pub(crate) fn drain(&self, generation: u64, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.inner.lock().map_err(|_| STALE)?;
        loop {
            if inner.durable.generation != generation {
                return Err(STALE.into());
            }
            if inner.operations.is_empty() {
                inner.draining = false;
                return Ok(());
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or("A previous computer operation is still draining. Input remains stopped.")?;
            let (next, _) = self
                .drained
                .wait_timeout(inner, remaining)
                .map_err(|_| STALE)?;
            inner = next;
        }
    }
    pub(super) fn revoke_and_drain_later(self: &Arc<Self>) {
        let generation = self.snapshot().and_then(|s| self.revoke(s.generation));
        if let Ok(generation) = generation {
            let authority = self.clone();
            let _ = std::thread::Builder::new()
                .name("mivlet-computer-drain".into())
                .spawn(move || {
                    let _ = authority.drain(generation, Duration::from_secs(20));
                });
        }
    }
}
impl OperationTicket {
    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancellation.clone()
    }
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(STALE.into());
        }
        self.authority.check_generation(self.generation).map(|_| ())
    }
    pub(crate) fn finish<T>(self, result: Result<T, String>) -> Result<T, String> {
        self.check()?;
        result
    }
}
impl Drop for OperationTicket {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.authority.inner.lock() {
            inner.operations.remove(&self.id);
            self.authority.drained.notify_all();
        }
    }
}
fn next_generation(previous: u64) -> Result<u64, String> {
    previous
        .checked_add(1)
        .filter(|g| *g <= MAX_GENERATION)
        .ok_or("The computer generation is exhausted.".into())
}
fn read_state(path: &Path) -> Result<Vec<u8>, String> {
    crate::paths::strict_canonicalize(path)
        .map_err(|_| "Computer authority storage failed its security check.")?;
    let bytes = std::fs::read(path).map_err(|_| "Computer authority storage is unavailable.")?;
    if bytes.len() > 4096 {
        return Err("Computer authority storage is invalid.".into());
    }
    Ok(bytes)
}
fn persist(path: &Path, durable: &Durable) -> Result<(), String> {
    let mut pending = tempfile::NamedTempFile::new_in(path.parent().ok_or(STALE)?)
        .map_err(|_| "Computer authority could not be saved. Control remains off.")?;
    serde_json::to_writer(&mut pending, durable).map_err(|_| STALE)?;
    pending
        .flush()
        .and_then(|_| pending.as_file().sync_all())
        .map_err(|_| "Computer authority could not be saved. Control remains off.")?;
    pending
        .persist(path)
        .map_err(|_| "Computer authority could not be saved. Control remains off.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revocation_invalidates_queued_and_completed_results_before_drain() {
        let root = tempfile::tempdir().unwrap();
        let auth = ComputerAuthority::load(root.path()).unwrap();
        let a = auth.begin_agent(1).unwrap();
        let b = auth.begin_agent(1).unwrap();
        let generation = auth.revoke(1).unwrap();
        assert!(a.check().is_err());
        assert!(b.finish(Ok("late")).is_err());
        assert!(auth.begin_agent(generation).is_err());
        assert!(auth.drain(generation, Duration::from_millis(1)).is_err());
        drop(a);
        auth.drain(generation, Duration::from_secs(1)).unwrap();
        assert!(auth.begin_agent(1).is_err());
        assert!(auth.begin_agent(generation).is_ok());
    }
    #[test]
    fn restart_increments_generation_without_restoring_permission() {
        let root = tempfile::tempdir().unwrap();
        let auth = ComputerAuthority::load(root.path()).unwrap();
        drop(auth);
        let auth = ComputerAuthority::load(root.path()).unwrap();
        assert_eq!(auth.snapshot().unwrap().generation, 2);
        assert!(auth.begin_agent(1).is_err());
    }
    #[test]
    fn legacy_metadata_and_files_remain_untouched() {
        let root = tempfile::tempdir().unwrap();
        let old = br#"{"version":1,"controller":"agent","generation":17,"leaseExpiresAt":null}"#;
        std::fs::write(root.path().join("control.json"), old).unwrap();
        std::fs::create_dir(root.path().join("workspace")).unwrap();
        std::fs::write(root.path().join("workspace/report.txt"), "keep").unwrap();
        let auth = ComputerAuthority::load(root.path()).unwrap();
        assert!(auth.snapshot().unwrap().retired_docker);
        assert_eq!(auth.snapshot().unwrap().generation, 18);
        assert_eq!(
            std::fs::read(root.path().join("control.json")).unwrap(),
            old
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("workspace/report.txt")).unwrap(),
            "keep"
        );
    }
    #[test]
    fn plugin_disable_blocks_new_tickets() {
        let root = tempfile::tempdir().unwrap();
        let bits = Arc::new(AtomicU8::new(0));
        let auth = ComputerAuthority::load_with_plugins(root.path(), bits.clone()).unwrap();
        assert!(auth.begin_agent(1).is_err());
        bits.store(super::super::plugins::COMPUTER, Ordering::Release);
        assert!(auth.begin_agent(1).is_ok());
    }
}

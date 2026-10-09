//! Nonsecret lifecycle metadata only. Output and commands never enter this file.
use super::{JobRecord, JobStatus};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 512 * 1024;
pub(super) const MAX_RECORDS: usize = 128;

pub(super) struct Storage {
    path: PathBuf,
    _owner: File,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u8,
    jobs: Vec<JobRecord>,
}
impl Storage {
    pub fn open(scope: &Path) -> Result<(Self, Vec<JobRecord>), String> {
        let root = scope.join("command-jobs");
        fs::create_dir_all(&root).map_err(|_| "Command history is unavailable.")?;
        crate::paths::strict_canonicalize(&root)
            .map_err(|_| "Command history path failed validation.")?;
        let lease = root.join("owner.lock");
        if lease.exists() {
            crate::paths::strict_canonicalize(&lease)
                .map_err(|_| "Command owner path failed validation.")?;
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let owner = options.open(lease).map_err(|_| {
            "Another native process owns command jobs for this scope; reconnect to its authority."
        })?;
        let storage = Self {
            path: root.join("jobs.json"),
            _owner: owner,
        };
        let mut jobs = if storage.path.exists() {
            crate::paths::strict_canonicalize(&storage.path)
                .map_err(|_| "Command history failed validation.")?;
            let mut bytes = Vec::new();
            File::open(&storage.path)
                .map_err(|_| "Command history is unavailable.")?
                .take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read command history.")?;
            if bytes.len() as u64 > MAX_BYTES {
                return Err("Command history exceeds its bound.".into());
            }
            let index: Index =
                serde_json::from_slice(&bytes).map_err(|_| "Command history needs recovery.")?;
            if index.version != 1 || index.jobs.len() > MAX_RECORDS {
                return Err("Unsupported command history.".into());
            }
            let mut ids = std::collections::HashSet::new();
            for job in &index.jobs {
                if !job.valid() || !ids.insert(&job.id) {
                    return Err("Invalid command history identity.".into());
                }
            }
            index.jobs
        } else {
            Vec::new()
        };
        for job in &mut jobs {
            if job.status.active() {
                // The previous host's anonymous kill-on-close job cannot survive
                // it. Never attach by PID, relaunch, or import abandoned files.
                job.status = JobStatus::Interrupted;
                job.finished_at = Some(super::now());
                job.message =
                    Some("Native owner ended; outcome uncertain. No replay or file import.".into());
            }
        }
        storage.save(&jobs)?;
        Ok((storage, jobs))
    }
    pub fn save(&self, jobs: &[JobRecord]) -> Result<(), String> {
        let bytes = serde_json::to_vec(&Index {
            version: 1,
            jobs: jobs.to_vec(),
        })
        .map_err(|_| "Invalid command history.")?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Command history exceeds its bound.".into());
        }
        let mut pending = tempfile::NamedTempFile::new_in(
            self.path.parent().ok_or("Invalid command history path.")?,
        )
        .map_err(|_| "Cannot stage command history.")?;
        pending
            .write_all(&bytes)
            .and_then(|_| pending.flush())
            .and_then(|_| pending.as_file().sync_all())
            .map_err(|_| "Cannot flush command history.")?;
        pending
            .persist(&self.path)
            .map_err(|_| "Cannot commit command history.")?;
        Ok(())
    }
}

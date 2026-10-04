//! Mivlet-owned Windows execution boundary, independent of provider runtimes.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(all(test, windows))]
mod acceptance;
#[cfg(windows)]
mod custody;
mod files;
#[cfg(windows)]
mod process;
mod runtime;
#[cfg(windows)]
mod security;
#[cfg(windows)]
pub mod setup;
#[cfg(windows)]
pub use custody::recover;
pub fn verify_runtime(resources: &Path) -> Result<String, String> {
    runtime::verify(resources)
}

/// Data limits are checked before staging, while the job runs, and before import.
/// Memory/process/CPU limits are enforced by the Windows kernel. Disk monitoring
/// is a watchdog, not an NTFS quota; writes can briefly exceed its threshold.
#[derive(Clone, Copy)]
pub struct Limits {
    pub file_bytes: u64,
    pub tree_bytes: u64,
    pub file_count: usize,
    pub memory_bytes: usize,
    pub processes: u32,
}
impl Limits {
    pub const ANALYSIS: Self = Self {
        file_bytes: 8 * 1024 * 1024,
        tree_bytes: 64 * 1024 * 1024,
        file_count: 4096,
        memory_bytes: 1024 * 1024 * 1024,
        processes: 32,
    };
    pub const CODING: Self = Self {
        file_bytes: 256 * 1024 * 1024,
        tree_bytes: 2 * 1024 * 1024 * 1024,
        file_count: 200_000,
        memory_bytes: 2 * 1024 * 1024 * 1024,
        processes: 64,
    };
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub run_id: String,
    pub executor: String,
    pub runtime_id: String,
    pub input_id: String,
    pub output_id: Option<String>,
    pub exit_code: Option<i32>,
    pub output: String,
    pub truncated: bool,
    pub interrupted: bool,
    pub reason: Option<String>,
    pub elapsed_ms: u64,
    pub network: bool,
    pub command_id: String,
    pub binding: Binding,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub scope_id: String,
    pub generation: u64,
    pub operation_id: u64,
}

/// Owns the validated snapshot after all descendants have been terminated.
/// Callers retain their generation/approval fences before committing any bytes.
pub struct CompletedRun {
    receipt: Receipt,
    #[cfg(windows)]
    _lease: custody::Lease,
    directory: tempfile::TempDir,
    work: PathBuf,
    limits: Limits,
}
impl CompletedRun {
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }
    pub fn work(&self) -> &Path {
        &self.work
    }
    pub fn import_repository(&self, destination: &Path) -> Result<(), String> {
        self.verify_seal()?;
        files::replace_tree(&self.work, destination, self.limits)
    }
    pub fn verify_seal(&self) -> Result<(), String> {
        if self.receipt.exit_code != Some(0) || self.receipt.interrupted {
            return Err("Failed or interrupted command snapshots cannot be imported.".into());
        }
        if Some(files::tree_id(&self.work, self.limits)?) != self.receipt.output_id {
            return Err("The sealed command snapshot changed. No changes imported.".into());
        }
        Ok(())
    }
    pub fn retained_directory(&self) -> &Path {
        self.directory.path()
    }
}

/// The caller supplies a trusted resource root, never a model-selected program
/// or host PATH. `current` is polled without waiting for the execution lock.
#[allow(clippy::too_many_arguments)]
pub fn run(
    resource_root: &Path,
    input: &Path,
    script: &str,
    network: bool,
    timeout_seconds: u64,
    limits: Limits,
    binding: Binding,
    current: impl Fn() -> bool,
) -> Result<CompletedRun, String> {
    if script.trim().is_empty()
        || script.len() > 8192
        || script.contains('\0')
        || !(1..=900).contains(&timeout_seconds)
    {
        return Err("Invalid native execution command or timeout.".into());
    }
    if binding.scope_id.len() != 64
        || !binding.scope_id.bytes().all(|b| b.is_ascii_hexdigit())
        || binding.generation == 0
        || binding.operation_id == 0
    {
        return Err("Native execution requires a current scoped operation.".into());
    }
    #[cfg(windows)]
    {
        process::run(
            resource_root,
            input,
            script,
            network,
            timeout_seconds,
            limits,
            binding,
            current,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (resource_root, input, network, limits, binding, current);
        Err("Native code execution requires Windows x64.".into())
    }
}

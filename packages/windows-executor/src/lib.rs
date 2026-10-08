//! Mivlet-owned Windows execution boundary, independent of provider runtimes.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(all(test, windows))]
mod acceptance;
#[cfg(windows)]
mod custody;
mod files;
#[cfg(all(test, windows))]
mod lifecycle_acceptance;
pub mod output;
pub use output::OutputLog;
mod repository_import;
pub use repository_import::{
    acknowledge_recovery as acknowledge_repository_import, recover as recover_repository_import,
    Recovery as RepositoryImportRecovery,
};
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
    #[serde(default)]
    pub persistent: bool,
}

/// Persistent jobs retain their isolated writable snapshot only while running.
/// They never produce an importable seal, even when they exit successfully.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionMode {
    Command,
    Persistent,
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
    directory: ExecutionDirectory,
    work: PathBuf,
    limits: Limits,
}
pub(crate) struct ExecutionDirectory {
    path: PathBuf,
    retained: bool,
}
impl ExecutionDirectory {
    #[cfg(windows)]
    pub(crate) fn create(path: PathBuf) -> Result<Self, String> {
        std::fs::create_dir(&path).map_err(|_| "Cannot prepare native execution custody.")?;
        Ok(Self {
            path,
            retained: false,
        })
    }
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    #[cfg(windows)]
    pub(crate) fn publish(&mut self, path: PathBuf) -> Result<(), String> {
        std::fs::rename(&self.path, &path).map_err(|error| {
            format!(
                "Cannot publish prepared native custody (Windows {:?}).",
                error.raw_os_error()
            )
        })?;
        self.path = path;
        Ok(())
    }
    #[cfg(windows)]
    pub(crate) fn keep(mut self) -> PathBuf {
        self.retained = true;
        self.path.clone()
    }
}
impl Drop for ExecutionDirectory {
    fn drop(&mut self) {
        if !self.retained {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
pub struct PreparedRepositoryImport {
    prepared: repository_import::Prepared,
    limits: Limits,
}
pub struct RepositoryImportCleanup {
    committed: repository_import::Committed,
    limits: Limits,
}
impl PreparedRepositoryImport {
    /// Call inside the generation fence; acknowledge after durable repository
    /// state persistence, outside that fence. Dropping never removes custody.
    pub fn commit(self) -> Result<RepositoryImportCleanup, String> {
        Ok(RepositoryImportCleanup {
            committed: self.prepared.commit()?,
            limits: self.limits,
        })
    }
}
impl RepositoryImportCleanup {
    pub fn acknowledge(self, current: impl Fn() -> bool) -> Result<(), String> {
        self.committed.acknowledge(self.limits, &current)
    }
}
impl CompletedRun {
    pub fn receipt(&self) -> &Receipt {
        &self.receipt
    }
    pub fn work(&self) -> &Path {
        &self.work
    }
    pub fn import_repository(&self, destination: &Path) -> Result<(), String> {
        self.prepare_repository_import(destination, || true)?
            .commit()
            .and_then(|committed| committed.acknowledge(|| true))
    }
    /// Stage the expensive copy without holding the authority lock; Stop is
    /// polled during inspection/copying. Only the final rename needs the fence.
    pub fn prepare_repository_import(
        &self,
        destination: &Path,
        current: impl Fn() -> bool,
    ) -> Result<PreparedRepositoryImport, String> {
        self.verify_seal_current(&current)?;
        let prepared = repository_import::prepare(
            &self.work,
            destination,
            self.limits,
            &self.receipt,
            &current,
        )?;
        Ok(PreparedRepositoryImport {
            prepared,
            limits: self.limits,
        })
    }
    pub fn verify_seal(&self) -> Result<(), String> {
        self.verify_seal_current(&|| true)
    }
    fn verify_seal_current(&self, current: &dyn Fn() -> bool) -> Result<(), String> {
        if self.receipt.persistent {
            return Err("Persistent job snapshots are never importable.".into());
        }
        if self.receipt.exit_code != Some(0) || self.receipt.interrupted {
            return Err("Failed or interrupted command snapshots cannot be imported.".into());
        }
        if Some(files::tree_id_current(&self.work, self.limits, current)?) != self.receipt.output_id
        {
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
/// `launch` must dispatch its single-use resume action under the owning native
/// generation fence. Expensive staging and token validation precede that action.
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
    launch: impl FnOnce(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>,
) -> Result<CompletedRun, String> {
    run_with_output(
        resource_root,
        input,
        script,
        network,
        timeout_seconds,
        limits,
        binding,
        ExecutionMode::Command,
        OutputLog::new(|_, text| text.to_owned()),
        current,
        launch,
    )
}

/// Native-owned streaming uses a bounded pull log, with no subscriber callbacks
/// on the supervisor or pipe threads. The caller retains its exact approval,
/// repository lock and operation ticket for the entire lifetime of this call.
#[allow(clippy::too_many_arguments)]
pub fn run_with_output(
    resource_root: &Path,
    input: &Path,
    script: &str,
    network: bool,
    timeout_seconds: u64,
    limits: Limits,
    binding: Binding,
    mode: ExecutionMode,
    output: OutputLog,
    current: impl Fn() -> bool,
    launch: impl FnOnce(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>,
) -> Result<CompletedRun, String> {
    struct Close(OutputLog);
    impl Drop for Close {
        fn drop(&mut self) {
            self.0.close();
        }
    }
    let _close = Close(output.clone());
    let max_seconds = if mode == ExecutionMode::Persistent {
        86_400
    } else {
        900
    };
    if script.trim().is_empty()
        || script.len() > 8192
        || script.contains('\0')
        || !(1..=max_seconds).contains(&timeout_seconds)
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
            mode,
            output,
            current,
            launch,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (
            resource_root,
            input,
            network,
            limits,
            binding,
            mode,
            output,
            current,
            launch,
        );
        Err("Native code execution requires Windows x64.".into())
    }
}

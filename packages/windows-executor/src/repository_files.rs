//! Bounded file operations for native-owned repository checkpoints. Callers must
//! hold repository custody and check their account/approval/generation authority.
//! These helpers never launch a process or mint an execution receipt.
use crate::{files, repository_import, Binding, Limits, PreparedRepositoryImport};
use std::{fs, path::Path};

pub fn tree_id(root: &Path, limits: Limits, current: impl Fn() -> bool) -> Result<String, String> {
    files::tree_id_current(root, limits, &current)
}
pub fn copy_tree(
    source: &Path,
    destination: &Path,
    limits: Limits,
    current: impl Fn() -> bool,
) -> Result<String, String> {
    files::strict_path(destination)?;
    files::copy_tree_current(source, destination, limits, &current)
}
pub fn read(path: &Path, limit: u64, current: impl Fn() -> bool) -> Result<Vec<u8>, String> {
    files::read_current(path, limit, &current)
}
pub fn relative(path: &str) -> Result<(), String> {
    if Path::new(path).is_absolute()
        || path.contains('\\')
        || path.split('/').any(|p| p.eq_ignore_ascii_case(".git"))
    {
        return Err("Checkpoint paths must be relative and exclude Git custody.".into());
    }
    files::relative(Path::new(path)).map(|_| ())
}

/// One OS lease shared by all coding operations, including a future detached
/// worker. No wait while holding a generation fence; competing owners fail closed.
pub fn lease(directory: &Path) -> Result<fs::File, String> {
    files::strict_path(directory)?;
    let path = directory.join("repository.lock");
    if path.exists() {
        files::strict_path(&path)?;
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(3).custom_flags(0x00200000); // no delete sharing; open reparse point itself
    }
    let file = options
        .open(path)
        .map_err(|_| "Repository custody is unavailable.")?;
    files::regular_file(&file)?;
    file.try_lock()
        .map_err(|_| "A repository operation owns this copy. Wait or Stop it before continuing.")?;
    Ok(file)
}

/// Stage an exactly reviewed file restore using the existing durable import
/// transaction. This carries checkpoint provenance, never a fabricated command.
#[allow(clippy::too_many_arguments)]
pub fn prepare_restore(
    source: &Path,
    destination: &Path,
    limits: Limits,
    checkpoint_id: &str,
    expected_current: &str,
    expected_output: &str,
    binding: Binding,
    current: impl Fn() -> bool,
) -> Result<PreparedRepositoryImport, String> {
    let prepared = repository_import::prepare_restore(
        source,
        destination,
        limits,
        checkpoint_id,
        expected_current,
        expected_output,
        binding,
        &current,
    )?;
    Ok(PreparedRepositoryImport { prepared, limits })
}

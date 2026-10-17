use super::*;
use serde::{de::DeserializeOwned, Serialize};

const METADATA_BYTES: u64 = 4 * 1024 * 1024;
pub(super) fn home(directory: &Path, repo: &Repository) -> Result<PathBuf, String> {
    let owner = crate::paths::strict_canonicalize(&directory.join(&repo.id))
        .map_err(|_| "The retained repository copy is unavailable.")?;
    if checkout(directory, repo)? != owner.join("checkout") {
        return Err("The coding copy identity changed.".into());
    }
    let path = owner.join("hosted-repositories");
    fs::create_dir_all(&path).map_err(|_| "Cannot create private hosted file custody.")?;
    if crate::paths::strict_canonicalize(&path).map_err(|_| "Hosted file custody changed.")? != path
    {
        return Err("Hosted file custody changed.".into());
    }
    Ok(path)
}
pub(super) fn snapshot_root(home: &Path, id: &str) -> Result<PathBuf, String> {
    if !hex(id, 48) {
        return Err("Invalid source snapshot identity.".into());
    }
    let path = home.join(id);
    if crate::paths::strict_canonicalize(&path)
        .map_err(|_| "The saved source snapshot is unavailable.")?
        != path
    {
        return Err("The saved source snapshot identity changed.".into());
    }
    Ok(path)
}
pub(super) fn write_new<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let encoded = serde_json::to_vec(value).map_err(|_| "Invalid hosted file metadata.")?;
    if encoded.len() as u64 > METADATA_BYTES {
        return Err("Hosted file metadata exceeds its limit.".into());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Cannot reserve immutable hosted file metadata.")?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist hosted file metadata.".into())
}
pub(super) fn read<T: DeserializeOwned>(
    path: &Path,
    ticket: &OperationTicket,
) -> Result<T, String> {
    let bytes = files::read(path, METADATA_BYTES, || ticket.check().is_ok())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Saved hosted file metadata failed validation.".into())
}
pub(super) fn replace<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    crate::paths::strict_canonicalize(path).map_err(|_| "Saved import review changed.")?;
    let encoded = serde_json::to_vec(value).map_err(|_| "Invalid import review metadata.")?;
    if encoded.len() as u64 > METADATA_BYTES {
        return Err("Import review metadata exceeds its limit.".into());
    }
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid import review custody.")?)
            .map_err(|_| "Cannot stage import review metadata.")?;
    file.write_all(&encoded)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Cannot persist import review metadata.")?;
    file.persist(path)
        .map_err(|_| "Cannot refresh the immutable output review.")?;
    Ok(())
}
pub(super) fn load(
    directory: &Path,
    repo: &Repository,
    ticket: &OperationTicket,
    snapshot_id: &str,
) -> Result<(PathBuf, models::Record), String> {
    let root = snapshot_root(&home(directory, repo)?, snapshot_id)?;
    let record: models::Record = read(&root.join("snapshot.json"), ticket)?;
    validate_snapshot(&record.snapshot)?;
    record.task.validate()?;
    record.repository.check(repo)?;
    if record.version != 1
        || record.snapshot.snapshot_id != snapshot_id
        || record.snapshot.repository_id != repo.id
        || record.snapshot.branch != repo.branch
        || record.snapshot.base_commit != repo.base
        || record.account != crate::account_session::binding()?
        || record.scope_id != ticket.execution_binding().scope_id
        || !hex(&record.full_tree_id, 64)
        || !(hex(&record.head, 40) || hex(&record.head, 64))
    {
        return Err(
            "This source snapshot belongs to another task, account, computer or repository copy."
                .into(),
        );
    }
    Ok((root, record))
}
pub(super) fn reserve(home: &Path) -> Result<tempfile::TempDir, String> {
    let count = fs::read_dir(home)
        .map_err(|_| "Cannot inspect hosted source custody.")?
        .take(MAX_SNAPSHOTS + 1)
        .count();
    if count >= MAX_SNAPSHOTS {
        return Err("This copy has reached its four retained source snapshots. Review its existing hosted work before exporting more source.".into());
    }
    tempfile::Builder::new()
        .prefix("preparing-")
        .tempdir_in(home)
        .map_err(|_| "Cannot reserve private source custody.".into())
}
pub(super) fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid private source destination.")?)
        .map_err(|_| "Cannot prepare private source directories.")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "Source paths collide or changed during staging.")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist private source bytes.".into())
}
pub(super) fn repository(
    state: &crate::local_computer::LocalComputerState,
    task: &TaskIdentity,
    binding: &super::super::RepositoryWorkBinding,
) -> Result<(PathBuf, Repository), String> {
    let directory = super::super::directory(state, &task.local_workspace_id, &task.agent_id)?;
    let repository = copy_manager::owned_repository(
        &directory,
        &binding.repository_id,
        &task.local_workspace_id,
        &task.agent_id,
    )?;
    binding.check(&repository)?;
    Ok((directory, repository))
}

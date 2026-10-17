//! Release only native snapshots whose exact canonical task cannot use them.
use super::*;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
fn preparations() -> &'static Mutex<BTreeMap<String, TaskIdentity>> {
    static ACTIVE: OnceLock<Mutex<BTreeMap<String, TaskIdentity>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(BTreeMap::new()))
}
pub(crate) struct Preparation {
    task: TaskIdentity,
}
pub(crate) fn preparing(task: &TaskIdentity) -> Result<Preparation, String> {
    task.validate()?;
    let mut active = preparations()
        .lock()
        .map_err(|_| "Source preparation custody unavailable.")?;
    if active.len() >= 16 || active.contains_key(&task.task_id) {
        return Err("A bounded source preparation is already running.".into());
    }
    active.insert(task.task_id.clone(), task.clone());
    Ok(Preparation { task: task.clone() })
}
pub(crate) fn is_preparing(task: &TaskIdentity) -> Result<bool, String> {
    Ok(preparations()
        .lock()
        .map_err(|_| "Source preparation custody unavailable.")?
        .get(&task.task_id)
        == Some(task))
}
impl Drop for Preparation {
    fn drop(&mut self) {
        if let Ok(mut active) = preparations().lock() {
            if active.get(&self.task.task_id) == Some(&self.task) {
                active.remove(&self.task.task_id);
            }
        }
    }
}

const CUSTODY_LIMITS: Limits = Limits {
    file_bytes: 4 * 1024 * 1024,
    tree_bytes: 128 * 1024 * 1024,
    file_count: 8192,
    ..Limits::CODING
};
fn remove_retired(home: &Path, root: &Path, current: impl Fn() -> bool) -> Result<(), String> {
    if root.parent() != Some(home)
        || !root
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_prefix("released-"))
            .is_some_and(|id| hex(id, 48))
        || crate::paths::strict_canonicalize(root).map_err(|_| "Released snapshot path changed.")?
            != root
    {
        return Err("Released snapshot path changed.".into());
    }
    // Validate the complete bounded tree before recursive deletion. Never
    // follow links or junctions, and leave the provenance metadata until last.
    files::tree_id(root, CUSTODY_LIMITS, &current)?;
    for entry in fs::read_dir(root).map_err(|_| "Cannot inspect released source custody.")? {
        if !current() {
            return Err("Source cleanup stopped.".into());
        }
        let entry = entry.map_err(|_| "Cannot inspect released source custody.")?;
        if entry.file_name() == "snapshot.json" {
            continue;
        }
        let path = entry.path();
        if crate::paths::strict_canonicalize(&path).map_err(|_| "Released source changed.")? != path
        {
            return Err("Released source changed.".into());
        }
        if entry
            .file_type()
            .map_err(|_| "Released source changed.")?
            .is_dir()
        {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
        .map_err(|_| "Released source cleanup is pending; no active snapshot was removed.")?;
    }
    if !current() {
        return Err("Source cleanup stopped.".into());
    }
    fs::remove_file(root.join("snapshot.json"))
        .map_err(|_| "Released source metadata cleanup is pending.")?;
    fs::remove_dir(root).map_err(|_| "Released source directory cleanup is pending.".into())
}
/// Caller holds the exact repository mutex and OS lease. This fixed home lease
/// is also held by readers/stagers, so dropping an inner Windows lease for the
/// atomic rename cannot let another snapshot reader acquire it in between.
pub(super) fn prune(
    app: &tauri::AppHandle,
    ticket: &OperationTicket,
    directory: &Path,
    repo: &Repository,
    home: &Path,
) -> Result<(), String> {
    let _custody = files::lease(home)?;
    let facts = super::super::checkpoints::retention::inspect(
        directory,
        &repo.id,
        &ticket.execution_binding().scope_id,
        || ticket.check().is_ok(),
    )?;
    if repo.operation != "idle" || !facts.recovery.is_empty() {
        return Err("Recover this copy before releasing hosted source custody.".into());
    }
    for (index, entry) in fs::read_dir(home)
        .map_err(|_| "Cannot inspect hosted source custody.")?
        .enumerate()
    {
        if index >= 16 {
            return Err("Hosted source custody exceeds its cleanup bound.".into());
        }
        ticket.check()?;
        let entry = entry.map_err(|_| "Cannot inspect hosted source custody.")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let released = name.strip_prefix("released-");
        let id = released.unwrap_or(name);
        if !hex(id, 48) {
            continue;
        }
        let root = entry.path();
        if crate::paths::strict_canonicalize(&root).map_err(|_| "Hosted source path changed.")?
            != root
        {
            return Err("Hosted source path changed.".into());
        }
        // A crash after the final metadata removal can leave an empty retired
        // directory. remove_dir alone never recursively deletes unknown data.
        if released.is_some()
            && !root
                .join("snapshot.json")
                .try_exists()
                .map_err(|_| "Cannot inspect retired metadata.")?
        {
            let _ = fs::remove_dir(&root);
            continue;
        }
        let record: models::Record = match storage::read(&root.join("snapshot.json"), ticket) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if storage::validate_record(&record, repo, ticket, id).is_err()
            || is_preparing(&record.task)?
        {
            continue;
        }
        let root_lease = match files::lease(&root) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let destination = home.join(format!("released-{id}"));
        let retired = crate::collaboration::hosted_repository::retire_snapshot(
            app,
            ticket,
            &record.task,
            &record.snapshot,
            || {
                drop(root_lease);
                if released.is_none() {
                    fs::rename(&root, &destination)
                        .map_err(|_| "Cannot retire source custody safely.".to_string())?;
                }
                Ok(())
            },
        )?;
        if retired {
            remove_retired(home, &destination, || ticket.check().is_ok())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recursive_cleanup_requires_native_retired_shape_and_preserves_unknown_data() {
        let temp = tempfile::tempdir().unwrap();
        let home = crate::paths::strict_canonicalize(temp.path()).unwrap();
        let root = home.join(format!("released-{}", "a".repeat(48)));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("snapshot.json"), b"native metadata").unwrap();
        fs::create_dir(root.join("input")).unwrap();
        fs::write(root.join("input/main.ts"), b"source").unwrap();
        remove_retired(&home, &root, || true).unwrap();
        assert!(!root.exists());
        let unknown = home.join("preparing-unknown");
        fs::create_dir(&unknown).unwrap();
        fs::write(unknown.join("source"), b"keep").unwrap();
        assert!(remove_retired(&home, &unknown, || true).is_err());
        assert_eq!(fs::read(unknown.join("source")).unwrap(), b"keep");
    }
}

//! Non-mutating checkpoint facts for native retained-copy inventory. The caller
//! verifies account/workspace/agent ownership and holds the canonical copy lock
//! (including its OS lease) before calling. No authority is acquired here.
use super::{files, storage};
use std::{fs, path::Path};

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Recovery {
    CapturePending,
    DeletionPending,
    RestoreStaging,
    DiffStaging,
    /// Presence only: import metadata belongs to the executor's canonical parser.
    /// Never treat this as a validated or terminal import outcome.
    ImportUnknown,
    CheckoutMissing,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Retention {
    pub repository_id: String,
    pub execution_scope_id: String,
    pub saved_count: usize,
    /// Verified logical saved-file bytes; excludes manifests and pending trees.
    pub saved_bytes: u64,
    pub recovery: Vec<Recovery>,
}

impl Retention {
    pub fn requires_retention(&self) -> bool {
        self.saved_count != 0 || !self.recovery.is_empty()
    }
}

fn check(current: &dyn Fn() -> bool) -> Result<(), String> {
    if current() {
        Ok(())
    } else {
        Err("Checkpoint retention inspection stopped; preserve the copy.".into())
    }
}

fn present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Checkpoint retention storage is inaccessible; preserve the copy.".into()),
    }
}

fn directory(path: &Path) -> Result<(), String> {
    crate::paths::strict_canonicalize(path)
        .map_err(|_| "Checkpoint retention path failed validation; preserve the copy.")?;
    if !fs::symlink_metadata(path)
        .map_err(|_| "Checkpoint retention path is unavailable.")?
        .is_dir()
    {
        return Err("Checkpoint retention needs a regular directory.".into());
    }
    Ok(())
}

/// Inspect one retained copy, including an unselected copy or a missing-checkout
/// rename gap. `coding_directory` and `execution_scope_id` must come from the
/// verified *owner*, not the account-inventory actor or caller-supplied paths.
/// Derive the identity with `authority::execution_scope_id` on the owner's
/// `state.scope(...).directory`; do not load an authority merely to inspect it.
/// `current` must recheck the caller's account/Stop/freshness authority.
///
/// Returns Err for unknown/malformed checkpoint evidence: callers must protect
/// that copy, never substitute an empty projection. Import remnants remain
/// conservatively unknown without invoking recovery or another journal parser.
/// Even an empty successful result is not permission to delete: copy ownership,
/// work/jobs/import/publication guards and a fresh cleanup approval still apply.
pub(crate) fn inspect(
    coding_directory: &Path,
    repository_id: &str,
    execution_scope_id: &str,
    current: impl Fn() -> bool,
) -> Result<Retention, String> {
    check(&current)?;
    if !storage::id(repository_id, 48) || !storage::id(execution_scope_id, 64) {
        return Err(
            "Checkpoint retention requires verified repository and execution scope.".into(),
        );
    }
    directory(coding_directory)?;
    let copy = coding_directory.join(repository_id);
    directory(&copy)?;
    let mut result = Retention {
        repository_id: repository_id.into(),
        execution_scope_id: execution_scope_id.into(),
        saved_count: 0,
        saved_bytes: 0,
        recovery: Vec::new(),
    };
    if present(&copy.join("checkout"))? {
        directory(&copy.join("checkout"))?;
    } else {
        result.recovery.push(Recovery::CheckoutMissing);
    }
    // Only recognize checkpoint custody here. The copy inventory retains its
    // existing unknown-metadata guards for all other copy-service domains.
    for (index, entry) in fs::read_dir(&copy)
        .map_err(|_| "Cannot inspect checkpoint retention.")?
        .enumerate()
    {
        check(&current)?;
        if index >= 128 {
            return Err("Copy metadata exceeds its inspection bound.".into());
        }
        let entry = entry.map_err(|_| "Cannot inspect checkpoint retention entry.")?;
        let name = entry.file_name();
        let name = name.to_str().ok_or("Unknown copy metadata name.")?;
        // Windows custody names are case-insensitive; a renamed marker must
        // never become invisible to the conservative retention decision.
        let normalized = name.to_ascii_lowercase();
        let recovery = match normalized.as_str() {
            "checkpoints" => None,
            "checkpoint-pending" => Some(Recovery::CapturePending),
            "checkpoint-deleting" => Some(Recovery::DeletionPending),
            "checkpoint-restore-staging" => Some(Recovery::RestoreStaging),
            "checkpoint-diff" => Some(Recovery::DiffStaging),
            _ if normalized.starts_with("checkpoint") => {
                return Err("Unknown checkpoint metadata; preserve the copy.".into());
            }
            _ if normalized.starts_with("native-import") => {
                if !result.recovery.contains(&Recovery::ImportUnknown) {
                    result.recovery.push(Recovery::ImportUnknown);
                }
                None
            }
            _ => None,
        };
        if let Some(recovery) = recovery {
            directory(&entry.path())?;
            result.recovery.push(recovery);
        }
    }
    let home = copy.join("checkpoints");
    if present(&home)? {
        directory(&home)?;
        for entry in fs::read_dir(&home).map_err(|_| "Cannot inspect saved checkpoints.")? {
            check(&current)?;
            if result.saved_count >= storage::MAX_CHECKPOINTS {
                return Err("Checkpoint count exceeds its bound; preserve the copy.".into());
            }
            let entry = entry.map_err(|_| "Cannot inspect saved checkpoint.")?;
            let name = entry.file_name();
            let id = name.to_str().ok_or("Invalid checkpoint name.")?;
            directory(&entry.path())?;
            let manifest = storage::read_manifest(
                &entry.path().join("manifest.json"),
                id,
                repository_id,
                execution_scope_id,
                &current,
            )?;
            for child in fs::read_dir(entry.path()).map_err(|_| "Cannot inspect checkpoint.")? {
                check(&current)?;
                let child = child.map_err(|_| "Cannot inspect checkpoint entry.")?;
                if child.file_name() != "tree" && child.file_name() != "manifest.json" {
                    return Err("Unknown checkpoint contents; preserve the copy.".into());
                }
            }
            let tree = entry.path().join("tree");
            if files::tree_id(&tree, storage::LIMITS, &current)? != manifest.checkpoint.tree_id {
                return Err("Checkpoint saved files changed; preserve the copy.".into());
            }
            // The tree hash authenticates paths/content, not byte declarations.
            // Verify manifest sizes against the same bounded, link-safe reader.
            for (path, saved) in &manifest.files {
                if files::read(&tree.join(path), storage::LIMITS.file_bytes, &current)?.len() as u64
                    != saved.bytes
                {
                    return Err("Checkpoint saved size changed; preserve the copy.".into());
                }
            }
            result.saved_count += 1;
            result.saved_bytes += manifest.checkpoint.bytes;
            if result.saved_bytes > storage::MAX_STORAGE {
                return Err("Checkpoint storage exceeds its bound; preserve the copy.".into());
            }
        }
    }
    check(&current)?;
    result.recovery.sort();
    Ok(result)
}

#[cfg(test)]
mod tests;

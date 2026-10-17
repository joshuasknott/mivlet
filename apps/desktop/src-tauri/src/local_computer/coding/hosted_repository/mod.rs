//! Native custody for explicitly reviewed source files. No repository bytes or
//! host paths are accepted from a renderer, and cloud receipts grant no import.
mod candidates;
mod import;
mod models;
mod output;
mod snapshot;
mod storage;
#[cfg(test)]
mod tests;
use super::{checkout, copy_manager, git, lock, OperationTicket, Repository};
pub(crate) use candidates::*;
pub(crate) use import::*;
use mivlet_windows_executor::{repository_files as files, Limits};
pub(crate) use models::{Entry, ImportReceipt, OutputManifest, Snapshot, Target, TaskIdentity};
pub(crate) use output::{retained_output, AuthenticatedHostedRepositoryOutput, OutputStager};
use sha2::{Digest, Sha256};
pub(crate) use snapshot::{capture_snapshot, read_snapshot_chunk, retained_snapshot};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const FILE_BYTES: u64 = 256 * 1024;
pub(crate) const TREE_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const FILES: usize = 2000;
pub(crate) const CHUNK_BYTES: usize = 64 * 1024;
const MAX_SNAPSHOTS: usize = 4;
const DATA_LIMITS: Limits = Limits {
    file_bytes: FILE_BYTES,
    tree_bytes: TREE_BYTES,
    file_count: FILES * 2 + 32,
    ..Limits::CODING
};
// Hash/restore the entire retained tree locally, including omitted private files.
// This hash never enters a public snapshot or cloud transfer.
const COPY_LIMITS: Limits = Limits {
    file_bytes: 16 * 1024 * 1024,
    tree_bytes: 64 * 1024 * 1024,
    file_count: 4096,
    ..Limits::CODING
};

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn public_path(path: &str) -> Result<(), String> {
    files::relative(path)?;
    if path.len() > 512
        || !path.is_ascii()
        || path.starts_with('/')
        || path.split('/').any(|part| {
            let lower = part.to_ascii_lowercase();
            matches!(
                lower.as_str(),
                ".git"
                    | ".mivlet"
                    | ".codex"
                    | ".claude"
                    | ".opencode"
                    | ".github"
                    | ".vscode"
                    | ".idea"
                    | ".ssh"
                    | ".aws"
                    | ".azure"
                    | ".gnupg"
                    | ".npmrc"
                    | ".pypirc"
                    | ".netrc"
                    | "_netrc"
                    | ".gitmodules"
                    | "agents.md"
                    | "claude.md"
                    | "credentials"
                    | "credentials.json"
                    | "secrets.json"
                    | "id_rsa"
                    | "id_ed25519"
            ) || lower.starts_with(".env")
                || [".pem", ".key", ".p12", ".pfx"]
                    .iter()
                    .any(|suffix| lower.ends_with(suffix))
        })
        || crate::secret_redaction::redact_secret_text_or_omit(path) != path
    {
        return Err(
            "Choose ordinary relative source files without credentials or control files.".into(),
        );
    }
    Ok(())
}
fn public_content(bytes: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Hosted coding currently accepts UTF-8 source files only.")?;
    if bytes.len() as u64 > FILE_BYTES
        || bytes.contains(&0)
        || text.starts_with("version https://git-lfs.github.com/spec/v1")
        || crate::hosted_tasks::text_failure(text)
    {
        return Err("A selected source file is oversized or contains a private path, credential marker, or unsupported content.".into());
    }
    Ok(())
}
fn validate_entries(entries: &[Entry], total: u64) -> Result<(), String> {
    if entries.len() > FILES || total > TREE_BYTES {
        return Err("Hosted coding exceeds its 2000-file or 32 MiB limit.".into());
    }
    let mut aliases = BTreeSet::new();
    let mut directories = std::collections::BTreeMap::new();
    let mut previous: Option<&str> = None;
    let mut count = 0u64;
    for entry in entries {
        public_path(&entry.path)?;
        if previous.is_some_and(|path| path >= entry.path.as_str())
            || !aliases.insert(entry.path.to_ascii_lowercase())
            || !hex(&entry.sha256, 64)
            || entry.size_bytes > FILE_BYTES
        {
            return Err(
                "The source manifest has an invalid name, alias, hash, ordering or size.".into(),
            );
        }
        previous = Some(&entry.path);
        let parts: Vec<_> = entry.path.split('/').collect();
        let mut directory = String::new();
        for part in &parts[..parts.len().saturating_sub(1)] {
            if !directory.is_empty() {
                directory.push('/');
            }
            directory.push_str(part);
            if directories
                .insert(directory.to_ascii_lowercase(), directory.clone())
                .is_some_and(|before| before != directory)
            {
                return Err("Source paths contain a directory case alias.".into());
            }
        }
        count = count
            .checked_add(entry.size_bytes)
            .ok_or("Source size overflow.")?;
    }
    if count != total {
        return Err("The source manifest byte count changed.".into());
    }
    for entry in entries {
        let lower = entry.path.to_ascii_lowercase();
        let mut prefix = String::new();
        let parts: Vec<_> = lower.split('/').collect();
        for part in &parts[..parts.len().saturating_sub(1)] {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if aliases.contains(&prefix) {
                return Err("Source paths contain a file/directory alias.".into());
            }
        }
    }
    Ok(())
}
fn validate_writable(paths: &[String]) -> Result<(), String> {
    if paths.len() > FILES {
        return Err("Review at most 2000 exact writable source paths.".into());
    }
    let entries: Vec<_> = paths
        .iter()
        .map(|path| Entry {
            path: path.clone(),
            size_bytes: 0,
            sha256: "0".repeat(64),
        })
        .collect();
    validate_entries(&entries, 0)
}
fn tree_id(entries: &[Entry]) -> String {
    let mut hash = Sha256::new();
    for entry in entries {
        hash.update((entry.path.len() as u64).to_le_bytes());
        hash.update(entry.path.as_bytes());
        hash.update(hex::decode(&entry.sha256).expect("validated source hash"));
    }
    hex::encode(hash.finalize())
}
fn snapshot_digest(value: &Snapshot) -> Result<String, String> {
    crate::hosted_tasks::digest_value(
        &serde_json::json!({"version":value.version,"snapshotId":value.snapshot_id,"repositoryId":value.repository_id,"branch":value.branch,"baseCommit":value.base_commit,"inputTreeId":value.input_tree_id,"files":value.files,"writablePaths":value.writable_paths,"totalBytes":value.total_bytes}),
    )
}
fn output_digest(value: &OutputManifest) -> Result<String, String> {
    crate::hosted_tasks::digest_value(
        &serde_json::json!({"version":value.version,"snapshotId":value.snapshot_id,"inputManifestSha256":value.input_manifest_sha256,"files":value.files,"deletedPaths":value.deleted_paths,"totalBytes":value.total_bytes}),
    )
}
pub(crate) fn validate_snapshot(value: &Snapshot) -> Result<(), String> {
    validate_entries(&value.files, value.total_bytes)?;
    validate_writable(&value.writable_paths)?;
    if value.version != 1
        || !hex(&value.snapshot_id, 48)
        || !hex(&value.repository_id, 48)
        || value.input_tree_id != tree_id(&value.files)
        || value.manifest_sha256 != snapshot_digest(value)?
        || !(hex(&value.base_commit, 40) || hex(&value.base_commit, 64))
        || value.branch.is_empty()
        || value.branch.len() > 256
        || value.branch.chars().any(char::is_control)
        || crate::hosted_tasks::text_failure(&value.branch)
    {
        return Err("The immutable source snapshot failed validation.".into());
    }
    Ok(())
}
pub(crate) fn validate_bound_snapshot(
    binding: &crate::hosted_tasks::models::Binding,
    snapshot: &Snapshot,
) -> Result<(), String> {
    validate_snapshot(snapshot)?;
    let repository = binding
        .repository
        .as_ref()
        .ok_or("The cloud task has no exact reviewed repository snapshot.")?;
    if binding.version != 3
        || binding.mode.as_deref() != Some("offline-coding")
        || binding.web_scope.is_some()
        || repository.snapshot != *snapshot
        || repository.scope.writable_paths != snapshot.writable_paths
        || repository.scope.network != "disabled"
    {
        return Err(
            "The source snapshot or write scope differs from the exact admitted coding task."
                .into(),
        );
    }
    Ok(())
}
fn bound_context(
    current: &crate::collaboration::hosted_repository::RepositoryContext,
    snapshot: &Snapshot,
) -> Result<(), String> {
    validate_bound_snapshot(
        current
            .binding
            .as_ref()
            .ok_or("The exact cloud coding owner is unavailable.")?,
        snapshot,
    )
}

//! Immutable file checkpoints in a selected private repository. Conversation
//! state, provider sessions and Git HEAD are deliberately outside restoration.
mod preview;
mod storage;
#[cfg(test)]
mod tests;
use super::{checkout, git, save, Input, OperationTicket, Repository};
use mivlet_windows_executor::{repository_files as files, Limits};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub id: String,
    pub repository_id: String,
    pub label: String,
    pub tree_id: String,
    pub head: String,
    pub created_at: String,
    pub bytes: u64,
    pub file_count: usize,
    pub request_id: String,
    pub generation: u64,
    pub reason: String,
}

pub(super) fn execute(
    directory: &Path,
    repo: &mut Repository,
    ticket: &OperationTicket,
    tool: &str,
    input: &Input,
    request_id: &str,
) -> Result<Value, String> {
    ticket.check()?;
    storage::storage(directory, repo)?;
    // All checkpoint operations share the exact selected repository/OS lease.
    // Restart uncertainty must be reconciled, never overwritten by restore.
    if repo.operation != "idle" {
        return Err(
            "Review and recover the interrupted repository operation before using checkpoints."
                .into(),
        );
    }
    match tool {
        "repository-checkpoint-list" => Ok(
            json!({"checkpoints": storage::list(directory, repo, ticket)?, "maxCheckpoints": storage::MAX_CHECKPOINTS, "maxBytes": storage::MAX_STORAGE}),
        ),
        "repository-checkpoint-capture" => Ok(
            json!({"checkpoint": storage::capture(directory, repo, ticket, input.label.as_deref().ok_or("Supply a checkpoint label.")?, request_id, "manual")?}),
        ),
        "repository-checkpoint-preview" | "repository-checkpoint-restore" => {
            let checkpoint_id = input
                .checkpoint_id
                .as_deref()
                .ok_or("Select an exact checkpoint.")?;
            let manifest = storage::load(
                &storage::home(directory, repo)?,
                checkpoint_id,
                repo,
                ticket,
            )?;
            let prepared = preview::prepare(directory, repo, ticket, &manifest)?;
            if tool == "repository-checkpoint-preview" {
                return Ok(prepared.review);
            }
            if input.expected_tree.as_deref() != prepared.review["currentTreeId"].as_str()
                || input.expected_checkpoint_tree.as_deref() != Some(&manifest.checkpoint.tree_id)
                || input.expected_output.as_deref() != prepared.review["outputTreeId"].as_str()
                || input.expected_head.as_deref() != prepared.review["head"].as_str()
            {
                return Err("The copy or checkpoint changed after review. Preview again and request a fresh approval.".into());
            }
            // The pre-restore state remains a normal immutable checkpoint, even
            // after successful transaction cleanup. It can itself be restored.
            let before = storage::capture(
                directory,
                repo,
                ticket,
                "Before checkpoint restore",
                request_id,
                "before-restore",
            )?;
            let root = checkout(directory, repo)?;
            let imported = files::prepare_restore(
                &prepared.tree,
                &root,
                Limits::CODING,
                checkpoint_id,
                input.expected_tree.as_deref().unwrap(),
                input.expected_output.as_deref().unwrap(),
                ticket.execution_binding(),
                || ticket.check().is_ok(),
            )?;
            // Recheck selected ownership and HEAD immediately before the short
            // atomic rename fence. Repository custody excludes all native writers.
            if super::load(directory)?.is_none_or(|selected| selected.id != repo.id)
                || storage::storage(directory, repo)?.join("checkout") != root
                || git::run(directory, repo, &["rev-parse", "HEAD"], ticket)?
                    != input.expected_head.as_deref().unwrap()
            {
                return Err(
                    "Repository ownership changed; restore requires recovery and a fresh review."
                        .into(),
                );
            }
            let committed = ticket.with_current(|| {
                repo.command_diff_id = None;
                repo.operation =
                    "checkpoint restore pending; inspect and use repository-recover".into();
                save(directory, repo)?;
                let committed = imported.commit()?;
                repo.operation = "idle".into();
                save(directory, repo)?;
                Ok(committed)
            })?;
            committed.acknowledge(|| ticket.check().is_ok())?;
            storage::remove_tree(&prepared.tree, Limits::CODING, ticket)?;
            Ok(
                json!({"restored": manifest.checkpoint, "beforeRestore": before, "treeId": input.expected_output,
                "verificationInvalidated": true, "message": "Files restored in the selected Mivlet copy. Git HEAD, original checkout and conversation are unchanged. Run checks again."}),
            )
        }
        "repository-checkpoint-delete" => {
            let home = storage::home(directory, repo)?;
            let id = input
                .checkpoint_id
                .as_deref()
                .ok_or("Select an exact checkpoint.")?;
            let manifest = storage::load(&home, id, repo, ticket)?;
            if input.expected_checkpoint_tree.as_deref() != Some(&manifest.checkpoint.tree_id) {
                return Err("Checkpoint deletion requires its exact tree hash.".into());
            }
            let deleted = storage::storage(directory, repo)?.join("checkpoint-deleting");
            storage::remove_tree(&deleted, Limits::CODING, ticket)?;
            ticket.with_current(|| {
                fs::rename(home.join(id), &deleted)
                    .map_err(|_| "Cannot retire checkpoint.".to_owned())
            })?;
            storage::remove_tree(&deleted, Limits::CODING, ticket)?;
            Ok(json!({"deletedCheckpointId": id}))
        }
        _ => Err("Unknown checkpoint operation.".into()),
    }
}

/// Read-only native UI entry. Mutations always use execute_tool_call and the
/// existing persisted one-use approval, shared with provider tool execution.
#[tauri::command]
pub async fn coding_checkpoint_inspect(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, std::sync::Arc<super::super::LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    repository_id: String,
    checkpoint_id: Option<String>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Checkpoints belong to the main window.".into());
    }
    let ticket = state.begin_agent_operation(&workspace_id, &agent_id, expected_generation)?;
    let directory = super::directory(&state, &workspace_id, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tool = if checkpoint_id.is_some() {
            "repository-checkpoint-preview"
        } else {
            "repository-checkpoint-list"
        };
        let args = json!({"repositoryId": repository_id, "checkpointId": checkpoint_id});
        let result =
            super::execute_with_request(&directory, &ticket, tool, args, "checkpoint-inspection")?;
        ticket.finish(
            serde_json::from_str(&result).map_err(|_| "Invalid checkpoint inspection.".into()),
        )
    })
    .await
    .map_err(|_| "Checkpoint inspection stopped.".to_owned())?
}

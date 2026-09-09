//! Encrypted project file shares and approval-bound materialization into an
//! agent's isolated workspace.
//!
//! Unfinished internal boundary: no commands or model tools are registered.
//! Native approval/run binding, outward integration, and regression tests must
//! be completed before exposing materialization to either UI or model callers.

use super::{artifacts::verified_artifact_for_project, LocalComputerState};
use crate::authorized_scope::{command_scope, ScopeAccess};
use crate::store::repos::{execution_attempt, local_project};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_SHARED_FILES: usize = 64;
const MAX_ID_CHARACTERS: usize = 160;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSharedFile {
    pub id: String,
    pub project_id: String,
    pub source_run_id: String,
    pub source_agent_id: String,
    pub artifact_id: String,
    pub name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub shared_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectFileIndex {
    version: u32,
    project_id: String,
    files: Vec<ProjectSharedFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareProjectFileRequest {
    workspace_id: String,
    project_id: String,
    expected_project_revision: i64,
    source_run_id: String,
    source_agent_id: String,
    artifact_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListProjectFilesRequest {
    workspace_id: String,
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnshareProjectFileRequest {
    workspace_id: String,
    project_id: String,
    expected_project_revision: i64,
    shared_file_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnshareProjectFileResult {
    removed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileMaterialization {
    shared_file_id: String,
    relative_path: String,
    name: String,
    media_type: String,
    size_bytes: u64,
    sha256: String,
}

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Project files are available only from Fable's main window.".into())
    }
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.chars().count() > MAX_ID_CHARACTERS
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("{label} identifier is invalid."));
    }
    Ok(())
}

fn index_path(computers: &LocalComputerState, project_id: &str) -> PathBuf {
    let mut digest = Sha256::new();
    digest.update(b"fable-project-file-index-v1\0");
    digest.update(project_id.as_bytes());
    computers.root.join(format!(
        "project-files-{}.json",
        hex::encode(digest.finalize())
    ))
}

fn share_id(project_id: &str, run_id: &str, agent_id: &str, artifact_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable-project-file-share-v1\0");
    for value in [project_id, run_id, agent_id, artifact_id] {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    format!("project-file-{}", hex::encode(digest.finalize()))
}

fn project_and_author(
    workspace_id: &str,
    project_id: &str,
    expected_revision: Option<i64>,
    run_id: Option<&str>,
    agent_id: Option<&str>,
    allowed_statuses: &[&str],
) -> Result<(String, String), String> {
    let authorization = command_scope(Some(workspace_id.into()), None, ScopeAccess::Read)?;
    let store = crate::store::try_global().ok_or("Fable's encrypted store is not initialized.")?;
    store
        .with_conn(|tx| {
            let project =
                local_project::get_project(tx, store, &authorization.private, project_id)?
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid("The local project was not found.".into())
                    })?;
            if project.lifecycle != "active"
                || expected_revision.is_some_and(|r| project.revision != r)
            {
                return Err(crate::store::StoreError::Invalid(
                    "The local project changed or was archived. Refresh it before sharing files."
                        .into(),
                ));
            }
            if let Some(run_id) = run_id {
                let author =
                    local_project::get_run_author(tx, store, &authorization.private, run_id)?
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "This run has no immutable project author.".into(),
                            )
                        })?;
                if author.project_id != project_id
                    || author.thread_id != project.thread_id
                    || agent_id.is_some_and(|id| author.agent_id != id)
                {
                    return Err(crate::store::StoreError::Invalid(
                        "The run does not belong to this project and agent.".into(),
                    ));
                }
                let attempt =
                    execution_attempt::get_scoped(tx, store, &authorization.data, run_id)?
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "The project execution attempt was not found.".into(),
                            )
                        })?;
                if attempt.thread_id.as_deref() != Some(project.thread_id.as_str())
                    || !allowed_statuses.contains(&attempt.status.as_str())
                {
                    return Err(crate::store::StoreError::Invalid(
                        "The project run is not in an allowed lifecycle state.".into(),
                    ));
                }
            }
            Ok((project.thread_id, project.revision.to_string()))
        })
        .map_err(|error| error.to_string())
}

fn attempt_proves_artifact(
    workspace_id: &str,
    run_id: &str,
    artifact_id: &str,
) -> Result<(), String> {
    let authorization = command_scope(Some(workspace_id.into()), None, ScopeAccess::Read)?;
    let store = crate::store::try_global().ok_or("Fable's encrypted store is not initialized.")?;
    store
        .with_conn(|tx| {
            let row = execution_attempt::get_scoped(tx, store, &authorization.data, run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("The completed run was not found.".into())
                })?;
            let attempt: crate::models::ExecutionAttempt = serde_json::from_value(row.payload)
                .map_err(|_| {
                    crate::store::StoreError::Invalid("The completed run record is invalid.".into())
                })?;
            let proven = attempt.exchanges.iter().any(|exchange| {
                exchange.role == "tool"
                    && exchange.ok == Some(true)
                    && matches!(
                        exchange.tool_name.as_deref(),
                        Some("computer-artifact" | "generate-image" | "edit-image")
                    )
                    && serde_json::from_str::<serde_json::Value>(&exchange.content)
                        .ok()
                        .and_then(|value| {
                            value
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        })
                        .as_deref()
                        == Some(artifact_id)
            });
            if proven {
                Ok(())
            } else {
                Err(crate::store::StoreError::Invalid(
                    "The completed run does not prove this artifact as a successful result.".into(),
                ))
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn local_project_file_share(
    window: tauri::WebviewWindow,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
    request: ShareProjectFileRequest,
) -> Result<ProjectSharedFile, String> {
    require_main_window(&window)?;
    for (value, label) in [
        (&request.project_id, "Project"),
        (&request.source_run_id, "Run"),
        (&request.source_agent_id, "Agent"),
        (&request.artifact_id, "Artifact"),
    ] {
        validate_id(value, label)?;
    }
    project_and_author(
        &request.workspace_id,
        &request.project_id,
        Some(request.expected_project_revision),
        Some(&request.source_run_id),
        Some(&request.source_agent_id),
        &["completed"],
    )?;
    attempt_proves_artifact(
        &request.workspace_id,
        &request.source_run_id,
        &request.artifact_id,
    )?;
    let artifact = verified_artifact_for_project(
        &computers,
        &request.workspace_id,
        &request.source_agent_id,
        &request.artifact_id,
    )?;
    if artifact.agent_id != request.source_agent_id || artifact.artifact_id != request.artifact_id {
        return Err("The artifact source changed before it could be shared.".into());
    }
    let shared = ProjectSharedFile {
        id: share_id(
            &request.project_id,
            &request.source_run_id,
            &request.source_agent_id,
            &request.artifact_id,
        ),
        project_id: request.project_id.clone(),
        source_run_id: request.source_run_id.clone(),
        source_agent_id: request.source_agent_id.clone(),
        artifact_id: artifact.artifact_id,
        name: artifact.export_name,
        media_type: artifact.mime_type,
        size_bytes: artifact.bytes.len() as u64,
        sha256: artifact.sha256,
        shared_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let authorization =
        command_scope(Some(request.workspace_id.clone()), None, ScopeAccess::Write)?;
    let path = index_path(&computers, &request.project_id);
    crate::store::update_private_workspace_document(
        &path,
        &authorization.private,
        |current: Option<ProjectFileIndex>| {
            let mut index = current.unwrap_or(ProjectFileIndex {
                version: 1,
                project_id: request.project_id.clone(),
                files: vec![],
            });
            if index.version != 1 || index.project_id != request.project_id {
                return Err("The encrypted project file index is invalid.".into());
            }
            if let Some(existing) = index.files.iter().find(|file| file.id == shared.id) {
                return Ok((Some(index.clone()), existing.clone()));
            }
            if index.files.len() >= MAX_SHARED_FILES {
                return Err("This project has reached its 64 shared file limit.".into());
            }
            index.files.push(shared.clone());
            Ok((Some(index), shared.clone()))
        },
    )
}

#[tauri::command]
pub fn local_project_file_list(
    window: tauri::WebviewWindow,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
    request: ListProjectFilesRequest,
) -> Result<Vec<ProjectSharedFile>, String> {
    require_main_window(&window)?;
    validate_id(&request.project_id, "Project")?;
    let authorization = command_scope(Some(request.workspace_id), None, ScopeAccess::Read)?;
    let store = crate::store::try_global().ok_or("Fable's encrypted store is not initialized.")?;
    store
        .with_conn(|tx| {
            local_project::get_project(tx, store, &authorization.private, &request.project_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("The local project was not found.".into())
                })
                .map(|_| ())
        })
        .map_err(|e| e.to_string())?;
    let index: Option<ProjectFileIndex> = crate::store::read_private_workspace_document(
        &index_path(&computers, &request.project_id),
        &authorization.private,
    )?;
    match index {
        None => Ok(vec![]),
        Some(index)
            if index.version == 1
                && index.project_id == request.project_id
                && index.files.len() <= MAX_SHARED_FILES =>
        {
            Ok(index.files)
        }
        _ => Err("The encrypted project file index is invalid.".into()),
    }
}

#[tauri::command]
pub fn local_project_file_unshare(
    window: tauri::WebviewWindow,
    computers: tauri::State<'_, Arc<LocalComputerState>>,
    request: UnshareProjectFileRequest,
) -> Result<UnshareProjectFileResult, String> {
    require_main_window(&window)?;
    validate_id(&request.project_id, "Project")?;
    validate_id(&request.shared_file_id, "Shared file")?;
    project_and_author(
        &request.workspace_id,
        &request.project_id,
        Some(request.expected_project_revision),
        None,
        None,
        &[],
    )?;
    let authorization = command_scope(Some(request.workspace_id), None, ScopeAccess::Write)?;
    crate::store::update_private_workspace_document(
        &index_path(&computers, &request.project_id),
        &authorization.private,
        |current: Option<ProjectFileIndex>| {
            let Some(mut index) = current else {
                return Ok((None, UnshareProjectFileResult { removed: false }));
            };
            if index.version != 1 || index.project_id != request.project_id {
                return Err("The encrypted project file index is invalid.".into());
            }
            let before = index.files.len();
            index.files.retain(|file| file.id != request.shared_file_id);
            let removed = before != index.files.len();
            Ok((Some(index), UnshareProjectFileResult { removed }))
        },
    )
}

fn safe_materialization_path(
    root: &Path,
    shared: &ProjectSharedFile,
) -> Result<(PathBuf, String), String> {
    validate_id(&shared.id, "Shared file")?;
    if shared.name.is_empty()
        || shared.name.len() > 240
        || shared.name.contains(['/', '\\', ':'])
        || shared.name.starts_with('.')
        || shared.name.ends_with([' ', '.'])
    {
        return Err("The shared file name is unsafe.".into());
    }
    let relative = format!("Shared/{}/{}", shared.id, shared.name);
    let target = crate::tools::confine_path(&relative, root)?;
    Ok((target, relative))
}

pub(crate) fn materialize_project_file(
    computers: &LocalComputerState,
    workspace_id: &str,
    target_agent_id: &str,
    expected_generation: u64,
    execution_attempt_id: &str,
    project_id: &str,
    expected_project_revision: i64,
    shared_file_id: &str,
) -> Result<ProjectFileMaterialization, String> {
    for (value, label) in [
        (execution_attempt_id, "Run"),
        (project_id, "Project"),
        (target_agent_id, "Agent"),
        (shared_file_id, "Shared file"),
    ] {
        validate_id(value, label)?;
    }
    project_and_author(
        workspace_id,
        project_id,
        Some(expected_project_revision),
        Some(execution_attempt_id),
        Some(target_agent_id),
        &["queued", "streaming", "awaiting-approval", "retrying"],
    )?;
    let authorization = command_scope(Some(workspace_id.into()), None, ScopeAccess::Read)?;
    let path = index_path(computers, project_id);
    let index: ProjectFileIndex =
        crate::store::read_private_workspace_document(&path, &authorization.private)?
            .ok_or("This project file is no longer shared.")?;
    let shared = index
        .files
        .into_iter()
        .find(|file| file.id == shared_file_id)
        .ok_or("This project file is no longer shared.")?;
    let artifact = verified_artifact_for_project(
        computers,
        workspace_id,
        &shared.source_agent_id,
        &shared.artifact_id,
    )?;
    if artifact.sha256 != shared.sha256 || artifact.bytes.len() as u64 != shared.size_bytes {
        return Err("The shared artifact changed and cannot be materialized.".into());
    }
    let result =
        computers.with_agent_files(workspace_id, target_agent_id, expected_generation, |root| {
            let (target, relative) = safe_materialization_path(root, &shared)?;
            let parent = target
                .parent()
                .ok_or("The shared file destination is invalid.")?;
            fs::create_dir_all(parent)
                .map_err(|_| "Fable could not create the shared file folder.")?;
            if crate::paths::contains_symlink(parent) {
                return Err("The shared file folder contains a symlink or junction.".into());
            }
            if target.exists() {
                let existing = fs::read(&target)
                    .map_err(|_| "The existing shared file could not be checked.")?;
                if existing.len() as u64 == shared.size_bytes
                    && hex::encode(Sha256::digest(&existing)) == shared.sha256
                {
                    return Ok((target, relative, false));
                }
                return Err(
                    "A different file already exists at the shared file destination.".into(),
                );
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(
                    windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
                );
            }
            let mut file = options
                .open(&target)
                .map_err(|_| "Fable could not create the shared file.")?;
            if file
                .write_all(&artifact.bytes)
                .and_then(|_| file.sync_all())
                .is_err()
            {
                let _ = fs::remove_file(&target);
                return Err("Fable could not write the shared file.".into());
            }
            Ok((target, relative, true))
        })?;
    let recheck = project_and_author(
        workspace_id,
        project_id,
        Some(expected_project_revision),
        Some(execution_attempt_id),
        Some(target_agent_id),
        &["queued", "streaming", "awaiting-approval", "retrying"],
    )
    .and_then(|_| {
        crate::store::read_private_workspace_document::<ProjectFileIndex>(
            &path,
            &authorization.private,
        )
        .and_then(|index| {
            if index.is_some_and(|i| {
                i.files
                    .iter()
                    .any(|f| f.id == shared_file_id && f.sha256 == shared.sha256)
            }) {
                Ok(())
            } else {
                Err("This project file was unshared while it was being copied.".into())
            }
        })
    });
    if let Err(error) = recheck {
        if result.2 {
            let _ = fs::remove_file(&result.0);
        }
        return Err(error);
    }
    Ok(ProjectFileMaterialization {
        shared_file_id: shared.id,
        relative_path: result.1,
        name: shared.name,
        media_type: shared.media_type,
        size_bytes: shared.size_bytes,
        sha256: shared.sha256,
    })
}

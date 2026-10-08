//! Managed Git checkouts and isolated build execution. Never a desktop shell.
pub(crate) mod copy_manager;
mod git;
pub(super) mod process;
#[cfg(test)]
mod tests;
use super::{authority::OperationTicket, LocalComputerState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::State;

// JSON escaping may expand a 64 KiB command receipt by up to six times.
const STATE_LIMIT: usize = 512 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub base: String,
    pub base_branch: String,
    pub remote: Option<String>,
    pub operation: String,
    pub last_result: Option<process::CommandResult>,
    pub last_command: Option<String>,
    pub command_diff_id: Option<String>,
    pub publication: Option<String>,
}

fn lock(directory: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    Ok(LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Repository is unavailable.")?
        .entry(directory.to_owned())
        .or_default()
        .clone())
}
fn directory(state: &LocalComputerState, workspace: &str, agent: &str) -> Result<PathBuf, String> {
    let directory = state.scope(workspace, agent)?.directory.join("coding");
    fs::create_dir_all(&directory).map_err(|_| "Repository storage is unavailable.")?;
    crate::paths::strict_canonicalize(&directory)
        .map_err(|_| "Repository storage failed validation.".into())
}
fn save(directory: &Path, repo: &Repository) -> Result<(), String> {
    copy_manager::save_copy(directory, repo)?;
    let bytes = serde_json::to_vec(repo).map_err(|_| "Repository state could not be saved.")?;
    if bytes.len() > STATE_LIMIT {
        return Err("Repository state exceeds its storage limit.".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "Repository state is unavailable.")?;
    file.write_all(&bytes)
        .map_err(|_| "Repository state could not be saved.")?;
    file.flush()
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Repository state could not be saved.")?;
    file.persist(directory.join("repository.json"))
        .map_err(|_| "Repository state could not be saved.")?;
    Ok(())
}
fn load(directory: &Path) -> Result<Option<Repository>, String> {
    let path = directory.join("repository.json");
    if !path.exists() {
        return Ok(None);
    }
    crate::paths::strict_canonicalize(&path).map_err(|_| "Repository state failed validation.")?;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "Repository state is unavailable.")?
        .take((STATE_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Repository state is unreadable.")?;
    if bytes.len() > STATE_LIMIT {
        return Err("Repository state exceeds its storage limit.".into());
    }
    let repo: Repository =
        serde_json::from_slice(&bytes).map_err(|_| "Repository state needs recovery.")?;
    if repo.id.len() != 48 || !repo.id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid repository identity.".into());
    }
    Ok(Some(repo))
}
fn checkout(directory: &Path, repo: &Repository) -> Result<PathBuf, String> {
    let path = directory.join(&repo.id).join("checkout");
    crate::paths::strict_canonicalize(&path).map_err(|_| "Managed checkout needs recovery.".into())
}
fn reconcile_import(
    directory: &Path,
    repo: &mut Repository,
    ticket: &OperationTicket,
) -> Result<Option<mivlet_windows_executor::RepositoryImportRecovery>, String> {
    let recovery = mivlet_windows_executor::recover_repository_import(
        &directory.join(&repo.id).join("checkout"),
        mivlet_windows_executor::Limits::CODING,
        &ticket.execution_binding().scope_id,
        || ticket.check().is_ok(),
        |action| ticket.with_current(action),
    )?;
    if let Some(recovery) = &recovery {
        repo.operation =
            "command import outcome uncertain; inspect and use repository-recover".into();
        repo.command_diff_id = None;
        repo.last_result = Some(process::CommandResult {
            interrupted: true,
            output: format!(
                "{}; no command replayed or staged output imported.",
                recovery.outcome
            ),
            ..Default::default()
        });
        ticket.with_current(|| save(directory, repo))?;
    }
    Ok(recovery)
}
fn status(directory: &Path, ticket: &OperationTicket) -> Result<Value, String> {
    let Some(mut repo) = load(directory)? else {
        return Ok(json!({"repository": null}));
    };
    let mutex = lock(directory)?;
    let guard = mutex.try_lock();
    let busy = guard.is_err();
    let recovery = if busy {
        None
    } else {
        reconcile_import(directory, &mut repo, ticket)?
    };
    let changes = if busy {
        Value::Null
    } else {
        git::changes(directory, &repo, ticket)?
    };
    Ok(
        json!({"repository": repo, "busy": busy, "recoveryRequired": !busy && repo.operation != "idle", "changes": changes, "importRecovery": recovery}),
    )
}

#[tauri::command]
pub async fn coding_repository_status(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Repositories belong to the main window.".into());
    }
    let ticket = state.begin_agent_operation(&workspace_id, &agent_id, expected_generation)?;
    let directory = directory(&state, &workspace_id, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = status(&directory, &ticket);
        ticket.finish(result)
    })
    .await
    .map_err(|_| "Repository inspection stopped.".to_string())?
}

#[tauri::command]
pub async fn coding_repository_attach(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
) -> Result<Option<Repository>, String> {
    if window.label() != "main" {
        return Err("Repository selection belongs to the main window.".into());
    }
    let ticket = state.begin_agent_operation(&workspace_id, &agent_id, expected_generation)?;
    let selected = rfd::AsyncFileDialog::new()
        .set_title(
            "Choose repository — Mivlet copies committed HEAD; existing work stays untouched",
        )
        .pick_folder()
        .await;
    let Some(selected) = selected else {
        return Ok(None);
    };
    ticket.check()?;
    state.validate_target(&workspace_id, &agent_id)?;
    let directory = directory(&state, &workspace_id, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mutex = lock(&directory)?;
        let _guard = mutex.try_lock().map_err(|_| {
            "Stop the running repository operation before attaching another repository."
        })?;
        if load(&directory)?.is_some_and(|repo| repo.operation.starts_with("publication")
            || directory.join(&repo.id).join("native-import.json").exists()) {
            return Err(
                "Recover the current publication or command import before attaching another repository.".into(),
            );
        }
        let repository = git::attach(&directory, selected.path(), &ticket)?;
        ticket.commit(|| {
            copy_manager::register(&directory, &repository, &workspace_id, &agent_id, selected.path())?;
            save(&directory, &repository)?;
            Ok(Some(repository))
        })
    })
    .await
    .map_err(|_| "Repository attachment stopped.".to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    #[serde(default)]
    repository_id: String,
    path: Option<String>,
    content: Option<String>,
    command: Option<String>,
    network: Option<bool>,
    timeout_seconds: Option<u64>,
    expected_diff: Option<String>,
    expected_head: Option<String>,
    message: Option<String>,
    title: Option<String>,
    body: Option<String>,
    remote: Option<String>,
    base_branch: Option<String>,
}

pub(crate) fn execute(
    state: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    tool: &str,
    arguments: Value,
) -> Result<String, String> {
    let ticket = state.begin_agent_operation(workspace, agent, generation)?;
    let directory = directory(state, workspace, agent)?;
    execute_in(&directory, &ticket, tool, arguments)
}
fn execute_in(
    directory: &Path,
    ticket: &OperationTicket,
    tool: &str,
    arguments: Value,
) -> Result<String, String> {
    ticket.check()?;
    let input: Input =
        serde_json::from_value(arguments).map_err(|_| "Invalid repository tool arguments.")?;
    if tool == "repository-status" {
        return serde_json::to_string(&status(directory, ticket)?)
            .map_err(|_| "Invalid repository status.".into());
    }
    let mutex = lock(directory)?;
    let _guard = mutex
        .try_lock()
        .map_err(|_| "A repository operation is running. Wait or Stop it before continuing.")?;
    let mut repo = load(directory)?.ok_or("Attach a repository in Library first.")?;
    if input.repository_id != repo.id {
        return Err(
            "Repository selection changed. Inspect status and request a fresh approval.".into(),
        );
    }
    let import_recovery = reconcile_import(directory, &mut repo, ticket)?;
    if let Some(recovery) = import_recovery {
        if tool == "repository-recover" {
            repo.operation = "idle".into();
            ticket.with_current(|| save(directory, &repo))?;
            mivlet_windows_executor::acknowledge_repository_import(
                &directory.join(&repo.id).join("checkout"),
                mivlet_windows_executor::Limits::CODING,
                &ticket.execution_binding().scope_id,
                || ticket.check().is_ok(),
            )?;
            return serde_json::to_string(&json!({"importRecovery": recovery, "message": "Existing checkout reconciled; uncertainty receipt preserved. Review its diff before continuing. No command was replayed and no staged snapshot was imported."}))
                .map_err(|_| "Invalid import recovery result.".into());
        }
        if tool != "repository-read" {
            return Err("Command import outcome is uncertain. Inspect status and use repository-recover before changing or publishing this checkout.".into());
        }
    }
    if repo.operation.starts_with("publication")
        && !matches!(tool, "repository-read" | "repository-recover")
    {
        return Err("Publication outcome is unknown. Use repository-recover before changing or publishing this checkout; no action was replayed.".into());
    }
    let root = checkout(directory, &repo)?;
    let result = match tool {
        "repository-read" => {
            let path = input
                .path
                .as_deref()
                .ok_or("Supply a relative file path.")?;
            safe_path(path)?;
            json!({"path": path, "content": crate::secret_redaction::redact_secret_text_or_omit(&crate::tools::run_read_file(&json!({"path": path}), &root)?.output)})
        }
        "repository-write" => {
            let path = input
                .path
                .as_deref()
                .ok_or("Supply a relative file path.")?;
            safe_path(path)?;
            let content = input
                .content
                .as_deref()
                .ok_or("Supply file content (empty is allowed).")?;
            if content.len() > 256 * 1024
                || crate::secret_redaction::secret_marker_survives(content)
            {
                return Err(
                    "File content exceeds the limit or contains a credential marker.".into(),
                );
            }
            let target = crate::tools::confine_path(path, &root)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|_| "Cannot create repository directory.")?;
            }
            ticket.with_current(|| {
                fs::write(target, content).map_err(|_| "Cannot write repository file.".to_owned())
            })?;
            json!({"path": path, "bytes": content.len()})
        }
        "repository-run" => {
            let script = input.command.as_deref().ok_or("Supply a command.")?;
            if script.is_empty()
                || script.len() > 8192
                || crate::secret_redaction::secret_marker_survives(script)
            {
                return Err("Supply a bounded command without credentials.".into());
            }
            let timeout = input.timeout_seconds.unwrap_or(300);
            if !(1..=900).contains(&timeout) {
                return Err("Command timeout must be 1–900 seconds.".into());
            }
            repo.operation =
                "command running; if interrupted inspect changes before continuing".into();
            repo.last_result = None;
            repo.last_command = Some(script.to_owned());
            repo.command_diff_id = None;
            save(directory, &repo)?;
            let (result, completed) = match process::native_run(
                &root,
                script,
                input.network.unwrap_or(false),
                timeout,
                false,
                ticket,
            ) {
                Ok(value) => value,
                Err(error) => {
                    repo.operation =
                        "command unavailable or interrupted; no snapshot imported".into();
                    repo.last_result = Some(process::CommandResult {
                        interrupted: true,
                        output: crate::secret_redaction::redact_secret_text_or_omit(&error),
                        ..Default::default()
                    });
                    save(directory, &repo)?;
                    return Err(error);
                }
            };
            let mut committed_import = None;
            if result.exit_code == Some(0) && !result.interrupted {
                let imported = (|| {
                    let prepared =
                        completed.prepare_repository_import(&root, || ticket.check().is_ok())?;
                    ticket.with_current(|| prepared.commit())
                })();
                match imported {
                    Ok(committed) => committed_import = Some(committed),
                    Err(error) => {
                        repo.operation =
                            "command result not imported; inspect before continuing".into();
                        repo.last_result = Some(process::CommandResult {
                            interrupted: true,
                            output: crate::secret_redaction::redact_secret_text_or_omit(&error),
                            ..result
                        });
                        save(directory, &repo)?;
                        return Err(error);
                    }
                }
            }
            repo.operation = if result.interrupted {
                "command interrupted; inspect changes before continuing"
            } else {
                "idle"
            }
            .into();
            repo.last_result = Some(result.clone());
            if !result.interrupted {
                repo.command_diff_id = git::tree(directory, &repo, ticket).ok();
            }
            save(directory, &repo)?;
            if let Some(committed) = committed_import {
                // Keep the durable intent and previous tree until repository
                // state is saved. Cleanup remains outside the Stop fence.
                committed.acknowledge(|| ticket.check().is_ok())?;
            }
            serde_json::to_value(result).map_err(|_| "Invalid command result.")?
        }
        "repository-commit" => git::commit(directory, &mut repo, &input, ticket)?,
        "repository-publish" => git::publish(directory, &mut repo, &input, ticket)?,
        "repository-recover" => git::recover(directory, &mut repo, ticket)?,
        _ => return Err("Unknown repository operation.".into()),
    };
    ticket.check()?;
    serde_json::to_string(&result).map_err(|_| "Invalid repository result.".into())
}
pub(super) fn safe_path(path: &str) -> Result<(), String> {
    if path.split(['/', '\\']).any(|part| {
        part.eq_ignore_ascii_case(".git")
            || part.eq_ignore_ascii_case(".env")
            || part.to_ascii_lowercase().starts_with(".env.")
            || part.ends_with(".pem")
            || part.ends_with(".key")
    }) || path.contains(':')
    {
        return Err(
            "Git internals and credential files are not available to repository file tools.".into(),
        );
    }
    Ok(())
}

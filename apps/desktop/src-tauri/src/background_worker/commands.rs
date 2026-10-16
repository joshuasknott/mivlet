//! Approved commands use the existing native tool/ticket/job authority inside
//! the detached process. This module never creates or widens an approval.
use crate::tools::{ToolExecutionRequest, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs::File, sync::Arc, time::Duration};
use tauri::Manager;

pub(crate) fn supported(tool: &str) -> bool {
    matches!(
        tool,
        "repository-run"
            | "repository-start"
            | "workspace-run"
            | "workspace-start"
            | "command-jobs"
            | "command-output"
            | "command-stop"
    )
}

pub(crate) fn enabled() -> Result<bool, String> {
    if !cfg!(windows) || super::is_worker() {
        return Ok(false);
    }
    crate::account_session::ensure_current()?;
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    super::enabled(store)
}

pub(crate) fn should_route(tool: &str) -> Result<bool, String> {
    Ok(supported(tool) && enabled()?)
}

pub(crate) fn with_authority<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if !super::is_worker() {
        return operation();
    }
    crate::account_session::ensure_current()?;
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    store
        .transaction(|conn| {
            if super::stopping()
                || !super::enabled_at(conn, store)?
                || !crate::execution_control::allowed_at(conn, store)?
            {
                return Err(crate::store::StoreError::Invalid(
                    "Background command authority was revoked.".into(),
                ));
            }
            operation().map_err(crate::store::StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

/// Kept through a foreground dispatch. Start cannot move ownership while an
/// already admitted foreground command is crossing into its native job manager.
pub(crate) fn foreground_fence(tool: &str) -> Result<Option<File>, String> {
    if !cfg!(windows) || super::is_worker() || !supported(tool) {
        return Ok(None);
    }
    crate::local_computer::leases::acquire_shared(
        &crate::account_session::root()?.join("background-command-handoff.lock"),
        Duration::ZERO,
    )
    .map(Some)
}
pub(crate) fn handoff_fence() -> Result<File, String> {
    crate::local_computer::leases::acquire(
        &crate::account_session::root()?.join("background-command-handoff.lock"),
        Duration::ZERO,
    )
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Action {
    Scope {
        workspace: String,
        agent: String,
    },
    Tool {
        request: Box<ToolExecutionRequest>,
    },
    View {
        workspace: String,
        agent: String,
        generation: u64,
        tool: String,
        job_id: Option<String>,
        job_generation: Option<u64>,
        cursor: u64,
    },
}

pub(crate) async fn execute(request: ToolExecutionRequest) -> Result<ToolResult, String> {
    if !supported(&request.tool) {
        return Err("This tool has no background command route.".into());
    }
    serde_json::from_value(
        call(Action::Tool {
            request: Box::new(request),
        })
        .await?,
    )
    .map_err(|_| "Invalid background command receipt.".into())
}

pub(crate) async fn prepare_scope(workspace: &str, agent: &str) -> Result<(), String> {
    call(Action::Scope {
        workspace: workspace.into(),
        agent: agent.into(),
    })
    .await
    .map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn view(
    workspace: String,
    agent: String,
    generation: u64,
    tool: &str,
    job_id: Option<String>,
    job_generation: Option<u64>,
    cursor: u64,
) -> Result<Value, String> {
    call(Action::View {
        workspace,
        agent,
        generation,
        tool: tool.into(),
        job_id,
        job_generation,
        cursor,
    })
    .await
}

async fn call(action: Action) -> Result<Value, String> {
    if !super::ready() {
        return Err("The background command owner is unavailable. Start or reconnect it in General settings; this request was not replayed.".into());
    }
    #[cfg(windows)]
    {
        super::command_ipc::request(action).await
    }
    #[cfg(not(windows))]
    {
        let _ = action;
        Err("Background commands require Windows.".into())
    }
}

pub(super) async fn dispatch(app: &tauri::AppHandle, action: Action) -> Result<Value, String> {
    crate::account_session::ensure_current()?;
    let store = crate::store::try_global().ok_or("Account storage is unavailable.")?;
    if !super::is_worker() || super::stopping() || !super::enabled(store)? {
        return Err("Background command authority was revoked.".into());
    }
    let state = app.state::<Arc<crate::local_computer::LocalComputerState>>();
    state.refresh_background_plugins()?;
    match action {
        Action::Scope { workspace, agent } => {
            state.validate_target(&workspace, &agent)?;
            let snapshot = state.authority_for(&workspace, &agent)?.snapshot()?;
            Ok(serde_json::json!({"generation":snapshot.generation}))
        }
        Action::Tool { request } => {
            if !supported(&request.tool) {
                return Err("This tool has no background command route.".into());
            }
            serde_json::to_value(
                crate::tools::execute_background_tool(app.clone(), *request, state).await?,
            )
            .map_err(|_| "Background command receipt could not be encoded.".into())
        }
        Action::View {
            workspace,
            agent,
            generation,
            tool,
            job_id,
            job_generation,
            cursor,
        } => {
            if !matches!(
                tool.as_str(),
                "command-jobs" | "command-output" | "command-stop"
            ) {
                return Err("Invalid native command control.".into());
            }
            crate::local_computer::command_jobs::observe(
                state.inner().clone(),
                workspace,
                agent,
                generation,
                tool,
                job_id,
                job_generation,
                cursor,
            )
            .await
        }
    }
}

pub(super) async fn monitor(app: tauri::AppHandle) {
    while !super::stopping() {
        let state = app.state::<Arc<crate::local_computer::LocalComputerState>>();
        if crate::account_session::ensure_current().is_err()
            || crate::execution_control::ensure_active_execution_allowed().is_err()
            || crate::store::try_global()
                .is_none_or(|store| !super::enabled(store).unwrap_or(false))
            || state.refresh_background_plugins().is_err()
        {
            super::stop();
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_never_admits_host_shell_or_unrelated_tools() {
        for tool in [
            "run-shell",
            "local-desktop-action",
            "repository-publish",
            "write-file",
            "unknown",
        ] {
            assert!(!supported(tool));
        }
        for tool in ["repository-run", "workspace-start", "command-stop"] {
            assert!(supported(tool));
        }
        assert!(serde_json::from_value::<Action>(
            serde_json::json!({"kind":"shell","command":"ignored"})
        )
        .is_err());
    }
}

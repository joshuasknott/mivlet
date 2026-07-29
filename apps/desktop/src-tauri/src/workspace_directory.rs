//! Secret-free Tauri boundary for the local hosted-workspace directory.
//!
//! A later authenticated runtime bridge supplies only summaries already
//! authorized by the Fable control plane. This module deliberately has no
//! Clerk credential access and does not make local-only storage depend on
//! hosted identity being configured.

use chrono::{SecondsFormat, Utc};
use serde::Serialize;

use crate::store::repos::workspace_directory as repo;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryState {
    account_bound: bool,
    workspaces: Vec<repo::WorkspaceDirectorySummary>,
    active_workspace: repo::ActiveWorkspaceSelection,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[tauri::command]
pub fn list_workspace_directory() -> Result<WorkspaceDirectoryState, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| {
            let workspaces = repo::list_authoritative_summaries_for_current_user(conn)?;
            let account_bound = workspaces.is_some();
            let active_workspace = repo::selected_active_workspace_for_current_user(conn)?
                .unwrap_or_else(repo::unbound_workspace_selection);
            // The account id stays inside the native store. The directory
            // response is intentionally empty until the authenticated adapter
            // has established that binding.
            let workspaces = workspaces.unwrap_or_default();
            Ok(WorkspaceDirectoryState {
                account_bound,
                workspaces,
                active_workspace,
            })
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn select_active_workspace(
    fable_workspace_id: String,
) -> Result<repo::ActiveWorkspaceSelection, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|conn| {
            repo::select_active_workspace_for_current_user(conn, &fable_workspace_id, &now())
        })
        .map_err(|error| error.to_string())
}

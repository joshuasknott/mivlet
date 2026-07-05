//! Optional cloud-team sync command boundary.
//!
//! Batch 7A deliberately stops before a live Convex network adapter. These
//! commands expose secret-free status, link state, local outbox enqueue, and
//! fail-closed flush/pull readiness while preserving solo startup when config
//! is absent.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::repos::cloud_sync as repo;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    configured: bool,
    linked: bool,
    state: String,
    message: String,
    link: Option<repo::CloudWorkspaceLink>,
    queued_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncFlushResult {
    phase: String,
    queued_count: usize,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncPullResult {
    phase: String,
    last_pulled_revision: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncEnqueueRequest {
    local_workspace_id: String,
    local_mutation_id: String,
    client_mutation_id: String,
    base_revision: i64,
    record_type: String,
    record_id: String,
    operation: String,
    payload: Value,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn config_ready() -> bool {
    let convex = std::env::var("FABLE_CONVEX_URL")
        .or_else(|_| std::env::var("VITE_CONVEX_URL"))
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    let clerk = std::env::var("FABLE_CLERK_ISSUER")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    convex && clerk
}

#[tauri::command]
pub fn cloud_sync_status(workspace_id: String) -> Result<CloudSyncStatus, String> {
    let configured = config_ready();
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let (link, queued_count) = store
        .with_conn(|conn| {
            let link = repo::get_link(conn, &workspace_id)?;
            let queued_count = repo::list_queued(conn, store, &workspace_id)?.len();
            Ok((link, queued_count))
        })
        .map_err(|error| error.to_string())?;
    let linked = link.is_some();
    let state = if !configured {
        "disabled"
    } else {
        link.as_ref()
            .map(|link| link.sync_state.as_str())
            .unwrap_or("unlinked")
    }
    .to_string();
    let message = if !configured {
        "Cloud team sync is disabled until Clerk and Convex configuration are present."
    } else if !linked {
        "This local workspace is not linked to a shared cloud workspace."
    } else {
        "Cloud team sync link state is available."
    }
    .to_string();
    Ok(CloudSyncStatus {
        configured,
        linked,
        state,
        message,
        link,
        queued_count,
    })
}

#[tauri::command]
pub fn cloud_sync_link_state(
    workspace_id: String,
) -> Result<Option<repo::CloudWorkspaceLink>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| repo::get_link(conn, &workspace_id))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cloud_sync_enqueue_shared_mutation(
    request: CloudSyncEnqueueRequest,
) -> Result<repo::CloudMutationOutboxRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let input = repo::EnqueueMutationInput {
        local_workspace_id: request.local_workspace_id,
        local_mutation_id: request.local_mutation_id,
        client_mutation_id: request.client_mutation_id,
        base_revision: request.base_revision,
        record_type: request.record_type,
        record_id: request.record_id,
        operation: request.operation,
        payload: request.payload,
    };
    store
        .transaction(|tx| repo::enqueue_mutation(tx, store, &input, &now()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cloud_sync_flush_outbox(workspace_id: String) -> Result<CloudSyncFlushResult, String> {
    let configured = config_ready();
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let (link, queued_count) = store
        .with_conn(|conn| {
            let link = repo::get_link(conn, &workspace_id)?;
            let queued_count = repo::list_queued(conn, store, &workspace_id)?.len();
            Ok((link, queued_count))
        })
        .map_err(|error| error.to_string())?;
    if !configured {
        return Ok(CloudSyncFlushResult {
            phase: "disabled".into(),
            queued_count,
            message:
                "Cloud sync flush is disabled until Clerk and Convex configuration are present."
                    .into(),
        });
    }
    match link {
        None => Ok(CloudSyncFlushResult {
            phase: "unlinked".into(),
            queued_count,
            message: "This workspace is not linked to a shared cloud workspace.".into(),
        }),
        Some(link) if link.sync_state != "active" => Ok(CloudSyncFlushResult {
            phase: "blocked".into(),
            queued_count,
            message: "Cloud sync flush is blocked until this device or workspace link is active.".into(),
        }),
        Some(_) => Ok(CloudSyncFlushResult {
            phase: "adapter-unavailable".into(),
            queued_count,
            message: "The local outbox is ready; the live Convex network adapter is deferred to the product slice.".into(),
        }),
    }
}

#[tauri::command]
pub fn cloud_sync_pull_after_cursor(workspace_id: String) -> Result<CloudSyncPullResult, String> {
    let configured = config_ready();
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let link = store
        .with_conn(|conn| repo::get_link(conn, &workspace_id))
        .map_err(|error| error.to_string())?;
    if !configured {
        return Ok(CloudSyncPullResult {
            phase: "disabled".into(),
            last_pulled_revision: 0,
            message:
                "Cloud sync pull is disabled until Clerk and Convex configuration are present."
                    .into(),
        });
    }
    let Some(link) = link else {
        return Ok(CloudSyncPullResult {
            phase: "unlinked".into(),
            last_pulled_revision: 0,
            message: "This workspace is not linked to a shared cloud workspace.".into(),
        });
    };
    let cursor = store
        .with_conn(|conn| repo::get_cursor(conn, &workspace_id, &link.linked_device_id))
        .map_err(|error| error.to_string())?;
    Ok(CloudSyncPullResult {
        phase: if link.sync_state == "active" {
            "adapter-unavailable"
        } else {
            "blocked"
        }
        .into(),
        last_pulled_revision: cursor
            .as_ref()
            .map(|cursor| cursor.last_pulled_revision)
            .unwrap_or(link.last_accepted_revision),
        message: "The local cursor is ready; the live Convex pull adapter is deferred to the product slice.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_keeps_cloud_sync_disabled() {
        std::env::remove_var("FABLE_CONVEX_URL");
        std::env::remove_var("VITE_CONVEX_URL");
        std::env::remove_var("FABLE_CLERK_ISSUER");
        assert!(!config_ready());
    }
}

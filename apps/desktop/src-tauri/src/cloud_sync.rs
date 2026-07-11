//! Optional cloud-team sync command boundary.
//!
//! Batch 7A deliberately stops before a live Convex network adapter. These
//! commands expose secret-free status, link state, local outbox enqueue, and
//! fail-closed flush/pull readiness while preserving solo startup when config
//! is absent.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;

use crate::clerk_identity::{self, ConvexFunctionType, ConvexIdentityCallRequest};
use crate::store::repos::cloud_sync as repo;
use crate::store::repos::workspace_directory;

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

fn flush_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn authorized_workspace(
    requested_workspace_id: &str,
) -> Result<workspace_directory::AuthorizedWorkspaceContext, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(conn)?;
            if context.active_workspace.local_workspace_id != requested_workspace_id {
                return Err(crate::store::StoreError::Invalid(
                    "The selected workspace changed.".into(),
                ));
            }
            Ok(context)
        })
        .map_err(|error| error.to_string())
}

fn authorized_link(requested_workspace_id: &str) -> Result<repo::CloudWorkspaceLink, String> {
    let context = authorized_workspace(requested_workspace_id)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|conn| {
            let link = repo::get_link(conn, requested_workspace_id)?.ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "This workspace is not linked to cloud sync.".into(),
                )
            })?;
            if context.active_workspace.fable_workspace_id.as_deref()
                != Some(&link.fable_workspace_id)
                || context.internal_user_id != link.internal_user_id
                || context.member_id.as_deref() != Some(&link.member_id)
            {
                return Err(crate::store::StoreError::Invalid(
                    "The cloud link no longer matches the signed-in workspace.".into(),
                ));
            }
            Ok(link)
        })
        .map_err(|error| error.to_string())
}

async fn hosted_call(
    function_type: ConvexFunctionType,
    path: &str,
    args: Value,
) -> Result<Value, String> {
    let envelope = clerk_identity::call_convex(ConvexIdentityCallRequest {
        function_type,
        function_path: path.to_string(),
        args,
    })
    .await?;
    let object = envelope
        .as_object()
        .ok_or_else(|| "The hosted sync response is malformed.".to_string())?;
    if object.len() != 2 || object.get("status").and_then(Value::as_str) != Some("success") {
        return Err("The hosted sync request was rejected.".into());
    }
    object
        .get("value")
        .cloned()
        .ok_or_else(|| "The hosted sync response omitted its value.".into())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum HostedMutationResult {
    Accepted {
        #[serde(rename = "workspaceRevision")]
        workspace_revision: i64,
        #[serde(default)]
        record: Option<repo::AcceptedSharedProject>,
        #[serde(default)]
        tombstone: Option<repo::AcceptedSharedTombstone>,
    },
    Rejected {
        code: String,
        #[serde(rename = "message")]
        _message: String,
        #[serde(default, rename = "currentRecord")]
        current_record: Option<repo::AcceptedSharedProject>,
    },
    Conflict {
        code: String,
        #[serde(rename = "message")]
        _message: String,
        #[serde(default, rename = "currentRecord")]
        current_record: Option<repo::AcceptedSharedProject>,
    },
}

fn valid_rejection_code(status: &str, code: &str) -> bool {
    let allowed = [
        "permission-denied",
        "membership-inactive",
        "device-inactive",
        "stale-revision",
        "idempotency-conflict",
        "conflict",
    ];
    matches!(status, "rejected" | "conflict") && allowed.contains(&code)
}

fn validate_hosted_record(record: &repo::AcceptedSharedProject) -> Result<(), String> {
    if record.authority != "convex"
        || record.visibility != "workspace-shared"
        || record.schema_version != 1
        || record.lifecycle != "active"
        || record.workspace_revision != record.revision
    {
        return Err("The hosted shared project constants are invalid.".into());
    }
    Ok(())
}

fn same_sync_authority(
    expected: &repo::CloudWorkspaceLink,
    current: &repo::CloudWorkspaceLink,
) -> bool {
    expected.local_workspace_id == current.local_workspace_id
        && expected.fable_workspace_id == current.fable_workspace_id
        && expected.internal_user_id == current.internal_user_id
        && expected.member_id == current.member_id
        && expected.device_id == current.device_id
        && current.sync_state == "active"
}

fn reauthorize_sync(
    expected: &repo::CloudWorkspaceLink,
) -> Result<repo::CloudWorkspaceLink, String> {
    let current = authorized_link(&expected.local_workspace_id)?;
    if !same_sync_authority(expected, &current) {
        return Err("The signed-in cloud workspace changed during synchronization.".into());
    }
    Ok(current)
}

fn settlement_from_hosted(result: HostedMutationResult) -> Result<repo::Settlement, String> {
    match result {
        HostedMutationResult::Accepted {
            workspace_revision,
            record: Some(record),
            tombstone: None,
        } => {
            validate_hosted_record(&record)?;
            if record.workspace_revision != workspace_revision {
                return Err("The hosted mutation revision is inconsistent.".into());
            }
            Ok(repo::Settlement::Record {
                workspace_revision,
                record,
            })
        }
        HostedMutationResult::Accepted {
            workspace_revision,
            record: None,
            tombstone: Some(tombstone),
        } if tombstone.revision == workspace_revision => Ok(repo::Settlement::Tombstone {
            workspace_revision,
            tombstone,
        }),
        HostedMutationResult::Accepted { .. } => {
            Err("The hosted mutation response is ambiguous.".into())
        }
        HostedMutationResult::Rejected {
            code,
            current_record,
            ..
        } => {
            if !valid_rejection_code("rejected", &code) {
                return Err("The hosted mutation rejection is invalid.".into());
            }
            if let Some(record) = current_record.as_ref() {
                validate_hosted_record(record)?;
            }
            Ok(repo::Settlement::Rejected {
                status: "rejected".into(),
                code,
                server_revision: current_record.map(|record| record.revision).unwrap_or(0),
            })
        }
        HostedMutationResult::Conflict {
            code,
            current_record,
            ..
        } => {
            if !valid_rejection_code("conflict", &code) {
                return Err("The hosted mutation conflict is invalid.".into());
            }
            if let Some(record) = current_record.as_ref() {
                validate_hosted_record(record)?;
            }
            Ok(repo::Settlement::Rejected {
                status: "conflict".into(),
                code,
                server_revision: current_record.map(|record| record.revision).unwrap_or(0),
            })
        }
    }
}

#[tauri::command]
pub fn cloud_sync_status(workspace_id: String) -> Result<CloudSyncStatus, String> {
    let configured = config_ready();
    if !configured {
        return Ok(CloudSyncStatus {
            configured: false,
            linked: false,
            state: "disabled".into(),
            message:
                "Cloud team sync is disabled until Clerk and Convex configuration are present."
                    .into(),
            link: None,
            queued_count: 0,
        });
    }
    let _context = authorized_workspace(&workspace_id)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let link = store
        .with_conn(|conn| repo::get_link(conn, &workspace_id))
        .map_err(|error| error.to_string())?;
    let link = match link {
        Some(_) => Some(authorized_link(&workspace_id)?),
        None => None,
    };
    let queued_count = store
        .with_conn(|conn| repo::list_queued(conn, store, &workspace_id).map(|rows| rows.len()))
        .map_err(|error| error.to_string())?;
    let linked = link.is_some();
    let state = link
        .as_ref()
        .map(|link| link.sync_state.as_str())
        .unwrap_or("unlinked")
        .to_string();
    let message = if !linked {
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
    if !config_ready() {
        return Ok(None);
    }
    let _context = authorized_workspace(&workspace_id)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let link = store
        .with_conn(|conn| repo::get_link(conn, &workspace_id))
        .map_err(|error| error.to_string())?;
    match link {
        Some(_) => authorized_link(&workspace_id).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn cloud_sync_enqueue_shared_mutation(
    request: CloudSyncEnqueueRequest,
) -> Result<repo::CloudMutationOutboxRow, String> {
    let _link = authorized_link(&request.local_workspace_id)?;
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
pub async fn cloud_sync_flush_outbox(workspace_id: String) -> Result<CloudSyncFlushResult, String> {
    let configured = config_ready();
    if !configured {
        return Ok(CloudSyncFlushResult {
            phase: "disabled".into(),
            queued_count: 0,
            message:
                "Cloud sync flush is disabled until Clerk and Convex configuration are present."
                    .into(),
        });
    }
    let _context = authorized_workspace(&workspace_id)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let link = store
        .with_conn(|conn| repo::get_link(conn, &workspace_id))
        .map_err(|error| error.to_string())?;
    let verified_link = match link.as_ref() {
        Some(_) => Some(authorized_link(&workspace_id)?),
        None => None,
    };
    let queued_count = store
        .with_conn(|conn| repo::list_queued(conn, store, &workspace_id).map(|rows| rows.len()))
        .map_err(|error| error.to_string())?;
    match link {
        None => Ok(CloudSyncFlushResult {
            phase: "unlinked".into(),
            queued_count,
            message: "This workspace is not linked to a shared cloud workspace.".into(),
        }),
        Some(link) if link.sync_state != "active" => Ok(CloudSyncFlushResult {
            phase: "blocked".into(),
            queued_count,
            message: "Cloud sync flush is blocked until this device or workspace link is active."
                .into(),
        }),
        Some(_) => {
            let link = verified_link
                .ok_or_else(|| "The cloud workspace link became unavailable.".to_string())?;
            // Serialize flushes inside the desktop process. A waiter re-reads the
            // pending outbox after the active flush settles, so one intent is
            // never sent twice concurrently while restart recovery stays pending.
            let _flush_guard = flush_lock().lock().await;
            let link = reauthorize_sync(&link)?;
            let queued = store
                .with_conn(|conn| repo::list_queued(conn, store, &workspace_id))
                .map_err(|error| error.to_string())?;
            let mut remaining = queued.len();
            for row in queued {
                store
                    .transaction(|tx| repo::mark_attempt(tx, &row.local_mutation_id, &now()))
                    .map_err(|error| error.to_string())?;
                let mut args = json!({
                    "workspaceId": link.fable_workspace_id,
                    "deviceId": link.device_id,
                    "clientMutationId": row.client_mutation_id,
                    "idempotencyKey": row.idempotency_key,
                    "intentFingerprint": row.intent_fingerprint,
                    "baseRevision": row.base_revision,
                    "recordType": row.record_type,
                    "recordId": row.record_id,
                    "operation": row.operation,
                });
                if !row.payload.is_null() {
                    args.as_object_mut()
                        .unwrap()
                        .insert("payload".into(), row.payload.clone());
                }
                let hosted = hosted_call(
                    ConvexFunctionType::Mutation,
                    "mutations:applyOutboxMutation",
                    args,
                )
                .await
                .map_err(|error| {
                    format!("Cloud sync is blocked; queued changes remain pending. {error}")
                })?;
                reauthorize_sync(&link)?;
                let result: HostedMutationResult = serde_json::from_value(hosted)
                    .map_err(|_| "The hosted mutation response is malformed.".to_string())?;
                let settlement = settlement_from_hosted(result)?;
                let settled = store
                    .transaction(|tx| {
                        repo::settle_mutation(tx, store, &row.local_mutation_id, settlement, &now())
                    })
                    .map_err(|error| error.to_string())?;
                remaining = remaining.saturating_sub(1);
                if settled == "conflict" || settled == "rejected" {
                    break;
                }
            }
            Ok(CloudSyncFlushResult {
                phase: if remaining == 0 { "synced" } else { "blocked" }.into(),
                queued_count: remaining,
                message: if remaining == 0 {
                    "Shared changes are up to date."
                } else {
                    "A shared change needs repair before later changes can sync."
                }
                .into(),
            })
        }
    }
}

#[tauri::command]
pub async fn cloud_sync_pull_after_cursor(
    workspace_id: String,
) -> Result<CloudSyncPullResult, String> {
    let configured = config_ready();
    if !configured {
        return Ok(CloudSyncPullResult {
            phase: "disabled".into(),
            last_pulled_revision: 0,
            message:
                "Cloud sync pull is disabled until Clerk and Convex configuration are present."
                    .into(),
        });
    }
    let _context = authorized_workspace(&workspace_id)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let link = store
        .with_conn(|conn| repo::get_link(conn, &workspace_id))
        .map_err(|error| error.to_string())?;
    let Some(link) = link else {
        return Ok(CloudSyncPullResult {
            phase: "unlinked".into(),
            last_pulled_revision: 0,
            message: "This workspace is not linked to a shared cloud workspace.".into(),
        });
    };
    let verified_link = authorized_link(&workspace_id)?;
    let cursor = store
        .with_conn(|conn| repo::get_cursor(conn, &workspace_id, &link.device_id))
        .map_err(|error| error.to_string())?;
    if link.sync_state != "active" {
        return Ok(CloudSyncPullResult {
            phase: "blocked".into(),
            last_pulled_revision: cursor
                .as_ref()
                .map(|cursor| cursor.last_pulled_revision)
                .unwrap_or(link.last_accepted_revision),
            message: "Cloud sync is blocked until this workspace and device link are active."
                .into(),
        });
    }
    let link = verified_link;
    let after_revision = cursor
        .as_ref()
        .map(|cursor| cursor.last_pulled_revision)
        .unwrap_or(0);
    let value = hosted_call(
        ConvexFunctionType::Query,
        "viewer:getWorkspaceDelta",
        json!({
            "workspaceId": link.fable_workspace_id, "afterRevision": after_revision
        }),
    )
    .await
    .map_err(|error| format!("Cloud sync is blocked; the local cursor was not changed. {error}"))?;
    reauthorize_sync(&link)?;
    let delta: repo::WorkspaceDelta = serde_json::from_value(value)
        .map_err(|_| "The hosted workspace delta is malformed.".to_string())?;
    let revision = store
        .transaction(|tx| repo::apply_workspace_delta(tx, store, &workspace_id, &delta, &now()))
        .map_err(|error| error.to_string())?;
    Ok(CloudSyncPullResult {
        phase: "synced".into(),
        last_pulled_revision: revision,
        message: "Shared project updates are up to date.".into(),
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

    #[tokio::test]
    async fn flush_lock_excludes_a_concurrent_sender() {
        let first = flush_lock().lock().await;
        assert!(flush_lock().try_lock().is_err());
        drop(first);
        assert!(flush_lock().try_lock().is_ok());
    }

    #[test]
    fn hosted_settlement_rejects_noncanonical_project_constants() {
        let canonical = json!({
            "status": "accepted",
            "workspaceRevision": 4,
            "record": {
                "id": "project-a", "workspaceId": "fable-ws", "authority": "convex",
                "visibility": "workspace-shared", "schemaVersion": 1, "revision": 4,
                "workspaceRevision": 4, "createdByInternalUserId": "user-a",
                "createdByDeviceId": "device-a", "createdAt": "t0", "updatedAt": "t1",
                "title": "Launch", "lifecycle": "active"
            }
        });
        let parsed = serde_json::from_value::<HostedMutationResult>(canonical.clone()).unwrap();
        assert!(settlement_from_hosted(parsed).is_ok());
        let mut invalid = canonical;
        invalid["record"]["authority"] = json!("local");
        let parsed = serde_json::from_value::<HostedMutationResult>(invalid).unwrap();
        assert!(settlement_from_hosted(parsed).is_err());
    }

    #[test]
    fn hosted_rejection_codes_are_closed() {
        assert!(valid_rejection_code("rejected", "permission-denied"));
        assert!(valid_rejection_code("conflict", "stale-revision"));
        assert!(!valid_rejection_code("rejected", "server-error"));
        assert!(!valid_rejection_code("accepted", "conflict"));
    }

    #[test]
    fn workspace_or_account_switch_invalidates_sync_authority() {
        let expected = repo::CloudWorkspaceLink {
            local_workspace_id: "local-a".into(),
            fable_workspace_id: "workspace-a".into(),
            internal_user_id: "user-a".into(),
            member_id: "member-a".into(),
            device_id: "device-a".into(),
            role: "editor".into(),
            sync_state: "active".into(),
            last_accepted_revision: 3,
            linked_at: "t0".into(),
            updated_at: "t0".into(),
        };
        assert!(same_sync_authority(&expected, &expected));
        for (field, value) in [
            ("workspace", "workspace-b"),
            ("user", "user-b"),
            ("member", "member-b"),
            ("device", "device-b"),
            ("state", "revoked"),
        ] {
            let mut current = expected.clone();
            match field {
                "workspace" => current.fable_workspace_id = value.into(),
                "user" => current.internal_user_id = value.into(),
                "member" => current.member_id = value.into(),
                "device" => current.device_id = value.into(),
                _ => current.sync_state = value.into(),
            }
            assert!(!same_sync_authority(&expected, &current));
        }
    }
}

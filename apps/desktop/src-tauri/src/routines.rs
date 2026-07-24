//! Authenticated native Routine commands and legacy evidence capture.
//!
//! Renderer workspace/owner fields are assertions only. The native account
//! directory supplies the active workspace, member, and internal-user identity
//! used by every repository write.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

use crate::authorized_scope::{self, ScopeAccess};
use crate::store::repos::{
    routine::{self, RoutineBundleRow},
    routine_migration::{self, MigrationBatchSummary},
    schedule, scheduled_job, scheduler_queue, workflow,
};

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn secure_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| format!("Fable could not create a secure {prefix} id."))?;
    Ok(format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn checksum(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| "Fable could not encode legacy Routine evidence.".to_string())?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn scope_for(
    tx: &rusqlite::Connection,
    project_id: Option<&str>,
    access: ScopeAccess,
) -> crate::store::Result<authorized_scope::AuthorizedCommandScope> {
    let context =
        crate::store::repos::workspace_directory::require_active_workspace_context_for_current_user(
            tx,
        )?;
    authorized_scope::resolve(
        tx,
        Some(&context.active_workspace.local_workspace_id),
        project_id,
        access,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineCreateInput {
    project_id: Option<String>,
    title: String,
    instruction: String,
    trigger: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineEditInput {
    project_id: Option<String>,
    routine_id: String,
    expected_revision: i64,
    title: String,
    instruction: String,
    trigger: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineTransitionInput {
    project_id: Option<String>,
    routine_id: String,
    expected_revision: i64,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineReadInput {
    project_id: Option<String>,
    routine_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineListInput {
    project_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineConnectionOption {
    connection_id: String,
    display_name: String,
    health_state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineOccurrenceInput {
    project_id: Option<String>,
    occurrence: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineMigrationCaptureInput {
    project_id: Option<String>,
    planned_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineMigrationApplyInput {
    project_id: Option<String>,
    batch_id: Option<String>,
    evidence: Value,
    plan: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineMigrationReplayInput {
    project_id: Option<String>,
    batch_id: String,
    evidence: Value,
    plan: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineMigrationRollbackInput {
    project_id: Option<String>,
    batch_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineDriverLeaseInput {
    project_id: Option<String>,
    occurrence_id: String,
    writer_epoch: i64,
    lease_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineDriverAttemptInput {
    project_id: Option<String>,
    occurrence_id: String,
    writer_epoch: i64,
    lease_token: String,
    run_id: String,
    attempt_number: i64,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineSchedulerCommandInput {
    project_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSchedulerStatus {
    authority: routine::SchedulerAuthorityRow,
    ready_for_cutover: bool,
    blockers: Vec<String>,
    active_legacy_jobs: usize,
    mapped_legacy_jobs: usize,
    future_legacy_occurrences: usize,
    terminal_legacy_occurrences: usize,
    routine_driver_occurrences: usize,
    reconciliation_hash: Option<String>,
}

fn validate_trigger_authority(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &authorized_scope::AuthorizedCommandScope,
    trigger: &Value,
) -> crate::store::Result<()> {
    if trigger.get("kind").and_then(Value::as_str) != Some("connection-event") {
        return Ok(());
    }
    if auth.data.project_id().is_some() {
        return Err(crate::store::StoreError::Invalid(
            "Connection-event Routines must use workspace scope.".into(),
        ));
    }
    let object = trigger.as_object().ok_or_else(|| {
        crate::store::StoreError::Invalid("Connection-event trigger is invalid.".into())
    })?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "kind" | "connectionId" | "eventType"))
    {
        return Err(crate::store::StoreError::Invalid(
            "Connection-event trigger contains unsupported fields.".into(),
        ));
    }
    let connection_id = trigger
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Connection-event trigger requires one Connection.".into(),
            )
        })?;
    let event_type = trigger
        .get("eventType")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Connection-event trigger requires one event type.".into(),
            )
        })?;
    if !matches!(
        event_type,
        "mcp.tools.list_changed" | "mcp.resources.list_changed"
    ) {
        return Err(crate::store::StoreError::Invalid(
            "This Connection event is not supported by the local adapter.".into(),
        ));
    }
    let connection =
        crate::store::repos::connection_record::get_private_owned(tx, store, auth, connection_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("The selected Connection is unavailable.".into())
            })?;
    if connection.kind != "mcp"
        || connection.lifecycle != "authorized"
        || !matches!(
            connection.authorization_state.as_str(),
            "authorized" | "not-required"
        )
        || !matches!(
            connection.credential_state.as_str(),
            "available" | "not-required"
        )
    {
        return Err(crate::store::StoreError::Invalid(
            "The selected tool-server Connection is not ready.".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn routine_create(input: RoutineCreateInput) -> Result<RoutineBundleRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            let member_id = auth.member_id.as_deref().ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active member is required to create a Routine.".into(),
                )
            })?;
            validate_trigger_authority(tx, store, &auth, &input.trigger)?;
            let at = now();
            let routine_id = secure_id("routine").map_err(crate::store::StoreError::Invalid)?;
            let trigger_id = secure_id("trigger").map_err(crate::store::StoreError::Invalid)?;
            let scope = serde_json::json!({"projectId":auth.data.project_id()});
            let routine = serde_json::json!({
                "id":routine_id,
                "workspaceId":auth.data.workspace_id(),
                "authority":"local",
                "schemaVersion":1,
                "revision":1,
                "createdByInternalUserId":auth.internal_user_id,
                "createdAt":at,
                "updatedAt":at,
                "visibility":"member-private",
                "ownerMemberId":member_id,
                "projectId":auth.data.project_id(),
                "status":"active",
                "title":input.title,
                "currentVersion":1,
                "scope":scope,
                "authorityPolicy":"no-expansion"
            });
            let version = serde_json::json!({
                "routineId":routine_id,
                "version":1,
                "createdAt":at,
                "createdByInternalUserId":auth.internal_user_id,
                "action":{
                    "kind":"direct-request",
                    "title":input.title,
                    "instruction":input.instruction
                },
                "scope":scope,
                "routePolicy":{"kind":"resolve-at-run"},
                "placementPolicy":{"kind":"resolve-at-run"},
                "budgets":{"capabilityGrantIds":[]},
                "triggerIds":[trigger_id]
            });
            let trigger = serde_json::json!({
                "id":trigger_id,
                "routineId":routine_id,
                "workspaceId":auth.data.workspace_id(),
                "authority":"local",
                "schemaVersion":1,
                "revision":1,
                "createdByInternalUserId":auth.internal_user_id,
                "createdAt":at,
                "updatedAt":at,
                "visibility":"member-private",
                "ownerMemberId":member_id,
                "projectId":auth.data.project_id(),
                "status":"active",
                "spec":input.trigger,
                "deduplication":{"strategy":"per-trigger-event"}
            });
            routine::create(
                tx,
                store,
                &auth.data,
                &auth.private,
                &auth.internal_user_id,
                &routine,
                &version,
                &[trigger],
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_edit(input: RoutineEditInput) -> Result<RoutineBundleRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            let mut existing =
                routine::get(tx, store, &auth.data, &auth.private, &input.routine_id)?.ok_or_else(
                    || crate::store::StoreError::Invalid("Routine was not found.".into()),
                )?;
            let next_version = existing
                .routine
                .get("currentVersion")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Stored Routine version is invalid.".into())
                })?
                + 1;
            let at = now();
            existing.routine["title"] = Value::String(input.title.clone());
            existing.routine["currentVersion"] = Value::Number(next_version.into());
            existing.routine["revision"] = Value::Number((input.expected_revision + 1).into());
            existing.routine["updatedAt"] = Value::String(at.clone());
            let mut version = existing.current_version.clone();
            version["version"] = Value::Number(next_version.into());
            version["createdAt"] = Value::String(at.clone());
            version["createdByInternalUserId"] = Value::String(auth.internal_user_id.clone());
            version["action"]["title"] = Value::String(input.title);
            version["action"]["instruction"] = Value::String(input.instruction);
            let mut new_triggers = Vec::new();
            if let Some(spec) = input.trigger {
                validate_trigger_authority(tx, store, &auth, &spec)?;
                let member_id = auth.member_id.as_deref().ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "An active member is required to edit a Routine.".into(),
                    )
                })?;
                let trigger_id = secure_id("trigger").map_err(crate::store::StoreError::Invalid)?;
                version["triggerIds"] = serde_json::json!([trigger_id]);
                new_triggers.push(serde_json::json!({
                    "id":trigger_id,
                    "routineId":input.routine_id,
                    "workspaceId":auth.data.workspace_id(),
                    "authority":"local",
                    "schemaVersion":1,
                    "revision":1,
                    "createdByInternalUserId":auth.internal_user_id,
                    "createdAt":at,
                    "updatedAt":at,
                    "visibility":"member-private",
                    "ownerMemberId":member_id,
                    "projectId":auth.data.project_id(),
                    "status":"active",
                    "spec":spec,
                    "deduplication":{"strategy":"per-trigger-event"}
                }));
            }
            routine::append_version(
                tx,
                store,
                &auth.data,
                &auth.private,
                &auth.internal_user_id,
                &input.routine_id,
                input.expected_revision,
                &existing.routine,
                &version,
                &new_triggers,
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

fn transition(input: RoutineTransitionInput, status: &str) -> Result<RoutineBundleRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            routine::transition(
                tx,
                store,
                &auth.data,
                &auth.private,
                &auth.internal_user_id,
                &input.routine_id,
                input.expected_revision,
                status,
                input.reason.as_deref(),
                &now(),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_pause(input: RoutineTransitionInput) -> Result<RoutineBundleRow, String> {
    transition(input, "paused")
}

#[tauri::command]
pub fn routine_resume(input: RoutineTransitionInput) -> Result<RoutineBundleRow, String> {
    transition(input, "active")
}

#[tauri::command]
pub fn routine_delete(input: RoutineTransitionInput) -> Result<RoutineBundleRow, String> {
    transition(input, "deleted")
}

#[tauri::command]
pub fn routine_get(input: RoutineReadInput) -> Result<Option<RoutineBundleRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Read)?;
            routine::get(tx, store, &auth.data, &auth.private, &input.routine_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_list(input: RoutineListInput) -> Result<Vec<RoutineBundleRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Read)?;
            routine::list(tx, store, &auth.data, &auth.private)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_connection_options() -> Result<Vec<RoutineConnectionOption>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let auth = scope_for(tx, None, ScopeAccess::Read)?;
            let options =
                crate::store::repos::connection_record::list_private_owned(tx, store, &auth)?
                    .into_iter()
                    .filter(|connection| {
                        connection.kind == "mcp"
                            && connection.lifecycle == "authorized"
                            && matches!(
                                connection.authorization_state.as_str(),
                                "authorized" | "not-required"
                            )
                            && matches!(
                                connection.credential_state.as_str(),
                                "available" | "not-required"
                            )
                    })
                    .map(|connection| RoutineConnectionOption {
                        connection_id: connection.id,
                        display_name: connection.display_name,
                        health_state: connection.health_state,
                    })
                    .collect();
            Ok(options)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_occurrence_append(input: RoutineOccurrenceInput) -> Result<Value, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            routine::append_occurrence(tx, store, &auth.data, &auth.private, &input.occurrence)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_occurrence_history(input: RoutineReadInput) -> Result<Vec<Value>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Read)?;
            routine::occurrence_history(tx, store, &auth.data, &auth.private, &input.routine_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_driver_renew(input: RoutineDriverLeaseInput) -> Result<bool, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            let at = Utc::now();
            routine::renew_driver_lease(
                tx,
                auth.data.workspace_id(),
                auth.private.owner_subject(),
                &input.occurrence_id,
                input.writer_epoch,
                &input.lease_token,
                &at.to_rfc3339_opts(SecondsFormat::Millis, true),
                &(at + Duration::minutes(15)).to_rfc3339_opts(SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_driver_report(input: RoutineDriverAttemptInput) -> Result<String, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            if input.attempt_number < 1 || input.attempt_number > 3 {
                return Err(crate::store::StoreError::Invalid(
                    "Routine driver attempt number is invalid.".into(),
                ));
            }
            let at = Utc::now();
            let at_iso = at.to_rfc3339_opts(SecondsFormat::Millis, true);
            let lease_expires_at =
                (at + Duration::minutes(15)).to_rfc3339_opts(SecondsFormat::Millis, true);
            let exponent = u32::try_from(input.attempt_number - 1).unwrap_or(0);
            let backoff_seconds = 30_i64
                .saturating_mul(2_i64.saturating_pow(exponent))
                .min(900);
            let retry_at = (at + Duration::seconds(backoff_seconds))
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            routine::report_driver_attempt(
                tx,
                store,
                auth.data.workspace_id(),
                auth.private.owner_subject(),
                &input.occurrence_id,
                input.writer_epoch,
                &input.lease_token,
                &input.run_id,
                input.attempt_number,
                &input.status,
                &at_iso,
                Some(&lease_expires_at),
                Some(&retry_at),
            )
        })
        .map_err(|error| error.to_string())
}

fn scheduler_reconciliation(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &authorized_scope::AuthorizedCommandScope,
    authority: &routine::SchedulerAuthorityRow,
    reconciled_at: &str,
) -> crate::store::Result<(RoutineSchedulerStatus, Value)> {
    let jobs = scheduled_job::list(tx, store, auth.data.workspace_id())?;
    let mut active_legacy_jobs = 0;
    let mut mapped_legacy_jobs = 0;
    let mut blockers = Vec::new();
    let mut mapped = Vec::new();
    for row in jobs {
        if !matches!(
            row.value.get("status").and_then(Value::as_str),
            Some("active" | "paused")
        ) {
            continue;
        }
        active_legacy_jobs += 1;
        let schema_version = row
            .value
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let source_key = format!("scheduled-job\u{0}{}\u{0}{schema_version}", row.id);
        let source_checksum = checksum(&row.value).map_err(crate::store::StoreError::Invalid)?;
        let canonical = tx
            .query_row(
                "SELECT source.canonical_routine_id
                 FROM routine_migration_source source
                 JOIN routine_migration_batch batch
                   ON batch.workspace_id=source.workspace_id
                  AND batch.owner_subject=source.owner_subject
                  AND batch.id=source.batch_id
                 JOIN routine_record routine
                   ON routine.workspace_id=source.workspace_id
                  AND routine.owner_subject=source.owner_subject
                  AND routine.id=source.canonical_routine_id
                 WHERE source.workspace_id=?1 AND source.owner_subject=?2
                   AND source.source_key=?3 AND source.checksum=?4
                   AND source.disposition='candidate' AND batch.status='applied'
                   AND routine.status IN ('active','paused')
                 ORDER BY batch.applied_at DESC LIMIT 1;",
                rusqlite::params![
                    auth.data.workspace_id(),
                    auth.private.owner_subject(),
                    source_key,
                    source_checksum
                ],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        if let Some(routine_id) = canonical {
            mapped_legacy_jobs += 1;
            mapped.push(serde_json::json!({
                "legacyJobId":row.id,
                "checksum":source_checksum,
                "routineId":routine_id
            }));
        } else {
            blockers.push(format!(
                "Legacy schedule {} has no exact current owner-qualified Routine migration.",
                row.id
            ));
        }
    }

    let queue = scheduler_queue::list(tx, store, auth.data.workspace_id())?;
    let mut future_legacy_occurrences = 0;
    let mut terminal_legacy_occurrences = 0;
    let mut terminal_runs = Vec::new();
    let mut future_runs = Vec::new();
    for row in queue {
        let state = row
            .value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let run_id = row.value.get("runId").and_then(Value::as_str).unwrap_or("");
        let scheduled_at = row
            .value
            .get("scheduledAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        let scheduled_in_future = if state == "queued" {
            match (
                DateTime::parse_from_rfc3339(scheduled_at),
                DateTime::parse_from_rfc3339(reconciled_at),
            ) {
                (Ok(scheduled), Ok(reconciled)) => Some(scheduled > reconciled),
                _ => None,
            }
        } else {
            None
        };
        match state {
            "done" | "dead" | "cancelled" => {
                terminal_legacy_occurrences += 1;
                let retained: bool = !run_id.is_empty()
                    && tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM routine_occurrence
                         WHERE workspace_id=?1 AND owner_subject=?2 AND run_id=?3);",
                        rusqlite::params![
                            auth.data.workspace_id(),
                            auth.private.owner_subject(),
                            run_id
                        ],
                        |row| row.get(0),
                    )?;
                if retained {
                    terminal_runs.push(run_id.to_string());
                } else {
                    blockers.push(format!(
                        "Finished legacy run {} is not retained in canonical Routine history.",
                        if run_id.is_empty() {
                            row.id.as_str()
                        } else {
                            run_id
                        }
                    ));
                }
            }
            "queued" if scheduled_in_future == Some(true) => {
                future_legacy_occurrences += 1;
                future_runs.push(serde_json::json!({
                    "runId":run_id,
                    "scheduledAt":scheduled_at
                }));
            }
            "queued" if scheduled_in_future == Some(false) => blockers.push(format!(
                "Legacy run {} is due and must settle before Routine cutover.",
                if run_id.is_empty() {
                    row.id.as_str()
                } else {
                    run_id
                }
            )),
            "queued" => blockers.push(format!(
                "Legacy run {} has an invalid scheduled time and cannot be reconciled.",
                if run_id.is_empty() {
                    row.id.as_str()
                } else {
                    run_id
                }
            )),
            "leased" | "running" | "blocked-auth" => blockers.push(format!(
                "Legacy run {} is still {}.",
                if run_id.is_empty() {
                    row.id.as_str()
                } else {
                    run_id
                },
                state
            )),
            other => blockers.push(format!(
                "Legacy run {} has unsupported state {}.",
                if run_id.is_empty() {
                    row.id.as_str()
                } else {
                    run_id
                },
                other
            )),
        }
    }
    mapped.sort_by_key(|left| left.to_string());
    terminal_runs.sort();
    future_runs.sort_by_key(|left| left.to_string());
    blockers.sort();

    let routine_driver_occurrences: usize = tx.query_row(
        "SELECT COUNT(*) FROM routine_driver_occurrence WHERE workspace_id=?1;",
        [auth.data.workspace_id()],
        |row| row.get::<_, i64>(0),
    )? as usize;
    let evidence = serde_json::json!({
        "workspaceId":auth.data.workspace_id(),
        "ownerSubject":auth.private.owner_subject(),
        "authorityEpoch":authority.epoch,
        "reconciledAt":reconciled_at,
        "mappedLegacyJobs":mapped,
        "terminalLegacyRunIds":terminal_runs,
        "futureLegacyRuns":future_runs,
        "routineDriverOccurrences":routine_driver_occurrences,
        "blockers":blockers
    });
    let reconciliation_hash = checksum(&evidence).map_err(crate::store::StoreError::Invalid)?;
    let ready_for_cutover =
        authority.writer == "legacy" && authority.phase == "shadow" && blockers.is_empty();
    Ok((
        RoutineSchedulerStatus {
            authority: authority.clone(),
            ready_for_cutover,
            blockers,
            active_legacy_jobs,
            mapped_legacy_jobs,
            future_legacy_occurrences,
            terminal_legacy_occurrences,
            routine_driver_occurrences,
            reconciliation_hash: Some(reconciliation_hash),
        },
        evidence,
    ))
}

#[tauri::command]
pub fn routine_scheduler_status(
    input: RoutineSchedulerCommandInput,
) -> Result<RoutineSchedulerStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Read)?;
            let at = now();
            let authority = routine::scheduler_authority(tx, store, auth.data.workspace_id(), &at)?;
            scheduler_reconciliation(tx, store, &auth, &authority, &at).map(|value| value.0)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_scheduler_begin_shadow(
    input: RoutineSchedulerCommandInput,
) -> Result<RoutineSchedulerStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            let at = now();
            let current = routine::scheduler_authority(tx, store, auth.data.workspace_id(), &at)?;
            let fence = secure_id("routine_shadow").map_err(crate::store::StoreError::Invalid)?;
            let authority = routine::transition_scheduler_authority(
                tx,
                store,
                auth.data.workspace_id(),
                current.epoch,
                "legacy",
                "shadow",
                &fence,
                None,
                &serde_json::json!({
                    "startedByInternalUserId":auth.internal_user_id,
                    "startedAt":at,
                    "legacyWriterRemainsSelected":true
                }),
                &at,
            )?;
            scheduler_reconciliation(tx, store, &auth, &authority, &at).map(|value| value.0)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_scheduler_cutover(
    input: RoutineSchedulerCommandInput,
) -> Result<RoutineSchedulerStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            let at = now();
            let current = routine::scheduler_authority(tx, store, auth.data.workspace_id(), &at)?;
            if current.writer != "legacy" || current.phase != "shadow" {
                return Err(crate::store::StoreError::Invalid(
                    "Routine cutover requires the legacy writer to be in shadow mode.".into(),
                ));
            }
            let (status, evidence) = scheduler_reconciliation(tx, store, &auth, &current, &at)?;
            if !status.blockers.is_empty() {
                return Err(crate::store::StoreError::Invalid(format!(
                    "Routine cutover is blocked: {}",
                    status.blockers.join(" ")
                )));
            }
            let proof = status.reconciliation_hash.as_deref().ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Routine reconciliation proof is unavailable.".into(),
                )
            })?;
            let fence = secure_id("routine_writer").map_err(crate::store::StoreError::Invalid)?;
            let authority = routine::transition_scheduler_authority(
                tx,
                store,
                auth.data.workspace_id(),
                current.epoch,
                "routine",
                "routine",
                &fence,
                Some(proof),
                &evidence,
                &at,
            )?;
            scheduler_reconciliation(tx, store, &auth, &authority, &at).map(|value| value.0)
        })
        .map_err(|error| error.to_string())
}

#[derive(Debug)]
struct RollbackOccurrence {
    occurrence_id: String,
    routine_id: String,
    driver_state: String,
    occurrence_status: String,
    scheduled_for: String,
    observed_at: String,
    run_id: String,
    attempt_count: i64,
}

fn scheduled_job_source_id(source_key: &str) -> Option<&str> {
    let mut parts = source_key.split('\0');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("scheduled-job"), Some(id), Some(_schema_version), None) if !id.is_empty() => {
            Some(id)
        }
        _ => None,
    }
}

fn exact_legacy_job_for_routine(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &authorized_scope::AuthorizedCommandScope,
    routine_id: &str,
    jobs: &BTreeMap<String, Value>,
) -> crate::store::Result<String> {
    let mut stmt = tx.prepare(
        "SELECT source.source_key,source.checksum
         FROM routine_migration_source source
         JOIN routine_migration_batch batch
           ON batch.workspace_id=source.workspace_id
          AND batch.owner_subject=source.owner_subject
          AND batch.id=source.batch_id
         WHERE source.workspace_id=?1 AND source.owner_subject=?2
           AND source.canonical_routine_id=?3
           AND source.disposition='candidate' AND batch.status='applied'
         ORDER BY batch.applied_at DESC,source.source_key;",
    )?;
    let candidates = stmt
        .query_map(
            rusqlite::params![
                auth.data.workspace_id(),
                auth.private.owner_subject(),
                routine_id
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut exact = Vec::new();
    for (source_key, expected_checksum) in candidates {
        let Some(job_id) = scheduled_job_source_id(&source_key) else {
            continue;
        };
        let Some(job) = jobs.get(job_id) else {
            continue;
        };
        let actual_checksum = checksum(job).map_err(crate::store::StoreError::Invalid)?;
        if actual_checksum == expected_checksum {
            exact.push(job_id.to_string());
        }
    }
    exact.sort();
    exact.dedup();
    if exact.len() != 1 {
        return Err(crate::store::StoreError::Invalid(format!(
            "Routine {routine_id} does not have one exact unchanged legacy schedule for rollback."
        )));
    }
    // Re-open through the encrypted repository boundary before returning the
    // identity. The caller-provided map is only a transaction-local cache.
    let exists = scheduled_job::list(tx, store, auth.data.workspace_id())?
        .into_iter()
        .any(|row| row.id == exact[0]);
    if !exists {
        return Err(crate::store::StoreError::Invalid(
            "The rollback legacy schedule disappeared.".into(),
        ));
    }
    Ok(exact.remove(0))
}

fn bridge_routine_execution_for_legacy_rollback(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &authorized_scope::AuthorizedCommandScope,
    current: &routine::SchedulerAuthorityRow,
    at: &str,
) -> crate::store::Result<Value> {
    let foreign_private_rows: bool = tx.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM routine_record
           WHERE workspace_id=?1 AND owner_subject<>?2 AND status IN ('active','paused')
           UNION ALL
           SELECT 1 FROM routine_driver_occurrence
           WHERE workspace_id=?1 AND owner_subject<>?2 AND writer_epoch=?3
         );",
        rusqlite::params![
            auth.data.workspace_id(),
            auth.private.owner_subject(),
            current.epoch
        ],
        |row| row.get(0),
    )?;
    if foreign_private_rows {
        return Err(crate::store::StoreError::Invalid(
            "Routine rollback cannot reconcile another private owner from the active member boundary."
                .into(),
        ));
    }

    let jobs = scheduled_job::list(tx, store, auth.data.workspace_id())?
        .into_iter()
        .map(|row| (row.id, row.value))
        .collect::<BTreeMap<_, _>>();
    let active_routines = {
        let mut stmt = tx.prepare(
            "SELECT id,revision,current_version FROM routine_record
             WHERE workspace_id=?1 AND owner_subject=?2 AND status IN ('active','paused')
             ORDER BY id;",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![auth.data.workspace_id(), auth.private.owner_subject()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut job_by_routine = BTreeMap::new();
    for (routine_id, revision, version) in active_routines {
        if revision != 1 || version != 1 {
            return Err(crate::store::StoreError::Invalid(format!(
                "Routine {routine_id} changed after migration and cannot be restored to an older legacy definition."
            )));
        }
        let job_id = exact_legacy_job_for_routine(tx, store, auth, &routine_id, &jobs)?;
        job_by_routine.insert(routine_id, job_id);
    }

    let occurrences = {
        let mut stmt = tx.prepare(
            "SELECT d.occurrence_id,o.routine_id,d.state,o.status,
                    COALESCE(o.scheduled_for,''),o.observed_at,COALESCE(o.run_id,''),
                    d.attempt_count
             FROM routine_driver_occurrence d
             JOIN routine_occurrence o
               ON o.workspace_id=d.workspace_id
              AND o.owner_subject=d.owner_subject
              AND o.id=d.occurrence_id
             WHERE d.workspace_id=?1 AND d.owner_subject=?2 AND d.writer_epoch=?3
             ORDER BY o.scheduled_for,d.occurrence_id;",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                auth.data.workspace_id(),
                auth.private.owner_subject(),
                current.epoch
            ],
            |row| {
                Ok(RollbackOccurrence {
                    occurrence_id: row.get(0)?,
                    routine_id: row.get(1)?,
                    driver_state: row.get(2)?,
                    occurrence_status: row.get(3)?,
                    scheduled_for: row.get(4)?,
                    observed_at: row.get(5)?,
                    run_id: row.get(6)?,
                    attempt_count: row.get(7)?,
                })
            },
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut bridged = Vec::new();
    let mut latest_by_job = BTreeMap::<String, (DateTime<Utc>, String, String)>::new();
    for occurrence in occurrences {
        let (queue_state, expected_occurrence_status) = match occurrence.driver_state.as_str() {
            "done" => ("done", "completed"),
            "dead" => ("dead", "failed"),
            "cancelled" => ("cancelled", "cancelled"),
            "blocked" => ("blocked-auth", "blocked"),
            "queued" | "leased" | "running" => {
                return Err(crate::store::StoreError::Invalid(format!(
                    "Routine occurrence {} is still {} and must settle before rollback.",
                    occurrence.occurrence_id, occurrence.driver_state
                )));
            }
            _ => {
                return Err(crate::store::StoreError::Invalid(
                    "Routine rollback found an unsupported driver state.".into(),
                ));
            }
        };
        if occurrence.occurrence_status != expected_occurrence_status
            || occurrence.run_id.is_empty()
            || occurrence.scheduled_for.is_empty()
        {
            return Err(crate::store::StoreError::Invalid(format!(
                "Routine occurrence {} has inconsistent terminal history.",
                occurrence.occurrence_id
            )));
        }
        let scheduled = DateTime::parse_from_rfc3339(&occurrence.scheduled_for)
            .map_err(|_| {
                crate::store::StoreError::Invalid(
                    "Routine rollback found an invalid scheduled time.".into(),
                )
            })?
            .with_timezone(&Utc);
        let job_id = job_by_routine
            .get(&occurrence.routine_id)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(format!(
                    "Routine {} has no unchanged legacy schedule for its terminal occurrence.",
                    occurrence.routine_id
                ))
            })?
            .clone();
        let job = jobs.get(&job_id).ok_or_else(|| {
            crate::store::StoreError::Invalid("The rollback legacy schedule is unavailable.".into())
        })?;
        let queue = serde_json::json!({
            "workspaceId":auth.data.workspace_id(),
            "projectId":job.get("projectId").and_then(Value::as_str),
            "authority":"local",
            "visibility":"member-private",
            "ownerMemberId":auth.member_id,
            "createdByInternalUserId":auth.internal_user_id,
            "jobId":job_id,
            "runId":occurrence.run_id,
            "scheduledAt":occurrence.scheduled_for,
            "state":queue_state,
            "leaseHolder":"",
            "leaseExpiresAt":"",
            "leaseToken":"",
            "attempts":[],
            "deduplicationKey":format!("routine-rollback:v1:{}",occurrence.occurrence_id),
            "availableAt":occurrence.observed_at,
            "routineRollback":{
                "version":1,
                "occurrenceId":occurrence.occurrence_id,
                "routineId":occurrence.routine_id,
                "writerEpoch":current.epoch,
                "attemptCount":occurrence.attempt_count
            }
        });
        let inserted =
            scheduler_queue::upsert_entry(tx, store, auth.data.workspace_id(), &queue, at)?;
        if inserted.is_none() {
            return Err(crate::store::StoreError::Invalid(
                "Routine rollback collided with existing legacy history.".into(),
            ));
        }
        latest_by_job
            .entry(job_id.clone())
            .and_modify(|current_latest| {
                if scheduled > current_latest.0 {
                    *current_latest = (
                        scheduled,
                        occurrence.scheduled_for.clone(),
                        occurrence.run_id.clone(),
                    );
                }
            })
            .or_insert((
                scheduled,
                occurrence.scheduled_for.clone(),
                occurrence.run_id.clone(),
            ));
        bridged.push(serde_json::json!({
            "occurrenceId":occurrence.occurrence_id,
            "routineId":occurrence.routine_id,
            "legacyJobId":job_id,
            "runId":occurrence.run_id,
            "state":queue_state
        }));
    }

    for (job_id, (_, last_run_at, last_run_id)) in latest_by_job {
        let mut job = jobs.get(&job_id).cloned().ok_or_else(|| {
            crate::store::StoreError::Invalid("The rollback legacy schedule is unavailable.".into())
        })?;
        job["lastRunAt"] = Value::String(last_run_at);
        job["lastRunId"] = Value::String(last_run_id);
        job["nextRunAt"] = Value::String(String::new());
        job["updatedAt"] = Value::String(at.to_string());
        scheduled_job::upsert_from_value(tx, store, auth.data.workspace_id(), job, at)?;
    }
    Ok(serde_json::json!({
        "workspaceId":auth.data.workspace_id(),
        "ownerSubject":auth.private.owner_subject(),
        "rolledBackAt":at,
        "routineWriterEpoch":current.epoch,
        "bridgedOccurrences":bridged
    }))
}

#[tauri::command]
pub fn routine_scheduler_rollback(
    input: RoutineSchedulerCommandInput,
) -> Result<RoutineSchedulerStatus, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            let at = now();
            let current = routine::scheduler_authority(tx, store, auth.data.workspace_id(), &at)?;
            if current.writer != "routine" || current.phase != "routine" {
                return Err(crate::store::StoreError::Invalid(
                    "Routine rollback requires the Routine writer.".into(),
                ));
            }
            let evidence =
                bridge_routine_execution_for_legacy_rollback(tx, store, &auth, &current, &at)?;
            let proof = checksum(&evidence).map_err(crate::store::StoreError::Invalid)?;
            let fence = secure_id("legacy_rollback").map_err(crate::store::StoreError::Invalid)?;
            let rollback_authority = routine::transition_scheduler_authority(
                tx,
                store,
                auth.data.workspace_id(),
                current.epoch,
                "legacy",
                "rollback",
                &fence,
                Some(&proof),
                &evidence,
                &at,
            )?;
            let settled_fence =
                secure_id("legacy_writer").map_err(crate::store::StoreError::Invalid)?;
            let authority = routine::transition_scheduler_authority(
                tx,
                store,
                auth.data.workspace_id(),
                rollback_authority.epoch,
                "legacy",
                "legacy",
                &settled_fence,
                Some(&proof),
                &serde_json::json!({
                    "rollbackProof":proof,
                    "legacyWriterRestoredAt":at
                }),
                &at,
            )?;
            scheduler_reconciliation(tx, store, &auth, &authority, &at).map(|value| value.0)
        })
        .map_err(|error| error.to_string())
}

fn evidence_source(
    auth: &authorized_scope::AuthorizedCommandScope,
    kind: &str,
    legacy_id: &str,
    record: Value,
    selected_for_snapshot: Option<bool>,
) -> Result<Value, String> {
    let source_checksum = checksum(&record)?;
    let schema_version = record
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let ownership = if record.get("workspaceId").and_then(Value::as_str)
        == Some(auth.data.workspace_id())
        && record.get("projectId").and_then(Value::as_str) == auth.data.project_id()
        && record.get("visibility").and_then(Value::as_str) == Some("member-private")
        && record.get("ownerMemberId").and_then(Value::as_str) == auth.member_id.as_deref()
        && record
            .get("createdByInternalUserId")
            .and_then(Value::as_str)
            == Some(auth.internal_user_id.as_str())
    {
        serde_json::json!({
            "status":"proven",
            "source":{
                "kind":kind,
                "legacyId":legacy_id,
                "legacySchemaVersion":schema_version,
                "checksum":source_checksum
            },
            "workspaceId":auth.data.workspace_id(),
            "projectId":auth.data.project_id(),
            "visibility":"member-private",
            "ownerMemberId":auth.member_id,
            "createdByInternalUserId":auth.internal_user_id,
            "evidenceReference":format!("native:encrypted-snapshot:{source_checksum}")
        })
    } else {
        serde_json::json!({
            "status":"unresolved",
            "reason":"The legacy row has no exact persisted member-private creator evidence."
        })
    };
    let mut source = serde_json::json!({
        "kind":kind,
        "legacyId":legacy_id,
        "legacySchemaVersion":schema_version,
        "checksum":source_checksum,
        "repositoryScope":{
            "workspaceId":auth.data.workspace_id(),
            "projectId":auth.data.project_id()
        },
        "ownership":ownership,
        "record":record
    });
    if let Some(selected) = selected_for_snapshot {
        source["selectedForSnapshot"] = Value::Bool(selected);
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::{DataScope, PrivateDataScope};
    use crate::store::repos::workspace_directory::{
        select_active_workspace, set_current_internal_user, upsert_authoritative_summary,
        WorkspaceDirectoryUpsert,
    };
    use crate::store::vault::{MasterKey, Vault};

    fn auth(project_id: Option<&str>) -> authorized_scope::AuthorizedCommandScope {
        let data = DataScope::new("w1", project_id.map(str::to_string)).unwrap();
        authorized_scope::AuthorizedCommandScope {
            private: PrivateDataScope::for_authenticated_user(
                data.clone(),
                "user-1",
                Some("member-1"),
            )
            .unwrap(),
            data,
            internal_user_id: "user-1".into(),
            member_id: Some("member-1".into()),
        }
    }

    fn store() -> crate::store::Store {
        crate::store::Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
            .unwrap()
    }

    fn summary(user: &str, member: &str) -> WorkspaceDirectoryUpsert {
        WorkspaceDirectoryUpsert {
            internal_user_id: user.into(),
            fable_workspace_id: "workspace-1".into(),
            name: "Workspace".into(),
            workspace_status: "active".into(),
            workspace_revision: 1,
            policy_revision: 1,
            member_id: member.into(),
            role: "owner".into(),
            membership_status: "active".into(),
            membership_revision: 1,
            updated_at: "2026-07-24T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn connection_event_trigger_requires_one_ready_mcp_connection_and_supported_event() {
        let store = store();
        store
            .transaction(|tx| {
                let workspace = upsert_authoritative_summary(tx, &summary("user-1", "member-1"))?;
                set_current_internal_user(tx, "user-1", "2026-07-24T10:00:00.000Z")?;
                select_active_workspace(tx, "user-1", "workspace-1", "2026-07-24T10:00:00.000Z")?;
                let command_scope = authorized_scope::resolve(
                    tx,
                    Some(&workspace.local_workspace_id),
                    None,
                    ScopeAccess::Write,
                )?;
                let connection = crate::store::repos::connection_record::upsert_mcp_stdio(
                    tx,
                    &store,
                    &command_scope,
                    "fixture-tools",
                    "Fixture tools",
                    "2026-07-24T10:00:00.000Z",
                )?;
                upsert_authoritative_summary(tx, &summary("user-2", "member-2"))?;
                set_current_internal_user(tx, "user-2", "2026-07-24T10:00:00.000Z")?;
                select_active_workspace(tx, "user-2", "workspace-1", "2026-07-24T10:00:00.000Z")?;
                let other_scope = authorized_scope::resolve(
                    tx,
                    Some(&workspace.local_workspace_id),
                    None,
                    ScopeAccess::Write,
                )?;
                let other_connection = crate::store::repos::connection_record::upsert_mcp_stdio(
                    tx,
                    &store,
                    &other_scope,
                    "other-tools",
                    "Other member tools",
                    "2026-07-24T10:00:00.000Z",
                )?;
                set_current_internal_user(tx, "user-1", "2026-07-24T10:00:00.000Z")?;
                select_active_workspace(tx, "user-1", "workspace-1", "2026-07-24T10:00:00.000Z")?;
                assert_eq!(
                    crate::store::repos::connection_record::list_private_owned(
                        tx,
                        &store,
                        &command_scope,
                    )?
                    .len(),
                    1
                );
                assert!(crate::store::repos::connection_record::get_private_owned(
                    tx,
                    &store,
                    &command_scope,
                    &other_connection.id,
                )?
                .is_none());
                validate_trigger_authority(
                    tx,
                    &store,
                    &command_scope,
                    &serde_json::json!({
                        "kind":"connection-event",
                        "connectionId":connection.id,
                        "eventType":"mcp.tools.list_changed"
                    }),
                )?;
                assert!(validate_trigger_authority(
                    tx,
                    &store,
                    &command_scope,
                    &serde_json::json!({
                        "kind":"connection-event",
                        "connectionId":connection.id,
                        "eventType":"provider.unknown"
                    }),
                )
                .unwrap_err()
                .to_string()
                .contains("not supported"));
                assert!(validate_trigger_authority(
                    tx,
                    &store,
                    &command_scope,
                    &serde_json::json!({
                        "kind":"connection-event",
                        "connectionId":connection.id,
                        "eventType":"mcp.tools.list_changed",
                        "eventFilter":{"hidden":"claim"}
                    }),
                )
                .unwrap_err()
                .to_string()
                .contains("unsupported fields"));
                assert!(validate_trigger_authority(
                    tx,
                    &store,
                    &auth(Some("project-1")),
                    &serde_json::json!({
                        "kind":"connection-event",
                        "connectionId":connection.id,
                        "eventType":"mcp.tools.list_changed"
                    }),
                )
                .unwrap_err()
                .to_string()
                .contains("workspace scope"));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn migration_evidence_proves_only_exact_persisted_ownership() {
        let auth = auth(Some("project-1"));
        let exact = serde_json::json!({
            "id":"job-1",
            "schemaVersion":1,
            "workspaceId":"w1",
            "projectId":"project-1",
            "visibility":"member-private",
            "ownerMemberId":"member-1",
            "createdByInternalUserId":"user-1"
        });
        let proven = evidence_source(&auth, "scheduled-job", "job-1", exact, None).unwrap();
        assert_eq!(proven["ownership"]["status"], "proven");
        assert!(proven["ownership"]["evidenceReference"]
            .as_str()
            .unwrap()
            .starts_with("native:encrypted-snapshot:sha256:"));

        let unresolved = evidence_source(
            &auth,
            "scheduled-job",
            "job-2",
            serde_json::json!({"id":"job-2"}),
            None,
        )
        .unwrap();
        assert_eq!(unresolved["ownership"]["status"], "unresolved");
        assert!(unresolved["ownership"].get("ownerMemberId").is_none());
        assert!(unresolved["ownership"]
            .get("createdByInternalUserId")
            .is_none());
    }

    #[test]
    fn migration_evidence_rejects_cross_scope_identity_claims() {
        let auth = auth(None);
        for (field, value) in [
            ("workspaceId", "w2"),
            ("visibility", "shared"),
            ("ownerMemberId", "member-2"),
            ("createdByInternalUserId", "user-2"),
        ] {
            let mut record = serde_json::json!({
                "workspaceId":"w1",
                "visibility":"member-private",
                "ownerMemberId":"member-1",
                "createdByInternalUserId":"user-1"
            });
            record[field] = Value::String(value.into());
            let source = evidence_source(&auth, "scheduled-job", "job", record, None).unwrap();
            assert_eq!(source["ownership"]["status"], "unresolved", "{field}");
        }
    }

    #[test]
    fn post_execution_rollback_bridges_terminal_history_and_legacy_cursor() {
        let store = store();
        store
            .transaction(|tx| {
                crate::store::repos::workspace::upsert(tx, "w1", "Workspace", "now")?;
                let auth = auth(None);
                let at = "2026-07-23T10:00:00.000Z";
                let job = serde_json::json!({
                    "id":"job-1",
                    "schemaVersion":crate::models::SCHEDULER_STORE_VERSION,
                    "workspaceId":"w1",
                    "visibility":"member-private",
                    "ownerMemberId":"member-1",
                    "createdByInternalUserId":"user-1",
                    "name":"Daily brief",
                    "description":"Summarise the day",
                    "workflowDefinitionId":"workflow-1",
                    "trigger":{"kind":"recurring","rule":{
                        "frequency":"daily","interval":1,"hour":9,"minute":0
                    }},
                    "missedRunPolicy":"run-once",
                    "status":"active",
                    "nextRunAt":"2026-07-24T09:00:00.000Z",
                    "lastRunAt":"",
                    "lastRunId":"",
                    "createdAt":"2026-07-20T10:00:00.000Z",
                    "updatedAt":"2026-07-20T10:00:00.000Z"
                });
                scheduled_job::upsert_from_value(tx, &store, "w1", job.clone(), at)?;

                let routine_record = serde_json::json!({
                    "id":"routine-1","workspaceId":"w1","authority":"local",
                    "schemaVersion":1,"revision":1,"createdByInternalUserId":"user-1",
                    "createdAt":"2026-07-20T10:00:00.000Z",
                    "updatedAt":"2026-07-20T10:00:00.000Z",
                    "visibility":"member-private","ownerMemberId":"member-1",
                    "status":"active","title":"Daily brief","currentVersion":1,
                    "scope":{},"authorityPolicy":"no-expansion"
                });
                let version = serde_json::json!({
                    "routineId":"routine-1","version":1,
                    "createdAt":"2026-07-20T10:00:00.000Z",
                    "createdByInternalUserId":"user-1",
                    "action":{"kind":"direct-request","title":"Daily brief",
                              "instruction":"Summarise the day"},
                    "scope":{},"routePolicy":{"kind":"resolve-at-run"},
                    "placementPolicy":{"kind":"resolve-at-run"},
                    "budgets":{"capabilityGrantIds":[]},"triggerIds":["trigger-1"]
                });
                let trigger = serde_json::json!({
                    "id":"trigger-1","routineId":"routine-1","workspaceId":"w1",
                    "authority":"local","schemaVersion":1,"revision":1,
                    "createdByInternalUserId":"user-1",
                    "createdAt":"2026-07-20T10:00:00.000Z",
                    "updatedAt":"2026-07-20T10:00:00.000Z",
                    "visibility":"member-private","ownerMemberId":"member-1",
                    "status":"active","spec":{"kind":"time-recurring","timezone":"UTC",
                    "recurrence":{"frequency":"daily","expression":
                    "legacy-rrule-lite:v1:{\"frequency\":\"daily\",\"interval\":1,\"byWeekday\":[],\"byMonthDay\":null,\"hour\":9,\"minute\":0}"},
                    "missedRunPolicy":"run-once"},
                    "deduplication":{"strategy":"per-trigger-event"}
                });
                routine::create(
                    tx,
                    &store,
                    &auth.data,
                    &auth.private,
                    &auth.internal_user_id,
                    &routine_record,
                    &version,
                    &[trigger],
                )?;

                let source_key = format!(
                    "scheduled-job\0job-1\0{}",
                    crate::models::SCHEDULER_STORE_VERSION
                );
                let source_checksum =
                    checksum(&job).map_err(crate::store::StoreError::Invalid)?;
                tx.execute(
                    "INSERT INTO routine_migration_batch
                     (workspace_id,owner_subject,id,input_hash,planned_at,status,
                      applied_at,payload,payload_nonce)
                     VALUES ('w1',?1,'batch-1','sha256:batch','2026-07-20T10:00:00.000Z',
                             'applied','2026-07-20T10:00:00.000Z',X'00',X'00');",
                    [auth.private.owner_subject()],
                )?;
                tx.execute(
                    "INSERT INTO routine_migration_source
                     (workspace_id,owner_subject,batch_id,source_key,checksum,disposition,
                      canonical_routine_id,payload,payload_nonce)
                     VALUES ('w1',?1,'batch-1',?2,?3,'candidate','routine-1',X'00',X'00');",
                    rusqlite::params![
                        auth.private.owner_subject(),
                        source_key,
                        source_checksum
                    ],
                )?;

                let legacy = routine::scheduler_authority(tx, &store, "w1", at)?;
                let shadow = routine::transition_scheduler_authority(
                    tx,
                    &store,
                    "w1",
                    legacy.epoch,
                    "legacy",
                    "shadow",
                    "shadow-test",
                    None,
                    &serde_json::json!({}),
                    at,
                )?;
                let current = routine::transition_scheduler_authority(
                    tx,
                    &store,
                    "w1",
                    shadow.epoch,
                    "routine",
                    "routine",
                    "routine-test",
                    Some(&format!("sha256:{}", "0".repeat(64))),
                    &serde_json::json!({}),
                    at,
                )?;

                let occurrence = serde_json::json!({
                    "id":"occurrence-1","routineId":"routine-1","triggerId":"trigger-1",
                    "routineVersion":1,"status":"completed",
                    "scheduledFor":"2026-07-23T09:00:00.000Z",
                    "observedAt":"2026-07-23T09:00:05.000Z",
                    "deduplicationKey":"routine-1:2026-07-23T09:00:00.000Z",
                    "runId":"run-1"
                });
                routine::append_occurrence(tx, &store, &auth.data, &auth.private, &occurrence)?;
                tx.execute(
                    "INSERT INTO routine_driver_occurrence
                     (workspace_id,owner_subject,occurrence_id,writer_epoch,state,
                      available_at,attempt_count,updated_at,payload,payload_nonce)
                     VALUES ('w1',?1,'occurrence-1',?2,'done',
                             '2026-07-23T09:00:05.000Z',1,
                             '2026-07-23T09:00:05.000Z',X'00',X'00');",
                    rusqlite::params![auth.private.owner_subject(), current.epoch],
                )?;

                tx.execute(
                    "UPDATE routine_driver_occurrence SET state='running'
                     WHERE workspace_id='w1' AND occurrence_id='occurrence-1';",
                    [],
                )?;
                let in_flight = bridge_routine_execution_for_legacy_rollback(
                    tx, &store, &auth, &current, at,
                )
                .unwrap_err();
                assert!(in_flight
                    .to_string()
                    .contains("must settle before rollback"));
                tx.execute(
                    "UPDATE routine_driver_occurrence SET state='done'
                     WHERE workspace_id='w1' AND occurrence_id='occurrence-1';",
                    [],
                )?;

                let evidence = bridge_routine_execution_for_legacy_rollback(
                    tx, &store, &auth, &current, at,
                )?;
                assert_eq!(
                    evidence["bridgedOccurrences"][0]["occurrenceId"],
                    "occurrence-1"
                );
                let queue = scheduler_queue::list(tx, &store, "w1")?;
                assert_eq!(queue.len(), 1);
                assert_eq!(queue[0].value["state"], "done");
                assert_eq!(
                    queue[0].value["routineRollback"]["writerEpoch"],
                    current.epoch
                );
                let jobs = scheduled_job::list(tx, &store, "w1")?;
                assert_eq!(
                    jobs[0].value["lastRunAt"],
                    "2026-07-23T09:00:00.000Z"
                );
                assert_eq!(jobs[0].value["lastRunId"], "run-1");
                assert_eq!(jobs[0].value["nextRunAt"], "");

                tx.execute(
                    "UPDATE routine_record SET revision=2
                     WHERE workspace_id='w1' AND id='routine-1';",
                    [],
                )?;
                let changed = bridge_routine_execution_for_legacy_rollback(
                    tx, &store, &auth, &current, at,
                )
                .unwrap_err();
                assert!(changed
                    .to_string()
                    .contains("changed after migration"));
                Ok(())
            })
            .unwrap();
    }
}

/// Capture an authenticated, encrypted-store snapshot for the pure migration
/// planner. No owner, grant, approval, provider, or placement fact is inferred.
#[tauri::command]
pub fn routine_migration_capture(input: RoutineMigrationCaptureInput) -> Result<Value, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Read)?;
            if auth.member_id.is_none() {
                return Err(crate::store::StoreError::Invalid(
                    "An active member is required to capture Routine migration evidence.".into(),
                ));
            }
            let mut sources = Vec::new();
            for row in scheduled_job::list(tx, store, auth.data.workspace_id())? {
                if row.value.get("projectId").and_then(Value::as_str) == auth.data.project_id() {
                    sources.push(
                        evidence_source(&auth, "scheduled-job", &row.id, row.value, None)
                            .map_err(crate::store::StoreError::Invalid)?,
                    );
                }
            }
            let definitions = workflow::list_definitions(tx, store, &auth.data)?;
            let mut newest = BTreeMap::<String, u64>::new();
            for definition in &definitions {
                if let (Some(id), Some(version)) = (
                    definition.get("id").and_then(Value::as_str),
                    definition.get("version").and_then(Value::as_u64),
                ) {
                    newest
                        .entry(id.to_string())
                        .and_modify(|current| *current = (*current).max(version))
                        .or_insert(version);
                }
            }
            for definition in definitions {
                let id = definition
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "Stored workflow definition has no id.".into(),
                        )
                    })?
                    .to_string();
                let version = definition
                    .get("version")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let selected = newest.get(&id) == Some(&version);
                sources.push(
                    evidence_source(
                        &auth,
                        "workflow-definition",
                        &format!("{id}:v{version}"),
                        definition,
                        Some(selected),
                    )
                    .map_err(crate::store::StoreError::Invalid)?,
                );
            }
            for run in workflow::list_runs(tx, store, &auth.data, None)? {
                let id = run
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid("Stored workflow run has no id.".into())
                    })?
                    .to_string();
                sources.push(
                    evidence_source(&auth, "workflow-run", &id, run, None)
                        .map_err(crate::store::StoreError::Invalid)?,
                );
            }
            for row in scheduler_queue::list(tx, store, auth.data.workspace_id())? {
                if row.value.get("projectId").and_then(Value::as_str) == auth.data.project_id() {
                    sources.push(
                        evidence_source(&auth, "scheduler-queue-entry", &row.id, row.value, None)
                            .map_err(crate::store::StoreError::Invalid)?,
                    );
                }
            }
            for row in schedule::list_scoped(tx, store, &auth.data)? {
                sources.push(
                    evidence_source(&auth, "schedule-entry", &row.id, row.payload, None)
                        .map_err(crate::store::StoreError::Invalid)?,
                );
            }
            sources.sort_by(|left, right| {
                let left_key = (
                    left.get("kind").and_then(Value::as_str).unwrap_or_default(),
                    left.get("legacyId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                let right_key = (
                    right
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    right
                        .get("legacyId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                left_key.cmp(&right_key)
            });
            Ok(serde_json::json!({
                "plannedAt":input.planned_at,
                "sources":sources,
                "pinnedRouteEvidence":[]
            }))
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_migration_apply(
    input: RoutineMigrationApplyInput,
) -> Result<MigrationBatchSummary, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let batch_id = input
        .batch_id
        .map(Ok)
        .unwrap_or_else(|| secure_id("routine_migration"))?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            routine_migration::apply(
                tx,
                store,
                &auth.data,
                &auth.private,
                &auth.internal_user_id,
                &batch_id,
                &input.evidence,
                &input.plan,
                &now(),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_migration_verify_replay(
    input: RoutineMigrationReplayInput,
) -> Result<MigrationBatchSummary, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Read)?;
            routine_migration::verify_replay(
                tx,
                store,
                &auth.data,
                &auth.private,
                &input.batch_id,
                &input.evidence,
                &input.plan,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn routine_migration_rollback(
    input: RoutineMigrationRollbackInput,
) -> Result<MigrationBatchSummary, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = scope_for(tx, input.project_id.as_deref(), ScopeAccess::Write)?;
            routine_migration::rollback(
                tx,
                store,
                &auth.data,
                &auth.private,
                &input.batch_id,
                &now(),
            )
        })
        .map_err(|error| error.to_string())
}

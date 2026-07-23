//! Authenticated native Routine commands and legacy evidence capture.
//!
//! Renderer workspace/owner fields are assertions only. The native account
//! directory supplies the active workspace, member, and internal-user identity
//! used by every repository write.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
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
    let mut source = serde_json::json!({
        "kind":kind,
        "legacyId":legacy_id,
        "legacySchemaVersion":schema_version,
        "checksum":source_checksum,
        "repositoryScope":{
            "workspaceId":auth.data.workspace_id(),
            "projectId":auth.data.project_id()
        },
        "ownership":{
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
        },
        "record":record
    });
    if let Some(selected) = selected_for_snapshot {
        source["selectedForSnapshot"] = Value::Bool(selected);
    }
    Ok(source)
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

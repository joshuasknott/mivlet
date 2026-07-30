//! Durable encrypted SQLite workflow-run journal. The rich step-record shape is
//! owned by the TS protocol; Rust owns scoped durability and bounded history.
//! Restart recovery of in-flight runs is handled by the TS layer marking
//! `running`/`awaiting-approval` runs as recoverable on resume.

#[cfg(test)]
use std::{fs, path::Path};

use crate::authorized_scope::{self, AuthorizedCommandScope, ScopeAccess};
#[cfg(test)]
use crate::models::MAX_WORKFLOW_RUNS;
use crate::models::{
    WorkflowDefinitionRecord, WorkflowRunRecord, MAX_WORKFLOW_STEPS, WORKFLOW_RUN_STATUSES,
    WORKFLOW_RUN_STORE_VERSION,
};
use crate::paths::{normalize_spaces, truncate_characters};
use crate::store::repos::workflow;

fn normalize_definition(
    mut definition: WorkflowDefinitionRecord,
) -> Result<WorkflowDefinitionRecord, String> {
    definition.id = truncate_characters(&normalize_spaces(&definition.id), 160);
    definition.name = truncate_characters(&normalize_spaces(&definition.name), 200);
    definition.description = truncate_characters(&normalize_spaces(&definition.description), 2_000);
    definition.created_at = normalize_spaces(&definition.created_at);
    definition.updated_at = normalize_spaces(&definition.updated_at);
    let status = definition
        .status
        .take()
        .unwrap_or_else(|| "active".to_string());
    let status = normalize_spaces(&status).to_ascii_lowercase();
    if !matches!(status.as_str(), "active" | "paused") {
        return Err("Workflow status is not recognized.".to_string());
    }
    definition.status = Some(status);
    if let Some(profile) = definition.permission_profile.take() {
        let profile = normalize_spaces(&profile).to_ascii_lowercase();
        if !matches!(
            profile.as_str(),
            "read-only" | "trusted" | "full-with-approvals"
        ) {
            return Err("Workflow permission profile is not recognized.".to_string());
        }
        definition.permission_profile = Some(profile);
    }
    definition.steps = crate::store::repos::connector_cache::redact_value(&definition.steps);
    let step_count = definition.steps.as_array().map(Vec::len).unwrap_or(0);
    if definition.schema_version != WORKFLOW_RUN_STORE_VERSION
        || definition.id.is_empty()
        || definition.name.is_empty()
        || definition.version == 0
        || step_count == 0
        || step_count > MAX_WORKFLOW_STEPS
    {
        return Err("Workflow definition is incomplete or exceeds its limits.".to_string());
    }
    Ok(definition)
}

fn ownership_is_unresolved(
    authority: &str,
    visibility: &str,
    owner_member_id: Option<&str>,
    created_by_internal_user_id: Option<&str>,
) -> bool {
    authority.is_empty()
        && visibility.is_empty()
        && owner_member_id.is_none()
        && created_by_internal_user_id.is_none()
}

fn apply_definition_ownership(
    definition: &mut WorkflowDefinitionRecord,
    existing: Option<&WorkflowDefinitionRecord>,
    auth: &AuthorizedCommandScope,
) -> Result<(), String> {
    if let Some(existing) = existing {
        if ownership_is_unresolved(
            &existing.authority,
            &existing.visibility,
            existing.owner_member_id.as_deref(),
            existing.created_by_internal_user_id.as_deref(),
        ) {
            definition.workspace_id = existing.workspace_id.clone();
            definition.project_id = existing.project_id.clone();
            definition.authority.clear();
            definition.visibility.clear();
            definition.owner_member_id = None;
            definition.created_by_internal_user_id = None;
            return Ok(());
        }
        if existing.workspace_id != auth.data.workspace_id()
            || existing.project_id.as_deref() != auth.data.project_id()
            || existing.authority != "local"
            || existing.visibility != "member-private"
            || existing.owner_member_id.as_deref() != auth.member_id.as_deref()
            || existing.created_by_internal_user_id != Some(auth.internal_user_id.clone())
        {
            return Err(
                "This workflow version is not owned by the active Fable member and cannot be changed."
                    .into(),
            );
        }
        definition.workspace_id = existing.workspace_id.clone();
        definition.project_id = existing.project_id.clone();
        definition.authority = existing.authority.clone();
        definition.visibility = existing.visibility.clone();
        definition.owner_member_id = existing.owner_member_id.clone();
        definition.created_by_internal_user_id = existing.created_by_internal_user_id.clone();
        return Ok(());
    }
    let member_id = auth.member_id.as_deref().ok_or_else(|| {
        "An active Fable workspace membership is required to create a workflow version.".to_string()
    })?;
    definition.workspace_id = auth.data.workspace_id().to_string();
    definition.project_id = auth.data.project_id().map(str::to_string);
    definition.authority = "local".into();
    definition.visibility = "member-private".into();
    definition.owner_member_id = Some(member_id.to_string());
    definition.created_by_internal_user_id = Some(auth.internal_user_id.clone());
    Ok(())
}

fn apply_run_ownership(
    run: &mut WorkflowRunRecord,
    existing: Option<&WorkflowRunRecord>,
    auth: &AuthorizedCommandScope,
) -> Result<(), String> {
    if let Some(existing) = existing {
        if ownership_is_unresolved(
            &existing.authority,
            &existing.visibility,
            existing.owner_member_id.as_deref(),
            existing.created_by_internal_user_id.as_deref(),
        ) {
            run.workspace_id = existing.workspace_id.clone();
            run.project_id = existing.project_id.clone();
            run.authority.clear();
            run.visibility.clear();
            run.owner_member_id = None;
            run.created_by_internal_user_id = None;
            return Ok(());
        }
        if existing.workspace_id != auth.data.workspace_id()
            || existing.project_id.as_deref() != auth.data.project_id()
            || existing.authority != "local"
            || existing.visibility != "member-private"
            || existing.owner_member_id.as_deref() != auth.member_id.as_deref()
            || existing.created_by_internal_user_id != Some(auth.internal_user_id.clone())
        {
            return Err(
                "This workflow run is not owned by the active Fable member and cannot be changed."
                    .into(),
            );
        }
        run.workspace_id = existing.workspace_id.clone();
        run.project_id = existing.project_id.clone();
        run.authority = existing.authority.clone();
        run.visibility = existing.visibility.clone();
        run.owner_member_id = existing.owner_member_id.clone();
        run.created_by_internal_user_id = existing.created_by_internal_user_id.clone();
        return Ok(());
    }
    let member_id = auth.member_id.as_deref().ok_or_else(|| {
        "An active Fable workspace membership is required to create a workflow run.".to_string()
    })?;
    run.workspace_id = auth.data.workspace_id().to_string();
    run.project_id = auth.data.project_id().map(str::to_string);
    run.authority = "local".into();
    run.visibility = "member-private".into();
    run.owner_member_id = Some(member_id.to_string());
    run.created_by_internal_user_id = Some(auth.internal_user_id.clone());
    Ok(())
}

#[cfg(test)]
fn read_definitions(path: &Path) -> Result<Vec<WorkflowDefinitionRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read workflow definitions.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse workflow definitions.".to_string())
}

#[cfg(test)]
fn write_definitions(path: &Path, definitions: &[WorkflowDefinitionRecord]) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(definitions)
        .map_err(|_| "Fable could not encode workflow definitions.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded)
        .map_err(|_| "Fable could not save workflow definitions.".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "Fable could not commit workflow definitions.".to_string())
}

#[tauri::command]
pub fn save_workflow_definition(
    _app: tauri::AppHandle,
    definition: WorkflowDefinitionRecord,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<WorkflowDefinitionRecord, String> {
    let mut definition = normalize_definition(definition)?;
    let auth = authorized_scope::command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let existing = workflow::list_definitions(tx, store, &auth.data)?
                .into_iter()
                .find(|value| {
                    value.get("id").and_then(serde_json::Value::as_str)
                        == Some(definition.id.as_str())
                        && value.get("version").and_then(serde_json::Value::as_u64)
                            == Some(u64::from(definition.version))
                })
                .map(|value| {
                    serde_json::from_value::<WorkflowDefinitionRecord>(value).map_err(|_| {
                        crate::store::StoreError::Invalid(
                            "Stored workflow definition is invalid.".into(),
                        )
                    })
                })
                .transpose()?;
            apply_definition_ownership(&mut definition, existing.as_ref(), &auth)
                .map_err(crate::store::StoreError::Invalid)?;
            let value = serde_json::to_value(&definition).map_err(|_| {
                crate::store::StoreError::Invalid(
                    "Fable could not encode workflow definition.".into(),
                )
            })?;
            workflow::upsert_definition(
                tx,
                store,
                &auth.data,
                &definition.id,
                definition.version,
                &definition.created_at,
                &definition.updated_at,
                &value,
            )
        })
        .map_err(|error| error.to_string())?;
    record_definition_change(&definition);
    Ok(definition)
}

fn record_definition_change(definition: &WorkflowDefinitionRecord) {
    crate::action_history::Recorder::new(
        crate::action_history::categories::SCHEDULE,
        "workflow",
        &definition.id,
        definition.status.as_deref().unwrap_or("active"),
    )
    .actor("user")
    .mode(definition.permission_profile.as_deref().unwrap_or(""))
    .summary(&format!(
        "Workflow {} version {} saved.",
        definition.id, definition.version
    ))
    .record();
}

#[tauri::command]
pub fn list_workflow_definitions(
    _app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<WorkflowDefinitionRecord>, String> {
    let scope = authorized_scope::command_scope(workspace_id, project_id, ScopeAccess::Read)?.data;
    if let Some(values) = crate::store::with_store(|store| {
        store.with_conn(|conn| workflow::list_definitions(conn, store, &scope))
    })? {
        return values
            .into_iter()
            .map(|value| {
                serde_json::from_value(value)
                    .map_err(|_| "Fable could not decode workflow definition.".to_string())
            })
            .collect();
    }
    Err("Fable's encrypted workflow store is not initialized.".into())
}

fn normalize_run(mut run: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    run.id = truncate_characters(&normalize_spaces(&run.id), 160);
    run.definition_id = truncate_characters(&normalize_spaces(&run.definition_id), 160);
    run.status = normalize_spaces(&run.status).to_ascii_lowercase();
    run.trigger = normalize_spaces(&run.trigger).to_ascii_lowercase();
    run.started_at = normalize_spaces(&run.started_at);
    run.updated_at = normalize_spaces(&run.updated_at);
    run.input = crate::store::repos::connector_cache::redact_value(&run.input);
    run.steps = crate::store::repos::connector_cache::redact_value(&run.steps);
    run.failure_reason = run.failure_reason.take().map(|message| {
        crate::store::repos::connector_cache::redact_value(&serde_json::Value::String(message))
            .as_str()
            .unwrap_or("[redacted connector data]")
            .to_string()
    });
    if let Some(route) = &mut run.provider_route {
        crate::agent_runs::normalize_provider_route_binding(route)?;
        if run.trigger != "schedule"
            || route.selection.fallback_from_provider_route_id.is_some()
            || !matches!(
                run.status.as_str(),
                "completed" | "failed" | "blocked-auth" | "cancelled"
            )
        {
            return Err("Workflow provider route evidence is invalid.".to_string());
        }
    }
    if let Some(profile) = run.permission_profile.take() {
        let profile = normalize_spaces(&profile).to_ascii_lowercase();
        let mode = match profile.as_str() {
            "read-only" => "read-only",
            "trusted" => "trusted-scope",
            "full-with-approvals" => "full-access",
            _ => return Err("Workflow run permission profile is not recognized.".to_string()),
        };
        if run.status == "running" && run.trigger == "schedule" {
            crate::permission_policy::ensure_permission_allowed(
                mode,
                Some(&profile),
                "schedule-execution",
                "medium",
            )?;
        }
        run.permission_profile = Some(profile);
    } else if run.status == "running" && run.trigger == "schedule" {
        return Err("Scheduled workflow runs require a captured permission profile.".to_string());
    }

    if run.id.is_empty() || run.definition_id.is_empty() || run.started_at.is_empty() {
        return Err("Workflow run is incomplete.".to_string());
    }
    if !WORKFLOW_RUN_STATUSES.contains(&run.status.as_str()) {
        return Err("Workflow run status is not recognized.".to_string());
    }
    if !matches!(run.trigger.as_str(), "schedule" | "manual" | "voice") {
        return Err("Workflow run trigger is not recognized.".to_string());
    }
    Ok(run)
}

#[cfg(test)]
pub fn read_runs(path: &Path) -> Result<Vec<WorkflowRunRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents =
        fs::read_to_string(path).map_err(|_| "Fable could not read workflow runs.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<WorkflowRunRecord>>(&contents)
        .map_err(|_| "Fable could not parse workflow runs.".to_string())
}

#[cfg(test)]
fn write_runs(path: &Path, runs: &[WorkflowRunRecord]) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(runs)
        .map_err(|_| "Fable could not encode workflow runs.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded).map_err(|_| "Fable could not save workflow runs.".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "Fable could not commit workflow runs.".to_string())
}

/// Persist a run, replacing any existing record with the same id and capping
/// history to the most recent MAX_WORKFLOW_RUNS records.
#[cfg(test)]
fn persist_run(path: &Path, run: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    let run = normalize_run(run)?;
    let mut runs = read_runs(path)?;
    if let Some(existing) = runs.iter().find(|existing| existing.id == run.id) {
        ensure_provider_route_transition(existing, &run)?;
    }
    runs.retain(|r| r.id != run.id);
    runs.insert(0, run.clone());
    runs.truncate(MAX_WORKFLOW_RUNS);
    write_runs(path, &runs)?;
    Ok(run)
}

fn ensure_provider_route_transition(
    existing: &WorkflowRunRecord,
    incoming: &WorkflowRunRecord,
) -> Result<(), String> {
    if existing.provider_route.is_some() && existing.provider_route != incoming.provider_route {
        return Err("A workflow run provider route cannot be changed or removed.".to_string());
    }
    if existing.provider_route.is_none()
        && incoming.provider_route.is_some()
        && !matches!(
            incoming.status.as_str(),
            "completed" | "failed" | "blocked-auth" | "cancelled"
        )
    {
        return Err(
            "A workflow run route receipt requires completed execution evidence.".to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn save_workflow_run(
    _app: tauri::AppHandle,
    run: WorkflowRunRecord,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<WorkflowRunRecord, String> {
    let mut run = normalize_run(run)?;
    let auth = authorized_scope::command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            if let Some(existing) = workflow::list_runs(tx, store, &auth.data, None)?
                .into_iter()
                .find(|value| {
                    value.get("id").and_then(serde_json::Value::as_str) == Some(run.id.as_str())
                })
            {
                let existing =
                    serde_json::from_value::<WorkflowRunRecord>(existing).map_err(|_| {
                        crate::store::StoreError::Invalid("Stored workflow run is invalid.".into())
                    })?;
                ensure_provider_route_transition(&existing, &run)
                    .map_err(crate::store::StoreError::Invalid)?;
                apply_run_ownership(&mut run, Some(&existing), &auth)
                    .map_err(crate::store::StoreError::Invalid)?;
            } else {
                apply_run_ownership(&mut run, None, &auth)
                    .map_err(crate::store::StoreError::Invalid)?;
            }
            let value = serde_json::to_value(&run).map_err(|_| {
                crate::store::StoreError::Invalid("Fable could not encode workflow run.".into())
            })?;
            workflow::upsert_run(
                tx,
                store,
                &auth.data,
                &run.id,
                &run.definition_id,
                run.definition_version,
                &run.status,
                &run.started_at,
                &run.updated_at,
                &value,
            )
        })
        .map_err(|error| error.to_string())?;
    record_run_change(&run);
    Ok(run)
}

fn record_run_change(run: &WorkflowRunRecord) {
    crate::action_history::Recorder::new(
        crate::action_history::categories::SCHEDULE,
        "workflow",
        &run.definition_id,
        &run.status,
    )
    .correlation(&run.id)
    .mode(run.permission_profile.as_deref().unwrap_or(""))
    .error(if run.status == "failed" {
        "workflow-failed"
    } else {
        ""
    })
    .summary(&format!(
        "Workflow run {} changed to {}.",
        run.id, run.status
    ))
    .record();
}

/// Reconcile workflow journal state after an unclean shutdown. The scheduler
/// queue remains the execution authority and will re-lease the same occurrence;
/// the journal is moved back to `queued` so the UI never presents a stale run
/// as actively executing.
pub fn recover_stale_runs(app: &tauri::AppHandle) -> Result<usize, String> {
    let selected = crate::store::with_store(|store| {
        store.with_conn(
            crate::store::repos::workspace_directory::selected_active_workspace_for_current_user,
        )
    })?
    .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let Some(selected) = selected else {
        return Ok(0);
    };
    let workspace_id = selected.local_workspace_id;
    let mut runs = list_workflow_runs(app.clone(), Some(workspace_id.clone()), None)?;
    let recovered_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut recovered = 0;
    for run in &mut runs {
        if run.status != "running" {
            continue;
        }
        run.status = "queued".to_string();
        run.updated_at = recovered_at.clone();
        run.failure_reason = Some("Interrupted; queued for recovery.".to_string());
        save_workflow_run(app.clone(), run.clone(), Some(workspace_id.clone()), None)?;
        recovered += 1;
    }
    Ok(recovered)
}

#[tauri::command]
pub fn list_workflow_runs(
    _app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<WorkflowRunRecord>, String> {
    let scope = authorized_scope::command_scope(workspace_id, project_id, ScopeAccess::Read)?.data;
    if let Some(values) = crate::store::with_store(|store| {
        store.with_conn(|conn| workflow::list_runs(conn, store, &scope, None))
    })? {
        return values
            .into_iter()
            .map(|value| {
                serde_json::from_value(value)
                    .map_err(|_| "Fable could not decode workflow run.".to_string())
            })
            .collect();
    }
    Err("Fable's encrypted workflow store is not initialized.".into())
}

#[tauri::command]
pub fn list_workflow_runs_for_definition(
    _app: tauri::AppHandle,
    definition_id: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<WorkflowRunRecord>, String> {
    let definition_id = normalize_spaces(&definition_id);
    let scope = authorized_scope::command_scope(workspace_id, project_id, ScopeAccess::Read)?.data;
    if let Some(values) = crate::store::with_store(|store| {
        store.with_conn(|conn| workflow::list_runs(conn, store, &scope, Some(&definition_id)))
    })? {
        return values
            .into_iter()
            .map(|value| {
                serde_json::from_value(value)
                    .map_err(|_| "Fable could not decode workflow run.".to_string())
            })
            .collect();
    }
    Err("Fable's encrypted workflow store is not initialized.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::{DataScope, PrivateDataScope, DEFAULT_WORKSPACE_ID};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_path() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "fable-wf-{}-{}-{}.json",
            std::process::id(),
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_file(&p);
        p
    }

    fn sample_run(id: &str, status: &str) -> WorkflowRunRecord {
        WorkflowRunRecord {
            workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
            project_id: None,
            authority: String::new(),
            visibility: String::new(),
            owner_member_id: None,
            created_by_internal_user_id: None,
            id: id.to_string(),
            definition_id: "wf".to_string(),
            definition_version: 1,
            status: status.to_string(),
            trigger: "manual".to_string(),
            scheduled_job_id: None,
            permission_profile: None,
            provider_route: None,
            input: serde_json::json!({}),
            steps: serde_json::json!([]),
            failure_reason: None,
            idempotency_key: None,
            attempt_number: None,
            next_retry_at: None,
            started_at: "0".to_string(),
            updated_at: "0".to_string(),
            finished_at: None,
        }
    }

    fn sample_definition() -> WorkflowDefinitionRecord {
        WorkflowDefinitionRecord {
            workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
            project_id: None,
            authority: String::new(),
            visibility: String::new(),
            owner_member_id: None,
            created_by_internal_user_id: None,
            schema_version: WORKFLOW_RUN_STORE_VERSION,
            id: "wf".to_string(),
            version: 1,
            name: "Brief".to_string(),
            description: "A transparent brief.".to_string(),
            status: Some("active".to_string()),
            permission_profile: None,
            steps: serde_json::json!([{"kind":"prompt","id":"prompt","prompt":"Summarize"}]),
            notification_prefs: None,
            created_at: "2026-06-28T10:00:00Z".to_string(),
            updated_at: "2026-06-28T10:00:00Z".to_string(),
        }
    }

    fn route_binding() -> crate::models::ProviderRouteExecutionBinding {
        crate::models::ProviderRouteExecutionBinding {
            workspace_id: "workspace-1".into(),
            selection: crate::models::ProviderRouteSelection {
                provider_route_id: "provider-route:v2:openai:test".into(),
                selected_at: "2026-07-12T12:00:00Z".into(),
                reason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route.".into(),
                fallback_from_provider_route_id: None,
                boundary_policy_ref: Some("boundary:member-private:account-owned-provider:openai:local-credential-egress".into()),
                observation: None,
                quality: None,
                cost: None,
            },
        }
    }

    fn auth() -> AuthorizedCommandScope {
        let data = DataScope::new(DEFAULT_WORKSPACE_ID, Some("project-1".into())).unwrap();
        AuthorizedCommandScope {
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

    #[test]
    fn native_workflow_ownership_is_stamped_once_and_legacy_rows_stay_unresolved() {
        let auth = auth();
        let mut created = sample_definition();
        created.authority = "forged".into();
        created.owner_member_id = Some("member-2".into());
        apply_definition_ownership(&mut created, None, &auth).unwrap();
        assert_eq!(created.workspace_id, DEFAULT_WORKSPACE_ID);
        assert_eq!(created.project_id.as_deref(), Some("project-1"));
        assert_eq!(created.authority, "local");
        assert_eq!(created.visibility, "member-private");
        assert_eq!(created.owner_member_id.as_deref(), Some("member-1"));
        assert_eq!(
            created.created_by_internal_user_id.as_deref(),
            Some("user-1")
        );

        let mut forged_update = sample_definition();
        forged_update.owner_member_id = Some("member-2".into());
        apply_definition_ownership(&mut forged_update, Some(&created), &auth).unwrap();
        assert_eq!(forged_update.owner_member_id.as_deref(), Some("member-1"));

        let unresolved = sample_definition();
        let mut later_update = sample_definition();
        apply_definition_ownership(&mut later_update, Some(&unresolved), &auth).unwrap();
        assert!(later_update.authority.is_empty());
        assert!(later_update.owner_member_id.is_none());
        assert!(later_update.created_by_internal_user_id.is_none());

        let mut run = sample_run("run-owned", "completed");
        apply_run_ownership(&mut run, None, &auth).unwrap();
        assert_eq!(run.owner_member_id.as_deref(), Some("member-1"));
        assert_eq!(run.project_id.as_deref(), Some("project-1"));

        let mut foreign = run.clone();
        foreign.owner_member_id = Some("member-2".into());
        foreign.created_by_internal_user_id = Some("user-2".into());
        assert!(apply_run_ownership(&mut run, Some(&foreign), &auth).is_err());
    }

    #[test]
    fn scheduled_route_receipt_is_safe_and_can_only_be_added_once_after_execution() {
        let mut completed = sample_run("run-route", "completed");
        completed.trigger = "schedule".into();
        completed.permission_profile = Some("trusted".into());
        completed.provider_route = Some(route_binding());
        assert!(normalize_run(completed.clone()).is_ok());

        let mut running = completed.clone();
        running.status = "running".into();
        let mut without_route = running.clone();
        without_route.provider_route = None;
        assert!(ensure_provider_route_transition(&without_route, &running).is_err());
        assert!(ensure_provider_route_transition(&without_route, &completed).is_ok());

        let mut changed = completed.clone();
        changed.provider_route.as_mut().unwrap().selection.reason = "Changed".into();
        assert!(ensure_provider_route_transition(&completed, &changed).is_err());

        let mut secret = completed;
        secret.provider_route.as_mut().unwrap().selection.reason =
            "Authorization: Bearer provider-secret".into();
        assert!(normalize_run(secret).is_err());
    }

    #[test]
    fn round_trips_a_run() {
        let path = tmp_path();
        let run = sample_run("r1", "completed");
        persist_run(&path, run).unwrap();
        let read = read_runs(&path).unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].id, "r1");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn replace_existing_run_keeps_history_bounded() {
        let path = tmp_path();
        for i in 0..(MAX_WORKFLOW_RUNS + 5) {
            persist_run(&path, sample_run(&format!("r{i}"), "completed")).unwrap();
        }
        // Re-saving an existing id replaces it rather than adding a duplicate.
        persist_run(&path, sample_run("r0", "failed")).unwrap();
        let read = read_runs(&path).unwrap();
        assert!(read.len() <= MAX_WORKFLOW_RUNS);
        assert_eq!(read[0].id, "r0");
        assert_eq!(read[0].status, "failed");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn normalize_rejects_unknown_status() {
        let mut run = sample_run("r1", "completed");
        run.status = "bogus".to_string();
        assert!(normalize_run(run).is_err());
    }

    #[test]
    fn normalize_rejects_unknown_trigger() {
        let mut run = sample_run("r1", "completed");
        run.trigger = "auto".to_string();
        assert!(normalize_run(run).is_err());
    }

    #[test]
    fn versioned_definition_round_trips_without_overwriting_history() {
        let path = tmp_path();
        let first = normalize_definition(sample_definition()).unwrap();
        write_definitions(&path, std::slice::from_ref(&first)).unwrap();
        let mut second = sample_definition();
        second.version = 2;
        let mut definitions = read_definitions(&path).unwrap();
        definitions.insert(0, normalize_definition(second).unwrap());
        write_definitions(&path, &definitions).unwrap();
        let read = read_definitions(&path).unwrap();
        assert_eq!(
            read.iter()
                .map(|definition| definition.version)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
        let _ = fs::remove_file(path);
    }
}

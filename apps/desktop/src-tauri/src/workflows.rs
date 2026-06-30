//! Durable workflow-run journal. Atomic writes (tmp + rename) so a process
//! interruption cannot leave a partially encoded file. The rich step-record
//! shape is owned by the TS protocol; Rust owns durability + bounded history
//! only. Restart recovery of in-flight runs is handled by the TS layer marking
//! `running`/`awaiting-approval` runs as recoverable on resume.

use std::{fs, path::Path};

use crate::models::{
    WorkflowDefinitionRecord, WorkflowRunRecord, MAX_WORKFLOW_RUNS, MAX_WORKFLOW_STEPS,
    WORKFLOW_RUN_STATUSES, WORKFLOW_RUN_STORE_VERSION,
};
use crate::paths::{
    normalize_spaces, truncate_characters, workflow_definitions_path, workflow_runs_path,
};
use crate::store::repos::{scope::DataScope, workflow};

fn data_scope(
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<DataScope, String> {
    DataScope::new(
        workspace_id
            .unwrap_or_else(|| crate::store::repos::scope::DEFAULT_WORKSPACE_ID.to_string()),
        project_id,
    )
    .map_err(|error| error.to_string())
}

fn normalize_definition(
    mut definition: WorkflowDefinitionRecord,
) -> Result<WorkflowDefinitionRecord, String> {
    definition.id = truncate_characters(&normalize_spaces(&definition.id), 160);
    definition.name = truncate_characters(&normalize_spaces(&definition.name), 200);
    definition.description = truncate_characters(&normalize_spaces(&definition.description), 2_000);
    definition.created_at = normalize_spaces(&definition.created_at);
    definition.updated_at = normalize_spaces(&definition.updated_at);
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
    app: tauri::AppHandle,
    definition: WorkflowDefinitionRecord,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<WorkflowDefinitionRecord, String> {
    let definition = normalize_definition(definition)?;
    let scope = data_scope(workspace_id, project_id)?;
    let value = serde_json::to_value(&definition)
        .map_err(|_| "Fable could not encode workflow definition.".to_string())?;
    if crate::store::with_store(|store| {
        store.transaction(|tx| {
            workflow::upsert_definition(
                tx,
                store,
                &scope,
                &definition.id,
                definition.version,
                &definition.created_at,
                &definition.updated_at,
                &value,
            )
        })
    })?
    .is_some()
    {
        return Ok(definition);
    }
    let path = workflow_definitions_path(&app)?;
    let mut definitions = read_definitions(&path)?;
    definitions
        .retain(|existing| existing.id != definition.id || existing.version != definition.version);
    definitions.insert(0, definition.clone());
    definitions.truncate(500);
    write_definitions(&path, &definitions)?;
    Ok(definition)
}

#[tauri::command]
pub fn list_workflow_definitions(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<WorkflowDefinitionRecord>, String> {
    let scope = data_scope(workspace_id, project_id)?;
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
    read_definitions(&workflow_definitions_path(&app)?)
}

fn normalize_run(mut run: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    run.id = truncate_characters(&normalize_spaces(&run.id), 160);
    run.definition_id = truncate_characters(&normalize_spaces(&run.definition_id), 160);
    run.status = normalize_spaces(&run.status).to_ascii_lowercase();
    run.trigger = normalize_spaces(&run.trigger).to_ascii_lowercase();
    run.started_at = normalize_spaces(&run.started_at);
    run.updated_at = normalize_spaces(&run.updated_at);

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

fn write_runs(path: &Path, runs: &[WorkflowRunRecord]) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(runs)
        .map_err(|_| "Fable could not encode workflow runs.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded).map_err(|_| "Fable could not save workflow runs.".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "Fable could not commit workflow runs.".to_string())
}

/// Persist a run, replacing any existing record with the same id and capping
/// history to the most recent MAX_WORKFLOW_RUNS records.
pub fn persist_run(path: &Path, run: WorkflowRunRecord) -> Result<WorkflowRunRecord, String> {
    let run = normalize_run(run)?;
    let mut runs = read_runs(path)?;
    runs.retain(|r| r.id != run.id);
    runs.insert(0, run.clone());
    runs.truncate(MAX_WORKFLOW_RUNS);
    write_runs(path, &runs)?;
    Ok(run)
}

#[tauri::command]
pub fn save_workflow_run(
    app: tauri::AppHandle,
    run: WorkflowRunRecord,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<WorkflowRunRecord, String> {
    let run = normalize_run(run)?;
    let scope = data_scope(workspace_id, project_id)?;
    let value = serde_json::to_value(&run)
        .map_err(|_| "Fable could not encode workflow run.".to_string())?;
    if crate::store::with_store(|store| {
        store.transaction(|tx| {
            workflow::upsert_run(
                tx,
                store,
                &scope,
                &run.id,
                &run.definition_id,
                run.definition_version,
                &run.status,
                &run.started_at,
                &run.updated_at,
                &value,
            )
        })
    })?
    .is_some()
    {
        return Ok(run);
    }
    persist_run(&workflow_runs_path(&app)?, run)
}

#[tauri::command]
pub fn list_workflow_runs(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<WorkflowRunRecord>, String> {
    let scope = data_scope(workspace_id, project_id)?;
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
    read_runs(&workflow_runs_path(&app)?)
}

#[tauri::command]
pub fn list_workflow_runs_for_definition(
    app: tauri::AppHandle,
    definition_id: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<WorkflowRunRecord>, String> {
    let definition_id = normalize_spaces(&definition_id);
    let scope = data_scope(workspace_id, project_id)?;
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
    let runs = read_runs(&workflow_runs_path(&app)?)?;
    Ok(runs
        .into_iter()
        .filter(|r| r.definition_id == definition_id)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
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
            id: id.to_string(),
            definition_id: "wf".to_string(),
            definition_version: 1,
            status: status.to_string(),
            trigger: "manual".to_string(),
            scheduled_job_id: None,
            input: serde_json::json!({}),
            steps: serde_json::json!([]),
            failure_reason: None,
            idempotency_key: None,
            started_at: "0".to_string(),
            updated_at: "0".to_string(),
            finished_at: None,
        }
    }

    fn sample_definition() -> WorkflowDefinitionRecord {
        WorkflowDefinitionRecord {
            schema_version: WORKFLOW_RUN_STORE_VERSION,
            id: "wf".to_string(),
            version: 1,
            name: "Brief".to_string(),
            description: "A transparent brief.".to_string(),
            steps: serde_json::json!([{"kind":"prompt","id":"prompt","prompt":"Summarize"}]),
            notification_prefs: None,
            created_at: "2026-06-28T10:00:00Z".to_string(),
            updated_at: "2026-06-28T10:00:00Z".to_string(),
        }
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

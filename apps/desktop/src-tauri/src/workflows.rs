//! Durable workflow-run journal. Atomic writes (tmp + rename) so a process
//! interruption cannot leave a partially encoded file. The rich step-record
//! shape is owned by the TS protocol; Rust owns durability + bounded history
//! only. Restart recovery of in-flight runs is handled by the TS layer marking
//! `running`/`awaiting-approval` runs as recoverable on resume.

use std::{fs, path::Path};

use crate::models::{WorkflowRunRecord, MAX_WORKFLOW_RUNS, WORKFLOW_RUN_STATUSES};
use crate::paths::{normalize_spaces, truncate_characters, workflow_runs_path};

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
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read workflow runs.".to_string())?;
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
) -> Result<WorkflowRunRecord, String> {
    persist_run(&workflow_runs_path(&app)?, run)
}

#[tauri::command]
pub fn list_workflow_runs(app: tauri::AppHandle) -> Result<Vec<WorkflowRunRecord>, String> {
    read_runs(&workflow_runs_path(&app)?)
}

#[tauri::command]
pub fn list_workflow_runs_for_definition(
    app: tauri::AppHandle,
    definition_id: String,
) -> Result<Vec<WorkflowRunRecord>, String> {
    let definition_id = normalize_spaces(&definition_id);
    let runs = read_runs(&workflow_runs_path(&app)?)?;
    Ok(runs.into_iter().filter(|r| r.definition_id == definition_id).collect())
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
}

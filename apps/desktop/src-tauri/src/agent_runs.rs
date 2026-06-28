//! Durable native-agent run journal.
//!
//! The journal contains only non-secret run state. It is written atomically so
//! a process interruption cannot leave a partially encoded run file. On app
//! restart, in-flight runs are marked `interrupted` and remain recoverable for
//! explicit resume/retry.

use std::{fs, path::Path};

use crate::models::{
    PersistedAgentRun, MAX_AGENT_RUNS, MAX_AGENT_RUN_TRANSCRIPT_CHARACTERS,
    MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
};
use crate::paths::{agent_runs_path, normalize_spaces, truncate_characters};

const RUN_STATUSES: [&str; 8] = [
    "queued",
    "streaming",
    "awaiting-approval",
    "retrying",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
];

pub(crate) fn normalize_agent_run(mut run: PersistedAgentRun) -> Result<PersistedAgentRun, String> {
    run.id = truncate_characters(
        &normalize_spaces(&run.id),
        MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
    );
    run.provider_id = truncate_characters(&normalize_spaces(&run.provider_id), 80);
    run.model = truncate_characters(&normalize_spaces(&run.model), 160);
    run.status = normalize_spaces(&run.status).to_ascii_lowercase();
    run.transcript = truncate_characters(&run.transcript, MAX_AGENT_RUN_TRANSCRIPT_CHARACTERS);
    run.thread_id = run
        .thread_id
        .map(|value| truncate_characters(&normalize_spaces(&value), 160))
        .filter(|value| !value.is_empty());
    run.parent_run_id = run
        .parent_run_id
        .map(|value| truncate_characters(&normalize_spaces(&value), 160))
        .filter(|value| !value.is_empty() && value != &run.id);
    run.exchanges = run
        .exchanges
        .into_iter()
        .filter_map(|mut exchange| {
            exchange.role = normalize_spaces(&exchange.role).to_ascii_lowercase();
            if !matches!(exchange.role.as_str(), "user" | "assistant" | "tool") {
                return None;
            }
            exchange.content =
                truncate_characters(&exchange.content, MAX_AGENT_RUN_TRANSCRIPT_CHARACTERS);
            exchange.tool_call_id = exchange
                .tool_call_id
                .map(|value| truncate_characters(&normalize_spaces(&value), 160))
                .filter(|value| !value.is_empty());
            exchange.tool_name = exchange
                .tool_name
                .map(|value| truncate_characters(&normalize_spaces(&value), 120))
                .filter(|value| !value.is_empty());
            Some(exchange)
        })
        .take(256)
        .collect();
    run.pending_approval_ids = run
        .pending_approval_ids
        .into_iter()
        .map(|value| truncate_characters(&normalize_spaces(&value), 160))
        .filter(|value| !value.is_empty())
        .take(100)
        .collect();
    run.error = run
        .error
        .map(|value| truncate_characters(&normalize_spaces(&value), 2_000))
        .filter(|value| !value.is_empty());
    run.created_at = normalize_spaces(&run.created_at);
    run.updated_at = normalize_spaces(&run.updated_at);

    if run.id.is_empty()
        || run.provider_id.is_empty()
        || run.model.is_empty()
        || run.created_at.is_empty()
        || run.updated_at.is_empty()
        || !RUN_STATUSES.contains(&run.status.as_str())
    {
        return Err("Agent run state is incomplete or invalid.".to_string());
    }
    if let Some(usage) = &run.usage {
        if !usage.cost_usd.is_finite() || usage.cost_usd < 0.0 {
            return Err("Agent run usage is invalid.".to_string());
        }
    }
    Ok(run)
}

pub(crate) fn read_agent_runs(path: &Path) -> Result<Vec<PersistedAgentRun>, String> {
    if let Some(runs) = crate::store::read_document(path)? {
        return Ok(runs);
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read agent run state.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse agent run state.".to_string())
}

fn write_agent_runs(path: &Path, runs: &[PersistedAgentRun]) -> Result<(), String> {
    if crate::store::write_document(path, &runs)? {
        return Ok(());
    }
    let encoded = serde_json::to_vec_pretty(runs)
        .map_err(|_| "Fable could not encode agent run state.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded)
        .map_err(|_| "Fable could not save agent run state.".to_string())?;
    fs::rename(&temporary, path).map_err(|_| "Fable could not commit agent run state.".to_string())
}

pub(crate) fn persist_agent_run(
    path: &Path,
    run: PersistedAgentRun,
) -> Result<PersistedAgentRun, String> {
    let run = normalize_agent_run(run)?;
    let mut runs = read_agent_runs(path)?;
    runs.retain(|existing| existing.id != run.id);
    runs.insert(0, run.clone());
    runs.truncate(MAX_AGENT_RUNS);
    write_agent_runs(path, &runs)?;
    Ok(run)
}

pub(crate) fn recover_agent_runs_at(
    path: &Path,
    recovered_at: &str,
) -> Result<Vec<PersistedAgentRun>, String> {
    let mut runs = read_agent_runs(path)?;
    let mut changed = false;
    for run in &mut runs {
        if matches!(
            run.status.as_str(),
            "queued" | "streaming" | "awaiting-approval" | "retrying"
        ) {
            run.status = "interrupted".to_string();
            run.recoverable = true;
            run.updated_at = recovered_at.to_string();
            changed = true;
        }
    }
    if changed {
        write_agent_runs(path, &runs)?;
    }
    Ok(runs)
}

#[tauri::command]
pub fn save_agent_run(
    app: tauri::AppHandle,
    run: PersistedAgentRun,
) -> Result<PersistedAgentRun, String> {
    persist_agent_run(&agent_runs_path(&app)?, run)
}

#[tauri::command]
pub fn list_agent_runs(app: tauri::AppHandle) -> Result<Vec<PersistedAgentRun>, String> {
    read_agent_runs(&agent_runs_path(&app)?)
}

#[tauri::command]
pub fn recover_interrupted_agent_runs(
    app: tauri::AppHandle,
    recovered_at: String,
) -> Result<Vec<PersistedAgentRun>, String> {
    recover_agent_runs_at(&agent_runs_path(&app)?, &normalize_spaces(&recovered_at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentRunUsage;

    fn fixture(status: &str) -> PersistedAgentRun {
        PersistedAgentRun {
            id: "run-1".to_string(),
            provider_id: "openai".to_string(),
            model: "gpt-5".to_string(),
            status: status.to_string(),
            transcript: "partial response".to_string(),
            turn: 1,
            usage: Some(AgentRunUsage {
                input_tokens: 10,
                output_tokens: 4,
                cost_usd: 0.01,
                cost_estimated: true,
            }),
            thread_id: Some("thread-1".to_string()),
            exchanges: vec![crate::models::PersistedAgentExchange {
                role: "user".to_string(),
                content: "Summarize this".to_string(),
                tool_call_id: None,
                tool_name: None,
                ok: None,
            }],
            parent_run_id: None,
            pending_approval_ids: vec!["approval-1".to_string()],
            recoverable: true,
            retry_count: 1,
            error: None,
            created_at: "2026-06-27T12:00:00Z".to_string(),
            updated_at: "2026-06-27T12:00:01Z".to_string(),
        }
    }

    #[test]
    fn restart_marks_inflight_run_interrupted_without_losing_state() {
        let path =
            std::env::temp_dir().join(format!("fable-agent-runs-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        persist_agent_run(&path, fixture("streaming")).expect("persist");
        let recovered = recover_agent_runs_at(&path, "2026-06-27T12:01:00Z").expect("recover");
        assert_eq!(recovered[0].status, "interrupted");
        assert_eq!(recovered[0].transcript, "partial response");
        assert_eq!(recovered[0].pending_approval_ids, vec!["approval-1"]);
        assert_eq!(recovered[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(recovered[0].exchanges.len(), 1);
        assert!(recovered[0].recoverable);
        let _ = fs::remove_file(path);
    }
}

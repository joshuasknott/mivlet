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
use crate::paths::{normalize_spaces, truncate_characters};
use crate::store::repos::{run, scope::DataScope, workspace_directory};

fn runtime_scope() -> Result<DataScope, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let active = workspace_directory::resolve_active_workspace_for_current_user(tx)?
                .unwrap_or(workspace_directory::legacy_default_workspace(tx)?);
            DataScope::workspace(active.local_workspace_id)
        })
        .map_err(|e| e.to_string())
}

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
    _app: tauri::AppHandle,
    run: PersistedAgentRun,
) -> Result<PersistedAgentRun, String> {
    let run = normalize_agent_run(run)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = runtime_scope()?;
    store
        .transaction(|tx| {
            if let Some(existing) = run::get_scoped(tx, store, &scope, &run.id)? {
                let terminal = matches!(
                    existing.status.as_str(),
                    "completed" | "cancelled" | "failed" | "interrupted"
                );
                if terminal
                    && matches!(
                        run.status.as_str(),
                        "queued" | "streaming" | "awaiting-approval" | "retrying"
                    )
                {
                    return Err(crate::store::StoreError::Invalid(
                        "A terminal agent run cannot return to an in-flight state.".into(),
                    ));
                }
            }
            let payload = serde_json::to_value(&run).map_err(|_| {
                crate::store::StoreError::Invalid("Agent run could not be encoded.".into())
            })?;
            run::upsert_scoped(
                tx,
                store,
                &scope,
                &run.id,
                run.thread_id.as_deref(),
                &run.provider_id,
                &run.model,
                &run.status,
                run.turn,
                run.recoverable,
                run.retry_count,
                &run.created_at,
                &run.updated_at,
                &payload,
            )
        })
        .map_err(|e| e.to_string())?;
    Ok(run)
}

#[tauri::command]
pub fn list_agent_runs(_app: tauri::AppHandle) -> Result<Vec<PersistedAgentRun>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = runtime_scope()?;
    store
        .with_conn(|tx| {
            let ids = run::list_by_status_scoped(tx, &scope, &RUN_STATUSES)?;
            ids.into_iter()
                .map(|id| {
                    run::get_scoped(tx, store, &scope, &id)?
                        .and_then(|row| serde_json::from_value(row.payload).ok())
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "Agent run payload is invalid.".into(),
                            )
                        })
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recover_interrupted_agent_runs(
    _app: tauri::AppHandle,
    recovered_at: String,
) -> Result<Vec<PersistedAgentRun>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let scope = runtime_scope()?;
    let recovered_at = normalize_spaces(&recovered_at);
    store
        .transaction(|tx| {
            let ids = run::list_by_status_scoped(
                tx,
                &scope,
                &["queued", "streaming", "awaiting-approval", "retrying"],
            )?;
            let mut out = Vec::new();
            for id in ids {
                let row = run::get_scoped(tx, store, &scope, &id)?.ok_or_else(|| {
                    crate::store::StoreError::Invalid("Run disappeared during recovery.".into())
                })?;
                let mut value: PersistedAgentRun =
                    serde_json::from_value(row.payload).map_err(|_| {
                        crate::store::StoreError::Invalid("Agent run payload is invalid.".into())
                    })?;
                value.status = "interrupted".into();
                value.recoverable = true;
                value.pending_approval_ids.clear();
                value.updated_at = recovered_at.clone();
                let payload = serde_json::to_value(&value).map_err(|_| {
                    crate::store::StoreError::Invalid("Agent run could not be encoded.".into())
                })?;
                run::upsert_scoped(
                    tx,
                    store,
                    &scope,
                    &value.id,
                    value.thread_id.as_deref(),
                    &value.provider_id,
                    &value.model,
                    &value.status,
                    value.turn,
                    value.recoverable,
                    value.retry_count,
                    &value.created_at,
                    &value.updated_at,
                    &payload,
                )?;
                out.push(value);
            }
            let all = run::list_by_status_scoped(tx, &scope, &RUN_STATUSES)?;
            for id in all {
                if let Some(row) = run::get_scoped(tx, store, &scope, &id)? {
                    if let Ok(value) = serde_json::from_value::<PersistedAgentRun>(row.payload) {
                        if !out.iter().any(|r: &PersistedAgentRun| r.id == value.id) {
                            out.push(value)
                        }
                    }
                }
            }
            Ok(out)
        })
        .map_err(|e| e.to_string())
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

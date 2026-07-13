//! Durable native-agent run journal.
//!
//! The journal contains only non-secret run state. It is written atomically so
//! a process interruption cannot leave a partially encoded run file. On app
//! restart, in-flight runs are marked `interrupted` and remain recoverable for
//! explicit resume/retry.

use chrono::{DateTime, SecondsFormat, Utc};
use std::{collections::HashSet, fs, path::Path};

use crate::models::{
    PersistedAgentRun, RunContextCitation, RunContextContribution, RunContextReceipt,
    RunContextScope, MAX_AGENT_RUNS, MAX_AGENT_RUN_TRANSCRIPT_CHARACTERS,
    MAX_RUNTIME_SNAPSHOT_ID_CHARACTERS,
};
use crate::paths::{normalize_spaces, truncate_characters};
use crate::store::repos::{run, scope::DataScope, workspace_directory};

fn runtime_scope() -> Result<DataScope, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let active = workspace_directory::require_active_workspace_for_current_user(tx)?;
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

const MAX_CONTEXT_CITATIONS: usize = 16;
const MAX_CONTEXT_CONTRIBUTIONS: usize = 256;
const MAX_CONTEXT_ID: usize = 160;
const MAX_CONTEXT_TITLE: usize = 256;
const MAX_CONTEXT_SNIPPET: usize = 2_000;
const MAX_CONTEXT_PROVENANCE: usize = 512;
const MAX_CONTEXT_PATH: usize = 512;

fn bounded_id(value: &str, max: usize, label: &str) -> Result<String, String> {
    let normalized = normalize_spaces(value);
    if normalized.is_empty() || normalized.chars().count() > max {
        return Err(format!("Run context {label} is invalid."));
    }
    if contains_secret_shape(&normalized) {
        return Err("Run context receipts cannot contain secret-shaped data.".to_string());
    }
    Ok(normalized)
}

fn bounded_text(value: &str, max: usize, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("Run context {label} is invalid."));
    }
    let safe = if contains_secret_shape(trimmed) {
        "[redacted secret-bearing context]".to_string()
    } else {
        trimmed.to_string()
    };
    Ok(truncate_characters(&safe, max))
}

fn optional_bounded(
    value: Option<String>,
    max: usize,
    label: &str,
) -> Result<Option<String>, String> {
    value
        .map(|value| bounded_id(&value, max, label))
        .transpose()
}

fn contains_secret_shape(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "authorization:",
        "bearer ",
        "cookie:",
        "access_token",
        "refresh_token",
        "client_secret",
        "xoxb-",
        "xoxp-",
        "ghp_",
        "github_pat_",
        "sk-",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn normalize_context_scope(mut scope: RunContextScope) -> Result<RunContextScope, String> {
    scope.level = normalize_spaces(&scope.level).to_ascii_lowercase();
    scope.project_id = optional_bounded(scope.project_id, MAX_CONTEXT_ID, "project id")?;
    scope.thread_id = optional_bounded(scope.thread_id, MAX_CONTEXT_ID, "thread id")?;
    let valid = match scope.level.as_str() {
        "global" => scope.project_id.is_none() && scope.thread_id.is_none(),
        "project" => scope.project_id.is_some() && scope.thread_id.is_none(),
        "thread" => scope.thread_id.is_some(),
        _ => false,
    };
    if !valid {
        return Err("Run context scope is invalid.".to_string());
    }
    Ok(scope)
}

fn scope_is_within(candidate: &RunContextScope, receipt: &RunContextScope) -> bool {
    match candidate.level.as_str() {
        "global" => true,
        "project" => receipt.level != "global" && candidate.project_id == receipt.project_id,
        "thread" => receipt.level == "thread" && candidate.thread_id == receipt.thread_id,
        _ => false,
    }
}

fn normalize_context_citation(
    mut citation: RunContextCitation,
    receipt_scope: &RunContextScope,
) -> Result<RunContextCitation, String> {
    citation.source_id = bounded_id(&citation.source_id, MAX_CONTEXT_ID, "source id")?;
    citation.title = bounded_text(&citation.title, MAX_CONTEXT_TITLE, "citation title")?;
    citation.snippet = bounded_text(&citation.snippet, MAX_CONTEXT_SNIPPET, "citation snippet")?;
    citation.provenance = bounded_text(
        &citation.provenance,
        MAX_CONTEXT_PROVENANCE,
        "citation provenance",
    )?;
    citation.freshness = bounded_text(&citation.freshness, 160, "citation freshness")?;
    citation.trust = normalize_spaces(&citation.trust).to_ascii_lowercase();
    if !matches!(citation.trust.as_str(), "trusted" | "untrusted") {
        return Err("Run context citation trust is invalid.".to_string());
    }
    citation.chunk_id = optional_bounded(citation.chunk_id, MAX_CONTEXT_ID, "chunk id")?;
    citation.account = optional_bounded(citation.account, MAX_CONTEXT_ID, "account")?;
    citation.source_path = optional_bounded(citation.source_path, MAX_CONTEXT_PATH, "source path")?;
    if citation.source_path.as_deref().is_some_and(|path| {
        path.starts_with('/')
            || path.starts_with('\\')
            || path.contains(":\\")
            || path.contains(":/")
    }) {
        return Err("Run context source paths must stay relative.".to_string());
    }
    citation.media_type = optional_bounded(citation.media_type, 120, "media type")?;
    citation.scope = citation.scope.map(normalize_context_scope).transpose()?;
    if citation
        .scope
        .as_ref()
        .is_some_and(|scope| !scope_is_within(scope, receipt_scope))
    {
        return Err("Run context citation scope exceeds the run scope.".to_string());
    }
    let scores = [
        citation.score,
        citation.ranking.relevance,
        citation.ranking.recency,
        citation.ranking.authority,
        citation.ranking.pin,
        citation.ranking.feedback,
    ];
    if scores
        .iter()
        .any(|score| !score.is_finite() || *score < 0.0)
    {
        return Err("Run context citation ranking is invalid.".to_string());
    }
    Ok(citation)
}

fn normalize_context_contribution(
    mut contribution: RunContextContribution,
    citation_ids: &HashSet<String>,
) -> Result<RunContextContribution, String> {
    contribution.id = bounded_id(&contribution.id, MAX_CONTEXT_ID, "contribution id")?;
    contribution.kind = normalize_spaces(&contribution.kind).to_ascii_lowercase();
    contribution.reason = normalize_spaces(&contribution.reason).to_ascii_lowercase();
    if !matches!(
        contribution.kind.as_str(),
        "memory" | "source" | "tool-result" | "conversation" | "instruction"
    ) || !matches!(
        contribution.reason.as_str(),
        "system-instruction"
            | "conversation"
            | "project-context"
            | "pinned"
            | "memory-approved"
            | "memory-pinned"
            | "retrieved"
            | "tool-result"
    ) {
        return Err("Run context contribution vocabulary is invalid.".to_string());
    }
    contribution.citation_id =
        optional_bounded(contribution.citation_id, MAX_CONTEXT_ID, "citation id")?;
    if contribution.reason == "retrieved"
        && (contribution.kind != "source"
            || contribution
                .citation_id
                .as_ref()
                .is_none_or(|id| !citation_ids.contains(id)))
    {
        return Err("Retrieved context contributions need a matching citation.".to_string());
    }
    if contribution.kind != "source" && contribution.citation_id.is_some() {
        return Err("Only source contributions can name a citation.".to_string());
    }
    Ok(contribution)
}

fn normalize_context_receipt(
    mut receipt: RunContextReceipt,
    run_id: &str,
    thread_id: Option<&str>,
) -> Result<RunContextReceipt, String> {
    if !matches!(receipt.version, 1 | 2) || receipt.run_id != run_id {
        return Err("Run context receipt identity is invalid.".to_string());
    }
    receipt.run_id = bounded_id(&receipt.run_id, MAX_CONTEXT_ID, "run id")?;
    let assembled = DateTime::parse_from_rfc3339(&receipt.assembled_at)
        .map_err(|_| "Run context assembly time is invalid.".to_string())?;
    receipt.assembled_at = assembled
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    receipt.scope = normalize_context_scope(receipt.scope)?;
    if receipt.version == 1 && receipt.audience.is_some() {
        return Err("Legacy context receipts cannot declare an audience.".to_string());
    }
    if receipt.version == 2 && receipt.audience.is_none() {
        return Err("Private context receipts need an audience.".to_string());
    }
    if receipt.scope.level == "thread" && receipt.scope.thread_id.as_deref() != thread_id {
        return Err("Run context receipt thread does not match the run.".to_string());
    }
    if receipt.citations.len() > MAX_CONTEXT_CITATIONS
        || receipt.contributions.len() > MAX_CONTEXT_CONTRIBUTIONS
    {
        return Err("Run context receipt exceeds its item limits.".to_string());
    }
    receipt.citations = receipt
        .citations
        .into_iter()
        .map(|citation| normalize_context_citation(citation, &receipt.scope))
        .collect::<Result<_, _>>()?;
    let citation_ids = receipt
        .citations
        .iter()
        .map(|citation| {
            citation
                .chunk_id
                .clone()
                .unwrap_or_else(|| citation.source_id.clone())
        })
        .collect::<HashSet<_>>();
    receipt.contributions = receipt
        .contributions
        .into_iter()
        .map(|contribution| normalize_context_contribution(contribution, &citation_ids))
        .collect::<Result<_, _>>()?;
    Ok(receipt)
}

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
    run.context_receipt = run
        .context_receipt
        .map(|receipt| normalize_context_receipt(receipt, &run.id, run.thread_id.as_deref()))
        .transpose()?;
    if let Some(route) = &mut run.provider_route {
        normalize_provider_route_binding(route)?;
        crate::backends::validate_persisted_native_provider_route_selection(
            &run.provider_id,
            &run.model,
            &route.selection.provider_route_id,
            &route.selection,
        )?;
    }
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

pub(crate) fn normalize_provider_route_binding(
    route: &mut crate::models::ProviderRouteExecutionBinding,
) -> Result<(), String> {
    route.workspace_id = normalize_spaces(&route.workspace_id);
    route.selection.provider_route_id = normalize_spaces(&route.selection.provider_route_id);
    route.selection.selected_at = normalize_spaces(&route.selection.selected_at);
    route.selection.reason = normalize_spaces(&route.selection.reason);
    route.selection.boundary_policy_ref = route
        .selection
        .boundary_policy_ref
        .take()
        .map(|value| normalize_spaces(&value))
        .filter(|value| !value.is_empty());
    route.selection.fallback_from_provider_route_id = route
        .selection
        .fallback_from_provider_route_id
        .take()
        .map(|value| normalize_spaces(&value))
        .filter(|value| !value.is_empty());
    if route.workspace_id.is_empty()
        || route.workspace_id.len() > 160
        || route.selection.provider_route_id.is_empty()
        || route.selection.provider_route_id.len() > 240
        || route.selection.reason.is_empty()
        || route.selection.reason.len() > 500
        || contains_secret_shape(&route.selection.reason)
        || route
            .selection
            .boundary_policy_ref
            .as_ref()
            .is_none_or(|value| value.len() > 240)
        || chrono::DateTime::parse_from_rfc3339(&route.selection.selected_at).is_err()
    {
        return Err("Provider route evidence is invalid.".to_string());
    }
    Ok(())
}

pub(crate) fn read_agent_runs(path: &Path) -> Result<Vec<PersistedAgentRun>, String> {
    if let Some(runs) = crate::store::read_document::<Vec<PersistedAgentRun>>(path)? {
        return runs.into_iter().map(normalize_agent_run).collect();
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read agent run state.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    let runs: Vec<PersistedAgentRun> = serde_json::from_str(&contents)
        .map_err(|_| "Fable could not parse agent run state.".to_string())?;
    runs.into_iter().map(normalize_agent_run).collect()
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
    if let Some(existing) = runs.iter().find(|existing| existing.id == run.id) {
        if existing.thread_id != run.thread_id || existing.created_at != run.created_at {
            return Err("Agent run ownership and creation identity are immutable.".to_string());
        }
        if is_terminal_status(&existing.status) {
            if existing == &run {
                return Ok(run);
            }
            return Err("A terminal agent run is immutable.".to_string());
        }
        ensure_run_evidence_immutable(existing, &run)?;
    }
    runs.retain(|existing| existing.id != run.id);
    runs.insert(0, run.clone());
    runs.truncate(MAX_AGENT_RUNS);
    write_agent_runs(path, &runs)?;
    Ok(run)
}

fn ensure_run_evidence_immutable(
    existing: &PersistedAgentRun,
    incoming: &PersistedAgentRun,
) -> Result<(), String> {
    if existing.context_receipt.is_some() && existing.context_receipt != incoming.context_receipt {
        return Err("A run context receipt cannot be changed or removed.".to_string());
    }
    if existing.provider_route != incoming.provider_route {
        return Err("A run provider route cannot be changed or removed.".to_string());
    }
    Ok(())
}

fn is_terminal_status(status: &str) -> bool {
    matches!(status, "completed" | "cancelled" | "failed" | "interrupted")
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

fn validate_context_receipt_authority(receipt: &RunContextReceipt) -> Result<(), String> {
    if receipt.version == 1 {
        return if receipt.citations.is_empty() && receipt.contributions.is_empty() {
            Ok(())
        } else {
            Err(
                "New sourced runs require a version 2 context receipt with an audience."
                    .to_string(),
            )
        };
    }
    let audience = receipt
        .audience
        .as_ref()
        .ok_or_else(|| "Private context receipts need an audience.".to_string())?;
    if audience.authority != "local" || audience.visibility != "member-private" {
        return Err(
            "Shared context audiences are unavailable until native sharing authority exists."
                .to_string(),
        );
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let context = store
        .with_conn(workspace_directory::require_active_workspace_context_for_current_user)
        .map_err(|error| error.to_string())?;
    validate_context_receipt_for_owner(
        receipt,
        &context.internal_user_id,
        context.member_id.as_deref(),
    )
}

fn validate_context_receipt_for_owner(
    receipt: &RunContextReceipt,
    internal_user_id: &str,
    member_id: Option<&str>,
) -> Result<(), String> {
    if receipt.version == 1 {
        return Ok(());
    }
    let audience = receipt
        .audience
        .as_ref()
        .ok_or_else(|| "Private context receipts need an audience.".to_string())?;
    if audience.authority != "local" || audience.visibility != "member-private" {
        return Err(
            "Shared context audiences are unavailable until native sharing authority exists."
                .to_string(),
        );
    }
    let audience_matches = match member_id {
        Some(member_id) => {
            audience.acting_member_id.as_deref() == Some(member_id)
                && audience.acting_internal_user_id.is_none()
        }
        None => {
            audience.acting_internal_user_id.as_deref() == Some(internal_user_id)
                && audience.acting_member_id.is_none()
        }
    };
    if !audience_matches {
        return Err("Run context audience does not match the active private owner.".to_string());
    }
    for citation in &receipt.citations {
        let authority = citation.authority_scope.as_ref().ok_or_else(|| {
            "Private context citations need canonical authority facts.".to_string()
        })?;
        let owner_matches = match member_id {
            Some(member_id) => {
                authority.owner_member_id.as_deref() == Some(member_id)
                    && authority.owner_internal_user_id.is_none()
            }
            None => {
                authority.owner_internal_user_id.as_deref() == Some(internal_user_id)
                    && authority.owner_member_id.is_none()
            }
        };
        if authority.authority != "local"
            || authority.visibility != "member-private"
            || !owner_matches
        {
            return Err(
                "Run context citation authority does not match the active private owner."
                    .to_string(),
            );
        }
    }
    Ok(())
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
    if let Some(receipt) = run.context_receipt.as_ref() {
        validate_context_receipt_authority(receipt)?;
    }
    store
        .transaction(|tx| {
            if let Some(existing) = run::get_scoped(tx, store, &scope, &run.id)? {
                let existing_value: PersistedAgentRun =
                    serde_json::from_value(existing.payload.clone()).map_err(|_| {
                        crate::store::StoreError::Invalid("Agent run payload is invalid.".into())
                    })?;
                ensure_run_evidence_immutable(&existing_value, &run)
                    .map_err(crate::store::StoreError::Invalid)?;
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
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "Agent run payload is invalid.".into(),
                            )
                        })
                        .and_then(|row| {
                            serde_json::from_value(row.payload).map_err(|_| {
                                crate::store::StoreError::Invalid(
                                    "Agent run payload is invalid.".into(),
                                )
                            })
                        })
                        .and_then(|run| {
                            normalize_agent_run(run).map_err(crate::store::StoreError::Invalid)
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
                let value: PersistedAgentRun =
                    serde_json::from_value(row.payload).map_err(|_| {
                        crate::store::StoreError::Invalid("Agent run payload is invalid.".into())
                    })?;
                let mut value =
                    normalize_agent_run(value).map_err(crate::store::StoreError::Invalid)?;
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
                    let decoded = serde_json::from_value::<PersistedAgentRun>(row.payload)
                        .map_err(|_| {
                            crate::store::StoreError::Invalid(
                                "Agent run payload is invalid.".into(),
                            )
                        })?;
                    let value =
                        normalize_agent_run(decoded).map_err(crate::store::StoreError::Invalid)?;
                    if !out.iter().any(|r: &PersistedAgentRun| r.id == value.id) {
                        out.push(value)
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
    use crate::models::{
        AgentRunUsage, RunContextCitation, RunContextContribution, RunContextRanking,
        RunContextReceipt, RunContextScope,
    };

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
            context_receipt: None,
            provider_route: None,
            pending_approval_ids: vec!["approval-1".to_string()],
            recoverable: true,
            retry_count: 1,
            error: None,
            created_at: "2026-06-27T12:00:00Z".to_string(),
            updated_at: "2026-06-27T12:00:01Z".to_string(),
        }
    }

    #[test]
    fn provider_route_is_structurally_valid_and_immutable_from_first_save() {
        let mut initial = fixture("streaming");
        let route = crate::models::ProviderRouteExecutionBinding {
            workspace_id: "workspace-1".into(),
            selection: crate::models::ProviderRouteSelection {
                provider_route_id: "provider-route:v2:openai:test".into(),
                selected_at: "2026-07-12T12:00:00Z".into(),
                reason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route.".into(),
                fallback_from_provider_route_id: None,
                boundary_policy_ref: Some("boundary:member-private:account-owned-provider:openai:local-credential-egress".into()),
                observation: None,
                cost: None,
            },
        };
        initial.provider_route = Some(route.clone());
        assert!(normalize_agent_run(initial.clone()).is_ok());
        let mut secret_bearing = initial.clone();
        secret_bearing
            .provider_route
            .as_mut()
            .unwrap()
            .selection
            .reason = "Authorization: Bearer provider-secret".into();
        assert!(normalize_agent_run(secret_bearing).is_err());
        let mut changed = initial.clone();
        changed.provider_route.as_mut().unwrap().selection.reason = "Changed".into();
        assert!(ensure_run_evidence_immutable(&initial, &changed).is_err());
        let legacy = fixture("streaming");
        assert!(ensure_run_evidence_immutable(&legacy, &initial).is_err());
    }

    fn receipt() -> RunContextReceipt {
        RunContextReceipt {
            version: 1,
            run_id: "run-1".into(),
            assembled_at: "2026-06-27T12:00:00Z".into(),
            scope: RunContextScope {
                level: "thread".into(),
                project_id: Some("project-1".into()),
                thread_id: Some("thread-1".into()),
            },
            audience: None,
            citations: vec![RunContextCitation {
                source_id: "source-1".into(),
                title: "Launch plan".into(),
                snippet: "The launch plan prioritizes recovery.".into(),
                provenance: "Local file".into(),
                freshness: "Updated today".into(),
                trust: "untrusted".into(),
                pinned: false,
                score: 0.8,
                chunk_id: Some("source-1#0".into()),
                account: None,
                ranking: RunContextRanking {
                    relevance: 0.8,
                    recency: 0.1,
                    authority: 0.2,
                    pin: 0.0,
                    feedback: 0.0,
                },
                source_path: Some("docs/launch.md".into()),
                media_type: Some("text/markdown".into()),
                scope: Some(RunContextScope {
                    level: "project".into(),
                    project_id: Some("project-1".into()),
                    thread_id: None,
                }),
                authority_scope: None,
            }],
            contributions: vec![RunContextContribution {
                id: "source-1".into(),
                kind: "source".into(),
                reason: "retrieved".into(),
                citation_id: Some("source-1#0".into()),
            }],
        }
    }

    #[test]
    fn v2_receipts_require_the_active_private_audience_and_citation_owner() {
        let legacy_sourced = receipt();
        assert!(validate_context_receipt_authority(&legacy_sourced)
            .unwrap_err()
            .contains("version 2"));
        let mut legacy_empty = receipt();
        legacy_empty.citations.clear();
        legacy_empty.contributions.clear();
        validate_context_receipt_authority(&legacy_empty).unwrap();

        let mut receipt = receipt();
        receipt.version = 2;
        receipt.audience = Some(crate::models::RunContextAudience {
            authority: "local".into(),
            visibility: "member-private".into(),
            acting_member_id: Some("member-a".into()),
            acting_internal_user_id: None,
        });
        receipt.citations[0].authority_scope = Some(crate::models::ContextRecordAuthorityScope {
            authority: "local".into(),
            visibility: "member-private".into(),
            owner_member_id: Some("member-a".into()),
            owner_internal_user_id: None,
        });
        validate_context_receipt_for_owner(&receipt, "user-a", Some("member-a")).unwrap();
        assert!(
            validate_context_receipt_for_owner(&receipt, "user-b", Some("member-b"))
                .unwrap_err()
                .contains("audience")
        );

        receipt.audience.as_mut().unwrap().authority = "convex".into();
        receipt.audience.as_mut().unwrap().visibility = "workspace-shared".into();
        assert!(
            validate_context_receipt_for_owner(&receipt, "user-a", Some("member-a"))
                .unwrap_err()
                .contains("Shared")
        );

        receipt.audience = Some(crate::models::RunContextAudience {
            authority: "local".into(),
            visibility: "member-private".into(),
            acting_member_id: None,
            acting_internal_user_id: Some("user-local".into()),
        });
        receipt.citations[0].authority_scope = Some(crate::models::ContextRecordAuthorityScope {
            authority: "local".into(),
            visibility: "member-private".into(),
            owner_member_id: None,
            owner_internal_user_id: Some("user-local".into()),
        });
        validate_context_receipt_for_owner(&receipt, "user-local", None).unwrap();
        receipt.citations[0].authority_scope = None;
        assert!(
            validate_context_receipt_for_owner(&receipt, "user-local", None)
                .unwrap_err()
                .contains("canonical authority")
        );
    }

    #[test]
    fn context_receipt_round_trips_restart_and_becomes_immutable() {
        let path = std::env::temp_dir().join(format!(
            "fable-agent-context-receipt-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let base = fixture("streaming");
        persist_agent_run(&path, base.clone()).unwrap();
        let mut with_receipt = base;
        let mut context_receipt = receipt();
        context_receipt.citations[0].snippet = "First line\n\nSecond line".into();
        with_receipt.context_receipt = Some(context_receipt);
        with_receipt.updated_at = "2026-06-27T12:00:02Z".into();
        let with_receipt = persist_agent_run(&path, with_receipt).unwrap();
        assert_eq!(
            with_receipt.context_receipt.as_ref().unwrap().citations[0].snippet,
            "First line\n\nSecond line"
        );

        let mut removed = with_receipt.clone();
        removed.context_receipt = None;
        assert!(persist_agent_run(&path, removed)
            .unwrap_err()
            .contains("cannot be changed"));
        let mut changed = with_receipt.clone();
        changed.context_receipt.as_mut().unwrap().citations[0].title = "Rewritten".into();
        assert!(persist_agent_run(&path, changed)
            .unwrap_err()
            .contains("cannot be changed"));

        let recovered = recover_agent_runs_at(&path, "2026-06-27T12:01:00Z").unwrap();
        assert_eq!(recovered[0].context_receipt, with_receipt.context_receipt);
        let reread = read_agent_runs(&path).unwrap();
        assert_eq!(reread[0].context_receipt, with_receipt.context_receipt);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn context_receipt_rejects_invalid_identity_vocab_scores_secrets_and_limits() {
        let mut run = fixture("streaming");
        let mut invalid = receipt();
        invalid.run_id = "another-run".into();
        run.context_receipt = Some(invalid);
        assert!(normalize_agent_run(run.clone()).is_err());

        let mut invalid = receipt();
        invalid.scope.level = "organization".into();
        run.context_receipt = Some(invalid);
        assert!(normalize_agent_run(run.clone()).is_err());

        let mut invalid = receipt();
        invalid.citations[0].ranking.relevance = f64::NAN;
        run.context_receipt = Some(invalid);
        assert!(normalize_agent_run(run.clone()).is_err());

        let mut redacted = receipt();
        redacted.citations[0].snippet = "Authorization: Bearer secret".into();
        run.context_receipt = Some(redacted);
        let normalized = normalize_agent_run(run.clone()).unwrap();
        assert_eq!(
            normalized.context_receipt.unwrap().citations[0].snippet,
            "[redacted secret-bearing context]"
        );

        let mut invalid = receipt();
        invalid.assembled_at = "yesterday".into();
        run.context_receipt = Some(invalid);
        assert!(normalize_agent_run(run.clone())
            .unwrap_err()
            .contains("assembly time"));

        let mut invalid = receipt();
        invalid.citations = vec![invalid.citations[0].clone(); MAX_CONTEXT_CITATIONS + 1];
        run.context_receipt = Some(invalid);
        assert!(normalize_agent_run(run)
            .unwrap_err()
            .contains("item limits"));
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

    #[test]
    fn file_journal_rejects_terminal_replacement_and_late_inflight_writer() {
        let path = std::env::temp_dir().join(format!(
            "fable-agent-runs-terminal-{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        let completed = fixture("completed");
        persist_agent_run(&path, completed.clone()).expect("persist terminal");
        persist_agent_run(&path, completed.clone()).expect("exact replay");

        let mut replacement = completed.clone();
        replacement.status = "failed".into();
        replacement.error = Some("late failure".into());
        assert!(persist_agent_run(&path, replacement).is_err());

        let mut stale = completed.clone();
        stale.status = "streaming".into();
        stale.transcript = "stale partial".into();
        assert!(persist_agent_run(&path, stale).is_err());
        assert_eq!(read_agent_runs(&path).unwrap(), vec![completed]);
        let _ = fs::remove_file(path);
    }
}

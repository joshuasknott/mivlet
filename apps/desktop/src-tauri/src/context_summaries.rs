//! Durable derived conversation summaries.
//!
//! Raw transcript records stay in the conversation repository; this module owns
//! only the bounded, derived summary revisions used to compact long histories.
//! Summaries live in the account's encrypted private-document store (no SQL
//! migration), are owner-qualified by the account scope, and are labelled as
//! untrusted prior evidence wherever they enter model context.
//!
//! Corrections and forgetting call [`invalidate_for_memory`] before the memory
//! record changes. A summary that ever folded a changed memory record is marked
//! stale and permanently excluded from context, so a removed fact is not
//! resurrected. Staleness is monotonic within a record id; a later explicit
//! re-compaction writes a fresh revision from raw history.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::authorized_scope::{command_scope, ScopeAccess};
use crate::models::ContextRecordAuthorityScope;
use crate::paths::{normalize_spaces, truncate_characters};
use crate::store::repos::scope::PrivateDataScope;

pub const MAX_CONTEXT_SUMMARIES: usize = 120;
pub const MAX_CONTEXT_SUMMARY_CHARACTERS: usize = 16_000;
pub const MAX_CONTEXT_SUMMARY_SOURCE_REFS: usize = 256;
const MAX_CONTEXT_SUMMARY_ID_CHARACTERS: usize = 160;
const MAX_CONTEXT_SUMMARY_OWNER_ID_CHARACTERS: usize = 128;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSummaryState {
    #[serde(default)]
    pub summaries: Vec<ContextSummaryRecord>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSummaryRecord {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub authority_scope: Option<ContextRecordAuthorityScope>,
    pub id: String,
    pub thread_id: String,
    pub scope: serde_json::Value,
    pub from_sequence: i64,
    pub through_sequence: i64,
    pub revision: u32,
    pub text: String,
    #[serde(default)]
    pub source_message_ids: Vec<String>,
    #[serde(default)]
    pub source_revision_ids: Vec<String>,
    #[serde(default)]
    pub derived_memory_ids: Vec<String>,
    #[serde(default)]
    pub derived_memory_revisions: BTreeMap<String, String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub stale_at: Option<String>,
    #[serde(default)]
    pub stale_reason: Option<String>,
}

impl Default for ContextSummaryRecord {
    fn default() -> Self {
        Self {
            workspace_id: None,
            authority_scope: None,
            id: String::new(),
            thread_id: String::new(),
            scope: serde_json::json!({"level":"global"}),
            from_sequence: 0,
            through_sequence: 0,
            revision: 0,
            text: String::new(),
            source_message_ids: Vec::new(),
            source_revision_ids: Vec::new(),
            derived_memory_ids: Vec::new(),
            derived_memory_revisions: BTreeMap::new(),
            created_at: String::new(),
            updated_at: String::new(),
            stale_at: None,
            stale_reason: None,
        }
    }
}

/// Live (non-stale) summaries only. Every model-context read path uses this.
pub fn live_summaries(state: &ContextSummaryState) -> Vec<ContextSummaryRecord> {
    state
        .summaries
        .iter()
        .filter(|summary| summary.stale_at.is_none())
        .cloned()
        .collect()
}

pub fn summaries_for_thread(
    state: &ContextSummaryState,
    thread_id: &str,
) -> Vec<ContextSummaryRecord> {
    live_summaries(state)
        .into_iter()
        .filter(|summary| summary.thread_id == thread_id)
        .collect()
}

/// Keep summary section structure while stripping control characters and
/// collapsing runaway blank lines. Unlike memory values, derived summaries are
/// multi-line and must stay readable to the user.
fn normalize_summary_text(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut pending_newlines = 0usize;
    for character in value.chars() {
        if character == '\r' {
            continue;
        }
        if character == '\n' {
            pending_newlines += 1;
            continue;
        }
        if character.is_control() && character != '\t' {
            continue;
        }
        if pending_newlines > 0 {
            if !result.is_empty() {
                for _ in 0..pending_newlines.min(2) {
                    result.push('\n');
                }
            }
            pending_newlines = 0;
        }
        result.push(character);
    }
    result.trim().to_string()
}

fn normalize_owner_id(value: &str, label: &str) -> Result<String, String> {
    let value = normalize_spaces(value);
    if value.is_empty()
        || value.len() > MAX_CONTEXT_SUMMARY_OWNER_ID_CHARACTERS
        || value.contains('\0')
    {
        return Err(format!("Context summary {label} is invalid."));
    }
    Ok(value)
}

fn normalize_scope(
    value: &serde_json::Value,
    thread_id: &str,
) -> Result<serde_json::Value, String> {
    let level = value
        .get("level")
        .and_then(serde_json::Value::as_str)
        .ok_or("Context summary needs an explicit scope.")?;
    if level == "global" {
        return Ok(serde_json::json!({"level":"global"}));
    }
    let key = match level {
        "thread" => "threadId",
        "agent" => "agentId",
        "project" => "projectId",
        "work" => "workId",
        _ => return Err("Unknown context summary scope.".into()),
    };
    let id = value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= MAX_CONTEXT_SUMMARY_OWNER_ID_CHARACTERS)
        .ok_or("Context summary scope needs its owning object ID.")?;
    if level == "thread" && id != thread_id {
        return Err("Context summary thread scope must match its thread.".into());
    }
    let mut result = serde_json::json!({"level":level});
    result[key] = serde_json::json!(id);
    Ok(result)
}

fn normalize_summary(
    record: ContextSummaryRecord,
    scope: &PrivateDataScope,
) -> Result<ContextSummaryRecord, String> {
    let id = truncate_characters(
        &normalize_spaces(&record.id),
        MAX_CONTEXT_SUMMARY_ID_CHARACTERS,
    );
    if id.is_empty() {
        return Err("Context summaries need a stable id.".to_string());
    }
    let thread_id = normalize_owner_id(&record.thread_id, "thread id")?;
    if record.from_sequence < 0
        || record.through_sequence < record.from_sequence
        || record.revision < 1
    {
        return Err("Context summary coverage is invalid.".to_string());
    }
    let text = truncate_characters(
        &normalize_summary_text(&record.text),
        MAX_CONTEXT_SUMMARY_CHARACTERS,
    );
    if text.is_empty() {
        return Err("Context summaries need bounded derived text.".to_string());
    }
    let created_at = normalize_spaces(&record.created_at);
    let updated_at = normalize_spaces(&record.updated_at);
    if created_at.is_empty() || updated_at.is_empty() {
        return Err("Context summaries need creation and update times.".to_string());
    }
    Ok(ContextSummaryRecord {
        workspace_id: Some(scope.workspace_id().to_string()),
        authority_scope: Some(ContextRecordAuthorityScope {
            authority: "local".into(),
            visibility: "member-private".into(),
            owner_member_id: scope.owner_member_id().map(str::to_string),
            owner_internal_user_id: scope.owner_internal_user_id().map(str::to_string),
        }),
        id,
        scope: normalize_scope(&record.scope, &thread_id)?,
        thread_id,
        from_sequence: record.from_sequence,
        through_sequence: record.through_sequence,
        revision: record.revision,
        text,
        source_message_ids: bounded_refs(record.source_message_ids),
        source_revision_ids: bounded_refs(record.source_revision_ids),
        derived_memory_ids: bounded_refs(record.derived_memory_ids),
        derived_memory_revisions: record
            .derived_memory_revisions
            .into_iter()
            .filter(|(key, value)| !key.is_empty() && !value.is_empty())
            .take(MAX_CONTEXT_SUMMARY_SOURCE_REFS)
            .collect(),
        created_at,
        updated_at,
        stale_at: record.stale_at.map(|value| normalize_spaces(&value)),
        stale_reason: record.stale_reason.map(|value| normalize_spaces(&value)),
    })
}

fn bounded_refs(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    values
        .into_iter()
        .map(|value| truncate_characters(&normalize_spaces(&value), 200))
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .take(MAX_CONTEXT_SUMMARY_SOURCE_REFS)
        .collect()
}

fn canonicalize_state(
    state: ContextSummaryState,
    scope: &PrivateDataScope,
) -> Result<ContextSummaryState, String> {
    let mut summaries = Vec::new();
    for summary in state.summaries {
        if summaries.len() >= MAX_CONTEXT_SUMMARIES {
            break;
        }
        let normalized = normalize_summary(summary, scope)?;
        if summaries
            .iter()
            .any(|existing: &ContextSummaryRecord| existing.id == normalized.id)
        {
            continue;
        }
        summaries.push(normalized);
    }
    Ok(ContextSummaryState { summaries })
}

fn invalidate_state(
    state: &mut ContextSummaryState,
    memory_id: &str,
    now: &str,
) -> Vec<ContextSummaryRecord> {
    let mut invalidated = Vec::new();
    for summary in &mut state.summaries {
        if summary.stale_at.is_some()
            || !summary.derived_memory_ids.iter().any(|id| id == memory_id)
        {
            continue;
        }
        summary.stale_at = Some(now.to_string());
        summary.stale_reason = Some("memory-changed".to_string());
        summary.updated_at = now.to_string();
        invalidated.push(summary.clone());
    }
    invalidated
}

fn upsert_state(
    state: &mut ContextSummaryState,
    record: ContextSummaryRecord,
) -> ContextSummaryRecord {
    let mut replaced = false;
    for existing in &mut state.summaries {
        if existing.id == record.id && existing.thread_id == record.thread_id {
            let created_at = existing.created_at.clone();
            *existing = ContextSummaryRecord {
                created_at,
                ..record.clone()
            };
            replaced = true;
            break;
        }
    }
    if !replaced {
        state.summaries.push(record.clone());
    }
    record
}

#[cfg(test)]
fn encode_summary_state(state: &ContextSummaryState) -> Result<String, String> {
    serde_json::to_string_pretty(state)
        .map_err(|_| "Mivlet could not encode context summaries.".to_string())
}

#[cfg(test)]
fn write_summary_state(
    path: &std::path::Path,
    state: ContextSummaryState,
    scope: &PrivateDataScope,
) -> Result<ContextSummaryState, String> {
    let normalized = canonicalize_state(state, scope)?;
    if crate::store::write_private_workspace_document(path, scope, &normalized)? {
        return Ok(normalized);
    }
    let encoded = encode_summary_state(&normalized)?;
    std::fs::write(path, encoded)
        .map_err(|_| "Mivlet could not save context summaries.".to_string())?;
    Ok(normalized)
}

pub(crate) fn context_summaries_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    crate::paths::app_data_file_path(app, "context-summaries.json")
}

/// Invalidate every live summary derived from a changed memory record. Called
/// before the memory record is corrected, disabled, or forgotten. If the later
/// memory write fails, the over-invalidated summaries are safe: raw history
/// remains and an explicit re-compaction rebuilds them.
pub(crate) fn invalidate_for_memory(
    app: &tauri::AppHandle,
    workspace_id: Option<String>,
    memory_id: &str,
) -> Result<Vec<ContextSummaryRecord>, String> {
    let memory_id = normalize_spaces(memory_id);
    if memory_id.is_empty() {
        return Err("Memory invalidation needs a record id.".to_string());
    }
    let path = context_summaries_path(app)?;
    let authorized = command_scope(workspace_id, None, ScopeAccess::Write)?;
    let scope = &authorized.private;
    let now = chrono::Utc::now().to_rfc3339();
    crate::store::update_private_workspace_document(
        &path,
        scope,
        |existing: Option<ContextSummaryState>| {
            let mut state = canonicalize_state(existing.unwrap_or_default(), scope)?;
            let invalidated = invalidate_state(&mut state, &memory_id, &now);
            Ok((Some(state), invalidated))
        },
    )
}

#[tauri::command]
pub fn list_context_summaries(
    app: tauri::AppHandle,
    thread_id: String,
    workspace_id: Option<String>,
) -> Result<Vec<ContextSummaryRecord>, String> {
    let path = context_summaries_path(&app)?;
    let authorized = command_scope(workspace_id, None, ScopeAccess::Read)?;
    let scope = &authorized.private;
    let state = crate::store::read_private_workspace_document(&path, scope)?.unwrap_or_default();
    let state = canonicalize_state(state, scope)?;
    let thread_id = normalize_spaces(&thread_id);
    if thread_id.is_empty() {
        return Ok(Vec::new());
    }
    Ok(summaries_for_thread(&state, &thread_id))
}

#[tauri::command]
pub fn save_context_summary(
    app: tauri::AppHandle,
    summary: ContextSummaryRecord,
    workspace_id: Option<String>,
) -> Result<ContextSummaryRecord, String> {
    let path = context_summaries_path(&app)?;
    let authorized = command_scope(workspace_id, None, ScopeAccess::Write)?;
    let scope = &authorized.private;
    crate::store::update_private_workspace_document(
        &path,
        scope,
        |existing: Option<ContextSummaryState>| {
            let mut state = canonicalize_state(existing.unwrap_or_default(), scope)?;
            let saved = upsert_state(&mut state, normalize_summary(summary, scope)?);
            Ok((Some(state), saved))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::DataScope;
    use crate::store::repos::scope::PrivateDataScope;

    fn owner() -> PrivateDataScope {
        PrivateDataScope::for_authenticated_user(
            DataScope::workspace("default").unwrap(),
            "account-test",
            Some("member-test"),
        )
        .unwrap()
    }

    fn record(id: &str, thread: &str, through: i64) -> ContextSummaryRecord {
        ContextSummaryRecord {
            id: id.into(),
            thread_id: thread.into(),
            scope: serde_json::json!({"level":"thread","threadId":thread}),
            from_sequence: 1,
            through_sequence: through,
            revision: 1,
            text: format!("summary text {id}"),
            source_message_ids: vec!["message-1".into()],
            source_revision_ids: vec!["revision-1".into()],
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-01T00:00:00Z".into(),
            ..Default::default()
        }
    }

    #[test]
    fn normalization_stamps_owner_and_bounds_text_and_refs() {
        let mut input = record("summary-1", "thread-1", 4);
        input.text = "x".repeat(MAX_CONTEXT_SUMMARY_CHARACTERS + 500);
        input.source_message_ids = (0..MAX_CONTEXT_SUMMARY_SOURCE_REFS + 40)
            .map(|index| format!("message-{index}"))
            .collect();
        let normalized = normalize_summary(input, &owner()).unwrap();
        assert_eq!(
            normalized
                .authority_scope
                .unwrap()
                .owner_member_id
                .as_deref(),
            Some("member-test")
        );
        assert_eq!(
            normalized.text.chars().count(),
            MAX_CONTEXT_SUMMARY_CHARACTERS
        );
        assert_eq!(
            normalized.source_message_ids.len(),
            MAX_CONTEXT_SUMMARY_SOURCE_REFS
        );
        assert_eq!(normalized.workspace_id.as_deref(), Some("default"));
    }

    #[test]
    fn summary_text_keeps_line_structure_but_strips_control_characters() {
        let mut input = record("summary-1", "thread-1", 4);
        input.text = "Decisions:\n- one\n\n\n\n- two\u{0007}".into();
        let normalized = normalize_summary(input, &owner()).unwrap();
        assert_eq!(normalized.text, "Decisions:\n- one\n\n- two");
    }

    #[test]
    fn scope_owner_must_be_exact_and_thread_scope_must_match() {
        let mut input = record("summary-1", "thread-1", 4);
        input.scope = serde_json::json!({"level":"agent"});
        assert!(normalize_summary(input.clone(), &owner()).is_err());
        input.scope = serde_json::json!({"level":"thread","threadId":"thread-2"});
        assert!(normalize_summary(input, &owner()).is_err());
        let input = record("summary-1", "thread-1", 4);
        assert_eq!(
            normalize_summary(input, &owner()).unwrap().scope,
            serde_json::json!({"level":"thread","threadId":"thread-1"})
        );
    }

    #[test]
    fn coverage_and_revision_are_validated() {
        let mut backwards = record("summary-1", "thread-1", 4);
        backwards.from_sequence = 5;
        assert!(normalize_summary(backwards, &owner()).is_err());
        let mut revision = record("summary-1", "thread-1", 4);
        revision.revision = 0;
        assert!(normalize_summary(revision, &owner()).is_err());
        let mut empty = record("summary-1", "thread-1", 4);
        empty.text = "   ".into();
        assert!(normalize_summary(empty, &owner()).is_err());
    }

    #[test]
    fn stale_summaries_are_excluded_from_live_reads() {
        let mut state = ContextSummaryState {
            summaries: vec![
                record("live", "thread-1", 4),
                record("stale", "thread-1", 8),
            ],
        };
        state.summaries[1].stale_at = Some("2026-09-02T00:00:00Z".into());
        let live = live_summaries(&state);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].id, "live");
        assert!(summaries_for_thread(&state, "thread-1")
            .iter()
            .all(|summary| summary.id != "stale"));
        assert!(summaries_for_thread(&state, "thread-2").is_empty());
    }

    #[test]
    fn invalidating_one_memory_marks_only_its_derived_summaries_once() {
        let mut derived = record("derived", "thread-1", 4);
        derived.derived_memory_ids = vec!["memory-1".into()];
        derived.derived_memory_revisions =
            BTreeMap::from([("memory-1".to_string(), "revision-a".to_string())]);
        let other = record("other", "thread-1", 8);
        let mut state = ContextSummaryState {
            summaries: vec![derived, other],
        };
        let invalidated = invalidate_state(&mut state, "memory-1", "2026-09-03T00:00:00Z");
        assert_eq!(invalidated.len(), 1);
        assert_eq!(invalidated[0].id, "derived");
        assert_eq!(
            invalidated[0].stale_reason.as_deref(),
            Some("memory-changed")
        );
        assert_eq!(invalidated[0].updated_at, "2026-09-03T00:00:00Z");
        assert!(invalidate_state(&mut state, "memory-1", "later").is_empty());
        assert_eq!(live_summaries(&state).len(), 1);
    }

    #[test]
    fn upsert_replaces_same_id_and_keeps_created_at() {
        let mut state = ContextSummaryState {
            summaries: vec![record("summary-1", "thread-1", 4)],
        };
        let mut next = record("summary-1", "thread-1", 8);
        next.revision = 2;
        next.created_at = "2026-09-09T00:00:00Z".into();
        let saved = upsert_state(&mut state, next);
        assert_eq!(state.summaries.len(), 1);
        assert_eq!(saved.revision, 2);
        assert_eq!(state.summaries[0].revision, 2);
        assert_eq!(state.summaries[0].created_at, "2026-09-01T00:00:00Z");
    }

    #[test]
    fn canonicalization_caps_the_document_and_rejects_duplicate_ids() {
        let mut input = ContextSummaryState {
            summaries: vec![record("summary-1", "thread-1", 4)],
        };
        input.summaries.push(record("summary-1", "thread-1", 8));
        let normalized = canonicalize_state(input, &owner()).unwrap();
        assert_eq!(normalized.summaries.len(), 1);
        assert_eq!(normalized.summaries[0].through_sequence, 4);
    }

    #[test]
    fn file_fallback_round_trips_when_the_encrypted_store_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context-summaries.json");
        let state = ContextSummaryState {
            summaries: vec![record("summary-1", "thread-1", 4)],
        };
        write_summary_state(&path, state, &owner()).unwrap();
        let encoded = std::fs::read_to_string(&path).unwrap();
        let restored: ContextSummaryState = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored.summaries.len(), 1);
        assert_eq!(restored.summaries[0].id, "summary-1");
    }
}

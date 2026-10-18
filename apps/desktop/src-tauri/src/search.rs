//! Unified, account-scoped search (P7).
//!
//! Every result is a live scoped read over existing repositories: no index
//! migration, no replacement store and no cross-account cache. Scans are
//! bounded and incrementally paginated so a query never loads a whole
//! transcript history into the renderer. Hard-deleted rows disappear because
//! they are simply no longer read; archived objects are reported with an
//! `archived` flag and only returned when the caller asks for them.

use std::collections::BTreeSet;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::authorized_scope::{AuthorizedCommandScope, ScopeAccess};
use crate::collaboration::models::{Fact, ObjectReference, Work, WorkStatus};
use crate::local_computer::artifacts::ArtifactReceipt;
use crate::models::{LocalFileImport, MivletAgentProfile};
use crate::store::repos::collaboration::{self as collaboration_repo, Kind};
use crate::store::repos::{
    local_project, message as message_repo, preferences, scope::PrivateDataScope,
    thread as thread_repo,
};
use crate::store::{Result, Store, StoreError};

pub const SEARCH_MAX_QUERY_CHARACTERS: usize = 200;
const SEARCH_DEFAULT_LIMIT: usize = 20;
const SEARCH_MAX_LIMIT: usize = 50;
const AGENT_SCAN_PAGE: usize = 100;
const MAX_MATCH_TEXT_CHARACTERS: usize = 20_000;
const SNIPPET_CHARACTERS: usize = 200;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequest {
    pub workspace_id: String,
    pub query: String,
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_sequence: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    work_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    work_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    reference: ObjectReference,
    object_kind: String,
    title: String,
    snippet: String,
    matched_field: String,
    score: f64,
    archived: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    context: SearchResultContext,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchScanSummary {
    conversations_scanned: usize,
    messages_scanned: usize,
    work_scanned: usize,
    projects_scanned: usize,
    agents_scanned: usize,
    files_scanned: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    decisions_scanned: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    query: String,
    results: Vec<SearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
    truncated: bool,
    scanned: SearchScanSummary,
}

/// Hard scan budgets. Tests exercise truncation with reduced limits.
#[derive(Clone, Copy)]
pub(crate) struct SearchLimits {
    pub(crate) max_threads: usize,
    pub(crate) max_messages: usize,
    pub(crate) max_projects: usize,
    pub(crate) max_work: usize,
    pub(crate) max_decisions: usize,
    pub(crate) max_files: usize,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            max_threads: 150,
            max_messages: 6_000,
            max_projects: 128,
            max_work: 512,
            max_decisions: 512,
            max_files: 512,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Domain {
    Agent,
    Project,
    Conversation,
    Work,
    Decision,
    File,
}

impl Domain {
    const ALL: [Domain; 6] = [
        Domain::Agent,
        Domain::Project,
        Domain::Conversation,
        Domain::Work,
        Domain::Decision,
        Domain::File,
    ];

    fn parse(value: &str) -> Result<Self> {
        match value {
            "agent" => Ok(Self::Agent),
            "project" => Ok(Self::Project),
            "conversation" => Ok(Self::Conversation),
            "work" => Ok(Self::Work),
            "decision" => Ok(Self::Decision),
            "file" => Ok(Self::File),
            _ => Err(StoreError::Invalid(format!(
                "Unknown search scope: {value}"
            ))),
        }
    }
}

#[tauri::command]
pub fn search_workspace(
    app: tauri::AppHandle,
    request: SearchRequest,
) -> std::result::Result<SearchResponse, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Mivlet's encrypted store is not initialized.".to_string())?;
    let authorized = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        ScopeAccess::Read,
    )?;
    let agents = crate::snapshot::load_runtime_snapshot(
        app.clone(),
        Some(request.workspace_id.clone()),
        None,
    )?
    .map(|snapshot| snapshot.agents)
    .unwrap_or_default();
    let files = crate::snapshot::list_imported_knowledge_sources(
        app,
        Some(request.workspace_id.clone()),
        None,
    )?;
    store
        .with_conn(|conn| run(conn, store, &authorized, &request, &agents, &files))
        .map_err(|error| error.to_string())
}

pub(crate) fn run(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: &SearchRequest,
    agents: &[MivletAgentProfile],
    files: &[LocalFileImport],
) -> Result<SearchResponse> {
    run_bounded(
        conn,
        store,
        scope,
        request,
        agents,
        files,
        &SearchLimits::default(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_bounded(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    request: &SearchRequest,
    agents: &[MivletAgentProfile],
    files: &[LocalFileImport],
    limits: &SearchLimits,
) -> Result<SearchResponse> {
    let query = request.query.trim();
    if query.chars().count() > SEARCH_MAX_QUERY_CHARACTERS {
        return Err(StoreError::Invalid(format!(
            "Search text is limited to {SEARCH_MAX_QUERY_CHARACTERS} characters."
        )));
    }
    let tokens = tokenize(query);
    let selected = requested_domains(request.kinds.as_deref())?;
    if tokens.is_empty() || selected.is_empty() {
        return Ok(SearchResponse {
            query: query.to_string(),
            results: Vec::new(),
            next_cursor: None,
            truncated: false,
            scanned: SearchScanSummary::default(),
        });
    }

    let cursor = parse_cursor(request.cursor.as_deref())?;
    let mut next = cursor.clone();
    let workspace_id = scope.data.workspace_id().to_string();
    let mut summary = SearchScanSummary::default();
    let mut scanned_truncated = false;
    let mut collected: Vec<SearchResult> = Vec::new();

    if selected.contains(&Domain::Agent) {
        let (mut results, truncated) =
            scan_agents(agents, &workspace_id, &tokens, &mut summary, cursor.page);
        scanned_truncated |= truncated;
        collected.append(&mut results);
    }
    if selected.contains(&Domain::Project) {
        let (mut results, truncated) = scan_projects(
            conn,
            store,
            &scope.private,
            &workspace_id,
            request.include_archived,
            &tokens,
            limits,
            &mut summary,
            cursor.page,
        )?;
        scanned_truncated |= truncated;
        collected.append(&mut results);
    }
    if selected.contains(&Domain::Work) {
        let (mut work, truncated) = scan_work(
            conn,
            store,
            &scope.private,
            &workspace_id,
            request.include_archived,
            &tokens,
            limits,
            &mut summary,
            cursor.page,
        )?;
        scanned_truncated |= truncated;
        collected.append(&mut work);
    }
    if selected.contains(&Domain::Decision) {
        let (mut decisions, truncated) = scan_decisions(
            conn,
            store,
            &scope.private,
            &workspace_id,
            request.include_archived,
            &tokens,
            limits,
            &mut summary,
            cursor.page,
        )?;
        scanned_truncated |= truncated;
        collected.append(&mut decisions);
    }
    if selected.contains(&Domain::Conversation) {
        let (mut results, truncated) = scan_conversations(
            conn,
            store,
            &scope.private,
            &workspace_id,
            request.include_archived,
            &tokens,
            limits,
            &mut summary,
            &mut next,
        )?;
        scanned_truncated |= truncated;
        collected.append(&mut results);
    }
    if selected.contains(&Domain::File) {
        let (mut results, truncated) = scan_files(
            conn,
            store,
            scope,
            files,
            request.include_archived,
            &tokens,
            limits,
            &mut summary,
            cursor.page,
        )?;
        scanned_truncated |= truncated;
        collected.append(&mut results);
    }

    let normalized_query = normalize_search_text(query);
    collected.sort_by(|left, right| compare_results(left, right, &normalized_query));
    let offset = cursor.result;
    let limit = request
        .limit
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT);
    let has_more = collected.len() > offset.saturating_add(limit);
    let next_cursor = if has_more {
        Some(
            SearchCursor {
                result: offset.saturating_add(limit),
                ..cursor
            }
            .encode(),
        )
    } else if scanned_truncated {
        next.page += 1;
        next.result = 0;
        Some(next.encode())
    } else {
        None
    };
    let results = collected.into_iter().skip(offset).take(limit).collect();

    Ok(SearchResponse {
        query: query.to_string(),
        results,
        next_cursor,
        truncated: scanned_truncated || has_more,
        scanned: summary,
    })
}

mod matching;
mod scanners;
#[cfg(test)]
use matching::reference;
use matching::{compare_results, normalize_search_text, parse_cursor, tokenize, SearchCursor};
use scanners::{
    requested_domains, scan_agents, scan_conversations, scan_decisions, scan_files, scan_projects,
    scan_work,
};

#[cfg(test)]
#[path = "search/tests.rs"]
mod tests;

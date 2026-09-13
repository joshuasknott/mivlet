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
use crate::collaboration::models::{ObjectReference, Work, WorkStatus};
use crate::local_computer::artifacts::ArtifactReceipt;
use crate::models::{FableAgentProfile, LocalFileImport};
use crate::store::repos::collaboration::{self as collaboration_repo, Kind};
use crate::store::repos::{
    local_project, message as message_repo, preferences, scope::PrivateDataScope,
    thread as thread_repo,
};
use crate::store::{Result, Store, StoreError};

pub const SEARCH_MAX_QUERY_CHARACTERS: usize = 200;
const SEARCH_DEFAULT_LIMIT: usize = 20;
const SEARCH_MAX_LIMIT: usize = 50;
const MAX_DOMAIN_RESULTS: usize = 100;
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
    pub(crate) max_files: usize,
}

impl Default for SearchLimits {
    fn default() -> Self {
        Self {
            max_threads: 150,
            max_messages: 6_000,
            max_projects: 128,
            max_work: 512,
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
    File,
}

impl Domain {
    const ALL: [Domain; 5] = [
        Domain::Agent,
        Domain::Project,
        Domain::Conversation,
        Domain::Work,
        Domain::File,
    ];

    fn parse(value: &str) -> Result<Self> {
        match value {
            "agent" => Ok(Self::Agent),
            "project" => Ok(Self::Project),
            "conversation" => Ok(Self::Conversation),
            "work" => Ok(Self::Work),
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
    agents: &[FableAgentProfile],
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
    agents: &[FableAgentProfile],
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

    let workspace_id = scope.data.workspace_id().to_string();
    let mut summary = SearchScanSummary::default();
    let mut scanned_truncated = false;
    let mut collected: Vec<SearchResult> = Vec::new();

    if selected.contains(&Domain::Agent) {
        let (mut results, truncated) = scan_agents(agents, &workspace_id, &tokens, &mut summary);
        scanned_truncated |= truncated;
        collected.append(&mut results);
    }
    if selected.contains(&Domain::Project) || selected.contains(&Domain::Work) {
        // Work archive visibility follows its project lifecycle, so read the
        // project lifecycle even when only Work results were requested.
        let (mut results, archived_projects, truncated) = scan_projects(
            conn,
            store,
            &scope.private,
            &workspace_id,
            request.include_archived,
            &tokens,
            limits,
            &mut summary,
        )?;
        scanned_truncated |= truncated;
        if selected.contains(&Domain::Project) {
            collected.append(&mut results);
        }
        if selected.contains(&Domain::Work) {
            let (mut work, truncated) = scan_work(
                conn,
                store,
                &scope.private,
                &workspace_id,
                request.include_archived,
                &archived_projects,
                &tokens,
                limits,
                &mut summary,
            )?;
            scanned_truncated |= truncated;
            collected.append(&mut work);
        }
    }
    if selected.contains(&Domain::Conversation) {
        let (mut results, truncated) = scan_conversations(
            conn,
            store,
            &scope.data,
            &workspace_id,
            request.include_archived,
            &tokens,
            limits,
            &mut summary,
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
        )?;
        scanned_truncated |= truncated;
        collected.append(&mut results);
    }

    collected.sort_by(compare_results);
    let offset = parse_cursor(request.cursor.as_deref())?;
    let limit = request
        .limit
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
        .clamp(1, SEARCH_MAX_LIMIT);
    let has_more = collected.len() > offset.saturating_add(limit);
    let next_cursor = has_more.then(|| offset.saturating_add(limit).to_string());
    let results = collected.into_iter().skip(offset).take(limit).collect();

    Ok(SearchResponse {
        query: query.to_string(),
        results,
        next_cursor,
        truncated: scanned_truncated || has_more,
        scanned: summary,
    })
}

fn requested_domains(kinds: Option<&[String]>) -> Result<BTreeSet<Domain>> {
    match kinds {
        None => Ok(Domain::ALL.iter().copied().collect()),
        Some(kinds) => {
            if kinds.is_empty() {
                return Err(StoreError::Invalid(
                    "Choose at least one search scope.".into(),
                ));
            }
            let mut selected = BTreeSet::new();
            for kind in kinds {
                selected.insert(Domain::parse(kind)?);
            }
            Ok(selected)
        }
    }
}

fn scan_agents(
    agents: &[FableAgentProfile],
    workspace_id: &str,
    tokens: &[String],
    summary: &mut SearchScanSummary,
) -> (Vec<SearchResult>, bool) {
    summary.agents_scanned += agents.len();
    let mut results = Vec::new();
    let mut truncated = false;
    for agent in agents {
        let name_score = weight(&agent.name, tokens, 4.0);
        let instruction_score = weight(&agent.instructions, tokens, 1.0);
        let learned_score = agent
            .learned_tasks
            .iter()
            .map(|task| weight(&task.title, tokens, 2.0) + weight(&task.instruction, tokens, 1.0))
            .sum::<f64>();
        let metadata_score = weight(&agent.model_id, tokens, 0.5);
        let score = name_score + instruction_score + learned_score + metadata_score;
        if score <= 0.0 {
            continue;
        }
        let (matched_field, snippet_source) = if name_score > 0.0 {
            ("title", agent.name.as_str())
        } else if instruction_score > 0.0 {
            ("content", agent.instructions.as_str())
        } else if learned_score > 0.0 {
            agent
                .learned_tasks
                .iter()
                .find_map(|task| {
                    if weight(&task.title, tokens, 1.0) > 0.0 {
                        Some(("title", task.title.as_str()))
                    } else if weight(&task.instruction, tokens, 1.0) > 0.0 {
                        Some(("content", task.instruction.as_str()))
                    } else {
                        None
                    }
                })
                .unwrap_or(("content", agent.instructions.as_str()))
        } else {
            ("metadata", agent.model_id.as_str())
        };
        results.push(SearchResult {
            reference: reference(workspace_id, "agent", &agent.id),
            object_kind: "agent".into(),
            title: agent.name.clone(),
            snippet: match_snippet(snippet_source, tokens),
            matched_field: matched_field.into(),
            score,
            archived: false,
            updated_at: None,
            context: SearchResultContext {
                agent_id: Some(agent.id.clone()),
                agent_name: Some(agent.name.clone()),
                ..SearchResultContext::default()
            },
        });
        if results.len() >= MAX_DOMAIN_RESULTS {
            truncated = true;
            break;
        }
    }
    (results, truncated)
}

fn scan_projects(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    workspace_id: &str,
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
) -> Result<(Vec<SearchResult>, BTreeSet<String>, bool)> {
    let rows = local_project::list_projects(conn, store, scope, true, limits.max_projects)?;
    summary.projects_scanned += rows.len();
    let mut truncated = rows.len() >= limits.max_projects;
    let mut archived_projects = BTreeSet::new();
    let mut results = Vec::new();
    for row in rows {
        let archived = row.lifecycle == "archived";
        if archived {
            archived_projects.insert(row.id.clone());
        }
        let name = row
            .payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let instructions = row
            .payload
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let name_score = weight(name, tokens, 4.0);
        let instruction_score = weight(instructions, tokens, 1.0);
        let score = name_score + instruction_score;
        if score <= 0.0 || (archived && !include_archived) {
            continue;
        }
        let (matched_field, snippet_source) = if name_score > 0.0 {
            ("title", name)
        } else {
            ("content", instructions)
        };
        results.push(SearchResult {
            reference: reference(workspace_id, "project", &row.id),
            object_kind: "project".into(),
            title: name.to_string(),
            snippet: match_snippet(snippet_source, tokens),
            matched_field: matched_field.into(),
            score,
            archived,
            updated_at: Some(row.updated_at.clone()),
            context: SearchResultContext {
                project_id: Some(row.id.clone()),
                project_name: Some(name.to_string()),
                thread_id: Some(row.thread_id.clone()),
                conversation_id: Some(row.thread_id.clone()),
                ..SearchResultContext::default()
            },
        });
        if results.len() >= MAX_DOMAIN_RESULTS {
            truncated = true;
            break;
        }
    }
    Ok((results, archived_projects, truncated))
}

#[allow(clippy::too_many_arguments)]
fn scan_conversations(
    conn: &Connection,
    store: &Store,
    scope: &crate::store::repos::scope::DataScope,
    workspace_id: &str,
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
) -> Result<(Vec<SearchResult>, bool)> {
    let (threads, mut truncated) =
        thread_repo::list_bounded(conn, store, scope, limits.max_threads)?;
    summary.conversations_scanned += threads.len();
    let mut results = Vec::new();
    for thread in threads {
        let archived = thread.lifecycle == "archived";
        if archived && !include_archived {
            continue;
        }
        let title_score = weight(&thread.title, tokens, 4.0);
        if title_score > 0.0 {
            results.push(SearchResult {
                reference: reference(workspace_id, "conversation", &thread.id),
                object_kind: "conversation".into(),
                title: thread.title.clone(),
                snippet: match_snippet(&thread.title, tokens),
                matched_field: "title".into(),
                score: title_score,
                archived,
                updated_at: Some(thread.updated_at.clone()),
                context: conversation_context(&thread),
            });
            if results.len() >= MAX_DOMAIN_RESULTS {
                truncated = true;
                break;
            }
            continue;
        }
        if summary.messages_scanned >= limits.max_messages {
            truncated = true;
            break;
        }
        let messages = message_repo::list(conn, store, scope, &thread.id)?;
        summary.messages_scanned += messages.len();
        for message in &messages {
            let (text, text_truncated) = collect_text(&message.content);
            if text_truncated {
                truncated = true;
            }
            if text.trim().is_empty() {
                continue;
            }
            let score = weight(&text, tokens, 1.0);
            if score <= 0.0 {
                continue;
            }
            let title = if thread.title.trim().is_empty() {
                truncate(&collapse(&text), 120)
            } else {
                thread.title.clone()
            };
            results.push(SearchResult {
                reference: reference(workspace_id, "conversation", &thread.id),
                object_kind: "conversation".into(),
                title,
                snippet: match_snippet(&text, tokens),
                matched_field: "content".into(),
                score,
                archived,
                updated_at: Some(thread.updated_at.clone()),
                context: SearchResultContext {
                    message_id: Some(message.id.clone()),
                    message_sequence: Some(message.sequence),
                    ..conversation_context(&thread)
                },
            });
            break;
        }
        if summary.messages_scanned >= limits.max_messages {
            truncated = true;
            break;
        }
        if results.len() >= MAX_DOMAIN_RESULTS {
            truncated = true;
            break;
        }
    }
    Ok((results, truncated))
}

fn conversation_context(thread: &thread_repo::ThreadRow) -> SearchResultContext {
    SearchResultContext {
        conversation_id: Some(thread.id.clone()),
        conversation_title: Some(thread.title.clone()),
        thread_id: Some(thread.id.clone()),
        project_id: thread.project_id.clone(),
        ..SearchResultContext::default()
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_work(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    workspace_id: &str,
    include_archived: bool,
    archived_projects: &BTreeSet<String>,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
) -> Result<(Vec<SearchResult>, bool)> {
    let (works, mut truncated) =
        collaboration_repo::list_bounded::<Work>(conn, store, scope, Kind::Work, limits.max_work)?;
    summary.work_scanned += works.len();
    let mut results = Vec::new();
    for work in works {
        let archived = work.status == WorkStatus::Cancelled
            || work
                .project_id
                .as_ref()
                .is_some_and(|project| archived_projects.contains(project));
        if archived && !include_archived {
            continue;
        }
        let prompt_score = weight(&work.prompt, tokens, 3.0);
        let request_score = weight(&work.user_request, tokens, 3.0);
        let agent_score = weight(&work.agent_name, tokens, 1.0);
        let output_text = work
            .outputs
            .iter()
            .map(|output| output.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let output_score = weight(&output_text, tokens, 1.0);
        let reason_score = work
            .reason
            .as_deref()
            .map(|reason| weight(reason, tokens, 0.5))
            .unwrap_or(0.0);
        let score = prompt_score + request_score + agent_score + output_score + reason_score;
        if score <= 0.0 {
            continue;
        }
        let heading = if !work.prompt.trim().is_empty() {
            work.prompt.as_str()
        } else if !work.user_request.trim().is_empty() {
            work.user_request.as_str()
        } else {
            work.agent_name.as_str()
        };
        let (matched_field, snippet_source) = if prompt_score + request_score > 0.0 {
            ("title", heading)
        } else if output_score > 0.0 {
            ("content", output_text.as_str())
        } else if reason_score > 0.0 {
            ("content", work.reason.as_deref().unwrap_or_default())
        } else {
            ("metadata", work.agent_name.as_str())
        };
        let status = serde_json::to_value(&work.status)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".into());
        results.push(SearchResult {
            reference: reference(workspace_id, "work", &work.id),
            object_kind: "work".into(),
            title: truncate(&collapse(heading), 120),
            snippet: match_snippet(snippet_source, tokens),
            matched_field: matched_field.into(),
            score,
            archived,
            updated_at: Some(work.updated_at.clone()),
            context: SearchResultContext {
                work_id: Some(work.id.clone()),
                work_status: Some(status),
                conversation_id: Some(work.conversation_id.clone()),
                project_id: work.project_id.clone(),
                agent_id: Some(work.agent_id.clone()),
                agent_name: Some(work.agent_name.clone()),
                ..SearchResultContext::default()
            },
        });
        if results.len() >= MAX_DOMAIN_RESULTS {
            truncated = true;
            break;
        }
    }
    Ok((results, truncated))
}

#[allow(clippy::too_many_arguments)]
fn scan_files(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    files: &[LocalFileImport],
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
) -> Result<(Vec<SearchResult>, bool)> {
    let mut results = Vec::new();
    let mut truncated = false;

    for file in files {
        if file.deleted_at.is_some() {
            continue;
        }
        summary.files_scanned += 1;
        let archived = file.disabled;
        if archived && !include_archived {
            continue;
        }
        let title_score = weight(&file.title, tokens, 4.0);
        let preview_score = weight(&file.content_preview, tokens, 1.0);
        let provenance_score = weight(&file.provenance, tokens, 0.75);
        let score = title_score + preview_score + provenance_score;
        if score <= 0.0 {
            continue;
        }
        let (matched_field, snippet_source) = if title_score > 0.0 {
            ("title", file.title.as_str())
        } else if preview_score > 0.0 {
            ("content", file.content_preview.as_str())
        } else {
            ("metadata", file.provenance.as_str())
        };
        results.push(SearchResult {
            reference: reference(scope.private.workspace_id(), "file", &file.id),
            object_kind: "file".into(),
            title: file.title.clone(),
            snippet: match_snippet(snippet_source, tokens),
            matched_field: matched_field.into(),
            score,
            archived,
            updated_at: Some(file.imported_at.clone()),
            context: SearchResultContext {
                file_kind: Some("knowledge".into()),
                source_id: Some(file.id.clone()),
                project_id: file
                    .scope
                    .as_ref()
                    .and_then(|scope| scope.get("projectId"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                size_bytes: Some(file.size_bytes as u64),
                ..SearchResultContext::default()
            },
        });
        if results.len() >= MAX_DOMAIN_RESULTS {
            truncated = true;
            break;
        }
    }

    let prefix =
        crate::store::private_document_key_prefix(&scope.private).map_err(StoreError::Invalid)?;
    let receipt_prefix = format!("{prefix}computer-");
    let keys = preferences::keys_scoped(conn, &scope.data)?;
    let mut receipt_keys: Vec<String> = keys
        .into_iter()
        .filter(|key| key.starts_with(&receipt_prefix) && key.ends_with(".json"))
        .collect();
    if receipt_keys.len() > limits.max_files {
        receipt_keys.truncate(limits.max_files);
        truncated = true;
    }
    for key in receipt_keys {
        summary.files_scanned += 1;
        let Some(value) = preferences::get_scoped(conn, store, &scope.data, &key)? else {
            continue;
        };
        let Ok(receipt) = serde_json::from_value::<ArtifactReceipt>(value) else {
            continue;
        };
        if receipt.workspace_id != scope.private.workspace_id() {
            continue;
        }
        let title_score = weight(&receipt.artifact.title, tokens, 4.0);
        let path_score = weight(&receipt.artifact.relative_path, tokens, 2.0);
        let mime_score = weight(&receipt.artifact.mime_type, tokens, 0.5);
        let score = title_score + path_score + mime_score;
        if score <= 0.0 {
            continue;
        }
        let (matched_field, snippet_source) = if title_score > 0.0 {
            ("title", receipt.artifact.title.as_str())
        } else if path_score > 0.0 {
            ("content", receipt.artifact.relative_path.as_str())
        } else {
            ("metadata", receipt.artifact.mime_type.as_str())
        };
        let reference_id = serde_json::to_string(&serde_json::json!([
            receipt.agent_id.clone(),
            receipt.artifact.relative_path.clone()
        ]))
        .unwrap_or_else(|_| receipt.artifact.id.clone());
        results.push(SearchResult {
            reference: ObjectReference {
                workspace_id: scope.private.workspace_id().to_string(),
                kind: "file".into(),
                id: reference_id,
            },
            object_kind: "file".into(),
            title: receipt.artifact.title.clone(),
            snippet: match_snippet(snippet_source, tokens),
            matched_field: matched_field.into(),
            score,
            archived: false,
            updated_at: Some(receipt.artifact.created_at.clone()),
            context: SearchResultContext {
                file_kind: Some("artifact".into()),
                artifact_id: Some(receipt.artifact.id.clone()),
                agent_id: Some(receipt.agent_id.clone()),
                relative_path: Some(receipt.artifact.relative_path.clone()),
                mime_type: Some(receipt.artifact.mime_type.clone()),
                size_bytes: Some(receipt.artifact.size_bytes),
                ..SearchResultContext::default()
            },
        });
        if results.len() >= MAX_DOMAIN_RESULTS {
            truncated = true;
            break;
        }
    }

    Ok((results, truncated))
}

fn reference(workspace_id: &str, kind: &str, id: &str) -> ObjectReference {
    ObjectReference {
        workspace_id: workspace_id.to_string(),
        kind: kind.into(),
        id: id.into(),
    }
}

fn compare_results(left: &SearchResult, right: &SearchResult) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
            right
                .updated_at
                .as_deref()
                .unwrap_or_default()
                .cmp(left.updated_at.as_deref().unwrap_or_default())
        })
        .then_with(|| left.object_kind.cmp(&right.object_kind))
        .then_with(|| left.title.cmp(&right.title))
        .then_with(|| left.reference.id.cmp(&right.reference.id))
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize> {
    match cursor {
        None | Some("") => Ok(0),
        Some(value) => value.parse::<usize>().map_err(|_| {
            StoreError::Invalid("The search cursor is invalid. Start a new search.".into())
        }),
    }
}

fn tokenize(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    for character in query.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            current.push(character);
        } else if current.len() > 1 {
            if !tokens.contains(&current) {
                tokens.push(current.clone());
            }
            current.clear();
        } else {
            current.clear();
        }
    }
    if current.len() > 1 && !tokens.contains(&current) {
        tokens.push(current);
    }
    tokens
}

fn weight(text: &str, tokens: &[String], weight: f64) -> f64 {
    if tokens.is_empty() || text.is_empty() {
        return 0.0;
    }
    let normalized = text.to_ascii_lowercase();
    tokens
        .iter()
        .map(|token| normalized.matches(token.as_str()).count() as f64)
        .sum::<f64>()
        * weight
}

fn first_match(normalized: &str, tokens: &[String]) -> Option<usize> {
    tokens
        .iter()
        .filter_map(|token| normalized.find(token))
        .min()
}

fn match_snippet(text: &str, tokens: &[String]) -> String {
    let collapsed = collapse(text);
    let normalized = collapsed.to_ascii_lowercase();
    let Some(index) = first_match(&normalized, tokens) else {
        return truncate(&collapsed, SNIPPET_CHARACTERS);
    };
    let start_target = index.saturating_sub(SNIPPET_CHARACTERS / 3);
    let mut start = start_target;
    while start > 0 && !collapsed.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + SNIPPET_CHARACTERS).min(collapsed.len());
    while end > start && !collapsed.is_char_boundary(end) {
        end -= 1;
    }
    let window = collapsed[start..end].trim();
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(window);
    if end < collapsed.len() {
        snippet.push('…');
    }
    snippet
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(text: &str, max_characters: usize) -> String {
    if text.chars().count() <= max_characters {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_characters).collect();
    truncated.push('…');
    truncated
}

fn collect_text(value: &Value) -> (String, bool) {
    let mut text = String::new();
    let mut truncated = false;
    collect_text_into(value, &mut text, &mut truncated);
    (text, truncated)
}

fn collect_text_into(value: &Value, out: &mut String, truncated: &mut bool) {
    if out.chars().count() >= MAX_MATCH_TEXT_CHARACTERS {
        *truncated = true;
        return;
    }
    match value {
        Value::String(text) => {
            let remaining = MAX_MATCH_TEXT_CHARACTERS.saturating_sub(out.chars().count());
            if text.chars().count() > remaining {
                out.extend(text.chars().take(remaining));
                out.push('\n');
                *truncated = true;
            } else {
                out.push_str(text);
                out.push('\n');
            }
        }
        Value::Array(values) => {
            for entry in values {
                collect_text_into(entry, out, truncated);
            }
        }
        Value::Object(values) => {
            for entry in values.values() {
                collect_text_into(entry, out, truncated);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::models::Work;
    use crate::store::repos::scope::{DataScope, PrivateDataScope};
    use crate::store::repos::{collaboration::Kind, local_project::LocalProjectRow};
    use crate::store::vault::{MasterKey, Vault};
    use serde_json::json;

    const TIME: &str = "2026-09-14T09:00:00.000Z";

    fn store() -> Store {
        Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
    }

    fn scope(member: &str) -> AuthorizedCommandScope {
        let data = DataScope::workspace("default".to_string()).unwrap();
        let internal_user_id = format!("account-{member}");
        let private =
            PrivateDataScope::for_authenticated_user(data.clone(), &internal_user_id, Some(member))
                .unwrap();
        AuthorizedCommandScope {
            data,
            private,
            internal_user_id,
            member_id: Some(member.to_string()),
        }
    }

    fn request(query: &str) -> SearchRequest {
        SearchRequest {
            workspace_id: "default".into(),
            query: query.into(),
            kinds: None,
            include_archived: false,
            limit: None,
            cursor: None,
        }
    }

    fn seed_thread(
        store: &Store,
        scope: &AuthorizedCommandScope,
        id: &str,
        title: &str,
        lifecycle: &str,
        at: &str,
    ) {
        store
            .transaction(|tx| {
                thread_repo::create(tx, store, &scope.data, id, None, title, at, &json!({}))?;
                if lifecycle == "archived" {
                    thread_repo::update(
                        tx,
                        store,
                        &scope.data,
                        id,
                        None,
                        Some("archived"),
                        None,
                        at,
                    )?;
                }
                tx.execute(
                    "UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3",
                    rusqlite::params![scope.private.owner_member_id(), "default", id],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn seed_messages(
        store: &Store,
        scope: &AuthorizedCommandScope,
        thread_id: &str,
        prefix: &str,
        texts: &[&str],
        at: &str,
    ) {
        let mut previous: Option<String> = None;
        for (index, text) in texts.iter().enumerate() {
            let id = format!("{prefix}-m{index}");
            let revision = format!("{prefix}-r{index}");
            let sequence = index as i64 + 1;
            store
                .transaction(|tx| {
                    message_repo::append(
                        tx,
                        store,
                        &scope.data,
                        thread_id,
                        &id,
                        "user",
                        &json!({}),
                        None,
                        sequence,
                        sequence - 1,
                        previous.as_deref(),
                        &format!("idempotency-{prefix}-{index}"),
                        &revision,
                        "terminal",
                        "test",
                        &json!({ "text": text }),
                        at,
                    )
                })
                .unwrap();
            previous = Some(id);
        }
    }

    fn seed_project(
        store: &Store,
        scope: &AuthorizedCommandScope,
        id: &str,
        name: &str,
        instructions: &str,
        lifecycle: &str,
        thread_id: &str,
        at: &str,
    ) {
        let archived_at = (lifecycle == "archived").then(|| at.to_string());
        store
            .transaction(|tx| {
                local_project::insert_project(
                    tx,
                    store,
                    &scope.private,
                    &LocalProjectRow {
                        id: id.into(),
                        lifecycle: lifecycle.into(),
                        revision: 1,
                        thread_id: thread_id.into(),
                        created_at: at.into(),
                        updated_at: at.into(),
                        archived_at,
                        payload: json!({
                            "name": name,
                            "instructions": instructions,
                            "knowledgeSourceIds": [],
                        }),
                    },
                )
            })
            .unwrap();
    }

    fn work_json(
        id: &str,
        prompt: &str,
        agent_name: &str,
        conversation_id: &str,
        project_id: Option<&str>,
        status: &str,
        at: &str,
    ) -> Value {
        json!({
            "id": id,
            "workspaceId": "default",
            "conversationId": conversation_id,
            "projectId": project_id,
            "rootId": id,
            "agentId": "agent-work",
            "agentName": agent_name,
            "prompt": prompt,
            "userRequest": prompt,
            "status": status,
            "dependencies": [],
            "generation": 1,
            "conversationGeneration": 1,
            "contextRevision": 1,
            "depth": 0,
            "turnCount": 0,
            "tokenUsage": 0,
            "maxTurns": 10,
            "maxTokens": 1000,
            "runIds": [],
            "modelOptionId": "model",
            "outputs": [],
            "createdAt": at,
            "updatedAt": at
        })
    }

    fn seed_work(
        store: &Store,
        scope: &AuthorizedCommandScope,
        id: &str,
        prompt: &str,
        agent_name: &str,
        conversation_id: &str,
        project_id: Option<&str>,
        status: &str,
        at: &str,
    ) {
        let work: Work = serde_json::from_value(work_json(
            id,
            prompt,
            agent_name,
            conversation_id,
            project_id,
            status,
            at,
        ))
        .unwrap();
        store
            .transaction(|tx| {
                collaboration_repo::put(
                    tx,
                    store,
                    &scope.private,
                    Kind::Work,
                    id,
                    None,
                    project_id,
                    &work,
                )
            })
            .unwrap();
    }

    fn seed_artifact(
        store: &Store,
        scope: &AuthorizedCommandScope,
        artifact_id: &str,
        agent_id: &str,
        title: &str,
        relative_path: &str,
        at: &str,
    ) -> String {
        let path = std::path::Path::new("computer-search.json");
        let (storage_scope, placeholder_key) =
            crate::store::private_document_location(path, &scope.private).unwrap();
        let key = placeholder_key.replace(
            "computer-search.json",
            &format!("computer-{artifact_id}.json"),
        );
        let receipt = json!({
            "artifact": {
                "kind": "computer-artifact",
                "version": 1,
                "id": artifact_id,
                "computerId": "computer-1",
                "title": title,
                "mimeType": "text/plain",
                "sizeBytes": 12,
                "relativePath": relative_path,
                "createdAt": at,
            },
            "workspaceId": "default",
            "agentId": agent_id,
            "exportName": "fable.txt",
            "sha256": "0".repeat(64),
        });
        store
            .transaction(|tx| {
                preferences::upsert_scoped(tx, store, &storage_scope, &key, &receipt, TIME)
            })
            .unwrap();
        key
    }

    fn knowledge(
        id: &str,
        title: &str,
        preview: &str,
        disabled: bool,
        deleted: bool,
    ) -> LocalFileImport {
        serde_json::from_value(json!({
            "id": id,
            "title": title,
            "kind": "text",
            "connectorId": "local-import",
            "provenance": "Imported notes",
            "freshness": "now",
            "pinned": false,
            "trust": "trusted",
            "contentPreview": preview,
            "contentFingerprint": "fingerprint",
            "sizeBytes": 42,
            "importedAt": TIME,
            "origin": "local-import",
            "disabled": disabled,
            "deletedAt": deleted.then_some(TIME),
        }))
        .unwrap()
    }

    fn agent(id: &str, name: &str, instructions: &str) -> FableAgentProfile {
        serde_json::from_value(json!({
            "id": id,
            "name": name,
            "instructions": instructions,
            "modelId": "model",
            "icon": "robot",
            "permissionLabel": "Standard",
        }))
        .unwrap()
    }

    fn search(
        store: &Store,
        scope: &AuthorizedCommandScope,
        query: &str,
        agents: &[FableAgentProfile],
        files: &[LocalFileImport],
    ) -> SearchResponse {
        store
            .with_conn(|conn| run(conn, store, scope, &request(query), agents, files))
            .unwrap()
    }

    fn search_bounded(
        store: &Store,
        scope: &AuthorizedCommandScope,
        query: &str,
        agents: &[FableAgentProfile],
        files: &[LocalFileImport],
        limits: &SearchLimits,
    ) -> SearchResponse {
        store
            .with_conn(|conn| {
                run_bounded(conn, store, scope, &request(query), agents, files, limits)
            })
            .unwrap()
    }

    #[test]
    fn mixed_object_results_identify_type_owner_and_matching_text() {
        let store = store();
        let scope = scope("member-a");
        seed_thread(
            &store,
            &scope,
            "thread-title",
            "Aurora planning",
            "active",
            TIME,
        );
        seed_thread(
            &store,
            &scope,
            "thread-message",
            "Weekly sync",
            "active",
            TIME,
        );
        seed_messages(
            &store,
            &scope,
            "thread-message",
            "weekly",
            &["ordinary notes", "the aurora borealis schedule"],
            TIME,
        );
        seed_thread(
            &store,
            &scope,
            "thread-project",
            "Project room",
            "active",
            TIME,
        );
        seed_project(
            &store,
            &scope,
            "project-1",
            "Aurora project",
            "Track aurora research",
            "active",
            "thread-project",
            TIME,
        );
        seed_work(
            &store,
            &scope,
            "work-1",
            "Summarize aurora findings",
            "Nova",
            "thread-title",
            None,
            "completed",
            TIME,
        );
        seed_artifact(
            &store,
            &scope,
            &format!("artifact-{}", "a".repeat(64)),
            "agent-1",
            "Aurora notes",
            "notes/aurora.txt",
            TIME,
        );
        let files = vec![knowledge("file-1", "Aurora file", "borealis", false, false)];
        let agents = vec![agent("agent-1", "Aurora agent", "Find aurora events")];

        let response = search(&store, &scope, "aurora", &agents, &files);
        assert_eq!(response.results.len(), 7, "{:?}", response.results);
        assert!(!response.truncated);

        let kinds: BTreeSet<&str> = response
            .results
            .iter()
            .map(|result| result.object_kind.as_str())
            .collect();
        assert_eq!(
            kinds,
            BTreeSet::from(["agent", "project", "conversation", "work", "file"])
        );

        let agent = find_result(&response, "agent", "agent-1");
        assert_eq!(agent.context.agent_name.as_deref(), Some("Aurora agent"));
        assert!(agent.snippet.to_ascii_lowercase().contains("aurora"));

        let project = find_result(&response, "project", "project-1");
        assert_eq!(
            project.context.project_name.as_deref(),
            Some("Aurora project")
        );
        assert_eq!(project.context.thread_id.as_deref(), Some("thread-project"));

        let title_match = find_result(&response, "conversation", "thread-title");
        assert_eq!(title_match.matched_field, "title");
        assert!(title_match.context.message_id.is_none());

        let message_match = find_result(&response, "conversation", "thread-message");
        assert_eq!(message_match.matched_field, "content");
        assert_eq!(
            message_match.context.message_id.as_deref(),
            Some("weekly-m1")
        );
        assert_eq!(message_match.context.message_sequence, Some(2));
        assert!(message_match
            .snippet
            .to_ascii_lowercase()
            .contains("aurora"));

        let work = find_result(&response, "work", "work-1");
        assert_eq!(work.context.work_status.as_deref(), Some("completed"));
        assert_eq!(
            work.context.conversation_id.as_deref(),
            Some("thread-title")
        );

        let artifact = response
            .results
            .iter()
            .find(|result| {
                result.object_kind == "file"
                    && result.context.file_kind.as_deref() == Some("artifact")
            })
            .expect("artifact result");
        assert_eq!(artifact.context.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(
            artifact.context.relative_path.as_deref(),
            Some("notes/aurora.txt")
        );
        assert_eq!(artifact.reference.id, "[\"agent-1\",\"notes/aurora.txt\"]");

        let knowledge = response
            .results
            .iter()
            .find(|result| {
                result.object_kind == "file"
                    && result.context.file_kind.as_deref() == Some("knowledge")
            })
            .expect("knowledge result");
        assert_eq!(knowledge.reference.id, "file-1");
        assert_eq!(knowledge.context.project_id, None);
    }

    #[test]
    fn owner_and_workspace_requests_fail_closed() {
        let store = store();
        let member_a = scope("member-a");
        seed_thread(
            &store,
            &member_a,
            "thread-a",
            "Owner thread",
            "active",
            TIME,
        );
        seed_work(
            &store,
            &member_a,
            "work-a",
            "Secret aurora plan",
            "Nova",
            "thread-a",
            None,
            "completed",
            TIME,
        );
        seed_project(
            &store,
            &member_a,
            "project-a",
            "Aurora project",
            "Private",
            "active",
            "thread-a",
            TIME,
        );
        seed_artifact(
            &store,
            &member_a,
            &format!("artifact-{}", "b".repeat(64)),
            "agent-1",
            "Aurora private",
            "notes/private.txt",
            TIME,
        );

        let member_b = scope("member-b");
        let response = search(&store, &member_b, "aurora", &[], &[]);
        assert!(!response
            .results
            .iter()
            .any(|result| result.object_kind == "project"));
        assert!(!response
            .results
            .iter()
            .any(|result| result.object_kind == "work"));
        assert!(!response
            .results
            .iter()
            .any(|result| result.context.file_kind.as_deref() == Some("artifact")));

        let denied = store
            .with_conn(|conn| {
                crate::authorized_scope::resolve(
                    conn,
                    Some("hosted-workspace"),
                    None,
                    ScopeAccess::Read,
                )
            })
            .unwrap_err();
        assert!(denied.to_string().contains("workspace"));
    }

    #[test]
    fn archive_visibility_is_explicit_and_filterable() {
        let store = store();
        let scope = scope("member-a");
        seed_thread(
            &store,
            &scope,
            "thread-archived",
            "Archived aurora chat",
            "archived",
            TIME,
        );
        seed_thread(
            &store,
            &scope,
            "thread-project",
            "Project room",
            "active",
            TIME,
        );
        seed_project(
            &store,
            &scope,
            "project-archived",
            "Archived aurora project",
            "Instructions",
            "archived",
            "thread-project",
            TIME,
        );
        seed_work(
            &store,
            &scope,
            "work-cancelled",
            "Cancelled aurora work",
            "Nova",
            "thread-project",
            None,
            "cancelled",
            TIME,
        );
        seed_work(
            &store,
            &scope,
            "work-project",
            "Completed aurora work",
            "Nova",
            "thread-project",
            Some("project-archived"),
            "completed",
            TIME,
        );
        let files = vec![knowledge(
            "file-disabled",
            "Disabled aurora file",
            "preview",
            true,
            false,
        )];

        let hidden = search(&store, &scope, "aurora", &[], &files);
        assert!(hidden.results.is_empty(), "{:?}", hidden.results);

        let mut include = request("aurora");
        include.include_archived = true;
        let visible = store
            .with_conn(|conn| run(conn, &store, &scope, &include, &[], &files))
            .unwrap();
        assert_eq!(visible.results.len(), 5, "{:?}", visible.results);
        assert!(visible.results.iter().all(|result| result.archived));
        assert!(visible
            .results
            .iter()
            .any(|result| result.reference.id == "thread-archived"));
        assert!(visible
            .results
            .iter()
            .any(|result| result.reference.id == "project-archived"));
        assert!(visible
            .results
            .iter()
            .any(|result| result.reference.id == "work-cancelled"));
        assert!(visible
            .results
            .iter()
            .any(|result| result.reference.id == "work-project"));
        assert!(visible
            .results
            .iter()
            .any(|result| result.reference.id == "file-disabled"));

        // Work-only scopes still hide work archived by its project's lifecycle.
        let mut work_only = request("aurora");
        work_only.kinds = Some(vec!["work".into()]);
        let hidden_work = store
            .with_conn(|conn| run(conn, &store, &scope, &work_only, &[], &[]))
            .unwrap();
        assert!(hidden_work.results.is_empty(), "{:?}", hidden_work.results);
        work_only.include_archived = true;
        let visible_work = store
            .with_conn(|conn| run(conn, &store, &scope, &work_only, &[], &[]))
            .unwrap();
        assert_eq!(visible_work.results.len(), 2, "{:?}", visible_work.results);
        assert!(visible_work
            .results
            .iter()
            .all(|result| result.object_kind == "work" && result.archived));
    }

    #[test]
    fn deleted_content_disappears_from_results() {
        let store = store();
        let scope = scope("member-a");
        seed_thread(
            &store,
            &scope,
            "thread-deleted",
            "Aurora deleted chat",
            "active",
            TIME,
        );
        let artifact_id = format!("artifact-{}", "c".repeat(64));
        let artifact_key = seed_artifact(
            &store,
            &scope,
            &artifact_id,
            "agent-1",
            "Aurora deleted artifact",
            "notes/deleted.txt",
            TIME,
        );
        let deleted_file = knowledge("file-deleted", "Aurora deleted file", "gone", false, true);
        let live_file = knowledge("file-live", "Aurora file", "here", false, false);
        let files = vec![deleted_file, live_file.clone()];

        let before = search(&store, &scope, "aurora", &[], &files);
        assert!(before
            .results
            .iter()
            .any(|result| result.reference.id == "thread-deleted"));
        assert!(before
            .results
            .iter()
            .any(|result| result.context.artifact_id.as_deref() == Some(&artifact_id)));
        assert!(before
            .results
            .iter()
            .any(|result| result.reference.id == "file-live"));
        assert!(!before
            .results
            .iter()
            .any(|result| result.reference.id == "file-deleted"));

        store
            .transaction(|tx| thread_repo::delete(tx, &scope.data, "thread-deleted", TIME))
            .unwrap();
        store
            .transaction(|tx| preferences::delete_scoped(tx, &scope.data, &artifact_key))
            .unwrap();

        let after = search(&store, &scope, "aurora", &[], &[live_file]);
        assert!(!after
            .results
            .iter()
            .any(|result| result.reference.id == "thread-deleted"));
        assert!(!after
            .results
            .iter()
            .any(|result| result.context.artifact_id.as_deref() == Some(&artifact_id)));
        assert!(after
            .results
            .iter()
            .any(|result| result.reference.id == "file-live"));
    }

    #[test]
    fn larger_history_fixture_is_bounded_and_complete_within_budget() {
        let store = store();
        let scope = scope("member-a");
        for index in 0..60 {
            let thread_id = format!("thread-{index:02}");
            seed_thread(
                &store,
                &scope,
                &thread_id,
                &format!("History thread {index:02}"),
                "active",
                TIME,
            );
            let needle = if index == 42 {
                "the needle sentence"
            } else {
                "ordinary content"
            };
            seed_messages(
                &store,
                &scope,
                &thread_id,
                &format!("history-{index:02}"),
                &[needle, "follow up", "closing"],
                TIME,
            );
        }
        let response = search(&store, &scope, "needle", &[], &[]);
        assert_eq!(response.results.len(), 1, "{:?}", response.results);
        assert_eq!(response.results[0].reference.id, "thread-42");
        assert!(!response.truncated);
        assert_eq!(response.scanned.conversations_scanned, 60);
        assert_eq!(response.scanned.messages_scanned, 180);
    }

    #[test]
    fn reduced_limits_report_truncation_without_failing() {
        let store = store();
        let scope = scope("member-a");
        for index in 0..5 {
            let thread_id = format!("thread-limit-{index}");
            seed_thread(
                &store,
                &scope,
                &thread_id,
                &format!("Limit thread {index}"),
                "active",
                TIME,
            );
            seed_messages(
                &store,
                &scope,
                &thread_id,
                &format!("limit-{index}"),
                &["aurora limit content"],
                TIME,
            );
        }
        let limits = SearchLimits {
            max_threads: 2,
            max_messages: 16,
            max_projects: 4,
            max_work: 4,
            max_files: 4,
        };
        let response = search_bounded(&store, &scope, "limit", &[], &[], &limits);
        assert!(response.truncated);
        assert_eq!(response.scanned.conversations_scanned, 2);
        assert_eq!(response.results.len(), 2);
    }

    #[test]
    fn cursor_pagination_is_incremental_and_deterministic() {
        let store = store();
        let scope = scope("member-a");
        for index in 0..5 {
            seed_thread(
                &store,
                &scope,
                &format!("thread-cursor-{index}"),
                &format!("Cursor aurora {index}"),
                "active",
                TIME,
            );
        }
        let mut page = request("aurora");
        page.limit = Some(2);
        let first = store
            .with_conn(|conn| run(conn, &store, &scope, &page, &[], &[]))
            .unwrap();
        assert_eq!(first.results.len(), 2);
        assert!(first.next_cursor.is_some());
        assert!(first.truncated);

        page.cursor = first.next_cursor.clone();
        let second = store
            .with_conn(|conn| run(conn, &store, &scope, &page, &[], &[]))
            .unwrap();
        assert_eq!(second.results.len(), 2);
        assert_ne!(
            first.results[0].reference.id,
            second.results[0].reference.id
        );

        page.cursor = second.next_cursor.clone();
        let third = store
            .with_conn(|conn| run(conn, &store, &scope, &page, &[], &[]))
            .unwrap();
        assert_eq!(third.results.len(), 1);
        assert!(third.next_cursor.is_none());

        let mut bad = request("aurora");
        bad.cursor = Some("not-a-cursor".into());
        assert!(store
            .with_conn(|conn| run(conn, &store, &scope, &bad, &[], &[]))
            .is_err());
    }

    #[test]
    fn query_scopes_and_length_fail_closed() {
        let store = store();
        let scope = scope("member-a");
        seed_thread(&store, &scope, "thread-scope", "Aurora", "active", TIME);

        let mut scoped = request("aurora");
        scoped.kinds = Some(vec!["project".into()]);
        let response = store
            .with_conn(|conn| run(conn, &store, &scope, &scoped, &[], &[]))
            .unwrap();
        assert!(response.results.is_empty());

        let mut unknown = request("aurora");
        unknown.kinds = Some(vec!["transcript".into()]);
        assert!(store
            .with_conn(|conn| run(conn, &store, &scope, &unknown, &[], &[]))
            .is_err());

        let long_query = "a".repeat(SEARCH_MAX_QUERY_CHARACTERS + 1);
        assert!(store
            .with_conn(|conn| run(conn, &store, &scope, &request(&long_query), &[], &[]))
            .is_err());

        let empty = search(&store, &scope, "   ", &[], &[]);
        assert!(empty.results.is_empty());
    }

    fn find_result<'a>(
        response: &'a SearchResponse,
        object_kind: &str,
        id: &str,
    ) -> &'a SearchResult {
        response
            .results
            .iter()
            .find(|result| result.object_kind == object_kind && result.reference.id == id)
            .unwrap_or_else(|| panic!("missing {object_kind} result {id}"))
    }
}

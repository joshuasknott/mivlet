//! Search domain scanners.

use super::matching::{
    collapse, collect_text, match_snippet, reference, truncate, weight, SearchCursor,
};
use super::*;
pub(super) fn requested_domains(kinds: Option<&[String]>) -> Result<BTreeSet<Domain>> {
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

pub(super) fn scan_agents(
    agents: &[MivletAgentProfile],
    workspace_id: &str,
    tokens: &[String],
    summary: &mut SearchScanSummary,
    page: usize,
) -> (Vec<SearchResult>, bool) {
    let offset = page * AGENT_SCAN_PAGE;
    let selected: Vec<_> = agents.iter().skip(offset).take(AGENT_SCAN_PAGE).collect();
    summary.agents_scanned += selected.len();
    let mut results = Vec::new();
    let truncated = agents.len() > offset.saturating_add(AGENT_SCAN_PAGE);
    for agent in selected {
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
    }
    (results, truncated)
}

pub(super) fn scan_projects(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    workspace_id: &str,
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
    page: usize,
) -> Result<(Vec<SearchResult>, bool)> {
    let mut rows = local_project::list_projects_page(
        conn,
        store,
        scope,
        true,
        limits.max_projects + 1,
        page * limits.max_projects,
    )?;
    let truncated = rows.len() > limits.max_projects;
    rows.truncate(limits.max_projects);
    summary.projects_scanned += rows.len();
    let mut results = Vec::new();
    for row in rows {
        let archived = row.lifecycle == "archived";
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
    }
    Ok((results, truncated))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn scan_conversations(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    workspace_id: &str,
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
    next: &mut SearchCursor,
) -> Result<(Vec<SearchResult>, bool)> {
    let (threads, mut truncated) = thread_repo::list_bounded(
        conn,
        store,
        scope.data(),
        limits.max_threads,
        scope.owner_member_id(),
        next.thread,
    )?;
    summary.conversations_scanned += threads.len();
    let mut results = Vec::new();
    for thread in threads {
        let archived = thread.lifecycle == "archived";
        if archived && !include_archived {
            next.thread += 1;
            next.message = 0;
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
            next.thread += 1;
            next.message = 0;
            continue;
        }
        if summary.messages_scanned >= limits.max_messages {
            truncated = true;
            break;
        }
        let remaining = limits.max_messages - summary.messages_scanned;
        let mut messages = message_repo::list_page(
            conn,
            store,
            scope.data(),
            &thread.id,
            remaining.saturating_add(1) as i64,
            next.message as i64,
        )?;
        let more_messages = messages.len() > remaining;
        messages.truncate(remaining);
        summary.messages_scanned += messages.len();
        let mut matched = false;
        for message in &messages {
            let (text, text_truncated) = collect_text(&message.content);
            truncated |= text_truncated;
            let score = weight(&text, tokens, 1.0);
            if text.trim().is_empty() || score <= 0.0 {
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
                    // Message IDs are valid branch anchors. Keeping the
                    // matching row as the anchor lets the shell reopen an
                    // alternate branch without guessing its head.
                    branch_id: Some(message.id.clone()),
                    source_revision_id: Some(message.current_revision_id.clone()),
                    message_sequence: Some(message.sequence),
                    ..conversation_context(&thread)
                },
            });
            matched = true;
            break;
        }
        // One result opens this exact Chat. Otherwise resume its unscanned raw
        // messages on the next batch, rather than permanently hiding its tail.
        if more_messages && !matched {
            next.message += messages.len();
            truncated = true;
            break;
        }
        next.thread += 1;
        next.message = 0;
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
pub(super) fn scan_decisions(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    workspace_id: &str,
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
    page: usize,
) -> Result<(Vec<SearchResult>, bool)> {
    let (records, truncated) = collaboration_repo::list_bounded::<Fact>(
        conn,
        store,
        scope,
        Kind::Fact,
        limits.max_decisions,
        page * limits.max_decisions,
    )?;
    summary.decisions_scanned = Some(
        summary
            .decisions_scanned
            .unwrap_or_default()
            .saturating_add(records.len()),
    );
    let mut results = Vec::new();
    for fact in records {
        if fact.kind != "decision" {
            continue;
        }
        // Collaboration records are owner-subject scoped by the repository;
        // resolve the project before matching so archived/deleted projects do
        // not leak a decision title or snippet.
        let Some(project) = local_project::get_project(conn, store, scope, &fact.project_id)?
        else {
            continue;
        };
        let conversation_owned: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2 AND owner_member_id IS ?3 AND deleted_at IS NULL)",
            rusqlite::params![scope.workspace_id(), fact.conversation_id, scope.owner_member_id()],
            |row| row.get(0),
        )?;
        if !conversation_owned {
            continue;
        }
        let source_message_valid = fact
            .message_id
            .as_deref()
            .map(|message_id| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM message WHERE workspace_id=?1 AND thread_id=?2 AND id=?3 AND deleted_at IS NULL)",
                    rusqlite::params![scope.workspace_id(), fact.conversation_id, message_id],
                    |row| row.get(0),
                )
            })
            .transpose()?
            .unwrap_or(true);
        let source_revision_valid = fact
            .source_revision_id
            .as_deref()
            .map(|revision_id| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM message_revision r JOIN message m ON m.id=r.message_id WHERE r.workspace_id=?1 AND r.thread_id=?2 AND r.id=?3 AND (?4 IS NULL OR r.message_id=?4) AND m.deleted_at IS NULL)",
                    rusqlite::params![
                        scope.workspace_id(),
                        fact.conversation_id,
                        revision_id,
                        fact.message_id.as_deref(),
                    ],
                    |row| row.get(0),
                )
            })
            .transpose()?
            .unwrap_or(true);
        if !source_message_valid || !source_revision_valid {
            continue;
        }
        let branch_valid = fact
            .branch_id
            .as_deref()
            .map(|branch_id| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM message WHERE workspace_id=?1 AND thread_id=?2 AND id=?3 AND deleted_at IS NULL)",
                    rusqlite::params![scope.workspace_id(), fact.conversation_id, branch_id],
                    |row| row.get(0),
                )
            })
            .transpose()?
            .unwrap_or(true);
        if !branch_valid {
            continue;
        }
        let archived = fact.status == "forgotten" || project.lifecycle == "archived";
        if archived && !include_archived {
            continue;
        }
        let text_score = weight(&fact.text, tokens, 3.0);
        let source_score = weight(&fact.source, tokens, 0.75);
        let score = text_score + source_score;
        if score <= 0.0 {
            continue;
        }
        let (matched_field, snippet_source) = if text_score > 0.0 {
            ("content", fact.text.as_str())
        } else {
            ("metadata", fact.source.as_str())
        };
        results.push(SearchResult {
            reference: reference(workspace_id, "decision", &fact.id),
            object_kind: "decision".into(),
            title: truncate(&collapse(&fact.text), 120),
            snippet: match_snippet(snippet_source, tokens),
            matched_field: matched_field.into(),
            score,
            archived,
            updated_at: Some(fact.created_at.clone()),
            context: SearchResultContext {
                project_id: Some(fact.project_id.clone()),
                project_name: project
                    .payload
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                conversation_id: Some(fact.conversation_id.clone()),
                message_id: fact.message_id.clone(),
                branch_id: fact.branch_id.clone(),
                source_revision_id: fact.source_revision_id.clone(),
                ..SearchResultContext::default()
            },
        });
    }
    Ok((results, truncated))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn scan_work(
    conn: &Connection,
    store: &Store,
    scope: &PrivateDataScope,
    workspace_id: &str,
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
    page: usize,
) -> Result<(Vec<SearchResult>, bool)> {
    let (works, truncated) = collaboration_repo::list_bounded::<Work>(
        conn,
        store,
        scope,
        Kind::Work,
        limits.max_work,
        page * limits.max_work,
    )?;
    summary.work_scanned += works.len();
    let mut results = Vec::new();
    for work in works {
        // Resolve lifecycle for this exact object; a capped catalogue scan is
        // not evidence that an omitted Project is active.
        let project = work
            .project_id
            .as_deref()
            .map(|id| local_project::get_project(conn, store, scope, id))
            .transpose()?
            .flatten();
        let archived = work.status == WorkStatus::Cancelled
            || project
                .as_ref()
                .is_some_and(|project| project.lifecycle == "archived");
        if work.project_id.is_some() && project.is_none() {
            continue;
        }
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
    }
    Ok((results, truncated))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn scan_files(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
    files: &[LocalFileImport],
    include_archived: bool,
    tokens: &[String],
    limits: &SearchLimits,
    summary: &mut SearchScanSummary,
    page: usize,
) -> Result<(Vec<SearchResult>, bool)> {
    let mut results = Vec::new();
    let offset = page * limits.max_files;
    let live_files: Vec<_> = files
        .iter()
        .filter(|file| file.deleted_at.is_none())
        .collect();
    let mut truncated = live_files.len() > offset.saturating_add(limits.max_files);

    for file in live_files.iter().skip(offset).take(limits.max_files) {
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
    }

    let prefix =
        crate::store::private_document_key_prefix(&scope.private).map_err(StoreError::Invalid)?;
    let receipt_prefix = format!("{prefix}computer-");
    let keys = preferences::keys_scoped(conn, &scope.data)?;
    let mut receipt_keys: Vec<String> = keys
        .into_iter()
        .filter(|key| key.starts_with(&receipt_prefix) && key.ends_with(".json"))
        .skip(offset.saturating_sub(live_files.len()))
        .collect();
    let remaining_files = limits.max_files.saturating_sub(summary.files_scanned);
    if receipt_keys.len() > remaining_files {
        receipt_keys.truncate(remaining_files);
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
    }

    Ok((results, truncated))
}

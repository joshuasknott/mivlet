//! Search regression tests.

use super::*;
use crate::collaboration::models::{Fact, Work};
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
                thread_repo::update(tx, store, &scope.data, id, None, Some("archived"), None, at)?;
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

fn seed_decision(
    store: &Store,
    scope: &AuthorizedCommandScope,
    id: &str,
    project_id: &str,
    conversation_id: &str,
    at: &str,
) {
    let decision = Fact {
        id: id.into(),
        project_id: project_id.into(),
        kind: "decision".into(),
        text: "Launch the Aurora review on Tuesday".into(),
        confidence: "confirmed".into(),
        status: "current".into(),
        conversation_id: conversation_id.into(),
        run_id: None,
        branch_id: Some("decision-source-m0".into()),
        message_id: Some("decision-source-m0".into()),
        source_revision_id: Some("decision-source-r0".into()),
        pinned: false,
        source: "Confirmed by the project owner".into(),
        supersedes_id: None,
        created_at: at.into(),
    };
    store
        .transaction(|tx| {
            collaboration_repo::put(
                tx,
                store,
                &scope.private,
                Kind::Fact,
                id,
                None,
                Some(project_id),
                &decision,
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
        "exportName": "mivlet.txt",
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

fn agent(id: &str, name: &str, instructions: &str) -> MivletAgentProfile {
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
    agents: &[MivletAgentProfile],
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
    agents: &[MivletAgentProfile],
    files: &[LocalFileImport],
    limits: &SearchLimits,
) -> SearchResponse {
    store
        .with_conn(|conn| run_bounded(conn, store, scope, &request(query), agents, files, limits))
        .unwrap()
}

#[test]
fn exact_normalized_title_match_precedes_a_higher_relevance_score() {
    let mut results = [
        SearchResult {
            reference: reference("workspace", "conversation", "partial"),
            object_kind: "conversation".into(),
            title: "MCP acceptance notes".into(),
            snippet: "Handoff and MCP acceptance".into(),
            matched_field: "content".into(),
            score: 99.0,
            archived: false,
            updated_at: None,
            context: SearchResultContext::default(),
        },
        SearchResult {
            reference: reference("workspace", "conversation", "owner"),
            object_kind: "conversation".into(),
            title: "Handoff — and MCP acceptance".into(),
            snippet: "Conversation owner".into(),
            matched_field: "title".into(),
            score: 1.0,
            archived: false,
            updated_at: None,
            context: SearchResultContext::default(),
        },
    ];

    let query = normalize_search_text("Handoff and MCP acceptance");
    results.sort_by(|left, right| compare_results(left, right, &query));

    assert_eq!(results[0].reference.id, "owner");
}

#[test]
fn unicode_title_matches_and_empty_query_does_not_promote_empty_titles() {
    let result = |id: &str, title: &str, score: f64| SearchResult {
        reference: reference("workspace", "conversation", id),
        object_kind: "conversation".into(),
        title: title.into(),
        snippet: String::new(),
        matched_field: "title".into(),
        score,
        archived: false,
        updated_at: None,
        context: SearchResultContext::default(),
    };

    let mut unicode = [
        result("partial-unicode", "東京会議 notes", 99.0),
        result("exact-unicode", "Übernahme — 東京会議", 1.0),
    ];
    let unicode_query = normalize_search_text("ÜBERNAHME 東京会議");
    unicode.sort_by(|left, right| compare_results(left, right, &unicode_query));
    assert_eq!(unicode[0].reference.id, "exact-unicode");

    let mut empty_query = [
        result("empty-title", "", 1.0),
        result("notes", "Notes", 10.0),
    ];
    empty_query.sort_by(|left, right| compare_results(left, right, ""));
    assert_eq!(empty_query[0].reference.id, "notes");
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
            result.object_kind == "file" && result.context.file_kind.as_deref() == Some("artifact")
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
            result.object_kind == "file" && result.context.file_kind.as_deref() == Some("knowledge")
        })
        .expect("knowledge result");
    assert_eq!(knowledge.reference.id, "file-1");
    assert_eq!(knowledge.context.project_id, None);
}

#[test]
fn message_budget_is_enforced_before_loading_a_long_thread() {
    let store = store();
    let scope = scope("member-a");
    seed_thread(&store, &scope, "long", "Unrelated title", "active", TIME);
    seed_messages(
        &store,
        &scope,
        "long",
        "long",
        &["first", "second", "aurora"],
        TIME,
    );
    let limits = SearchLimits {
        max_messages: 2,
        ..SearchLimits::default()
    };
    let mut query = request("aurora");
    query.kinds = Some(vec!["conversation".into()]);
    let response = store
        .with_conn(|conn| run_bounded(conn, &store, &scope, &query, &[], &[], &limits))
        .unwrap();
    assert_eq!(response.scanned.messages_scanned, 2);
    assert!(response.truncated);
    assert!(response.results.is_empty());
    query.cursor = response.next_cursor;
    assert!(query.cursor.is_some());
    let tail = store
        .with_conn(|conn| run_bounded(conn, &store, &scope, &query, &[], &[], &limits))
        .unwrap();
    assert_eq!(tail.scanned.messages_scanned, 1);
    assert_eq!(tail.results.len(), 1);
    assert_eq!(tail.results[0].reference.id, "long");
    assert!(tail.next_cursor.is_none());
}

#[test]
fn work_archive_checks_do_not_depend_on_project_scan_budget() {
    let store = store();
    let scope = scope("member-a");
    seed_thread(&store, &scope, "chat", "Chat", "active", TIME);
    seed_project(
        &store, &scope, "archived", "Project", "", "archived", "chat", TIME,
    );
    seed_work(
        &store,
        &scope,
        "work",
        "aurora",
        "Agent",
        "chat",
        Some("archived"),
        "completed",
        TIME,
    );
    let limits = SearchLimits {
        max_projects: 0,
        ..SearchLimits::default()
    };
    let mut query = request("aurora");
    query.kinds = Some(vec!["work".into()]);
    let response = store
        .with_conn(|conn| run_bounded(conn, &store, &scope, &query, &[], &[], &limits))
        .unwrap();
    assert!(response.results.is_empty());
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
        .any(|result| result.object_kind == "conversation"));
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
        max_decisions: 4,
        max_files: 4,
    };
    let response = search_bounded(&store, &scope, "limit", &[], &[], &limits);
    assert!(response.truncated);
    assert_eq!(response.scanned.conversations_scanned, 2);
    assert_eq!(response.results.len(), 2);
}

#[test]
fn file_pages_cross_the_import_receipt_boundary_without_gaps() {
    let store = store();
    let scope = scope("member-a");
    let files = vec![
        knowledge("one", "Aurora one", "", false, false),
        knowledge("two", "Aurora two", "", false, false),
        knowledge("three", "Aurora three", "", false, false),
    ];
    for index in 0..3 {
        seed_artifact(
            &store,
            &scope,
            &format!("receipt-{index}"),
            "agent",
            "Aurora artifact",
            &format!("notes/{index}.txt"),
            TIME,
        );
    }
    let limits = SearchLimits {
        max_files: 2,
        ..SearchLimits::default()
    };
    let mut query = request("aurora");
    query.kinds = Some(vec!["file".into()]);
    let mut found = std::collections::HashSet::new();
    for page in 0..3 {
        let response = store
            .with_conn(|conn| run_bounded(conn, &store, &scope, &query, &[], &files, &limits))
            .unwrap();
        assert_eq!(response.scanned.files_scanned, 2);
        assert_eq!(response.results.len(), 2);
        for result in response.results {
            assert!(found.insert(result.reference.id));
        }
        query.cursor = response.next_cursor;
        assert_eq!(query.cursor.is_some(), page < 2);
    }
    assert_eq!(found.len(), 6);
}

#[test]
fn scan_windows_and_result_pages_reach_all_private_records() {
    let store = store();
    let scope = scope("member-a");
    for index in 0..5 {
        let id = format!("page-{index}");
        seed_thread(&store, &scope, &id, "Aurora chat", "active", TIME);
        seed_project(
            &store,
            &scope,
            &id,
            "Aurora project",
            "",
            "active",
            &id,
            TIME,
        );
        seed_work(
            &store,
            &scope,
            &id,
            "Aurora work",
            "Agent",
            &id,
            None,
            "completed",
            TIME,
        );
    }
    let limits = SearchLimits {
        max_threads: 2,
        max_projects: 2,
        max_work: 2,
        ..SearchLimits::default()
    };
    let mut query = request("aurora");
    query.kinds = Some(vec!["conversation".into(), "project".into(), "work".into()]);
    query.limit = Some(2);
    let mut found = std::collections::HashSet::new();
    for page in 0..12 {
        let response = store
            .with_conn(|conn| run_bounded(conn, &store, &scope, &query, &[], &[], &limits))
            .unwrap();
        assert!(response.scanned.conversations_scanned <= 2);
        assert!(response.scanned.projects_scanned <= 2);
        assert!(response.scanned.work_scanned <= 2);
        assert!(response.results.len() <= 2);
        for result in response.results {
            assert!(found.insert(format!("{}:{}", result.object_kind, result.reference.id)));
        }
        query.cursor = response.next_cursor;
        if query.cursor.is_none() {
            break;
        }
        assert!(page < 11, "pagination must terminate");
    }
    assert_eq!(found.len(), 15);
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

#[test]
fn decision_search_returns_scoped_source_provenance() {
    let store = store();
    let scope = scope("member-a");
    seed_thread(
        &store,
        &scope,
        "decision-thread",
        "Aurora decisions",
        "active",
        TIME,
    );
    seed_project(
        &store,
        &scope,
        "decision-project",
        "Aurora project",
        "",
        "active",
        "decision-thread",
        TIME,
    );
    seed_messages(
        &store,
        &scope,
        "decision-thread",
        "decision-source",
        &["The project decision source"],
        TIME,
    );
    seed_decision(
        &store,
        &scope,
        "decision-aurora",
        "decision-project",
        "decision-thread",
        TIME,
    );

    let mut query = request("tuesday");
    query.kinds = Some(vec!["decision".into()]);
    let response = store
        .with_conn(|conn| run(conn, &store, &scope, &query, &[], &[]))
        .unwrap();
    assert_eq!(response.results.len(), 1);
    let result = &response.results[0];
    assert_eq!(result.object_kind, "decision");
    assert_eq!(
        result.context.conversation_id.as_deref(),
        Some("decision-thread")
    );
    assert_eq!(
        result.context.message_id.as_deref(),
        Some("decision-source-m0")
    );
    assert_eq!(
        result.context.branch_id.as_deref(),
        Some("decision-source-m0")
    );
    assert_eq!(
        result.context.source_revision_id.as_deref(),
        Some("decision-source-r0")
    );
}

fn find_result<'a>(response: &'a SearchResponse, object_kind: &str, id: &str) -> &'a SearchResult {
    response
        .results
        .iter()
        .find(|result| result.object_kind == object_kind && result.reference.id == id)
        .unwrap_or_else(|| panic!("missing {object_kind} result {id}"))
}

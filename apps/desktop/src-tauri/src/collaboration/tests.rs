//! Deterministic storage/coordination fixtures. No live provider is simulated as
//! successful product evidence; fixture attempts are explicitly authored here.
use super::*;
use crate::store::repos::scope::{DataScope, PrivateDataScope};
use crate::store::repos::{draft, execution_attempt, message};
use crate::store::vault::{MasterKey, Vault};
use serde_json::json;
use sha2::{Digest, Sha256};

#[path = "exchange_regressions.rs"]
mod exchange_regressions;
#[path = "scheduling_regressions.rs"]
mod scheduling_regressions;
#[path = "workspace_tests.rs"]
mod workspace_tests;

const TIME: &str = "2026-09-12T10:00:00.000Z";

fn store() -> Store {
    Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
}
fn profiles() -> Vec<MivletAgentProfile> {
    ["lead", "researcher", "reviewer"].iter().map(|id| serde_json::from_value(json!({"id":id,"name":id,"instructions":"Fixture teammate","modelId":"openai::fixture-model","icon":"sparkle","permissionLabel":"Ask Me"})).unwrap()).collect()
}
fn fixture<T>(store: &Store, f: impl FnOnce(&Context<'_>) -> Result<T>) -> T {
    fixture_with_profiles(store, profiles(), f)
}
fn fixture_with_profiles<T>(
    store: &Store,
    profiles: Vec<MivletAgentProfile>,
    f: impl FnOnce(&Context<'_>) -> Result<T>,
) -> T {
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            f(&Context {
                conn,
                store,
                scope: &scope,
                profiles: &profiles,
                time: TIME,
            })
        })
        .unwrap()
}
#[test]
fn integration_chat_capture_compacts_old_text_and_never_adopts_later_chat() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        for index in 0..32 {
            output(
                ctx,
                &room.id,
                &format!("old-{index}"),
                &format!("Earlier decision {index}"),
            )?;
        }
        let agent = ctx
            .profiles
            .iter()
            .find(|agent| agent.id == "lead")
            .unwrap();
        let first = context::capture(ctx, &room, agent)?;
        let captured: serde_json::Value = serde_json::from_str(&first.text).unwrap();
        assert_eq!(captured["history"].as_array().unwrap().len(), 24);
        assert!(captured["transcriptSummary"]["text"]
            .as_str()
            .unwrap()
            .contains("Earlier decision 0"));
        output(ctx, &room.id, "later", "Future unrelated input")?;
        assert!(!first.text.contains("Future unrelated input"));
        let next = context::capture(ctx, &room, agent)?;
        let next: serde_json::Value = serde_json::from_str(&next.text).unwrap();
        assert!(
            next["transcriptSummary"]["throughSequence"]
                .as_i64()
                .unwrap()
                > captured["transcriptSummary"]["throughSequence"]
                    .as_i64()
                    .unwrap()
        );
        assert_eq!(
            next["transcriptSummary"]["text"]
                .as_str()
                .unwrap()
                .matches("Earlier decision 0")
                .count(),
            1
        );
        // A deleted source revision cannot survive in the derived cache.
        ctx.conn.execute(
            "UPDATE message SET deleted_at=?1 WHERE id='message-old-0'",
            [TIME],
        )?;
        let changed = context::capture(ctx, &room, agent)?;
        assert!(!changed.text.contains("Earlier decision 0"));
        Ok(())
    });
}

#[test]
fn integration_project_snapshots_are_recipient_scoped_and_frozen() {
    fixture(&store(), |ctx| {
        project(ctx, "shared-project", "shared-chat")?;
        let mut row =
            local_project::get_project(ctx.conn, ctx.store, &ctx.scope.private, "shared-project")?
                .unwrap();
        row.payload["shares"] = json!([{"id":"snapshot","mode":"snapshot","source":{"workspaceId":ctx.scope.data.workspace_id(),"kind":"conversation","id":"deleted-source"},"sourceRevision":"original","recipient":{"kind":"agent","id":"lead"},"owner":{"kind":"user","name":"You"},"title":"Selected conclusion","snapshotText":"Immutable selected bytes","createdAt":TIME}]);
        let own =
            crate::local_projects::capture_shares(ctx.conn, ctx.store, ctx.scope, &row, "lead")?;
        assert_eq!(own[0]["text"], "Immutable selected bytes");
        assert_eq!(own[0]["sourceRevision"], "original");
        assert!(crate::local_projects::capture_shares(
            ctx.conn,
            ctx.store,
            ctx.scope,
            &row,
            "researcher"
        )?
        .is_empty());
        assert!(crate::local_projects::capture_shares(
            ctx.conn, ctx.store, ctx.scope, &row, "outsider"
        )?
        .is_empty());
        row.payload["shares"][0]["mode"] = json!("live-reference");
        let unavailable =
            crate::local_projects::capture_shares(ctx.conn, ctx.store, ctx.scope, &row, "lead")?;
        assert_eq!(unavailable[0]["available"], false);
        Ok(())
    });
}

#[test]
fn integration_shared_file_resolution_checks_project_owner_and_liveness() {
    fixture(&store(), |ctx| {
        use crate::store::repos::knowledge_source;
        ctx.conn.execute("INSERT INTO project (id,workspace_id,title_fingerprint,created_at,updated_at,payload,payload_nonce) VALUES ('source-project',?1,'fixture',?2,?2,x'',x'')", rusqlite::params![ctx.scope.data.workspace_id(), TIME])?;
        let source_scope = PrivateDataScope::for_authenticated_user(
            DataScope::new(ctx.scope.data.workspace_id(), Some("source-project".into()))?,
            &ctx.scope.internal_user_id,
            ctx.scope.member_id.as_deref(),
        )?;
        knowledge_source::upsert_private(
            ctx.conn,
            ctx.store,
            &source_scope,
            json!({"id":"shared-file","contentPreview":"Project-scoped evidence","contentFingerprint":"v1"}),
            TIME,
        )?;
        assert!(
            knowledge_source::list_private(ctx.conn, ctx.store, &ctx.scope.private)?.is_empty()
        );
        let source = knowledge_source::get_shared_source(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            "source-project",
            "shared-file",
        )?
        .unwrap();
        assert_eq!(source.payload["contentPreview"], "Project-scoped evidence");
        assert!(knowledge_source::get_shared_source(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            "another-project",
            "shared-file"
        )?
        .is_none());
        let stranger = PrivateDataScope::for_authenticated_user(
            ctx.scope.data.clone(),
            "stranger",
            Some("stranger"),
        )?;
        assert!(knowledge_source::get_shared_source(
            ctx.conn,
            ctx.store,
            &stranger,
            "source-project",
            "shared-file"
        )?
        .is_none());
        ctx.conn.execute(
            "UPDATE knowledge_source SET disabled=1 WHERE id='shared-file'",
            [],
        )?;
        assert!(knowledge_source::get_shared_source(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            "source-project",
            "shared-file"
        )?
        .is_none());
        Ok(())
    });
}

fn account_scope(data: &DataScope, user: &str, member: &str) -> AuthorizedCommandScope {
    AuthorizedCommandScope {
        data: data.clone(),
        private: PrivateDataScope::for_authenticated_user(data.clone(), user, Some(member))
            .unwrap(),
        internal_user_id: user.into(),
        member_id: Some(member.into()),
    }
}
fn group(ctx: &Context<'_>, key: &str) -> Result<Conversation> {
    project(ctx, &format!("project-{key}"), key)
}
fn journal(ctx: &Context<'_>, room: &str, run: &str, status: &str, transcript: &str) -> Result<()> {
    let payload = json!({"id":run,"providerId":"openai","model":"fixture-model","status":status,"transcript":transcript,"threadId":room,"exchanges":[],"turn":1,"usage":{"inputTokens":100,"outputTokens":100,"costUsd":0.0},"pendingApprovalIds":[],"recoverable":true,"retryCount":0,"createdAt":TIME,"updatedAt":TIME});
    execution_attempt::upsert_scoped(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        run,
        Some(room),
        "openai",
        "fixture-model",
        status,
        1,
        true,
        0,
        TIME,
        TIME,
        &payload,
    )
}
fn output(ctx: &Context<'_>, room: &str, run: &str, text: &str) -> Result<()> {
    let thread = thread::get(ctx.conn, ctx.store, &ctx.scope.data, room)?.unwrap();
    message::append(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        room,
        &format!("message-{run}"),
        "assistant",
        &json!({"kind":"text"}),
        Some(run),
        thread.last_sequence + 1,
        thread.last_sequence,
        thread.last_message_id.as_deref(),
        &format!("output-{run}"),
        &format!("revision-{run}"),
        "terminal",
        "provider-completed",
        &json!({"text":text}),
        TIME,
    )?;
    journal(ctx, room, run, "completed", text)
}
fn bind(ctx: &Context<'_>, key: &str, run: &str) -> Result<()> {
    let work = ctx.item(key)?;
    journal(ctx, &work.conversation_id, run, "queued", "")?;
    work::bind(ctx, key, work.generation, run, None)
}
fn complete(ctx: &Context<'_>, key: &str, run: &str, text: &str) -> Result<()> {
    let item = ctx.item(key)?;
    output(ctx, &item.conversation_id, run, text)?;
    work::finish(ctx, key, item.generation, run, WorkStatus::Completed, None)
}
fn delegate(agent: &str, prompt: &str) -> AgentCommand {
    AgentCommand::Delegate {
        agent_id: agent.into(),
        prompt: prompt.into(),
        title: prompt.into(),
        dependencies: vec![],
        focused: false,
    }
}
fn staged_attachment(id: &str, path: &str) -> WorkAttachment {
    staged_attachment_with_hash(id, path, 128, &"a".repeat(64))
}
fn staged_attachment_with_hash(id: &str, path: &str, size: u64, hash: &str) -> WorkAttachment {
    WorkAttachment {
        id: id.into(),
        name: path.rsplit('/').next().unwrap_or(id).into(),
        mime_type: "text/plain".into(),
        size_bytes: size,
        availability: "workspace-file".into(),
        relative_path: Some(path.into()),
        source_id: None,
        sha256: Some(hash.into()),
    }
}
fn project(ctx: &Context<'_>, project: &str, conversation: &str) -> Result<Conversation> {
    // Standalone groups are retired; fixture group rooms are project-owned.
    thread::create(
        ctx.conn,
        ctx.store,
        &ctx.scope.data,
        conversation,
        None,
        "Fixture group",
        TIME,
        &json!({"authorityScope":{"authority":"local","visibility":"member-private","ownerMemberId":ctx.scope.private.owner_member_id()}}),
    )?;
    ctx.conn.execute(
        "UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3 AND owner_member_id IS NULL",
        rusqlite::params![ctx.scope.private.owner_member_id(), ctx.scope.data.workspace_id(), conversation],
    )?;
    let row = local_project::LocalProjectRow {
        id: project.into(),
        lifecycle: "active".into(),
        revision: 1,
        thread_id: conversation.into(),
        created_at: TIME.into(),
        updated_at: TIME.into(),
        archived_at: None,
        payload: json!({"name":"Fixture project","instructions":"Keep the sources","knowledgeSourceIds":[]}),
    };
    local_project::insert_project(ctx.conn, ctx.store, &ctx.scope.private, &row)?;
    ctx.team(&Team {
        project_id: project.into(),
        lead_agent_id: Some("lead".into()),
        participant_ids: vec!["lead".into(), "researcher".into(), "reviewer".into()],
        revision: 1,
    })?;
    let room = Conversation {
        archived: false,
        chat: Some(ChatBinding {
            role: "main".into(),
            owner_kind: "project".into(),
            owner_id: project.into(),
        }),
        id: conversation.into(),
        workspace_id: ctx.scope.data.workspace_id().into(),
        kind: "group".into(),
        title: "Fixture group".into(),
        project_id: Some(project.into()),
        facilitator_id: Some("lead".into()),
        participants: participants(
            ctx.profiles,
            &["lead".into(), "researcher".into(), "reviewer".into()],
            Some("lead"),
        )?,
        revision: 1,
        generation: 1,
        created_at: TIME.into(),
        updated_at: TIME.into(),
    };
    ctx.conversation(&room)?;
    Ok(room)
}

#[test]
fn collaboration_direct_histories_have_distinct_identity_and_workspace_dispatch_is_explicit() {
    fixture(&store(), |ctx| {
        for key in ["private-one", "private-two"] {
            ctx.create_room(
                key,
                key,
                "direct",
                participants(ctx.profiles, &["lead".into()], Some("lead"))?,
                Some("lead".into()),
                None,
            )?;
            work::start(
                ctx,
                format!("work-{key}"),
                key.into(),
                "lead".into(),
                format!("Question in {key}"),
                false,
                None,
                None,
            )?;
        }
        bind(ctx, "work-private-one", "run-one")?;
        assert!(
            bind(ctx, "work-private-two", "run-two").is_err(),
            "one agent cannot accidentally overlap work"
        );
        assert!(work::agent_command(
            ctx,
            "work-private-one",
            1,
            "run-one",
            "call",
            delegate("researcher", "Share private text")
        )
        .is_ok());
        complete(ctx, "work-private-one", "run-one", "Private result one")?;
        bind(ctx, "work-private-two", "run-two")?;
        complete(ctx, "work-private-two", "run-two", "Private result two")?;
        assert_eq!(
            message::list(ctx.conn, ctx.store, &ctx.scope.data, "private-one")?.len(),
            1
        );
        assert_eq!(
            message::list(ctx.conn, ctx.store, &ctx.scope.data, "private-two")?.len(),
            1
        );
        assert_eq!(ctx.snapshot()?.authors.len(), 2);
        Ok(())
    });
}

#[test]
fn collaboration_question_response_and_synthesis_use_distinct_real_attempt_bindings() {
    fixture(&store(), |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Compare two plans".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run-lead-one")?;
        work::agent_command(
            ctx,
            "root",
            1,
            "run-lead-one",
            "ask",
            delegate("researcher", "Find a constraint"),
        )?;
        let child = ctx
            .all_work()?
            .into_iter()
            .find(|w| w.parent_id.as_deref() == Some("root"))
            .unwrap();
        complete(
            ctx,
            "root",
            "run-lead-one",
            "I asked the researcher for the constraint.",
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Waiting);
        bind(ctx, &child.id, "run-researcher")?;
        complete(
            ctx,
            &child.id,
            "run-researcher",
            "Constraint: available capacity is two.",
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Queued);
        bind(ctx, "root", "run-lead-two")?;
        complete(
            ctx,
            "root",
            "run-lead-two",
            "Using the returned capacity of two, choose the smaller plan.",
        )?;
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::Completed);
        assert_eq!(root.turn_count, 3);
        assert_eq!(root.token_usage, 600);
        assert_eq!(root.outputs.len(), 2);
        complete(
            ctx,
            "root",
            "run-lead-two",
            "Using the returned capacity of two, choose the smaller plan.",
        )?;
        assert_eq!(
            ctx.item("root")?.outputs.len(),
            2,
            "duplicate completion cannot dispatch or count twice"
        );
        Ok(())
    });
}

#[test]
fn collaboration_duplicate_circular_and_nonparticipant_handoffs_fail_closed() {
    fixture(&store(), |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Discuss".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run-lead")?;
        let command = delegate("researcher", "Question");
        work::agent_command(ctx, "root", 1, "run-lead", "call", command.clone())?;
        work::agent_command(ctx, "root", 1, "run-lead", "call", command)?;
        assert_eq!(ctx.all_work()?.len(), 2);
        assert!(work::agent_command(
            ctx,
            "root",
            1,
            "run-lead",
            "call",
            delegate("reviewer", "Different question")
        )
        .is_err());
        assert!(
            work::agent_command(ctx, "root", 1, "run-lead", "self", delegate("lead", "Self"))
                .is_err()
        );
        assert!(work::agent_command(
            ctx,
            "root",
            1,
            "run-lead",
            "missing",
            delegate("missing", "Question")
        )
        .is_err());
        let child = ctx
            .all_work()?
            .into_iter()
            .find(|w| w.id != "root")
            .unwrap();
        bind(ctx, &child.id, "run-child")?;
        assert!(work::agent_command(
            ctx,
            &child.id,
            1,
            "run-child",
            "cycle",
            delegate("lead", "Loop")
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn collaboration_cancel_fences_descendants_and_preserves_unrelated_work() {
    fixture(&store(), |ctx| {
        group(ctx, "group")?;
        group(ctx, "unrelated")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Discuss".into(),
            false,
            None,
            None,
        )?;
        work::start(
            ctx,
            "other".into(),
            "unrelated".into(),
            "reviewer".into(),
            "Separate request".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run-lead")?;
        work::agent_command(
            ctx,
            "root",
            1,
            "run-lead",
            "child",
            delegate("researcher", "Question"),
        )?;
        commands::apply(
            ctx,
            Command::StopWork {
                id: "root".into(),
                expected_generation: None,
            },
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Cancelled);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run-lead")).is_err());
        assert!(work::agent_command(
            ctx,
            "root",
            1,
            "run-lead",
            "late",
            delegate("reviewer", "Late")
        )
        .is_err());
        assert_eq!(ctx.item("other")?.status, WorkStatus::Queued);
        assert!(ctx
            .all_work()?
            .iter()
            .filter(|w| w.root_id == "root")
            .all(|w| w.status == WorkStatus::Cancelled));
        Ok(())
    });
}

#[test]
fn collaboration_completion_requires_saved_provider_result_and_enforces_turn_budget() {
    fixture(&store(), |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Do work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        assert!(work::finish(ctx, "root", 1, "run", WorkStatus::Completed, None).is_err());
        journal(ctx, "group", "run", "completed", "Unsaved report")?;
        assert!(work::finish(ctx, "root", 1, "run", WorkStatus::Completed, None).is_err());
        let mut root = ctx.item("root")?;
        root.turn_count = root.max_turns;
        ctx.work(&root)?;
        assert!(work::agent_command(
            ctx,
            "root",
            1,
            "run",
            "over-budget",
            delegate("researcher", "More work")
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn collaboration_restart_marks_work_for_review_and_does_not_replay_attempts() {
    let store = store();
    fixture(&store, |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")
    });
    recover(&store).unwrap();
    fixture(&store, |ctx| {
        let work = ctx.item("root")?;
        assert_eq!(work.status, WorkStatus::AwaitingUser);
        assert_eq!(work.generation, 2);
        assert_eq!(work.run_ids, vec!["run"]);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run")).is_err());
        assert!(commands::apply(
            ctx,
            Command::ContinueWork {
                id: "root".into(),
                expected_generation: 2,
                reconcile: false
            }
        )
        .is_err());
        commands::apply(
            ctx,
            Command::ContinueWork {
                id: "root".into(),
                expected_generation: 2,
                reconcile: true,
            },
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Queued);
        assert_eq!(ctx.item("root")?.current_run_id, None);
        Ok(())
    });
}

#[test]
fn remount_recovery_fences_orphaned_executing_work_and_rejects_late_writes() {
    let store = store();
    fixture(&store, |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        work::start(
            ctx,
            "queued".into(),
            "group".into(),
            "reviewer".into(),
            "Later".into(),
            false,
            None,
            None,
        )?;
        work::start(
            ctx,
            "approval".into(),
            "group".into(),
            "researcher".into(),
            "Permit".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "approval", "run-approval")?;
        let mut approval = ctx.item("approval")?;
        approval.status = WorkStatus::AwaitingApproval;
        ctx.work(&approval)?;
        Ok(())
    });
    store
        .transaction(|conn| fence_orphaned_executing_work(conn, &store, TIME))
        .unwrap();
    fixture(&store, |ctx| {
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::AwaitingUser);
        assert_eq!(root.generation, 2);
        assert_eq!(root.current_run_id, None);
        assert!(root.reason.as_deref().unwrap().contains("execution owner"));
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run")).is_err());
        let approval = ctx.item("approval")?;
        assert_eq!(approval.status, WorkStatus::AwaitingUser);
        assert_eq!(approval.generation, 2);
        assert_eq!(approval.current_run_id, None);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run-approval")).is_err());
        assert_eq!(ctx.item("queued")?.status, WorkStatus::Queued);
        assert_eq!(ctx.item("queued")?.generation, 1);
        Ok(())
    });
}

#[test]
fn generation_fenced_stop_work_is_a_noop_after_remount_recovery() {
    let store = store();
    fixture(&store, |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        Ok(())
    });
    store
        .transaction(|conn| fence_orphaned_executing_work(conn, &store, TIME))
        .unwrap();
    fixture(&store, |ctx| {
        commands::apply(
            ctx,
            Command::StopWork {
                id: "root".into(),
                expected_generation: Some(1),
            },
        )?;
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::AwaitingUser);
        assert_eq!(root.generation, 2);
        assert_eq!(root.current_run_id, None);
        assert!(root.reason.as_deref().unwrap().contains("execution owner"));
        Ok(())
    });
}

#[test]
fn generation_fenced_stop_work_does_not_cancel_a_continued_assignment() {
    let store = store();
    fixture(&store, |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        Ok(())
    });
    store
        .transaction(|conn| fence_orphaned_executing_work(conn, &store, TIME))
        .unwrap();
    fixture(&store, |ctx| {
        commands::apply(
            ctx,
            Command::ContinueWork {
                id: "root".into(),
                expected_generation: 2,
                reconcile: true,
            },
        )?;
        bind(ctx, "root", "run-continued")?;
        commands::apply(
            ctx,
            Command::StopWork {
                id: "root".into(),
                expected_generation: Some(1),
            },
        )?;
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::Running);
        assert_eq!(root.current_run_id.as_deref(), Some("run-continued"));
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run-continued")).is_ok());
        Ok(())
    });
}

#[test]
fn generation_fenced_stop_work_still_cancels_the_captured_generation() {
    let store = store();
    fixture(&store, |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        commands::apply(
            ctx,
            Command::StopWork {
                id: "root".into(),
                expected_generation: Some(1),
            },
        )?;
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::Cancelled);
        assert_eq!(root.generation, 2);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run")).is_err());
        Ok(())
    });
}

#[test]
fn stop_work_omitting_expected_generation_deserializes_as_unfenced() {
    let command: Command = serde_json::from_str(r#"{"action":"stop-work","id":"root"}"#).unwrap();
    match command {
        Command::StopWork {
            id,
            expected_generation,
        } => {
            assert_eq!(id, "root");
            assert_eq!(expected_generation, None);
        }
        other => panic!("expected StopWork, got {other:?}"),
    }
}

#[test]
fn recover_interrupted_attempts_fences_executing_work_and_marks_the_journal() {
    let store = store();
    fixture(&store, |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        Ok(())
    });
    let recovered =
        crate::execution_attempts::recover_interrupted_attempts_in_store(&store, TIME).unwrap();
    assert!(recovered
        .iter()
        .any(|attempt| attempt.id == "run" && attempt.status == "interrupted"));
    fixture(&store, |ctx| {
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::AwaitingUser);
        assert_eq!(root.generation, 2);
        assert_eq!(root.current_run_id, None);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run")).is_err());
        Ok(())
    });
}

fn attempt_record(
    run: &str,
    room: &str,
    status: &str,
    transcript: &str,
) -> crate::models::ExecutionAttempt {
    serde_json::from_value(json!({
        "id": run,
        "providerId": "openai",
        "model": "fixture-model",
        "status": status,
        "transcript": transcript,
        "threadId": room,
        "exchanges": [],
        "turn": 1,
        "usage": {"inputTokens": 100, "outputTokens": 100, "costUsd": 0.0},
        "pendingApprovalIds": [],
        "recoverable": true,
        "retryCount": 0,
        "createdAt": TIME,
        "updatedAt": TIME,
    }))
    .unwrap()
}

#[test]
fn save_path_rejects_interrupted_to_completed_and_allows_exact_replay() {
    let store = store();
    let room = fixture(&store, |ctx| {
        group(ctx, "group")?;
        work::start(
            ctx,
            "root".into(),
            "group".into(),
            "lead".into(),
            "Work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        Ok(ctx.item("root")?.conversation_id)
    });
    let interrupted = attempt_record("run", &room, "interrupted", "partial");
    fixture(&store, |ctx| {
        let payload = serde_json::to_value(&interrupted).unwrap();
        execution_attempt::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            "run",
            Some(&room),
            "openai",
            "fixture-model",
            "interrupted",
            1,
            true,
            0,
            TIME,
            TIME,
            &payload,
        )?;
        Ok(())
    });
    let mut completed = interrupted.clone();
    completed.status = "completed".into();
    completed.transcript = "final".into();
    completed.updated_at = "2026-09-12T10:01:00.000Z".into();
    let error =
        crate::execution_attempts::save_execution_attempt_record(&store, completed).unwrap_err();
    assert!(
        error.contains("immutable"),
        "expected terminal immutability, got {error}"
    );
    crate::execution_attempts::save_execution_attempt_record(&store, interrupted.clone())
        .expect("exact replay of a terminal attempt is allowed");
    fixture(&store, |ctx| {
        assert_eq!(ctx.item("root")?.status, WorkStatus::Running);
        assert_eq!(ctx.item("root")?.current_run_id.as_deref(), Some("run"));
        Ok(())
    });
}

#[test]
fn collaboration_project_correction_invalidates_work_and_never_reads_private_history() {
    fixture(&store(), |ctx| {
        project(ctx, "project", "main")?;
        let main = ctx.room("main")?;
        ctx.create_room(
            "focused",
            "Decision discussion",
            "group",
            main.participants,
            Some("reviewer".into()),
            Some("project".into()),
        )?;
        group(ctx, "private")?;
        work::start(
            ctx,
            "root".into(),
            "main".into(),
            "lead".into(),
            "Plan work".into(),
            false,
            None,
            None,
        )?;
        work::start(
            ctx,
            "unrelated".into(),
            "private".into(),
            "researcher".into(),
            "Private request".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        commands::apply(
            ctx,
            Command::SaveFact {
                project_id: "project".into(),
                conversation_id: "focused".into(),
                id: "decision".into(),
                kind: "decision".into(),
                text: "Use a two week deadline".into(),
                source: "User correction in this conversation".into(),
                supersedes_id: None,
            },
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::AwaitingUser);
        assert_eq!(ctx.item("unrelated")?.status, WorkStatus::Queued);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("run")).is_err());
        commands::apply(
            ctx,
            Command::SaveFact {
                project_id: "project".into(),
                conversation_id: "focused".into(),
                id: "corrected".into(),
                kind: "decision".into(),
                text: "Use three weeks".into(),
                source: "User correction".into(),
                supersedes_id: Some("decision".into()),
            },
        )?;
        let old: Fact = repo::get(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Fact,
            "decision",
        )?
        .unwrap();
        assert_eq!(old.status, "superseded");
        commands::apply(
            ctx,
            Command::ChangeFact {
                project_id: "project".into(),
                id: "corrected".into(),
                status: "forgotten".into(),
            },
        )?;
        let forgotten: Fact = repo::get(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Fact,
            "corrected",
        )?
        .unwrap();
        assert!(forgotten.text.is_empty());
        assert!(commands::apply(
            ctx,
            Command::SaveFact {
                project_id: "project".into(),
                conversation_id: "private".into(),
                id: "leak".into(),
                kind: "fact".into(),
                text: "Private fact".into(),
                source: "Private".into(),
                supersedes_id: None
            }
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn collaboration_membership_and_lead_change_preserve_authorship_reject_late_work() {
    fixture(&store(), |ctx| {
        project(ctx, "project", "main")?;
        work::start(
            ctx,
            "root".into(),
            "main".into(),
            "researcher".into(),
            "Research".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        commands::apply(
            ctx,
            Command::UpdateTeam {
                project_id: "project".into(),
                expected_revision: 1,
                lead_agent_id: Some("reviewer".into()),
                participant_ids: vec!["lead".into(), "reviewer".into()],
                share_history: false,
            },
        )?;
        assert_eq!(ctx.room("main")?.facilitator_id, Some("reviewer".into()));
        assert!(work::current(ctx, "root", 1, Some("run")).is_err());
        assert_eq!(ctx.snapshot()?.authors[0].name, "researcher");
        assert!(work::start(
            ctx,
            "removed".into(),
            "main".into(),
            "researcher".into(),
            "Do more".into(),
            false,
            None,
            None
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn collaboration_v41_migration_retains_original_thread_ciphertext_and_authorship() {
    fixture(&store(), |ctx| {
        project(ctx, "project", "legacy")?;
        journal(ctx, "legacy", "old-run", "queued", "")?;
        output(
            ctx,
            "legacy",
            "old-run",
            "Existing content and attachment reference",
        )?;
        local_project::insert_run_author(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            &local_project::LocalProjectRunAuthorRow {
                project_id: "project".into(),
                run_id: "old-run".into(),
                agent_id: "researcher".into(),
                thread_id: "legacy".into(),
                created_at: TIME.into(),
                payload: json!({"agentName":"Historical name"}),
            },
        )?;
        let before: Vec<u8> = ctx.conn.query_row(
            "SELECT payload FROM message_revision WHERE id='revision-old-run'",
            [],
            |r| r.get(0),
        )?;
        ctx.conn.execute_batch("DROP TABLE collaboration_record")?;
        crate::store::migrations::apply(ctx.conn, 41, 42)?;
        adopt_existing(ctx)?;
        adopt_existing(ctx)?;
        let after: Vec<u8> = ctx.conn.query_row(
            "SELECT payload FROM message_revision WHERE id='revision-old-run'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(before, after);
        assert_eq!(ctx.room("legacy")?.project_id, Some("project".into()));
        assert_eq!(ctx.snapshot()?.authors[0].name, "Historical name");
        assert_eq!(ctx.snapshot()?.conversations.len(), 1);
        let sealed: Vec<u8> = ctx.conn.query_row(
            "SELECT payload FROM collaboration_record WHERE kind='conversation'",
            [],
            |r| r.get(0),
        )?;
        assert!(!String::from_utf8_lossy(&sealed).contains("Fixture"));
        Ok(())
    });
}

#[test]
fn collaboration_sharing_requires_explicit_consent_and_layout_does_not_create_work() {
    fixture(&store(), |ctx| {
        project(ctx, "project", "main")?;
        ctx.create_room(
            "private",
            "Private",
            "direct",
            participants(ctx.profiles, &["lead".into()], Some("lead"))?,
            Some("lead".into()),
            None,
        )?;
        assert!(commands::apply(
            ctx,
            Command::PlaceConversation {
                id: "private".into(),
                expected_revision: 1,
                project_id: "project".into(),
                share_history: false
            }
        )
        .is_err());
        assert_eq!(ctx.room("private")?.project_id, None);
        commands::apply(
            ctx,
            Command::PlaceConversation {
                id: "private".into(),
                expected_revision: 1,
                project_id: "project".into(),
                share_history: true,
            },
        )?;
        let layout = Layout {
            version: 2,
            views: vec![],
            panes: vec![vec![]],
            active: vec![None],
            active_pane: 0,
            tree: Some(LayoutNode::Pane { pane: 0 }),
            closed: vec![View {
                id: "tab".into(),
                conversation_id: "private".into(),
                kind: "conversation".into(),
                agent_id: None,
                output: None,
                title: None,
            }],
        };
        commands::apply(ctx, Command::SaveLayout { layout })?;
        assert!(ctx.all_work()?.is_empty());
        assert_eq!(ctx.snapshot()?.layout.unwrap().closed.len(), 1);
        Ok(())
    });
}

#[test]
fn collaboration_scheduled_project_research_uses_the_exact_attempt_and_records_evidence() {
    fixture(&store(), |ctx| {
        project(ctx, "project", "main")?;
        group(ctx, "scheduled-result")?;
        assert!(validate_schedule_project(
            ctx.conn,
            ctx.store,
            ctx.scope,
            Some("project"),
            "outsider"
        )
        .is_err());
        let payload = json!({"id":"scheduled-run","providerId":"openai","model":"fixture-model","status":"queued","transcript":"","threadId":"scheduled-result","exchanges":[{"role":"user","content":"Fixture scheduled project question"}],"turn":0,"pendingApprovalIds":[],"recoverable":true,"retryCount":0,"createdAt":TIME,"updatedAt":TIME});
        execution_attempt::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            "scheduled-run",
            Some("scheduled-result"),
            "openai",
            "fixture-model",
            "queued",
            0,
            true,
            0,
            TIME,
            TIME,
            &payload,
        )?;
        bind_schedule(
            ctx.conn,
            ctx.store,
            ctx.scope,
            ctx.profiles,
            "project",
            "researcher",
            "scheduled-run",
            TIME,
        )?;
        bind_schedule(
            ctx.conn,
            ctx.store,
            ctx.scope,
            ctx.profiles,
            "project",
            "researcher",
            "scheduled-run",
            TIME,
        )?;
        let item = ctx.item("work-scheduled-run")?;
        assert_eq!(item.permission_mode, "read-only");
        assert_eq!(item.run_ids, vec!["scheduled-run"]);
        assert_eq!(item.project_id.as_deref(), Some("project"));
        assert_eq!(
            ctx.room("scheduled-result")?.project_id.as_deref(),
            Some("project")
        );
        output(
            ctx,
            "scheduled-result",
            "scheduled-run",
            "Fixture source-backed research result",
        )?;
        finish_schedule(
            ctx.conn,
            ctx.store,
            ctx.scope,
            ctx.profiles,
            "scheduled-run",
            TIME,
        )?;
        assert_eq!(
            ctx.item("work-scheduled-run")?.status,
            WorkStatus::Completed
        );
        assert_eq!(
            ctx.item("work-scheduled-run")?.outputs[0].run_id,
            "scheduled-run"
        );
        Ok(())
    });
}

#[test]
fn collaboration_rejects_cross_conversation_run_binding_and_keeps_usage_on_continuation() {
    fixture(&store(), |ctx| {
        group(ctx, "one")?;
        group(ctx, "two")?;
        work::start(
            ctx,
            "work".into(),
            "one".into(),
            "lead".into(),
            "Fixture request".into(),
            false,
            None,
            None,
        )?;
        journal(ctx, "two", "wrong-run", "queued", "")?;
        assert!(work::bind(ctx, "work", 1, "wrong-run", None).is_err());
        let mut item = ctx.item("work")?;
        item.status = WorkStatus::AwaitingUser;
        item.token_usage = 128_005;
        item.turn_count = 3;
        ctx.work(&item)?;
        commands::apply(
            ctx,
            Command::ContinueWork {
                id: "work".into(),
                expected_generation: 1,
                reconcile: true,
            },
        )?;
        let continued = ctx.item("work")?;
        assert_eq!(continued.token_usage, 128_005);
        assert_eq!(continued.max_tokens, 256_005);
        assert_eq!(continued.generation, 2);
        assert!(work::current(ctx, "work", 1, None).is_err());
        Ok(())
    });
}

#[test]
fn collaboration_grid_layout_is_bounded_scoped_and_has_unique_panes() {
    fixture(&store(), |ctx| {
        group(ctx, "grid-room")?;
        fn grid(first: usize, count: usize) -> LayoutNode {
            if count == 1 {
                return LayoutNode::Pane { pane: first };
            }
            let half = count / 2;
            LayoutNode::Split {
                axis: if count > 2 { "row" } else { "column" }.into(),
                ratio: 0.5,
                children: [
                    Box::new(grid(first, half)),
                    Box::new(grid(first + half, count - half)),
                ],
            }
        }
        let layout = Layout {
            version: 2,
            views: (0..8)
                .map(|i| View {
                    id: format!("view-{i}"),
                    conversation_id: "grid-room".into(),
                    kind: "conversation".into(),
                    agent_id: None,
                    output: None,
                    title: None,
                })
                .collect(),
            panes: (0..8).map(|i| vec![format!("view-{i}")]).collect(),
            active: (0..8).map(|i| Some(format!("view-{i}"))).collect(),
            active_pane: 7,
            tree: Some(grid(0, 8)),
            closed: vec![],
        };
        commands::apply(
            ctx,
            Command::SaveLayout {
                layout: layout.clone(),
            },
        )?;
        assert_eq!(ctx.snapshot()?.layout, Some(layout.clone()));
        assert!(ctx.all_work()?.is_empty());
        let mut invalid = layout.clone();
        invalid.tree = Some(LayoutNode::Split {
            axis: "row".into(),
            ratio: 0.5,
            children: [Box::new(grid(0, 4)), Box::new(grid(0, 4))],
        });
        assert!(commands::apply(ctx, Command::SaveLayout { layout: invalid }).is_err());
        let mut invalid = layout.clone();
        invalid.views[0].conversation_id = "outside-workspace".into();
        assert!(commands::apply(ctx, Command::SaveLayout { layout: invalid }).is_err());
        let mut invalid = layout.clone();
        invalid.panes.push(vec![]);
        invalid.active.push(None);
        invalid.tree = Some(grid(0, 9));
        assert!(commands::apply(ctx, Command::SaveLayout { layout: invalid }).is_err());
        let mut invalid = layout.clone();
        invalid.active.pop();
        assert!(commands::apply(ctx, Command::SaveLayout { layout: invalid }).is_err());
        let mut invalid = layout.clone();
        if let Some(LayoutNode::Split { ratio, .. }) = invalid.tree.as_mut() {
            *ratio = 1.0;
        }
        assert!(commands::apply(ctx, Command::SaveLayout { layout: invalid }).is_err());
        assert_eq!(ctx.snapshot()?.layout, Some(layout));
        Ok(())
    });
}

#[test]
fn collaboration_legacy_layout_remains_readable_for_renderer_migration() {
    let layout: Layout = serde_json::from_value(json!({ "version": 1, "panes": [[], []], "views": [], "active": [null, null], "activePane": 0, "split": false, "ratio": 0.5, "closed": [] })).unwrap();
    assert_eq!(layout.version, 1);
    assert!(layout.tree.is_none());
}

#[test]
fn roadmap_main_chat_is_unique_under_concurrent_selection_and_excludes_side_history() {
    let store = store();
    let ids = std::thread::scope(|scope| {
        let tasks: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| fixture(&store, |ctx| Ok(chats::open_main(ctx, "lead")?.id))))
            .collect();
        tasks
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(ids.iter().all(|id| id == &ids[0]));
    fixture(&store, |ctx| {
        let side = ctx.create_room(
            "side",
            "Separate question",
            "direct",
            vec![Participant {
                agent_id: "lead".into(),
                name: "lead".into(),
            }],
            Some("lead".into()),
            None,
        )?;
        output(ctx, &side.id, "side-run", "SIBLING_TRANSCRIPT_CANARY")?;
        work::start(
            ctx,
            "captured".into(),
            ids[0].clone(),
            "lead".into(),
            "Do this".into(),
            false,
            None,
            None,
        )?;
        let before = ctx.item("captured")?.captured_context.unwrap();
        output(ctx, &ids[0], "later", "UNRELATED_LATER_CHAT")?;
        let after = ctx.item("captured")?.captured_context.unwrap();
        assert_eq!(before, after);
        assert!(!after.text.contains("SIBLING_TRANSCRIPT_CANARY"));
        assert!(!after.text.contains("UNRELATED_LATER_CHAT"));
        assert_eq!(side.chat.unwrap().role, "side");
        Ok(())
    });
}

#[test]
fn roadmap_steering_and_account_suspension_never_replay_uncertain_effects() {
    let store = store();
    fixture(&store, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "work".into(),
            room.id.clone(),
            "lead".into(),
            "Original request".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "work", "attempt")?;
        let generation = ctx.item("work")?.generation;
        commands::apply(
            ctx,
            Command::SteerWork {
                id: "work".into(),
                expected_generation: generation,
                event_id: "steer".into(),
                text: "Use the smaller scope".into(),
            },
        )?;
        let item = ctx.item("work")?;
        assert_eq!(item.status, WorkStatus::AwaitingUser);
        assert_eq!(item.user_request, "Original request");
        assert_eq!(item.steering.len(), 1);
        assert!(work::current(ctx, "work", generation, Some("attempt")).is_err());
        work::start(
            ctx,
            "queued".into(),
            room.id,
            "lead".into(),
            "Another request".into(),
            false,
            None,
            None,
        )?;
        suspend_account(
            ctx.conn,
            ctx.store,
            &ctx.scope.internal_user_id,
            ctx.scope.member_id.as_deref().unwrap(),
        )?;
        assert_eq!(ctx.item("queued")?.status, WorkStatus::AwaitingUser);
        assert!(ctx.item("queued")?.run_ids.is_empty());
        assert_eq!(ctx.item("work")?.run_ids, vec!["attempt"]);
        Ok(())
    });
}

#[test]
fn roadmap_optional_coordinator_preserves_project_team_and_chat() {
    fixture(&store(), |ctx| {
        project(ctx, "project", "project-chat")?;
        let team = ctx.project_team("project")?;
        commands::apply(
            ctx,
            Command::UpdateTeam {
                project_id: "project".into(),
                expected_revision: team.revision,
                lead_agent_id: None,
                participant_ids: vec!["lead".into(), "researcher".into()],
                share_history: true,
            },
        )?;
        assert_eq!(ctx.project_team("project")?.lead_agent_id, None);
        assert!(ctx.room("project-chat")?.facilitator_id.is_none());
        assert!(work::start(
            ctx,
            "missing-choice".into(),
            "project-chat".into(),
            "".into(),
            "Help".into(),
            false,
            None,
            None
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn roadmap_standalone_groups_are_retired_and_project_chats_allow_no_coordinator() {
    fixture(&store(), |ctx| {
        // A group without a project cannot be created through any path.
        assert!(ctx
            .create_room(
                "loose",
                "Loose group",
                "group",
                participants(ctx.profiles, &["lead".into(), "researcher".into()], None)?,
                None,
                None,
            )
            .is_err());
        project(ctx, "project", "project-chat")?;
        let team = ctx.project_team("project")?;
        commands::apply(
            ctx,
            Command::UpdateTeam {
                project_id: "project".into(),
                expected_revision: team.revision,
                lead_agent_id: None,
                participant_ids: vec!["lead".into(), "researcher".into()],
                share_history: true,
            },
        )?;
        // A coordinator-less Project Team still accepts side Chats, and the
        // submitter chooses the exact responder with no automatic fan-out.
        commands::apply(
            ctx,
            Command::CreateConversation {
                id: "side".into(),
                title: "Focused review".into(),
                kind: "group".into(),
                participant_ids: vec!["researcher".into()],
                facilitator_id: None,
                project_id: Some("project".into()),
            },
        )?;
        assert!(ctx.room("side")?.facilitator_id.is_none());
        work::start(
            ctx,
            "work-side".into(),
            "side".into(),
            "researcher".into(),
            "Review this.".into(),
            false,
            None,
            None,
        )?;
        assert_eq!(ctx.item("work-side")?.agent_id, "researcher");
        assert!(work::start(
            ctx,
            "work-blank".into(),
            "side".into(),
            String::new(),
            "No responder".into(),
            false,
            None,
            None,
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn roadmap_delegation_excludes_later_chat_and_steering_fences_children() {
    fixture(&store(), |ctx| {
        group(ctx, "room")?;
        output(ctx, "room", "earlier", "CAPTURED_HISTORY")?;
        work::start(
            ctx,
            "root".into(),
            "room".into(),
            "lead".into(),
            "Request".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "run")?;
        output(ctx, "room", "unrelated", "LATER_UNRELATED_CANARY")?;
        work::agent_command(
            ctx,
            "root",
            1,
            "run",
            "delegate",
            delegate("researcher", "Research"),
        )?;
        let child = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.parent_id.as_deref() == Some("root"))
            .unwrap();
        let capture = child.captured_context.as_ref().unwrap();
        assert!(capture.text.contains("CAPTURED_HISTORY"));
        assert!(!capture.text.contains("LATER_UNRELATED_CANARY"));
        commands::apply(
            ctx,
            Command::SteerWork {
                id: "root".into(),
                expected_generation: 1,
                event_id: "change".into(),
                text: "Narrow the request".into(),
            },
        )?;
        assert_eq!(ctx.item(&child.id)?.status, WorkStatus::AwaitingUser);
        assert!(work::current(ctx, &child.id, child.generation, None).is_err());
        Ok(())
    });
}

#[test]
fn roadmap_additive_payloads_preserve_old_work_without_guessing_context() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "old".into(),
            room.id,
            "lead".into(),
            "Retain request".into(),
            false,
            None,
            None,
        )?;
        let mut legacy = serde_json::to_value(ctx.item("old")?).unwrap();
        legacy.as_object_mut().unwrap().remove("capturedContext");
        legacy.as_object_mut().unwrap().remove("steering");
        legacy.as_object_mut().unwrap().remove("attachments");
        legacy.as_object_mut().unwrap().remove("origin");
        let restored: Work = serde_json::from_value(legacy).unwrap();
        assert!(restored.captured_context.is_none());
        assert!(restored.steering.is_empty());
        assert!(restored.attachments.is_empty());
        assert!(restored.origin.is_none());
        assert_eq!(restored.user_request, "Retain request");
        Ok(())
    });
}

#[test]
fn roadmap_work_attachment_refs_are_bounded_and_refreshed_at_bind() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        let preview = vec![
            WorkAttachment {
                id: "upload".into(),
                name: "brief.txt".into(),
                mime_type: "text/plain".into(),
                size_bytes: 128,
                availability: "transient".into(),
                relative_path: None,
                source_id: None,
                sha256: None,
            },
            WorkAttachment {
                id: "source".into(),
                name: "catalog.pdf".into(),
                mime_type: "application/pdf".into(),
                size_bytes: 2048,
                availability: "knowledge-context".into(),
                relative_path: None,
                source_id: Some("knowledge-1".into()),
                sha256: None,
            },
        ];
        commands::apply(
            ctx,
            Command::StartWork {
                id: "attach".into(),
                conversation_id: room.id.clone(),
                agent_id: "lead".into(),
                prompt: "Read the brief".into(),
                discussion: false,
                recipient_ids: None,
                attachments: Some(preview.clone()),
            },
        )?;
        let item = ctx.item("attach")?;
        assert_eq!(item.attachments, preview);
        assert!(item.origin.is_none());
        let staged = vec![staged_attachment("upload", "Attachments/batch-1/brief.txt")];
        journal(ctx, &room.id, "run", "queued", "")?;
        commands::apply(
            ctx,
            Command::BindWork {
                id: "attach".into(),
                generation: 1,
                run_id: "run".into(),
                attachments: Some(staged.clone()),
            },
        )?;
        assert_eq!(ctx.item("attach")?.attachments, staged);
        assert_eq!(ctx.item("attach")?.current_run_id.as_deref(), Some("run"));
        // A repeated bind is idempotent and never rewrites the dispatched inputs.
        let replacement = vec![staged_attachment(
            "upload",
            "Attachments/batch-2/replacement.txt",
        )];
        commands::apply(
            ctx,
            Command::BindWork {
                id: "attach".into(),
                generation: 1,
                run_id: "run".into(),
                attachments: Some(replacement),
            },
        )?;
        assert_eq!(ctx.item("attach")?.attachments, staged);
        // A stale generation cannot reach the dispatched request at all.
        let stale = vec![staged_attachment("upload", "Attachments/batch-3/stale.txt")];
        assert!(commands::apply(
            ctx,
            Command::BindWork {
                id: "attach".into(),
                generation: 99,
                run_id: "run".into(),
                attachments: Some(stale),
            },
        )
        .is_err());
        assert_eq!(ctx.item("attach")?.attachments, staged);
        let mut unsafe_path = staged_attachment("upload", "Attachments/batch-1/brief.txt");
        unsafe_path.relative_path = Some("../outside.txt".into());
        assert!(work::validate_attachments(&[unsafe_path]).is_err());
        let mut missing_hash = staged_attachment("upload", "Attachments/batch-1/brief.txt");
        missing_hash.sha256 = None;
        assert!(work::validate_attachments(&[missing_hash]).is_err());
        let mut bad_hash = staged_attachment("upload", "Attachments/batch-1/brief.txt");
        bad_hash.sha256 = Some("not-a-hash".into());
        assert!(work::validate_attachments(&[bad_hash]).is_err());
        let mut in_memory_with_ref = preview[0].clone();
        in_memory_with_ref.relative_path = Some("Attachments/batch-1/brief.txt".into());
        assert!(work::validate_attachments(&[in_memory_with_ref]).is_err());
        let mut unknown_kind = preview[1].clone();
        unknown_kind.availability = "cloud".into();
        assert!(work::validate_attachments(&[unknown_kind]).is_err());
        assert!(work::validate_attachments(&vec![preview[0].clone(); 13]).is_err());
        Ok(())
    });
}

#[test]
fn roadmap_repeated_selection_resolves_one_persistent_main_chat_per_agent() {
    fixture(&store(), |ctx| {
        let first = chats::open_main(ctx, "lead")?;
        let again = chats::open_main(ctx, "lead")?;
        assert_eq!(first.id, again.id);
        assert_eq!(
            first.chat.as_ref().map(|chat| chat.role.as_str()),
            Some("main")
        );
        assert_eq!(
            first.chat.as_ref().map(|chat| chat.owner_id.as_str()),
            Some("lead")
        );
        let other = chats::open_main(ctx, "researcher")?;
        assert_ne!(first.id, other.id);
        let mains = repo::list::<Conversation>(
            ctx.conn,
            ctx.store,
            &ctx.scope.private,
            Kind::Conversation,
        )?
        .into_iter()
        .filter(|room| {
            room.chat
                .as_ref()
                .is_some_and(|chat| chat.role == "main" && chat.owner_kind == "agent")
        })
        .count();
        assert_eq!(mains, 2);
        let reopened = chats::open_main(ctx, "lead")?;
        assert_eq!(reopened.revision, first.revision);
        assert_eq!(
            thread::list(ctx.conn, ctx.store, &ctx.scope.data)?
                .into_iter()
                .filter(|row| row.id == first.id || row.id == other.id)
                .count(),
            2,
            "repeated selection must never create a duplicate main Chat"
        );
        Ok(())
    });
}

#[test]
fn roadmap_staged_attachment_verification_requires_exact_existing_bytes() {
    use std::path::PathBuf;
    let root = std::env::temp_dir().join(format!(
        "mivlet-work-attachments-{}-{}",
        std::process::id(),
        TIME.replace([':', '.', '-'], "")
    ));
    let state = crate::local_computer::LocalComputerState::for_test(root.clone());
    let key = hex::encode(Sha256::digest(b"fable-local-computer-v1\0workspace\0lead"));
    let workspace = root.join(&key[..32]).join("workspace");
    let staged_path: PathBuf = workspace.join("Attachments/batch-1/brief.txt");
    std::fs::create_dir_all(staged_path.parent().unwrap()).unwrap();
    let bytes = b"exact staged bytes";
    std::fs::write(&staged_path, bytes).unwrap();
    let hash = hex::encode(Sha256::digest(bytes));
    let verified = vec![staged_attachment_with_hash(
        "upload",
        "Attachments/batch-1/brief.txt",
        bytes.len() as u64,
        &hash,
    )];
    assert!(work::verify_attachment_files(Some(&state), "workspace", "lead", &verified).is_ok());
    // In-memory refs are not file claims and never block verification.
    let memory_only = vec![WorkAttachment {
        id: "photo".into(),
        name: "photo.png".into(),
        mime_type: "image/png".into(),
        size_bytes: 2048,
        availability: "image-input".into(),
        relative_path: None,
        source_id: None,
        sha256: None,
    }];
    assert!(work::verify_attachment_files(Some(&state), "workspace", "lead", &memory_only).is_ok());
    // Wrong recorded size fails closed.
    let wrong_size = vec![staged_attachment_with_hash(
        "upload",
        "Attachments/batch-1/brief.txt",
        bytes.len() as u64 + 1,
        &hash,
    )];
    let error = work::verify_attachment_files(Some(&state), "workspace", "lead", &wrong_size)
        .unwrap_err()
        .to_string();
    assert!(error.contains("changed since it was attached"), "{error}");
    // Changed content fails closed even when the size matches.
    std::fs::write(&staged_path, b"tampered staged bytes").unwrap();
    let error = work::verify_attachment_files(Some(&state), "workspace", "lead", &verified)
        .unwrap_err()
        .to_string();
    assert!(error.contains("changed since it was attached"), "{error}");
    // Missing staged files name the exact reattach prerequisite.
    std::fs::remove_file(&staged_path).unwrap();
    let error = work::verify_attachment_files(Some(&state), "workspace", "lead", &verified)
        .unwrap_err()
        .to_string();
    assert!(error.contains("no longer available"), "{error}");
    assert!(error.contains("Reattach it before continuing."), "{error}");
    // A different agent's workspace never satisfies the same relative path.
    let other_key = hex::encode(Sha256::digest(
        b"fable-local-computer-v1\0workspace\0researcher",
    ));
    let other = root.join(&other_key[..32]).join("workspace");
    std::fs::create_dir_all(other.join("Attachments/batch-1")).unwrap();
    std::fs::write(other.join("Attachments/batch-1/brief.txt"), bytes).unwrap();
    assert!(
        work::verify_attachment_files(Some(&state), "workspace", "lead", &verified).is_err(),
        "another agent's workspace does not satisfy this request"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn roadmap_attachment_refs_survive_restart_review_without_replay() {
    let store = store();
    let refs = vec![staged_attachment("upload", "Attachments/batch-1/brief.txt")];
    fixture(&store, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        commands::apply(
            ctx,
            Command::StartWork {
                id: "recover".into(),
                conversation_id: room.id.clone(),
                agent_id: "lead".into(),
                prompt: "Read the brief".into(),
                discussion: false,
                recipient_ids: None,
                attachments: Some(refs.clone()),
            },
        )?;
        journal(ctx, &room.id, "run", "queued", "")?;
        commands::apply(
            ctx,
            Command::BindWork {
                id: "recover".into(),
                generation: 1,
                run_id: "run".into(),
                attachments: Some(refs.clone()),
            },
        )?;
        Ok(())
    });
    // Restart recovery opens its own transaction; never call it while holding
    // the fixture transaction and its non-reentrant Store mutex.
    recover(&store).unwrap();
    fixture(&store, |ctx| {
        let item = ctx.item("recover")?;
        assert_eq!(item.status, WorkStatus::AwaitingUser);
        assert_eq!(item.generation, 2);
        assert_eq!(item.attachments, refs);
        assert!(commands::apply(
            ctx,
            Command::ContinueWork {
                id: "recover".into(),
                expected_generation: 2,
                reconcile: false,
            },
        )
        .is_err());
        commands::apply(
            ctx,
            Command::ContinueWork {
                id: "recover".into(),
                expected_generation: 2,
                reconcile: true,
            },
        )?;
        assert_eq!(ctx.item("recover")?.status, WorkStatus::Queued);
        assert_eq!(ctx.item("recover")?.attachments, refs);
        Ok(())
    });
}

#[test]
fn roadmap_schedule_work_carries_schedule_origin_and_inherits_it_on_delegation() {
    fixture(&store(), |ctx| {
        project(ctx, "project", "project-chat")?;
        let room = ctx.room("project-chat")?;
        let payload = json!({"id":"scheduled-run","providerId":"openai","model":"fixture-model","status":"queued","transcript":"","threadId":room.id,"exchanges":[{"role":"user","content":"Scheduled brief"}],"turn":1,"usage":{"inputTokens":100,"outputTokens":100,"costUsd":0.0},"pendingApprovalIds":[],"recoverable":true,"retryCount":0,"createdAt":TIME,"updatedAt":TIME});
        execution_attempt::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            "scheduled-run",
            Some(&room.id),
            "openai",
            "fixture-model",
            "queued",
            1,
            true,
            0,
            TIME,
            TIME,
            &payload,
        )?;
        bind_schedule(
            ctx.conn,
            ctx.store,
            ctx.scope,
            ctx.profiles,
            "project",
            "lead",
            "scheduled-run",
            TIME,
        )?;
        let item = ctx.item("work-scheduled-run")?;
        assert_eq!(item.origin.as_deref(), Some("schedule"));
        assert_eq!(item.permission_mode, "read-only");
        work::agent_command(
            ctx,
            "work-scheduled-run",
            1,
            "scheduled-run",
            "delegate",
            delegate("researcher", "Dig deeper"),
        )?;
        let child = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.parent_id.as_deref() == Some("work-scheduled-run"))
            .unwrap();
        assert_eq!(child.origin.as_deref(), Some("schedule"));
        Ok(())
    });
}

#[test]
fn roadmap_side_chat_lifecycle_preserves_transcript_drafts_and_guards_main() {
    fixture(&store(), |ctx| {
        let main = chats::open_main(ctx, "lead")?;
        let side = ctx.create_room(
            "side",
            "Separate question",
            "direct",
            vec![Participant {
                agent_id: "lead".into(),
                name: "lead".into(),
            }],
            Some("lead".into()),
            None,
        )?;
        assert_eq!(
            side.chat.as_ref().map(|chat| chat.role.as_str()),
            Some("side")
        );
        output(ctx, &side.id, "side-run", "Side transcript")?;
        draft::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            Some(&side.id),
            "composer",
            &json!({"text":"keep me"}),
            TIME,
        )?;

        commands::apply(
            ctx,
            Command::RenameConversation {
                id: side.id.clone(),
                expected_revision: side.revision,
                title: "Renamed Side Chat".into(),
            },
        )?;
        let renamed = ctx.room(&side.id)?;
        assert_eq!(renamed.title, "Renamed Side Chat");
        assert_eq!(renamed.revision, side.revision + 1);
        assert_eq!(
            thread::get(ctx.conn, ctx.store, &ctx.scope.data, &side.id)?
                .unwrap()
                .title,
            "Renamed Side Chat"
        );
        assert_eq!(
            message::list(ctx.conn, ctx.store, &ctx.scope.data, &side.id)?.len(),
            1,
            "renaming a Side Chat cannot touch its transcript"
        );

        commands::apply(
            ctx,
            Command::SetConversationArchived {
                id: side.id.clone(),
                expected_revision: renamed.revision,
                archived: true,
            },
        )?;
        let archived = ctx.room(&side.id)?;
        assert!(archived.archived);
        assert_eq!(
            thread::get(ctx.conn, ctx.store, &ctx.scope.data, &side.id)?
                .unwrap()
                .lifecycle,
            "archived"
        );
        assert_eq!(
            message::list(ctx.conn, ctx.store, &ctx.scope.data, &side.id)?.len(),
            1
        );
        assert!(
            draft::get_scoped(
                ctx.conn,
                ctx.store,
                &ctx.scope.data,
                Some(&side.id),
                "composer"
            )?
            .is_some(),
            "archiving keeps the conversation-owned draft"
        );

        for command in [
            Command::RenameConversation {
                id: main.id.clone(),
                expected_revision: main.revision,
                title: "Not allowed".into(),
            },
            Command::SetConversationArchived {
                id: main.id.clone(),
                expected_revision: main.revision,
                archived: true,
            },
            Command::DeleteConversation {
                id: main.id.clone(),
                expected_revision: main.revision,
            },
        ] {
            assert!(
                commands::apply(ctx, command).is_err(),
                "the persistent main Chat cannot be renamed, archived or deleted"
            );
        }

        let archived_revision = archived.revision;
        work::start(
            ctx,
            "side-work".into(),
            side.id.clone(),
            "lead".into(),
            "Do a thing".into(),
            false,
            None,
            None,
        )?;
        assert!(commands::apply(
            ctx,
            Command::SetConversationArchived {
                id: side.id.clone(),
                expected_revision: archived_revision,
                archived: true,
            }
        )
        .is_err());
        assert!(commands::apply(
            ctx,
            Command::DeleteConversation {
                id: side.id.clone(),
                expected_revision: archived_revision,
            }
        )
        .is_err());

        commands::apply(
            ctx,
            Command::SetConversationArchived {
                id: side.id.clone(),
                expected_revision: archived_revision,
                archived: false,
            },
        )?;
        let restored = ctx.room(&side.id)?;
        assert!(!restored.archived);
        assert_eq!(
            thread::get(ctx.conn, ctx.store, &ctx.scope.data, &side.id)?
                .unwrap()
                .lifecycle,
            "active"
        );
        Ok(())
    });
}

#[test]
fn roadmap_side_chat_delete_is_explicit_and_keeps_durable_evidence() {
    fixture(&store(), |ctx| {
        let main = chats::open_main(ctx, "lead")?;
        let doomed = ctx.create_room(
            "doomed",
            "Throwaway",
            "direct",
            vec![Participant {
                agent_id: "lead".into(),
                name: "lead".into(),
            }],
            Some("lead".into()),
            None,
        )?;
        let kept = ctx.create_room(
            "kept",
            "Keep me",
            "direct",
            vec![Participant {
                agent_id: "lead".into(),
                name: "lead".into(),
            }],
            Some("lead".into()),
            None,
        )?;
        output(ctx, &doomed.id, "doomed-run", "Goodbye")?;
        draft::upsert_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            Some(&doomed.id),
            "composer",
            &json!({"text":"discard with the chat"}),
            TIME,
        )?;
        commands::apply(
            ctx,
            Command::DeleteConversation {
                id: doomed.id.clone(),
                expected_revision: doomed.revision,
            },
        )?;
        assert!(ctx.room(&doomed.id).is_err());
        assert!(thread::get(ctx.conn, ctx.store, &ctx.scope.data, &doomed.id)?.is_none());
        assert!(draft::get_scoped(
            ctx.conn,
            ctx.store,
            &ctx.scope.data,
            Some(&doomed.id),
            "composer"
        )?
        .is_none());
        assert_eq!(ctx.room(&main.id)?.chat.as_ref().unwrap().role, "main");
        assert_eq!(ctx.room(&kept.id)?.title, "Keep me");
        assert!(
            ctx.create_room(
                "doomed",
                "Recreated",
                "direct",
                vec![Participant {
                    agent_id: "lead".into(),
                    name: "lead".into(),
                }],
                Some("lead".into()),
                None
            )
            .is_err(),
            "a deleted Side Chat stays tombstoned"
        );

        project(ctx, "project", "project-chat")?;
        let recorded = ctx.create_room(
            "recorded",
            "Decision log",
            "direct",
            vec![Participant {
                agent_id: "lead".into(),
                name: "lead".into(),
            }],
            Some("lead".into()),
            Some("project".into()),
        )?;
        commands::apply(
            ctx,
            Command::SaveFact {
                project_id: "project".into(),
                conversation_id: recorded.id.clone(),
                id: "decision".into(),
                kind: "decision".into(),
                text: "Use the two week deadline".into(),
                source: "Fixture decision".into(),
                supersedes_id: None,
            },
        )?;
        assert!(commands::apply(
            ctx,
            Command::DeleteConversation {
                id: recorded.id.clone(),
                expected_revision: recorded.revision,
            }
        )
        .is_err());
        commands::apply(
            ctx,
            Command::ChangeFact {
                project_id: "project".into(),
                id: "decision".into(),
                status: "forgotten".into(),
            },
        )?;
        commands::apply(
            ctx,
            Command::DeleteConversation {
                id: recorded.id.clone(),
                expected_revision: recorded.revision,
            },
        )?;
        Ok(())
    });
}

#[test]
fn roadmap_legacy_positive_agent_links_adopt_as_side_and_never_as_main() {
    let store = store();
    let mut members = profiles();
    members[0].thread_id = Some("legacy-linked".into());
    members[1].thread_ids = vec!["legacy-ambiguous".into()];
    members[2].thread_ids = vec!["legacy-ambiguous".into()];
    fixture_with_profiles(&store, members, |ctx| {
        for key in ["legacy-linked", "legacy-ambiguous"] {
            thread::create(
                ctx.conn,
                ctx.store,
                &ctx.scope.data,
                key,
                None,
                "Legacy conversation",
                TIME,
                &json!({"authorityScope":{"authority":"local","visibility":"member-private"}}),
            )?;
            ctx.conn.execute(
                "UPDATE thread SET owner_member_id=?1 WHERE workspace_id=?2 AND id=?3",
                rusqlite::params![
                    ctx.scope.private.owner_member_id(),
                    ctx.scope.data.workspace_id(),
                    key
                ],
            )?;
            message::append(
                ctx.conn,
                ctx.store,
                &ctx.scope.data,
                key,
                &format!("legacy-message-{key}"),
                "user",
                &json!({"kind":"user"}),
                None,
                1,
                0,
                None,
                &format!("legacy:{key}"),
                &format!("legacy-revision-{key}"),
                "terminal",
                "fixture",
                &json!({"text":"Legacy content that must survive"}),
                TIME,
            )?;
        }
        ctx.conn.execute_batch("DROP TABLE collaboration_record")?;
        crate::store::migrations::apply(ctx.conn, 41, 42)?;
        adopt_existing(ctx)?;
        adopt_existing(ctx)?;
        let linked = ctx.room("legacy-linked")?;
        assert_eq!(
            linked.chat.as_ref().map(|chat| (
                chat.role.as_str(),
                chat.owner_kind.as_str(),
                chat.owner_id.as_str()
            )),
            Some(("side", "agent", "lead")),
            "a single positive profile link is a Side Chat, never a guessed main Chat"
        );
        assert!(
            ctx.room("legacy-ambiguous")?.chat.is_none(),
            "zero or multiple profile links stay unclassified"
        );
        assert_eq!(ctx.snapshot()?.conversations.len(), 2);
        assert!(ctx
            .snapshot()?
            .conversations
            .iter()
            .all(|room| room.chat.as_ref().is_none_or(|chat| chat.role != "main")));
        assert_eq!(
            message::list(ctx.conn, ctx.store, &ctx.scope.data, "legacy-linked")?.len(),
            1
        );
        let main = chats::open_main(ctx, "lead")?;
        assert_ne!(main.id, "legacy-linked");
        assert_eq!(main.chat.as_ref().unwrap().role, "main");
        assert_eq!(ctx.snapshot()?.conversations.len(), 3);
        Ok(())
    });
}

#[test]
fn roadmap_older_conversation_payloads_default_archived_false() {
    let value = json!({
        "id":"legacy",
        "workspaceId":"default",
        "kind":"direct",
        "title":"Legacy",
        "participants":[],
        "revision":1,
        "generation":1,
        "createdAt":TIME,
        "updatedAt":TIME
    });
    let room: Conversation = serde_json::from_value(value).unwrap();
    assert!(!room.archived);
    assert!(room.chat.is_none());
}

#[test]
fn roadmap_second_account_cannot_resolve_or_mutate_chats() {
    let store = store();
    let data = DataScope::workspace(crate::store::repos::scope::DEFAULT_WORKSPACE_ID).unwrap();
    let alpha = account_scope(&data, "user-a", "member-a");
    let beta = account_scope(&data, "user-b", "member-b");
    let (main_id, side_id) = store
        .transaction(|conn| {
            let profiles = profiles();
            let ctx = Context {
                conn,
                store: &store,
                scope: &alpha,
                profiles: &profiles,
                time: TIME,
            };
            let main = chats::open_main(&ctx, "lead")?;
            let side = ctx.create_room(
                "side",
                "Private side",
                "direct",
                vec![Participant {
                    agent_id: "lead".into(),
                    name: "lead".into(),
                }],
                Some("lead".into()),
                None,
            )?;
            Ok((main.id, side.id))
        })
        .unwrap();
    store
        .with_conn(|conn| {
            let profiles = profiles();
            let ctx = Context {
                conn,
                store: &store,
                scope: &beta,
                profiles: &profiles,
                time: TIME,
            };
            assert!(ctx.room(&main_id).is_err());
            assert!(
                repo::list::<Conversation>(conn, &store, &beta.private, Kind::Conversation)?
                    .is_empty()
            );
            assert!(chats::rename(&ctx, &side_id, 1, "Stolen").is_err());
            assert!(chats::set_archived(&ctx, &side_id, 1, true).is_err());
            assert!(chats::delete(&ctx, &side_id, 1).is_err());
            Ok(())
        })
        .unwrap();
    store
        .with_conn(|conn| {
            let profiles = profiles();
            let ctx = Context {
                conn,
                store: &store,
                scope: &alpha,
                profiles: &profiles,
                time: TIME,
            };
            assert_eq!(ctx.room(&side_id)?.title, "Private side");
            assert!(!ctx.room(&side_id)?.archived);
            assert_eq!(ctx.room(&main_id)?.chat.as_ref().unwrap().role, "main");
            Ok(())
        })
        .unwrap();
}

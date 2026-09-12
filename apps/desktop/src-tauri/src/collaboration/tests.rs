//! Deterministic storage/coordination fixtures. No live provider is simulated as
//! successful product evidence; fixture attempts are explicitly authored here.
use super::*;
use crate::store::repos::{execution_attempt, message};
use crate::store::vault::{MasterKey, Vault};
use serde_json::json;

const TIME: &str = "2026-09-12T10:00:00.000Z";

fn store() -> Store {
    Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
}
fn profiles() -> Vec<FableAgentProfile> {
    ["lead", "researcher", "reviewer"].iter().map(|id| serde_json::from_value(json!({"id":id,"name":id,"instructions":"Fixture teammate","modelId":"openai::fixture-model","icon":"sparkle","permissionLabel":"Ask Me"})).unwrap()).collect()
}
fn fixture<T>(store: &Store, f: impl FnOnce(&Context<'_>) -> Result<T>) -> T {
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            let profiles = profiles();
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
fn group(ctx: &Context<'_>, key: &str) -> Result<Conversation> {
    ctx.create_room(
        key,
        "Fixture group",
        "group",
        participants(
            ctx.profiles,
            &["lead".into(), "researcher".into(), "reviewer".into()],
            "lead",
        )?,
        Some("lead".into()),
        None,
    )
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
    work::bind(ctx, key, work.generation, run)
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
fn project(ctx: &Context<'_>, project: &str, conversation: &str) -> Result<()> {
    group(ctx, conversation)?;
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
    let mut room = ctx.room(conversation)?;
    room.project_id = Some(project.into());
    ctx.conversation(&room)
}

#[test]
fn collaboration_direct_histories_have_distinct_identity_and_private_dispatch_fails() {
    fixture(&store(), |ctx| {
        for key in ["private-one", "private-two"] {
            ctx.create_room(
                key,
                key,
                "direct",
                participants(ctx.profiles, &["lead".into()], "lead")?,
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
        .is_err());
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
        )?;
        work::start(
            ctx,
            "other".into(),
            "unrelated".into(),
            "reviewer".into(),
            "Separate request".into(),
            false,
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
        commands::apply(ctx, Command::StopWork { id: "root".into() })?;
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
        )?;
        work::start(
            ctx,
            "unrelated".into(),
            "private".into(),
            "researcher".into(),
            "Private request".into(),
            false,
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
        )?;
        bind(ctx, "root", "run")?;
        commands::apply(
            ctx,
            Command::UpdateTeam {
                project_id: "project".into(),
                expected_revision: 1,
                lead_agent_id: "reviewer".into(),
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
            false
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
            participants(ctx.profiles, &["lead".into()], "lead")?,
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
            version: 1,
            views: vec![],
            panes: [vec![], vec![]],
            active: [None, None],
            active_pane: 0,
            split: false,
            ratio: 0.5,
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

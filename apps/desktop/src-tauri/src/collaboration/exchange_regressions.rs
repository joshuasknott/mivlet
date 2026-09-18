//! Regression coverage for task-scoped agent exchanges.
//!
//! This is a child of the collaboration fixture module, so its helpers remain
//! private to the test harness and no production surface is widened.
use super::*;

#[test]
fn ordinary_direct_exchange_routes_question_answer_and_fresh_synthesis_turns() {
    fixture(&store(), |ctx| {
        let room = ctx.create_room(
            "ordinary",
            "Ordinary conversation",
            "direct",
            participants(ctx.profiles, &["lead".into()], Some("lead"))?,
            Some("lead".into()),
            None,
        )?;
        work::start(
            ctx,
            "root".into(),
            room.id.clone(),
            "lead".into(),
            "Review this implementation".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "lead-one")?;
        work::agent_command(
            ctx,
            "root",
            1,
            "lead-one",
            "delegate-researcher",
            delegate("researcher", "Check the error path"),
        )?;
        let child = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.parent_id.as_deref() == Some("root"))
            .expect("delegated worker");
        let child_id = child.id.clone();
        complete(
            ctx,
            "root",
            "lead-one",
            "Researcher is checking the error path.",
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Waiting);

        // The worker asks the lead while the lead is waiting on the worker.
        // This must queue a lead turn without adding a reverse dependency.
        bind(ctx, &child_id, "worker-one")?;
        work::agent_command(
            ctx,
            &child_id,
            1,
            "worker-one",
            "worker-question",
            AgentCommand::Message {
                assignment_id: "root".into(),
                message: "Which compatibility target should I check?".into(),
                question: true,
            },
        )?;
        let root_after_question = ctx.item("root")?;
        assert_eq!(root_after_question.status, WorkStatus::Queued);
        assert_eq!(root_after_question.waiting_for, vec![child_id.clone()]);
        assert!(root_after_question.steering.is_empty());
        assert_eq!(root_after_question.messages.len(), 1);

        // The lead answers in a distinct provider attempt. The worker remains
        // live while that answer is recorded, then receives a fresh turn.
        bind(ctx, "root", "lead-two")?;
        work::agent_command(
            ctx,
            "root",
            2,
            "lead-two",
            "lead-answer",
            AgentCommand::Message {
                assignment_id: child_id.clone(),
                message: "Check the v2 compatibility target.".into(),
                question: false,
            },
        )?;
        assert_eq!(ctx.item(&child_id)?.status, WorkStatus::Running);
        complete(
            ctx,
            "root",
            "lead-two",
            "The worker has the compatibility target.",
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Waiting);

        complete(
            ctx,
            &child_id,
            "worker-one",
            "I received the compatibility target and need a fresh turn.",
        )?;
        assert_eq!(ctx.item(&child_id)?.status, WorkStatus::Queued);
        bind(ctx, &child_id, "worker-two")?;
        assert_eq!(ctx.item(&child_id)?.messages.len(), 1);
        complete(
            ctx,
            &child_id,
            "worker-two",
            "The v2 compatibility path is safe.",
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Queued);

        bind(ctx, "root", "lead-three")?;
        complete(
            ctx,
            "root",
            "lead-three",
            "Synthesis: ship the v2 compatibility path.",
        )?;
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::Completed);
        assert_eq!(root.run_ids, vec!["lead-one", "lead-two", "lead-three"]);
        assert_eq!(
            ctx.item(&child_id)?.run_ids,
            vec!["worker-one", "worker-two"]
        );
        assert!(!ctx
            .all_work()?
            .iter()
            .any(|item| item.status == WorkStatus::Cancelled));
        assert!(root.steering.is_empty());
        Ok(())
    });
}

#[test]
fn failed_or_awaiting_user_targets_and_late_messages_require_reconciliation() {
    fixture(&store(), |ctx| {
        let room = ctx.create_room(
            "recovery-room",
            "Recovery conversation",
            "direct",
            participants(ctx.profiles, &["lead".into()], Some("lead"))?,
            Some("lead".into()),
            None,
        )?;
        work::start(
            ctx,
            "root".into(),
            room.id.clone(),
            "lead".into(),
            "Recover delegated work".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "root-run")?;
        work::agent_command(
            ctx,
            "root",
            1,
            "root-run",
            "delegate-recovery",
            delegate("researcher", "Inspect the failing path"),
        )?;
        let child_id = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.id != "root")
            .expect("delegated child")
            .id;
        bind(ctx, &child_id, "child-run")?;
        journal(ctx, &room.id, "child-run", "failed", "Provider failed")?;
        work::finish(
            ctx,
            &child_id,
            1,
            "child-run",
            WorkStatus::Failed,
            Some("Provider failed".into()),
        )?;
        assert!(work::agent_command(
            ctx,
            "root",
            1,
            "root-run",
            "message-failed",
            AgentCommand::Message {
                assignment_id: child_id.clone(),
                message: "Retry this failed assignment".into(),
                question: true,
            },
        )
        .is_err());

        // A user-blocked assignment also cannot be revived by an agent message.
        work::agent_command(
            ctx,
            "root",
            1,
            "root-run",
            "delegate-awaiting",
            delegate("reviewer", "Ask the user"),
        )?;
        let awaiting_id = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.agent_id == "reviewer")
            .expect("awaiting child")
            .id;
        bind(ctx, &awaiting_id, "awaiting-run")?;
        output(ctx, &room.id, "awaiting-run", "Needs user")?;
        work::finish(
            ctx,
            &awaiting_id,
            1,
            "awaiting-run",
            WorkStatus::AwaitingUser,
            Some("Need a user decision".into()),
        )?;
        assert!(work::agent_command(
            ctx,
            "root",
            1,
            "root-run",
            "message-awaiting",
            AgentCommand::Message {
                assignment_id: awaiting_id,
                message: "Ignore the user decision".into(),
                question: false,
            },
        )
        .is_err());

        commands::apply(
            ctx,
            Command::StopWork {
                id: "root".into(),
                expected_generation: Some(1),
            },
        )?;
        assert!(work::agent_command(
            ctx,
            "root",
            1,
            "root-run",
            "late-message",
            AgentCommand::Message {
                assignment_id: child_id.clone(),
                message: "Late result".into(),
                question: false,
            },
        )
        .is_err());
        assert!(ctx.item(&child_id)?.messages.is_empty());
        Ok(())
    });
}

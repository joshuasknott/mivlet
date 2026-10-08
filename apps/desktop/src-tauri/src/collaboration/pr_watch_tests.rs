use super::*;
use crate::collaboration::pr_watches::deliver;
#[test]
fn pr_watch_queues_fresh_work_once_and_keeps_existing_limits_and_authority() {
    let database = store();
    fixture(&database, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "pr-work".into(),
            room.id,
            "lead".into(),
            "Review my PR".into(),
            false,
            None,
            None,
        )?;
        let mut item = ctx.item("pr-work")?;
        item.status = WorkStatus::Completed;
        ctx.work(&item)?;
        let generation = deliver(
            ctx,
            "lead",
            &item.id,
            item.generation,
            Some(("pr-event-1", "Checks failed; inspect the PR.")),
        )?;
        let queued = ctx.item(&item.id)?;
        assert_eq!(queued.status, WorkStatus::Queued);
        assert_eq!(queued.max_turns, item.max_turns);
        assert_eq!(queued.max_tokens, item.max_tokens);
        assert_eq!(queued.permission_mode, item.permission_mode);
        assert_eq!(queued.messages.len(), 1);
        assert!(queued.current_run_id.is_none());
        assert_eq!(generation, item.generation + 1);
        // A crash after native admission but before journal acknowledgement.
        assert_eq!(
            deliver(
                ctx,
                "lead",
                &item.id,
                item.generation,
                Some(("pr-event-1", "Checks failed; inspect the PR."))
            )?,
            generation
        );
        assert_eq!(ctx.item(&item.id)?.messages.len(), 1);
        assert!(deliver(ctx, "reviewer", &item.id, generation, None).is_err());
        commands::apply(
            ctx,
            Command::StopWork {
                id: item.id.clone(),
                expected_generation: None,
            },
        )?;
        assert!(deliver(
            ctx,
            "lead",
            &item.id,
            generation,
            Some(("pr-event-1", "Checks failed; inspect the PR."))
        )
        .is_err());
        assert!(deliver(
            ctx,
            "lead",
            &item.id,
            generation,
            Some(("pr-event-2", "Checks passed."))
        )
        .is_err());
        assert_eq!(ctx.item(&item.id)?.status, WorkStatus::Cancelled);
        Ok(())
    });
}
#[test]
fn pr_watch_does_not_bypass_approval_or_recovery_decisions() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "pr-work".into(),
            room.id,
            "lead".into(),
            "Review my PR".into(),
            false,
            None,
            None,
        )?;
        let mut item = ctx.item("pr-work")?;
        item.status = WorkStatus::AwaitingApproval;
        ctx.work(&item)?;
        let generation = deliver(
            ctx,
            "lead",
            &item.id,
            item.generation,
            Some(("pr-event-1", "A reviewer commented.")),
        )?;
        assert_eq!(generation, item.generation);
        assert_eq!(ctx.item(&item.id)?.status, WorkStatus::AwaitingApproval);
        item = ctx.item(&item.id)?;
        for status in [
            WorkStatus::AwaitingUser,
            WorkStatus::Blocked,
            WorkStatus::Failed,
        ] {
            item.status = status;
            ctx.work(&item)?;
            assert!(deliver(ctx, "lead", &item.id, generation, None).is_err());
        }
        Ok(())
    });
}

#[test]
fn pr_watch_stops_when_project_context_changes() {
    fixture(&store(), |ctx| {
        let room = project(ctx, "project", "project-chat")?;
        work::start(
            ctx,
            "pr-work".into(),
            room.id,
            "lead".into(),
            "Review PR".into(),
            false,
            None,
            None,
        )?;
        let item = ctx.item("pr-work")?;
        let mut team = ctx.project_team("project")?;
        team.revision += 1;
        ctx.team(&team)?;
        assert!(deliver(
            ctx,
            "lead",
            &item.id,
            item.generation,
            Some(("pr-event-1", "A reviewer commented."))
        )
        .is_err());
        assert!(ctx.item(&item.id)?.messages.is_empty());
        Ok(())
    });
}

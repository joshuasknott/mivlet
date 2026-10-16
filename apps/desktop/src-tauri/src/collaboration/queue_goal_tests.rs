use super::*;

fn request(ctx: &Context<'_>, key: &str, room: &str) -> Result<()> {
    work::start(
        ctx,
        key.into(),
        room.into(),
        "lead".into(),
        format!("Request {key}"),
        false,
        None,
        None,
    )
}

#[test]
fn queue_order_hold_and_edits_are_native_generation_fences() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "first", &room.id)?;
        request(ctx, "second", &room.id)?;
        assert!(bind(ctx, "second", "out-of-order").is_err());
        queue::hold(ctx, "first", 1, true)?;
        assert!(queue::edit(ctx, "first", 1, "stale edit").is_err());
        queue::edit(ctx, "first", 2, "Edited before dispatch")?;
        let edited = ctx.item("first")?;
        assert_eq!(edited.user_request, "Edited before dispatch");
        assert_eq!(edited.prompt, "Edited before dispatch");
        assert!(edited.queue.unwrap().held);
        assert!(bind(ctx, "first", "held-run").is_err());
        bind(ctx, "second", "second-run")?;
        assert!(queue::edit(ctx, "second", 1, "too late").is_err());
        complete(ctx, "second", "second-run", "Completed second")?;
        queue::hold(ctx, "first", 3, false)?;
        bind(ctx, "first", "first-run")?;
        assert!(work::bind(ctx, "first", 1, "stale-run", None).is_err());
        Ok(())
    });
}

#[test]
fn queue_move_is_scoped_and_controls_the_native_bind_order() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "first", &room.id)?;
        request(ctx, "second", &room.id)?;
        let other = ctx.create_room(
            "other-room",
            "Other",
            "direct",
            participants(ctx.profiles, &["lead".into()], None)?,
            None,
            None,
        )?;
        request(ctx, "outside", &other.id)?;
        assert!(queue::move_before(ctx, "first", 1, Some("outside")).is_err());
        queue::move_before(ctx, "second", 1, Some("first"))?;
        assert!(bind(ctx, "first", "wrong-order").is_err());
        bind(ctx, "second", "right-order")?;
        assert!(queue::move_before(ctx, "second", 1, Some("first")).is_err());
        Ok(())
    });
}

#[test]
fn only_provably_unstarted_new_queue_entries_survive_restart() {
    let store = store();
    fixture(&store, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "held", &room.id)?;
        queue::hold(ctx, "held", 1, true)?;
        request(ctx, "started", &room.id)?;
        bind(ctx, "started", "started-run")?;
        Ok(())
    });
    recover(&store).unwrap();
    fixture(&store, |ctx| {
        assert_eq!(ctx.item("held")?.status, WorkStatus::Queued);
        assert!(ctx.item("held")?.queue.unwrap().held);
        assert_eq!(ctx.item("held")?.generation, 2);
        assert_eq!(ctx.item("started")?.status, WorkStatus::AwaitingUser);
        assert_eq!(ctx.item("started")?.generation, 2);
        Ok(())
    });
}

#[test]
fn goal_reports_need_exact_run_and_saved_completed_output() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "goal", &room.id)?;
        goals::set(
            ctx,
            "goal",
            1,
            "Working calculator",
            "Tests pass and result is 4",
            3,
            32000,
        )?;
        bind(ctx, "goal", "goal-run")?;
        let report = AgentCommand::GoalReport {
            status: "completed".into(),
            text: "Check returned 4; one test passed".into(),
        };
        assert!(
            work::agent_command(ctx, "goal", 2, "wrong-run", "report", report.clone()).is_err()
        );
        work::agent_command(ctx, "goal", 2, "goal-run", "report", report)?;
        assert!(work::finish(ctx, "goal", 2, "goal-run", WorkStatus::Completed, None).is_err());
        assert_eq!(ctx.item("goal")?.outcome_goal.unwrap().status, "active");
        complete(
            ctx,
            "goal",
            "goal-run",
            "Calculator returns 4. Test passed.",
        )?;
        let saved = ctx.item("goal")?;
        assert_eq!(saved.status, WorkStatus::Completed);
        assert_eq!(saved.outcome_goal.unwrap().status, "completed");
        assert_eq!(saved.outputs.len(), 1);
        Ok(())
    });
}

#[test]
fn goals_pause_at_boundaries_and_stop_at_the_original_budget() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "goal", &room.id)?;
        goals::set(
            ctx,
            "goal",
            1,
            "Finish report",
            "Report has sources",
            2,
            32000,
        )?;
        bind(ctx, "goal", "first-run")?;
        goals::pause(ctx, "goal", 2, true)?;
        complete(ctx, "goal", "first-run", "First section drafted")?;
        assert_eq!(ctx.item("goal")?.status, WorkStatus::Queued);
        assert!(bind(ctx, "goal", "paused-run").is_err());
        goals::pause(ctx, "goal", 2, false)?;
        bind(ctx, "goal", "last-run")?;
        complete(ctx, "goal", "last-run", "Still missing a source")?;
        let saved = ctx.item("goal")?;
        assert_eq!(saved.status, WorkStatus::AwaitingUser);
        assert_eq!(saved.outcome_goal.unwrap().status, "budget-exhausted");
        assert_eq!(saved.outputs.len(), 2);
        assert!(bind(ctx, "goal", "over-budget").is_err());
        Ok(())
    });
}

#[test]
fn uncertain_live_guidance_never_queues_a_duplicate_turn() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "guided", &room.id)?;
        bind(ctx, "guided", "guided-run")?;
        let mut item = ctx.item("guided")?;
        item.live_steering.push(LiveWorkSteering {
            id: "event".into(),
            text: "Focus on the parser".into(),
            run_id: "guided-run".into(),
            delivery: "pending".into(),
            created_at: TIME.into(),
        });
        ctx.work(&item)?;
        complete(ctx, "guided", "guided-run", "Current result")?;
        assert_eq!(ctx.item("guided")?.status, WorkStatus::AwaitingUser);
        assert!(!ctx.item("guided")?.awaiting_user);
        assert!(bind(ctx, "guided", "duplicate-run").is_err());
        Ok(())
    });
}

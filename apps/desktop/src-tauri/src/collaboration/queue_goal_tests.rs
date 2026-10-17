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
fn browser_handover_persists_review_and_preserves_the_task_copy_binding() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "source", &room.id)?;
        bind(ctx, "source", "source-run")?;
        let mut item = ctx.item("source")?;
        item.repository_binding = Some(crate::local_computer::coding::RepositoryWorkBinding {
            version: 1,
            repository_id: "owned-copy".into(),
            branch: "codex/task".into(),
            base_commit: "a".repeat(40),
            captured_at: TIME.into(),
        });
        let binding = item.repository_binding.clone();
        ctx.work(&item)?;
        assert!(handover::pause(ctx, "reviewer", "Human sign-in required").is_err());
        handover::pause(
            ctx,
            "lead",
            "Human sign-in required; Continue after reviewing the browser",
        )?;
        let saved = ctx.item("source")?;
        assert_eq!(saved.status, WorkStatus::AwaitingUser);
        assert_eq!(saved.generation, 2);
        assert!(saved.current_run_id.is_none());
        assert!(!saved.awaiting_user);
        assert_eq!(saved.repository_binding, binding);
        assert!(ensure_run_current(ctx.conn, ctx.store, Some("source-run")).is_err());
        assert!(commands::apply(
            ctx,
            Command::ReplyWork {
                id: saved.id,
                expected_generation: saved.generation,
                event_id: "blind-reply".into(),
                text: "Keep going".into()
            }
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn live_steering_admission_requires_current_codex_author_and_never_resends_pending_input() {
    let mut selected = profiles();
    selected[0].model_id = "codex::fixture".into();
    fixture_with_profiles(&store(), selected, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "guided", &room.id)?;
        let mut item = ctx.item("guided")?;
        item.status = WorkStatus::Running;
        item.current_run_id = Some("codex-run".into());
        item.run_ids = vec!["codex-run".into()];
        ctx.work(&item)?;
        assert!(steering::admit(ctx, "guided", 1, "input", "Use the smaller scope").is_err());
        let author = Author {
            run_id: "codex-run".into(),
            conversation_id: room.id.clone(),
            agent_id: "lead".into(),
            name: "Lead".into(),
            work_id: Some("guided".into()),
            generation: 1,
        };
        ctx.put(Kind::Author, "codex-run", Some(&room.id), None, &author)?;
        assert!(steering::admit(ctx, "guided", 0, "input", "Use the smaller scope").is_err());
        assert_eq!(
            steering::admit(ctx, "guided", 1, "input", "Use the smaller scope")?,
            Some("codex-run".into())
        );
        assert_eq!(
            steering::admit(ctx, "guided", 1, "input", "Use the smaller scope")?,
            None
        );
        assert!(steering::admit(ctx, "guided", 1, "input", "Changed text").is_err());
        assert!(steering::admit(ctx, "guided", 1, "duplicate", "Use the smaller scope").is_err());
        let mut current = ctx.item("guided")?;
        current.live_steering.clear();
        current.execution_owner = Some("native-background".into());
        ctx.work(&current)?;
        assert!(steering::admit(
            ctx,
            "guided",
            1,
            "background",
            "Do not route to a different owner"
        )
        .is_err());
        current.execution_owner = None;
        ctx.work(&current)?;
        let mut changed = ctx.room(&room.id)?;
        changed.generation += 1;
        ctx.conversation(&changed)?;
        assert!(steering::admit(ctx, "guided", 1, "stale-room", "Late guidance").is_err());
        Ok(())
    });
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
fn queue_edit_and_hold_fence_every_explicit_recipient_before_anyone_starts() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start_for_recipients(
            ctx,
            "effort".into(),
            room.id,
            vec!["lead".into(), "reviewer".into()],
            true,
            "Review the parser".into(),
            false,
            None,
            None,
        )?;
        queue::edit(ctx, "effort", 1, "Review only the parser tests")?;
        let all = ctx.all_work()?;
        let effort: Vec<_> = all.iter().filter(|item| item.root_id == "effort").collect();
        assert_eq!(effort.len(), 2);
        assert!(effort.iter().all(
            |item| item.user_request == "Review only the parser tests" && item.generation == 2
        ));
        queue::hold(ctx, "effort", 2, true)?;
        let child = effort
            .iter()
            .find(|item| item.parent_id.is_some())
            .unwrap()
            .id
            .clone();
        assert!(bind(ctx, &child, "held-child").is_err());
        queue::hold(ctx, "effort", 3, false)?;
        bind(ctx, &child, "child-run")?;
        assert!(queue::edit(ctx, "effort", 4, "Too late").is_err());
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
        work::agent_command(
            ctx,
            "goal",
            2,
            "first-run",
            "continue-first",
            AgentCommand::GoalReport {
                status: "continue".into(),
                text: "The remaining section needs a source".into(),
            },
        )?;
        goals::pause(ctx, "goal", 2, true)?;
        complete(ctx, "goal", "first-run", "First section drafted")?;
        assert_eq!(ctx.item("goal")?.status, WorkStatus::Queued);
        assert!(bind(ctx, "goal", "paused-run").is_err());
        goals::pause(ctx, "goal", 2, false)?;
        bind(ctx, "goal", "last-run")?;
        work::agent_command(
            ctx,
            "goal",
            3,
            "last-run",
            "continue-last",
            AgentCommand::GoalReport {
                status: "continue".into(),
                text: "Still missing the source".into(),
            },
        )?;
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

#[test]
fn missing_or_stale_goal_reports_never_start_another_billable_attempt() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        request(ctx, "goal", &room.id)?;
        goals::set(
            ctx,
            "goal",
            1,
            "Finish report",
            "All sources checked",
            4,
            32000,
        )?;
        bind(ctx, "goal", "first-run")?;
        complete(
            ctx,
            "goal",
            "first-run",
            "A partial report without progress evidence",
        )?;
        assert_eq!(ctx.item("goal")?.status, WorkStatus::AwaitingUser);
        assert_eq!(ctx.item("goal")?.outcome_goal.unwrap().status, "blocked");
        assert!(bind(ctx, "goal", "automatic-retry").is_err());
        commands::apply(
            ctx,
            Command::ContinueWork {
                id: "goal".into(),
                expected_generation: 2,
                reconcile: true,
            },
        )?;
        bind(ctx, "goal", "second-run")?;
        let mut current = ctx.item("goal")?;
        current.outcome_goal.as_mut().unwrap().report = Some(GoalReport {
            status: "continue".into(),
            text: "An old progress report".into(),
            run_id: "first-run".into(),
            created_at: TIME.into(),
        });
        ctx.work(&current)?;
        complete(
            ctx,
            "goal",
            "second-run",
            "Still no current progress report",
        )?;
        assert_eq!(ctx.item("goal")?.status, WorkStatus::AwaitingUser);
        assert!(bind(ctx, "goal", "stale-report-retry").is_err());
        Ok(())
    });
}

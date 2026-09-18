//! Scheduling regressions for nested delegation and dependency failures.
use super::*;

#[test]
fn direct_nested_delegation_resumes_each_parent_with_distinct_attempts() {
    fixture(&store(), |ctx| {
        let room = ctx.create_room(
            "nested-room",
            "Nested delegation",
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
            "Review the implementation".into(),
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
            delegate("researcher", "Review the error handling"),
        )?;
        let researcher_id = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.parent_id.as_deref() == Some("root"))
            .expect("researcher assignment")
            .id;
        complete(
            ctx,
            "root",
            "lead-one",
            "Researcher is reviewing the error handling.",
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Waiting);

        bind(ctx, &researcher_id, "researcher-one")?;
        work::agent_command(
            ctx,
            &researcher_id,
            1,
            "researcher-one",
            "delegate-reviewer",
            delegate("reviewer", "Verify the error handling result"),
        )?;
        let reviewer_id = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.parent_id.as_deref() == Some(researcher_id.as_str()))
            .expect("reviewer assignment")
            .id;
        complete(
            ctx,
            &researcher_id,
            "researcher-one",
            "The reviewer is verifying the error handling.",
        )?;
        assert_eq!(ctx.item(&researcher_id)?.status, WorkStatus::Waiting);

        bind(ctx, &reviewer_id, "reviewer-one")?;
        complete(
            ctx,
            &reviewer_id,
            "reviewer-one",
            "The error handling is safe.",
        )?;
        assert_eq!(ctx.item(&researcher_id)?.status, WorkStatus::Queued);
        bind(ctx, &researcher_id, "researcher-two")?;
        complete(
            ctx,
            &researcher_id,
            "researcher-two",
            "The reviewer confirms the implementation is safe.",
        )?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Queued);

        bind(ctx, "root", "lead-two")?;
        complete(
            ctx,
            "root",
            "lead-two",
            "Synthesis: the implementation is safe to ship.",
        )?;
        let root = ctx.item("root")?;
        assert_eq!(root.status, WorkStatus::Completed);
        assert_eq!(root.run_ids, vec!["lead-one", "lead-two"]);
        assert_eq!(
            ctx.item(&researcher_id)?.run_ids,
            vec!["researcher-one", "researcher-two"]
        );
        assert_eq!(ctx.item(&reviewer_id)?.run_ids, vec!["reviewer-one"]);
        assert!(ctx
            .all_work()?
            .iter()
            .all(|item| item.status != WorkStatus::Cancelled));
        Ok(())
    });
}

#[test]
fn failed_dependency_blocks_child_and_releases_parent_from_waiting() {
    fixture(&store(), |ctx| {
        let room = ctx.create_room(
            "dependency-room",
            "Dependency failure",
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
            "Check two dependent paths".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "root", "lead-run")?;
        work::agent_command(
            ctx,
            "root",
            1,
            "lead-run",
            "delegate-prerequisite",
            delegate("researcher", "Check the prerequisite path"),
        )?;
        let prerequisite_id = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.parent_id.as_deref() == Some("root"))
            .expect("prerequisite assignment")
            .id;
        work::agent_command(
            ctx,
            "root",
            1,
            "lead-run",
            "delegate-dependent",
            AgentCommand::Delegate {
                agent_id: "reviewer".into(),
                prompt: "Use the prerequisite result to verify the release path".into(),
                title: "Dependent release check".into(),
                dependencies: vec![prerequisite_id.clone()],
                focused: false,
            },
        )?;
        let dependent_id = ctx
            .all_work()?
            .into_iter()
            .find(|item| item.agent_id == "reviewer")
            .expect("dependent assignment")
            .id;
        assert_eq!(ctx.item(&dependent_id)?.status, WorkStatus::Waiting);
        assert_eq!(
            ctx.item(&dependent_id)?.prerequisites,
            vec![prerequisite_id.clone()]
        );
        complete(ctx, "root", "lead-run", "The two checks are queued.")?;
        assert_eq!(ctx.item("root")?.status, WorkStatus::Waiting);

        bind(ctx, &prerequisite_id, "prerequisite-run")?;
        journal(
            ctx,
            &room.id,
            "prerequisite-run",
            "failed",
            "The prerequisite provider failed",
        )?;
        work::finish(
            ctx,
            &prerequisite_id,
            1,
            "prerequisite-run",
            WorkStatus::Failed,
            Some("The prerequisite provider failed".into()),
        )?;

        let dependent = ctx.item(&dependent_id)?;
        assert_eq!(dependent.status, WorkStatus::Blocked);
        assert!(dependent.current_run_id.is_none());
        assert!(dependent.run_ids.is_empty());
        let root = ctx.item("root")?;
        assert_ne!(root.status, WorkStatus::Waiting);
        assert_eq!(root.status, WorkStatus::Queued);
        assert!(root.awaiting_user);
        assert!(root.reason.as_deref().unwrap_or("").contains("unresolved"));
        Ok(())
    });
}

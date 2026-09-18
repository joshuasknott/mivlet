use super::*;

#[test]
fn resumed_assignment_rechecks_resource_ownership() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "old".into(),
            room.id.clone(),
            "lead".into(),
            "Write report".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "old", "old-run")?;
        work::agent_command(
            ctx,
            "old",
            1,
            "old-run",
            "claim-old",
            AgentCommand::ClaimResource {
                resource: "connector:drive".into(),
            },
        )?;
        complete(ctx, "old", "old-run", "Report written")?;
        work::start_for_recipients(
            ctx,
            "new".into(),
            room.id,
            vec!["reviewer".into()],
            true,
            "Update report".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "new", "new-run")?;
        work::agent_command(
            ctx,
            "new",
            1,
            "new-run",
            "claim-new",
            AgentCommand::ClaimResource {
                resource: "connector:drive".into(),
            },
        )?;
        commands::apply(
            ctx,
            Command::ReplyWork {
                id: "old".into(),
                expected_generation: 1,
                event_id: "resume-old".into(),
                text: "Revise your report".into(),
            },
        )?;
        bind(ctx, "old", "resumed-run")?;
        assert!(work::agent_command(
            ctx,
            "old",
            2,
            "resumed-run",
            "claim-resumed",
            AgentCommand::ClaimResource {
                resource: "connector:drive".into()
            }
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn workspace_recipients_share_a_frozen_request_without_membership_or_private_context_leak() {
    let profiles = [
        ("lead", "Lead private instructions"),
        ("researcher", "Researcher private instructions"),
        ("reviewer", "Reviewer private instructions"),
    ]
    .iter()
    .map(|(id, instructions)| {
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "instructions": instructions,
            "modelId": "openai::fixture-model",
            "icon": "sparkle",
            "permissionLabel": "Ask Me"
        }))
        .unwrap()
    })
    .collect();
    let store = store();
    fixture_with_profiles(&store, profiles, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        let attachments = vec![WorkAttachment {
            id: "brief".into(),
            name: "brief.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 2_048,
            availability: "knowledge-context".into(),
            relative_path: None,
            source_id: Some("knowledge-brief".into()),
            sha256: None,
        }];
        commands::apply(
            ctx,
            Command::StartWork {
                id: "workspace-effort".into(),
                conversation_id: room.id.clone(),
                agent_id: "researcher".into(),
                prompt: "Review this implementation".into(),
                discussion: false,
                recipient_ids: Some(vec!["researcher".into(), "reviewer".into()]),
                attachments: Some(attachments.clone()),
            },
        )?;
        let root = ctx.item("workspace-effort")?;
        let child_id = root.dependencies.first().cloned().unwrap();
        let child = ctx.item(&child_id)?;
        assert_eq!(root.attachments, attachments);
        assert_eq!(child.attachments, attachments);
        assert!(root.workspace_recipient && child.workspace_recipient);
        assert_eq!(ctx.room(&room.id)?.participants.len(), 1);
        assert_eq!(root.root_id, child.root_id);
        assert_eq!(
            root.captured_context.as_ref().unwrap().source,
            child.captured_context.as_ref().unwrap().source
        );
        let root_context: serde_json::Value =
            serde_json::from_str(&root.captured_context.as_ref().unwrap().text).unwrap();
        let child_context: serde_json::Value =
            serde_json::from_str(&child.captured_context.as_ref().unwrap().text).unwrap();
        assert_eq!(
            root_context["agentInstructions"],
            "Researcher private instructions"
        );
        assert_eq!(
            child_context["agentInstructions"],
            "Reviewer private instructions"
        );
        Ok(())
    });
}

#[test]
fn task_messages_and_resource_claims_are_scoped_and_idempotent() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start_for_recipients(
            ctx,
            "effort-a".into(),
            room.id.clone(),
            vec!["lead".into(), "researcher".into()],
            true,
            "Coordinate a review".into(),
            false,
            None,
            None,
        )?;
        let root = ctx.item("effort-a")?;
        let child_id = root.dependencies[0].clone();
        journal(ctx, &room.id, "effort-run", "queued", "")?;
        work::bind(ctx, "effort-a", root.generation, "effort-run", None)?;
        work::agent_command(
            ctx,
            "effort-a",
            1,
            "effort-run",
            "claim-call",
            AgentCommand::ClaimResource {
                resource: r"Workspace\Shared\Report.md".into(),
            },
        )?;
        assert_eq!(
            ctx.item("effort-a")?.resource_claims,
            vec!["workspace/shared/report.md"]
        );
        work::agent_command(
            ctx,
            "effort-a",
            1,
            "effort-run",
            "claim-call",
            AgentCommand::ClaimResource {
                resource: r"Workspace\Shared\Report.md".into(),
            },
        )?;
        work::agent_command(
            ctx,
            "effort-a",
            1,
            "effort-run",
            "message-call",
            AgentCommand::Message {
                assignment_id: child_id.clone(),
                message: "Please check the error path.".into(),
                question: true,
            },
        )?;
        let child = ctx.item(&child_id)?;
        assert_eq!(child.messages.len(), 1);
        assert_eq!(child.messages[0].from_agent_id, "lead");
        assert!(child.messages[0].question);

        work::start_for_recipients(
            ctx,
            "effort-b".into(),
            room.id,
            vec!["reviewer".into()],
            true,
            "Separate review".into(),
            false,
            None,
            None,
        )?;
        let other = ctx.item("effort-b")?;
        journal(ctx, &other.conversation_id, "effort-b-run", "queued", "")?;
        work::bind(ctx, "effort-b", other.generation, "effort-b-run", None)?;
        assert!(work::agent_command(
            ctx,
            "effort-b",
            1,
            "effort-b-run",
            "conflicting-claim",
            AgentCommand::ClaimResource {
                resource: "workspace/shared/report.md".into(),
            },
        )
        .is_err());
        Ok(())
    });
}

#[test]
fn user_follow_up_resumes_only_deliberate_waits_and_never_replays_a_running_turn() {
    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "reply-work".into(),
            room.id.clone(),
            "lead".into(),
            "Answer the brief".into(),
            false,
            None,
            None,
        )?;
        journal(ctx, &room.id, "reply-run", "queued", "")?;
        work::bind(ctx, "reply-work", 1, "reply-run", None)?;
        work::agent_command(
            ctx,
            "reply-work",
            1,
            "reply-run",
            "await-call",
            AgentCommand::AwaitUser {
                reason: "Need the user's decision".into(),
            },
        )?;
        complete(ctx, "reply-work", "reply-run", "Waiting for decision")?;
        assert_eq!(ctx.item("reply-work")?.status, WorkStatus::AwaitingUser);
        commands::apply(
            ctx,
            Command::ReplyWork {
                id: "reply-work".into(),
                expected_generation: 1,
                event_id: "user-follow-up".into(),
                text: "Use the safer option".into(),
            },
        )?;
        let resumed = ctx.item("reply-work")?;
        assert_eq!(resumed.status, WorkStatus::Queued);
        assert_eq!(resumed.generation, 2);
        assert!(!resumed.awaiting_user);
        assert_eq!(resumed.steering.len(), 1);
        assert!(commands::apply(
            ctx,
            Command::ReplyWork {
                id: "reply-work".into(),
                expected_generation: 2,
                event_id: "duplicate".into(),
                text: "Another instruction".into(),
            },
        )
        .is_ok());
        Ok(())
    });

    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "running-reply".into(),
            room.id.clone(),
            "lead".into(),
            "Answer the brief".into(),
            false,
            None,
            None,
        )?;
        journal(ctx, &room.id, "running-run", "queued", "")?;
        work::bind(ctx, "running-reply", 1, "running-run", None)?;
        commands::apply(
            ctx,
            Command::ReplyWork {
                id: "running-reply".into(),
                expected_generation: 1,
                event_id: "running-follow-up".into(),
                text: "Also check the error path".into(),
            },
        )?;
        assert_eq!(ctx.item("running-reply")?.status, WorkStatus::Running);
        complete(ctx, "running-reply", "running-run", "Initial result")?;
        assert_eq!(ctx.item("running-reply")?.status, WorkStatus::Queued);
        Ok(())
    });

    fixture(&store(), |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "waiting-reply".into(),
            room.id.clone(),
            "lead".into(),
            "Coordinate the review".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "waiting-reply", "lead-run")?;
        work::agent_command(
            ctx,
            "waiting-reply",
            1,
            "lead-run",
            "delegate-worker",
            AgentCommand::Delegate {
                agent_id: "researcher".into(),
                prompt: "Inspect the parser boundary".into(),
                title: "Parser boundary".into(),
                dependencies: vec![],
                focused: false,
            },
        )?;
        let child_id = ctx
            .all_work()?
            .into_iter()
            .find(|work| work.parent_id.as_deref() == Some("waiting-reply"))
            .unwrap()
            .id;
        bind(ctx, &child_id, "worker-run")?;
        complete(
            ctx,
            "waiting-reply",
            "lead-run",
            "Worker is checking the parser",
        )?;
        assert_eq!(ctx.item("waiting-reply")?.status, WorkStatus::Waiting);
        commands::apply(
            ctx,
            Command::ReplyWork {
                id: "waiting-reply".into(),
                expected_generation: 1,
                event_id: "guidance-while-running".into(),
                text: "Prioritize compatibility findings".into(),
            },
        )?;
        assert_eq!(ctx.item("waiting-reply")?.status, WorkStatus::Queued);
        assert_eq!(ctx.item(&child_id)?.status, WorkStatus::Running);
        assert_eq!(ctx.item("waiting-reply")?.waiting_for, vec![child_id]);
        Ok(())
    });
}

#[test]
fn missing_recipients_fail_without_profile_or_permission_widening() {
    let profiles = [("lead", "Work Freely"), ("reviewer", "Ask Me")]
        .iter()
        .map(|(id, permission)| {
            serde_json::from_value(json!({
                "id": id,
                "name": id,
                "instructions": "Fixture teammate",
                "modelId": "openai::fixture-model",
                "icon": "sparkle",
                "permissionLabel": permission
            }))
            .unwrap()
        })
        .collect();
    fixture_with_profiles(&store(), profiles, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        commands::apply(
            ctx,
            Command::StartWork {
                id: "removed-recipient".into(),
                conversation_id: room.id.clone(),
                agent_id: "reviewer".into(),
                prompt: "Review the change".into(),
                discussion: false,
                recipient_ids: Some(vec!["reviewer".into()]),
                attachments: None,
            },
        )?;
        let lead = ctx
            .profiles
            .iter()
            .find(|profile| profile.id == "lead")
            .unwrap()
            .clone();
        let limited_profiles = vec![MivletAgentProfile {
            permission_label: "Ask Me".into(),
            ..lead.clone()
        }];
        let limited = Context {
            conn: ctx.conn,
            store: ctx.store,
            scope: ctx.scope,
            profiles: &limited_profiles,
            time: ctx.time,
        };
        commands::apply(
            &limited,
            Command::WorkStatus {
                id: "removed-recipient".into(),
                generation: 1,
                status: WorkStatus::Failed,
                reason: Some("Recipient was removed from the workspace.".into()),
            },
        )?;
        assert_eq!(ctx.item("removed-recipient")?.status, WorkStatus::Failed);

        work::start(
            ctx,
            "permission-fence".into(),
            room.id,
            "lead".into(),
            "Use the available tools".into(),
            false,
            None,
            None,
        )?;
        assert!(work::current(&limited, "permission-fence", 1, None).is_err());
        Ok(())
    });
}

#[test]
fn task_question_does_not_create_a_transitive_wait_cycle() {
    let profiles = ["lead", "researcher", "reviewer", "analyst"]
        .iter()
        .map(|id| {
            serde_json::from_value(json!({
                "id": id,
                "name": id,
                "instructions": "Fixture teammate",
                "modelId": "openai::fixture-model",
                "icon": "sparkle",
                "permissionLabel": "Ask Me"
            }))
            .unwrap()
        })
        .collect();
    fixture_with_profiles(&store(), profiles, |ctx| {
        let room = chats::open_main(ctx, "lead")?;
        work::start(
            ctx,
            "cycle-root".into(),
            room.id,
            "lead".into(),
            "Coordinate peers".into(),
            false,
            None,
            None,
        )?;
        bind(ctx, "cycle-root", "root-run")?;
        for (agent, call) in [
            ("researcher", "delegate-a"),
            ("reviewer", "delegate-b"),
            ("analyst", "delegate-c"),
        ] {
            work::agent_command(
                ctx,
                "cycle-root",
                1,
                "root-run",
                call,
                delegate(agent, "Peer task"),
            )?;
        }
        let mut children = ctx
            .all_work()?
            .into_iter()
            .filter(|item| item.parent_id.as_deref() == Some("cycle-root"))
            .collect::<Vec<_>>();
        children.sort_by(|left, right| left.agent_id.cmp(&right.agent_id));
        let ids = children
            .iter()
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        for (index, run) in ["a-run", "b-run", "c-run"].iter().enumerate() {
            bind(ctx, &ids[index], run)?;
        }
        for (from, to, call) in [
            (0, 1, "question-a"),
            (1, 2, "question-b"),
            (2, 0, "question-c"),
        ] {
            work::agent_command(
                ctx,
                &ids[from],
                1,
                ["a-run", "b-run", "c-run"][from],
                call,
                AgentCommand::Message {
                    assignment_id: ids[to].clone(),
                    message: "Please confirm your finding".into(),
                    question: true,
                },
            )?;
        }
        assert_eq!(ctx.item(&ids[0])?.waiting_for, vec![ids[1].clone()]);
        assert_eq!(ctx.item(&ids[1])?.waiting_for, vec![ids[2].clone()]);
        assert!(ctx.item(&ids[2])?.waiting_for.is_empty());
        assert_eq!(ctx.item(&ids[0])?.messages.len(), 1);
        Ok(())
    });
}

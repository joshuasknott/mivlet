use super::*;
use crate::collaboration::{chats, models::WorkStatus, work};
use crate::models::ApprovalRequest;
use crate::store::vault::{MasterKey, Vault};
use crate::store::Store;
use serde_json::json;

fn fixture_snapshot() -> RuntimeSnapshot {
    serde_json::from_value(json!({
        "version": 8,
        "activeItem": "Chat",
        "composerDraft": "",
        "voiceEnabled": false,
        "approvalAudit": [],
        "dismissedApprovalIds": [],
        "approvalRules": [],
        "agents": [{
            "id": "lead",
            "name": "Lead",
            "instructions": "Fixture agent",
            "modelId": "fixture-model",
            "reasoningEffort": "high",
            "fastMode": true,
            "icon": "agent",
            "iconColor": "#6D5DF7",
            "connectorIds": ["private-connector"],
            "knowledgeSourceIds": ["private-source"],
            "permissionLabel": "Ask Me",
            "threadIds": [],
            "learnedTasks": []
        }],
        "activeAgentId": "lead",
        "pinnedSourceIds": [],
        "importedKnowledgeSources": [],
        "memoryDisabled": false,
        "memoryRecords": [],
        "connectedBackendIds": [],
        "savedAt": "2026-10-19T00:00:00Z",
        "permissionMode": "trusted-scope",
        "permissionLabel": "Ask Me"
    }))
    .expect("fixture snapshot")
}

fn fixture_work() -> Work {
    serde_json::from_value(json!({
        "id": "work",
        "workspaceId": "default",
        "conversationId": "chat",
        "rootId": "work",
        "agentId": "lead",
        "agentName": "Lead",
        "prompt": "Manage the workspace",
        "userRequest": "Manage the workspace",
        "status": "running",
        "dependencies": [],
        "generation": 1,
        "conversationGeneration": 1,
        "contextRevision": 1,
        "depth": 0,
        "turnCount": 1,
        "tokenUsage": 0,
        "maxTurns": 8,
        "maxTokens": 1000,
        "runIds": ["run"],
        "currentRunId": "run",
        "modelOptionId": "fixture-model",
        "outputs": [],
        "createdAt": "2026-10-19T00:00:00Z",
        "updatedAt": "2026-10-19T00:00:00Z"
    }))
    .expect("fixture work")
}

#[test]
fn ids_are_stable_for_replay() {
    assert_eq!(
        digest_id("agent-chat", "call-1"),
        digest_id("agent-chat", "call-1")
    );
    assert_ne!(
        digest_id("agent-chat", "call-1"),
        digest_id("agent-chat", "call-2")
    );
}

#[test]
fn self_delete_and_read_only_are_mutations() {
    assert!(mutating(&WorkspaceOperation::DeleteAgent {
        agent_id: "agent".into()
    }));
    assert!(!mutating(&WorkspaceOperation::Inspect));
}

#[test]
fn tool_name_is_converted_to_a_strict_operation_shape() {
    let (operation, raw) = parse_operation(
        "agent-create",
        r#"{"name":"Scout","instructions":"Find sources"}"#,
    )
    .expect("valid agent-create arguments");
    assert_eq!(operation.name(), "create-agent");
    assert_eq!(raw["name"], "Scout");
    assert!(parse_operation("agent-create", r#"{"name":"Scout","extra":true}"#).is_err());
}

#[test]
fn receipt_fingerprint_is_canonical_and_tool_bound() {
    let first = crate::tools::tool_arguments_fingerprint(
        "agent-create",
        &serde_json::json!({"name":"Scout","instructions":"x"}),
    )
    .unwrap();
    let reordered = crate::tools::tool_arguments_fingerprint(
        "agent-create",
        &serde_json::json!({"instructions":"x","name":"Scout"}),
    )
    .unwrap();
    let other_tool = crate::tools::tool_arguments_fingerprint(
        "agent-update",
        &serde_json::json!({"name":"Scout","instructions":"x"}),
    )
    .unwrap();
    assert_eq!(first, reordered);
    assert_ne!(first, other_tool);
}

#[test]
fn project_create_commits_project_team_conversation_and_receipt_together() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let operation = WorkspaceOperation::CreateProject {
        name: "Research".into(),
        instructions: "Collect evidence".into(),
        participant_ids: vec!["lead".into()],
        lead_agent_id: Some("lead".into()),
    };
    let snapshot = fixture_snapshot();
    let work = fixture_work();
    let profiles = snapshot.agents.clone();
    let digest = crate::tools::tool_arguments_fingerprint(
        "project-create",
        &json!({
            "name": "Research",
            "instructions": "Collect evidence",
            "participantIds": ["lead"],
            "leadAgentId": "lead"
        }),
    )
    .unwrap();
    let receipt_key = receipt_id("run", "call");
    let project_id = digest_id("project-chat", &receipt_key);
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
            let ctx = Context {
                conn,
                store: &store,
                scope: &scope,
                profiles: &profiles,
                time: "2026-10-19T00:00:00Z",
            };
            let mut snapshot = snapshot.clone();
            apply_operation(
                &ctx,
                &work,
                &operation,
                None,
                &mut snapshot,
                &receipt_key,
                &digest,
            )?;
            let project = local_project::get_project(conn, &store, &scope.private, &project_id)?;
            assert!(project.is_some());
            assert!(
                repo::get::<Team>(conn, &store, &scope.private, Kind::Team, &project_id,)?
                    .is_some()
            );
            assert!(repo::get::<Conversation>(
                conn,
                &store,
                &scope.private,
                Kind::Conversation,
                &format!("{project_id}-thread"),
            )?
            .is_some());
            assert!(repo::get::<SavedReceipt>(
                conn,
                &store,
                &scope.private,
                Kind::Receipt,
                &receipt_key,
            )?
            .is_some());
            Ok(())
        })
        .expect("project transaction");
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Read)?;
            assert!(
                local_project::get_project(conn, &store, &scope.private, &project_id,)?.is_some()
            );
            Ok(())
        })
        .expect("committed project remains readable");
}

#[test]
fn create_agent_copies_only_model_settings_from_the_caller() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let mut snapshot = fixture_snapshot();
    let profiles = snapshot.agents.clone();
    let work = fixture_work();
    let operation = WorkspaceOperation::CreateAgent {
        name: "Researcher".into(),
        instructions: "Search primary sources.".into(),
        model_agent_id: None,
    };
    let receipt_key = receipt_id("run", "create-agent-call");
    let expected_id = digest_id("agent-chat", &receipt_key);

    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
            let ctx = Context {
                conn,
                store: &store,
                scope: &scope,
                profiles: &profiles,
                time: "2026-10-19T00:00:00Z",
            };
            apply_operation(
                &ctx,
                &work,
                &operation,
                Some(0),
                &mut snapshot,
                &receipt_key,
                "digest",
            )?;
            let created = snapshot
                .agents
                .iter()
                .find(|agent| agent.id == expected_id)
                .expect("created agent");
            assert_eq!(created.model_id, "fixture-model");
            assert_eq!(created.reasoning_effort.as_deref(), Some("high"));
            assert_eq!(created.fast_mode, Some(true));
            assert!(created.connector_ids.is_empty());
            assert!(created.knowledge_source_ids.is_empty());
            assert!(created.thread_id.is_none());
            assert_eq!(created.instructions, "Search primary sources.");
            assert_eq!(snapshot.agent_revision, 1);
            Ok(())
        })
        .expect("create agent transaction");
}

#[test]
fn no_op_update_does_not_increment_revision_or_team_revision() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let mut snapshot = fixture_snapshot();
    let profiles = snapshot.agents.clone();
    let work = fixture_work();
    let operation = WorkspaceOperation::UpdateAgent {
        agent_id: "lead".into(),
        name: Some("Lead".into()),
        instructions: None,
        model_agent_id: None,
    };
    let receipt_key = receipt_id("run", "no-op-update");

    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
            let ctx = Context {
                conn,
                store: &store,
                scope: &scope,
                profiles: &profiles,
                time: "2026-10-19T00:00:00Z",
            };
            local_projects::create_project_at(
                conn,
                &store,
                &scope,
                CreateLocalProjectRequest {
                    workspace_id: "default".into(),
                    id: "project".into(),
                    thread_id: "project-chat".into(),
                    name: "Research".into(),
                    instructions: "Collect evidence".into(),
                    knowledge_source_ids: vec![],
                },
                ctx.time,
            )?;
            ctx.team(&Team {
                project_id: "project".into(),
                lead_agent_id: Some("lead".into()),
                participant_ids: vec!["lead".into()],
                revision: 3,
            })?;
            apply_operation(
                &ctx,
                &work,
                &operation,
                Some(0),
                &mut snapshot,
                &receipt_key,
                "digest",
            )?;
            let team = repo::get::<Team>(conn, &store, &scope.private, Kind::Team, "project")?
                .expect("team");
            assert_eq!(team.revision, 3);
            assert_eq!(snapshot.agent_revision, 0);
            Ok(())
        })
        .expect("no-op update transaction");
}

#[test]
fn unknown_delete_is_rejected_before_roster_change() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let mut snapshot = fixture_snapshot();
    let mut second = snapshot.agents[0].clone();
    second.id = "researcher".into();
    second.name = "Researcher".into();
    snapshot.agents.push(second);
    let profiles = snapshot.agents.clone();
    let operation = WorkspaceOperation::DeleteAgent {
        agent_id: "missing".into(),
    };
    let work = fixture_work();
    let result = store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
        let ctx = Context {
            conn,
            store: &store,
            scope: &scope,
            profiles: &profiles,
            time: "2026-10-19T00:00:00Z",
        };
        apply_operation(
            &ctx,
            &work,
            &operation,
            Some(0),
            &mut snapshot,
            "receipt",
            "digest",
        )
    });
    assert!(result.is_err());
    assert_eq!(snapshot.agents.len(), 2);
    assert_eq!(snapshot.agent_revision, 0);
}

#[test]
fn active_work_blocks_agent_delete() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let mut snapshot = fixture_snapshot();
    let mut second = snapshot.agents[0].clone();
    second.id = "researcher".into();
    second.name = "Researcher".into();
    snapshot.agents.push(second);
    let profiles = snapshot.agents.clone();
    let work = fixture_work();
    let operation = WorkspaceOperation::DeleteAgent {
        agent_id: "researcher".into(),
    };
    let result = store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
        let ctx = Context {
            conn,
            store: &store,
            scope: &scope,
            profiles: &profiles,
            time: "2026-10-19T00:00:00Z",
        };
        let mut active = fixture_work();
        active.id = "research-work".into();
        active.root_id = active.id.clone();
        active.agent_id = "researcher".into();
        active.agent_name = "Researcher".into();
        ctx.work(&active)?;
        apply_operation(
            &ctx,
            &work,
            &operation,
            Some(0),
            &mut snapshot,
            "receipt",
            "digest",
        )
    });
    assert!(result.is_err());
    assert_eq!(snapshot.agents.len(), 2);
    assert_eq!(snapshot.agent_revision, 0);
}

#[test]
fn team_update_requires_explicit_history_sharing_and_revision() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let mut snapshot = fixture_snapshot();
    let mut second = snapshot.agents[0].clone();
    second.id = "researcher".into();
    second.name = "Researcher".into();
    snapshot.agents.push(second);
    let profiles = snapshot.agents.clone();
    let work = fixture_work();

    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
            let ctx = Context {
                conn,
                store: &store,
                scope: &scope,
                profiles: &profiles,
                time: "2026-10-19T00:00:00Z",
            };
            let project_operation = WorkspaceOperation::CreateProject {
                name: "Research".into(),
                instructions: "Collect evidence".into(),
                participant_ids: vec!["lead".into()],
                lead_agent_id: Some("lead".into()),
            };
            apply_operation(
                &ctx,
                &work,
                &project_operation,
                None,
                &mut snapshot,
                "create-project-receipt",
                "digest",
            )?;
            let project_id = digest_id("project-chat", "create-project-receipt");
            let without_share = WorkspaceOperation::UpdateTeam {
                project_id: project_id.clone(),
                expected_revision: 1,
                participant_ids: vec!["lead".into(), "researcher".into()],
                lead_agent_id: Some("lead".into()),
                share_history: false,
            };
            assert!(apply_operation(
                &ctx,
                &work,
                &without_share,
                None,
                &mut snapshot,
                "team-no-share",
                "digest",
            )
            .is_err());
            let mut with_share = without_share.clone();
            if let WorkspaceOperation::UpdateTeam { share_history, .. } = &mut with_share {
                *share_history = true;
            }
            apply_operation(
                &ctx,
                &work,
                &with_share,
                None,
                &mut snapshot,
                "team-share",
                "digest",
            )?;
            let team = repo::get::<Team>(conn, &store, &scope.private, Kind::Team, &project_id)?
                .expect("updated team");
            assert_eq!(team.revision, 2);
            assert_eq!(team.participant_ids, vec!["lead", "researcher"]);
            let stale = with_share;
            assert!(apply_operation(
                &ctx,
                &work,
                &stale,
                None,
                &mut snapshot,
                "team-stale",
                "digest",
            )
            .is_err());
            Ok(())
        })
        .expect("team update transaction");
}

#[test]
fn mutation_allowed_rejects_read_only_work_and_profile() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
            let mut profiles = fixture_snapshot().agents;
            let mut item = fixture_work();
            profiles[0].permission_label = "Read Only".into();
            let ctx = Context {
                conn,
                store: &store,
                scope: &scope,
                profiles: &profiles,
                time: "2026-10-19T00:00:00Z",
            };
            assert!(mutation_allowed(&ctx, &item).is_err());
            profiles[0].permission_label = "Ask Me".into();
            item.permission_mode = "read-only".into();
            let ctx = Context {
                conn,
                store: &store,
                scope: &scope,
                profiles: &profiles,
                time: "2026-10-19T00:00:00Z",
            };
            assert!(mutation_allowed(&ctx, &item).is_err());
            Ok(())
        })
        .expect("permission transaction");
}

fn foreground_work_context<T>(f: impl FnOnce(&Context<'_>, &Work) -> Result<T, StoreError>) -> T {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let snapshot = fixture_snapshot();
    let profiles = snapshot.agents.clone();
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
            let ctx = Context {
                conn,
                store: &store,
                scope: &scope,
                profiles: &profiles,
                time: "2026-10-19T00:00:00Z",
            };
            let room = chats::open_main(&ctx, "lead")?;
            work::start(
                &ctx,
                "foreground-work".into(),
                room.id,
                "lead".into(),
                "Manage the workspace".into(),
                false,
                Some("chat"),
                None,
            )?;
            let mut item = ctx.item("foreground-work")?;
            item.status = WorkStatus::Running;
            item.current_run_id = Some("foreground-run".into());
            item.run_ids = vec!["foreground-run".into()];
            ctx.work(&item)?;
            f(&ctx, &item)
        })
        .expect("foreground work fixture")
}

#[test]
fn foreground_fence_accepts_current_chat_work() {
    foreground_work_context(|ctx, item| {
        let request = WorkspaceManageRequest {
            workspace_id: "default".into(),
            work_id: item.id.clone(),
            generation: item.generation,
            run_id: "foreground-run".into(),
            call_id: "call".into(),
            tool: "workspace-inspect".into(),
            arguments: "{}".into(),
            approval: ApprovalResolutionRequest {
                request: ApprovalRequest {
                    id: "call".into(),
                    service: "mivlet".into(),
                    action: "workspace-inspect".into(),
                    mode: "read".into(),
                    risk_level: "low".into(),
                    data_used: vec![],
                    consequence: "none".into(),
                    requested_at: "2026-10-19T00:00:00Z".into(),
                    decisions: vec!["once".into()],
                    confirmation_phrase: None,
                },
                decision: "once".into(),
                decided_at: "2026-10-19T00:00:00Z".into(),
                confirmation_text: None,
                modification: None,
            },
            expected_agent_revision: None,
        };
        assert_eq!(fence(ctx, &request)?.id, item.id);
        Ok(())
    });
}

#[test]
fn fence_rejects_stale_generation_and_stopped_work() {
    foreground_work_context(|ctx, item| {
        let mut request = WorkspaceManageRequest {
            workspace_id: "default".into(),
            work_id: item.id.clone(),
            generation: item.generation + 1,
            run_id: "foreground-run".into(),
            call_id: "call".into(),
            tool: "workspace-inspect".into(),
            arguments: "{}".into(),
            approval: serde_json::from_value(json!({
                "request": {"id":"call","service":"mivlet","action":"workspace-inspect","mode":"read","riskLevel":"low","dataUsed":[],"consequence":"none","requestedAt":"2026-10-19T00:00:00Z","decisions":["once"]},
                "decision":"once","decidedAt":"2026-10-19T00:00:00Z"
            }))
            .expect("approval fixture"),
            expected_agent_revision: None,
        };
        assert!(fence(ctx, &request).is_err());
        request.generation = item.generation;
        let mut stopped = ctx.item(&item.id)?;
        stopped.status = WorkStatus::Cancelled;
        ctx.work(&stopped)?;
        assert!(fence(ctx, &request).is_err());
        Ok(())
    });
}

#[test]
fn fence_rejects_background_owned_work_even_when_running() {
    foreground_work_context(|ctx, item| {
        let mut background = item.clone();
        background.execution_owner = Some("native-background".into());
        ctx.work(&background)?;
        let request: WorkspaceManageRequest = serde_json::from_value(json!({
            "workspaceId":"default","workId":item.id,"generation":item.generation,
            "runId":"foreground-run","callId":"call","tool":"workspace-inspect","arguments":"{}",
            "approval":{"request":{"id":"call","service":"mivlet","action":"workspace-inspect","mode":"read","riskLevel":"low","dataUsed":[],"consequence":"none","requestedAt":"2026-10-19T00:00:00Z","decisions":["once"]},"decision":"once","decidedAt":"2026-10-19T00:00:00Z"}
        }))
        .expect("request fixture");
        assert!(fence(ctx, &request).is_err());
        Ok(())
    });
}

#[test]
fn replay_binding_rejects_changed_digest_work_or_generation() {
    let saved = SavedReceipt {
        work_id: "work".into(),
        generation: 3,
        operation: "create-agent".into(),
        summary: "Created an agent profile.".into(),
        arguments_digest: "digest-a".into(),
    };
    let request = |work_id: &str, generation: u32| {
        WorkspaceManageRequest {
        workspace_id: "default".into(),
        work_id: work_id.into(),
        generation,
        run_id: "run".into(),
        call_id: "call".into(),
        tool: "agent-create".into(),
        arguments: "{}".into(),
        approval: serde_json::from_value(json!({
            "request":{"id":"call","service":"mivlet","action":"agent-create","mode":"write","riskLevel":"high","dataUsed":[],"consequence":"change","requestedAt":"2026-10-19T00:00:00Z","decisions":["once"]},"decision":"once","decidedAt":"2026-10-19T00:00:00Z"
        }))
        .unwrap(),
        expected_agent_revision: Some(0),
    }
    };
    assert!(validate_replay(&saved, &request("work", 3), "create-agent", "digest-a").is_ok());
    assert!(validate_replay(&saved, &request("work", 3), "create-agent", "digest-b").is_err());
    assert!(validate_replay(&saved, &request("other", 3), "create-agent", "digest-a").is_err());
    assert!(validate_replay(&saved, &request("work", 4), "create-agent", "digest-a").is_err());
}

#[test]
fn receipt_ids_are_unambiguous_for_separator_containing_inputs() {
    assert_ne!(receipt_id("a:b", "c"), receipt_id("a", "b:c"));
}

#[test]
fn project_mutation_rolls_back_project_team_conversation_and_receipt_together() {
    let store = Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap())
        .expect("in-memory store");
    let mut snapshot = fixture_snapshot();
    let profiles = snapshot.agents.clone();
    let work = fixture_work();
    let receipt_key = "rollback-receipt";
    let project_id = digest_id("project-chat", receipt_key);
    let result: Result<(), StoreError> = store.transaction(|conn| {
        let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Write)?;
        let ctx = Context {
            conn,
            store: &store,
            scope: &scope,
            profiles: &profiles,
            time: "2026-10-19T00:00:00Z",
        };
        apply_operation(
            &ctx,
            &work,
            &WorkspaceOperation::CreateProject {
                name: "Rollback project".into(),
                instructions: "This must not persist".into(),
                participant_ids: vec!["lead".into()],
                lead_agent_id: Some("lead".into()),
            },
            None,
            &mut snapshot,
            receipt_key,
            "digest",
        )?;
        Err(invalid("force transaction rollback"))
    });
    assert!(result.is_err());
    store
        .with_conn(|conn| {
            let scope = authorized_scope::resolve(conn, Some("default"), None, ScopeAccess::Read)?;
            assert!(
                local_project::get_project(conn, &store, &scope.private, &project_id)?.is_none()
            );
            assert!(
                repo::get::<Team>(conn, &store, &scope.private, Kind::Team, &project_id)?.is_none()
            );
            assert!(repo::get::<Conversation>(
                conn,
                &store,
                &scope.private,
                Kind::Conversation,
                &format!("{project_id}-thread")
            )?
            .is_none());
            assert!(repo::get::<SavedReceipt>(
                conn,
                &store,
                &scope.private,
                Kind::Receipt,
                receipt_key
            )?
            .is_none());
            Ok(())
        })
        .expect("rolled back records remain absent");
}

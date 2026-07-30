    #[test]
    fn reviewer_selection_persists_idempotently_across_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("reviewer-selection.db");
        let vault =
            crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
                .unwrap();
        let scope = DataScope::workspace("workspace-1").unwrap();
        let at = "2026-07-23T10:00:00.000Z";
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "id":"mission-review","workspaceId":"workspace-1",
                "visibility":"member-private","ownerMemberId":"member-1",
                "authority":"local","schemaVersion":1,
                "constraints":[{
                    "key":GENERAL_DECLARED_GRAPH_MARKER,
                    "description":"Use the authenticated native general Mission graph.",
                    "severity":"required","source":"user"
                }],
                "acceptance":{"requiresHumanAcceptance":false,"criteria":[{
                    "key":"quality","description":"Review quality.","required":true,
                    "evaluator":"worker"
                }]}
            }),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-review",
                "steps":[{
                    "key":"review","kind":"review","acceptanceCriterionKeys":["quality"]
                }]
            }),
        };
        {
            let store = crate::store::Store::open(&path, vault.clone()).unwrap();
            store
                .transaction(|tx| {
                    tx.execute(
                        "INSERT INTO workspace(id,name,created_at,updated_at)
                         VALUES ('workspace-1','W',?1,?1)",
                        [at],
                    )?;
                    let mut run = json!({
                        "id":"run-general-store","workspaceId":"workspace-1",
                        "visibility":"member-private","ownerMemberId":"member-1",
                        "authority":"local","schemaVersion":1,"revision":1,
                        "createdByInternalUserId":"user-1","createdAt":at,"updatedAt":at,
                        "status":"running","executionDepth":"multi-worker",
                        "initiator":{"kind":"mission","missionId":"mission-review"},
                        "parentage":{"kind":"root"},"departmentIds":[],
                        "planRevisionId":"revision-review",
                        "budget":{"maxWorkers":1,"maxAttempts":1},
                        "currentAttemptNumber":1,
                        "eventHead":{"lastSequence":1,"lastEventId":"event-created"}
                    });
                    let created = json!({
                        "id":"event-created","runId":"run-general-store","type":"run-created",
                        "sequence":1,"attemptNumber":1,"idempotencyKey":"created-review",
                        "payload":{"run":run}
                    });
                    mission_run::create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "run-general-store",
                        "event-created",
                        "created-review",
                        &run,
                        &created,
                        at,
                    )?;
                    append_general_store_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-reviewer-created",
                        "worker-created",
                        json!({"worker":{
                            "id":"worker-review","runId":"run-general-store",
                            "planRevisionId":"revision-review","planStepKey":"review",
                            "workspaceId":"workspace-1","ownerMemberId":"member-1",
                            "authority":"local","role":{"kind":"reviewer"}
                        }}),
                        json!({"kind":"system"}),
                        at,
                    )?;
                    let journal =
                        mission_run::get(tx, &store, &scope, "member-1", "run-general-store")?
                            .unwrap();
                    let selected = ensure_reviewer_selection_in_tx(
                        tx,
                        &store,
                        AuthorizedRun {
                            scope: scope.clone(),
                            member: "member-1".into(),
                            actor: "user-1".into(),
                            journal,
                            lifecycle: lifecycle.clone(),
                        },
                    )?;
                    assert_eq!(selected.events.last().unwrap()["type"], "reviewer-selected");
                    Ok(())
                })
                .unwrap();
        }
        let reopened = crate::store::Store::open(&path, vault).unwrap();
        reopened
            .transaction(|tx| {
                let journal =
                    mission_run::get(tx, &reopened, &scope, "member-1", "run-general-store")?
                        .unwrap();
                let count = journal
                    .events
                    .iter()
                    .filter(|event| {
                        event.get("type").and_then(Value::as_str) == Some("reviewer-selected")
                    })
                    .count();
                let replayed = ensure_reviewer_selection_in_tx(
                    tx,
                    &reopened,
                    AuthorizedRun {
                        scope: scope.clone(),
                        member: "member-1".into(),
                        actor: "user-1".into(),
                        journal,
                        lifecycle,
                    },
                )?;
                assert_eq!(count, 1);
                assert_eq!(
                    replayed
                        .events
                        .iter()
                        .filter(|event| {
                            event.get("type").and_then(Value::as_str) == Some("reviewer-selected")
                        })
                        .count(),
                    1
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn human_evaluation_and_general_terminal_persist_across_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("general-terminal.db");
        let vault =
            crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
                .unwrap();
        let scope = DataScope::workspace("workspace-1").unwrap();
        let at = "2026-07-23T10:00:00.000Z";
        {
            let store = crate::store::Store::open(&path, vault.clone()).unwrap();
            store
                .transaction(|tx| {
                    tx.execute(
                        "INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('workspace-1','W',?1,?1)",
                        [at],
                    )?;
                    crate::store::repos::thread::create(
                        tx,
                        &store,
                        &scope,
                        "thread-general-store",
                        None,
                        "General Mission",
                        at,
                        &json!({}),
                    )?;
                    tx.execute(
                        "UPDATE thread SET authority='local',visibility='member-private',
                         owner_member_id='member-1' WHERE workspace_id='workspace-1'
                         AND id='thread-general-store'",
                        [],
                    )?;
                    let mission = json!({
                        "id":"mission-general-store","workspaceId":"workspace-1",
                        "visibility":"member-private","ownerMemberId":"member-1",
                        "authority":"local","schemaVersion":1,"revision":1,
                        "createdByInternalUserId":"user-1","createdAt":at,"updatedAt":at,
                        "status":"ready","executionDepth":"delegated",
                        "currentPlanId":"plan-general-store",
                        "currentPlanRevisionId":"revision-general-store",
                        "outcome":{"title":"Final brief","desiredOutcome":"Create it.",
                            "deliverables":[{"key":"final","description":"the final brief","required":true}]},
                        "scope":{"departmentIds":[],"context":[]},"constraints":[{
                            "key":GENERAL_DECLARED_GRAPH_MARKER,
                            "description":"Use the authenticated native general Mission graph.",
                            "severity":"required","source":"user"
                        }],
                        "acceptance":{"requiresHumanAcceptance":true,"criteria":[{
                            "key":"grounded","description":"The brief is grounded.",
                            "required":true,"evaluator":"human",
                            "evidenceRequired":[],
                            "evidenceFromStepOutputs":true
                        }]}
                    });
                    let plan = json!({
                        "id":"plan-general-store","missionId":"mission-general-store",
                        "status":"current","revision":1,
                        "currentRevisionId":"revision-general-store",
                        "currentRevisionNumber":1,"createdAt":at,"updatedAt":at
                    });
                    let revision = json!({
                        "id":"revision-general-store","planId":"plan-general-store",
                        "missionId":"mission-general-store","planRevisionNumber":1,
                        "reason":"initial","summary":"Produce the final brief.",
                        "bounds":{"maxSteps":1,"maxDependenciesPerStep":0,
                            "maxParallelSteps":1,"maxRevisions":1},
                        "steps":[{"key":"final","kind":"produce","title":"Final brief",
                            "objective":"Produce it.","dependsOnStepKeys":[],
                            "requiredCapabilities":[],"acceptanceCriterionKeys":["grounded"],
                            "optional":false,"expectedOutputs":[{
                                "key":"final","description":"the final brief","required":true,
                                "format":"text/markdown"
                            }]}]
                    });
                    let ready = mission_plan::create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "mission-general-store",
                        "plan-general-store",
                        "revision-general-store",
                        "delegated",
                        &mission,
                        &plan,
                        &revision,
                        at,
                    )?;
                    mission_plan::mark_running(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        &ready,
                        at,
                    )?;
                    let mut run = json!({
                        "id":"run-general-store","workspaceId":"workspace-1",
                        "visibility":"member-private","ownerMemberId":"member-1",
                        "authority":"local","schemaVersion":1,"revision":1,
                        "createdByInternalUserId":"user-1","createdAt":at,"updatedAt":at,
                        "status":"running","executionDepth":"delegated",
                        "initiator":{"kind":"mission","missionId":"mission-general-store"},
                        "parentage":{"kind":"root"},"departmentIds":[],
                        "sourceThreadId":"thread-general-store",
                        "planRevisionId":"revision-general-store",
                        "budget":{"maxWorkers":1,"maxAttempts":1},
                        "currentAttemptNumber":1,
                        "eventHead":{"lastSequence":1,"lastEventId":"event-created"}
                    });
                    let created = json!({
                        "id":"event-created","runId":"run-general-store","type":"run-created",
                        "sequence":1,"attemptNumber":1,"idempotencyKey":"created-general",
                        "payload":{"run":run}
                    });
                    mission_run::create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "run-general-store",
                        "event-created",
                        "created-general",
                        &run,
                        &created,
                        at,
                    )?;
                    let journal = mission_run::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-general-store",
                    )?
                    .unwrap();
                    let lifecycle = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-general-store",
                    )?
                    .unwrap();
                    let prepared = prepare_provider_workers_in_tx(
                        tx,
                        &store,
                        AuthorizedRun {
                            scope: scope.clone(),
                            member: "member-1".into(),
                            actor: "user-1".into(),
                            journal,
                            lifecycle,
                        },
                    )?;
                    assert_eq!(prepared.events.last().unwrap()["type"], "worker-created");
                    assert_eq!(
                        prepared.events.last().unwrap()["payload"]["worker"]["planStepKey"],
                        "final"
                    );
                    let prepared_worker_id = prepared.events.last().unwrap()["payload"]["worker"]
                        ["id"]
                        .as_str()
                        .unwrap()
                        .to_string();
                    let prepared_event_count = prepared.events.len();
                    let replay_journal = mission_run::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-general-store",
                    )?
                    .unwrap();
                    let replay_lifecycle = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-general-store",
                    )?
                    .unwrap();
                    let replayed = prepare_provider_workers_in_tx(
                        tx,
                        &store,
                        AuthorizedRun {
                            scope: scope.clone(),
                            member: "member-1".into(),
                            actor: "user-1".into(),
                            journal: replay_journal,
                            lifecycle: replay_lifecycle,
                        },
                    )?;
                    assert_eq!(replayed.events.len(), prepared_event_count);
                    run = replayed.run;
                    let output_text = "Final cited brief.";
                    let output_hash = format!("{:x}", Sha256::digest(output_text.as_bytes()));
                    let output_reference =
                        mission_worker_output::binding_reference(
                            "workspace-1",
                            "member-1",
                            "run-general-store",
                            &prepared_worker_id,
                            "event-completed",
                            "final",
                            &output_hash,
                        );
                    append_general_store_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-completed",
                        "worker-completed",
                        json!({"workerId":prepared_worker_id,
                            "outputs":[{
                            "key":"final","summary":"Final cited brief.",
                            "valueReference":output_reference
                        }]}),
                        json!({"kind":"system"}),
                        at,
                    )?;
                    mission_worker_output::put(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-general-store",
                        &prepared_worker_id,
                        "event-completed",
                        "final",
                        &output_reference,
                        &output_hash,
                        output_text.len() as i64,
                        &json!({
                            "version":1,"workspaceId":"workspace-1",
                            "ownerMemberId":"member-1","runId":"run-general-store",
                            "workerId":prepared_worker_id,
                            "completionEventId":"event-completed","outputKey":"final",
                            "valueReference":output_reference,"contentHash":output_hash,
                            "sizeBytes":output_text.len() as i64,"text":output_text,
                            "mediaType":"text/markdown","encoding":"utf-8",
                            "observedProvider":"fixture-provider",
                            "providerRouteId":"fixture-route","requestedModel":"fixture-model",
                            "trust":"provider-generated","citations":[],"createdAt":at
                        }),
                        at,
                    )?;
                    let journal =
                        mission_run::get(tx, &store, &scope, "member-1", "run-general-store")?
                            .unwrap();
                    let lifecycle = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-general-store",
                    )?
                    .unwrap();
                    let review_progress =
                        mission_progress_projection(&lifecycle, &journal)
                            .map_err(crate::store::StoreError::Invalid)?;
                    assert_eq!(
                        review_progress["humanReview"]["runId"],
                        "run-general-store"
                    );
                    assert_eq!(
                        review_progress["humanReview"]["criteria"][0]["criterionKey"],
                        "grounded"
                    );
                    let listed = thread_progress_list_in_tx(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "thread-general-store",
                        24,
                    )?;
                    assert_eq!(listed["progress"][0]["runId"], "run-general-store");
                    assert_eq!(
                        listed["progress"][0]["progress"]["steps"][0]["title"],
                        "Final brief"
                    );
                    assert_eq!(listed["unavailableCount"], 0);
                    assert_eq!(
                        thread_progress_list_in_tx(
                            tx,
                            &store,
                            &scope,
                            "member-1",
                            "thread-other",
                            24,
                        )?["progress"],
                        json!([])
                    );
                    let expected_revision = journal.run["revision"].as_i64().unwrap();
                    let expected_sequence = journal.run["eventHead"]["lastSequence"]
                        .as_i64()
                        .unwrap();
                    let mut missing_evidence_lifecycle =
                        mission_plan::MissionPlanLifecycleRow {
                            mission: lifecycle.mission.clone(),
                            plan: lifecycle.plan.clone(),
                            current_revision: lifecycle.current_revision.clone(),
                        };
                    missing_evidence_lifecycle.mission["acceptance"]["criteria"][0]
                        ["evidenceRequired"] = json!(["missing-output"]);
                    let missing_evidence_journal = mission_run::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-general-store",
                    )?
                    .unwrap();
                    let missing_evidence = append_human_evaluation_in_tx(
                        tx,
                        &store,
                        AuthorizedRun {
                            scope: scope.clone(),
                            member: "member-1".into(),
                            actor: "user-1".into(),
                            journal: missing_evidence_journal,
                            lifecycle: missing_evidence_lifecycle,
                        },
                        "grounded",
                        true,
                        expected_revision,
                        expected_sequence,
                    )
                    .unwrap_err();
                    assert!(missing_evidence
                        .to_string()
                        .contains("Required durable evidence is unavailable"));
                    let evaluated = append_human_evaluation_in_tx(
                        tx,
                        &store,
                        AuthorizedRun {
                            scope: scope.clone(),
                            member: "member-1".into(),
                            actor: "user-1".into(),
                            journal,
                            lifecycle,
                        },
                        "grounded",
                        true,
                        expected_revision,
                        expected_sequence,
                    )?;
                    assert_eq!(
                        evaluated.events.last().unwrap()["actor"]["kind"],
                        "internal-user"
                    );
                    assert_eq!(
                        evaluated.events.last().unwrap()["payload"]["evaluation"]["criteria"][0]
                            ["evidenceRefs"],
                        json!([output_reference])
                    );
                    let evaluated_progress =
                        mission_progress_projection(
                            &mission_plan::get(
                                tx,
                                &store,
                                &scope,
                                "member-1",
                                "mission-general-store",
                            )?
                            .unwrap(),
                            &evaluated,
                        )
                        .map_err(crate::store::StoreError::Invalid)?;
                    assert!(evaluated_progress["humanReview"].is_null());
                    let replay_lifecycle = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-general-store",
                    )?
                    .unwrap();
                    let replayed = append_human_evaluation_in_tx(
                        tx,
                        &store,
                        AuthorizedRun {
                            scope: scope.clone(),
                            member: "member-1".into(),
                            actor: "user-1".into(),
                            journal: evaluated,
                            lifecycle: replay_lifecycle,
                        },
                        "grounded",
                        true,
                        expected_revision,
                        expected_sequence,
                    )?;
                    assert_eq!(
                        replayed
                            .events
                            .iter()
                            .filter(|event| {
                                event.get("type").and_then(Value::as_str)
                                    == Some("evaluation-recorded")
                            })
                            .count(),
                        1
                    );
                    let changed_lifecycle = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-general-store",
                    )?
                    .unwrap();
                    let changed_journal = mission_run::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-general-store",
                    )?
                    .unwrap();
                    let changed = append_human_evaluation_in_tx(
                        tx,
                        &store,
                        AuthorizedRun {
                            scope: scope.clone(),
                            member: "member-1".into(),
                            actor: "user-1".into(),
                            journal: changed_journal,
                            lifecycle: changed_lifecycle,
                        },
                        "grounded",
                        false,
                        expected_revision,
                        expected_sequence,
                    )
                    .unwrap_err();
                    assert!(changed
                        .to_string()
                        .contains("changed its durable decision"));
                    let journal = replayed;
                    let lifecycle = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-general-store",
                    )?
                    .unwrap();
                    let mut terminal = derive_general_terminal(&lifecycle, &journal, at)
                        .map_err(crate::store::StoreError::Invalid)?;
                    let authorized = AuthorizedRun {
                        scope: scope.clone(),
                        member: "member-1".into(),
                        actor: "user-1".into(),
                        journal,
                        lifecycle,
                    };
                    let (event_id, event_key) = automatic_coordination_identity(
                        "run-general-store",
                        "run-terminal",
                        "revision-general-store",
                    );
                    let artifact_specs =
                        bind_reviewed_general_artifacts(tx, &store, &authorized, &mut terminal)?;
                    append_general_terminal(
                        tx,
                        &store,
                        &authorized,
                        &terminal,
                        &event_id,
                        &event_key,
                        at,
                    )?;
                    materialize_reviewed_general_artifacts(
                        tx,
                        &store,
                        &authorized,
                        &event_id,
                        &artifact_specs,
                    )?;
                    mission_plan::mark_completed(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        &authorized.lifecycle,
                        &terminal.mission_result,
                        at,
                    )?;
                    Ok(())
                })
                .unwrap();
        }
        let reopened = crate::store::Store::open(&path, vault).unwrap();
        let journal = reopened
            .with_conn(|tx| {
                mission_run::get(tx, &reopened, &scope, "member-1", "run-general-store")
            })
            .unwrap()
            .unwrap();
        let lifecycle = reopened
            .with_conn(|tx| {
                mission_plan::get(tx, &reopened, &scope, "member-1", "mission-general-store")
            })
            .unwrap()
            .unwrap();
        assert_eq!(journal.run["status"], "completed");
        assert_eq!(journal.run["terminalResult"]["outcome"], "succeeded");
        assert_eq!(lifecycle.mission["status"], "completed");
        assert_eq!(
            lifecycle.mission["terminalResult"]["producingRunIds"],
            json!(["run-general-store"])
        );
        let artifact_id = journal.run["terminalResult"]["outputs"][0]["artifactId"]
            .as_str()
            .unwrap()
            .to_string();
        let artifact_version_id = journal.run["terminalResult"]["outputs"][0]["artifactVersionId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(artifact_id.starts_with("mission-reviewed-artifact-"));
        reopened
            .transaction(|tx| {
                let replay_journal =
                    mission_run::get(tx, &reopened, &scope, "member-1", "run-general-store")?
                        .unwrap();
                let replay_lifecycle =
                    mission_plan::get(tx, &reopened, &scope, "member-1", "mission-general-store")?
                        .unwrap();
                let authorized = AuthorizedRun {
                    scope: scope.clone(),
                    member: "member-1".into(),
                    actor: "user-1".into(),
                    journal: replay_journal,
                    lifecycle: replay_lifecycle,
                };
                let mut outputs = authorized.journal.run["terminalResult"]["outputs"].clone();
                let specs =
                    reviewed_general_artifact_specs(tx, &reopened, &authorized, &mut outputs)?;
                assert_eq!(outputs, authorized.journal.run["terminalResult"]["outputs"]);
                materialize_reviewed_general_artifacts(
                    tx,
                    &reopened,
                    &authorized,
                    authorized
                        .journal
                        .run
                        .pointer("/eventHead/lastEventId")
                        .and_then(Value::as_str)
                        .unwrap(),
                    &specs,
                )?;
                let mut changed_binding = specs[0].binding.clone();
                changed_binding.artifact_id.push_str("-changed");
                let changed = artifact::create_reviewed_general_mission_output(
                    tx,
                    &reopened,
                    &PrivateDataScope::for_authenticated_user(
                        scope.clone(),
                        "user-1",
                        Some("member-1"),
                    )?,
                    "member-1",
                    "run-general-store",
                    authorized
                        .journal
                        .run
                        .pointer("/eventHead/lastEventId")
                        .and_then(Value::as_str)
                        .unwrap(),
                    &specs[0].output_key,
                    &specs[0].value_reference,
                    &specs[0].title,
                    &changed_binding,
                )
                .unwrap_err();
                assert!(changed
                    .to_string()
                    .contains("identity does not match its immutable output"));
                let private = PrivateDataScope::for_authenticated_user(
                    scope.clone(),
                    "user-1",
                    Some("member-1"),
                )?;
                let bundle = artifact::get_bundle(tx, &reopened, &private, &artifact_id)?.unwrap();
                assert_eq!(bundle["artifact"]["status"], "accepted");
                assert_eq!(bundle["artifact"]["currentVersionId"], artifact_version_id);
                assert_eq!(
                    bundle["currentVersion"]["inputs"][0]["label"],
                    "Reviewed untrusted Mission output"
                );
                Ok(())
            })
            .unwrap();
    }

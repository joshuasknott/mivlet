    #[test]
    fn cited_terminal_transcript_is_derived_from_durable_mission_facts() {
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-transcript".into(),
            worker_id: "worker-1".into(),
            worker_started_event_id: "event-start".into(),
            route_selected_event_id: "event-route".into(),
            usage_event_id: "event-usage".into(),
            completion_event_id: "event-complete".into(),
            evaluation_event_id: "event-evaluation".into(),
            result_event_id: "event-result".into(),
            failure_event_id: "event-failure".into(),
            idempotency_key: "terminal-1".into(),
            expected_run_revision: 4,
            expected_last_sequence: 3,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({"id":"mission-1","scope":{"sourceThreadId":"thread-1"}}),
            plan: json!({}),
            current_revision: json!({"summary":"Search the connected launch notes."}),
        };
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"sourceThreadId":"thread-1"}),
            events: vec![],
        };
        let receipt = json!({"text":"Launch is planned for Q3 [source-1]."});
        let artifact = crate::store::repos::artifact::AcceptedMissionArtifactBinding {
            artifact_id: "artifact-1".into(),
            artifact_version_id: "artifact-version-1".into(),
        };
        let accepted_event = json!({
            "id":"event-result","type":"run-completed","payload":{"result":{"outputs":[{
                "artifactId":"artifact-1","artifactVersionId":"artifact-version-1"
            }]}}
        });
        let accepted = cited_mission_transcript(
            &journal,
            &lifecycle,
            &binding,
            &receipt,
            &accepted_event,
            Some(&artifact),
        )
        .unwrap();
        assert_eq!(accepted.thread_id, "thread-1");
        assert_eq!(accepted.prompt, "Search the connected launch notes.");
        assert_eq!(accepted.response, "Launch is planned for Q3 [source-1].");
        assert_eq!(accepted.assistant_detail["outcome"], "accepted");
        assert_eq!(accepted.assistant_detail["artifactId"], "artifact-1");
        assert_eq!(
            accepted.user_message_id,
            cited_transcript_identity("run-transcript", "user").0
        );

        let partial_event = json!({
            "id":"event-result","type":"run-failed","payload":{
                "error":{"code":"policy-acceptance-failed"},
                "partial":{"summary":CITED_PARTIAL_ACCEPTANCE_SUMMARY}
            }
        });
        let partial = cited_mission_transcript(
            &journal,
            &lifecycle,
            &binding,
            &receipt,
            &partial_event,
            None,
        )
        .unwrap();
        assert_eq!(partial.assistant_detail["outcome"], "partial");
        assert!(partial.assistant_detail.get("artifactId").is_none());
        assert!(partial
            .response
            .starts_with("Draft preserved, but not accepted:"));

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cited-transcript.db");
        let vault =
            crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
                .unwrap();
        {
            let store = crate::store::Store::open(&path, vault.clone()).unwrap();
            let scope = crate::store::repos::scope::DataScope::workspace("workspace-1").unwrap();
            store
                .transaction(|tx| {
                    tx.execute(
                        "INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('workspace-1','W','t','t')",
                        [],
                    )?;
                    thread::create(
                        tx,
                        &store,
                        &scope,
                        "thread-1",
                        None,
                        "Cited brief",
                        "2026-07-13T12:00:00Z",
                        &json!({}),
                    )?;
                    append_cited_mission_transcript(
                        tx,
                        &store,
                        &scope,
                        &journal,
                        &lifecycle,
                        &binding,
                        &receipt,
                        &accepted_event,
                        Some(&artifact),
                        "2026-07-13T12:01:00Z",
                    )?;
                    for (thread_id, run_id, outcome, status, event_type, summary) in [
                        (
                            "thread-failed",
                            "run-failed",
                            "failed",
                            "failed",
                            "run-failed",
                            "The mission stopped because its only worker failed.",
                        ),
                        (
                            "thread-cancelled",
                            "run-cancelled",
                            "cancelled",
                            "cancelled",
                            "run-cancelled",
                            "The mission stopped after its cancellation request was observed.",
                        ),
                    ] {
                        thread::create(
                            tx,
                            &store,
                            &scope,
                            thread_id,
                            None,
                            "Cited status",
                            "2026-07-13T12:00:00Z",
                            &json!({}),
                        )?;
                        let result_event = if outcome == "failed" {
                            json!({"id":format!("event-{outcome}"),"runId":run_id,
                                "type":event_type,"occurredAt":"2026-07-13T12:02:00Z",
                                "payload":{"error":{"code":"provider-failed"}}})
                        } else {
                            json!({"id":format!("event-{outcome}"),"runId":run_id,
                                "type":event_type,"occurredAt":"2026-07-13T12:02:00Z",
                                "payload":{"cancellation":{"requestKey":"cancel-1"}}})
                        };
                        let terminal_result = json!({"outcome":outcome,"summary":summary,
                            "producingRunIds":[run_id],"outputs":[],"acceptance":[],
                            "completedAt":"2026-07-13T12:02:00Z"});
                        let status_lifecycle = mission_plan::MissionPlanLifecycleRow {
                            mission: json!({"id":format!("mission-{outcome}"),
                                "scope":{"sourceThreadId":thread_id},
                                "terminalResult":terminal_result.clone()}),
                            plan: json!({}),
                            current_revision: json!({"summary":format!("Prompt for {outcome} mission.")}),
                        };
                        let status_journal = mission_run::MissionRunJournalRow {
                            run: json!({"id":run_id,"ownerMemberId":"member-1",
                                "sourceThreadId":thread_id,"status":status,
                                "eventHead":{"lastEventId":format!("event-{outcome}")}}),
                            events: vec![result_event.clone()],
                        };
                        append_cited_terminal_status_transcript(
                            tx,
                            &store,
                            &scope,
                            "member-1",
                            &status_journal,
                            &status_lifecycle,
                            &terminal_result,
                            &result_event,
                            "2026-07-13T12:02:00Z",
                        )?;
                        validate_cited_terminal_status_transcript_replay(
                            tx,
                            &store,
                            &scope,
                            "member-1",
                            &status_journal,
                            &status_lifecycle,
                        )?;
                    }
                    Ok(())
                })
                .unwrap();
        }
        let reopened = crate::store::Store::open(&path, vault).unwrap();
        let scope = crate::store::repos::scope::DataScope::workspace("workspace-1").unwrap();
        let messages = reopened
            .with_conn(|tx| message::list(tx, &reopened, &scope, "thread-1"))
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].content,
            json!("Search the connected launch notes.")
        );
        assert_eq!(messages[1].detail["outcome"], "accepted");
        assert_eq!(
            messages[1].content,
            json!("Launch is planned for Q3 [source-1].")
        );
        let failed_messages = reopened
            .with_conn(|tx| message::list(tx, &reopened, &scope, "thread-failed"))
            .unwrap();
        assert_eq!(failed_messages[1].detail["outcome"], "failed");
        assert_eq!(
            failed_messages[1].content,
            json!("Mission failed: The mission stopped because its only worker failed.")
        );
        let cancelled_messages = reopened
            .with_conn(|tx| message::list(tx, &reopened, &scope, "thread-cancelled"))
            .unwrap();
        assert_eq!(cancelled_messages[1].detail["outcome"], "cancelled");
        assert_eq!(
            cancelled_messages[1].content,
            json!("Mission cancelled: The mission stopped after its cancellation request was observed.")
        );
    }

    fn terminal_approval_journal(decision: &str) -> mission_run::MissionRunJournalRow {
        let approved = decision == "approved";
        mission_run::MissionRunJournalRow {
            run: json!({
                "id":"run-approval","status":if approved{"completed"}else{"partially-completed"},
                "eventHead":{"lastSequence":11,"lastEventId":"event-result"}
            }),
            events: vec![
                json!({
                    "id":"event-request","runId":"run-approval","type":"approval-requested","sequence":9,
                    "previousEventId":"event-checkpoint","payload":{"wait":{"waitKey":"wait-1","proposalHash":"sha256:proposal"}}
                }),
                json!({
                    "id":"event-resolution","runId":"run-approval","type":"approval-resolved","sequence":10,
                    "previousEventId":"event-request","payload":{"resolution":{
                        "waitKey":"wait-1","decision":decision,"acceptedProposalHash":"sha256:proposal"
                    }}
                }),
                if approved {
                    json!({
                        "id":"event-result","runId":"run-approval","type":"run-completed","sequence":11,
                        "previousEventId":"event-resolution","payload":{"result":{"outcome":"succeeded"}}
                    })
                } else {
                    json!({
                        "id":"event-result","runId":"run-approval","type":"run-failed","sequence":11,
                        "previousEventId":"event-resolution","payload":{"error":{"code":"human-acceptance-denied"}}
                    })
                },
            ],
        }
    }

    #[test]
    fn terminal_approval_replay_requires_the_linked_resolution_chain() {
        let approved = terminal_approval_journal("approved");
        assert_eq!(
            terminal_cited_approval_decision(&approved).unwrap(),
            "approved"
        );
        let denied = terminal_approval_journal("denied");
        assert_eq!(terminal_cited_approval_decision(&denied).unwrap(), "denied");

        let mut detached = terminal_approval_journal("approved");
        detached.events.insert(
            1,
            json!({
                "id":"event-resolution-old","runId":"run-approval","type":"approval-resolved","sequence":8,
                "previousEventId":"event-request","payload":{"resolution":{
                    "waitKey":"wait-1","decision":"approved","acceptedProposalHash":"sha256:proposal"
                }}
            }),
        );
        detached.events.last_mut().unwrap()["previousEventId"] = json!("event-resolution-old");
        assert!(terminal_cited_approval_decision(&detached).is_err());

        let mut changed = terminal_approval_journal("approved");
        changed.events[1]["payload"]["resolution"]["decision"] = json!("denied");
        assert!(terminal_cited_approval_decision(&changed).is_err());
    }

    #[test]
    fn cited_acceptance_wait_survives_reopen_and_rejects_detached_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cited-approval-wait.db");
        let vault =
            crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
                .unwrap();
        let at = "2026-07-15T12:00:00Z";
        let text = "The connected launch record confirms Q3 [source-1].";
        let content_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let output_reference = crate::store::repos::mission_worker_output::binding_reference(
            "workspace-1",
            "member-1",
            "run-approval",
            "worker-approval",
            "event-complete",
            "brief",
            &content_hash,
        );
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-approval".into(),
            worker_id: "worker-approval".into(),
            worker_started_event_id: "event-worker-started".into(),
            route_selected_event_id: "event-route".into(),
            usage_event_id: "event-usage".into(),
            completion_event_id: "event-complete".into(),
            evaluation_event_id: "event-evaluation".into(),
            result_event_id: "event-result".into(),
            failure_event_id: "event-failure".into(),
            idempotency_key: "approval-terminal-1".into(),
            expected_run_revision: 7,
            expected_last_sequence: 7,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        let output_receipt = json!({
            "version":2,"workspaceId":"workspace-1","ownerMemberId":"member-1",
            "runId":"run-approval","workerId":"worker-approval",
            "completionEventId":"event-complete","outputKey":"brief",
            "valueReference":output_reference,"contentHash":content_hash,
            "sizeBytes":text.len(),"text":text,"mediaType":"text/markdown","encoding":"utf-8",
            "observedProvider":"openai","providerRouteId":"route-openai",
            "requestedModel":"gpt-5","trust":"provider-generated-with-external-evidence",
            "citations":[{"citationId":"source-1","sourceId":"doc-1","title":"Launch record",
                "snippet":"Q3 launch","uri":"https://example.com/launch",
                "provenance":"connection:doc-1","freshness":"current","trust":"external-untrusted"}],
            "createdAt":at
        });
        {
            let store = crate::store::Store::open(&path, vault.clone()).unwrap();
            let scope = crate::store::repos::scope::DataScope::workspace("workspace-1").unwrap();
            store
                .transaction(|tx| {
                    tx.execute(
                        "INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('workspace-1','W',?1,?1)",
                        [at],
                    )?;
                    thread::create(
                        tx,
                        &store,
                        &scope,
                        "thread-approval",
                        None,
                        "Approval-gated cited brief",
                        at,
                        &json!({}),
                    )?;
                    let mission = json!({
                        "id":"mission-approval","workspaceId":"workspace-1","ownerMemberId":"member-1",
                        "status":"ready","executionDepth":"delegated","revision":1,
                        "currentPlanId":"plan-approval","currentPlanRevisionId":"revision-approval",
                        "createdByInternalUserId":"user-1","createdAt":at,"updatedAt":at,
                        "scope":{"sourceThreadId":"thread-approval","context":[]},
                        "outcome":{"title":"Connected-source cited brief","summary":"Produce one cited brief.",
                            "deliverables":[{"key":"brief","description":"One cited Markdown brief.",
                                "required":true,"format":"text/markdown"}]},
                        "acceptance":{"requiresHumanAcceptance":true,"minimumRequiredCriteria":1,
                            "criteria":[{"key":"cited","description":"Use only attested citations.",
                                "required":true,"evaluator":"policy"}]},
                        "budget":{"maxWorkers":1,"maxDurationMs":120000,"maxInputTokens":32000,
                            "maxOutputTokens":2048,"maxToolCalls":1,"maxAttempts":2}
                    });
                    let plan = json!({
                        "id":"plan-approval","missionId":"mission-approval","status":"current","revision":1,
                        "currentRevisionId":"revision-approval","currentRevisionNumber":1,
                        "createdAt":at,"updatedAt":at
                    });
                    let plan_revision = json!({
                        "id":"revision-approval","planId":"plan-approval","missionId":"mission-approval",
                        "planRevisionNumber":1,"reason":"initial","summary":"Research the connected launch record.",
                        "steps":[{"key":"research","kind":"investigate","title":"Research launch evidence",
                            "objective":"Find the exact connected launch evidence.","dependsOnStepKeys":[],
                            "requiredCapabilities":["knowledge.content.search"],
                            "expectedOutputs":[{"key":"brief","description":"One cited Markdown brief.",
                                "required":true,"format":"text/markdown"}],
                            "acceptanceCriterionKeys":["cited"]}]
                    });
                    let ready = mission_plan::create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "mission-approval",
                        "plan-approval",
                        "revision-approval",
                        "delegated",
                        &mission,
                        &plan,
                        &plan_revision,
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
                    let lifecycle = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-approval",
                    )?
                    .unwrap();
                    let mut run = json!({
                        "id":"run-approval","workspaceId":"workspace-1","ownerMemberId":"member-1",
                        "visibility":"member-private","authority":"local","schemaVersion":1,
                        "status":"running","revision":1,"currentAttemptNumber":1,
                        "missionId":"mission-approval","planRevisionId":"revision-approval",
                        "sourceThreadId":"thread-approval","initiator":{"kind":"mission","missionId":"mission-approval"},
                        "createdByInternalUserId":"user-1","createdAt":at,"updatedAt":at,
                        "eventHead":{"lastSequence":1,"lastEventId":"event-created"}
                    });
                    let created = json!({
                        "id":"event-created","runId":"run-approval","type":"run-created",
                        "sequence":1,"attemptNumber":1,"idempotencyKey":"created-approval"
                    });
                    mission_run::create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "run-approval",
                        "event-created",
                        "created-approval",
                        &run,
                        &created,
                        at,
                    )?;
                    append_approval_fixture_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-worker-created",
                        "worker-created",
                        "worker-created-approval",
                        json!({"worker":{"id":"worker-approval","runId":"run-approval","planStepKey":"research"}}),
                        at,
                    )?;
                    append_approval_fixture_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-worker-started",
                        "worker-started",
                        "worker-started-approval",
                        json!({"workerId":"worker-approval"}),
                        at,
                    )?;
                    append_approval_fixture_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-route",
                        "route-selected",
                        "route-approval",
                        json!({"workerId":"worker-approval","providerId":"openai",
                            "modelReference":"gpt-5","selection":{
                            "providerRouteId":"route-openai","reason":"Selected OpenAI GPT-5 for model.generate."}}),
                        at,
                    )?;
                    append_approval_fixture_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-usage",
                        "usage-recorded",
                        "usage-approval",
                        json!({"usage":{"runId":"run-approval","workerId":"worker-approval",
                            "providerRouteId":"route-openai","modelReference":"gpt-5",
                            "inputTokens":90,"outputTokens":40,"toolCalls":1,"durationMs":1500,
                            "attemptNumber":1,"costs":[]}}),
                        at,
                    )?;
                    append_approval_fixture_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-complete",
                        "worker-completed",
                        "complete-approval",
                        json!({"workerId":"worker-approval","outputs":[{
                            "key":"brief","summary":"Native worker text output","valueReference":output_reference}]}),
                        at,
                    )?;
                    crate::store::repos::mission_worker_output::put(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-approval",
                        "worker-approval",
                        "event-complete",
                        "brief",
                        &output_reference,
                        &content_hash,
                        text.len() as i64,
                        &output_receipt,
                        at,
                    )?;
                    append_approval_fixture_event(
                        tx,
                        &store,
                        &scope,
                        &mut run,
                        "event-evaluation",
                        "evaluation-recorded",
                        "evaluation-approval",
                        json!({"evaluation":{"evaluationKey":"native-policy:event-evaluation",
                            "target":{"kind":"worker","workerId":"worker-approval"},
                            "verdict":"pass","recommendedAction":"accept",
                            "criteria":[{"criterionKey":"cited","passed":true,
                                "evidenceRefs":[output_reference],"summary":"All citations are attested."}]}}),
                        at,
                    )?;
                    let journal = mission_run::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-approval",
                    )?
                    .unwrap();
                    append_cited_acceptance_wait(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        &journal,
                        &lifecycle,
                        &binding,
                        &output_receipt,
                        &output_reference,
                        7,
                        7,
                        at,
                    )?;
                    let waiting = mission_run::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-approval",
                    )?
                    .unwrap();
                    let waiting_mission = mission_plan::get(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "mission-approval",
                    )?
                    .unwrap();
                    assert_eq!(waiting.run["status"], "waiting-approval");
                    assert_eq!(waiting.run["revision"], 9);
                    assert_eq!(waiting.run["eventHead"]["lastSequence"], 9);
                    assert_eq!(waiting_mission.mission["status"], "waiting");
                    assert!(cited_approval_facts(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        &waiting,
                        Some("thread-approval"),
                    )
                    .is_ok());
                    Ok(())
                })
                .unwrap();
        }

        let store = crate::store::Store::open(&path, vault).unwrap();
        let scope = crate::store::repos::scope::DataScope::workspace("workspace-1").unwrap();
        store
            .with_conn(|tx| {
                let journal =
                    mission_run::get(tx, &store, &scope, "member-1", "run-approval")?.unwrap();
                let lifecycle =
                    mission_plan::get(tx, &store, &scope, "member-1", "mission-approval")?.unwrap();
                let facts = cited_approval_facts(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    &journal,
                    Some("thread-approval"),
                )?;
                assert_eq!(journal.run["status"], "waiting-approval");
                assert_eq!(lifecycle.mission["status"], "waiting");
                assert_eq!(facts.worker_started_event_id, "event-worker-started");
                assert_eq!(facts.route_selected_event_id, "event-route");
                assert_eq!(facts.usage_event_id, "event-usage");
                assert_eq!(facts.completion_event_id, "event-complete");
                assert_eq!(facts.evaluation_event_id, "event-evaluation");
                assert_eq!(facts.requested_model, "gpt-5");
                assert_eq!(facts.provider_route_id, "route-openai");
                assert_eq!(facts.token_usage, (90, 40));
                assert_eq!(facts.output.receipt["text"], text);
                Ok(())
            })
            .unwrap();

        assert_approval_event_tamper_rejected(&store, &scope, "event-route", |event| {
            event["payload"]["selection"]["providerRouteId"] = json!("route-detached");
        });
        assert_approval_event_tamper_rejected(&store, &scope, "event-route", |event| {
            event["previousEventId"] = json!("event-created");
        });
        assert_approval_event_tamper_rejected(&store, &scope, "event-usage", |event| {
            event["payload"]["usage"]["attemptNumber"] = json!(2);
        });
        assert_approval_event_tamper_rejected(&store, &scope, "event-usage", |event| {
            event["previousEventId"] = json!("event-worker-started");
        });
        assert_approval_event_tamper_rejected(&store, &scope, "event-complete", |event| {
            event["previousEventId"] = json!("event-route");
        });
        assert_approval_event_tamper_rejected(&store, &scope, "event-evaluation", |event| {
            event["previousEventId"] = json!("event-route");
        });
        let checkpoint_event_id = store
            .with_conn(|tx| {
                let journal =
                    mission_run::get(tx, &store, &scope, "member-1", "run-approval")?.unwrap();
                Ok(journal.events.last().unwrap()["previousEventId"]
                    .as_str()
                    .unwrap()
                    .to_string())
            })
            .unwrap();
        assert_approval_event_tamper_rejected(&store, &scope, &checkpoint_event_id, |event| {
            event["previousEventId"] = json!("event-route");
        });
    }

    #[test]
    fn partial_cited_receipt_projection_is_exact_and_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cited-receipt.db");
        let vault =
            crate::store::vault::Vault::new(&crate::store::vault::MasterKey::generate().unwrap())
                .unwrap();
        let at = "2026-07-13T12:00:00Z";
        let text = "Draft with retained evidence [source-1].";
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let reference = crate::store::repos::mission_worker_output::binding_reference(
            "workspace-1",
            "member-1",
            "run-1",
            "worker-1",
            "event-complete",
            "brief",
            &hash,
        );
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-1".into(),
            worker_id: "worker-1".into(),
            worker_started_event_id: "event-start".into(),
            route_selected_event_id: "event-route".into(),
            usage_event_id: "event-usage".into(),
            completion_event_id: "event-complete".into(),
            evaluation_event_id: "event-evaluation".into(),
            result_event_id: "event-result".into(),
            failure_event_id: "event-failure".into(),
            idempotency_key: "terminal-1".into(),
            expected_run_revision: 3,
            expected_last_sequence: 2,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        {
            let store = crate::store::Store::open(&path, vault.clone()).unwrap();
            let scope = crate::store::repos::scope::DataScope::workspace("workspace-1").unwrap();
            store.transaction(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('workspace-1','W',?1,?1)",
                    [at],
                )?;
                thread::create(tx, &store, &scope, "thread-1", None, "Cited brief", at, &json!({}))?;
                let mission = json!({
                    "id":"mission-1","currentPlanId":"plan-1","currentPlanRevisionId":"revision-1",
                    "scope":{"sourceThreadId":"thread-1"},
                    "budget":{"maxInputTokens":32000,"maxOutputTokens":2048,"maxToolCalls":1,
                        "maxDurationMs":120000,"maxAttempts":1}
                });
                let plan = json!({
                    "id":"plan-1","missionId":"mission-1","currentRevisionId":"revision-1",
                    "currentRevisionNumber":1
                });
                let plan_revision = json!({
                    "id":"revision-1","planId":"plan-1","missionId":"mission-1",
                    "planRevisionNumber":1,"summary":"Search connected work."
                });
                let lifecycle = mission_plan::create(
                    tx, &store, &scope, "member-1", "user-1", "mission-1", "plan-1",
                    "revision-1", "delegated", &mission, &plan, &plan_revision, at,
                )?;
                let mut run = json!({
                    "id":"run-1","workspaceId":"workspace-1","status":"running","revision":1,
                    "sourceThreadId":"thread-1","initiator":{"kind":"mission","missionId":"mission-1"},
                    "createdByInternalUserId":"user-1","eventHead":{"lastSequence":1,"lastEventId":"event-created"}
                });
                let created = json!({
                    "id":"event-created","runId":"run-1","type":"run-created","sequence":1,
                    "idempotencyKey":"created-1"
                });
                mission_run::create(
                    tx, &store, &scope, "member-1", "user-1", "run-1", "event-created",
                    "created-1", &run, &created, at,
                )?;
                let route = json!({
                    "id":"event-route","runId":"run-1","type":"route-selected","sequence":2,
                    "previousEventId":"event-created","idempotencyKey":"route-1",
                    "payload":{"selection":{"providerRouteId":"route-openai","reason":"Selected OpenAI GPT-5 for model.generate."}}
                });
                run["revision"] = json!(2);
                run["eventHead"] = json!({"lastSequence":2,"lastEventId":"event-route"});
                mission_run::append(
                    tx, &store, &scope, "member-1", "run-1", 1, 1, "event-route",
                    "route-selected", "route-1", &route, &run, at,
                )?;
                let usage = json!({
                    "id":"event-usage","runId":"run-1","type":"usage-recorded","sequence":3,
                    "previousEventId":"event-route","attemptNumber":1,"idempotencyKey":"usage-1","payload":{"usage":{
                        "runId":"run-1","workerId":"worker-1","providerRouteId":"route-openai",
                        "modelReference":"gpt-5","inputTokens":90,"outputTokens":40,"toolCalls":1,
                        "durationMs":1500,"attemptNumber":1,"costs":[]}}
                });
                run["revision"] = json!(3);
                run["eventHead"] = json!({"lastSequence":3,"lastEventId":"event-usage"});
                mission_run::append(
                    tx, &store, &scope, "member-1", "run-1", 2, 2, "event-usage",
                    "usage-recorded", "usage-1", &usage, &run, at,
                )?;
                let completion = json!({
                    "id":"event-complete","runId":"run-1","type":"worker-completed","sequence":4,
                    "previousEventId":"event-usage","idempotencyKey":"complete-1","payload":{
                        "workerId":"worker-1","outputs":[{"key":"brief","valueReference":reference}]}
                });
                run["revision"] = json!(4);
                run["eventHead"] = json!({"lastSequence":4,"lastEventId":"event-complete"});
                mission_run::append(
                    tx, &store, &scope, "member-1", "run-1", 3, 3, "event-complete",
                    "worker-completed", "complete-1", &completion, &run, at,
                )?;
                let output_receipt = json!({
                    "version":2,"workspaceId":"workspace-1","ownerMemberId":"member-1","runId":"run-1",
                    "workerId":"worker-1","completionEventId":"event-complete","outputKey":"brief",
                    "valueReference":reference,"contentHash":hash,"sizeBytes":text.len(),"text":text,
                    "mediaType":"text/markdown","encoding":"utf-8","observedProvider":"openai",
                    "providerRouteId":"route-openai","requestedModel":"gpt-5",
                    "trust":"provider-generated-with-external-evidence","citations":[{
                        "citationId":"source-1","sourceId":"doc-1","title":"Plan","snippet":"Evidence",
                        "uri":"https://example.com/plan","provenance":"connection:doc-1",
                        "freshness":"current","trust":"external-untrusted"}],"createdAt":at
                });
                crate::store::repos::mission_worker_output::put(
                    tx, &store, &scope, "member-1", "run-1", "worker-1", "event-complete",
                    "brief", &reference, &hash, text.len() as i64, &output_receipt, at,
                )?;
                let evaluation = json!({
                    "id":"event-evaluation","runId":"run-1","type":"evaluation-recorded","sequence":5,
                    "previousEventId":"event-complete","idempotencyKey":"evaluation-1","payload":{
                        "evaluation":{"verdict":"fail","target":{"kind":"worker","workerId":"worker-1"}}}
                });
                run["revision"] = json!(5);
                run["eventHead"] = json!({"lastSequence":5,"lastEventId":"event-evaluation"});
                mission_run::append(
                    tx, &store, &scope, "member-1", "run-1", 4, 4, "event-evaluation",
                    "evaluation-recorded", "evaluation-1", &evaluation, &run, at,
                )?;
                let result = json!({
                    "id":"event-result","runId":"run-1","type":"run-failed","sequence":6,
                    "previousEventId":"event-evaluation","idempotencyKey":"result-1","occurredAt":at,
                    "payload":{"error":{"code":"policy-acceptance-failed"},"partial":{
                        "summary":CITED_PARTIAL_ACCEPTANCE_SUMMARY,
                        "completedOutputs":[{"key":"brief","valueReference":reference}]}}
                });
                run["status"] = json!("partially-completed");
                run["revision"] = json!(6);
                run["eventHead"] = json!({"lastSequence":6,"lastEventId":"event-result"});
                mission_run::append(
                    tx, &store, &scope, "member-1", "run-1", 5, 5, "event-result",
                    "run-failed", "result-1", &result, &run, at,
                )?;
                let journal = mission_run::get(tx, &store, &scope, "member-1", "run-1")?.unwrap();
                append_cited_mission_transcript(
                    tx, &store, &scope, &journal, &lifecycle, &binding, &output_receipt,
                    &result, None, at,
                )?;
                Ok(())
            }).unwrap();
        }
        let store = crate::store::Store::open(&path, vault).unwrap();
        let scope = crate::store::repos::scope::DataScope::workspace("workspace-1").unwrap();
        let (receipt, forged_rejected) = store
            .with_conn(|tx| {
                let messages = message::list(tx, &store, &scope, "thread-1")?;
                let receipt =
                    project_cited_mission_receipt(tx, &store, &scope, "member-1", &messages[1])?;
                let mut forged = messages[1].clone();
                forged.detail["outcome"] = json!("accepted");
                forged.detail["artifactId"] = json!("forged-artifact");
                forged.detail["artifactVersionId"] = json!("forged-version");
                Ok((
                    receipt,
                    project_cited_mission_receipt(tx, &store, &scope, "member-1", &forged).is_err(),
                ))
            })
            .unwrap();
        assert_eq!(receipt["acceptanceStatus"], "not-accepted");
        assert_eq!(receipt["provider"], "openai");
        assert_eq!(receipt["inputTokens"], 90);
        assert_eq!(receipt["durationMs"], 1500);
        assert_eq!(receipt["attemptNumber"], 1);
        assert_eq!(receipt["sourceCount"], 1);
        assert_eq!(receipt["maxOutputTokens"], 2048);
        assert!(receipt.get("costAmount").is_none());
        assert!(forged_rejected);
    }

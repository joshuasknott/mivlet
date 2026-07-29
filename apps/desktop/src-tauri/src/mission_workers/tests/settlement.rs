    #[test]
    fn parallel_native_settlement_is_limited_to_two_independent_evidence_free_markdown_steps() {
        let worker = |id: &str, step: &str, key: &str| {
            json!({
                "id":id,"runId":"run-parallel","planRevisionId":"revision-parallel",
                "planStepKey":step,"tools":[],"context":[],"capabilityIds":[],
                "capabilityGrantIds":[],"outputContract":{"slots":[{"key":key,
                    "description":"Bounded Markdown brief","required":true,"format":"text/markdown"}],
                    "includeEvidence":false,"includeUncertainty":true,"delivery":"run-result"}
            })
        };
        let worker_a = worker("worker-a", "approach-a", "approach-a");
        let worker_b = worker("worker-b", "approach-b", "approach-b");
        let journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":worker_a}}),
                json!({"type":"worker-created","payload":{"worker":worker_b}}),
            ],
        };
        let step = |key: &str, output_key: &str| {
            json!({"key":key,"kind":"produce","title":key,"objective":format!("Create {key}"),
            "dependsOnStepKeys":[],
            "requiredCapabilities":[],"acceptanceCriterionKeys":[],"expectedOutputs":[{
                "key":output_key,"description":"Bounded Markdown brief","required":true,
                "format":"text/markdown"}],"optional":false,
                "estimatedBudget":{"maxDurationMs":90000,"maxInputTokens":16000,
                    "maxOutputTokens":2048,"maxToolCalls":1,"maxAttempts":1}})
        };
        let mut lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({"executionDepth":"multi-worker","budget":{"maxWorkers":2,"maxAttempts":1},
                "constraints":[{"key":"native:parallel-approaches:v1","severity":"required",
                    "source":"orchestrator"}],
                "acceptance":{"requiresHumanAcceptance":false,"minimumRequiredCriteria":1,
                    "criteria":[{"key":"both-approaches","required":true,"evaluator":"policy"}]}}),
            plan: json!({}),
            current_revision: json!({"id":"revision-parallel","bounds":{"maxSteps":3,
                "maxDependenciesPerStep":2,"maxParallelSteps":2,"maxRevisions":1},"steps":[
                step("approach-a", "approach-a"), step("approach-b", "approach-b"),
                {"key":"compare","kind":"synthesize","title":"Compare approaches",
                    "objective":"Join both outputs","dependsOnStepKeys":["approach-a","approach-b"],
                    "requiredCapabilities":[],"acceptanceCriterionKeys":["both-approaches"],
                    "expectedOutputs":[{"key":"comparison","description":"Comparison",
                        "required":true,"format":"text/markdown"}],"optional":false,
                    "estimatedBudget":{"maxDurationMs":5000,"maxInputTokens":1,
                        "maxOutputTokens":1,"maxToolCalls":1,"maxAttempts":1}}
            ]}),
        };
        let mut binding = NativeWorkerExecutionBinding {
            run_id: "run-parallel".into(),
            worker_id: "worker-a".into(),
            worker_started_event_id: "start-a".into(),
            route_selected_event_id: "route-a".into(),
            usage_event_id: "usage-a".into(),
            completion_event_id: "complete-a".into(),
            evaluation_event_id: "evaluation-a".into(),
            result_event_id: "result-a".into(),
            failure_event_id: "failure-a".into(),
            idempotency_key: "terminal-a".into(),
            expected_run_revision: 4,
            expected_last_sequence: 3,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        let target = journal.events[0].pointer("/payload/worker").unwrap();
        let output = native_output_spec(target).unwrap().unwrap();
        assert!(is_parallel_evidence_free_markdown_run(
            &journal,
            &lifecycle,
            &binding,
            target,
            Some(&output)
        ));
        lifecycle.current_revision["steps"][1]["dependsOnStepKeys"] = json!(["approach-a"]);
        assert!(!is_parallel_evidence_free_markdown_run(
            &journal,
            &lifecycle,
            &binding,
            target,
            Some(&output)
        ));
        lifecycle.current_revision["steps"][1]["dependsOnStepKeys"] = json!([]);
        binding.tool_evidence = Some(NativeWorkerToolEvidenceBinding {
            tool_event_id: "tool-a".into(),
            output_reference: "mission-tool:v1:a".into(),
        });
        assert!(!is_parallel_evidence_free_markdown_run(
            &journal,
            &lifecycle,
            &binding,
            target,
            Some(&output)
        ));
    }

    #[test]
    fn parallel_evidence_free_workers_accept_only_exact_sibling_head_advancement() {
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-parallel".into(),
            worker_id: "worker-a".into(),
            worker_started_event_id: "start-a".into(),
            route_selected_event_id: "route-a".into(),
            usage_event_id: "usage-a".into(),
            completion_event_id: "complete-a".into(),
            evaluation_event_id: "evaluation-a".into(),
            result_event_id: "result-a".into(),
            failure_event_id: "failure-a".into(),
            idempotency_key: "terminal-a".into(),
            expected_run_revision: 4,
            expected_last_sequence: 3,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        let output = NativeWorkerOutputSpec {
            key: "brief-a".into(),
            description: "First brief".into(),
            include_uncertainty: true,
            include_evidence: false,
        };
        let worker_b = json!({
            "id":"worker-b","planStepKey":"step-b","tools":[],"context":[],
            "capabilityIds":[],"capabilityGrantIds":[],
            "outputContract":{"slots":[{"key":"brief-b","description":"Second brief",
                "required":true,"format":"text/markdown"}],"includeEvidence":false,
                "includeUncertainty":true,"delivery":"run-result"}
        });
        let prefix = vec![
            json!({"id":"start-a","runId":"run-parallel","type":"worker-started","sequence":2,
                "previousEventId":"created-a","payload":{"workerId":"worker-a"}}),
            json!({"id":"route-a","runId":"run-parallel","type":"route-selected","sequence":3,
                "previousEventId":"start-a","payload":{"workerId":"worker-a",
                    "selection":{"providerRouteId":"provider-route-a"}}}),
            json!({"id":"created-b","runId":"run-parallel","type":"worker-created","sequence":4,
                "previousEventId":"route-a","payload":{"worker":worker_b}}),
            json!({"id":"start-b","runId":"run-parallel","type":"worker-started","sequence":5,
                "previousEventId":"created-b","payload":{"workerId":"worker-b"}}),
            json!({"id":"route-b","runId":"run-parallel","type":"route-selected","sequence":6,
                "previousEventId":"start-b","payload":{"workerId":"worker-b","providerId":"openai",
                    "modelReference":"gpt-5","selection":{"providerRouteId":"provider-route-b"}}}),
        ];
        let live = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":7,
                "eventHead":{"lastSequence":6,"lastEventId":"route-b"}}),
            events: prefix.clone(),
        };
        assert!(validate_native_completion_head(&live, &binding, true, false).is_ok());
        assert!(validate_native_completion_head(&live, &binding, false, false).is_err());
        let mut join_binding = binding.clone();
        join_binding.expected_run_revision = 8;
        join_binding.expected_last_sequence = 7;
        let mut join_events = vec![json!({"id":"created-a","runId":"run-parallel",
            "type":"worker-created","sequence":1,"payload":{"worker":{"id":"worker-a"}}})];
        join_events.extend(live.events.clone());
        join_events.push(
            json!({"id":"join-open","runId":"run-parallel","type":"join-opened",
            "sequence":7,"previousEventId":"route-b","payload":{"join":{"joinKey":"join-1",
                "status":"open","strategy":"all","workerIds":["worker-a","worker-b"],
                "allowFailedWorkers":false,"satisfiedWorkerIds":[],"failedWorkerIds":[]}}}),
        );
        let joined = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":8,
                "eventHead":{"lastSequence":7,"lastEventId":"join-open"}}),
            events: join_events,
        };
        assert!(validate_native_completion_head(&joined, &join_binding, true, false).is_ok());
        let joined_usage = json!({"id":"usage-a","runId":"run-parallel","type":"usage-recorded",
            "sequence":8,"previousEventId":"join-open","idempotencyKey":"worker-usage:terminal-a",
            "payload":{"usage":{"runId":"run-parallel","workerId":"worker-a"}}});
        let joined_terminal = json!({"id":"complete-a","runId":"run-parallel","type":"worker-completed",
            "sequence":9,"previousEventId":"usage-a","idempotencyKey":"worker-complete:terminal-a",
            "correlationKey":"native-worker-completion:v1:run-revision:8",
            "payload":{"workerId":"worker-a","outputs":[{"key":"brief-a",
                "summary":"Native worker text output","valueReference":"mission-output:v1:brief-a"}]}});
        let mut joined_events = joined.events;
        joined_events.extend([joined_usage, joined_terminal.clone()]);
        let joined_settled = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":10,
                "eventHead":{"lastSequence":9,"lastEventId":"complete-a"}}),
            events: joined_events,
        };
        assert!(exact_native_terminal_replay_with_mode(
            &joined_settled,
            &joined_terminal,
            &join_binding,
            Some(&output),
            true,
        )
        .is_ok());

        let usage_a = json!({"id":"usage-a","runId":"run-parallel","type":"usage-recorded",
            "sequence":7,"previousEventId":"route-b","idempotencyKey":"worker-usage:terminal-a",
            "payload":{"usage":{"runId":"run-parallel","workerId":"worker-a"}}});
        let terminal_a = json!({"id":"complete-a","runId":"run-parallel","type":"worker-completed",
            "sequence":8,"previousEventId":"usage-a","idempotencyKey":"worker-complete:terminal-a",
            "correlationKey":"native-worker-completion:v1:run-revision:4",
            "payload":{"workerId":"worker-a","outputs":[{"key":"brief-a",
                "summary":"Native worker text output","valueReference":"mission-output:v1:brief-a"}]}});
        let usage_b = json!({"id":"usage-b","runId":"run-parallel","type":"usage-recorded",
            "sequence":9,"previousEventId":"complete-a","payload":{"usage":{
                "runId":"run-parallel","workerId":"worker-b"}}});
        let terminal_b = json!({"id":"complete-b","runId":"run-parallel","type":"worker-completed",
            "sequence":10,"previousEventId":"usage-b","payload":{"workerId":"worker-b","outputs":[]}});
        let mut events = prefix;
        events.extend([usage_a, terminal_a.clone(), usage_b, terminal_b]);
        let settled = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":11,
                "eventHead":{"lastSequence":10,"lastEventId":"complete-b"}}),
            events,
        };
        assert!(exact_native_terminal_replay_with_mode(
            &settled,
            &terminal_a,
            &binding,
            Some(&output),
            true,
        )
        .is_ok());

        let mut tampered = mission_run::MissionRunJournalRow {
            run: settled.run.clone(),
            events: settled.events.clone(),
        };
        tampered.events[4]["previousEventId"] = json!("created-b");
        assert!(exact_native_terminal_replay_with_mode(
            &tampered,
            &terminal_a,
            &binding,
            Some(&output),
            true,
        )
        .is_err());
        let mut colliding = mission_run::MissionRunJournalRow {
            run: live.run.clone(),
            events: live.events.clone(),
        };
        colliding.events[4]["id"] = json!("failure-a");
        colliding.run["eventHead"]["lastEventId"] = json!("failure-a");
        assert!(validate_native_completion_head(&colliding, &binding, true, false).is_err());
        let mut cancelled = settled;
        cancelled.run["status"] = json!("cancelling");
        assert!(exact_native_terminal_replay_with_mode(
            &cancelled,
            &terminal_a,
            &binding,
            Some(&output),
            true,
        )
        .is_err());

        let cancellation = json!({"requestKey":"stop-parallel","scope":"run",
            "requestedAt":"t","requestedByInternalUserId":"user-1","mode":"cooperative"});
        let cancellation_event = json!({"id":"cancel-parallel","runId":"run-parallel",
            "type":"cancellation-requested","sequence":7,"previousEventId":"route-b",
            "idempotencyKey":"cancel:stop-parallel","payload":{"cancellation":cancellation}});
        let mut cancelling_events = live.events.clone();
        cancelling_events.push(cancellation_event.clone());
        let cancelling = mission_run::MissionRunJournalRow {
            run: json!({"status":"cancelling","revision":8,"cancellation":cancellation,
                "eventHead":{"lastSequence":7,"lastEventId":"cancel-parallel"}}),
            events: cancelling_events,
        };
        assert!(validate_parallel_native_cancellation_head(&cancelling, &binding).is_ok());
        let cancelled_event = json!({"id":"result-a","runId":"run-parallel","type":"run-cancelled",
            "sequence":8,"previousEventId":"cancel-parallel","idempotencyKey":"worker-cancel:terminal-a",
            "correlationKey":"native-worker-completion:v1:run-revision:4",
            "payload":{"cancellation":cancellation}});
        let mut cancelled_events = cancelling.events;
        cancelled_events.push(cancelled_event.clone());
        let mut cancelled = mission_run::MissionRunJournalRow {
            run: json!({"status":"cancelled","revision":9,"cancellation":cancellation,
                "eventHead":{"lastSequence":8,"lastEventId":"result-a"}}),
            events: cancelled_events,
        };
        assert!(exact_native_terminal_replay_with_mode(
            &cancelled,
            &cancelled_event,
            &binding,
            Some(&output),
            true,
        )
        .is_ok());
        cancelled.events[5]["payload"]["cancellation"]["requestKey"] = json!("stop-other");
        assert!(exact_native_terminal_replay_with_mode(
            &cancelled,
            &cancelled_event,
            &binding,
            Some(&output),
            true,
        )
        .is_err());
    }

    #[test]
    fn general_provider_workers_accept_only_terminal_sibling_advancement() {
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-general".into(),
            worker_id: "worker-a".into(),
            worker_started_event_id: "start-a".into(),
            route_selected_event_id: "route-a".into(),
            usage_event_id: "usage-a".into(),
            completion_event_id: "complete-a".into(),
            evaluation_event_id: "evaluation-a".into(),
            result_event_id: "result-a".into(),
            failure_event_id: "failure-a".into(),
            idempotency_key: "terminal-a".into(),
            expected_run_revision: 8,
            expected_last_sequence: 7,
            checkpoint_event_id: Some("checkpoint-general".into()),
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        let worker = |id: &str| {
            json!({"id":id,"tools":[],"capabilityIds":[],"capabilityGrantIds":[],
                "routePreference":{"policy":"automatic","providerRouteIds":[],
                    "allowFallback":false},
                "placementPreference":{"policy":"require",
                    "executionNodeIds":["local-desktop"],"locality":"local",
                    "allowTransfer":false},
                "outputContract":{"slots":[],"includeEvidence":false,
                    "includeUncertainty":true,"delivery":"run-result"}})
        };
        let events = vec![
            json!({"type":"worker-created","payload":{"worker":worker("worker-a")}}),
            json!({"type":"worker-created","payload":{"worker":worker("worker-b")}}),
            json!({"id":"start-a","runId":"run-general","type":"worker-started",
                "sequence":3,"previousEventId":"created-b",
                "payload":{"workerId":"worker-a"}}),
            json!({"id":"route-a","runId":"run-general","type":"route-selected",
                "sequence":4,"previousEventId":"start-a",
                "payload":{"workerId":"worker-a"}}),
            json!({"id":"start-b","runId":"run-general","type":"worker-started",
                "sequence":5,"previousEventId":"route-a",
                "payload":{"workerId":"worker-b"}}),
            json!({"id":"route-b","runId":"run-general","type":"route-selected",
                "sequence":6,"previousEventId":"start-b",
                "payload":{"workerId":"worker-b"}}),
            json!({"id":"checkpoint-general","runId":"run-general",
                "type":"checkpoint-created","sequence":7,"previousEventId":"route-b",
                "payload":{"checkpoint":{"attemptNumber":1,
                    "stateStorage":"portable-redacted","executionNodeId":"local-desktop",
                    "replayBoundary":{"durableThroughSequence":6,
                        "resumeAfterEventId":"route-b"}}}}),
            json!({"id":"usage-b","runId":"run-general","type":"usage-recorded",
                "sequence":8,"previousEventId":"checkpoint-general",
                "payload":{"usage":{"workerId":"worker-b"}}}),
            json!({"id":"complete-b","runId":"run-general","type":"worker-completed",
                "sequence":9,"previousEventId":"usage-b",
                "payload":{"workerId":"worker-b"}}),
        ];
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":10,"currentAttemptNumber":1,
                "eventHead":{"lastSequence":9,"lastEventId":"complete-b"}}),
            events,
        };
        assert!(validate_native_completion_head(&journal, &binding, false, true).is_ok());

        let mut restored_binding = binding.clone();
        restored_binding.expected_run_revision = 9;
        restored_binding.expected_last_sequence = 8;
        restored_binding.checkpoint_restore_event_id = Some("restore-general".into());
        let mut restored_events = journal.events[..7].to_vec();
        restored_events.push(json!({"id":"restore-general","runId":"run-general",
            "type":"checkpoint-restored","sequence":8,"previousEventId":"checkpoint-general",
            "attemptNumber":2,"payload":{"checkpointEventId":"checkpoint-general",
                "newAttemptNumber":2}}));
        let restored = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":9,"currentAttemptNumber":2,
                "eventHead":{"lastSequence":8,"lastEventId":"restore-general"}}),
            events: restored_events,
        };
        assert!(validate_native_completion_head(&restored, &restored_binding, false, true).is_ok());

        let mut substituted = journal;
        substituted.events[7]["payload"]["usage"]["workerId"] = json!("worker-a");
        assert!(validate_native_completion_head(&substituted, &binding, false, true).is_err());
    }

    #[test]
    fn general_provider_shape_accepts_only_exact_connected_search_evidence() {
        let connected_worker = json!({
            "id":"worker-a",
            "tools":[{"toolName":"connection-read","access":"read",
                "purpose":"Search connected sources","required":true}],
            "capabilityIds":["knowledge.content.search"],
            "capabilityGrantIds":["grant-search-1"],
            "routePreference":{"policy":"require","providerRouteIds":["route-a"],
                "allowFallback":false},
            "placementPreference":{"policy":"require",
                "executionNodeIds":["local-desktop"],"locality":"local",
                "allowTransfer":false},
            "outputContract":{"slots":[{"key":"a","description":"A","required":true,
                "format":"text/markdown"}],"includeEvidence":true,
                "includeUncertainty":true,"delivery":"run-result"}
        });
        let plain_worker = json!({
            "id":"worker-b","tools":[],"capabilityIds":[],"capabilityGrantIds":[],
            "routePreference":{"policy":"require","providerRouteIds":["route-b"],
                "allowFallback":false},
            "placementPreference":{"policy":"require",
                "executionNodeIds":["local-desktop"],"locality":"local",
                "allowTransfer":false},
            "outputContract":{"slots":[{"key":"b","description":"B","required":true,
                "format":"text/markdown"}],"includeEvidence":false,
                "includeUncertainty":true,"delivery":"run-result"}
        });
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({"executionDepth":"multi-worker"}),
            plan: json!({}),
            current_revision: json!({}),
        };
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":connected_worker}}),
                json!({"type":"worker-created","payload":{"worker":plain_worker}}),
            ],
        };
        let mut binding = NativeWorkerExecutionBinding {
            run_id: "run-general".into(),
            worker_id: "worker-a".into(),
            worker_started_event_id: "start-a".into(),
            route_selected_event_id: "route-a".into(),
            usage_event_id: "usage-a".into(),
            completion_event_id: "complete-a".into(),
            evaluation_event_id: "evaluation-a".into(),
            result_event_id: "result-a".into(),
            failure_event_id: "failure-a".into(),
            idempotency_key: "terminal-a".into(),
            expected_run_revision: 8,
            expected_last_sequence: 7,
            checkpoint_event_id: Some("checkpoint-general".into()),
            checkpoint_restore_event_id: None,
            tool_evidence: Some(NativeWorkerToolEvidenceBinding {
                tool_event_id: "tool-a".into(),
                output_reference: "mission-tool:v1:evidence".into(),
            }),
        };
        let output = NativeWorkerOutputSpec {
            key: "a".into(),
            description: "A".into(),
            include_uncertainty: true,
            include_evidence: true,
        };
        assert!(is_general_concurrent_provider_run(
            &journal,
            &lifecycle,
            &binding,
            Some(&output)
        ));
        binding.tool_evidence = None;
        assert!(!is_general_concurrent_provider_run(
            &journal,
            &lifecycle,
            &binding,
            Some(&output)
        ));
        binding.tool_evidence = Some(NativeWorkerToolEvidenceBinding {
            tool_event_id: "tool-a".into(),
            output_reference: "mission-tool:v1:evidence".into(),
        });
        journal.events[0]["payload"]["worker"]["capabilityGrantIds"] = json!([]);
        assert!(!is_general_concurrent_provider_run(
            &journal,
            &lifecycle,
            &binding,
            Some(&output)
        ));
    }

    #[test]
    fn native_retry_replay_is_bound_to_one_exact_failed_attempt() {
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-1".into(),
            worker_id: "worker-1".into(),
            worker_started_event_id: "event-start".into(),
            route_selected_event_id: "event-route".into(),
            usage_event_id: "event-usage".into(),
            completion_event_id: "event-completion".into(),
            evaluation_event_id: "event-evaluation".into(),
            result_event_id: "event-retry".into(),
            failure_event_id: "event-attempt".into(),
            idempotency_key: "terminal-1".into(),
            expected_run_revision: 8,
            expected_last_sequence: 7,
            checkpoint_event_id: Some("event-checkpoint".into()),
            checkpoint_restore_event_id: None,
            tool_evidence: Some(NativeWorkerToolEvidenceBinding {
                tool_event_id: "event-tool".into(),
                output_reference: "mission-tool:v1:evidence".into(),
            }),
        };
        let error = json!({"code":"native-provider-stream-interrupted","category":"provider",
            "message":"The native provider stream ended unexpectedly.","retryable":true});
        let retry = json!({
            "id":"event-retry","type":"retry-scheduled","sequence":10,
            "previousEventId":"event-attempt","attemptNumber":1,"occurredAt":"t2",
            "idempotencyKey":"worker-retry:terminal-1",
            "payload":{"nextAttemptNumber":2,"error":error}
        });
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"id":"run-1","status":"retrying","revision":11,
                "selectedRoute":{"providerRouteId":"route-1"},
                "eventHead":{"lastSequence":10,"lastEventId":"event-retry"}}),
            events: vec![
                json!({"id":"event-route","type":"route-selected",
                    "payload":{"selection":{"providerRouteId":"route-1"}}}),
                json!({"id":"event-usage","type":"usage-recorded","sequence":8,
                    "previousEventId":"event-checkpoint","attemptNumber":1,
                    "idempotencyKey":"worker-usage:terminal-1","payload":{"usage":{
                        "runId":"run-1","workerId":"worker-1","providerRouteId":"route-1",
                        "modelReference":"gpt-5","toolCalls":1,"durationMs":900,
                        "attemptNumber":1,"costs":[]}}}),
                json!({"id":"event-attempt","type":"attempt-finished","sequence":9,
                    "previousEventId":"event-usage","attemptNumber":1,"occurredAt":"t2",
                    "idempotencyKey":"worker-attempt-finished:terminal-1","payload":{"attempt":{
                        "runId":"run-1","attemptNumber":1,"status":"failed","retryReason":error,
                        "selectedRoute":{"providerRouteId":"route-1"},
                        "selectedPlacement":{"executionNodeId":"execution-node-local-desktop"},
                        "startedAt":"t1","finishedAt":"t2"}}}),
                retry.clone(),
            ],
        };
        validate_native_retry_replay(&journal, &retry, &binding, "gpt-5", 120_000, 1, 2).unwrap();
        let mut changed = retry;
        changed["payload"]["error"]["message"] = json!("Changed");
        assert!(
            validate_native_retry_replay(&journal, &changed, &binding, "gpt-5", 120_000, 1, 2)
                .is_err()
        );
    }

    #[test]
    fn cited_receipt_selects_only_the_terminal_retry_attempt_usage() {
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({"currentAttemptNumber":2}),
            events: vec![
                json!({"type":"usage-recorded","payload":{"usage":{
                    "attemptNumber":1,"durationMs":900}}}),
                json!({"type":"retry-scheduled","attemptNumber":1,"payload":{
                    "nextAttemptNumber":2,"error":{"retryable":true}}}),
                json!({"type":"usage-recorded","payload":{"usage":{
                    "attemptNumber":2,"inputTokens":125,"outputTokens":84,"durationMs":800}}}),
            ],
        };
        let usage = select_cited_terminal_usage(&journal).unwrap();
        assert_eq!(usage["attemptNumber"], 2);
        assert_eq!(usage["inputTokens"], 125);
        journal.events.remove(1);
        assert!(select_cited_terminal_usage(&journal).is_err());
    }

    #[test]
    fn native_cancellation_requires_the_exact_request_head_and_terminal_replay() {
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-1".into(),
            worker_id: "worker-1".into(),
            worker_started_event_id: "event-3".into(),
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
        let cancellation = json!({
            "requestKey":"stop-1","requestedAt":"t","requestedByInternalUserId":"user-1",
            "scope":"run","mode":"cooperative","reason":"User requested stop."
        });
        let requested = json!({
            "id":"event-stop","runId":"run-1","type":"cancellation-requested","sequence":4,
            "previousEventId":"event-route","idempotencyKey":"cancel:stop-1",
            "payload":{"cancellation":cancellation}
        });
        let cancelling = mission_run::MissionRunJournalRow {
            run: json!({"status":"cancelling","revision":5,"cancellation":cancellation,
                "eventHead":{"lastSequence":4,"lastEventId":"event-stop"}}),
            events: vec![requested.clone()],
        };
        assert!(validate_native_cancellation_head(&cancelling, &binding).is_ok());

        let terminal = json!({
            "id":"event-result","runId":"run-1","type":"run-cancelled","sequence":5,
            "previousEventId":"event-stop","idempotencyKey":"worker-cancel:terminal-1",
            "correlationKey":"native-worker-completion:v1:run-revision:4",
            "payload":{"cancellation":cancellation}
        });
        let mut settled = mission_run::MissionRunJournalRow {
            run: json!({"status":"cancelled","revision":6,"cancellation":cancellation,
                "eventHead":{"lastSequence":5,"lastEventId":"event-result"}}),
            events: vec![requested, terminal.clone()],
        };
        assert!(exact_native_cancellation_replay(&settled, &terminal, &binding).is_ok());
        settled.events[1]["payload"]["cancellation"]["requestKey"] = json!("stop-other");
        assert!(exact_native_cancellation_replay(&settled, &settled.events[1], &binding).is_err());
    }

    #[test]
    fn native_completion_accepts_only_the_exact_durable_checkpoint_head() {
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
            expected_run_revision: 6,
            expected_last_sequence: 5,
            checkpoint_event_id: Some("event-checkpoint".into()),
            checkpoint_restore_event_id: None,
            tool_evidence: Some(NativeWorkerToolEvidenceBinding {
                tool_event_id: "event-tool".into(),
                output_reference: "mission-tool:v1:evidence".into(),
            }),
        };
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":6,"currentAttemptNumber":1,
                "eventHead":{"lastSequence":5,"lastEventId":"event-checkpoint"}}),
            events: vec![
                json!({"id":"event-start","type":"worker-started","sequence":2,
                    "payload":{"workerId":"worker-1"}}),
                json!({"id":"event-route","type":"route-selected","sequence":3,
                    "previousEventId":"event-start"}),
                json!({"id":"event-tool","type":"tool-call-completed","sequence":4,
                    "previousEventId":"event-route"}),
                json!({"id":"event-checkpoint","type":"checkpoint-created","sequence":5,
                    "previousEventId":"event-tool","payload":{"checkpoint":{"attemptNumber":1,
                    "replayBoundary":{"durableThroughSequence":4,"resumeAfterEventId":"event-tool"}}}}),
            ],
        };
        assert!(validate_native_completion_head(&journal, &binding, false, false).is_ok());
        let mut restored_binding = binding.clone();
        restored_binding.expected_run_revision = 7;
        restored_binding.expected_last_sequence = 6;
        restored_binding.checkpoint_restore_event_id = Some("event-restore".into());
        let mut restored = mission_run::MissionRunJournalRow {
            run: journal.run.clone(),
            events: journal.events.clone(),
        };
        restored.run = json!({"status":"running","revision":7,"currentAttemptNumber":2,
            "eventHead":{"lastSequence":6,"lastEventId":"event-restore"}});
        restored
            .events
            .push(json!({"id":"event-restore","type":"checkpoint-restored",
            "sequence":6,"previousEventId":"event-checkpoint","attemptNumber":2,
            "payload":{"checkpointEventId":"event-checkpoint","newAttemptNumber":2}}));
        assert!(
            validate_native_completion_head(&restored, &restored_binding, false, false).is_ok()
        );
        restored.events[4]["payload"]["checkpointEventId"] = json!("event-other");
        assert!(
            validate_native_completion_head(&restored, &restored_binding, false, false).is_err()
        );
        let mut changed = journal;
        changed.events[3]["payload"]["checkpoint"]["replayBoundary"]["durableThroughSequence"] =
            json!(3);
        assert!(validate_native_completion_head(&changed, &binding, false, false).is_err());
    }

    #[test]
    fn policy_result_replay_requires_exact_terminal_acceptance_outcome() {
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
            expected_run_revision: 4,
            expected_last_sequence: 3,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: Some(NativeWorkerToolEvidenceBinding {
                tool_event_id: "event-tool".into(),
                output_reference: "mission-tool:v1:evidence".into(),
            }),
        };
        let output = NativeWorkerOutputSpec {
            key: "brief".into(),
            description: "Brief".into(),
            include_uncertainty: true,
            include_evidence: true,
        };
        let terminal = json!({"id":"event-complete","runId":"run-1","type":"worker-completed","sequence":5,
            "payload":{"workerId":"worker-1","outputs":[{"key":"brief","summary":"Native worker text output","valueReference":"mission-output:v1:brief"}]}});
        let evaluation = json!({"id":"event-evaluation","runId":"run-1","type":"evaluation-recorded","sequence":6,
            "previousEventId":"event-complete","idempotencyKey":"worker-evaluation:terminal-1",
            "payload":{"evaluation":{"target":{"kind":"worker","workerId":"worker-1"},"verdict":"fail",
                "criteria":[{"criterionKey":"cited","passed":false}]}}});
        let failed = json!({"id":"event-result","runId":"run-1","type":"run-failed","sequence":7,
            "previousEventId":"event-evaluation","idempotencyKey":"run-result:terminal-1","payload":{
                "error":{"code":"policy-acceptance-failed","category":"validation","retryable":false},
                "partial":{"completedOutputs":[{"key":"brief","valueReference":"mission-output:v1:brief"}]}}});
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"partially-completed","eventHead":{"lastEventId":"event-result"}}),
            events: vec![terminal.clone(), evaluation.clone(), failed.clone()],
        };
        assert!(
            validate_native_result_replay(&journal, &terminal, &binding, Some(&output), true)
                .is_ok()
        );
        let mut mismatched = journal;
        mismatched.events[2]["payload"]["error"]["category"] = json!("provider");
        assert!(validate_native_result_replay(
            &mismatched,
            &terminal,
            &binding,
            Some(&output),
            true
        )
        .is_err());
        assert!(validate_native_result_replay(
            &mismatched,
            &terminal,
            &binding,
            Some(&output),
            false
        )
        .is_ok());
    }

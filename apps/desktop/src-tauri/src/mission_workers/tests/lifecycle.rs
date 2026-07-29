    #[test]
    fn worker_builder_clamps_budget_and_rejects_undeclared_context() {
        let mission = json!({"workspaceId":"workspace-1","scope":{"context":[{"kind":"knowledge","reference":"source-1"}]},"budget":{"maxToolCalls":4,"maxCost":{"amount":"5.00","currencyCode":"USD"}}});
        let revision = json!({"id":"revision-1"});
        let step = json!({"key":"search","kind":"investigate","title":"Search","objective":"Find evidence","requiredCapabilities":[],"expectedOutputs":[],"acceptanceCriterionKeys":[],"estimatedBudget":{"maxToolCalls":2,"maxCost":{"amount":"2.50","currencyCode":"USD"}}});
        let input = MissionWorkerCreateInput {
            run_id: "run-1".into(),
            event_id: "event-2".into(),
            idempotency_key: "one".into(),
            expected_run_revision: 2,
            expected_last_sequence: 1,
            worker_id: "worker-1".into(),
            step_key: "search".into(),
            context: vec![
                json!({"reference":{"kind":"knowledge","reference":"source-1"},"purpose":"Evidence","required":true}),
            ],
            grants: vec![],
        };
        let built = build_worker(
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input,
            &[],
            "user-1",
            "member-1",
            "t",
        )
        .unwrap();
        assert_eq!(built["budget"]["maxToolCalls"], 2);
        assert_eq!(built["budget"]["maxCost"]["amount"], "2.50");
        assert_eq!(built["context"][0]["trust"], "untrusted");
        let mut changed = input;
        changed.context = vec![
            json!({"reference":{"kind":"knowledge","reference":"other"},"purpose":"Hidden","required":true}),
        ];
        assert!(build_worker(
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &changed,
            &[],
            "user-1",
            "member-1",
            "t"
        )
        .is_err());
    }

    #[test]
    fn worker_slot_requires_dependencies_and_unique_bounded_assignments() {
        let mission = json!({"executionDepth":"multi-worker","budget":{"maxWorkers":1}});
        let revision = json!({"bounds":{"maxSteps":3,"maxParallelSteps":2}});
        let step = json!({"key":"write","dependsOnStepKeys":["search"]});
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{"id":"worker-search","planStepKey":"search"}}}),
            ],
        };
        let input = MissionWorkerCreateInput {
            run_id: "run-1".into(),
            event_id: "event-3".into(),
            idempotency_key: "write".into(),
            expected_run_revision: 3,
            expected_last_sequence: 2,
            worker_id: "worker-write".into(),
            step_key: "write".into(),
            context: vec![],
            grants: vec![],
        };
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_err());
        journal
            .events
            .push(json!({"type":"worker-completed","payload":{"workerId":"worker-search"}}));
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_ok());
        journal.events.push(json!({"type":"worker-created","payload":{"worker":{"id":"worker-other","planStepKey":"other"}}}));
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_err());
    }

    #[test]
    fn worker_slot_requires_the_exact_satisfied_join_for_multiple_dependencies() {
        let mission = json!({"executionDepth":"multi-worker","budget":{"maxWorkers":4}});
        let revision = json!({"id":"revision-join","bounds":{"maxSteps":4,"maxParallelSteps":3}});
        let step = json!({
            "key":"combine",
            "kind":"compose",
            "dependsOnStepKeys":["search","draft"]
        });
        let input = MissionWorkerCreateInput {
            run_id: "run-join".into(),
            event_id: "event-combine".into(),
            idempotency_key: "combine".into(),
            expected_run_revision: 6,
            expected_last_sequence: 5,
            worker_id: "worker-combine".into(),
            step_key: "combine".into(),
            context: vec![],
            grants: vec![],
        };
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{"id":"worker-search","planStepKey":"search"}}}),
                json!({"type":"worker-created","payload":{"worker":{"id":"worker-draft","planStepKey":"draft"}}}),
                json!({"type":"worker-completed","payload":{"workerId":"worker-search"}}),
            ],
        };
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_err());

        let join_key =
            crate::mission_coordination::coordination_join_key("revision-join", "combine");
        journal
            .events
            .push(json!({"type":"join-resolved","payload":{"join":{
                "joinKey":join_key,"status":"satisfied",
                "workerIds":["worker-draft","worker-search"]
            }}}));
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_err());

        journal.events.last_mut().unwrap()["payload"]["join"]["workerIds"] =
            json!(["worker-search", "worker-draft"]);
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_ok());

        let coordinate_step =
            json!({"key":"coordinate","kind":"coordinate","dependsOnStepKeys":[]});
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &coordinate_step,
            &input
        )
        .is_err());
    }

    #[test]
    fn worker_start_is_first_only_and_replays_exact_event_identity() {
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"created","revision":3,"eventHead":{"lastSequence":2,"lastEventId":"event-2"}}),
            events: vec![json!({"type":"worker-created","payload":{"worker":{"id":"worker-1"}}})],
        };
        let input = MissionWorkerStartInput {
            run_id: "run-1".into(),
            worker_id: "worker-1".into(),
            run_start_event_id: Some("event-3".into()),
            worker_started_event_id: "event-4".into(),
            route_selected_event_id: "event-5".into(),
            provider_id: "openai".into(),
            model_reference: "gpt-5".into(),
            route_selection: crate::models::ProviderRouteSelection {
                provider_route_id: "provider-route:v2:openai:test".into(),
                selected_at: "2026-07-13T00:00:00Z".into(),
                reason: "Selected OpenAI GPT-5 for model.generate; quality unobserved; cost unobserved; latency unobserved; healthy route.".into(),
                fallback_from_provider_route_id: None,
                boundary_policy_ref: Some(crate::backends::native_provider_route_boundary("openai")),
                observation: None,
                quality: None,
                cost: None,
            },
            idempotency_key: "start-1".into(),
            expected_run_revision: 3,
            expected_last_sequence: 2,
        };
        assert!(validate_start_head(&journal, &input).is_ok());
        let event = json!({"id":"event-4","runId":"run-1","type":"worker-started","sequence":4,"previousEventId":"event-3","payload":{"workerId":"worker-1"}});
        assert!(exact_start_replay(&event, &input).is_ok());
        let route = json!({"id":"event-5","runId":"run-1","type":"route-selected","sequence":5,"previousEventId":"event-4","payload":{"workerId":"worker-1","providerId":"openai","modelReference":"gpt-5","selection":input.route_selection}});
        assert!(exact_route_replay(&route, &input).is_ok());
        journal.events.push(event);
        assert!(validate_start_head(&journal, &input).is_err());
    }

    #[test]
    fn native_completion_request_is_exact_objective_only_and_outputless() {
        let body = json!({
            "model":"gpt-5","messages":[{"role":"user","content":"Inspect health"}],
            "max_completion_tokens":50,"stream":true,"stream_options":{"include_usage":true}
        });
        assert!(
            validate_openai_compatible_worker_body(&body, "gpt-5", "Inspect health", 50).is_ok()
        );
        let mut widened = body;
        widened["tools"] = json!([]);
        assert!(
            validate_openai_compatible_worker_body(&widened, "gpt-5", "Inspect health", 50)
                .is_err()
        );
    }

    #[test]
    fn anthropic_and_gemini_worker_requests_are_exact_and_tool_free() {
        let anthropic = json!({
            "model":"claude-sonnet-4-5","max_tokens":50,"stream":true,
            "messages":[{"role":"user","content":"Inspect health"}]
        });
        assert!(validate_anthropic_worker_body(
            &anthropic,
            "claude-sonnet-4-5",
            "Inspect health",
            50
        )
        .is_ok());
        let mut anthropic_with_tool = anthropic;
        anthropic_with_tool["tools"] = json!([]);
        assert!(validate_anthropic_worker_body(
            &anthropic_with_tool,
            "claude-sonnet-4-5",
            "Inspect health",
            50
        )
        .is_err());

        let gemini = json!({
            "contents":[{"role":"user","parts":[{"text":"Inspect health"}]}],
            "generationConfig":{"maxOutputTokens":50}
        });
        assert!(validate_gemini_worker_body(&gemini, "Inspect health", 50).is_ok());
        let mut gemini_with_tool = gemini;
        gemini_with_tool["tools"] = json!([]);
        assert!(validate_gemini_worker_body(&gemini_with_tool, "Inspect health", 50).is_err());
    }

    #[test]
    fn native_output_contract_allows_only_one_required_markdown_result() {
        let worker = json!({"outputContract":{
            "slots":[{"key":"brief","description":"A concise brief","required":true,"format":"text/markdown"}],
            "includeEvidence":false,"includeUncertainty":true,"delivery":"run-result"
        }});
        let spec = native_output_spec(&worker).unwrap().unwrap();
        assert_eq!(spec.key, "brief");
        assert_eq!(
            native_worker_prompt("Research", Some(&spec), None),
            "Objective:\nResearch\n\nRequired output (brief; text/markdown):\nA concise brief\n\nReturn one Markdown result only.\nState material uncertainty explicitly in the Markdown result."
        );
        let mut cited = worker;
        cited["outputContract"]["includeEvidence"] = json!(true);
        assert!(
            native_output_spec(&cited)
                .unwrap()
                .unwrap()
                .include_evidence
        );
    }

    #[test]
    fn native_usage_timing_is_bounded_and_attempt_fenced() {
        assert!(validate_native_attempt_budget(2, 2).is_ok());
        assert!(validate_native_attempt_budget(1, 2).is_err());
        assert!(validate_native_usage_timing(120_000, 2, 1_250, 2, false).is_ok());
        assert!(validate_native_usage_timing(120_000, 2, 120_000, 2, true).is_ok());
        assert!(validate_native_usage_timing(120_000, 2, 119_999, 2, true).is_err());
        assert!(validate_native_usage_timing(120_000, 2, 120_001, 2, false).is_err());
        assert!(validate_native_usage_timing(120_000, 2, 1_250, 1, false).is_err());
    }

    #[test]
    fn native_error_contract_requires_closed_static_facts() {
        for (code, message) in [
            (
                "native-provider-transport-failed",
                "The native provider connection failed after retrying.",
            ),
            (
                "native-provider-temporarily-unavailable",
                "The native provider remained unavailable after retrying.",
            ),
            (
                "native-provider-stream-interrupted",
                "The native provider stream ended unexpectedly.",
            ),
        ] {
            assert!(native_contract_error_valid(&json!({
                "code":code,"category":"provider","message":message,"retryable":true
            })));
        }
        assert!(native_contract_error_valid(&json!({
            "code":"native-provider-request-rejected","category":"provider",
            "message":"The native provider rejected the request.","retryable":false
        })));
        assert!(!native_contract_error_valid(&json!({
            "code":"native-provider-request-rejected","category":"provider",
            "message":"The native provider rejected the request.","retryable":true
        })));
        assert!(!native_contract_error_valid(&json!({
            "code":"native-provider-stream-interrupted","category":"provider",
            "message":"The native provider stream ended unexpectedly.","retryable":true,
            "unexpected":"field"
        })));
    }

    #[test]
    fn cited_brief_accepts_only_exact_mapped_external_evidence() {
        let evidence = json!({"result":{"degraded":false,"citations":[{
            "citationId":"source-1","sourceId":"doc-1","title":"Launch plan",
            "snippet":"Ship in Q3","uri":"https://example.com/launch","provenance":"Notion",
            "freshness":"2026-07-11T20:00:00Z","trust":"external-untrusted"
        }]}});
        let valid = "The launch is planned for Q3 [source-1].\n\n## Sources\n- [source-1] Launch plan — https://example.com/launch";
        assert_eq!(validate_cited_brief(valid, &evidence).unwrap().len(), 1);
        assert!(validate_cited_brief("Invented [source-2].\n\n## Sources", &evidence).is_err());
        assert!(validate_cited_brief("Uncited claim.\n\n## Sources", &evidence).is_err());
        let mut degraded = evidence;
        degraded["result"]["degraded"] = json!(true);
        assert!(validate_cited_brief(valid, &degraded).is_err());
    }

    #[test]
    fn native_completion_replay_is_bound_to_the_original_run_revision() {
        let binding = NativeWorkerExecutionBinding {
            run_id: "run-1".into(),
            worker_id: "worker-1".into(),
            worker_started_event_id: "event-3".into(),
            route_selected_event_id: "event-route".into(),
            usage_event_id: "event-usage".into(),
            completion_event_id: "event-4".into(),
            evaluation_event_id: "event-evaluation".into(),
            result_event_id: "event-result".into(),
            failure_event_id: "event-5".into(),
            idempotency_key: "terminal-1".into(),
            expected_run_revision: 4,
            expected_last_sequence: 3,
            checkpoint_event_id: None,
            checkpoint_restore_event_id: None,
            tool_evidence: None,
        };
        let mut event = json!({
            "id":"event-4","runId":"run-1","type":"worker-completed",
            "previousEventId":"event-route","sequence":4,
            "idempotencyKey":"worker-complete:terminal-1",
            "correlationKey":"native-worker-completion:v1:run-revision:4",
            "payload":{"workerId":"worker-1","outputs":[]}
        });
        assert!(exact_native_terminal_replay(&event, &binding, None).is_ok());
        event["correlationKey"] = json!("native-worker-completion:v1:run-revision:3");
        assert!(exact_native_terminal_replay(&event, &binding, None).is_err());
        let failed = json!({
            "id":"event-5","runId":"run-1","type":"worker-failed",
            "previousEventId":"event-route","sequence":4,
            "idempotencyKey":"worker-fail:terminal-1",
            "correlationKey":"native-worker-completion:v1:run-revision:4",
            "payload":{"workerId":"worker-1","error":{
                "code":"native-provider-request-rejected","category":"provider",
                "message":"The native provider rejected the request.",
                "retryable":false
            }}
        });
        assert!(exact_native_terminal_replay(&failed, &binding, None).is_ok());
        let usage = json!({
            "id":"event-usage","runId":"run-1","type":"usage-recorded","sequence":4,
            "previousEventId":"event-route","attemptNumber":1,"idempotencyKey":"worker-usage:terminal-1",
            "payload":{"usage":{"usageKey":"native-usage:event-usage","runId":"run-1",
                "workerId":"worker-1","providerRouteId":"provider-route-1","modelReference":"gpt-5","inputTokens":12,
                "outputTokens":3,"toolCalls":0,"durationMs":1500,"attemptNumber":1,"costs":[{"amount":{"amount":"0.000045","currencyCode":"USD"},
                "provenance":"fable-calculated","pricingReference":"https://developers.openai.com/api/docs/models/gpt-5|reviewed=2026-07-13|standard-input-usd-per-1m=1.25|standard-output-usd-per-1m=10"}],"measuredAt":"t"}}
        });
        let terminal = json!({
            "id":"event-4","runId":"run-1","type":"worker-completed","sequence":5,
            "previousEventId":"event-usage","idempotencyKey":"worker-complete:terminal-1",
            "correlationKey":"native-worker-completion:v1:run-revision:4",
            "payload":{"workerId":"worker-1","outputs":[]}
        });
        let journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"id":"event-route","type":"route-selected","payload":{"providerId":"openai","selection":{"providerRouteId":"provider-route-1"}}}),
                usage.clone(),
                terminal.clone(),
            ],
        };
        assert!(exact_native_terminal_replay(&terminal, &binding, None).is_ok());
        assert!(validate_usage_replay(&journal, &terminal, &binding, "gpt-5", 120_000, 1).is_ok());
        let mut wrong_timing = usage.clone();
        wrong_timing["payload"]["usage"]["attemptNumber"] = json!(2);
        let wrong_timing_journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"id":"event-route","type":"route-selected","payload":{"providerId":"openai","selection":{"providerRouteId":"provider-route-1"}}}),
                wrong_timing,
                terminal.clone(),
            ],
        };
        assert!(validate_usage_replay(
            &wrong_timing_journal,
            &terminal,
            &binding,
            "gpt-5",
            120_000,
            1,
        )
        .is_err());
        assert_eq!(
            exact_model_costs("openai", "gpt-5", 12, 3)[0]["amount"]["amount"],
            "0.000045"
        );
        assert!(exact_model_costs("openai", "gpt-5.2", 12, 3).is_empty());
        assert!(exact_model_costs("xai", "gpt-5", 12, 3).is_empty());
        let budget_failure = json!({
            "id":"event-5","runId":"run-1","type":"worker-failed","sequence":5,
            "previousEventId":"event-usage","idempotencyKey":"worker-fail:terminal-1",
            "correlationKey":"native-worker-completion:v1:run-revision:4",
            "payload":{"workerId":"worker-1","error":{
                "code":"native-worker-token-budget-exceeded","category":"budget-exceeded",
                "message":"The native provider usage exceeded the worker token budget.",
                "retryable":false
            }}
        });
        let failed_journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"id":"event-route","type":"route-selected","payload":{"providerId":"openai","selection":{"providerRouteId":"provider-route-1"}}}),
                usage.clone(),
                budget_failure.clone(),
            ],
        };
        assert!(exact_native_terminal_replay(&budget_failure, &binding, None).is_ok());
        assert!(validate_usage_replay(
            &failed_journal,
            &budget_failure,
            &binding,
            "gpt-5",
            120_000,
            1,
        )
        .is_ok());
        let mut duration_usage = usage.clone();
        duration_usage["payload"]["usage"]["durationMs"] = json!(120_000);
        let mut duration_failure = budget_failure.clone();
        duration_failure["payload"]["error"] = json!({
            "code":"native-worker-duration-budget-exceeded",
            "category":"budget-exceeded",
            "message":"The native provider exceeded the worker duration budget.",
            "retryable":false
        });
        let duration_failed_journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"id":"event-route","type":"route-selected","payload":{"providerId":"openai","selection":{"providerRouteId":"provider-route-1"}}}),
                duration_usage.clone(),
                duration_failure.clone(),
            ],
        };
        assert!(exact_native_terminal_replay(&duration_failure, &binding, None).is_ok());
        assert!(validate_usage_replay(
            &duration_failed_journal,
            &duration_failure,
            &binding,
            "gpt-5",
            120_000,
            1,
        )
        .is_ok());
        duration_usage["payload"]["usage"]["durationMs"] = json!(119_999);
        let early_duration_failure_journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"id":"event-route","type":"route-selected","payload":{"providerId":"openai","selection":{"providerRouteId":"provider-route-1"}}}),
                duration_usage,
                duration_failure.clone(),
            ],
        };
        assert!(validate_usage_replay(
            &early_duration_failure_journal,
            &duration_failure,
            &binding,
            "gpt-5",
            120_000,
            1,
        )
        .is_err());
        let run_failure = json!({
            "id":"event-result","runId":"run-1","type":"run-failed","sequence":6,
            "previousEventId":"event-5","idempotencyKey":"run-result:terminal-1",
            "payload":{"error":budget_failure.pointer("/payload/error").unwrap()}
        });
        let terminal_failed_journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"failed","eventHead":{"lastEventId":"event-result"}}),
            events: vec![budget_failure.clone(), run_failure],
        };
        assert!(validate_native_result_replay(
            &terminal_failed_journal,
            &budget_failure,
            &binding,
            None,
            true
        )
        .is_ok());
        let live = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","revision":4,"eventHead":{"lastSequence":3,"lastEventId":"event-route"}}),
            events: vec![
                json!({"id":"event-3","type":"worker-started","payload":{"workerId":"worker-1"}}),
                json!({"id":"event-route","type":"route-selected","previousEventId":"event-3","payload":{"workerId":"worker-1"}}),
            ],
        };
        assert!(validate_native_completion_head(&live, &binding, false, false).is_ok());
        let mut colliding = binding.clone();
        colliding.evaluation_event_id = colliding.completion_event_id.clone();
        assert!(validate_native_completion_head(&live, &colliding, false, false).is_err());
    }

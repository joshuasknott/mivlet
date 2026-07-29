    #[test]
    fn all_any_and_quorum_resolve_only_from_durable_terminal_facts() {
        let workers = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let completed = BTreeSet::from(["a".to_string()]);
        let failed = BTreeSet::from(["b".to_string()]);
        assert_eq!(
            resolve_status(
                "any",
                None,
                false,
                &workers,
                &completed,
                &BTreeSet::new(),
                false,
                false
            ),
            Some("satisfied")
        );
        assert_eq!(
            resolve_status("all", None, false, &workers, &completed, &failed, false, false),
            Some("cancelled")
        );
        assert_eq!(
            resolve_status(
                "quorum",
                Some(2),
                true,
                &workers,
                &completed,
                &failed,
                false,
                false
            ),
            Some("satisfied")
        );
        assert_eq!(
            resolve_status(
                "quorum",
                Some(3),
                true,
                &workers,
                &BTreeSet::new(),
                &BTreeSet::new(),
                false,
                false
            ),
            None
        );
        assert_eq!(
            resolve_status(
                "quorum",
                Some(3),
                true,
                &workers,
                &BTreeSet::new(),
                &BTreeSet::new(),
                true,
                false
            ),
            Some("timed-out")
        );
    }

    #[test]
    fn provider_worker_is_derived_from_the_selected_plan_without_authority() {
        let scope = DataScope::workspace("workspace-1").unwrap();
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "id":"mission-1","workspaceId":"workspace-1","visibility":"member-private",
                "ownerMemberId":"member-1","authority":"local","schemaVersion":1,
                "createdByInternalUserId":"user-1",
                "budget":{"maxOutputTokens":3000,"maxAttempts":2},
                "dataBoundary":{
                    "allowedProviderRouteIds":["route-1","route-2"],
                    "allowedExecutionNodeIds":["local-desktop"]
                }
            }),
            plan: json!({}),
            current_revision: json!({"id":"revision-1"}),
        };
        let mut authorized = AuthorizedRun {
            scope,
            member: "member-1".into(),
            actor: "user-1".into(),
            journal: mission_run::MissionRunJournalRow {
                run: json!({
                    "id":"run-1","budget":{"maxWorkers":2,"maxOutputTokens":5000,
                        "maxCost":{"amount":"2.00","currencyCode":"USD"}}
                }),
                events: vec![],
            },
            lifecycle,
        };
        let step = json!({
            "key":"draft","kind":"produce","title":"Prepare the draft",
            "objective":"Prepare one bounded draft.","requiredCapabilities":[],
            "expectedOutputs":[{"key":"draft","description":"The draft","required":true}],
            "acceptanceCriterionKeys":["complete"],"estimatedBudget":{"maxOutputTokens":1000}
        });
        let worker =
            derived_provider_worker(&authorized, &step, "2026-07-23T10:00:00.000Z").unwrap();
        assert_eq!(
            worker["id"],
            deterministic_worker_id("run-1", "revision-1", "draft")
        );
        assert_eq!(worker["budget"]["maxOutputTokens"], 1000);
        assert_eq!(worker["budget"]["maxAttempts"], 1);
        assert_eq!(worker["budget"]["maxCost"]["amount"], "2.00");
        assert_eq!(worker["role"]["kind"], "specialist");
        assert_eq!(worker["capabilityIds"], json!([]));
        assert_eq!(worker["capabilityGrantIds"], json!([]));
        assert_eq!(worker["tools"], json!([]));
        assert_eq!(worker["routePreference"]["policy"], "require");
        assert_eq!(
            worker["routePreference"]["providerRouteIds"],
            json!(["route-1", "route-2"])
        );
        assert_eq!(worker["routePreference"]["allowFallback"], false);
        assert_eq!(worker["placementPreference"]["policy"], "require");
        assert_eq!(
            worker["placementPreference"]["executionNodeIds"],
            json!(["local-desktop"])
        );
        assert_eq!(worker["placementPreference"]["locality"], "local");
        assert_eq!(worker["placementPreference"]["allowTransfer"], false);
        assert_eq!(worker["outputContract"]["includeEvidence"], true);

        let capability_step = json!({
            "key":"search","kind":"investigate","title":"Search","objective":"Search.",
            "requiredCapabilities":["knowledge.content.search"],"expectedOutputs":[],
            "acceptanceCriterionKeys":[]
        });
        assert!(
            derived_provider_worker(&authorized, &capability_step, "2026-07-23T10:00:00.000Z")
                .unwrap_err()
                .contains("explicit native grant composition")
        );

        authorized.lifecycle.mission["dataBoundary"]["allowedExecutionNodeIds"] =
            json!(["hosted-node"]);
        assert!(
            derived_provider_worker(&authorized, &step, "2026-07-23T10:00:00.000Z")
                .unwrap_err()
                .contains("does not permit local desktop execution")
        );
    }

    #[test]
    fn reviewer_selection_is_derived_from_exact_plan_acceptance_and_assignment() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "id":"mission-1","workspaceId":"workspace-1","visibility":"member-private",
                "ownerMemberId":"member-1","authority":"local","schemaVersion":1,
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
                "id":"revision-1",
                "steps":[
                    {"key":"draft","kind":"produce","acceptanceCriterionKeys":[]},
                    {"key":"review","kind":"review","acceptanceCriterionKeys":["quality"]}
                ]
            }),
        };
        let reviewer = json!({
            "id":"worker-review","runId":"run-1","planRevisionId":"revision-1",
            "planStepKey":"review","workspaceId":"workspace-1","ownerMemberId":"member-1",
            "authority":"local","role":{"kind":"reviewer"}
        });
        let mut authorized = AuthorizedRun {
            scope: DataScope::workspace("workspace-1").unwrap(),
            member: "member-1".into(),
            actor: "user-1".into(),
            journal: mission_run::MissionRunJournalRow {
                run: json!({
                    "id":"run-1","workspaceId":"workspace-1",
                    "ownerMemberId":"member-1","authority":"local",
                    "status":"running","executionDepth":"multi-worker"
                }),
                events: vec![json!({
                    "type":"worker-created","payload":{"worker":reviewer}
                })],
            },
            lifecycle,
        };
        assert_eq!(
            derive_reviewer_selection(&authorized).unwrap(),
            Some(json!({
                "reviewStepKey":"review",
                "reviewerWorkerId":"worker-review",
                "justification":["declared-worker-acceptance"],
                "criterionKeys":["quality"],
                "authority":"declared-worker-evaluator",
                "policyRef":"native-policy:mission-review:v1"
            }))
        );

        authorized.lifecycle.current_revision["steps"][1]["acceptanceCriterionKeys"] = json!([]);
        assert!(derive_reviewer_selection(&authorized)
            .unwrap_err()
            .contains("bind exactly"));
        authorized.lifecycle.current_revision["steps"][1]["acceptanceCriterionKeys"] =
            json!(["quality"]);
        authorized.journal.events.clear();
        assert!(derive_reviewer_selection(&authorized)
            .unwrap_err()
            .contains("one exact reviewer"));
    }

    #[test]
    fn user_declared_review_is_selected_only_as_an_advisory_worker() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "id":"mission-1","workspaceId":"workspace-1",
                "constraints":[{
                    "key":GENERAL_DECLARED_GRAPH_MARKER,
                    "severity":"required","source":"user"
                }],
                "acceptance":{"criteria":[{
                    "key":"human-final","evaluator":"human","required":true
                }]}
            }),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-1",
                "steps":[{
                    "key":"review","kind":"review","acceptanceCriterionKeys":[]
                }]
            }),
        };
        let reviewer = json!({
            "id":"worker-review","runId":"run-1","planRevisionId":"revision-1",
            "planStepKey":"review","workspaceId":"workspace-1",
            "ownerMemberId":"member-1","authority":"local",
            "role":{"kind":"reviewer"}
        });
        let mut authorized = AuthorizedRun {
            scope: DataScope::workspace("workspace-1").unwrap(),
            member: "member-1".into(),
            actor: "user-1".into(),
            journal: mission_run::MissionRunJournalRow {
                run: json!({
                    "id":"run-1","status":"running","executionDepth":"multi-worker",
                    "planRevisionId":"revision-1","workspaceId":"workspace-1",
                    "ownerMemberId":"member-1","authority":"local"
                }),
                events: vec![json!({
                    "type":"worker-created","payload":{"worker":reviewer}
                })],
            },
            lifecycle,
        };

        let selected = derive_reviewer_selection(&authorized).unwrap().unwrap();
        assert_eq!(selected["reviewStepKey"], "review");
        assert_eq!(selected["reviewerWorkerId"], "worker-review");
        assert_eq!(
            selected["justification"],
            json!(["user-requested-advisory"])
        );
        assert_eq!(selected["criterionKeys"], json!([]));
        assert_eq!(selected["authority"], "advisory");
        assert_eq!(
            selected["policyRef"],
            "native-policy:mission-advisory-review:v1"
        );

        authorized.lifecycle.current_revision["steps"][0]["acceptanceCriterionKeys"] =
            json!(["human-final"]);
        assert!(derive_reviewer_selection(&authorized)
            .unwrap_err()
            .contains("cannot claim"));
    }

    #[test]
    fn progress_projection_derives_ready_work_usage_and_terminal_acceptance() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "outcome":{
                    "title":"Compare approaches",
                    "desiredOutcome":"Choose a practical direction."
                },
                "acceptance":{"criteria":[{
                    "key":"both","description":"Both approaches are present.",
                    "required":true,"evaluator":"policy"
                }]}
            }),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-progress",
                "summary":"Develop two options, then compare them.",
                "bounds":{"maxParallelSteps":2},
                "steps":[
                    {"key":"approach-a","kind":"compose","title":"Approach A",
                        "objective":"Develop the practical option.","dependsOnStepKeys":[]},
                    {"key":"approach-b","kind":"compose","title":"Approach B",
                        "objective":"Develop a distinct alternative.","dependsOnStepKeys":[]},
                    {"key":"combine","kind":"coordinate","title":"Combine",
                        "objective":"Compare both options.",
                        "dependsOnStepKeys":["approach-a","approach-b"]}
                ]
            }),
        };
        let join_key = coordination_join_key("revision-progress", "combine");
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({
                "status":"running",
                "budget":{"maxWorkers":2,"maxInputTokens":100,"maxOutputTokens":50,
                    "maxToolCalls":0,"maxDurationMs":1000,"maxAttempts":1}
            }),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-a","planStepKey":"approach-a"
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-b","planStepKey":"approach-b"
                }}}),
                json!({"type":"worker-started","payload":{"workerId":"worker-a"}}),
                json!({"type":"usage-recorded","payload":{"usage":{
                    "workerId":"worker-a","inputTokens":12,"outputTokens":3,
                    "toolCalls":0,"durationMs":1500,"costs":[]
                }}}),
                json!({"type":"worker-completed","payload":{
                    "workerId":"worker-a","outputs":[]
                }}),
                json!({"type":"join-opened","payload":{"join":{
                    "joinKey":join_key,"status":"open"
                }}}),
            ],
        };
        let progress = mission_progress_projection(&lifecycle, &journal).unwrap();
        assert_eq!(progress.get("state").and_then(Value::as_str), Some("ready"));
        assert_eq!(
            progress.pointer("/plan/title").and_then(Value::as_str),
            Some("Compare approaches")
        );
        assert_eq!(
            progress
                .pointer("/steps/2/objective")
                .and_then(Value::as_str),
            Some("Compare both options.")
        );
        assert_eq!(
            progress
                .pointer("/steps/2/dependsOnStepKeys")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        assert_eq!(
            progress.pointer("/steps/0/state").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            progress.pointer("/steps/1/state").and_then(Value::as_str),
            Some("ready")
        );
        assert_eq!(
            progress.pointer("/steps/2/state").and_then(Value::as_str),
            Some("waiting")
        );
        assert_eq!(
            progress
                .pointer("/usage/inputTokens")
                .and_then(Value::as_i64),
            Some(12)
        );
        assert_eq!(
            progress
                .pointer("/usage/durationMs")
                .and_then(Value::as_i64),
            Some(1500)
        );

        journal.run["status"] = json!("completed");
        journal.run["terminalResult"] = json!({
            "acceptance":[{
                "criterionKey":"both","status":"met","evidenceRefs":["output:a","output:b"],
                "summary":"Both exact outputs were joined."
            }]
        });
        journal.events.extend([
            json!({"type":"worker-started","payload":{"workerId":"worker-b"}}),
            json!({"type":"worker-completed","payload":{
                "workerId":"worker-b","outputs":[]
            }}),
            json!({"type":"join-resolved","payload":{"join":{
                "joinKey":coordination_join_key("revision-progress", "combine"),
                "status":"satisfied"
            }}}),
            json!({"type":"aggregation-recorded","payload":{"aggregation":{
                "stepKey":"combine","status":"complete"
            }}}),
        ]);
        let completed = mission_progress_projection(&lifecycle, &journal).unwrap();
        assert_eq!(
            completed.get("state").and_then(Value::as_str),
            Some("complete")
        );
        assert_eq!(
            completed.get("completedSteps").and_then(Value::as_u64),
            Some(3)
        );
        assert_eq!(
            completed
                .pointer("/acceptance/0/status")
                .and_then(Value::as_str),
            Some("met")
        );
        assert_eq!(
            completed
                .pointer("/acceptance/0/evidenceCount")
                .and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn progress_projection_fails_closed_on_unknown_worker_activity() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({"acceptance":{"criteria":[]}}),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-progress",
                "bounds":{"maxParallelSteps":1},
                "steps":[{"key":"draft","kind":"compose","title":"Draft","dependsOnStepKeys":[]}]
            }),
        };
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","budget":{"maxWorkers":1}}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-draft","planStepKey":"draft"
                }}}),
                json!({"type":"worker-started","payload":{"workerId":"substituted-worker"}}),
            ],
        };
        assert!(mission_progress_projection(&lifecycle, &journal)
            .unwrap_err()
            .contains("unknown worker"));
    }

    #[test]
    fn progress_cost_projection_keeps_only_bounded_contract_fields() {
        let projected = safe_cost_observation(&json!({
            "amount":{"amount":"0.000045","currencyCode":"USD"},
            "provenance":"fable-calculated",
            "pricingReference":"official-price|reviewed=2026-07-13",
            "secret":"must-not-cross"
        }))
        .unwrap();
        assert_eq!(
            projected,
            json!({
                "amount":{"amount":"0.000045","currencyCode":"USD"},
                "provenance":"fable-calculated",
                "pricingReference":"official-price|reviewed=2026-07-13"
            })
        );
        assert!(safe_cost_observation(&json!({
            "amount":{"amount":"0.1","currencyCode":"usd"},
            "provenance":"invented"
        }))
        .is_err());
    }

    #[test]
    fn automatic_advancement_resolves_only_declared_terminal_join_facts() {
        let join = "join-general";
        let waiting = mission_run::MissionRunJournalRow {
            run: json!({"status":"running"}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-a","planStepKey":"a"
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-b","planStepKey":"b"
                }}}),
                json!({"type":"join-opened","payload":{"join":{
                    "joinKey":join,"status":"open","strategy":"all",
                    "workerIds":["worker-a","worker-b"],"quorum":null,
                    "allowFailedWorkers":false,"deadline":null,
                    "satisfiedWorkerIds":[],"failedWorkerIds":[]
                }}}),
                json!({"type":"worker-completed","payload":{"workerId":"worker-a","outputs":[]}}),
            ],
        };
        assert!(next_automatic_join_resolution(&waiting).unwrap().is_none());

        let mut complete = waiting;
        complete.events.push(
            json!({"type":"worker-completed","payload":{"workerId":"worker-b","outputs":[]}}),
        );
        let (join_key, resolution) = next_automatic_join_resolution(&complete)
            .unwrap()
            .expect("all declared workers are terminal");
        assert_eq!(join_key, join);
        assert_eq!(
            resolution.get("status").and_then(Value::as_str),
            Some("satisfied")
        );
        assert_eq!(
            resolution
                .get("satisfiedWorkerIds")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );

        complete.events.push(
            json!({"type":"worker-completed","payload":{"workerId":"worker-b","outputs":[]}}),
        );
        assert!(next_automatic_join_resolution(&complete)
            .unwrap_err()
            .contains("terminal facts are ambiguous"));
    }

    #[test]
    fn automatic_advancement_materializes_only_a_ready_coordinate_step() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({}),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-auto",
                "steps":[
                    {"key":"a","kind":"produce","dependsOnStepKeys":[]},
                    {"key":"b","kind":"produce","dependsOnStepKeys":[]},
                    {"key":"combine","kind":"coordinate","dependsOnStepKeys":["a","b"]}
                ]
            }),
        };
        let join_key = coordination_join_key("revision-auto", "combine");
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"running"}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-a","planStepKey":"a",
                    "outputContract":{"slots":[{"key":"output-a","required":true}]}
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-b","planStepKey":"b",
                    "outputContract":{"slots":[{"key":"output-b","required":true}]}
                }}}),
                json!({"type":"worker-completed","payload":{"workerId":"worker-a","outputs":[{
                    "key":"output-a","summary":"First output.","valueReference":"mission-output:a"
                }]}}),
                json!({"type":"worker-completed","payload":{"workerId":"worker-b","outputs":[{
                    "key":"output-b","summary":"Second output.","valueReference":"mission-output:b"
                }]}}),
                json!({"type":"join-opened","payload":{"join":{
                    "joinKey":join_key,"status":"open","strategy":"all",
                    "workerIds":["worker-a","worker-b"],"quorum":null,
                    "allowFailedWorkers":false,"deadline":null,
                    "satisfiedWorkerIds":[],"failedWorkerIds":[]
                }}}),
                json!({"type":"join-resolved","payload":{"join":{
                    "joinKey":coordination_join_key("revision-auto", "combine"),
                    "status":"satisfied","strategy":"all",
                    "workerIds":["worker-a","worker-b"],"quorum":null,
                    "allowFailedWorkers":false,"deadline":null,
                    "satisfiedWorkerIds":["worker-a","worker-b"],"failedWorkerIds":[]
                }}}),
            ],
        };
        let (step_key, aggregation) = next_automatic_aggregation(&lifecycle, &journal)
            .unwrap()
            .expect("satisfied terminal coordinate step");
        assert_eq!(step_key, "combine");
        assert_eq!(
            aggregation.get("status").and_then(Value::as_str),
            Some("complete")
        );
        assert_eq!(
            aggregation
                .get("producedOutputs")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        let identity = automatic_coordination_identity("run-1", "join-resolved", "join-1");
        assert_eq!(
            identity,
            automatic_coordination_identity("run-1", "join-resolved", "join-1")
        );
        assert_ne!(
            identity,
            automatic_coordination_identity("run-1", "aggregation-recorded", "join-1")
        );
    }

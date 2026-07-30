    fn general_terminal_fixture(
        include_evaluation: bool,
    ) -> (
        mission_plan::MissionPlanLifecycleRow,
        mission_run::MissionRunJournalRow,
    ) {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "id":"mission-general","status":"running",
                "workspaceId":"workspace-1","visibility":"member-private",
                "ownerMemberId":"member-1","authority":"local",
                "outcome":{"title":"Final brief","desiredOutcome":"Create the final brief.",
                "deliverables":[{
                    "key":"final","description":"the final brief","required":true
                }]},
                "acceptance":{"requiresHumanAcceptance":false,"criteria":[{
                    "key":"grounded","description":"The brief is grounded.",
                    "required":true,"evaluator":"policy",
                    "evidenceRequired":["source-1"]
                }]}
            }),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-general",
                "summary":"Produce the final brief.",
                "bounds":{"maxParallelSteps":1},
                "steps":[{
                    "key":"final","kind":"produce","title":"Final brief",
                    "objective":"Produce the final brief.",
                    "dependsOnStepKeys":[],
                    "expectedOutputs":[{
                        "key":"final","description":"the final brief","required":true
                    }]
                }]
            }),
        };
        let mut events = vec![
            json!({"id":"event-worker","type":"worker-created","payload":{"worker":{
                "id":"worker-final","planStepKey":"final",
                "outputContract":{"slots":[{
                    "key":"final","description":"the final brief","required":true
                }]}
            }}}),
            json!({"id":"event-completed","type":"worker-completed","actor":{"kind":"system"},
            "payload":{"workerId":"worker-final","outputs":[{
                "key":"final","summary":"Final cited brief.",
                "valueReference":"mission-output:final"
            }]}}),
        ];
        if include_evaluation {
            events.push(json!({
                "id":"event-evaluation","type":"evaluation-recorded",
                "actor":{"kind":"system"},"payload":{"evaluation":{
                    "evaluationKey":"policy-grounded",
                    "target":{"kind":"worker","workerId":"worker-final"},
                    "verdict":"pass","summary":"Policy passed.",
                    "evaluatedAt":"2026-07-23T10:00:00.000Z",
                    "criteria":[{
                        "criterionKey":"grounded","passed":true,
                        "summary":"Exact evidence retained.",
                        "evidenceRefs":["source-1"]
                    }]
                }}
            }));
        }
        let journal = mission_run::MissionRunJournalRow {
            run: json!({
                "id":"run-general","status":"running","budget":{},
                "currentAttemptNumber":1
            }),
            events,
        };
        (lifecycle, journal)
    }

    #[test]
    fn general_terminal_result_is_derived_only_from_exact_durable_facts() {
        let (lifecycle, journal) = general_terminal_fixture(true);
        let terminal =
            derive_general_terminal(&lifecycle, &journal, "2026-07-23T10:01:00.000Z").unwrap();
        assert_eq!(terminal.outcome, "succeeded");
        assert_eq!(terminal.event_type, "run-completed");
        assert_eq!(
            terminal.run_result["outputs"][0]["valueReference"],
            "mission-output:final"
        );
        assert_eq!(terminal.run_result["acceptance"][0]["status"], "met");
        assert_eq!(
            terminal.mission_result["producingRunIds"],
            json!(["run-general"])
        );
        assert!(terminal.run_result.get("partial").is_none());
        assert!(terminal.run_result.get("error").is_none());
    }

    #[test]
    fn general_terminal_result_preserves_unaccepted_output_as_partial() {
        let (lifecycle, journal) = general_terminal_fixture(false);
        let terminal =
            derive_general_terminal(&lifecycle, &journal, "2026-07-23T10:01:00.000Z").unwrap();
        assert_eq!(terminal.outcome, "partial");
        assert_eq!(terminal.event_type, "run-failed");
        assert_eq!(terminal.run_status, "partially-completed");
        assert_eq!(
            terminal.run_result["partial"]["completedOutputs"][0]["key"],
            "final"
        );
        assert_eq!(
            terminal.run_result["partial"]["recommendedNextAction"],
            "revise-plan"
        );
    }

    #[test]
    fn general_terminal_result_rejects_substituted_evaluation_authority() {
        let (lifecycle, mut journal) = general_terminal_fixture(true);
        journal.events[2]["actor"] = json!({"kind":"worker","workerId":"worker-final"});
        assert!(
            derive_general_terminal(&lifecycle, &journal, "2026-07-23T10:01:00.000Z")
                .unwrap_err()
                .contains("declared authority")
        );
    }

    #[test]
    fn general_terminal_result_keeps_worker_review_advisory() {
        let (mut lifecycle, mut journal) = general_terminal_fixture(true);
        lifecycle.mission["acceptance"]["criteria"][0]["evaluator"] = json!("worker");
        lifecycle.mission["acceptance"]["criteria"][0]
            .as_object_mut()
            .unwrap()
            .remove("evidenceRequired");
        journal.events[2]["actor"] = json!({"kind":"worker","workerId":"worker-final"});
        journal.events[2]["payload"]["evaluation"]["reviewerWorkerId"] = json!("worker-final");
        journal.events[2]["payload"]["evaluation"]["criteria"][0]["evidenceRefs"] = json!([]);
        let terminal =
            derive_general_terminal(&lifecycle, &journal, "2026-07-23T10:01:00.000Z").unwrap();
        assert_eq!(terminal.outcome, "partial");
        assert_eq!(
            terminal.run_result["acceptance"][0]["status"],
            "partially-met"
        );
        assert!(terminal.run_result["acceptance"][0]["summary"]
            .as_str()
            .unwrap()
            .contains("model opinion remains advisory"));
    }

    #[test]
    fn general_terminal_result_requires_one_plan_derived_output_source() {
        let (mut lifecycle, mut journal) = general_terminal_fixture(true);
        lifecycle.current_revision["steps"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "key":"alternate","kind":"produce","title":"Alternate",
                "objective":"Produce an alternate final brief.",
                "dependsOnStepKeys":[],
                "expectedOutputs":[{
                    "key":"final","description":"the final brief","required":true
                }]
            }));
        journal.events.push(json!({
            "id":"event-worker-alternate","type":"worker-created","payload":{"worker":{
                "id":"worker-alternate","planStepKey":"alternate",
                "outputContract":{"slots":[{
                    "key":"final","description":"the final brief","required":true
                }]}
            }}
        }));
        journal.events.push(json!({
            "id":"event-completed-alternate","type":"worker-completed",
            "actor":{"kind":"system"},"payload":{
                "workerId":"worker-alternate","outputs":[{
                    "key":"final","summary":"Alternate brief.",
                    "valueReference":"mission-output:alternate"
                }]
            }
        }));
        assert!(
            derive_general_terminal(&lifecycle, &journal, "2026-07-23T10:01:00.000Z")
                .unwrap_err()
                .contains("one exact producing step")
        );
    }

    #[test]
    fn general_terminal_result_honours_durable_cancellation_without_outputs() {
        let (lifecycle, mut journal) = general_terminal_fixture(false);
        journal.run["status"] = json!("cancelling");
        journal.run["cancellation"] = json!({
            "requestKey":"cancel-general","requestedAt":"2026-07-23T10:00:30.000Z",
            "scope":"run","mode":"cooperative"
        });
        let terminal =
            derive_general_terminal(&lifecycle, &journal, "2026-07-23T10:01:00.000Z").unwrap();
        assert_eq!(terminal.outcome, "cancelled");
        assert_eq!(terminal.event_type, "run-cancelled");
        assert_eq!(
            terminal.event_payload["cancellation"]["requestKey"],
            "cancel-general"
        );
    }

    fn append_general_store_event(
        tx: &rusqlite::Connection,
        store: &crate::store::Store,
        scope: &DataScope,
        run: &mut Value,
        event_id: &str,
        event_type: &str,
        payload: Value,
        actor: Value,
        at: &str,
    ) -> crate::store::Result<()> {
        let revision = run.get("revision").and_then(Value::as_i64).unwrap();
        let last_sequence = run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            .unwrap();
        let previous = run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            .unwrap();
        let sequence = last_sequence + 1;
        let key = format!("fixture:{event_type}");
        let event = json!({
            "id":event_id,"runId":"run-general-store","type":event_type,
            "sequence":sequence,"previousEventId":previous,"attemptNumber":1,
            "occurredAt":at,"actor":actor,"idempotencyKey":key,"payload":payload
        });
        run["revision"] = json!(revision + 1);
        run["updatedAt"] = json!(at);
        run["eventHead"] = json!({"lastSequence":sequence,"lastEventId":event_id});
        mission_run::append(
            tx,
            store,
            scope,
            "member-1",
            "run-general-store",
            revision,
            last_sequence,
            event_id,
            event_type,
            &key,
            &event,
            run,
            at,
        )?;
        Ok(())
    }

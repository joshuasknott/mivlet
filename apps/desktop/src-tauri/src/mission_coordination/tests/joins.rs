    #[test]
    fn satisfied_join_must_match_exact_plan_target_and_worker_order() {
        let revision = "plan-revision-1";
        let target = "combine";
        let workers = vec!["worker-a".to_string(), "worker-b".to_string()];
        let key = coordination_join_key(revision, target);
        let journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![json!({
                "type":"join-resolved","payload":{"join":{
                    "joinKey":key,"status":"satisfied","strategy":"any",
                    "workerIds":workers,"allowFailedWorkers":false,
                    "satisfiedWorkerIds":["worker-a"],"failedWorkerIds":[]
                }}
            })],
        };
        assert!(has_satisfied_dependency_join(
            &journal,
            revision,
            target,
            &["worker-a".into(), "worker-b".into()]
        ));
        assert!(!has_satisfied_dependency_join(
            &journal,
            revision,
            target,
            &["worker-b".into(), "worker-a".into()]
        ));
        assert!(!has_satisfied_dependency_join(
            &journal,
            revision,
            "another-target",
            &["worker-a".into(), "worker-b".into()]
        ));
    }

    #[test]
    fn declared_general_dependency_objective_requires_the_exact_supported_join() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "constraints":[{
                    "key":GENERAL_DECLARED_GRAPH_MARKER,
                    "severity":"required",
                    "source":"user"
                }]
            }),
            plan: json!({}),
            current_revision: json!({"id":"revision-1"}),
        };
        assert!(declared_general_graph(&lifecycle));
        let workers = vec!["worker-a".to_string(), "worker-b".to_string()];
        let join_key = coordination_join_key("revision-1", "joined-result");
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![json!({
                "type":"join-resolved","payload":{"join":{
                    "joinKey":join_key,
                    "targetStepKey":"joined-result",
                    "status":"satisfied",
                    "strategy":"any",
                    "workerIds":workers,
                    "allowFailedWorkers":true,
                    "satisfiedWorkerIds":["worker-a"],
                    "failedWorkerIds":["worker-b"]
                }}
            })],
        };
        assert_eq!(
            exact_dependency_join(
                &lifecycle,
                &journal,
                "joined-result",
                &["worker-a".into(), "worker-b".into()]
            )
            .unwrap()["strategy"],
            "any"
        );
        journal.events[0]["payload"]["join"]["allowFailedWorkers"] = json!(false);
        assert!(exact_dependency_join(
            &lifecycle,
            &journal,
            "joined-result",
            &["worker-a".into(), "worker-b".into()]
        )
        .unwrap_err()
        .contains("unsupported"));
    }

    #[test]
    fn aggregation_is_derived_in_plan_order_from_reference_bearing_terminal_outputs() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({}),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-1",
                "steps":[
                    {"key":"research","kind":"investigate","dependsOnStepKeys":[]},
                    {"key":"draft","kind":"compose","dependsOnStepKeys":[]},
                    {"key":"combine","kind":"coordinate","dependsOnStepKeys":["research","draft"]}
                ]
            }),
        };
        let join_key = coordination_join_key("revision-1", "combine");
        let journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-research","planStepKey":"research",
                    "outputContract":{"slots":[{"key":"evidence","required":true}]}
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-draft","planStepKey":"draft",
                    "outputContract":{"slots":[{"key":"draft","required":true}]}
                }}}),
                json!({"type":"worker-completed","payload":{
                    "workerId":"worker-draft","outputs":[{
                        "key":"draft","summary":"Draft output.",
                        "valueReference":"mission-output:v1:draft"
                    }]
                }}),
                json!({"type":"worker-completed","payload":{
                    "workerId":"worker-research","outputs":[{
                        "key":"evidence","summary":"Evidence output.",
                        "artifactId":"artifact-1","artifactVersionId":"version-1"
                    }]
                }}),
                json!({"type":"join-resolved","payload":{"join":{
                    "joinKey":join_key,"status":"satisfied",
                    "workerIds":["worker-research","worker-draft"]
                }}}),
            ],
        };
        let receipt = deterministic_aggregation_receipt(&lifecycle, &journal, "combine").unwrap();
        assert_eq!(receipt["status"], "complete");
        assert_eq!(receipt["inputs"][0]["sourceStepKey"], "research");
        assert_eq!(receipt["producedOutputs"][0]["key"], "evidence");
        assert_eq!(receipt["producedOutputs"][1]["key"], "draft");
        assert_eq!(receipt["missingRequiredOutputKeys"], json!([]));

        let mut without_join = mission_run::MissionRunJournalRow {
            run: journal.run.clone(),
            events: journal.events.clone(),
        };
        without_join.events.pop();
        assert!(deterministic_aggregation_receipt(&lifecycle, &without_join, "combine").is_err());

        let mut content_only = journal;
        content_only.events[3]["payload"]["outputs"][0]
            .as_object_mut()
            .unwrap()
            .remove("artifactId");
        content_only.events[3]["payload"]["outputs"][0]
            .as_object_mut()
            .unwrap()
            .remove("artifactVersionId");
        assert!(deterministic_aggregation_receipt(&lifecycle, &content_only, "combine").is_err());
    }

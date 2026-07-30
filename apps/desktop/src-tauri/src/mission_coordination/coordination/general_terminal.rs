#[derive(Debug)]
struct GeneralMissionTerminal {
    event_type: &'static str,
    event_payload: Value,
    run_result: Value,
    mission_result: Value,
    run_status: &'static str,
    outcome: &'static str,
}

#[derive(Debug)]
struct GeneralMissionArtifactSpec {
    output_key: String,
    value_reference: String,
    title: String,
    binding: artifact::AcceptedMissionArtifactBinding,
}

fn general_output_title(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    output_key: &str,
) -> Result<String, String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    let producers = steps
        .iter()
        .filter(|step| {
            step.get("expectedOutputs")
                .and_then(Value::as_array)
                .is_some_and(|outputs| {
                    outputs
                        .iter()
                        .any(|output| output.get("key").and_then(Value::as_str) == Some(output_key))
                })
        })
        .collect::<Vec<_>>();
    if producers.len() != 1 {
        return Err("General Mission output has no exact producing step.".into());
    }
    bounded(
        producers[0]
            .get("title")
            .and_then(Value::as_str)
            .ok_or_else(|| "General Mission output title is invalid.".to_string())?,
        "General Mission output title",
        400,
    )
}

fn reviewed_general_artifact_specs(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    authorized: &AuthorizedRun,
    outputs: &mut Value,
) -> crate::store::Result<Vec<GeneralMissionArtifactSpec>> {
    let run_id = authorized
        .journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("General Mission run id is invalid.".into())
        })?;
    let private = PrivateDataScope::for_authenticated_user(
        authorized.scope.clone(),
        &authorized.actor,
        Some(&authorized.member),
    )?;
    let outputs = outputs.as_array_mut().ok_or_else(|| {
        crate::store::StoreError::Invalid("General Mission outputs are invalid.".into())
    })?;
    let mut specs = Vec::with_capacity(outputs.len());
    for output in outputs {
        let output_key = output
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("General Mission output key is invalid.".into())
            })?
            .to_string();
        let value_reference = output
            .get("valueReference")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "General Mission output reference is invalid.".into(),
                )
            })?
            .to_string();
        let binding = artifact::reviewed_general_mission_binding_for_reference(
            tx,
            store,
            &private,
            &authorized.member,
            run_id,
            &output_key,
            &value_reference,
        )?;
        let object = output.as_object_mut().ok_or_else(|| {
            crate::store::StoreError::Invalid("General Mission output is invalid.".into())
        })?;
        object.insert("artifactId".into(), json!(binding.artifact_id));
        object.insert(
            "artifactVersionId".into(),
            json!(binding.artifact_version_id),
        );
        specs.push(GeneralMissionArtifactSpec {
            title: general_output_title(&authorized.lifecycle, &output_key)
                .map_err(crate::store::StoreError::Invalid)?,
            output_key,
            value_reference,
            binding,
        });
    }
    Ok(specs)
}

fn bind_reviewed_general_artifacts(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    authorized: &AuthorizedRun,
    terminal: &mut GeneralMissionTerminal,
) -> crate::store::Result<Vec<GeneralMissionArtifactSpec>> {
    if terminal.outcome != "succeeded" {
        return Ok(Vec::new());
    }
    let specs = reviewed_general_artifact_specs(
        tx,
        store,
        authorized,
        terminal.run_result.get_mut("outputs").ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "General Mission terminal outputs are unavailable.".into(),
            )
        })?,
    )?;
    terminal.mission_result["outputs"] = terminal.run_result["outputs"].clone();
    terminal.event_payload = json!({"result":terminal.run_result});
    Ok(specs)
}

fn materialize_reviewed_general_artifacts(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    authorized: &AuthorizedRun,
    result_event_id: &str,
    specs: &[GeneralMissionArtifactSpec],
) -> crate::store::Result<()> {
    if specs.is_empty() {
        return Ok(());
    }
    let private = PrivateDataScope::for_authenticated_user(
        authorized.scope.clone(),
        &authorized.actor,
        Some(&authorized.member),
    )?;
    let run_id = authorized
        .journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("General Mission run id is invalid.".into())
        })?;
    for spec in specs {
        artifact::create_reviewed_general_mission_output(
            tx,
            store,
            &private,
            &authorized.member,
            run_id,
            result_event_id,
            &spec.output_key,
            &spec.value_reference,
            &spec.title,
            &spec.binding,
        )?;
    }
    Ok(())
}

fn exact_evaluations_and_acceptance(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
    known_workers: &BTreeSet<String>,
) -> Result<(Vec<Value>, Vec<Value>, bool), String> {
    let criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .filter(|criteria| criteria.len() <= 128)
        .ok_or_else(|| "Mission acceptance criteria are invalid.".to_string())?;
    let mut criterion_by_key = BTreeMap::<String, &Value>::new();
    for criterion in criteria {
        let key = bounded(
            criterion
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Mission acceptance criterion is invalid.".to_string())?,
            "Mission acceptance criterion",
            160,
        )?;
        if criterion_by_key.insert(key, criterion).is_some() {
            return Err("Mission acceptance criteria are ambiguous.".into());
        }
    }
    let run_id = journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run identity is invalid.".to_string())?;
    let mut evaluation_keys = BTreeSet::new();
    let mut evaluations = Vec::new();
    let mut results = BTreeMap::<String, (bool, bool, BTreeSet<String>, Vec<String>)>::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("evaluation-recorded") {
            continue;
        }
        if evaluations.len() >= 128 {
            return Err("Mission evaluation count exceeds safe bounds.".into());
        }
        let evaluation = event
            .pointer("/payload/evaluation")
            .ok_or_else(|| "Stored Mission evaluation is invalid.".to_string())?;
        let evaluation_key = bounded(
            evaluation
                .get("evaluationKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission evaluation identity is invalid.".to_string())?,
            "Mission evaluation",
            200,
        )?;
        if !evaluation_keys.insert(evaluation_key) {
            return Err("Stored Mission evaluations are ambiguous.".into());
        }
        let target_valid = match evaluation.pointer("/target/kind").and_then(Value::as_str) {
            Some("run") => {
                evaluation.pointer("/target/runId").and_then(Value::as_str) == Some(run_id)
            }
            Some("worker") => evaluation
                .pointer("/target/workerId")
                .and_then(Value::as_str)
                .is_some_and(|worker| known_workers.contains(worker)),
            _ => false,
        };
        if !target_valid {
            return Err(
                "Stored Mission evaluation targets work outside the selected graph.".into(),
            );
        }
        let criterion_results = evaluation
            .get("criteria")
            .and_then(Value::as_array)
            .filter(|values| values.len() <= 128)
            .ok_or_else(|| "Stored Mission evaluation criteria are invalid.".to_string())?;
        let mut seen = BTreeSet::new();
        for result in criterion_results {
            let key = bounded(
                result
                    .get("criterionKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Stored Mission evaluation criterion is invalid.".to_string())?,
                "Mission evaluation criterion",
                160,
            )?;
            if !seen.insert(key.clone()) {
                return Err("One Mission evaluation repeats an acceptance criterion.".into());
            }
            let criterion = criterion_by_key.get(&key).ok_or_else(|| {
                "Stored Mission evaluation references an unknown criterion.".to_string()
            })?;
            let evaluator = criterion
                .get("evaluator")
                .and_then(Value::as_str)
                .ok_or_else(|| "Mission acceptance evaluator is invalid.".to_string())?;
            let actor_kind = event.pointer("/actor/kind").and_then(Value::as_str);
            let authorized = match evaluator {
                "policy" => actor_kind == Some("system"),
                "human" => {
                    actor_kind == Some("internal-user")
                        && event
                            .pointer("/actor/internalUserId")
                            .and_then(Value::as_str)
                            == evaluation
                                .get("reviewerInternalUserId")
                                .and_then(Value::as_str)
                }
                "worker" => {
                    let reviewer = evaluation.get("reviewerWorkerId").and_then(Value::as_str);
                    actor_kind == Some("worker")
                        && reviewer.is_some_and(|worker| known_workers.contains(worker))
                        && event.pointer("/actor/workerId").and_then(Value::as_str) == reviewer
                }
                "external" => false,
                _ => false,
            };
            if !authorized {
                return Err("Mission acceptance evaluation lacks its declared authority.".into());
            }
            let passed = match result.get("passed") {
                Some(Value::Bool(value)) => Some(*value),
                Some(Value::Null) | None => None,
                _ => return Err("Stored Mission evaluation verdict is invalid.".into()),
            };
            let evidence = result
                .get("evidenceRefs")
                .and_then(Value::as_array)
                .filter(|values| values.len() <= 128)
                .ok_or_else(|| "Stored Mission evaluation evidence is invalid.".to_string())?;
            let entry = results
                .entry(key)
                .or_insert_with(|| (false, false, BTreeSet::new(), Vec::new()));
            entry.0 |= passed == Some(true);
            entry.1 |= passed == Some(false);
            for reference in evidence {
                entry.2.insert(bounded(
                    reference.as_str().ok_or_else(|| {
                        "Stored Mission evaluation evidence is invalid.".to_string()
                    })?,
                    "Mission evaluation evidence",
                    512,
                )?);
            }
            if let Some(summary) = result.get("summary").and_then(Value::as_str) {
                entry
                    .3
                    .push(bounded(summary, "Mission acceptance summary", 2_000)?);
            }
        }
        evaluations.push(evaluation.clone());
    }

    let mut acceptance = Vec::with_capacity(criteria.len());
    let mut required_met = true;
    let mut met_count = 0usize;
    let mut human_met = false;
    for (key, criterion) in &criterion_by_key {
        let (has_pass, has_fail, evidence, summaries) = results
            .get(key)
            .cloned()
            .unwrap_or_else(|| (false, false, BTreeSet::new(), Vec::new()));
        let evaluator = criterion
            .get("evaluator")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission acceptance evaluator is invalid.".to_string())?;
        let (required_evidence, derived_evidence_complete) =
            criterion_required_evidence_refs(lifecycle, journal, criterion)?;
        let evidence_complete = derived_evidence_complete
            && required_evidence
                .iter()
                .all(|reference| evidence.contains(reference));
        let evaluated_status = if has_pass && has_fail {
            "partially-met"
        } else if has_fail {
            "not-met"
        } else if has_pass && evidence_complete {
            "met"
        } else if has_pass {
            "partially-met"
        } else {
            "not-evaluated"
        };
        let status = if evaluator == "worker" && evaluated_status == "met" {
            "partially-met"
        } else {
            evaluated_status
        };
        let required = criterion
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        required_met &= !required || status == "met";
        met_count += usize::from(status == "met");
        human_met |= evaluator == "human" && status == "met";
        let summary = if evaluator == "worker" && has_pass && !has_fail && evidence_complete {
            Some(
                "The declared worker review passed this criterion, but model opinion remains advisory."
                    .to_string(),
            )
        } else if summaries.is_empty() {
            None
        } else {
            Some(summaries.join(" "))
        };
        acceptance.push(json!({
            "criterionKey":key,
            "status":status,
            "evidenceRefs":evidence.into_iter().collect::<Vec<_>>(),
            "summary":summary
        }));
    }
    let minimum = lifecycle
        .mission
        .pointer("/acceptance/minimumRequiredCriteria")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or_else(|| {
            criteria
                .iter()
                .filter(|criterion| {
                    criterion
                        .get("required")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .count()
        });
    if minimum > criteria.len() {
        return Err("Mission minimum acceptance count is invalid.".into());
    }
    let human_required = lifecycle
        .mission
        .pointer("/acceptance/requiresHumanAcceptance")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((
        evaluations,
        acceptance,
        required_met && met_count >= minimum && (!human_required || human_met),
    ))
}

fn exact_general_outputs(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
) -> Result<(Vec<Value>, Vec<String>), String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    let workers = workers_by_step(journal)?;
    let deliverables = lifecycle
        .mission
        .pointer("/outcome/deliverables")
        .and_then(Value::as_array)
        .filter(|values| values.len() <= 128)
        .ok_or_else(|| "Mission deliverables are invalid.".to_string())?;
    let mut output_keys = BTreeSet::new();
    let mut outputs = Vec::new();
    let mut missing = Vec::new();
    for deliverable in deliverables {
        let key = bounded(
            deliverable
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Mission deliverable is invalid.".to_string())?,
            "Mission deliverable",
            160,
        )?;
        if !output_keys.insert(key.clone()) {
            return Err("Mission deliverables are ambiguous.".into());
        }
        let producers = steps
            .iter()
            .filter(|step| {
                step.get("expectedOutputs")
                    .and_then(Value::as_array)
                    .is_some_and(|values| {
                        values.iter().any(|output| {
                            output.get("key").and_then(Value::as_str) == Some(key.as_str())
                        })
                    })
            })
            .collect::<Vec<_>>();
        if producers.len() != 1 {
            return Err(
                "General Mission finalization requires one exact producing step per deliverable."
                    .into(),
            );
        }
        let producer = producers[0];
        let step_key = producer
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission producing step is invalid.".to_string())?;
        let candidate = if producer.get("kind").and_then(Value::as_str) == Some("coordinate") {
            let receipts = journal
                .events
                .iter()
                .filter(|event| {
                    event.get("type").and_then(Value::as_str) == Some("aggregation-recorded")
                        && event
                            .pointer("/payload/aggregation/stepKey")
                            .and_then(Value::as_str)
                            == Some(step_key)
                })
                .collect::<Vec<_>>();
            if receipts.len() > 1 {
                return Err("Mission coordinate results are ambiguous.".into());
            }
            if let Some(event) = receipts.first() {
                let expected = deterministic_aggregation_receipt(lifecycle, journal, step_key)?;
                if event.pointer("/payload/aggregation") != Some(&expected) {
                    return Err("Mission coordinate result changed from its durable inputs.".into());
                }
                expected
                    .get("producedOutputs")
                    .and_then(Value::as_array)
                    .and_then(|values| {
                        values
                            .iter()
                            .find(|output| output.get("key").and_then(Value::as_str) == Some(&key))
                    })
                    .cloned()
            } else {
                None
            }
        } else {
            let worker_id = workers
                .get(step_key)
                .ok_or_else(|| "Mission producing worker is unavailable.".to_string())?;
            let terminals = journal
                .events
                .iter()
                .filter(|event| {
                    matches!(
                        event.get("type").and_then(Value::as_str),
                        Some("worker-completed" | "worker-failed")
                    ) && event.pointer("/payload/workerId").and_then(Value::as_str)
                        == Some(worker_id.as_str())
                })
                .collect::<Vec<_>>();
            if terminals.len() != 1 {
                return Err("Mission producing worker terminal fact is ambiguous.".into());
            }
            if terminals[0].get("type").and_then(Value::as_str) == Some("worker-completed") {
                terminals[0]
                    .pointer("/payload/outputs")
                    .and_then(Value::as_array)
                    .and_then(|values| {
                        values
                            .iter()
                            .find(|output| output.get("key").and_then(Value::as_str) == Some(&key))
                    })
                    .cloned()
            } else {
                None
            }
        };
        if let Some(candidate) = candidate {
            let object = candidate
                .as_object()
                .ok_or_else(|| "Mission output is invalid.".to_string())?;
            bounded(
                object
                    .get("summary")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Mission output summary is invalid.".to_string())?,
                "Mission output summary",
                2_000,
            )?;
            let has_reference = [
                "artifactId",
                "artifactVersionId",
                "handoffId",
                "valueReference",
            ]
            .iter()
            .any(|field| object.get(*field).and_then(Value::as_str).is_some());
            if !has_reference {
                return Err("Mission output lacks a durable reference.".into());
            }
            outputs.push(candidate);
        } else if deliverable
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let description = bounded(
                deliverable
                    .get("description")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Mission deliverable description is invalid.".to_string())?,
                "Mission deliverable description",
                2_000,
            )?;
            missing.push(format!("Produce {description}"));
        }
    }
    Ok((outputs, missing))
}

fn derive_general_terminal(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
    at: &str,
) -> Result<GeneralMissionTerminal, String> {
    let run_id = bounded(
        journal
            .run
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission run identity is invalid.".to_string())?,
        "Mission run",
        160,
    )?;
    let run_status = journal
        .run
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run status is invalid.".to_string())?;
    if run_status == "cancelling" {
        let cancellation = journal
            .run
            .get("cancellation")
            .cloned()
            .ok_or_else(|| "Mission cancellation request is unavailable.".to_string())?;
        let run_result = json!({
            "outcome":"cancelled","summary":"The mission was cancelled.",
            "outputs":[],"acceptance":[],"evaluations":[],"usage":[],
            "completedAt":at
        });
        return Ok(GeneralMissionTerminal {
            event_type: "run-cancelled",
            event_payload: json!({"cancellation":cancellation}),
            run_result,
            mission_result: json!({
                "outcome":"cancelled","summary":"The mission was cancelled.",
                "producingRunIds":[run_id],"outputs":[],"acceptance":[],"completedAt":at
            }),
            run_status: "cancelled",
            outcome: "cancelled",
        });
    }
    if run_status != "running" {
        return Err("General Mission finalization requires a running or cancelling run.".into());
    }
    let progress = mission_progress_projection(lifecycle, journal)?;
    if progress
        .get("steps")
        .and_then(Value::as_array)
        .is_some_and(|steps| {
            steps.iter().any(|step| {
                matches!(
                    step.get("state").and_then(Value::as_str),
                    Some("ready" | "running" | "waiting")
                )
            })
        })
    {
        return Err("Mission graph still has runnable or waiting work.".into());
    }
    let workers = workers_by_step(journal)?;
    let known_workers = workers.into_values().collect::<BTreeSet<_>>();
    let (completed, failed) = strict_terminal_workers(journal)?;
    if completed.len() + failed.len() != known_workers.len() {
        return Err("Mission graph workers are not all terminal.".into());
    }
    let (evaluations, acceptance, acceptance_met) =
        exact_evaluations_and_acceptance(lifecycle, journal, &known_workers)?;
    let (outputs, mut remaining_work) = exact_general_outputs(lifecycle, journal)?;
    for (criterion, result) in lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
        .iter()
        .zip(&acceptance)
    {
        if result.get("status").and_then(Value::as_str) != Some("met") {
            remaining_work.push(format!(
                "Meet acceptance criterion: {}",
                bounded(
                    criterion
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("the declared criterion"),
                    "Mission acceptance description",
                    2_000,
                )?
            ));
        }
    }
    remaining_work.sort();
    remaining_work.dedup();
    let mut usage = Vec::new();
    let mut usage_keys = BTreeSet::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("usage-recorded") {
            continue;
        }
        let record = event
            .pointer("/payload/usage")
            .ok_or_else(|| "Stored Mission usage is invalid.".to_string())?;
        let key = bounded(
            record
                .get("usageKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission usage identity is invalid.".to_string())?,
            "Mission usage",
            200,
        )?;
        if !usage_keys.insert(key)
            || record.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
            || record
                .get("workerId")
                .and_then(Value::as_str)
                .is_some_and(|worker| !known_workers.contains(worker))
        {
            return Err("Stored Mission usage is outside the selected graph.".into());
        }
        usage.push(record.clone());
    }
    let succeeded = !completed.is_empty() && remaining_work.is_empty() && acceptance_met;
    let outcome = if succeeded {
        "succeeded"
    } else if outputs.is_empty() {
        "failed"
    } else {
        "partial"
    };
    let summary = match outcome {
        "succeeded" => "The mission completed its declared deliverables and acceptance criteria.",
        "partial" => "The mission preserved useful work but did not meet its full acceptance bar.",
        _ => "The mission ended without a declared deliverable that met its acceptance bar.",
    };
    let partial = (outcome == "partial").then(|| {
        json!({
            "summary":summary,"completedOutputs":outputs,
            "remainingWork":remaining_work,"acceptance":acceptance,
            "recoverable":true,
            "recommendedNextAction":if lifecycle.mission
                .pointer("/acceptance/requiresHumanAcceptance")
                .and_then(Value::as_bool).unwrap_or(false) {"human-review"} else {"revise-plan"}
        })
    });
    let error = json!({
        "code":"mission-acceptance-incomplete","category":"validation",
        "message":summary,"retryable":false
    });
    let mut run_result = json!({
        "outcome":outcome,"summary":summary,"outputs":outputs,
        "acceptance":acceptance,"evaluations":evaluations,"usage":usage,
        "completedAt":at
    });
    if let Some(partial) = &partial {
        run_result["partial"] = partial.clone();
    }
    if outcome != "succeeded" {
        run_result["error"] = error.clone();
    }
    let mut mission_result = json!({
        "outcome":outcome,"summary":summary,"producingRunIds":[run_id],
        "outputs":outputs,"acceptance":acceptance,"completedAt":at
    });
    if let Some(partial) = &partial {
        mission_result["partial"] = partial.clone();
    }
    let event_payload = if outcome == "succeeded" {
        json!({"result":run_result})
    } else if let Some(partial) = &partial {
        json!({"error":error,"partial":partial})
    } else {
        json!({"error":error})
    };
    Ok(GeneralMissionTerminal {
        event_type: if outcome == "succeeded" {
            "run-completed"
        } else {
            "run-failed"
        },
        event_payload,
        run_result,
        mission_result,
        run_status: match outcome {
            "succeeded" => "completed",
            "partial" => "partially-completed",
            _ => "failed",
        },
        outcome,
    })
}

fn append_event(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    authorized: &AuthorizedRun,
    event_id: &str,
    event_type: &str,
    event_key: &str,
    payload: Value,
    at: &str,
) -> crate::store::Result<mission_run::MissionRunJournalRow> {
    let revision = authorized
        .journal
        .run
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run revision is invalid.".into())
        })?;
    let sequence = authorized
        .journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?
        + 1;
    let previous = authorized
        .journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let workspace = authorized
        .journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    let run_id = authorized
        .journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run id is invalid.".into()))?;
    let attempt_number = authorized
        .journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run attempt is invalid.".into())
        })?;
    let event = json!({
        "workspaceId":workspace,"visibility":"member-private",
        "ownerMemberId":authorized.member,"authority":"local","schemaVersion":1,"revision":1,
        "createdByInternalUserId":authorized.actor,"createdAt":at,"updatedAt":at,
        "id":event_id,"runId":run_id,"type":event_type,
        "sequence":sequence,"previousEventId":previous,
        "attemptNumber":attempt_number,
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":event_key,
        "payload":payload
    });
    let mut projected = authorized.journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":event_id}),
    );
    mission_run::append(
        tx,
        store,
        &authorized.scope,
        &authorized.member,
        run_id,
        revision,
        sequence - 1,
        event_id,
        event_type,
        event_key,
        &event,
        &Value::Object(projected),
        at,
    )
}

fn exact_durable_evidence_refs(
    journal: &mission_run::MissionRunJournalRow,
) -> Result<BTreeSet<String>, String> {
    let mut references = BTreeSet::new();
    for event in &journal.events {
        let outputs = match event.get("type").and_then(Value::as_str) {
            Some("worker-completed") => event.pointer("/payload/outputs"),
            Some("aggregation-recorded") => event.pointer("/payload/aggregation/producedOutputs"),
            _ => None,
        };
        if let Some(outputs) = outputs {
            let outputs = outputs
                .as_array()
                .filter(|values| values.len() <= 128)
                .ok_or_else(|| "Stored Mission output evidence is invalid.".to_string())?;
            for output in outputs {
                for field in [
                    "valueReference",
                    "artifactId",
                    "artifactVersionId",
                    "handoffId",
                ] {
                    if let Some(reference) = output.get(field).and_then(Value::as_str) {
                        references.insert(bounded(reference, "Mission output evidence", 512)?);
                    }
                }
            }
        }
        if event.get("type").and_then(Value::as_str) == Some("artifact-produced") {
            for field in ["artifactId", "versionId"] {
                if let Some(reference) = event
                    .get("payload")
                    .and_then(|payload| payload.get(field))
                    .and_then(Value::as_str)
                {
                    references.insert(bounded(reference, "Mission artifact evidence", 512)?);
                }
            }
        }
    }
    Ok(references)
}

fn output_evidence_refs(outputs: &Value) -> Result<BTreeSet<String>, String> {
    let outputs = outputs
        .as_array()
        .filter(|values| values.len() <= 128)
        .ok_or_else(|| "Stored Mission output evidence is invalid.".to_string())?;
    let mut references = BTreeSet::new();
    for output in outputs {
        for field in [
            "valueReference",
            "artifactId",
            "artifactVersionId",
            "handoffId",
        ] {
            if let Some(reference) = output.get(field).and_then(Value::as_str) {
                references.insert(bounded(reference, "Mission output evidence", 512)?);
            }
        }
    }
    Ok(references)
}

fn criterion_required_evidence_refs(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
    criterion: &Value,
) -> Result<(BTreeSet<String>, bool), String> {
    let mut references = criterion
        .get("evidenceRequired")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    bounded(
                        value
                            .as_str()
                            .ok_or_else(|| "Mission required evidence is invalid.".to_string())?,
                        "Mission required evidence",
                        512,
                    )
                })
                .collect::<Result<BTreeSet<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if criterion
        .get("evidenceFromStepOutputs")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok((references, true));
    }

    let criterion_key = bounded(
        criterion
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission acceptance criterion is invalid.".to_string())?,
        "Mission acceptance criterion",
        160,
    )?;
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| steps.len() <= 128)
        .ok_or_else(|| "Selected Mission plan steps are invalid.".to_string())?;
    let selected_steps = steps
        .iter()
        .filter(|step| {
            step.get("acceptanceCriterionKeys")
                .and_then(Value::as_array)
                .is_some_and(|keys| {
                    keys.iter()
                        .any(|key| key.as_str() == Some(criterion_key.as_str()))
                })
        })
        .collect::<Vec<_>>();
    if selected_steps.is_empty() {
        return Err("Output-bound Mission acceptance does not identify a producing step.".into());
    }

    let mut worker_by_step = BTreeMap::<String, String>::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("worker-created") {
            continue;
        }
        let worker = event
            .pointer("/payload/worker")
            .ok_or_else(|| "Stored Mission worker is invalid.".to_string())?;
        let worker_id = bounded(
            worker
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission worker identity is invalid.".to_string())?,
            "Mission worker",
            160,
        )?;
        let step_key = bounded(
            worker
                .get("planStepKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission worker step is invalid.".to_string())?,
            "Mission Plan step",
            160,
        )?;
        if worker_by_step.insert(step_key, worker_id).is_some() {
            return Err("Stored Mission workers are ambiguous.".into());
        }
    }

    let mut complete = true;
    for step in selected_steps {
        let step_key = bounded(
            step.get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected Mission plan step is invalid.".to_string())?,
            "Mission Plan step",
            160,
        )?;
        let matching_outputs = if step.get("kind").and_then(Value::as_str) == Some("coordinate") {
            journal
                .events
                .iter()
                .filter(|event| {
                    event.get("type").and_then(Value::as_str) == Some("aggregation-recorded")
                        && event
                            .pointer("/payload/aggregation/stepKey")
                            .and_then(Value::as_str)
                            == Some(step_key.as_str())
                })
                .filter_map(|event| event.pointer("/payload/aggregation/producedOutputs"))
                .collect::<Vec<_>>()
        } else if let Some(worker_id) = worker_by_step.get(&step_key) {
            journal
                .events
                .iter()
                .filter(|event| {
                    event.get("type").and_then(Value::as_str) == Some("worker-completed")
                        && event.pointer("/payload/workerId").and_then(Value::as_str)
                            == Some(worker_id.as_str())
                })
                .filter_map(|event| event.pointer("/payload/outputs"))
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        if matching_outputs.len() != 1 {
            complete = false;
            continue;
        }
        let step_references = output_evidence_refs(matching_outputs[0])?;
        if step_references.is_empty() {
            complete = false;
        }
        references.extend(step_references);
    }
    Ok((references, complete))
}

fn human_evaluation_identity(run_id: &str, criterion_key: &str) -> (String, String, String) {
    let mut digest = Sha256::new();
    digest.update(b"fable.mission.human-evaluation.v1\0");
    digest.update(run_id.as_bytes());
    digest.update(b"\0");
    digest.update(criterion_key.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    (
        format!("mission_human_evaluation_event_{digest}"),
        format!("mission-human-evaluation:{digest}"),
        format!("mission_human_evaluation_{digest}"),
    )
}

fn append_human_evaluation_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    authorized: AuthorizedRun,
    criterion_key: &str,
    passed: bool,
    expected_revision: i64,
    expected_sequence: i64,
) -> crate::store::Result<mission_run::MissionRunJournalRow> {
    let run_id = bounded(
        authorized
            .journal
            .run
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run identity is invalid.".into())
            })?,
        "Mission run",
        160,
    )
    .map_err(crate::store::StoreError::Invalid)?;
    let criterion_key = bounded(criterion_key, "Mission acceptance criterion", 160)
        .map_err(crate::store::StoreError::Invalid)?;
    let (event_id, idempotency_key, evaluation_key) =
        human_evaluation_identity(&run_id, &criterion_key);
    let decision_summary = if passed {
        "The signed-in member accepted this criterion after reviewing the durable Mission evidence."
    } else {
        "The signed-in member did not accept this criterion after reviewing the durable Mission evidence."
    };
    let criteria = authorized
        .lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .filter(|criteria| criteria.len() <= 128)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission acceptance criteria are invalid.".into())
        })?;
    let matching = criteria
        .iter()
        .filter(|criterion| {
            criterion.get("key").and_then(Value::as_str) == Some(criterion_key.as_str())
        })
        .collect::<Vec<_>>();
    if matching.len() != 1 || matching[0].get("evaluator").and_then(Value::as_str) != Some("human")
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission criterion is unavailable for human review.".into(),
        ));
    }
    let available_evidence = exact_durable_evidence_refs(&authorized.journal)
        .map_err(crate::store::StoreError::Invalid)?;
    let (required_evidence, derived_evidence_complete) =
        criterion_required_evidence_refs(&authorized.lifecycle, &authorized.journal, matching[0])
            .map_err(crate::store::StoreError::Invalid)?;
    let evidence_available = required_evidence
        .iter()
        .all(|reference| available_evidence.contains(reference));
    let evidence = required_evidence
        .iter()
        .filter(|reference| available_evidence.contains(*reference))
        .cloned()
        .collect::<Vec<_>>();
    let matching_events = authorized
        .journal
        .events
        .iter()
        .filter(|event| {
            event.get("id").and_then(Value::as_str) == Some(event_id.as_str())
                || event.get("idempotencyKey").and_then(Value::as_str)
                    == Some(idempotency_key.as_str())
                || event
                    .pointer("/payload/evaluation/evaluationKey")
                    .and_then(Value::as_str)
                    == Some(evaluation_key.as_str())
        })
        .collect::<Vec<_>>();
    if matching_events.len() > 1 {
        return Err(crate::store::StoreError::Invalid(
            "Stored human Mission evaluation is ambiguous.".into(),
        ));
    }
    if let Some(event) = matching_events.first() {
        let criteria = event
            .pointer("/payload/evaluation/criteria")
            .and_then(Value::as_array);
        let exact_replay = event.get("id").and_then(Value::as_str) == Some(event_id.as_str())
            && event.get("idempotencyKey").and_then(Value::as_str)
                == Some(idempotency_key.as_str())
            && event.get("type").and_then(Value::as_str) == Some("evaluation-recorded")
            && event.pointer("/actor/kind").and_then(Value::as_str) == Some("internal-user")
            && event
                .pointer("/actor/internalUserId")
                .and_then(Value::as_str)
                == Some(authorized.actor.as_str())
            && event
                .pointer("/payload/evaluation/reviewerInternalUserId")
                .and_then(Value::as_str)
                == Some(authorized.actor.as_str())
            && event
                .pointer("/payload/evaluation/target/kind")
                .and_then(Value::as_str)
                == Some("run")
            && event
                .pointer("/payload/evaluation/target/runId")
                .and_then(Value::as_str)
                == Some(run_id.as_str())
            && event
                .pointer("/payload/evaluation/evaluationKey")
                .and_then(Value::as_str)
                == Some(evaluation_key.as_str())
            && event
                .pointer("/payload/evaluation/verdict")
                .and_then(Value::as_str)
                == Some(if passed { "pass" } else { "fail" })
            && event
                .pointer("/payload/evaluation/summary")
                .and_then(Value::as_str)
                == Some(decision_summary)
            && event
                .pointer("/payload/evaluation/recommendedAction")
                .and_then(Value::as_str)
                == Some(if passed { "accept" } else { "revise" })
            && criteria.is_some_and(|criteria| {
                criteria.len() == 1
                    && criteria[0].get("criterionKey").and_then(Value::as_str)
                        == Some(criterion_key.as_str())
                    && criteria[0].get("passed").and_then(Value::as_bool) == Some(passed)
                    && criteria[0].get("summary").and_then(Value::as_str) == Some(decision_summary)
                    && criteria[0]
                        .get("evidenceRefs")
                        .and_then(Value::as_array)
                        .is_some_and(|references| {
                            references.len() == evidence.len()
                                && references.iter().zip(&evidence).all(|(stored, expected)| {
                                    stored.as_str() == Some(expected.as_str())
                                })
                        })
            });
        if exact_replay {
            return Ok(authorized.journal);
        }
        return Err(crate::store::StoreError::Invalid(
            "Human Mission evaluation replay changed its durable decision.".into(),
        ));
    }
    validate_head(&authorized.journal, expected_revision, expected_sequence)
        .map_err(crate::store::StoreError::Invalid)?;
    let progress = mission_progress_projection(&authorized.lifecycle, &authorized.journal)
        .map_err(crate::store::StoreError::Invalid)?;
    if progress
        .get("steps")
        .and_then(Value::as_array)
        .is_none_or(|steps| {
            steps.iter().any(|step| {
                matches!(
                    step.get("state").and_then(Value::as_str),
                    Some("ready" | "running" | "waiting")
                )
            })
        })
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission work must settle before human acceptance review.".into(),
        ));
    }
    if passed && (!derived_evidence_complete || !evidence_available) {
        return Err(crate::store::StoreError::Invalid(
            "Required durable evidence is unavailable for this acceptance decision.".into(),
        ));
    }
    let at = now();
    let revision = authorized
        .journal
        .run
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run revision is invalid.".into())
        })?;
    let sequence = authorized
        .journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?
        + 1;
    let previous = authorized
        .journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let workspace = authorized
        .journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    let attempt_number = authorized
        .journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run attempt is invalid.".into())
        })?;
    let evaluation = json!({
        "evaluationKey":evaluation_key,
        "target":{"kind":"run","runId":run_id},
        "reviewerInternalUserId":authorized.actor,
        "verdict":if passed {"pass"} else {"fail"},
        "criteria":[{
            "criterionKey":criterion_key,
            "passed":passed,
            "summary":decision_summary,
            "evidenceRefs":evidence
        }],
        "summary":decision_summary,
        "recommendedAction":if passed {"accept"} else {"revise"},
        "evaluatedAt":at
    });
    let event = json!({
        "workspaceId":workspace,"visibility":"member-private",
        "ownerMemberId":authorized.member,"authority":"local","schemaVersion":1,"revision":1,
        "createdByInternalUserId":authorized.actor,"createdAt":at,"updatedAt":at,
        "id":event_id,"runId":run_id,"type":"evaluation-recorded",
        "sequence":sequence,"previousEventId":previous,"attemptNumber":attempt_number,
        "occurredAt":at,
        "actor":{"kind":"internal-user","internalUserId":authorized.actor},
        "idempotencyKey":idempotency_key,
        "payload":{"evaluation":evaluation}
    });
    let mut projected = authorized.journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":event_id}),
    );
    mission_run::append(
        tx,
        store,
        &authorized.scope,
        &authorized.member,
        &run_id,
        revision,
        sequence - 1,
        &event_id,
        "evaluation-recorded",
        &idempotency_key,
        &event,
        &Value::Object(projected),
        &at,
    )
}

fn resolve_status(
    strategy: &str,
    quorum: Option<usize>,
    allow_failed: bool,
    worker_ids: &[String],
    completed: &BTreeSet<String>,
    failed: &BTreeSet<String>,
    deadline_elapsed: bool,
    run_cancelled: bool,
) -> Option<&'static str> {
    if run_cancelled {
        return Some("cancelled");
    }
    let complete_count = worker_ids
        .iter()
        .filter(|worker| completed.contains(*worker))
        .count();
    let failed_count = worker_ids
        .iter()
        .filter(|worker| failed.contains(*worker))
        .count();
    let accepted = complete_count + usize::from(allow_failed) * failed_count;
    let target = match strategy {
        "all" => worker_ids.len(),
        "any" => 1,
        "quorum" => quorum.unwrap_or(usize::MAX),
        _ => return Some("cancelled"),
    };
    if accepted >= target && (allow_failed || failed_count == 0) {
        return Some("satisfied");
    }
    if deadline_elapsed {
        return Some("timed-out");
    }
    let terminal = complete_count + failed_count;
    let possible = accepted + worker_ids.len().saturating_sub(terminal);
    if (!allow_failed && failed_count > 0) || possible < target {
        return Some("cancelled");
    }
    None
}

fn safe_cost_observation(value: &Value) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Stored Mission cost observation is invalid.".to_string())?;
    let amount = value
        .pointer("/amount/amount")
        .and_then(Value::as_str)
        .ok_or_else(|| "Stored Mission cost amount is invalid.".to_string())?;
    let valid_amount = !amount.is_empty()
        && amount.len() <= 64
        && amount
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        && amount.chars().filter(|character| *character == '.').count() <= 1;
    let currency = value
        .pointer("/amount/currencyCode")
        .and_then(Value::as_str)
        .filter(|currency| {
            currency.len() == 3
                && currency
                    .chars()
                    .all(|character| character.is_ascii_uppercase())
        })
        .ok_or_else(|| "Stored Mission cost currency is invalid.".to_string())?;
    let provenance = object
        .get("provenance")
        .and_then(Value::as_str)
        .filter(|provenance| {
            matches!(
                *provenance,
                "provider-reported" | "fable-calculated" | "estimated" | "unknown"
            )
        })
        .ok_or_else(|| "Stored Mission cost provenance is invalid.".to_string())?;
    if !valid_amount {
        return Err("Stored Mission cost observation is invalid.".into());
    }
    let pricing_reference = object
        .get("pricingReference")
        .and_then(Value::as_str)
        .map(|reference| bounded(reference, "Mission pricing reference", 2_000))
        .transpose()?;
    Ok(json!({
        "amount":{"amount":amount,"currencyCode":currency},
        "provenance":provenance,
        "pricingReference":pricing_reference
    }))
}

fn safe_budget_projection(run: &Value) -> Result<Value, String> {
    let budget = run
        .get("budget")
        .and_then(Value::as_object)
        .ok_or_else(|| "Mission run budget is invalid.".to_string())?;
    let mut projected = serde_json::Map::new();
    for field in [
        "maxDurationMs",
        "maxInputTokens",
        "maxOutputTokens",
        "maxToolCalls",
        "maxWorkers",
        "maxAttempts",
    ] {
        let Some(value) = budget.get(field) else {
            continue;
        };
        let value = value
            .as_i64()
            .filter(|value| *value >= 0)
            .ok_or_else(|| "Mission run budget is invalid.".to_string())?;
        projected.insert(field.into(), json!(value));
    }
    if let Some(max_cost) = budget.get("maxCost") {
        let amount = max_cost
            .get("amount")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission run cost budget is invalid.".to_string())?;
        let currency = max_cost
            .get("currencyCode")
            .and_then(Value::as_str)
            .filter(|currency| {
                currency.len() == 3
                    && currency
                        .chars()
                        .all(|character| character.is_ascii_uppercase())
            })
            .ok_or_else(|| "Mission run cost budget is invalid.".to_string())?;
        if amount.is_empty()
            || amount.len() > 64
            || !amount
                .chars()
                .all(|character| character.is_ascii_digit() || character == '.')
            || amount.chars().filter(|character| *character == '.').count() > 1
        {
            return Err("Mission run cost budget is invalid.".into());
        }
        projected.insert(
            "maxCost".into(),
            json!({"amount":amount,"currencyCode":currency}),
        );
    }
    Ok(Value::Object(projected))
}

fn automatic_coordination_identity(
    run_id: &str,
    event_kind: &str,
    reference: &str,
) -> (String, String) {
    let mut digest = Sha256::new();
    digest.update(b"fable.mission.coordination.advance.v1\0");
    digest.update(run_id.as_bytes());
    digest.update(b"\0");
    digest.update(event_kind.as_bytes());
    digest.update(b"\0");
    digest.update(reference.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    (
        format!("mission-event-{}", &digest[..32]),
        format!("coordination-auto:{event_kind}:{}", &digest[..32]),
    )
}

fn next_automatic_join_resolution(
    journal: &mission_run::MissionRunJournalRow,
) -> Result<Option<(String, Value)>, String> {
    let resolved_values = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("join-resolved"))
        .filter_map(|event| {
            event
                .pointer("/payload/join/joinKey")
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    let resolved = resolved_values.iter().copied().collect::<BTreeSet<_>>();
    if resolved.len() != resolved_values.len() {
        return Err("Stored Mission join resolutions are ambiguous.".into());
    }
    let known_workers = workers_by_step(journal)?
        .into_values()
        .collect::<BTreeSet<_>>();
    let (completed, failed) = strict_terminal_workers(journal)?;
    let mut opened = BTreeSet::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("join-opened") {
            continue;
        }
        let join = event
            .pointer("/payload/join")
            .and_then(Value::as_object)
            .ok_or_else(|| "Stored Mission join declaration is invalid.".to_string())?;
        let join_key = bounded(
            join.get("joinKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission join identity is invalid.".to_string())?,
            "Mission join",
            200,
        )?;
        if !opened.insert(join_key.clone()) {
            return Err("Stored Mission join declarations are ambiguous.".into());
        }
        if resolved.contains(join_key.as_str()) {
            continue;
        }
        let strategy = join
            .get("strategy")
            .and_then(Value::as_str)
            .filter(|strategy| matches!(*strategy, "all" | "any" | "quorum"))
            .ok_or_else(|| "Stored Mission join strategy is invalid.".to_string())?;
        let worker_ids = join
            .get("workerIds")
            .and_then(Value::as_array)
            .filter(|workers| (2..=32).contains(&workers.len()))
            .ok_or_else(|| "Stored Mission join workers are invalid.".to_string())?
            .iter()
            .map(|worker| {
                bounded(
                    worker
                        .as_str()
                        .ok_or_else(|| "Stored Mission join worker is invalid.".to_string())?,
                    "Mission join worker",
                    200,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if worker_ids.iter().collect::<BTreeSet<_>>().len() != worker_ids.len() {
            return Err("Stored Mission join workers are ambiguous.".into());
        }
        if worker_ids
            .iter()
            .any(|worker| !known_workers.contains(worker))
        {
            return Err("Stored Mission join references an unknown worker.".into());
        }
        let quorum = join
            .get("quorum")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok());
        if (strategy == "quorum"
            && quorum.is_none_or(|value| value == 0 || value > worker_ids.len()))
            || (strategy != "quorum" && quorum.is_some())
        {
            return Err("Stored Mission join quorum is invalid.".into());
        }
        let allow_failed = join
            .get("allowFailedWorkers")
            .and_then(Value::as_bool)
            .ok_or_else(|| "Stored Mission join failure policy is invalid.".to_string())?;
        let target_step_key = join
            .get("targetStepKey")
            .and_then(Value::as_str)
            .map(|value| bounded(value, "Mission join target", 160))
            .transpose()?;
        let deadline = join.get("deadline").filter(|value| !value.is_null());
        let deadline_elapsed = deadline
            .and_then(Value::as_str)
            .map(|deadline| {
                DateTime::parse_from_rfc3339(deadline)
                    .map(|deadline| deadline <= Utc::now())
                    .map_err(|_| "Stored Mission join deadline is invalid.".to_string())
            })
            .transpose()?
            .unwrap_or(false);
        let status = resolve_status(
            strategy,
            quorum,
            allow_failed,
            &worker_ids,
            &completed,
            &failed,
            deadline_elapsed,
            matches!(
                journal.run.get("status").and_then(Value::as_str),
                Some("cancelling" | "cancelled")
            ),
        );
        let Some(status) = status else {
            continue;
        };
        let satisfied_workers = worker_ids
            .iter()
            .filter(|worker| completed.contains(*worker))
            .cloned()
            .collect::<Vec<_>>();
        let failed_workers = worker_ids
            .iter()
            .filter(|worker| failed.contains(*worker))
            .cloned()
            .collect::<Vec<_>>();
        return Ok(Some((
            join_key.clone(),
            json!({
                "joinKey":join_key,
                "targetStepKey":target_step_key,
                "status":status,
                "strategy":strategy,
                "workerIds":worker_ids,
                "quorum":quorum,
                "allowFailedWorkers":allow_failed,
                "deadline":deadline,
                "satisfiedWorkerIds":satisfied_workers,
                "failedWorkerIds":failed_workers
            }),
        )));
    }
    Ok(None)
}

fn next_automatic_aggregation(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
) -> Result<Option<(String, Value)>, String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    let recorded_values = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("aggregation-recorded"))
        .filter_map(|event| {
            event
                .pointer("/payload/aggregation/stepKey")
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    let recorded = recorded_values.iter().copied().collect::<BTreeSet<_>>();
    if recorded.len() != recorded_values.len() {
        return Err("Stored Mission aggregation facts are ambiguous.".into());
    }
    let workers = workers_by_step(journal)?;
    let (completed, failed) = strict_terminal_workers(journal)?;
    for step in steps {
        if step.get("kind").and_then(Value::as_str) != Some("coordinate") {
            continue;
        }
        let step_key = bounded(
            step.get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected coordinate step is invalid.".to_string())?,
            "Coordinate step",
            160,
        )?;
        if recorded.contains(step_key.as_str()) {
            continue;
        }
        let dependencies = step
            .get("dependsOnStepKeys")
            .and_then(Value::as_array)
            .filter(|dependencies| (1..=32).contains(&dependencies.len()))
            .ok_or_else(|| "Coordinate step dependencies are invalid.".to_string())?
            .iter()
            .map(|dependency| {
                dependency
                    .as_str()
                    .ok_or_else(|| "Coordinate step dependency is invalid.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let dependency_workers = dependencies
            .iter()
            .map(|dependency| {
                workers
                    .get(*dependency)
                    .cloned()
                    .ok_or_else(|| "Coordinate dependency worker is unavailable.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let all_terminal = dependency_workers
            .iter()
            .all(|worker| completed.contains(worker) || failed.contains(worker));
        if !all_terminal {
            continue;
        }
        if dependencies.len() == 1 && !completed.contains(&dependency_workers[0]) {
            continue;
        }
        if dependencies.len() > 1 {
            let revision_id = lifecycle
                .current_revision
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected plan revision is invalid.".to_string())?;
            if !has_satisfied_dependency_join(journal, revision_id, &step_key, &dependency_workers)
            {
                continue;
            }
        }
        return Ok(Some((
            step_key.clone(),
            deterministic_aggregation_receipt(lifecycle, journal, &step_key)?,
        )));
    }
    Ok(None)
}

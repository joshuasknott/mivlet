#[tauri::command]
pub fn mission_coordination_progress_read(run_id: String) -> Result<Value, String> {
    let run_id = bounded(&run_id, "Mission run", 160)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let authorized = authorized_run_for_read(tx, store, &run_id)?;
            mission_progress_projection(&authorized.lifecycle, &authorized.journal)
                .map_err(crate::store::StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionProgressListInput {
    source_thread_id: String,
    limit: Option<usize>,
}

fn thread_progress_list_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    member: &str,
    source_thread_id: &str,
    limit: usize,
) -> crate::store::Result<Value> {
    let ids = mission_run::list_recent_ids(tx, scope, member, 101)?;
    let mut truncated = ids.len() > 100;
    let mut progress = Vec::new();
    let mut unavailable_count = 0usize;
    for run_id in ids.into_iter().take(100) {
        let Some(journal) = mission_run::get(tx, store, scope, member, &run_id)? else {
            unavailable_count += 1;
            continue;
        };
        if journal.run.get("sourceThreadId").and_then(Value::as_str) != Some(source_thread_id) {
            continue;
        }
        let Some(mission_id) = journal
            .run
            .pointer("/initiator/missionId")
            .and_then(Value::as_str)
        else {
            unavailable_count += 1;
            continue;
        };
        let Some(lifecycle) = mission_plan::get(tx, store, scope, member, mission_id)? else {
            unavailable_count += 1;
            continue;
        };
        if journal.run.get("planRevisionId") != lifecycle.current_revision.get("id")
            || journal.run.get("workspaceId") != lifecycle.mission.get("workspaceId")
            || journal.run.get("ownerMemberId") != lifecycle.mission.get("ownerMemberId")
        {
            unavailable_count += 1;
            continue;
        }
        match mission_progress_projection(&lifecycle, &journal) {
            Ok(projection) if progress.len() < limit => progress.push(json!({
                "runId":run_id,
                "progress":projection
            })),
            Ok(_) => {
                truncated = true;
                break;
            }
            Err(_) => unavailable_count += 1,
        }
    }
    Ok(json!({
        "progress":progress,
        "unavailableCount":unavailable_count,
        "truncated":truncated
    }))
}

#[tauri::command]
pub fn mission_coordination_progress_list(
    input: MissionProgressListInput,
) -> Result<Value, String> {
    let source_thread_id = bounded(&input.source_thread_id, "Conversation", 160)?;
    let limit = input.limit.unwrap_or(24);
    if !(1..=100).contains(&limit) {
        return Err("Mission progress list limit is invalid.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required for Mission progress.".into(),
                )
            })?;
            let scope = DataScope::workspace(context.active_workspace.local_workspace_id)?;
            thread_progress_list_in_tx(tx, store, &scope, &member, &source_thread_id, limit)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_human_evaluation_record(
    input: MissionHumanEvaluationInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let run_id = bounded(&input.run_id, "Mission run", 160)?;
    let criterion_key = bounded(&input.criterion_key, "Mission acceptance criterion", 160)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &run_id)?;
            append_human_evaluation_in_tx(
                tx,
                store,
                authorized,
                &criterion_key,
                input.passed,
                input.expected_run_revision,
                input.expected_last_sequence,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_prepare_workers(
    run_id: String,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &run_id)?;
            prepare_provider_workers_in_tx(tx, store, authorized)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_worker_objective(
    input: MissionWorkerObjectiveInput,
) -> Result<String, String> {
    let run_id = bounded(&input.run_id, "Mission run", 160)?;
    let worker_id = bounded(&input.worker_id, "Mission worker", 200)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &run_id)?;
            native_general_worker_objective_in_tx(
                tx,
                store,
                &authorized.scope,
                &authorized.member,
                &authorized.journal,
                &authorized.lifecycle,
                &worker_id,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_advance(run_id: String) -> Result<Value, String> {
    let run_id = bounded(&run_id, "Mission run", 160)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let mut appended_event_ids = Vec::new();
            for _ in 0..64 {
                let authorized = authorized_run(tx, store, &run_id)?;
                if let Some((join_key, join)) =
                    next_automatic_join_resolution(&authorized.journal)
                        .map_err(crate::store::StoreError::Invalid)?
                {
                    let (event_id, event_key) =
                        automatic_coordination_identity(&run_id, "join-resolved", &join_key);
                    if authorized.journal.events.iter().any(|event| {
                        event.get("idempotencyKey").and_then(Value::as_str)
                            == Some(event_key.as_str())
                    }) {
                        return Err(crate::store::StoreError::Invalid(
                            "Automatic Mission join replay no longer matches its durable fact."
                                .into(),
                        ));
                    }
                    let at = now();
                    append_event(
                        tx,
                        store,
                        &authorized,
                        &event_id,
                        "join-resolved",
                        &event_key,
                        json!({"join":join}),
                        &at,
                    )?;
                    appended_event_ids.push(event_id);
                    continue;
                }
                if let Some((step_key, aggregation)) =
                    next_automatic_aggregation(&authorized.lifecycle, &authorized.journal)
                        .map_err(crate::store::StoreError::Invalid)?
                {
                    let (event_id, event_key) = automatic_coordination_identity(
                        &run_id,
                        "aggregation-recorded",
                        &step_key,
                    );
                    if authorized.journal.events.iter().any(|event| {
                        event.get("idempotencyKey").and_then(Value::as_str)
                            == Some(event_key.as_str())
                    }) {
                        return Err(crate::store::StoreError::Invalid(
                            "Automatic Mission aggregation replay no longer matches its durable fact."
                                .into(),
                        ));
                    }
                    let at = now();
                    append_event(
                        tx,
                        store,
                        &authorized,
                        &event_id,
                        "aggregation-recorded",
                        &event_key,
                        json!({"aggregation":aggregation}),
                        &at,
                    )?;
                    appended_event_ids.push(event_id);
                    continue;
                }
                let progress =
                    mission_progress_projection(&authorized.lifecycle, &authorized.journal)
                        .map_err(crate::store::StoreError::Invalid)?;
                return Ok(json!({
                    "journal":authorized.journal,
                    "progress":progress,
                    "appendedEventIds":appended_event_ids
                }));
            }
            Err(crate::store::StoreError::Invalid(
                "Automatic Mission coordination exceeded its bounded advance limit.".into(),
            ))
        })
        .map_err(|error| error.to_string())
}

fn append_general_terminal(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    authorized: &AuthorizedRun,
    terminal: &GeneralMissionTerminal,
    event_id: &str,
    event_key: &str,
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
        "id":event_id,"runId":run_id,"type":terminal.event_type,
        "sequence":sequence,"previousEventId":previous,
        "attemptNumber":attempt_number,"occurredAt":at,
        "actor":{"kind":"system"},"idempotencyKey":event_key,
        "payload":terminal.event_payload
    });
    let mut projected = authorized.journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("status".into(), json!(terminal.run_status));
    projected.insert("terminalResult".into(), terminal.run_result.clone());
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
        terminal.event_type,
        event_key,
        &event,
        &Value::Object(projected),
        at,
    )
}

#[tauri::command]
pub fn mission_coordination_finalize(run_id: String) -> Result<Value, String> {
    let run_id = bounded(&run_id, "Mission run", 160)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run_for_read(tx, store, &run_id)?;
            let revision_id = authorized
                .lifecycle
                .current_revision
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Selected plan revision is invalid.".into())
                })?;
            let (event_id, event_key) =
                automatic_coordination_identity(&run_id, "run-terminal", revision_id);
            if matches!(
                authorized.journal.run.get("status").and_then(Value::as_str),
                Some("completed" | "partially-completed" | "failed" | "cancelled")
            ) {
                let terminal_matches = authorized.journal.events.last().is_some_and(|event| {
                    event.get("id").and_then(Value::as_str) == Some(event_id.as_str())
                        && event.get("idempotencyKey").and_then(Value::as_str)
                            == Some(event_key.as_str())
                        && matches!(
                            event.get("type").and_then(Value::as_str),
                            Some("run-completed" | "run-failed" | "run-cancelled")
                        )
                }) && authorized.journal.run.get("terminalResult").is_some()
                    && authorized
                        .lifecycle
                        .mission
                        .pointer("/terminalResult/producingRunIds/0")
                        .and_then(Value::as_str)
                        == Some(run_id.as_str());
                if !terminal_matches {
                    return Err(crate::store::StoreError::Invalid(
                        "Terminal Mission coordination does not match this finalizer.".into(),
                    ));
                }
                if authorized.journal.run.get("status").and_then(Value::as_str) == Some("completed")
                    && authorized
                        .journal
                        .run
                        .pointer("/terminalResult/outcome")
                        .and_then(Value::as_str)
                        == Some("succeeded")
                    && declared_general_graph(&authorized.lifecycle)
                {
                    let mut outputs = authorized
                        .journal
                        .run
                        .pointer("/terminalResult/outputs")
                        .cloned()
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "Completed general Mission outputs are unavailable.".into(),
                            )
                        })?;
                    let specs =
                        reviewed_general_artifact_specs(tx, store, &authorized, &mut outputs)?;
                    if outputs
                        != *authorized
                            .journal
                            .run
                            .pointer("/terminalResult/outputs")
                            .ok_or_else(|| {
                                crate::store::StoreError::Invalid(
                                    "Completed general Mission outputs are unavailable.".into(),
                                )
                            })?
                    {
                        return Err(crate::store::StoreError::Invalid(
                            "Completed general Mission outputs predate reviewed Artifact binding."
                                .into(),
                        ));
                    }
                    materialize_reviewed_general_artifacts(
                        tx,
                        store,
                        &authorized,
                        &event_id,
                        &specs,
                    )?;
                }
                let progress =
                    mission_progress_projection(&authorized.lifecycle, &authorized.journal)
                        .map_err(crate::store::StoreError::Invalid)?;
                return Ok(json!({
                    "journal":authorized.journal,
                    "missionResult":authorized.lifecycle.mission.get("terminalResult"),
                    "progress":progress,
                    "terminalEventId":event_id
                }));
            }
            let mut terminal =
                derive_general_terminal(&authorized.lifecycle, &authorized.journal, &now())
                    .map_err(crate::store::StoreError::Invalid)?;
            let artifact_specs =
                bind_reviewed_general_artifacts(tx, store, &authorized, &mut terminal)?;
            let at = terminal
                .run_result
                .get("completedAt")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission completion time is invalid.".into())
                })?
                .to_string();
            let journal = append_general_terminal(
                tx,
                store,
                &authorized,
                &terminal,
                &event_id,
                &event_key,
                &at,
            )?;
            materialize_reviewed_general_artifacts(
                tx,
                store,
                &authorized,
                &event_id,
                &artifact_specs,
            )?;
            match terminal.outcome {
                "succeeded" => mission_plan::mark_completed(
                    tx,
                    store,
                    &authorized.scope,
                    &authorized.member,
                    &authorized.lifecycle,
                    &terminal.mission_result,
                    &at,
                )?,
                "partial" => mission_plan::mark_partially_completed(
                    tx,
                    store,
                    &authorized.scope,
                    &authorized.member,
                    &authorized.lifecycle,
                    &terminal.mission_result,
                    &at,
                )?,
                "failed" => mission_plan::mark_failed(
                    tx,
                    store,
                    &authorized.scope,
                    &authorized.member,
                    &authorized.lifecycle,
                    &terminal.mission_result,
                    &at,
                )?,
                "cancelled" => mission_plan::mark_cancelled(
                    tx,
                    store,
                    &authorized.scope,
                    &authorized.member,
                    &authorized.lifecycle,
                    &terminal.mission_result,
                    &at,
                )?,
                _ => {
                    return Err(crate::store::StoreError::Invalid(
                        "Mission terminal outcome is invalid.".into(),
                    ))
                }
            }
            let progress = mission_progress_projection(&authorized.lifecycle, &journal)
                .map_err(crate::store::StoreError::Invalid)?;
            Ok(json!({
                "journal":journal,
                "missionResult":terminal.mission_result,
                "progress":progress,
                "terminalEventId":event_id
            }))
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_join_open(
    input: MissionJoinOpenInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &input.run_id)?;
            let event_key = format!(
                "coordination-join-open:{}",
                bounded(&input.idempotency_key, "Join idempotency key", 200)
                    .map_err(crate::store::StoreError::Invalid)?
            );
            if let Some(existing) = authorized.journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                let worker_ids = exact_dependency_workers(
                    &authorized.lifecycle,
                    &authorized.journal,
                    &input.target_step_key,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                let plan_revision_id = authorized
                    .lifecycle
                    .current_revision
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "Selected plan revision is invalid.".into(),
                        )
                    })?;
                let expected_join_key =
                    coordination_join_key(plan_revision_id, &input.target_step_key);
                let join = existing.pointer("/payload/join");
                if existing.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
                    && existing.get("type").and_then(Value::as_str) == Some("join-opened")
                    && join
                        .and_then(|value| value.get("joinKey"))
                        .and_then(Value::as_str)
                        == Some(expected_join_key.as_str())
                    && join
                        .and_then(|value| value.get("targetStepKey"))
                        .and_then(Value::as_str)
                        == Some(input.target_step_key.as_str())
                    && join
                        .and_then(|value| value.get("strategy"))
                        .and_then(Value::as_str)
                        == Some(input.strategy.as_str())
                    && join
                        .and_then(|value| value.get("allowFailedWorkers"))
                        .and_then(Value::as_bool)
                        == Some(input.allow_failed_workers)
                    && join
                        .and_then(|value| value.get("quorum"))
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        == input.quorum
                    && join
                        .and_then(|value| value.get("deadline"))
                        .and_then(Value::as_str)
                        == input.deadline.as_deref()
                    && join
                        .and_then(|value| value.get("workerIds"))
                        .and_then(Value::as_array)
                        .is_some_and(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .eq(worker_ids.iter().map(String::as_str))
                        })
                {
                    return Ok(authorized.journal);
                }
                return Err(crate::store::StoreError::Invalid(
                    "Join idempotency key already represents another declaration.".into(),
                ));
            }
            validate_head(
                &authorized.journal,
                input.expected_run_revision,
                input.expected_last_sequence,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.run_id, "Mission run", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.target_step_key, "Join target step", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.event_id, "Join event", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            let worker_ids = exact_dependency_workers(
                &authorized.lifecycle,
                &authorized.journal,
                &input.target_step_key,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let plan_revision_id = authorized
                .lifecycle
                .current_revision
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Selected plan revision is invalid.".into())
                })?;
            let join_key = coordination_join_key(plan_revision_id, &input.target_step_key);
            if authorized.journal.events.iter().any(|event| {
                matches!(
                    event.get("type").and_then(Value::as_str),
                    Some("join-opened" | "join-resolved")
                ) && event
                    .pointer("/payload/join/joinKey")
                    .and_then(Value::as_str)
                    == Some(join_key.as_str())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "This plan dependency join is already declared.".into(),
                ));
            }
            if !matches!(input.strategy.as_str(), "all" | "any" | "quorum")
                || (input.strategy == "quorum"
                    && input
                        .quorum
                        .is_none_or(|value| value == 0 || value > worker_ids.len()))
                || (input.strategy != "quorum" && input.quorum.is_some())
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency join policy is invalid.".into(),
                ));
            }
            let (completed, failed) = terminal_workers(&authorized.journal);
            if worker_ids
                .iter()
                .any(|worker| completed.contains(worker) || failed.contains(worker))
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency joins must be declared before worker outcomes are known."
                        .into(),
                ));
            }
            if input.deadline.as_deref().is_some_and(|deadline| {
                DateTime::parse_from_rfc3339(deadline)
                    .ok()
                    .is_none_or(|deadline| deadline <= Utc::now())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency join deadline is invalid.".into(),
                ));
            }
            let at = now();
            append_event(
                tx,
                store,
                &authorized,
                &input.event_id,
                "join-opened",
                &event_key,
                json!({"join":{
                    "joinKey":join_key,"targetStepKey":input.target_step_key,
                    "status":"open","strategy":input.strategy,
                    "workerIds":worker_ids,"quorum":input.quorum,
                    "allowFailedWorkers":input.allow_failed_workers,"deadline":input.deadline,
                    "satisfiedWorkerIds":[],"failedWorkerIds":[]
                }}),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_join_resolve(
    input: MissionJoinResolveInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &input.run_id)?;
            let event_key = format!(
                "coordination-join-resolve:{}",
                bounded(&input.idempotency_key, "Join idempotency key", 200)
                    .map_err(crate::store::StoreError::Invalid)?
            );
            if let Some(existing) = authorized.journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                if existing.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
                    && existing.get("type").and_then(Value::as_str) == Some("join-resolved")
                    && existing
                        .pointer("/payload/join/joinKey")
                        .and_then(Value::as_str)
                        == Some(input.join_key.as_str())
                {
                    return Ok(authorized.journal);
                }
                return Err(crate::store::StoreError::Invalid(
                    "Join idempotency key already represents another resolution.".into(),
                ));
            }
            validate_head(
                &authorized.journal,
                input.expected_run_revision,
                input.expected_last_sequence,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.run_id, "Mission run", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.join_key, "Mission join", 96)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.event_id, "Join event", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            if authorized.journal.events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("join-resolved")
                    && event
                        .pointer("/payload/join/joinKey")
                        .and_then(Value::as_str)
                        == Some(input.join_key.as_str())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency join is already resolved.".into(),
                ));
            }
            let open = authorized
                .journal
                .events
                .iter()
                .find(|event| {
                    event.get("type").and_then(Value::as_str) == Some("join-opened")
                        && event
                            .pointer("/payload/join/joinKey")
                            .and_then(Value::as_str)
                            == Some(input.join_key.as_str())
                })
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join declaration is unavailable.".into(),
                    )
                })?;
            let join = open
                .pointer("/payload/join")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join declaration is invalid.".into(),
                    )
                })?;
            let strategy = join.get("strategy").and_then(Value::as_str).unwrap_or("");
            let quorum = join
                .get("quorum")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            let allow_failed = join
                .get("allowFailedWorkers")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let worker_ids = join
                .get("workerIds")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join workers are invalid.".into(),
                    )
                })?
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join workers are invalid.".into(),
                    )
                })?;
            let deadline_elapsed = join
                .get("deadline")
                .and_then(Value::as_str)
                .and_then(|deadline| DateTime::parse_from_rfc3339(deadline).ok())
                .is_some_and(|deadline| deadline <= Utc::now());
            let (completed, failed) = terminal_workers(&authorized.journal);
            let status = resolve_status(
                strategy,
                quorum,
                allow_failed,
                &worker_ids,
                &completed,
                &failed,
                deadline_elapsed,
                matches!(
                    authorized.journal.run.get("status").and_then(Value::as_str),
                    Some("cancelling" | "cancelled")
                ),
            )
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Mission dependency join is still waiting for worker outcomes.".into(),
                )
            })?;
            let satisfied = worker_ids
                .iter()
                .filter(|worker| completed.contains(*worker))
                .cloned()
                .collect::<Vec<_>>();
            let failed = worker_ids
                .iter()
                .filter(|worker| failed.contains(*worker))
                .cloned()
                .collect::<Vec<_>>();
            let at = now();
            append_event(
                tx,
                store,
                &authorized,
                &input.event_id,
                "join-resolved",
                &event_key,
                json!({"join":{
                    "joinKey":input.join_key,
                    "targetStepKey":join.get("targetStepKey"),
                    "status":status,"strategy":strategy,
                    "workerIds":worker_ids,"quorum":quorum,
                    "allowFailedWorkers":allow_failed,"deadline":join.get("deadline"),
                    "satisfiedWorkerIds":satisfied,"failedWorkerIds":failed
                }}),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_aggregation_record(
    input: MissionAggregationRecordInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &input.run_id)?;
            let event_key = format!(
                "coordination-aggregation:{}",
                bounded(&input.idempotency_key, "Aggregation idempotency key", 200)
                    .map_err(crate::store::StoreError::Invalid)?
            );
            let aggregation = deterministic_aggregation_receipt(
                &authorized.lifecycle,
                &authorized.journal,
                &input.target_step_key,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            if let Some(existing) = authorized.journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                if existing.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
                    && existing.get("type").and_then(Value::as_str) == Some("aggregation-recorded")
                    && existing.pointer("/payload/aggregation") == Some(&aggregation)
                {
                    return Ok(authorized.journal);
                }
                return Err(crate::store::StoreError::Invalid(
                    "Aggregation idempotency key already represents another receipt.".into(),
                ));
            }
            validate_head(
                &authorized.journal,
                input.expected_run_revision,
                input.expected_last_sequence,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.run_id, "Mission run", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.target_step_key, "Aggregation target step", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.event_id, "Aggregation event", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            if authorized.journal.events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("aggregation-recorded")
                    && event
                        .pointer("/payload/aggregation/stepKey")
                        .and_then(Value::as_str)
                        == Some(input.target_step_key.as_str())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "This deterministic aggregation is already recorded.".into(),
                ));
            }
            let at = now();
            append_event(
                tx,
                store,
                &authorized,
                &input.event_id,
                "aggregation-recorded",
                &event_key,
                json!({"aggregation":aggregation}),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn has_satisfied_dependency_join(
    journal: &mission_run::MissionRunJournalRow,
    plan_revision_id: &str,
    target_step_key: &str,
    dependency_worker_ids: &[String],
) -> bool {
    let join_key = coordination_join_key(plan_revision_id, target_step_key);
    journal.events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("join-resolved")
            && event
                .pointer("/payload/join/joinKey")
                .and_then(Value::as_str)
                == Some(join_key.as_str())
            && event
                .pointer("/payload/join/status")
                .and_then(Value::as_str)
                == Some("satisfied")
            && event
                .pointer("/payload/join/workerIds")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .eq(dependency_worker_ids.iter().map(String::as_str))
                })
    })
}

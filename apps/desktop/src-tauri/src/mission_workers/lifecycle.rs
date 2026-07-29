#[tauri::command]
pub fn mission_worker_create(
    input: MissionWorkerCreateInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.clone().ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required.".into(),
                )
            })?;
            let scope = crate::store::repos::scope::DataScope::workspace(
                context.active_workspace.local_workspace_id.clone(),
            )?;
            let journal = mission_run::get(tx, store, &scope, &member, &input.run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let event_key = format!("worker-create:{}", bounded(&input.idempotency_key, "Worker idempotency key", 200).map_err(crate::store::StoreError::Invalid)?);
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                exact_replay(existing, &input).map_err(crate::store::StoreError::Invalid)?;
                return Ok(journal);
            }
            validate_live_head(&journal.run, &input).map_err(crate::store::StoreError::Invalid)?;
            let mission_id = journal
                .run
                .pointer("/initiator/missionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run has no selected mission lifecycle.".into(),
                    )
                })?;
            let lifecycle = mission_plan::get(tx, store, &scope, &member, mission_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission plan is unavailable in this workspace.".into(),
                    )
                })?;
            validate_lifecycle(&journal.run, &lifecycle)
                .map_err(crate::store::StoreError::Invalid)?;
            let mission = object(&lifecycle.mission, "Mission")
                .map_err(crate::store::StoreError::Invalid)?;
            let revision = object(&lifecycle.current_revision, "Plan revision")
                .map_err(crate::store::StoreError::Invalid)?;
            let step = revision
                .get("steps")
                .and_then(Value::as_array)
                .and_then(|steps| {
                    steps.iter().find(|step| {
                        step.get("key").and_then(Value::as_str) == Some(input.step_key.as_str())
                    })
                })
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Selected mission plan step is unavailable.".into(),
                    )
                })?;
            validate_worker_slot(&journal, mission, revision, step, &input)
                .map_err(crate::store::StoreError::Invalid)?;
            let at = now();
            let grant_ids = validate_grants(
                tx, store, &scope, mission, step, &input.grants, &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let worker = build_worker(
                mission,
                revision,
                step,
                &input,
                &grant_ids,
                &context.internal_user_id,
                &member,
                &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let workspace = journal
                .run
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
                })?;
            let previous = journal
                .run
                .pointer("/eventHead/lastEventId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
                })?;
            let sequence = input.expected_last_sequence + 1;
            let event = json!({
                "workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,
                "authority":"local","schemaVersion":1,"revision":1,
                "createdByInternalUserId":context.internal_user_id,"createdAt":at,"updatedAt":at,
                "id":input.event_id,"runId":input.run_id,"type":"worker-created","sequence":sequence,
                "previousEventId":previous,"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
                "occurredAt":at,"actor":{"kind":"internal-user","internalUserId":context.internal_user_id,"memberId":member},
                "idempotencyKey":event_key,"payload":{"worker":worker}
            });
            let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run record is invalid.".into())
            })?;
            projected.insert("revision".into(), json!(input.expected_run_revision + 1));
            projected.insert("updatedAt".into(), json!(at));
            projected.insert(
                "eventHead".into(),
                json!({"lastSequence":sequence,"lastEventId":input.event_id}),
            );
            mission_run::append(
                tx,
                store,
                &scope,
                &member,
                &input.run_id,
                input.expected_run_revision,
                input.expected_last_sequence,
                &input.event_id,
                "worker-created",
                &event_key,
                &event,
                &Value::Object(projected),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_worker_start(
    input: MissionWorkerStartInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.clone().ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required.".into(),
                )
            })?;
            let scope = crate::store::repos::scope::DataScope::workspace(
                context.active_workspace.local_workspace_id.clone(),
            )?;
            let journal =
                mission_run::get(tx, store, &scope, &member, &input.run_id)?.ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let key = bounded(&input.idempotency_key, "Worker start idempotency key", 200)
                .map_err(crate::store::StoreError::Invalid)?;
            let event_key = format!("worker-start:{key}");
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                exact_start_replay(existing, &input).map_err(crate::store::StoreError::Invalid)?;
                let route_key = format!("worker-route:{key}");
                let route = journal
                    .events
                    .iter()
                    .find(|event| {
                        event.get("idempotencyKey").and_then(Value::as_str)
                            == Some(route_key.as_str())
                    })
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "Worker route selection is missing.".into(),
                        )
                    })?;
                exact_route_replay(route, &input).map_err(crate::store::StoreError::Invalid)?;
                return Ok(journal);
            }
            validate_start_head(&journal, &input).map_err(crate::store::StoreError::Invalid)?;
            let worker = journal
                .events
                .iter()
                .find(|event| {
                    event.get("type").and_then(Value::as_str) == Some("worker-created")
                        && event.pointer("/payload/worker/id").and_then(Value::as_str)
                            == Some(input.worker_id.as_str())
                })
                .and_then(|event| event.pointer("/payload/worker"))
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Worker assignment is unavailable in this run.".into(),
                    )
                })?;
            let mission_id = journal
                .run
                .pointer("/initiator/missionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run has no selected mission lifecycle.".into(),
                    )
                })?;
            let lifecycle =
                mission_plan::get(tx, store, &scope, &member, mission_id)?.ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission plan is unavailable in this workspace.".into(),
                    )
                })?;
            validate_lifecycle(&journal.run, &lifecycle)
                .map_err(crate::store::StoreError::Invalid)?;
            let mission =
                object(&lifecycle.mission, "Mission").map_err(crate::store::StoreError::Invalid)?;
            let revision = object(&lifecycle.current_revision, "Plan revision")
                .map_err(crate::store::StoreError::Invalid)?;
            let step_key = worker
                .get("planStepKey")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Worker plan step is invalid.".into())
                })?;
            let step = revision
                .get("steps")
                .and_then(Value::as_array)
                .and_then(|steps| {
                    steps
                        .iter()
                        .find(|step| step.get("key").and_then(Value::as_str) == Some(step_key))
                })
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Worker plan step is no longer selected.".into(),
                    )
                })?;
            let mappings =
                worker_grant_mappings(worker).map_err(crate::store::StoreError::Invalid)?;
            let at = now();
            validate_grants(tx, store, &scope, mission, step, &mappings, &at)
                .map_err(crate::store::StoreError::Invalid)?;
            let provider_route_id = crate::backends::validate_account_native_provider_model(
                tx,
                &context.internal_user_id,
                &input.provider_id,
                &input.model_reference,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            validate_worker_execution_policy(worker, &provider_route_id, &input.route_selection)
                .map_err(crate::store::StoreError::Invalid)?;
            crate::backends::validate_native_provider_route_selection_in_tx(
                tx,
                store,
                &context.internal_user_id,
                &input.provider_id,
                &input.model_reference,
                &provider_route_id,
                worker_route_quality_policy_ref(&journal, &lifecycle),
                &input.route_selection,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            validate_route_cost_matches_step(step, &input.route_selection)
                .map_err(crate::store::StoreError::Invalid)?;
            let mut current = journal;
            if current.run.get("status").and_then(Value::as_str) != Some("running") {
                let start_event_id = input.run_start_event_id.as_deref().ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Starting this worker requires a run-start event id.".into(),
                    )
                })?;
                bounded(start_event_id, "Run start event", 160)
                    .map_err(crate::store::StoreError::Invalid)?;
                current = append_run_started(
                    tx,
                    store,
                    &scope,
                    &member,
                    &context.internal_user_id,
                    &current,
                    &input,
                    start_event_id,
                    &format!("worker-start-status:{key}"),
                    &at,
                )?;
            } else if input.run_start_event_id.is_some() {
                return Err(crate::store::StoreError::Invalid(
                    "A running mission does not accept another run-start event.".into(),
                ));
            }
            let started = append_worker_started(
                tx,
                store,
                &scope,
                &member,
                &context.internal_user_id,
                &current,
                &input,
                &event_key,
                &at,
            )?;
            append_route_selected(
                tx,
                store,
                &scope,
                &member,
                &context.internal_user_id,
                &started,
                &input,
                &provider_route_id,
                &format!("worker-route:{key}"),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

fn validate_start_head(
    journal: &mission_run::MissionRunJournalRow,
    input: &MissionWorkerStartInput,
) -> Result<(), String> {
    bounded(&input.run_id, "Mission run", 160)?;
    bounded(&input.worker_id, "Worker", 160)?;
    bounded(&input.worker_started_event_id, "Worker start event", 160)?;
    bounded(&input.route_selected_event_id, "Route selection event", 160)?;
    bounded(&input.provider_id, "Route provider", 80)?;
    bounded(&input.model_reference, "Route model", 300)?;
    if input.run_start_event_id.as_deref() == Some(input.worker_started_event_id.as_str()) {
        return Err("Run-start and worker-start events require distinct ids.".into());
    }
    if input.route_selected_event_id == input.worker_started_event_id
        || input.run_start_event_id.as_deref() == Some(input.route_selected_event_id.as_str())
    {
        return Err("Run-start, worker-start, and route events require distinct ids.".into());
    }
    if journal.run.get("revision").and_then(Value::as_i64) != Some(input.expected_run_revision)
        || journal
            .run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
        || !matches!(
            journal.run.get("status").and_then(Value::as_str),
            Some("created" | "planning" | "queued" | "running")
        )
    {
        return Err("The mission run changed before the worker could start.".into());
    }
    let created = journal.events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("worker-created")
            && event.pointer("/payload/worker/id").and_then(Value::as_str)
                == Some(input.worker_id.as_str())
    });
    let already_advanced = journal.events.iter().any(|event| {
        matches!(
            event.get("type").and_then(Value::as_str),
            Some("worker-started" | "worker-completed" | "worker-failed")
        ) && event.pointer("/payload/workerId").and_then(Value::as_str)
            == Some(input.worker_id.as_str())
    });
    if !created || already_advanced {
        return Err("Worker is unavailable for a first start.".into());
    }
    Ok(())
}

fn worker_grant_mappings(worker: &Value) -> Result<Vec<WorkerGrantInput>, String> {
    let capabilities = worker
        .get("capabilityIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Worker capabilities are invalid.".to_string())?;
    let grants = worker
        .get("capabilityGrantIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Worker capability grants are invalid.".to_string())?;
    if capabilities.len() != grants.len() {
        return Err("Worker capability grants are incomplete.".into());
    }
    capabilities
        .iter()
        .zip(grants)
        .map(|(capability, grant)| {
            Ok(WorkerGrantInput {
                capability_id: capability
                    .as_str()
                    .ok_or_else(|| "Worker capability is invalid.".to_string())?
                    .to_string(),
                capability_grant_id: grant
                    .as_str()
                    .ok_or_else(|| "Worker capability grant is invalid.".to_string())?
                    .to_string(),
            })
        })
        .collect()
}

fn validate_worker_execution_policy(
    worker: &Value,
    provider_route_id: &str,
    selection: &crate::models::ProviderRouteSelection,
) -> Result<(), String> {
    let route = worker.get("routePreference");
    let placement = worker.get("placementPreference");
    if route.is_none() && placement.is_none() {
        // Compatibility for fixed-shape workers created before the saved-policy
        // contract. Their exact route still passes the native account and
        // no-fallback selection validation below.
        return Ok(());
    }
    let route = route
        .and_then(Value::as_object)
        .ok_or_else(|| "Worker route policy is invalid.".to_string())?;
    let placement = placement
        .and_then(Value::as_object)
        .ok_or_else(|| "Worker placement policy is invalid.".to_string())?;
    if route.get("allowFallback").and_then(Value::as_bool) != Some(false)
        || selection.fallback_from_provider_route_id.is_some()
    {
        return Err("Worker route policy does not permit fallback.".into());
    }
    let route_ids = route
        .get("providerRouteIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Worker route policy identities are invalid.".to_string())?;
    if route_ids.len() > 64 {
        return Err("Worker route policy exceeds its safe bound.".into());
    }
    let route_ids = route_ids
        .iter()
        .map(|value| {
            bounded(
                value
                    .as_str()
                    .ok_or_else(|| "Worker route policy identity is invalid.".to_string())?,
                "Worker route policy identity",
                200,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    if route_ids.iter().collect::<BTreeSet<_>>().len() != route_ids.len() {
        return Err("Worker route policy identities are ambiguous.".into());
    }
    match route.get("policy").and_then(Value::as_str) {
        Some("automatic") if route_ids.is_empty() => {}
        Some("require")
            if !route_ids.is_empty()
                && route_ids
                    .iter()
                    .any(|route_id| route_id == provider_route_id) => {}
        _ => return Err("The selected provider route is outside the saved worker policy.".into()),
    }
    let execution_nodes = placement
        .get("executionNodeIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "Worker placement policy identities are invalid.".to_string())?;
    if placement.get("policy").and_then(Value::as_str) != Some("require")
        || placement.get("locality").and_then(Value::as_str) != Some("local")
        || placement.get("allowTransfer").and_then(Value::as_bool) != Some(false)
        || execution_nodes.len() != 1
        || execution_nodes[0].as_str() != Some("local-desktop")
    {
        return Err("Worker placement policy does not permit this local execution.".into());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_run_started(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    member: &str,
    actor: &str,
    journal: &mission_run::MissionRunJournalRow,
    input: &MissionWorkerStartInput,
    event_id: &str,
    event_key: &str,
    at: &str,
) -> crate::store::Result<mission_run::MissionRunJournalRow> {
    let current_status = journal
        .run
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run status is invalid.".into())
        })?;
    let previous = journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let workspace = journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    let sequence = input.expected_last_sequence + 1;
    let event = json!({
        "workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,"authority":"local",
        "schemaVersion":1,"revision":1,"createdByInternalUserId":actor,"createdAt":at,"updatedAt":at,
        "id":event_id,"runId":input.run_id,"type":"status-transitioned","sequence":sequence,
        "previousEventId":previous,"occurredAt":at,"actor":{"kind":"internal-user","internalUserId":actor,"memberId":member},
        "idempotencyKey":event_key,"payload":{"from":current_status,"to":"running","reason":"The first bounded worker is starting."}
    });
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("status".into(), Value::String("running".into()));
    projected.insert("revision".into(), json!(input.expected_run_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        member,
        &input.run_id,
        input.expected_run_revision,
        input.expected_last_sequence,
        event_id,
        "status-transitioned",
        event_key,
        &event,
        &Value::Object(projected),
        at,
    )
}

#[allow(clippy::too_many_arguments)]
fn append_worker_started(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    member: &str,
    actor: &str,
    journal: &mission_run::MissionRunJournalRow,
    input: &MissionWorkerStartInput,
    event_key: &str,
    at: &str,
) -> crate::store::Result<mission_run::MissionRunJournalRow> {
    let revision = journal
        .run
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run revision is invalid.".into())
        })?;
    let last_sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let previous = journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let workspace = journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    let sequence = last_sequence + 1;
    let event = json!({
        "workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,"authority":"local",
        "schemaVersion":1,"revision":1,"createdByInternalUserId":actor,"createdAt":at,"updatedAt":at,
        "id":input.worker_started_event_id,"runId":input.run_id,"type":"worker-started","sequence":sequence,
        "previousEventId":previous,"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"internal-user","internalUserId":actor,"memberId":member},
        "idempotencyKey":event_key,"payload":{"workerId":input.worker_id}
    });
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":input.worker_started_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        member,
        &input.run_id,
        revision,
        last_sequence,
        &input.worker_started_event_id,
        "worker-started",
        event_key,
        &event,
        &Value::Object(projected),
        at,
    )
}

fn exact_start_replay(event: &Value, input: &MissionWorkerStartInput) -> Result<(), String> {
    let added = if input.run_start_event_id.is_some() {
        2
    } else {
        1
    };
    if event.get("id").and_then(Value::as_str) == Some(input.worker_started_event_id.as_str())
        && event.get("runId").and_then(Value::as_str) == Some(input.run_id.as_str())
        && event.get("type").and_then(Value::as_str) == Some("worker-started")
        && event.pointer("/payload/workerId").and_then(Value::as_str)
            == Some(input.worker_id.as_str())
        && event.get("sequence").and_then(Value::as_i64)
            == Some(input.expected_last_sequence + added)
        && event.get("sequence").and_then(Value::as_i64)
            == Some(input.expected_run_revision + added - 1)
        && input
            .run_start_event_id
            .as_deref()
            .is_none_or(|start| event.get("previousEventId").and_then(Value::as_str) == Some(start))
    {
        Ok(())
    } else {
        Err("Worker start idempotency key already represents another start.".into())
    }
}

#[allow(clippy::too_many_arguments)]
fn append_route_selected(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    member: &str,
    actor: &str,
    journal: &mission_run::MissionRunJournalRow,
    input: &MissionWorkerStartInput,
    provider_route_id: &str,
    event_key: &str,
    at: &str,
) -> crate::store::Result<mission_run::MissionRunJournalRow> {
    let revision = journal
        .run
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run revision is invalid.".into())
        })?;
    let last_sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let previous = journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let workspace = journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    if input.route_selection.provider_route_id != provider_route_id {
        return Err(crate::store::StoreError::Invalid(
            "Worker route selection does not match its authorized provider route.".into(),
        ));
    }
    let selection = serde_json::to_value(&input.route_selection).map_err(|_| {
        crate::store::StoreError::Invalid("Worker route selection is invalid.".into())
    })?;
    let sequence = last_sequence + 1;
    let event = json!({
        "workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,"authority":"local",
        "schemaVersion":1,"revision":1,"createdByInternalUserId":actor,"createdAt":at,"updatedAt":at,
        "id":input.route_selected_event_id,"runId":input.run_id,"type":"route-selected","sequence":sequence,
        "previousEventId":previous,"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":event_key,
        "payload":{"workerId":input.worker_id,"providerId":input.provider_id,
            "modelReference":input.model_reference,"selection":selection}
    });
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert("selectedRoute".into(), selection);
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":input.route_selected_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        member,
        &input.run_id,
        revision,
        last_sequence,
        &input.route_selected_event_id,
        "route-selected",
        event_key,
        &event,
        &Value::Object(projected),
        at,
    )
}

fn exact_route_replay(event: &Value, input: &MissionWorkerStartInput) -> Result<(), String> {
    let added = if input.run_start_event_id.is_some() {
        3
    } else {
        2
    };
    let selection = event.pointer("/payload/selection");
    if event.get("id").and_then(Value::as_str) == Some(input.route_selected_event_id.as_str())
        && event.get("runId").and_then(Value::as_str) == Some(input.run_id.as_str())
        && event.get("type").and_then(Value::as_str) == Some("route-selected")
        && event.pointer("/payload/workerId").and_then(Value::as_str)
            == Some(input.worker_id.as_str())
        && event.pointer("/payload/providerId").and_then(Value::as_str)
            == Some(input.provider_id.as_str())
        && event
            .pointer("/payload/modelReference")
            .and_then(Value::as_str)
            == Some(input.model_reference.as_str())
        && event.get("previousEventId").and_then(Value::as_str)
            == Some(input.worker_started_event_id.as_str())
        && event.get("sequence").and_then(Value::as_i64)
            == Some(input.expected_last_sequence + added)
        && selection
            == Some(
                &serde_json::to_value(&input.route_selection)
                    .map_err(|_| "Worker route selection is invalid.".to_string())?,
            )
    {
        Ok(())
    } else {
        Err("Worker route idempotency key already represents another selection.".into())
    }
}

fn validate_route_cost_matches_step(
    step: &Value,
    selection: &crate::models::ProviderRouteSelection,
) -> Result<(), String> {
    let Some(cost) = selection.cost.as_ref() else {
        return Ok(());
    };
    let budget = step
        .get("estimatedBudget")
        .and_then(Value::as_object)
        .ok_or_else(|| "Worker route cost requires an exact step budget.".to_string())?;
    let input_tokens = budget
        .get("maxInputTokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Worker route input budget is invalid.".to_string())?;
    let output_tokens = budget
        .get("maxOutputTokens")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Worker route output budget is invalid.".to_string())?;
    if cost.estimated_input_tokens != input_tokens || cost.estimated_output_tokens != output_tokens
    {
        return Err("Worker route cost does not match its exact step budget.".into());
    }
    Ok(())
}

fn validate_lifecycle(
    run: &Value,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
) -> Result<(), String> {
    let mission = object(&lifecycle.mission, "Mission")?;
    let revision = object(&lifecycle.current_revision, "Plan revision")?;
    if !matches!(
        mission.get("status").and_then(Value::as_str),
        Some("ready" | "running" | "waiting")
    ) || mission.get("currentPlanRevisionId").and_then(Value::as_str)
        != revision.get("id").and_then(Value::as_str)
        || run.get("planRevisionId").and_then(Value::as_str)
            != revision.get("id").and_then(Value::as_str)
        || run.get("workspaceId") != mission.get("workspaceId")
        || run.get("ownerMemberId") != mission.get("ownerMemberId")
    {
        return Err("Mission run is not bound to the currently selected plan revision.".into());
    }
    Ok(())
}

fn validate_live_head(run: &Value, input: &MissionWorkerCreateInput) -> Result<(), String> {
    if !matches!(
        run.get("status").and_then(Value::as_str),
        Some("created" | "planning" | "queued" | "running")
    ) {
        return Err("Mission run cannot create another worker.".into());
    }
    if run.get("revision").and_then(Value::as_i64) != Some(input.expected_run_revision)
        || run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
    {
        return Err("The mission run changed before the worker could be created.".into());
    }
    bounded(&input.run_id, "Mission run", 160)?;
    bounded(&input.event_id, "Worker event", 160)?;
    bounded(&input.worker_id, "Worker", 160)?;
    bounded(&input.step_key, "Plan step", 160)?;
    Ok(())
}

fn validate_grants(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    storage_scope: &crate::store::repos::scope::DataScope,
    mission: &Map<String, Value>,
    step: &Value,
    mappings: &[WorkerGrantInput],
    at: &str,
) -> Result<Vec<String>, String> {
    let project = mission
        .get("scope")
        .and_then(Value::as_object)
        .and_then(|scope| scope.get("projectId"))
        .and_then(Value::as_str);
    let scope = crate::authorized_scope::resolve(
        tx,
        Some(storage_scope.workspace_id()),
        project,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|error| error.to_string())?;
    let capabilities = step
        .get("requiredCapabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| "Plan step capabilities are invalid.".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "Plan step capability is invalid.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut by_capability = BTreeMap::<String, String>::new();
    for mapping in mappings {
        let capability = bounded(&mapping.capability_id, "Capability", 160)?;
        let grant_id = bounded(&mapping.capability_grant_id, "Capability grant", 160)?;
        if !capabilities.contains(&capability)
            || by_capability.insert(capability, grant_id).is_some()
        {
            return Err("Capability grants must map exactly once to required capabilities.".into());
        }
    }
    if by_capability.len() != capabilities.len() {
        return Err("Every worker capability requires one explicit grant reference.".into());
    }
    let mut ordered = Vec::with_capacity(capabilities.len());
    for capability in capabilities {
        let grant_id = by_capability
            .get(&capability)
            .ok_or_else(|| "Worker capability grant is missing.".to_string())?;
        let grant = capability_grant::get(tx, store, &scope, grant_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Worker capability grant is unavailable.".to_string())?;
        if grant.capability_id != capability {
            return Err("Worker capability grant does not match its required capability.".into());
        }
        if grant.consequence != "read" {
            return Err("Current mission capabilities require a read-only grant.".into());
        }
        let active = capability_grant::check(
            tx,
            store,
            &scope,
            &capability,
            &grant.connection_id,
            "read",
            at,
        )
        .map_err(|error| error.to_string())?
        .map_err(|failure| failure.message.to_string())?;
        if !active.iter().any(|candidate| candidate.id == grant.id) {
            return Err("Worker capability grant is not active in this exact scope.".into());
        }
        ordered.push(grant.id);
    }
    Ok(ordered)
}

fn validate_worker_slot(
    journal: &mission_run::MissionRunJournalRow,
    mission: &Map<String, Value>,
    revision: &Map<String, Value>,
    step: &Value,
    input: &MissionWorkerCreateInput,
) -> Result<(), String> {
    let step = object(step, "Plan step")?;
    if step.get("kind").and_then(Value::as_str) == Some("coordinate") {
        return Err(
            "Coordinate steps require deterministic aggregation rather than a model worker.".into(),
        );
    }
    let mut worker_steps = BTreeMap::<String, String>::new();
    let mut completed_workers = BTreeSet::<String>::new();
    let mut failed_workers = BTreeSet::<String>::new();
    for event in &journal.events {
        match event.get("type").and_then(Value::as_str) {
            Some("worker-created") => {
                let worker = event
                    .pointer("/payload/worker")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Stored worker event is invalid.".to_string())?;
                let id = required(worker, "id")?;
                let step_key = required(worker, "planStepKey")?;
                if id == input.worker_id {
                    return Err("Worker id is already present in this run.".into());
                }
                if step_key == input.step_key {
                    return Err("This plan step already has a worker assignment.".into());
                }
                if worker_steps.insert(id, step_key).is_some() {
                    return Err("Stored worker identities are not unique in this run.".into());
                }
            }
            Some("worker-completed") => {
                if let Some(id) = event.pointer("/payload/workerId").and_then(Value::as_str) {
                    completed_workers.insert(id.to_string());
                }
            }
            Some("worker-failed") => {
                if let Some(id) = event.pointer("/payload/workerId").and_then(Value::as_str) {
                    failed_workers.insert(id.to_string());
                }
            }
            _ => {}
        }
    }
    let completed_steps = completed_workers
        .iter()
        .filter_map(|worker| worker_steps.get(worker).cloned())
        .collect::<BTreeSet<_>>();
    let dependencies = step
        .get("dependsOnStepKeys")
        .and_then(Value::as_array)
        .ok_or_else(|| "Plan step dependencies are invalid.".to_string())?;
    let dependency_keys = dependencies
        .iter()
        .map(|dependency| {
            dependency
                .as_str()
                .ok_or_else(|| "Plan step dependency is invalid.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dependency_keys.len() > 1 {
        let dependency_worker_ids = dependency_keys
            .iter()
            .map(|dependency| {
                worker_steps
                    .iter()
                    .find_map(|(worker, step)| {
                        (step.as_str() == *dependency).then(|| worker.clone())
                    })
                    .ok_or_else(|| {
                        "Every joined dependency requires one durable worker.".to_string()
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let revision_id = required(revision, "id")?;
        if !crate::mission_coordination::has_satisfied_dependency_join(
            journal,
            &revision_id,
            &input.step_key,
            &dependency_worker_ids,
        ) {
            return Err(
                "Multi-source plan dependencies require their exact satisfied durable join.".into(),
            );
        }
    } else if dependency_keys
        .iter()
        .any(|key| !completed_steps.contains(*key))
    {
        return Err("Plan step dependency is not durably complete.".into());
    }
    let depth = required(mission, "executionDepth")?;
    let mission_limit = mission
        .get("budget")
        .and_then(Value::as_object)
        .and_then(|budget| budget.get("maxWorkers"))
        .and_then(Value::as_i64);
    let plan_limit = revision
        .get("bounds")
        .and_then(Value::as_object)
        .and_then(|bounds| bounds.get("maxSteps"))
        .and_then(Value::as_i64)
        .ok_or_else(|| "Plan worker bound is invalid.".to_string())?;
    let parallel_limit = revision
        .get("bounds")
        .and_then(Value::as_object)
        .and_then(|bounds| bounds.get("maxParallelSteps"))
        .and_then(Value::as_i64)
        .ok_or_else(|| "Plan parallel worker bound is invalid.".to_string())?;
    let concurrency_limit = if depth == "delegated" {
        1
    } else {
        mission_limit.unwrap_or(parallel_limit).min(parallel_limit)
    };
    let terminal_workers = completed_workers
        .union(&failed_workers)
        .cloned()
        .collect::<BTreeSet<_>>();
    let active_workers = worker_steps
        .keys()
        .filter(|worker| !terminal_workers.contains(*worker))
        .count() as i64;
    if plan_limit < 1 || worker_steps.len() as i64 >= plan_limit {
        return Err("Plan worker assignment limit is exhausted.".into());
    }
    if concurrency_limit < 1 || active_workers >= concurrency_limit {
        return Err("Mission worker limit is exhausted.".into());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_worker(
    mission: &Map<String, Value>,
    revision: &Map<String, Value>,
    step: &Value,
    input: &MissionWorkerCreateInput,
    grant_ids: &[String],
    actor: &str,
    member: &str,
    at: &str,
) -> Result<Value, String> {
    let step = object(step, "Plan step")?;
    let allowed = mission
        .get("scope")
        .and_then(Value::as_object)
        .and_then(|scope| scope.get("context"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Mission context is invalid.".to_string())?;
    let context = validate_context(&input.context, allowed)?;
    let capabilities = step
        .get("requiredCapabilities")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Plan step capabilities are invalid.".to_string())?;
    let tools = tools_for_capabilities(&capabilities)?;
    let kind = step.get("kind").and_then(Value::as_str).unwrap_or("");
    let role = match kind {
        "review" => "reviewer",
        "act" => "executor",
        _ => "specialist",
    };
    let workspace = required(mission, "workspaceId")?;
    let revision_id = required(revision, "id")?;
    let title = required(step, "title")?;
    let objective = required(step, "objective")?;
    let budget = bounded_budget(mission.get("budget"), step.get("estimatedBudget"))?;
    let outputs = step
        .get("expectedOutputs")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Plan step outputs are invalid.".to_string())?;
    Ok(json!({
        "workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":actor,
        "createdAt":at,"updatedAt":at,"id":input.worker_id,"runId":input.run_id,"status":"proposed",
        "role":{"kind":role,"title":title,"objective":objective,"responsibilities":[objective]},
        "planRevisionId":revision_id,"planStepKey":input.step_key,"context":context,
        "capabilityIds":capabilities,"capabilityGrantIds":grant_ids,"tools":tools,"budget":budget,
        "stopConditions":[
            {"kind":"objective-met","description":"Stop when the assigned objective and required outputs are complete."},
            {"kind":"budget-reached","description":"Stop before any worker budget is exceeded."},
            {"kind":"no-progress","description":"Stop after two iterations without useful progress.","threshold":2}
        ],
        "outputContract":{"slots":outputs,"includeEvidence":step.get("acceptanceCriterionKeys").and_then(Value::as_array).is_some_and(|values|!values.is_empty()),"includeUncertainty":true,"delivery":"run-result"}
    }))
}

fn validate_context(values: &[Value], allowed: &[Value]) -> Result<Vec<Value>, String> {
    if values.len() > MAX_CONTEXT {
        return Err("Worker context exceeds its reference bound.".into());
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let item = object(value, "Worker context")?;
        exact_keys(item, &["reference", "purpose", "required", "maxCharacters"])?;
        let reference = item
            .get("reference")
            .ok_or_else(|| "Worker context reference is missing.".to_string())?;
        if !allowed.contains(reference) {
            return Err("Worker context must be declared by the mission scope.".into());
        }
        let fingerprint = serde_json::to_string(reference)
            .map_err(|_| "Worker context reference is invalid.".to_string())?;
        if !seen.insert(fingerprint) {
            return Err("Worker context references must be unique.".into());
        }
        text(item.get("purpose"), "Worker context purpose", 1_000)?;
        if item.get("required").and_then(Value::as_bool).is_none()
            || item.get("maxCharacters").is_some_and(|value| {
                value
                    .as_i64()
                    .is_none_or(|number| !(1..=1_000_000).contains(&number))
            })
        {
            return Err("Worker context bounds are invalid.".into());
        }
        let mut normalized = item.clone();
        normalized.insert("trust".into(), Value::String("untrusted".into()));
        result.push(Value::Object(normalized));
    }
    Ok(result)
}

fn tools_for_capabilities(capabilities: &[Value]) -> Result<Vec<Value>, String> {
    if capabilities.len() > MAX_TOOLS {
        return Err("Worker capability set exceeds its tool bound.".into());
    }
    const CONNECTED_READS: &[&str] = &[
        "connected-source.search",
        "source.repository.list",
        "source.file.search",
        "knowledge.content.search",
        "communication.email.search",
        "communication.channel.list",
        "calendar.list",
        "calendar.event.search",
        "software.deployment.list",
        "work.issue.list",
    ];
    if capabilities.is_empty() {
        return Ok(Vec::new());
    }
    if capabilities.iter().any(|capability| {
        capability
            .as_str()
            .is_none_or(|value| !CONNECTED_READS.contains(&value))
    }) {
        return Err("Plan step requires a capability with no native mission tool binding.".into());
    }
    Ok(vec![
        json!({"toolName":"connection-read","access":"read","purpose":"Search connected work sources for evidence required by this step.","required":true}),
    ])
}

fn bounded_budget(mission: Option<&Value>, step: Option<&Value>) -> Result<Value, String> {
    let defaults = [600_000_i64, 32_000, 8_000, 20, 1];
    let keys = [
        "maxDurationMs",
        "maxInputTokens",
        "maxOutputTokens",
        "maxToolCalls",
        "maxAttempts",
    ];
    let mut result = Map::new();
    for (index, key) in keys.iter().enumerate() {
        let mut values = vec![defaults[index]];
        for budget in [mission, step].into_iter().flatten() {
            if let Some(value) = budget.get(*key) {
                let number = value
                    .as_i64()
                    .filter(|number| *number > 0)
                    .ok_or_else(|| format!("Worker {key} must be a positive integer."))?;
                values.push(number);
            }
        }
        result.insert((*key).into(), json!(values.into_iter().min().unwrap()));
    }
    if let Some(cost) = lower_cost(
        mission.and_then(|value| value.get("maxCost")),
        step.and_then(|value| value.get("maxCost")),
    )? {
        result.insert("maxCost".into(), cost.clone());
    }
    Ok(Value::Object(result))
}

fn lower_cost<'a>(
    first: Option<&'a Value>,
    second: Option<&'a Value>,
) -> Result<Option<&'a Value>, String> {
    match (first, second) {
        (None, None) => Ok(None),
        (Some(value), None) | (None, Some(value)) => {
            cost_parts(value)?;
            Ok(Some(value))
        }
        (Some(left), Some(right)) => {
            let (left_currency, left_number) = cost_parts(left)?;
            let (right_currency, right_number) = cost_parts(right)?;
            if left_currency != right_currency {
                return Err("Worker monetary budgets must use one currency.".into());
            }
            Ok(Some(if decimal_le(&left_number, &right_number) {
                left
            } else {
                right
            }))
        }
    }
}

fn cost_parts(value: &Value) -> Result<(String, String), String> {
    let object = object(value, "Worker monetary budget")?;
    exact_keys(object, &["amount", "currencyCode"])?;
    let currency = required(object, "currencyCode")?;
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("Worker monetary budget currency is invalid.".into());
    }
    let amount = required(object, "amount")?;
    if amount.len() > 64
        || amount.starts_with('-')
        || amount.matches('.').count() > 1
        || !amount
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        || amount.split('.').next().is_none_or(str::is_empty)
    {
        return Err("Worker monetary budget amount is invalid.".into());
    }
    Ok((currency, amount))
}

fn decimal_le(left: &str, right: &str) -> bool {
    let (left_whole, left_fraction) = normalized_decimal(left);
    let (right_whole, right_fraction) = normalized_decimal(right);
    if left_whole.len() != right_whole.len() {
        return left_whole.len() < right_whole.len();
    }
    if left_whole != right_whole {
        return left_whole < right_whole;
    }
    let width = left_fraction.len().max(right_fraction.len());
    let left_padded = format!("{left_fraction:0<width$}");
    let right_padded = format!("{right_fraction:0<width$}");
    left_padded <= right_padded
}

fn normalized_decimal(value: &str) -> (String, String) {
    let mut parts = value.splitn(2, '.');
    let whole = parts.next().unwrap_or("0").trim_start_matches('0');
    let fraction = parts.next().unwrap_or("").trim_end_matches('0');
    (
        if whole.is_empty() { "0" } else { whole }.to_string(),
        fraction.to_string(),
    )
}

fn exact_replay(event: &Value, input: &MissionWorkerCreateInput) -> Result<(), String> {
    let worker = event
        .pointer("/payload/worker")
        .ok_or_else(|| "Replayed worker event is invalid.".to_string())?;
    let expected_tools = worker
        .get("capabilityIds")
        .and_then(Value::as_array)
        .map(|capabilities| tools_for_capabilities(capabilities))
        .transpose()?
        .ok_or_else(|| "Replayed worker capabilities are invalid.".to_string())?;
    let expected_context = normalize_replay_context(&input.context)?;
    let mapping = input
        .grants
        .iter()
        .map(|grant| {
            (
                grant.capability_id.as_str(),
                grant.capability_grant_id.as_str(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    if mapping.len() != input.grants.len() {
        return Err("Worker idempotency replay contains duplicate capability mappings.".into());
    }
    let expected_grants = worker
        .get("capabilityIds")
        .and_then(Value::as_array)
        .and_then(|capabilities| {
            capabilities
                .iter()
                .map(|capability| {
                    capability
                        .as_str()
                        .and_then(|value| mapping.get(value).copied())
                        .map(|value| Value::String(value.to_string()))
                })
                .collect::<Option<Vec<_>>>()
        });
    if event.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
        && event.get("type").and_then(Value::as_str) == Some("worker-created")
        && event.get("runId").and_then(Value::as_str) == Some(input.run_id.as_str())
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_last_sequence + 1)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_run_revision)
        && worker.get("id").and_then(Value::as_str) == Some(input.worker_id.as_str())
        && worker.get("runId").and_then(Value::as_str) == Some(input.run_id.as_str())
        && worker.get("planStepKey").and_then(Value::as_str) == Some(input.step_key.as_str())
        && worker.get("context") == Some(&Value::Array(expected_context))
        && worker.get("tools") == Some(&Value::Array(expected_tools))
        && worker
            .get("capabilityGrantIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| {
                expected_grants
                    .as_ref()
                    .is_some_and(|expected| ids == expected)
            })
    {
        Ok(())
    } else {
        Err("Worker idempotency key already represents another assignment.".into())
    }
}

fn normalize_replay_context(values: &[Value]) -> Result<Vec<Value>, String> {
    if values.len() > MAX_CONTEXT {
        return Err("Worker context exceeds its reference bound.".into());
    }
    values
        .iter()
        .map(|value| {
            let item = object(value, "Worker context")?;
            exact_keys(item, &["reference", "purpose", "required", "maxCharacters"])?;
            if item.get("reference").is_none()
                || item.get("required").and_then(Value::as_bool).is_none()
            {
                return Err("Worker context replay is invalid.".into());
            }
            text(item.get("purpose"), "Worker context purpose", 1_000)?;
            let mut normalized = item.clone();
            normalized.insert("trust".into(), Value::String("untrusted".into()));
            Ok(Value::Object(normalized))
        })
        .collect()
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} is invalid."))
}

fn exact_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Worker input contains an unsupported field.".into());
    }
    Ok(())
}

fn required(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(|value| bounded(value, key, 4_000))
        .transpose()?
        .ok_or_else(|| format!("Mission {key} is invalid."))
}

fn text(value: Option<&Value>, label: &str, max: usize) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(|value| bounded(value, label, max))
        .transpose()?
        .ok_or_else(|| format!("{label} is invalid."))
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(value.to_string())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

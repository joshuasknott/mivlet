pub(crate) fn preflight_native_connected_search(
    binding: &NativeWorkerToolExecutionBinding,
    approval_request_id: &str,
    workspace_id: &str,
    project_id: Option<&str>,
    capability_id: &str,
    input: &BTreeMap<String, Value>,
) -> Result<NativeWorkerToolPreflight, String> {
    if capability_id != "knowledge.content.search"
        || input.keys().any(|key| key != "query" && key != "limit")
    {
        return Err("This mission tool boundary supports only connected-source search.".into());
    }
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if query.is_empty() || query.len() > 2_000 || binding.call_key != approval_request_id {
        return Err("Mission connected-source search identity is invalid.".into());
    }
    let identity = crate::clerk_identity::native_identity_generation_snapshot()?;
    let _identity_guard = crate::clerk_identity::lock_native_identity_generation(&identity)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.clone().ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required.".into(),
                )
            })?;
            if context.active_workspace.local_workspace_id != workspace_id {
                return Err(crate::store::StoreError::Invalid(
                    "Mission connected-source workspace changed.".into(),
                ));
            }
            let scope = crate::store::repos::scope::DataScope::workspace(workspace_id)?;
            let journal = mission_run::get(tx, store, &scope, &member, &binding.run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            validate_native_tool_binding(binding).map_err(crate::store::StoreError::Invalid)?;
            let key = native_tool_event_key(binding).map_err(crate::store::StoreError::Invalid)?;
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(key.as_str())
            }) {
                if existing.get("id").and_then(Value::as_str)
                    != Some(binding.tool_event_id.as_str())
                    || existing.get("type").and_then(Value::as_str) != Some("tool-call-completed")
                {
                    return Err(crate::store::StoreError::Invalid(
                        "Mission tool idempotency key represents another event.".into(),
                    ));
                }
                let reference = existing
                    .pointer("/payload/result/outputReference")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid("Mission tool replay is invalid.".into())
                    })?;
                let receipt = crate::store::repos::mission_worker_tool::get_by_reference(
                    tx, store, &scope, &member, reference,
                )?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission tool replay receipt is unavailable.".into(),
                    )
                })?;
                return Ok(NativeWorkerToolPreflight::AlreadyRecorded(
                    receipt.receipt["result"].clone(),
                ));
            }
            validate_native_tool_head(&journal, binding)
                .map_err(crate::store::StoreError::Invalid)?;
            let worker = journal
                .events
                .iter()
                .find(|event| {
                    event.get("type").and_then(Value::as_str) == Some("worker-created")
                        && event.pointer("/payload/worker/id").and_then(Value::as_str)
                            == Some(binding.worker_id.as_str())
                })
                .and_then(|event| event.pointer("/payload/worker"))
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission worker assignment is unavailable.".into(),
                    )
                })?;
            let tools = worker
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission worker tools are invalid.".into())
                })?;
            let mappings =
                worker_grant_mappings(worker).map_err(crate::store::StoreError::Invalid)?;
            if tools.len() != 1
                || tools[0].get("toolName").and_then(Value::as_str) != Some("connection-read")
                || mappings.len() != 1
                || mappings[0].capability_id != capability_id
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission worker does not own this exact connected-source tool.".into(),
                ));
            }
            let mission_id = journal
                .run
                .get("missionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission run has no selected mission.".into())
                })?;
            let lifecycle =
                mission_plan::get(tx, store, &scope, &member, mission_id)?.ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission plan is unavailable.".into())
                })?;
            validate_lifecycle(&journal.run, &lifecycle)
                .map_err(crate::store::StoreError::Invalid)?;
            let mission_project = lifecycle
                .mission
                .pointer("/scope/projectId")
                .and_then(Value::as_str);
            if mission_project != project_id {
                return Err(crate::store::StoreError::Invalid(
                    "Mission connected-source project scope changed.".into(),
                ));
            }
            Ok(NativeWorkerToolPreflight::Execute(
                NativeWorkerToolAuthority {
                    binding: binding.clone(),
                    identity: identity.clone(),
                    local_workspace_id: workspace_id.to_string(),
                    project_id: project_id.map(str::to_string),
                    member_id: member,
                    internal_user_id: context.internal_user_id,
                    capability_grant_id: mappings[0].capability_grant_id.clone(),
                    query: query.to_string(),
                },
            ))
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn settle_native_connected_search(
    authority: &NativeWorkerToolAuthority,
    result: Value,
    implementation_kind: &str,
) -> Result<String, String> {
    let connected = result
        .get("result")
        .ok_or_else(|| "Mission connected-source result is invalid.".to_string())?;
    validate_connected_search_result(connected, authority, implementation_kind)?;
    if result.get("capabilityId").and_then(Value::as_str) != Some("knowledge.content.search")
        || result.get("connectionId") != connected.get("connectionId")
        || result.get("matchedGrantIds") != connected.get("matchedGrantIds")
        || result.get("implementationEvidence").and_then(Value::as_str) != Some("adapter-validated")
    {
        return Err("Mission connected-source outer authority is invalid.".into());
    }
    let encoded = serde_json::to_vec(&result)
        .map_err(|_| "Mission connected-source result is invalid.".to_string())?;
    if encoded.is_empty() || encoded.len() > 131_072 {
        return Err("Mission connected-source result is too large.".into());
    }
    let hash = format!("{:x}", Sha256::digest(&encoded));
    let reference = crate::store::repos::mission_worker_tool::binding_reference(
        &authority.local_workspace_id,
        &authority.member_id,
        &authority.binding.run_id,
        &authority.binding.worker_id,
        &authority.binding.tool_event_id,
        &authority.binding.call_key,
        &hash,
    );
    let _identity_guard =
        crate::clerk_identity::lock_native_identity_generation(&authority.identity)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store.transaction(|tx| {
        let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
        if context.active_workspace.local_workspace_id != authority.local_workspace_id
            || context.member_id.as_deref() != Some(authority.member_id.as_str())
            || context.internal_user_id != authority.internal_user_id {
            return Err(crate::store::StoreError::Invalid("Mission tool authority changed during connected-source search.".into()));
        }
        let scope = crate::store::repos::scope::DataScope::workspace(authority.local_workspace_id.clone())?;
        let journal = mission_run::get(tx, store, &scope, &authority.member_id, &authority.binding.run_id)?
            .ok_or_else(|| crate::store::StoreError::Invalid("Mission run disappeared.".into()))?;
        let key = native_tool_event_key(&authority.binding).map_err(crate::store::StoreError::Invalid)?;
        if let Some(existing) = journal.events.iter().find(|event| event.get("idempotencyKey").and_then(Value::as_str) == Some(key.as_str())) {
            if existing.pointer("/payload/result/outputReference").and_then(Value::as_str) == Some(reference.as_str()) { return Ok(reference); }
            return Err(crate::store::StoreError::Invalid("Mission tool idempotency key represents another result.".into()));
        }
        validate_native_tool_head(&journal, &authority.binding).map_err(crate::store::StoreError::Invalid)?;
        let at = now();
        let sequence = authority.binding.expected_last_sequence + 1;
        let event = json!({
            "workspaceId":authority.local_workspace_id,"visibility":"member-private","ownerMemberId":authority.member_id,
            "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":authority.internal_user_id,
            "createdAt":at,"updatedAt":at,"id":authority.binding.tool_event_id,"runId":authority.binding.run_id,
            "type":"tool-call-completed","sequence":sequence,"previousEventId":authority.binding.route_selected_event_id,
            "attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),"occurredAt":at,
            "actor":{"kind":"system"},"idempotencyKey":key,
            "payload":{"result":{"callKey":authority.binding.call_key,"workerId":authority.binding.worker_id,
                "toolName":"connection-read","outputReference":reference,"outputHash":hash}}
        });
        let mut projected = journal.run.as_object().cloned().ok_or_else(|| crate::store::StoreError::Invalid("Mission run record is invalid.".into()))?;
        projected.insert("revision".into(), json!(authority.binding.expected_run_revision + 1));
        projected.insert("updatedAt".into(), json!(at));
        projected.insert("eventHead".into(), json!({"lastSequence":sequence,"lastEventId":authority.binding.tool_event_id}));
        mission_run::append(tx, store, &scope, &authority.member_id, &authority.binding.run_id,
            authority.binding.expected_run_revision, authority.binding.expected_last_sequence, &authority.binding.tool_event_id,
            "tool-call-completed", &key, &event, &Value::Object(projected), &at)?;
        let receipt = json!({"version":1,"workspaceId":authority.local_workspace_id,"ownerMemberId":authority.member_id,
            "runId":authority.binding.run_id,"workerId":authority.binding.worker_id,"toolEventId":authority.binding.tool_event_id,
            "callKey":authority.binding.call_key,"outputReference":reference,"outputHash":hash,"sizeBytes":encoded.len(),
            "trust":"external-untrusted","instructionAuthority":"none","result":result,"createdAt":at});
        crate::store::repos::mission_worker_tool::put(tx, store, &scope, &authority.member_id, &authority.binding.run_id,
            &authority.binding.worker_id, &authority.binding.tool_event_id, &authority.binding.call_key, &reference, &hash,
            encoded.len() as i64, &receipt, &at)?;
        Ok(reference)
    }).map_err(|error| error.to_string())
}

pub(crate) fn preflight_native_worker_completion(
    binding: &NativeWorkerExecutionBinding,
    provider_id: &str,
    model: &str,
    body: &Value,
) -> Result<NativeWorkerCompletionPreflight, String> {
    if !crate::native_api::supports_native_mission_provider(provider_id) {
        return Err("Native mission completion requires a registered native provider.".into());
    }
    let identity = crate::clerk_identity::native_identity_generation_snapshot()?;
    let _identity_guard = crate::clerk_identity::lock_native_identity_generation(&identity)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
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
            let journal = mission_run::get(tx, store, &scope, &member, &binding.run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let worker = journal
                .events
                .iter()
                .find(|event| {
                    event.get("type").and_then(Value::as_str) == Some("worker-created")
                        && event.pointer("/payload/worker/id").and_then(Value::as_str)
                            == Some(binding.worker_id.as_str())
                })
                .and_then(|event| event.pointer("/payload/worker"))
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission worker assignment is unavailable.".into(),
                    )
                })?;
            let provider_route_id = validate_selected_provider_route(
                tx,
                &context.internal_user_id,
                &journal,
                binding,
                provider_id,
                model,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let mission_id = journal
                .run
                .get("missionId")
                .or_else(|| journal.run.pointer("/initiator/missionId"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run has no selected mission.".into(),
                    )
                })?;
            let lifecycle = mission_plan::get(tx, store, &scope, &member, mission_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission plan is unavailable.".into())
                })?;
            let reviewed_parallel_context =
                crate::mission_parallel_approaches::reviewed_worker_context_in_tx(
                    tx,
                    store,
                    &scope,
                    &member,
                    &journal,
                    &lifecycle,
                    &binding.worker_id,
                )?;
            let general_objective = if reviewed_parallel_context.is_none() {
                Some(
                    crate::mission_coordination::native_general_worker_objective_in_tx(
                        tx,
                        store,
                        &scope,
                        &member,
                        &journal,
                        &lifecycle,
                        &binding.worker_id,
                    )?,
                )
            } else {
                None
            };
            let evidence = match binding.tool_evidence.as_ref() {
                Some(evidence) => Some(load_native_tool_evidence(
                    tx, store, &scope, &member, &journal, binding, worker, evidence,
                )?),
                None => {
                    for path in ["/tools", "/capabilityIds", "/capabilityGrantIds"] {
                        if worker.pointer(path).and_then(Value::as_array).is_none_or(|items| !items.is_empty()) {
                            return Err(crate::store::StoreError::Invalid(
                                "Native completion requires exact attested tool evidence for a tool-bearing worker.".into(),
                            ));
                        }
                    }
                    if reviewed_parallel_context.is_none()
                        && worker
                            .pointer("/context")
                            .and_then(Value::as_array)
                            .is_none_or(|items| !items.is_empty())
                    {
                        return Err(crate::store::StoreError::Invalid(
                            "Native completion does not accept unattested worker context.".into(),
                        ));
                    }
                    None
                }
            };
            let output = native_output_spec(worker).map_err(crate::store::StoreError::Invalid)?;
            let cited_policy_shape = is_cited_terminal_status_shape(&journal, &lifecycle);
            if cited_policy_shape
                && output.as_ref().is_some_and(|spec| spec.include_evidence) != evidence.is_some()
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission output evidence does not match its worker contract.".into(),
                ));
            }
            let objective = worker
                .pointer("/role/objective")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission worker objective is invalid.".into())
                })?;
            let max_tokens = worker
                .pointer("/budget/maxOutputTokens")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission worker output budget is invalid.".into())
                })?;
            let max_input_tokens = worker.pointer("/budget/maxInputTokens").and_then(Value::as_i64);
            let max_duration_ms = worker
                .pointer("/budget/maxDurationMs")
                .and_then(Value::as_i64)
                .filter(|value| (1..=600_000).contains(value))
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission worker duration budget is invalid.".into(),
                    )
                })?;
            let attempt_number = journal
                .run
                .get("currentAttemptNumber")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            // A checkpoint restore advances the run attempt while retaining the
            // same worker assignment. The mission owns that retry budget; the
            // worker's per-assignment attempt clamp must not invalidate attempt 2.
            let parallel_evidence_free = is_parallel_evidence_free_markdown_run(
                &journal,
                &lifecycle,
                binding,
                worker,
                output.as_ref(),
            ) || reviewed_parallel_context.is_some();
            let general_concurrent_provider = is_general_concurrent_provider_run(
                &journal,
                &lifecycle,
                binding,
                output.as_ref(),
            );
            let max_attempts = lifecycle
                .mission
                .pointer("/budget/maxAttempts")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission attempt budget is unavailable.".into(),
                    )
                })?;
            validate_native_attempt_budget(max_attempts, attempt_number)
                .map_err(crate::store::StoreError::Invalid)?;
            let prompt = native_attested_worker_prompt(
                objective,
                output.as_ref(),
                evidence.as_ref(),
                reviewed_parallel_context.as_ref(),
                general_objective.as_deref(),
            );
            match crate::native_api::provider_kind(provider_id) {
                crate::native_api::ProviderKind::OpenAiCompat => {
                    validate_openai_compatible_worker_body(body, model, &prompt, max_tokens)
                }
                crate::native_api::ProviderKind::Anthropic => {
                    validate_anthropic_worker_body(body, model, &prompt, max_tokens)
                }
                crate::native_api::ProviderKind::Gemini => {
                    validate_gemini_worker_body(body, &prompt, max_tokens)
                }
            }
            .map_err(crate::store::StoreError::Invalid)?;
            for event_key in native_terminal_event_keys(binding)
                .map_err(crate::store::StoreError::Invalid)?
            {
                if let Some(existing) = journal.events.iter().find(|event| {
                    event.get("idempotencyKey").and_then(Value::as_str)
                        == Some(event_key.as_str())
                }) {
                    exact_native_terminal_replay_with_mode(
                        &journal,
                        existing,
                        binding,
                        output.as_ref(),
                        parallel_evidence_free,
                    )
                    .map_err(crate::store::StoreError::Invalid)?;
                    validate_usage_replay_with_mode(
                        &journal,
                        existing,
                        binding,
                        model,
                        max_duration_ms,
                        attempt_number,
                        parallel_evidence_free,
                    )
                        .map_err(crate::store::StoreError::Invalid)?;
                    validate_output_receipt_replay(
                        tx, store, &scope, &member, &journal, existing, binding, output.as_ref(),
                    )?;
                    validate_native_result_replay(
                        &journal,
                        existing,
                        binding,
                        output.as_ref(),
                        cited_policy_shape,
                    )
                    .map_err(crate::store::StoreError::Invalid)?;
                    if cited_policy_shape {
                        validate_accepted_mission_artifact_replay(
                            tx, store, &scope, &member, &journal, existing, binding, output.as_ref(),
                        )?;
                        validate_cited_mission_transcript_replay(
                            tx, store, &scope, &member, &journal, existing, binding, output.as_ref(),
                        )?;
                    }
                    return Ok(NativeWorkerCompletionPreflight::AlreadyCompleted);
                }
            }
            let retry_key = native_retry_event_key(binding)
                .map_err(crate::store::StoreError::Invalid)?;
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str)
                    == Some(retry_key.as_str())
            }) {
                validate_native_retry_replay(
                    &journal,
                    existing,
                    binding,
                    model,
                    max_duration_ms,
                    attempt_number,
                    max_attempts,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                return Ok(NativeWorkerCompletionPreflight::AlreadyCompleted);
            }
            validate_native_completion_head(
                &journal,
                binding,
                parallel_evidence_free,
                general_concurrent_provider,
            )
                .map_err(crate::store::StoreError::Invalid)?;
            Ok(NativeWorkerCompletionPreflight::Execute(NativeWorkerCompletionAuthority {
                binding: binding.clone(),
                identity: identity.clone(),
                local_workspace_id: scope.workspace_id().to_string(),
                member_id: member,
                internal_user_id: context.internal_user_id,
                provider_id: provider_id.to_string(),
                requested_model: model.to_string(),
                provider_route_id,
                output,
                max_input_tokens,
                max_output_tokens: max_tokens,
                max_duration_ms,
                attempt_number,
                max_attempts,
                evidence,
                cited_policy_shape,
                parallel_evidence_free,
                general_concurrent_provider,
                reviewed_parallel_context,
            }))
        })
        .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn load_native_tool_evidence(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    member: &str,
    journal: &mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
    worker: &Value,
    evidence: &NativeWorkerToolEvidenceBinding,
) -> crate::store::Result<Value> {
    load_cited_tool_evidence(
        tx,
        store,
        scope,
        member,
        journal,
        &binding.run_id,
        &binding.worker_id,
        worker,
        evidence,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn load_cited_tool_evidence(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    member: &str,
    journal: &mission_run::MissionRunJournalRow,
    run_id: &str,
    worker_id: &str,
    worker: &Value,
    evidence: &NativeWorkerToolEvidenceBinding,
) -> crate::store::Result<Value> {
    bounded(&evidence.tool_event_id, "Mission tool evidence event", 200)
        .map_err(crate::store::StoreError::Invalid)?;
    if !evidence.output_reference.starts_with("mission-tool:v1:")
        || evidence.output_reference.len() > 512
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission tool evidence reference is invalid.".into(),
        ));
    }
    let event = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str) == Some(evidence.tool_event_id.as_str())
        })
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission tool evidence event is unavailable.".into())
        })?;
    if event.get("type").and_then(Value::as_str) != Some("tool-call-completed")
        || event
            .pointer("/payload/result/workerId")
            .and_then(Value::as_str)
            != Some(worker_id)
        || event
            .pointer("/payload/result/toolName")
            .and_then(Value::as_str)
            != Some("connection-read")
        || event
            .pointer("/payload/result/outputReference")
            .and_then(Value::as_str)
            != Some(evidence.output_reference.as_str())
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission tool evidence event is invalid.".into(),
        ));
    }
    let receipt = crate::store::repos::mission_worker_tool::get_by_reference(
        tx,
        store,
        scope,
        member,
        &evidence.output_reference,
    )?
    .ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission tool evidence receipt is unavailable.".into())
    })?;
    if receipt.run_id != run_id
        || receipt.worker_id != worker_id
        || receipt.tool_event_id != evidence.tool_event_id
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission tool evidence crosses its worker boundary.".into(),
        ));
    }
    let mappings = worker_grant_mappings(worker).map_err(crate::store::StoreError::Invalid)?;
    let tools = worker
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission worker tools are invalid.".into())
        })?;
    let result = receipt.receipt.get("result").cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission tool evidence result is invalid.".into())
    })?;
    let connected = result.get("result").ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission connected-source evidence is invalid.".into())
    })?;
    if tools.len() != 1
        || tools[0].get("toolName").and_then(Value::as_str) != Some("connection-read")
        || mappings.len() != 1
        || mappings[0].capability_id != "knowledge.content.search"
        || connected
            .get("matchedGrantIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| {
                ids.len() != 1 || ids[0].as_str() != Some(mappings[0].capability_grant_id.as_str())
            })
        || connected.get("trust").and_then(Value::as_str) != Some("external-untrusted")
        || connected
            .get("instructionAuthority")
            .and_then(Value::as_str)
            != Some("none")
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission connected-source evidence does not match its worker assignment.".into(),
        ));
    }
    Ok(result)
}

pub(crate) fn settle_native_worker_completion(
    authority: &NativeWorkerCompletionAuthority,
    outcome: NativeWorkerTerminalOutcome,
) -> Result<(), String> {
    let _identity_guard =
        crate::clerk_identity::lock_native_identity_generation(&authority.identity)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            if context.active_workspace.local_workspace_id != authority.local_workspace_id
                || context.member_id.as_deref() != Some(authority.member_id.as_str())
                || context.internal_user_id != authority.internal_user_id
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission worker authority changed during provider execution.".into(),
                ));
            }
            let scope = crate::store::repos::scope::DataScope::workspace(
                authority.local_workspace_id.clone(),
            )?;
            let journal = mission_run::get(
                tx,
                store,
                &scope,
                &authority.member_id,
                &authority.binding.run_id,
            )?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run disappeared.".into())
            })?;
            if authority.parallel_evidence_free {
                validate_parallel_evidence_free_authority(
                    tx,
                    store,
                    &scope,
                    &authority.member_id,
                    &journal,
                    authority,
                )?;
            }
            if matches!(outcome, NativeWorkerTerminalOutcome::Cancelled)
                || journal.run.get("status").and_then(Value::as_str) == Some("cancelling")
            {
                return append_native_run_cancellation(
                    tx,
                    store,
                    &scope,
                    &authority.member_id,
                    &authority.internal_user_id,
                    &journal,
                    &authority.binding,
                    authority.parallel_evidence_free,
                );
            }
            let outcome = enforce_reviewed_parallel_output_contract(
                authority.reviewed_parallel_context.as_ref(),
                outcome,
            );
            let retry_key = native_retry_event_key(&authority.binding)
                .map_err(crate::store::StoreError::Invalid)?;
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str)
                    == Some(retry_key.as_str())
            }) {
                validate_native_retry_replay(
                    &journal,
                    existing,
                    &authority.binding,
                    &authority.requested_model,
                    authority.max_duration_ms,
                    authority.attempt_number,
                    authority.max_attempts,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                return Ok(());
            }
            let (event_key, event_id, event_type) = match &outcome {
                NativeWorkerTerminalOutcome::Completed { .. } => (
                    native_terminal_event_keys(&authority.binding)
                        .map_err(crate::store::StoreError::Invalid)?[0]
                        .clone(),
                    authority.binding.completion_event_id.as_str(),
                    "worker-completed",
                ),
                NativeWorkerTerminalOutcome::Failed { .. } => (
                    native_terminal_event_keys(&authority.binding)
                        .map_err(crate::store::StoreError::Invalid)?[1]
                        .clone(),
                    authority.binding.failure_event_id.as_str(),
                    "worker-failed",
                ),
                NativeWorkerTerminalOutcome::Cancelled => unreachable!(),
            };
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                exact_native_terminal_replay_with_mode(
                    &journal,
                    existing,
                    &authority.binding,
                    authority.output.as_ref(),
                    authority.parallel_evidence_free,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                validate_usage_replay_with_mode(
                    &journal,
                    existing,
                    &authority.binding,
                    &authority.requested_model,
                    authority.max_duration_ms,
                    authority.attempt_number,
                    authority.parallel_evidence_free,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                validate_output_receipt_replay(
                    tx,
                    store,
                    &scope,
                    &authority.member_id,
                    &journal,
                    existing,
                    &authority.binding,
                    authority.output.as_ref(),
                )?;
                validate_native_result_replay(
                    &journal,
                    existing,
                    &authority.binding,
                    authority.output.as_ref(),
                    authority.cited_policy_shape,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                if authority.cited_policy_shape {
                    validate_accepted_mission_artifact_replay(
                        tx,
                        store,
                        &scope,
                        &authority.member_id,
                        &journal,
                        existing,
                        &authority.binding,
                        authority.output.as_ref(),
                    )?;
                    validate_cited_mission_transcript_replay(
                        tx,
                        store,
                        &scope,
                        &authority.member_id,
                        &journal,
                        existing,
                        &authority.binding,
                        authority.output.as_ref(),
                    )?;
                }
                return Ok(());
            }
            validate_native_completion_head(
                &journal,
                &authority.binding,
                authority.parallel_evidence_free,
                authority.general_concurrent_provider,
            )
                .map_err(crate::store::StoreError::Invalid)?;
            let at = now();
            let workspace = journal
                .run
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
            })?;
            let mut receipt = None;
            let mut retry_error = None;
            let usage: Option<ObservedNativeUsage>;
            let payload = match outcome {
                NativeWorkerTerminalOutcome::Completed {
                    text,
                    input_tokens,
                    output_tokens,
                    duration_ms,
                    attempt_number,
                } => {
                    if input_tokens < 0
                        || output_tokens < 0
                        || output_tokens > authority.max_output_tokens
                        || authority
                            .max_input_tokens
                            .is_some_and(|maximum| input_tokens > maximum)
                    {
                        return Err(crate::store::StoreError::Invalid(
                            "Native provider usage exceeded the worker budget.".into(),
                        ));
                    }
                    validate_native_usage_timing(
                        authority.max_duration_ms,
                        authority.attempt_number,
                        duration_ms,
                        attempt_number,
                        false,
                    )
                    .map_err(crate::store::StoreError::Invalid)?;
                    usage = Some(ObservedNativeUsage {
                        input_tokens: Some(input_tokens),
                        output_tokens: Some(output_tokens),
                        duration_ms,
                        attempt_number,
                    });
                    let outputs = match (&authority.output, text) {
                        (None, None) => Vec::new(),
                        (Some(spec), Some(text))
                            if !text.trim().is_empty() && text.len() <= 65_536 =>
                        {
                            let citations = match authority.evidence.as_ref() {
                                Some(evidence) => validate_cited_brief(&text, evidence)
                                    .map_err(crate::store::StoreError::Invalid)?,
                                None => Vec::new(),
                            };
                            let content_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
                            let value_reference = crate::store::repos::mission_worker_output::binding_reference(
                                workspace,
                                &authority.member_id,
                                &authority.binding.run_id,
                                &authority.binding.worker_id,
                                &authority.binding.completion_event_id,
                                &spec.key,
                                &content_hash,
                            );
                            let size_bytes = text.len() as i64;
                            let receipt_value = json!({
                                "version":if authority.evidence.is_some(){2}else{1},"workspaceId":workspace,"ownerMemberId":authority.member_id,
                                "runId":authority.binding.run_id,"workerId":authority.binding.worker_id,
                                "completionEventId":authority.binding.completion_event_id,
                                "outputKey":spec.key,"valueReference":value_reference,
                                "contentHash":content_hash,"sizeBytes":size_bytes,"text":text,
                                "mediaType":"text/markdown","encoding":"utf-8",
                                "observedProvider":authority.provider_id,"providerRouteId":authority.provider_route_id,"requestedModel":authority.requested_model,
                                "trust":if authority.evidence.is_some(){"provider-generated-with-external-evidence"}else{"provider-generated"},
                                "citations":citations,"createdAt":at
                            });
                            receipt = Some((
                                spec.key.clone(),
                                value_reference.clone(),
                                content_hash,
                                size_bytes,
                                receipt_value,
                            ));
                            vec![json!({
                                "key":spec.key,"summary":"Native worker text output",
                                "valueReference":value_reference
                            })]
                        }
                        _ => {
                            return Err(crate::store::StoreError::Invalid(
                                "Native worker output does not match its persisted contract.".into(),
                            ));
                        }
                    };
                    json!({"workerId":authority.binding.worker_id,"outputs":outputs})
                }
                NativeWorkerTerminalOutcome::Failed {
                    code,
                    message,
                    retryable,
                    usage: observed_usage,
                    duration_ms,
                    attempt_number,
                } => {
                    if let Some((input, output)) = observed_usage {
                        if input < 0 || output < 0 {
                            return Err(crate::store::StoreError::Invalid(
                                "Native provider usage is invalid.".into(),
                            ));
                        }
                    }
                    validate_native_usage_timing(
                        authority.max_duration_ms,
                        authority.attempt_number,
                        duration_ms,
                        attempt_number,
                        code == "native-worker-duration-budget-exceeded",
                    )
                    .map_err(crate::store::StoreError::Invalid)?;
                    usage = Some(ObservedNativeUsage {
                        input_tokens: observed_usage.map(|value| value.0),
                        output_tokens: observed_usage.map(|value| value.1),
                        duration_ms,
                        attempt_number,
                    });
                    let category = if matches!(
                        code,
                        "native-worker-token-budget-exceeded"
                            | "native-worker-duration-budget-exceeded"
                    ) {
                        "budget-exceeded"
                    } else if code == "native-worker-output-contract-invalid" {
                        "validation"
                    } else {
                        "provider"
                    };
                    let error = json!({
                        "code":code,"category":category,"message":message,"retryable":retryable
                    });
                    if retryable_cited_provider_failure(authority, code, retryable) {
                        retry_error = Some(error.clone());
                    }
                    json!({"workerId":authority.binding.worker_id,"error":error})
                },
                NativeWorkerTerminalOutcome::Cancelled => unreachable!(),
            };
            let (mut terminal_expected_revision, mut terminal_expected_sequence, mut terminal_previous_event) =
                if authority.parallel_evidence_free || authority.general_concurrent_provider {
                    let revision = journal.run.get("revision").and_then(Value::as_i64).ok_or_else(|| {
                        crate::store::StoreError::Invalid("Mission run revision is invalid.".into())
                    })?;
                    let sequence = journal.run.pointer("/eventHead/lastSequence").and_then(Value::as_i64).ok_or_else(|| {
                        crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
                    })?;
                    let previous = journal.run.pointer("/eventHead/lastEventId").and_then(Value::as_str).ok_or_else(|| {
                        crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
                    })?;
                    (revision, sequence, previous)
                } else {
                    (
                        authority.binding.expected_run_revision,
                        authority.binding.expected_last_sequence,
                        native_completion_base_event(&authority.binding),
                    )
                };
            if let Some(observed_usage) = usage {
                let costs = observed_usage
                    .tokens()
                    .map(|(input, output)| {
                        exact_model_costs(
                            &authority.provider_id,
                            &authority.requested_model,
                            input,
                            output,
                        )
                    })
                    .unwrap_or_default();
                let usage_sequence = terminal_expected_sequence + 1;
                let usage_key = native_usage_event_key(&authority.binding)
                    .map_err(crate::store::StoreError::Invalid)?;
                let mut usage_payload = json!({
                    "usageKey":format!("native-usage:{}",authority.binding.usage_event_id),
                    "runId":authority.binding.run_id,"attemptNumber":observed_usage.attempt_number,
                    "workerId":authority.binding.worker_id,"providerRouteId":authority.provider_route_id,
                    "modelReference":authority.requested_model,
                    "toolCalls":if authority.evidence.is_some(){1}else{0},
                    "durationMs":observed_usage.duration_ms,"costs":costs,"measuredAt":at
                });
                if let Some(object) = usage_payload.as_object_mut() {
                    if let Some(input_tokens) = observed_usage.input_tokens {
                        object.insert("inputTokens".into(), json!(input_tokens));
                    }
                    if let Some(output_tokens) = observed_usage.output_tokens {
                        object.insert("outputTokens".into(), json!(output_tokens));
                    }
                }
                let usage_event = json!({
                    "workspaceId":workspace,"visibility":"member-private","ownerMemberId":authority.member_id,
                    "authority":"local","schemaVersion":1,"revision":1,
                    "createdByInternalUserId":authority.internal_user_id,"createdAt":at,"updatedAt":at,
                    "id":authority.binding.usage_event_id,"runId":authority.binding.run_id,
                    "type":"usage-recorded","sequence":usage_sequence,"previousEventId":terminal_previous_event,
                    "attemptNumber":observed_usage.attempt_number,
                    "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":usage_key,
                    "payload":{"usage":usage_payload}
                });
                let mut usage_projection = journal.run.as_object().cloned().ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission run record is invalid.".into())
                })?;
                usage_projection.insert(
                    "revision".into(),
                    json!(terminal_expected_revision + 1),
                );
                usage_projection.insert("updatedAt".into(), json!(at));
                usage_projection.insert(
                    "eventHead".into(),
                    json!({"lastSequence":usage_sequence,"lastEventId":authority.binding.usage_event_id}),
                );
                mission_run::append(
                    tx, store, &scope, &authority.member_id, &authority.binding.run_id,
                    terminal_expected_revision,
                    terminal_expected_sequence,
                    &authority.binding.usage_event_id,
                    "usage-recorded",
                    &usage_key,
                    &usage_event,
                    &Value::Object(usage_projection),
                    &at,
                )?;
                terminal_expected_revision += 1;
                terminal_expected_sequence += 1;
                terminal_previous_event = authority.binding.usage_event_id.as_str();
            }
            if let Some(error) = retry_error.as_ref() {
                append_native_cited_retry(
                    tx,
                    store,
                    &scope,
                    &authority.member_id,
                    &authority.internal_user_id,
                    &journal,
                    &authority.binding,
                    error,
                    terminal_expected_revision,
                    terminal_expected_sequence,
                    terminal_previous_event,
                    &at,
                )?;
                return Ok(());
            }
            let sequence = terminal_expected_sequence + 1;
            let event = json!({
                "workspaceId":workspace,"visibility":"member-private","ownerMemberId":authority.member_id,
                "authority":"local","schemaVersion":1,"revision":1,
                "createdByInternalUserId":authority.internal_user_id,"createdAt":at,"updatedAt":at,
                "id":event_id,"runId":authority.binding.run_id,
                "type":event_type,"sequence":sequence,"previousEventId":terminal_previous_event,
                "attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
                "occurredAt":at,"actor":{"kind":"system"},
                "correlationKey":format!("native-worker-completion:v1:run-revision:{}", authority.binding.expected_run_revision),
                "idempotencyKey":event_key,"payload":payload
            });
            let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run record is invalid.".into())
            })?;
            projected.insert(
                "revision".into(),
                json!(terminal_expected_revision + 1),
            );
            projected.insert("updatedAt".into(), json!(at));
            projected.insert(
                "eventHead".into(),
                json!({"lastSequence":sequence,"lastEventId":event_id}),
            );
            mission_run::append(
                tx,
                store,
                &scope,
                &authority.member_id,
                &authority.binding.run_id,
                terminal_expected_revision,
                terminal_expected_sequence,
                event_id,
                event_type,
                &event_key,
                &event,
                &Value::Object(projected),
                &at,
            )?;
            if let Some((key, reference, hash, size, receipt_value)) = receipt.as_ref() {
                crate::store::repos::mission_worker_output::put(
                    tx,
                    store,
                    &scope,
                    &authority.member_id,
                    &authority.binding.run_id,
                    &authority.binding.worker_id,
                    &authority.binding.completion_event_id,
                    key,
                    reference,
                    hash,
                    *size,
                    receipt_value,
                    &at,
                )?;
            }
            if authority.cited_policy_shape {
                if let Some((_, reference, _, _, receipt_value)) = receipt.as_ref() {
                    append_native_policy_evaluation(
                        tx,
                        store,
                        &scope,
                        &authority.member_id,
                        &authority.internal_user_id,
                        &journal,
                        &authority.binding,
                        reference,
                        receipt_value,
                        usage.and_then(ObservedNativeUsage::tokens),
                        &authority.provider_id,
                        &authority.requested_model,
                        &authority.provider_route_id,
                        terminal_expected_revision + 1,
                        sequence,
                        event_id,
                        &at,
                    )?;
                } else if event_type == "worker-failed" {
                    let error = event.pointer("/payload/error").ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "Mission worker failure error is unavailable.".into(),
                        )
                    })?;
                    append_single_worker_run_failure(
                        tx,
                        store,
                        &scope,
                        &authority.member_id,
                        &authority.internal_user_id,
                        &journal,
                        &authority.binding,
                        error,
                        terminal_expected_revision + 1,
                        sequence,
                        event_id,
                        &at,
                    )?;
                } else {
                    return Err(crate::store::StoreError::Invalid(
                        "Cited Mission output receipt is unavailable.".into(),
                    ));
                }
            }
            Ok(())
        })
        .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn append_native_cited_retry(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
    error: &Value,
    expected_revision: i64,
    expected_sequence: i64,
    previous_event_id: &str,
    at: &str,
) -> crate::store::Result<()> {
    let selected_route = journal.run.get("selectedRoute").cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited retry route is unavailable.".into())
    })?;
    let started_at = journal
        .events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("worker-started")
                && event.pointer("/payload/workerId").and_then(Value::as_str)
                    == Some(binding.worker_id.as_str())
        })
        .and_then(|event| event.get("occurredAt"))
        .cloned()
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited retry worker start is unavailable.".into())
        })?;
    let attempt_key =
        native_attempt_finished_event_key(binding).map_err(crate::store::StoreError::Invalid)?;
    let attempt_sequence = expected_sequence + 1;
    let attempt_event = json!({
        "workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,
        "createdAt":at,"updatedAt":at,"id":binding.failure_event_id,"runId":binding.run_id,
        "type":"attempt-finished","sequence":attempt_sequence,"previousEventId":previous_event_id,
        "attemptNumber":1,"occurredAt":at,"actor":{"kind":"system"},
        "correlationKey":format!("native-worker-retry:v1:run-revision:{}",binding.expected_run_revision),
        "idempotencyKey":attempt_key,
        "payload":{"attempt":{"runId":binding.run_id,"attemptNumber":1,"status":"failed",
            "retryReason":error,"selectedRoute":selected_route,
            "selectedPlacement":{"executionNodeId":"execution-node-local-desktop","selectedAt":at,
                "reason":"Selected the authenticated local desktop runtime."},
            "startedAt":started_at,"finishedAt":at}}
    });
    let mut attempt_projection = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    attempt_projection.insert("revision".into(), json!(expected_revision + 1));
    attempt_projection.insert("updatedAt".into(), json!(at));
    attempt_projection.insert(
        "eventHead".into(),
        json!({"lastSequence":attempt_sequence,"lastEventId":binding.failure_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        expected_revision,
        expected_sequence,
        &binding.failure_event_id,
        "attempt-finished",
        &attempt_key,
        &attempt_event,
        &Value::Object(attempt_projection),
        at,
    )?;

    let retry_key = native_retry_event_key(binding).map_err(crate::store::StoreError::Invalid)?;
    let retry_sequence = attempt_sequence + 1;
    let retry_event = json!({
        "workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,
        "createdAt":at,"updatedAt":at,"id":binding.result_event_id,"runId":binding.run_id,
        "type":"retry-scheduled","sequence":retry_sequence,"previousEventId":binding.failure_event_id,
        "attemptNumber":1,"occurredAt":at,"actor":{"kind":"system"},
        "correlationKey":format!("native-worker-retry:v1:run-revision:{}",binding.expected_run_revision),
        "idempotencyKey":retry_key,"payload":{"nextAttemptNumber":2,"error":error}
    });
    let mut retry_projection = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    retry_projection.insert("status".into(), json!("retrying"));
    retry_projection.insert("revision".into(), json!(expected_revision + 2));
    retry_projection.insert("updatedAt".into(), json!(at));
    retry_projection.insert(
        "eventHead".into(),
        json!({"lastSequence":retry_sequence,"lastEventId":binding.result_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        expected_revision + 1,
        attempt_sequence,
        &binding.result_event_id,
        "retry-scheduled",
        &retry_key,
        &retry_event,
        &Value::Object(retry_projection),
        at,
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_native_policy_evaluation(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
    output_reference: &str,
    receipt: &Value,
    usage: Option<(i64, i64)>,
    provider_id: &str,
    requested_model: &str,
    provider_route_id: &str,
    expected_revision: i64,
    expected_sequence: i64,
    previous_event_id: &str,
    at: &str,
) -> crate::store::Result<()> {
    let worker = journal
        .events
        .iter()
        .find_map(|event| {
            (event.get("type").and_then(Value::as_str) == Some("worker-created")
                && event.pointer("/payload/worker/id").and_then(Value::as_str)
                    == Some(binding.worker_id.as_str()))
            .then(|| event.pointer("/payload/worker"))
            .flatten()
        })
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission worker assignment is unavailable.".into())
        })?;
    let step_key = worker
        .get("planStepKey")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission worker step is invalid.".into())
        })?;
    let mission_id = journal
        .run
        .get("missionId")
        .or_else(|| journal.run.pointer("/initiator/missionId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run has no selected mission.".into())
        })?;
    let lifecycle = mission_plan::get(tx, store, scope, owner_member_id, mission_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission plan is unavailable.".into()))?;
    validate_lifecycle(&journal.run, &lifecycle).map_err(crate::store::StoreError::Invalid)?;
    let step = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .find(|step| step.get("key").and_then(Value::as_str) == Some(step_key))
        })
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission worker plan step is unavailable.".into())
        })?;
    let criterion_keys = step
        .get("acceptanceCriterionKeys")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Mission worker acceptance criteria are invalid.".into(),
            )
        })?;
    let criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission acceptance criteria are invalid.".into())
        })?;
    let available_evidence = std::iter::once(output_reference.to_string())
        .chain(
            receipt
                .get("citations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|citation| {
                    citation
                        .get("citationId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
        )
        .collect::<BTreeSet<_>>();
    let mut results = Vec::new();
    for key in criterion_keys.iter().filter_map(Value::as_str) {
        let criterion = criteria
            .iter()
            .find(|criterion| criterion.get("key").and_then(Value::as_str) == Some(key))
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Mission worker references an unknown acceptance criterion.".into(),
                )
            })?;
        if criterion.get("evaluator").and_then(Value::as_str) != Some("policy") {
            continue;
        }
        let required = criterion
            .get("evidenceRequired")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        let passed = receipt.get("version").and_then(Value::as_i64) == Some(2)
            && receipt.get("trust").and_then(Value::as_str)
                == Some("provider-generated-with-external-evidence")
            && receipt
                .get("citations")
                .and_then(Value::as_array)
                .is_some_and(|values| !values.is_empty())
            && required
                .iter()
                .all(|reference| available_evidence.contains(*reference));
        results.push(json!({"criterionKey":key,"passed":passed,
            "summary":if passed{"The cited brief is backed by Rust-attested connected-source evidence."}else{"The cited brief does not satisfy its required attested evidence."},
            "evidenceRefs":available_evidence.iter().cloned().collect::<Vec<_>>() }));
    }
    if results.is_empty() {
        return Ok(());
    }
    let idempotency_key = format!(
        "worker-evaluation:{}",
        bounded(
            &binding.idempotency_key,
            "Worker evaluation idempotency key",
            200
        )
        .map_err(crate::store::StoreError::Invalid)?
    );
    let passed = results
        .iter()
        .all(|result| result.get("passed").and_then(Value::as_bool) == Some(true));
    let evaluation = json!({"evaluationKey":format!("native-policy:{}",binding.evaluation_event_id),
        "target":{"kind":"worker","workerId":binding.worker_id},
        "verdict":if passed{"pass"}else{"fail"},
        "criteria":results,"summary":"Fable evaluated the durable cited output against its policy criteria.",
        "recommendedAction":if passed{"accept"}else{"revise"},
        "evaluatedAt":at});
    let sequence = expected_sequence + 1;
    let event = json!({"workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,
        "createdAt":at,"updatedAt":at,"id":binding.evaluation_event_id,"runId":binding.run_id,"type":"evaluation-recorded",
        "sequence":sequence,"previousEventId":previous_event_id,"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":idempotency_key,"payload":{"evaluation":evaluation}});
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("revision".into(), json!(expected_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":binding.evaluation_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        expected_revision,
        expected_sequence,
        &binding.evaluation_event_id,
        "evaluation-recorded",
        &idempotency_key,
        &event,
        &Value::Object(projected),
        at,
    )?;
    let workspace_id = journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    let plan_revision_id = lifecycle
        .current_revision
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission plan revision is invalid.".into())
        })?;
    let observation_digest =
        Sha256::digest(format!("{internal_user_id}:{}", binding.evaluation_event_id).as_bytes());
    let observation_id = format!("route-policy-observation:v1:{observation_digest:x}");
    if let Err(error) = crate::store::repos::provider_route_quality_observation::record(
        tx,
        store,
        internal_user_id,
        provider_id,
        provider_route_id,
        crate::backends::NATIVE_CITED_BRIEF_POLICY_REVISION,
        &observation_id,
        requested_model,
        workspace_id,
        owner_member_id,
        plan_revision_id,
        &binding.run_id,
        &binding.worker_id,
        &binding.route_selected_event_id,
        &binding.evaluation_event_id,
        passed,
        results.len(),
        at,
    ) {
        // Quality evidence is advisory telemetry. A corrupt or unavailable
        // cohort must never roll back a valid provider settlement.
        eprintln!("route-policy observation record failed: {error}");
    }
    append_single_worker_run_result(
        tx,
        store,
        scope,
        owner_member_id,
        internal_user_id,
        journal,
        binding,
        &lifecycle,
        worker,
        receipt,
        output_reference,
        &evaluation,
        usage,
        provider_id,
        requested_model,
        provider_route_id,
        expected_revision + 1,
        sequence,
        at,
        None,
        None,
    )?;
    Ok(())
}

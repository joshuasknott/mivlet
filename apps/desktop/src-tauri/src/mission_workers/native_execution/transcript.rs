#[derive(Debug)]
struct CitedMissionTranscript {
    thread_id: String,
    user_message_id: String,
    user_revision_id: String,
    assistant_message_id: String,
    assistant_revision_id: String,
    prompt: String,
    response: String,
    assistant_detail: Value,
}

fn cited_transcript_identity(run_id: &str, role: &str) -> (String, String, String) {
    let digest =
        Sha256::digest(format!("fable.cited-mission-transcript.v1\0{run_id}\0{role}").as_bytes());
    let suffix = format!("{digest:x}");
    (
        format!("mission-transcript-{role}-{suffix}"),
        format!("mission-transcript-revision-{role}-{suffix}"),
        format!("mission-transcript:v1:{role}:{suffix}"),
    )
}

fn cited_mission_transcript(
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    binding: &NativeWorkerExecutionBinding,
    receipt: &Value,
    result_event: &Value,
    accepted_artifact: Option<&crate::store::repos::artifact::AcceptedMissionArtifactBinding>,
) -> crate::store::Result<CitedMissionTranscript> {
    let mission_id = lifecycle
        .mission
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission identity is invalid.".into())
        })?;
    let thread_id = lifecycle
        .mission
        .pointer("/scope/sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited mission source conversation is unavailable.".into(),
            )
        })?;
    if journal.run.get("sourceThreadId").and_then(Value::as_str) != Some(thread_id) {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission run does not match its source conversation.".into(),
        ));
    }
    let prompt = lifecycle
        .current_revision
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission prompt is unavailable.".into())
        })?;
    let text = receipt
        .get("text")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission response is unavailable.".into())
        })?;
    let (response, assistant_detail) = if let Some(artifact) = accepted_artifact {
        let exact = result_event.get("id").and_then(Value::as_str)
            == Some(binding.result_event_id.as_str())
            && result_event.get("type").and_then(Value::as_str) == Some("run-completed")
            && result_event
                .pointer("/payload/result/outputs/0/artifactId")
                .and_then(Value::as_str)
                == Some(artifact.artifact_id.as_str())
            && result_event
                .pointer("/payload/result/outputs/0/artifactVersionId")
                .and_then(Value::as_str)
                == Some(artifact.artifact_version_id.as_str());
        if !exact {
            return Err(crate::store::StoreError::Invalid(
                "Accepted cited mission transcript does not match its terminal result.".into(),
            ));
        }
        (
            text.to_string(),
            json!({
                "type":"mission-result",
                "missionId":mission_id,
                "resultEventId":binding.result_event_id,
                "outcome":"accepted",
                "artifactId":artifact.artifact_id,
                "artifactVersionId":artifact.artifact_version_id
            }),
        )
    } else {
        let error_code = result_event
            .pointer("/payload/error/code")
            .and_then(Value::as_str);
        let partial_summary = result_event
            .pointer("/payload/partial/summary")
            .and_then(Value::as_str);
        let expected_summary = match error_code {
            Some("policy-acceptance-failed") => Some(CITED_PARTIAL_ACCEPTANCE_SUMMARY),
            Some("human-acceptance-denied") => Some(CITED_HUMAN_DENIAL_SUMMARY),
            _ => None,
        };
        let exact = result_event.get("id").and_then(Value::as_str)
            == Some(binding.result_event_id.as_str())
            && result_event.get("type").and_then(Value::as_str) == Some("run-failed")
            && expected_summary.is_some()
            && partial_summary == expected_summary;
        if !exact {
            return Err(crate::store::StoreError::Invalid(
                "Partial cited mission transcript does not match its terminal result.".into(),
            ));
        }
        (
            format!(
                "Draft preserved, but not accepted: {}\n\n{text}",
                expected_summary.unwrap_or(CITED_PARTIAL_ACCEPTANCE_SUMMARY)
            ),
            json!({
                "type":"mission-result",
                "missionId":mission_id,
                "resultEventId":binding.result_event_id,
                "outcome":"partial"
            }),
        )
    };
    let (user_message_id, user_revision_id, _) = cited_transcript_identity(&binding.run_id, "user");
    let (assistant_message_id, assistant_revision_id, _) =
        cited_transcript_identity(&binding.run_id, "assistant");
    Ok(CitedMissionTranscript {
        thread_id: thread_id.to_string(),
        user_message_id,
        user_revision_id,
        assistant_message_id,
        assistant_revision_id,
        prompt: prompt.to_string(),
        response,
        assistant_detail,
    })
}

#[allow(clippy::too_many_arguments)]
fn append_cited_mission_transcript(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    binding: &NativeWorkerExecutionBinding,
    receipt: &Value,
    result_event: &Value,
    accepted_artifact: Option<&crate::store::repos::artifact::AcceptedMissionArtifactBinding>,
    at: &str,
) -> crate::store::Result<()> {
    let transcript = cited_mission_transcript(
        journal,
        lifecycle,
        binding,
        receipt,
        result_event,
        accepted_artifact,
    )?;
    let head = thread::get(tx, store, scope, &transcript.thread_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "Cited mission source conversation is unavailable.".into(),
        )
    })?;
    let (_, _, user_idempotency) = cited_transcript_identity(&binding.run_id, "user");
    let user = message::append(
        tx,
        store,
        scope,
        &transcript.thread_id,
        &transcript.user_message_id,
        "user",
        &Value::Null,
        Some(&binding.run_id),
        head.last_sequence + 1,
        head.last_sequence,
        head.last_message_id.as_deref(),
        &user_idempotency,
        &transcript.user_revision_id,
        "terminal",
        "initial",
        &json!(transcript.prompt),
        at,
    )?;
    let (_, _, assistant_idempotency) = cited_transcript_identity(&binding.run_id, "assistant");
    let assistant = message::append(
        tx,
        store,
        scope,
        &transcript.thread_id,
        &transcript.assistant_message_id,
        "assistant",
        &transcript.assistant_detail,
        Some(&binding.run_id),
        head.last_sequence + 2,
        head.last_sequence + 1,
        Some(&transcript.user_message_id),
        &assistant_idempotency,
        &transcript.assistant_revision_id,
        "terminal",
        "initial",
        &json!(transcript.response),
        at,
    )?;
    let exact_user = user.kind == "user"
        && user.run_id.as_deref() == Some(binding.run_id.as_str())
        && user.sequence == head.last_sequence + 1
        && user.detail.is_null()
        && user.current_revision_id == transcript.user_revision_id
        && user.current_revision_number == 1
        && user.current_revision_state == "terminal"
        && user.content == json!(transcript.prompt)
        && user.created_at == at;
    let exact_assistant = assistant.kind == "assistant"
        && assistant.run_id.as_deref() == Some(binding.run_id.as_str())
        && assistant.sequence == head.last_sequence + 2
        && assistant.detail == transcript.assistant_detail
        && assistant.current_revision_id == transcript.assistant_revision_id
        && assistant.current_revision_number == 1
        && assistant.current_revision_state == "terminal"
        && assistant.content == json!(transcript.response)
        && assistant.created_at == at;
    if exact_user && exact_assistant {
        Ok(())
    } else {
        Err(crate::store::StoreError::Invalid(
            "Cited mission transcript identity is already in use.".into(),
        ))
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn append_cited_terminal_status_transcript(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    terminal_result: &Value,
    result_event: &Value,
    at: &str,
) -> crate::store::Result<()> {
    let run_id = journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission run identity is invalid.".into())
        })?;
    let mission_id = lifecycle
        .mission
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission identity is invalid.".into())
        })?;
    let thread_id = lifecycle
        .mission
        .pointer("/scope/sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited mission source conversation is unavailable.".into(),
            )
        })?;
    let prompt = lifecycle
        .current_revision
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission prompt is unavailable.".into())
        })?;
    let outcome = terminal_result
        .get("outcome")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "failed" | "cancelled"))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission terminal outcome is invalid.".into())
        })?;
    let summary = terminal_result
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission terminal summary is invalid.".into())
        })?;
    let result_event_id = result_event
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission result identity is invalid.".into())
        })?;
    let expected_event_type = if outcome == "failed" {
        "run-failed"
    } else {
        "run-cancelled"
    };
    let expected_status = if outcome == "failed" {
        "failed"
    } else {
        "cancelled"
    };
    let producing_runs = terminal_result
        .get("producingRunIds")
        .and_then(Value::as_array);
    let outputs = terminal_result.get("outputs").and_then(Value::as_array);
    let event_payload_valid = if outcome == "failed" {
        result_event.pointer("/payload/error").is_some()
    } else {
        result_event.pointer("/payload/cancellation").is_some()
    };
    let exact = journal.run.get("ownerMemberId").and_then(Value::as_str) == Some(owner_member_id)
        && journal.run.get("sourceThreadId").and_then(Value::as_str) == Some(thread_id)
        && journal.run.get("status").and_then(Value::as_str) == Some(expected_status)
        && journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            == Some(result_event_id)
        && result_event.get("runId").and_then(Value::as_str) == Some(run_id)
        && result_event.get("type").and_then(Value::as_str) == Some(expected_event_type)
        && producing_runs.is_some_and(|ids| ids.len() == 1 && ids[0].as_str() == Some(run_id))
        && outputs.is_some_and(Vec::is_empty)
        && terminal_result.get("completedAt").and_then(Value::as_str) == Some(at)
        && event_payload_valid;
    if !exact {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission terminal transcript does not match its durable result.".into(),
        ));
    }
    let response = if outcome == "failed" {
        format!("Mission failed: {summary}")
    } else {
        format!("Mission cancelled: {summary}")
    };
    let assistant_detail = json!({
        "type":"mission-result",
        "missionId":mission_id,
        "resultEventId":result_event_id,
        "outcome":outcome
    });
    let (user_message_id, user_revision_id, user_idempotency) =
        cited_transcript_identity(run_id, "user");
    let (assistant_message_id, assistant_revision_id, assistant_idempotency) =
        cited_transcript_identity(run_id, "assistant");
    let head = thread::get(tx, store, scope, thread_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "Cited mission source conversation is unavailable.".into(),
        )
    })?;
    let user = message::append(
        tx,
        store,
        scope,
        thread_id,
        &user_message_id,
        "user",
        &Value::Null,
        Some(run_id),
        head.last_sequence + 1,
        head.last_sequence,
        head.last_message_id.as_deref(),
        &user_idempotency,
        &user_revision_id,
        "terminal",
        "initial",
        &json!(prompt),
        at,
    )?;
    let assistant = message::append(
        tx,
        store,
        scope,
        thread_id,
        &assistant_message_id,
        "assistant",
        &assistant_detail,
        Some(run_id),
        head.last_sequence + 2,
        head.last_sequence + 1,
        Some(&user_message_id),
        &assistant_idempotency,
        &assistant_revision_id,
        "terminal",
        "initial",
        &json!(response),
        at,
    )?;
    let exact_user = user.kind == "user"
        && user.run_id.as_deref() == Some(run_id)
        && user.sequence == head.last_sequence + 1
        && user.detail.is_null()
        && user.current_revision_id == user_revision_id
        && user.current_revision_number == 1
        && user.current_revision_state == "terminal"
        && user.content == json!(prompt)
        && user.created_at == at;
    let exact_assistant = assistant.kind == "assistant"
        && assistant.run_id.as_deref() == Some(run_id)
        && assistant.sequence == head.last_sequence + 2
        && assistant.detail == assistant_detail
        && assistant.current_revision_id == assistant_revision_id
        && assistant.current_revision_number == 1
        && assistant.current_revision_state == "terminal"
        && assistant.content == json!(response)
        && assistant.created_at == at;
    if exact_user && exact_assistant {
        Ok(())
    } else {
        Err(crate::store::StoreError::Invalid(
            "Cited mission transcript identity is already in use.".into(),
        ))
    }
}

pub(crate) fn validate_cited_terminal_status_transcript_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
) -> crate::store::Result<()> {
    let run_id = journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission run identity is invalid.".into())
        })?;
    let mission_id = lifecycle
        .mission
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission identity is invalid.".into())
        })?;
    let thread_id = lifecycle
        .mission
        .pointer("/scope/sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited mission source conversation is unavailable.".into(),
            )
        })?;
    let prompt = lifecycle
        .current_revision
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission prompt is unavailable.".into())
        })?;
    let terminal_result = lifecycle.mission.get("terminalResult").ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission terminal result is missing.".into())
    })?;
    let outcome = terminal_result
        .get("outcome")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "failed" | "cancelled"))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission terminal outcome is invalid.".into())
        })?;
    let summary = terminal_result
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission terminal summary is invalid.".into())
        })?;
    let completed_at = terminal_result
        .get("completedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission completion time is invalid.".into())
        })?;
    let result_event_id = journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission result identity is invalid.".into())
        })?;
    let result_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission terminal event is missing.".into())
        })?;
    let expected_event_type = if outcome == "failed" {
        "run-failed"
    } else {
        "run-cancelled"
    };
    let response = if outcome == "failed" {
        format!("Mission failed: {summary}")
    } else {
        format!("Mission cancelled: {summary}")
    };
    let detail = json!({
        "type":"mission-result",
        "missionId":mission_id,
        "resultEventId":result_event_id,
        "outcome":outcome
    });
    let durable_facts_match = journal.run.get("ownerMemberId").and_then(Value::as_str)
        == Some(owner_member_id)
        && journal.run.get("sourceThreadId").and_then(Value::as_str) == Some(thread_id)
        && journal.run.get("status").and_then(Value::as_str) == Some(outcome)
        && result_event.get("runId").and_then(Value::as_str) == Some(run_id)
        && result_event.get("type").and_then(Value::as_str) == Some(expected_event_type)
        && result_event.get("occurredAt").and_then(Value::as_str) == Some(completed_at)
        && terminal_result
            .get("producingRunIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.len() == 1 && ids[0].as_str() == Some(run_id))
        && terminal_result
            .get("outputs")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
    if !durable_facts_match {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission terminal transcript does not match its durable result.".into(),
        ));
    }
    let (user_message_id, user_revision_id, _) = cited_transcript_identity(run_id, "user");
    let (assistant_message_id, assistant_revision_id, _) =
        cited_transcript_identity(run_id, "assistant");
    let messages = message::list(tx, store, scope, thread_id)?;
    let user = messages
        .iter()
        .find(|message| message.id == user_message_id);
    let assistant = messages
        .iter()
        .find(|message| message.id == assistant_message_id);
    let exact_user = user.is_some_and(|message| {
        message.kind == "user"
            && message.run_id.as_deref() == Some(run_id)
            && message.detail.is_null()
            && message.current_revision_id == user_revision_id
            && message.current_revision_number == 1
            && message.current_revision_state == "terminal"
            && message.content == json!(prompt)
            && message.created_at == completed_at
    });
    let exact_assistant = assistant.is_some_and(|message| {
        message.kind == "assistant"
            && message.run_id.as_deref() == Some(run_id)
            && message.detail == detail
            && message.current_revision_id == assistant_revision_id
            && message.current_revision_number == 1
            && message.current_revision_state == "terminal"
            && message.content == json!(response)
            && message.created_at == completed_at
            && user.is_some_and(|user| message.sequence == user.sequence + 1)
    });
    if exact_user && exact_assistant {
        Ok(())
    } else {
        Err(crate::store::StoreError::Invalid(
            "Cited mission terminal transcript replay does not match its durable result.".into(),
        ))
    }
}

#[allow(clippy::too_many_arguments)]
fn append_single_worker_run_result(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    worker: &Value,
    receipt: &Value,
    output_reference: &str,
    evaluation: &Value,
    usage: Option<(i64, i64)>,
    provider_id: &str,
    requested_model: &str,
    provider_route_id: &str,
    expected_revision: i64,
    expected_sequence: i64,
    at: &str,
    human_decision: Option<bool>,
    result_previous_event_id: Option<&str>,
) -> crate::store::Result<()> {
    let Some((input_tokens, output_tokens)) = usage else {
        return Ok(());
    };
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission plan steps are invalid.".into())
        })?;
    let created_workers = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
        .count();
    let deliverables = lifecycle
        .mission
        .pointer("/outcome/deliverables")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission deliverables are invalid.".into())
        })?;
    let mission_criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission acceptance criteria are invalid.".into())
        })?;
    let evaluation_results = evaluation
        .get("criteria")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let evaluated_keys = evaluation_results
        .iter()
        .filter_map(|result| result.get("criterionKey").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    let output_key = receipt
        .get("outputKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let human_acceptance = lifecycle
        .mission
        .pointer("/acceptance/requiresHumanAcceptance")
        .and_then(Value::as_bool);
    let eligible = steps.len() == 1
        && created_workers == 1
        && worker.get("id").and_then(Value::as_str) == Some(binding.worker_id.as_str())
        && deliverables.len() == 1
        && deliverables[0].get("key").and_then(Value::as_str) == Some(output_key)
        && deliverables[0].get("required").and_then(Value::as_bool) == Some(true)
        && human_acceptance.is_some()
        && mission_criteria.iter().all(|criterion| {
            criterion.get("evaluator").and_then(Value::as_str) == Some("policy")
                && criterion
                    .get("key")
                    .and_then(Value::as_str)
                    .is_some_and(|key| evaluated_keys.contains(key))
        });
    if !eligible {
        return Ok(());
    }
    let acceptance = mission_criteria
        .iter()
        .filter_map(|criterion| criterion.get("key").and_then(Value::as_str))
        .filter_map(|key| {
            evaluation_results
                .iter()
                .find(|result| {
                    result.get("criterionKey").and_then(Value::as_str) == Some(key)
                })
                .map(|result| {
                    json!({
                        "criterionKey":key,
                        "status":if result.get("passed").and_then(Value::as_bool) == Some(true){"met"}else{"not-met"},
                        "evidenceRefs":result.get("evidenceRefs").and_then(Value::as_array).cloned().unwrap_or_default(),
                        "summary":result.get("summary")
                    })
                })
        })
        .collect::<Vec<_>>();
    let costs = exact_model_costs(provider_id, requested_model, input_tokens, output_tokens);
    let usage_value = json!({"usageKey":format!("native-usage:{}",binding.usage_event_id),"runId":binding.run_id,
        "workerId":binding.worker_id,"providerRouteId":provider_route_id,"modelReference":requested_model,"inputTokens":input_tokens,"outputTokens":output_tokens,
        "toolCalls":1,"costs":costs,"measuredAt":at});
    let policy_passed = evaluation.get("verdict").and_then(Value::as_str) == Some("pass");
    if policy_passed && human_acceptance == Some(true) && human_decision.is_none() {
        append_cited_acceptance_wait(
            tx,
            store,
            scope,
            owner_member_id,
            internal_user_id,
            journal,
            lifecycle,
            binding,
            receipt,
            output_reference,
            expected_revision,
            expected_sequence,
            at,
        )?;
        return Ok(());
    }
    let passed = policy_passed && human_decision != Some(false);
    let artifact_binding = passed.then(|| {
        crate::store::repos::artifact::accepted_mission_output_binding(
            scope.workspace_id(),
            owner_member_id,
            &binding.run_id,
            &binding.worker_id,
            &binding.completion_event_id,
            output_key,
            receipt
                .get("contentHash")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
    });
    let mut output = json!({"key":output_key,"summary":"Native worker text output","valueReference":output_reference});
    if let Some(artifact) = artifact_binding.as_ref() {
        let object = output.as_object_mut().ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission output is invalid.".into())
        })?;
        object.insert("artifactId".into(), json!(artifact.artifact_id));
        object.insert(
            "artifactVersionId".into(),
            json!(artifact.artifact_version_id),
        );
    }
    let mut failed_criteria = mission_criteria
        .iter()
        .filter(|criterion| {
            let key = criterion.get("key").and_then(Value::as_str);
            acceptance.iter().any(|result| {
                result.get("criterionKey").and_then(Value::as_str) == key
                    && result.get("status").and_then(Value::as_str) != Some("met")
            })
        })
        .map(|criterion| {
            format!(
                "Meet acceptance criterion: {}",
                criterion
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| {
                        criterion
                            .get("key")
                            .and_then(Value::as_str)
                            .unwrap_or("required policy")
                    })
            )
        })
        .collect::<Vec<_>>();
    if policy_passed && human_decision == Some(false) {
        failed_criteria =
            vec!["Approve the preserved cited draft before creating an accepted artifact.".into()];
    }
    let partial_summary = if policy_passed && human_decision == Some(false) {
        CITED_HUMAN_DENIAL_SUMMARY
    } else {
        CITED_PARTIAL_ACCEPTANCE_SUMMARY
    };
    let partial = (!passed).then(|| {
        json!({
            "summary":partial_summary,
            "completedOutputs":[output.clone()],
            "remainingWork":failed_criteria,
            "acceptance":acceptance.clone(),
            "recoverable":true,
            "recommendedNextAction":"stop"
        })
    });
    let accepted_summary = if human_decision == Some(true) {
        "The cited brief passed policy and was accepted by its owner."
    } else {
        "The cited brief and its required policy acceptance are complete."
    };
    let result = passed.then(|| json!({"outcome":"succeeded","summary":accepted_summary,
        "outputs":[output.clone()],"acceptance":acceptance.clone(),"evaluations":[evaluation],"usage":[usage_value],"completedAt":at}));
    let mission_result = if let Some(result) = result.as_ref() {
        json!({"outcome":"succeeded","summary":result.get("summary"),"producingRunIds":[binding.run_id],
            "outputs":result.get("outputs"),"acceptance":result.get("acceptance"),"completedAt":at})
    } else {
        json!({"outcome":"partial","summary":partial_summary,"producingRunIds":[binding.run_id],
            "outputs":[output],"acceptance":acceptance,"partial":partial,"completedAt":at})
    };
    let idempotency_key = format!(
        "run-result:{}",
        bounded(&binding.idempotency_key, "Run result idempotency key", 200)
            .map_err(crate::store::StoreError::Invalid)?
    );
    let sequence = expected_sequence + 1;
    let denied = policy_passed && human_decision == Some(false);
    let error = json!({"code":if denied{"human-acceptance-denied"}else{"policy-acceptance-failed"},"category":"validation",
        "message":if denied{"The owner kept the cited output as a draft."}else{"The cited output did not satisfy its required evidence policy."},"retryable":false,
        "causedByEventId":binding.evaluation_event_id});
    let (event_type, payload, next_status) = if let Some(result) = result.as_ref() {
        ("run-completed", json!({"result":result}), "completed")
    } else {
        (
            "run-failed",
            json!({"error":error,"partial":partial}),
            "partially-completed",
        )
    };
    let event = json!({"workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,"createdAt":at,"updatedAt":at,
        "id":binding.result_event_id,"runId":binding.run_id,"type":event_type,"sequence":sequence,
        "previousEventId":result_previous_event_id.unwrap_or(binding.evaluation_event_id.as_str()),"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":idempotency_key,"payload":payload});
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("status".into(), json!(next_status));
    if let Some(result) = result {
        projected.insert("terminalResult".into(), result);
    }
    projected.insert("revision".into(), json!(expected_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":binding.result_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        expected_revision,
        expected_sequence,
        &binding.result_event_id,
        event_type,
        &idempotency_key,
        &event,
        &Value::Object(projected),
        at,
    )?;
    if let Some(artifact) = artifact_binding.as_ref() {
        let private = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
            scope.clone(),
            internal_user_id,
            Some(owner_member_id),
        )?;
        crate::store::repos::artifact::create_accepted_mission_output(
            tx,
            store,
            &private,
            owner_member_id,
            &binding.run_id,
            &binding.worker_id,
            &binding.completion_event_id,
            &binding.evaluation_event_id,
            &binding.result_event_id,
            output_key,
            output_reference,
            artifact,
        )?;
    }
    append_cited_mission_transcript(
        tx,
        store,
        scope,
        journal,
        lifecycle,
        binding,
        receipt,
        &event,
        artifact_binding.as_ref(),
        at,
    )?;
    if passed {
        mission_plan::mark_completed(
            tx,
            store,
            scope,
            owner_member_id,
            lifecycle,
            &mission_result,
            at,
        )?;
    } else {
        mission_plan::mark_partially_completed(
            tx,
            store,
            scope,
            owner_member_id,
            lifecycle,
            &mission_result,
            at,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_cited_acceptance_wait(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    binding: &NativeWorkerExecutionBinding,
    receipt: &Value,
    output_reference: &str,
    expected_revision: i64,
    expected_sequence: i64,
    at: &str,
) -> crate::store::Result<()> {
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
    let content_hash = receipt
        .get("contentHash")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited draft content binding is invalid.".into())
        })?;
    if receipt.get("valueReference").and_then(Value::as_str) != Some(output_reference)
        || receipt.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || receipt.get("workerId").and_then(Value::as_str) != Some(binding.worker_id.as_str())
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited draft does not match its approval proposal.".into(),
        ));
    }
    let proposal_material = format!(
        "fable.cited-artifact-approval.v1\0{workspace_id}\0{owner_member_id}\0{plan_revision_id}\0{}\0{}\0{output_reference}\0{content_hash}",
        binding.run_id, binding.worker_id
    );
    let suffix = format!("{:x}", Sha256::digest(proposal_material.as_bytes()));
    let proposal_hash = format!("sha256:{suffix}");
    let wait_key = format!("cited-artifact-wait:v1:{suffix}");
    let approval_request_ref = format!("cited-artifact-proposal:v1:{suffix}");
    let checkpoint_event_id = format!("mission-wait-checkpoint-{suffix}");
    let approval_event_id = format!("mission-approval-requested-{suffix}");
    let checkpoint_reference = format!("checkpoint:{checkpoint_event_id}");
    let attempt_number = journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let checkpoint_state = json!({
        "activeWorkerIds":[],
        "activePlanStepKeys":[],
        "pendingWaitKeys":[wait_key],
        "approvalProposal":{
            "approvalRequestRef":approval_request_ref,
            "proposalHash":proposal_hash,
            "planRevisionId":plan_revision_id,
            "workerId":binding.worker_id,
            "workerStartedEventId":binding.worker_started_event_id,
            "routeSelectedEventId":binding.route_selected_event_id,
            "usageEventId":binding.usage_event_id,
            "completionBaseEventId":native_completion_base_event(binding),
            "completionEventId":binding.completion_event_id,
            "evaluationEventId":binding.evaluation_event_id,
            "outputReference":output_reference,
            "contentHash":content_hash
        }
    });
    let checkpoint_bytes = serde_json::to_vec(&checkpoint_state).map_err(|_| {
        crate::store::StoreError::Invalid("Cited approval checkpoint could not be encoded.".into())
    })?;
    let state_hash = format!("{:x}", Sha256::digest(&checkpoint_bytes));
    let checkpoint_sequence = expected_sequence + 1;
    let checkpoint = json!({
        "kind":"wait-boundary","attemptNumber":attempt_number,"createdAt":at,
        "replayBoundary":{
            "durableThroughSequence":expected_sequence,
            "resumeAfterEventId":binding.evaluation_event_id,
            "completedPlanStepKeys":["research"],
            "completedWorkerIds":[binding.worker_id],
            "committedEffectKeys":[]
        },
        "stateStorage":"portable-redacted","stateReference":checkpoint_reference,
        "stateHash":state_hash,"executionNodeId":"local-desktop","pendingWaitKey":wait_key
    });
    let checkpoint_event = json!({
        "workspaceId":workspace_id,"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,
        "createdAt":at,"updatedAt":at,"id":checkpoint_event_id,"runId":binding.run_id,
        "type":"checkpoint-created","sequence":checkpoint_sequence,"previousEventId":binding.evaluation_event_id,
        "attemptNumber":attempt_number,"occurredAt":at,"actor":{"kind":"system"},
        "idempotencyKey":format!("cited-acceptance-checkpoint:v1:{suffix}"),
        "payload":{"checkpoint":checkpoint}
    });
    let mut checkpoint_projection = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    checkpoint_projection.insert("revision".into(), json!(expected_revision + 1));
    checkpoint_projection.insert("updatedAt".into(), json!(at));
    checkpoint_projection.insert(
        "eventHead".into(),
        json!({"lastSequence":checkpoint_sequence,"lastEventId":checkpoint_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        expected_revision,
        expected_sequence,
        &checkpoint_event_id,
        "checkpoint-created",
        &format!("cited-acceptance-checkpoint:v1:{suffix}"),
        &checkpoint_event,
        &Value::Object(checkpoint_projection),
        at,
    )?;
    mission_checkpoint::put(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        &checkpoint_event_id,
        attempt_number,
        &checkpoint_reference,
        &state_hash,
        &checkpoint_state,
        at,
    )?;

    let approval_sequence = checkpoint_sequence + 1;
    let wait = json!({
        "waitKey":wait_key,"status":"pending","approvalRequestRef":approval_request_ref,
        "proposalHash":proposal_hash,
        "actionSummary":"Save this policy-passed cited brief as an accepted artifact.",
        "requestedAt":at,"workerId":binding.worker_id,
        "sideEffect":{
            "effectKey":format!("cited-artifact-create:v1:{suffix}"),
            "idempotencyKey":format!("cited-artifact-create:v1:{suffix}"),
            "replayPolicy":"deduplicate","proposalHash":proposal_hash,
            "targetSummary":"One private accepted cited-brief artifact"
        }
    });
    let approval_event = json!({
        "workspaceId":workspace_id,"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,
        "createdAt":at,"updatedAt":at,"id":approval_event_id,"runId":binding.run_id,
        "type":"approval-requested","sequence":approval_sequence,"previousEventId":checkpoint_event_id,
        "attemptNumber":attempt_number,"occurredAt":at,"actor":{"kind":"system"},
        "idempotencyKey":format!("cited-acceptance-request:v1:{suffix}"),"payload":{"wait":wait}
    });
    let mut approval_projection = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    approval_projection.insert("status".into(), json!("waiting-approval"));
    approval_projection.insert("revision".into(), json!(expected_revision + 2));
    approval_projection.insert("updatedAt".into(), json!(at));
    approval_projection.insert(
        "eventHead".into(),
        json!({"lastSequence":approval_sequence,"lastEventId":approval_event_id}),
    );
    mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        expected_revision + 1,
        checkpoint_sequence,
        &approval_event_id,
        "approval-requested",
        &format!("cited-acceptance-request:v1:{suffix}"),
        &approval_event,
        &Value::Object(approval_projection),
        at,
    )?;
    mission_plan::mark_waiting(tx, store, scope, owner_member_id, lifecycle, at)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_single_worker_run_failure(
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
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission plan steps are invalid.".into())
        })?;
    let created_workers = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
        .count();
    if steps.len() != 1
        || created_workers != 1
        || steps[0].get("key").and_then(Value::as_str) != Some(step_key)
    {
        return Ok(());
    }
    let criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission acceptance criteria are invalid.".into())
        })?;
    let acceptance = criteria
        .iter()
        .filter_map(|criterion| criterion.get("key").and_then(Value::as_str))
        .map(|key| {
            json!({"criterionKey":key,"status":"not-evaluated","evidenceRefs":[],
            "summary":"The mission stopped before this criterion could be accepted."})
        })
        .collect::<Vec<_>>();
    let mission_result = json!({"outcome":"failed","summary":"The mission stopped because its only worker failed.",
        "producingRunIds":[binding.run_id],"outputs":[],"acceptance":acceptance,"completedAt":at});
    let idempotency_key = format!(
        "run-result:{}",
        bounded(&binding.idempotency_key, "Run result idempotency key", 200)
            .map_err(crate::store::StoreError::Invalid)?
    );
    let sequence = expected_sequence + 1;
    let event = json!({"workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,"createdAt":at,"updatedAt":at,
        "id":binding.result_event_id,"runId":binding.run_id,"type":"run-failed","sequence":sequence,
        "previousEventId":previous_event_id,"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":idempotency_key,"payload":{"error":error}});
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("status".into(), json!("failed"));
    projected.insert("revision".into(), json!(expected_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":binding.result_event_id}),
    );
    let settled = mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        expected_revision,
        expected_sequence,
        &binding.result_event_id,
        "run-failed",
        &idempotency_key,
        &event,
        &Value::Object(projected),
        at,
    )?;
    mission_plan::mark_failed(
        tx,
        store,
        scope,
        owner_member_id,
        &lifecycle,
        &mission_result,
        at,
    )?;
    if is_cited_terminal_status_shape(journal, &lifecycle) {
        append_cited_terminal_status_transcript(
            tx,
            store,
            scope,
            owner_member_id,
            &settled,
            &lifecycle,
            &mission_result,
            &event,
            at,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_native_run_cancellation(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
    parallel_evidence_free: bool,
) -> crate::store::Result<()> {
    let key =
        native_terminal_event_keys(binding).map_err(crate::store::StoreError::Invalid)?[2].clone();
    if let Some(existing) = journal
        .events
        .iter()
        .find(|event| event.get("idempotencyKey").and_then(Value::as_str) == Some(key.as_str()))
    {
        exact_native_terminal_replay_with_mode(
            journal,
            existing,
            binding,
            None,
            parallel_evidence_free,
        )
        .map_err(crate::store::StoreError::Invalid)?;
        let mission_id = journal
            .run
            .get("missionId")
            .or_else(|| journal.run.pointer("/initiator/missionId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run has no selected mission.".into())
            })?;
        let lifecycle = mission_plan::get(tx, store, scope, owner_member_id, mission_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission plan is unavailable.".into())
            })?;
        if is_cited_terminal_status_shape(journal, &lifecycle) {
            validate_cited_terminal_status_transcript_replay(
                tx,
                store,
                scope,
                owner_member_id,
                journal,
                &lifecycle,
            )?;
        }
        if parallel_evidence_free {
            crate::mission_parallel_approaches::append_cancelled_transcript(tx, store, journal)?;
        }
        return Ok(());
    }
    let cancellation_event = if parallel_evidence_free {
        validate_parallel_native_cancellation_head(journal, binding)
    } else {
        validate_native_cancellation_head(journal, binding)
    }
    .map_err(crate::store::StoreError::Invalid)?;
    let cancellation = cancellation_event
        .pointer("/payload/cancellation")
        .cloned()
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission cancellation fact is invalid.".into())
        })?;
    let at = now();
    let current_revision = journal
        .run
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission cancellation revision is invalid.".into())
        })?;
    let current_sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission cancellation event head is invalid.".into())
        })?;
    let sequence = current_sequence + 1;
    let event = json!({
        "workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":owner_member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,"createdAt":at,"updatedAt":at,
        "id":binding.result_event_id,"runId":binding.run_id,"type":"run-cancelled","sequence":sequence,
        "previousEventId":cancellation_event.get("id"),"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},
        "correlationKey":format!("native-worker-completion:v1:run-revision:{}",binding.expected_run_revision),
        "idempotencyKey":key,"payload":{"cancellation":cancellation}
    });
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("status".into(), json!("cancelled"));
    projected.insert("revision".into(), json!(current_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":binding.result_event_id}),
    );
    let settled = mission_run::append(
        tx,
        store,
        scope,
        owner_member_id,
        &binding.run_id,
        current_revision,
        current_sequence,
        &binding.result_event_id,
        "run-cancelled",
        &key,
        &event,
        &Value::Object(projected),
        &at,
    )?;

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
    let acceptance = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|criterion| criterion.get("key").and_then(Value::as_str))
        .map(|criterion_key| {
            json!({
                "criterionKey":criterion_key,"status":"not-evaluated","evidenceRefs":[],
                "summary":"The mission was cancelled before this criterion could be accepted."
            })
        })
        .collect::<Vec<_>>();
    let mission_result = json!({
        "outcome":"cancelled","summary":"The mission stopped after its cancellation request was observed.",
        "producingRunIds":[binding.run_id],"outputs":[],"acceptance":acceptance,"completedAt":at
    });
    mission_plan::mark_cancelled(
        tx,
        store,
        scope,
        owner_member_id,
        &lifecycle,
        &mission_result,
        &at,
    )?;
    if is_cited_terminal_status_shape(journal, &lifecycle) {
        append_cited_terminal_status_transcript(
            tx,
            store,
            scope,
            owner_member_id,
            &settled,
            &lifecycle,
            &mission_result,
            &event,
            &at,
        )?;
    }
    if parallel_evidence_free {
        crate::mission_parallel_approaches::append_cancelled_transcript(tx, store, &settled)?;
    }
    Ok(())
}

fn is_cited_terminal_status_shape(
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
) -> bool {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array);
    let criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array);
    let workers = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
        .collect::<Vec<_>>();
    lifecycle
        .mission
        .pointer("/scope/sourceThreadId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        && lifecycle
            .current_revision
            .get("summary")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        && lifecycle
            .mission
            .pointer("/acceptance/requiresHumanAcceptance")
            .and_then(Value::as_bool)
            .is_some()
        && steps.is_some_and(|steps| {
            steps.len() == 1
                && steps[0]
                    .get("requiredCapabilities")
                    .and_then(Value::as_array)
                    .is_some_and(|capabilities| {
                        capabilities.len() == 1 && capabilities[0] == "knowledge.content.search"
                    })
                && steps[0]
                    .get("expectedOutputs")
                    .and_then(Value::as_array)
                    .is_some_and(|outputs| {
                        outputs.len() == 1
                            && outputs[0].get("format").and_then(Value::as_str)
                                == Some("text/markdown")
                    })
                && workers.len() == 1
                && workers[0]
                    .pointer("/payload/worker/planStepKey")
                    .and_then(Value::as_str)
                    == steps[0].get("key").and_then(Value::as_str)
        })
        && criteria.is_some_and(|criteria| {
            !criteria.is_empty()
                && criteria.iter().all(|criterion| {
                    criterion.get("evaluator").and_then(Value::as_str) == Some("policy")
                })
        })
}

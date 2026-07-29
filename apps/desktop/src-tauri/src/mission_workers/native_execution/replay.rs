fn validate_native_cancellation_head<'a>(
    journal: &'a mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
) -> Result<&'a Value, String> {
    let event = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str)
                == journal
                    .run
                    .pointer("/eventHead/lastEventId")
                    .and_then(Value::as_str)
        })
        .ok_or_else(|| "Mission cancellation event is unavailable.".to_string())?;
    let cancellation = event.pointer("/payload/cancellation");
    let request_key = cancellation
        .and_then(|value| value.get("requestKey"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission cancellation request key is invalid.".to_string())?;
    if journal.run.get("status").and_then(Value::as_str) != Some("cancelling")
        || journal.run.get("revision").and_then(Value::as_i64)
            != Some(binding.expected_run_revision + 1)
        || journal
            .run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(binding.expected_last_sequence + 1)
        || event.get("type").and_then(Value::as_str) != Some("cancellation-requested")
        || event.get("sequence").and_then(Value::as_i64) != Some(binding.expected_last_sequence + 1)
        || event.get("previousEventId").and_then(Value::as_str)
            != Some(native_completion_base_event(binding))
        || event.get("idempotencyKey").and_then(Value::as_str)
            != Some(format!("cancel:{request_key}").as_str())
        || cancellation != journal.run.get("cancellation")
        || cancellation
            .and_then(|value| value.get("scope"))
            .and_then(Value::as_str)
            != Some("run")
    {
        return Err("Mission cancellation does not match the executing worker.".into());
    }
    Ok(event)
}

fn validate_parallel_native_cancellation_head<'a>(
    journal: &'a mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
) -> Result<&'a Value, String> {
    let parallel_base = parallel_completion_base_event(journal, binding)?;
    let event = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str)
                == journal
                    .run
                    .pointer("/eventHead/lastEventId")
                    .and_then(Value::as_str)
        })
        .ok_or_else(|| "Parallel mission cancellation event is unavailable.".to_string())?;
    let sequence = event
        .get("sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Parallel mission cancellation sequence is invalid.".to_string())?;
    let cancellation = event.pointer("/payload/cancellation");
    let request_key = cancellation
        .and_then(|value| value.get("requestKey"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Parallel mission cancellation request key is invalid.".to_string())?;
    let previous = if sequence == binding.expected_last_sequence + 1 {
        parallel_base
    } else {
        journal
            .events
            .iter()
            .find(|candidate| {
                candidate.get("sequence").and_then(Value::as_i64) == Some(sequence - 1)
            })
            .and_then(|candidate| candidate.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "Parallel mission cancellation predecessor is unavailable.".to_string()
            })?
    };
    if journal.run.get("status").and_then(Value::as_str) != Some("cancelling")
        || event.get("type").and_then(Value::as_str) != Some("cancellation-requested")
        || event.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || event.get("previousEventId").and_then(Value::as_str) != Some(previous)
        || event.get("idempotencyKey").and_then(Value::as_str)
            != Some(format!("cancel:{request_key}").as_str())
        || cancellation != journal.run.get("cancellation")
        || cancellation
            .and_then(|value| value.get("scope"))
            .and_then(Value::as_str)
            != Some("run")
    {
        return Err("Parallel mission cancellation does not match the executing worker.".into());
    }
    validate_parallel_sibling_advancement(
        journal,
        binding,
        binding.expected_last_sequence + 1,
        sequence - 1,
        parallel_base,
    )?;
    Ok(event)
}

fn exact_native_terminal_replay_with_journal(
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
) -> Result<(), String> {
    let expected_correlation = format!(
        "native-worker-completion:v1:run-revision:{}",
        binding.expected_run_revision
    );
    let event_type = event.get("type").and_then(Value::as_str);
    if event_type == Some("run-cancelled") {
        let cancellation_event = journal
            .events
            .iter()
            .find(|candidate| {
                candidate.get("id").and_then(Value::as_str)
                    == event.get("previousEventId").and_then(Value::as_str)
            })
            .ok_or_else(|| "Mission cancellation replay fact is missing.".to_string())?;
        let cancellation = cancellation_event.pointer("/payload/cancellation");
        let request_key = cancellation
            .and_then(|value| value.get("requestKey"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission cancellation replay request is invalid.".to_string())?;
        let valid = event.get("id").and_then(Value::as_str)
            == Some(binding.result_event_id.as_str())
            && event.get("runId").and_then(Value::as_str) == Some(binding.run_id.as_str())
            && event.get("idempotencyKey").and_then(Value::as_str)
                == Some(format!("worker-cancel:{}", binding.idempotency_key).as_str())
            && event.get("sequence").and_then(Value::as_i64)
                == Some(binding.expected_last_sequence + 2)
            && event.get("correlationKey").and_then(Value::as_str)
                == Some(expected_correlation.as_str())
            && event.pointer("/payload/cancellation") == cancellation
            && cancellation_event.get("type").and_then(Value::as_str)
                == Some("cancellation-requested")
            && cancellation_event.get("sequence").and_then(Value::as_i64)
                == Some(binding.expected_last_sequence + 1)
            && cancellation_event
                .get("previousEventId")
                .and_then(Value::as_str)
                == Some(native_completion_base_event(binding))
            && cancellation_event
                .get("idempotencyKey")
                .and_then(Value::as_str)
                == Some(format!("cancel:{request_key}").as_str())
            && journal.run.get("status").and_then(Value::as_str) == Some("cancelled")
            && journal.run.get("cancellation") == cancellation
            && journal
                .run
                .pointer("/eventHead/lastEventId")
                .and_then(Value::as_str)
                == Some(binding.result_event_id.as_str());
        return valid
            .then_some(())
            .ok_or_else(|| "Mission cancellation replay fact is invalid.".to_string());
    }
    let (expected_event_id, expected_key, expected_previous, expected_sequence, payload_valid) =
        match event_type {
            Some("worker-completed") => {
                let previous = event.get("previousEventId").and_then(Value::as_str);
                let (expected_previous, expected_sequence) =
                    if previous == Some(binding.usage_event_id.as_str()) {
                        (
                            binding.usage_event_id.as_str(),
                            binding.expected_last_sequence + 2,
                        )
                    } else {
                        (
                            native_completion_base_event(binding),
                            binding.expected_last_sequence + 1,
                        )
                    };
                (
                    binding.completion_event_id.as_str(),
                    format!("worker-complete:{}", binding.idempotency_key),
                    expected_previous,
                    expected_sequence,
                    event
                        .pointer("/payload/outputs")
                        .and_then(Value::as_array)
                        .is_some_and(|outputs| match output {
                            None => outputs.is_empty(),
                            Some(spec) => {
                                outputs.len() == 1
                                    && outputs[0].get("key").and_then(Value::as_str)
                                        == Some(spec.key.as_str())
                                    && outputs[0].get("summary").and_then(Value::as_str)
                                        == Some("Native worker text output")
                                    && outputs[0]
                                        .get("valueReference")
                                        .and_then(Value::as_str)
                                        .is_some_and(|reference| {
                                            reference.starts_with("mission-output:v1:")
                                        })
                            }
                        }),
                )
            }
            Some("worker-failed") => {
                let previous = event.get("previousEventId").and_then(Value::as_str);
                let (expected_previous, expected_sequence) =
                    if previous == Some(binding.usage_event_id.as_str()) {
                        (
                            binding.usage_event_id.as_str(),
                            binding.expected_last_sequence + 2,
                        )
                    } else {
                        (
                            native_completion_base_event(binding),
                            binding.expected_last_sequence + 1,
                        )
                    };
                (
                    binding.failure_event_id.as_str(),
                    format!("worker-fail:{}", binding.idempotency_key),
                    expected_previous,
                    expected_sequence,
                    native_failure_payload_valid(event),
                )
            }
            _ => return Err("Worker terminal idempotency key represents another result.".into()),
        };
    if event.get("id").and_then(Value::as_str) == Some(expected_event_id)
        && event.get("runId").and_then(Value::as_str) == Some(binding.run_id.as_str())
        && event.get("idempotencyKey").and_then(Value::as_str) == Some(expected_key.as_str())
        && event.get("previousEventId").and_then(Value::as_str) == Some(expected_previous)
        && event.pointer("/payload/workerId").and_then(Value::as_str)
            == Some(binding.worker_id.as_str())
        && payload_valid
        && event.get("sequence").and_then(Value::as_i64) == Some(expected_sequence)
        && event.get("correlationKey").and_then(Value::as_str)
            == Some(expected_correlation.as_str())
    {
        Ok(())
    } else {
        Err("Worker terminal idempotency key represents another result.".into())
    }
}

#[cfg(test)]
fn exact_native_cancellation_replay(
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    binding: &NativeWorkerExecutionBinding,
) -> Result<(), String> {
    exact_native_terminal_replay_with_journal(journal, event, binding, None)
}

fn exact_parallel_native_terminal_replay(
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
) -> Result<(), String> {
    let event_type = event.get("type").and_then(Value::as_str);
    let (expected_id, expected_key, payload_valid) = match event_type {
        Some("worker-completed") => (
            binding.completion_event_id.as_str(),
            format!("worker-complete:{}", binding.idempotency_key),
            event
                .pointer("/payload/outputs")
                .and_then(Value::as_array)
                .is_some_and(|outputs| match output {
                    None => outputs.is_empty(),
                    Some(spec) => {
                        outputs.len() == 1
                            && outputs[0].get("key").and_then(Value::as_str)
                                == Some(spec.key.as_str())
                            && outputs[0].get("summary").and_then(Value::as_str)
                                == Some("Native worker text output")
                            && outputs[0]
                                .get("valueReference")
                                .and_then(Value::as_str)
                                .is_some_and(|reference| {
                                    reference.starts_with("mission-output:v1:")
                                })
                    }
                }),
        ),
        Some("worker-failed") => (
            binding.failure_event_id.as_str(),
            format!("worker-fail:{}", binding.idempotency_key),
            native_failure_payload_valid(event),
        ),
        _ => return Err("Worker terminal idempotency key represents another result.".into()),
    };
    let terminal_sequence = event
        .get("sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Parallel worker terminal sequence is invalid.".to_string())?;
    let usage = journal
        .events
        .iter()
        .find(|candidate| {
            candidate.get("id").and_then(Value::as_str) == Some(binding.usage_event_id.as_str())
        })
        .ok_or_else(|| "Parallel worker terminal usage event is missing.".to_string())?;
    let usage_sequence = usage
        .get("sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Parallel worker usage sequence is invalid.".to_string())?;
    let expected_correlation = format!(
        "native-worker-completion:v1:run-revision:{}",
        binding.expected_run_revision
    );
    let parallel_base = parallel_completion_base_event(journal, binding)?;
    let prefix_previous = if usage_sequence == binding.expected_last_sequence + 1 {
        parallel_base
    } else {
        journal
            .events
            .iter()
            .find(|candidate| {
                candidate.get("sequence").and_then(Value::as_i64) == Some(usage_sequence - 1)
            })
            .and_then(|candidate| candidate.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Parallel worker usage predecessor is missing.".to_string())?
    };
    if journal.run.get("status").and_then(Value::as_str) != Some("running")
        || event.get("id").and_then(Value::as_str) != Some(expected_id)
        || event.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || event.get("idempotencyKey").and_then(Value::as_str) != Some(expected_key.as_str())
        || event.pointer("/payload/workerId").and_then(Value::as_str)
            != Some(binding.worker_id.as_str())
        || event.get("previousEventId").and_then(Value::as_str)
            != Some(binding.usage_event_id.as_str())
        || event.get("correlationKey").and_then(Value::as_str)
            != Some(expected_correlation.as_str())
        || terminal_sequence != usage_sequence + 1
        || !payload_valid
        || usage.get("type").and_then(Value::as_str) != Some("usage-recorded")
        || usage.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || usage.get("idempotencyKey").and_then(Value::as_str)
            != Some(format!("worker-usage:{}", binding.idempotency_key).as_str())
        || usage.get("previousEventId").and_then(Value::as_str) != Some(prefix_previous)
        || usage
            .pointer("/payload/usage/workerId")
            .and_then(Value::as_str)
            != Some(binding.worker_id.as_str())
        || usage_sequence <= binding.expected_last_sequence
        || journal
            .events
            .iter()
            .filter(|candidate| candidate.get("id").and_then(Value::as_str) == Some(expected_id))
            .count()
            != 1
        || journal
            .events
            .iter()
            .filter(|candidate| {
                candidate.get("id").and_then(Value::as_str) == Some(binding.usage_event_id.as_str())
            })
            .count()
            != 1
    {
        return Err("Parallel worker terminal replay fact is invalid.".into());
    }
    validate_parallel_sibling_advancement(
        journal,
        binding,
        binding.expected_last_sequence + 1,
        usage_sequence - 1,
        parallel_base,
    )?;
    let current_sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Mission run event head is invalid.".to_string())?;
    validate_parallel_sibling_advancement(
        journal,
        binding,
        terminal_sequence + 1,
        current_sequence,
        expected_id,
    )?;
    Ok(())
}

fn exact_parallel_native_cancellation_replay(
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    binding: &NativeWorkerExecutionBinding,
) -> Result<(), String> {
    let parallel_base = parallel_completion_base_event(journal, binding)?;
    let cancellation_event = journal
        .events
        .iter()
        .find(|candidate| {
            candidate.get("id").and_then(Value::as_str)
                == event.get("previousEventId").and_then(Value::as_str)
        })
        .ok_or_else(|| "Parallel mission cancellation replay fact is missing.".to_string())?;
    let cancellation_sequence = cancellation_event
        .get("sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Parallel mission cancellation replay sequence is invalid.".to_string())?;
    let cancellation = cancellation_event.pointer("/payload/cancellation");
    let request_key = cancellation
        .and_then(|value| value.get("requestKey"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Parallel mission cancellation replay request is invalid.".to_string())?;
    let previous = if cancellation_sequence == binding.expected_last_sequence + 1 {
        parallel_base
    } else {
        journal
            .events
            .iter()
            .find(|candidate| {
                candidate.get("sequence").and_then(Value::as_i64) == Some(cancellation_sequence - 1)
            })
            .and_then(|candidate| candidate.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| "Parallel mission cancellation predecessor is missing.".to_string())?
    };
    let expected_correlation = format!(
        "native-worker-completion:v1:run-revision:{}",
        binding.expected_run_revision
    );
    if journal.run.get("status").and_then(Value::as_str) != Some("cancelled")
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(binding.result_event_id.as_str())
        || event.get("id").and_then(Value::as_str) != Some(binding.result_event_id.as_str())
        || event.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || event.get("type").and_then(Value::as_str) != Some("run-cancelled")
        || event.get("sequence").and_then(Value::as_i64) != Some(cancellation_sequence + 1)
        || event.get("idempotencyKey").and_then(Value::as_str)
            != Some(format!("worker-cancel:{}", binding.idempotency_key).as_str())
        || event.get("correlationKey").and_then(Value::as_str)
            != Some(expected_correlation.as_str())
        || event.pointer("/payload/cancellation") != cancellation
        || cancellation_event.get("type").and_then(Value::as_str) != Some("cancellation-requested")
        || cancellation_event.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || cancellation_event
            .get("previousEventId")
            .and_then(Value::as_str)
            != Some(previous)
        || cancellation_event
            .get("idempotencyKey")
            .and_then(Value::as_str)
            != Some(format!("cancel:{request_key}").as_str())
        || cancellation != journal.run.get("cancellation")
        || cancellation
            .and_then(|value| value.get("scope"))
            .and_then(Value::as_str)
            != Some("run")
    {
        return Err("Parallel mission cancellation replay fact is invalid.".into());
    }
    validate_parallel_sibling_advancement(
        journal,
        binding,
        binding.expected_last_sequence + 1,
        cancellation_sequence - 1,
        parallel_base,
    )?;
    Ok(())
}

fn exact_native_terminal_replay_with_mode(
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
    parallel_evidence_free: bool,
) -> Result<(), String> {
    if parallel_evidence_free {
        if event.get("type").and_then(Value::as_str) == Some("run-cancelled") {
            exact_parallel_native_cancellation_replay(journal, event, binding)
        } else {
            exact_parallel_native_terminal_replay(journal, event, binding, output)
        }
    } else {
        exact_native_terminal_replay_with_journal(journal, event, binding, output)
    }
}

#[cfg(test)]
fn exact_native_terminal_replay(
    event: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
) -> Result<(), String> {
    let empty = mission_run::MissionRunJournalRow {
        run: json!({}),
        events: Vec::new(),
    };
    exact_native_terminal_replay_with_journal(&empty, event, binding, output)
}

fn validate_output_receipt_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner: &str,
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
) -> crate::store::Result<()> {
    if event.get("type").and_then(Value::as_str) != Some("worker-completed") {
        return Ok(());
    }
    let Some(spec) = output else {
        return Ok(());
    };
    let reference = event
        .pointer("/payload/outputs/0/valueReference")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Worker output reference is missing.".into())
        })?;
    let receipt = crate::store::repos::mission_worker_output::get_by_reference(
        tx, store, scope, owner, reference,
    )?
    .ok_or_else(|| {
        crate::store::StoreError::Invalid("Worker completion output receipt is missing.".into())
    })?;
    if receipt.run_id != binding.run_id
        || receipt.worker_id != binding.worker_id
        || receipt.completion_event_id != binding.completion_event_id
        || receipt.output_key != spec.key
        || receipt
            .receipt
            .get("providerRouteId")
            .and_then(Value::as_str)
            != journal_provider_route_id(journal, binding)
    {
        return Err(crate::store::StoreError::Invalid(
            "Worker completion output receipt represents another result.".into(),
        ));
    }
    Ok(())
}

fn validate_native_result_replay(
    journal: &mission_run::MissionRunJournalRow,
    terminal: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
    cited_policy_shape: bool,
) -> Result<(), String> {
    if !cited_policy_shape {
        return Ok(());
    }
    if terminal.get("type").and_then(Value::as_str) == Some("run-cancelled") {
        return Ok(());
    }
    if terminal.get("type").and_then(Value::as_str) == Some("worker-failed") {
        let terminal_sequence = terminal
            .get("sequence")
            .and_then(Value::as_i64)
            .ok_or_else(|| "Worker failure terminal sequence is invalid.".to_string())?;
        let result = journal.events.iter().find(|event| {
            event.get("id").and_then(Value::as_str) == Some(binding.result_event_id.as_str())
        });
        let Some(result) = result else {
            return if output.is_some_and(|spec| spec.include_evidence) {
                Err("Policy-bearing worker failure run result is missing.".into())
            } else {
                Ok(())
            };
        };
        let result_key = format!("run-result:{}", binding.idempotency_key);
        if result.get("type").and_then(Value::as_str) == Some("run-failed")
            && result.get("runId").and_then(Value::as_str) == Some(binding.run_id.as_str())
            && result.get("previousEventId").and_then(Value::as_str)
                == Some(binding.failure_event_id.as_str())
            && result.get("sequence").and_then(Value::as_i64) == Some(terminal_sequence + 1)
            && result.get("idempotencyKey").and_then(Value::as_str) == Some(result_key.as_str())
            && result.pointer("/payload/error") == terminal.pointer("/payload/error")
            && journal.run.get("status").and_then(Value::as_str) == Some("failed")
            && journal
                .run
                .pointer("/eventHead/lastEventId")
                .and_then(Value::as_str)
                == Some(binding.result_event_id.as_str())
        {
            return Ok(());
        }
        return Err("Worker failure run result does not match its terminal fact.".into());
    }
    let Some(output) = output.filter(|spec| spec.include_evidence) else {
        return Ok(());
    };
    if terminal.get("type").and_then(Value::as_str) != Some("worker-completed") {
        return Err("Policy-bearing worker replay is missing its completed output.".into());
    }
    let output_reference = terminal
        .pointer("/payload/outputs/0/valueReference")
        .and_then(Value::as_str)
        .ok_or_else(|| "Policy-bearing worker output reference is missing.".to_string())?;
    let terminal_sequence = terminal
        .get("sequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Policy-bearing worker terminal sequence is invalid.".to_string())?;
    let evaluation = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str) == Some(binding.evaluation_event_id.as_str())
        })
        .ok_or_else(|| "Policy evaluation replay fact is missing.".to_string())?;
    let verdict = evaluation
        .pointer("/payload/evaluation/verdict")
        .and_then(Value::as_str);
    let evaluation_key = format!("worker-evaluation:{}", binding.idempotency_key);
    if evaluation.get("type").and_then(Value::as_str) != Some("evaluation-recorded")
        || evaluation.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || evaluation.get("previousEventId").and_then(Value::as_str)
            != Some(binding.completion_event_id.as_str())
        || evaluation.get("sequence").and_then(Value::as_i64) != Some(terminal_sequence + 1)
        || evaluation.get("idempotencyKey").and_then(Value::as_str) != Some(evaluation_key.as_str())
        || evaluation
            .pointer("/payload/evaluation/target/workerId")
            .and_then(Value::as_str)
            != Some(binding.worker_id.as_str())
        || !matches!(verdict, Some("pass" | "fail"))
        || evaluation
            .pointer("/payload/evaluation/criteria")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
    {
        return Err("Policy evaluation replay fact is invalid.".into());
    }
    let result = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str) == Some(binding.result_event_id.as_str())
        })
        .ok_or_else(|| "Policy result replay fact is missing.".to_string())?;
    let result_key = format!("run-result:{}", binding.idempotency_key);
    if result.get("runId").and_then(Value::as_str) != Some(binding.run_id.as_str())
        || result.get("previousEventId").and_then(Value::as_str)
            != Some(binding.evaluation_event_id.as_str())
        || result.get("sequence").and_then(Value::as_i64) != Some(terminal_sequence + 2)
        || result.get("idempotencyKey").and_then(Value::as_str) != Some(result_key.as_str())
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(binding.result_event_id.as_str())
    {
        return Err("Policy result replay fact is invalid.".into());
    }
    let valid = match verdict {
        Some("pass") => {
            result.get("type").and_then(Value::as_str) == Some("run-completed")
                && result
                    .pointer("/payload/result/outcome")
                    .and_then(Value::as_str)
                    == Some("succeeded")
                && result
                    .pointer("/payload/result/outputs/0/key")
                    .and_then(Value::as_str)
                    == Some(output.key.as_str())
                && result
                    .pointer("/payload/result/outputs/0/valueReference")
                    .and_then(Value::as_str)
                    == Some(output_reference)
                && journal.run.get("status").and_then(Value::as_str) == Some("completed")
                && journal
                    .run
                    .pointer("/terminalResult/outcome")
                    .and_then(Value::as_str)
                    == Some("succeeded")
        }
        Some("fail") => {
            result.get("type").and_then(Value::as_str) == Some("run-failed")
                && result
                    .pointer("/payload/error/code")
                    .and_then(Value::as_str)
                    == Some("policy-acceptance-failed")
                && result
                    .pointer("/payload/error/category")
                    .and_then(Value::as_str)
                    == Some("validation")
                && result
                    .pointer("/payload/error/retryable")
                    .and_then(Value::as_bool)
                    == Some(false)
                && result
                    .pointer("/payload/partial/completedOutputs/0/key")
                    .and_then(Value::as_str)
                    == Some(output.key.as_str())
                && result
                    .pointer("/payload/partial/completedOutputs/0/valueReference")
                    .and_then(Value::as_str)
                    == Some(output_reference)
                && journal.run.get("status").and_then(Value::as_str) == Some("partially-completed")
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Policy result replay fact does not match its evaluation.".into())
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_accepted_mission_artifact_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    terminal: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
) -> crate::store::Result<()> {
    if terminal.get("type").and_then(Value::as_str) != Some("worker-completed") {
        return Ok(());
    }
    let Some(spec) = output.filter(|value| value.include_evidence) else {
        return Ok(());
    };
    let evaluation = journal.events.iter().find(|event| {
        event.get("id").and_then(Value::as_str) == Some(binding.evaluation_event_id.as_str())
    });
    let verdict = evaluation
        .and_then(|event| event.pointer("/payload/evaluation/verdict"))
        .and_then(Value::as_str);
    let actor = journal
        .run
        .get("createdByInternalUserId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission artifact replay creator is missing.".into())
        })?;
    let private = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
        scope.clone(),
        actor,
        Some(owner_member_id),
    )?;
    if verdict != Some("pass") {
        if crate::store::repos::artifact::mission_source_exists(
            tx,
            &private,
            owner_member_id,
            &binding.run_id,
            &spec.key,
        )? {
            return Err(crate::store::StoreError::Invalid(
                "A non-accepted mission output cannot have a canonical artifact.".into(),
            ));
        }
        return Ok(());
    }
    let output_reference = terminal
        .pointer("/payload/outputs/0/valueReference")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Accepted mission output reference is missing.".into(),
            )
        })?;
    let receipt = crate::store::repos::mission_worker_output::get_by_reference(
        tx,
        store,
        scope,
        owner_member_id,
        output_reference,
    )?
    .ok_or_else(|| {
        crate::store::StoreError::Invalid("Accepted mission output receipt is missing.".into())
    })?;
    let expected = crate::store::repos::artifact::accepted_mission_output_binding(
        scope.workspace_id(),
        owner_member_id,
        &binding.run_id,
        &binding.worker_id,
        &binding.completion_event_id,
        &spec.key,
        &receipt.content_hash,
    );
    let result = journal.events.iter().find(|event| {
        event.get("id").and_then(Value::as_str) == Some(binding.result_event_id.as_str())
    });
    let result_matches = result.is_some_and(|event| {
        event
            .pointer("/payload/result/outputs/0/artifactId")
            .and_then(Value::as_str)
            == Some(expected.artifact_id.as_str())
            && event
                .pointer("/payload/result/outputs/0/artifactVersionId")
                .and_then(Value::as_str)
                == Some(expected.artifact_version_id.as_str())
    });
    let source = crate::store::repos::artifact::get_mission_source_binding(
        tx,
        &private,
        owner_member_id,
        &binding.run_id,
        &spec.key,
        &binding.completion_event_id,
        &binding.evaluation_event_id,
        &binding.result_event_id,
        output_reference,
        &receipt.content_hash,
    )?;
    if !result_matches || source.as_ref() != Some(&expected) {
        return Err(crate::store::StoreError::Invalid(
            "Accepted mission artifact replay does not match its terminal result.".into(),
        ));
    }
    crate::store::repos::artifact::validate_mission_artifact_bundle(
        tx,
        store,
        &private,
        &expected,
        &receipt.content_hash,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_cited_mission_transcript_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    terminal: &Value,
    binding: &NativeWorkerExecutionBinding,
    output: Option<&NativeWorkerOutputSpec>,
) -> crate::store::Result<()> {
    if matches!(
        terminal.get("type").and_then(Value::as_str),
        Some("worker-failed" | "run-cancelled")
    ) {
        let mission_id = journal
            .run
            .get("missionId")
            .or_else(|| journal.run.pointer("/initiator/missionId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Cited mission transcript has no selected mission.".into(),
                )
            })?;
        let lifecycle = mission_plan::get(tx, store, scope, owner_member_id, mission_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Cited mission plan is unavailable.".into())
            })?;
        if is_cited_terminal_status_shape(journal, &lifecycle) {
            return validate_cited_terminal_status_transcript_replay(
                tx,
                store,
                scope,
                owner_member_id,
                journal,
                &lifecycle,
            );
        }
        return Ok(());
    }
    if terminal.get("type").and_then(Value::as_str) != Some("worker-completed")
        || output.is_none_or(|spec| !spec.include_evidence)
    {
        return Ok(());
    }
    let mission_id = journal
        .run
        .get("missionId")
        .or_else(|| journal.run.pointer("/initiator/missionId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited mission transcript has no selected mission.".into(),
            )
        })?;
    let lifecycle =
        mission_plan::get(tx, store, scope, owner_member_id, mission_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission plan is unavailable.".into())
        })?;
    let output_reference = terminal
        .pointer("/payload/outputs/0/valueReference")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission output reference is missing.".into())
        })?;
    let receipt = crate::store::repos::mission_worker_output::get_by_reference(
        tx,
        store,
        scope,
        owner_member_id,
        output_reference,
    )?
    .ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission output receipt is missing.".into())
    })?;
    let result_event = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str) == Some(binding.result_event_id.as_str())
        })
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission terminal result is missing.".into())
        })?;
    let passed = journal.events.iter().any(|event| {
        event.get("id").and_then(Value::as_str) == Some(binding.evaluation_event_id.as_str())
            && event
                .pointer("/payload/evaluation/verdict")
                .and_then(Value::as_str)
                == Some("pass")
    });
    let accepted_artifact = passed.then(|| {
        crate::store::repos::artifact::accepted_mission_output_binding(
            scope.workspace_id(),
            owner_member_id,
            &binding.run_id,
            &binding.worker_id,
            &binding.completion_event_id,
            &receipt.output_key,
            &receipt.content_hash,
        )
    });
    let expected = cited_mission_transcript(
        journal,
        &lifecycle,
        binding,
        &receipt.receipt,
        result_event,
        accepted_artifact.as_ref(),
    )?;
    let messages = message::list(tx, store, scope, &expected.thread_id)?;
    let user = messages
        .iter()
        .find(|candidate| candidate.id == expected.user_message_id);
    let assistant = messages
        .iter()
        .find(|candidate| candidate.id == expected.assistant_message_id);
    let occurred_at = result_event.get("occurredAt").and_then(Value::as_str);
    let exact_user = user.is_some_and(|candidate| {
        candidate.kind == "user"
            && candidate.run_id.as_deref() == Some(binding.run_id.as_str())
            && candidate.detail.is_null()
            && candidate.current_revision_id == expected.user_revision_id
            && candidate.current_revision_number == 1
            && candidate.current_revision_state == "terminal"
            && candidate.content == json!(expected.prompt)
            && occurred_at == Some(candidate.created_at.as_str())
    });
    let exact_assistant = assistant.is_some_and(|candidate| {
        candidate.kind == "assistant"
            && candidate.run_id.as_deref() == Some(binding.run_id.as_str())
            && candidate.detail == expected.assistant_detail
            && candidate.current_revision_id == expected.assistant_revision_id
            && candidate.current_revision_number == 1
            && candidate.current_revision_state == "terminal"
            && candidate.content == json!(expected.response)
            && occurred_at == Some(candidate.created_at.as_str())
            && user.is_some_and(|user| candidate.sequence == user.sequence + 1)
    });
    if exact_user && exact_assistant {
        Ok(())
    } else {
        Err(crate::store::StoreError::Invalid(
            "Cited mission transcript replay does not match its terminal result.".into(),
        ))
    }
}

fn journal_provider_route_id<'a>(
    journal: &'a mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
) -> Option<&'a str> {
    journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str)
                == Some(binding.route_selected_event_id.as_str())
        })
        .and_then(|event| event.pointer("/payload/selection/providerRouteId"))
        .and_then(Value::as_str)
}

fn journal_provider_id<'a>(
    journal: &'a mission_run::MissionRunJournalRow,
    binding: &NativeWorkerExecutionBinding,
) -> Option<&'a str> {
    journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str)
                == Some(binding.route_selected_event_id.as_str())
        })
        .and_then(|event| event.pointer("/payload/providerId"))
        .and_then(Value::as_str)
}

fn validate_usage_replay_with_mode(
    journal: &mission_run::MissionRunJournalRow,
    terminal: &Value,
    binding: &NativeWorkerExecutionBinding,
    model: &str,
    max_duration_ms: i64,
    expected_attempt_number: i64,
    parallel_evidence_free: bool,
) -> Result<(), String> {
    if terminal.get("type").and_then(Value::as_str) == Some("run-cancelled") {
        return Ok(());
    }
    if !parallel_evidence_free
        && terminal.get("previousEventId").and_then(Value::as_str)
            == Some(native_completion_base_event(binding))
    {
        return Ok(());
    }
    if !matches!(
        terminal.get("type").and_then(Value::as_str),
        Some("worker-completed" | "worker-failed" | "retry-scheduled")
    ) {
        return Err("Worker terminal usage chain is invalid.".into());
    }
    let usage = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str) == Some(binding.usage_event_id.as_str())
        })
        .ok_or_else(|| "Worker terminal usage event is missing.".to_string())?;
    let input_tokens = usage
        .pointer("/payload/usage/inputTokens")
        .and_then(Value::as_i64);
    let output_tokens = usage
        .pointer("/payload/usage/outputTokens")
        .and_then(Value::as_i64);
    let duration_ms = usage
        .pointer("/payload/usage/durationMs")
        .and_then(Value::as_i64);
    let attempt_number = usage
        .pointer("/payload/usage/attemptNumber")
        .and_then(Value::as_i64);
    let tokens_valid = match (input_tokens, output_tokens) {
        (Some(input), Some(output)) => input >= 0 && output >= 0,
        (None, None) => true,
        _ => false,
    };
    // Stored events written before native duration ownership remain replayable,
    // but any event carrying the new timing fields must carry the exact pair.
    let timing_valid = match (duration_ms, attempt_number) {
        (None, None) => true,
        (Some(duration), Some(attempt)) => {
            duration >= 0
                && duration <= max_duration_ms
                && attempt == expected_attempt_number
                && usage.get("attemptNumber").and_then(Value::as_i64) == Some(attempt)
        }
        _ => false,
    };
    let duration_failure_valid = terminal
        .pointer("/payload/error/code")
        .and_then(Value::as_str)
        != Some("native-worker-duration-budget-exceeded")
        || duration_ms == Some(max_duration_ms);
    let expected_costs = Value::Array(
        input_tokens
            .zip(output_tokens)
            .map(|(input, output)| {
                exact_model_costs(
                    journal_provider_id(journal, binding).unwrap_or(""),
                    model,
                    input,
                    output,
                )
            })
            .unwrap_or_default(),
    );
    let expected_key = native_usage_event_key(binding)?;
    let selected_route = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str)
                == Some(binding.route_selected_event_id.as_str())
        })
        .and_then(|event| event.pointer("/payload/selection/providerRouteId"))
        .and_then(Value::as_str);
    let usage_sequence_valid = if parallel_evidence_free {
        terminal.get("previousEventId").and_then(Value::as_str)
            == Some(binding.usage_event_id.as_str())
            && terminal.get("sequence").and_then(Value::as_i64)
                == usage
                    .get("sequence")
                    .and_then(Value::as_i64)
                    .map(|sequence| sequence + 1)
            && usage
                .get("sequence")
                .and_then(Value::as_i64)
                .is_some_and(|sequence| sequence > binding.expected_last_sequence)
    } else {
        usage.get("sequence").and_then(Value::as_i64) == Some(binding.expected_last_sequence + 1)
            && usage.get("previousEventId").and_then(Value::as_str)
                == Some(native_completion_base_event(binding))
    };
    if selected_route.is_none()
        || usage.get("type").and_then(Value::as_str) != Some("usage-recorded")
        || !usage_sequence_valid
        || usage.get("idempotencyKey").and_then(Value::as_str) != Some(expected_key.as_str())
        || usage
            .pointer("/payload/usage/runId")
            .and_then(Value::as_str)
            != Some(binding.run_id.as_str())
        || usage
            .pointer("/payload/usage/workerId")
            .and_then(Value::as_str)
            != Some(binding.worker_id.as_str())
        || usage
            .pointer("/payload/usage/providerRouteId")
            .and_then(Value::as_str)
            != selected_route
        || usage
            .pointer("/payload/usage/modelReference")
            .and_then(Value::as_str)
            != Some(model)
        || !tokens_valid
        || !timing_valid
        || !duration_failure_valid
        || usage
            .pointer("/payload/usage/toolCalls")
            .and_then(Value::as_i64)
            != Some(if binding.tool_evidence.is_some() {
                1
            } else {
                0
            })
        || usage.pointer("/payload/usage/costs") != Some(&expected_costs)
    {
        return Err("Worker terminal usage event represents another result.".into());
    }
    Ok(())
}

fn validate_usage_replay(
    journal: &mission_run::MissionRunJournalRow,
    terminal: &Value,
    binding: &NativeWorkerExecutionBinding,
    model: &str,
    max_duration_ms: i64,
    expected_attempt_number: i64,
) -> Result<(), String> {
    validate_usage_replay_with_mode(
        journal,
        terminal,
        binding,
        model,
        max_duration_ms,
        expected_attempt_number,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_native_retry_replay(
    journal: &mission_run::MissionRunJournalRow,
    retry: &Value,
    binding: &NativeWorkerExecutionBinding,
    model: &str,
    max_duration_ms: i64,
    expected_attempt_number: i64,
    max_attempts: i64,
) -> Result<(), String> {
    if expected_attempt_number != 1 || max_attempts != 2 {
        return Err("Cited retry is outside its persisted attempt budget.".into());
    }
    validate_usage_replay(
        journal,
        retry,
        binding,
        model,
        max_duration_ms,
        expected_attempt_number,
    )?;
    let attempt = journal
        .events
        .iter()
        .find(|event| {
            event.get("id").and_then(Value::as_str) == Some(binding.failure_event_id.as_str())
        })
        .ok_or_else(|| "Cited retry attempt event is missing.".to_string())?;
    let error = retry
        .pointer("/payload/error")
        .ok_or_else(|| "Cited retry error is missing.".to_string())?;
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let attempt_key = native_attempt_finished_event_key(binding)?;
    let retry_key = native_retry_event_key(binding)?;
    let occurred_at = retry.get("occurredAt");
    let selected_route = journal.run.get("selectedRoute");
    if retry.get("id").and_then(Value::as_str) != Some(binding.result_event_id.as_str())
        || retry.get("type").and_then(Value::as_str) != Some("retry-scheduled")
        || retry.get("sequence").and_then(Value::as_i64) != Some(binding.expected_last_sequence + 3)
        || retry.get("previousEventId").and_then(Value::as_str)
            != Some(binding.failure_event_id.as_str())
        || retry.get("attemptNumber").and_then(Value::as_i64) != Some(1)
        || retry.get("idempotencyKey").and_then(Value::as_str) != Some(retry_key.as_str())
        || retry
            .pointer("/payload/nextAttemptNumber")
            .and_then(Value::as_i64)
            != Some(2)
        || error.get("retryable").and_then(Value::as_bool) != Some(true)
        || !matches!(
            code,
            "native-provider-transport-failed"
                | "native-provider-temporarily-unavailable"
                | "native-provider-stream-interrupted"
        )
        || !native_contract_error_valid(error)
        || attempt.get("type").and_then(Value::as_str) != Some("attempt-finished")
        || attempt.get("sequence").and_then(Value::as_i64)
            != Some(binding.expected_last_sequence + 2)
        || attempt.get("previousEventId").and_then(Value::as_str)
            != Some(binding.usage_event_id.as_str())
        || attempt.get("attemptNumber").and_then(Value::as_i64) != Some(1)
        || attempt.get("idempotencyKey").and_then(Value::as_str) != Some(attempt_key.as_str())
        || attempt
            .pointer("/payload/attempt/runId")
            .and_then(Value::as_str)
            != Some(binding.run_id.as_str())
        || attempt
            .pointer("/payload/attempt/attemptNumber")
            .and_then(Value::as_i64)
            != Some(1)
        || attempt
            .pointer("/payload/attempt/status")
            .and_then(Value::as_str)
            != Some("failed")
        || attempt.pointer("/payload/attempt/retryReason") != Some(error)
        || attempt.pointer("/payload/attempt/selectedRoute") != selected_route
        || attempt
            .pointer("/payload/attempt/selectedPlacement/executionNodeId")
            .and_then(Value::as_str)
            != Some("execution-node-local-desktop")
        || attempt.pointer("/payload/attempt/finishedAt") != attempt.get("occurredAt")
        || attempt.get("occurredAt") != occurred_at
        || journal.run.get("status").and_then(Value::as_str) != Some("retrying")
        || journal.run.get("revision").and_then(Value::as_i64)
            != Some(binding.expected_run_revision + 3)
        || journal
            .run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(binding.expected_last_sequence + 3)
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(binding.result_event_id.as_str())
    {
        return Err("Cited retry replay represents another provider attempt.".into());
    }
    Ok(())
}

fn exact_model_costs(
    provider_id: &str,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
) -> Vec<Value> {
    let Some(pricing) = crate::backends::exact_model_pricing_evidence(provider_id, model) else {
        return Vec::new();
    };
    if input_tokens < 0 || output_tokens < 0 {
        return Vec::new();
    }
    let nanos = (i128::from(input_tokens) * i128::from(pricing.input_rate_minor_units)
        + i128::from(output_tokens) * i128::from(pricing.output_rate_minor_units))
        * 10_000_000
        / i128::from(pricing.unit_tokens);
    let pricing_reference = format!(
        "{}|reviewed={}|standard-input-usd-per-1m={}|standard-output-usd-per-1m={}",
        pricing.source_url,
        &pricing.reviewed_at[..10],
        decimal_usd_from_minor(pricing.input_rate_minor_units),
        decimal_usd_from_minor(pricing.output_rate_minor_units),
    );
    vec![json!({
        "amount":{"amount":decimal_usd_from_nanos(nanos),"currencyCode":"USD"},
        "provenance":"fable-calculated","pricingReference":pricing_reference
    })]
}

fn decimal_usd_from_minor(minor_units: u64) -> String {
    let whole = minor_units / 100;
    let fractional = minor_units % 100;
    if fractional == 0 {
        whole.to_string()
    } else if fractional.is_multiple_of(10) {
        format!("{whole}.{}", fractional / 10)
    } else {
        format!("{whole}.{fractional:02}")
    }
}

fn decimal_usd_from_nanos(nanos: i128) -> String {
    let whole = nanos / 1_000_000_000;
    let fractional = nanos % 1_000_000_000;
    if fractional == 0 {
        return whole.to_string();
    }
    let fraction = format!("{fractional:09}").trim_end_matches('0').to_string();
    format!("{whole}.{fraction}")
}

fn native_failure_payload_valid(event: &Value) -> bool {
    let Some(payload) = event.get("payload").and_then(Value::as_object) else {
        return false;
    };
    if exact_keys(payload, &["workerId", "error"]).is_err() {
        return false;
    }
    payload
        .get("workerId")
        .and_then(Value::as_str)
        .is_some_and(|worker_id| !worker_id.is_empty())
        && payload
            .get("error")
            .is_some_and(native_contract_error_valid)
}

fn native_contract_error_valid(error: &Value) -> bool {
    let Some(error) = error.as_object() else {
        return false;
    };
    if exact_keys(error, &["code", "category", "message", "retryable"]).is_err() {
        return false;
    }
    if error.get("code").and_then(Value::as_str) == Some("native-worker-token-budget-exceeded") {
        return error.get("category").and_then(Value::as_str) == Some("budget-exceeded")
            && error.get("message").and_then(Value::as_str)
                == Some("The native provider usage exceeded the worker token budget.")
            && error.get("retryable").and_then(Value::as_bool) == Some(false);
    }
    if error.get("code").and_then(Value::as_str) == Some("native-worker-duration-budget-exceeded") {
        return error.get("category").and_then(Value::as_str) == Some("budget-exceeded")
            && error.get("message").and_then(Value::as_str)
                == Some("The native provider exceeded the worker duration budget.")
            && error.get("retryable").and_then(Value::as_bool) == Some(false);
    }
    if error.get("code").and_then(Value::as_str) == Some("native-worker-output-contract-invalid") {
        return error.get("category").and_then(Value::as_str) == Some("validation")
            && error.get("message").and_then(Value::as_str)
                == Some(
                    "The reviewer output did not match its required bounded Markdown contract.",
                )
            && error.get("retryable").and_then(Value::as_bool) == Some(false);
    }
    if error.get("category").and_then(Value::as_str) != Some("provider")
        || error.get("retryable").and_then(Value::as_bool).is_none()
    {
        return false;
    }
    matches!(
        (
            error.get("code").and_then(Value::as_str),
            error.get("message").and_then(Value::as_str),
            error.get("retryable").and_then(Value::as_bool),
        ),
        (
            Some("native-provider-transport-failed"),
            Some("The native provider connection failed after retrying."),
            Some(true)
        ) | (
            Some("native-provider-temporarily-unavailable"),
            Some("The native provider remained unavailable after retrying."),
            Some(true)
        ) | (
            Some("native-provider-request-rejected"),
            Some("The native provider rejected the request."),
            Some(false)
        ) | (
            Some("native-provider-response-too-large"),
            Some("The native provider response exceeded Fable's limit."),
            Some(false)
        ) | (
            Some("native-provider-stream-interrupted"),
            Some("The native provider stream ended unexpectedly."),
            Some(true)
        ) | (
            Some("native-provider-payload-error"),
            Some("The native provider returned an error payload."),
            Some(false)
        ) | (
            Some("native-provider-invalid-utf8"),
            Some("The native provider stream contained invalid UTF-8."),
            Some(false)
        ) | (
            Some("native-provider-output-too-large"),
            Some("The native provider output exceeded Fable's mission receipt limit."),
            Some(false)
        ) | (
            Some("native-provider-output-limit"),
            Some("The native provider reached the worker output limit."),
            Some(false)
        ) | (
            Some("native-provider-terminal-incomplete"),
            Some("The native provider ended without a successful stop."),
            Some(false)
        )
    )
}

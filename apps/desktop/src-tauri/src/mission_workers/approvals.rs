#[tauri::command]
pub fn mission_worker_output_read(
    value_reference: String,
) -> Result<Option<crate::store::repos::mission_worker_output::MissionWorkerOutputRow>, String> {
    if !value_reference.starts_with("mission-output:v1:") || value_reference.len() > 512 {
        return Err("Mission worker output reference is invalid.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required.".into(),
                )
            })?;
            let scope = crate::store::repos::scope::DataScope::workspace(
                context.active_workspace.local_workspace_id,
            )?;
            crate::store::repos::mission_worker_output::get_by_reference(
                tx,
                store,
                &scope,
                &member,
                &value_reference,
            )
        })
        .map_err(|error| error.to_string())
}

struct CitedApprovalFacts {
    lifecycle: mission_plan::MissionPlanLifecycleRow,
    output: crate::store::repos::mission_worker_output::MissionWorkerOutputRow,
    wait_key: String,
    proposal_hash: String,
    suffix: String,
    requested_at: String,
    worker_id: String,
    worker_started_event_id: String,
    route_selected_event_id: String,
    usage_event_id: String,
    completion_event_id: String,
    evaluation_event_id: String,
    provider_id: String,
    requested_model: String,
    provider_route_id: String,
    token_usage: (i64, i64),
    evaluation: Value,
    plan_summary: Value,
}

fn cited_approval_facts(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    expected_thread_id: Option<&str>,
) -> crate::store::Result<CitedApprovalFacts> {
    if journal.run.get("status").and_then(Value::as_str) != Some("waiting-approval") {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission is not waiting for human acceptance.".into(),
        ));
    }
    let run_id = journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval run is invalid.".into())
        })?;
    if expected_thread_id.is_some_and(|thread_id| {
        journal.run.get("sourceThreadId").and_then(Value::as_str) != Some(thread_id)
    }) {
        return Err(crate::store::StoreError::Invalid(
            "Cited approval belongs to another conversation.".into(),
        ));
    }
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval mission is invalid.".into())
        })?;
    let lifecycle =
        mission_plan::get(tx, store, scope, owner_member_id, mission_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval plan is unavailable.".into())
        })?;
    validate_lifecycle(&journal.run, &lifecycle).map_err(crate::store::StoreError::Invalid)?;
    if lifecycle
        .mission
        .pointer("/acceptance/requiresHumanAcceptance")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited approval is not required by the selected plan.".into(),
        ));
    }
    let plan_summary =
        crate::mission_plans::project_cited_plan_summary(&lifecycle, expected_thread_id)
            .map_err(crate::store::StoreError::Invalid)?;
    let approval_event = journal.events.last().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited approval event is unavailable.".into())
    })?;
    let checkpoint_event_id = approval_event
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval checkpoint is invalid.".into())
        })?;
    let wait = approval_event.pointer("/payload/wait").ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited approval proposal is unavailable.".into())
    })?;
    let wait_key = wait.get("waitKey").and_then(Value::as_str).unwrap_or("");
    let proposal_hash = wait
        .get("proposalHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    let approval_request_ref = wait
        .get("approvalRequestRef")
        .and_then(Value::as_str)
        .unwrap_or("");
    let requested_at = wait
        .get("requestedAt")
        .and_then(Value::as_str)
        .unwrap_or("");
    let suffix = approval_request_ref
        .strip_prefix("cited-artifact-proposal:v1:")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval identity is invalid.".into())
        })?;
    let checkpoint_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(checkpoint_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval checkpoint is unavailable.".into())
        })?;
    if approval_event.get("type").and_then(Value::as_str) != Some("approval-requested")
        || checkpoint_event.get("type").and_then(Value::as_str) != Some("checkpoint-created")
        || checkpoint_event
            .pointer("/payload/checkpoint/kind")
            .and_then(Value::as_str)
            != Some("wait-boundary")
        || checkpoint_event
            .pointer("/payload/checkpoint/pendingWaitKey")
            .and_then(Value::as_str)
            != Some(wait_key)
        || wait.get("status").and_then(Value::as_str) != Some("pending")
        || wait.get("actionSummary").and_then(Value::as_str)
            != Some("Save this policy-passed cited brief as an accepted artifact.")
        || requested_at.is_empty()
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited approval event chain is invalid.".into(),
        ));
    }
    let checkpoint =
        mission_checkpoint::get_by_event(tx, store, scope, owner_member_id, checkpoint_event_id)?
            .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval state is unavailable.".into())
        })?;
    let proposal = checkpoint.state.get("approvalProposal").ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited approval state is invalid.".into())
    })?;
    let worker_id = proposal
        .get("workerId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let worker_started_event_id = proposal
        .get("workerStartedEventId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let route_selected_event_id = proposal
        .get("routeSelectedEventId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let usage_event_id = proposal
        .get("usageEventId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let completion_base_event_id = proposal
        .get("completionBaseEventId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let completion_event_id = proposal
        .get("completionEventId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let evaluation_event_id = proposal
        .get("evaluationEventId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let output_reference = proposal
        .get("outputReference")
        .and_then(Value::as_str)
        .unwrap_or("");
    let output = crate::store::repos::mission_worker_output::get_by_reference(
        tx,
        store,
        scope,
        owner_member_id,
        output_reference,
    )?
    .ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited approval draft is unavailable.".into())
    })?;
    let plan_revision_id = lifecycle
        .current_revision
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let material = format!(
        "fable.cited-artifact-approval.v1\0{}\0{owner_member_id}\0{plan_revision_id}\0{run_id}\0{worker_id}\0{output_reference}\0{}",
        scope.workspace_id(), output.content_hash
    );
    let expected_suffix = format!("{:x}", Sha256::digest(material.as_bytes()));
    let evaluation = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(evaluation_event_id))
        .and_then(|event| event.pointer("/payload/evaluation"))
        .cloned()
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval evaluation is unavailable.".into())
        })?;
    let completion_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(completion_event_id));
    let evaluation_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(evaluation_event_id));
    let worker_started_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(worker_started_event_id));
    let route_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(route_selected_event_id));
    let usage_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(usage_event_id));
    let completion_base_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(completion_base_event_id));
    let requested_model = usage_event
        .and_then(|event| event.pointer("/payload/usage/modelReference"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let provider_id = route_event
        .and_then(|event| event.pointer("/payload/providerId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let provider_route_id = usage_event
        .and_then(|event| event.pointer("/payload/usage/providerRouteId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let token_usage = (
        usage_event
            .and_then(|event| event.pointer("/payload/usage/inputTokens"))
            .and_then(Value::as_i64)
            .unwrap_or(-1),
        usage_event
            .and_then(|event| event.pointer("/payload/usage/outputTokens"))
            .and_then(Value::as_i64)
            .unwrap_or(-1),
    );
    let current_attempt = journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let expected_criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array);
    let evaluated_criteria = evaluation.get("criteria").and_then(Value::as_array);
    let criteria_match =
        expected_criteria
            .zip(evaluated_criteria)
            .is_some_and(|(expected, evaluated)| {
                !expected.is_empty()
                    && expected.len() == evaluated.len()
                    && expected.iter().all(|criterion| {
                        let key = criterion.get("key").and_then(Value::as_str);
                        evaluated.iter().any(|result| {
                            result.get("criterionKey").and_then(Value::as_str) == key
                                && result.get("passed").and_then(Value::as_bool) == Some(true)
                                && result
                                    .get("evidenceRefs")
                                    .and_then(Value::as_array)
                                    .is_some_and(|refs| !refs.is_empty())
                        })
                    })
            });
    let expected_evaluation_key = format!("native-policy:{evaluation_event_id}");
    let exact = suffix == expected_suffix
        && wait_key == format!("cited-artifact-wait:v1:{suffix}")
        && proposal_hash == format!("sha256:{suffix}")
        && wait.get("workerId").and_then(Value::as_str) == Some(worker_id)
        && proposal.get("approvalRequestRef").and_then(Value::as_str) == Some(approval_request_ref)
        && proposal.get("proposalHash").and_then(Value::as_str) == Some(proposal_hash)
        && proposal.get("planRevisionId").and_then(Value::as_str) == Some(plan_revision_id)
        && proposal.get("contentHash").and_then(Value::as_str)
            == Some(output.content_hash.as_str())
        && checkpoint_event
            .get("previousEventId")
            .and_then(Value::as_str)
            == Some(evaluation_event_id)
        && worker_started_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("worker-started")
                && event.pointer("/payload/workerId").and_then(Value::as_str) == Some(worker_id)
        })
        && route_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("route-selected")
                && event.get("previousEventId").and_then(Value::as_str)
                    == Some(worker_started_event_id)
                && event.pointer("/payload/workerId").and_then(Value::as_str) == Some(worker_id)
                && event.pointer("/payload/providerId").and_then(Value::as_str) == Some(provider_id)
                && event
                    .pointer("/payload/selection/providerRouteId")
                    .and_then(Value::as_str)
                    == Some(provider_route_id)
        })
        && usage_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("usage-recorded")
                && event.get("previousEventId").and_then(Value::as_str)
                    == Some(completion_base_event_id)
                && event
                    .pointer("/payload/usage/runId")
                    .and_then(Value::as_str)
                    == Some(run_id)
                && event
                    .pointer("/payload/usage/workerId")
                    .and_then(Value::as_str)
                    == Some(worker_id)
                && event
                    .pointer("/payload/usage/attemptNumber")
                    .and_then(Value::as_i64)
                    == Some(current_attempt)
        })
        && completion_base_event.is_some_and(|event| {
            event.get("runId").and_then(Value::as_str) == Some(run_id)
                && matches!(
                    event.get("type").and_then(Value::as_str),
                    Some(
                        "route-selected"
                            | "tool-call-completed"
                            | "checkpoint-created"
                            | "checkpoint-restored"
                    )
                )
        })
        && completion_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("worker-completed")
                && event.get("previousEventId").and_then(Value::as_str) == Some(usage_event_id)
                && event.pointer("/payload/workerId").and_then(Value::as_str) == Some(worker_id)
        })
        && evaluation_event.is_some_and(|event| {
            event.get("type").and_then(Value::as_str) == Some("evaluation-recorded")
                && event.get("runId").and_then(Value::as_str) == Some(run_id)
                && event.get("previousEventId").and_then(Value::as_str) == Some(completion_event_id)
                && event
                    .pointer("/payload/evaluation/target/workerId")
                    .and_then(Value::as_str)
                    == Some(worker_id)
        })
        && output.run_id == run_id
        && output.worker_id == worker_id
        && output.completion_event_id == completion_event_id
        && output.value_reference == output_reference
        && evaluation.get("evaluationKey").and_then(Value::as_str)
            == Some(expected_evaluation_key.as_str())
        && evaluation.get("verdict").and_then(Value::as_str) == Some("pass")
        && evaluation.get("recommendedAction").and_then(Value::as_str) == Some("accept")
        && criteria_match
        && !requested_model.is_empty()
        && !provider_id.is_empty()
        && !provider_route_id.is_empty()
        && token_usage.0 >= 0
        && token_usage.1 >= 0
        && output.receipt.get("requestedModel").and_then(Value::as_str) == Some(requested_model)
        && output
            .receipt
            .get("observedProvider")
            .and_then(Value::as_str)
            == Some(provider_id)
        && output
            .receipt
            .get("providerRouteId")
            .and_then(Value::as_str)
            == Some(provider_route_id);
    if !exact {
        return Err(crate::store::StoreError::Invalid(
            "Cited approval proposal no longer matches its durable facts.".into(),
        ));
    }
    Ok(CitedApprovalFacts {
        lifecycle,
        output,
        wait_key: wait_key.to_string(),
        proposal_hash: proposal_hash.to_string(),
        suffix: suffix.to_string(),
        requested_at: requested_at.to_string(),
        worker_id: worker_id.to_string(),
        worker_started_event_id: worker_started_event_id.to_string(),
        route_selected_event_id: route_selected_event_id.to_string(),
        usage_event_id: usage_event_id.to_string(),
        completion_event_id: completion_event_id.to_string(),
        evaluation_event_id: evaluation_event_id.to_string(),
        provider_id: provider_id.to_string(),
        requested_model: requested_model.to_string(),
        provider_route_id: provider_route_id.to_string(),
        token_usage,
        evaluation,
        plan_summary,
    })
}

pub(crate) fn validate_pending_cited_approval(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<()> {
    cited_approval_facts(tx, store, scope, owner_member_id, journal, None).map(|_| ())
}

fn terminal_cited_approval_decision(
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<&str> {
    let head_id = journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval terminal head is unavailable.".into())
        })?;
    let head_sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64);
    let terminal = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(head_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited approval terminal result is unavailable.".into(),
            )
        })?;
    let resolution_id = terminal
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited approval terminal resolution is unavailable.".into(),
            )
        })?;
    let resolution = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(resolution_id))
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("approval-resolved"))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited approval terminal resolution is invalid.".into(),
            )
        })?;
    let request_id = resolution
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval request is unavailable.".into())
        })?;
    let request = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(request_id))
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("approval-requested"))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval request is invalid.".into())
        })?;
    let decision = resolution
        .pointer("/payload/resolution/decision")
        .and_then(Value::as_str)
        .filter(|decision| matches!(*decision, "approved" | "denied"))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited approval decision is invalid.".into())
        })?;
    let wait_key = request
        .pointer("/payload/wait/waitKey")
        .and_then(Value::as_str);
    let proposal_hash = request
        .pointer("/payload/wait/proposalHash")
        .and_then(Value::as_str);
    let exact_resolution = wait_key.is_some()
        && proposal_hash.is_some()
        && request.get("runId").and_then(Value::as_str)
            == journal.run.get("id").and_then(Value::as_str)
        && resolution.get("runId").and_then(Value::as_str)
            == journal.run.get("id").and_then(Value::as_str)
        && request
            .get("sequence")
            .and_then(Value::as_i64)
            .is_some_and(|sequence| {
                resolution.get("sequence").and_then(Value::as_i64) == Some(sequence + 1)
            })
        && resolution
            .pointer("/payload/resolution/waitKey")
            .and_then(Value::as_str)
            == wait_key
        && resolution
            .pointer("/payload/resolution/acceptedProposalHash")
            .and_then(Value::as_str)
            == proposal_hash;
    let exact_terminal = terminal.get("sequence").and_then(Value::as_i64) == head_sequence
        && terminal.get("runId").and_then(Value::as_str)
            == journal.run.get("id").and_then(Value::as_str)
        && resolution
            .get("sequence")
            .and_then(Value::as_i64)
            .is_some_and(|sequence| {
                terminal.get("sequence").and_then(Value::as_i64) == Some(sequence + 1)
            })
        && match decision {
            "approved" => {
                journal.run.get("status").and_then(Value::as_str) == Some("completed")
                    && terminal.get("type").and_then(Value::as_str) == Some("run-completed")
                    && terminal
                        .pointer("/payload/result/outcome")
                        .and_then(Value::as_str)
                        == Some("succeeded")
            }
            "denied" => {
                journal.run.get("status").and_then(Value::as_str) == Some("partially-completed")
                    && terminal.get("type").and_then(Value::as_str) == Some("run-failed")
                    && terminal
                        .pointer("/payload/error/code")
                        .and_then(Value::as_str)
                        == Some("human-acceptance-denied")
            }
            _ => false,
        };
    if !exact_resolution || !exact_terminal {
        return Err(crate::store::StoreError::Invalid(
            "Cited approval terminal chain is invalid.".into(),
        ));
    }
    Ok(decision)
}

#[tauri::command]
pub fn mission_cited_approval_pending_list(thread_id: String) -> Result<Value, String> {
    if thread_id.trim().is_empty() || thread_id.len() > 160 {
        return Err("Cited approval conversation is invalid.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required.".into(),
                )
            })?;
            let scope = crate::store::repos::scope::DataScope::workspace(
                context.active_workspace.local_workspace_id,
            )?;
            const MAX_PENDING_APPROVALS: usize = 100;
            let candidates = mission_run::list_waiting_approval_ids(
                tx,
                &scope,
                &member,
                (MAX_PENDING_APPROVALS + 1) as i64,
            )?;
            let truncated = candidates.len() > MAX_PENDING_APPROVALS;
            let mut pending = Vec::new();
            let mut unavailable_count = 0_u64;
            for run_id in candidates.into_iter().take(MAX_PENDING_APPROVALS) {
                let journal = match mission_run::get(tx, store, &scope, &member, &run_id) {
                    Ok(Some(journal)) => journal,
                    Ok(None) => continue,
                    Err(_) => {
                        unavailable_count += 1;
                        continue;
                    }
                };
                if journal.run.get("status").and_then(Value::as_str) != Some("waiting-approval") {
                    unavailable_count += 1;
                    continue;
                }
                if journal.run.get("sourceThreadId").and_then(Value::as_str)
                    != Some(thread_id.as_str())
                {
                    continue;
                }
                let facts = match cited_approval_facts(
                    tx,
                    store,
                    &scope,
                    &member,
                    &journal,
                    Some(&thread_id),
                ) {
                    Ok(facts) => facts,
                    Err(_) => {
                        unavailable_count += 1;
                        continue;
                    }
                };
                pending.push(json!({
                    "runId":run_id,
                    "missionId":journal.run.pointer("/initiator/missionId"),
                    "waitKey":facts.wait_key,
                    "requestedAt":facts.requested_at,
                    "expectedRunRevision":journal.run.get("revision"),
                    "expectedLastSequence":journal.run.pointer("/eventHead/lastSequence"),
                    "valueReference":facts.output.value_reference,
                    "draft":facts.output.receipt.get("text"),
                    "plan":facts.plan_summary
                }));
            }
            Ok(json!({
                "approvals":pending,
                "unavailableCount":unavailable_count,
                "truncated":truncated
            }))
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_cited_approval_resolve(
    input: CitedApprovalResolveInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    if input.run_id.trim().is_empty()
        || input.run_id.len() > 160
        || !matches!(input.decision.as_str(), "approved" | "denied")
        || input.expected_run_revision < 1
        || input.expected_last_sequence < 1
    {
        return Err("Cited approval resolution is invalid.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.ok_or_else(|| {
                crate::store::StoreError::Invalid("An active workspace membership is required.".into())
            })?;
            let scope = crate::store::repos::scope::DataScope::workspace(
                context.active_workspace.local_workspace_id,
            )?;
            let journal = mission_run::get(tx, store, &scope, &member, &input.run_id)?
                .ok_or_else(|| crate::store::StoreError::Invalid("Cited approval run is unavailable.".into()))?;
            if matches!(
                journal.run.get("status").and_then(Value::as_str),
                Some("completed" | "partially-completed")
            ) {
                let exact = terminal_cited_approval_decision(&journal)
                    .is_ok_and(|decision| decision == input.decision);
                return if exact {
                    Ok(journal)
                } else {
                    Err(crate::store::StoreError::Invalid(
                        "Cited approval was already resolved differently.".into(),
                    ))
                };
            }
            if journal.run.get("revision").and_then(Value::as_i64)
                != Some(input.expected_run_revision)
                || journal
                    .run
                    .pointer("/eventHead/lastSequence")
                    .and_then(Value::as_i64)
                    != Some(input.expected_last_sequence)
            {
                return Err(crate::store::StoreError::Invalid(
                    "The cited approval changed before it could be resolved.".into(),
                ));
            }
            let facts = cited_approval_facts(tx, store, &scope, &member, &journal, None)?;
            let at = now();
            let resolved_event_id = format!("mission-approval-resolved-{}", facts.suffix);
            let resolution_key = format!("cited-acceptance-resolution:v1:{}", facts.suffix);
            let sequence = input.expected_last_sequence + 1;
            let resolution = json!({
                "waitKey":facts.wait_key,"decision":input.decision,"decidedAt":at,
                "decidedByInternalUserId":context.internal_user_id,
                "acceptedProposalHash":facts.proposal_hash
            });
            let event = json!({
                "workspaceId":scope.workspace_id(),"visibility":"member-private","ownerMemberId":member,
                "authority":"local","schemaVersion":1,"revision":1,
                "createdByInternalUserId":context.internal_user_id,"createdAt":at,"updatedAt":at,
                "id":resolved_event_id,"runId":input.run_id,"type":"approval-resolved",
                "sequence":sequence,"previousEventId":journal.run.pointer("/eventHead/lastEventId"),
                "attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
                "occurredAt":at,"actor":{"kind":"internal-user","internalUserId":context.internal_user_id,"memberId":member},
                "idempotencyKey":resolution_key,"payload":{"resolution":resolution}
            });
            let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
                crate::store::StoreError::Invalid("Cited approval run is invalid.".into())
            })?;
            projected.insert("status".into(), json!("running"));
            projected.insert("revision".into(), json!(input.expected_run_revision + 1));
            projected.insert("updatedAt".into(), json!(at));
            projected.insert(
                "eventHead".into(),
                json!({"lastSequence":sequence,"lastEventId":resolved_event_id}),
            );
            let resolved = mission_run::append(
                tx, store, &scope, &member, &input.run_id,
                input.expected_run_revision, input.expected_last_sequence,
                &resolved_event_id, "approval-resolved", &resolution_key, &event,
                &Value::Object(projected), &at,
            )?;
            mission_plan::resume_waiting(
                tx, store, &scope, &member, &facts.lifecycle, &at,
            )?;
            let mission_id = facts.lifecycle.mission.get("id").and_then(Value::as_str).ok_or_else(|| {
                crate::store::StoreError::Invalid("Cited approval mission is invalid.".into())
            })?;
            let settlement_lifecycle = mission_plan::get(tx, store, &scope, &member, mission_id)?
                .ok_or_else(|| crate::store::StoreError::Invalid("Cited approval plan is unavailable.".into()))?;
            let binding = NativeWorkerExecutionBinding {
                run_id: input.run_id.clone(),
                worker_id: facts.worker_id.clone(),
                worker_started_event_id: facts.worker_started_event_id.clone(),
                route_selected_event_id: facts.route_selected_event_id.clone(),
                usage_event_id: facts.usage_event_id.clone(),
                completion_event_id: facts.completion_event_id.clone(),
                evaluation_event_id: facts.evaluation_event_id.clone(),
                result_event_id: format!("mission-approval-result-{}", facts.suffix),
                failure_event_id: format!("mission-approval-failure-{}", facts.suffix),
                idempotency_key: format!("cited-human-settlement:v1:{}", facts.suffix),
                expected_run_revision: input.expected_run_revision + 1,
                expected_last_sequence: sequence,
                checkpoint_event_id: None,
                checkpoint_restore_event_id: None,
                tool_evidence: None,
            };
            let worker = journal.events.iter().find_map(|event| {
                (event.get("type").and_then(Value::as_str) == Some("worker-created")
                    && event.pointer("/payload/worker/id").and_then(Value::as_str)
                        == Some(facts.worker_id.as_str()))
                    .then(|| event.pointer("/payload/worker"))
                    .flatten()
            }).ok_or_else(|| crate::store::StoreError::Invalid("Cited approval worker is unavailable.".into()))?;
            append_single_worker_run_result(
                tx, store, &scope, &member, &context.internal_user_id, &resolved,
                &binding, &settlement_lifecycle, worker, &facts.output.receipt,
                &facts.output.value_reference, &facts.evaluation, Some(facts.token_usage),
                &facts.provider_id, &facts.requested_model, &facts.provider_route_id,
                input.expected_run_revision + 1, sequence, &at,
                Some(input.decision == "approved"), Some(&resolved_event_id),
            )?;
            mission_run::get(tx, store, &scope, &member, &input.run_id)?
                .ok_or_else(|| crate::store::StoreError::Invalid("Cited approval settlement is unavailable.".into()))
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_worker_cited_receipts_read(
    input: CitedReceiptReadInput,
) -> Result<Vec<Value>, String> {
    if input.thread_id.trim().is_empty()
        || input.thread_id.len() > 160
        || input.message_ids.is_empty()
        || input.message_ids.len() > MAX_CITED_RECEIPT_MESSAGES
        || input
            .message_ids
            .iter()
            .any(|id| id.trim().is_empty() || id.len() > 160)
        || input.message_ids.iter().collect::<BTreeSet<_>>().len() != input.message_ids.len()
    {
        return Err("Cited mission receipt request is invalid.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required.".into(),
                )
            })?;
            let scope = crate::store::repos::scope::DataScope::workspace(
                context.active_workspace.local_workspace_id,
            )?;
            let messages = message::list(tx, store, &scope, &input.thread_id)?;
            Ok(input
                .message_ids
                .iter()
                .map(|message_id| {
                    let receipt = messages
                        .iter()
                        .find(|candidate| candidate.id == *message_id)
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "Cited mission message is unavailable.".into(),
                            )
                        })
                        .and_then(|message| {
                            project_cited_mission_receipt(tx, store, &scope, &member, message)
                        });
                    match receipt {
                        Ok(receipt) => json!({
                            "messageId":message_id,
                            "status":"available",
                            "receipt":receipt
                        }),
                        Err(_) => json!({
                            "messageId":message_id,
                            "status":"unavailable"
                        }),
                    }
                })
                .collect())
        })
        .map_err(|error| error.to_string())
}

fn project_cited_mission_receipt(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    message: &message::MessageRow,
) -> crate::store::Result<Value> {
    let detail = message.detail.as_object().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission message detail is invalid.".into())
    })?;
    let run_id = message.run_id.as_deref().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission message run is missing.".into())
    })?;
    let mission_id = detail
        .get("missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission message identity is invalid.".into())
        })?;
    let result_event_id = detail
        .get("resultEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission result identity is invalid.".into())
        })?;
    let outcome = detail
        .get("outcome")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission outcome is invalid.".into())
        })?;
    let detail_keys = if outcome == "accepted" {
        [
            "type",
            "missionId",
            "resultEventId",
            "outcome",
            "artifactId",
            "artifactVersionId",
        ]
        .as_slice()
    } else {
        ["type", "missionId", "resultEventId", "outcome"].as_slice()
    };
    if message.kind != "assistant"
        || message.current_revision_state != "terminal"
        || message.current_revision_number != 1
        || detail.get("type").and_then(Value::as_str) != Some("mission-result")
        || !matches!(outcome, "accepted" | "partial")
        || detail.len() != detail_keys.len()
        || detail
            .keys()
            .any(|key| !detail_keys.contains(&key.as_str()))
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission message linkage is invalid.".into(),
        ));
    }
    let journal =
        mission_run::get(tx, store, scope, owner_member_id, run_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission journal is unavailable.".into())
        })?;
    let lifecycle =
        mission_plan::get(tx, store, scope, owner_member_id, mission_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission plan is unavailable.".into())
        })?;
    if journal.run.get("id").and_then(Value::as_str) != Some(run_id)
        || journal
            .run
            .pointer("/initiator/missionId")
            .and_then(Value::as_str)
            != Some(mission_id)
        || journal.run.get("sourceThreadId").and_then(Value::as_str)
            != Some(message.thread_id.as_str())
        || lifecycle
            .mission
            .pointer("/scope/sourceThreadId")
            .and_then(Value::as_str)
            != Some(message.thread_id.as_str())
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(result_event_id)
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission receipt scope is invalid.".into(),
        ));
    }
    let result_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission result is unavailable.".into())
        })?;
    let (output_reference, acceptance_summary) = match outcome {
        "accepted"
            if journal.run.get("status").and_then(Value::as_str) == Some("completed")
                && result_event.get("type").and_then(Value::as_str) == Some("run-completed") =>
        {
            (
                result_event
                    .pointer("/payload/result/outputs/0/valueReference")
                    .and_then(Value::as_str),
                result_event
                    .pointer("/payload/result/summary")
                    .and_then(Value::as_str),
            )
        }
        "partial"
            if journal.run.get("status").and_then(Value::as_str) == Some("partially-completed")
                && result_event.get("type").and_then(Value::as_str) == Some("run-failed")
                && result_event
                    .pointer("/payload/error/code")
                    .and_then(Value::as_str)
                    .is_some_and(|code| {
                        matches!(code, "policy-acceptance-failed" | "human-acceptance-denied")
                    }) =>
        {
            (
                result_event
                    .pointer("/payload/partial/completedOutputs/0/valueReference")
                    .and_then(Value::as_str),
                result_event
                    .pointer("/payload/partial/summary")
                    .and_then(Value::as_str),
            )
        }
        _ => (None, None),
    };
    let output_reference = output_reference.ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission output is unavailable.".into())
    })?;
    let acceptance_summary = acceptance_summary.ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission acceptance is unavailable.".into())
    })?;
    let output = crate::store::repos::mission_worker_output::get_by_reference(
        tx,
        store,
        scope,
        owner_member_id,
        output_reference,
    )?
    .ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission output receipt is unavailable.".into())
    })?;
    let mut evaluations = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("evaluation-recorded"))
        .filter(|event| {
            event
                .pointer("/payload/evaluation/target/workerId")
                .and_then(Value::as_str)
                == Some(output.worker_id.as_str())
        });
    let evaluation = evaluations.next().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission evaluation is unavailable.".into())
    })?;
    if evaluations.next().is_some() {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission evaluation is ambiguous.".into(),
        ));
    }
    let human_denied = result_event
        .pointer("/payload/error/code")
        .and_then(Value::as_str)
        == Some("human-acceptance-denied");
    let expected_verdict = if outcome == "accepted" || human_denied {
        "pass"
    } else {
        "fail"
    };
    if evaluation
        .pointer("/payload/evaluation/verdict")
        .and_then(Value::as_str)
        != Some(expected_verdict)
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission evaluation does not match its outcome.".into(),
        ));
    }
    validate_cited_receipt_artifact_link(
        tx,
        scope,
        owner_member_id,
        journal
            .run
            .get("createdByInternalUserId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Cited mission receipt creator is unavailable.".into(),
                )
            })?,
        detail,
        run_id,
        result_event,
        evaluation,
        &output,
        outcome,
    )?;
    let text = output
        .receipt
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission response is unavailable.".into())
        })?;
    let expected_content = if outcome == "partial" {
        format!("Draft preserved, but not accepted: {acceptance_summary}\n\n{text}")
    } else {
        text.to_string()
    };
    if message.content != json!(expected_content) {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission message does not match its durable output.".into(),
        ));
    }
    let mut routes = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("route-selected"));
    let route = routes
        .next()
        .and_then(|event| event.pointer("/payload/selection"))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission route is unavailable.".into())
        })?;
    if routes.next().is_some() {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission route is ambiguous.".into(),
        ));
    }
    let usage = select_cited_terminal_usage(&journal)?;
    if route.get("providerRouteId") != output.receipt.get("providerRouteId")
        || usage.get("providerRouteId") != route.get("providerRouteId")
        || usage.get("modelReference") != output.receipt.get("requestedModel")
        || usage.get("runId").and_then(Value::as_str) != Some(run_id)
        || usage.get("workerId").and_then(Value::as_str) != Some(output.worker_id.as_str())
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission receipt facts do not share one route.".into(),
        ));
    }
    let budget = lifecycle.mission.get("budget").ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission budget is unavailable.".into())
    })?;
    let mut receipt = json!({
        "acceptanceStatus":if outcome == "accepted"{"accepted"}else{"not-accepted"},
        "acceptanceSummary":acceptance_summary,
        "provider":output.receipt.get("observedProvider"),
        "model":output.receipt.get("requestedModel"),
        "routeReason":route.get("reason"),
        "inputTokens":usage.get("inputTokens"),
        "outputTokens":usage.get("outputTokens"),
        "toolCalls":usage.get("toolCalls"),
        "durationMs":usage.get("durationMs"),
        "attemptNumber":usage.get("attemptNumber"),
        "sourceCount":output.receipt.get("citations").and_then(Value::as_array).map(Vec::len),
        "trust":output.receipt.get("trust"),
        "maxInputTokens":budget.get("maxInputTokens"),
        "maxOutputTokens":budget.get("maxOutputTokens"),
        "maxToolCalls":budget.get("maxToolCalls"),
        "maxDurationMs":budget.get("maxDurationMs"),
        "maxAttempts":budget.get("maxAttempts")
    });
    if let Some(cost) = usage
        .get("costs")
        .and_then(Value::as_array)
        .filter(|costs| costs.len() == 1)
        .and_then(|costs| costs.first())
    {
        if let Some(object) = receipt.as_object_mut() {
            object.insert(
                "costAmount".into(),
                cost.pointer("/amount/amount")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            object.insert(
                "costCurrency".into(),
                cost.pointer("/amount/currencyCode")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            object.insert(
                "pricingReference".into(),
                cost.get("pricingReference").cloned().unwrap_or(Value::Null),
            );
        }
    }
    validate_cited_receipt_projection(&receipt)?;
    Ok(receipt)
}

fn select_cited_terminal_usage(
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<&Value> {
    let current_attempt = journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let usages = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("usage-recorded"))
        .collect::<Vec<_>>();
    let matching = usages
        .iter()
        .filter(|event| {
            event
                .pointer("/payload/usage/attemptNumber")
                .and_then(Value::as_i64)
                == Some(current_attempt)
        })
        .collect::<Vec<_>>();
    let usage = matching
        .first()
        .and_then(|event| event.pointer("/payload/usage"))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission usage is unavailable.".into())
        })?;
    let prior_usage_valid = if usages.len() == 1 {
        true
    } else {
        current_attempt == 2
            && usages.len() == 2
            && usages
                .iter()
                .filter(|event| {
                    event
                        .pointer("/payload/usage/attemptNumber")
                        .and_then(Value::as_i64)
                        == Some(1)
                })
                .count()
                == 1
            && journal.events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("retry-scheduled")
                    && event.get("attemptNumber").and_then(Value::as_i64) == Some(1)
                    && event
                        .pointer("/payload/nextAttemptNumber")
                        .and_then(Value::as_i64)
                        == Some(2)
                    && event
                        .pointer("/payload/error/retryable")
                        .and_then(Value::as_bool)
                        == Some(true)
            })
    };
    if matching.len() != 1 || !prior_usage_valid {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission usage is ambiguous.".into(),
        ));
    }
    Ok(usage)
}

#[allow(clippy::too_many_arguments)]
fn validate_cited_receipt_artifact_link(
    tx: &rusqlite::Connection,
    scope: &crate::store::repos::scope::DataScope,
    owner_member_id: &str,
    internal_user_id: &str,
    detail: &Map<String, Value>,
    run_id: &str,
    result_event: &Value,
    evaluation_event: &Value,
    output: &crate::store::repos::mission_worker_output::MissionWorkerOutputRow,
    outcome: &str,
) -> crate::store::Result<()> {
    let private = crate::store::repos::scope::PrivateDataScope::for_authenticated_user(
        scope.clone(),
        internal_user_id,
        Some(owner_member_id),
    )?;
    let result_event_id = result_event
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission result identity is invalid.".into())
        })?;
    let evaluation_event_id = evaluation_event
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited mission evaluation identity is invalid.".into(),
            )
        })?;
    if outcome == "accepted" {
        let expected = crate::store::repos::artifact::accepted_mission_output_binding(
            scope.workspace_id(),
            owner_member_id,
            run_id,
            &output.worker_id,
            &output.completion_event_id,
            &output.output_key,
            &output.content_hash,
        );
        let matches = detail.get("artifactId").and_then(Value::as_str)
            == Some(expected.artifact_id.as_str())
            && detail.get("artifactVersionId").and_then(Value::as_str)
                == Some(expected.artifact_version_id.as_str())
            && result_event
                .pointer("/payload/result/outputs/0/artifactId")
                .and_then(Value::as_str)
                == Some(expected.artifact_id.as_str())
            && result_event
                .pointer("/payload/result/outputs/0/artifactVersionId")
                .and_then(Value::as_str)
                == Some(expected.artifact_version_id.as_str());
        let source = crate::store::repos::artifact::get_mission_source_binding(
            tx,
            &private,
            owner_member_id,
            run_id,
            &output.output_key,
            &output.completion_event_id,
            evaluation_event_id,
            result_event_id,
            &output.value_reference,
            &output.content_hash,
        )?;
        if matches && source.as_ref() == Some(&expected) {
            Ok(())
        } else {
            Err(crate::store::StoreError::Invalid(
                "Cited mission artifact receipt linkage is invalid.".into(),
            ))
        }
    } else if !detail.contains_key("artifactId")
        && !detail.contains_key("artifactVersionId")
        && result_event
            .pointer("/payload/partial/completedOutputs/0/artifactId")
            .is_none()
        && result_event
            .pointer("/payload/partial/completedOutputs/0/artifactVersionId")
            .is_none()
        && !crate::store::repos::artifact::mission_source_exists(
            tx,
            &private,
            owner_member_id,
            run_id,
            &output.output_key,
        )?
    {
        Ok(())
    } else {
        Err(crate::store::StoreError::Invalid(
            "A partial cited mission cannot expose an artifact receipt.".into(),
        ))
    }
}

fn validate_cited_receipt_projection(receipt: &Value) -> crate::store::Result<()> {
    let object = receipt.as_object().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission receipt is invalid.".into())
    })?;
    const REQUIRED: [&str; 17] = [
        "acceptanceStatus",
        "acceptanceSummary",
        "provider",
        "model",
        "routeReason",
        "inputTokens",
        "outputTokens",
        "toolCalls",
        "durationMs",
        "attemptNumber",
        "sourceCount",
        "trust",
        "maxInputTokens",
        "maxOutputTokens",
        "maxToolCalls",
        "maxDurationMs",
        "maxAttempts",
    ];
    const COST: [&str; 3] = ["costAmount", "costCurrency", "pricingReference"];
    let strings_valid = [
        "acceptanceSummary",
        "provider",
        "model",
        "routeReason",
        "trust",
    ]
    .iter()
    .all(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.len() <= 2_000)
    });
    let counts_valid = [
        "inputTokens",
        "outputTokens",
        "toolCalls",
        "sourceCount",
        "durationMs",
    ]
    .iter()
    .all(|key| {
        object
            .get(*key)
            .and_then(Value::as_i64)
            .is_some_and(|value| value >= 0)
    });
    let utilization_valid = object
        .get("attemptNumber")
        .and_then(Value::as_i64)
        .is_some_and(|value| value > 0)
        && object
            .get("maxAttempts")
            .and_then(Value::as_i64)
            .is_some_and(|maximum| {
                object
                    .get("attemptNumber")
                    .and_then(Value::as_i64)
                    .is_some_and(|attempt| attempt <= maximum)
            })
        && object
            .get("durationMs")
            .and_then(Value::as_i64)
            .zip(object.get("maxDurationMs").and_then(Value::as_i64))
            .is_some_and(|(duration, maximum)| duration <= maximum);
    let limits_valid = [
        "maxInputTokens",
        "maxOutputTokens",
        "maxToolCalls",
        "maxDurationMs",
        "maxAttempts",
    ]
    .iter()
    .all(|key| {
        object
            .get(*key)
            .and_then(Value::as_i64)
            .is_some_and(|value| value > 0)
    });
    let cost_count = COST.iter().filter(|key| object.contains_key(**key)).count();
    let cost_valid = cost_count == 0
        || (cost_count == COST.len()
            && COST.iter().all(|key| {
                object
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty() && value.len() <= 1_000)
            }));
    let exact_keys = object.len() == REQUIRED.len() + cost_count
        && object
            .keys()
            .all(|key| REQUIRED.contains(&key.as_str()) || COST.contains(&key.as_str()));
    if exact_keys
        && strings_valid
        && counts_valid
        && utilization_valid
        && limits_valid
        && cost_valid
        && matches!(
            object.get("acceptanceStatus").and_then(Value::as_str),
            Some("accepted" | "not-accepted")
        )
    {
        Ok(())
    } else {
        Err(crate::store::StoreError::Invalid(
            "Cited mission receipt projection is invalid.".into(),
        ))
    }
}

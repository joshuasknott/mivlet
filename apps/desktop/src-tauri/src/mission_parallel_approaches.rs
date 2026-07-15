use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::store::repos::{
    artifact, message, mission_plan, mission_run, mission_worker_output,
    scope::{DataScope, PrivateDataScope},
    thread, workspace_directory,
};

const MARKER: &str = "native:parallel-approaches:v1";
const JOIN_KEY_PREFIX: &str = "parallel-approaches-join:v1:";
const OUTPUT_KEY: &str = "comparison";
const CANCELLED_TEXT: &str =
    "This parallel mission was cancelled. No comparison artifact was created.";
const WORKER_STEPS: [(&str, &str); 2] =
    [("approach-a", "approach-a"), ("approach-b", "approach-b")];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParallelApproachesJoinOpenInput {
    run_id: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParallelApproachesFinalizeResult {
    mission_id: String,
    run_id: String,
    outcome: String,
    text: String,
    artifact_id: Option<String>,
    artifact_version_id: Option<String>,
    journal: mission_run::MissionRunJournalRow,
}

#[tauri::command]
pub fn mission_parallel_approaches_join_open(
    input: ParallelApproachesJoinOpenInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    bounded(&input.run_id, "Mission run", 200)?;
    if input.expected_run_revision < 1 || input.expected_last_sequence < 1 {
        return Err("Parallel mission event head is invalid.".into());
    }
    let identity = crate::clerk_identity::native_identity_generation_snapshot()?;
    let _guard = crate::clerk_identity::lock_native_identity_generation(&identity)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = authorized(tx)?;
            let journal = mission_run::get(tx, store, &auth.scope, &auth.member_id, &input.run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Parallel mission run is unavailable.".into())
                })?;
            let lifecycle = lifecycle_for_journal(tx, store, &auth, &journal)?;
            let shape = validate_shape(tx, store, &auth, &journal, &lifecycle)?;
            let join_key = join_key(&input.run_id);
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("type").and_then(Value::as_str) == Some("join-opened")
                    && event
                        .pointer("/payload/join/joinKey")
                        .and_then(Value::as_str)
                        == Some(join_key.as_str())
            }) {
                validate_open_join(existing, &shape.worker_ids, &join_key)?;
                return Ok(journal);
            }
            if journal.run.get("status").and_then(Value::as_str) != Some("running")
                || required_i64(&journal.run, "revision")? != input.expected_run_revision
                || journal
                    .run
                    .pointer("/eventHead/lastSequence")
                    .and_then(Value::as_i64)
                    != Some(input.expected_last_sequence)
                || shape.worker_ids.len() != 2
            {
                return Err(crate::store::StoreError::Invalid(
                    "Parallel mission changed before its join could open.".into(),
                ));
            }
            for worker_id in &shape.worker_ids {
                let started = journal.events.iter().any(|event| {
                    event.get("type").and_then(Value::as_str) == Some("worker-started")
                        && event.pointer("/payload/workerId").and_then(Value::as_str)
                            == Some(worker_id.as_str())
                });
                let routed = journal.events.iter().any(|event| {
                    event.get("type").and_then(Value::as_str) == Some("route-selected")
                        && event.pointer("/payload/workerId").and_then(Value::as_str)
                            == Some(worker_id.as_str())
                });
                let terminal = worker_terminal(&journal, worker_id).is_some();
                if !started || !routed || terminal {
                    return Err(crate::store::StoreError::Invalid(
                        "A parallel join requires two started, routed, nonterminal workers.".into(),
                    ));
                }
            }
            let at = now();
            let event_id = format!("parallel-join-open-{}", suffix(&join_key));
            let idempotency_key = format!("parallel-join-open:v1:{}", suffix(&join_key));
            let event = event_envelope(
                &journal,
                &auth,
                &event_id,
                "join-opened",
                input.expected_last_sequence + 1,
                journal
                    .run
                    .pointer("/eventHead/lastEventId")
                    .and_then(Value::as_str),
                &idempotency_key,
                json!({"join":{
                    "joinKey":join_key,"status":"open","strategy":"all",
                    "workerIds":shape.worker_ids,"allowFailedWorkers":false,
                    "satisfiedWorkerIds":[],"failedWorkerIds":[]
                }}),
                &at,
            )?;
            let projected = project_head(
                &journal.run,
                &event_id,
                input.expected_last_sequence + 1,
                &at,
            )?;
            mission_run::append(
                tx,
                store,
                &auth.scope,
                &auth.member_id,
                &input.run_id,
                input.expected_run_revision,
                input.expected_last_sequence,
                &event_id,
                "join-opened",
                &idempotency_key,
                &event,
                &projected,
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_parallel_approaches_finalize(
    run_id: String,
) -> Result<ParallelApproachesFinalizeResult, String> {
    bounded(&run_id, "Mission run", 200)?;
    let identity = crate::clerk_identity::native_identity_generation_snapshot()?;
    let _guard = crate::clerk_identity::lock_native_identity_generation(&identity)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| finalize_in_tx(tx, store, &run_id))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_parallel_approaches_recover_completed(
) -> Result<Vec<ParallelApproachesFinalizeResult>, String> {
    let identity = crate::clerk_identity::native_identity_generation_snapshot()?;
    let _guard = crate::clerk_identity::lock_native_identity_generation(&identity)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = authorized(tx)?;
            let ids = mission_run::list_nonterminal_ids(tx, &auth.scope, &auth.member_id)?;
            let mut eligible = Vec::new();
            for run_id in ids {
                if eligible.len() >= 50 {
                    break;
                }
                let Some(journal) =
                    mission_run::get(tx, store, &auth.scope, &auth.member_id, &run_id)?
                else {
                    continue;
                };
                let Ok(lifecycle) = lifecycle_for_journal(tx, store, &auth, &journal) else {
                    continue;
                };
                let Ok(shape) = validate_shape(tx, store, &auth, &journal, &lifecycle) else {
                    continue;
                };
                if shape
                    .worker_ids
                    .iter()
                    .all(|worker_id| worker_terminal(&journal, worker_id).is_some())
                {
                    eligible.push(run_id);
                }
            }
            eligible
                .into_iter()
                .map(|run_id| finalize_in_tx(tx, store, &run_id))
                .collect()
        })
        .map_err(|error| error.to_string())
}

fn finalize_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    run_id: &str,
) -> crate::store::Result<ParallelApproachesFinalizeResult> {
    let auth = authorized(tx)?;
    let journal =
        mission_run::get(tx, store, &auth.scope, &auth.member_id, run_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel mission run is unavailable.".into())
        })?;
    let lifecycle = lifecycle_for_journal(tx, store, &auth, &journal)?;
    let shape = validate_shape(tx, store, &auth, &journal, &lifecycle)?;
    if is_terminal(&journal.run) {
        return validate_terminal_replay(tx, store, &auth, journal, lifecycle, shape);
    }
    let join_key = join_key(run_id);
    let opened = journal
        .events
        .iter()
        .find(|event| {
            event.get("type").and_then(Value::as_str) == Some("join-opened")
                && event
                    .pointer("/payload/join/joinKey")
                    .and_then(Value::as_str)
                    == Some(join_key.as_str())
        })
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel mission join is not open.".into())
        })?;
    validate_open_join(opened, &shape.worker_ids, &join_key)?;
    if journal
        .events
        .iter()
        .any(|event| event.get("type").and_then(Value::as_str) == Some("join-resolved"))
    {
        return Err(crate::store::StoreError::Invalid(
            "Parallel mission has a detached join resolution.".into(),
        ));
    }

    let mut completed = Vec::new();
    let mut failed = Vec::new();
    for (step_key, worker_id) in WORKER_STEPS.iter().zip(shape.worker_ids.iter()) {
        match worker_terminal(&journal, worker_id) {
            Some(WorkerTerminal::Completed(event)) => {
                completed.push(load_worker_output(
                    tx, store, &auth, &journal, worker_id, step_key.1, event,
                )?);
            }
            Some(WorkerTerminal::Failed) => failed.push(worker_id.clone()),
            None => {
                return Err(crate::store::StoreError::Invalid(
                    "Parallel mission is still waiting for a worker.".into(),
                ))
            }
        }
    }
    let at = now();
    let current_revision = required_i64(&journal.run, "revision")?;
    let current_sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel mission head is invalid.".into())
        })?;
    let resolved_id = format!("parallel-join-resolved-{}", suffix(&join_key));
    let resolved_key = format!("parallel-join-resolved:v1:{}", suffix(&join_key));
    let satisfied_ids = completed
        .iter()
        .map(|output| output.worker_id.clone())
        .collect::<Vec<_>>();
    let resolution_status = if failed.is_empty() {
        "satisfied"
    } else {
        "cancelled"
    };
    let resolved_event = event_envelope(
        &journal,
        &auth,
        &resolved_id,
        "join-resolved",
        current_sequence + 1,
        journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str),
        &resolved_key,
        json!({"join":{
            "joinKey":join_key,"status":resolution_status,"strategy":"all",
            "workerIds":shape.worker_ids,"allowFailedWorkers":false,
            "satisfiedWorkerIds":satisfied_ids,"failedWorkerIds":failed
        }}),
        &at,
    )?;
    let resolved_projection = project_head(&journal.run, &resolved_id, current_sequence + 1, &at)?;
    let after_join = mission_run::append(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        run_id,
        current_revision,
        current_sequence,
        &resolved_id,
        "join-resolved",
        &resolved_key,
        &resolved_event,
        &resolved_projection,
        &at,
    )?;

    if !failed.is_empty() {
        return finalize_failure(
            tx,
            store,
            &auth,
            &lifecycle,
            after_join,
            shape,
            completed,
            &resolved_id,
            &at,
        );
    }
    finalize_success(
        tx,
        store,
        &auth,
        &lifecycle,
        after_join,
        shape,
        completed,
        &resolved_id,
        &at,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_success(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: mission_run::MissionRunJournalRow,
    shape: ParallelShape,
    outputs: Vec<WorkerOutput>,
    join_event_id: &str,
    at: &str,
) -> crate::store::Result<ParallelApproachesFinalizeResult> {
    if outputs.len() != 2 {
        return Err(crate::store::StoreError::Invalid(
            "Parallel mission aggregate is incomplete.".into(),
        ));
    }
    let text = render_comparison(&shape.topic, &outputs);
    let content_hash = digest(&text);
    let binding = artifact::direct_mission_output_binding(
        auth.scope.workspace_id(),
        &auth.member_id,
        &shape.run_id,
        join_event_id,
        OUTPUT_KEY,
        &content_hash,
    );
    let result_event_id = format!("parallel-run-completed-{}", suffix(join_event_id));
    let output = json!({
        "key":OUTPUT_KEY,"summary":"Deterministic comparison of two independent approaches",
        "valueReference":format!("sha256:{content_hash}"),
        "artifactId":binding.artifact_id,"artifactVersionId":binding.artifact_version_id
    });
    let acceptance = json!([{
        "criterionKey":"both-approaches","status":"met",
        "evidenceRefs":outputs.iter().map(|output| output.value_reference.clone()).collect::<Vec<_>>(),
        "summary":"Both independently generated worker outputs reached the exact durable join."
    }]);
    let usage = journal
        .events
        .iter()
        .filter_map(|event| {
            (event.get("type").and_then(Value::as_str) == Some("usage-recorded"))
                .then(|| event.pointer("/payload/usage").cloned())
                .flatten()
        })
        .collect::<Vec<_>>();
    let result = json!({
        "outcome":"succeeded","summary":"Two independent approaches were joined into one comparison.",
        "outputs":[output.clone()],"acceptance":acceptance,"evaluations":[],"usage":usage,"completedAt":at
    });
    let terminal = append_terminal(
        tx,
        store,
        auth,
        &journal,
        &result_event_id,
        "run-completed",
        json!({"result":result.clone()}),
        "completed",
        Some(result.clone()),
        at,
    )?;
    let private = PrivateDataScope::for_authenticated_user(
        auth.scope.clone(),
        &auth.internal_user_id,
        Some(&auth.member_id),
    )?;
    let worker_refs = outputs
        .iter()
        .map(|output| artifact::DirectMissionWorkerOutputReference {
            worker_id: &output.worker_id,
            completion_event_id: &output.completion_event_id,
            output_key: &output.output_key,
            value_reference: &output.value_reference,
            content_hash: &output.content_hash,
        })
        .collect::<Vec<_>>();
    artifact::create_direct_mission_aggregate_output(
        tx,
        store,
        &private,
        &auth.member_id,
        &shape.run_id,
        join_event_id,
        &result_event_id,
        OUTPUT_KEY,
        &comparison_title(&shape.topic),
        &text,
        &binding,
        &worker_refs,
    )?;
    append_transcript(
        tx,
        store,
        auth,
        &shape,
        &terminal,
        &text,
        Some(&binding),
        &result_event_id,
        "completed",
        at,
    )?;
    let current = mission_plan::get(tx, store, &auth.scope, &auth.member_id, &shape.mission_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Parallel mission disappeared.".into()))?;
    let mission_result = json!({
        "outcome":"succeeded","summary":"Two independent approaches were joined into one comparison.",
        "producingRunIds":[shape.run_id],"outputs":[output],"acceptance":acceptance,"completedAt":at
    });
    mission_plan::mark_completed(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        &current,
        &mission_result,
        at,
    )?;
    let _ = lifecycle;
    Ok(ParallelApproachesFinalizeResult {
        mission_id: shape.mission_id,
        run_id: shape.run_id,
        outcome: "completed".into(),
        text,
        artifact_id: Some(binding.artifact_id),
        artifact_version_id: Some(binding.artifact_version_id),
        journal: terminal,
    })
}

#[allow(clippy::too_many_arguments)]
fn finalize_failure(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    _lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: mission_run::MissionRunJournalRow,
    shape: ParallelShape,
    completed: Vec<WorkerOutput>,
    join_event_id: &str,
    at: &str,
) -> crate::store::Result<ParallelApproachesFinalizeResult> {
    let partial = !completed.is_empty();
    let text = if partial {
        "One approach completed, but Fable did not create a comparison because the second worker failed. The completed worker output remains preserved in the run.".to_string()
    } else {
        "Fable could not produce either approach, so no comparison artifact was created."
            .to_string()
    };
    let error = json!({
        "code":"parallel-worker-failed","category":"provider","message":"At least one required parallel worker failed.","retryable":false,
        "causedByEventId":join_event_id
    });
    let partial_value = partial.then(|| json!({
        "summary":"One independent approach is preserved without a comparison artifact.",
        "completedOutputs":completed.iter().map(|output| json!({
            "key":output.output_key,"summary":"Completed independent approach","valueReference":output.value_reference
        })).collect::<Vec<_>>(),
        "remainingWork":["Generate the missing independent approach and complete a new join."],
        "acceptance":[{"criterionKey":"both-approaches","status":"partially-met",
            "evidenceRefs":completed.iter().map(|output| output.value_reference.clone()).collect::<Vec<_>>(),
            "summary":"Only one required worker output reached the join."}],
        "recoverable":true,"recommendedNextAction":"retry"
    }));
    let result_event_id = format!("parallel-run-failed-{}", suffix(join_event_id));
    let payload = json!({"error":error,"partial":partial_value});
    let terminal = append_terminal(
        tx,
        store,
        auth,
        &journal,
        &result_event_id,
        "run-failed",
        payload,
        if partial {
            "partially-completed"
        } else {
            "failed"
        },
        None,
        at,
    )?;
    append_transcript(
        tx,
        store,
        auth,
        &shape,
        &terminal,
        &text,
        None,
        &result_event_id,
        if partial { "partial" } else { "failed" },
        at,
    )?;
    let current = mission_plan::get(tx, store, &auth.scope, &auth.member_id, &shape.mission_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Parallel mission disappeared.".into()))?;
    if partial {
        let mission_result = json!({
            "outcome":"partial","summary":"One approach completed; no comparison artifact was created.",
            "producingRunIds":[shape.run_id],"outputs":[],
            "acceptance":[{"criterionKey":"both-approaches","status":"partially-met","evidenceRefs":[]}],
            "partial":partial_value,"completedAt":at
        });
        mission_plan::mark_partially_completed(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &current,
            &mission_result,
            at,
        )?;
    } else {
        let mission_result = json!({
            "outcome":"failed","summary":"Neither required approach completed.",
            "producingRunIds":[shape.run_id],"outputs":[],
            "acceptance":[{"criterionKey":"both-approaches","status":"not-met","evidenceRefs":[]}],
            "completedAt":at
        });
        mission_plan::mark_failed(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &current,
            &mission_result,
            at,
        )?;
    }
    Ok(ParallelApproachesFinalizeResult {
        mission_id: shape.mission_id,
        run_id: shape.run_id,
        outcome: if partial { "partial" } else { "failed" }.into(),
        text,
        artifact_id: None,
        artifact_version_id: None,
        journal: terminal,
    })
}

fn validate_terminal_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    journal: mission_run::MissionRunJournalRow,
    lifecycle: mission_plan::MissionPlanLifecycleRow,
    shape: ParallelShape,
) -> crate::store::Result<ParallelApproachesFinalizeResult> {
    let terminal = journal.events.last().ok_or_else(|| {
        crate::store::StoreError::Invalid("Parallel terminal event is unavailable.".into())
    })?;
    let event_type = terminal.get("type").and_then(Value::as_str);
    if event_type == Some("run-cancelled") {
        append_cancelled_transcript(tx, store, &journal)?;
        if lifecycle.mission.get("status").and_then(Value::as_str) != Some("cancelled") {
            return Err(crate::store::StoreError::Invalid(
                "Parallel cancellation replay is incomplete.".into(),
            ));
        }
        return Ok(ParallelApproachesFinalizeResult {
            mission_id: shape.mission_id,
            run_id: shape.run_id,
            outcome: "cancelled".into(),
            text: CANCELLED_TEXT.into(),
            artifact_id: None,
            artifact_version_id: None,
            journal,
        });
    }
    if event_type == Some("run-completed") {
        let join_id = terminal
            .get("previousEventId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Parallel result join link is invalid.".into())
            })?;
        let mut outputs = Vec::new();
        for (step, worker_id) in WORKER_STEPS.iter().zip(shape.worker_ids.iter()) {
            let event = match worker_terminal(&journal, worker_id) {
                Some(WorkerTerminal::Completed(event)) => event,
                _ => {
                    return Err(crate::store::StoreError::Invalid(
                        "Parallel terminal worker evidence is incomplete.".into(),
                    ))
                }
            };
            outputs.push(load_worker_output(
                tx, store, auth, &journal, worker_id, step.1, event,
            )?);
        }
        let text = render_comparison(&shape.topic, &outputs);
        let content_hash = digest(&text);
        let binding = artifact::direct_mission_output_binding(
            auth.scope.workspace_id(),
            &auth.member_id,
            &shape.run_id,
            join_id,
            OUTPUT_KEY,
            &content_hash,
        );
        let private = PrivateDataScope::for_authenticated_user(
            auth.scope.clone(),
            &auth.internal_user_id,
            Some(&auth.member_id),
        )?;
        artifact::validate_direct_mission_artifact_bundle(
            tx,
            store,
            &private,
            &binding,
            &content_hash,
        )?;
        let bundle =
            artifact::get_bundle(tx, store, &private, &binding.artifact_id)?.ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Parallel aggregate artifact is unavailable.".into(),
                )
            })?;
        let inputs = bundle
            .pointer("/currentVersion/inputs")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Parallel aggregate inputs are unavailable.".into(),
                )
            })?;
        if inputs.len() != outputs.len() + 1
            || inputs[0].get("referenceId").and_then(Value::as_str) != Some(join_id)
            || outputs.iter().enumerate().any(|(index, output)| {
                inputs[index + 1].get("referenceId").and_then(Value::as_str)
                    != Some(output.value_reference.as_str())
                    || inputs[index + 1]
                        .pointer("/contentHash/value")
                        .and_then(Value::as_str)
                        != Some(output.content_hash.as_str())
            })
        {
            return Err(crate::store::StoreError::Invalid(
                "Parallel aggregate no longer names both immutable worker outputs.".into(),
            ));
        }
        validate_transcript(
            tx,
            store,
            auth,
            &shape,
            &text,
            Some(&binding),
            required(terminal, "id")?,
            "completed",
            required(terminal, "occurredAt")?,
        )?;
        if lifecycle.mission.get("status").and_then(Value::as_str) != Some("completed")
            || terminal
                .pointer("/payload/result/outputs/0/artifactId")
                .and_then(Value::as_str)
                != Some(binding.artifact_id.as_str())
        {
            return Err(crate::store::StoreError::Invalid(
                "Parallel terminal replay is incomplete.".into(),
            ));
        }
        return Ok(ParallelApproachesFinalizeResult {
            mission_id: shape.mission_id,
            run_id: shape.run_id,
            outcome: "completed".into(),
            text,
            artifact_id: Some(binding.artifact_id),
            artifact_version_id: Some(binding.artifact_version_id),
            journal,
        });
    }
    if !matches!(event_type, Some("run-failed")) {
        return Err(crate::store::StoreError::Invalid(
            "Parallel terminal replay is not supported.".into(),
        ));
    }
    let partial = journal.run.get("status").and_then(Value::as_str) == Some("partially-completed");
    let text = if partial {
        "One approach completed, but Fable did not create a comparison because the second worker failed. The completed worker output remains preserved in the run."
    } else {
        "Fable could not produce either approach, so no comparison artifact was created."
    }.to_string();
    validate_transcript(
        tx,
        store,
        auth,
        &shape,
        &text,
        None,
        required(terminal, "id")?,
        if partial { "partial" } else { "failed" },
        required(terminal, "occurredAt")?,
    )?;
    Ok(ParallelApproachesFinalizeResult {
        mission_id: shape.mission_id,
        run_id: shape.run_id,
        outcome: if partial { "partial" } else { "failed" }.into(),
        text,
        artifact_id: None,
        artifact_version_id: None,
        journal,
    })
}

pub(crate) fn append_cancelled_transcript(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<()> {
    if journal.run.get("status").and_then(Value::as_str) != Some("cancelled") {
        return Err(crate::store::StoreError::Invalid(
            "Parallel cancellation transcript requires a cancelled run.".into(),
        ));
    }
    let auth = authorized(tx)?;
    let lifecycle = lifecycle_for_journal(tx, store, &auth, journal)?;
    let shape = validate_shape(tx, store, &auth, journal, &lifecycle)?;
    let terminal = journal
        .events
        .last()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("run-cancelled")
                && event.get("id").and_then(Value::as_str)
                    == journal
                        .run
                        .pointer("/eventHead/lastEventId")
                        .and_then(Value::as_str)
        })
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel cancellation event is unavailable.".into())
        })?;
    append_transcript(
        tx,
        store,
        &auth,
        &shape,
        journal,
        CANCELLED_TEXT,
        None,
        required(terminal, "id")?,
        "cancelled",
        required(terminal, "occurredAt")?,
    )
}

struct Authorized {
    scope: DataScope,
    member_id: String,
    internal_user_id: String,
}

fn authorized(tx: &rusqlite::Connection) -> crate::store::Result<Authorized> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let member_id = context.member_id.ok_or_else(|| {
        crate::store::StoreError::Invalid("An active workspace membership is required.".into())
    })?;
    Ok(Authorized {
        scope: DataScope::workspace(context.active_workspace.local_workspace_id)?,
        member_id,
        internal_user_id: context.internal_user_id,
    })
}

struct ParallelShape {
    mission_id: String,
    run_id: String,
    source_thread_id: String,
    topic: String,
    worker_ids: Vec<String>,
    plan_summary: Value,
}

fn lifecycle_for_journal(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<mission_plan::MissionPlanLifecycleRow> {
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel mission identity is unavailable.".into())
        })?;
    mission_plan::get(tx, store, &auth.scope, &auth.member_id, mission_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid("Parallel mission plan is unavailable.".into())
    })
}

fn validate_shape(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
) -> crate::store::Result<ParallelShape> {
    let constraints = lifecycle
        .mission
        .get("constraints")
        .and_then(Value::as_array);
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array);
    let topic = lifecycle
        .current_revision
        .get("summary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.chars().count() <= 2_000)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel mission topic is invalid.".into())
        })?;
    let mission_id = required(&lifecycle.mission, "id")?.to_string();
    let run_id = required(&journal.run, "id")?.to_string();
    let source_thread_id = required(&journal.run, "sourceThreadId")?.to_string();
    if journal.run.get("planRevisionId") != lifecycle.current_revision.get("id")
        || journal
            .run
            .pointer("/initiator/missionId")
            .and_then(Value::as_str)
            != Some(mission_id.as_str())
        || constraints.is_none_or(|items| {
            items.len() != 1
                || items[0].get("key").and_then(Value::as_str) != Some(MARKER)
                || items[0].get("severity").and_then(Value::as_str) != Some("required")
                || items[0].get("source").and_then(Value::as_str) != Some("orchestrator")
        })
        || !valid_parallel_plan_contract(lifecycle)
        || steps.is_none_or(|items| {
            items.len() != 3
                || items[0].get("key").and_then(Value::as_str) != Some("approach-a")
                || items[1].get("key").and_then(Value::as_str) != Some("approach-b")
                || items[2].get("key").and_then(Value::as_str) != Some("compare")
                || items[0]
                    .get("dependsOnStepKeys")
                    .and_then(Value::as_array)
                    .is_none_or(|deps| !deps.is_empty())
                || items[1]
                    .get("dependsOnStepKeys")
                    .and_then(Value::as_array)
                    .is_none_or(|deps| !deps.is_empty())
                || items[2]
                    .get("dependsOnStepKeys")
                    .and_then(Value::as_array)
                    .is_none_or(|deps| {
                        deps.iter().filter_map(Value::as_str).collect::<Vec<_>>()
                            != vec!["approach-a", "approach-b"]
                    })
        })
    {
        return Err(crate::store::StoreError::Invalid(
            "Parallel mission durable shape is invalid.".into(),
        ));
    }
    let thread = thread::get(tx, store, &auth.scope, &source_thread_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "Parallel mission source conversation is unavailable.".into(),
        )
    })?;
    let owns_thread: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM thread WHERE workspace_id=?1 AND id=?2
          AND authority='local' AND visibility='member-private' AND deleted_at IS NULL
          AND owner_member_id=?3)",
        rusqlite::params![auth.scope.workspace_id(), source_thread_id, auth.member_id],
        |row| row.get(0),
    )?;
    if !owns_thread
        || thread.lifecycle != "active"
        || thread.project_id.as_deref() != journal.run.get("projectId").and_then(Value::as_str)
    {
        return Err(crate::store::StoreError::Invalid(
            "Parallel mission source scope changed.".into(),
        ));
    }
    let created_worker_count = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
        .count();
    if created_worker_count != WORKER_STEPS.len() {
        return Err(crate::store::StoreError::Invalid(
            "Parallel mission worker assignments are invalid.".into(),
        ));
    }
    let plan_revision_id = required(&lifecycle.current_revision, "id")?;
    let mut worker_ids: Vec<String> = Vec::new();
    for (step_key, output_key) in WORKER_STEPS {
        let workers = journal
            .events
            .iter()
            .filter_map(|event| {
                (event.get("type").and_then(Value::as_str) == Some("worker-created")
                    && event
                        .pointer("/payload/worker/planStepKey")
                        .and_then(Value::as_str)
                        == Some(step_key))
                .then(|| event.pointer("/payload/worker"))
                .flatten()
            })
            .collect::<Vec<_>>();
        let worker_id = workers
            .first()
            .and_then(|worker| worker.get("id"))
            .and_then(Value::as_str);
        if workers.len() != 1
            || worker_id.is_none()
            || !valid_worker_assignment(workers[0], &run_id, plan_revision_id, step_key, output_key)
            || worker_ids
                .iter()
                .any(|existing| Some(existing.as_str()) == worker_id)
        {
            return Err(crate::store::StoreError::Invalid(
                "Parallel mission worker assignments are invalid.".into(),
            ));
        }
        worker_ids.push(worker_id.unwrap().to_string());
    }
    let step_values = steps.unwrap();
    let first_budget = step_values[0]
        .get("estimatedBudget")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mission_budget = lifecycle
        .mission
        .get("budget")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let plan_summary = json!({
        "title":"Compare two approaches",
        "summary":"Two independent workers develop distinct approaches; Fable joins their immutable outputs in a fixed order.",
        "executionLabel":"Two workers · deterministic join",
        "steps":[
            {"title":"Practical approach","objective":step_values[0].get("objective"),"output":"Required Markdown approach"},
            {"title":"Alternative approach","objective":step_values[1].get("objective"),"output":"Required Markdown approach"},
            {"title":"Compare","objective":"Join both exact outputs without asking another model to reinterpret them.","output":"Draft comparison artifact"}
        ],
        "acceptance":["Both independently generated outputs must reach the durable all-workers join."],
        "budget":{
            "maxWorkers":mission_budget.get("maxWorkers"),
            "maxDurationMs":first_budget.get("maxDurationMs"),
            "maxOutputTokens":first_budget.get("maxOutputTokens"),
            "maxAttempts":first_budget.get("maxAttempts")
        }
    });
    Ok(ParallelShape {
        mission_id,
        run_id,
        source_thread_id,
        topic: topic.trim().into(),
        worker_ids,
        plan_summary,
    })
}

fn valid_worker_assignment(
    worker: &Value,
    run_id: &str,
    plan_revision_id: &str,
    step_key: &str,
    output_key: &str,
) -> bool {
    let slots = worker
        .pointer("/outputContract/slots")
        .and_then(Value::as_array);
    worker
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && value.len() <= 200)
        && worker.get("runId").and_then(Value::as_str) == Some(run_id)
        && worker.get("planRevisionId").and_then(Value::as_str) == Some(plan_revision_id)
        && worker.get("planStepKey").and_then(Value::as_str) == Some(step_key)
        && worker
            .pointer("/role/objective")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 4_000)
        && ["tools", "context", "capabilityIds", "capabilityGrantIds"]
            .iter()
            .all(|key| {
                worker
                    .get(*key)
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
            })
        && worker
            .pointer("/outputContract/includeEvidence")
            .and_then(Value::as_bool)
            == Some(false)
        && worker
            .pointer("/outputContract/delivery")
            .and_then(Value::as_str)
            == Some("run-result")
        && slots.is_some_and(|slots| {
            slots.len() == 1
                && slots[0].get("key").and_then(Value::as_str) == Some(output_key)
                && slots[0].get("required").and_then(Value::as_bool) == Some(true)
                && slots[0].get("format").and_then(Value::as_str) == Some("text/markdown")
        })
}

fn exact_strings(value: &Value, key: &str, expected: &[&str]) -> bool {
    value
        .get(key)
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>() == expected)
}

fn exact_step(
    step: &Value,
    key: &str,
    kind: &str,
    dependencies: &[&str],
    output_key: &str,
    criteria: &[&str],
    budget: (i64, i64, i64, i64, i64),
) -> bool {
    let output = step
        .get("expectedOutputs")
        .and_then(Value::as_array)
        .filter(|items| items.len() == 1)
        .and_then(|items| items.first());
    step.get("key").and_then(Value::as_str) == Some(key)
        && step.get("kind").and_then(Value::as_str) == Some(kind)
        && step
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 200)
        && step
            .get("objective")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.chars().count() <= 4_000)
        && exact_strings(step, "dependsOnStepKeys", dependencies)
        && exact_strings(step, "requiredCapabilities", &[])
        && exact_strings(step, "acceptanceCriterionKeys", criteria)
        && step.get("optional").and_then(Value::as_bool) == Some(false)
        && output.is_some_and(|output| {
            output.get("key").and_then(Value::as_str) == Some(output_key)
                && output.get("required").and_then(Value::as_bool) == Some(true)
                && output.get("format").and_then(Value::as_str) == Some("text/markdown")
        })
        && step
            .pointer("/estimatedBudget/maxDurationMs")
            .and_then(Value::as_i64)
            == Some(budget.0)
        && step
            .pointer("/estimatedBudget/maxInputTokens")
            .and_then(Value::as_i64)
            == Some(budget.1)
        && step
            .pointer("/estimatedBudget/maxOutputTokens")
            .and_then(Value::as_i64)
            == Some(budget.2)
        && step
            .pointer("/estimatedBudget/maxToolCalls")
            .and_then(Value::as_i64)
            == Some(budget.3)
        && step
            .pointer("/estimatedBudget/maxAttempts")
            .and_then(Value::as_i64)
            == Some(budget.4)
}

pub(crate) fn valid_parallel_plan_contract(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
) -> bool {
    let mission = &lifecycle.mission;
    let revision = &lifecycle.current_revision;
    let constraints = mission.get("constraints").and_then(Value::as_array);
    let Some(steps) = revision.get("steps").and_then(Value::as_array) else {
        return false;
    };
    let acceptance = mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array);
    constraints.is_some_and(|items| {
        items.len() == 1
            && items[0].get("key").and_then(Value::as_str) == Some(MARKER)
            && items[0].get("severity").and_then(Value::as_str) == Some("required")
            && items[0].get("source").and_then(Value::as_str) == Some("orchestrator")
    }) && mission.get("executionDepth").and_then(Value::as_str) == Some("multi-worker")
        && mission
            .pointer("/budget/maxWorkers")
            .and_then(Value::as_i64)
            == Some(2)
        && mission
            .pointer("/budget/maxAttempts")
            .and_then(Value::as_i64)
            == Some(1)
        && mission
            .pointer("/acceptance/requiresHumanAcceptance")
            .and_then(Value::as_bool)
            == Some(false)
        && mission
            .pointer("/acceptance/minimumRequiredCriteria")
            .and_then(Value::as_i64)
            == Some(1)
        && acceptance.is_some_and(|criteria| {
            criteria.len() == 1
                && criteria[0].get("key").and_then(Value::as_str) == Some("both-approaches")
                && criteria[0].get("required").and_then(Value::as_bool) == Some(true)
                && criteria[0].get("evaluator").and_then(Value::as_str) == Some("policy")
        })
        && revision.pointer("/bounds/maxSteps").and_then(Value::as_i64) == Some(3)
        && revision
            .pointer("/bounds/maxDependenciesPerStep")
            .and_then(Value::as_i64)
            == Some(2)
        && revision
            .pointer("/bounds/maxParallelSteps")
            .and_then(Value::as_i64)
            == Some(2)
        && revision
            .pointer("/bounds/maxRevisions")
            .and_then(Value::as_i64)
            == Some(1)
        && steps.len() == 3
        && exact_step(
            &steps[0],
            "approach-a",
            "produce",
            &[],
            "approach-a",
            &[],
            (90_000, 16_000, 2_048, 1, 1),
        )
        && exact_step(
            &steps[1],
            "approach-b",
            "produce",
            &[],
            "approach-b",
            &[],
            (90_000, 16_000, 2_048, 1, 1),
        )
        && exact_step(
            &steps[2],
            "compare",
            "synthesize",
            &["approach-a", "approach-b"],
            OUTPUT_KEY,
            &["both-approaches"],
            (5_000, 1, 1, 1, 1),
        )
}

enum WorkerTerminal<'a> {
    Completed(&'a Value),
    Failed,
}

fn worker_terminal<'a>(
    journal: &'a mission_run::MissionRunJournalRow,
    worker_id: &str,
) -> Option<WorkerTerminal<'a>> {
    journal.events.iter().find_map(|event| {
        let matches = event.pointer("/payload/workerId").and_then(Value::as_str) == Some(worker_id);
        match event.get("type").and_then(Value::as_str) {
            Some("worker-completed") if matches => Some(WorkerTerminal::Completed(event)),
            Some("worker-failed") if matches => Some(WorkerTerminal::Failed),
            _ => None,
        }
    })
}

struct WorkerOutput {
    worker_id: String,
    completion_event_id: String,
    output_key: String,
    value_reference: String,
    content_hash: String,
    text: String,
}

fn load_worker_output(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    journal: &mission_run::MissionRunJournalRow,
    worker_id: &str,
    expected_key: &str,
    event: &Value,
) -> crate::store::Result<WorkerOutput> {
    let completion_event_id = required(event, "id")?;
    let output = event.pointer("/payload/outputs/0").ok_or_else(|| {
        crate::store::StoreError::Invalid("Parallel worker output is unavailable.".into())
    })?;
    let value_reference = required(output, "valueReference")?;
    if event
        .pointer("/payload/outputs")
        .and_then(Value::as_array)
        .is_none_or(|items| items.len() != 1)
        || output.get("key").and_then(Value::as_str) != Some(expected_key)
        || event.pointer("/payload/workerId").and_then(Value::as_str) != Some(worker_id)
    {
        return Err(crate::store::StoreError::Invalid(
            "Parallel worker output contract changed.".into(),
        ));
    }
    let receipt = mission_worker_output::get_by_reference(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        value_reference,
    )?
    .ok_or_else(|| {
        crate::store::StoreError::Invalid("Parallel worker output receipt is unavailable.".into())
    })?;
    let text = receipt
        .receipt
        .get("text")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 48_000)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel worker output text is invalid.".into())
        })?;
    let computed = digest(text);
    if receipt.run_id != required(&journal.run, "id")?
        || receipt.worker_id != worker_id
        || receipt.completion_event_id != completion_event_id
        || receipt.output_key != expected_key
        || receipt.value_reference != value_reference
        || receipt.content_hash != computed
        || receipt.receipt.get("trust").and_then(Value::as_str) != Some("provider-generated")
        || receipt.receipt.get("version").and_then(Value::as_i64) != Some(1)
    {
        return Err(crate::store::StoreError::Invalid(
            "Parallel worker receipt crosses its immutable boundary.".into(),
        ));
    }
    Ok(WorkerOutput {
        worker_id: worker_id.into(),
        completion_event_id: completion_event_id.into(),
        output_key: expected_key.into(),
        value_reference: value_reference.into(),
        content_hash: computed,
        text: text.into(),
    })
}

fn render_comparison(topic: &str, outputs: &[WorkerOutput]) -> String {
    format!(
        "# Two approaches: {}\n\nFable generated these approaches independently and joined their immutable outputs in a fixed order.\n\n## Approach A — Practical path\n\n{}\n\n## Approach B — Alternative path\n\n{}\n\n## Comparison checklist\n\n- Which approach best fits the available time and resources?\n- Which risks are reversible, and which require an explicit decision?\n- Which useful elements can be combined without losing the distinct trade-offs?\n- What evidence or human judgement is still needed before acting?\n",
        escape(&flatten(topic)), outputs[0].text.trim(), outputs[1].text.trim(),
    )
}

#[allow(clippy::too_many_arguments)]
fn append_terminal(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    journal: &mission_run::MissionRunJournalRow,
    event_id: &str,
    event_type: &str,
    payload: Value,
    status: &str,
    terminal_result: Option<Value>,
    at: &str,
) -> crate::store::Result<mission_run::MissionRunJournalRow> {
    let revision = required_i64(&journal.run, "revision")?;
    let sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Parallel mission head is invalid.".into())
        })?;
    let key = format!("parallel-terminal:v1:{}", suffix(event_id));
    let event = event_envelope(
        journal,
        auth,
        event_id,
        event_type,
        sequence + 1,
        journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str),
        &key,
        payload,
        at,
    )?;
    let mut projected = object(journal.run.clone())?;
    projected.insert("status".into(), json!(status));
    if let Some(result) = terminal_result {
        projected.insert("terminalResult".into(), result);
    }
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence + 1,"lastEventId":event_id}),
    );
    mission_run::append(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        required(&journal.run, "id")?,
        revision,
        sequence,
        event_id,
        event_type,
        &key,
        &event,
        &Value::Object(projected),
        at,
    )
}

#[allow(clippy::too_many_arguments)]
fn append_transcript(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    shape: &ParallelShape,
    journal: &mission_run::MissionRunJournalRow,
    text: &str,
    artifact_binding: Option<&artifact::DirectMissionArtifactBinding>,
    result_event_id: &str,
    outcome: &str,
    at: &str,
) -> crate::store::Result<()> {
    let head = thread::get(tx, store, &auth.scope, &shape.source_thread_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid("Parallel source conversation is unavailable.".into())
    })?;
    let (user_id, user_revision, user_key) = transcript_identity(&shape.run_id, "user");
    let (assistant_id, assistant_revision, assistant_key) =
        transcript_identity(&shape.run_id, "assistant");
    message::append(
        tx,
        store,
        &auth.scope,
        &shape.source_thread_id,
        &user_id,
        "user",
        &Value::Null,
        Some(&shape.run_id),
        head.last_sequence + 1,
        head.last_sequence,
        head.last_message_id.as_deref(),
        &user_key,
        &user_revision,
        "terminal",
        "initial",
        &json!(shape.topic),
        at,
    )?;
    let mut detail = Map::from_iter([
        ("type".into(), json!("mission-result")),
        ("missionKind".into(), json!("parallel-approaches")),
        ("missionId".into(), json!(shape.mission_id)),
        ("resultEventId".into(), json!(result_event_id)),
        ("outcome".into(), json!(outcome)),
        ("plan".into(), shape.plan_summary.clone()),
    ]);
    if let Some(binding) = artifact_binding {
        detail.insert("artifactId".into(), json!(binding.artifact_id));
        detail.insert(
            "artifactVersionId".into(),
            json!(binding.artifact_version_id),
        );
    }
    message::append(
        tx,
        store,
        &auth.scope,
        &shape.source_thread_id,
        &assistant_id,
        "assistant",
        &Value::Object(detail),
        Some(&shape.run_id),
        head.last_sequence + 2,
        head.last_sequence + 1,
        Some(&user_id),
        &assistant_key,
        &assistant_revision,
        "terminal",
        "initial",
        &json!(text),
        at,
    )?;
    validate_transcript(
        tx,
        store,
        auth,
        shape,
        text,
        artifact_binding,
        result_event_id,
        outcome,
        at,
    )?;
    let _ = journal;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_transcript(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    shape: &ParallelShape,
    text: &str,
    artifact_binding: Option<&artifact::DirectMissionArtifactBinding>,
    result_event_id: &str,
    outcome: &str,
    at: &str,
) -> crate::store::Result<()> {
    let messages = message::list(tx, store, &auth.scope, &shape.source_thread_id)?;
    let (user_id, user_revision, user_key) = transcript_identity(&shape.run_id, "user");
    let (assistant_id, assistant_revision, assistant_key) =
        transcript_identity(&shape.run_id, "assistant");
    let user = messages.iter().find(|message| message.id == user_id);
    let assistant = messages.iter().find(|message| message.id == assistant_id);
    let mut detail = Map::from_iter([
        ("type".into(), json!("mission-result")),
        ("missionKind".into(), json!("parallel-approaches")),
        ("missionId".into(), json!(shape.mission_id)),
        ("resultEventId".into(), json!(result_event_id)),
        ("outcome".into(), json!(outcome)),
        ("plan".into(), shape.plan_summary.clone()),
    ]);
    if let Some(binding) = artifact_binding {
        detail.insert("artifactId".into(), json!(binding.artifact_id));
        detail.insert(
            "artifactVersionId".into(),
            json!(binding.artifact_version_id),
        );
    }
    let links: Option<(String, Option<String>, String)> = tx
        .query_row(
            "SELECT u.idempotency_key,a.previous_message_id,a.idempotency_key
         FROM message u JOIN message a ON a.workspace_id=u.workspace_id AND a.thread_id=u.thread_id
         WHERE u.workspace_id=?1 AND u.thread_id=?2 AND u.id=?3 AND a.id=?4",
            rusqlite::params![
                auth.scope.workspace_id(),
                shape.source_thread_id,
                user_id,
                assistant_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if user.is_none_or(|message| {
        message.kind != "user"
            || message.run_id.as_deref() != Some(shape.run_id.as_str())
            || message.content != json!(shape.topic)
            || message.current_revision_id != user_revision
            || message.created_at != at
    }) || assistant.is_none_or(|message| {
        message.kind != "assistant"
            || message.run_id.as_deref() != Some(shape.run_id.as_str())
            || message.content != json!(text)
            || message.detail != Value::Object(detail.clone())
            || message.current_revision_id != assistant_revision
            || message.created_at != at
    }) || links.is_none_or(|(stored_user_key, previous, stored_assistant_key)| {
        stored_user_key != user_key
            || previous.as_deref() != Some(user_id.as_str())
            || stored_assistant_key != assistant_key
    }) {
        return Err(crate::store::StoreError::Invalid(
            "Parallel mission transcript is incomplete.".into(),
        ));
    }
    Ok(())
}

fn validate_open_join(
    event: &Value,
    worker_ids: &[String],
    join_key: &str,
) -> crate::store::Result<()> {
    if event
        .pointer("/payload/join/joinKey")
        .and_then(Value::as_str)
        != Some(join_key)
        || event
            .pointer("/payload/join/status")
            .and_then(Value::as_str)
            != Some("open")
        || event
            .pointer("/payload/join/strategy")
            .and_then(Value::as_str)
            != Some("all")
        || event
            .pointer("/payload/join/allowFailedWorkers")
            .and_then(Value::as_bool)
            != Some(false)
        || event.pointer("/payload/join/workerIds") != Some(&json!(worker_ids))
        || event
            .pointer("/payload/join/satisfiedWorkerIds")
            .and_then(Value::as_array)
            .is_none_or(|items| !items.is_empty())
        || event
            .pointer("/payload/join/failedWorkerIds")
            .and_then(Value::as_array)
            .is_none_or(|items| !items.is_empty())
    {
        return Err(crate::store::StoreError::Invalid(
            "Parallel mission join changed.".into(),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn event_envelope(
    journal: &mission_run::MissionRunJournalRow,
    auth: &Authorized,
    event_id: &str,
    event_type: &str,
    sequence: i64,
    previous_event_id: Option<&str>,
    idempotency_key: &str,
    payload: Value,
    at: &str,
) -> crate::store::Result<Value> {
    Ok(json!({
        "workspaceId":auth.scope.workspace_id(),"visibility":"member-private","ownerMemberId":auth.member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":auth.internal_user_id,
        "createdAt":at,"updatedAt":at,"id":event_id,"runId":required(&journal.run,"id")?,
        "type":event_type,"sequence":sequence,"previousEventId":previous_event_id,
        "attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":idempotency_key,"payload":payload
    }))
}

fn project_head(
    run: &Value,
    event_id: &str,
    sequence: i64,
    at: &str,
) -> crate::store::Result<Value> {
    let mut projected = object(run.clone())?;
    projected.insert("revision".into(), json!(required_i64(run, "revision")? + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":event_id}),
    );
    Ok(Value::Object(projected))
}

fn transcript_identity(run_id: &str, role: &str) -> (String, String, String) {
    let suffix = suffix(&format!("parallel-transcript:v1|{run_id}|{role}"));
    (
        format!("parallel-message-{suffix}"),
        format!("parallel-message-revision-{suffix}"),
        format!("parallel-message:v1:{suffix}"),
    )
}

fn join_key(run_id: &str) -> String {
    format!("{JOIN_KEY_PREFIX}{}", suffix(run_id))
}
fn suffix(value: &str) -> String {
    digest(value)[..40].to_string()
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn is_terminal(run: &Value) -> bool {
    matches!(
        run.get("status").and_then(Value::as_str),
        Some("completed" | "partially-completed" | "failed" | "cancelled")
    )
}
fn flatten(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn comparison_title(topic: &str) -> String {
    let prefix = "Two approaches: ";
    let remaining = 400usize.saturating_sub(prefix.chars().count());
    format!(
        "{prefix}{}",
        flatten(topic).chars().take(remaining).collect::<String>()
    )
}
fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('#', "\\#")
        .replace('|', "\\|")
}

fn bounded(value: &str, label: &str, maximum: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > maximum {
        Err(format!("{label} is invalid."))
    } else {
        Ok(())
    }
}
fn required<'a>(value: &'a Value, key: &str) -> crate::store::Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(format!("Parallel mission {key} is invalid."))
        })
}
fn required_i64(value: &Value, key: &str) -> crate::store::Result<i64> {
    value.get(key).and_then(Value::as_i64).ok_or_else(|| {
        crate::store::StoreError::Invalid(format!("Parallel mission {key} is invalid."))
    })
}
fn object(value: Value) -> crate::store::Result<Map<String, Value>> {
    value.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Parallel mission record is invalid.".into())
    })
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::{
        artifact, mission_plan, mission_run, mission_worker_output, thread, workspace_directory,
    };
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    struct Fixture {
        directory: tempfile::TempDir,
        key: MasterKey,
        workspace_id: String,
    }

    fn seed() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let key = MasterKey::generate().unwrap();
        let store = Store::open(
            &directory.path().join("fable.db"),
            Vault::new(&key).unwrap(),
        )
        .unwrap();
        let summary = workspace_directory::WorkspaceDirectoryUpsert {
            internal_user_id: "user-1".into(),
            fable_workspace_id: "workspace-hosted-1".into(),
            name: "One".into(),
            workspace_status: "active".into(),
            workspace_revision: 1,
            policy_revision: 1,
            member_id: "member-1".into(),
            role: "owner".into(),
            membership_status: "active".into(),
            membership_revision: 1,
            updated_at: "2026-07-13T09:00:00Z".into(),
        };
        let workspace_id = store
            .transaction(|tx| {
                let local = workspace_directory::upsert_authoritative_summary(tx, &summary)?;
                workspace_directory::set_current_internal_user(tx, "user-1", "t0")?;
                workspace_directory::select_active_workspace_for_current_user(
                    tx,
                    "workspace-hosted-1",
                    "t0",
                )?;
                let scope = DataScope::workspace(local.local_workspace_id.clone())?;
                thread::create(
                    tx,
                    &store,
                    &scope,
                    "thread-1",
                    None,
                    "Compare",
                    "t0",
                    &json!({}),
                )?;
                tx.execute(
                    "UPDATE thread SET owner_member_id='member-1' WHERE id='thread-1'",
                    [],
                )?;
                Ok(local.local_workspace_id)
            })
            .unwrap();
        Fixture {
            directory,
            key,
            workspace_id,
        }
    }

    fn reopen(fixture: &Fixture) -> Store {
        Store::open(
            &fixture.directory.path().join("fable.db"),
            Vault::new(&fixture.key).unwrap(),
        )
        .unwrap()
    }

    fn auth(workspace_id: &str) -> Authorized {
        Authorized {
            scope: DataScope::workspace(workspace_id.to_string()).unwrap(),
            member_id: "member-1".into(),
            internal_user_id: "user-1".into(),
        }
    }

    fn create_parallel(store: &Store, workspace_id: &str, fail_second: bool) {
        let auth = auth(workspace_id);
        store.transaction(|tx| {
            let mission = json!({
                "id":"mission-1","status":"ready","revision":1,
                "currentPlanId":"plan-1","currentPlanRevisionId":"plan-revision-1",
                "executionDepth":"multi-worker",
                "constraints":[{"key":MARKER,"severity":"required","source":"orchestrator"}],
                "acceptance":{"requiresHumanAcceptance":false,"minimumRequiredCriteria":1,
                    "criteria":[{"key":"both-approaches","required":true,"evaluator":"policy"}]},
                "budget":{"maxDurationMs":180000,"maxInputTokens":32000,"maxOutputTokens":4096,
                    "maxToolCalls":1,"maxWorkers":2,"maxAttempts":1}
            });
            let plan = json!({"id":"plan-1","missionId":"mission-1","currentRevisionId":"plan-revision-1","currentRevisionNumber":1});
            let revision = json!({
                "id":"plan-revision-1","planId":"plan-1","missionId":"mission-1","planRevisionNumber":1,
                "summary":"Generate two independent approaches for onboarding and compare the trade-offs",
                "bounds":{"maxSteps":3,"maxDependenciesPerStep":2,"maxParallelSteps":2,"maxRevisions":1},
                "steps":[
                    {"key":"approach-a","kind":"produce","title":"Practical approach","objective":"Practical approach objective",
                        "dependsOnStepKeys":[],"requiredCapabilities":[],"expectedOutputs":[{"key":"approach-a","required":true,"format":"text/markdown"}],
                        "acceptanceCriterionKeys":[],"optional":false,"estimatedBudget":{"maxDurationMs":90000,"maxInputTokens":16000,"maxOutputTokens":2048,"maxToolCalls":1,"maxAttempts":1}},
                    {"key":"approach-b","kind":"produce","title":"Alternative approach","objective":"Alternative approach objective",
                        "dependsOnStepKeys":[],"requiredCapabilities":[],"expectedOutputs":[{"key":"approach-b","required":true,"format":"text/markdown"}],
                        "acceptanceCriterionKeys":[],"optional":false,"estimatedBudget":{"maxDurationMs":90000,"maxInputTokens":16000,"maxOutputTokens":2048,"maxToolCalls":1,"maxAttempts":1}},
                    {"key":"compare","kind":"synthesize","title":"Compare approaches","objective":"Join both outputs","dependsOnStepKeys":["approach-a","approach-b"],
                        "requiredCapabilities":[],"expectedOutputs":[{"key":"comparison","required":true,"format":"text/markdown"}],
                        "acceptanceCriterionKeys":["both-approaches"],"optional":false,"estimatedBudget":{"maxDurationMs":5000,"maxInputTokens":1,"maxOutputTokens":1,"maxToolCalls":1,"maxAttempts":1}}
                ]
            });
            let lifecycle = mission_plan::create(
                tx, store, &auth.scope, &auth.member_id, &auth.internal_user_id,
                "mission-1", "plan-1", "plan-revision-1", "multi-worker",
                &mission, &plan, &revision, "t0",
            )?;
            mission_plan::mark_running(tx, store, &auth.scope, &auth.member_id, &lifecycle, "t1")?;
            let run = json!({
                "id":"run-1","workspaceId":workspace_id,"visibility":"member-private","ownerMemberId":"member-1",
                "authority":"local","schemaVersion":1,"revision":1,"status":"running",
                "createdByInternalUserId":"user-1",
                "initiator":{"missionId":"mission-1"},"missionId":"mission-1","planRevisionId":"plan-revision-1",
                "sourceThreadId":"thread-1","currentAttemptNumber":1,
                "budget":{"maxWorkers":2,"maxAttempts":1},
                "eventHead":{"lastSequence":1,"lastEventId":"event-created"}
            });
            let created = json!({"id":"event-created","runId":"run-1","type":"run-created","sequence":1,"idempotencyKey":"create","payload":{"run":run}});
            let mut journal = mission_run::create(
                tx, store, &auth.scope, &auth.member_id, &auth.internal_user_id,
                "run-1", "event-created", "create", &run, &created, "t1",
            )?;
            for (worker_id, step_key, output_key) in [
                ("worker-a", "approach-a", "approach-a"),
                ("worker-b", "approach-b", "approach-b"),
            ] {
                journal = append_test_event(tx, store, &auth, journal, &format!("created-{worker_id}"), "worker-created", json!({
                    "worker":{"id":worker_id,"runId":"run-1","planRevisionId":"plan-revision-1","planStepKey":step_key,
                        "role":{"objective":format!("{step_key} objective")},"budget":{"maxDurationMs":90000,"maxOutputTokens":2048,"maxAttempts":1},
                        "tools":[],"context":[],"capabilityIds":[],"capabilityGrantIds":[],
                        "outputContract":{"slots":[{"key":output_key,"required":true,"format":"text/markdown"}],"includeEvidence":false,"includeUncertainty":true,"delivery":"run-result"}}
                }))?;
                journal = append_test_event(tx, store, &auth, journal, &format!("started-{worker_id}"), "worker-started", json!({"workerId":worker_id}))?;
                journal = append_test_event(tx, store, &auth, journal, &format!("route-{worker_id}"), "route-selected", json!({"workerId":worker_id,"selection":{"providerRouteId":"route-openai"}}))?;
            }
            let join_key = join_key("run-1");
            journal = append_test_event(tx, store, &auth, journal, "join-open", "join-opened", json!({"join":{
                "joinKey":join_key,"status":"open","strategy":"all","workerIds":["worker-a","worker-b"],
                "allowFailedWorkers":false,"satisfiedWorkerIds":[],"failedWorkerIds":[]
            }}))?;
            journal = append_worker_completion(tx, store, &auth, journal, "worker-a", "approach-a", "completion-a", "# Practical\n\nUse the current system first.")?;
            if fail_second {
                let _ = append_test_event(tx, store, &auth, journal, "failure-b", "worker-failed", json!({
                    "workerId":"worker-b","error":{"code":"provider-failed","category":"provider","message":"Provider failed.","retryable":false}
                }))?;
            } else {
                let _ = append_worker_completion(tx, store, &auth, journal, "worker-b", "approach-b", "completion-b", "# Alternative\n\nTest a bolder path in parallel.")?;
            }
            Ok(())
        }).unwrap();
    }

    fn append_test_event(
        tx: &rusqlite::Connection,
        store: &Store,
        auth: &Authorized,
        journal: mission_run::MissionRunJournalRow,
        event_id: &str,
        event_type: &str,
        payload: Value,
    ) -> crate::store::Result<mission_run::MissionRunJournalRow> {
        let revision = required_i64(&journal.run, "revision")?;
        let sequence = journal
            .run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            .unwrap();
        let key = format!("test:{event_id}");
        let event = event_envelope(
            &journal,
            auth,
            event_id,
            event_type,
            sequence + 1,
            journal
                .run
                .pointer("/eventHead/lastEventId")
                .and_then(Value::as_str),
            &key,
            payload,
            "2026-07-13T10:00:00Z",
        )?;
        let projected = project_head(&journal.run, event_id, sequence + 1, "2026-07-13T10:00:00Z")?;
        mission_run::append(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            "run-1",
            revision,
            sequence,
            event_id,
            event_type,
            &key,
            &event,
            &projected,
            "2026-07-13T10:00:00Z",
        )
    }

    fn append_worker_completion(
        tx: &rusqlite::Connection,
        store: &Store,
        auth: &Authorized,
        journal: mission_run::MissionRunJournalRow,
        worker_id: &str,
        output_key: &str,
        event_id: &str,
        text: &str,
    ) -> crate::store::Result<mission_run::MissionRunJournalRow> {
        let hash = digest(text);
        let reference = mission_worker_output::binding_reference(
            auth.scope.workspace_id(),
            &auth.member_id,
            "run-1",
            worker_id,
            event_id,
            output_key,
            &hash,
        );
        let journal = append_test_event(
            tx,
            store,
            auth,
            journal,
            event_id,
            "worker-completed",
            json!({
                "workerId":worker_id,"outputs":[{"key":output_key,"summary":"Worker output","valueReference":reference}]
            }),
        )?;
        let receipt = json!({
            "version":1,"workspaceId":auth.scope.workspace_id(),"ownerMemberId":auth.member_id,
            "runId":"run-1","workerId":worker_id,"completionEventId":event_id,"outputKey":output_key,
            "valueReference":reference,"contentHash":hash,"sizeBytes":text.len(),"text":text,
            "mediaType":"text/markdown","encoding":"utf-8","observedProvider":"openai",
            "providerRouteId":"route-openai","requestedModel":"gpt-5","trust":"provider-generated",
            "citations":[],"createdAt":"2026-07-13T10:00:00Z"
        });
        mission_worker_output::put(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            "run-1",
            worker_id,
            event_id,
            output_key,
            &reference,
            &hash,
            text.len() as i64,
            &receipt,
            "2026-07-13T10:00:00Z",
        )?;
        Ok(journal)
    }

    #[test]
    fn completed_workers_recover_after_reopen_and_create_one_exact_aggregate() {
        let fixture = seed();
        let store = reopen(&fixture);
        create_parallel(&store, &fixture.workspace_id, false);
        drop(store);

        let reopened = reopen(&fixture);
        let result = reopened
            .transaction(|tx| finalize_in_tx(tx, &reopened, "run-1"))
            .unwrap();
        assert_eq!(result.outcome, "completed");
        assert!(result.text.contains("## Approach A"));
        assert!(result.text.contains("## Approach B"));
        let artifact_id = result.artifact_id.clone().unwrap();
        let private = PrivateDataScope::for_authenticated_user(
            DataScope::workspace(fixture.workspace_id.clone()).unwrap(),
            "user-1",
            Some("member-1"),
        )
        .unwrap();
        let bundle = reopened
            .with_conn(|tx| artifact::get_bundle(tx, &reopened, &private, &artifact_id))
            .unwrap()
            .unwrap();
        let inputs = bundle["currentVersion"]["inputs"].as_array().unwrap();
        assert_eq!(inputs.len(), 3);
        assert_eq!(
            inputs[1]["referenceId"],
            result
                .journal
                .events
                .iter()
                .find(|event| event["type"] == "worker-completed")
                .unwrap()["payload"]["outputs"][0]["valueReference"]
        );
        let messages = reopened
            .with_conn(|tx| message::list(tx, &reopened, private.data(), "thread-1"))
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].detail["missionKind"], "parallel-approaches");
        assert_eq!(
            messages[1].detail["plan"]["steps"]
                .as_array()
                .unwrap()
                .len(),
            3
        );

        drop(reopened);
        let replayed = reopen(&fixture);
        let exact = replayed
            .transaction(|tx| finalize_in_tx(tx, &replayed, "run-1"))
            .unwrap();
        assert_eq!(exact.artifact_id, Some(artifact_id));
        let replay_messages = replayed
            .with_conn(|tx| message::list(tx, &replayed, private.data(), "thread-1"))
            .unwrap();
        assert_eq!(replay_messages.len(), 2);
    }

    #[test]
    fn one_worker_failure_preserves_partial_without_creating_an_aggregate() {
        let fixture = seed();
        let store = reopen(&fixture);
        create_parallel(&store, &fixture.workspace_id, true);
        let result = store
            .transaction(|tx| finalize_in_tx(tx, &store, "run-1"))
            .unwrap();
        assert_eq!(result.outcome, "partial");
        assert!(result.artifact_id.is_none());
        assert_eq!(result.journal.run["status"], "partially-completed");
        let scope = DataScope::workspace(fixture.workspace_id.clone()).unwrap();
        let lifecycle = store
            .with_conn(|tx| mission_plan::get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        assert_eq!(lifecycle.mission["status"], "partially-completed");
        let artifact_count: i64 = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT COUNT(*) FROM artifact WHERE workspace_id=?1",
                    [fixture.workspace_id.as_str()],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(artifact_count, 0);
    }

    #[test]
    fn changed_worker_receipt_fails_closed_before_join_resolution() {
        let fixture = seed();
        let store = reopen(&fixture);
        create_parallel(&store, &fixture.workspace_id, false);
        store.with_conn(|tx| {
            tx.execute(
                "UPDATE mission_worker_output_receipt SET content_hash=?1 WHERE worker_id='worker-a'",
                ["0".repeat(64)],
            )?;
            Ok(())
        }).unwrap();
        let error = store
            .transaction(|tx| finalize_in_tx(tx, &store, "run-1"))
            .unwrap_err();
        assert!(!error.to_string().trim().is_empty());
        let scope = DataScope::workspace(fixture.workspace_id).unwrap();
        let journal = store
            .with_conn(|tx| mission_run::get(tx, &store, &scope, "member-1", "run-1"))
            .unwrap()
            .unwrap();
        assert!(!journal
            .events
            .iter()
            .any(|event| event["type"] == "join-resolved"));
    }

    #[test]
    fn cancelled_parallel_run_replays_one_transcript_and_never_creates_an_aggregate() {
        let fixture = seed();
        let store = reopen(&fixture);
        create_parallel(&store, &fixture.workspace_id, false);
        let auth = auth(&fixture.workspace_id);
        store
            .transaction(|tx| {
                let journal =
                    mission_run::get(tx, &store, &auth.scope, &auth.member_id, "run-1")?.unwrap();
                let revision = required_i64(&journal.run, "revision")?;
                let sequence = journal
                    .run
                    .pointer("/eventHead/lastSequence")
                    .and_then(Value::as_i64)
                    .unwrap();
                let cancellation = json!({"requestKey":"stop-1","scope":"run",
                "requestedAt":"2026-07-13T10:01:00Z","requestedByInternalUserId":"user-1",
                "mode":"cooperative","reason":"User requested stop."});
                let requested = event_envelope(
                    &journal,
                    &auth,
                    "cancel-requested",
                    "cancellation-requested",
                    sequence + 1,
                    journal
                        .run
                        .pointer("/eventHead/lastEventId")
                        .and_then(Value::as_str),
                    "cancel:stop-1",
                    json!({"cancellation":cancellation}),
                    "2026-07-13T10:01:00Z",
                )?;
                let mut cancelling = object(journal.run.clone())?;
                cancelling.insert("status".into(), json!("cancelling"));
                cancelling.insert("cancellation".into(), cancellation.clone());
                cancelling.insert("revision".into(), json!(revision + 1));
                cancelling.insert(
                    "eventHead".into(),
                    json!({"lastSequence":sequence + 1,
                "lastEventId":"cancel-requested"}),
                );
                let journal = mission_run::append(
                    tx,
                    &store,
                    &auth.scope,
                    &auth.member_id,
                    "run-1",
                    revision,
                    sequence,
                    "cancel-requested",
                    "cancellation-requested",
                    "cancel:stop-1",
                    &requested,
                    &Value::Object(cancelling),
                    "2026-07-13T10:01:00Z",
                )?;
                let revision = required_i64(&journal.run, "revision")?;
                let sequence = journal
                    .run
                    .pointer("/eventHead/lastSequence")
                    .and_then(Value::as_i64)
                    .unwrap();
                let cancelled = event_envelope(
                    &journal,
                    &auth,
                    "run-cancelled",
                    "run-cancelled",
                    sequence + 1,
                    Some("cancel-requested"),
                    "worker-cancel:terminal",
                    json!({"cancellation":cancellation}),
                    "2026-07-13T10:01:01Z",
                )?;
                let mut projected = object(journal.run.clone())?;
                projected.insert("status".into(), json!("cancelled"));
                projected.insert("revision".into(), json!(revision + 1));
                projected.insert(
                    "eventHead".into(),
                    json!({"lastSequence":sequence + 1,
                "lastEventId":"run-cancelled"}),
                );
                mission_run::append(
                    tx,
                    &store,
                    &auth.scope,
                    &auth.member_id,
                    "run-1",
                    revision,
                    sequence,
                    "run-cancelled",
                    "run-cancelled",
                    "worker-cancel:terminal",
                    &cancelled,
                    &Value::Object(projected),
                    "2026-07-13T10:01:01Z",
                )?;
                let lifecycle =
                    mission_plan::get(tx, &store, &auth.scope, &auth.member_id, "mission-1")?
                        .unwrap();
                mission_plan::mark_cancelled(
                    tx,
                    &store,
                    &auth.scope,
                    &auth.member_id,
                    &lifecycle,
                    &json!({"outcome":"cancelled","summary":"Stopped.","producingRunIds":["run-1"],
                    "outputs":[],"acceptance":[],"completedAt":"2026-07-13T10:01:01Z"}),
                    "2026-07-13T10:01:01Z",
                )?;
                Ok(())
            })
            .unwrap();

        let result = store
            .transaction(|tx| finalize_in_tx(tx, &store, "run-1"))
            .unwrap();
        assert_eq!(result.outcome, "cancelled");
        assert!(result.artifact_id.is_none());
        let private = PrivateDataScope::for_authenticated_user(
            DataScope::workspace(fixture.workspace_id.clone()).unwrap(),
            "user-1",
            Some("member-1"),
        )
        .unwrap();
        let messages = store
            .with_conn(|tx| message::list(tx, &store, private.data(), "thread-1"))
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].detail["outcome"], "cancelled");
        let replay = store
            .transaction(|tx| finalize_in_tx(tx, &store, "run-1"))
            .unwrap();
        assert_eq!(replay.outcome, "cancelled");
        let count: i64 = store
            .with_conn(|tx| {
                tx.query_row(
                    "SELECT COUNT(*) FROM artifact WHERE workspace_id=?1",
                    [fixture.workspace_id.as_str()],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}

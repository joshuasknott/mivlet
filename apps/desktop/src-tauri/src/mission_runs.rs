//! Authenticated mission-run creation, read, and cooperative cancellation.

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::{Mutex, OnceLock};

use crate::store::repos::{
    mission_checkpoint, mission_plan, mission_run, scope::DataScope, workspace_directory,
};

const MAX_CHECKPOINT_STATE_BYTES: usize = 256_000;
static RECOVERED_CITED_SCOPES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static MISSION_RECOVERY_EPOCH: OnceLock<String> = OnceLock::new();

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn initialize_recovery_epoch() {
    let _ = MISSION_RECOVERY_EPOCH.set(now());
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionRunCreateInput {
    mission_id: String,
    run_id: String,
    event_id: String,
    idempotency_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionRunCancelInput {
    run_id: String,
    event_id: String,
    request_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    mode: String,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionRunFinalizeCancellationInput {
    run_id: String,
    event_id: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionCheckpointCreateInput {
    run_id: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    attempt_number: i64,
    durable_through_sequence: i64,
    resume_after_event_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionCheckpointRestoreInput {
    run_id: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    new_attempt_number: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionCheckpointRestoreResult {
    journal: mission_run::MissionRunJournalRow,
    checkpoint: mission_checkpoint::CheckpointStateRow,
}

#[derive(Serialize)]
#[allow(clippy::large_enum_variant)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CitedMissionRestartRecovery {
    Resumable {
        run_id: String,
        source_thread_id: String,
        worker: Value,
        provider_id: String,
        model_reference: String,
        worker_started_event_id: String,
        route_selected_event_id: String,
        checkpoint_event_id: String,
        checkpoint_restore_event_id: String,
        tool_event_id: String,
        output_reference: String,
        evidence: Value,
        restore_idempotency_key: String,
        terminal_idempotency_key: String,
        usage_event_id: String,
        completion_event_id: String,
        evaluation_event_id: String,
        result_event_id: String,
        failure_event_id: String,
        expected_run_revision: i64,
        expected_last_sequence: i64,
        new_attempt_number: i64,
    },
    Terminalized {
        journal: mission_run::MissionRunJournalRow,
    },
}

fn authorized(
    tx: &rusqlite::Connection,
) -> crate::store::Result<(
    DataScope,
    workspace_directory::AuthorizedWorkspaceContext,
    String,
)> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let member = context.member_id.clone().ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "An active Fable workspace membership is required for private mission runs.".into(),
        )
    })?;
    let scope = DataScope::workspace(context.active_workspace.local_workspace_id.clone())?;
    Ok((scope, context, member))
}

#[tauri::command]
pub fn mission_run_create(
    input: MissionRunCreateInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, context, member) = authorized(tx)?;
            validate_key(&input.idempotency_key, "Mission run idempotency key", 200)
                .map_err(crate::store::StoreError::Invalid)?;
            if let Some(existing) = mission_run::get(tx, store, &scope, &member, &input.run_id)? {
                return exact_create_replay(&existing, &input)
                    .map(|_| existing)
                    .map_err(crate::store::StoreError::Invalid);
            }
            let lifecycle = mission_plan::get(tx, store, &scope, &member, &input.mission_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission is unavailable in this workspace.".into(),
                    )
                })?;
            let at = now();
            let create_key = format!("create:{}", input.idempotency_key.trim());
            let (run, event) =
                build_run_created(&lifecycle, &input, &context.internal_user_id, &member, &at)
                    .map_err(crate::store::StoreError::Invalid)?;
            let journal = mission_run::create(
                tx,
                store,
                &scope,
                &member,
                &context.internal_user_id,
                &input.run_id,
                &input.event_id,
                &create_key,
                &run,
                &event,
                &at,
            )?;
            mission_plan::mark_running(tx, store, &scope, &member, &lifecycle, &at)?;
            Ok(journal)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_run_get(
    run_id: String,
) -> Result<Option<mission_run::MissionRunJournalRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, member) = authorized(tx)?;
            mission_run::get(tx, store, &scope, &member, &run_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_run_request_cancellation(
    input: MissionRunCancelInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, context, member) = authorized(tx)?;
            validate_cancellation_input(&input).map_err(crate::store::StoreError::Invalid)?;
            let journal =
                mission_run::get(tx, store, &scope, &member, &input.run_id)?.ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let cancel_key = format!("cancel:{}", input.request_key.trim());
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(cancel_key.as_str())
            }) {
                return exact_cancellation_replay(existing, &input, &context.internal_user_id)
                    .map(|_| journal)
                    .map_err(crate::store::StoreError::Invalid);
            }
            let at = now();
            let (projected, event) = build_cancellation(
                &journal.run,
                &input,
                &context.internal_user_id,
                &member,
                &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            mission_run::append(
                tx,
                store,
                &scope,
                &member,
                &input.run_id,
                input.expected_run_revision,
                input.expected_last_sequence,
                &input.event_id,
                "cancellation-requested",
                &cancel_key,
                &event,
                &projected,
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_run_finalize_cancellation(
    input: MissionRunFinalizeCancellationInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, context, member) = authorized(tx)?;
            validate_key(&input.run_id, "Mission run", 160)
                .and_then(|_| validate_key(&input.event_id, "Cancellation terminal event", 200))
                .map_err(crate::store::StoreError::Invalid)?;
            if crate::native_api::mission_run_has_active_native_execution(&input.run_id)
                .map_err(crate::store::StoreError::Invalid)?
            {
                return Err(crate::store::StoreError::Invalid(
                    "Native provider cancellation has not settled yet.".into(),
                ));
            }
            let journal = mission_run::get(tx, store, &scope, &member, &input.run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let cancellation = journal.run.get("cancellation").cloned().ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission cancellation request is unavailable.".into())
            })?;
            let request_key = cancellation
                .get("requestKey")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission cancellation request is invalid.".into())
                })?;
            let key = format!("cancel-finalize:{request_key}");
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(key.as_str())
            }) {
                if existing.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
                    && existing.get("type").and_then(Value::as_str) == Some("run-cancelled")
                    && existing.pointer("/payload/cancellation") == Some(&cancellation)
                    && journal.run.get("status").and_then(Value::as_str) == Some("cancelled")
                {
                    let mission_id = journal.run.get("missionId")
                        .or_else(|| journal.run.pointer("/initiator/missionId"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run has no selected mission.".into()))?;
                    let lifecycle = mission_plan::get(tx, store, &scope, &member, mission_id)?
                        .ok_or_else(|| crate::store::StoreError::Invalid("Mission plan is unavailable.".into()))?;
                    if is_cited_transcript_shape(&journal.run, &lifecycle) {
                        crate::mission_workers::validate_cited_terminal_status_transcript_replay(
                            tx,
                            store,
                            &scope,
                            &member,
                            &journal,
                            &lifecycle,
                        )?;
                    }
                    return Ok(journal);
                }
                return Err(crate::store::StoreError::Invalid(
                    "Cancellation terminal idempotency key represents another event.".into(),
                ));
            }
            if journal.run.get("status").and_then(Value::as_str) != Some("cancelling")
                || journal.run.get("revision").and_then(Value::as_i64)
                    != Some(input.expected_run_revision)
                || journal.run.pointer("/eventHead/lastSequence").and_then(Value::as_i64)
                    != Some(input.expected_last_sequence)
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission cancellation changed before it could be finalized.".into(),
                ));
            }
            let previous = journal.run.pointer("/eventHead/lastEventId").and_then(Value::as_str)
                .ok_or_else(|| crate::store::StoreError::Invalid("Mission cancellation event is unavailable.".into()))?;
            let requested = journal.events.iter().find(|event| event.get("id").and_then(Value::as_str) == Some(previous))
                .ok_or_else(|| crate::store::StoreError::Invalid("Mission cancellation event is unavailable.".into()))?;
            if requested.get("type").and_then(Value::as_str) != Some("cancellation-requested")
                || requested.pointer("/payload/cancellation") != Some(&cancellation)
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission cancellation head is invalid.".into(),
                ));
            }
            let at = now();
            let sequence = input.expected_last_sequence + 1;
            let event = json!({
                "workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":member,
                "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":context.internal_user_id,"createdAt":at,"updatedAt":at,
                "id":input.event_id,"runId":input.run_id,"type":"run-cancelled","sequence":sequence,"previousEventId":previous,
                "attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
                "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":key,"payload":{"cancellation":cancellation}
            });
            let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run record is invalid.".into())
            })?;
            projected.insert("status".into(), json!("cancelled"));
            projected.insert("revision".into(), json!(input.expected_run_revision + 1));
            projected.insert("updatedAt".into(), json!(at));
            projected.insert("eventHead".into(), json!({"lastSequence":sequence,"lastEventId":input.event_id}));
            let settled = mission_run::append(
                tx, store, &scope, &member, &input.run_id, input.expected_run_revision,
                input.expected_last_sequence, &input.event_id, "run-cancelled", &key, &event,
                &Value::Object(projected), &at,
            )?;
            let mission_id = journal.run.get("missionId")
                .or_else(|| journal.run.pointer("/initiator/missionId"))
                .and_then(Value::as_str)
                .ok_or_else(|| crate::store::StoreError::Invalid("Mission run has no selected mission.".into()))?;
            let lifecycle = mission_plan::get(tx, store, &scope, &member, mission_id)?
                .ok_or_else(|| crate::store::StoreError::Invalid("Mission plan is unavailable.".into()))?;
            let acceptance = lifecycle.mission.pointer("/acceptance/criteria").and_then(Value::as_array)
                .into_iter().flatten().filter_map(|criterion| criterion.get("key").and_then(Value::as_str))
                .map(|criterion_key| json!({"criterionKey":criterion_key,"status":"not-evaluated","evidenceRefs":[],
                    "summary":"The mission was cancelled before this criterion could be accepted."}))
                .collect::<Vec<_>>();
            let result = json!({"outcome":"cancelled","summary":"The mission stopped after its cancellation request was observed.",
                "producingRunIds":[input.run_id],"outputs":[],"acceptance":acceptance,"completedAt":at});
            mission_plan::mark_cancelled(tx, store, &scope, &member, &lifecycle, &result, &at)?;
            if is_cited_recovery_shape(&journal.run, &lifecycle) {
                crate::mission_workers::append_cited_terminal_status_transcript(
                    tx,
                    store,
                    &scope,
                    &member,
                    &settled,
                    &lifecycle,
                    &result,
                    &event,
                    &at,
                )?;
            }
            Ok(settled)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_run_recover_interrupted_cited() -> Result<Vec<CitedMissionRestartRecovery>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let (scope, context, member) = store
        .with_conn(authorized)
        .map_err(|error| error.to_string())?;
    let recovery_scope = format!(
        "{}\0{}\0{}",
        context.internal_user_id,
        scope.workspace_id(),
        member
    );
    {
        let mut recovered = RECOVERED_CITED_SCOPES
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .map_err(|_| "Fable could not access mission recovery state.".to_string())?;
        if !recovered.insert(recovery_scope.clone()) {
            return Ok(Vec::new());
        }
    }
    let result = (|| {
        let recovery_epoch = MISSION_RECOVERY_EPOCH
            .get()
            .ok_or_else(|| "Mission recovery epoch is unavailable.".to_string())?;
        let ids = store
            .with_conn(|tx| {
                mission_run::list_nonterminal_ids_before(tx, &scope, &member, recovery_epoch)
            })
            .map_err(|error| error.to_string())?;
        let mut journals = Vec::new();
        for run_id in ids {
            if crate::native_api::mission_run_has_active_native_execution(&run_id)? {
                continue;
            }
            let recovered = store
                .transaction(|tx| {
                    recover_interrupted_cited_run(
                        tx,
                        store,
                        &scope,
                        &member,
                        &context.internal_user_id,
                        &run_id,
                    )
                })
                .map_err(|error| error.to_string())?;
            if let Some(journal) = recovered {
                journals.push(journal);
            }
        }
        Ok(journals)
    })();
    if result.is_err() {
        if let Ok(mut recovered) = RECOVERED_CITED_SCOPES
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
        {
            recovered.remove(&recovery_scope);
        }
    }
    result
}

fn recover_interrupted_cited_run(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    member: &str,
    internal_user_id: &str,
    run_id: &str,
) -> crate::store::Result<Option<CitedMissionRestartRecovery>> {
    let journal = mission_run::get(tx, store, scope, member, run_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run disappeared during recovery.".into())
    })?;
    if matches!(
        journal.run.get("status").and_then(Value::as_str),
        Some("completed" | "partially-completed" | "failed" | "cancelled")
    ) {
        return Ok(None);
    }
    let mission_id = journal
        .run
        .get("missionId")
        .or_else(|| journal.run.pointer("/initiator/missionId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run has no selected mission.".into())
        })?;
    let lifecycle = mission_plan::get(tx, store, scope, member, mission_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission plan is unavailable.".into()))?;
    if !is_cited_recovery_shape(&journal.run, &lifecycle) {
        return Ok(None);
    }
    if journal.run.get("status").and_then(Value::as_str) == Some("running") {
        match cited_restart_resume_descriptor(
            tx,
            store,
            scope,
            member,
            internal_user_id,
            &journal,
            &lifecycle,
        ) {
            Ok(Some(resume)) => return Ok(Some(resume)),
            Ok(None) | Err(crate::store::StoreError::Invalid(_)) => {}
            Err(error) => return Err(error),
        }
    }
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
    let status = journal
        .run
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let at = now();
    let identity = format!(
        "{}\0{}\0{}\0{}",
        scope.workspace_id(),
        member,
        run_id,
        revision
    );
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let event_id = format!("mission-recovery-{}", &digest[..32]);
    let event_key = format!("restart-recovery:v1:{revision}:{last_sequence}");
    let sequence = last_sequence + 1;
    let (event_type, payload, next_status, outcome, summary) = if status == "cancelling" {
        let cancellation = journal.run.get("cancellation").cloned().ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Interrupted cancellation request is unavailable.".into(),
            )
        })?;
        let requested = journal
            .events
            .iter()
            .find(|event| event.get("id").and_then(Value::as_str) == Some(previous))
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Interrupted cancellation event is unavailable.".into(),
                )
            })?;
        if requested.get("type").and_then(Value::as_str) != Some("cancellation-requested")
            || requested.pointer("/payload/cancellation") != Some(&cancellation)
        {
            return Err(crate::store::StoreError::Invalid(
                "Interrupted cancellation head is invalid.".into(),
            ));
        }
        (
            "run-cancelled",
            json!({"cancellation":cancellation}),
            "cancelled",
            "cancelled",
            "The mission was cancelled before Fable restarted.",
        )
    } else {
        (
            "run-failed",
            json!({"error":{"code":"mission-interrupted","category":"interrupted",
                "message":"The mission was interrupted before it reached a terminal result.",
                "retryable":true,"causedByEventId":previous}}),
            "failed",
            "failed",
            "The mission was interrupted before it reached a terminal result.",
        )
    };
    let event = json!({
        "workspaceId":journal.run.get("workspaceId"),"visibility":"member-private","ownerMemberId":member,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":internal_user_id,"createdAt":at,"updatedAt":at,
        "id":event_id,"runId":run_id,"type":event_type,"sequence":sequence,"previousEventId":previous,
        "attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":event_key,"payload":payload
    });
    let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("status".into(), json!(next_status));
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":event_id}),
    );
    let settled = mission_run::append(
        tx,
        store,
        scope,
        member,
        run_id,
        revision,
        last_sequence,
        &event_id,
        event_type,
        &event_key,
        &event,
        &Value::Object(projected),
        &at,
    )?;
    let acceptance = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|criterion| criterion.get("key").and_then(Value::as_str))
        .map(|criterion_key| {
            json!({"criterionKey":criterion_key,"status":"not-evaluated","evidenceRefs":[],
            "summary":"The mission ended before this criterion could be accepted."})
        })
        .collect::<Vec<_>>();
    let terminal_result = json!({"outcome":outcome,"summary":summary,"producingRunIds":[run_id],
        "outputs":[],"acceptance":acceptance,"completedAt":at});
    if outcome == "cancelled" {
        mission_plan::mark_cancelled(tx, store, scope, member, &lifecycle, &terminal_result, &at)?;
    } else {
        mission_plan::mark_failed(tx, store, scope, member, &lifecycle, &terminal_result, &at)?;
    }
    crate::mission_workers::append_cited_terminal_status_transcript(
        tx,
        store,
        scope,
        member,
        &settled,
        &lifecycle,
        &terminal_result,
        &event,
        &at,
    )?;
    Ok(Some(CitedMissionRestartRecovery::Terminalized {
        journal: settled,
    }))
}

#[allow(clippy::too_many_arguments)]
fn cited_restart_resume_descriptor(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    member: &str,
    internal_user_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
) -> crate::store::Result<Option<CitedMissionRestartRecovery>> {
    let run_id = journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run identity is invalid.".into())
        })?;
    let current_attempt = journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let max_attempts = lifecycle
        .mission
        .pointer("/budget/maxAttempts")
        .and_then(Value::as_i64);
    if current_attempt != 1 || max_attempts != Some(2) {
        return Ok(None);
    }
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
    let checkpoint_event_id = journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let checkpoint_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(checkpoint_event_id));
    if checkpoint_event
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str)
        != Some("checkpoint-created")
    {
        return Ok(None);
    }
    let checkpoint =
        mission_checkpoint::latest(tx, store, scope, member, run_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery checkpoint is missing.".into())
        })?;
    if checkpoint.checkpoint_event_id != checkpoint_event_id {
        return Err(crate::store::StoreError::Invalid(
            "Cited recovery checkpoint is not the current run head.".into(),
        ));
    }
    let checkpoint_event = checkpoint_event.expect("checked checkpoint event");
    verify_checkpoint_state(&checkpoint, checkpoint_event)
        .map_err(crate::store::StoreError::Invalid)?;
    let worker_events = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
        .collect::<Vec<_>>();
    let started_events = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-started"))
        .collect::<Vec<_>>();
    let route_events = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("route-selected"))
        .collect::<Vec<_>>();
    let tool_events = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("tool-call-completed"))
        .collect::<Vec<_>>();
    if worker_events.len() != 1
        || started_events.len() != 1
        || route_events.len() != 1
        || tool_events.len() != 1
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited recovery requires one exact worker evidence chain.".into(),
        ));
    }
    let worker = worker_events[0]
        .pointer("/payload/worker")
        .cloned()
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery worker is missing.".into())
        })?;
    let worker_id = worker.get("id").and_then(Value::as_str).ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited recovery worker is invalid.".into())
    })?;
    let step_key = worker
        .get("planStepKey")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery worker step is invalid.".into())
        })?;
    let worker_started_event_id = started_events[0]
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery worker start is invalid.".into())
        })?;
    let route_selected_event_id = route_events[0]
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery route is invalid.".into())
        })?;
    let tool_event_id = tool_events[0]
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery tool result is invalid.".into())
        })?;
    let output_reference = tool_events[0]
        .pointer("/payload/result/outputReference")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Cited recovery evidence reference is invalid.".into(),
            )
        })?;
    let provider_id = route_events[0]
        .pointer("/payload/providerId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery provider is unavailable.".into())
        })?;
    let model_reference = route_events[0]
        .pointer("/payload/modelReference")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery model is unavailable.".into())
        })?;
    let selection_value = route_events[0]
        .pointer("/payload/selection")
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery route selection is invalid.".into())
        })?;
    let selection =
        serde_json::from_value::<crate::models::ProviderRouteSelection>(selection_value.clone())
            .map_err(|_| {
                crate::store::StoreError::Invalid(
                    "Cited recovery route selection is invalid.".into(),
                )
            })?;
    let provider_route_id = crate::backends::validate_account_native_provider_model(
        tx,
        internal_user_id,
        provider_id,
        model_reference,
    )
    .map_err(crate::store::StoreError::Invalid)?;
    crate::backends::validate_native_provider_route_selection_in_tx(
        tx,
        store,
        internal_user_id,
        provider_id,
        model_reference,
        &provider_route_id,
        Some(crate::backends::NATIVE_CITED_BRIEF_POLICY_REVISION),
        &selection,
    )
    .map_err(crate::store::StoreError::Invalid)?;
    let route_sequence = route_events[0].get("sequence").and_then(Value::as_i64);
    let tool_sequence = tool_events[0].get("sequence").and_then(Value::as_i64);
    let exact = worker.get("runId").and_then(Value::as_str) == Some(run_id)
        && worker.get("planRevisionId") == lifecycle.current_revision.get("id")
        && worker.get("planStepKey").and_then(Value::as_str) == Some(step_key)
        && worker
            .pointer("/budget/maxAttempts")
            .and_then(Value::as_i64)
            == Some(1)
        && worker
            .pointer("/outputContract/includeEvidence")
            .and_then(Value::as_bool)
            == Some(true)
        && started_events[0]
            .pointer("/payload/workerId")
            .and_then(Value::as_str)
            == Some(worker_id)
        && route_events[0]
            .get("previousEventId")
            .and_then(Value::as_str)
            == Some(worker_started_event_id)
        && route_events[0]
            .pointer("/payload/workerId")
            .and_then(Value::as_str)
            == Some(worker_id)
        && journal.run.get("selectedRoute") == Some(selection_value)
        && tool_events[0]
            .get("previousEventId")
            .and_then(Value::as_str)
            == Some(route_selected_event_id)
        && tool_events[0]
            .pointer("/payload/result/workerId")
            .and_then(Value::as_str)
            == Some(worker_id)
        && tool_events[0]
            .pointer("/payload/result/toolName")
            .and_then(Value::as_str)
            == Some("connection-read")
        && route_sequence
            .zip(tool_sequence)
            .is_some_and(|(route, tool)| tool == route + 1)
        && tool_sequence.is_some_and(|tool| last_sequence == tool + 1)
        && checkpoint_event
            .get("previousEventId")
            .and_then(Value::as_str)
            == Some(tool_event_id)
        && checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/resumeAfterEventId")
            .and_then(Value::as_str)
            == Some(tool_event_id)
        && checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/durableThroughSequence")
            .and_then(Value::as_i64)
            == tool_sequence
        && checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/completedWorkerIds")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        && checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/committedEffectKeys")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        && checkpoint.attempt_number == current_attempt
        && checkpoint.state
            == json!({"activeWorkerIds":[worker_id],"activePlanStepKeys":[step_key],"pendingWaitKeys":[]});
    if !exact {
        return Err(crate::store::StoreError::Invalid(
            "Cited recovery evidence chain does not match its durable checkpoint.".into(),
        ));
    }
    let evidence_binding = crate::mission_workers::NativeWorkerToolEvidenceBinding {
        tool_event_id: tool_event_id.to_string(),
        output_reference: output_reference.to_string(),
    };
    let evidence = crate::mission_workers::load_cited_tool_evidence(
        tx,
        store,
        scope,
        member,
        journal,
        run_id,
        worker_id,
        &worker,
        &evidence_binding,
    )?;
    let source_thread_id = lifecycle
        .mission
        .pointer("/scope/sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited recovery thread is unavailable.".into())
        })?;
    let identity = format!(
        "fable.cited-restart-resume.v1\0{}\0{}\0{}\0{}",
        scope.workspace_id(),
        member,
        run_id,
        checkpoint_event_id
    );
    let digest = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let event_id = |role: &str| format!("mission-resume-{role}-{}", &digest[..32]);
    Ok(Some(CitedMissionRestartRecovery::Resumable {
        run_id: run_id.to_string(),
        source_thread_id: source_thread_id.to_string(),
        worker,
        provider_id: provider_id.to_string(),
        model_reference: model_reference.to_string(),
        worker_started_event_id: worker_started_event_id.to_string(),
        route_selected_event_id: route_selected_event_id.to_string(),
        checkpoint_event_id: checkpoint_event_id.to_string(),
        checkpoint_restore_event_id: event_id("restore"),
        tool_event_id: tool_event_id.to_string(),
        output_reference: output_reference.to_string(),
        evidence,
        restore_idempotency_key: format!("cited-restart-restore:v1:{}", &digest[..32]),
        terminal_idempotency_key: format!("cited-restart-terminal:v1:{}", &digest[..32]),
        usage_event_id: event_id("usage"),
        completion_event_id: event_id("completion"),
        evaluation_event_id: event_id("evaluation"),
        result_event_id: event_id("result"),
        failure_event_id: event_id("failure"),
        expected_run_revision: revision,
        expected_last_sequence: last_sequence,
        new_attempt_number: current_attempt + 1,
    }))
}

fn is_cited_recovery_shape(run: &Value, lifecycle: &mission_plan::MissionPlanLifecycleRow) -> bool {
    lifecycle.mission.get("status").and_then(Value::as_str) == Some("running")
        && is_cited_transcript_shape(run, lifecycle)
}

fn is_cited_transcript_shape(
    run: &Value,
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
    run.get("planRevisionId") == lifecycle.current_revision.get("id")
        && lifecycle
            .mission
            .pointer("/acceptance/requiresHumanAcceptance")
            .and_then(Value::as_bool)
            == Some(false)
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
        })
        && criteria.is_some_and(|criteria| {
            !criteria.is_empty()
                && criteria.iter().all(|criterion| {
                    criterion.get("evaluator").and_then(Value::as_str) == Some("policy")
                })
        })
}

#[tauri::command]
pub fn mission_run_create_checkpoint(
    input: MissionCheckpointCreateInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, context, member) = authorized(tx)?;
            validate_key(&input.idempotency_key, "Checkpoint idempotency key", 200)
                .map_err(crate::store::StoreError::Invalid)?;
            let journal =
                mission_run::get(tx, store, &scope, &member, &input.run_id)?.ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let facts = derive_replay_facts(&journal.events, input.durable_through_sequence)
                .map_err(crate::store::StoreError::Invalid)?;
            let state = facts.state.clone();
            let reference = format!("checkpoint:{}", input.event_id);
            let state_hash = checkpoint_state_hash(
                &input.run_id,
                &input.event_id,
                input.attempt_number,
                &reference,
                &state,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let event_key = format!("checkpoint:{}", input.idempotency_key.trim());
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                exact_checkpoint_replay(existing, &input, &state_hash, &facts)
                    .map_err(crate::store::StoreError::Invalid)?;
                let stored =
                    mission_checkpoint::get_by_event(tx, store, &scope, &member, &input.event_id)?
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "Checkpoint state is unavailable for the replayed event.".into(),
                            )
                        })?;
                if stored.state_hash != state_hash || stored.state != state {
                    return Err(crate::store::StoreError::Invalid(
                        "Replayed checkpoint state does not match the original request.".into(),
                    ));
                }
                return Ok(journal);
            }
            let at = now();
            let (projected, event, reference) = build_checkpoint(
                &journal,
                &input,
                &state_hash,
                &facts,
                &context.internal_user_id,
                &member,
                &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let saved = mission_run::append(
                tx,
                store,
                &scope,
                &member,
                &input.run_id,
                input.expected_run_revision,
                input.expected_last_sequence,
                &input.event_id,
                "checkpoint-created",
                &event_key,
                &event,
                &projected,
                &at,
            )?;
            mission_checkpoint::put(
                tx,
                store,
                &scope,
                &member,
                &input.run_id,
                &input.event_id,
                input.attempt_number,
                &reference,
                &state_hash,
                &state,
                &at,
            )?;
            Ok(saved)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_run_restore_checkpoint(
    input: MissionCheckpointRestoreInput,
) -> Result<MissionCheckpointRestoreResult, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, context, member) = authorized(tx)?;
            validate_key(
                &input.idempotency_key,
                "Checkpoint restore idempotency key",
                200,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let journal =
                mission_run::get(tx, store, &scope, &member, &input.run_id)?.ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let event_key = format!("restore:{}", input.idempotency_key.trim());
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                let checkpoint_event_id = existing
                    .pointer("/payload/checkpointEventId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "Replayed checkpoint restore is invalid.".into(),
                        )
                    })?;
                let checkpoint = mission_checkpoint::get_by_event(
                    tx,
                    store,
                    &scope,
                    &member,
                    checkpoint_event_id,
                )?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Checkpoint state is unavailable for the replayed restore.".into(),
                    )
                })?;
                let checkpoint_event = journal
                    .events
                    .iter()
                    .find(|event| {
                        event.get("id").and_then(Value::as_str) == Some(checkpoint_event_id)
                            && event.get("type").and_then(Value::as_str)
                                == Some("checkpoint-created")
                    })
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "Checkpoint event is unavailable for the replayed restore.".into(),
                        )
                    })?;
                verify_checkpoint_state(&checkpoint, checkpoint_event)
                    .map_err(crate::store::StoreError::Invalid)?;
                exact_restore_replay(existing, &input, &checkpoint)
                    .map_err(crate::store::StoreError::Invalid)?;
                return Ok(MissionCheckpointRestoreResult {
                    journal,
                    checkpoint,
                });
            }
            let checkpoint = mission_checkpoint::latest(tx, store, &scope, &member, &input.run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run has no restorable checkpoint.".into(),
                    )
                })?;
            let checkpoint_event = journal
                .events
                .iter()
                .find(|event| {
                    event.get("id").and_then(Value::as_str)
                        == Some(checkpoint.checkpoint_event_id.as_str())
                        && event.get("type").and_then(Value::as_str) == Some("checkpoint-created")
                })
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Checkpoint event is unavailable in this run.".into(),
                    )
                })?;
            verify_checkpoint_state(&checkpoint, checkpoint_event)
                .map_err(crate::store::StoreError::Invalid)?;
            let at = now();
            let (projected, event) = build_checkpoint_restore(
                &journal.run,
                &input,
                &checkpoint,
                &context.internal_user_id,
                &member,
                &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let journal = mission_run::append(
                tx,
                store,
                &scope,
                &member,
                &input.run_id,
                input.expected_run_revision,
                input.expected_last_sequence,
                &input.event_id,
                "checkpoint-restored",
                &event_key,
                &event,
                &projected,
                &at,
            )?;
            Ok(MissionCheckpointRestoreResult {
                journal,
                checkpoint,
            })
        })
        .map_err(|error| error.to_string())
}

fn build_run_created(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    input: &MissionRunCreateInput,
    actor: &str,
    member: &str,
    at: &str,
) -> Result<(Value, Value), String> {
    let mission = lifecycle
        .mission
        .as_object()
        .ok_or_else(|| "Mission record is invalid.".to_string())?;
    if mission.get("id").and_then(Value::as_str) != Some(input.mission_id.as_str())
        || mission.get("status").and_then(Value::as_str) != Some("ready")
        || mission.get("currentPlanRevisionId").and_then(Value::as_str)
            != lifecycle.current_revision.get("id").and_then(Value::as_str)
    {
        return Err("Mission is not ready with one selected plan revision.".into());
    }
    let plan = lifecycle
        .plan
        .as_object()
        .ok_or_else(|| "Mission plan is invalid.".to_string())?;
    let revision = lifecycle
        .current_revision
        .as_object()
        .ok_or_else(|| "Mission plan revision is invalid.".to_string())?;
    if plan.get("status").and_then(Value::as_str) != Some("current")
        || plan.get("missionId").and_then(Value::as_str) != Some(input.mission_id.as_str())
        || plan.get("currentRevisionId").and_then(Value::as_str)
            != revision.get("id").and_then(Value::as_str)
        || revision.get("missionId").and_then(Value::as_str) != Some(input.mission_id.as_str())
        || revision.get("planId").and_then(Value::as_str) != plan.get("id").and_then(Value::as_str)
    {
        return Err("Mission plan lifecycle is inconsistent.".into());
    }
    let workspace = required(mission, "workspaceId")?;
    let plan_revision_id = required(mission, "currentPlanRevisionId")?;
    let depth = required(mission, "executionDepth")?;
    let scope = mission
        .get("scope")
        .and_then(Value::as_object)
        .ok_or_else(|| "Mission scope is invalid.".to_string())?;
    let base_metadata = metadata(&workspace, member, actor, at, 1);
    let mut fresh = object(base_metadata)?;
    fresh.extend(object(json!({
        "id":input.run_id,"status":"created","parentage":{"kind":"root"},
        "departmentIds":scope.get("departmentIds").cloned().unwrap_or_else(||json!([])),
        "planRevisionId":plan_revision_id,
        "budget":mission.get("budget").cloned().unwrap_or_else(||json!({"maxAttempts":1})),
        "eventHead":{"lastSequence":0},"kind":"mission","executionDepth":depth,
        "initiator":{"kind":"mission","missionId":input.mission_id}
    }))?);
    copy_optional(scope, &mut fresh, "sourceThreadId");
    copy_optional(scope, &mut fresh, "projectId");
    copy_optional(scope, &mut fresh, "goalId");
    let fresh = Value::Object(fresh);
    let mut event = object(metadata(&workspace, member, actor, at, 1))?;
    event.extend(object(json!({
        "id":input.event_id,"runId":input.run_id,"type":"run-created","sequence":1,
        "occurredAt":at,"actor":{"kind":"internal-user","internalUserId":actor,"memberId":member},
        "idempotencyKey":format!("create:{}",input.idempotency_key.trim()),"payload":{"run":fresh}
    }))?);
    let mut projected = object(fresh)?;
    projected.insert("revision".into(), json!(2));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":1,"lastEventId":input.event_id}),
    );
    Ok((Value::Object(projected), Value::Object(event)))
}

fn build_cancellation(
    current: &Value,
    input: &MissionRunCancelInput,
    actor: &str,
    member: &str,
    at: &str,
) -> Result<(Value, Value), String> {
    validate_cancellation_input(input)?;
    let status = required(
        current
            .as_object()
            .ok_or_else(|| "Mission run is invalid.".to_string())?,
        "status",
    )?;
    if matches!(
        status.as_str(),
        "completed" | "partially-completed" | "failed" | "cancelled" | "cancelling"
    ) {
        return Err("Mission run cannot accept another cancellation request.".into());
    }
    if current.get("revision").and_then(Value::as_i64) != Some(input.expected_run_revision)
        || current
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
    {
        return Err("The mission run changed before cancellation could be requested.".into());
    }
    let workspace = current
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run workspace is invalid.".to_string())?;
    let previous = current
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run event head is invalid.".to_string())?;
    let sequence = input.expected_last_sequence + 1;
    let cancellation = json!({
        "requestKey":input.request_key.trim(),"requestedAt":at,"requestedByInternalUserId":actor,
        "scope":"run","reason":input.reason.as_deref().map(str::trim).filter(|value|!value.is_empty()),"mode":input.mode
    });
    let mut event = object(metadata(workspace, member, actor, at, 1))?;
    event.extend(object(json!({
        "id":input.event_id,"runId":input.run_id,"type":"cancellation-requested","sequence":sequence,
        "previousEventId":previous,"occurredAt":at,
        "actor":{"kind":"internal-user","internalUserId":actor,"memberId":member},
        "idempotencyKey":format!("cancel:{}",input.request_key.trim()),"payload":{"cancellation":cancellation}
    }))?);
    let mut projected = object(current.clone())?;
    projected.insert("status".into(), json!("cancelling"));
    projected.insert("revision".into(), json!(input.expected_run_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert("cancellation".into(), cancellation);
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":input.event_id}),
    );
    Ok((Value::Object(projected), Value::Object(event)))
}

fn build_checkpoint(
    journal: &mission_run::MissionRunJournalRow,
    input: &MissionCheckpointCreateInput,
    state_hash: &str,
    facts: &ReplayFacts,
    actor: &str,
    member: &str,
    at: &str,
) -> Result<(Value, Value, String), String> {
    let current = &journal.run;
    validate_live_head(
        current,
        input.expected_run_revision,
        input.expected_last_sequence,
    )?;
    let current_attempt = current
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    if input.attempt_number != current_attempt {
        return Err("Checkpoint attempt does not match the current run attempt.".into());
    }
    if input.durable_through_sequence < 1
        || input.durable_through_sequence >= input.expected_last_sequence + 1
    {
        return Err("Checkpoint durable sequence is invalid.".into());
    }
    let resume = journal.events.iter().find(|event| {
        event.get("id").and_then(Value::as_str) == Some(input.resume_after_event_id.as_str())
    });
    if resume
        .and_then(|event| event.get("sequence"))
        .and_then(Value::as_i64)
        != Some(input.durable_through_sequence)
    {
        return Err("Checkpoint replay boundary is unavailable in this run.".into());
    }
    let workspace = current
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run workspace is invalid.".to_string())?;
    let previous = current
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run event head is invalid.".to_string())?;
    let sequence = input.expected_last_sequence + 1;
    let reference = format!("checkpoint:{}", input.event_id);
    let checkpoint = json!({"kind":"manual","attemptNumber":input.attempt_number,"createdAt":at,
        "replayBoundary":{"durableThroughSequence":input.durable_through_sequence,"resumeAfterEventId":input.resume_after_event_id,
        "completedPlanStepKeys":facts.completed_plan_step_keys,"completedWorkerIds":facts.completed_worker_ids,"committedEffectKeys":facts.committed_effect_keys},
        "stateStorage":"portable-redacted","stateReference":reference,"stateHash":state_hash,"executionNodeId":"local-desktop"});
    let mut event = object(metadata(workspace, member, actor, at, 1))?;
    event.extend(object(json!({"id":input.event_id,"runId":input.run_id,"type":"checkpoint-created","sequence":sequence,
        "previousEventId":previous,"attemptNumber":input.attempt_number,"occurredAt":at,
        "actor":{"kind":"internal-user","internalUserId":actor,"memberId":member},
        "idempotencyKey":format!("checkpoint:{}",input.idempotency_key.trim()),"payload":{"checkpoint":checkpoint}}))?);
    let mut projected = object(current.clone())?;
    projected.insert("revision".into(), json!(input.expected_run_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":input.event_id}),
    );
    Ok((Value::Object(projected), Value::Object(event), reference))
}

fn build_checkpoint_restore(
    current: &Value,
    input: &MissionCheckpointRestoreInput,
    checkpoint: &mission_checkpoint::CheckpointStateRow,
    actor: &str,
    member: &str,
    at: &str,
) -> Result<(Value, Value), String> {
    validate_live_head(
        current,
        input.expected_run_revision,
        input.expected_last_sequence,
    )?;
    let current_attempt = current
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    if input.new_attempt_number != current_attempt + 1
        || input.new_attempt_number <= checkpoint.attempt_number
    {
        return Err("Checkpoint restore must advance exactly one run attempt.".into());
    }
    let workspace = current
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run workspace is invalid.".to_string())?;
    let previous = current
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run event head is invalid.".to_string())?;
    let sequence = input.expected_last_sequence + 1;
    let mut event = object(metadata(workspace, member, actor, at, 1))?;
    event.extend(object(json!({"id":input.event_id,"runId":input.run_id,"type":"checkpoint-restored","sequence":sequence,
        "previousEventId":previous,"attemptNumber":input.new_attempt_number,"occurredAt":at,
        "actor":{"kind":"internal-user","internalUserId":actor,"memberId":member},
        "idempotencyKey":format!("restore:{}",input.idempotency_key.trim()),
        "payload":{"checkpointEventId":checkpoint.checkpoint_event_id,"newAttemptNumber":input.new_attempt_number}}))?);
    let mut projected = object(current.clone())?;
    projected.insert("revision".into(), json!(input.expected_run_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "currentAttemptNumber".into(),
        json!(input.new_attempt_number),
    );
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":input.event_id}),
    );
    Ok((Value::Object(projected), Value::Object(event)))
}

fn validate_live_head(current: &Value, revision: i64, sequence: i64) -> Result<(), String> {
    let status = current.get("status").and_then(Value::as_str).unwrap_or("");
    if matches!(
        status,
        "completed" | "partially-completed" | "failed" | "cancelled" | "cancelling"
    ) {
        return Err("Mission run is not available for checkpoint recovery.".into());
    }
    if current.get("revision").and_then(Value::as_i64) != Some(revision)
        || current
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(sequence)
    {
        return Err("The mission run changed before the checkpoint operation.".into());
    }
    Ok(())
}

struct ReplayFacts {
    completed_plan_step_keys: Vec<String>,
    completed_worker_ids: Vec<String>,
    committed_effect_keys: Vec<String>,
    state: Value,
}

fn derive_replay_facts(events: &[Value], durable_through: i64) -> Result<ReplayFacts, String> {
    let mut worker_steps = BTreeMap::<String, String>::new();
    let mut active_workers = BTreeSet::<String>::new();
    let mut completed_workers = BTreeSet::<String>::new();
    let mut completed_steps = BTreeSet::<String>::new();
    let mut committed_effects = BTreeSet::<String>::new();
    let mut pending_waits = BTreeSet::<String>::new();
    for event in events.iter().filter(|event| {
        event
            .get("sequence")
            .and_then(Value::as_i64)
            .is_some_and(|sequence| sequence <= durable_through)
    }) {
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "worker-created" => {
                let worker = event
                    .pointer("/payload/worker")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Worker creation event is invalid.".to_string())?;
                let id = required(worker, "id")?;
                if let Some(step) = worker.get("planStepKey").and_then(Value::as_str) {
                    worker_steps.insert(id, step.to_string());
                }
            }
            "worker-started" => {
                if let Some(id) = event.pointer("/payload/workerId").and_then(Value::as_str) {
                    active_workers.insert(id.to_string());
                }
            }
            "worker-completed" => {
                if let Some(id) = event.pointer("/payload/workerId").and_then(Value::as_str) {
                    active_workers.remove(id);
                    completed_workers.insert(id.to_string());
                    if let Some(step) = worker_steps.get(id) {
                        completed_steps.insert(step.clone());
                    }
                }
            }
            "worker-failed" => {
                if let Some(id) = event.pointer("/payload/workerId").and_then(Value::as_str) {
                    active_workers.remove(id);
                }
            }
            "side-effect-recorded" => {
                if matches!(
                    event
                        .pointer("/payload/receipt/outcome")
                        .and_then(Value::as_str),
                    Some("committed" | "deduplicated")
                ) {
                    if let Some(key) = event
                        .pointer("/payload/receipt/boundary/effectKey")
                        .and_then(Value::as_str)
                    {
                        committed_effects.insert(key.to_string());
                    }
                }
            }
            "worker-waiting" => {
                if let Some(key) = event.pointer("/payload/waitKey").and_then(Value::as_str) {
                    pending_waits.insert(key.to_string());
                }
            }
            "approval-requested" | "human-input-requested" => {
                if let Some(key) = event
                    .pointer("/payload/wait/waitKey")
                    .and_then(Value::as_str)
                {
                    pending_waits.insert(key.to_string());
                }
            }
            "approval-resolved" | "human-input-received" => {
                if let Some(key) = event
                    .pointer("/payload/resolution/waitKey")
                    .and_then(Value::as_str)
                {
                    pending_waits.remove(key);
                }
            }
            _ => {}
        }
    }
    let active_plan_step_keys = active_workers
        .iter()
        .filter_map(|id| worker_steps.get(id).cloned())
        .collect::<BTreeSet<_>>();
    let state = json!({"activeWorkerIds":active_workers,"activePlanStepKeys":active_plan_step_keys,"pendingWaitKeys":pending_waits});
    let bytes = serde_json::to_vec(&state)
        .map_err(|_| "Checkpoint state could not be encoded.".to_string())?;
    if bytes.len() > MAX_CHECKPOINT_STATE_BYTES {
        return Err("Checkpoint state exceeds its storage limit.".into());
    }
    Ok(ReplayFacts {
        completed_plan_step_keys: completed_steps.into_iter().collect(),
        completed_worker_ids: completed_workers.into_iter().collect(),
        committed_effect_keys: committed_effects.into_iter().collect(),
        state,
    })
}

fn checkpoint_state_hash(
    run_id: &str,
    event_id: &str,
    attempt: i64,
    reference: &str,
    state: &Value,
) -> Result<String, String> {
    let envelope = json!({"runId":run_id,"checkpointEventId":event_id,"attemptNumber":attempt,"stateReference":reference,"state":state});
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|_| "Checkpoint state could not be encoded.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn verify_checkpoint_state(
    checkpoint: &mission_checkpoint::CheckpointStateRow,
    event: &Value,
) -> Result<(), String> {
    if event.get("id").and_then(Value::as_str) != Some(checkpoint.checkpoint_event_id.as_str())
        || event.get("runId").and_then(Value::as_str) != Some(checkpoint.run_id.as_str())
        || event
            .pointer("/payload/checkpoint/attemptNumber")
            .and_then(Value::as_i64)
            != Some(checkpoint.attempt_number)
        || event
            .pointer("/payload/checkpoint/stateReference")
            .and_then(Value::as_str)
            != Some(checkpoint.state_reference.as_str())
        || event
            .pointer("/payload/checkpoint/stateHash")
            .and_then(Value::as_str)
            != Some(checkpoint.state_hash.as_str())
    {
        return Err("Checkpoint state metadata does not match its immutable event.".into());
    }
    let hash = checkpoint_state_hash(
        &checkpoint.run_id,
        &checkpoint.checkpoint_event_id,
        checkpoint.attempt_number,
        &checkpoint.state_reference,
        &checkpoint.state,
    )?;
    if hash != checkpoint.state_hash {
        return Err("Checkpoint state failed its integrity check.".into());
    }
    Ok(())
}
fn exact_checkpoint_replay(
    event: &Value,
    input: &MissionCheckpointCreateInput,
    state_hash: &str,
    facts: &ReplayFacts,
) -> Result<(), String> {
    if event.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
        && event.get("type").and_then(Value::as_str) == Some("checkpoint-created")
        && event
            .pointer("/payload/checkpoint/stateHash")
            .and_then(Value::as_str)
            == Some(state_hash)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_last_sequence + 1)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_run_revision)
        && event
            .pointer("/payload/checkpoint/attemptNumber")
            .and_then(Value::as_i64)
            == Some(input.attempt_number)
        && event
            .pointer("/payload/checkpoint/replayBoundary/durableThroughSequence")
            .and_then(Value::as_i64)
            == Some(input.durable_through_sequence)
        && event
            .pointer("/payload/checkpoint/replayBoundary/resumeAfterEventId")
            .and_then(Value::as_str)
            == Some(input.resume_after_event_id.as_str())
        && event.pointer("/payload/checkpoint/replayBoundary/completedPlanStepKeys")
            == Some(&json!(facts.completed_plan_step_keys))
        && event.pointer("/payload/checkpoint/replayBoundary/completedWorkerIds")
            == Some(&json!(facts.completed_worker_ids))
        && event.pointer("/payload/checkpoint/replayBoundary/committedEffectKeys")
            == Some(&json!(facts.committed_effect_keys))
    {
        Ok(())
    } else {
        Err("Checkpoint idempotency key already represents another request.".into())
    }
}
fn exact_restore_replay(
    event: &Value,
    input: &MissionCheckpointRestoreInput,
    checkpoint: &mission_checkpoint::CheckpointStateRow,
) -> Result<(), String> {
    if event.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
        && event.get("type").and_then(Value::as_str) == Some("checkpoint-restored")
        && event
            .pointer("/payload/checkpointEventId")
            .and_then(Value::as_str)
            == Some(checkpoint.checkpoint_event_id.as_str())
        && event
            .pointer("/payload/newAttemptNumber")
            .and_then(Value::as_i64)
            == Some(input.new_attempt_number)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_last_sequence + 1)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_run_revision)
    {
        Ok(())
    } else {
        Err("Checkpoint restore idempotency key already represents another request.".into())
    }
}

fn metadata(workspace: &str, member: &str, actor: &str, at: &str, revision: i64) -> Value {
    json!({"workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,"authority":"local","schemaVersion":1,"revision":revision,"createdByInternalUserId":actor,"createdAt":at,"updatedAt":at})
}
fn object(value: Value) -> Result<Map<String, Value>, String> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "Mission run record is invalid.".into())
}
fn required(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Mission {key} is invalid."))
}
fn copy_optional(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.into(), value.clone());
    }
}

fn validate_key(value: &str, label: &str, max: usize) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn validate_cancellation_input(input: &MissionRunCancelInput) -> Result<(), String> {
    if !matches!(input.mode.as_str(), "cooperative" | "immediate-if-safe") {
        return Err("Mission run cancellation mode is invalid.".into());
    }
    validate_key(&input.request_key, "Mission run cancellation key", 160)?;
    if let Some(reason) = input.reason.as_deref() {
        if reason.chars().count() > 1_000 || reason.chars().any(char::is_control) {
            return Err("Mission run cancellation reason is invalid.".into());
        }
    }
    Ok(())
}

fn exact_create_replay(
    journal: &mission_run::MissionRunJournalRow,
    input: &MissionRunCreateInput,
) -> Result<(), String> {
    let first = journal
        .events
        .first()
        .ok_or_else(|| "Stored mission run has no creation event.".to_string())?;
    if journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        == Some(input.mission_id.as_str())
        && first.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
        && first.get("idempotencyKey").and_then(Value::as_str)
            == Some(format!("create:{}", input.idempotency_key.trim()).as_str())
    {
        Ok(())
    } else {
        Err("Mission run id or idempotency key already represents another request.".into())
    }
}

fn exact_cancellation_replay(
    event: &Value,
    input: &MissionRunCancelInput,
    actor: &str,
) -> Result<(), String> {
    let expected_reason = input
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let stored_reason = event
        .pointer("/payload/cancellation/reason")
        .and_then(Value::as_str);
    if event.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
        && event.get("type").and_then(Value::as_str) == Some("cancellation-requested")
        && event
            .pointer("/payload/cancellation/requestKey")
            .and_then(Value::as_str)
            == Some(input.request_key.trim())
        && event
            .pointer("/payload/cancellation/mode")
            .and_then(Value::as_str)
            == Some(input.mode.as_str())
        && event
            .pointer("/payload/cancellation/requestedByInternalUserId")
            .and_then(Value::as_str)
            == Some(actor)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_last_sequence + 1)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_run_revision)
        && stored_reason == expected_reason
    {
        Ok(())
    } else {
        Err("Cancellation idempotency key already represents another request.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    fn lifecycle() -> mission_plan::MissionPlanLifecycleRow {
        mission_plan::MissionPlanLifecycleRow {
            mission: json!({"id":"mission-1","workspaceId":"workspace-1","status":"ready","executionDepth":"delegated","currentPlanRevisionId":"revision-1","scope":{"sourceThreadId":"thread-1","departmentIds":[],"context":[]},"budget":{"maxAttempts":2}}),
            plan: json!({"id":"plan-1","missionId":"mission-1","status":"current","currentRevisionId":"revision-1"}),
            current_revision: json!({"id":"revision-1","planId":"plan-1","missionId":"mission-1"}),
        }
    }

    #[test]
    fn creation_derives_private_actor_scope_and_selected_plan() {
        let input = MissionRunCreateInput {
            mission_id: "mission-1".into(),
            run_id: "run-1".into(),
            event_id: "event-1".into(),
            idempotency_key: "create-1".into(),
        };
        let (run, event) =
            build_run_created(&lifecycle(), &input, "user-real", "member-real", "t1").unwrap();
        assert_eq!(run["workspaceId"], "workspace-1");
        assert_eq!(run["ownerMemberId"], "member-real");
        assert_eq!(run["planRevisionId"], "revision-1");
        assert_eq!(run["eventHead"]["lastSequence"], 1);
        assert_eq!(event["actor"]["internalUserId"], "user-real");
        assert_eq!(event["payload"]["run"]["eventHead"]["lastSequence"], 0);
    }

    #[test]
    fn cancellation_derives_sequence_actor_and_cancelling_projection() {
        let current = json!({"id":"run-1","workspaceId":"workspace-1","status":"running","revision":3,"eventHead":{"lastSequence":2,"lastEventId":"event-2"}});
        let input = MissionRunCancelInput {
            run_id: "run-1".into(),
            event_id: "event-3".into(),
            request_key: "stop-1".into(),
            expected_run_revision: 3,
            expected_last_sequence: 2,
            mode: "cooperative".into(),
            reason: Some("User stopped".into()),
        };
        let (run, event) =
            build_cancellation(&current, &input, "user-real", "member-real", "t3").unwrap();
        assert_eq!(run["status"], "cancelling");
        assert_eq!(run["revision"], 4);
        assert_eq!(event["previousEventId"], "event-2");
        assert_eq!(
            event["payload"]["cancellation"]["requestedByInternalUserId"],
            "user-real"
        );
        exact_cancellation_replay(&event, &input, "user-real").unwrap();
        let changed = MissionRunCancelInput {
            mode: "immediate-if-safe".into(),
            ..input
        };
        assert!(exact_cancellation_replay(&event, &changed, "user-real").is_err());
    }

    #[test]
    fn restart_recovery_is_limited_to_the_exact_cited_plan_shape() {
        let run = json!({"planRevisionId":"revision-1"});
        let mut cited = mission_plan::MissionPlanLifecycleRow {
            mission: json!({"status":"running","acceptance":{"requiresHumanAcceptance":false,
                "criteria":[{"key":"cited","evaluator":"policy"}]}}),
            plan: json!({}),
            current_revision: json!({"id":"revision-1","steps":[{
                "requiredCapabilities":["knowledge.content.search"],
                "expectedOutputs":[{"format":"text/markdown"}]
            }]}),
        };
        assert!(is_cited_recovery_shape(&run, &cited));
        cited.current_revision["steps"][0]["requiredCapabilities"] = json!(["model.generate"]);
        assert!(!is_cited_recovery_shape(&run, &cited));
        cited.current_revision["steps"][0]["requiredCapabilities"] =
            json!(["knowledge.content.search"]);
        cited.mission["acceptance"]["requiresHumanAcceptance"] = json!(true);
        assert!(!is_cited_recovery_shape(&run, &cited));
    }

    #[test]
    fn stale_cited_run_recovery_atomically_fails_run_and_mission() {
        let store = crate::store::Store::open_in_memory(
            Vault::new(&MasterKey::generate().unwrap()).unwrap(),
        )
        .unwrap();
        store
            .transaction(|tx| {
                tx.execute(
                    "INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",
                    [],
                )?;
                crate::store::repos::thread::create(
                    tx,
                    &store,
                    &DataScope::workspace("w1")?,
                    "thread-1",
                    None,
                    "Cited recovery",
                    "t",
                    &json!({}),
                )?;
                Ok(())
            })
            .unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let mission = json!({
            "id":"mission-1","workspaceId":"w1","visibility":"member-private","ownerMemberId":"member-1",
            "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":"user-1","createdAt":"t1","updatedAt":"t1",
            "status":"ready","executionDepth":"delegated","currentPlanId":"plan-1","currentPlanRevisionId":"revision-1",
            "scope":{"workspaceId":"w1","sourceThreadId":"thread-1","departmentIds":[],"context":[]},"budget":{"maxAttempts":1},
            "acceptance":{"requiresHumanAcceptance":false,"criteria":[{"key":"cited","evaluator":"policy"}]}
        });
        let plan = json!({"id":"plan-1","missionId":"mission-1","status":"current","currentRevisionId":"revision-1","currentRevisionNumber":1,"revision":1});
        let revision = json!({
            "id":"revision-1","planId":"plan-1","missionId":"mission-1","planRevisionNumber":1,
            "summary":"Search the connected launch notes.",
            "steps":[{"requiredCapabilities":["knowledge.content.search"],
                "expectedOutputs":[{"format":"text/markdown"}]}]
        });
        let lifecycle = store
            .transaction(|tx| {
                mission_plan::create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "mission-1",
                    "plan-1",
                    "revision-1",
                    "delegated",
                    &mission,
                    &plan,
                    &revision,
                    "t1",
                )
            })
            .unwrap();
        let input = MissionRunCreateInput {
            mission_id: "mission-1".into(),
            run_id: "run-1".into(),
            event_id: "event-1".into(),
            idempotency_key: "create-1".into(),
        };
        let (run, event) =
            build_run_created(&lifecycle, &input, "user-1", "member-1", "t2").unwrap();
        store
            .transaction(|tx| {
                mission_run::create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "run-1",
                    "event-1",
                    "create:create-1",
                    &run,
                    &event,
                    "t2",
                )?;
                mission_plan::mark_running(tx, &store, &scope, "member-1", &lifecycle, "t2")?;
                Ok(())
            })
            .unwrap();
        let recovered = store
            .transaction(|tx| {
                recover_interrupted_cited_run(tx, &store, &scope, "member-1", "user-1", "run-1")
            })
            .unwrap()
            .unwrap();
        let CitedMissionRestartRecovery::Terminalized { journal: recovered } = recovered else {
            panic!("legacy one-attempt cited runs must be terminalized");
        };
        assert_eq!(recovered.run["status"], "failed");
        assert_eq!(recovered.events.last().unwrap()["type"], "run-failed");
        assert_eq!(
            recovered.events.last().unwrap()["payload"]["error"]["code"],
            "mission-interrupted"
        );
        let recovered_mission = store
            .with_conn(|tx| mission_plan::get(tx, &store, &scope, "member-1", "mission-1"))
            .unwrap()
            .unwrap();
        assert_eq!(recovered_mission.mission["status"], "failed");
        assert_eq!(
            recovered_mission.mission["terminalResult"]["outcome"],
            "failed"
        );
        let messages = store
            .with_conn(|tx| crate::store::repos::message::list(tx, &store, &scope, "thread-1"))
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].content,
            json!("Search the connected launch notes.")
        );
        assert_eq!(messages[1].detail["outcome"], "failed");
        assert_eq!(
            messages[1].content,
            json!(
                "Mission failed: The mission was interrupted before it reached a terminal result."
            )
        );
    }

    #[test]
    fn creation_replay_requires_the_same_mission_event_and_namespaced_key() {
        let input = MissionRunCreateInput {
            mission_id: "mission-1".into(),
            run_id: "run-1".into(),
            event_id: "event-1".into(),
            idempotency_key: "create-1".into(),
        };
        let (run, event) =
            build_run_created(&lifecycle(), &input, "user-real", "member-real", "t1").unwrap();
        let journal = mission_run::MissionRunJournalRow {
            run,
            events: vec![event],
        };
        exact_create_replay(&journal, &input).unwrap();
        let changed = MissionRunCreateInput {
            mission_id: "mission-other".into(),
            ..input
        };
        assert!(exact_create_replay(&journal, &changed).is_err());
    }

    #[test]
    fn checkpoint_creation_and_restore_bind_hash_boundary_and_attempt() {
        let current = json!({"id":"run-1","workspaceId":"workspace-1","status":"running","revision":6,"currentAttemptNumber":1,"eventHead":{"lastSequence":5,"lastEventId":"event-5"}});
        let journal = mission_run::MissionRunJournalRow {
            run: current,
            events: vec![
                json!({"id":"event-1","type":"run-created","sequence":1}),
                json!({"id":"event-2","type":"worker-created","sequence":2,"payload":{"worker":{"id":"worker-1","planStepKey":"search"}}}),
                json!({"id":"event-3","type":"worker-started","sequence":3,"payload":{"workerId":"worker-1"}}),
                json!({"id":"event-4","type":"worker-completed","sequence":4,"payload":{"workerId":"worker-1","outputs":[]}}),
                json!({"id":"event-5","type":"side-effect-recorded","sequence":5,"payload":{"receipt":{"outcome":"committed","boundary":{"effectKey":"effect-1"}}}}),
            ],
        };
        let input = MissionCheckpointCreateInput {
            run_id: "run-1".into(),
            event_id: "event-6".into(),
            idempotency_key: "save-1".into(),
            expected_run_revision: 6,
            expected_last_sequence: 5,
            attempt_number: 1,
            durable_through_sequence: 5,
            resume_after_event_id: "event-5".into(),
        };
        let facts = derive_replay_facts(&journal.events, input.durable_through_sequence).unwrap();
        assert_eq!(facts.completed_plan_step_keys, ["search"]);
        assert_eq!(facts.completed_worker_ids, ["worker-1"]);
        assert_eq!(facts.committed_effect_keys, ["effect-1"]);
        assert_eq!(facts.state["activeWorkerIds"], json!([]));
        let state = facts.state.clone();
        let reference = "checkpoint:event-6";
        let hash = checkpoint_state_hash("run-1", "event-6", 1, reference, &state).unwrap();
        let (projected, event, reference) = build_checkpoint(
            &journal,
            &input,
            &hash,
            &facts,
            "user-real",
            "member-real",
            "t6",
        )
        .unwrap();
        assert_eq!(projected["eventHead"]["lastSequence"], 6);
        assert_eq!(event["payload"]["checkpoint"]["stateHash"], hash);
        assert_eq!(
            event["payload"]["checkpoint"]["replayBoundary"]["completedWorkerIds"],
            json!(["worker-1"])
        );
        let changed_facts = derive_replay_facts(&journal.events, 4).unwrap();
        let changed = MissionCheckpointCreateInput {
            run_id: "run-1".into(),
            event_id: "event-6".into(),
            idempotency_key: "save-1".into(),
            expected_run_revision: 6,
            expected_last_sequence: 5,
            attempt_number: 1,
            durable_through_sequence: 4,
            resume_after_event_id: "event-4".into(),
        };
        assert!(exact_checkpoint_replay(&event, &changed, &hash, &changed_facts).is_err());
        let checkpoint = mission_checkpoint::CheckpointStateRow {
            run_id: "run-1".into(),
            checkpoint_event_id: "event-6".into(),
            attempt_number: 1,
            state_reference: reference,
            state_hash: hash,
            created_at: "t6".into(),
            state,
        };
        verify_checkpoint_state(&checkpoint, &event).unwrap();
        let restore = MissionCheckpointRestoreInput {
            run_id: "run-1".into(),
            event_id: "event-7".into(),
            idempotency_key: "restore-1".into(),
            expected_run_revision: 7,
            expected_last_sequence: 6,
            new_attempt_number: 2,
        };
        let (restored, restore_event) = build_checkpoint_restore(
            &projected,
            &restore,
            &checkpoint,
            "user-real",
            "member-real",
            "t7",
        )
        .unwrap();
        assert_eq!(restored["currentAttemptNumber"], 2);
        assert_eq!(restore_event["payload"]["checkpointEventId"], "event-6");
    }

    #[test]
    fn checkpoint_state_tracks_first_class_wait_requests_and_resolutions() {
        let events = vec![
            json!({"sequence":1,"type":"approval-requested","payload":{"wait":{"waitKey":"approval-1"}}}),
            json!({"sequence":2,"type":"human-input-requested","payload":{"wait":{"waitKey":"input-1"}}}),
            json!({"sequence":3,"type":"approval-resolved","payload":{"resolution":{"waitKey":"approval-1"}}}),
        ];
        let facts = derive_replay_facts(&events, 3).unwrap();
        assert_eq!(facts.state["pendingWaitKeys"], json!(["input-1"]));
    }
}

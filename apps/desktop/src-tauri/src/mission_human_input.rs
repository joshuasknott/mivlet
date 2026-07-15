//! Provider-free durable human-input waits for authenticated mission runs.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::store::repos::{
    mission_checkpoint, mission_plan, mission_run, scope::DataScope, workspace_directory,
};

const MAX_PENDING_SCAN: i64 = 1_001;
const DEFAULT_PENDING_LIMIT: usize = 50;
const MAX_PENDING_LIMIT: usize = 100;
const MAX_TEXT_VALUE: usize = 4_000;
const MAX_ABSOLUTE_NUMBER: f64 = 1_000_000_000_000_000.0;

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanInputField {
    pub(crate) key: String,
    pub(crate) label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) help: Option<String>,
    pub(crate) kind: String,
    pub(crate) required: bool,
    pub(crate) sensitive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) choices: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanInputRequestInput {
    pub(crate) run_id: String,
    pub(crate) request_key: String,
    pub(crate) expected_run_revision: i64,
    pub(crate) expected_last_sequence: i64,
    pub(crate) prompt: String,
    pub(crate) fields: Vec<HumanInputField>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanInputPendingListInput {
    source_thread_id: String,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanInputValue {
    pub(crate) field_key: String,
    pub(crate) value: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanInputReceiveInput {
    pub(crate) run_id: String,
    pub(crate) wait_key: String,
    pub(crate) expected_run_revision: i64,
    pub(crate) expected_last_sequence: i64,
    pub(crate) values: Vec<HumanInputValue>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingHumanInput {
    pub(crate) run_id: String,
    pub(crate) mission_id: String,
    pub(crate) source_thread_id: String,
    pub(crate) wait_key: String,
    pub(crate) request_key: String,
    pub(crate) prompt: String,
    pub(crate) fields: Vec<HumanInputField>,
    pub(crate) requested_at: String,
    pub(crate) run_revision: i64,
    pub(crate) last_sequence: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingHumanInputEnvelope {
    requests: Vec<PendingHumanInput>,
    unavailable_count: usize,
    truncated: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HumanInputReceiveReceipt {
    pub(crate) run_id: String,
    pub(crate) wait_key: String,
    pub(crate) status: &'static str,
    pub(crate) received_at: String,
    pub(crate) run_revision: i64,
    pub(crate) last_sequence: i64,
}

struct Authorized {
    scope: DataScope,
    internal_user_id: String,
    member_id: String,
}

struct WaitFacts {
    pending: PendingHumanInput,
    request_event_id: String,
    request_suffix: String,
    attempt_number: i64,
}

fn authorized(tx: &rusqlite::Connection) -> crate::store::Result<Authorized> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let member_id = context.member_id.ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "An active Fable workspace membership is required for mission human input.".into(),
        )
    })?;
    Ok(Authorized {
        scope: DataScope::workspace(context.active_workspace.local_workspace_id)?,
        internal_user_id: context.internal_user_id,
        member_id,
    })
}

#[tauri::command]
pub fn mission_human_input_request(
    input: HumanInputRequestInput,
) -> Result<PendingHumanInput, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    request_with_store(store, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_human_input_pending_list(
    input: HumanInputPendingListInput,
) -> Result<PendingHumanInputEnvelope, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    pending_with_store(store, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_human_input_receive(
    input: HumanInputReceiveInput,
) -> Result<HumanInputReceiveReceipt, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    receive_with_store(store, input).map_err(|error| error.to_string())
}

fn request_with_store(
    store: &crate::store::Store,
    input: HumanInputRequestInput,
) -> crate::store::Result<PendingHumanInput> {
    validate_request(&input).map_err(crate::store::StoreError::Invalid)?;
    store.transaction(|tx| {
        let auth = authorized(tx)?;
        request_in_tx(
            tx,
            store,
            &auth.scope,
            &auth.internal_user_id,
            &auth.member_id,
            &input,
        )
    })
}

pub(crate) fn request_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    internal_user_id: &str,
    member_id: &str,
    input: &HumanInputRequestInput,
) -> crate::store::Result<PendingHumanInput> {
    validate_request(input).map_err(crate::store::StoreError::Invalid)?;
    let auth = Authorized {
        scope: scope.clone(),
        internal_user_id: internal_user_id.to_string(),
        member_id: member_id.to_string(),
    };
    let journal =
        mission_run::get(tx, store, scope, member_id, &input.run_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Mission run is unavailable in this workspace.".into(),
            )
        })?;
    let mission_id = mission_id(&journal.run)?;
    let lifecycle = mission_plan::get(tx, store, &auth.scope, &auth.member_id, mission_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission plan is unavailable.".into()))?;
    let base_event_id = event_id_at(&journal, input.expected_last_sequence)?;
    let schema_hash = schema_hash(&input.fields)?;
    let suffix = request_suffix(
        auth.scope.workspace_id(),
        &auth.member_id,
        &journal.run,
        input,
        &schema_hash,
        base_event_id,
    )?;
    let request_event_id = format!("mission-human-input-requested-{suffix}");
    if journal
        .events
        .iter()
        .any(|event| event.get("id").and_then(Value::as_str) == Some(request_event_id.as_str()))
    {
        let facts = validate_pending_wait(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &journal,
            Some(&lifecycle),
        )?;
        if facts.request_suffix != suffix
            || facts.pending.request_key != input.request_key.trim()
            || facts.pending.prompt != input.prompt.trim()
            || facts.pending.fields != input.fields
        {
            return Err(crate::store::StoreError::Invalid(
                "The human-input request key represents different facts.".into(),
            ));
        }
        return Ok(facts.pending);
    }
    validate_request_boundary(&journal.run, &lifecycle, input)?;
    let at = now();
    append_wait(
        tx,
        store,
        &auth,
        &journal,
        &lifecycle,
        input,
        &schema_hash,
        &suffix,
        base_event_id,
        &at,
    )
}

pub(crate) fn pending_for_run_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<PendingHumanInput> {
    validate_pending_wait(tx, store, scope, owner_member_id, journal, None)
        .map(|facts| facts.pending)
}

fn pending_with_store(
    store: &crate::store::Store,
    input: HumanInputPendingListInput,
) -> crate::store::Result<PendingHumanInputEnvelope> {
    bounded(&input.source_thread_id, "Source thread", 160)
        .map_err(crate::store::StoreError::Invalid)?;
    let limit = input.limit.unwrap_or(DEFAULT_PENDING_LIMIT);
    if !(1..=MAX_PENDING_LIMIT).contains(&limit) {
        return Err(crate::store::StoreError::Invalid(
            "Mission human-input list limit must be between 1 and 100.".into(),
        ));
    }
    store.with_conn(|tx| {
        let auth = authorized(tx)?;
        let ids = mission_run::list_waiting_human_input_ids(
            tx,
            &auth.scope,
            &auth.member_id,
            MAX_PENDING_SCAN,
        )?;
        let scan_truncated = ids.len() == MAX_PENDING_SCAN as usize;
        let mut requests = Vec::new();
        let mut unavailable_count = 0;
        let mut more_matching = false;
        for run_id in ids {
            let result = mission_run::get(tx, store, &auth.scope, &auth.member_id, &run_id)
                .and_then(|journal| {
                    let journal = journal.ok_or_else(|| {
                        crate::store::StoreError::Invalid("Mission run disappeared.".into())
                    })?;
                    validate_pending_wait(tx, store, &auth.scope, &auth.member_id, &journal, None)
                });
            match result {
                Ok(facts) if facts.pending.source_thread_id == input.source_thread_id => {
                    if requests.len() < limit {
                        requests.push(facts.pending);
                    } else {
                        more_matching = true;
                    }
                }
                Ok(_) => {}
                Err(_) => unavailable_count += 1,
            }
        }
        Ok(PendingHumanInputEnvelope {
            requests,
            unavailable_count,
            truncated: scan_truncated || more_matching,
        })
    })
}

pub(crate) fn receive_with_store(
    store: &crate::store::Store,
    input: HumanInputReceiveInput,
) -> crate::store::Result<HumanInputReceiveReceipt> {
    bounded(&input.run_id, "Mission run", 160)
        .and_then(|_| bounded(&input.wait_key, "Human-input wait", 200))
        .map_err(crate::store::StoreError::Invalid)?;
    store.transaction(|tx| {
        let auth = authorized(tx)?;
        let journal = mission_run::get(tx, store, &auth.scope, &auth.member_id, &input.run_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Mission run is unavailable in this workspace.".into(),
                )
            })?;
        if let Some(received) = journal.events.iter().find(|event| {
            event.get("type").and_then(Value::as_str) == Some("human-input-received")
                && event
                    .pointer("/payload/resolution/waitKey")
                    .and_then(Value::as_str)
                    == Some(input.wait_key.as_str())
        }) {
            let receipt = exact_receive_replay(
                tx,
                store,
                &auth.scope,
                &auth.member_id,
                &journal,
                received,
                &input,
                &auth.internal_user_id,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            crate::mission_structured_intake::validate_terminal_replay_in_tx(
                tx,
                store,
                &auth.scope,
                &auth.internal_user_id,
                &auth.member_id,
                &journal,
                received,
            )?;
            return Ok(receipt);
        }
        let facts = validate_pending_wait(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &journal,
            None,
        )?;
        if facts.pending.wait_key != input.wait_key {
            return Err(crate::store::StoreError::Invalid(
                "The mission human-input wait changed.".into(),
            ));
        }
        if facts.pending.run_revision != input.expected_run_revision
            || facts.pending.last_sequence != input.expected_last_sequence
        {
            return Err(crate::store::StoreError::Invalid(
                "The mission run changed before human input was received.".into(),
            ));
        }
        let values = validate_values(&facts.pending.fields, &input.values)
            .map_err(crate::store::StoreError::Invalid)?;
        let at = now();
        let sequence = input.expected_last_sequence + 1;
        let event_id = format!("mission-human-input-received-{}", facts.request_suffix);
        let key = format!("human-input-received:v1:{}", facts.request_suffix);
        let workspace_id = journal
            .run
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
            })?;
        let event = json!({
            "workspaceId":workspace_id,"visibility":"member-private","ownerMemberId":auth.member_id,
            "authority":"local","schemaVersion":1,"revision":1,
            "createdByInternalUserId":auth.internal_user_id,"createdAt":at,"updatedAt":at,
            "id":event_id,"runId":input.run_id,"type":"human-input-received","sequence":sequence,
            "previousEventId":facts.request_event_id,"attemptNumber":facts.attempt_number,
            "occurredAt":at,
            "actor":{"kind":"internal-user","internalUserId":auth.internal_user_id,"memberId":auth.member_id},
            "idempotencyKey":key,
            "payload":{"resolution":{"waitKey":input.wait_key,"receivedAt":at,
                "suppliedByInternalUserId":auth.internal_user_id,"values":values}}
        });
        let mut projected = object(journal.run.clone())?;
        projected.insert("status".into(), json!("running"));
        projected.insert("revision".into(), json!(input.expected_run_revision + 1));
        projected.insert("updatedAt".into(), json!(at));
        projected.insert(
            "eventHead".into(),
            json!({"lastSequence":sequence,"lastEventId":event_id}),
        );
        let received_journal = mission_run::append(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &input.run_id,
            input.expected_run_revision,
            input.expected_last_sequence,
            &event_id,
            "human-input-received",
            &key,
            &event,
            &Value::Object(projected),
            &at,
        )?;
        let lifecycle = mission_plan::get(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &facts.pending.mission_id,
        )?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission plan is unavailable.".into()))?;
        mission_plan::resume_waiting(
            tx,
            store,
            &auth.scope,
            &auth.member_id,
            &lifecycle,
            &at,
        )?;
        crate::mission_structured_intake::settle_if_structured_in_tx(
            tx,
            store,
            &auth.scope,
            &auth.internal_user_id,
            &auth.member_id,
            &received_journal,
            &lifecycle,
            &event_id,
            &at,
        )?;
        Ok(HumanInputReceiveReceipt {
            run_id: input.run_id,
            wait_key: input.wait_key,
            status: "received",
            received_at: at,
            run_revision: input.expected_run_revision + 1,
            last_sequence: sequence,
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn append_wait(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    input: &HumanInputRequestInput,
    schema_hash: &str,
    suffix: &str,
    base_event_id: &str,
    at: &str,
) -> crate::store::Result<PendingHumanInput> {
    let plan_revision_id = journal
        .run
        .get("planRevisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run plan revision is invalid.".into())
        })?;
    let mission_id = mission_id(&journal.run)?.to_string();
    let source_thread_id = journal
        .run
        .get("sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run source thread is invalid.".into())
        })?
        .to_string();
    let workspace_id = journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    let wait_key = format!("human-input-wait:v1:{suffix}");
    let checkpoint_event_id = format!("mission-human-input-checkpoint-{suffix}");
    let request_event_id = format!("mission-human-input-requested-{suffix}");
    let checkpoint_reference = format!("checkpoint:{checkpoint_event_id}");
    let attempt_number = journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let checkpoint_state = json!({
        "activeWorkerIds":[],"activePlanStepKeys":[],"pendingWaitKeys":[wait_key],
        "humanInputWait":{
            "planRevisionId":plan_revision_id,"requestKey":input.request_key.trim(),
            "schemaHash":schema_hash,"waitKey":wait_key,"prompt":input.prompt.trim(),
            "fields":input.fields,
            "runHead":{"revision":input.expected_run_revision,"lastSequence":input.expected_last_sequence,
                "lastEventId":base_event_id}
        }
    });
    let state_hash = sha256_json(&checkpoint_state)?;
    let checkpoint_sequence = input.expected_last_sequence + 1;
    let checkpoint = json!({
        "kind":"wait-boundary","attemptNumber":attempt_number,"createdAt":at,
        "replayBoundary":{"durableThroughSequence":input.expected_last_sequence,
            "resumeAfterEventId":base_event_id,"completedPlanStepKeys":[],
            "completedWorkerIds":[],"committedEffectKeys":[]},
        "stateStorage":"portable-redacted","stateReference":checkpoint_reference,
        "stateHash":state_hash,"executionNodeId":"local-desktop","pendingWaitKey":wait_key
    });
    let checkpoint_key = format!("human-input-checkpoint:v1:{suffix}");
    let checkpoint_event = json!({
        "workspaceId":workspace_id,"visibility":"member-private","ownerMemberId":auth.member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":auth.internal_user_id,
        "createdAt":at,"updatedAt":at,"id":checkpoint_event_id,"runId":input.run_id,
        "type":"checkpoint-created","sequence":checkpoint_sequence,"previousEventId":base_event_id,
        "attemptNumber":attempt_number,"occurredAt":at,"actor":{"kind":"system"},
        "idempotencyKey":checkpoint_key,"payload":{"checkpoint":checkpoint}
    });
    let mut checkpoint_projection = object(journal.run.clone())?;
    checkpoint_projection.insert("revision".into(), json!(input.expected_run_revision + 1));
    checkpoint_projection.insert("updatedAt".into(), json!(at));
    checkpoint_projection.insert(
        "eventHead".into(),
        json!({"lastSequence":checkpoint_sequence,"lastEventId":checkpoint_event_id}),
    );
    mission_run::append(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        &input.run_id,
        input.expected_run_revision,
        input.expected_last_sequence,
        &checkpoint_event_id,
        "checkpoint-created",
        &checkpoint_key,
        &checkpoint_event,
        &Value::Object(checkpoint_projection),
        at,
    )?;
    mission_checkpoint::put(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        &input.run_id,
        &checkpoint_event_id,
        attempt_number,
        &checkpoint_reference,
        &state_hash,
        &checkpoint_state,
        at,
    )?;
    let request_sequence = checkpoint_sequence + 1;
    let wait = json!({"waitKey":wait_key,"status":"pending","prompt":input.prompt.trim(),
        "fields":input.fields,"requestedAt":at});
    let request_key = format!("human-input-request:v1:{suffix}");
    let request_event = json!({
        "workspaceId":workspace_id,"visibility":"member-private","ownerMemberId":auth.member_id,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":auth.internal_user_id,
        "createdAt":at,"updatedAt":at,"id":request_event_id,"runId":input.run_id,
        "type":"human-input-requested","sequence":request_sequence,
        "previousEventId":checkpoint_event_id,"attemptNumber":attempt_number,"occurredAt":at,
        "actor":{"kind":"system"},"idempotencyKey":request_key,"payload":{"wait":wait}
    });
    let mut request_projection = object(journal.run.clone())?;
    request_projection.insert("status".into(), json!("waiting-human-input"));
    request_projection.insert("revision".into(), json!(input.expected_run_revision + 2));
    request_projection.insert("updatedAt".into(), json!(at));
    request_projection.insert(
        "eventHead".into(),
        json!({"lastSequence":request_sequence,"lastEventId":request_event_id}),
    );
    mission_run::append(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        &input.run_id,
        input.expected_run_revision + 1,
        checkpoint_sequence,
        &request_event_id,
        "human-input-requested",
        &request_key,
        &request_event,
        &Value::Object(request_projection),
        at,
    )?;
    mission_plan::mark_waiting(tx, store, &auth.scope, &auth.member_id, lifecycle, at)?;
    Ok(PendingHumanInput {
        run_id: input.run_id.clone(),
        mission_id,
        source_thread_id,
        wait_key,
        request_key: input.request_key.trim().to_string(),
        prompt: input.prompt.trim().to_string(),
        fields: input.fields.clone(),
        requested_at: at.to_string(),
        run_revision: input.expected_run_revision + 2,
        last_sequence: request_sequence,
    })
}

fn validate_pending_wait(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    known_lifecycle: Option<&mission_plan::MissionPlanLifecycleRow>,
) -> crate::store::Result<WaitFacts> {
    if journal.run.get("status").and_then(Value::as_str) != Some("waiting-human-input") {
        return Err(crate::store::StoreError::Invalid(
            "Mission run is not waiting for human input.".into(),
        ));
    }
    let revision = positive_i64(&journal.run, "revision", "Mission run revision")?;
    let last_sequence = journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .filter(|value| *value > 2)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let request_event_id = journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let request_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(request_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input request event is unavailable.".into())
        })?;
    let checkpoint_event_id = request_event
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input checkpoint link is invalid.".into())
        })?;
    let checkpoint_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(checkpoint_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input checkpoint is unavailable.".into())
        })?;
    let wait = request_event.pointer("/payload/wait").ok_or_else(|| {
        crate::store::StoreError::Invalid("Human-input request payload is invalid.".into())
    })?;
    let fields: Vec<HumanInputField> =
        serde_json::from_value(wait.get("fields").cloned().ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input schema is missing.".into())
        })?)
        .map_err(|_| crate::store::StoreError::Invalid("Human-input schema is invalid.".into()))?;
    validate_fields(&fields).map_err(crate::store::StoreError::Invalid)?;
    let prompt = wait.get("prompt").and_then(Value::as_str).ok_or_else(|| {
        crate::store::StoreError::Invalid("Human-input prompt is invalid.".into())
    })?;
    bounded(prompt, "Human-input prompt", 2_000).map_err(crate::store::StoreError::Invalid)?;
    let wait_key = wait.get("waitKey").and_then(Value::as_str).ok_or_else(|| {
        crate::store::StoreError::Invalid("Human-input wait key is invalid.".into())
    })?;
    let requested_at = wait
        .get("requestedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input request time is invalid.".into())
        })?;
    let attempt_number = request_event
        .get("attemptNumber")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input attempt is invalid.".into())
        })?;
    if request_event.get("type").and_then(Value::as_str) != Some("human-input-requested")
        || request_event.get("runId") != journal.run.get("id")
        || request_event.get("sequence").and_then(Value::as_i64) != Some(last_sequence)
        || request_event
            .pointer("/payload/wait/status")
            .and_then(Value::as_str)
            != Some("pending")
        || checkpoint_event.get("type").and_then(Value::as_str) != Some("checkpoint-created")
        || checkpoint_event.get("runId") != journal.run.get("id")
        || checkpoint_event.get("sequence").and_then(Value::as_i64) != Some(last_sequence - 1)
        || checkpoint_event
            .pointer("/payload/checkpoint/kind")
            .and_then(Value::as_str)
            != Some("wait-boundary")
        || checkpoint_event
            .pointer("/payload/checkpoint/pendingWaitKey")
            .and_then(Value::as_str)
            != Some(wait_key)
        || checkpoint_event
            .get("attemptNumber")
            .and_then(Value::as_i64)
            != Some(attempt_number)
    {
        return Err(crate::store::StoreError::Invalid(
            "Human-input wait evidence is invalid.".into(),
        ));
    }
    let checkpoint =
        mission_checkpoint::get_by_event(tx, store, scope, owner_member_id, checkpoint_event_id)?
            .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input checkpoint state is unavailable.".into())
        })?;
    if checkpoint.run_id != journal.run.get("id").and_then(Value::as_str).unwrap_or("")
        || checkpoint.attempt_number != attempt_number
        || checkpoint.state_hash != sha256_json(&checkpoint.state)?
        || checkpoint_event
            .pointer("/payload/checkpoint/stateReference")
            .and_then(Value::as_str)
            != Some(checkpoint.state_reference.as_str())
        || checkpoint_event
            .pointer("/payload/checkpoint/stateHash")
            .and_then(Value::as_str)
            != Some(checkpoint.state_hash.as_str())
    {
        return Err(crate::store::StoreError::Invalid(
            "Human-input checkpoint state is invalid.".into(),
        ));
    }
    let state = checkpoint.state.get("humanInputWait").ok_or_else(|| {
        crate::store::StoreError::Invalid("Human-input checkpoint facts are missing.".into())
    })?;
    let plan_revision_id = journal
        .run
        .get("planRevisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run plan revision is invalid.".into())
        })?;
    let request_key = state
        .get("requestKey")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input request key is invalid.".into())
        })?;
    let schema_hash = schema_hash(&fields)?;
    let base_revision = state
        .pointer("/runHead/revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input checkpoint head is invalid.".into())
        })?;
    let base_sequence = state
        .pointer("/runHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input checkpoint head is invalid.".into())
        })?;
    let base_event_id = state
        .pointer("/runHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input checkpoint head is invalid.".into())
        })?;
    let request_input = HumanInputRequestInput {
        run_id: journal
            .run
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        request_key: request_key.into(),
        expected_run_revision: base_revision,
        expected_last_sequence: base_sequence,
        prompt: prompt.into(),
        fields: fields.clone(),
    };
    let request_suffix = request_suffix(
        scope.workspace_id(),
        owner_member_id,
        &journal.run,
        &request_input,
        &schema_hash,
        base_event_id,
    )?;
    if state.get("planRevisionId").and_then(Value::as_str) != Some(plan_revision_id)
        || state.get("schemaHash").and_then(Value::as_str) != Some(schema_hash.as_str())
        || state.get("waitKey").and_then(Value::as_str) != Some(wait_key)
        || state.get("prompt").and_then(Value::as_str) != Some(prompt)
        || state.get("fields") != wait.get("fields")
        || checkpoint
            .state
            .get("pendingWaitKeys")
            .and_then(Value::as_array)
            .is_none_or(|keys| keys.as_slice() != [json!(wait_key)])
        || checkpoint_event
            .get("previousEventId")
            .and_then(Value::as_str)
            != Some(base_event_id)
        || checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/durableThroughSequence")
            .and_then(Value::as_i64)
            != Some(base_sequence)
        || checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/resumeAfterEventId")
            .and_then(Value::as_str)
            != Some(base_event_id)
        || checkpoint_event_id != format!("mission-human-input-checkpoint-{request_suffix}")
        || request_event_id != format!("mission-human-input-requested-{request_suffix}")
        || wait_key != format!("human-input-wait:v1:{request_suffix}")
    {
        return Err(crate::store::StoreError::Invalid(
            "Human-input wait facts do not match their durable checkpoint.".into(),
        ));
    }
    let mission_id = mission_id(&journal.run)?;
    let owned_lifecycle;
    let lifecycle = if let Some(lifecycle) = known_lifecycle {
        lifecycle
    } else {
        owned_lifecycle = mission_plan::get(tx, store, scope, owner_member_id, mission_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission plan is unavailable.".into())
            })?;
        &owned_lifecycle
    };
    if lifecycle.mission.get("status").and_then(Value::as_str) != Some("waiting")
        || lifecycle.current_revision.get("id").and_then(Value::as_str) != Some(plan_revision_id)
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission lifecycle does not match its human-input wait.".into(),
        ));
    }
    let source_thread_id = journal
        .run
        .get("sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run source thread is invalid.".into())
        })?;
    Ok(WaitFacts {
        pending: PendingHumanInput {
            run_id: request_input.run_id,
            mission_id: mission_id.into(),
            source_thread_id: source_thread_id.into(),
            wait_key: wait_key.into(),
            request_key: request_key.into(),
            prompt: prompt.into(),
            fields,
            requested_at: requested_at.into(),
            run_revision: revision,
            last_sequence,
        },
        request_event_id: request_event_id.into(),
        request_suffix,
        attempt_number,
    })
}

fn validate_request(input: &HumanInputRequestInput) -> Result<(), String> {
    bounded(&input.run_id, "Mission run", 160)?;
    bounded(&input.request_key, "Human-input request key", 200)?;
    bounded(&input.prompt, "Human-input prompt", 2_000)?;
    if input.expected_run_revision < 1 || input.expected_last_sequence < 1 {
        return Err("Mission human-input run fence is invalid.".into());
    }
    validate_fields(&input.fields)
}

fn validate_fields(fields: &[HumanInputField]) -> Result<(), String> {
    if !(1..=8).contains(&fields.len()) {
        return Err("Human input requires between 1 and 8 fields.".into());
    }
    let mut keys = BTreeSet::new();
    for field in fields {
        bounded(&field.key, "Human-input field key", 80)?;
        if !field.key.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        }) {
            return Err("Human-input field keys may contain letters, numbers, dots, underscores, and dashes.".into());
        }
        if !keys.insert(field.key.as_str()) {
            return Err("Human-input field keys must be unique.".into());
        }
        bounded(&field.label, "Human-input field label", 200)?;
        if let Some(help) = field.help.as_deref() {
            bounded(help, "Human-input field help", 500)?;
        }
        if field.sensitive {
            return Err("Sensitive human input is unavailable until a secure value boundary can prevent journal projection leakage.".into());
        }
        if !matches!(
            field.kind.as_str(),
            "text" | "number" | "boolean" | "choice" | "date-time"
        ) {
            return Err(if field.kind == "artifact" {
                "Artifact human-input fields are not supported by this native wait boundary.".into()
            } else {
                "Human-input field kind is invalid.".into()
            });
        }
        match (field.kind.as_str(), field.choices.as_ref()) {
            ("choice", Some(choices)) if (2..=20).contains(&choices.len()) => {
                let mut unique = BTreeSet::new();
                for choice in choices {
                    bounded(choice, "Human-input choice", 200)?;
                    if !unique.insert(choice.as_str()) {
                        return Err("Human-input choices must be unique.".into());
                    }
                }
            }
            ("choice", _) => return Err("Choice fields require between 2 and 20 choices.".into()),
            (_, None) => {}
            (_, Some(_)) => return Err("Only choice fields may declare choices.".into()),
        }
    }
    Ok(())
}

fn validate_request_boundary(
    run: &Value,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    input: &HumanInputRequestInput,
) -> crate::store::Result<()> {
    if run.get("status").and_then(Value::as_str) != Some("running")
        || run.get("revision").and_then(Value::as_i64) != Some(input.expected_run_revision)
        || run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
    {
        return Err(crate::store::StoreError::Invalid(
            "The running mission changed before human input could be requested.".into(),
        ));
    }
    if lifecycle.mission.get("status").and_then(Value::as_str) != Some("running")
        || lifecycle.current_revision.get("id") != run.get("planRevisionId")
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission lifecycle does not match the running plan revision.".into(),
        ));
    }
    Ok(())
}

fn validate_values(
    fields: &[HumanInputField],
    inputs: &[HumanInputValue],
) -> Result<Vec<HumanInputValue>, String> {
    if inputs.len() > fields.len() {
        return Err("Human-input response contains too many values.".into());
    }
    let mut supplied = BTreeMap::new();
    for input in inputs {
        bounded(&input.field_key, "Human-input response field", 80)?;
        if supplied
            .insert(input.field_key.as_str(), &input.value)
            .is_some()
        {
            return Err("Human-input response fields must be unique.".into());
        }
    }
    let mut normalized = Vec::new();
    for field in fields {
        let value = supplied.remove(field.key.as_str());
        let Some(value) = value else {
            if field.required {
                return Err(format!(
                    "Required human-input field '{}' is missing.",
                    field.key
                ));
            }
            continue;
        };
        validate_value(field, value)?;
        normalized.push(HumanInputValue {
            field_key: field.key.clone(),
            value: value.clone(),
        });
    }
    if !supplied.is_empty() {
        return Err("Human-input response contains an unknown field.".into());
    }
    Ok(normalized)
}

fn validate_value(field: &HumanInputField, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return if field.required {
            Err(format!(
                "Required human-input field '{}' cannot be null.",
                field.key
            ))
        } else {
            Ok(())
        };
    }
    let valid = match field.kind.as_str() {
        "text" => value.as_str().is_some_and(|text| {
            text.len() <= MAX_TEXT_VALUE && (!field.required || !text.trim().is_empty())
        }),
        "number" => value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number.abs() <= MAX_ABSOLUTE_NUMBER),
        "boolean" => value.is_boolean(),
        "choice" => value.as_str().is_some_and(|choice| {
            field
                .choices
                .as_ref()
                .is_some_and(|choices| choices.iter().any(|item| item == choice))
        }),
        "date-time" => value.as_str().is_some_and(valid_date_time),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Human-input value for '{}' does not match its field schema.",
            field.key
        ))
    }
}

fn valid_date_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    let shape = bytes.len() == 20
        || ((22..=24).contains(&bytes.len())
            && bytes.get(19) == Some(&b'.')
            && bytes.last() == Some(&b'Z'));
    shape
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.last() == Some(&b'Z')
        && DateTime::parse_from_rfc3339(value).is_ok()
}

fn exact_receive_replay(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    input: &HumanInputReceiveInput,
    internal_user_id: &str,
) -> Result<HumanInputReceiveReceipt, String> {
    let suffix = input
        .wait_key
        .strip_prefix("human-input-wait:v1:")
        .ok_or_else(|| "Replayed human-input wait is invalid.".to_string())?;
    let request_event_id = event
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Replayed human-input request link is invalid.".to_string())?;
    let request_event = journal
        .events
        .iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(request_event_id))
        .ok_or_else(|| "Replayed human-input request is unavailable.".to_string())?;
    let checkpoint_event_id = request_event
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Replayed human-input checkpoint link is invalid.".to_string())?;
    let checkpoint_event = journal
        .events
        .iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(checkpoint_event_id))
        .ok_or_else(|| "Replayed human-input checkpoint is unavailable.".to_string())?;
    let checkpoint =
        mission_checkpoint::get_by_event(tx, store, scope, owner_member_id, checkpoint_event_id)
            .map_err(|_| "Replayed human-input checkpoint is unavailable.".to_string())?
            .ok_or_else(|| "Replayed human-input checkpoint is unavailable.".to_string())?;
    let base_revision = checkpoint
        .state
        .pointer("/humanInputWait/runHead/revision")
        .and_then(Value::as_i64);
    let stored_hash = sha256_json(&checkpoint.state).map_err(|error| error.to_string())?;
    if request_event.get("type").and_then(Value::as_str) != Some("human-input-requested")
        || request_event.get("runId") != event.get("runId")
        || request_event.get("sequence").and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
        || request_event
            .pointer("/payload/wait/waitKey")
            .and_then(Value::as_str)
            != Some(input.wait_key.as_str())
        || checkpoint_event.get("type").and_then(Value::as_str) != Some("checkpoint-created")
        || checkpoint_event.get("runId") != event.get("runId")
        || checkpoint_event.get("sequence").and_then(Value::as_i64)
            != Some(input.expected_last_sequence - 1)
        || checkpoint_event
            .pointer("/payload/checkpoint/pendingWaitKey")
            .and_then(Value::as_str)
            != Some(input.wait_key.as_str())
        || checkpoint_event
            .pointer("/payload/checkpoint/stateHash")
            .and_then(Value::as_str)
            != Some(stored_hash.as_str())
        || checkpoint.state_hash != stored_hash
        || checkpoint
            .state
            .pointer("/humanInputWait/waitKey")
            .and_then(Value::as_str)
            != Some(input.wait_key.as_str())
        || base_revision.map(|revision| revision + 2) != Some(input.expected_run_revision)
        || request_event_id != format!("mission-human-input-requested-{suffix}")
        || checkpoint_event_id != format!("mission-human-input-checkpoint-{suffix}")
        || event.get("id").and_then(Value::as_str)
            != Some(format!("mission-human-input-received-{suffix}").as_str())
    {
        return Err("The human-input response replay is not bound to its exact checkpoint.".into());
    }
    let stored: Vec<HumanInputValue> = serde_json::from_value(
        event
            .pointer("/payload/resolution/values")
            .cloned()
            .ok_or_else(|| "Replayed human-input response is invalid.".to_string())?,
    )
    .map_err(|_| "Replayed human-input response is invalid.".to_string())?;
    let supplied_by = event
        .pointer("/payload/resolution/suppliedByInternalUserId")
        .and_then(Value::as_str);
    if event.get("runId").and_then(Value::as_str) != Some(input.run_id.as_str())
        || event
            .pointer("/payload/resolution/waitKey")
            .and_then(Value::as_str)
            != Some(input.wait_key.as_str())
        || supplied_by != Some(internal_user_id)
        || !equivalent_values(&stored, &input.values)
        || event.get("sequence").and_then(Value::as_i64) != Some(input.expected_last_sequence + 1)
    {
        return Err("The human-input response replay represents different facts.".into());
    }
    let received_at = event
        .pointer("/payload/resolution/receivedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "Replayed human-input response is invalid.".to_string())?;
    Ok(HumanInputReceiveReceipt {
        run_id: input.run_id.clone(),
        wait_key: input.wait_key.clone(),
        status: "received",
        received_at: received_at.into(),
        run_revision: input.expected_run_revision + 1,
        last_sequence: input.expected_last_sequence + 1,
    })
}

fn equivalent_values(left: &[HumanInputValue], right: &[HumanInputValue]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let collect = |values: &[HumanInputValue]| {
        let mut by_key = BTreeMap::new();
        for value in values {
            if by_key
                .insert(value.field_key.clone(), value.value.clone())
                .is_some()
            {
                return None;
            }
        }
        Some(by_key)
    };
    collect(left) == collect(right)
}

fn request_suffix(
    workspace_id: &str,
    owner_member_id: &str,
    run: &Value,
    input: &HumanInputRequestInput,
    schema_hash: &str,
    base_event_id: &str,
) -> crate::store::Result<String> {
    let run_id = run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run id is invalid.".into()))?;
    let plan_revision_id = run
        .get("planRevisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run plan revision is invalid.".into())
        })?;
    if run_id != input.run_id {
        return Err(crate::store::StoreError::Invalid(
            "Mission run id is inconsistent.".into(),
        ));
    }
    let material = format!(
        "fable.mission-human-input.v1\0{workspace_id}\0{owner_member_id}\0{run_id}\0{plan_revision_id}\0{}\0{}\0{}\0{}\0{schema_hash}",
        input.expected_run_revision,
        input.expected_last_sequence,
        base_event_id,
        input.request_key.trim(),
    );
    Ok(format!("{:x}", Sha256::digest(material.as_bytes())))
}

fn schema_hash(fields: &[HumanInputField]) -> crate::store::Result<String> {
    let bytes = serde_json::to_vec(fields).map_err(|_| {
        crate::store::StoreError::Invalid("Human-input schema could not be encoded.".into())
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn sha256_json(value: &Value) -> crate::store::Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        crate::store::StoreError::Invalid("Human-input checkpoint could not be encoded.".into())
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn event_id_at(
    journal: &mission_run::MissionRunJournalRow,
    sequence: i64,
) -> crate::store::Result<&str> {
    journal
        .events
        .iter()
        .find(|event| event.get("sequence").and_then(Value::as_i64) == Some(sequence))
        .and_then(|event| event.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Mission human-input request head is unavailable.".into(),
            )
        })
}

fn mission_id(run: &Value) -> crate::store::Result<&str> {
    run.get("missionId")
        .or_else(|| run.pointer("/initiator/missionId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run has no selected mission.".into())
        })
}

fn positive_i64(value: &Value, key: &str, label: &str) -> crate::store::Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|number| *number > 0)
        .ok_or_else(|| crate::store::StoreError::Invalid(format!("{label} is invalid.")))
}

fn bounded(value: &str, label: &str, max: usize) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > max || trimmed.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn object(value: Value) -> crate::store::Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run record is invalid.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::{mission_plan, mission_run, seal_json, workspace_directory};
    use crate::store::vault::{MasterKey, Vault};
    use crate::store::Store;

    struct Fixture {
        directory: tempfile::TempDir,
        key: MasterKey,
        workspace_id: String,
        member_id: String,
    }

    fn field(key: &str, kind: &str, required: bool, choices: Option<Vec<&str>>) -> HumanInputField {
        HumanInputField {
            key: key.into(),
            label: key.replace('-', " "),
            help: None,
            kind: kind.into(),
            required,
            sensitive: false,
            choices: choices.map(|items| items.into_iter().map(str::to_string).collect()),
        }
    }

    fn fields() -> Vec<HumanInputField> {
        vec![
            field("title", "text", true, None),
            field("note", "text", false, None),
            field("count", "number", true, None),
            field("confirmed", "boolean", true, None),
            field("format", "choice", true, Some(vec!["brief", "report"])),
            field("due-at", "date-time", true, None),
        ]
    }

    fn request() -> HumanInputRequestInput {
        HumanInputRequestInput {
            run_id: "run-1".into(),
            request_key: "collect-brief-v1".into(),
            expected_run_revision: 2,
            expected_last_sequence: 1,
            prompt: "Provide the bounded details needed to continue.".into(),
            fields: fields(),
        }
    }

    fn values() -> Vec<HumanInputValue> {
        vec![
            HumanInputValue {
                field_key: "title".into(),
                value: json!("Quarterly research brief"),
            },
            HumanInputValue {
                field_key: "count".into(),
                value: json!(3),
            },
            HumanInputValue {
                field_key: "confirmed".into(),
                value: json!(true),
            },
            HumanInputValue {
                field_key: "format".into(),
                value: json!("brief"),
            },
            HumanInputValue {
                field_key: "due-at".into(),
                value: json!("2026-07-31T16:30:00Z"),
            },
        ]
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
            updated_at: "2026-07-15T09:00:00Z".into(),
        };
        let other_summary = workspace_directory::WorkspaceDirectoryUpsert {
            internal_user_id: "user-other".into(),
            member_id: "member-other".into(),
            ..summary.clone()
        };
        let local = store
            .transaction(|tx| {
                let local = workspace_directory::upsert_authoritative_summary(tx, &summary)?;
                workspace_directory::upsert_authoritative_summary(tx, &other_summary)?;
                workspace_directory::set_current_internal_user(tx, "user-1", "t0")?;
                workspace_directory::select_active_workspace_for_current_user(
                    tx,
                    "workspace-hosted-1",
                    "t0",
                )?;
                Ok(local.local_workspace_id)
            })
            .unwrap();
        let scope = DataScope::workspace(local.clone()).unwrap();
        store
            .transaction(|tx| {
                let mission = json!({
                    "id":"mission-1","workspaceId":local,"visibility":"member-private",
                    "ownerMemberId":"member-1","authority":"local","schemaVersion":1,"revision":1,
                    "createdByInternalUserId":"user-1","createdAt":"t0","updatedAt":"t0",
                    "status":"ready","executionDepth":"delegated","currentPlanId":"plan-1",
                    "currentPlanRevisionId":"revision-1",
                    "scope":{"workspaceId":local,"sourceThreadId":"thread-1","departmentIds":[],"context":[]},
                    "budget":{"maxAttempts":2}
                });
                let plan = json!({"id":"plan-1","missionId":"mission-1","status":"current",
                    "currentRevisionId":"revision-1","currentRevisionNumber":1,"revision":1});
                let revision = json!({"id":"revision-1","planId":"plan-1","missionId":"mission-1",
                    "planRevisionNumber":1,"summary":"Collect the missing brief facts."});
                let lifecycle = mission_plan::create(
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
                    "t0",
                )?;
                mission_plan::mark_running(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    &lifecycle,
                    "t1",
                )?;
                let run = json!({
                    "id":"run-1","workspaceId":local,"visibility":"member-private",
                    "ownerMemberId":"member-1","authority":"local","schemaVersion":1,"revision":2,
                    "createdByInternalUserId":"user-1","createdAt":"t1","updatedAt":"t1",
                    "status":"running","kind":"mission","executionDepth":"delegated",
                    "initiator":{"kind":"mission","missionId":"mission-1"},"parentage":{"kind":"root"},
                    "sourceThreadId":"thread-1","departmentIds":[],"planRevisionId":"revision-1",
                    "currentAttemptNumber":1,"budget":{"maxAttempts":2},
                    "eventHead":{"lastSequence":1,"lastEventId":"event-created"}
                });
                let event = json!({
                    "workspaceId":local,"visibility":"member-private","ownerMemberId":"member-1",
                    "authority":"local","schemaVersion":1,"revision":1,
                    "createdByInternalUserId":"user-1","createdAt":"t1","updatedAt":"t1",
                    "id":"event-created","runId":"run-1","type":"run-created","sequence":1,
                    "occurredAt":"t1","actor":{"kind":"internal-user","internalUserId":"user-1","memberId":"member-1"},
                    "idempotencyKey":"create:run-1","payload":{"run":{"id":"run-1"}}
                });
                mission_run::create(
                    tx,
                    &store,
                    &scope,
                    "member-1",
                    "user-1",
                    "run-1",
                    "event-created",
                    "create:run-1",
                    &run,
                    &event,
                    "t1",
                )?;
                Ok(())
            })
            .unwrap();
        Fixture {
            directory,
            key,
            workspace_id: local,
            member_id: "member-1".into(),
        }
    }

    fn reopen(fixture: &Fixture) -> Store {
        Store::open(
            &fixture.directory.path().join("fable.db"),
            Vault::new(&fixture.key).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn durable_wait_reopens_projects_exactly_and_receives_once() {
        let fixture = seed();
        let store = reopen(&fixture);
        let pending = request_with_store(&store, request()).unwrap();
        assert_eq!(pending.run_revision, 4);
        assert_eq!(pending.last_sequence, 3);
        assert_eq!(request_with_store(&store, request()).unwrap(), pending);
        let journal = store
            .with_conn(|tx| {
                mission_run::get(
                    tx,
                    &store,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    &fixture.member_id,
                    "run-1",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(journal.run["status"], "waiting-human-input");
        assert_eq!(journal.events[1]["type"], "checkpoint-created");
        assert_eq!(journal.events[2]["type"], "human-input-requested");
        assert_eq!(
            journal.events[2]["previousEventId"],
            journal.events[1]["id"]
        );
        let event_count = journal.events.len();
        drop(store);

        let reopened = reopen(&fixture);
        let listed = pending_with_store(
            &reopened,
            HumanInputPendingListInput {
                source_thread_id: "thread-1".into(),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(listed.requests, vec![pending.clone()]);
        assert_eq!(listed.unavailable_count, 0);
        assert!(!listed.truncated);
        let unchanged = reopened
            .with_conn(|tx| {
                mission_run::get(
                    tx,
                    &reopened,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    &fixture.member_id,
                    "run-1",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.events.len(), event_count);

        let response = HumanInputReceiveInput {
            run_id: "run-1".into(),
            wait_key: pending.wait_key.clone(),
            expected_run_revision: pending.run_revision,
            expected_last_sequence: pending.last_sequence,
            values: values(),
        };
        let receipt = receive_with_store(&reopened, response).unwrap();
        assert_eq!(receipt.run_revision, 5);
        assert_eq!(receipt.last_sequence, 4);
        let replay = receive_with_store(
            &reopened,
            HumanInputReceiveInput {
                run_id: "run-1".into(),
                wait_key: pending.wait_key.clone(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                values: values(),
            },
        )
        .unwrap();
        assert_eq!(replay, receipt);
        let wrong_revision = receive_with_store(
            &reopened,
            HumanInputReceiveInput {
                run_id: "run-1".into(),
                wait_key: pending.wait_key.clone(),
                expected_run_revision: pending.run_revision + 1,
                expected_last_sequence: pending.last_sequence,
                values: values(),
            },
        )
        .unwrap_err();
        assert!(wrong_revision.to_string().contains("exact checkpoint"));
        let after = reopened
            .with_conn(|tx| {
                mission_run::get(
                    tx,
                    &reopened,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    &fixture.member_id,
                    "run-1",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(after.events.len(), event_count + 1);
        assert_eq!(after.run["status"], "running");
        assert!(after
            .run
            .to_string()
            .find("Quarterly research brief")
            .is_none());
        let lifecycle = reopened
            .with_conn(|tx| {
                mission_plan::get(
                    tx,
                    &reopened,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    &fixture.member_id,
                    "mission-1",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(lifecycle.mission["status"], "running");
    }

    #[test]
    fn stale_changed_and_tampered_responses_leave_the_wait_unchanged() {
        let fixture = seed();
        let store = reopen(&fixture);
        let pending = request_with_store(&store, request()).unwrap();
        let before = store
            .with_conn(|tx| {
                mission_run::get(
                    tx,
                    &store,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    &fixture.member_id,
                    "run-1",
                )
            })
            .unwrap()
            .unwrap();
        let mut changed_request = request();
        changed_request.fields[0].label = "Changed title".into();
        assert!(request_with_store(&store, changed_request).is_err());
        let stale = receive_with_store(
            &store,
            HumanInputReceiveInput {
                run_id: "run-1".into(),
                wait_key: pending.wait_key.clone(),
                expected_run_revision: pending.run_revision - 1,
                expected_last_sequence: pending.last_sequence,
                values: values(),
            },
        )
        .unwrap_err();
        assert!(stale.to_string().contains("changed"));
        let mut missing = values();
        missing.retain(|value| value.field_key != "title");
        assert!(receive_with_store(
            &store,
            HumanInputReceiveInput {
                run_id: "run-1".into(),
                wait_key: pending.wait_key.clone(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                values: missing,
            },
        )
        .is_err());
        let unchanged = store
            .with_conn(|tx| {
                mission_run::get(
                    tx,
                    &store,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    &fixture.member_id,
                    "run-1",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.run, before.run);
        assert_eq!(unchanged.events, before.events);

        let request_event_id = before.events[2]["id"].as_str().unwrap();
        let mut tampered = before.events[2].clone();
        tampered["payload"]["wait"]["fields"][0]["label"] = json!("Changed label");
        let aad = format!(
            "mission-run-event:{}:{}:{}",
            fixture.workspace_id, fixture.member_id, request_event_id
        );
        let sealed = seal_json(&store, &tampered, &aad).unwrap();
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE mission_run_event SET payload=?1,payload_nonce=?2 WHERE workspace_id=?3 AND owner_member_id=?4 AND id=?5;",
                    rusqlite::params![sealed.ciphertext,sealed.nonce,fixture.workspace_id,fixture.member_id,request_event_id],
                )?;
                Ok(())
            })
            .unwrap();
        let unavailable = pending_with_store(
            &store,
            HumanInputPendingListInput {
                source_thread_id: "thread-1".into(),
                limit: Some(10),
            },
        )
        .unwrap();
        assert!(unavailable.requests.is_empty());
        assert_eq!(unavailable.unavailable_count, 1);
    }

    #[test]
    fn dormant_human_input_cancellation_is_atomic_across_reopen() {
        let fixture = seed();
        let store = reopen(&fixture);
        let pending = request_with_store(&store, request()).unwrap();
        let cancel = crate::mission_runs::MissionRunCancelInput {
            run_id: pending.run_id.clone(),
            event_id: "mission-human-input-cancel-requested-test".into(),
            request_key: "human-input-stop:v1:test".into(),
            expected_run_revision: pending.run_revision,
            expected_last_sequence: pending.last_sequence,
            mode: "cooperative".into(),
            reason: Some("User requested stop while mission input was pending.".into()),
        };
        let settled = crate::mission_runs::request_cancellation_with_store(&store, cancel).unwrap();
        assert_eq!(settled.run["status"], "cancelled");
        assert_eq!(settled.events[3]["type"], "cancellation-requested");
        assert_eq!(settled.events[4]["type"], "run-cancelled");
        drop(store);

        let reopened = reopen(&fixture);
        let replay = crate::mission_runs::request_cancellation_with_store(
            &reopened,
            crate::mission_runs::MissionRunCancelInput {
                run_id: pending.run_id.clone(),
                event_id: "mission-human-input-cancel-requested-test".into(),
                request_key: "human-input-stop:v1:test".into(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                mode: "cooperative".into(),
                reason: Some("User requested stop while mission input was pending.".into()),
            },
        )
        .unwrap();
        assert_eq!(replay.run["status"], "cancelled");
        assert_eq!(replay.events.len(), 5);
        let listed = pending_with_store(
            &reopened,
            HumanInputPendingListInput {
                source_thread_id: "thread-1".into(),
                limit: None,
            },
        )
        .unwrap();
        assert!(listed.requests.is_empty());
        let lifecycle = reopened
            .with_conn(|tx| {
                mission_plan::get(
                    tx,
                    &reopened,
                    &DataScope::workspace(fixture.workspace_id.clone())?,
                    &fixture.member_id,
                    "mission-1",
                )
            })
            .unwrap()
            .unwrap();
        assert_eq!(lifecycle.mission["status"], "cancelled");
    }

    #[test]
    fn schema_and_value_boundaries_fail_closed_and_query_is_bounded() {
        let mut invalid = fields();
        invalid[0].sensitive = true;
        let error = validate_fields(&invalid).unwrap_err();
        assert!(error.contains("secure value boundary"));
        let mut artifact = fields();
        artifact[0].kind = "artifact".into();
        assert!(validate_fields(&artifact).unwrap_err().contains("Artifact"));
        let mut duplicate = fields();
        duplicate[1].key = duplicate[0].key.clone();
        assert!(validate_fields(&duplicate).is_err());
        let mut choices = fields();
        choices[4].choices = Some(vec!["brief".into(), "brief".into()]);
        assert!(validate_fields(&choices).is_err());
        choices[4].choices = Some(vec!["brief".into()]);
        assert!(validate_fields(&choices).is_err());
        assert!(validate_fields(&fields()[..0]).is_err());
        let nine = (0..9)
            .map(|index| field(&format!("field-{index}"), "text", false, None))
            .collect::<Vec<_>>();
        assert!(validate_fields(&nine).is_err());

        let schema = fields();
        for changed in [
            vec![HumanInputValue {
                field_key: "title".into(),
                value: json!(true),
            }],
            vec![HumanInputValue {
                field_key: "format".into(),
                value: json!("memo"),
            }],
            vec![HumanInputValue {
                field_key: "due-at".into(),
                value: json!("2026-07-31 16:30:00"),
            }],
            vec![HumanInputValue {
                field_key: "unknown".into(),
                value: json!("value"),
            }],
        ] {
            assert!(validate_values(&schema, &changed).is_err());
        }
        let fixture = seed();
        let store = reopen(&fixture);
        let scope = DataScope::workspace(fixture.workspace_id).unwrap();
        assert!(store
            .with_conn(|tx| mission_run::list_waiting_human_input_ids(
                tx,
                &scope,
                &fixture.member_id,
                1_002
            ))
            .is_err());
        assert!(pending_with_store(
            &store,
            HumanInputPendingListInput {
                source_thread_id: "thread-1".into(),
                limit: Some(101),
            }
        )
        .is_err());
    }

    #[test]
    fn alternative_receive_replay_and_cross_owner_access_fail_closed() {
        let fixture = seed();
        let store = reopen(&fixture);
        let pending = request_with_store(&store, request()).unwrap();
        receive_with_store(
            &store,
            HumanInputReceiveInput {
                run_id: "run-1".into(),
                wait_key: pending.wait_key.clone(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                values: values(),
            },
        )
        .unwrap();
        let mut changed = values();
        changed[0].value = json!("Different title");
        assert!(receive_with_store(
            &store,
            HumanInputReceiveInput {
                run_id: "run-1".into(),
                wait_key: pending.wait_key,
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
                values: changed,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("different facts"));

        store
            .transaction(|tx| {
                workspace_directory::set_current_internal_user(tx, "user-other", "later")?;
                workspace_directory::select_active_workspace_for_current_user(
                    tx,
                    "workspace-hosted-1",
                    "later",
                )?;
                Ok(())
            })
            .unwrap();
        let isolated = pending_with_store(
            &store,
            HumanInputPendingListInput {
                source_thread_id: "thread-1".into(),
                limit: None,
            },
        )
        .unwrap();
        assert!(isolated.requests.is_empty());
        assert_eq!(isolated.unavailable_count, 0);
        assert!(receive_with_store(
            &store,
            HumanInputReceiveInput {
                run_id: "run-1".into(),
                wait_key: "human-input-wait:v1:unavailable".into(),
                expected_run_revision: 4,
                expected_last_sequence: 3,
                values: values(),
            }
        )
        .unwrap_err()
        .to_string()
        .contains("unavailable"));
    }
}

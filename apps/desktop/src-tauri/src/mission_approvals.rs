//! Provider-neutral durable approval waits for general Mission runs.
//!
//! This boundary records a fresh decision about one exact secret-free
//! side-effect proposal. It never executes the effect, selects a provider, or
//! turns approval into policy, factual, credential, or acceptance authority.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::store::repos::{
    mission_approval_consumption, mission_checkpoint, mission_plan, mission_run, scope::DataScope,
    workspace_directory,
};

const MAX_PENDING_APPROVALS: i64 = 101;
const APPROVED_EFFECT_FRESHNESS_SECONDS: i64 = 15 * 60;

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionApprovalEffect {
    effect_key: String,
    idempotency_key: String,
    target_summary: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionApprovalRequestInput {
    run_id: String,
    worker_id: Option<String>,
    request_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    action_summary: String,
    proposal_hash: String,
    effect: MissionApprovalEffect,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionApprovalResolveInput {
    run_id: String,
    wait_key: String,
    decision: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionApprovalPendingListInput {
    source_thread_id: String,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingMissionApproval {
    pub(crate) run_id: String,
    pub(crate) mission_id: String,
    pub(crate) source_thread_id: String,
    pub(crate) plan_revision_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) worker_id: Option<String>,
    pub(crate) wait_key: String,
    pub(crate) request_key: String,
    pub(crate) action_summary: String,
    pub(crate) proposal_hash: String,
    pub(crate) effect: MissionApprovalEffect,
    pub(crate) requested_at: String,
    pub(crate) run_revision: i64,
    pub(crate) last_sequence: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMissionApprovalEnvelope {
    approvals: Vec<PendingMissionApproval>,
    unavailable_count: usize,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionApprovalResolutionReceipt {
    run_id: String,
    wait_key: String,
    decision: String,
    proposal_hash: String,
    effect: MissionApprovalEffect,
    decided_at: String,
    run_revision: i64,
    last_sequence: i64,
}

/// A stack-local proof returned only to a native effect adapter after the
/// durable approval has been atomically consumed. It is deliberately neither
/// serializable nor exposed as a Tauri command result.
#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct MissionEffectPermit {
    pub(crate) run_id: String,
    pub(crate) wait_key: String,
    pub(crate) resolution_event_id: String,
    pub(crate) proposal_hash: String,
    pub(crate) effect: MissionApprovalEffect,
    pub(crate) consumed_at: String,
}

struct Authorized {
    scope: DataScope,
    internal_user_id: String,
    member_id: String,
}

struct ApprovalFacts {
    lifecycle: mission_plan::MissionPlanLifecycleRow,
    pending: PendingMissionApproval,
    request_event_id: String,
    suffix: String,
    attempt_number: i64,
}

fn authorized(tx: &rusqlite::Connection) -> crate::store::Result<Authorized> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let member_id = context.member_id.ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "An active Fable workspace membership is required for Mission approval.".into(),
        )
    })?;
    Ok(Authorized {
        scope: DataScope::workspace(context.active_workspace.local_workspace_id)?,
        internal_user_id: context.internal_user_id,
        member_id,
    })
}

#[tauri::command]
pub fn mission_approval_request(
    input: MissionApprovalRequestInput,
) -> Result<PendingMissionApproval, String> {
    validate_request(&input)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = authorized(tx)?;
            request_in_tx(tx, store, &auth, &input)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_approval_pending_list(
    input: MissionApprovalPendingListInput,
) -> Result<PendingMissionApprovalEnvelope, String> {
    bounded(&input.source_thread_id, "Approval conversation", 160)?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err("Mission approval list limit must be between 1 and 100.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let auth = authorized(tx)?;
            let ids = mission_run::list_waiting_approval_ids(
                tx,
                &auth.scope,
                &auth.member_id,
                MAX_PENDING_APPROVALS,
            )?;
            let scan_truncated = ids.len() == MAX_PENDING_APPROVALS as usize;
            let mut approvals = Vec::new();
            let mut unavailable_count = 0;
            let mut more_matching = false;
            for run_id in ids {
                let result = mission_run::get(tx, store, &auth.scope, &auth.member_id, &run_id)
                    .and_then(|journal| {
                        let journal = journal.ok_or_else(|| {
                            crate::store::StoreError::Invalid("Mission run disappeared.".into())
                        })?;
                        if is_cited_approval_wait(&journal) {
                            return Ok(None);
                        }
                        pending_for_run_in_tx(tx, store, &auth.scope, &auth.member_id, &journal)
                            .map(Some)
                    });
                match result {
                    Ok(Some(pending)) if pending.source_thread_id == input.source_thread_id => {
                        if approvals.len() < limit {
                            approvals.push(pending);
                        } else {
                            more_matching = true;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => unavailable_count += 1,
                }
            }
            Ok(PendingMissionApprovalEnvelope {
                approvals,
                unavailable_count,
                truncated: scan_truncated || more_matching,
            })
        })
        .map_err(|error| error.to_string())
}

fn is_cited_approval_wait(journal: &mission_run::MissionRunJournalRow) -> bool {
    journal.events.last().is_some_and(|event| {
        event.get("type").and_then(Value::as_str) == Some("approval-requested")
            && event
                .pointer("/payload/wait/approvalRequestRef")
                .and_then(Value::as_str)
                .is_some_and(|reference| reference.starts_with("cited-artifact-proposal:v1:"))
    })
}

#[tauri::command]
pub fn mission_approval_resolve(
    input: MissionApprovalResolveInput,
) -> Result<MissionApprovalResolutionReceipt, String> {
    validate_resolution(&input)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let auth = authorized(tx)?;
            resolve_in_tx(tx, store, &auth, &input)
        })
        .map_err(|error| error.to_string())
}

fn request_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    input: &MissionApprovalRequestInput,
) -> crate::store::Result<PendingMissionApproval> {
    let journal = mission_run::get(tx, store, &auth.scope, &auth.member_id, &input.run_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run is unavailable.".into()))?;
    let base_event_id = event_id_at(&journal, input.expected_last_sequence)?;
    let suffix = approval_suffix(
        auth.scope.workspace_id(),
        &auth.member_id,
        &journal.run,
        input,
        base_event_id,
    )
    .map_err(crate::store::StoreError::Invalid)?;
    let request_event_id = format!("mission-approval-requested-{suffix}");
    if journal
        .events
        .iter()
        .any(|event| event.get("id").and_then(Value::as_str) == Some(request_event_id.as_str()))
    {
        let facts = approval_facts(tx, store, &auth.scope, &auth.member_id, &journal, None)?;
        if facts.suffix != suffix
            || facts.pending.request_key != input.request_key.trim()
            || facts.pending.worker_id.as_deref() != input.worker_id.as_deref()
            || facts.pending.action_summary != input.action_summary.trim()
            || facts.pending.proposal_hash != input.proposal_hash
            || facts.pending.effect != input.effect
        {
            return Err(crate::store::StoreError::Invalid(
                "The Mission approval request key represents different facts.".into(),
            ));
        }
        return Ok(facts.pending);
    }
    let lifecycle = lifecycle_for_run(tx, store, &auth.scope, &auth.member_id, &journal)?;
    exact_live_head(&journal, input)?;
    validate_worker(&journal, input.worker_id.as_deref())
        .map_err(crate::store::StoreError::Invalid)?;
    let at = now();
    append_wait(
        tx,
        store,
        auth,
        &journal,
        &lifecycle,
        input,
        base_event_id,
        &suffix,
        &at,
    )
}

fn resolve_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    input: &MissionApprovalResolveInput,
) -> crate::store::Result<MissionApprovalResolutionReceipt> {
    let journal = mission_run::get(tx, store, &auth.scope, &auth.member_id, &input.run_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run is unavailable.".into()))?;
    if let Some(existing) = journal.events.iter().find(|event| {
        event.get("type").and_then(Value::as_str) == Some("approval-resolved")
            && event
                .pointer("/payload/resolution/waitKey")
                .and_then(Value::as_str)
                == Some(input.wait_key.as_str())
    }) {
        return exact_resolution_replay(&journal, existing, input)
            .map_err(crate::store::StoreError::Invalid);
    }
    let facts = approval_facts(tx, store, &auth.scope, &auth.member_id, &journal, None)?;
    if facts.pending.wait_key != input.wait_key
        || facts.pending.run_revision != input.expected_run_revision
        || facts.pending.last_sequence != input.expected_last_sequence
    {
        return Err(crate::store::StoreError::Invalid(
            "The Mission approval changed before it could be resolved.".into(),
        ));
    }
    let at = now();
    let sequence = input.expected_last_sequence + 1;
    let event_id = format!("mission-approval-resolved-{}", facts.suffix);
    let event_key = format!("mission-approval-resolution:v1:{}", facts.suffix);
    let resolution = json!({
        "waitKey":facts.pending.wait_key,
        "decision":input.decision,
        "decidedAt":at,
        "decidedByInternalUserId":auth.internal_user_id,
        "acceptedProposalHash":facts.pending.proposal_hash,
        "effect":facts.pending.effect
    });
    let event = json!({
        "workspaceId":auth.scope.workspace_id(),"visibility":"member-private",
        "ownerMemberId":auth.member_id,"authority":"local","schemaVersion":1,"revision":1,
        "createdByInternalUserId":auth.internal_user_id,"createdAt":at,"updatedAt":at,
        "id":event_id,"runId":input.run_id,"type":"approval-resolved","sequence":sequence,
        "previousEventId":facts.request_event_id,"attemptNumber":facts.attempt_number,
        "occurredAt":at,
        "actor":{"kind":"internal-user","internalUserId":auth.internal_user_id,
            "memberId":auth.member_id},
        "idempotencyKey":event_key,"payload":{"resolution":resolution}
    });
    let mut projected = object(journal.run.clone())?;
    projected.insert("status".into(), json!("running"));
    projected.insert("revision".into(), json!(input.expected_run_revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":event_id}),
    );
    mission_run::append(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        &input.run_id,
        input.expected_run_revision,
        input.expected_last_sequence,
        &event_id,
        "approval-resolved",
        &event_key,
        &event,
        &Value::Object(projected),
        &at,
    )?;
    mission_plan::resume_waiting(
        tx,
        store,
        &auth.scope,
        &auth.member_id,
        &facts.lifecycle,
        &at,
    )?;
    Ok(MissionApprovalResolutionReceipt {
        run_id: input.run_id.clone(),
        wait_key: input.wait_key.clone(),
        decision: input.decision.clone(),
        proposal_hash: facts.pending.proposal_hash,
        effect: facts.pending.effect,
        decided_at: at,
        run_revision: input.expected_run_revision + 1,
        last_sequence: sequence,
    })
}

pub(crate) fn pending_for_run_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<PendingMissionApproval> {
    approval_facts(tx, store, scope, owner_member_id, journal, None).map(|facts| facts.pending)
}

fn append_wait(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    auth: &Authorized,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    input: &MissionApprovalRequestInput,
    base_event_id: &str,
    suffix: &str,
    at: &str,
) -> crate::store::Result<PendingMissionApproval> {
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
            crate::store::StoreError::Invalid("Mission source conversation is invalid.".into())
        })?
        .to_string();
    let attempt_number = journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let wait_key = format!("mission-approval-wait:v1:{suffix}");
    let checkpoint_event_id = format!("mission-approval-checkpoint-{suffix}");
    let request_event_id = format!("mission-approval-requested-{suffix}");
    let checkpoint_reference = format!("checkpoint:{checkpoint_event_id}");
    let replay =
        crate::mission_runs::derive_replay_facts(&journal.events, input.expected_last_sequence)
            .map_err(crate::store::StoreError::Invalid)?;
    if replay
        .state
        .get("pendingWaitKeys")
        .and_then(Value::as_array)
        .is_none_or(|waits| !waits.is_empty())
    {
        return Err(crate::store::StoreError::Invalid(
            "A Mission can request only one durable wait at a time.".into(),
        ));
    }
    let mut approval_wait = json!({
        "planRevisionId":plan_revision_id,"requestKey":input.request_key.trim(),
        "actionSummary":input.action_summary.trim(),
        "proposalHash":input.proposal_hash,"effect":input.effect,
        "waitKey":wait_key,"requestedAt":at,
        "runHead":{"revision":input.expected_run_revision,
            "lastSequence":input.expected_last_sequence,"lastEventId":base_event_id}
    });
    if let Some(worker_id) = &input.worker_id {
        approval_wait["workerId"] = json!(worker_id);
    }
    let checkpoint_state = json!({
        "activeWorkerIds":replay.state.get("activeWorkerIds"),
        "activePlanStepKeys":replay.state.get("activePlanStepKeys"),
        "pendingWaitKeys":[wait_key],
        "approvalWait":approval_wait
    });
    let state_hash = crate::mission_runs::checkpoint_state_hash(
        &input.run_id,
        &checkpoint_event_id,
        attempt_number,
        &checkpoint_reference,
        &checkpoint_state,
    )
    .map_err(crate::store::StoreError::Invalid)?;
    let checkpoint_sequence = input.expected_last_sequence + 1;
    let checkpoint = json!({
        "kind":"wait-boundary","attemptNumber":attempt_number,"createdAt":at,
        "replayBoundary":{"durableThroughSequence":input.expected_last_sequence,
            "resumeAfterEventId":base_event_id,
            "completedPlanStepKeys":replay.completed_plan_step_keys,
            "completedWorkerIds":replay.completed_worker_ids,
            "committedEffectKeys":replay.committed_effect_keys},
        "stateStorage":"portable-redacted","stateReference":checkpoint_reference,
        "stateHash":state_hash,"executionNodeId":"local-desktop","pendingWaitKey":wait_key
    });
    let checkpoint_key = format!("mission-approval-checkpoint:v1:{suffix}");
    let checkpoint_event = event(
        auth,
        &input.run_id,
        &checkpoint_event_id,
        "checkpoint-created",
        checkpoint_sequence,
        base_event_id,
        attempt_number,
        &checkpoint_key,
        json!({"checkpoint":checkpoint}),
        at,
    );
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
    let mut wait = json!({
        "waitKey":wait_key,"status":"pending","requestKey":input.request_key.trim(),
        "actionSummary":input.action_summary.trim(),
        "proposalHash":input.proposal_hash,"effect":input.effect,
        "requestedAt":at
    });
    if let Some(worker_id) = &input.worker_id {
        wait["workerId"] = json!(worker_id);
    }
    let request_key = format!("mission-approval-request:v1:{suffix}");
    let request_event = event(
        auth,
        &input.run_id,
        &request_event_id,
        "approval-requested",
        request_sequence,
        &checkpoint_event_id,
        attempt_number,
        &request_key,
        json!({"wait":wait}),
        at,
    );
    let mut request_projection = object(journal.run.clone())?;
    request_projection.insert("status".into(), json!("waiting-approval"));
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
        "approval-requested",
        &request_key,
        &request_event,
        &Value::Object(request_projection),
        at,
    )?;
    mission_plan::mark_waiting(tx, store, &auth.scope, &auth.member_id, lifecycle, at)?;
    Ok(PendingMissionApproval {
        run_id: input.run_id.clone(),
        mission_id,
        source_thread_id,
        plan_revision_id: plan_revision_id.to_string(),
        worker_id: input.worker_id.clone(),
        wait_key,
        request_key: input.request_key.trim().to_string(),
        action_summary: input.action_summary.trim().to_string(),
        proposal_hash: input.proposal_hash.clone(),
        effect: input.effect.clone(),
        requested_at: at.to_string(),
        run_revision: input.expected_run_revision + 2,
        last_sequence: request_sequence,
    })
}

fn approval_facts(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    known_lifecycle: Option<&mission_plan::MissionPlanLifecycleRow>,
) -> crate::store::Result<ApprovalFacts> {
    if journal.run.get("status").and_then(Value::as_str) != Some("waiting-approval") {
        return Err(crate::store::StoreError::Invalid(
            "Mission run is not waiting for approval.".into(),
        ));
    }
    let revision = positive(&journal.run, "revision", "Mission run revision")?;
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
        })?
        .to_string();
    let request_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(&request_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval request is unavailable.".into())
        })?;
    let checkpoint_event_id = request_event
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval checkpoint is invalid.".into())
        })?
        .to_string();
    let checkpoint_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(&checkpoint_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval checkpoint is unavailable.".into())
        })?;
    let wait = request_event
        .pointer("/payload/wait")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval request is invalid.".into())
        })?;
    let wait_key = required(wait, "waitKey")?;
    let request_key = required(wait, "requestKey")?;
    let action_summary = required(wait, "actionSummary")?;
    let proposal_hash = required(wait, "proposalHash")?;
    let requested_at = required(wait, "requestedAt")?;
    let worker_id = wait
        .get("workerId")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission approval worker is invalid.".into())
                })
        })
        .transpose()?;
    let effect: MissionApprovalEffect =
        serde_json::from_value(wait.get("effect").cloned().ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval effect is missing.".into())
        })?)
        .map_err(|_| {
            crate::store::StoreError::Invalid("Mission approval effect is invalid.".into())
        })?;
    validate_effect(&effect).map_err(crate::store::StoreError::Invalid)?;
    let suffix = wait_key
        .strip_prefix("mission-approval-wait:v1:")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval identity is invalid.".into())
        })?
        .to_string();
    let attempt_number = request_event
        .get("attemptNumber")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval attempt is invalid.".into())
        })?;
    if request_event.get("type").and_then(Value::as_str) != Some("approval-requested")
        || request_event.get("sequence").and_then(Value::as_i64) != Some(last_sequence)
        || checkpoint_event.get("type").and_then(Value::as_str) != Some("checkpoint-created")
        || checkpoint_event.get("sequence").and_then(Value::as_i64) != Some(last_sequence - 1)
        || checkpoint_event
            .pointer("/payload/checkpoint/kind")
            .and_then(Value::as_str)
            != Some("wait-boundary")
        || checkpoint_event
            .pointer("/payload/checkpoint/pendingWaitKey")
            .and_then(Value::as_str)
            != Some(wait_key.as_str())
        || wait.get("status").and_then(Value::as_str) != Some("pending")
        || request_event_id != format!("mission-approval-requested-{suffix}")
        || checkpoint_event_id != format!("mission-approval-checkpoint-{suffix}")
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission approval event chain is invalid.".into(),
        ));
    }
    let checkpoint =
        mission_checkpoint::get_by_event(tx, store, scope, owner_member_id, &checkpoint_event_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Mission approval checkpoint state is unavailable.".into(),
                )
            })?;
    crate::mission_runs::verify_checkpoint_state(&checkpoint, checkpoint_event)
        .map_err(crate::store::StoreError::Invalid)?;
    let approval_wait = checkpoint
        .state
        .get("approvalWait")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Mission approval checkpoint facts are missing.".into(),
            )
        })?;
    let plan_revision_id = journal
        .run
        .get("planRevisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run plan revision is invalid.".into())
        })?;
    let base_revision = approval_wait
        .get("runHead")
        .and_then(|value| value.get("revision"))
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval checkpoint head is invalid.".into())
        })?;
    let base_sequence = approval_wait
        .get("runHead")
        .and_then(|value| value.get("lastSequence"))
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval checkpoint head is invalid.".into())
        })?;
    let base_event_id = approval_wait
        .get("runHead")
        .and_then(|value| value.get("lastEventId"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval checkpoint head is invalid.".into())
        })?;
    let replay = crate::mission_runs::derive_replay_facts(&journal.events, base_sequence)
        .map_err(crate::store::StoreError::Invalid)?;
    let expected_state = json!({
        "activeWorkerIds":replay.state.get("activeWorkerIds"),
        "activePlanStepKeys":replay.state.get("activePlanStepKeys"),
        "pendingWaitKeys":[wait_key],
        "approvalWait":approval_wait
    });
    let request_input = MissionApprovalRequestInput {
        run_id: journal
            .run
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        worker_id: worker_id.clone(),
        request_key: request_key.clone(),
        expected_run_revision: base_revision,
        expected_last_sequence: base_sequence,
        action_summary: action_summary.clone(),
        proposal_hash: proposal_hash.clone(),
        effect: effect.clone(),
    };
    let expected_suffix = approval_suffix(
        scope.workspace_id(),
        owner_member_id,
        &journal.run,
        &request_input,
        base_event_id,
    )
    .map_err(crate::store::StoreError::Invalid)?;
    if checkpoint.state != expected_state
        || checkpoint.attempt_number != attempt_number
        || checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/durableThroughSequence")
            .and_then(Value::as_i64)
            != Some(base_sequence)
        || checkpoint_event
            .pointer("/payload/checkpoint/replayBoundary/resumeAfterEventId")
            .and_then(Value::as_str)
            != Some(base_event_id)
        || checkpoint_event.pointer("/payload/checkpoint/replayBoundary/completedPlanStepKeys")
            != Some(&json!(replay.completed_plan_step_keys))
        || checkpoint_event.pointer("/payload/checkpoint/replayBoundary/completedWorkerIds")
            != Some(&json!(replay.completed_worker_ids))
        || checkpoint_event.pointer("/payload/checkpoint/replayBoundary/committedEffectKeys")
            != Some(&json!(replay.committed_effect_keys))
        || approval_wait.get("planRevisionId").and_then(Value::as_str) != Some(plan_revision_id)
        || approval_wait.get("waitKey").and_then(Value::as_str) != Some(wait_key.as_str())
        || approval_wait.get("requestedAt").and_then(Value::as_str) != Some(requested_at.as_str())
        || approval_wait.get("workerId") != wait.get("workerId")
        || approval_wait.get("effect") != wait.get("effect")
        || expected_suffix != suffix
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission approval checkpoint does not match its exact proposal.".into(),
        ));
    }
    let mission_id = mission_id(&journal.run)?.to_string();
    let owned_lifecycle;
    let lifecycle = if let Some(lifecycle) = known_lifecycle {
        lifecycle
    } else {
        owned_lifecycle = mission_plan::get(tx, store, scope, owner_member_id, &mission_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission plan is unavailable.".into())
            })?;
        &owned_lifecycle
    };
    if lifecycle.mission.get("status").and_then(Value::as_str) != Some("waiting")
        || lifecycle.current_revision.get("id").and_then(Value::as_str) != Some(plan_revision_id)
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission lifecycle does not match its approval wait.".into(),
        ));
    }
    let source_thread_id = journal
        .run
        .get("sourceThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission source conversation is invalid.".into())
        })?
        .to_string();
    Ok(ApprovalFacts {
        lifecycle: lifecycle.clone(),
        pending: PendingMissionApproval {
            run_id: request_input.run_id,
            mission_id,
            source_thread_id,
            plan_revision_id: plan_revision_id.to_string(),
            worker_id,
            wait_key,
            request_key,
            action_summary,
            proposal_hash,
            effect,
            requested_at,
            run_revision: revision,
            last_sequence,
        },
        request_event_id,
        suffix,
        attempt_number,
    })
}

fn exact_resolution_replay(
    journal: &mission_run::MissionRunJournalRow,
    event: &Value,
    input: &MissionApprovalResolveInput,
) -> Result<MissionApprovalResolutionReceipt, String> {
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Replayed Mission approval event is invalid.".to_string())?;
    let request_event_id = event
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Replayed Mission approval request link is invalid.".to_string())?;
    let request_event = journal
        .events
        .iter()
        .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(request_event_id))
        .ok_or_else(|| "Replayed Mission approval request is unavailable.".to_string())?;
    let decision = event
        .pointer("/payload/resolution/decision")
        .and_then(Value::as_str);
    let wait_key = event
        .pointer("/payload/resolution/waitKey")
        .and_then(Value::as_str);
    let decided_at = event.get("occurredAt").and_then(Value::as_str);
    let proposal_hash = event
        .pointer("/payload/resolution/acceptedProposalHash")
        .and_then(Value::as_str);
    let effect: MissionApprovalEffect = serde_json::from_value(
        event
            .pointer("/payload/resolution/effect")
            .cloned()
            .ok_or_else(|| "Replayed Mission approval effect is missing.".to_string())?,
    )
    .map_err(|_| "Replayed Mission approval effect is invalid.".to_string())?;
    if event.get("type").and_then(Value::as_str) != Some("approval-resolved")
        || event.get("runId").and_then(Value::as_str) != Some(input.run_id.as_str())
        || event_id.is_empty()
        || decision != Some(input.decision.as_str())
        || wait_key != Some(input.wait_key.as_str())
        || event.get("sequence").and_then(Value::as_i64) != Some(input.expected_last_sequence + 1)
        || request_event.get("type").and_then(Value::as_str) != Some("approval-requested")
        || request_event.get("sequence").and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
        || request_event
            .pointer("/payload/wait/waitKey")
            .and_then(Value::as_str)
            != Some(input.wait_key.as_str())
        || request_event
            .pointer("/payload/wait/proposalHash")
            .and_then(Value::as_str)
            != proposal_hash
        || request_event.pointer("/payload/wait/effect")
            != event.pointer("/payload/resolution/effect")
    {
        return Err("Mission approval was already resolved differently.".into());
    }
    Ok(MissionApprovalResolutionReceipt {
        run_id: input.run_id.clone(),
        wait_key: input.wait_key.clone(),
        decision: input.decision.clone(),
        proposal_hash: proposal_hash
            .ok_or_else(|| "Replayed Mission approval proposal is invalid.".to_string())?
            .to_string(),
        effect,
        decided_at: decided_at
            .ok_or_else(|| "Replayed Mission approval time is invalid.".to_string())?
            .to_string(),
        run_revision: input.expected_run_revision + 1,
        last_sequence: input.expected_last_sequence + 1,
    })
}

/// Native effect adapters call this inside their authenticated transaction
/// immediately before egress. Consuming first gives at-most-once semantics:
/// a crash can require a fresh approval, but can never silently replay an
/// uncertain consequential effect.
///
/// No renderer command wraps this function. Until a concrete native effect
/// adapter calls it, approved Mission waits execute nothing.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn consume_approved_effect_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
    wait_key: &str,
    proposal_hash: &str,
    effect: &MissionApprovalEffect,
    expected_run_revision: i64,
    expected_last_sequence: i64,
) -> crate::store::Result<MissionEffectPermit> {
    consume_approved_effect_at(
        tx,
        store,
        scope,
        owner_member_id,
        run_id,
        wait_key,
        proposal_hash,
        effect,
        expected_run_revision,
        expected_last_sequence,
        &now(),
    )
}

#[allow(clippy::too_many_arguments)]
fn consume_approved_effect_at(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    run_id: &str,
    wait_key: &str,
    proposal_hash: &str,
    effect: &MissionApprovalEffect,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    consumed_at: &str,
) -> crate::store::Result<MissionEffectPermit> {
    validate_effect(effect).map_err(crate::store::StoreError::Invalid)?;
    validate_hash(proposal_hash, "Mission approval proposal")
        .map_err(crate::store::StoreError::Invalid)?;
    let journal = mission_run::get(tx, store, scope, owner_member_id, run_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run is unavailable.".into()))?;
    if journal.run.get("status").and_then(Value::as_str) != Some("running")
        || journal.run.get("revision").and_then(Value::as_i64) != Some(expected_run_revision)
        || journal
            .run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(expected_last_sequence)
    {
        return Err(crate::store::StoreError::Invalid(
            "The Mission changed before its approved effect could run.".into(),
        ));
    }
    let resolutions = journal
        .events
        .iter()
        .filter(|event| {
            event.get("type").and_then(Value::as_str) == Some("approval-resolved")
                && event
                    .pointer("/payload/resolution/waitKey")
                    .and_then(Value::as_str)
                    == Some(wait_key)
        })
        .collect::<Vec<_>>();
    if resolutions.len() != 1 {
        return Err(crate::store::StoreError::Invalid(
            "The approved Mission effect has no unique resolution.".into(),
        ));
    }
    let resolution = resolutions[0];
    let event_id = resolution
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval resolution is invalid.".into())
        })?
        .to_string();
    let request_id = resolution
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval request link is invalid.".into())
        })?;
    let request = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(request_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval request is unavailable.".into())
        })?;
    let resolved_effect = resolution
        .pointer("/payload/resolution/effect")
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval effect is unavailable.".into())
        })?;
    let decided_at = resolution
        .get("occurredAt")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission approval decision time is invalid.".into())
        })?;
    let approver = resolution
        .pointer("/actor/internalUserId")
        .and_then(Value::as_str);
    if resolution
        .pointer("/payload/resolution/decision")
        .and_then(Value::as_str)
        != Some("approved")
        || resolution
            .pointer("/payload/resolution/acceptedProposalHash")
            .and_then(Value::as_str)
            != Some(proposal_hash)
        || resolved_effect != &json!(effect)
        || resolution.pointer("/actor/kind").and_then(Value::as_str) != Some("internal-user")
        || resolution
            .pointer("/actor/memberId")
            .and_then(Value::as_str)
            != Some(owner_member_id)
        || approver.is_none_or(str::is_empty)
        || request.get("type").and_then(Value::as_str) != Some("approval-requested")
        || request
            .pointer("/payload/wait/proposalHash")
            .and_then(Value::as_str)
            != Some(proposal_hash)
        || request.pointer("/payload/wait/effect") != Some(resolved_effect)
    {
        return Err(crate::store::StoreError::Invalid(
            "The Mission effect does not match its exact approved proposal.".into(),
        ));
    }
    let decided = DateTime::parse_from_rfc3339(decided_at).map_err(|_| {
        crate::store::StoreError::Invalid("Mission approval decision time is invalid.".into())
    })?;
    let consumed = DateTime::parse_from_rfc3339(consumed_at)
        .map_err(|_| crate::store::StoreError::Invalid("Mission effect time is invalid.".into()))?;
    let age = consumed.signed_duration_since(decided).num_seconds();
    if !(0..=APPROVED_EFFECT_FRESHNESS_SECONDS).contains(&age) {
        return Err(crate::store::StoreError::Invalid(
            "The Mission approval is stale; ask for a fresh decision.".into(),
        ));
    }
    let receipt = json!({
        "workspaceId":scope.workspace_id(),
        "ownerMemberId":owner_member_id,
        "runId":run_id,
        "waitKey":wait_key,
        "resolutionEventId":event_id,
        "proposalHash":proposal_hash,
        "effectKey":effect.effect_key,
        "consumedAt":consumed_at
    });
    mission_approval_consumption::consume(
        tx,
        store,
        scope,
        owner_member_id,
        run_id,
        wait_key,
        &event_id,
        proposal_hash,
        &effect.effect_key,
        &receipt,
        consumed_at,
    )?;
    Ok(MissionEffectPermit {
        run_id: run_id.to_string(),
        wait_key: wait_key.to_string(),
        resolution_event_id: event_id,
        proposal_hash: proposal_hash.to_string(),
        effect: effect.clone(),
        consumed_at: consumed_at.to_string(),
    })
}

fn lifecycle_for_run(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
) -> crate::store::Result<mission_plan::MissionPlanLifecycleRow> {
    let mission_id = mission_id(&journal.run)?;
    let lifecycle = mission_plan::get(tx, store, scope, owner_member_id, mission_id)?
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission plan is unavailable.".into()))?;
    if lifecycle.mission.get("status").and_then(Value::as_str) != Some("running")
        || lifecycle.current_revision.get("id") != journal.run.get("planRevisionId")
        || lifecycle.mission.get("workspaceId") != journal.run.get("workspaceId")
        || lifecycle.mission.get("ownerMemberId") != journal.run.get("ownerMemberId")
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission approval is not bound to the selected running Plan.".into(),
        ));
    }
    Ok(lifecycle)
}

fn exact_live_head<'a>(
    journal: &'a mission_run::MissionRunJournalRow,
    input: &MissionApprovalRequestInput,
) -> crate::store::Result<&'a str> {
    if journal.run.get("status").and_then(Value::as_str) != Some("running")
        || journal.run.get("revision").and_then(Value::as_i64) != Some(input.expected_run_revision)
        || journal
            .run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
    {
        return Err(crate::store::StoreError::Invalid(
            "The Mission run changed before approval could be requested.".into(),
        ));
    }
    journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })
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
            crate::store::StoreError::Invalid("Mission approval base event is unavailable.".into())
        })
}

fn validate_worker(
    journal: &mission_run::MissionRunJournalRow,
    worker_id: Option<&str>,
) -> Result<(), String> {
    let Some(worker_id) = worker_id else {
        return Ok(());
    };
    bounded(worker_id, "Approval worker", 160)?;
    let created = journal.events.iter().filter(|event| {
        event.get("type").and_then(Value::as_str) == Some("worker-created")
            && event.pointer("/payload/worker/id").and_then(Value::as_str) == Some(worker_id)
    });
    if created.count() != 1
        || journal.events.iter().any(|event| {
            matches!(
                event.get("type").and_then(Value::as_str),
                Some("worker-completed" | "worker-failed")
            ) && event.pointer("/payload/workerId").and_then(Value::as_str) == Some(worker_id)
        })
    {
        return Err("Mission approval requires one exact live worker assignment.".into());
    }
    Ok(())
}

fn approval_suffix(
    workspace_id: &str,
    owner_member_id: &str,
    run: &Value,
    input: &MissionApprovalRequestInput,
    base_event_id: &str,
) -> Result<String, String> {
    let plan_revision_id = run
        .get("planRevisionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run plan revision is invalid.".to_string())?;
    let envelope = json!({
        "version":1,"workspaceId":workspace_id,"ownerMemberId":owner_member_id,
        "runId":input.run_id,"planRevisionId":plan_revision_id,
        "workerId":input.worker_id,"requestKey":input.request_key.trim(),
        "actionSummary":input.action_summary.trim(),"proposalHash":input.proposal_hash,
        "effect":input.effect,"runRevision":input.expected_run_revision,
        "lastSequence":input.expected_last_sequence,"lastEventId":base_event_id
    });
    let bytes = serde_json::to_vec(&envelope)
        .map_err(|_| "Mission approval identity could not be encoded.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn validate_request(input: &MissionApprovalRequestInput) -> Result<(), String> {
    bounded(&input.run_id, "Mission run", 160)?;
    bounded(&input.request_key, "Mission approval request key", 200)?;
    safe_summary(&input.action_summary, "Mission approval action", 500)?;
    if input.expected_run_revision < 1
        || input.expected_last_sequence < 1
        || input.proposal_hash.len() != 64
        || !input
            .proposal_hash
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err("Mission approval request is invalid.".into());
    }
    if let Some(worker_id) = input.worker_id.as_deref() {
        bounded(worker_id, "Mission approval worker", 160)?;
    }
    validate_effect(&input.effect)
}

fn validate_resolution(input: &MissionApprovalResolveInput) -> Result<(), String> {
    bounded(&input.run_id, "Mission run", 160)?;
    bounded(&input.wait_key, "Mission approval wait", 200)?;
    if !matches!(input.decision.as_str(), "approved" | "denied")
        || input.expected_run_revision < 1
        || input.expected_last_sequence < 1
    {
        return Err("Mission approval resolution is invalid.".into());
    }
    Ok(())
}

fn validate_effect(effect: &MissionApprovalEffect) -> Result<(), String> {
    bounded(&effect.effect_key, "Approval effect key", 200)?;
    bounded(
        &effect.idempotency_key,
        "Approval effect idempotency key",
        200,
    )?;
    safe_summary(&effect.target_summary, "Approval target summary", 500)
}

fn validate_hash(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn safe_summary(value: &str, label: &str, max: usize) -> Result<(), String> {
    let value = bounded(value, label, max)?;
    if crate::store::repos::action_history::redact_safe_detail(&json!(value)) != json!(value) {
        return Err(format!("{label} cannot contain secret-shaped data."));
    }
    Ok(())
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(value.to_string())
}

fn mission_id(run: &Value) -> crate::store::Result<&str> {
    run.get("missionId")
        .or_else(|| run.pointer("/initiator/missionId"))
        .and_then(Value::as_str)
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission identity is invalid.".into()))
}

fn positive(value: &Value, key: &str, label: &str) -> crate::store::Result<i64> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| crate::store::StoreError::Invalid(format!("{label} is invalid.")))
}

fn object(value: Value) -> crate::store::Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run record is invalid.".into()))
}

fn required(object: &Map<String, Value>, key: &str) -> crate::store::Result<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(format!("Mission approval {key} is invalid."))
        })
}

#[allow(clippy::too_many_arguments)]
fn event(
    auth: &Authorized,
    run_id: &str,
    event_id: &str,
    event_type: &str,
    sequence: i64,
    previous_event_id: &str,
    attempt_number: i64,
    idempotency_key: &str,
    payload: Value,
    at: &str,
) -> Value {
    json!({
        "workspaceId":auth.scope.workspace_id(),"visibility":"member-private",
        "ownerMemberId":auth.member_id,"authority":"local","schemaVersion":1,"revision":1,
        "createdByInternalUserId":auth.internal_user_id,"createdAt":at,"updatedAt":at,
        "id":event_id,"runId":run_id,"type":event_type,"sequence":sequence,
        "previousEventId":previous_event_id,"attemptNumber":attempt_number,
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":idempotency_key,
        "payload":payload
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::vault::{MasterKey, Vault};

    #[test]
    fn request_validation_rejects_secrets_and_unbounded_effects() {
        let input = MissionApprovalRequestInput {
            run_id: "run-1".into(),
            worker_id: Some("worker-1".into()),
            request_key: "send-1".into(),
            expected_run_revision: 4,
            expected_last_sequence: 3,
            action_summary: "Send the reviewed update.".into(),
            proposal_hash: "a".repeat(64),
            effect: MissionApprovalEffect {
                effect_key: "email-send:1".into(),
                idempotency_key: "email-send:1".into(),
                target_summary: "One reviewed email".into(),
            },
        };
        validate_request(&input).unwrap();
        let secret = MissionApprovalRequestInput {
            action_summary: "Authorization: Bearer secret".into(),
            ..input
        };
        assert!(validate_request(&secret).unwrap_err().contains("secret"));
    }

    #[test]
    fn approval_identity_changes_with_scope_head_and_proposal() {
        let input = MissionApprovalRequestInput {
            run_id: "run-1".into(),
            worker_id: None,
            request_key: "effect-1".into(),
            expected_run_revision: 4,
            expected_last_sequence: 3,
            action_summary: "Publish one update.".into(),
            proposal_hash: "a".repeat(64),
            effect: MissionApprovalEffect {
                effect_key: "publish:1".into(),
                idempotency_key: "publish:1".into(),
                target_summary: "One update".into(),
            },
        };
        let run = json!({"planRevisionId":"revision-1"});
        let first = approval_suffix("w1", "m1", &run, &input, "event-3").unwrap();
        let changed = MissionApprovalRequestInput {
            proposal_hash: "b".repeat(64),
            ..input
        };
        assert_ne!(
            first,
            approval_suffix("w1", "m1", &run, &changed, "event-3").unwrap()
        );
        assert_ne!(
            first,
            approval_suffix("w1", "m1", &run, &changed, "event-4").unwrap()
        );
    }

    #[test]
    fn general_listing_does_not_misclassify_cited_acceptance() {
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"waiting-approval"}),
            events: vec![json!({
                "type":"approval-requested",
                "payload":{"wait":{"approvalRequestRef":
                    "cited-artifact-proposal:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
            })],
        };
        assert!(is_cited_approval_wait(&journal));
    }

    #[test]
    fn durable_general_approval_replays_resolves_and_reopens() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fable.db");
        let key = MasterKey::generate().unwrap();
        {
            let store = crate::store::Store::open(&path, Vault::new(&key).unwrap()).unwrap();
            store
                .with_conn(|tx| {
                    tx.execute(
                        "INSERT INTO workspace(id,name,created_at,updated_at) VALUES ('w1','One','t','t');",
                        [],
                    )?;
                    Ok(())
                })
                .unwrap();
            let scope = DataScope::workspace("w1").unwrap();
            let mission = json!({
                "id":"mission-1","workspaceId":"w1","visibility":"member-private",
                "ownerMemberId":"member-1","authority":"local","schemaVersion":1,"revision":1,
                "createdByInternalUserId":"user-1","createdAt":"t1","updatedAt":"t1",
                "status":"ready","executionDepth":"multi-worker","currentPlanId":"plan-1",
                "currentPlanRevisionId":"revision-1",
                "scope":{"workspaceId":"w1","sourceThreadId":"thread-1",
                    "departmentIds":[],"context":[]},"budget":{"maxAttempts":2},
                "acceptance":{"requiresHumanAcceptance":false,"criteria":[]}
            });
            let plan = json!({
                "id":"plan-1","missionId":"mission-1","status":"current",
                "currentRevisionId":"revision-1","currentRevisionNumber":1,"revision":1
            });
            let revision = json!({
                "id":"revision-1","planId":"plan-1","missionId":"mission-1",
                "planRevisionNumber":1,"summary":"Perform one bounded effect.",
                "steps":[{"key":"act","kind":"act","dependsOnStepKeys":[],
                    "requiredCapabilities":[],"expectedOutputs":[]}]
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
                        "multi-worker",
                        &mission,
                        &plan,
                        &revision,
                        "t1",
                    )
                })
                .unwrap();
            let create = crate::mission_runs::MissionRunCreateInput {
                mission_id: "mission-1".into(),
                run_id: "run-1".into(),
                event_id: "event-create".into(),
                idempotency_key: "create-1".into(),
            };
            let (run, created_event) = crate::mission_runs::build_run_created(
                &lifecycle, &create, "user-1", "member-1", "t2",
            )
            .unwrap();
            store
                .transaction(|tx| {
                    let created = mission_run::create(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "user-1",
                        "run-1",
                        "event-create",
                        "create:create-1",
                        &run,
                        &created_event,
                        "t2",
                    )?;
                    let mut projected = created.run.as_object().unwrap().clone();
                    projected.insert("status".into(), json!("running"));
                    projected.insert("revision".into(), json!(3));
                    projected.insert("updatedAt".into(), json!("t3"));
                    projected.insert(
                        "eventHead".into(),
                        json!({"lastSequence":2,"lastEventId":"event-running"}),
                    );
                    let running_event = json!({
                        "id":"event-running","runId":"run-1","type":"status-transitioned",
                        "sequence":2,"previousEventId":"event-create","occurredAt":"t3",
                        "idempotencyKey":"status:running",
                        "payload":{"from":"created","to":"running"}
                    });
                    mission_run::append(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-1",
                        2,
                        1,
                        "event-running",
                        "status-transitioned",
                        "status:running",
                        &running_event,
                        &Value::Object(projected),
                        "t3",
                    )?;
                    mission_plan::mark_running(tx, &store, &scope, "member-1", &lifecycle, "t3")?;
                    Ok(())
                })
                .unwrap();
            let auth = Authorized {
                scope: scope.clone(),
                internal_user_id: "user-1".into(),
                member_id: "member-1".into(),
            };
            let request = MissionApprovalRequestInput {
                run_id: "run-1".into(),
                worker_id: None,
                request_key: "publish-1".into(),
                expected_run_revision: 3,
                expected_last_sequence: 2,
                action_summary: "Publish the reviewed update.".into(),
                proposal_hash: "a".repeat(64),
                effect: MissionApprovalEffect {
                    effect_key: "publish:update-1".into(),
                    idempotency_key: "publish:update-1".into(),
                    target_summary: "One reviewed update".into(),
                },
            };
            let pending = store
                .transaction(|tx| request_in_tx(tx, &store, &auth, &request))
                .unwrap();
            assert_eq!(pending.run_revision, 5);
            assert_eq!(pending.last_sequence, 4);
            let replayed = store
                .transaction(|tx| request_in_tx(tx, &store, &auth, &request))
                .unwrap();
            assert_eq!(replayed, pending);
            let waiting = store
                .with_conn(|tx| {
                    let journal =
                        mission_run::get(tx, &store, &scope, "member-1", "run-1")?.unwrap();
                    pending_for_run_in_tx(tx, &store, &scope, "member-1", &journal)
                })
                .unwrap();
            assert_eq!(waiting.wait_key, pending.wait_key);
            let resolution = MissionApprovalResolveInput {
                run_id: "run-1".into(),
                wait_key: pending.wait_key.clone(),
                decision: "approved".into(),
                expected_run_revision: pending.run_revision,
                expected_last_sequence: pending.last_sequence,
            };
            let receipt = store
                .transaction(|tx| resolve_in_tx(tx, &store, &auth, &resolution))
                .unwrap();
            assert_eq!(receipt.decision, "approved");
            assert_eq!(receipt.run_revision, 6);
            let replayed_receipt = store
                .transaction(|tx| resolve_in_tx(tx, &store, &auth, &resolution))
                .unwrap();
            assert_eq!(replayed_receipt.decision, "approved");
            let changed_effect = MissionApprovalEffect {
                target_summary: "A substituted target".into(),
                ..request.effect.clone()
            };
            let changed_error = store
                .transaction(|tx| {
                    consume_approved_effect_at(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-1",
                        &pending.wait_key,
                        &request.proposal_hash,
                        &changed_effect,
                        6,
                        5,
                        &receipt.decided_at,
                    )
                })
                .unwrap_err();
            assert!(changed_error
                .to_string()
                .contains("exact approved proposal"));
            let stale_at = (DateTime::parse_from_rfc3339(&receipt.decided_at).unwrap()
                + chrono::Duration::seconds(APPROVED_EFFECT_FRESHNESS_SECONDS + 1))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
            let stale_error = store
                .transaction(|tx| {
                    consume_approved_effect_at(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-1",
                        &pending.wait_key,
                        &request.proposal_hash,
                        &request.effect,
                        6,
                        5,
                        &stale_at,
                    )
                })
                .unwrap_err();
            assert!(stale_error.to_string().contains("approval is stale"));
            let permit = store
                .transaction(|tx| {
                    consume_approved_effect_at(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-1",
                        &pending.wait_key,
                        &request.proposal_hash,
                        &request.effect,
                        6,
                        5,
                        &receipt.decided_at,
                    )
                })
                .unwrap();
            assert_eq!(permit.wait_key, pending.wait_key);
            let replay_error = store
                .transaction(|tx| {
                    consume_approved_effect_at(
                        tx,
                        &store,
                        &scope,
                        "member-1",
                        "run-1",
                        &pending.wait_key,
                        &request.proposal_hash,
                        &request.effect,
                        6,
                        5,
                        &receipt.decided_at,
                    )
                })
                .unwrap_err();
            assert!(replay_error.to_string().contains("already consumed"));
            let journal = store
                .with_conn(|tx| {
                    mission_run::get(tx, &store, &scope, "member-1", "run-1")?
                        .ok_or_else(|| crate::store::StoreError::Invalid("missing run".into()))
                })
                .unwrap();
            let resolved_event = journal.events.last().unwrap().clone();
            let mut progressed_run = journal.run.clone();
            progressed_run["revision"] = json!(7);
            progressed_run["eventHead"] =
                json!({"lastSequence":6,"lastEventId":"event-after-approval"});
            let mut progressed_events = journal.events;
            progressed_events.push(json!({
                "id":"event-after-approval","runId":"run-1","type":"status-transitioned",
                "sequence":6,"previousEventId":resolved_event["id"],"occurredAt":"t7",
                "idempotencyKey":"status:after-approval","payload":{"from":"running","to":"running"}
            }));
            let progressed = mission_run::MissionRunJournalRow {
                run: progressed_run,
                events: progressed_events,
            };
            let historical_replay =
                exact_resolution_replay(&progressed, &resolved_event, &resolution).unwrap();
            assert_eq!(historical_replay.decision, receipt.decision);
            assert_eq!(historical_replay.proposal_hash, receipt.proposal_hash);
            assert_eq!(historical_replay.run_revision, receipt.run_revision);
            assert_eq!(historical_replay.last_sequence, receipt.last_sequence);
        }
        let store = crate::store::Store::open(&path, Vault::new(&key).unwrap()).unwrap();
        let scope = DataScope::workspace("w1").unwrap();
        let (journal, lifecycle) = store
            .with_conn(|tx| {
                Ok((
                    mission_run::get(tx, &store, &scope, "member-1", "run-1")?.unwrap(),
                    mission_plan::get(tx, &store, &scope, "member-1", "mission-1")?.unwrap(),
                ))
            })
            .unwrap();
        assert_eq!(journal.run["status"], "running");
        assert_eq!(journal.events.last().unwrap()["type"], "approval-resolved");
        assert_eq!(lifecycle.mission["status"], "running");
        let wait_key = journal.events.last().unwrap()["payload"]["resolution"]["waitKey"]
            .as_str()
            .unwrap();
        let consumption = store
            .with_conn(|tx| {
                mission_approval_consumption::get(tx, &store, &scope, "member-1", wait_key)
            })
            .unwrap()
            .unwrap();
        assert_eq!(consumption.run_id, "run-1");
        assert_eq!(consumption.effect_key, "publish:update-1");
        assert!(store
            .with_conn(|tx| {
                mission_approval_consumption::get(tx, &store, &scope, "member-2", wait_key)
            })
            .unwrap()
            .is_none());
    }
}

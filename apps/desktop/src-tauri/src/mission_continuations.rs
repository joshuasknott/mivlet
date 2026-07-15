//! Native-owned continuation dispatch for durable mission human-input waits.
//!
//! Continuation identity is read only from authenticated persisted plan, run,
//! request, and checkpoint facts. Renderer-supplied response fields never
//! select executable native behavior.

use serde_json::Value;

use crate::store::repos::{mission_checkpoint, mission_plan, mission_run, scope::DataScope};

enum NativeContinuation {
    StructuredIntakeV1,
    ArtifactRevisionBriefV1,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn settle_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    internal_user_id: &str,
    owner_member_id: &str,
    received_journal: &mission_run::MissionRunJournalRow,
    lifecycle_before_resume: &mission_plan::MissionPlanLifecycleRow,
    received_event_id: &str,
    at: &str,
) -> crate::store::Result<bool> {
    let received = received_journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(received_event_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Human-input continuation response is unavailable.".into(),
            )
        })?;
    match continuation_from_persisted_facts(
        tx,
        store,
        scope,
        owner_member_id,
        received_journal,
        lifecycle_before_resume,
        received,
    )? {
        None => Ok(false),
        Some(NativeContinuation::StructuredIntakeV1) => {
            crate::mission_structured_intake::settle_if_structured_in_tx(
                tx,
                store,
                scope,
                internal_user_id,
                owner_member_id,
                received_journal,
                lifecycle_before_resume,
                received_event_id,
                at,
            )
        }
        Some(NativeContinuation::ArtifactRevisionBriefV1) => {
            crate::mission_artifact_revision_brief::settle_if_artifact_revision_brief_in_tx(
                tx,
                store,
                scope,
                internal_user_id,
                owner_member_id,
                received_journal,
                lifecycle_before_resume,
                received_event_id,
                at,
            )
        }
    }
}

pub(crate) fn validate_terminal_replay_in_tx(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    internal_user_id: &str,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    received_event: &Value,
) -> crate::store::Result<()> {
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Human-input continuation mission is invalid.".into())
        })?;
    let lifecycle =
        mission_plan::get(tx, store, scope, owner_member_id, mission_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Human-input continuation plan is unavailable.".into(),
            )
        })?;
    match continuation_from_persisted_facts(
        tx,
        store,
        scope,
        owner_member_id,
        journal,
        &lifecycle,
        received_event,
    )? {
        None => Ok(()),
        Some(NativeContinuation::StructuredIntakeV1) => {
            crate::mission_structured_intake::validate_terminal_replay_in_tx(
                tx,
                store,
                scope,
                internal_user_id,
                owner_member_id,
                journal,
                received_event,
            )
        }
        Some(NativeContinuation::ArtifactRevisionBriefV1) => {
            crate::mission_artifact_revision_brief::validate_terminal_replay_in_tx(
                tx,
                store,
                scope,
                internal_user_id,
                owner_member_id,
                journal,
                received_event,
            )
        }
    }
}

fn continuation_from_persisted_facts(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    owner_member_id: &str,
    journal: &mission_run::MissionRunJournalRow,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    received: &Value,
) -> crate::store::Result<Option<NativeContinuation>> {
    let run_id = journal.run.get("id").and_then(Value::as_str);
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str);
    let plan_revision_id = journal.run.get("planRevisionId").and_then(Value::as_str);
    if run_id.is_none()
        || received.get("runId").and_then(Value::as_str) != run_id
        || lifecycle.mission.get("id").and_then(Value::as_str) != mission_id
        || lifecycle.current_revision.get("id").and_then(Value::as_str) != plan_revision_id
    {
        return invalid("Human-input continuation run and plan facts do not match.");
    }

    let request_id = received
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Human-input continuation request link is invalid.".into(),
            )
        })?;
    let request = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(request_id))
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Human-input continuation request is unavailable.".into(),
            )
        })?;
    let checkpoint_id = request
        .get("previousEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Human-input continuation checkpoint link is invalid.".into(),
            )
        })?;
    let checkpoint =
        mission_checkpoint::get_by_event(tx, store, scope, owner_member_id, checkpoint_id)?
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Human-input continuation checkpoint is unavailable.".into(),
                )
            })?;

    let checkpoint_continuation =
        optional_identity(checkpoint.state.pointer("/humanInputWait/continuationId"))?;
    if request.pointer("/payload/wait/continuationId").is_some() {
        return invalid("Human-input continuation request contains a non-portable selector.");
    }

    let plan_continuation = native_plan_continuation(&lifecycle.mission)?;
    if checkpoint_continuation != plan_continuation.as_deref() {
        return invalid("Human-input continuation plan and wait facts disagree.");
    }

    classify_identity(checkpoint_continuation)
}

fn classify_identity(identity: Option<&str>) -> crate::store::Result<Option<NativeContinuation>> {
    match identity {
        None => Ok(None),
        Some(id) if id == crate::mission_structured_intake::CONTINUATION_ID => {
            Ok(Some(NativeContinuation::StructuredIntakeV1))
        }
        Some(id) if id == crate::mission_artifact_revision_brief::CONTINUATION_ID => {
            Ok(Some(NativeContinuation::ArtifactRevisionBriefV1))
        }
        Some(_) => invalid("The persisted native human-input continuation is unsupported."),
    }
}

fn optional_identity(value: Option<&Value>) -> crate::store::Result<Option<&str>> {
    value
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Persisted human-input continuation identity is invalid.".into(),
                    )
                })
        })
        .transpose()
}

fn native_plan_continuation(mission: &Value) -> crate::store::Result<Option<String>> {
    let mut found = None;
    for constraint in mission
        .get("constraints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(key) = constraint.get("key").and_then(Value::as_str) else {
            continue;
        };
        if !key.starts_with("native:") {
            continue;
        }
        if found.is_some()
            || constraint.get("severity").and_then(Value::as_str) != Some("required")
            || constraint.get("source").and_then(Value::as_str) != Some("orchestrator")
        {
            return invalid("Native human-input continuation plan facts are invalid.");
        }
        found = Some(key.to_string());
    }
    Ok(found)
}

fn invalid<T>(message: &str) -> crate::store::Result<T> {
    Err(crate::store::StoreError::Invalid(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unknown_and_substituted_native_plan_identities_fail_closed() {
        assert!(classify_identity(Some("native:unknown:v9")).is_err());
        assert!(native_plan_continuation(&json!({"constraints":[
            {"key":"native:structured-intake:v1","severity":"required","source":"orchestrator"},
            {"key":"native:substituted:v1","severity":"required","source":"orchestrator"}
        ]}))
        .is_err());
        assert!(native_plan_continuation(&json!({"constraints":[{
            "key":"native:structured-intake:v1","severity":"advisory","source":"orchestrator"
        }]}))
        .is_err());
    }
}

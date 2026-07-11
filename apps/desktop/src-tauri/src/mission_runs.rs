//! Authenticated mission-run creation, read, and cooperative cancellation.

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::store::repos::{mission_plan, mission_run, scope::DataScope, workspace_directory};

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
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
            mission_run::create(
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
            )
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
}

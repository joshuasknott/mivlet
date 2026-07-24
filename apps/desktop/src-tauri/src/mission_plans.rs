//! Authenticated native boundary for bounded generated mission plans.

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

use crate::store::repos::{
    message, mission_plan, mission_run, scope::DataScope, workspace_directory,
};

const MAX_PLAN_BYTES: usize = 256_000;
const MAX_STEPS: usize = 32;
const MAX_DEPENDENCIES: usize = 8;
const MAX_REVISIONS: i64 = 12;
const MAX_CITED_PLAN_MESSAGES: usize = 32;

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionPlanCreateInput {
    pub(crate) mission_id: String,
    pub(crate) plan_id: String,
    pub(crate) plan_revision_id: String,
    pub(crate) execution_depth: String,
    pub(crate) outcome: Value,
    pub(crate) mission_scope: Value,
    #[serde(default)]
    pub(crate) constraints: Value,
    pub(crate) time_constraint: Option<Value>,
    pub(crate) data_boundary: Option<Value>,
    pub(crate) acceptance: Value,
    pub(crate) budget: Option<Value>,
    pub(crate) summary: String,
    pub(crate) bounds: Value,
    pub(crate) steps: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionPlanReviseInput {
    mission_id: String,
    plan_id: String,
    current_plan_revision_id: String,
    new_plan_revision_id: String,
    expected_mission_revision: i64,
    expected_plan_revision: i64,
    reason: String,
    summary: String,
    bounds: Value,
    steps: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CitedMissionPlanSummaryReadInput {
    thread_id: String,
    message_ids: Vec<String>,
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
            "An active Fable workspace membership is required for private missions.".into(),
        )
    })?;
    let scope = DataScope::workspace(context.active_workspace.local_workspace_id.clone())?;
    Ok((scope, context, member))
}

#[tauri::command]
pub fn mission_plan_create(
    input: MissionPlanCreateInput,
) -> Result<mission_plan::MissionPlanLifecycleRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, context, member) = authorized(tx)?;
            let at = now();
            let workspace_id = context
                .active_workspace
                .fable_workspace_id
                .as_deref()
                .unwrap_or(scope.workspace_id());
            let records = build_initial_records(
                &input,
                workspace_id,
                &member,
                &context.internal_user_id,
                &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            mission_plan::create(
                tx,
                store,
                &scope,
                &member,
                &context.internal_user_id,
                &input.mission_id,
                &input.plan_id,
                &input.plan_revision_id,
                &input.execution_depth,
                &records.mission,
                &records.plan,
                &records.revision,
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_plan_get(
    mission_id: String,
) -> Result<Option<mission_plan::MissionPlanLifecycleRow>, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, member) = authorized(tx)?;
            mission_plan::get(tx, store, &scope, &member, &mission_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_plan_cited_summary_get(mission_id: String) -> Result<Value, String> {
    if mission_id.trim().is_empty() || mission_id.len() > 160 {
        return Err("Cited mission plan request is invalid.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, member) = authorized(tx)?;
            let lifecycle = mission_plan::get(tx, store, &scope, &member, &mission_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Cited mission plan is unavailable in this workspace.".into(),
                    )
                })?;
            project_cited_plan_summary(&lifecycle, None).map_err(crate::store::StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_plan_cited_summaries_read(
    input: CitedMissionPlanSummaryReadInput,
) -> Result<Vec<Value>, String> {
    if input.thread_id.trim().is_empty()
        || input.thread_id.len() > 160
        || input.message_ids.is_empty()
        || input.message_ids.len() > MAX_CITED_PLAN_MESSAGES
        || input
            .message_ids
            .iter()
            .any(|id| id.trim().is_empty() || id.len() > 160)
        || input.message_ids.iter().collect::<BTreeSet<_>>().len() != input.message_ids.len()
    {
        return Err("Cited mission plan summary request is invalid.".into());
    }
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let (scope, _, member) = authorized(tx)?;
            let messages = message::list(tx, store, &scope, &input.thread_id)?;
            Ok(input
                .message_ids
                .iter()
                .map(|message_id| {
                    let summary = messages
                        .iter()
                        .find(|candidate| candidate.id == *message_id)
                        .ok_or_else(|| {
                            crate::store::StoreError::Invalid(
                                "Cited mission plan message is unavailable.".into(),
                            )
                        })
                        .and_then(|message| {
                            project_cited_plan_summary_for_message(
                                tx, store, &scope, &member, message,
                            )
                        });
                    match summary {
                        Ok(plan) => {
                            json!({"messageId":message_id,"status":"available","plan":plan})
                        }
                        Err(_) => json!({"messageId":message_id,"status":"unavailable"}),
                    }
                })
                .collect())
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_plan_revise(
    input: MissionPlanReviseInput,
) -> Result<mission_plan::MissionPlanLifecycleRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let (scope, _, member) = authorized(tx)?;
            let current = mission_plan::get(tx, store, &scope, &member, &input.mission_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission is unavailable in this workspace.".into(),
                    )
                })?;
            let at = now();
            let records = build_revised_records(&input, &current, &at)
                .map_err(crate::store::StoreError::Invalid)?;
            mission_plan::revise(
                tx,
                store,
                &scope,
                &member,
                &input.mission_id,
                &input.plan_id,
                input.expected_mission_revision,
                input.expected_plan_revision,
                &input.current_plan_revision_id,
                &input.new_plan_revision_id,
                &input.reason,
                &records.mission,
                &records.plan,
                &records.revision,
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

fn project_cited_plan_summary_for_message(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    scope: &DataScope,
    member: &str,
    message: &message::MessageRow,
) -> crate::store::Result<Value> {
    let detail = message.detail.as_object().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission plan message detail is invalid.".into())
    })?;
    let run_id = message.run_id.as_deref().ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission plan run is missing.".into())
    })?;
    let mission_id = detail
        .get("missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Cited mission plan identity is invalid.".into())
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
    let expected_keys = if outcome == "accepted" {
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
        || !matches!(outcome, "accepted" | "partial" | "failed" | "cancelled")
        || detail.len() != expected_keys.len()
        || detail
            .keys()
            .any(|key| !expected_keys.contains(&key.as_str()))
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission plan message linkage is invalid.".into(),
        ));
    }
    let journal = mission_run::get(tx, store, scope, member, run_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission plan journal is unavailable.".into())
    })?;
    let lifecycle = mission_plan::get(tx, store, scope, member, mission_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid("Cited mission plan is unavailable.".into())
    })?;
    let result_event = journal
        .events
        .iter()
        .find(|event| event.get("id").and_then(Value::as_str) == Some(result_event_id));
    let terminal_matches = match outcome {
        "accepted" => {
            journal.run.get("status").and_then(Value::as_str) == Some("completed")
                && result_event
                    .and_then(|event| event.get("type"))
                    .and_then(Value::as_str)
                    == Some("run-completed")
        }
        "partial" => {
            journal.run.get("status").and_then(Value::as_str) == Some("partially-completed")
                && result_event
                    .and_then(|event| event.get("type"))
                    .and_then(Value::as_str)
                    == Some("run-failed")
                && result_event
                    .and_then(|event| event.pointer("/payload/error/code"))
                    .and_then(Value::as_str)
                    .is_some_and(|code| {
                        matches!(code, "policy-acceptance-failed" | "human-acceptance-denied")
                    })
        }
        "failed" => {
            journal.run.get("status").and_then(Value::as_str) == Some("failed")
                && result_event
                    .and_then(|event| event.get("type"))
                    .and_then(Value::as_str)
                    == Some("run-failed")
        }
        "cancelled" => {
            journal.run.get("status").and_then(Value::as_str) == Some("cancelled")
                && result_event
                    .and_then(|event| event.get("type"))
                    .and_then(Value::as_str)
                    == Some("run-cancelled")
        }
        _ => false,
    };
    if !terminal_matches
        || journal
            .run
            .pointer("/initiator/missionId")
            .and_then(Value::as_str)
            != Some(mission_id)
        || journal.run.get("sourceThreadId").and_then(Value::as_str)
            != Some(message.thread_id.as_str())
        || journal
            .run
            .pointer("/eventHead/lastEventId")
            .and_then(Value::as_str)
            != Some(result_event_id)
        || lifecycle
            .mission
            .pointer("/scope/sourceThreadId")
            .and_then(Value::as_str)
            != Some(message.thread_id.as_str())
    {
        return Err(crate::store::StoreError::Invalid(
            "Cited mission plan scope is invalid.".into(),
        ));
    }
    project_cited_plan_summary(&lifecycle, Some(&message.thread_id))
        .map_err(crate::store::StoreError::Invalid)
}

pub(crate) fn project_cited_plan_summary(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    expected_thread_id: Option<&str>,
) -> Result<Value, String> {
    let mission = lifecycle
        .mission
        .as_object()
        .ok_or_else(|| "Cited mission record is invalid.".to_string())?;
    let revision = lifecycle
        .current_revision
        .as_object()
        .ok_or_else(|| "Cited mission plan revision is invalid.".to_string())?;
    let steps = revision
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| steps.len() == 1)
        .ok_or_else(|| "Cited mission plan must contain one step.".to_string())?;
    let step = steps[0]
        .as_object()
        .ok_or_else(|| "Cited mission plan step is invalid.".to_string())?;
    let outputs = step
        .get("expectedOutputs")
        .and_then(Value::as_array)
        .filter(|outputs| outputs.len() == 1)
        .ok_or_else(|| "Cited mission plan output is invalid.".to_string())?;
    let output = outputs[0]
        .as_object()
        .ok_or_else(|| "Cited mission plan output is invalid.".to_string())?;
    let criteria = mission
        .get("acceptance")
        .and_then(|value| value.get("criteria"))
        .and_then(Value::as_array)
        .filter(|criteria| !criteria.is_empty() && criteria.len() <= 8)
        .ok_or_else(|| "Cited mission acceptance is invalid.".to_string())?;
    let budget = mission
        .get("budget")
        .and_then(Value::as_object)
        .ok_or_else(|| "Cited mission budget is invalid.".to_string())?;
    let required_text =
        |value: Option<&Value>, label: &str, max: usize| -> Result<String, String> {
            value
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= max)
                .map(str::to_string)
                .ok_or_else(|| format!("Cited mission {label} is invalid."))
        };
    let positive = |key: &str| -> Result<i64, String> {
        budget
            .get(key)
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .ok_or_else(|| format!("Cited mission {key} is invalid."))
    };
    let source_thread_id = mission
        .get("scope")
        .and_then(|value| value.get("sourceThreadId"))
        .and_then(Value::as_str);
    let capabilities = step.get("requiredCapabilities").and_then(Value::as_array);
    let step_criteria = step
        .get("acceptanceCriterionKeys")
        .and_then(Value::as_array);
    let exact = mission.get("executionDepth").and_then(Value::as_str) == Some("delegated")
        && lifecycle.plan.get("status").and_then(Value::as_str) == Some("current")
        && mission.get("currentPlanRevisionId") == revision.get("id")
        && lifecycle.plan.get("currentRevisionId") == revision.get("id")
        && expected_thread_id.is_none_or(|expected| source_thread_id == Some(expected))
        && step.get("kind").and_then(Value::as_str) == Some("investigate")
        && capabilities.is_some_and(|values| {
            values.len() == 1 && values[0].as_str() == Some("knowledge.content.search")
        })
        && output.get("required").and_then(Value::as_bool) == Some(true)
        && output.get("format").and_then(Value::as_str) == Some("text/markdown")
        && criteria.iter().all(|criterion| {
            criterion.get("required").and_then(Value::as_bool) == Some(true)
                && criterion.get("evaluator").and_then(Value::as_str) == Some("policy")
        })
        && mission
            .get("acceptance")
            .and_then(|value| value.get("requiresHumanAcceptance"))
            .and_then(Value::as_bool)
            .is_some()
        && step_criteria.is_some_and(|keys| {
            keys.len() == criteria.len()
                && criteria
                    .iter()
                    .all(|criterion| criterion.get("key").is_some_and(|key| keys.contains(key)))
        })
        && budget.get("maxWorkers").and_then(Value::as_i64) == Some(1)
        && budget.get("maxToolCalls").and_then(Value::as_i64) == Some(1)
        && budget.get("maxAttempts").and_then(Value::as_i64) == Some(2);
    if !exact {
        return Err("Mission is not the exact inspectable cited-plan shape.".into());
    }
    let acceptance = criteria
        .iter()
        .map(|criterion| {
            required_text(
                criterion.get("description"),
                "acceptance description",
                1_000,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "title":required_text(mission.get("outcome").and_then(|value| value.get("title")), "outcome title", 200)?,
        "summary":required_text(revision.get("summary"), "summary", 2_000)?,
        "executionLabel":"One focused research step",
        "step":{
            "title":required_text(step.get("title"), "step title", 200)?,
            "objective":required_text(step.get("objective"), "step objective", 4_000)?,
            "capability":"Search connected work sources",
            "output":required_text(output.get("description"), "output description", 1_000)?
        },
        "acceptance":acceptance,
        "requiresHumanAcceptance":mission.get("acceptance").and_then(|value|value.get("requiresHumanAcceptance")).and_then(Value::as_bool).unwrap_or(false),
        "budget":{
            "maxInputTokens":positive("maxInputTokens")?,
            "maxOutputTokens":positive("maxOutputTokens")?,
            "maxToolCalls":positive("maxToolCalls")?,
            "maxDurationMs":positive("maxDurationMs")?,
            "maxAttempts":positive("maxAttempts")?
        }
    }))
}

#[derive(Debug)]
pub(crate) struct Records {
    pub(crate) mission: Value,
    pub(crate) plan: Value,
    pub(crate) revision: Value,
}

pub(crate) fn build_initial_records(
    input: &MissionPlanCreateInput,
    workspace_id: &str,
    member: &str,
    actor: &str,
    at: &str,
) -> Result<Records, String> {
    validate_mission_shape(
        &input.mission_scope,
        &input.constraints,
        input.time_constraint.as_ref(),
        input.data_boundary.as_ref(),
    )?;
    validate_generated_plan(
        &input.execution_depth,
        input.budget.as_ref(),
        &input.outcome,
        &input.acceptance,
        &input.summary,
        &input.bounds,
        &input.steps,
    )?;
    let metadata = json!({
        "workspaceId": workspace_id, "visibility": "member-private", "ownerMemberId": member,
        "authority": "local", "schemaVersion": 1, "revision": 1,
        "createdByInternalUserId": actor, "createdAt": at, "updatedAt": at
    });
    let mut mission = object(metadata.clone())?;
    mission.extend(object(json!({
        "id": input.mission_id, "status": "ready", "executionDepth": input.execution_depth,
        "outcome": input.outcome, "scope": input.mission_scope, "constraints": input.constraints,
        "acceptance": input.acceptance, "currentPlanId": input.plan_id,
        "currentPlanRevisionId": input.plan_revision_id
    }))?);
    if let Some(value) = &input.time_constraint {
        mission.insert("timeConstraint".into(), value.clone());
    }
    if let Some(value) = &input.data_boundary {
        mission.insert("dataBoundary".into(), value.clone());
    }
    if let Some(value) = &input.budget {
        mission.insert("budget".into(), value.clone());
    }
    let mut plan = object(metadata.clone())?;
    plan.extend(object(json!({
        "id": input.plan_id, "missionId": input.mission_id, "status": "current",
        "currentRevisionId": input.plan_revision_id, "currentRevisionNumber": 1
    }))?);
    let mut revision = object(metadata)?;
    revision.extend(object(json!({
        "id": input.plan_revision_id, "planId": input.plan_id, "missionId": input.mission_id,
        "planRevisionNumber": 1, "reason": "initial", "summary": input.summary.trim(),
        "bounds": input.bounds, "steps": input.steps
    }))?);
    Ok(Records {
        mission: Value::Object(mission),
        plan: Value::Object(plan),
        revision: Value::Object(revision),
    })
}

fn build_revised_records(
    input: &MissionPlanReviseInput,
    current: &mission_plan::MissionPlanLifecycleRow,
    at: &str,
) -> Result<Records, String> {
    if current.mission.get("revision").and_then(Value::as_i64)
        != Some(input.expected_mission_revision)
        || current.plan.get("revision").and_then(Value::as_i64)
            != Some(input.expected_plan_revision)
        || current.plan.get("id").and_then(Value::as_str) != Some(input.plan_id.as_str())
        || current.current_revision.get("id").and_then(Value::as_str)
            != Some(input.current_plan_revision_id.as_str())
        || current.mission.get("id").and_then(Value::as_str) != Some(input.mission_id.as_str())
        || current.mission.get("currentPlanId").and_then(Value::as_str)
            != Some(input.plan_id.as_str())
        || current
            .mission
            .get("currentPlanRevisionId")
            .and_then(Value::as_str)
            != Some(input.current_plan_revision_id.as_str())
        || current.plan.get("status").and_then(Value::as_str) != Some("current")
        || current.plan.get("missionId").and_then(Value::as_str) != Some(input.mission_id.as_str())
        || current
            .current_revision
            .get("planId")
            .and_then(Value::as_str)
            != Some(input.plan_id.as_str())
        || current
            .current_revision
            .get("missionId")
            .and_then(Value::as_str)
            != Some(input.mission_id.as_str())
        || current
            .current_revision
            .get("planRevisionNumber")
            .and_then(Value::as_i64)
            != current
                .plan
                .get("currentRevisionNumber")
                .and_then(Value::as_i64)
        || matches!(
            current.mission.get("status").and_then(Value::as_str),
            Some("completed" | "partially-completed" | "failed" | "cancelled" | "archived")
        )
    {
        return Err("The mission plan changed before this revision could be prepared.".into());
    }
    let next_number = current
        .current_revision
        .get("planRevisionNumber")
        .and_then(Value::as_i64)
        .ok_or_else(|| "The current plan revision is invalid.".to_string())?
        + 1;
    let old_limit = current
        .current_revision
        .pointer("/bounds/maxRevisions")
        .and_then(Value::as_i64)
        .unwrap_or(MAX_REVISIONS);
    let proposed_limit = input
        .bounds
        .get("maxRevisions")
        .and_then(Value::as_i64)
        .unwrap_or(old_limit);
    if proposed_limit > old_limit {
        return Err("A plan revision cannot raise the selected revision limit.".into());
    }
    if next_number > proposed_limit {
        return Err("The generated plan revision limit has been reached.".into());
    }
    let depth = current
        .mission
        .get("executionDepth")
        .and_then(Value::as_str)
        .ok_or_else(|| "The mission execution depth is invalid.".to_string())?;
    validate_generated_plan(
        depth,
        current.mission.get("budget"),
        current
            .mission
            .get("outcome")
            .ok_or_else(|| "Mission outcome is missing.".to_string())?,
        current
            .mission
            .get("acceptance")
            .ok_or_else(|| "Mission acceptance is missing.".to_string())?,
        &input.summary,
        &input.bounds,
        &input.steps,
    )?;
    let mut mission = object(current.mission.clone())?;
    mission.insert(
        "revision".into(),
        json!(input.expected_mission_revision + 1),
    );
    mission.insert("updatedAt".into(), json!(at));
    mission.insert(
        "currentPlanRevisionId".into(),
        json!(input.new_plan_revision_id),
    );
    let mut plan = object(current.plan.clone())?;
    plan.insert("revision".into(), json!(input.expected_plan_revision + 1));
    plan.insert("updatedAt".into(), json!(at));
    plan.insert(
        "currentRevisionId".into(),
        json!(input.new_plan_revision_id),
    );
    plan.insert("currentRevisionNumber".into(), json!(next_number));
    let mut revision = object(current.current_revision.clone())?;
    revision.insert("id".into(), json!(input.new_plan_revision_id));
    revision.insert("revision".into(), json!(1));
    revision.insert("createdAt".into(), json!(at));
    revision.insert("updatedAt".into(), json!(at));
    revision.insert("planRevisionNumber".into(), json!(next_number));
    revision.insert(
        "supersedesRevisionId".into(),
        json!(input.current_plan_revision_id),
    );
    revision.insert("reason".into(), json!(input.reason));
    revision.insert("summary".into(), json!(input.summary.trim()));
    revision.insert("bounds".into(), input.bounds.clone());
    revision.insert("steps".into(), input.steps.clone());
    Ok(Records {
        mission: Value::Object(mission),
        plan: Value::Object(plan),
        revision: Value::Object(revision),
    })
}

fn validate_generated_plan(
    depth: &str,
    budget: Option<&Value>,
    outcome: &Value,
    acceptance: &Value,
    summary: &str,
    bounds: &Value,
    steps: &Value,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(&(outcome, acceptance, bounds, steps))
        .map_err(|_| "Generated plan could not be encoded.".to_string())?;
    if encoded.len() > MAX_PLAN_BYTES {
        return Err("Generated plan exceeds its storage limit.".into());
    }
    if summary.trim().is_empty() || summary.chars().count() > 4_000 {
        return Err("Generated plan summary is invalid.".into());
    }
    text(outcome, "title", 400)?;
    text(outcome, "desiredOutcome", 8_000)?;
    let deliverables = outcome
        .get("deliverables")
        .and_then(Value::as_array)
        .ok_or_else(|| "Mission deliverables must be an array.".to_string())?;
    if deliverables.is_empty() || deliverables.len() > 64 {
        return Err("Mission deliverable count is invalid.".into());
    }
    for deliverable in deliverables {
        text(deliverable, "key", 160)?;
        text(deliverable, "description", 2_000)?;
        if deliverable
            .get("required")
            .and_then(Value::as_bool)
            .is_none()
        {
            return Err("Mission deliverable requirement is invalid.".into());
        }
    }
    let acceptance_criteria = acceptance
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| "Mission acceptance criteria must be an array.".to_string())?;
    if acceptance_criteria.len() > 64
        || acceptance
            .get("requiresHumanAcceptance")
            .and_then(Value::as_bool)
            .is_none()
    {
        return Err("Mission acceptance is invalid.".into());
    }
    for criterion in acceptance_criteria {
        text(criterion, "key", 160)?;
        text(criterion, "description", 2_000)?;
        if criterion.get("required").and_then(Value::as_bool).is_none()
            || !matches!(
                criterion.get("evaluator").and_then(Value::as_str),
                Some("human" | "worker" | "policy" | "external")
            )
            || criterion
                .get("evidenceFromStepOutputs")
                .is_some_and(|value| !value.is_boolean())
        {
            return Err("Mission acceptance criterion is invalid.".into());
        }
    }
    let max_steps = integer(bounds, "maxSteps")?;
    let max_dependencies = integer(bounds, "maxDependenciesPerStep")?;
    let max_parallel = integer(bounds, "maxParallelSteps")?;
    if !(1..=MAX_STEPS as i64).contains(&max_steps)
        || !(0..=MAX_DEPENDENCIES as i64).contains(&max_dependencies)
        || !(1..=max_steps).contains(&max_parallel)
    {
        return Err("Generated plan bounds are invalid.".into());
    }
    if let Some(limit) = bounds.get("maxRevisions") {
        let limit = limit
            .as_i64()
            .ok_or_else(|| "Generated plan revision limit is invalid.".to_string())?;
        if !(1..=MAX_REVISIONS).contains(&limit) {
            return Err("Generated plan revision limit is invalid.".into());
        }
    }
    let steps = steps
        .as_array()
        .ok_or_else(|| "Generated plan steps must be an array.".to_string())?;
    if steps.is_empty() || steps.len() > max_steps as usize {
        return Err("Generated plan step count is invalid.".into());
    }
    let required_deliverables = required_keys(outcome.get("deliverables"), "deliverable")?;
    let required_criteria = required_keys(acceptance.get("criteria"), "acceptance criterion")?;
    let deliverable_keys = all_keys(outcome.get("deliverables"), "deliverable")?;
    let criterion_keys = all_keys(acceptance.get("criteria"), "acceptance criterion")?;
    let mut dependencies = BTreeMap::<String, Vec<String>>::new();
    let mut outputs = BTreeSet::new();
    let mut criteria = BTreeSet::new();
    for step in steps {
        let key = text(step, "key", 160)?;
        if dependencies.contains_key(&key) {
            return Err("Generated plan step keys must be unique.".into());
        }
        text(step, "title", 400)?;
        text(step, "objective", 8_000)?;
        if !matches!(
            step.get("kind").and_then(Value::as_str),
            Some("investigate" | "produce" | "act" | "review" | "coordinate")
        ) || step.get("optional").and_then(Value::as_bool).is_none()
        {
            return Err("Generated plan step shape is invalid.".into());
        }
        let deps = strings(
            step.get("dependsOnStepKeys"),
            "step dependencies",
            max_dependencies as usize,
        )?;
        let capabilities = strings(
            step.get("requiredCapabilities"),
            "required capabilities",
            64,
        )?;
        if capabilities.iter().collect::<BTreeSet<_>>().len() != capabilities.len() {
            return Err("Generated plan capabilities must be unique per step.".into());
        }
        for value in strings(
            step.get("acceptanceCriterionKeys"),
            "acceptance criteria",
            64,
        )? {
            if !criterion_keys.contains(&value) {
                return Err("Generated plan references an unknown acceptance criterion.".into());
            }
            criteria.insert(value);
        }
        for output in step
            .get("expectedOutputs")
            .and_then(Value::as_array)
            .ok_or_else(|| "Step outputs must be an array.".to_string())?
        {
            let output_key = text(output, "key", 160)?;
            if !deliverable_keys.contains(&output_key) {
                return Err("Generated plan references an unknown deliverable.".into());
            }
            outputs.insert(output_key);
            text(output, "description", 2_000)?;
            if output.get("required").and_then(Value::as_bool).is_none() {
                return Err("Generated plan output requirement is invalid.".into());
            }
        }
        dependencies.insert(key, deps);
    }
    for (key, deps) in &dependencies {
        for dependency in deps {
            if dependency == key || !dependencies.contains_key(dependency) {
                return Err("Generated plan dependencies are invalid.".into());
            }
        }
    }
    let mut depths = BTreeMap::new();
    for key in dependencies.keys() {
        visit_depth(key, &dependencies, &mut BTreeSet::new(), &mut depths)?;
    }
    let mut widths = BTreeMap::<usize, usize>::new();
    for value in depths.values() {
        *widths.entry(*value).or_default() += 1;
    }
    let parallel_width = widths.values().copied().max().unwrap_or(1);
    if parallel_width > max_parallel as usize {
        return Err("Generated plan exceeds its parallel-step bound.".into());
    }
    if !required_deliverables.is_subset(&outputs) || !required_criteria.is_subset(&criteria) {
        return Err(
            "Generated plan does not cover every required outcome and acceptance criterion.".into(),
        );
    }
    let worker_budget = match budget.and_then(|value| value.get("maxWorkers")) {
        Some(value) => value
            .as_i64()
            .ok_or_else(|| "Mission worker budget is invalid.".to_string())?,
        None => 1,
    };
    if worker_budget < 1 {
        return Err("Mission worker budget is invalid.".into());
    }
    let worker_limit = worker_budget.min(max_parallel).min(parallel_width as i64);
    let sized_depth = if worker_limit > 1 && (parallel_width > 1 || steps.len() >= 4) {
        "multi-worker"
    } else {
        "delegated"
    };
    if depth != sized_depth {
        return Err("Mission execution depth does not match generated plan sizing.".into());
    }
    Ok(())
}

fn validate_mission_shape(
    scope: &Value,
    constraints: &Value,
    time_constraint: Option<&Value>,
    data_boundary: Option<&Value>,
) -> Result<(), String> {
    let scope = scope
        .as_object()
        .ok_or_else(|| "Mission scope is invalid.".to_string())?;
    if !scope.get("departmentIds").is_some_and(Value::is_array)
        || !scope.get("context").is_some_and(Value::is_array)
    {
        return Err("Mission scope is invalid.".into());
    }
    let constraints = constraints
        .as_array()
        .ok_or_else(|| "Mission constraints must be an array.".to_string())?;
    if constraints.len() > 64 {
        return Err("Mission constraint count is invalid.".into());
    }
    for constraint in constraints {
        text(constraint, "key", 160)?;
        text(constraint, "description", 2_000)?;
        if !matches!(
            constraint.get("severity").and_then(Value::as_str),
            Some("required" | "preferred")
        ) || !matches!(
            constraint.get("source").and_then(Value::as_str),
            Some(
                "user"
                    | "workspace-policy"
                    | "project"
                    | "department"
                    | "pipeline"
                    | "orchestrator"
            )
        ) {
            return Err("Mission constraint is invalid.".into());
        }
    }
    if time_constraint.is_some_and(|value| !value.is_object())
        || data_boundary.is_some_and(|value| !value.is_object())
    {
        return Err("Mission boundary constraints are invalid.".into());
    }
    Ok(())
}

fn required_keys(value: Option<&Value>, label: &str) -> Result<BTreeSet<String>, String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Mission {label}s must be an array."))?;
    values
        .iter()
        .filter(|item| item.get("required").and_then(Value::as_bool) == Some(true))
        .map(|item| text(item, "key", 160))
        .collect()
}
fn all_keys(value: Option<&Value>, label: &str) -> Result<BTreeSet<String>, String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Mission {label}s must be an array."))?;
    let keys = values
        .iter()
        .map(|item| text(item, "key", 160))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if keys.len() != values.len() {
        return Err(format!("Mission {label} keys must be unique."));
    }
    Ok(keys)
}
fn integer(value: &Value, key: &str) -> Result<i64, String> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("Plan {key} is invalid."))
}
fn text(value: &Value, key: &str, max: usize) -> Result<String, String> {
    let value = value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("Generated plan {key} is invalid."));
    }
    Ok(value.to_string())
}
fn strings(value: Option<&Value>, label: &str, max: usize) -> Result<Vec<String>, String> {
    let values = value
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Generated plan {label} must be an array."))?;
    if values.len() > max {
        return Err(format!("Generated plan {label} exceed their bound."));
    }
    values
        .iter()
        .map(|value| {
            let value = value.as_str().map(str::trim).unwrap_or("");
            if value.is_empty()
                || value.chars().count() > 160
                || value.chars().any(char::is_control)
            {
                Err(format!("Generated plan {label} are invalid."))
            } else {
                Ok(value.to_string())
            }
        })
        .collect()
}
fn visit_depth(
    key: &str,
    graph: &BTreeMap<String, Vec<String>>,
    visiting: &mut BTreeSet<String>,
    depths: &mut BTreeMap<String, usize>,
) -> Result<usize, String> {
    if let Some(value) = depths.get(key) {
        return Ok(*value);
    }
    if !visiting.insert(key.to_string()) {
        return Err("Generated plan dependencies must be acyclic.".into());
    }
    let mut depth = 1;
    for dependency in graph.get(key).into_iter().flatten() {
        depth = depth.max(visit_depth(dependency, graph, visiting, depths)? + 1);
    }
    visiting.remove(key);
    depths.insert(key.to_string(), depth);
    Ok(depth)
}
fn object(value: Value) -> Result<Map<String, Value>, String> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "Mission record is invalid.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> MissionPlanCreateInput {
        serde_json::from_value(json!({
            "missionId":"mission-1","planId":"plan-1","planRevisionId":"revision-1","executionDepth":"multi-worker",
            "outcome":{"title":"Brief","desiredOutcome":"Produce brief","deliverables":[{"key":"brief","description":"Brief","required":true}]},
            "missionScope":{"departmentIds":[],"context":[]},"constraints":[],
            "acceptance":{"requiresHumanAcceptance":false,"criteria":[{"key":"cited","description":"Cited","required":true,"evaluator":"policy"}]},
            "budget":{"maxWorkers":2},"summary":"Search then write","bounds":{"maxSteps":3,"maxDependenciesPerStep":2,"maxParallelSteps":2,"maxRevisions":3},
            "steps":[
              {"key":"a","kind":"investigate","title":"A","objective":"Search A","dependsOnStepKeys":[],"requiredCapabilities":[],"expectedOutputs":[],"acceptanceCriterionKeys":[],"optional":false},
              {"key":"b","kind":"investigate","title":"B","objective":"Search B","dependsOnStepKeys":[],"requiredCapabilities":[],"expectedOutputs":[],"acceptanceCriterionKeys":[],"optional":false},
              {"key":"write","kind":"produce","title":"Write","objective":"Write brief","dependsOnStepKeys":["a","b"],"requiredCapabilities":[],"expectedOutputs":[{"key":"brief","description":"Brief","required":true}],"acceptanceCriterionKeys":["cited"],"optional":false}
            ]
        })).unwrap()
    }

    fn cited_input() -> MissionPlanCreateInput {
        serde_json::from_value(json!({
            "missionId":"mission-secret","planId":"plan-secret","planRevisionId":"revision-secret","executionDepth":"delegated",
            "outcome":{"title":"Connected work brief","desiredOutcome":"Produce a cited brief","deliverables":[{"key":"brief","description":"A trustworthy Markdown brief.","required":true}]},
            "missionScope":{"workspaceId":"hosted-secret","sourceThreadId":"thread-1","departmentIds":[],"context":[]},
            "constraints":[],
            "acceptance":{"requiresHumanAcceptance":false,"minimumRequiredCriteria":1,"criteria":[{"key":"cited","description":"Use only attested citations.","required":true,"evaluator":"policy"}]},
            "budget":{"maxDurationMs":120000,"maxInputTokens":32000,"maxOutputTokens":2048,"maxToolCalls":1,"maxWorkers":1,"maxAttempts":2},
            "summary":"What changed?","bounds":{"maxSteps":1,"maxDependenciesPerStep":0,"maxParallelSteps":1,"maxRevisions":1},
            "steps":[{"key":"research","kind":"investigate","title":"Research and write","objective":"Search connected work sources, then write a cited brief.","dependsOnStepKeys":[],"requiredCapabilities":["knowledge.content.search"],"expectedOutputs":[{"key":"brief","description":"A trustworthy Markdown brief.","required":true,"format":"text/markdown"}],"acceptanceCriterionKeys":["cited"],"optional":false,"estimatedBudget":{"maxAttempts":1}}]
        })).unwrap()
    }

    #[test]
    fn native_boundary_derives_authority_and_validates_sizing() {
        let input = input();
        let records =
            build_initial_records(&input, "workspace-real", "member-real", "user-real", "now")
                .unwrap();
        assert_eq!(records.mission["workspaceId"], "workspace-real");
        assert_eq!(records.mission["ownerMemberId"], "member-real");
        assert_eq!(records.mission["createdByInternalUserId"], "user-real");
        assert_eq!(records.mission["status"], "ready");
    }

    #[test]
    fn cited_plan_projection_is_bounded_readable_and_secret_safe() {
        let input = cited_input();
        let records = build_initial_records(
            &input,
            "workspace-secret",
            "member-secret",
            "user-secret",
            "now",
        )
        .unwrap();
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: records.mission,
            plan: records.plan,
            current_revision: records.revision,
        };
        let summary = project_cited_plan_summary(&lifecycle, Some("thread-1")).unwrap();
        assert_eq!(summary["executionLabel"], "One focused research step");
        assert_eq!(
            summary["step"]["capability"],
            "Search connected work sources"
        );
        assert_eq!(summary["budget"]["maxAttempts"], 2);
        let serialized = serde_json::to_string(&summary).unwrap();
        for secret in [
            "mission-secret",
            "plan-secret",
            "revision-secret",
            "workspace-secret",
            "member-secret",
            "user-secret",
            "hosted-secret",
            "knowledge.content.search",
        ] {
            assert!(!serialized.contains(secret));
        }
        let mut changed = lifecycle;
        changed.mission["budget"]["maxAttempts"] = json!(3);
        assert!(project_cited_plan_summary(&changed, Some("thread-1")).is_err());
        assert!(project_cited_plan_summary(&changed, Some("thread-other")).is_err());
    }

    #[test]
    fn native_boundary_rejects_cycles_and_missing_required_coverage() {
        let mut cyclic = input();
        cyclic.steps[0]["dependsOnStepKeys"] = json!(["write"]);
        assert!(build_initial_records(&cyclic, "w", "m", "u", "now")
            .unwrap_err()
            .contains("acyclic"));
        let mut uncovered = input();
        uncovered.steps[2]["expectedOutputs"] = json!([]);
        assert!(build_initial_records(&uncovered, "w", "m", "u", "now")
            .unwrap_err()
            .contains("cover"));
        let mut unknown_output = input();
        unknown_output.steps[2]["expectedOutputs"][0]["key"] = json!("unknown");
        assert!(build_initial_records(&unknown_output, "w", "m", "u", "now")
            .unwrap_err()
            .contains("unknown deliverable"));
        let mut unknown_criterion = input();
        unknown_criterion.steps[2]["acceptanceCriterionKeys"] = json!(["unknown"]);
        assert!(
            build_initial_records(&unknown_criterion, "w", "m", "u", "now")
                .unwrap_err()
                .contains("unknown acceptance")
        );
        let mut invalid_evidence_binding = input();
        invalid_evidence_binding.acceptance["criteria"][0]["evidenceFromStepOutputs"] =
            json!("renderer-selected");
        assert!(
            build_initial_records(&invalid_evidence_binding, "w", "m", "u", "now")
                .unwrap_err()
                .contains("criterion is invalid")
        );
        let mut duplicate_capability = input();
        duplicate_capability.steps[0]["requiredCapabilities"] =
            json!(["source.file.search", "source.file.search"]);
        assert!(
            build_initial_records(&duplicate_capability, "w", "m", "u", "now")
                .unwrap_err()
                .contains("capabilities must be unique")
        );
    }

    #[test]
    fn native_boundary_cannot_raise_or_undershoot_selected_revision_cap() {
        let initial_input = input();
        let initial = build_initial_records(&initial_input, "w", "m", "u", "t1").unwrap();
        let current = mission_plan::MissionPlanLifecycleRow {
            mission: initial.mission,
            plan: initial.plan,
            current_revision: initial.revision,
        };
        let revise = |max_revisions| -> MissionPlanReviseInput {
            serde_json::from_value(json!({
                "missionId":"mission-1","planId":"plan-1","currentPlanRevisionId":"revision-1",
                "newPlanRevisionId":"revision-2","expectedMissionRevision":1,"expectedPlanRevision":1,
                "reason":"manual-revision","summary":"Revise", "bounds":{
                    "maxSteps":3,"maxDependenciesPerStep":2,"maxParallelSteps":2,"maxRevisions":max_revisions
                },"steps":initial_input.steps
            })).unwrap()
        };
        assert!(build_revised_records(&revise(4), &current, "t2")
            .unwrap_err()
            .contains("cannot raise"));
        assert!(build_revised_records(&revise(1), &current, "t2")
            .unwrap_err()
            .contains("limit"));
    }
}

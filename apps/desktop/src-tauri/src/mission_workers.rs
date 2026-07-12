//! Authenticated native construction of bounded mission worker assignments.

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

use crate::store::repos::{capability_grant, mission_plan, mission_run, workspace_directory};

const MAX_CONTEXT: usize = 32;
const MAX_TOOLS: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionWorkerCreateInput {
    run_id: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
    worker_id: String,
    step_key: String,
    context: Vec<Value>,
    grants: Vec<WorkerGrantInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerGrantInput {
    capability_id: String,
    capability_grant_id: String,
}

#[tauri::command]
pub fn mission_worker_create(
    input: MissionWorkerCreateInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let context =
                workspace_directory::require_active_workspace_context_for_current_user(tx)?;
            let member = context.member_id.clone().ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "An active workspace membership is required.".into(),
                )
            })?;
            let scope = crate::store::repos::scope::DataScope::workspace(
                context.active_workspace.local_workspace_id.clone(),
            )?;
            let journal = mission_run::get(tx, store, &scope, &member, &input.run_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run is unavailable in this workspace.".into(),
                    )
                })?;
            let event_key = format!("worker-create:{}", bounded(&input.idempotency_key, "Worker idempotency key", 200).map_err(crate::store::StoreError::Invalid)?);
            if let Some(existing) = journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                exact_replay(existing, &input).map_err(crate::store::StoreError::Invalid)?;
                return Ok(journal);
            }
            validate_live_head(&journal.run, &input).map_err(crate::store::StoreError::Invalid)?;
            let mission_id = journal
                .run
                .pointer("/initiator/missionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission run has no selected mission lifecycle.".into(),
                    )
                })?;
            let lifecycle = mission_plan::get(tx, store, &scope, &member, mission_id)?
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission plan is unavailable in this workspace.".into(),
                    )
                })?;
            validate_lifecycle(&journal.run, &lifecycle)
                .map_err(crate::store::StoreError::Invalid)?;
            let mission = object(&lifecycle.mission, "Mission")
                .map_err(crate::store::StoreError::Invalid)?;
            let revision = object(&lifecycle.current_revision, "Plan revision")
                .map_err(crate::store::StoreError::Invalid)?;
            let step = revision
                .get("steps")
                .and_then(Value::as_array)
                .and_then(|steps| {
                    steps.iter().find(|step| {
                        step.get("key").and_then(Value::as_str) == Some(input.step_key.as_str())
                    })
                })
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Selected mission plan step is unavailable.".into(),
                    )
                })?;
            validate_worker_slot(&journal, mission, revision, step, &input)
                .map_err(crate::store::StoreError::Invalid)?;
            let at = now();
            let grant_ids = validate_grants(
                tx, store, &scope, mission, step, &input.grants, &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let worker = build_worker(
                mission,
                revision,
                step,
                &input,
                &grant_ids,
                &context.internal_user_id,
                &member,
                &at,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let workspace = journal
                .run
                .get("workspaceId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
                })?;
            let previous = journal
                .run
                .pointer("/eventHead/lastEventId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
                })?;
            let sequence = input.expected_last_sequence + 1;
            let event = json!({
                "workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,
                "authority":"local","schemaVersion":1,"revision":1,
                "createdByInternalUserId":context.internal_user_id,"createdAt":at,"updatedAt":at,
                "id":input.event_id,"runId":input.run_id,"type":"worker-created","sequence":sequence,
                "previousEventId":previous,"attemptNumber":journal.run.get("currentAttemptNumber").and_then(Value::as_i64).unwrap_or(1),
                "occurredAt":at,"actor":{"kind":"internal-user","internalUserId":context.internal_user_id,"memberId":member},
                "idempotencyKey":event_key,"payload":{"worker":worker}
            });
            let mut projected = journal.run.as_object().cloned().ok_or_else(|| {
                crate::store::StoreError::Invalid("Mission run record is invalid.".into())
            })?;
            projected.insert("revision".into(), json!(input.expected_run_revision + 1));
            projected.insert("updatedAt".into(), json!(at));
            projected.insert(
                "eventHead".into(),
                json!({"lastSequence":sequence,"lastEventId":input.event_id}),
            );
            mission_run::append(
                tx,
                store,
                &scope,
                &member,
                &input.run_id,
                input.expected_run_revision,
                input.expected_last_sequence,
                &input.event_id,
                "worker-created",
                &event_key,
                &event,
                &Value::Object(projected),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

fn validate_lifecycle(
    run: &Value,
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
) -> Result<(), String> {
    let mission = object(&lifecycle.mission, "Mission")?;
    let revision = object(&lifecycle.current_revision, "Plan revision")?;
    if mission.get("status").and_then(Value::as_str) != Some("ready")
        || mission.get("currentPlanRevisionId").and_then(Value::as_str)
            != revision.get("id").and_then(Value::as_str)
        || run.get("planRevisionId").and_then(Value::as_str)
            != revision.get("id").and_then(Value::as_str)
        || run.get("workspaceId") != mission.get("workspaceId")
        || run.get("ownerMemberId") != mission.get("ownerMemberId")
    {
        return Err("Mission run is not bound to the currently selected plan revision.".into());
    }
    Ok(())
}

fn validate_live_head(run: &Value, input: &MissionWorkerCreateInput) -> Result<(), String> {
    if !matches!(
        run.get("status").and_then(Value::as_str),
        Some("created" | "planning" | "queued" | "running")
    ) {
        return Err("Mission run cannot create another worker.".into());
    }
    if run.get("revision").and_then(Value::as_i64) != Some(input.expected_run_revision)
        || run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(input.expected_last_sequence)
    {
        return Err("The mission run changed before the worker could be created.".into());
    }
    bounded(&input.run_id, "Mission run", 160)?;
    bounded(&input.event_id, "Worker event", 160)?;
    bounded(&input.worker_id, "Worker", 160)?;
    bounded(&input.step_key, "Plan step", 160)?;
    Ok(())
}

fn validate_grants(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    storage_scope: &crate::store::repos::scope::DataScope,
    mission: &Map<String, Value>,
    step: &Value,
    mappings: &[WorkerGrantInput],
    at: &str,
) -> Result<Vec<String>, String> {
    let project = mission
        .get("scope")
        .and_then(Value::as_object)
        .and_then(|scope| scope.get("projectId"))
        .and_then(Value::as_str);
    let scope = crate::authorized_scope::resolve(
        tx,
        Some(storage_scope.workspace_id()),
        project,
        crate::authorized_scope::ScopeAccess::Write,
    )
    .map_err(|error| error.to_string())?;
    let capabilities = step
        .get("requiredCapabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| "Plan step capabilities are invalid.".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "Plan step capability is invalid.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut by_capability = BTreeMap::<String, String>::new();
    for mapping in mappings {
        let capability = bounded(&mapping.capability_id, "Capability", 160)?;
        let grant_id = bounded(&mapping.capability_grant_id, "Capability grant", 160)?;
        if !capabilities.contains(&capability)
            || by_capability.insert(capability, grant_id).is_some()
        {
            return Err("Capability grants must map exactly once to required capabilities.".into());
        }
    }
    if by_capability.len() != capabilities.len() {
        return Err("Every worker capability requires one explicit grant reference.".into());
    }
    let mut ordered = Vec::with_capacity(capabilities.len());
    for capability in capabilities {
        let grant_id = by_capability
            .get(&capability)
            .ok_or_else(|| "Worker capability grant is missing.".to_string())?;
        let grant = capability_grant::get(tx, store, &scope, grant_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Worker capability grant is unavailable.".to_string())?;
        if grant.capability_id != capability {
            return Err("Worker capability grant does not match its required capability.".into());
        }
        if grant.consequence != "read" {
            return Err("Current mission capabilities require a read-only grant.".into());
        }
        let active = capability_grant::check(
            tx,
            store,
            &scope,
            &capability,
            &grant.connection_id,
            "read",
            at,
        )
        .map_err(|error| error.to_string())?
        .map_err(|failure| failure.message.to_string())?;
        if !active.iter().any(|candidate| candidate.id == grant.id) {
            return Err("Worker capability grant is not active in this exact scope.".into());
        }
        ordered.push(grant.id);
    }
    Ok(ordered)
}

fn validate_worker_slot(
    journal: &mission_run::MissionRunJournalRow,
    mission: &Map<String, Value>,
    revision: &Map<String, Value>,
    step: &Value,
    input: &MissionWorkerCreateInput,
) -> Result<(), String> {
    let step = object(step, "Plan step")?;
    let mut worker_steps = BTreeMap::<String, String>::new();
    let mut completed_workers = BTreeSet::<String>::new();
    let mut failed_workers = BTreeSet::<String>::new();
    for event in &journal.events {
        match event.get("type").and_then(Value::as_str) {
            Some("worker-created") => {
                let worker = event
                    .pointer("/payload/worker")
                    .and_then(Value::as_object)
                    .ok_or_else(|| "Stored worker event is invalid.".to_string())?;
                let id = required(worker, "id")?;
                let step_key = required(worker, "planStepKey")?;
                if id == input.worker_id {
                    return Err("Worker id is already present in this run.".into());
                }
                if step_key == input.step_key {
                    return Err("This plan step already has a worker assignment.".into());
                }
                if worker_steps.insert(id, step_key).is_some() {
                    return Err("Stored worker identities are not unique in this run.".into());
                }
            }
            Some("worker-completed") => {
                if let Some(id) = event.pointer("/payload/workerId").and_then(Value::as_str) {
                    completed_workers.insert(id.to_string());
                }
            }
            Some("worker-failed") => {
                if let Some(id) = event.pointer("/payload/workerId").and_then(Value::as_str) {
                    failed_workers.insert(id.to_string());
                }
            }
            _ => {}
        }
    }
    let completed_steps = completed_workers
        .iter()
        .filter_map(|worker| worker_steps.get(worker).cloned())
        .collect::<BTreeSet<_>>();
    let dependencies = step
        .get("dependsOnStepKeys")
        .and_then(Value::as_array)
        .ok_or_else(|| "Plan step dependencies are invalid.".to_string())?;
    if dependencies.iter().any(|dependency| {
        dependency
            .as_str()
            .is_none_or(|key| !completed_steps.contains(key))
    }) {
        return Err("Plan step dependencies are not durably complete.".into());
    }
    let depth = required(mission, "executionDepth")?;
    let mission_limit = mission
        .get("budget")
        .and_then(Value::as_object)
        .and_then(|budget| budget.get("maxWorkers"))
        .and_then(Value::as_i64);
    let plan_limit = revision
        .get("bounds")
        .and_then(Value::as_object)
        .and_then(|bounds| bounds.get("maxSteps"))
        .and_then(Value::as_i64)
        .ok_or_else(|| "Plan worker bound is invalid.".to_string())?;
    let parallel_limit = revision
        .get("bounds")
        .and_then(Value::as_object)
        .and_then(|bounds| bounds.get("maxParallelSteps"))
        .and_then(Value::as_i64)
        .ok_or_else(|| "Plan parallel worker bound is invalid.".to_string())?;
    let concurrency_limit = if depth == "delegated" {
        1
    } else {
        mission_limit.unwrap_or(parallel_limit).min(parallel_limit)
    };
    let terminal_workers = completed_workers
        .union(&failed_workers)
        .cloned()
        .collect::<BTreeSet<_>>();
    let active_workers = worker_steps
        .keys()
        .filter(|worker| !terminal_workers.contains(*worker))
        .count() as i64;
    if plan_limit < 1 || worker_steps.len() as i64 >= plan_limit {
        return Err("Plan worker assignment limit is exhausted.".into());
    }
    if concurrency_limit < 1 || active_workers >= concurrency_limit {
        return Err("Mission worker limit is exhausted.".into());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn build_worker(
    mission: &Map<String, Value>,
    revision: &Map<String, Value>,
    step: &Value,
    input: &MissionWorkerCreateInput,
    grant_ids: &[String],
    actor: &str,
    member: &str,
    at: &str,
) -> Result<Value, String> {
    let step = object(step, "Plan step")?;
    let allowed = mission
        .get("scope")
        .and_then(Value::as_object)
        .and_then(|scope| scope.get("context"))
        .and_then(Value::as_array)
        .ok_or_else(|| "Mission context is invalid.".to_string())?;
    let context = validate_context(&input.context, allowed)?;
    let capabilities = step
        .get("requiredCapabilities")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Plan step capabilities are invalid.".to_string())?;
    let tools = tools_for_capabilities(&capabilities)?;
    let kind = step.get("kind").and_then(Value::as_str).unwrap_or("");
    let role = match kind {
        "review" => "reviewer",
        "act" => "executor",
        _ => "specialist",
    };
    let workspace = required(mission, "workspaceId")?;
    let revision_id = required(revision, "id")?;
    let title = required(step, "title")?;
    let objective = required(step, "objective")?;
    let budget = bounded_budget(mission.get("budget"), step.get("estimatedBudget"))?;
    let outputs = step
        .get("expectedOutputs")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "Plan step outputs are invalid.".to_string())?;
    Ok(json!({
        "workspaceId":workspace,"visibility":"member-private","ownerMemberId":member,
        "authority":"local","schemaVersion":1,"revision":1,"createdByInternalUserId":actor,
        "createdAt":at,"updatedAt":at,"id":input.worker_id,"runId":input.run_id,"status":"proposed",
        "role":{"kind":role,"title":title,"objective":objective,"responsibilities":[objective]},
        "planRevisionId":revision_id,"planStepKey":input.step_key,"context":context,
        "capabilityIds":capabilities,"capabilityGrantIds":grant_ids,"tools":tools,"budget":budget,
        "stopConditions":[
            {"kind":"objective-met","description":"Stop when the assigned objective and required outputs are complete."},
            {"kind":"budget-reached","description":"Stop before any worker budget is exceeded."},
            {"kind":"no-progress","description":"Stop after two iterations without useful progress.","threshold":2}
        ],
        "outputContract":{"slots":outputs,"includeEvidence":step.get("acceptanceCriterionKeys").and_then(Value::as_array).is_some_and(|values|!values.is_empty()),"includeUncertainty":true,"delivery":"run-result"}
    }))
}

fn validate_context(values: &[Value], allowed: &[Value]) -> Result<Vec<Value>, String> {
    if values.len() > MAX_CONTEXT {
        return Err("Worker context exceeds its reference bound.".into());
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let item = object(value, "Worker context")?;
        exact_keys(item, &["reference", "purpose", "required", "maxCharacters"])?;
        let reference = item
            .get("reference")
            .ok_or_else(|| "Worker context reference is missing.".to_string())?;
        if !allowed.contains(reference) {
            return Err("Worker context must be declared by the mission scope.".into());
        }
        let fingerprint = serde_json::to_string(reference)
            .map_err(|_| "Worker context reference is invalid.".to_string())?;
        if !seen.insert(fingerprint) {
            return Err("Worker context references must be unique.".into());
        }
        text(item.get("purpose"), "Worker context purpose", 1_000)?;
        if item.get("required").and_then(Value::as_bool).is_none()
            || item.get("maxCharacters").is_some_and(|value| {
                value
                    .as_i64()
                    .is_none_or(|number| !(1..=1_000_000).contains(&number))
            })
        {
            return Err("Worker context bounds are invalid.".into());
        }
        let mut normalized = item.clone();
        normalized.insert("trust".into(), Value::String("untrusted".into()));
        result.push(Value::Object(normalized));
    }
    Ok(result)
}

fn tools_for_capabilities(capabilities: &[Value]) -> Result<Vec<Value>, String> {
    if capabilities.len() > MAX_TOOLS {
        return Err("Worker capability set exceeds its tool bound.".into());
    }
    const CONNECTED_READS: &[&str] = &[
        "connected-source.search",
        "source.repository.list",
        "source.file.search",
        "knowledge.content.search",
        "communication.email.search",
        "communication.channel.list",
        "calendar.list",
        "calendar.event.search",
        "software.deployment.list",
        "work.issue.list",
    ];
    if capabilities.is_empty() {
        return Ok(Vec::new());
    }
    if capabilities.iter().any(|capability| {
        capability
            .as_str()
            .is_none_or(|value| !CONNECTED_READS.contains(&value))
    }) {
        return Err("Plan step requires a capability with no native mission tool binding.".into());
    }
    Ok(vec![
        json!({"toolName":"connection-read","access":"read","purpose":"Search connected work sources for evidence required by this step.","required":true}),
    ])
}

fn bounded_budget(mission: Option<&Value>, step: Option<&Value>) -> Result<Value, String> {
    let defaults = [600_000_i64, 32_000, 8_000, 20, 1];
    let keys = [
        "maxDurationMs",
        "maxInputTokens",
        "maxOutputTokens",
        "maxToolCalls",
        "maxAttempts",
    ];
    let mut result = Map::new();
    for (index, key) in keys.iter().enumerate() {
        let mut values = vec![defaults[index]];
        for budget in [mission, step].into_iter().flatten() {
            if let Some(value) = budget.get(*key) {
                let number = value
                    .as_i64()
                    .filter(|number| *number > 0)
                    .ok_or_else(|| format!("Worker {key} must be a positive integer."))?;
                values.push(number);
            }
        }
        result.insert((*key).into(), json!(values.into_iter().min().unwrap()));
    }
    if let Some(cost) = lower_cost(
        mission.and_then(|value| value.get("maxCost")),
        step.and_then(|value| value.get("maxCost")),
    )? {
        result.insert("maxCost".into(), cost.clone());
    }
    Ok(Value::Object(result))
}

fn lower_cost<'a>(
    first: Option<&'a Value>,
    second: Option<&'a Value>,
) -> Result<Option<&'a Value>, String> {
    match (first, second) {
        (None, None) => Ok(None),
        (Some(value), None) | (None, Some(value)) => {
            cost_parts(value)?;
            Ok(Some(value))
        }
        (Some(left), Some(right)) => {
            let (left_currency, left_number) = cost_parts(left)?;
            let (right_currency, right_number) = cost_parts(right)?;
            if left_currency != right_currency {
                return Err("Worker monetary budgets must use one currency.".into());
            }
            Ok(Some(if decimal_le(&left_number, &right_number) {
                left
            } else {
                right
            }))
        }
    }
}

fn cost_parts(value: &Value) -> Result<(String, String), String> {
    let object = object(value, "Worker monetary budget")?;
    exact_keys(object, &["amount", "currencyCode"])?;
    let currency = required(object, "currencyCode")?;
    if currency.len() != 3 || !currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("Worker monetary budget currency is invalid.".into());
    }
    let amount = required(object, "amount")?;
    if amount.len() > 64
        || amount.starts_with('-')
        || amount.matches('.').count() > 1
        || !amount
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        || amount.split('.').next().is_none_or(str::is_empty)
    {
        return Err("Worker monetary budget amount is invalid.".into());
    }
    Ok((currency, amount))
}

fn decimal_le(left: &str, right: &str) -> bool {
    let (left_whole, left_fraction) = normalized_decimal(left);
    let (right_whole, right_fraction) = normalized_decimal(right);
    if left_whole.len() != right_whole.len() {
        return left_whole.len() < right_whole.len();
    }
    if left_whole != right_whole {
        return left_whole < right_whole;
    }
    let width = left_fraction.len().max(right_fraction.len());
    let left_padded = format!("{left_fraction:0<width$}");
    let right_padded = format!("{right_fraction:0<width$}");
    left_padded <= right_padded
}

fn normalized_decimal(value: &str) -> (String, String) {
    let mut parts = value.splitn(2, '.');
    let whole = parts.next().unwrap_or("0").trim_start_matches('0');
    let fraction = parts.next().unwrap_or("").trim_end_matches('0');
    (
        if whole.is_empty() { "0" } else { whole }.to_string(),
        fraction.to_string(),
    )
}

fn exact_replay(event: &Value, input: &MissionWorkerCreateInput) -> Result<(), String> {
    let worker = event
        .pointer("/payload/worker")
        .ok_or_else(|| "Replayed worker event is invalid.".to_string())?;
    let expected_tools = worker
        .get("capabilityIds")
        .and_then(Value::as_array)
        .map(|capabilities| tools_for_capabilities(capabilities))
        .transpose()?
        .ok_or_else(|| "Replayed worker capabilities are invalid.".to_string())?;
    let expected_context = normalize_replay_context(&input.context)?;
    let mapping = input
        .grants
        .iter()
        .map(|grant| {
            (
                grant.capability_id.as_str(),
                grant.capability_grant_id.as_str(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    if mapping.len() != input.grants.len() {
        return Err("Worker idempotency replay contains duplicate capability mappings.".into());
    }
    let expected_grants = worker
        .get("capabilityIds")
        .and_then(Value::as_array)
        .map(|capabilities| {
            capabilities
                .iter()
                .map(|capability| {
                    capability
                        .as_str()
                        .and_then(|value| mapping.get(value).copied())
                        .map(|value| Value::String(value.to_string()))
                })
                .collect::<Option<Vec<_>>>()
        })
        .flatten();
    if event.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
        && event.get("type").and_then(Value::as_str) == Some("worker-created")
        && event.get("runId").and_then(Value::as_str) == Some(input.run_id.as_str())
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_last_sequence + 1)
        && event.get("sequence").and_then(Value::as_i64) == Some(input.expected_run_revision)
        && worker.get("id").and_then(Value::as_str) == Some(input.worker_id.as_str())
        && worker.get("runId").and_then(Value::as_str) == Some(input.run_id.as_str())
        && worker.get("planStepKey").and_then(Value::as_str) == Some(input.step_key.as_str())
        && worker.get("context") == Some(&Value::Array(expected_context))
        && worker.get("tools") == Some(&Value::Array(expected_tools))
        && worker
            .get("capabilityGrantIds")
            .and_then(Value::as_array)
            .is_some_and(|ids| {
                expected_grants
                    .as_ref()
                    .is_some_and(|expected| ids == expected)
            })
    {
        Ok(())
    } else {
        Err("Worker idempotency key already represents another assignment.".into())
    }
}

fn normalize_replay_context(values: &[Value]) -> Result<Vec<Value>, String> {
    if values.len() > MAX_CONTEXT {
        return Err("Worker context exceeds its reference bound.".into());
    }
    values
        .iter()
        .map(|value| {
            let item = object(value, "Worker context")?;
            exact_keys(item, &["reference", "purpose", "required", "maxCharacters"])?;
            if item.get("reference").is_none()
                || item.get("required").and_then(Value::as_bool).is_none()
            {
                return Err("Worker context replay is invalid.".into());
            }
            text(item.get("purpose"), "Worker context purpose", 1_000)?;
            let mut normalized = item.clone();
            normalized.insert("trust".into(), Value::String("untrusted".into()));
            Ok(Value::Object(normalized))
        })
        .collect()
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} is invalid."))
}

fn exact_keys(object: &Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Worker input contains an unsupported field.".into());
    }
    Ok(())
}

fn required(object: &Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(|value| bounded(value, key, 4_000))
        .transpose()?
        .ok_or_else(|| format!("Mission {key} is invalid."))
}

fn text(value: Option<&Value>, label: &str, max: usize) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(|value| bounded(value, label, max))
        .transpose()?
        .ok_or_else(|| format!("{label} is invalid."))
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(value.to_string())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_builder_clamps_budget_and_rejects_undeclared_context() {
        let mission = json!({"workspaceId":"workspace-1","scope":{"context":[{"kind":"knowledge","reference":"source-1"}]},"budget":{"maxToolCalls":4,"maxCost":{"amount":"5.00","currencyCode":"USD"}}});
        let revision = json!({"id":"revision-1"});
        let step = json!({"key":"search","kind":"investigate","title":"Search","objective":"Find evidence","requiredCapabilities":[],"expectedOutputs":[],"acceptanceCriterionKeys":[],"estimatedBudget":{"maxToolCalls":2,"maxCost":{"amount":"2.50","currencyCode":"USD"}}});
        let input = MissionWorkerCreateInput {
            run_id: "run-1".into(),
            event_id: "event-2".into(),
            idempotency_key: "one".into(),
            expected_run_revision: 2,
            expected_last_sequence: 1,
            worker_id: "worker-1".into(),
            step_key: "search".into(),
            context: vec![
                json!({"reference":{"kind":"knowledge","reference":"source-1"},"purpose":"Evidence","required":true}),
            ],
            grants: vec![],
        };
        let built = build_worker(
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input,
            &[],
            "user-1",
            "member-1",
            "t",
        )
        .unwrap();
        assert_eq!(built["budget"]["maxToolCalls"], 2);
        assert_eq!(built["budget"]["maxCost"]["amount"], "2.50");
        assert_eq!(built["context"][0]["trust"], "untrusted");
        let mut changed = input;
        changed.context = vec![
            json!({"reference":{"kind":"knowledge","reference":"other"},"purpose":"Hidden","required":true}),
        ];
        assert!(build_worker(
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &changed,
            &[],
            "user-1",
            "member-1",
            "t"
        )
        .is_err());
    }

    #[test]
    fn worker_slot_requires_dependencies_and_unique_bounded_assignments() {
        let mission = json!({"executionDepth":"multi-worker","budget":{"maxWorkers":1}});
        let revision = json!({"bounds":{"maxSteps":3,"maxParallelSteps":2}});
        let step = json!({"key":"write","dependsOnStepKeys":["search"]});
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{"id":"worker-search","planStepKey":"search"}}}),
            ],
        };
        let input = MissionWorkerCreateInput {
            run_id: "run-1".into(),
            event_id: "event-3".into(),
            idempotency_key: "write".into(),
            expected_run_revision: 3,
            expected_last_sequence: 2,
            worker_id: "worker-write".into(),
            step_key: "write".into(),
            context: vec![],
            grants: vec![],
        };
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_err());
        journal
            .events
            .push(json!({"type":"worker-completed","payload":{"workerId":"worker-search"}}));
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_ok());
        journal.events.push(json!({"type":"worker-created","payload":{"worker":{"id":"worker-other","planStepKey":"other"}}}));
        assert!(validate_worker_slot(
            &journal,
            mission.as_object().unwrap(),
            revision.as_object().unwrap(),
            &step,
            &input
        )
        .is_err());
    }
}

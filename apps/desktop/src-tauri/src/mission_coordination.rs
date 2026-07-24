//! Durable provider-neutral dependency joins for general Mission plans.
//!
//! Join policy is declared before dependency outcomes are known. Resolution is
//! derived only from the encrypted run journal, so a renderer cannot reshape a
//! join after seeing which worker succeeded.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::store::repos::{mission_plan, mission_run, scope::DataScope, workspace_directory};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionJoinOpenInput {
    run_id: String,
    target_step_key: String,
    strategy: String,
    quorum: Option<usize>,
    allow_failed_workers: bool,
    deadline: Option<String>,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionJoinResolveInput {
    run_id: String,
    join_key: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissionAggregationRecordInput {
    run_id: String,
    target_step_key: String,
    event_id: String,
    idempotency_key: String,
    expected_run_revision: i64,
    expected_last_sequence: i64,
}

struct AuthorizedRun {
    scope: DataScope,
    member: String,
    actor: String,
    journal: mission_run::MissionRunJournalRow,
    lifecycle: mission_plan::MissionPlanLifecycleRow,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn bounded(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid."));
    }
    Ok(value.to_string())
}

pub(crate) fn coordination_join_key(plan_revision_id: &str, target_step_key: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fable.mission.coordination.join.v1\0");
    digest.update(plan_revision_id.as_bytes());
    digest.update(b"\0");
    digest.update(target_step_key.as_bytes());
    format!("mission_join_{:x}", digest.finalize())
}

fn authorized_run(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    run_id: &str,
) -> crate::store::Result<AuthorizedRun> {
    let authorized = authorized_run_for_read(tx, store, run_id)?;
    if matches!(
        authorized.journal.run.get("status").and_then(Value::as_str),
        Some("completed" | "partially-completed" | "failed" | "cancelled")
    ) {
        return Err(crate::store::StoreError::Invalid(
            "Mission coordination is not bound to a live run.".into(),
        ));
    }
    Ok(authorized)
}

fn authorized_run_for_read(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    run_id: &str,
) -> crate::store::Result<AuthorizedRun> {
    let context = workspace_directory::require_active_workspace_context_for_current_user(tx)?;
    let member = context.member_id.clone().ok_or_else(|| {
        crate::store::StoreError::Invalid(
            "An active workspace membership is required for Mission coordination.".into(),
        )
    })?;
    let scope = DataScope::workspace(context.active_workspace.local_workspace_id)?;
    let journal = mission_run::get(tx, store, &scope, &member, run_id)?.ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run is unavailable in this workspace.".into())
    })?;
    let mission_id = journal
        .run
        .pointer("/initiator/missionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Mission run has no selected Mission lifecycle.".into(),
            )
        })?;
    let lifecycle =
        mission_plan::get(tx, store, &scope, &member, mission_id)?.ok_or_else(|| {
            crate::store::StoreError::Invalid(
                "Mission plan is unavailable in this workspace.".into(),
            )
        })?;
    if journal.run.get("planRevisionId") != lifecycle.current_revision.get("id")
        || journal.run.get("workspaceId") != lifecycle.mission.get("workspaceId")
        || journal.run.get("ownerMemberId") != lifecycle.mission.get("ownerMemberId")
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission coordination is not bound to the selected plan.".into(),
        ));
    }
    Ok(AuthorizedRun {
        scope,
        member,
        actor: context.internal_user_id,
        journal,
        lifecycle,
    })
}

fn dependency_step_keys<'a>(
    lifecycle: &'a mission_plan::MissionPlanLifecycleRow,
    target_step_key: &str,
) -> Result<Vec<&'a str>, String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    let target = steps
        .iter()
        .find(|step| step.get("key").and_then(Value::as_str) == Some(target_step_key))
        .ok_or_else(|| "Join target step is unavailable.".to_string())?;
    let dependencies = target
        .get("dependsOnStepKeys")
        .and_then(Value::as_array)
        .ok_or_else(|| "Join target dependencies are invalid.".to_string())?;
    if dependencies.len() < 2 {
        return Err("A durable join requires at least two dependency steps.".into());
    }
    dependencies
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "Join target dependency is invalid.".to_string())
        })
        .collect()
}

fn workers_by_step(
    journal: &mission_run::MissionRunJournalRow,
) -> Result<BTreeMap<String, String>, String> {
    let mut workers = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("worker-created") {
            continue;
        }
        let worker = event
            .pointer("/payload/worker")
            .and_then(Value::as_object)
            .ok_or_else(|| "Stored worker assignment is invalid.".to_string())?;
        let id = worker
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Stored worker identity is invalid.".to_string())?;
        let step = worker
            .get("planStepKey")
            .and_then(Value::as_str)
            .ok_or_else(|| "Stored worker step is invalid.".to_string())?;
        if !ids.insert(id.to_string()) || workers.insert(step.to_string(), id.to_string()).is_some()
        {
            return Err("Stored worker assignments are ambiguous.".into());
        }
    }
    Ok(workers)
}

fn terminal_workers(
    journal: &mission_run::MissionRunJournalRow,
) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut completed = BTreeSet::new();
    let mut failed = BTreeSet::new();
    for event in &journal.events {
        let Some(worker_id) = event.pointer("/payload/workerId").and_then(Value::as_str) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("worker-completed") => {
                completed.insert(worker_id.to_string());
            }
            Some("worker-failed") => {
                failed.insert(worker_id.to_string());
            }
            _ => {}
        }
    }
    (completed, failed)
}

fn strict_terminal_workers(
    journal: &mission_run::MissionRunJournalRow,
) -> Result<(BTreeSet<String>, BTreeSet<String>), String> {
    let known = workers_by_step(journal)?
        .into_values()
        .collect::<BTreeSet<_>>();
    let mut completed = BTreeSet::new();
    let mut failed = BTreeSet::new();
    for event in &journal.events {
        let terminal = match event.get("type").and_then(Value::as_str) {
            Some("worker-completed") => Some(true),
            Some("worker-failed") => Some(false),
            _ => None,
        };
        let Some(completed_fact) = terminal else {
            continue;
        };
        let worker_id = event
            .pointer("/payload/workerId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Stored Mission worker terminal fact is invalid.".to_string())?;
        if !known.contains(worker_id) || completed.contains(worker_id) || failed.contains(worker_id)
        {
            return Err("Stored Mission worker terminal facts are ambiguous.".into());
        }
        if completed_fact {
            completed.insert(worker_id.to_string());
        } else {
            failed.insert(worker_id.to_string());
        }
    }
    Ok((completed, failed))
}

fn exact_dependency_workers(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
    target_step_key: &str,
) -> Result<Vec<String>, String> {
    let dependencies = dependency_step_keys(lifecycle, target_step_key)?;
    let workers = workers_by_step(journal)?;
    dependencies
        .into_iter()
        .map(|step| {
            workers
                .get(step)
                .cloned()
                .ok_or_else(|| "Every joined dependency requires one durable worker.".to_string())
        })
        .collect()
}

fn deterministic_aggregation_receipt(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
    target_step_key: &str,
) -> Result<Value, String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    let target = steps
        .iter()
        .find(|step| step.get("key").and_then(Value::as_str) == Some(target_step_key))
        .ok_or_else(|| "Aggregation target step is unavailable.".to_string())?;
    if target.get("kind").and_then(Value::as_str) != Some("coordinate") {
        return Err(
            "Only an explicit coordinate step can record deterministic aggregation.".into(),
        );
    }
    let dependencies = target
        .get("dependsOnStepKeys")
        .and_then(Value::as_array)
        .ok_or_else(|| "Aggregation dependencies are invalid.".to_string())?
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "Aggregation dependency is invalid.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dependencies.is_empty() || dependencies.len() > 32 {
        return Err("Deterministic aggregation requires one to thirty-two dependencies.".into());
    }

    let worker_ids = workers_by_step(journal)?;
    if worker_ids.contains_key(target_step_key) {
        return Err("A deterministic coordinate step cannot also have a worker.".into());
    }
    let ordered_workers = dependencies
        .iter()
        .map(|step| {
            worker_ids
                .get(*step)
                .cloned()
                .ok_or_else(|| "Every aggregation dependency requires one durable worker.".into())
        })
        .collect::<Result<Vec<String>, String>>()?;
    if dependencies.len() > 1 {
        let revision_id = lifecycle
            .current_revision
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Selected plan revision is invalid.".to_string())?;
        if !has_satisfied_dependency_join(journal, revision_id, target_step_key, &ordered_workers) {
            return Err("Aggregation requires its exact satisfied dependency join.".into());
        }
    }

    let mut worker_facts = BTreeMap::<String, &Value>::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("worker-created") {
            continue;
        }
        let worker = event
            .pointer("/payload/worker")
            .ok_or_else(|| "Stored worker assignment is invalid.".to_string())?;
        let id = worker
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Stored worker identity is invalid.".to_string())?;
        if worker_facts.insert(id.to_string(), worker).is_some() {
            return Err("Stored worker identities are ambiguous.".into());
        }
    }

    let mut inputs = Vec::with_capacity(dependencies.len());
    let mut produced_outputs = Vec::new();
    let mut output_keys = BTreeSet::<String>::new();
    let mut required_keys = BTreeSet::<String>::new();
    let mut all_completed = true;
    for (source_step, worker_id) in dependencies.iter().zip(&ordered_workers) {
        let worker = worker_facts
            .get(worker_id)
            .ok_or_else(|| "Aggregation worker assignment is unavailable.".to_string())?;
        if worker.get("planStepKey").and_then(Value::as_str) != Some(*source_step) {
            return Err("Aggregation worker no longer matches its selected Plan step.".into());
        }
        let slots = worker
            .pointer("/outputContract/slots")
            .and_then(Value::as_array)
            .ok_or_else(|| "Aggregation worker output contract is invalid.".to_string())?;
        let mut declared = BTreeSet::<String>::new();
        for slot in slots {
            let key = slot
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Aggregation worker output slot is invalid.".to_string())?;
            let key = bounded(key, "Aggregation output key", 160)?;
            if !declared.insert(key.clone()) {
                return Err("Aggregation worker output slots are ambiguous.".into());
            }
            if slot.get("required").and_then(Value::as_bool) == Some(true) {
                required_keys.insert(key);
            }
        }

        let terminals = journal
            .events
            .iter()
            .filter(|event| {
                matches!(
                    event.get("type").and_then(Value::as_str),
                    Some("worker-completed" | "worker-failed")
                ) && event.pointer("/payload/workerId").and_then(Value::as_str)
                    == Some(worker_id.as_str())
            })
            .collect::<Vec<_>>();
        if terminals.len() != 1 {
            return Err("Aggregation requires one exact terminal fact per worker.".into());
        }
        let terminal = terminals[0];
        let status = terminal
            .get("type")
            .and_then(Value::as_str)
            .map(|kind| {
                if kind == "worker-completed" {
                    "completed"
                } else {
                    "failed"
                }
            })
            .unwrap_or("failed");
        if dependencies.len() == 1 && status != "completed" {
            return Err("A single aggregation dependency must complete successfully.".into());
        }
        all_completed &= status == "completed";
        let outputs = if status == "completed" {
            terminal.pointer("/payload/outputs")
        } else {
            terminal.pointer("/payload/partial/completedOutputs")
        }
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
        if produced_outputs.len() + outputs.len() > 128 {
            return Err("Deterministic aggregation output count is too large.".into());
        }
        for output in &outputs {
            let object = output
                .as_object()
                .ok_or_else(|| "Aggregation worker output is invalid.".to_string())?;
            let key = object
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Aggregation worker output key is invalid.".to_string())?;
            let key = bounded(key, "Aggregation output key", 160)?;
            let summary = object
                .get("summary")
                .and_then(Value::as_str)
                .ok_or_else(|| "Aggregation worker output summary is invalid.".to_string())?;
            bounded(summary, "Aggregation output summary", 2_000)?;
            if !declared.contains(&key) || !output_keys.insert(key.clone()) {
                return Err(
                    "Aggregation outputs must be unique and declared by their source workers."
                        .into(),
                );
            }
            let mut has_reference = false;
            for field in [
                "artifactId",
                "artifactVersionId",
                "handoffId",
                "valueReference",
            ] {
                if let Some(reference) = object.get(field) {
                    let reference = reference
                        .as_str()
                        .ok_or_else(|| "Aggregation output reference is invalid.".to_string())?;
                    bounded(reference, "Aggregation output reference", 512)?;
                    has_reference = true;
                }
            }
            if !has_reference {
                return Err(
                    "Deterministic aggregation can combine only reference-bearing outputs.".into(),
                );
            }
            required_keys.remove(&key);
            produced_outputs.push(output.clone());
        }
        inputs.push(json!({
            "sourceStepKey":source_step,
            "workerId":worker_id,
            "status":status,
            "outputs":outputs
        }));
    }
    let missing_required_output_keys = required_keys.into_iter().collect::<Vec<_>>();
    Ok(json!({
        "version":1,
        "strategy":"ordered-manifest-v1",
        "stepKey":target_step_key,
        "status":if all_completed && missing_required_output_keys.is_empty() {"complete"} else {"partial"},
        "inputs":inputs,
        "producedOutputs":produced_outputs,
        "missingRequiredOutputKeys":missing_required_output_keys
    }))
}

fn validate_head(
    journal: &mission_run::MissionRunJournalRow,
    expected_revision: i64,
    expected_sequence: i64,
) -> Result<(), String> {
    if journal.run.get("revision").and_then(Value::as_i64) != Some(expected_revision)
        || journal
            .run
            .pointer("/eventHead/lastSequence")
            .and_then(Value::as_i64)
            != Some(expected_sequence)
    {
        return Err("Mission run changed before the join action.".into());
    }
    Ok(())
}

fn append_event(
    tx: &rusqlite::Connection,
    store: &crate::store::Store,
    authorized: &AuthorizedRun,
    event_id: &str,
    event_type: &str,
    event_key: &str,
    payload: Value,
    at: &str,
) -> crate::store::Result<mission_run::MissionRunJournalRow> {
    let revision = authorized
        .journal
        .run
        .get("revision")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run revision is invalid.".into())
        })?;
    let sequence = authorized
        .journal
        .run
        .pointer("/eventHead/lastSequence")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?
        + 1;
    let previous = authorized
        .journal
        .run
        .pointer("/eventHead/lastEventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run event head is invalid.".into())
        })?;
    let workspace = authorized
        .journal
        .run
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run workspace is invalid.".into())
        })?;
    let run_id = authorized
        .journal
        .run
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| crate::store::StoreError::Invalid("Mission run id is invalid.".into()))?;
    let attempt_number = authorized
        .journal
        .run
        .get("currentAttemptNumber")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            crate::store::StoreError::Invalid("Mission run attempt is invalid.".into())
        })?;
    let event = json!({
        "workspaceId":workspace,"visibility":"member-private",
        "ownerMemberId":authorized.member,"authority":"local","schemaVersion":1,"revision":1,
        "createdByInternalUserId":authorized.actor,"createdAt":at,"updatedAt":at,
        "id":event_id,"runId":run_id,"type":event_type,
        "sequence":sequence,"previousEventId":previous,
        "attemptNumber":attempt_number,
        "occurredAt":at,"actor":{"kind":"system"},"idempotencyKey":event_key,
        "payload":payload
    });
    let mut projected = authorized.journal.run.as_object().cloned().ok_or_else(|| {
        crate::store::StoreError::Invalid("Mission run record is invalid.".into())
    })?;
    projected.insert("revision".into(), json!(revision + 1));
    projected.insert("updatedAt".into(), json!(at));
    projected.insert(
        "eventHead".into(),
        json!({"lastSequence":sequence,"lastEventId":event_id}),
    );
    mission_run::append(
        tx,
        store,
        &authorized.scope,
        &authorized.member,
        run_id,
        revision,
        sequence - 1,
        event_id,
        event_type,
        event_key,
        &event,
        &Value::Object(projected),
        at,
    )
}

fn resolve_status(
    strategy: &str,
    quorum: Option<usize>,
    allow_failed: bool,
    worker_ids: &[String],
    completed: &BTreeSet<String>,
    failed: &BTreeSet<String>,
    deadline_elapsed: bool,
    run_cancelled: bool,
) -> Option<&'static str> {
    if run_cancelled {
        return Some("cancelled");
    }
    let complete_count = worker_ids
        .iter()
        .filter(|worker| completed.contains(*worker))
        .count();
    let failed_count = worker_ids
        .iter()
        .filter(|worker| failed.contains(*worker))
        .count();
    let accepted = complete_count + usize::from(allow_failed) * failed_count;
    let target = match strategy {
        "all" => worker_ids.len(),
        "any" => 1,
        "quorum" => quorum.unwrap_or(usize::MAX),
        _ => return Some("cancelled"),
    };
    if accepted >= target && (allow_failed || failed_count == 0) {
        return Some("satisfied");
    }
    if deadline_elapsed {
        return Some("timed-out");
    }
    let terminal = complete_count + failed_count;
    let possible = accepted + worker_ids.len().saturating_sub(terminal);
    if (!allow_failed && failed_count > 0) || possible < target {
        return Some("cancelled");
    }
    None
}

fn safe_cost_observation(value: &Value) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Stored Mission cost observation is invalid.".to_string())?;
    let amount = value
        .pointer("/amount/amount")
        .and_then(Value::as_str)
        .ok_or_else(|| "Stored Mission cost amount is invalid.".to_string())?;
    let valid_amount = !amount.is_empty()
        && amount.len() <= 64
        && amount
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        && amount.chars().filter(|character| *character == '.').count() <= 1;
    let currency = value
        .pointer("/amount/currencyCode")
        .and_then(Value::as_str)
        .filter(|currency| {
            currency.len() == 3
                && currency
                    .chars()
                    .all(|character| character.is_ascii_uppercase())
        })
        .ok_or_else(|| "Stored Mission cost currency is invalid.".to_string())?;
    let provenance = object
        .get("provenance")
        .and_then(Value::as_str)
        .filter(|provenance| {
            matches!(
                *provenance,
                "provider-reported" | "fable-calculated" | "estimated" | "unknown"
            )
        })
        .ok_or_else(|| "Stored Mission cost provenance is invalid.".to_string())?;
    if !valid_amount {
        return Err("Stored Mission cost observation is invalid.".into());
    }
    let pricing_reference = object
        .get("pricingReference")
        .and_then(Value::as_str)
        .map(|reference| bounded(reference, "Mission pricing reference", 2_000))
        .transpose()?;
    Ok(json!({
        "amount":{"amount":amount,"currencyCode":currency},
        "provenance":provenance,
        "pricingReference":pricing_reference
    }))
}

fn safe_budget_projection(run: &Value) -> Result<Value, String> {
    let budget = run
        .get("budget")
        .and_then(Value::as_object)
        .ok_or_else(|| "Mission run budget is invalid.".to_string())?;
    let mut projected = serde_json::Map::new();
    for field in [
        "maxDurationMs",
        "maxInputTokens",
        "maxOutputTokens",
        "maxToolCalls",
        "maxWorkers",
        "maxAttempts",
    ] {
        let Some(value) = budget.get(field) else {
            continue;
        };
        let value = value
            .as_i64()
            .filter(|value| *value >= 0)
            .ok_or_else(|| "Mission run budget is invalid.".to_string())?;
        projected.insert(field.into(), json!(value));
    }
    if let Some(max_cost) = budget.get("maxCost") {
        let amount = max_cost
            .get("amount")
            .and_then(Value::as_str)
            .ok_or_else(|| "Mission run cost budget is invalid.".to_string())?;
        let currency = max_cost
            .get("currencyCode")
            .and_then(Value::as_str)
            .filter(|currency| {
                currency.len() == 3
                    && currency
                        .chars()
                        .all(|character| character.is_ascii_uppercase())
            })
            .ok_or_else(|| "Mission run cost budget is invalid.".to_string())?;
        if amount.is_empty()
            || amount.len() > 64
            || !amount
                .chars()
                .all(|character| character.is_ascii_digit() || character == '.')
            || amount.chars().filter(|character| *character == '.').count() > 1
        {
            return Err("Mission run cost budget is invalid.".into());
        }
        projected.insert(
            "maxCost".into(),
            json!({"amount":amount,"currencyCode":currency}),
        );
    }
    Ok(Value::Object(projected))
}

fn automatic_coordination_identity(
    run_id: &str,
    event_kind: &str,
    reference: &str,
) -> (String, String) {
    let mut digest = Sha256::new();
    digest.update(b"fable.mission.coordination.advance.v1\0");
    digest.update(run_id.as_bytes());
    digest.update(b"\0");
    digest.update(event_kind.as_bytes());
    digest.update(b"\0");
    digest.update(reference.as_bytes());
    let digest = format!("{:x}", digest.finalize());
    (
        format!("mission-event-{}", &digest[..32]),
        format!("coordination-auto:{event_kind}:{}", &digest[..32]),
    )
}

fn next_automatic_join_resolution(
    journal: &mission_run::MissionRunJournalRow,
) -> Result<Option<(String, Value)>, String> {
    let resolved_values = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("join-resolved"))
        .filter_map(|event| {
            event
                .pointer("/payload/join/joinKey")
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    let resolved = resolved_values.iter().copied().collect::<BTreeSet<_>>();
    if resolved.len() != resolved_values.len() {
        return Err("Stored Mission join resolutions are ambiguous.".into());
    }
    let known_workers = workers_by_step(journal)?
        .into_values()
        .collect::<BTreeSet<_>>();
    let (completed, failed) = strict_terminal_workers(journal)?;
    let mut opened = BTreeSet::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("join-opened") {
            continue;
        }
        let join = event
            .pointer("/payload/join")
            .and_then(Value::as_object)
            .ok_or_else(|| "Stored Mission join declaration is invalid.".to_string())?;
        let join_key = bounded(
            join.get("joinKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission join identity is invalid.".to_string())?,
            "Mission join",
            200,
        )?;
        if !opened.insert(join_key.clone()) {
            return Err("Stored Mission join declarations are ambiguous.".into());
        }
        if resolved.contains(join_key.as_str()) {
            continue;
        }
        let strategy = join
            .get("strategy")
            .and_then(Value::as_str)
            .filter(|strategy| matches!(*strategy, "all" | "any" | "quorum"))
            .ok_or_else(|| "Stored Mission join strategy is invalid.".to_string())?;
        let worker_ids = join
            .get("workerIds")
            .and_then(Value::as_array)
            .filter(|workers| (2..=32).contains(&workers.len()))
            .ok_or_else(|| "Stored Mission join workers are invalid.".to_string())?
            .iter()
            .map(|worker| {
                bounded(
                    worker
                        .as_str()
                        .ok_or_else(|| "Stored Mission join worker is invalid.".to_string())?,
                    "Mission join worker",
                    200,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if worker_ids.iter().collect::<BTreeSet<_>>().len() != worker_ids.len() {
            return Err("Stored Mission join workers are ambiguous.".into());
        }
        if worker_ids
            .iter()
            .any(|worker| !known_workers.contains(worker))
        {
            return Err("Stored Mission join references an unknown worker.".into());
        }
        let quorum = join
            .get("quorum")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok());
        if (strategy == "quorum"
            && quorum.is_none_or(|value| value == 0 || value > worker_ids.len()))
            || (strategy != "quorum" && quorum.is_some())
        {
            return Err("Stored Mission join quorum is invalid.".into());
        }
        let allow_failed = join
            .get("allowFailedWorkers")
            .and_then(Value::as_bool)
            .ok_or_else(|| "Stored Mission join failure policy is invalid.".to_string())?;
        let deadline = join.get("deadline").filter(|value| !value.is_null());
        let deadline_elapsed = deadline
            .and_then(Value::as_str)
            .map(|deadline| {
                DateTime::parse_from_rfc3339(deadline)
                    .map(|deadline| deadline <= Utc::now())
                    .map_err(|_| "Stored Mission join deadline is invalid.".to_string())
            })
            .transpose()?
            .unwrap_or(false);
        let status = resolve_status(
            strategy,
            quorum,
            allow_failed,
            &worker_ids,
            &completed,
            &failed,
            deadline_elapsed,
            matches!(
                journal.run.get("status").and_then(Value::as_str),
                Some("cancelling" | "cancelled")
            ),
        );
        let Some(status) = status else {
            continue;
        };
        let satisfied_workers = worker_ids
            .iter()
            .filter(|worker| completed.contains(*worker))
            .cloned()
            .collect::<Vec<_>>();
        let failed_workers = worker_ids
            .iter()
            .filter(|worker| failed.contains(*worker))
            .cloned()
            .collect::<Vec<_>>();
        return Ok(Some((
            join_key.clone(),
            json!({
                "joinKey":join_key,
                "status":status,
                "strategy":strategy,
                "workerIds":worker_ids,
                "quorum":quorum,
                "allowFailedWorkers":allow_failed,
                "deadline":deadline,
                "satisfiedWorkerIds":satisfied_workers,
                "failedWorkerIds":failed_workers
            }),
        )));
    }
    Ok(None)
}

fn next_automatic_aggregation(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
) -> Result<Option<(String, Value)>, String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    let recorded_values = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("aggregation-recorded"))
        .filter_map(|event| {
            event
                .pointer("/payload/aggregation/stepKey")
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>();
    let recorded = recorded_values.iter().copied().collect::<BTreeSet<_>>();
    if recorded.len() != recorded_values.len() {
        return Err("Stored Mission aggregation facts are ambiguous.".into());
    }
    let workers = workers_by_step(journal)?;
    let (completed, failed) = strict_terminal_workers(journal)?;
    for step in steps {
        if step.get("kind").and_then(Value::as_str) != Some("coordinate") {
            continue;
        }
        let step_key = bounded(
            step.get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected coordinate step is invalid.".to_string())?,
            "Coordinate step",
            160,
        )?;
        if recorded.contains(step_key.as_str()) {
            continue;
        }
        let dependencies = step
            .get("dependsOnStepKeys")
            .and_then(Value::as_array)
            .filter(|dependencies| (1..=32).contains(&dependencies.len()))
            .ok_or_else(|| "Coordinate step dependencies are invalid.".to_string())?
            .iter()
            .map(|dependency| {
                dependency
                    .as_str()
                    .ok_or_else(|| "Coordinate step dependency is invalid.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let dependency_workers = dependencies
            .iter()
            .map(|dependency| {
                workers
                    .get(*dependency)
                    .cloned()
                    .ok_or_else(|| "Coordinate dependency worker is unavailable.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let all_terminal = dependency_workers
            .iter()
            .all(|worker| completed.contains(worker) || failed.contains(worker));
        if !all_terminal {
            continue;
        }
        if dependencies.len() == 1 && !completed.contains(&dependency_workers[0]) {
            continue;
        }
        if dependencies.len() > 1 {
            let revision_id = lifecycle
                .current_revision
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected plan revision is invalid.".to_string())?;
            if !has_satisfied_dependency_join(journal, revision_id, &step_key, &dependency_workers)
            {
                continue;
            }
        }
        return Ok(Some((
            step_key.clone(),
            deterministic_aggregation_receipt(lifecycle, journal, &step_key)?,
        )));
    }
    Ok(None)
}

fn mission_progress_projection(
    lifecycle: &mission_plan::MissionPlanLifecycleRow,
    journal: &mission_run::MissionRunJournalRow,
) -> Result<Value, String> {
    let steps = lifecycle
        .current_revision
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| "Selected plan steps are invalid.".to_string())?;
    if steps.is_empty() || steps.len() > 32 {
        return Err("Mission progress requires one to thirty-two selected steps.".into());
    }
    let run_status = journal
        .run
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| "Mission run status is invalid.".to_string())?;
    let terminal_run = matches!(
        run_status,
        "completed" | "partially-completed" | "failed" | "cancelled"
    );
    let worker_facts = journal
        .events
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
        .map(|event| {
            let worker = event
                .pointer("/payload/worker")
                .ok_or_else(|| "Stored worker assignment is invalid.".to_string())?;
            let worker_id = bounded(
                worker
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Stored worker identity is invalid.".to_string())?,
                "Mission worker",
                200,
            )?;
            let step_key = bounded(
                worker
                    .get("planStepKey")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Stored worker step is invalid.".to_string())?,
                "Mission step",
                160,
            )?;
            Ok((step_key, (worker_id, worker)))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    if worker_facts.len()
        != journal
            .events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("worker-created"))
            .count()
    {
        return Err("Stored worker assignments are ambiguous.".into());
    }

    let mut worker_states = BTreeMap::<String, &'static str>::new();
    for (worker_id, _) in worker_facts.values() {
        worker_states.insert(worker_id.clone(), "pending");
    }
    for event in &journal.events {
        let event_type = event.get("type").and_then(Value::as_str);
        let worker_id = event.pointer("/payload/workerId").and_then(Value::as_str);
        let Some(worker_id) = worker_id else {
            continue;
        };
        let Some(state) = worker_states.get_mut(worker_id) else {
            return Err("Mission progress references an unknown worker.".into());
        };
        match event_type {
            Some("worker-started" | "worker-progressed") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker activity appears after its terminal fact.".into());
                }
                *state = "running";
            }
            Some("worker-waiting") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker wait appears after its terminal fact.".into());
                }
                *state = "waiting";
            }
            Some("worker-completed") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker has duplicate terminal facts.".into());
                }
                *state = "completed";
            }
            Some("worker-failed") => {
                if matches!(*state, "completed" | "failed") {
                    return Err("Mission worker has duplicate terminal facts.".into());
                }
                *state = "failed";
            }
            _ => {}
        }
    }

    let mut aggregation_states = BTreeMap::<String, &'static str>::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("aggregation-recorded") {
            continue;
        }
        let step_key = bounded(
            event
                .pointer("/payload/aggregation/stepKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored aggregation step is invalid.".to_string())?,
            "Aggregation step",
            160,
        )?;
        let status = match event
            .pointer("/payload/aggregation/status")
            .and_then(Value::as_str)
        {
            Some("complete") => "completed",
            Some("partial") => "partial",
            _ => return Err("Stored aggregation status is invalid.".into()),
        };
        if aggregation_states.insert(step_key, status).is_some() {
            return Err("Mission aggregation facts are ambiguous.".into());
        }
    }

    let step_keys = steps
        .iter()
        .map(|step| {
            bounded(
                step.get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Selected plan step identity is invalid.".to_string())?,
                "Mission step",
                160,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    if step_keys.iter().collect::<BTreeSet<_>>().len() != step_keys.len() {
        return Err("Selected plan step identities are ambiguous.".into());
    }

    let mut base_states = BTreeMap::<String, &'static str>::new();
    for (step, step_key) in steps.iter().zip(&step_keys) {
        let kind = step
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "Selected plan step kind is invalid.".to_string())?;
        if kind == "coordinate" {
            if worker_facts.contains_key(step_key) {
                return Err("A coordinate step cannot also have a worker.".into());
            }
            base_states.insert(
                step_key.clone(),
                aggregation_states
                    .get(step_key)
                    .copied()
                    .unwrap_or("pending"),
            );
        } else {
            let (worker_id, _) = worker_facts
                .get(step_key)
                .ok_or_else(|| "Every executable step requires one durable worker.".to_string())?;
            base_states.insert(
                step_key.clone(),
                worker_states.get(worker_id).copied().unwrap_or("pending"),
            );
        }
    }
    if worker_facts
        .keys()
        .any(|step_key| !base_states.contains_key(step_key))
        || aggregation_states
            .keys()
            .any(|step_key| !base_states.contains_key(step_key))
    {
        return Err("Mission progress contains work outside the selected plan.".into());
    }

    let running_workers = worker_states
        .values()
        .filter(|state| matches!(**state, "running" | "waiting"))
        .count();
    let max_parallel = lifecycle
        .current_revision
        .pointer("/bounds/maxParallelSteps")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0 && *value <= 32)
        .ok_or_else(|| "Selected plan parallel bound is invalid.".to_string())?;
    let mut available_slots = max_parallel.saturating_sub(running_workers);
    let mut ready_workers = 0usize;
    let mut blocked_steps = 0usize;
    let mut waiting_steps = 0usize;
    let mut projected_steps = Vec::with_capacity(steps.len());

    for (step, step_key) in steps.iter().zip(&step_keys) {
        let title = bounded(
            step.get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected plan step title is invalid.".to_string())?,
            "Mission step title",
            400,
        )?;
        let kind = bounded(
            step.get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| "Selected plan step kind is invalid.".to_string())?,
            "Mission step kind",
            80,
        )?;
        let dependencies = step
            .get("dependsOnStepKeys")
            .and_then(Value::as_array)
            .ok_or_else(|| "Selected plan dependencies are invalid.".to_string())?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "Selected plan dependency is invalid.".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if dependencies
            .iter()
            .any(|dependency| !base_states.contains_key(*dependency))
        {
            return Err("Selected plan dependency is unavailable.".into());
        }

        let base_state = base_states.get(step_key).copied().unwrap_or("pending");
        let (state, detail) = if terminal_run && !matches!(base_state, "completed" | "partial") {
            (
                if run_status == "cancelled" {
                    "cancelled"
                } else {
                    "blocked"
                },
                "The run ended before this step completed.",
            )
        } else if base_state != "pending" {
            (
                base_state,
                match base_state {
                    "running" => "Work is in progress.",
                    "waiting" => "Work is waiting at a durable boundary.",
                    "completed" => "The durable output is complete.",
                    "partial" => "The deterministic aggregation retained partial output.",
                    "failed" => "The worker ended with a durable failure.",
                    _ => "The durable state is recorded.",
                },
            )
        } else {
            let dependency_state = if dependencies.is_empty() {
                "ready"
            } else if dependencies.len() == 1 {
                match base_states.get(dependencies[0]).copied() {
                    Some("completed") => "ready",
                    Some("failed" | "partial") => "blocked",
                    _ => "waiting",
                }
            } else {
                let revision_id = lifecycle
                    .current_revision
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Selected plan revision is invalid.".to_string())?;
                let join_key = coordination_join_key(revision_id, step_key);
                let resolution = journal.events.iter().find(|event| {
                    event.get("type").and_then(Value::as_str) == Some("join-resolved")
                        && event
                            .pointer("/payload/join/joinKey")
                            .and_then(Value::as_str)
                            == Some(join_key.as_str())
                });
                if let Some(resolution) = resolution {
                    if resolution
                        .pointer("/payload/join/status")
                        .and_then(Value::as_str)
                        == Some("satisfied")
                    {
                        "ready"
                    } else {
                        "blocked"
                    }
                } else {
                    "waiting"
                }
            };
            match dependency_state {
                "ready" if kind != "coordinate" && available_slots > 0 => {
                    available_slots -= 1;
                    ready_workers += 1;
                    ("ready", "Ready within the declared parallel-work limit.")
                }
                "ready" if kind != "coordinate" => {
                    waiting_steps += 1;
                    (
                        "waiting",
                        "Ready after a current worker leaves its bounded slot.",
                    )
                }
                "ready" => ("ready", "Ready for deterministic aggregation."),
                "blocked" => (
                    "blocked",
                    "Its declared dependencies cannot satisfy this step.",
                ),
                _ => {
                    waiting_steps += 1;
                    ("waiting", "Waiting for its declared dependencies.")
                }
            }
        };
        if matches!(state, "failed" | "blocked" | "partial") {
            blocked_steps += usize::from(state != "partial" || !terminal_run);
        }
        projected_steps.push(json!({
            "stepKey":step_key,
            "title":title,
            "kind":kind,
            "state":state,
            "detail":detail
        }));
    }

    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut tool_calls = 0i64;
    let mut duration_ms = 0i64;
    let mut usage_records = 0usize;
    let mut cost_observations = Vec::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("usage-recorded") {
            continue;
        }
        let usage = event
            .pointer("/payload/usage")
            .and_then(Value::as_object)
            .ok_or_else(|| "Stored Mission usage is invalid.".to_string())?;
        for (field, total) in [
            ("inputTokens", &mut input_tokens),
            ("outputTokens", &mut output_tokens),
            ("toolCalls", &mut tool_calls),
            ("durationMs", &mut duration_ms),
        ] {
            if let Some(value) = usage.get(field) {
                let value = value
                    .as_i64()
                    .filter(|value| *value >= 0)
                    .ok_or_else(|| "Stored Mission usage is invalid.".to_string())?;
                *total = total
                    .checked_add(value)
                    .ok_or_else(|| "Stored Mission usage exceeds safe bounds.".to_string())?;
            }
        }
        let costs = usage
            .get("costs")
            .and_then(Value::as_array)
            .ok_or_else(|| "Stored Mission costs are invalid.".to_string())?;
        if cost_observations.len() + costs.len() > 64 {
            return Err("Stored Mission costs exceed safe bounds.".into());
        }
        cost_observations.extend(
            costs
                .iter()
                .map(safe_cost_observation)
                .collect::<Result<Vec<_>, _>>()?,
        );
        usage_records += 1;
    }

    let criteria = lifecycle
        .mission
        .pointer("/acceptance/criteria")
        .and_then(Value::as_array)
        .ok_or_else(|| "Mission acceptance criteria are invalid.".to_string())?;
    if criteria.len() > 128 {
        return Err("Mission acceptance criteria exceed safe bounds.".into());
    }
    let terminal_acceptance = journal
        .run
        .pointer("/terminalResult/acceptance")
        .and_then(Value::as_array);
    let mut evaluations = BTreeMap::<String, (&str, usize, Option<&str>)>::new();
    for event in &journal.events {
        if event.get("type").and_then(Value::as_str) != Some("evaluation-recorded") {
            continue;
        }
        for criterion in event
            .pointer("/payload/evaluation/criteria")
            .and_then(Value::as_array)
            .ok_or_else(|| "Stored Mission evaluation is invalid.".to_string())?
        {
            let key = criterion
                .get("criterionKey")
                .and_then(Value::as_str)
                .ok_or_else(|| "Stored Mission evaluation criterion is invalid.".to_string())?;
            let status = match criterion.get("passed").and_then(Value::as_bool) {
                Some(true) => "met",
                Some(false) => "not-met",
                None => "not-evaluated",
            };
            let evidence_count = criterion
                .get("evidenceRefs")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let summary = criterion.get("summary").and_then(Value::as_str);
            if evaluations
                .insert(key.to_string(), (status, evidence_count, summary))
                .is_some()
            {
                return Err("Mission evaluation criteria are ambiguous.".into());
            }
        }
    }
    let mut projected_acceptance = Vec::with_capacity(criteria.len());
    let mut criterion_keys = BTreeSet::new();
    for criterion in criteria {
        let key = bounded(
            criterion
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "Mission acceptance criterion is invalid.".to_string())?,
            "Mission acceptance criterion",
            160,
        )?;
        if !criterion_keys.insert(key.clone()) {
            return Err("Mission acceptance criteria are ambiguous.".into());
        }
        let description = bounded(
            criterion
                .get("description")
                .and_then(Value::as_str)
                .ok_or_else(|| "Mission acceptance description is invalid.".to_string())?,
            "Mission acceptance description",
            2_000,
        )?;
        let terminal = terminal_acceptance.and_then(|entries| {
            entries.iter().find(|entry| {
                entry.get("criterionKey").and_then(Value::as_str) == Some(key.as_str())
            })
        });
        let status = terminal
            .and_then(|entry| entry.get("status"))
            .and_then(Value::as_str)
            .or_else(|| evaluations.get(&key).map(|(status, _, _)| *status))
            .unwrap_or("not-evaluated");
        if !matches!(
            status,
            "met" | "partially-met" | "not-met" | "not-evaluated"
        ) {
            return Err("Mission acceptance status is invalid.".into());
        }
        let evidence_count = terminal
            .and_then(|entry| entry.get("evidenceRefs"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .or_else(|| evaluations.get(&key).map(|(_, count, _)| *count))
            .unwrap_or(0);
        if evidence_count > 128 {
            return Err("Mission acceptance evidence exceeds safe bounds.".into());
        }
        let summary = terminal
            .and_then(|entry| entry.get("summary"))
            .and_then(Value::as_str)
            .or_else(|| evaluations.get(&key).and_then(|(_, _, summary)| *summary))
            .map(|summary| bounded(summary, "Mission acceptance summary", 2_000))
            .transpose()?;
        let evaluator = criterion
            .get("evaluator")
            .and_then(Value::as_str)
            .filter(|evaluator| matches!(*evaluator, "policy" | "human" | "worker" | "external"))
            .ok_or_else(|| "Mission acceptance evaluator is invalid.".to_string())?;
        projected_acceptance.push(json!({
            "criterionKey":key,
            "description":description,
            "required":criterion.get("required").and_then(Value::as_bool).unwrap_or(false),
            "evaluator":evaluator,
            "status":status,
            "evidenceCount":evidence_count,
            "summary":summary
        }));
    }

    let completed_steps = projected_steps
        .iter()
        .filter(|step| step.get("state").and_then(Value::as_str) == Some("completed"))
        .count();
    let state = if run_status == "cancelled" {
        "cancelled"
    } else if terminal_run {
        "complete"
    } else if blocked_steps > 0 {
        "blocked"
    } else if running_workers > 0 {
        "running"
    } else if ready_workers > 0
        || projected_steps
            .iter()
            .any(|step| step.get("state").and_then(Value::as_str) == Some("ready"))
    {
        "ready"
    } else {
        "waiting"
    };
    let summary = match state {
        "complete" => "Mission work has reached a durable terminal result.",
        "cancelled" => "Mission work stopped with a durable cancellation.",
        "blocked" => "Mission work needs a declared failure or dependency decision.",
        "running" => "Mission work is progressing within its declared limits.",
        "ready" => "Mission work has a step ready to continue.",
        _ => "Mission work is waiting at a declared boundary.",
    };
    let next_action = match state {
        "complete" | "cancelled" => "No automatic work remains.",
        "blocked" => "Review the blocked step before continuing.",
        "running" => "Wait for current bounded work to settle.",
        "ready" => "Continue the next ready step.",
        _ => "Wait for the declared dependency or human response.",
    };
    Ok(json!({
        "version":1,
        "state":state,
        "summary":summary,
        "runStatus":run_status,
        "completedSteps":completed_steps,
        "totalSteps":steps.len(),
        "runningWorkers":running_workers,
        "readyWorkers":ready_workers,
        "waitingSteps":waiting_steps,
        "blockedSteps":blocked_steps,
        "steps":projected_steps,
        "usage":{
            "records":usage_records,
            "inputTokens":input_tokens,
            "outputTokens":output_tokens,
            "toolCalls":tool_calls,
            "durationMs":duration_ms,
            "costObservations":cost_observations
        },
        "budget":safe_budget_projection(&journal.run)?,
        "acceptance":projected_acceptance,
        "nextAction":next_action
    }))
}

#[tauri::command]
pub fn mission_coordination_progress_read(run_id: String) -> Result<Value, String> {
    let run_id = bounded(&run_id, "Mission run", 160)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| {
            let authorized = authorized_run_for_read(tx, store, &run_id)?;
            mission_progress_projection(&authorized.lifecycle, &authorized.journal)
                .map_err(crate::store::StoreError::Invalid)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_advance(run_id: String) -> Result<Value, String> {
    let run_id = bounded(&run_id, "Mission run", 160)?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let mut appended_event_ids = Vec::new();
            for _ in 0..64 {
                let authorized = authorized_run(tx, store, &run_id)?;
                if let Some((join_key, join)) =
                    next_automatic_join_resolution(&authorized.journal)
                        .map_err(crate::store::StoreError::Invalid)?
                {
                    let (event_id, event_key) =
                        automatic_coordination_identity(&run_id, "join-resolved", &join_key);
                    if authorized.journal.events.iter().any(|event| {
                        event.get("idempotencyKey").and_then(Value::as_str)
                            == Some(event_key.as_str())
                    }) {
                        return Err(crate::store::StoreError::Invalid(
                            "Automatic Mission join replay no longer matches its durable fact."
                                .into(),
                        ));
                    }
                    let at = now();
                    append_event(
                        tx,
                        store,
                        &authorized,
                        &event_id,
                        "join-resolved",
                        &event_key,
                        json!({"join":join}),
                        &at,
                    )?;
                    appended_event_ids.push(event_id);
                    continue;
                }
                if let Some((step_key, aggregation)) =
                    next_automatic_aggregation(&authorized.lifecycle, &authorized.journal)
                        .map_err(crate::store::StoreError::Invalid)?
                {
                    let (event_id, event_key) = automatic_coordination_identity(
                        &run_id,
                        "aggregation-recorded",
                        &step_key,
                    );
                    if authorized.journal.events.iter().any(|event| {
                        event.get("idempotencyKey").and_then(Value::as_str)
                            == Some(event_key.as_str())
                    }) {
                        return Err(crate::store::StoreError::Invalid(
                            "Automatic Mission aggregation replay no longer matches its durable fact."
                                .into(),
                        ));
                    }
                    let at = now();
                    append_event(
                        tx,
                        store,
                        &authorized,
                        &event_id,
                        "aggregation-recorded",
                        &event_key,
                        json!({"aggregation":aggregation}),
                        &at,
                    )?;
                    appended_event_ids.push(event_id);
                    continue;
                }
                let progress =
                    mission_progress_projection(&authorized.lifecycle, &authorized.journal)
                        .map_err(crate::store::StoreError::Invalid)?;
                return Ok(json!({
                    "journal":authorized.journal,
                    "progress":progress,
                    "appendedEventIds":appended_event_ids
                }));
            }
            Err(crate::store::StoreError::Invalid(
                "Automatic Mission coordination exceeded its bounded advance limit.".into(),
            ))
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_join_open(
    input: MissionJoinOpenInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &input.run_id)?;
            let event_key = format!(
                "coordination-join-open:{}",
                bounded(&input.idempotency_key, "Join idempotency key", 200)
                    .map_err(crate::store::StoreError::Invalid)?
            );
            if let Some(existing) = authorized.journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                let worker_ids = exact_dependency_workers(
                    &authorized.lifecycle,
                    &authorized.journal,
                    &input.target_step_key,
                )
                .map_err(crate::store::StoreError::Invalid)?;
                let plan_revision_id = authorized
                    .lifecycle
                    .current_revision
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        crate::store::StoreError::Invalid(
                            "Selected plan revision is invalid.".into(),
                        )
                    })?;
                let expected_join_key =
                    coordination_join_key(plan_revision_id, &input.target_step_key);
                let join = existing.pointer("/payload/join");
                if existing.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
                    && existing.get("type").and_then(Value::as_str) == Some("join-opened")
                    && join
                        .and_then(|value| value.get("joinKey"))
                        .and_then(Value::as_str)
                        == Some(expected_join_key.as_str())
                    && join
                        .and_then(|value| value.get("strategy"))
                        .and_then(Value::as_str)
                        == Some(input.strategy.as_str())
                    && join
                        .and_then(|value| value.get("allowFailedWorkers"))
                        .and_then(Value::as_bool)
                        == Some(input.allow_failed_workers)
                    && join
                        .and_then(|value| value.get("quorum"))
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        == input.quorum
                    && join
                        .and_then(|value| value.get("deadline"))
                        .and_then(Value::as_str)
                        == input.deadline.as_deref()
                    && join
                        .and_then(|value| value.get("workerIds"))
                        .and_then(Value::as_array)
                        .is_some_and(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .eq(worker_ids.iter().map(String::as_str))
                        })
                {
                    return Ok(authorized.journal);
                }
                return Err(crate::store::StoreError::Invalid(
                    "Join idempotency key already represents another declaration.".into(),
                ));
            }
            validate_head(
                &authorized.journal,
                input.expected_run_revision,
                input.expected_last_sequence,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.run_id, "Mission run", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.target_step_key, "Join target step", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.event_id, "Join event", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            let worker_ids = exact_dependency_workers(
                &authorized.lifecycle,
                &authorized.journal,
                &input.target_step_key,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            let plan_revision_id = authorized
                .lifecycle
                .current_revision
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid("Selected plan revision is invalid.".into())
                })?;
            let join_key = coordination_join_key(plan_revision_id, &input.target_step_key);
            if authorized.journal.events.iter().any(|event| {
                matches!(
                    event.get("type").and_then(Value::as_str),
                    Some("join-opened" | "join-resolved")
                ) && event
                    .pointer("/payload/join/joinKey")
                    .and_then(Value::as_str)
                    == Some(join_key.as_str())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "This plan dependency join is already declared.".into(),
                ));
            }
            if !matches!(input.strategy.as_str(), "all" | "any" | "quorum")
                || (input.strategy == "quorum"
                    && input
                        .quorum
                        .is_none_or(|value| value == 0 || value > worker_ids.len()))
                || (input.strategy != "quorum" && input.quorum.is_some())
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency join policy is invalid.".into(),
                ));
            }
            let (completed, failed) = terminal_workers(&authorized.journal);
            if worker_ids
                .iter()
                .any(|worker| completed.contains(worker) || failed.contains(worker))
            {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency joins must be declared before worker outcomes are known."
                        .into(),
                ));
            }
            if input.deadline.as_deref().is_some_and(|deadline| {
                DateTime::parse_from_rfc3339(deadline)
                    .ok()
                    .is_none_or(|deadline| deadline <= Utc::now())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency join deadline is invalid.".into(),
                ));
            }
            let at = now();
            append_event(
                tx,
                store,
                &authorized,
                &input.event_id,
                "join-opened",
                &event_key,
                json!({"join":{
                    "joinKey":join_key,"status":"open","strategy":input.strategy,
                    "workerIds":worker_ids,"quorum":input.quorum,
                    "allowFailedWorkers":input.allow_failed_workers,"deadline":input.deadline,
                    "satisfiedWorkerIds":[],"failedWorkerIds":[]
                }}),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_join_resolve(
    input: MissionJoinResolveInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &input.run_id)?;
            let event_key = format!(
                "coordination-join-resolve:{}",
                bounded(&input.idempotency_key, "Join idempotency key", 200)
                    .map_err(crate::store::StoreError::Invalid)?
            );
            if let Some(existing) = authorized.journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                if existing.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
                    && existing.get("type").and_then(Value::as_str) == Some("join-resolved")
                    && existing
                        .pointer("/payload/join/joinKey")
                        .and_then(Value::as_str)
                        == Some(input.join_key.as_str())
                {
                    return Ok(authorized.journal);
                }
                return Err(crate::store::StoreError::Invalid(
                    "Join idempotency key already represents another resolution.".into(),
                ));
            }
            validate_head(
                &authorized.journal,
                input.expected_run_revision,
                input.expected_last_sequence,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.run_id, "Mission run", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.join_key, "Mission join", 96)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.event_id, "Join event", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            if authorized.journal.events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("join-resolved")
                    && event
                        .pointer("/payload/join/joinKey")
                        .and_then(Value::as_str)
                        == Some(input.join_key.as_str())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "Mission dependency join is already resolved.".into(),
                ));
            }
            let open = authorized
                .journal
                .events
                .iter()
                .find(|event| {
                    event.get("type").and_then(Value::as_str) == Some("join-opened")
                        && event
                            .pointer("/payload/join/joinKey")
                            .and_then(Value::as_str)
                            == Some(input.join_key.as_str())
                })
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join declaration is unavailable.".into(),
                    )
                })?;
            let join = open
                .pointer("/payload/join")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join declaration is invalid.".into(),
                    )
                })?;
            let strategy = join.get("strategy").and_then(Value::as_str).unwrap_or("");
            let quorum = join
                .get("quorum")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            let allow_failed = join
                .get("allowFailedWorkers")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let worker_ids = join
                .get("workerIds")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join workers are invalid.".into(),
                    )
                })?
                .iter()
                .map(|value| value.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    crate::store::StoreError::Invalid(
                        "Mission dependency join workers are invalid.".into(),
                    )
                })?;
            let deadline_elapsed = join
                .get("deadline")
                .and_then(Value::as_str)
                .and_then(|deadline| DateTime::parse_from_rfc3339(deadline).ok())
                .is_some_and(|deadline| deadline <= Utc::now());
            let (completed, failed) = terminal_workers(&authorized.journal);
            let status = resolve_status(
                strategy,
                quorum,
                allow_failed,
                &worker_ids,
                &completed,
                &failed,
                deadline_elapsed,
                matches!(
                    authorized.journal.run.get("status").and_then(Value::as_str),
                    Some("cancelling" | "cancelled")
                ),
            )
            .ok_or_else(|| {
                crate::store::StoreError::Invalid(
                    "Mission dependency join is still waiting for worker outcomes.".into(),
                )
            })?;
            let satisfied = worker_ids
                .iter()
                .filter(|worker| completed.contains(*worker))
                .cloned()
                .collect::<Vec<_>>();
            let failed = worker_ids
                .iter()
                .filter(|worker| failed.contains(*worker))
                .cloned()
                .collect::<Vec<_>>();
            let at = now();
            append_event(
                tx,
                store,
                &authorized,
                &input.event_id,
                "join-resolved",
                &event_key,
                json!({"join":{
                    "joinKey":input.join_key,"status":status,"strategy":strategy,
                    "workerIds":worker_ids,"quorum":quorum,
                    "allowFailedWorkers":allow_failed,"deadline":join.get("deadline"),
                    "satisfiedWorkerIds":satisfied,"failedWorkerIds":failed
                }}),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mission_coordination_aggregation_record(
    input: MissionAggregationRecordInput,
) -> Result<mission_run::MissionRunJournalRow, String> {
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            let authorized = authorized_run(tx, store, &input.run_id)?;
            let event_key = format!(
                "coordination-aggregation:{}",
                bounded(&input.idempotency_key, "Aggregation idempotency key", 200)
                    .map_err(crate::store::StoreError::Invalid)?
            );
            let aggregation = deterministic_aggregation_receipt(
                &authorized.lifecycle,
                &authorized.journal,
                &input.target_step_key,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            if let Some(existing) = authorized.journal.events.iter().find(|event| {
                event.get("idempotencyKey").and_then(Value::as_str) == Some(event_key.as_str())
            }) {
                if existing.get("id").and_then(Value::as_str) == Some(input.event_id.as_str())
                    && existing.get("type").and_then(Value::as_str) == Some("aggregation-recorded")
                    && existing.pointer("/payload/aggregation") == Some(&aggregation)
                {
                    return Ok(authorized.journal);
                }
                return Err(crate::store::StoreError::Invalid(
                    "Aggregation idempotency key already represents another receipt.".into(),
                ));
            }
            validate_head(
                &authorized.journal,
                input.expected_run_revision,
                input.expected_last_sequence,
            )
            .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.run_id, "Mission run", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.target_step_key, "Aggregation target step", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            bounded(&input.event_id, "Aggregation event", 160)
                .map_err(crate::store::StoreError::Invalid)?;
            if authorized.journal.events.iter().any(|event| {
                event.get("type").and_then(Value::as_str) == Some("aggregation-recorded")
                    && event
                        .pointer("/payload/aggregation/stepKey")
                        .and_then(Value::as_str)
                        == Some(input.target_step_key.as_str())
            }) {
                return Err(crate::store::StoreError::Invalid(
                    "This deterministic aggregation is already recorded.".into(),
                ));
            }
            let at = now();
            append_event(
                tx,
                store,
                &authorized,
                &input.event_id,
                "aggregation-recorded",
                &event_key,
                json!({"aggregation":aggregation}),
                &at,
            )
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn has_satisfied_dependency_join(
    journal: &mission_run::MissionRunJournalRow,
    plan_revision_id: &str,
    target_step_key: &str,
    dependency_worker_ids: &[String],
) -> bool {
    let join_key = coordination_join_key(plan_revision_id, target_step_key);
    journal.events.iter().any(|event| {
        event.get("type").and_then(Value::as_str) == Some("join-resolved")
            && event
                .pointer("/payload/join/joinKey")
                .and_then(Value::as_str)
                == Some(join_key.as_str())
            && event
                .pointer("/payload/join/status")
                .and_then(Value::as_str)
                == Some("satisfied")
            && event
                .pointer("/payload/join/workerIds")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .eq(dependency_worker_ids.iter().map(String::as_str))
                })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_any_and_quorum_resolve_only_from_durable_terminal_facts() {
        let workers = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let completed = BTreeSet::from(["a".to_string()]);
        let failed = BTreeSet::from(["b".to_string()]);
        assert_eq!(
            resolve_status(
                "any",
                None,
                false,
                &workers,
                &completed,
                &BTreeSet::new(),
                false,
                false
            ),
            Some("satisfied")
        );
        assert_eq!(
            resolve_status("all", None, false, &workers, &completed, &failed, false, false),
            Some("cancelled")
        );
        assert_eq!(
            resolve_status(
                "quorum",
                Some(2),
                true,
                &workers,
                &completed,
                &failed,
                false,
                false
            ),
            Some("satisfied")
        );
        assert_eq!(
            resolve_status(
                "quorum",
                Some(3),
                true,
                &workers,
                &BTreeSet::new(),
                &BTreeSet::new(),
                false,
                false
            ),
            None
        );
        assert_eq!(
            resolve_status(
                "quorum",
                Some(3),
                true,
                &workers,
                &BTreeSet::new(),
                &BTreeSet::new(),
                true,
                false
            ),
            Some("timed-out")
        );
    }

    #[test]
    fn progress_projection_derives_ready_work_usage_and_terminal_acceptance() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({
                "acceptance":{"criteria":[{
                    "key":"both","description":"Both approaches are present.",
                    "required":true,"evaluator":"policy"
                }]}
            }),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-progress",
                "bounds":{"maxParallelSteps":2},
                "steps":[
                    {"key":"approach-a","kind":"compose","title":"Approach A","dependsOnStepKeys":[]},
                    {"key":"approach-b","kind":"compose","title":"Approach B","dependsOnStepKeys":[]},
                    {"key":"combine","kind":"coordinate","title":"Combine","dependsOnStepKeys":["approach-a","approach-b"]}
                ]
            }),
        };
        let join_key = coordination_join_key("revision-progress", "combine");
        let mut journal = mission_run::MissionRunJournalRow {
            run: json!({
                "status":"running",
                "budget":{"maxWorkers":2,"maxInputTokens":100,"maxOutputTokens":50,
                    "maxToolCalls":0,"maxDurationMs":1000,"maxAttempts":1}
            }),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-a","planStepKey":"approach-a"
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-b","planStepKey":"approach-b"
                }}}),
                json!({"type":"worker-started","payload":{"workerId":"worker-a"}}),
                json!({"type":"usage-recorded","payload":{"usage":{
                    "workerId":"worker-a","inputTokens":12,"outputTokens":3,
                    "toolCalls":0,"durationMs":1500,"costs":[]
                }}}),
                json!({"type":"worker-completed","payload":{
                    "workerId":"worker-a","outputs":[]
                }}),
                json!({"type":"join-opened","payload":{"join":{
                    "joinKey":join_key,"status":"open"
                }}}),
            ],
        };
        let progress = mission_progress_projection(&lifecycle, &journal).unwrap();
        assert_eq!(progress.get("state").and_then(Value::as_str), Some("ready"));
        assert_eq!(
            progress.pointer("/steps/0/state").and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(
            progress.pointer("/steps/1/state").and_then(Value::as_str),
            Some("ready")
        );
        assert_eq!(
            progress.pointer("/steps/2/state").and_then(Value::as_str),
            Some("waiting")
        );
        assert_eq!(
            progress
                .pointer("/usage/inputTokens")
                .and_then(Value::as_i64),
            Some(12)
        );
        assert_eq!(
            progress
                .pointer("/usage/durationMs")
                .and_then(Value::as_i64),
            Some(1500)
        );

        journal.run["status"] = json!("completed");
        journal.run["terminalResult"] = json!({
            "acceptance":[{
                "criterionKey":"both","status":"met","evidenceRefs":["output:a","output:b"],
                "summary":"Both exact outputs were joined."
            }]
        });
        journal.events.extend([
            json!({"type":"worker-started","payload":{"workerId":"worker-b"}}),
            json!({"type":"worker-completed","payload":{
                "workerId":"worker-b","outputs":[]
            }}),
            json!({"type":"join-resolved","payload":{"join":{
                "joinKey":coordination_join_key("revision-progress", "combine"),
                "status":"satisfied"
            }}}),
            json!({"type":"aggregation-recorded","payload":{"aggregation":{
                "stepKey":"combine","status":"complete"
            }}}),
        ]);
        let completed = mission_progress_projection(&lifecycle, &journal).unwrap();
        assert_eq!(
            completed.get("state").and_then(Value::as_str),
            Some("complete")
        );
        assert_eq!(
            completed.get("completedSteps").and_then(Value::as_u64),
            Some(3)
        );
        assert_eq!(
            completed
                .pointer("/acceptance/0/status")
                .and_then(Value::as_str),
            Some("met")
        );
        assert_eq!(
            completed
                .pointer("/acceptance/0/evidenceCount")
                .and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn progress_projection_fails_closed_on_unknown_worker_activity() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({"acceptance":{"criteria":[]}}),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-progress",
                "bounds":{"maxParallelSteps":1},
                "steps":[{"key":"draft","kind":"compose","title":"Draft","dependsOnStepKeys":[]}]
            }),
        };
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"running","budget":{"maxWorkers":1}}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-draft","planStepKey":"draft"
                }}}),
                json!({"type":"worker-started","payload":{"workerId":"substituted-worker"}}),
            ],
        };
        assert!(mission_progress_projection(&lifecycle, &journal)
            .unwrap_err()
            .contains("unknown worker"));
    }

    #[test]
    fn progress_cost_projection_keeps_only_bounded_contract_fields() {
        let projected = safe_cost_observation(&json!({
            "amount":{"amount":"0.000045","currencyCode":"USD"},
            "provenance":"fable-calculated",
            "pricingReference":"official-price|reviewed=2026-07-13",
            "secret":"must-not-cross"
        }))
        .unwrap();
        assert_eq!(
            projected,
            json!({
                "amount":{"amount":"0.000045","currencyCode":"USD"},
                "provenance":"fable-calculated",
                "pricingReference":"official-price|reviewed=2026-07-13"
            })
        );
        assert!(safe_cost_observation(&json!({
            "amount":{"amount":"0.1","currencyCode":"usd"},
            "provenance":"invented"
        }))
        .is_err());
    }

    #[test]
    fn automatic_advancement_resolves_only_declared_terminal_join_facts() {
        let join = "join-general";
        let waiting = mission_run::MissionRunJournalRow {
            run: json!({"status":"running"}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-a","planStepKey":"a"
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-b","planStepKey":"b"
                }}}),
                json!({"type":"join-opened","payload":{"join":{
                    "joinKey":join,"status":"open","strategy":"all",
                    "workerIds":["worker-a","worker-b"],"quorum":null,
                    "allowFailedWorkers":false,"deadline":null,
                    "satisfiedWorkerIds":[],"failedWorkerIds":[]
                }}}),
                json!({"type":"worker-completed","payload":{"workerId":"worker-a","outputs":[]}}),
            ],
        };
        assert!(next_automatic_join_resolution(&waiting).unwrap().is_none());

        let mut complete = waiting;
        complete.events.push(
            json!({"type":"worker-completed","payload":{"workerId":"worker-b","outputs":[]}}),
        );
        let (join_key, resolution) = next_automatic_join_resolution(&complete)
            .unwrap()
            .expect("all declared workers are terminal");
        assert_eq!(join_key, join);
        assert_eq!(
            resolution.get("status").and_then(Value::as_str),
            Some("satisfied")
        );
        assert_eq!(
            resolution
                .get("satisfiedWorkerIds")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );

        complete.events.push(
            json!({"type":"worker-completed","payload":{"workerId":"worker-b","outputs":[]}}),
        );
        assert!(next_automatic_join_resolution(&complete)
            .unwrap_err()
            .contains("terminal facts are ambiguous"));
    }

    #[test]
    fn automatic_advancement_materializes_only_a_ready_coordinate_step() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({}),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-auto",
                "steps":[
                    {"key":"a","kind":"produce","dependsOnStepKeys":[]},
                    {"key":"b","kind":"produce","dependsOnStepKeys":[]},
                    {"key":"combine","kind":"coordinate","dependsOnStepKeys":["a","b"]}
                ]
            }),
        };
        let join_key = coordination_join_key("revision-auto", "combine");
        let journal = mission_run::MissionRunJournalRow {
            run: json!({"status":"running"}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-a","planStepKey":"a",
                    "outputContract":{"slots":[{"key":"output-a","required":true}]}
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-b","planStepKey":"b",
                    "outputContract":{"slots":[{"key":"output-b","required":true}]}
                }}}),
                json!({"type":"worker-completed","payload":{"workerId":"worker-a","outputs":[{
                    "key":"output-a","summary":"First output.","valueReference":"mission-output:a"
                }]}}),
                json!({"type":"worker-completed","payload":{"workerId":"worker-b","outputs":[{
                    "key":"output-b","summary":"Second output.","valueReference":"mission-output:b"
                }]}}),
                json!({"type":"join-opened","payload":{"join":{
                    "joinKey":join_key,"status":"open","strategy":"all",
                    "workerIds":["worker-a","worker-b"],"quorum":null,
                    "allowFailedWorkers":false,"deadline":null,
                    "satisfiedWorkerIds":[],"failedWorkerIds":[]
                }}}),
                json!({"type":"join-resolved","payload":{"join":{
                    "joinKey":coordination_join_key("revision-auto", "combine"),
                    "status":"satisfied","strategy":"all",
                    "workerIds":["worker-a","worker-b"],"quorum":null,
                    "allowFailedWorkers":false,"deadline":null,
                    "satisfiedWorkerIds":["worker-a","worker-b"],"failedWorkerIds":[]
                }}}),
            ],
        };
        let (step_key, aggregation) = next_automatic_aggregation(&lifecycle, &journal)
            .unwrap()
            .expect("satisfied terminal coordinate step");
        assert_eq!(step_key, "combine");
        assert_eq!(
            aggregation.get("status").and_then(Value::as_str),
            Some("complete")
        );
        assert_eq!(
            aggregation
                .get("producedOutputs")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(2)
        );
        let identity = automatic_coordination_identity("run-1", "join-resolved", "join-1");
        assert_eq!(
            identity,
            automatic_coordination_identity("run-1", "join-resolved", "join-1")
        );
        assert_ne!(
            identity,
            automatic_coordination_identity("run-1", "aggregation-recorded", "join-1")
        );
    }

    #[test]
    fn satisfied_join_must_match_exact_plan_target_and_worker_order() {
        let revision = "plan-revision-1";
        let target = "combine";
        let workers = vec!["worker-a".to_string(), "worker-b".to_string()];
        let key = coordination_join_key(revision, target);
        let journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![json!({
                "type":"join-resolved","payload":{"join":{
                    "joinKey":key,"status":"satisfied","strategy":"any",
                    "workerIds":workers,"allowFailedWorkers":false,
                    "satisfiedWorkerIds":["worker-a"],"failedWorkerIds":[]
                }}
            })],
        };
        assert!(has_satisfied_dependency_join(
            &journal,
            revision,
            target,
            &["worker-a".into(), "worker-b".into()]
        ));
        assert!(!has_satisfied_dependency_join(
            &journal,
            revision,
            target,
            &["worker-b".into(), "worker-a".into()]
        ));
        assert!(!has_satisfied_dependency_join(
            &journal,
            revision,
            "another-target",
            &["worker-a".into(), "worker-b".into()]
        ));
    }

    #[test]
    fn aggregation_is_derived_in_plan_order_from_reference_bearing_terminal_outputs() {
        let lifecycle = mission_plan::MissionPlanLifecycleRow {
            mission: json!({}),
            plan: json!({}),
            current_revision: json!({
                "id":"revision-1",
                "steps":[
                    {"key":"research","kind":"investigate","dependsOnStepKeys":[]},
                    {"key":"draft","kind":"compose","dependsOnStepKeys":[]},
                    {"key":"combine","kind":"coordinate","dependsOnStepKeys":["research","draft"]}
                ]
            }),
        };
        let join_key = coordination_join_key("revision-1", "combine");
        let journal = mission_run::MissionRunJournalRow {
            run: json!({}),
            events: vec![
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-research","planStepKey":"research",
                    "outputContract":{"slots":[{"key":"evidence","required":true}]}
                }}}),
                json!({"type":"worker-created","payload":{"worker":{
                    "id":"worker-draft","planStepKey":"draft",
                    "outputContract":{"slots":[{"key":"draft","required":true}]}
                }}}),
                json!({"type":"worker-completed","payload":{
                    "workerId":"worker-draft","outputs":[{
                        "key":"draft","summary":"Draft output.",
                        "valueReference":"mission-output:v1:draft"
                    }]
                }}),
                json!({"type":"worker-completed","payload":{
                    "workerId":"worker-research","outputs":[{
                        "key":"evidence","summary":"Evidence output.",
                        "artifactId":"artifact-1","artifactVersionId":"version-1"
                    }]
                }}),
                json!({"type":"join-resolved","payload":{"join":{
                    "joinKey":join_key,"status":"satisfied",
                    "workerIds":["worker-research","worker-draft"]
                }}}),
            ],
        };
        let receipt = deterministic_aggregation_receipt(&lifecycle, &journal, "combine").unwrap();
        assert_eq!(receipt["status"], "complete");
        assert_eq!(receipt["inputs"][0]["sourceStepKey"], "research");
        assert_eq!(receipt["producedOutputs"][0]["key"], "evidence");
        assert_eq!(receipt["producedOutputs"][1]["key"], "draft");
        assert_eq!(receipt["missingRequiredOutputKeys"], json!([]));

        let mut without_join = mission_run::MissionRunJournalRow {
            run: journal.run.clone(),
            events: journal.events.clone(),
        };
        without_join.events.pop();
        assert!(deterministic_aggregation_receipt(&lifecycle, &without_join, "combine").is_err());

        let mut content_only = journal;
        content_only.events[3]["payload"]["outputs"][0]
            .as_object_mut()
            .unwrap()
            .remove("artifactId");
        content_only.events[3]["payload"]["outputs"][0]
            .as_object_mut()
            .unwrap()
            .remove("artifactVersionId");
        assert!(deterministic_aggregation_receipt(&lifecycle, &content_only, "combine").is_err());
    }
}

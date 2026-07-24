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
        || matches!(
            journal.run.get("status").and_then(Value::as_str),
            Some("completed" | "partially-completed" | "failed" | "cancelled")
        )
    {
        return Err(crate::store::StoreError::Invalid(
            "Mission coordination is not bound to the selected live plan.".into(),
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
}

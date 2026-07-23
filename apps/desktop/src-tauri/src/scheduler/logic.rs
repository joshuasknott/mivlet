//! Pure scheduler invariants: input normalization, queue transitions, leases,
//! retries, and occurrence deduplication. This module deliberately has no
//! Tauri or persistence dependency so its rules can be tested with fake clocks.

use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, SecondsFormat, Utc};

use crate::models::{
    JobAttempt, RetryPolicy, ScheduledExecutionRoute, ScheduledJob, SchedulerQueueEntry,
    SchedulerStore, JOB_ATTEMPT_STATUSES, MAX_JOB_ATTEMPTS, MAX_OCCURRENCE_LEDGER,
    MISSED_RUN_POLICIES, SCHEDULED_JOB_STATUSES, SCHEDULER_LEASE_MS, SCHEDULER_STORE_VERSION,
};
use crate::paths::{normalize_spaces, truncate_characters};
use crate::store::repos::scope::normalize_id;

pub(crate) fn empty_store(instance_id: &str) -> SchedulerStore {
    SchedulerStore {
        schema_version: SCHEDULER_STORE_VERSION,
        jobs: Vec::new(),
        queue: Vec::new(),
        instance_id: instance_id.to_string(),
        updated_at: now_iso(),
        occurrence_ledger: Vec::new(),
        occurrence_index: std::collections::HashSet::new(),
    }
}

pub(crate) fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn iso_from_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

pub(crate) fn parse_ms(value: &str) -> i64 {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return 0;
    }
    DateTime::parse_from_rfc3339(trimmed)
        .map(|value| value.timestamp_millis())
        .or_else(|_| trimmed.parse::<i64>())
        .unwrap_or(i64::MAX)
}

pub(crate) fn canonical_timestamp(value: &str) -> Result<String, String> {
    let parsed = DateTime::parse_from_rfc3339(value.trim())
        .map_err(|_| "Scheduler timestamps must be RFC 3339 strings.".to_string())?;
    Ok(parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

pub(crate) fn fresh_lease_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("lease-{nanos:x}")
}

pub(crate) fn normalize_route(
    route: ScheduledExecutionRoute,
) -> Result<ScheduledExecutionRoute, String> {
    let policy = normalize_spaces(&route.policy);
    if !matches!(policy.as_str(), "pinned" | "current-default") {
        return Err(
            "Execution route policy must be \"pinned\" or \"current-default\".".to_string(),
        );
    }
    let permission_mode = normalize_spaces(&route.permission_mode);
    let permission_profile = route
        .permission_profile
        .as_deref()
        .map(normalize_spaces)
        .filter(|profile| !profile.is_empty());
    let (permission_mode, permission_profile) =
        crate::permission_policy::normalize_permission_route(
            &permission_mode,
            permission_profile.as_deref(),
        )?;
    Ok(ScheduledExecutionRoute {
        policy,
        backend_id: truncate_characters(&normalize_spaces(&route.backend_id), 160),
        model_id: truncate_characters(&normalize_spaces(&route.model_id), 160),
        permission_mode,
        permission_profile: Some(permission_profile),
    })
}

pub(crate) fn normalize_retry_policy(mut policy: RetryPolicy) -> RetryPolicy {
    policy.max_attempts = policy.max_attempts.clamp(1, MAX_JOB_ATTEMPTS as u32);
    policy.initial_backoff_ms = policy.initial_backoff_ms.clamp(1_000, 86_400_000);
    policy.backoff_multiplier = policy.backoff_multiplier.clamp(1.0, 10.0);
    policy.max_backoff_ms = policy
        .max_backoff_ms
        .clamp(policy.initial_backoff_ms, 7 * 86_400_000);
    policy
}

pub(crate) fn retry_backoff_ms(policy: &RetryPolicy, failed_attempts: u32) -> i64 {
    let multiplier = policy
        .backoff_multiplier
        .powi(failed_attempts.saturating_sub(1) as i32);
    ((policy.initial_backoff_ms as f64 * multiplier) as i64).min(policy.max_backoff_ms)
}

pub(crate) fn ensure_route_allows(
    route: &ScheduledExecutionRoute,
    effect: &str,
) -> Result<(), String> {
    crate::permission_policy::ensure_permission_allowed(
        &route.permission_mode,
        route.permission_profile.as_deref(),
        effect,
        "medium",
    )
    .map(|_| ())
}

pub(crate) fn normalize_job(mut job: ScheduledJob) -> Result<ScheduledJob, String> {
    job.workspace_id =
        normalize_id(&job.workspace_id, "Workspace").map_err(|error| error.to_string())?;
    job.project_id = job
        .project_id
        .map(|id| normalize_id(&id, "Project").map_err(|error| error.to_string()))
        .transpose()?;
    job.id = truncate_characters(&normalize_spaces(&job.id), 160);
    job.name = truncate_characters(&normalize_spaces(&job.name), 200);
    job.description = truncate_characters(&normalize_spaces(&job.description), 500);
    job.workflow_definition_id =
        truncate_characters(&normalize_spaces(&job.workflow_definition_id), 160);
    job.missed_run_policy = normalize_spaces(&job.missed_run_policy);
    job.status = normalize_spaces(&job.status);
    job.next_run_at = normalize_spaces(&job.next_run_at);
    job.last_run_at = normalize_spaces(&job.last_run_at);
    job.last_run_id = truncate_characters(&normalize_spaces(&job.last_run_id), 160);
    if let Some(route) = job.execution.take() {
        let route = normalize_route(route)?;
        ensure_route_allows(&route, "schedule-mutation")?;
        job.execution = Some(route);
    }
    job.retry_policy = normalize_retry_policy(job.retry_policy);

    if job.id.is_empty() || job.name.is_empty() || job.workflow_definition_id.is_empty() {
        return Err("Scheduled job needs id, name, and workflow id.".to_string());
    }
    if !SCHEDULED_JOB_STATUSES.contains(&job.status.as_str()) {
        return Err("Scheduled job status is not recognized.".to_string());
    }
    if !MISSED_RUN_POLICIES.contains(&job.missed_run_policy.as_str()) {
        return Err("Missed-run policy is not recognized.".to_string());
    }
    if job.schema_version != SCHEDULER_STORE_VERSION {
        return Err("Scheduled job schema version is not supported.".to_string());
    }
    let kind = job
        .trigger
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if !matches!(kind, "once" | "recurring") {
        return Err("Schedule trigger kind must be \"once\" or \"recurring\".".to_string());
    }
    Ok(job)
}

pub(crate) fn normalize_attempt(mut attempt: JobAttempt) -> Result<JobAttempt, String> {
    attempt.run_id = truncate_characters(&normalize_spaces(&attempt.run_id), 160);
    attempt.status = normalize_spaces(&attempt.status).to_ascii_lowercase();
    attempt.started_at = normalize_spaces(&attempt.started_at);
    if let Some(token) = attempt.lease_token.take() {
        attempt.lease_token = Some(normalize_spaces(&token));
    }
    if let Some(error) = attempt.error.take() {
        let redacted =
            crate::store::repos::connector_cache::redact_value(&serde_json::Value::String(error))
                .as_str()
                .unwrap_or("[redacted connector data]")
                .to_string();
        attempt.error = Some(truncate_characters(&normalize_spaces(&redacted), 500));
    }
    if attempt.run_id.is_empty() || attempt.started_at.is_empty() {
        return Err("Job attempt needs runId and startedAt.".to_string());
    }
    if !JOB_ATTEMPT_STATUSES.contains(&attempt.status.as_str()) {
        return Err("Job attempt status is not recognized.".to_string());
    }
    Ok(attempt)
}

pub(crate) fn delete_job_from_store(
    store: &mut SchedulerStore,
    workspace_id: &str,
    project_id: Option<&str>,
    job_id: &str,
) -> bool {
    let deleted = store.jobs.iter().any(|job| {
        job.id == job_id
            && job.workspace_id == workspace_id
            && job.project_id.as_deref() == project_id
    });
    if !deleted {
        return false;
    }
    store.jobs.retain(|job| {
        job.id != job_id
            || job.workspace_id != workspace_id
            || job.project_id.as_deref() != project_id
    });
    store.queue.retain(|entry| {
        entry.job_id != job_id
            || entry.workspace_id != workspace_id
            || entry.project_id.as_deref() != project_id
    });
    true
}

pub(crate) fn set_job_status_in_store(
    store: &mut SchedulerStore,
    workspace_id: &str,
    project_id: Option<&str>,
    job_id: &str,
    status: &str,
) -> bool {
    let mut updated = false;
    for job in &mut store.jobs {
        if job.id == job_id
            && job.workspace_id == workspace_id
            && job.project_id.as_deref() == project_id
        {
            job.status = status.to_string();
            updated = true;
        }
    }
    if !updated {
        return false;
    }
    if status != "active" {
        let now = now_iso();
        let mut remembered = Vec::new();
        for entry in &mut store.queue {
            if entry.job_id == job_id
                && entry.workspace_id == workspace_id
                && entry.project_id.as_deref() == project_id
                && !matches!(entry.state.as_str(), "done" | "dead" | "cancelled")
            {
                entry.attempts.push(JobAttempt {
                    run_id: entry.run_id.clone(),
                    status: "cancelled".to_string(),
                    attempt_number: entry.attempts.len() as u32 + 1,
                    started_at: now.clone(),
                    finished_at: Some(now.clone()),
                    error: None,
                    retryable: Some(false),
                    lease_token: None,
                });
                if entry.attempts.len() > MAX_JOB_ATTEMPTS {
                    let drop = entry.attempts.len() - MAX_JOB_ATTEMPTS;
                    entry.attempts.drain(0..drop);
                }
                entry.state = "cancelled".to_string();
                entry.lease_holder.clear();
                entry.lease_expires_at.clear();
                entry.lease_token.clear();
                remembered.push(entry.deduplication_key.clone());
            }
        }
        for key in remembered {
            remember_occurrence(store, &key);
        }
    }
    true
}

pub(crate) fn failed_count(entry: &SchedulerQueueEntry) -> u32 {
    entry
        .attempts
        .iter()
        .filter(|attempt| attempt.status == "failed")
        .count() as u32
}

pub(crate) fn accepts_attempt(entry: &SchedulerQueueEntry, attempt: &JobAttempt) -> bool {
    if matches!(entry.state.as_str(), "done" | "dead" | "cancelled") {
        return false;
    }
    match attempt.lease_token.as_deref() {
        Some(token) if !token.is_empty() => token == entry.lease_token,
        _ => true,
    }
}

pub(crate) fn index_occurrences(store: &mut SchedulerStore) {
    store.occurrence_index.clear();
    store
        .occurrence_index
        .reserve(store.occurrence_ledger.len());
    for key in &store.occurrence_ledger {
        store.occurrence_index.insert(key.clone());
    }
}

pub(crate) fn remember_occurrence(store: &mut SchedulerStore, key: &str) {
    if store.occurrence_index.contains(key) {
        return;
    }
    store.occurrence_index.insert(key.to_string());
    store.occurrence_ledger.insert(0, key.to_string());
    if store.occurrence_ledger.len() > MAX_OCCURRENCE_LEDGER {
        let drop = store.occurrence_ledger.len() - MAX_OCCURRENCE_LEDGER;
        let evicted = store.occurrence_ledger[store.occurrence_ledger.len() - drop..].to_vec();
        store
            .occurrence_ledger
            .truncate(store.occurrence_ledger.len() - drop);
        for key in evicted {
            store.occurrence_index.remove(&key);
        }
    }
}

pub(crate) fn recover_store_at(store: &mut SchedulerStore) {
    for entry in &mut store.queue {
        if entry.state == "leased" || entry.state == "running" {
            entry.state = "queued".to_string();
            entry.lease_holder.clear();
            entry.lease_expires_at.clear();
            entry.lease_token.clear();
        }
    }
}

pub(crate) fn apply_tick_logic(
    queue: &mut [SchedulerQueueEntry],
    now_ms: i64,
    instance: &str,
) -> (bool, Vec<SchedulerQueueEntry>) {
    let mut changed = false;
    let mut newly_leased = Vec::new();
    for entry in queue.iter_mut() {
        if !entry.lease_holder.is_empty() && parse_ms(&entry.lease_expires_at) <= now_ms {
            entry.lease_holder.clear();
            entry.lease_expires_at.clear();
            entry.lease_token.clear();
            if entry.state == "leased" || entry.state == "running" {
                entry.state = "queued".to_string();
            }
            changed = true;
        }
    }
    for entry in queue.iter_mut() {
        if entry.state != "queued" || parse_ms(&entry.scheduled_at) > now_ms {
            continue;
        }
        if !entry.available_at.is_empty() && parse_ms(&entry.available_at) > now_ms {
            continue;
        }
        if entry
            .execution
            .as_ref()
            .is_some_and(|route| ensure_route_allows(route, "schedule-execution").is_err())
        {
            entry.state = "dead".to_string();
            entry.last_error =
                "Permission profile no longer allows scheduled execution.".to_string();
            crate::action_history::Recorder::new(
                crate::action_history::categories::POLICY_BLOCK,
                "scheduler",
                &entry.job_id,
                "blocked",
            )
            .correlation(&entry.run_id)
            .error("permission-denied")
            .summary("Scheduled execution blocked by its captured permission profile.")
            .record();
            changed = true;
            continue;
        }
        entry.state = "leased".to_string();
        entry.lease_holder = instance.to_string();
        entry.lease_expires_at = iso_from_ms(now_ms + SCHEDULER_LEASE_MS);
        entry.lease_token = fresh_lease_token();
        newly_leased.push(entry.clone());
        changed = true;
    }
    (changed, newly_leased)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::repos::scope::DEFAULT_WORKSPACE_ID;

    fn entry() -> SchedulerQueueEntry {
        SchedulerQueueEntry {
            workspace_id: DEFAULT_WORKSPACE_ID.to_string(),
            project_id: None,
            authority: String::new(),
            visibility: String::new(),
            owner_member_id: None,
            created_by_internal_user_id: None,
            job_id: "job".to_string(),
            run_id: "run".to_string(),
            scheduled_at: "1970-01-01T00:00:00.000Z".to_string(),
            state: "queued".to_string(),
            lease_holder: String::new(),
            lease_expires_at: String::new(),
            attempts: Vec::new(),
            deduplication_key: "job:0".to_string(),
            lease_token: String::new(),
            available_at: String::new(),
            last_error: String::new(),
            execution: None,
            retry_policy: RetryPolicy::default(),
        }
    }

    #[test]
    fn tick_leases_once_then_requeues_only_after_expiry() {
        let mut entries = vec![entry()];
        assert_eq!(apply_tick_logic(&mut entries, 0, "one").1.len(), 1);
        assert!(apply_tick_logic(&mut entries, 1, "two").1.is_empty());
        assert_eq!(
            apply_tick_logic(&mut entries, SCHEDULER_LEASE_MS + 1, "two")
                .1
                .len(),
            1
        );
        assert_eq!(entries[0].lease_holder, "two");
    }

    #[test]
    fn retry_policy_caps_exponential_backoff() {
        let policy = normalize_retry_policy(RetryPolicy {
            max_attempts: 100,
            initial_backoff_ms: 100,
            backoff_multiplier: 20.0,
            max_backoff_ms: 2_000,
        });
        assert_eq!(policy.max_attempts, MAX_JOB_ATTEMPTS as u32);
        assert_eq!(retry_backoff_ms(&policy, 3), 2_000);
    }
}

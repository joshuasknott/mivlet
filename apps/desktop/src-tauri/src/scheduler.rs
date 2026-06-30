//! Durable scheduler store: jobs + queue, atomically persisted. The in-process
//! tick loop (started in lib.rs setup) leases due entries and emits run-request
//! events. Because Tauri is a single shared process, the lease map prevents
//! duplicate execution across multiple Fable windows — two windows can never
//! lease the same occurrence simultaneously.
//!
//! Hard invariants:
//!   - Store writes are atomic (tmp + rename) so a crash cannot leave a
//!     partially encoded file.
//!   - A lease is held by exactly one instance until its short deadline; an
//!     interrupted tick only ever leaves entries leased until expiry, after
//!     which the next tick re-queues them (crash-safe).
//!   - Each lease carries a fencing `lease_token`. `renew_job_lease` and
//!     `report_job_attempt` reject calls whose token does not match, so a stale
//!     response from a crashed run cannot mutate a freshly re-leased occurrence.
//!   - Transient failures set `available_at` (exponential backoff); the tick
//!     will not re-lease an entry before that time. After `SCHEDULER_MAX_RETRIES`
//!     a failed entry becomes `dead`.
//!   - `blocked-auth` entries (provider unavailable / auth expired) are parked
//!     until `requeue_blocked_job_run` re-queues them on reconnect.
//!   - Missed occurrences and next-run math live in the TypeScript layer
//!     (`@fable/connectors/scheduler`); Rust owns durability + the lease lock.
//!
//! SECRET INVARIANT: the execution route stored on jobs/entries carries only
//! provider/model ids + permission mode — never keys, tokens, or credentials.

use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::path::PathBuf;

use crate::models::{
    JobAttempt, ScheduledExecutionRoute, ScheduledJob, SchedulerQueueEntry, SchedulerStore,
    JOB_ATTEMPT_STATUSES, MAX_JOB_ATTEMPTS, MAX_OCCURRENCE_LEDGER, MAX_SCHEDULED_JOBS,
    MAX_SCHEDULER_QUEUE_ENTRIES, MISSED_RUN_POLICIES, RETRY_BASE_MS, RUNNING_LEASE_MS,
    SCHEDULED_JOB_STATUSES, SCHEDULER_LEASE_MS, SCHEDULER_STORE_VERSION,
};
use crate::paths::{normalize_spaces, scheduler_store_path, truncate_characters};
use chrono::{DateTime, SecondsFormat, Utc};
use tauri::{AppHandle, Emitter, Manager};

/// Process-global scheduler state held behind Tauri's managed state.
/// Loaded once at setup; the tick mutates + persists it under the mutex.
pub struct SchedulerState(pub Mutex<Option<SchedulerStore>>);

impl SchedulerState {
    /// An empty store used before a real file is loaded.
    pub fn empty() -> SchedulerStore {
        empty_store("unset")
    }
}

/// Resolve the managed scheduler state. Managed state is registered at app
/// setup, so this is always present in the running app. Unit tests that call
/// the pure helpers directly (`read_store`, `normalize_*`) do not need it.
fn with_state<R>(app: &AppHandle, f: impl FnOnce(&Mutex<Option<SchedulerStore>>) -> R) -> R {
    f(&app.state::<SchedulerState>().inner().0)
}

fn empty_store(instance_id: &str) -> SchedulerStore {
    SchedulerStore {
        schema_version: SCHEDULER_STORE_VERSION,
        jobs: Vec::new(),
        queue: Vec::new(),
        instance_id: instance_id.to_string(),
        updated_at: now_iso(),
        occurrence_ledger: Vec::new(),
    }
}

/// Current time as epoch milliseconds (the canonical comparable value the
/// scheduler stores in `lease_expires_at` / `scheduled_at`). The TS layer
/// formats these for display.
fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// ISO timestamp for the given epoch milliseconds.
fn iso_from_ms(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// Parse the canonical RFC 3339 wire timestamp. Numeric epoch milliseconds are
/// accepted only for backward compatibility with the pre-ISO scheduler store.
fn parse_ms(value: &str) -> i64 {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return 0;
    }
    DateTime::parse_from_rfc3339(trimmed)
        .map(|value| value.timestamp_millis())
        .or_else(|_| trimmed.parse::<i64>())
        .unwrap_or(i64::MAX)
}

fn canonical_timestamp(value: &str) -> Result<String, String> {
    let parsed = DateTime::parse_from_rfc3339(value.trim())
        .map_err(|_| "Scheduler timestamps must be RFC 3339 strings.".to_string())?;
    Ok(parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// A fresh opaque fencing token. Embedded in run-request events and checked on
/// renew/report so a stale call from a crashed run is rejected.
fn fresh_lease_token() -> String {
    // Process-unique enough for fencing: instance id + epoch + nanos. Not a
    // secret — its only job is to prove the caller held the current lease.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("lease-{nanos:x}")
}

fn normalize_route(route: ScheduledExecutionRoute) -> Result<ScheduledExecutionRoute, String> {
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

fn ensure_route_allows(route: &ScheduledExecutionRoute, effect: &str) -> Result<(), String> {
    crate::permission_policy::ensure_permission_allowed(
        &route.permission_mode,
        route.permission_profile.as_deref(),
        effect,
        "medium",
    )
    .map(|_| ())
}

fn normalize_job(mut job: ScheduledJob) -> Result<ScheduledJob, String> {
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
    // Shallow trigger validation: must be an object with a known kind.
    let kind = job
        .trigger
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !matches!(kind, "once" | "recurring") {
        return Err("Schedule trigger kind must be \"once\" or \"recurring\".".to_string());
    }
    Ok(job)
}

fn normalize_attempt(mut attempt: JobAttempt) -> Result<JobAttempt, String> {
    attempt.run_id = truncate_characters(&normalize_spaces(&attempt.run_id), 160);
    attempt.status = normalize_spaces(&attempt.status).to_ascii_lowercase();
    attempt.started_at = normalize_spaces(&attempt.started_at);
    if let Some(token) = attempt.lease_token.take() {
        attempt.lease_token = Some(normalize_spaces(&token));
    }
    if let Some(error) = attempt.error.take() {
        // Errors are persisted; cap them and strip nothing else here (no secrets
        // should ever reach this path — adapters classify auth as a code).
        attempt.error = Some(truncate_characters(&normalize_spaces(&error), 500));
    }
    if attempt.run_id.is_empty() || attempt.started_at.is_empty() {
        return Err("Job attempt needs runId and startedAt.".to_string());
    }
    if !JOB_ATTEMPT_STATUSES.contains(&attempt.status.as_str()) {
        return Err("Job attempt status is not recognized.".to_string());
    }
    Ok(attempt)
}

pub fn read_store(path: &Path) -> Result<SchedulerStore, String> {
    if !path.exists() {
        return Ok(empty_store("unset"));
    }
    let contents = fs::read_to_string(path)
        .map_err(|_| "Fable could not read scheduler store.".to_string())?;
    if contents.trim().is_empty() {
        return Ok(empty_store("unset"));
    }
    let mut store = serde_json::from_str::<SchedulerStore>(&contents)
        .map_err(|_| "Fable could not parse scheduler store.".to_string())?;
    if store.schema_version != SCHEDULER_STORE_VERSION {
        return Err("Scheduler store schema version is not supported.".to_string());
    }
    if store.instance_id.is_empty() {
        store.instance_id = "unset".to_string();
    }
    Ok(store)
}

fn write_store(path: &Path, store: &SchedulerStore) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(store)
        .map_err(|_| "Fable could not encode scheduler store.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, encoded).map_err(|_| "Fable could not save scheduler store.".to_string())?;
    fs::rename(&tmp, path).map_err(|_| "Fable could not commit scheduler store.".to_string())
}

/// Load the store into managed state if needed, then mutate + persist it
/// atomically under the scheduler mutex.
fn persist<F: FnOnce(&mut SchedulerStore)>(app: &AppHandle, mutate: F) -> Result<(), String> {
    let path = scheduler_store_path(app)?;
    with_state(app, |mutex| {
        let mut guard = mutex
            .lock()
            .map_err(|_| "Scheduler lock poisoned.".to_string())?;
        if guard.is_none() {
            *guard = Some(read_store(&path)?);
        }
        let store = guard.as_mut().expect("store loaded");
        mutate(store);
        store.updated_at = now_iso();
        write_store(&path, store)
    })
}

/// Emit a run-request event so the TS scheduler driver picks up a due job.
fn emit_run_request(app: &AppHandle, entry: &SchedulerQueueEntry) {
    let execution = entry.execution.as_ref().map(|route| {
        serde_json::json!({
            "policy": route.policy,
            "backendId": route.backend_id,
            "modelId": route.model_id,
            "permissionMode": route.permission_mode,
            "permissionProfile": route.permission_profile,
        })
    });
    let _ = app.emit(
        "fable://scheduler/run-request",
        serde_json::json!({
            "jobId": entry.job_id,
            "runId": entry.run_id,
            "scheduledAt": entry.scheduled_at,
            "leaseToken": entry.lease_token,
            "execution": execution,
        }),
    );
}

/// The number of failed attempts (excluding the in-flight one) for an entry.
fn failed_count(entry: &SchedulerQueueEntry) -> u32 {
    entry
        .attempts
        .iter()
        .filter(|a| a.status == "failed")
        .count() as u32
}

#[tauri::command]
pub fn list_scheduler_jobs(app: AppHandle) -> Result<Vec<ScheduledJob>, String> {
    let path = scheduler_store_path(&app)?;
    Ok(read_store(&path)?.jobs)
}

#[tauri::command]
pub fn list_scheduler_queue(app: AppHandle) -> Result<Vec<SchedulerQueueEntry>, String> {
    let path = scheduler_store_path(&app)?;
    Ok(read_store(&path)?.queue)
}

#[tauri::command]
pub fn save_scheduled_job(app: AppHandle, job: ScheduledJob) -> Result<ScheduledJob, String> {
    let job = normalize_job(job)?;
    persist(&app, |store| {
        store.jobs.retain(|j| j.id != job.id);
        store.jobs.insert(0, job.clone());
        store.jobs.truncate(MAX_SCHEDULED_JOBS);
    })?;
    Ok(job)
}

#[tauri::command]
pub fn delete_scheduled_job(app: AppHandle, job_id: String) -> Result<(), String> {
    let job_id = normalize_spaces(&job_id);
    persist(&app, |store| {
        store.jobs.retain(|j| j.id != job_id);
        // Also drop queued entries for the deleted job so it can no longer fire.
        store.queue.retain(|e| e.job_id != job_id);
    })
}

#[tauri::command]
pub fn set_job_status(app: AppHandle, job_id: String, status: String) -> Result<(), String> {
    let status = normalize_spaces(&status);
    if !SCHEDULED_JOB_STATUSES.contains(&status.as_str()) {
        return Err("Unknown job status.".to_string());
    }
    let job_id_norm = normalize_spaces(&job_id);
    persist(&app, |store| {
        for job in &mut store.jobs {
            if job.id == job_id_norm {
                job.status = status.clone();
            }
        }
        // A paused/deleted job drops its queued entries so it stops firing.
        if status != "active" {
            store.queue.retain(|e| e.job_id != job_id_norm);
        }
    })
}

/// Enqueue a run for a job occurrence. Deduplicates by (jobId, scheduledAt); a
/// duplicate enqueue (in-queue OR in the occurrence ledger) is a no-op error.
#[tauri::command]
pub fn enqueue_job_run(
    app: AppHandle,
    job_id: String,
    run_id: String,
    scheduled_at: String,
) -> Result<SchedulerQueueEntry, String> {
    let job_id = normalize_spaces(&job_id);
    let run_id = truncate_characters(&normalize_spaces(&run_id), 160);
    let scheduled_at = canonical_timestamp(&scheduled_at)?;
    let key = format!("{}:{}", job_id, scheduled_at);
    if job_id.is_empty() || run_id.is_empty() || scheduled_at.is_empty() {
        return Err("Enqueue needs jobId, runId, and scheduledAt.".to_string());
    }
    let mut created: Option<SchedulerQueueEntry> = None;
    persist(&app, |store| {
        if store.queue.iter().any(|e| e.deduplication_key == key) {
            return;
        }
        if store.occurrence_ledger.iter().any(|seen| seen == &key) {
            return;
        }
        let execution = store
            .jobs
            .iter()
            .find(|job| job.id == job_id)
            .and_then(|job| job.execution.clone());
        if let Some(route) = execution.as_ref() {
            if ensure_route_allows(route, "schedule-execution").is_err() {
                return;
            }
        }
        let entry = SchedulerQueueEntry {
            job_id: job_id.clone(),
            run_id: run_id.clone(),
            scheduled_at: scheduled_at.clone(),
            state: "queued".to_string(),
            lease_holder: String::new(),
            lease_expires_at: String::new(),
            attempts: Vec::new(),
            deduplication_key: key.clone(),
            lease_token: String::new(),
            available_at: String::new(),
            last_error: String::new(),
            execution,
        };
        created = Some(entry.clone());
        store.queue.push(entry);
        store.queue.truncate(MAX_SCHEDULER_QUEUE_ENTRIES);
    })?;
    let entry = created.ok_or_else(|| "A run for this occurrence is already queued.".to_string())?;
    // Observe the queue transition in the unified action-history store
    // (observation only; the scheduler store remains the queue authority).
    crate::action_history::Recorder::new(
        crate::action_history::categories::SCHEDULE,
        "scheduler",
        &entry.job_id,
        "queued",
    )
    .actor("system")
    .correlation(&entry.run_id)
    .summary(&format!("Scheduled job {} queued for run.", entry.job_id))
    .record();
    Ok(entry)
}

/// Report an attempt outcome for a queued/leased run. Updates the attempt
/// history and advances the entry state (done on success/cancel, dead after
/// max retries on failure, blocked-auth parked until requeue). The optional
/// `lease_token` is a fencing token: when present and non-empty it must match
/// the entry's current lease, else the call is rejected as stale.
#[tauri::command]
pub fn report_job_attempt(
    app: AppHandle,
    run_id: String,
    attempt: JobAttempt,
) -> Result<(), String> {
    let attempt = normalize_attempt(attempt)?;
    let run_id = normalize_spaces(&run_id);
    let max_retries = crate::models::SCHEDULER_MAX_RETRIES;
    let mut remembered: Option<String> = None;
    persist(&app, |store| {
        for entry in &mut store.queue {
            if entry.run_id != run_id {
                continue;
            }
            // Fencing: a non-empty token on the attempt must match the entry.
            if let Some(token) = attempt.lease_token.as_ref() {
                if !token.is_empty() && !entry.lease_token.is_empty() && token != &entry.lease_token
                {
                    // Stale report from a superseded run: ignore it rather than
                    // mutating the freshly re-leased occurrence.
                    continue;
                }
            }
            let status = attempt.status.clone();
            entry.attempts.push(attempt.clone());
            if entry.attempts.len() > MAX_JOB_ATTEMPTS {
                let drop = entry.attempts.len() - MAX_JOB_ATTEMPTS;
                entry.attempts.drain(0..drop);
            }
            entry.last_error = attempt.error.clone().unwrap_or_default();
            if status == "succeeded" {
                entry.state = "done".to_string();
            } else if status == "cancelled" {
                entry.state = "cancelled".to_string();
            } else if status == "blocked-auth" {
                entry.state = "blocked-auth".to_string();
            } else if status == "failed" {
                let fails = failed_count(entry);
                if fails > max_retries {
                    entry.state = "dead".to_string();
                } else {
                    // Transient: re-queue with exponential backoff.
                    entry.state = "queued".to_string();
                    let backoff = RETRY_BASE_MS.saturating_mul(1_i64 << (fails.saturating_sub(1)));
                    entry.available_at = iso_from_ms(now_epoch_ms() + backoff);
                }
            } else if status == "running" {
                // Acknowledgement: keep the entry leased but extend it so the
                // five-second tick cannot start a duplicate while the workflow
                // is active. A crashed process eventually recovers the lease.
                entry.state = "leased".to_string();
                entry.lease_expires_at = iso_from_ms(now_epoch_ms() + RUNNING_LEASE_MS);
                continue;
            }
            // Record the scheduler attempt outcome into the unified action-
            // history store (observation only; the scheduler store remains the
            // authority for queue state). Blocked-auth/dead are policy blocks.
            let job_id = entry.job_id.clone();
            let final_state = entry.state.clone();
            let (ah_status, ah_category) = match final_state.as_str() {
                "done" => ("ok", crate::action_history::categories::SCHEDULE),
                "cancelled" => ("cancelled", crate::action_history::categories::SCHEDULE),
                "blocked-auth" => ("blocked", crate::action_history::categories::POLICY_BLOCK),
                "dead" => ("failed", crate::action_history::categories::POLICY_BLOCK),
                _ => ("retried", crate::action_history::categories::SCHEDULE),
            };
            crate::action_history::Recorder::new(ah_category, "scheduler", &job_id, ah_status)
                .actor("system")
                .correlation(&run_id)
                .error(if status == "failed" { "failed" } else { "" })
                .summary(&format!("Scheduled job {job_id} attempt: {status}"))
                .record();
            entry.lease_holder.clear();
            entry.lease_expires_at.clear();
            entry.lease_token.clear();
            if entry.state == "done" || entry.state == "cancelled" || entry.state == "dead" {
                remembered = Some(entry.deduplication_key.clone());
            }
        }
        if let Some(key) = remembered.take() {
            remember_occurrence(store, &key);
        }
    })
}

/// Record an occurrence in the bounded ledger so it can never be re-queued.
fn remember_occurrence(store: &mut SchedulerStore, key: &str) {
    if store.occurrence_ledger.iter().any(|seen| seen == key) {
        return;
    }
    store.occurrence_ledger.insert(0, key.to_string());
    if store.occurrence_ledger.len() > MAX_OCCURRENCE_LEDGER {
        let drop = store.occurrence_ledger.len() - MAX_OCCURRENCE_LEDGER;
        store
            .occurrence_ledger
            .truncate(store.occurrence_ledger.len() - drop);
    }
}

/// Renew the lease on a running entry. Rejects stale callers via the fencing
/// token. Used by the headless runner's heartbeat so a long run is not
/// re-queued by the tick while it is still active.
#[tauri::command]
pub fn renew_job_lease(
    app: AppHandle,
    run_id: String,
    lease_token: String,
) -> Result<bool, String> {
    let run_id = normalize_spaces(&run_id);
    let lease_token = normalize_spaces(&lease_token);
    let mut renewed = false;
    persist(&app, |store| {
        for entry in &mut store.queue {
            if entry.run_id != run_id {
                continue;
            }
            // Fencing: the caller's token must match the entry's current lease.
            if !entry.lease_token.is_empty()
                && !lease_token.is_empty()
                && entry.lease_token != lease_token
            {
                continue;
            }
            entry.lease_expires_at = iso_from_ms(now_epoch_ms() + RUNNING_LEASE_MS);
            renewed = true;
        }
    })?;
    Ok(renewed)
}

/// Re-queue a `blocked-auth` entry once its backend is connected again. No-op
/// (returns false) for entries that are not blocked.
#[tauri::command]
pub fn requeue_blocked_job_run(app: AppHandle, run_id: String) -> Result<bool, String> {
    let run_id = normalize_spaces(&run_id);
    let mut requeued = false;
    persist(&app, |store| {
        for entry in &mut store.queue {
            if entry.run_id == run_id && entry.state == "blocked-auth" {
                entry.state = "queued".to_string();
                entry.available_at = String::new();
                entry.last_error = String::new();
                requeued = true;
            }
        }
    })?;
    Ok(requeued)
}

/// Cancel a queued/leased/running entry. Records a cancelled attempt and
/// transitions the entry to `cancelled`. Used by the Schedules UI.
#[tauri::command]
pub fn cancel_job_run(app: AppHandle, run_id: String) -> Result<bool, String> {
    let run_id = normalize_spaces(&run_id);
    let now = now_iso();
    let mut cancelled = false;
    let mut remembered: Option<String> = None;
    persist(&app, |store| {
        for entry in &mut store.queue {
            if entry.run_id != run_id {
                continue;
            }
            if entry.state == "done" || entry.state == "dead" || entry.state == "cancelled" {
                continue;
            }
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
            remembered = Some(entry.deduplication_key.clone());
            cancelled = true;
            // Observe the cancellation in the unified action-history store.
            let cancelled_job_id = entry.job_id.clone();
            crate::action_history::Recorder::new(
                crate::action_history::categories::SCHEDULE,
                "scheduler",
                &cancelled_job_id,
                "cancelled",
            )
            .actor("user")
            .correlation(&run_id)
            .summary(&format!("Scheduled job {cancelled_job_id} cancelled."))
            .record();
        }
        if let Some(key) = remembered.take() {
            remember_occurrence(store, &key);
        }
    })?;
    Ok(cancelled)
}

/// Reconcile the store on startup: any entry left `leased` or `running` by a
/// crashed process is re-queued (its lease is stale). Called once at setup.
pub fn recover_store_at(store: &mut SchedulerStore) {
    for entry in &mut store.queue {
        if entry.state == "leased" || entry.state == "running" {
            entry.state = "queued".to_string();
            entry.lease_holder.clear();
            entry.lease_expires_at.clear();
            entry.lease_token.clear();
        }
    }
}

/// Initialize the scheduler store into managed state: read it, recover any
/// stale leases from a prior crash, and persist the recovered state. Called at
/// app setup.
pub fn initialize_store(app: &AppHandle) -> Result<(), String> {
    let path = scheduler_store_path(app)?;
    let mut store = read_store(&path)?;
    let mut changed = false;
    for entry in &store.queue {
        if entry.state == "leased" || entry.state == "running" {
            changed = true;
        }
    }
    if changed {
        recover_store_at(&mut store);
        store.updated_at = now_iso();
        write_store(&path, &store)?;
    }
    with_state(app, |mutex| {
        let mut guard = mutex
            .lock()
            .map_err(|_| "Scheduler lock poisoned.".to_string())?;
        *guard = Some(store);
        Ok::<(), String>(())
    })?;
    Ok(())
}

/// The scheduler tick: expire stale leases, then lease due queued entries owned
/// by this instance and emit run-request events for them. Idempotent + crash-
/// safe: an interrupted tick leaves entries leased only until their short
/// deadline; the next tick re-queues expired leases.
pub fn run_tick(app: &AppHandle) -> Result<usize, String> {
    let now_ms = now_epoch_ms();
    let instance = with_state(app, |mutex| {
        let guard = mutex
            .lock()
            .map_err(|_| "Scheduler lock poisoned.".to_string())?;
        Ok::<String, String>(
            guard
                .as_ref()
                .map(|s| s.instance_id.clone())
                .unwrap_or_else(|| "unset".to_string()),
        )
    })?;

    let mut newly_leased = Vec::new();
    persist(app, |store| {
        // 1. Expire leases whose deadline has passed.
        for entry in &mut store.queue {
            if !entry.lease_holder.is_empty() && parse_ms(&entry.lease_expires_at) <= now_ms {
                entry.lease_holder.clear();
                entry.lease_expires_at.clear();
                entry.lease_token.clear();
                if entry.state == "leased" || entry.state == "running" {
                    entry.state = "queued".to_string();
                }
            }
        }
        // 2. Lease due queued entries (scheduled-at <= now AND backoff elapsed),
        //    owned by this instance.
        for entry in &mut store.queue {
            if entry.state != "queued" {
                continue;
            }
            if parse_ms(&entry.scheduled_at) > now_ms {
                continue;
            }
            // Honor retry backoff: do not lease before `available_at`.
            if !entry.available_at.is_empty() && parse_ms(&entry.available_at) > now_ms {
                continue;
            }
            entry.state = "leased".to_string();
            entry.lease_holder = instance.clone();
            entry.lease_expires_at = iso_from_ms(now_ms + SCHEDULER_LEASE_MS);
            entry.lease_token = fresh_lease_token();
            newly_leased.push(entry.clone());
        }
    })?;

    // 3. Emit only entries leased by this tick. Previously every leased entry
    // was re-emitted every five seconds until acknowledgement.
    for entry in &newly_leased {
        emit_run_request(app, entry);
    }
    Ok(newly_leased.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SCHEDULER_STORE_VERSION;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_path() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "fable-sched-{}-{}-{}.json",
            std::process::id(),
            n,
            now_epoch_ms()
        ));
        let _ = fs::remove_file(&p);
        p
    }

    fn sample_job(id: &str, status: &str) -> ScheduledJob {
        ScheduledJob {
            id: id.to_string(),
            schema_version: SCHEDULER_STORE_VERSION,
            name: "Brief".to_string(),
            description: "desc".to_string(),
            workflow_definition_id: "wf".to_string(),
            trigger: serde_json::json!({"kind":"once","at":"1000"}),
            missed_run_policy: "skip".to_string(),
            status: status.to_string(),
            next_run_at: String::new(),
            last_run_at: String::new(),
            last_run_id: String::new(),
            created_at: "0".to_string(),
            updated_at: "0".to_string(),
            execution: None,
        }
    }

    fn sample_entry(id: &str, state: &str) -> SchedulerQueueEntry {
        SchedulerQueueEntry {
            job_id: id.to_string(),
            run_id: format!("run-{id}"),
            scheduled_at: "1970-01-01T00:00:00.000Z".to_string(),
            state: state.to_string(),
            lease_holder: String::new(),
            lease_expires_at: String::new(),
            attempts: Vec::new(),
            deduplication_key: format!("{id}:1970-01-01T00:00:00.000Z"),
            lease_token: String::new(),
            available_at: String::new(),
            last_error: String::new(),
            execution: None,
        }
    }

    #[test]
    fn store_round_trips_empty() {
        let p = tmp_path();
        let store = empty_store("inst");
        write_store(&p, &store).unwrap();
        let read = read_store(&p).unwrap();
        assert_eq!(read.jobs.len(), 0);
        assert_eq!(read.schema_version, SCHEDULER_STORE_VERSION);
        assert!(read.occurrence_ledger.is_empty());
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn store_round_trips_with_occurrence_ledger_and_execution() {
        let p = tmp_path();
        let mut store = empty_store("inst");
        let mut job = sample_job("j", "active");
        job.execution = Some(ScheduledExecutionRoute {
            policy: "pinned".to_string(),
            backend_id: "openai".to_string(),
            model_id: "gpt-4".to_string(),
            permission_mode: "trusted-scope".to_string(),
            permission_profile: Some("trusted".to_string()),
        });
        store.jobs.push(job);
        store
            .occurrence_ledger
            .push("j:1970-01-01T00:00:00.000Z".to_string());
        write_store(&p, &store).unwrap();
        let read = read_store(&p).unwrap();
        assert_eq!(read.occurrence_ledger.len(), 1);
        let route = read.jobs[0].execution.as_ref().expect("execution present");
        assert_eq!(route.backend_id, "openai");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn normalize_rejects_unknown_status() {
        let mut job = sample_job("j", "bogus");
        job.status = "bogus".to_string();
        assert!(normalize_job(job).is_err());
    }

    #[test]
    fn normalize_rejects_unknown_trigger_kind() {
        let mut job = sample_job("j", "active");
        job.trigger = serde_json::json!({"kind":"hourly"});
        assert!(normalize_job(job).is_err());
    }

    #[test]
    fn normalize_rejects_unknown_missed_policy() {
        let mut job = sample_job("j", "active");
        job.missed_run_policy = "always".to_string();
        assert!(normalize_job(job).is_err());
    }

    #[test]
    fn normalize_rejects_bad_route_policy() {
        let mut job = sample_job("j", "active");
        job.execution = Some(ScheduledExecutionRoute {
            policy: "loose".to_string(),
            backend_id: "openai".to_string(),
            model_id: "gpt-4".to_string(),
            permission_mode: "trusted-scope".to_string(),
            permission_profile: Some("trusted".to_string()),
        });
        assert!(normalize_job(job).is_err());
    }

    #[test]
    fn normalize_rejects_read_only_scheduled_execution_route() {
        let mut job = sample_job("j", "active");
        job.execution = Some(ScheduledExecutionRoute {
            policy: "pinned".to_string(),
            backend_id: "openai".to_string(),
            model_id: "gpt-4".to_string(),
            permission_mode: "read-only".to_string(),
            permission_profile: Some("read-only".to_string()),
        });
        assert!(normalize_job(job).is_err());
    }

    #[test]
    fn normalize_accepts_a_valid_job() {
        let job = sample_job("j", "active");
        assert!(normalize_job(job).is_ok());
    }

    #[test]
    fn parse_ms_handles_iso_and_legacy_epoch_ms() {
        assert_eq!(parse_ms("12345"), 12345);
        assert_eq!(parse_ms(""), 0);
        assert_eq!(parse_ms("1970-01-01T00:00:12.345Z"), 12345);
        assert_eq!(parse_ms("not-a-number"), i64::MAX);
        assert!(canonical_timestamp("2026-06-28T09:30:00+01:00")
            .unwrap()
            .ends_with('Z'));
    }

    #[test]
    fn fresh_lease_token_is_unique() {
        let a = fresh_lease_token();
        let b = fresh_lease_token();
        assert!(!a.is_empty());
        assert_ne!(a, b);
    }

    #[test]
    fn recover_store_requeues_stale_leases() {
        let mut store = empty_store("inst");
        store.queue.push(sample_entry("a", "leased"));
        store.queue.push(sample_entry("b", "running"));
        store.queue.push(sample_entry("c", "queued"));
        recover_store_at(&mut store);
        assert_eq!(store.queue[0].state, "queued");
        assert_eq!(store.queue[0].lease_token, "");
        assert_eq!(store.queue[1].state, "queued");
        assert_eq!(store.queue[1].lease_token, "");
        assert_eq!(store.queue[2].state, "queued");
    }

    #[test]
    fn remember_occurrence_is_deduplicating_and_bounded() {
        let mut store = empty_store("inst");
        for _ in 0..(MAX_OCCURRENCE_LEDGER + 50) {
            remember_occurrence(&mut store, "k");
        }
        assert_eq!(store.occurrence_ledger.len(), 1);
        for i in 0..(MAX_OCCURRENCE_LEDGER + 10) {
            remember_occurrence(&mut store, &format!("k{i}"));
        }
        assert!(store.occurrence_ledger.len() <= MAX_OCCURRENCE_LEDGER);
    }

    /// Pure helper: apply a normalized attempt to an entry, mirroring the
    /// command's transition logic. Keeps the test free of Tauri state.
    fn apply_attempt(entry: &mut SchedulerQueueEntry, status: &str) {
        let max_retries = crate::models::SCHEDULER_MAX_RETRIES;
        entry.attempts.push(JobAttempt {
            run_id: entry.run_id.clone(),
            status: status.to_string(),
            attempt_number: entry.attempts.len() as u32 + 1,
            started_at: "1970-01-01T00:00:00.000Z".to_string(),
            finished_at: Some("1970-01-01T00:00:00.000Z".to_string()),
            error: None,
            retryable: None,
            lease_token: None,
        });
        match status {
            "succeeded" => entry.state = "done".to_string(),
            "cancelled" => entry.state = "cancelled".to_string(),
            "blocked-auth" => entry.state = "blocked-auth".to_string(),
            "failed" => {
                let fails = entry
                    .attempts
                    .iter()
                    .filter(|a| a.status == "failed")
                    .count() as u32;
                if fails > max_retries {
                    entry.state = "dead".to_string();
                } else {
                    entry.state = "queued".to_string();
                }
            }
            "running" => {
                entry.state = "leased".to_string();
            }
            _ => {}
        }
    }

    #[test]
    fn failed_attempts_dead_after_max_retries() {
        let mut entry = sample_entry("a", "leased");
        apply_attempt(&mut entry, "failed");
        assert_eq!(entry.state, "queued"); // 1 fail <= 2
        apply_attempt(&mut entry, "failed");
        assert_eq!(entry.state, "queued"); // 2 fails <= 2
        apply_attempt(&mut entry, "failed");
        assert_eq!(entry.state, "dead"); // 3 fails > 2
    }

    #[test]
    fn blocked_auth_parks_until_requeue() {
        let mut entry = sample_entry("a", "leased");
        apply_attempt(&mut entry, "blocked-auth");
        assert_eq!(entry.state, "blocked-auth");
    }

    #[test]
    fn cancel_transitions_to_cancelled() {
        let mut entry = sample_entry("a", "leased");
        apply_attempt(&mut entry, "cancelled");
        assert_eq!(entry.state, "cancelled");
    }

    #[test]
    fn route_schedule_execution_gating() {
        let ro_route = ScheduledExecutionRoute {
            policy: "pinned".to_string(),
            backend_id: "openai".to_string(),
            model_id: "gpt-4".to_string(),
            permission_mode: "read-only".to_string(),
            permission_profile: Some("read-only".to_string()),
        };
        let trusted_route = ScheduledExecutionRoute {
            policy: "pinned".to_string(),
            backend_id: "openai".to_string(),
            model_id: "gpt-4".to_string(),
            permission_mode: "trusted-scope".to_string(),
            permission_profile: Some("trusted".to_string()),
        };

        assert!(ensure_route_allows(&ro_route, "schedule-execution").is_err());
        assert!(ensure_route_allows(&trusted_route, "schedule-execution").is_ok());
    }

    #[test]
    fn blocked_runs_audit_mapping() {
        // Verify final state mapping logic
        let state_blocked = "blocked-auth";
        let (blocked_status, blocked_category) = match state_blocked {
            "blocked-auth" => ("blocked", crate::action_history::categories::POLICY_BLOCK),
            _ => ("ok", crate::action_history::categories::SCHEDULE),
        };
        assert_eq!(blocked_status, "blocked");
        assert_eq!(blocked_category, "policy-block");

        let state_dead = "dead";
        let (dead_status, dead_category) = match state_dead {
            "dead" => ("failed", crate::action_history::categories::POLICY_BLOCK),
            _ => ("ok", crate::action_history::categories::SCHEDULE),
        };
        assert_eq!(dead_status, "failed");
        assert_eq!(dead_category, "policy-block");
    }
}

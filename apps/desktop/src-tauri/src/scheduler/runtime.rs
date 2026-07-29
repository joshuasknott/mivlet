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

#[cfg(test)]
use std::path::Path;

use crate::authorized_scope::ScopeAccess;
use crate::models::{
    JobAttempt, ScheduledJob, SchedulerQueueEntry, SchedulerStore, MAX_JOB_ATTEMPTS,
    MAX_SCHEDULED_JOBS, MAX_SCHEDULER_QUEUE_ENTRIES, RUNNING_LEASE_MS, SCHEDULED_JOB_STATUSES,
};
#[cfg(test)]
use crate::models::{RetryPolicy, ScheduledExecutionRoute, MAX_OCCURRENCE_LEDGER};
use crate::paths::{normalize_spaces, truncate_characters};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(test)]
use super::logic::{
    apply_tick_logic, empty_store, fresh_lease_token, index_occurrences, normalize_retry_policy,
    parse_ms, recover_store_at,
};
#[cfg(test)]
use super::persistence::{decode_store_from_sqlite_rows, write_store};
use super::{
    events::emit_run_request,
    logic::{
        accepts_attempt, canonical_timestamp, delete_job_from_store, ensure_route_allows,
        failed_count, iso_from_ms, normalize_attempt, normalize_job, now_epoch_ms, now_iso,
        remember_occurrence, retry_backoff_ms, set_job_status_in_store,
    },
    persistence::load_store_from_sqlite,
    state::{command_scope, with_state},
};

pub use super::state::SchedulerState;

/// Test-only fixture codec. Native production persistence is SQLite-only.
#[cfg(test)]
pub fn read_store(path: &Path) -> Result<SchedulerStore, String> {
    super::persistence::read_store(path)
}

/// Persist a managed store through the SQLite-first adapter.
fn persist<F: FnOnce(&mut SchedulerStore) -> bool>(
    app: &AppHandle,
    workspace_id: &str,
    mutate: F,
) -> Result<(), String> {
    with_state(app, |state| {
        super::persistence::persist(app, state, workspace_id, mutate)
    })
}

fn legacy_writer_allowed(workspace_id: &str) -> Result<bool, String> {
    Ok(crate::store::with_store(|store| {
        store.transaction(|tx| {
            crate::store::repos::routine::legacy_writer_permitted(
                tx,
                store,
                workspace_id,
                &now_iso(),
            )
        })
    })?
    .unwrap_or(true))
}

fn require_legacy_writer(workspace_id: &str) -> Result<(), String> {
    if legacy_writer_allowed(workspace_id)? {
        Ok(())
    } else {
        Err(
            "This workspace has cut over to Routines; the legacy scheduler is read-only."
                .to_string(),
        )
    }
}

pub(crate) fn apply_native_job_ownership(
    job: &mut ScheduledJob,
    existing: Option<&ScheduledJob>,
    internal_user_id: &str,
    member_id: Option<&str>,
) -> Result<(), String> {
    if let Some(existing) = existing {
        let unresolved_legacy = existing.authority.is_empty()
            && existing.visibility.is_empty()
            && existing.owner_member_id.is_none()
            && existing.created_by_internal_user_id.is_none();
        if unresolved_legacy {
            job.authority.clear();
            job.visibility.clear();
            job.owner_member_id = None;
            job.created_by_internal_user_id = None;
            return Ok(());
        }
        if existing.authority != "local"
            || existing.visibility != "member-private"
            || existing.owner_member_id.as_deref() != member_id
            || existing.created_by_internal_user_id.as_deref() != Some(internal_user_id)
        {
            return Err(
                "This schedule is not owned by the active Fable member and cannot be changed."
                    .into(),
            );
        }
        job.authority = existing.authority.clone();
        job.visibility = existing.visibility.clone();
        job.owner_member_id = existing.owner_member_id.clone();
        job.created_by_internal_user_id = existing.created_by_internal_user_id.clone();
        return Ok(());
    }
    let member_id = member_id.ok_or_else(|| {
        "An active Fable workspace membership is required to create a schedule.".to_string()
    })?;
    job.authority = "local".into();
    job.visibility = "member-private".into();
    job.owner_member_id = Some(member_id.to_string());
    job.created_by_internal_user_id = Some(internal_user_id.to_string());
    Ok(())
}

#[tauri::command]
pub fn list_scheduler_jobs(
    _app: AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<ScheduledJob>, String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Read)?;
    if let Some(store) = load_store_from_sqlite(scope.workspace_id())? {
        return Ok(store
            .jobs
            .into_iter()
            .filter(|job| job.project_id.as_deref() == scope.project_id())
            .collect());
    }
    Err("Fable's encrypted scheduler store is not initialized.".into())
}

#[tauri::command]
pub fn list_scheduler_queue(
    _app: AppHandle,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<SchedulerQueueEntry>, String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Read)?;
    if let Some(store) = load_store_from_sqlite(scope.workspace_id())? {
        return Ok(store
            .queue
            .into_iter()
            .filter(|entry| entry.project_id.as_deref() == scope.project_id())
            .collect());
    }
    Err("Fable's encrypted scheduler store is not initialized.".into())
}

#[tauri::command]
pub fn save_scheduled_job(
    app: AppHandle,
    mut job: ScheduledJob,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<ScheduledJob, String> {
    let auth =
        crate::authorized_scope::command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let scope = auth.data;
    require_legacy_writer(scope.workspace_id())?;
    job.workspace_id = scope.workspace_id().to_string();
    job.project_id = scope.project_id().map(str::to_string);
    let job = normalize_job(job)?;
    let mut ownership_error = None;
    let mut saved_job = job.clone();
    persist(&app, scope.workspace_id(), |store| {
        let existing = store.jobs.iter().find(|candidate| {
            candidate.id == job.id
                && candidate.workspace_id == job.workspace_id
                && candidate.project_id == job.project_id
        });
        if let Err(error) = apply_native_job_ownership(
            &mut saved_job,
            existing,
            &auth.internal_user_id,
            auth.member_id.as_deref(),
        ) {
            ownership_error = Some(error);
            return false;
        }
        store.jobs.retain(|j| {
            j.id != job.id || j.workspace_id != job.workspace_id || j.project_id != job.project_id
        });
        store.jobs.insert(0, saved_job.clone());
        store.jobs.truncate(MAX_SCHEDULED_JOBS);
        true
    })?;
    if let Some(error) = ownership_error {
        return Err(error);
    }
    crate::action_history::Recorder::new(
        crate::action_history::categories::SCHEDULE,
        "scheduler",
        &saved_job.id,
        "configured",
    )
    .actor("user")
    .mode(
        saved_job
            .execution
            .as_ref()
            .map(|route| route.permission_mode.as_str())
            .unwrap_or(""),
    )
    .summary(&format!("Scheduled job {} saved.", saved_job.id))
    .record();
    Ok(saved_job)
}

#[tauri::command]
pub fn delete_scheduled_job(
    app: AppHandle,
    job_id: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    require_legacy_writer(scope.workspace_id())?;
    let job_id = normalize_spaces(&job_id);
    let mut deleted = false;
    persist(&app, scope.workspace_id(), |store| {
        deleted = delete_job_from_store(store, scope.workspace_id(), scope.project_id(), &job_id);
        deleted
    })?;
    if !deleted {
        return Err("Scheduled job was not found.".to_string());
    }
    crate::action_history::Recorder::new(
        crate::action_history::categories::SCHEDULE,
        "scheduler",
        &job_id,
        "deleted",
    )
    .actor("user")
    .summary(&format!("Scheduled job {job_id} deleted."))
    .record();
    Ok(())
}

#[tauri::command]
pub fn set_job_status(
    app: AppHandle,
    job_id: String,
    status: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    require_legacy_writer(scope.workspace_id())?;
    let status = normalize_spaces(&status);
    if !SCHEDULED_JOB_STATUSES.contains(&status.as_str()) {
        return Err("Unknown job status.".to_string());
    }
    let job_id_norm = normalize_spaces(&job_id);
    let mut updated = false;
    let mut cancelled_run_ids = Vec::new();
    persist(&app, scope.workspace_id(), |store| {
        if status != "active" {
            cancelled_run_ids = store
                .queue
                .iter()
                .filter(|entry| {
                    entry.job_id == job_id_norm
                        && entry.workspace_id == scope.workspace_id()
                        && entry.project_id.as_deref() == scope.project_id()
                        && !matches!(entry.state.as_str(), "done" | "dead" | "cancelled")
                })
                .map(|entry| entry.run_id.clone())
                .collect();
        }
        updated = set_job_status_in_store(
            store,
            scope.workspace_id(),
            scope.project_id(),
            &job_id_norm,
            &status,
        );
        updated
    })?;
    if !updated {
        return Err("Scheduled job was not found.".to_string());
    }
    for run_id in cancelled_run_ids {
        let _ = app.emit(
            "fable://scheduler/cancel-request",
            serde_json::json!({
                "runId": run_id,
                "workspaceId": scope.workspace_id(),
                "projectId": scope.project_id(),
            }),
        );
    }
    crate::action_history::Recorder::new(
        crate::action_history::categories::SCHEDULE,
        "scheduler",
        &job_id_norm,
        &status,
    )
    .actor("user")
    .summary(&format!("Scheduled job {job_id_norm} changed to {status}."))
    .record();
    Ok(())
}

/// Enqueue a run for a job occurrence. Deduplicates by (jobId, scheduledAt); a
/// duplicate enqueue (in-queue OR in the occurrence ledger) is a no-op error.
#[tauri::command]
pub fn enqueue_job_run(
    app: AppHandle,
    job_id: String,
    run_id: String,
    scheduled_at: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<SchedulerQueueEntry, String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    require_legacy_writer(scope.workspace_id())?;
    let job_id = normalize_spaces(&job_id);
    let run_id = truncate_characters(&normalize_spaces(&run_id), 160);
    let scheduled_at = canonical_timestamp(&scheduled_at)?;
    let key = format!("{}:{}:{}", scope.workspace_id(), job_id, scheduled_at);
    if job_id.is_empty() || run_id.is_empty() || scheduled_at.is_empty() {
        return Err("Enqueue needs jobId, runId, and scheduledAt.".to_string());
    }
    let mut created: Option<SchedulerQueueEntry> = None;
    persist(&app, scope.workspace_id(), |store| {
        if store.queue.iter().any(|e| e.deduplication_key == key) {
            return false;
        }
        if store.occurrence_index.contains(&key) {
            return false;
        }
        let job = store.jobs.iter().find(|job| {
            job.id == job_id
                && job.workspace_id == scope.workspace_id()
                && job.project_id.as_deref() == scope.project_id()
        });
        let Some(job) = job else {
            return false;
        };
        if job.status != "active" {
            return false;
        }
        let execution = job.execution.clone();
        let retry_policy = job.retry_policy.clone();
        if let Some(route) = execution.as_ref() {
            if ensure_route_allows(route, "schedule-execution").is_err() {
                return false;
            }
        }
        let entry = SchedulerQueueEntry {
            workspace_id: scope.workspace_id().to_string(),
            project_id: scope.project_id().map(str::to_string),
            authority: job.authority.clone(),
            visibility: job.visibility.clone(),
            owner_member_id: job.owner_member_id.clone(),
            created_by_internal_user_id: job.created_by_internal_user_id.clone(),
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
            retry_policy,
        };
        created = Some(entry.clone());
        store.queue.push(entry);
        store.queue.truncate(MAX_SCHEDULER_QUEUE_ENTRIES);
        true
    })?;
    let entry =
        created.ok_or_else(|| "A run for this occurrence is already queued.".to_string())?;
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
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<(), String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let attempt = normalize_attempt(attempt)?;
    let run_id = normalize_spaces(&run_id);
    let mut remembered: Option<String> = None;
    persist(&app, scope.workspace_id(), |store| {
        for entry in &mut store.queue {
            if entry.run_id != run_id
                || entry.workspace_id != scope.workspace_id()
                || entry.project_id.as_deref() != scope.project_id()
            {
                continue;
            }
            // Terminal states are immutable, and a token-bearing report must
            // match the current lease. This prevents a late success from a
            // cancelled or superseded run from reviving the occurrence.
            if !accepts_attempt(entry, &attempt) {
                continue;
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
                if fails >= entry.retry_policy.max_attempts {
                    entry.state = "dead".to_string();
                } else {
                    // Transient: re-queue with exponential backoff.
                    entry.state = "queued".to_string();
                    let backoff = retry_backoff_ms(&entry.retry_policy, fails);
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
        true
    })
}

/// Renew the lease on a running entry. Rejects stale callers via the fencing
/// token. Used by the headless runner's heartbeat so a long run is not
/// re-queued by the tick while it is still active.
#[tauri::command]
pub fn renew_job_lease(
    app: AppHandle,
    run_id: String,
    lease_token: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<bool, String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let run_id = normalize_spaces(&run_id);
    let lease_token = normalize_spaces(&lease_token);
    let mut renewed = false;
    persist(&app, scope.workspace_id(), |store| {
        for entry in &mut store.queue {
            if entry.run_id != run_id
                || entry.workspace_id != scope.workspace_id()
                || entry.project_id.as_deref() != scope.project_id()
            {
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
        renewed
    })?;
    Ok(renewed)
}

/// Re-queue a `blocked-auth` entry once its backend is connected again. No-op
/// (returns false) for entries that are not blocked.
#[tauri::command]
pub fn requeue_blocked_job_run(
    app: AppHandle,
    run_id: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<bool, String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let run_id = normalize_spaces(&run_id);
    let mut requeued = false;
    persist(&app, scope.workspace_id(), |store| {
        for entry in &mut store.queue {
            if entry.run_id == run_id
                && entry.workspace_id == scope.workspace_id()
                && entry.project_id.as_deref() == scope.project_id()
                && entry.state == "blocked-auth"
            {
                entry.state = "queued".to_string();
                entry.available_at = String::new();
                entry.last_error = String::new();
                requeued = true;
            }
        }
        requeued
    })?;
    Ok(requeued)
}

/// Cancel a queued/leased/running entry. Records a cancelled attempt and
/// transitions the entry to `cancelled`. Used by the Schedules UI.
#[tauri::command]
pub fn cancel_job_run(
    app: AppHandle,
    run_id: String,
    workspace_id: Option<String>,
    project_id: Option<String>,
) -> Result<bool, String> {
    let scope = command_scope(workspace_id, project_id, ScopeAccess::Write)?;
    let run_id = normalize_spaces(&run_id);
    let now = now_iso();
    let mut cancelled = false;
    let mut remembered: Option<String> = None;
    persist(&app, scope.workspace_id(), |store| {
        for entry in &mut store.queue {
            if entry.run_id != run_id
                || entry.workspace_id != scope.workspace_id()
                || entry.project_id.as_deref() != scope.project_id()
            {
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
        cancelled
    })?;
    if cancelled {
        // The durable state change is authoritative; this event asks the
        // active headless backend to use its established cooperative
        // cancellation path. Queued runs simply have no listener to notify.
        let _ = app.emit(
            "fable://scheduler/cancel-request",
            serde_json::json!({
                "runId": run_id,
                "workspaceId": scope.workspace_id(),
                "projectId": scope.project_id(),
            }),
        );
    }
    Ok(cancelled)
}

/// Initialize durable scheduler state through the SQLite-first adapter.
pub fn initialize_store(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<SchedulerState>();
    super::persistence::initialize_store(app, state.inner())
}

/// Run deterministic lease selection against an already-loaded store.
pub fn run_tick_on_store(
    store: &mut SchedulerStore,
    now_ms: i64,
    instance: &str,
) -> Vec<SchedulerQueueEntry> {
    super::logic::apply_tick_logic(&mut store.queue, now_ms, instance).1
}

/// The scheduler tick: expire stale leases, then lease due queued entries owned
/// by this instance and emit run-request events for them. Idempotent + crash-
/// safe: an interrupted tick leaves entries leased only until their short
/// deadline; the next tick re-queues expired leases.
pub fn run_tick(app: &AppHandle) -> Result<usize, String> {
    let now_ms = now_epoch_ms();
    let workspaces = with_state(app, |mutex| {
        let guard = mutex
            .lock()
            .map_err(|_| "Scheduler lock poisoned.".to_string())?;
        Ok::<Vec<String>, String>(guard.keys().cloned().collect())
    })?;

    let mut newly_leased = Vec::new();
    for workspace_id in workspaces {
        if crate::execution_control::workspace_is_paused(&workspace_id)? {
            continue;
        }
        if !legacy_writer_allowed(&workspace_id)? {
            continue;
        }
        let instance = with_state(app, |mutex| {
            let guard = mutex
                .lock()
                .map_err(|_| "Scheduler lock poisoned.".to_string())?;
            Ok::<String, String>(
                guard
                    .get(&workspace_id)
                    .map(|store| store.instance_id.clone())
                    .unwrap_or_else(|| workspace_id.clone()),
            )
        })?;
        let mut workspace_leases = Vec::new();
        persist(app, &workspace_id, |store| {
            workspace_leases = run_tick_on_store(store, now_ms, &instance);
            !workspace_leases.is_empty()
        })?;
        newly_leased.extend(workspace_leases);
    }

    // 3. Emit only entries leased by this tick. Previously every leased entry
    // was re-emitted every five seconds until acknowledgement.
    for entry in &newly_leased {
        emit_run_request(app, entry);
    }
    let routine_leases = super::routine_runtime::run_tick(app)?;
    Ok(newly_leased.len() + routine_leases)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

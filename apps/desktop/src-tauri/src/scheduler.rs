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
//!   - Missed occurrences and next-run math live in the TypeScript layer
//!     (`@fable/connectors/scheduler`); Rust owns durability + the lease lock.

use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::path::PathBuf;

use crate::models::{
    JobAttempt, ScheduledJob, SchedulerQueueEntry, SchedulerStore, JOB_ATTEMPT_STATUSES,
    MAX_JOB_ATTEMPTS, MAX_SCHEDULED_JOBS, MAX_SCHEDULER_QUEUE_ENTRIES, MISSED_RUN_POLICIES,
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
    let _ = app.emit(
        "fable://scheduler/run-request",
        serde_json::json!({
            "jobId": entry.job_id,
            "runId": entry.run_id,
            "scheduledAt": entry.scheduled_at,
        }),
    );
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
/// duplicate enqueue is a no-op that returns an error so the caller knows.
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
        let entry = SchedulerQueueEntry {
            job_id: job_id.clone(),
            run_id: run_id.clone(),
            scheduled_at: scheduled_at.clone(),
            state: "queued".to_string(),
            lease_holder: String::new(),
            lease_expires_at: String::new(),
            attempts: Vec::new(),
            deduplication_key: key.clone(),
        };
        created = Some(entry.clone());
        store.queue.push(entry);
        store.queue.truncate(MAX_SCHEDULER_QUEUE_ENTRIES);
    })?;
    created.ok_or_else(|| "A run for this occurrence is already queued.".to_string())
}

/// Report an attempt outcome for a queued/leased run. Updates the attempt
/// history and advances the entry state (done on success/cancel, dead after
/// max retries on failure).
#[tauri::command]
pub fn report_job_attempt(
    app: AppHandle,
    run_id: String,
    attempt: JobAttempt,
) -> Result<(), String> {
    let attempt = normalize_attempt(attempt)?;
    let run_id = normalize_spaces(&run_id);
    let max_retries = crate::models::SCHEDULER_MAX_RETRIES;
    persist(&app, |store| {
        for entry in &mut store.queue {
            if entry.run_id != run_id {
                continue;
            }
            let status = attempt.status.clone();
            entry.attempts.push(attempt.clone());
            if entry.attempts.len() > MAX_JOB_ATTEMPTS {
                let drop = entry.attempts.len() - MAX_JOB_ATTEMPTS;
                entry.attempts.drain(0..drop);
            }
            if status == "succeeded" || status == "cancelled" {
                entry.state = "done".to_string();
            } else if status == "failed" {
                let fails = entry
                    .attempts
                    .iter()
                    .filter(|a| a.status == "failed")
                    .count() as u32;
                entry.state = if fails > max_retries {
                    "dead".to_string()
                } else {
                    "queued".to_string()
                };
            } else if status == "running" {
                // Acknowledgement: keep the entry leased but extend it so the
                // five-second tick cannot start a duplicate while the workflow
                // is active. A crashed process eventually recovers the lease.
                entry.state = "leased".to_string();
                entry.lease_expires_at =
                    DateTime::from_timestamp_millis(now_epoch_ms() + 15 * 60 * 1_000)
                        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
                        .unwrap_or_default();
                continue;
            }
            entry.lease_holder.clear();
            entry.lease_expires_at.clear();
        }
    })
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
                if entry.state == "leased" {
                    entry.state = "queued".to_string();
                }
            }
        }
        // 2. Lease due queued entries (scheduled-at <= now), owned by this instance.
        for entry in &mut store.queue {
            if entry.state == "queued" && parse_ms(&entry.scheduled_at) <= now_ms {
                entry.state = "leased".to_string();
                entry.lease_holder = instance.clone();
                entry.lease_expires_at =
                    DateTime::from_timestamp_millis(now_ms + SCHEDULER_LEASE_MS)
                        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
                        .unwrap_or_default();
                newly_leased.push(entry.clone());
            }
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
}

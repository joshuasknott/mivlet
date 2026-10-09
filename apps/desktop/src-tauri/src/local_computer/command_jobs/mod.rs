//! Native job ownership and bounded log observation. This is a process lifecycle
//! service, not a Work scheduler; all starts arrive through existing tool permits.
mod redaction;
mod store;
pub(super) use redaction::output_log as safe_output;
#[cfg(test)]
mod tests;
use super::{authority::OperationTicket, LocalComputerState};
use mivlet_windows_executor::{output::OutputPage, OutputLog, Receipt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn validate_start(command: &str, seconds: u64) -> Result<(), String> {
    if command.trim().is_empty()
        || command.len() > 8192
        || command.contains('\0')
        || crate::secret_redaction::secret_marker_survives(command)
        || !(1..=86_400).contains(&seconds)
    {
        Err("Supply a command without credentials (at most 8 KB) and an explicit 1–86400 second lifetime.".into())
    } else {
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum JobStatus {
    Preparing,
    Running,
    Stopping,
    Succeeded,
    Failed,
    Stopped,
    TimedOut,
    Interrupted,
}
impl JobStatus {
    fn active(self) -> bool {
        matches!(self, Self::Preparing | Self::Running | Self::Stopping)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRecord {
    pub id: String,
    pub repository_id: Option<String>,
    pub generation: u64,
    pub operation_id: u64,
    pub command_id: String,
    pub persistent: bool,
    pub network: bool,
    pub timeout_seconds: u64,
    pub status: JobStatus,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub execution_id: Option<String>,
    pub message: Option<String>,
}
impl JobRecord {
    fn valid(&self) -> bool {
        fn hex(value: &str, size: usize) -> bool {
            value.len() == size && value.bytes().all(|b| b.is_ascii_hexdigit())
        }
        hex(&self.id, 48)
            && hex(&self.command_id, 64)
            && self.repository_id.as_ref().is_none_or(|id| hex(id, 48))
            && self.generation > 0
            && self.operation_id > 0
            && (1..=86_400).contains(&self.timeout_seconds)
            && self.created_at.len() <= 40
            && self.finished_at.as_ref().is_none_or(|s| s.len() <= 40)
            && self.execution_id.as_ref().is_none_or(|id| hex(id, 48))
            && self.message.as_ref().is_none_or(|s| {
                s.len() <= 256 && !crate::secret_redaction::secret_marker_survives(s)
            })
    }
}
struct Live {
    output: OutputLog,
    cancel: Arc<AtomicBool>,
}
struct Inner {
    records: Vec<JobRecord>,
    live: HashMap<String, Live>,
}
pub(crate) struct ScopeJobs {
    storage: Mutex<store::Storage>,
    inner: Mutex<Inner>,
}
#[derive(Default)]
pub(crate) struct JobManager {
    scopes: Mutex<HashMap<PathBuf, Arc<ScopeJobs>>>,
}
impl JobManager {
    pub(super) fn release_idle(&self) -> Result<(), String> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?;
        for scope in scopes.values() {
            if Arc::strong_count(scope) != 1
                || scope
                    .inner
                    .lock()
                    .map_err(|_| "Command jobs are unavailable.")?
                    .records
                    .iter()
                    .any(|record| record.status.active())
            {
                return Err("Finish or Stop foreground command jobs before enabling their background owner.".into());
            }
        }
        scopes.clear();
        Ok(())
    }
    pub(super) fn scope(&self, directory: &Path) -> Result<Arc<ScopeJobs>, String> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?;
        if let Some(scope) = scopes.get(directory) {
            return Ok(scope.clone());
        }
        if scopes.len() >= 64 {
            return Err("Native command scope limit reached; restart after stopping jobs.".into());
        }
        let (storage, records) = store::Storage::open(directory)?;
        let scope = Arc::new(ScopeJobs {
            storage: Mutex::new(storage),
            inner: Mutex::new(Inner {
                records,
                live: HashMap::new(),
            }),
        });
        scopes.insert(directory.to_owned(), scope.clone());
        Ok(scope)
    }
}
impl Drop for JobManager {
    fn drop(&mut self) {
        if let Ok(scopes) = self.scopes.lock() {
            for scope in scopes.values() {
                if let Ok(inner) = scope.inner.lock() {
                    for live in inner.live.values() {
                        live.cancel.store(true, Ordering::Release);
                    }
                }
            }
        }
    }
}
impl LocalComputerState {
    pub(crate) fn command_jobs(
        &self,
        workspace: &str,
        agent: &str,
    ) -> Result<Arc<ScopeJobs>, String> {
        self.jobs.scope(&self.scope(workspace, agent)?.directory)
    }
}
/// Keeps the exact admitted operation alive in native code. A component or log
/// reader cannot extend authority, relaunch a job, or change its generation.
pub(crate) struct JobSession {
    scope: Arc<ScopeJobs>,
    id: String,
    output: OutputLog,
    finished: bool,
}
impl ScopeJobs {
    pub(crate) fn start(
        self: &Arc<Self>,
        ticket: &OperationTicket,
        repository_id: Option<&str>,
        script: &str,
        network: bool,
        timeout_seconds: u64,
        persistent: bool,
    ) -> Result<JobSession, String> {
        ticket.check()?;
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).map_err(|_| "Cannot create command identity.")?;
        let id = hex::encode(bytes);
        let binding = ticket.execution_binding();
        let command_id = hex::encode(Sha256::digest(
            serde_json::to_vec(&(script, network, timeout_seconds, persistent, &binding))
                .map_err(|_| "Invalid command identity.")?,
        ));
        let record = JobRecord {
            id: id.clone(),
            repository_id: repository_id.map(str::to_owned),
            generation: binding.generation,
            operation_id: binding.operation_id,
            command_id,
            persistent,
            network,
            timeout_seconds,
            status: JobStatus::Preparing,
            created_at: now(),
            finished_at: None,
            exit_code: None,
            execution_id: None,
            message: None,
        };
        if !record.valid() {
            return Err("Invalid command job metadata.".into());
        }
        let session = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Command jobs are unavailable.")?;
            if inner.records.iter().filter(|r| r.status.active()).count() >= 4 {
                return Err("Four command jobs already occupy this agent; stop one first.".into());
            }
            while inner.records.len() >= store::MAX_RECORDS {
                let index = inner
                    .records
                    .iter()
                    .position(|r| !r.status.active())
                    .ok_or("Command history is full.")?;
                let old = inner.records.remove(index);
                inner.live.remove(&old.id);
            }
            inner.records.push(record);
            // Metadata outlives scrollback. Cap retained log allocations across
            // completed jobs as well as within each individual output stream.
            while inner.live.len() >= 16 {
                let old = inner
                    .records
                    .iter()
                    .find(|r| !r.status.active() && inner.live.contains_key(&r.id))
                    .map(|r| r.id.clone());
                if let Some(id) = old {
                    inner.live.remove(&id);
                } else {
                    break;
                }
            }
            let output = redaction::output_log();
            inner.live.insert(
                id.clone(),
                Live {
                    output: output.clone(),
                    cancel: ticket.cancellation(),
                },
            );
            JobSession {
                scope: self.clone(),
                id,
                output,
                finished: false,
            }
        };
        // Flush before any process may launch, without holding the authority or
        // observation lock. Stop must not wait for disk I/O. A revoked ticket
        // drops this unlaunched session and records interruption.
        self.persist()?;
        ticket.check()?;
        Ok(session)
    }
    fn record(&self, id: &str) -> Result<JobRecord, String> {
        self.inner
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?
            .records
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or("Command job is unavailable in this scope.".into())
    }
    fn update(&self, id: &str, update: impl FnOnce(&mut JobRecord)) -> Result<(), String> {
        self.update_memory(id, update)?;
        self.persist()
    }
    fn update_memory(&self, id: &str, update: impl FnOnce(&mut JobRecord)) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?;
        let record = inner
            .records
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or("Command job is unavailable.")?;
        update(record);
        Ok(())
    }
    fn persist(&self) -> Result<(), String> {
        // Serialize writers before taking a fresh snapshot, so an older flush
        // cannot overwrite a newer terminal state. Neither lock is an authority
        // lock; disk I/O holds only this writer mutex.
        let storage = self
            .storage
            .lock()
            .map_err(|_| "Command history is unavailable.")?;
        let records = self
            .inner
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?
            .records
            .clone();
        storage.save(&records)
    }
    pub(crate) fn list(&self) -> Result<Vec<JobRecord>, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?
            .records
            .iter()
            .rev()
            .cloned()
            .collect())
    }
    fn output(&self, id: &str, generation: u64, cursor: u64) -> Result<Value, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?;
        let job = inner
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or("Command job is unavailable in this scope.")?;
        if job.generation != generation {
            return Err("Job generation changed; inspect its retained metadata. Output authority cannot be transferred.".into());
        }
        let page: Option<OutputPage> = inner
            .live
            .get(id)
            .map(|live| live.output.read(cursor))
            .transpose()?;
        Ok(json!({"job": job, "output": page, "outputUnavailable": page.is_none()}))
    }
    fn stop(&self, id: &str, generation: u64) -> Result<JobRecord, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Command jobs are unavailable.")?;
        let index = inner
            .records
            .iter()
            .position(|r| r.id == id)
            .ok_or("Command job is unavailable in this scope.")?;
        if inner.records[index].generation != generation {
            return Err("Job generation changed. Refresh before stopping a job.".into());
        }
        if inner.records[index].status.active() {
            let live = inner
                .live
                .get(id)
                .ok_or("Job owner is unavailable; reconcile by reopening the native scope.")?;
            live.cancel.store(true, Ordering::Release);
            inner.records[index].status = JobStatus::Stopping;
        }
        Ok(inner.records[index].clone())
    }
}
impl JobSession {
    pub(crate) fn fail(&mut self, error: &str) -> Result<(), String> {
        let mut safe = crate::secret_redaction::redact_secret_text_or_omit(error);
        while safe.len() > 256 {
            safe.pop();
        }
        self.output.close();
        self.scope.update(&self.id, |r| {
            r.status = JobStatus::Interrupted;
            r.finished_at = Some(now());
            r.message = Some(safe);
        })?;
        self.finished = true;
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> Result<JobRecord, String> {
        self.scope.record(&self.id)
    }
    pub(crate) fn output(&self) -> OutputLog {
        self.output.clone()
    }
    pub(crate) fn running(&self) -> Result<(), String> {
        // This runs immediately after resume on the supervisor thread. Admission
        // is already durable; a crash recovers Preparing as interrupted. Never
        // wait for disk here, which would delay Stop and timeout checks.
        self.scope.update_memory(&self.id, |r| {
            if r.status == JobStatus::Preparing {
                r.status = JobStatus::Running;
            }
        })
    }
    pub(crate) fn complete(&mut self, receipt: &Receipt) -> Result<(), String> {
        self.output.close();
        self.scope.update(&self.id, |r| {
            r.status = if receipt.reason.as_deref() == Some("timeout") {
                JobStatus::TimedOut
            } else if receipt.reason.as_deref() == Some("stopped or stale generation") {
                JobStatus::Stopped
            } else if receipt.interrupted {
                JobStatus::Interrupted
            } else if receipt.exit_code == Some(0) {
                JobStatus::Succeeded
            } else {
                JobStatus::Failed
            };
            r.exit_code = receipt.exit_code;
            r.execution_id = Some(receipt.run_id.clone());
            r.finished_at = Some(now());
            r.message = if receipt.interrupted {
                Some("Command ended without importing its snapshot.".into())
            } else {
                None
            };
        })?;
        self.finished = true;
        Ok(())
    }
}
impl Drop for JobSession {
    fn drop(&mut self) {
        if !self.finished {
            self.output.close();
            let _ = self.scope.update(&self.id, |r| { r.status = JobStatus::Interrupted; r.finished_at = Some(now());
                r.message = Some("Native execution did not complete. Inspect prerequisites; no automatic replay.".into()); });
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JobInput {
    job_id: Option<String>,
    job_generation: Option<u64>,
    #[serde(default)]
    cursor: u64,
}
pub(crate) fn execute(
    state: &LocalComputerState,
    workspace: &str,
    agent: &str,
    generation: u64,
    tool: &str,
    arguments: Value,
) -> Result<String, String> {
    let ticket = state.begin_agent_operation(workspace, agent, generation)?;
    let input: JobInput =
        serde_json::from_value(arguments).map_err(|_| "Invalid command observation request.")?;
    let jobs = state.command_jobs(workspace, agent)?;
    let value = dispatch(&jobs, &ticket, tool, input)?;
    ticket.finish(serde_json::to_string(&value).map_err(|_| "Invalid command result.".into()))
}
fn dispatch(
    jobs: &ScopeJobs,
    ticket: &OperationTicket,
    tool: &str,
    input: JobInput,
) -> Result<Value, String> {
    ticket.check()?;
    if tool == "command-jobs" {
        return Ok(json!({"jobs": jobs.list()?}));
    }
    let id = input
        .job_id
        .ok_or("Supply a job identity from command-jobs.")?;
    let generation = input
        .job_generation
        .ok_or("Supply the job's exact generation.")?;
    if generation != ticket.generation {
        return Err("This job belongs to a revoked generation; inspect metadata only.".into());
    }
    match tool {
        "command-output" => jobs.output(&id, generation, input.cursor),
        "command-stop" => {
            let job = ticket.with_current(|| jobs.stop(&id, generation))?;
            jobs.persist()?;
            Ok(json!({"job": job}))
        }
        _ => Err("Unknown command lifecycle operation.".into()),
    }
}

// Main-window reads are scoped on every poll. No global Tauri output event can
// leak logs to a different workspace, agent, account or stale subscription.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_command_jobs(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    job_id: Option<String>,
    job_generation: Option<u64>,
    cursor: Option<u64>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Command output belongs to the main window.".into());
    }
    let tool = if job_id.is_some() {
        "command-output"
    } else {
        "command-jobs"
    };
    let handoff = crate::background_worker::commands::foreground_fence(tool)?;
    if crate::background_worker::commands::should_route(tool)? {
        drop(handoff);
        return crate::background_worker::commands::view(
            workspace_id,
            agent_id,
            expected_generation,
            tool,
            job_id,
            job_generation,
            cursor.unwrap_or(0),
        )
        .await;
    }
    let _handoff = handoff;
    observe(
        state.inner().clone(),
        workspace_id,
        agent_id,
        expected_generation,
        tool.into(),
        job_id,
        job_generation,
        cursor.unwrap_or(0),
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_command_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    job_id: String,
    job_generation: u64,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Command controls belong to the main window.".into());
    }
    let handoff = crate::background_worker::commands::foreground_fence("command-stop")?;
    if crate::background_worker::commands::should_route("command-stop")? {
        drop(handoff);
        return crate::background_worker::commands::view(
            workspace_id,
            agent_id,
            expected_generation,
            "command-stop",
            Some(job_id),
            Some(job_generation),
            0,
        )
        .await;
    }
    let _handoff = handoff;
    observe(
        state.inner().clone(),
        workspace_id,
        agent_id,
        expected_generation,
        "command-stop".into(),
        Some(job_id),
        Some(job_generation),
        0,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn observe(
    state: Arc<LocalComputerState>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    tool: String,
    job_id: Option<String>,
    job_generation: Option<u64>,
    cursor: u64,
) -> Result<Value, String> {
    state.validate_target(&workspace_id, &agent_id)?;
    let ticket = state
        .authority_for(&workspace_id, &agent_id)?
        .begin_viewer(expected_generation)?;
    let jobs = state.command_jobs(&workspace_id, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = dispatch(
            &jobs,
            &ticket,
            &tool,
            JobInput {
                job_id,
                job_generation,
                cursor,
            },
        );
        ticket.finish(result)
    })
    .await
    .map_err(|_| "Command inspection failed; inspect its current status.".to_owned())?
}

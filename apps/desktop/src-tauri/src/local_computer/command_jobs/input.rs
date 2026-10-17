//! Exact one-use input into a held restricted process. Text is never indexed,
//! echoed by native code, or retried after a missing/uncertain receipt.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InputRequest {
    pub job_id: String,
    pub job_generation: u64,
    pub input_sequence: u64,
    pub text: String,
}
fn validate(input: &InputRequest) -> Result<(), String> {
    if input.text.is_empty()
        || input.text.len() > 4096
        || input.text.contains('\0')
        || crate::secret_redaction::secret_marker_survives(&input.text)
        || input.input_sequence == 0
        || input.input_sequence > 9_007_199_254_740_991
    {
        Err("Supply 1–4096 bytes of exact input without credentials or NUL, and the next input sequence from this job.".into())
    } else {
        Ok(())
    }
}
pub(super) fn dispatch(
    jobs: &ScopeJobs,
    ticket: &OperationTicket,
    input: InputRequest,
) -> Result<Value, String> {
    validate(&input)?;
    crate::execution_control::ensure_active_execution_allowed()?;
    let control = ticket.with_current(|| {
        let mut inner = jobs.inner.lock().map_err(|_| "Command jobs are unavailable.")?;
        let index = inner.records.iter().position(|record| record.id == input.job_id).ok_or("This command job is unavailable in the selected agent scope.")?;
        let record = &inner.records[index];
        if record.generation != input.job_generation || record.generation != ticket.generation
            || record.status != JobStatus::Running || !record.interactive || record.input_sequence.checked_add(1) != Some(input.input_sequence) {
            return Err("This input belongs to a stale, ended, noninteractive or already consumed command sequence. Refresh; do not replay it.".into());
        }
        let live = inner.live.get_mut(&input.job_id).ok_or("The exact native command owner is unavailable.")?;
        if live.cancel.load(Ordering::Acquire) || live.input_pending { return Err("Command input is stopped or a receipt is still pending. Do not replay it.".into()); }
        live.input_pending = true;
        let control = live.control.clone();
        inner.records[index].input_sequence = input.input_sequence;
        Ok(control)
    })?;
    struct Pending<'a> {
        jobs: &'a ScopeJobs,
        id: String,
    }
    impl Drop for Pending<'_> {
        fn drop(&mut self) {
            if let Ok(mut inner) = self.jobs.inner.lock() {
                if let Some(live) = inner.live.get_mut(&self.id) {
                    live.input_pending = false;
                }
            }
        }
    }
    let _pending = Pending {
        jobs,
        id: input.job_id.clone(),
    };
    // Consume and flush the nonsecret sequence before any bytes can be sent.
    // No generation, registry, approval or observation lock crosses pipe I/O.
    jobs.persist()?;
    ticket.check()?;
    crate::execution_control::ensure_active_execution_allowed()?;
    let delivery = control.write_input(&control.binding(), input.text)?;
    Ok(
        json!({"jobId": input.job_id, "jobGeneration": input.job_generation,
        "inputSequence": input.input_sequence, "delivery": delivery}),
    )
}

pub(crate) async fn receive_input(
    state: Arc<LocalComputerState>,
    workspace: String,
    agent: String,
    generation: u64,
    input: InputRequest,
) -> Result<Value, String> {
    state.validate_target(&workspace, &agent)?;
    let ticket = state
        .authority_for(&workspace, &agent)?
        .begin_viewer(generation)?;
    let jobs = state.command_jobs(&workspace, &agent)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = dispatch(&jobs, &ticket, input);
        ticket.finish(result)
    })
    .await
    .map_err(|_| {
        "The command input receipt was lost. Refresh the job; never replay it automatically."
            .to_owned()
    })?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn native_command_input(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<LocalComputerState>>,
    workspace_id: String,
    agent_id: String,
    expected_generation: u64,
    job_id: String,
    job_generation: u64,
    input_sequence: u64,
    text: String,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Command input belongs to the main window.".into());
    }
    let input = InputRequest {
        job_id,
        job_generation,
        input_sequence,
        text,
    };
    validate(&input)?;
    let handoff = crate::background_worker::commands::foreground_fence("command-input")?;
    if crate::background_worker::commands::should_route("command-input")? {
        drop(handoff);
        return crate::background_worker::commands::input(
            workspace_id,
            agent_id,
            expected_generation,
            input,
        )
        .await;
    }
    let _handoff = handoff;
    receive_input(
        state.inner().clone(),
        workspace_id,
        agent_id,
        expected_generation,
        input,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_sequence_is_consumed_before_delivery_and_never_replayed() {
        let root = tempfile::tempdir().unwrap();
        let auth = super::super::super::authority::ComputerAuthority::load(root.path()).unwrap();
        let ticket = auth.begin_agent(1).unwrap();
        let manager = JobManager::default();
        let jobs = manager.scope(root.path()).unwrap();
        let session = jobs
            .start_with_options(
                &ticket,
                None,
                "fixture",
                false,
                30,
                true,
                SessionOptions {
                    interactive: true,
                    preview_port: None,
                },
            )
            .unwrap();
        session.running().unwrap();
        let input = || InputRequest {
            job_id: session.id.clone(),
            job_generation: 1,
            input_sequence: 1,
            text: "private input\n".into(),
        };
        // No process endpoint installed; no bytes can be delivered. Even this
        // failed delivery permanently consumes the sequence before I/O.
        assert!(dispatch(&jobs, &ticket, input()).is_err());
        assert_eq!(session.snapshot().unwrap().input_sequence, 1);
        assert!(dispatch(&jobs, &ticket, input()).is_err());
        let saved = std::fs::read_to_string(root.path().join("command-jobs/jobs.json")).unwrap();
        assert!(!saved.contains("private input"));
        assert!(saved.contains("inputSequence"));
        auth.revoke(1).unwrap();
        assert!(dispatch(
            &jobs,
            &ticket,
            InputRequest {
                input_sequence: 2,
                ..input()
            }
        )
        .is_err());
    }
}

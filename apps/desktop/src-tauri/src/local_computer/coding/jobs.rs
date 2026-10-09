use super::*;
use crate::local_computer::command_jobs::ScopeJobs;
use std::sync::atomic::Ordering;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    repository_id: String,
    command: String,
    network: bool,
    timeout_seconds: u64,
}

pub(super) fn start(
    directory: PathBuf,
    ticket: OperationTicket,
    jobs: Arc<ScopeJobs>,
    arguments: Value,
) -> Result<String, String> {
    let input: Start =
        serde_json::from_value(arguments).map_err(|_| "Invalid persistent repository command.")?;
    super::super::command_jobs::validate_start(&input.command, input.timeout_seconds)?;
    let cancel = ticket.cancellation();
    let (ready, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("mivlet-repository-job".into())
        .spawn(move || {
            let result = (|| {
                ticket.check()?;
                let mutex = lock(&directory)?;
                let _guard = mutex.try_lock().map_err(|_| {
                    "A repository operation is running. Wait or Stop it before starting a job."
                })?;
                let mut repo = load(&directory)?.ok_or("Attach a repository in Library first.")?;
                if repo.id != input.repository_id {
                    return Err("Repository selection changed. Request a fresh approval.".into());
                }
                if reconcile_import(&directory, &mut repo, &ticket)?.is_some()
                    || repo.operation.starts_with("publication")
                {
                    return Err(
                        "Reconcile the existing repository outcome before starting a job.".into(),
                    );
                }
                let root = checkout(&directory, &repo)?;
                let mut session = jobs.start(
                    &ticket,
                    Some(&repo.id),
                    &input.command,
                    input.network,
                    input.timeout_seconds,
                    true,
                )?;
                let snapshot = session.snapshot()?;
                if ready.send(Ok(snapshot)).is_err() {
                    return Err("Command start observer disconnected before admission.".into());
                }
                // Keep the canonical repository lock through snapshot creation,
                // execution, full descendant termination and custody cleanup. No
                // long-lived snapshot can be imported or overwritten by file tools.
                let _completed = process::native_run(
                    &root,
                    &input.command,
                    input.network,
                    input.timeout_seconds,
                    false,
                    &ticket,
                    Some(&mut session),
                )?;
                Ok::<_, String>(())
            })();
            if let Err(error) = result {
                let _ = ready.send(Err(error));
            }
        })
        .map_err(|_| "Cannot start native command owner.")?;
    match receive.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(result) => serde_json::to_string(&json!({"job": result?, "notice": "Native job owns a fixed isolated snapshot; all writes are discarded. Use command-output and command-stop. Stop or timeout terminates all descendants; restart never replays it."})).map_err(|_| "Invalid command start receipt.".into()),
        Err(_) => { cancel.store(true, Ordering::Release); Err("Command admission interrupted; inspect command-jobs before retrying.".into()) }
    }
}

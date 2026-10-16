use super::super::authority::ComputerAuthority;
use super::*;

#[test]
fn ownership_handoff_refuses_active_jobs_and_releases_idle_scopes() {
    let root = tempfile::tempdir().unwrap();
    let auth = ComputerAuthority::load(root.path()).unwrap();
    let ticket = auth.begin_agent(1).unwrap();
    let manager = JobManager::default();
    let scope = manager.scope(root.path()).unwrap();
    let session = scope
        .start(&ticket, None, "echo fixture", false, 60, true)
        .unwrap();
    assert!(manager.release_idle().is_err());
    drop(session);
    drop(scope);
    drop(ticket);
    manager.release_idle().unwrap();
    let next_owner = JobManager::default();
    assert!(next_owner.scope(root.path()).is_ok());
}

#[test]
fn running_transition_does_not_block_the_supervisor_on_disk() {
    let root = tempfile::tempdir().unwrap();
    let auth = ComputerAuthority::load(root.path()).unwrap();
    let ticket = auth.begin_agent(1).unwrap();
    let manager = JobManager::default();
    let scope = manager.scope(root.path()).unwrap();
    let session = scope
        .start(&ticket, None, "echo test", false, 60, true)
        .unwrap();
    let disk = scope.storage.lock().unwrap();
    let (ready, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        ready.send(session.running()).unwrap();
        session
    });
    let transitioned = receive.recv_timeout(std::time::Duration::from_secs(5));
    drop(disk);
    let session = worker.join().unwrap();
    transitioned
        .expect("Running transition blocked on disk")
        .unwrap();
    assert_eq!(session.snapshot().unwrap().status, JobStatus::Running);
    let durable = std::fs::read_to_string(root.path().join("command-jobs/jobs.json")).unwrap();
    assert!(durable.contains("preparing"));
    auth.revoke(1).unwrap();
    assert!(ticket.check().is_err());
}

#[test]
fn revocation_does_not_wait_for_a_slow_job_metadata_flush() {
    let root = tempfile::tempdir().unwrap();
    let auth = ComputerAuthority::load(root.path()).unwrap();
    let ticket = auth.begin_agent(1).unwrap();
    let manager = JobManager::default();
    let scope = manager.scope(root.path()).unwrap();
    let disk = scope.storage.lock().unwrap();
    let pending = scope.clone();
    let worker = std::thread::spawn(move || {
        pending
            .start(&ticket, None, "echo test", false, 60, true)
            .is_err()
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while scope.list().unwrap().is_empty() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    // The writer is deliberately held until after revocation. A lock inversion
    // would deadlock here; no process has been authorised to launch yet.
    auth.revoke(1).unwrap();
    assert!(!worker.is_finished());
    drop(disk);
    assert!(worker.join().unwrap());
    assert_eq!(scope.list().unwrap()[0].status, JobStatus::Interrupted);
}
#[test]
fn metadata_survives_restart_without_commands_or_output_and_never_replays() {
    let root = tempfile::tempdir().unwrap();
    let auth = ComputerAuthority::load(root.path()).unwrap();
    let ticket = auth.begin_agent(1).unwrap();
    let manager = JobManager::default();
    let scope = manager.scope(root.path()).unwrap();
    let session = scope
        .start(
            &ticket,
            None,
            "echo nonsecret-private-command",
            false,
            60,
            true,
        )
        .unwrap();
    let id = session.id.clone();
    session.running().unwrap();
    // Simulate abrupt owner loss: retain the durable Running state rather than
    // using the ordinary interrupted-on-drop finalizer.
    let JobSession {
        scope: owner,
        id: _,
        output,
        finished: _,
    } = &session;
    assert_eq!(owner.list().unwrap()[0].status, JobStatus::Running);
    output.close();
    let bytes = std::fs::read_to_string(root.path().join("command-jobs/jobs.json")).unwrap();
    assert!(!bytes.contains("nonsecret-private-command"));
    drop(session);
    // The normal drop is also a durable interruption. A separately saved live
    // record below exercises crash reconciliation with the same disk format.
    scope
        .update(&id, |r| r.status = JobStatus::Running)
        .unwrap();
    drop(scope);
    drop(manager);
    let reopened = JobManager::default();
    let recovered = reopened.scope(root.path()).unwrap();
    let record = recovered.record(&id).unwrap();
    assert_eq!(record.status, JobStatus::Interrupted);
    assert!(record.message.unwrap().contains("No replay"));
    assert_eq!(
        recovered.output(&id, 1, 0).unwrap()["outputUnavailable"],
        true
    );
}
#[test]
fn scoped_output_stop_and_generation_fences_cannot_retarget_a_job() {
    let root = tempfile::tempdir().unwrap();
    let auth = ComputerAuthority::load(root.path()).unwrap();
    let ticket = auth.begin_agent(1).unwrap();
    let manager = JobManager::default();
    let a = manager.scope(root.path()).unwrap();
    let b = manager.scope(&root.path().join("another-agent")).unwrap();
    let session = a
        .start(&ticket, None, "echo test", false, 60, true)
        .unwrap();
    assert!(b.output(&session.id, 1, 0).is_err());
    assert!(a.output(&session.id, 2, 0).is_err());
    assert!(a.stop(&session.id, 2).is_err());
    assert!(ticket.check().is_ok());
    assert_eq!(a.stop(&session.id, 1).unwrap().status, JobStatus::Stopping);
    assert!(ticket.check().is_err());
}
#[test]
fn output_observation_disconnect_does_not_own_execution_and_admission_is_bounded() {
    let root = tempfile::tempdir().unwrap();
    let auth = ComputerAuthority::load(root.path()).unwrap();
    let manager = JobManager::default();
    let scope = manager.scope(root.path()).unwrap();
    let tickets: Vec<_> = (0..5).map(|_| auth.begin_agent(1).unwrap()).collect();
    let sessions: Vec<_> = tickets[..4]
        .iter()
        .map(|ticket| {
            scope
                .start(ticket, None, "echo test", false, 60, true)
                .unwrap()
        })
        .collect();
    let page = scope.output(&sessions[0].id, 1, 0).unwrap();
    drop(page);
    assert!(tickets[0].check().is_ok());
    assert!(scope
        .start(&tickets[4], None, "echo test", false, 60, true)
        .is_err());
    auth.revoke(1).unwrap();
    assert!(scope
        .start(&tickets[4], None, "echo test", false, 60, true)
        .is_err());
    assert!(tickets.iter().all(|t| t.check().is_err()));
}

//! Durable computer authority, independent of the browser connection.
//!
//! Admission and revocation share one short lock. Revocation invalidates every
//! admitted operation before waiting for it; human input is enabled only after
//! the old operations have drained. A ticket is an in-flight operation, not a
//! reusable capability. Results are checked again before crossing the boundary.

use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    time::{Duration, Instant},
};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};

use super::{LocalComputerController, HUMAN_CONTROL_LEASE_MINUTES};

const MAX_GENERATION: u64 = 9_007_199_254_740_991;
const STALE: &str = "Computer control changed. Refresh the computer before continuing; the previous result was discarded.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableAuthority {
    version: u8,
    controller: LocalComputerController,
    generation: u64,
    lease_expires_at: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct AuthoritySnapshot {
    pub controller: LocalComputerController,
    pub generation: u64,
    pub lease_expires_at: Option<String>,
    pub transitioning: bool,
}

struct Inner {
    durable: DurableAuthority,
    transitioning: bool,
    next_operation: u64,
    operations: HashMap<u64, Arc<AtomicBool>>,
    last_activity: Instant,
    pending_cancellations: usize,
}

pub(crate) struct ComputerAuthority {
    path: PathBuf,
    inner: Mutex<Inner>,
    drained: Condvar,
    self_weak: Weak<ComputerAuthority>,
    process_cancel: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
}

pub(crate) struct OperationTicket {
    authority: Arc<ComputerAuthority>,
    id: u64,
    pub generation: u64,
    controller: LocalComputerController,
    cancellation: Arc<AtomicBool>,
}

impl ComputerAuthority {
    #[cfg(test)]
    pub(super) fn load(directory: &Path) -> Result<Arc<Self>, String> {
        Self::load_with_cancellation(directory, None)
    }

    pub(super) fn load_with_cancellation(
        directory: &Path,
        process_cancel: Option<Arc<dyn Fn() -> Result<(), String> + Send + Sync>>,
    ) -> Result<Arc<Self>, String> {
        std::fs::create_dir_all(directory)
            .map_err(|_| "Fable could not prepare computer authority storage.".to_string())?;
        crate::paths::strict_canonicalize(directory)
            .map_err(|_| "Computer authority storage failed its security check.".to_string())?;
        let path = directory.join("control.json");
        let durable = if path.exists() {
            crate::paths::strict_canonicalize(&path)
                .map_err(|_| "Computer authority storage failed its security check.".to_string())?;
            let bytes = std::fs::read(&path)
                .map_err(|_| "Fable could not read computer control state.".to_string())?;
            if bytes.len() > 4096 {
                return Err("Computer control state is invalid. Recovery is required.".into());
            }
            let previous: DurableAuthority = serde_json::from_slice(&bytes).map_err(|_| {
                "Computer control state is invalid. Recovery is required.".to_string()
            })?;
            if previous.version != 1 || previous.generation == 0 {
                return Err("Computer control state is unsupported. Recovery is required.".into());
            }
            // A new native process never inherits permission to resume an old
            // agent or human session. Reconnecting requires an explicit choice.
            DurableAuthority {
                version: 1,
                controller: LocalComputerController::Paused,
                generation: next_generation(previous.generation)?,
                lease_expires_at: None,
            }
        } else {
            DurableAuthority {
                version: 1,
                controller: LocalComputerController::Agent,
                generation: 1,
                lease_expires_at: None,
            }
        };
        persist(&path, &durable)?;
        Ok(Arc::new_cyclic(|self_weak| Self {
            path,
            inner: Mutex::new(Inner {
                durable,
                transitioning: false,
                next_operation: 0,
                operations: HashMap::new(),
                last_activity: Instant::now(),
                pending_cancellations: 0,
            }),
            drained: Condvar::new(),
            self_weak: self_weak.clone(),
            process_cancel,
        }))
    }

    pub(crate) fn snapshot(&self) -> Result<AuthoritySnapshot, String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        self.expire(&mut inner, Utc::now())?;
        Ok(projection(&inner))
    }

    pub(crate) fn begin_agent(
        self: &Arc<Self>,
        expected_generation: u64,
    ) -> Result<OperationTicket, String> {
        self.begin(LocalComputerController::Agent, expected_generation)
    }

    pub(crate) fn begin_human(
        self: &Arc<Self>,
        expected_generation: u64,
    ) -> Result<OperationTicket, String> {
        self.begin(LocalComputerController::Human, expected_generation)
    }

    fn begin(
        self: &Arc<Self>,
        controller: LocalComputerController,
        expected_generation: u64,
    ) -> Result<OperationTicket, String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        self.expire(&mut inner, Utc::now())?;
        if inner.transitioning
            || inner.durable.controller != controller
            || inner.durable.generation != expected_generation
        {
            return Err(
                if inner.durable.controller == LocalComputerController::Paused {
                    "Computer actions and agent observation are paused. Explicitly return control to the agent to continue.".into()
                } else {
                    STALE.into()
                },
            );
        }
        inner.next_operation = inner
            .next_operation
            .checked_add(1)
            .ok_or_else(|| "The computer operation counter is exhausted.".to_string())?;
        let id = inner.next_operation;
        let cancellation = Arc::new(AtomicBool::new(false));
        inner.operations.insert(id, cancellation.clone());
        inner.last_activity = Instant::now();
        Ok(OperationTicket {
            authority: self.clone(),
            id,
            generation: expected_generation,
            controller,
            cancellation,
        })
    }

    /// Revoke immediately. Callers must stop external processes and drain old
    /// tickets before completing the transition. Failure leaves control paused.
    pub(crate) fn revoke(&self, expected_generation: u64) -> Result<u64, String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        self.expire(&mut inner, Utc::now())?;
        if inner.durable.generation != expected_generation || inner.transitioning {
            return Err(STALE.into());
        }
        revoke_inner(&mut inner)?;
        inner.transitioning = true;
        // Revocation remains effective in memory even if disk is unavailable.
        if let Err(error) = persist(&self.path, &inner.durable) {
            inner.transitioning = false;
            return Err(error);
        }
        Ok(inner.durable.generation)
    }

    /// Admission, viewer arrival, and idle suspension use the same lock, so
    /// suspension cannot race a newly admitted operation or viewer session.
    pub(crate) fn revoke_if_idle(
        &self,
        expected_generation: u64,
        idle_for: Duration,
    ) -> Result<Option<u64>, String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        self.expire(&mut inner, Utc::now())?;
        if inner.durable.generation != expected_generation
            || inner.transitioning
            || inner.durable.controller == LocalComputerController::Human
            || !inner.operations.is_empty()
            || inner.pending_cancellations != 0
            || inner.last_activity.elapsed() < idle_for
        {
            return Ok(None);
        }
        revoke_inner(&mut inner)?;
        inner.transitioning = true;
        if let Err(error) = persist(&self.path, &inner.durable) {
            inner.transitioning = false;
            return Err(error);
        }
        Ok(Some(inner.durable.generation))
    }

    pub(crate) fn is_idle_for(&self, idle_for: Duration) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            !inner.transitioning
                && inner.durable.controller != LocalComputerController::Human
                && inner.operations.is_empty()
                && inner.pending_cancellations == 0
                && inner.last_activity.elapsed() >= idle_for
        })
    }

    pub(crate) fn note_viewer_activity(&self, expected_generation: u64) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        self.expire(&mut inner, Utc::now())?;
        if inner.durable.generation != expected_generation || inner.transitioning {
            return Err(STALE.into());
        }
        inner.last_activity = Instant::now();
        Ok(())
    }

    pub(crate) fn drain(&self, generation: u64, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        while !inner.operations.is_empty() || inner.pending_cancellations != 0 {
            if inner.durable.generation != generation {
                return Err(STALE.into());
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                inner.transitioning = false;
                return Err("The previous computer action has not stopped. Control remains paused; wait and retry taking control.".into());
            };
            let (next, timed_out) = self
                .drained
                .wait_timeout(inner, remaining)
                .map_err(|_| unavailable())?;
            inner = next;
            if timed_out.timed_out()
                && (!inner.operations.is_empty() || inner.pending_cancellations != 0)
            {
                inner.transitioning = false;
                return Err("The previous computer action has not stopped. Control remains paused; wait and retry taking control.".into());
            }
        }
        Ok(())
    }

    pub(crate) fn complete_transition(
        &self,
        generation: u64,
        controller: LocalComputerController,
    ) -> Result<AuthoritySnapshot, String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        if inner.durable.generation != generation
            || !inner.transitioning
            || !inner.operations.is_empty()
            || inner.pending_cancellations != 0
        {
            return Err(STALE.into());
        }
        let next = DurableAuthority {
            version: 1,
            controller,
            generation,
            lease_expires_at: (controller == LocalComputerController::Human).then(|| {
                (Utc::now() + ChronoDuration::minutes(HUMAN_CONTROL_LEASE_MINUTES)).to_rfc3339()
            }),
        };
        persist(&self.path, &next)?;
        inner.durable = next;
        inner.transitioning = false;
        inner.last_activity = Instant::now();
        Ok(projection(&inner))
    }

    pub(crate) fn abandon_transition(&self, generation: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.durable.generation == generation {
                inner.transitioning = false;
            }
        }
    }

    pub(crate) fn check_generation(
        &self,
        expected_generation: u64,
    ) -> Result<AuthoritySnapshot, String> {
        let snapshot = self.snapshot()?;
        if snapshot.generation != expected_generation || snapshot.transitioning {
            return Err(STALE.into());
        }
        Ok(snapshot)
    }

    fn expire(&self, inner: &mut Inner, now: DateTime<Utc>) -> Result<(), String> {
        if inner.durable.controller == LocalComputerController::Human
            && inner
                .durable
                .lease_expires_at
                .as_deref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .is_none_or(|value| value <= now)
        {
            revoke_inner(inner)?;
            // Expiry grants neither actor authority. Explicit transition still
            // drains a human input operation that was already admitted.
            inner.transitioning = false;
            self.schedule_process_cancellation(inner)?;
            persist(&self.path, &inner.durable)?;
        }
        Ok(())
    }

    /// Viewer loss has the same process boundary as lease expiry. Cleanup is a
    /// drain barrier, so it cannot run late against a subsequently resumed agent.
    pub(crate) fn pause_disconnected(&self, expected_generation: u64) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        self.expire(&mut inner, Utc::now())?;
        if inner.durable.generation != expected_generation
            || inner.durable.controller != LocalComputerController::Human
        {
            return Ok(());
        }
        revoke_inner(&mut inner)?;
        inner.transitioning = false;
        self.schedule_process_cancellation(&mut inner)?;
        persist(&self.path, &inner.durable)
    }

    pub(super) fn pause_for_shutdown(&self) -> Result<u64, String> {
        let mut inner = self.inner.lock().map_err(|_| unavailable())?;
        // Cancellation still happens when the generation cannot advance.
        let _ = revoke_inner(&mut inner);
        inner.transitioning = true;
        let generation = inner.durable.generation;
        let cleanup = self.schedule_process_cancellation(&mut inner);
        let persisted = persist(&self.path, &inner.durable);
        cleanup.and(persisted).map(|()| generation)
    }

    fn schedule_process_cancellation(&self, inner: &mut Inner) -> Result<(), String> {
        let Some(cancel) = self.process_cancel.clone() else {
            return Ok(());
        };
        inner.pending_cancellations += 1;
        let authority = self.self_weak.clone();
        let spawned = std::thread::Builder::new()
            .name("fable-computer-pause".into())
            .spawn(move || {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = cancel();
                    // Ignore this cleanup's own barrier, but wait for the admitted
                    // input/launch operations before draining late-created jobs.
                    if let Some(authority) = authority.upgrade() {
                        let deadline = Instant::now() + Duration::from_secs(20);
                        if let Ok(mut inner) = authority.inner.lock() {
                            while !inner.operations.is_empty() {
                                let Some(remaining) =
                                    deadline.checked_duration_since(Instant::now())
                                else {
                                    return;
                                };
                                let Ok((next, timeout)) =
                                    authority.drained.wait_timeout(inner, remaining)
                                else {
                                    return;
                                };
                                inner = next;
                                if timeout.timed_out() && !inner.operations.is_empty() {
                                    return;
                                }
                            }
                        }
                    }
                    let _ = cancel();
                }));
                if let Some(authority) = authority.upgrade() {
                    if let Ok(mut inner) = authority.inner.lock() {
                        inner.pending_cancellations = inner.pending_cancellations.saturating_sub(1);
                        authority.drained.notify_all();
                    }
                }
            });
        if spawned.is_err() {
            inner.pending_cancellations -= 1;
            return Err("Computer actions are paused, but process cleanup could not start. Retry taking control.".into());
        }
        Ok(())
    }
}

impl OperationTicket {
    pub(crate) fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancellation.clone()
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(STALE.into());
        }
        let snapshot = self.authority.check_generation(self.generation)?;
        if snapshot.controller != self.controller {
            return Err(STALE.into());
        }
        Ok(())
    }

    pub(crate) fn finish<T>(self, result: Result<T, String>) -> Result<T, String> {
        self.check()?;
        result
    }

    pub(super) fn renew_human(&self) -> Result<(), String> {
        let mut inner = self.authority.inner.lock().map_err(|_| unavailable())?;
        self.authority.expire(&mut inner, Utc::now())?;
        if self.controller != LocalComputerController::Human
            || inner.durable.controller != self.controller
            || inner.durable.generation != self.generation
            || inner.transitioning
            || self.cancellation.load(Ordering::Acquire)
        {
            return Err(STALE.into());
        }
        // Input stays responsive without a durable write on every keystroke.
        if inner
            .durable
            .lease_expires_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|expiry| {
                expiry.with_timezone(&Utc)
                    > Utc::now() + ChronoDuration::minutes(HUMAN_CONTROL_LEASE_MINUTES - 1)
            })
        {
            return Ok(());
        }
        inner.durable.lease_expires_at =
            Some((Utc::now() + ChronoDuration::minutes(HUMAN_CONTROL_LEASE_MINUTES)).to_rfc3339());
        if let Err(error) = persist(&self.authority.path, &inner.durable) {
            revoke_inner(&mut inner)?;
            inner.transitioning = false;
            return Err(error);
        }
        Ok(())
    }
}

impl Drop for OperationTicket {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.authority.inner.lock() {
            inner.operations.remove(&self.id);
            inner.last_activity = Instant::now();
            self.authority.drained.notify_all();
        }
    }
}

fn revoke_inner(inner: &mut Inner) -> Result<(), String> {
    // Cancel first even if advancing/persisting the generation fails.
    for cancellation in inner.operations.values() {
        cancellation.store(true, Ordering::Release);
    }
    inner.durable.controller = LocalComputerController::Paused;
    inner.durable.lease_expires_at = None;
    inner.durable.generation = next_generation(inner.durable.generation)?;
    Ok(())
}

fn next_generation(previous: u64) -> Result<u64, String> {
    previous
        .checked_add(1)
        .filter(|next| *next <= MAX_GENERATION)
        .ok_or_else(|| "The computer control generation is exhausted.".to_string())
}

fn projection(inner: &Inner) -> AuthoritySnapshot {
    AuthoritySnapshot {
        controller: inner.durable.controller,
        generation: inner.durable.generation,
        lease_expires_at: inner.durable.lease_expires_at.clone(),
        transitioning: inner.transitioning,
    }
}

fn persist(path: &Path, state: &DurableAuthority) -> Result<(), String> {
    let parent = path.parent().ok_or_else(unavailable)?;
    let mut pending = tempfile::NamedTempFile::new_in(parent).map_err(|_| {
        "Fable could not save computer control state. Control remains paused.".to_string()
    })?;
    serde_json::to_writer(&mut pending, state).map_err(|_| unavailable())?;
    pending
        .flush()
        .and_then(|()| pending.as_file().sync_all())
        .map_err(|_| {
            "Fable could not save computer control state. Control remains paused.".to_string()
        })?;
    pending.persist(path).map_err(|_| {
        "Fable could not save computer control state. Control remains paused.".to_string()
    })?;
    Ok(())
}

fn unavailable() -> String {
    "Computer control state is unavailable. Actions remain paused.".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revocation_cancels_inflight_work_before_drain_and_blocks_both_actors() {
        let temp = tempfile::tempdir().unwrap();
        let authority = ComputerAuthority::load(temp.path()).unwrap();
        let old = authority.begin_agent(1).unwrap();
        let cancellation = old.cancellation();
        let generation = authority.revoke(1).unwrap();
        assert!(cancellation.load(Ordering::Acquire));
        assert_eq!(
            authority.snapshot().unwrap().controller,
            LocalComputerController::Paused
        );
        assert!(authority.begin_agent(generation).is_err());
        assert!(authority.begin_human(generation).is_err());
        assert!(authority
            .complete_transition(generation, LocalComputerController::Human)
            .is_err());
        assert!(old.finish(Ok("private previous output")).is_err());
        authority.drain(generation, Duration::from_secs(1)).unwrap();
        authority
            .complete_transition(generation, LocalComputerController::Human)
            .unwrap();
        assert!(authority.begin_agent(generation).is_err());
        assert!(authority.begin_human(1).is_err());
        assert!(authority.begin_human(generation).is_ok());
    }

    #[test]
    fn process_restart_and_expired_human_lease_require_explicit_resume() {
        let temp = tempfile::tempdir().unwrap();
        let authority = ComputerAuthority::load(temp.path()).unwrap();
        let generation = authority.revoke(1).unwrap();
        authority
            .complete_transition(generation, LocalComputerController::Human)
            .unwrap();
        {
            let mut inner = authority.inner.lock().unwrap();
            authority
                .expire(&mut inner, Utc::now() + ChronoDuration::minutes(6))
                .unwrap();
        }
        let expired = authority.snapshot().unwrap();
        assert_eq!(expired.controller, LocalComputerController::Paused);
        assert!(authority.begin_agent(expired.generation).is_err());
        let resume = authority.revoke(expired.generation).unwrap();
        authority
            .complete_transition(resume, LocalComputerController::Agent)
            .unwrap();
        drop(authority);
        let restarted = ComputerAuthority::load(temp.path()).unwrap();
        let state = restarted.snapshot().unwrap();
        assert_eq!(state.controller, LocalComputerController::Paused);
        assert!(state.generation > resume);
        assert!(restarted.begin_agent(state.generation).is_err());
    }

    #[test]
    fn bounded_drain_failure_never_grants_control_and_can_recover() {
        let temp = tempfile::tempdir().unwrap();
        let authority = ComputerAuthority::load(temp.path()).unwrap();
        let pending = authority.begin_agent(1).unwrap();
        let generation = authority.revoke(1).unwrap();
        assert!(authority.drain(generation, Duration::ZERO).is_err());
        assert!(authority
            .complete_transition(generation, LocalComputerController::Human)
            .is_err());
        drop(pending);
        let retry = authority.revoke(generation).unwrap();
        authority.drain(retry, Duration::from_secs(1)).unwrap();
        authority
            .complete_transition(retry, LocalComputerController::Human)
            .unwrap();
    }

    #[test]
    fn queued_operation_and_late_result_cannot_cross_return_control() {
        let temp = tempfile::tempdir().unwrap();
        let authority = ComputerAuthority::load(temp.path()).unwrap();
        let observed_generation = authority.snapshot().unwrap().generation;
        let generation = authority.revoke(observed_generation).unwrap();
        authority
            .complete_transition(generation, LocalComputerController::Human)
            .unwrap();
        let input = authority.begin_human(generation).unwrap();
        let return_generation = authority.revoke(generation).unwrap();
        assert!(input.finish(Ok("human-only frame")).is_err());
        authority
            .drain(return_generation, Duration::from_secs(1))
            .unwrap();
        authority
            .complete_transition(return_generation, LocalComputerController::Agent)
            .unwrap();
        assert!(authority.begin_agent(observed_generation).is_err());
        assert!(authority.begin_agent(return_generation).is_ok());
    }

    #[test]
    fn corrupt_state_and_exhausted_generations_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("control.json"), "broken").unwrap();
        assert!(ComputerAuthority::load(temp.path()).is_err());
        assert!(next_generation(MAX_GENERATION).is_err());
        assert!(next_generation(u64::MAX).is_err());
    }

    #[test]
    fn revoking_one_computer_does_not_cancel_another() {
        let temp = tempfile::tempdir().unwrap();
        let first = ComputerAuthority::load(&temp.path().join("first")).unwrap();
        let second = ComputerAuthority::load(&temp.path().join("second")).unwrap();
        let second_operation = second.begin_agent(1).unwrap();
        first.revoke(1).unwrap();
        assert!(second_operation.finish(Ok("isolated")).is_ok());
    }

    #[test]
    fn implicit_pause_cancels_processes_and_cleanup_cannot_cross_resume() {
        let temp = tempfile::tempdir().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let authority = ComputerAuthority::load_with_cancellation(
            temp.path(),
            Some(Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                let _ = started_tx.send(());
                Ok(())
            })),
        )
        .unwrap();
        let human = authority.revoke(1).unwrap();
        authority
            .complete_transition(human, LocalComputerController::Human)
            .unwrap();
        let pending_launch = authority.begin_human(human).unwrap();
        authority.pause_disconnected(human).unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let paused = authority.snapshot().unwrap();
        assert_eq!(paused.controller, LocalComputerController::Paused);
        let resume = authority.revoke(paused.generation).unwrap();
        assert!(authority
            .complete_transition(resume, LocalComputerController::Agent)
            .is_err());
        assert!(pending_launch.finish(Ok(())).is_err());
        authority.drain(resume, Duration::from_secs(2)).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        authority
            .complete_transition(resume, LocalComputerController::Agent)
            .unwrap();
    }

    #[test]
    fn idle_suspension_cannot_cross_operation_completion_or_viewer_arrival() {
        let temp = tempfile::tempdir().unwrap();
        let authority = ComputerAuthority::load(temp.path()).unwrap();
        let idle_for = Duration::from_secs(60);
        let age = |authority: &ComputerAuthority| {
            authority.inner.lock().unwrap().last_activity = Instant::now() - idle_for;
        };
        age(&authority);
        let operation = authority.begin_agent(1).unwrap();
        age(&authority);
        assert_eq!(authority.revoke_if_idle(1, idle_for).unwrap(), None);
        drop(operation);
        assert_eq!(authority.revoke_if_idle(1, idle_for).unwrap(), None);
        age(&authority);
        authority.note_viewer_activity(1).unwrap();
        assert_eq!(authority.revoke_if_idle(1, idle_for).unwrap(), None);
        age(&authority);
        let generation = authority.revoke_if_idle(1, idle_for).unwrap().unwrap();
        assert!(authority.note_viewer_activity(1).is_err());
        assert!(authority.note_viewer_activity(generation).is_err());
        authority
            .complete_transition(generation, LocalComputerController::Human)
            .unwrap();
        age(&authority);
        assert_eq!(
            authority.revoke_if_idle(generation, idle_for).unwrap(),
            None
        );
    }
}

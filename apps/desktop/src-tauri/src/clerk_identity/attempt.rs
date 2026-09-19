//! Exact, single-use login attempts. Cancellation and credential commit share
//! one lock so a late browser callback cannot sign in after Back has completed.
use std::sync::Mutex;
use tokio::sync::watch;

#[derive(Default)]
pub(super) struct Attempts(Mutex<Option<Attempt>>);

struct Attempt {
    id: String,
    started: bool,
    committed: bool,
    cancelled: watch::Sender<bool>,
}

impl Attempts {
    pub(super) fn prepare(&self, id: String) -> Result<String, String> {
        let mut current = self.0.lock().map_err(|_| "Account request unavailable.")?;
        if let Some(previous) = current.as_ref() {
            if previous.committed {
                return Err("Your account is verified. Mivlet is reopening your workspace.".into());
            }
            // A renderer reload may lose its handle. A new explicit request
            // supersedes the old one without allowing either callback to race.
            previous.cancelled.send_replace(true);
        }
        let (cancelled, _) = watch::channel(false);
        *current = Some(Attempt {
            id: id.clone(),
            started: false,
            committed: false,
            cancelled,
        });
        Ok(id)
    }

    pub(super) fn start(&self, id: &str) -> Result<watch::Receiver<bool>, String> {
        let mut current = self.0.lock().map_err(|_| "Account request unavailable.")?;
        let attempt = current
            .as_mut()
            .filter(|a| a.id == id && !a.started)
            .ok_or("This account request has ended. Start again from Mivlet.")?;
        attempt.started = true;
        Ok(attempt.cancelled.subscribe())
    }

    pub(super) fn cancel(&self, id: &str) -> Result<bool, String> {
        let mut current = self.0.lock().map_err(|_| "Account request unavailable.")?;
        if let Some(attempt) = current.as_ref().filter(|a| a.id == id) {
            if attempt.committed {
                return Ok(false);
            }
            attempt.cancelled.send_replace(true);
            *current = None;
        }
        Ok(true)
    }

    pub(super) fn commit<T>(
        &self,
        id: &str,
        save: impl FnOnce() -> Result<T, super::IdentityError>,
    ) -> Result<T, super::IdentityError> {
        let mut current = self
            .0
            .lock()
            .map_err(|_| super::identity_error("unknown", "Account request unavailable.", false))?;
        let attempt = current
            .as_mut()
            .filter(|a| a.id == id && a.started && !a.committed)
            .ok_or_else(|| {
                super::identity_error(
                    "sign-in-cancelled",
                    "Sign-in cancelled. You can log in or create an account.",
                    false,
                )
            })?;
        let result = save()?;
        attempt.committed = true;
        Ok(result)
    }

    pub(super) fn finish(&self, id: &str) {
        if let Ok(mut current) = self.0.lock() {
            if current.as_ref().is_some_and(|a| a.id == id && !a.committed) {
                *current = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_closes_wait_and_rejects_late_commit_and_replay() {
        let attempts = Attempts::default();
        attempts.prepare("first".into()).unwrap();
        let mut wait = attempts.start("first").unwrap();
        assert!(attempts.start("first").is_err());
        assert!(attempts.cancel("first").unwrap());
        wait.changed().await.unwrap();
        assert!(*wait.borrow());
        assert!(attempts.commit("first", || Ok(())).is_err());
        attempts.prepare("second".into()).unwrap();
        attempts.finish("first");
        attempts.cancel("first").unwrap();
        attempts.start("second").unwrap();
        assert!(attempts.commit("second", || Ok(())).is_ok());
        assert!(!attempts.cancel("second").unwrap());
        assert!(attempts.prepare("third".into()).is_err());
    }

    #[test]
    fn cancel_before_start_and_failed_commit_are_recoverable() {
        let attempts = Attempts::default();
        attempts.prepare("first".into()).unwrap();
        attempts.cancel("first").unwrap();
        assert!(attempts.start("first").is_err());
        attempts.prepare("second".into()).unwrap();
        attempts.start("second").unwrap();
        assert!(attempts
            .commit::<()>("second", || Err(super::super::identity_error(
                "offline", "offline", true
            )))
            .is_err());
        attempts.finish("second");
        assert!(attempts.prepare("third".into()).is_ok());
    }

    #[tokio::test]
    async fn a_new_request_after_renderer_reload_cancels_the_previous_one() {
        let attempts = Attempts::default();
        attempts.prepare("old".into()).unwrap();
        let mut old = attempts.start("old").unwrap();
        attempts.prepare("new".into()).unwrap();
        old.changed().await.unwrap();
        assert!(*old.borrow());
        assert!(attempts.commit("old", || Ok(())).is_err());
        attempts.finish("old");
        assert!(attempts.start("new").is_ok());
    }
}

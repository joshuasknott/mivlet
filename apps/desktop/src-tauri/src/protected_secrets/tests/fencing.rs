use super::*;
use std::sync::{atomic::AtomicUsize, Arc};

#[derive(Default)]
struct Identity {
    generation: u64,
    closing: bool,
}

struct AccountFence {
    identity: Arc<Mutex<Identity>>,
    change_at_commit: AtomicUsize,
}
impl Fence for AccountFence {
    fn check(&self) -> Result<(), Failure> {
        let identity = self.identity.try_lock().map_err(|_| Failure::Stopped)?;
        if identity.generation != 0 || identity.closing {
            return Err(Failure::Stopped);
        }
        Ok(())
    }
    fn commit<T>(&self, operation: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure> {
        let mut identity = self.identity.try_lock().map_err(|_| Failure::Stopped)?;
        match self.change_at_commit.load(Ordering::SeqCst) {
            1 => identity.generation += 1,
            2 => identity.closing = true,
            _ => {}
        }
        if identity.generation != 0 || identity.closing {
            return Err(Failure::Stopped);
        }
        operation()
    }
}

fn account_store() -> (Store, AccountFence, Arc<AtomicUsize>) {
    let identity = Arc::new(Mutex::new(Identity::default()));
    let checks = Arc::new(AtomicUsize::new(0));
    let checked_identity = identity.clone();
    let counted_checks = checks.clone();
    let store = store().with_test_account_check(move || {
        // The production account check locks the identity mutex. Fail fast on
        // re-entry here so a regression fails CI instead of hanging its runner.
        let identity = checked_identity.try_lock().map_err(|_| {
            crate::store::StoreError::Invalid("Account check re-entered identity lock.".into())
        })?;
        counted_checks.fetch_add(1, Ordering::SeqCst);
        if identity.closing {
            return Err(crate::store::StoreError::Invalid("Account closed.".into()));
        }
        Ok(())
    });
    (
        store,
        AccountFence {
            identity,
            change_at_commit: AtomicUsize::new(0),
        },
        checks,
    )
}

#[test]
fn protected_request_account_owned_lifecycle_never_reenters_identity() {
    let (store, fence, checks) = account_store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let request = s
        .begin(&scope(), "account-owned", input(), 1000, &fence)
        .unwrap();
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    let saved = s
        .answer(&request, Some(Secret::new(CANARY.into())), 1001, &fence)
        .unwrap();
    assert_eq!(saved.status, Status::Ready);
    let key = s
        .install(&scope(), install(&request), 1002, &fence)
        .unwrap();
    assert!(key.configured);
    assert_eq!(s.history(&scope()).unwrap()[0].status, Status::Consumed);
    assert!(
        !s.revoke_key(&scope(), &key.key_id, "releases", &fence)
            .unwrap()
            .configured
    );
    assert!(custody.values.lock().unwrap().is_empty());
}

#[test]
fn protected_request_account_change_at_commit_rolls_back_prepared_metadata() {
    for change in [1, 2] {
        let (store, fence, checks) = account_store();
        let custody = MemoryCustody::default();
        let s = service(&store, &custody);
        fence.change_at_commit.store(change, Ordering::SeqCst);
        assert!(matches!(
            s.begin(&scope(), "invalidated", input(), 1000, &fence),
            Err(Failure::Stopped)
        ));
        // Both account checks succeeded; cached generation/sign-out changed
        // only after SQL preparation, immediately before the guarded COMMIT.
        assert_eq!(checks.load(Ordering::SeqCst), 2);
        *fence.identity.lock().unwrap() = Identity::default();
        assert!(s.history(&scope()).unwrap().is_empty());
        assert!(custody.values.lock().unwrap().is_empty());
    }
}

#[test]
fn protected_request_account_check_after_preparation_rolls_back() {
    let (store, fence, _) = account_store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    s.begin(&scope(), "retained", input(), 1000, &fence)
        .unwrap();
    let result = repository::update_fenced(&store, &fence, |records| {
        records.requests.clear();
        fence.identity.lock().unwrap().closing = true;
        Ok(())
    });
    assert!(result.is_err());
    *fence.identity.lock().unwrap() = Identity::default();
    assert_eq!(s.history(&scope()).unwrap().len(), 1);
}

#[test]
fn protected_request_native_stop_at_commit_rolls_back_prepared_metadata() {
    struct Ticket(crate::local_computer::authority::OperationTicket);
    impl Fence for Ticket {
        fn check(&self) -> Result<(), Failure> {
            self.0.check().map_err(|_| Failure::Stopped)
        }
        fn commit<T>(&self, operation: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure> {
            self.0
                .with_current(|| Ok(operation()))
                .map_err(|_| Failure::Stopped)?
        }
    }
    let root = tempfile::tempdir().unwrap();
    let computers = crate::local_computer::LocalComputerState::for_test(root.path().into());
    let authority = computers.authority_for("default", "agent").unwrap();
    let generation = authority.snapshot().unwrap().generation;
    let fence = Ticket(authority.begin_viewer(generation).unwrap());
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    s.begin(&scope(), "retained", input(), 1000, &fence)
        .unwrap();
    let result = repository::update_fenced(&store, &fence, |records| {
        records.requests.clear();
        authority.revoke(generation).unwrap();
        Ok(())
    });
    assert_eq!(result, Err(Failure::Stopped));
    assert_eq!(s.history(&scope()).unwrap().len(), 1);
}

#[test]
fn protected_request_transaction_rechecks_pause_after_preflight() {
    struct PauseAfterPreflight<'a>(&'a Store, serde_json::Value);
    impl Fence for PauseAfterPreflight<'_> {
        fn check(&self) -> Result<(), Failure> {
            self.0.transaction(|tx| {
                crate::store::repos::preferences::upsert_scoped(
                    tx,
                    self.0,
                    &crate::store::repos::scope::DataScope::legacy_default(),
                    "executionControl",
                    &self.1,
                    "now",
                )
            })?;
            Ok(())
        }
        fn commit<T>(&self, operation: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure> {
            operation()
        }
    }
    for pause in [
        serde_json::json!({"paused":true,"revision":1,"changedAt":"now"}),
        serde_json::json!({"paused":"malformed"}),
    ] {
        let store = store();
        let custody = MemoryCustody::default();
        let s = service(&store, &custody);
        let fence = PauseAfterPreflight(&store, pause);
        assert!(matches!(
            s.begin(&scope(), "paused", input(), 1000, &fence),
            Err(Failure::Stopped)
        ));
        assert!(s.history(&scope()).unwrap().is_empty());
    }
}

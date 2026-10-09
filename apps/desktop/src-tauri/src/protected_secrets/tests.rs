use super::*;
mod fencing;
use crate::store::vault::{MasterKey, Vault};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

const CANARY: &str = "synthetic-test-material-53df3209678";
#[derive(Default)]
struct MemoryCustody {
    values: Mutex<HashMap<(String, String), String>>,
    fail_remove: AtomicBool,
    fail_put: AtomicBool,
    stop_after_put: AtomicBool,
    stopped: AtomicBool,
}
impl Custody for MemoryCustody {
    fn put(&self, account: &str, id: &str, value: &str) -> Result<(), Failure> {
        if self.fail_put.load(Ordering::SeqCst) {
            return Err(Failure::Custody);
        }
        self.values
            .lock()
            .unwrap()
            .insert((account.into(), id.into()), value.into());
        if self.stop_after_put.load(Ordering::SeqCst) {
            self.stopped.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    fn get(&self, account: &str, id: &str) -> Result<Option<Secret>, Failure> {
        Ok(self
            .values
            .lock()
            .unwrap()
            .get(&(account.into(), id.into()))
            .cloned()
            .map(Secret::new))
    }
    fn remove(&self, account: &str, id: &str) -> Result<(), Failure> {
        if self.fail_remove.load(Ordering::SeqCst) {
            return Err(Failure::Custody);
        }
        self.values
            .lock()
            .unwrap()
            .remove(&(account.into(), id.into()));
        Ok(())
    }
}
struct TestFence<'a>(&'a AtomicBool);
impl Fence for TestFence<'_> {
    fn check(&self) -> Result<(), Failure> {
        if self.0.load(Ordering::SeqCst) {
            Err(Failure::Stopped)
        } else {
            Ok(())
        }
    }
    fn commit<T>(&self, operation: impl FnOnce() -> Result<T, Failure>) -> Result<T, Failure> {
        self.check()?;
        operation()
    }
}
fn scope() -> Scope {
    Scope {
        account: "synthetic-account".into(),
        workspace: "default".into(),
        agent: "agent".into(),
        generation: 7,
    }
}
fn input() -> RequestInput {
    RequestInput {
        label: "Release webhook signing key".into(),
        reason: "Verify release events".into(),
        consumer: CONSUMER.into(),
        purpose: PURPOSE.into(),
        target_id: "releases".into(),
    }
}
fn store() -> Store {
    Store::open_in_memory(Vault::new(&MasterKey::generate().unwrap()).unwrap()).unwrap()
}
fn service<'a>(store: &'a Store, custody: &'a MemoryCustody) -> Service<'a, MemoryCustody> {
    Service {
        store,
        custody,
        boot: "boot-one",
    }
}
fn save(s: &Service<'_, MemoryCustody>) -> Record {
    let r = s
        .begin(
            &scope(),
            "approved-call-one",
            input(),
            1000,
            &TestFence(&s.custody.stopped),
        )
        .unwrap();
    let public = s
        .answer(
            &r,
            Some(Secret::new(CANARY.into())),
            1001,
            &TestFence(&s.custody.stopped),
        )
        .unwrap();
    assert_eq!(public.status, Status::Ready);
    assert_eq!(public.secret_ref.as_deref(), Some(r.reference.as_str()));
    r
}
fn install(r: &Record) -> webhook::InstallInput {
    webhook::InstallInput {
        request_id: r.id.clone(),
        secret_ref: r.reference.clone(),
        consumer: CONSUMER.into(),
        purpose: PURPOSE.into(),
        target_id: "releases".into(),
    }
}

#[test]
fn protected_request_installs_real_hmac_verifier_once_without_leaking() {
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = save(&s);
    let key = s
        .install(&scope(), install(&r), 1002, &TestFence(&custody.stopped))
        .unwrap();
    assert!(s
        .install(&scope(), install(&r), 1002, &TestFence(&custody.stopped))
        .is_err());
    assert!(custody
        .get(&scope().account, &r.reference)
        .unwrap()
        .is_none());
    let body = br#"{"event":"release"}"#;
    let signature = format!(
        "sha256={}",
        hex::encode(
            ring::hmac::sign(
                &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, CANARY.as_bytes()),
                body
            )
            .as_ref()
        )
    );
    assert!(s
        .verify(&scope(), &key.key_id, "releases", body, &signature)
        .unwrap());
    assert!(!s
        .verify(&scope(), &key.key_id, "releases", b"changed", &signature)
        .unwrap());
    assert!(!s
        .verify(&scope(), &key.key_id, "releases", body, "sha256=broken")
        .unwrap());
    assert!(s
        .verify(&scope(), &key.key_id, "another-target", body, &signature)
        .is_err());
    let public = serde_json::to_string(&s.history(&scope()).unwrap()).unwrap();
    assert!(!public.contains(CANARY));
    assert!(!public.contains("secretRef"));
    assert!(
        public.contains(&key.key_id),
        "Committed key identity must survive a lost response"
    );
    let metadata = repository::update(&store, |r| Ok(serde_json::to_string(r).unwrap())).unwrap();
    assert!(!metadata.contains(CANARY));
    store
        .with_conn(|conn| {
            let exported = crate::store::repos::preferences::documents_for_export(
                conn,
                &store,
                &crate::store::repos::scope::DataScope::legacy_default(),
            )?;
            assert!(!serde_json::to_string(&exported).unwrap().contains(CANARY));
            Ok(())
        })
        .unwrap();
    s.revoke_key(
        &scope(),
        &key.key_id,
        "releases",
        &TestFence(&custody.stopped),
    )
    .unwrap();
    assert!(s
        .verify(&scope(), &key.key_id, "releases", body, &signature)
        .is_err());
    assert!(custody.values.lock().unwrap().is_empty());
}

#[test]
fn protected_request_wrong_scope_and_consumer_do_not_burn_reference() {
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = save(&s);
    for altered in [
        Scope {
            account: "other".into(),
            ..scope()
        },
        Scope {
            workspace: "other".into(),
            ..scope()
        },
        Scope {
            agent: "other".into(),
            ..scope()
        },
        Scope {
            generation: 8,
            ..scope()
        },
    ] {
        assert!(s
            .install(&altered, install(&r), 1002, &TestFence(&custody.stopped))
            .is_err());
    }
    for field in 0..5 {
        let mut i = install(&r);
        match field {
            0 => i.consumer = "shell".into(),
            1 => i.purpose = "send-to-model".into(),
            2 => i.target_id = "different".into(),
            3 => i.secret_ref = "unknown".into(),
            _ => i.request_id = "wrong".into(),
        }
        assert!(s
            .install(&scope(), i, 1002, &TestFence(&custody.stopped))
            .is_err());
    }
    assert!(s
        .install(&scope(), install(&r), 1002, &TestFence(&custody.stopped))
        .is_ok());
}

#[test]
fn event_text_sanitizer_keeps_key_custody_and_scrubs_plain_and_json_escaped_material() {
    let store = store();
    let custody = MemoryCustody::default();
    let service = service(&store, &custody);
    let record = save(&service);
    let key = service
        .install(
            &scope(),
            install(&record),
            1002,
            &TestFence(&custody.stopped),
        )
        .unwrap();
    // An arbitrary signing value may not match credential heuristics. Its exact
    // JSON spelling must also disappear from the produced request.
    let material = "arbitrary-signing\"value\\with-newline\nand-extra-text";
    custody
        .put(&scope().account, &key.key_id, material)
        .unwrap();
    let quoted = serde_json::to_string(material).unwrap();
    let texts = vec![
        format!("Inspect {quoted}"),
        format!("Event: {material}"),
        "ordinary evidence".into(),
    ];
    let clean = service
        .redact_event_texts(&scope(), &key.key_id, "releases", &texts)
        .unwrap();
    assert!(!clean.join(" ").contains(material));
    assert!(!clean.join(" ").contains(&quoted[1..quoted.len() - 1]));
    assert!(clean[0].contains("[REDACTED]"));
    assert_eq!(clean[2], texts[2]);
    assert!(service
        .redact_event_texts(&scope(), &key.key_id, "wrong-target", &texts)
        .is_err());
    let other = Scope {
        account: "other".into(),
        ..scope()
    };
    assert!(service
        .redact_event_texts(&other, &key.key_id, "releases", &texts)
        .is_err());
    assert!(service
        .redact_event_texts(&scope(), &key.key_id, "releases", &vec!["value".into(); 14])
        .is_err());
    assert!(service
        .redact_event_texts(&scope(), &key.key_id, "releases", &["x".repeat(32_001)])
        .is_err());
    service
        .revoke_key(
            &scope(),
            &key.key_id,
            "releases",
            &TestFence(&custody.stopped),
        )
        .unwrap();
    assert!(service
        .redact_event_texts(&scope(), &key.key_id, "releases", &texts)
        .is_err());
}

#[test]
fn protected_request_concurrent_consumption_commits_exactly_one_key() {
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = save(&s);
    std::thread::scope(|threads| {
        let jobs = (0..12)
            .map(|_| {
                threads.spawn(|| {
                    s.install(&scope(), install(&r), 1002, &TestFence(&custody.stopped))
                        .is_ok()
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            jobs.into_iter()
                .map(|j| j.join().unwrap())
                .filter(|won| *won)
                .count(),
            1
        );
    });
    assert_eq!(custody.values.lock().unwrap().len(), 1);
}

#[test]
fn protected_request_decline_duplicate_answer_expiry_and_stop_are_terminal() {
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = s
        .begin(
            &scope(),
            "decline",
            input(),
            1000,
            &TestFence(&custody.stopped),
        )
        .unwrap();
    assert_eq!(
        s.answer(&r, None, 1001, &TestFence(&custody.stopped))
            .unwrap()
            .status,
        Status::Declined
    );
    assert!(s
        .answer(
            &r,
            Some(Secret::new(CANARY.into())),
            1001,
            &TestFence(&custody.stopped)
        )
        .is_err());
    assert!(custody.values.lock().unwrap().is_empty());
    let r = save(&s);
    assert!(s
        .answer(
            &r,
            Some(Secret::new("replacement-must-not-win".into())),
            1001,
            &TestFence(&custody.stopped)
        )
        .is_err());
    assert_eq!(
        custody
            .get(&scope().account, &r.reference)
            .unwrap()
            .unwrap()
            .as_str(),
        CANARY
    );
    assert!(s
        .install(
            &scope(),
            install(&r),
            r.expires_at,
            &TestFence(&custody.stopped)
        )
        .is_err());
    s.sweep(r.expires_at, |_| true).unwrap();
    assert!(custody.values.lock().unwrap().is_empty());
    let r = s
        .begin(
            &scope(),
            "stop-before-answer",
            input(),
            1000,
            &TestFence(&custody.stopped),
        )
        .unwrap();
    custody.stopped.store(true, Ordering::SeqCst);
    assert_eq!(
        s.answer(
            &r,
            Some(Secret::new(CANARY.into())),
            1001,
            &TestFence(&custody.stopped)
        )
        .unwrap_err(),
        Failure::Stopped
    );
    assert!(custody.values.lock().unwrap().is_empty());
}

#[test]
fn protected_request_stop_during_save_cleans_late_value() {
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = s
        .begin(
            &scope(),
            "stop-save",
            input(),
            1000,
            &TestFence(&custody.stopped),
        )
        .unwrap();
    custody.stop_after_put.store(true, Ordering::SeqCst);
    assert_eq!(
        s.answer(
            &r,
            Some(Secret::new(CANARY.into())),
            1001,
            &TestFence(&custody.stopped)
        )
        .unwrap_err(),
        Failure::Stopped
    );
    assert!(custody.values.lock().unwrap().is_empty());
    assert_eq!(s.history(&scope()).unwrap()[0].status, Status::Stopped);
}

#[test]
fn protected_request_stop_during_consumer_write_never_activates_key() {
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = save(&s);
    custody.stop_after_put.store(true, Ordering::SeqCst);
    assert!(s
        .install(&scope(), install(&r), 1002, &TestFence(&custody.stopped))
        .is_err());
    assert!(custody.values.lock().unwrap().is_empty());
    assert!(repository::update(&store, |r| Ok(r.signing_keys.is_empty())).unwrap());
}

#[test]
fn protected_request_cleanup_failure_is_durable_and_retried_without_handoff() {
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = save(&s);
    custody.fail_remove.store(true, Ordering::SeqCst);
    assert_eq!(
        s.install(&scope(), install(&r), 1002, &TestFence(&custody.stopped))
            .unwrap_err(),
        Failure::Custody
    );
    assert!(repository::update(&store, |r| Ok(
        r.requests[0].cleanup_pending && r.signing_keys.is_empty()
    ))
    .unwrap());
    custody.fail_remove.store(false, Ordering::SeqCst);
    s.sweep(1003, |_| true).unwrap();
    assert!(custody.values.lock().unwrap().is_empty());
    assert!(s
        .install(&scope(), install(&r), 1004, &TestFence(&custody.stopped))
        .is_err());
}

#[test]
fn protected_request_restart_cleans_every_interrupted_crash_phase() {
    for phase in [Status::Pending, Status::Ready, Status::Consuming] {
        let store = store();
        let custody = MemoryCustody::default();
        let s = service(&store, &custody);
        let r = save(&s);
        repository::update(&store, |rows| {
            rows.requests[0].status = phase;
            rows.requests[0].installing_key = Some("uncommitted-key".into());
            Ok(())
        })
        .unwrap();
        custody
            .put(&scope().account, "uncommitted-key", CANARY)
            .unwrap();
        let reopened = Service {
            store: &store,
            custody: &custody,
            boot: "new-process",
        };
        reopened.sweep(1003, |_| true).unwrap();
        assert!(custody.values.lock().unwrap().is_empty());
        assert_eq!(
            reopened.history(&scope()).unwrap()[0].status,
            Status::Interrupted
        );
        assert!(reopened
            .install(&scope(), install(&r), 1004, &TestFence(&custody.stopped))
            .is_err());
    }
}

#[test]
fn protected_request_installed_key_survives_encrypted_store_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let master = MasterKey::generate().unwrap();
    let custody = MemoryCustody::default();
    let path = temp.path().join("account.sqlite");
    let key = {
        let store = Store::open(&path, Vault::new(&master).unwrap()).unwrap();
        let s = service(&store, &custody);
        let r = save(&s);
        s.install(&scope(), install(&r), 1002, &TestFence(&custody.stopped))
            .unwrap()
    };
    let store = Store::open(&path, Vault::new(&master).unwrap()).unwrap();
    let s = Service {
        store: &store,
        custody: &custody,
        boot: "new-boot",
    };
    s.sweep(2000, |_| true).unwrap();
    assert!(
        s.key_status(&scope(), &key.key_id, "releases")
            .unwrap()
            .configured
    );
    let bytes = std::fs::read(path).unwrap();
    assert!(!bytes.windows(CANARY.len()).any(|w| w == CANARY.as_bytes()));
    assert!(!bytes
        .windows(r#"Release webhook"#.len())
        .any(|w| w == b"Release webhook"));
}

#[test]
fn protected_request_invalid_inputs_and_custody_failures_are_nonsecret() {
    let mut i = input();
    i.consumer = "any-tool".into();
    assert_eq!(i.validate(), Err(Failure::Invalid));
    i = input();
    i.label = "Release\u{202e} key".into();
    assert_eq!(i.validate(), Err(Failure::Invalid));
    assert!(serde_json::from_value::<RequestInput>(serde_json::json!({"label":"key", "reason":"reason", "consumer":CONSUMER, "purpose":PURPOSE, "targetId":"hook", "secret":CANARY})).is_err());
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let r = s
        .begin(
            &scope(),
            "storage-failed",
            input(),
            1000,
            &TestFence(&custody.stopped),
        )
        .unwrap();
    custody.fail_put.store(true, Ordering::SeqCst);
    let error = s
        .answer(
            &r,
            Some(Secret::new(CANARY.into())),
            1001,
            &TestFence(&custody.stopped),
        )
        .unwrap_err();
    assert_eq!(error, Failure::Custody);
    assert!(!error.to_string().contains(CANARY));
    assert_eq!(s.history(&scope()).unwrap()[0].status, Status::Failed);
}

#[test]
fn protected_request_real_native_generation_revokes_ready_reference() {
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
    let temp = tempfile::tempdir().unwrap();
    let computers = crate::local_computer::LocalComputerState::for_test(temp.path().into());
    let authority = computers.authority_for("default", "agent").unwrap();
    let mut scope = scope();
    scope.generation = authority.snapshot().unwrap().generation;
    let fence = Ticket(authority.begin_viewer(scope.generation).unwrap());
    let store = store();
    let custody = MemoryCustody::default();
    let s = service(&store, &custody);
    let request = s
        .begin(&scope, "native-stop", input(), 1000, &fence)
        .unwrap();
    s.answer(&request, Some(Secret::new(CANARY.into())), 1001, &fence)
        .unwrap();
    authority.revoke(scope.generation).unwrap();
    assert!(s.install(&scope, install(&request), 1002, &fence).is_err());
    s.sweep(1002, |_| fence.check().is_ok()).unwrap();
    assert!(custody.values.lock().unwrap().is_empty());
    assert_eq!(s.history(&scope).unwrap()[0].status, Status::Stopped);
}

#[cfg(windows)]
#[test]
#[ignore = "Writes and removes a random synthetic credential in the current Windows credential vault"]
fn protected_secret_native_vault_acceptance() {
    let account = opaque("synthetic-native-acceptance:").unwrap();
    let id = opaque("secret-ref:").unwrap();
    let custody = custody::NativeCustody;
    // Only synthetic material; account and entry are unique to this test.
    custody.put(&account, &id, CANARY).unwrap();
    let read = custody.get(&account, &id);
    let removed = custody.remove(&account, &id);
    assert!(removed.is_ok());
    assert!(
        read.unwrap().unwrap().as_str() == CANARY,
        "Synthetic vault round trip returned different material"
    );
    assert!(custody.get(&account, &id).unwrap().is_none());
}

#[cfg(windows)]
#[test]
#[ignore = "Opens only owned native test dialogs; uses synthetic input and no provider/account data"]
fn protected_secret_native_entry_acceptance() {
    use std::time::{Duration, Instant};
    use windows_sys::Win32::{
        Foundation::*,
        Graphics::Gdi::ScreenToClient,
        UI::{
            Controls::EM_GETPASSWORDCHAR,
            Input::KeyboardAndMouse::{VK_ESCAPE, VK_RETURN},
            WindowsAndMessaging::*,
        },
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    struct CancelOnDrop<'a>(&'a AtomicBool);
    impl Drop for CancelOnDrop<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    fn window() -> HWND {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let h = unsafe {
                FindWindowW(
                    wide("MivletProtectedSecretEntry").as_ptr(),
                    std::ptr::null(),
                )
            };
            if !h.is_null() && unsafe { IsWindowVisible(h) } != 0 {
                let mut pid = 0;
                unsafe {
                    GetWindowThreadProcessId(h, &mut pid);
                }
                assert_eq!(pid, std::process::id());
                return h;
            }
            assert!(
                std::time::Instant::now() < until,
                "Owned native entry did not open"
            );
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
    }
    assert!(matches!(
        capture::prompt(&input(), &|| false),
        Err(Failure::Stopped)
    ));
    for action in [
        "save",
        "enter",
        "decline",
        "escape",
        "close",
        "validation",
        "stale-save",
        "stop",
        "expiry",
    ] {
        let stopped = AtomicBool::new(false);
        let deadline = Mutex::new(None::<Instant>);
        std::thread::scope(|threads| {
            // An assertion failure must still close the owned window before
            // scoped-thread cleanup joins the prompt thread.
            let _cancel = CancelOnDrop(&stopped);
            let request = input();
            let stop = &stopped;
            let expires = &deadline;
            let prompt = threads.spawn(move || {
                capture::prompt(&request, &|| {
                    !stop.load(Ordering::SeqCst)
                        && expires.lock().unwrap().is_none_or(|at| Instant::now() < at)
                })
            });
            let h = window();
            unsafe {
                let mut affinity = 0;
                assert_ne!(GetWindowDisplayAffinity(h, &mut affinity), 0);
                assert_eq!(affinity, WDA_EXCLUDEFROMCAPTURE);
                let edit = GetDlgItem(h, 3);
                assert_ne!(
                    GetWindowLongW(edit, GWL_STYLE) as u32 & ES_PASSWORD as u32,
                    0
                );
                assert_ne!(SendMessageW(edit, EM_GETPASSWORDCHAR, 0, 0), 0);
                let mut client: RECT = std::mem::zeroed();
                assert_ne!(GetClientRect(h, &mut client), 0);
                for id in [1, 2, 3, 4, 10, 11, 12, 13, 14] {
                    let child = GetDlgItem(h, id);
                    assert!(!child.is_null());
                    let mut bounds: RECT = std::mem::zeroed();
                    assert_ne!(GetWindowRect(child, &mut bounds), 0);
                    let mut origin = POINT {
                        x: bounds.left,
                        y: bounds.top,
                    };
                    let mut corner = POINT {
                        x: bounds.right,
                        y: bounds.bottom,
                    };
                    ScreenToClient(h, &mut origin);
                    ScreenToClient(h, &mut corner);
                    assert!(
                        origin.x >= client.left
                            && origin.y >= client.top
                            && corner.x <= client.right
                            && corner.y <= client.bottom
                            && corner.x > origin.x
                            && corner.y > origin.y,
                        "Native control {id} is clipped or empty"
                    );
                }
                match action {
                    "save" | "enter" | "validation" | "stale-save" => {
                        if action == "validation" {
                            SendMessageW(h, WM_COMMAND, 1, 0);
                            assert_ne!(IsWindow(h), 0, "Empty input closed native entry");
                            let short = CANARY.chars().take(1).collect::<String>();
                            assert_ne!(SetWindowTextW(edit, wide(&short).as_ptr()), 0);
                            SendMessageW(h, WM_COMMAND, 1, 0);
                            assert_ne!(IsWindow(h), 0, "Short input closed native entry");
                            let mut error = [0u16; 128];
                            let length = GetWindowTextW(GetDlgItem(h, 4), error.as_mut_ptr(), 128);
                            assert!(
                                String::from_utf16_lossy(&error[..length as usize])
                                    == "Use a signing secret of 16 to 512 bytes.",
                                "Native input validation must use a nonsecret error"
                            );
                        }
                        assert_ne!(SetWindowTextW(edit, wide(CANARY).as_ptr()), 0);
                        if action == "stale-save" {
                            stopped.store(true, Ordering::SeqCst);
                        }
                        if action == "enter" {
                            assert_ne!(PostMessageW(edit, WM_KEYDOWN, VK_RETURN as usize, 0), 0);
                        } else {
                            // Closing actions must arrive through GetMessage, as
                            // real input does. Cross-thread SendMessage can close
                            // the window while leaving GetMessage asleep.
                            assert_ne!(PostMessageW(h, WM_COMMAND, 1, 0), 0);
                        }
                    }
                    "decline" => {
                        assert_ne!(PostMessageW(h, WM_COMMAND, 2, 0), 0);
                    }
                    "escape" => {
                        assert_ne!(PostMessageW(edit, WM_KEYDOWN, VK_ESCAPE as usize, 0), 0);
                    }
                    "close" => {
                        assert_ne!(PostMessageW(h, WM_CLOSE, 0, 0), 0);
                    }
                    "stop" => stopped.store(true, Ordering::SeqCst),
                    // Exercise the native timer using a short synthetic deadline;
                    // service expiry classification has separate lifecycle tests.
                    "expiry" => {
                        *deadline.lock().unwrap() =
                            Some(Instant::now() + Duration::from_millis(150))
                    }
                    _ => unreachable!(),
                }
            }
            let result = prompt.join().unwrap();
            assert_eq!(
                unsafe { IsWindow(h) },
                0,
                "Owned native entry did not close"
            );
            match action {
                "save" | "enter" | "validation" => assert!(
                    result.unwrap().unwrap().as_str() == CANARY,
                    "Synthetic native entry returned different material"
                ),
                "decline" | "escape" | "close" => assert!(result.unwrap().is_none()),
                _ => assert!(matches!(result, Err(Failure::Stopped))),
            }
        });
    }
}

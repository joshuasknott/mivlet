//! Explicitly opted-in live native-boundary acceptance against the disposable
//! WinForms fixture. No account, personal app or saved computer is used here.
use super::super::desktop_tools;
use super::*;
use serde_json::json;

fn selected(state: &LocalComputerState, agent: &str, pid: u32) -> ControlSnapshot {
    selected_title(state, agent, pid, "Mivlet disposable computer test")
}
fn selected_title(
    state: &LocalComputerState,
    agent: &str,
    pid: u32,
    title: &str,
) -> ControlSnapshot {
    selected_mode(state, agent, pid, title, DeliveryMode::Foreground)
}
fn selected_mode(
    state: &LocalComputerState,
    agent: &str,
    pid: u32,
    title: &str,
    mode: DeliveryMode,
) -> ControlSnapshot {
    let authority = state.authority_for("native-test", agent).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while authority.snapshot().unwrap().transitioning && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let generation = authority.snapshot().unwrap().generation;
    list_app_windows(state, "native-test", agent, generation).unwrap();
    let window_id = state
        .native
        .inner
        .lock()
        .unwrap()
        .choices
        .values()
        .find(|c| {
            c.identity.pid == pid && c.application == "MivletComputerFixture" && c.title == title
        })
        .expect("Open the disposable fixture first")
        .id
        .clone();
    assert!(select_app_window(
        state,
        "native-test",
        "wrong-agent",
        generation,
        &window_id,
        mode,
        "wrong-scope"
    )
    .is_err());
    let selected = select_app_window(
        state,
        "native-test",
        agent,
        generation,
        &window_id,
        mode,
        &desktop_tools::opaque_id().unwrap(),
    )
    .unwrap();
    assert!(select_app_window(
        state,
        "native-test",
        agent,
        generation,
        &window_id,
        mode,
        "replay-choice"
    )
    .is_err());
    selected
}
fn read(state: &LocalComputerState, generation: u64) -> Value {
    serde_json::from_str(
        &desktop_tools::observe_app(state, "native-test", "agent-a", generation).unwrap(),
    )
    .unwrap()
}
fn action(state: &LocalComputerState, generation: u64, value: Value) {
    desktop_tools::act(
        state,
        "native-test",
        "agent-a",
        generation,
        serde_json::from_value(value).unwrap(),
    )
    .unwrap();
}
fn reference(observed: &Value, name: &str) -> String {
    observed["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("missing {name}: {observed}"))
        .get("ref")
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn delivery_mode_is_explicit_and_refusal_proves_no_dispatch() {
    assert_eq!(DeliveryMode::default(), DeliveryMode::Background);
    assert_eq!(
        serde_json::from_str::<DeliveryMode>("\"foreground\"").unwrap(),
        DeliveryMode::Foreground
    );
    assert!(serde_json::from_str::<DeliveryMode>("null").is_err());
    assert!(serde_json::from_str::<DeliveryMode>("\"automatic\"").is_err());
    let refusal = foreground_required("Unsupported control");
    assert_eq!(refusal["inputDispatched"], false);
    assert_eq!(refusal["requiresObservation"], true);
}

#[test]
fn background_takeover_stays_revoked_after_the_monitor_detects_it() {
    let mut focus = ForegroundState {
        last: 10,
        taken_over: false,
    };
    assert!(focus.observe(20, false), "other apps stay usable");
    assert!(!focus.observe(30, true), "target activation must revoke");
    assert!(
        !focus.observe(30, true),
        "a subsequent dispatch cannot consume the monitor's detection"
    );
    assert!(
        !focus.observe(20, false),
        "moving away again must not restore authority"
    );
    let mut initially_active = ForegroundState {
        last: 30,
        taken_over: false,
    };
    assert!(initially_active.observe(30, true));
}

#[cfg(windows)]
#[test]
#[ignore = "requires disposable fixture and cover PIDs plus fixture directory in MIVLET_NATIVE_LIVE_FIXTURE_* environment variables"]
fn live_background_actions_stop_and_refusals() {
    use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};
    let pid = std::env::var("MIVLET_NATIVE_LIVE_FIXTURE_PID")
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let cover_pid = std::env::var("MIVLET_NATIVE_LIVE_FIXTURE_COVER_PID")
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let evidence =
        std::path::PathBuf::from(std::env::var("MIVLET_NATIVE_LIVE_FIXTURE_DIR").unwrap());
    let choices = windows::list_windows().unwrap();
    let target = choices
        .iter()
        .find(|w| {
            w.identity.pid == pid
                && w.application == "MivletComputerFixture"
                && w.title == "Mivlet disposable computer test"
        })
        .unwrap()
        .identity
        .hwnd;
    let cover = choices
        .iter()
        .find(|w| {
            w.identity.pid == cover_pid
                && w.application == "MivletComputerFixture"
                && w.title == "Mivlet background cover test"
        })
        .unwrap()
        .identity
        .hwnd;
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        assert_ne!(GetWindowRect(target as usize as _, &mut rect), 0);
        assert_ne!(
            SetWindowPos(
                cover as usize as _,
                HWND_TOPMOST,
                rect.left - 10,
                rect.top - 10,
                rect.right - rect.left + 20,
                rect.bottom - rect.top + 20,
                SWP_NOACTIVATE | SWP_SHOWWINDOW
            ),
            0
        );
    }
    // Establish a separate active disposable app before measuring background
    // delivery. This is fixture setup, not part of Mivlet's selection path.
    unsafe {
        SetForegroundWindow(cover as usize as _);
    }
    let settle = Instant::now() + Duration::from_millis(400);
    while windows::foreground() != cover && Instant::now() < settle {
        std::thread::sleep(Duration::from_millis(10));
    }
    let foreground = windows::foreground();
    assert_eq!(
        foreground, cover,
        "Windows must allow the disposable cover to become foreground before the background test can start"
    );
    let root = tempfile::tempdir().unwrap();
    let state = Arc::new(LocalComputerState::for_test(root.path().into()));
    super::super::activity::start(state.clone()).unwrap();
    struct Cleanup(Arc<LocalComputerState>, u64, u64);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.native.stop("Background acceptance ended");
            self.0.closing.store(true, Ordering::Release);
            unsafe {
                SetWindowPos(
                    self.2 as usize as _,
                    HWND_NOTOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                );
                ShowWindow(self.1 as usize as _, SW_SHOWNOACTIVATE);
            }
        }
    }
    let _cleanup = Cleanup(state.clone(), target, cover);
    let select = || {
        selected_mode(
            &state,
            "agent-a",
            pid,
            "Mivlet disposable computer test",
            DeliveryMode::Background,
        )
        .generation
        .unwrap()
    };
    let generation = select();
    assert_eq!(
        state
            .native
            .snapshot("native-test", "agent-a")
            .unwrap()
            .delivery_mode,
        Some(DeliveryMode::Background)
    );
    assert_eq!(
        windows::foreground(),
        foreground,
        "background selection raised the target"
    );
    let observed = read(&state, generation);
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"], "action":"type", "elementRef":reference(&observed,"Note"), "text":"Background acceptance 731"}),
    );
    assert_eq!(
        windows::foreground(),
        foreground,
        "background typing changed focus"
    );
    let observed = read(&state, generation);
    assert!(observed.to_string().contains("Background acceptance 731"));
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"], "action":"click", "elementRef":reference(&observed,"Confirm note")}),
    );
    let observed = read(&state, generation);
    assert!(observed
        .to_string()
        .contains("Confirmed: Background acceptance 731"));
    assert_eq!(
        windows::foreground(),
        foreground,
        "background click changed focus"
    );
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"], "action":"scroll", "elementRef":reference(&observed,"Scrollable sample"), "deltaY":600}),
    );
    assert_eq!(
        windows::foreground(),
        foreground,
        "background scroll changed focus"
    );
    assert!(
        !evidence.join("cover-events.txt").exists(),
        "input changed the covering fixture"
    );
    let grant = state.native.inner.lock().unwrap().active.clone().unwrap();
    let sent = grant.driver.dispatched();
    assert!(desktop_tools::observe(&state, "native-test", "agent-a", generation).is_err());
    assert_eq!(
        grant.driver.dispatched(),
        sent,
        "background image request reached the unsafe capture path"
    );
    assert!(state.native.active());
    for value in [
        json!({"action":"key", "key":"Enter"}),
        json!({"action":"click", "x":10, "y":10}),
    ] {
        let observed = read(&state, generation);
        let sent = grant.driver.dispatched();
        let mut value = value;
        value["observationId"] = observed["observationId"].clone();
        let refusal: Value = serde_json::from_str(
            &desktop_tools::act(
                &state,
                "native-test",
                "agent-a",
                generation,
                serde_json::from_value(value).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(refusal["status"], "foreground-required");
        assert_eq!(refusal["inputDispatched"], false);
        assert_eq!(grant.driver.dispatched(), sent);
        assert!(state.native.active());
        assert!(state.native.inner.lock().unwrap().observation.is_none());
    }
    // The native input callback ignores work in other windows and revokes the
    // exact target even when its foreground HWND did not change.
    state.native.user_input(cover);
    assert!(state.native.active());
    state.native.user_input(target);
    assert!(!state.native.active());
    assert!(desktop_tools::observe_app(&state, "native-test", "agent-a", generation).is_err());
    let generation = select();
    unsafe {
        ShowWindow(target as usize as _, SW_MINIMIZE);
    }
    state.native.monitor();
    assert!(
        !state.native.active(),
        "minimised target retained its lease"
    );
    assert!(desktop_tools::observe_app(&state, "native-test", "agent-a", generation).is_err());
    assert!(windows::list_windows()
        .unwrap()
        .iter()
        .all(|w| w.identity.hwnd != target));
    unsafe {
        ShowWindow(target as usize as _, SW_SHOWNOACTIVATE);
    }
    let generation = select();
    let observed = read(&state, generation);
    let grant = state.native.inner.lock().unwrap().active.clone().unwrap();
    let sent = grant.driver.dispatched();
    let next = state.clone();
    let acting = std::thread::spawn(move || {
        desktop_tools::act(&next, "native-test", "agent-a", generation,
        serde_json::from_value(json!({"observationId":observed["observationId"], "action":"type", "elementRef":reference(&observed,"Note"), "text":" SLOW_NATIVE_STOP"})).unwrap())
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !std::fs::read_to_string(evidence.join("fixture-events.txt"))
        .unwrap_or_default()
        .contains(" SLOW_NATIVE_STOP")
        && Instant::now() < deadline
        && !acting.is_finished()
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        std::fs::read_to_string(evidence.join("fixture-events.txt"))
            .unwrap()
            .contains(" SLOW_NATIVE_STOP"),
        "real UIA input must reach the disposable control"
    );
    assert!(
        !acting.is_finished(),
        "Stop must run during the real input call"
    );
    assert!(grant.background_input_in_flight.load(Ordering::Acquire));
    let next = state.clone();
    let queued = std::thread::spawn(move || {
        desktop_tools::observe_app(&next, "native-test", "agent-a", generation)
    });
    let started = Instant::now();
    state
        .native
        .stop("Live Stop during background input; effect unknown");
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(!grant.driver.alive());
    assert!(acting.join().unwrap().is_err());
    assert!(queued.join().unwrap().is_err());
    assert_eq!(
        grant.driver.dispatched(),
        sent + 1,
        "a queued action was sent after Stop"
    );
    let done = state
        .native
        .inner
        .lock()
        .unwrap()
        .retiring
        .clone()
        .expect("in-flight Stop must fence window cleanup");
    let deadline = Instant::now() + Duration::from_secs(6);
    while !done.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(done.load(Ordering::Acquire), "background cleanup failed");
    unsafe {
        assert_eq!(
            GetWindowLongPtrW(target as usize as _, GWL_EXSTYLE) & WS_EX_NOACTIVATE as isize,
            0
        );
    }
    let recovered = select();
    assert!(recovered > generation);
    let observed = read(&state, recovered);
    let note = observed["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|control| control["name"] == "Note")
        .unwrap();
    assert_eq!(
        note["value"], "Background acceptance 731 SLOW_NATIVE_STOP",
        "the unknown action must not replay"
    );
    let events = std::fs::read_to_string(evidence.join("fixture-events.txt")).unwrap();
    assert_eq!(
        events
            .lines()
            .filter(|line| line.contains("\ttext\t") && line.contains("SLOW_NATIVE_STOP"))
            .count(),
        1
    );
    eprintln!("LIVE background: covered UIA read/append/click/scroll preserved focus; covering text unchanged; image/key/pixel refusal sent zero input; user-target callback/minimise revoked; real in-progress input Stop <500ms, queue fenced, driver killed, window restored, fresh generation recovered without replay");
}

#[test]
#[ignore = "requires MIVLET_NATIVE_LIVE_FIXTURE_PID for the disposable acceptance app in an interactive Windows session"]
fn live_actions_stop_queue_and_reconnect() {
    let pid = std::env::var("MIVLET_NATIVE_LIVE_FIXTURE_PID")
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let state = Arc::new(LocalComputerState::for_test(root.path().into()));
    struct Stop(Arc<LocalComputerState>);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.native.stop("Acceptance ended");
        }
    }
    let _stop = Stop(state.clone());
    assert!(desktop_tools::observe_app(&state, "native-test", "agent-a", 1).is_err());
    let active = selected(&state, "agent-a", pid);
    let generation = active.generation.unwrap();
    assert_eq!(active.status, "active");
    assert_eq!(
        state
            .native
            .snapshot("native-test", "agent-b")
            .unwrap()
            .status,
        "busy"
    );
    assert!(state
        .native
        .validate("native-test", "agent-b", generation)
        .is_err());

    let observed = read(&state, generation);
    let note = reference(&observed, "Note");
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"],"action":"click","elementRef":note}),
    );
    for (key, modifiers) in [
        ("Home", json!([])),
        ("End", json!(["Shift"])),
        ("Backspace", json!([])),
    ] {
        let observed = read(&state, generation);
        action(
            &state,
            generation,
            json!({"observationId":observed["observationId"],"action":"key","key":key,"modifiers":modifiers}),
        );
    }
    let observed = read(&state, generation);
    let note = reference(&observed, "Note");
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"],"action":"type","elementRef":note,"text":"Native Mivlet acceptance 731"}),
    );
    let observed = read(&state, generation);
    assert!(observed
        .to_string()
        .contains("Native Mivlet acceptance 731"));
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"],"action":"key","key":"End"}),
    );
    let observed = read(&state, generation);
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"],"action":"key","key":"Backspace"}),
    );
    let observed = read(&state, generation);
    assert!(observed.to_string().contains("Native Mivlet acceptance 73"));
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"],"action":"click","elementRef":reference(&observed,"Confirm note")}),
    );
    let observed = read(&state, generation);
    assert!(observed
        .to_string()
        .contains("Confirmed: Native Mivlet acceptance 73"));
    let screenshot = desktop_tools::observe(&state, "native-test", "agent-a", generation).unwrap();
    assert!(screenshot.png.starts_with(b"\x89PNG"));
    desktop_tools::delivery_ticket(&state, &screenshot)
        .unwrap()
        .finish(Ok(()))
        .unwrap();
    std::fs::write(root.path().join("native-window.png"), &screenshot.png).unwrap();
    let observed: Value = serde_json::from_str(&screenshot.output).unwrap();
    action(
        &state,
        generation,
        json!({"observationId":observed["observationId"],"action":"scroll","elementRef":reference(&observed,"Scrollable sample"),"deltaY":600}),
    );
    assert!(
        desktop_tools::delivery_ticket(&state, &screenshot).is_err(),
        "an action must retire the previous image before egress"
    );
    let replaced = desktop_tools::observe(&state, "native-test", "agent-a", generation).unwrap();
    let observed = read(&state, generation);
    assert!(
        desktop_tools::delivery_ticket(&state, &replaced).is_err(),
        "a new observation must retire the previous image before egress"
    );
    assert!(desktop_tools::act(
        &state,
        "native-test",
        "agent-a",
        generation,
        serde_json::from_value(json!({"observationId":"expired","action":"key","key":"Enter"}))
            .unwrap()
    )
    .is_err());
    assert!(!state.native.active());
    assert!(state
        .native
        .validate("native-test", "agent-a", generation)
        .is_err());
    assert!(!observed["observationId"].as_str().unwrap().is_empty());

    // All input queued behind the outstanding transport lock must fail after
    // Stop, even if those operations were admitted with valid old tickets.
    let generation = selected(&state, "agent-a", pid).generation.unwrap();
    let grant = state.native.inner.lock().unwrap().active.clone().unwrap();
    let serial = grant.driver.serial().unwrap();
    let sent = grant.driver.dispatched();
    let ticket1 = grant.authority.begin_agent(generation).unwrap();
    let ticket2 = grant.authority.begin_agent(generation).unwrap();
    let a = state.clone();
    let b = state.clone();
    let queued = |state: Arc<LocalComputerState>, ticket: OperationTicket| {
        std::thread::spawn(move || {
            state.native.call("native-test","agent-a",generation,&ticket,None,|window,_,_|Ok(PreparedCall::Driver("press_key",json!({"pid":window.identity.pid,"window_id":window.identity.hwnd,"key":"RETURN"}))))
        })
    };
    let first = queued(a, ticket1);
    let second = queued(b, ticket2);
    let start = Instant::now();
    state.native.stop("Acceptance Stop");
    assert!(
        start.elapsed() < Duration::from_millis(500),
        "Stop waited for the input lock"
    );
    assert!(!grant.driver.alive());
    drop(serial);
    assert!(first.join().unwrap().is_err());
    assert!(second.join().unwrap().is_err());
    assert_eq!(
        grant.driver.dispatched(),
        sent,
        "queued input reached the driver after Stop"
    );
    assert!(desktop_tools::observe_app(&state, "native-test", "agent-a", generation).is_err());
    // Reconnect needs a fresh generation, current window list and new approved
    // selection. The old turn cannot discover, reselect or issue further input.
    assert!(list_app_windows(&state, "native-test", "agent-a", generation).is_err());
    let recovered = selected(&state, "agent-a", pid);
    assert!(recovered.generation.unwrap() > generation);
    let generation = recovered.generation.unwrap();
    let grant = state.native.inner.lock().unwrap().active.clone().unwrap();
    let sent = grant.driver.dispatched();
    let capture_state = state.clone();
    let capture = std::thread::spawn(move || {
        desktop_tools::observe(&capture_state, "native-test", "agent-a", generation)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while grant.driver.dispatched() == sent && Instant::now() < deadline && !capture.is_finished() {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(
        grant.driver.dispatched() > sent,
        "capture must reach the real driver"
    );
    assert!(
        !capture.is_finished(),
        "Stop must occur while real driver work is in progress"
    );
    let next = state.clone();
    let queued = std::thread::spawn(move || {
        desktop_tools::observe_app(&next, "native-test", "agent-a", generation)
    });
    let stopped = Instant::now();
    state.native.stop("Acceptance in-progress Stop");
    assert!(stopped.elapsed() < Duration::from_millis(500));
    assert!(capture.join().unwrap().is_err());
    assert!(queued.join().unwrap().is_err());
    assert_eq!(
        grant.driver.dispatched(),
        sent + 1,
        "no queued request followed the in-progress capture"
    );
    assert!(!grant.driver.alive());
    // Model input opens a real owned dialog, changing the foreground target.
    // This avoids a test process trying to bypass Windows activation policy.
    let generation = selected(&state, "agent-a", pid).generation.unwrap();
    let observed = read(&state, generation);
    let opened = desktop_tools::act(&state, "native-test", "agent-a", generation,
        serde_json::from_value(json!({"observationId":observed["observationId"],"action":"click","elementRef":reference(&observed,"Open dialog")})).unwrap());
    state.native.monitor();
    assert!(
        !state.native.active(),
        "dialog focus change must revoke control"
    );
    assert!(
        opened.is_err(),
        "changed-context input must not report a confirmed result"
    );
    assert!(desktop_tools::observe_app(&state, "native-test", "agent-a", generation).is_err());
    let generation = selected_title(&state, "agent-a", pid, "Mivlet disposable focus test")
        .generation
        .unwrap();
    let observed = read(&state, generation);
    let closed = desktop_tools::act(&state, "native-test", "agent-a", generation,
        serde_json::from_value(json!({"observationId":observed["observationId"],"action":"click","elementRef":reference(&observed,"Close dialog")})).unwrap());
    state.native.monitor();
    assert!(!state.native.active(), "target closure must revoke control");
    assert!(closed.is_err());
    assert!(desktop_tools::observe_app(&state, "native-test", "agent-a", generation).is_err());
    let generation = selected(&state, "agent-a", pid).generation.unwrap();
    state
        .native
        .inner
        .lock()
        .unwrap()
        .active
        .as_ref()
        .unwrap()
        .driver
        .stop();
    state.native.monitor();
    assert!(!state.native.active(), "runtime exit must revoke control");
    assert!(list_app_windows(&state, "native-test", "agent-a", generation).is_err());
    let generation = selected(&state, "agent-a", pid).generation.unwrap();
    state
        .native
        .inner
        .lock()
        .unwrap()
        .active
        .as_ref()
        .unwrap()
        .window
        .invalidate_marker_for_test();
    state.native.monitor();
    assert!(
        !state.native.active(),
        "a missing window identity marker must reject replacement"
    );
    assert!(desktop_tools::observe_app(&state, "native-test", "agent-a", generation).is_err());
    assert_eq!(
        selected(&state, "agent-a", pid).status,
        "active",
        "fresh request can recover on the surviving fixture"
    );
    eprintln!("LIVE native boundary: exact agent and one-use choice fence, observed/typed/key/click/PNG/scroll, stale revocation, queued and in-progress Stop, zero subsequent dispatch, fresh reconnect, dialog focus loss, runtime exit, replacement marker and target closure");
}

use super::*;
use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[test]
fn all_main_process_pipe_handles_are_non_inheritable() {
    for reads in [false, true] {
        let pair = Pair::new(reads).unwrap();
        for file in [&pair.parent, &pair.child] {
            let mut flags = 0;
            assert_ne!(
                unsafe { GetHandleInformation(file.as_raw_handle(), &mut flags) },
                0
            );
            assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        }
    }
}

#[test]
fn framing_preserves_separate_messages_in_one_read() {
    let mut pair = Pair::new(true).unwrap();
    pair.child.write_all(b"first\0second\0").unwrap();
    let mut reader = Framed::new(pair.parent);
    let end = Instant::now() + Duration::from_secs(2);
    assert_eq!(reader.read(end, &|| Ok(())).unwrap(), b"first");
    assert_eq!(reader.read(end, &|| Ok(())).unwrap(), b"second");
}

#[test]
fn scope_stop_cancels_a_stalled_read_without_holding_authority() {
    let temp = tempfile::tempdir().unwrap();
    let authority = crate::local_computer::authority::ComputerAuthority::load(temp.path()).unwrap();
    let ticket = authority.begin_agent(1).unwrap();
    let stop = authority.clone();
    let pair = Pair::new(true).unwrap();
    let mut reader = Framed::new(pair.parent);
    let start = Instant::now();
    let revoker = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        stop.revoke(1).unwrap();
    });
    assert!(reader
        .read(start + Duration::from_secs(3), &|| ticket.check())
        .is_err());
    revoker.join().unwrap();
    assert!(start.elapsed() < Duration::from_secs(2));
    drop(pair.child);
}

#[test]
fn stalled_writes_are_cancellable_and_requests_are_bounded() {
    let pair = Pair::new(false).unwrap();
    assert!(write(
        &pair.parent,
        &vec![b'x'; 4097],
        Instant::now() + Duration::from_secs(1),
        &|| Ok(())
    )
    .is_err());
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        flag.store(true, Ordering::Release);
    });
    let start = Instant::now();
    let check = || {
        if cancelled.load(Ordering::Acquire) {
            Err("stopped".into())
        } else {
            Ok(())
        }
    };
    let mut stopped = false;
    for _ in 0..256 {
        if write(
            &pair.parent,
            &vec![b'x'; 4096],
            start + Duration::from_secs(3),
            &check,
        )
        .is_err()
        {
            stopped = true;
            break;
        }
    }
    thread.join().unwrap();
    assert!(stopped);
    assert!(start.elapsed() < Duration::from_secs(2));
    drop(pair.child);
}

#[test]
fn mismatched_protocol_response_is_rejected_without_echoing_its_content() {
    let input = Pair::new(false).unwrap();
    let mut output = Pair::new(true).unwrap();
    output.child.write_all(b"{\"id\":999,\"result\":{\"protocolVersion\":\"1.3\",\"product\":\"Chrome/1\",\"userAgent\":\"private-content\"}}\0").unwrap();
    let mut control = ControlPipe::new(input.parent, output.parent);
    let error = control.verify(&|| Ok(())).unwrap_err();
    assert!(!error.contains("private-content"));
}

#[test]
fn read_protocol_discards_private_events_and_checks_the_exact_session() {
    let input = Pair::new(false).unwrap();
    let mut output = Pair::new(true).unwrap();
    output.child.write_all(b"{\"method\":\"Target.attachedToTarget\",\"params\":{\"private\":\"never export\"}}\0{\"id\":1,\"sessionId\":\"session-one\",\"result\":{\"nodes\":[]}}\0").unwrap();
    let mut control = ControlPipe::new(input.parent, output.parent);
    assert_eq!(
        control
            .read_command(
                ReadCommand::Accessibility,
                serde_json::json!({}),
                Some("session-one"),
                &|| Ok(())
            )
            .unwrap(),
        serde_json::json!({"nodes":[]})
    );
}
#[test]
fn cancelled_protocol_is_never_reused_and_does_not_close_browser_handles() {
    let input = Pair::new(false).unwrap();
    let output = Pair::new(true).unwrap();
    let mut control = ControlPipe::new(input.parent, output.parent);
    assert!(control
        .read_command(ReadCommand::Targets, serde_json::json!({}), None, &|| Err(
            "stopped".into()
        ))
        .is_err());
    let error = control
        .read_command(
            ReadCommand::Targets,
            serde_json::json!({}),
            None,
            &|| Ok(()),
        )
        .unwrap_err();
    assert!(error.contains("page remains yours"));
    let mut flags = 0;
    assert_ne!(
        unsafe { GetHandleInformation(control.input.as_raw_handle(), &mut flags) },
        0
    );
}

use super::super::{ActiveRun, Dispatch};
use super::*;
use serde_json::json;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::Instant,
};

#[test]
#[ignore = "Subprocess fixture for an actual SDK pipe, not a live provider"]
fn reading_provider_fixture() {
    println!("fixture-ready");
    std::io::stdout().flush().unwrap();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    let wire: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(wire["type"], "control_response");
    assert_eq!(wire["response"]["request_id"], "native-control");
    let reply = &wire["response"]["response"]["mcp_response"];
    assert_eq!(reply["id"], "rpc-fixture");
    assert_eq!(reply["result"]["isError"], false);
    assert_eq!(reply["result"]["content"][0]["text"], "native result");
    println!("fixture-delivered");
    std::io::stdout().flush().unwrap();
}

struct Fixture {
    id: String,
    call: String,
    input: Arc<Mutex<ChildStdin>>,
    bridge: Arc<Mutex<ToolBridge>>,
    child: Arc<Mutex<crate::provider_process::SupervisedChild>>,
    output: BufReader<std::process::ChildStdout>,
}
impl Fixture {
    fn new(reading: bool) -> Self {
        let path = if reading {
            "managed_runtime::tool_delivery::tests::reading_provider_fixture"
        } else {
            "managed_runtime::image_input::tests::nonreading_provider_stdin_fixture"
        };
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([path, "--exact", "--ignored", "--nocapture"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = crate::provider_process::SupervisedChild::spawn(command).unwrap();
        let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while !line.contains("fixture-ready") {
            assert_ne!(output.read_line(&mut line).unwrap(), 0);
        }
        let specs: Vec<_> = serde_json::from_value(json!([{
            "name":"read-file", "description":"Read scoped input", "parameters":"{\"type\":\"object\"}"
        }])).unwrap();
        let mut bridge = ToolBridge::new(&specs).unwrap();
        let Dispatch::Call(call) = bridge
            .dispatch(
                "native-control",
                &json!({
                    "jsonrpc":"2.0", "id":"rpc-fixture", "method":"tools/call",
                    "params":{"name":"read-file","arguments":{"path":"report.md"}}
                }),
            )
            .unwrap()
        else {
            panic!("fixture call was not dispatched")
        };
        let call = call["callId"].as_str().unwrap().to_string();
        let bridge = Arc::new(Mutex::new(bridge));
        let child = Arc::new(Mutex::new(child));
        let id = format!(
            "native-tool-delivery-{}",
            super::super::super::local_computer::desktop_tools::opaque_id().unwrap()
        );
        active_runs().lock().unwrap().insert(
            id.clone(),
            ActiveRun {
                owner: "fixture-owner".into(),
                provider_id: "claude".into(),
                stdin: Some(input.clone()),
                child: child.clone(),
                session_id: Arc::new(Mutex::new(None)),
                permissions: Arc::new(Mutex::new(HashMap::new())),
                opencode: None,
                tool_bridge: bridge.clone(),
            },
        );
        Self {
            id,
            call,
            input,
            bridge,
            child,
            output,
        }
    }
    fn response(&self, output: &str) -> ManagedToolResponse {
        ManagedToolResponse {
            request_id: self.id.clone(),
            tool_request_id: "native-control".into(),
            call_id: self.call.clone(),
            ok: true,
            output: output.into(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        active_runs().lock().unwrap().remove(&self.id);
        if let Ok(mut bridge) = self.bridge.lock() {
            bridge.stop();
        }
        let _ = terminate_claude_turn(&self.child);
    }
}

async fn wait_for_blocked_write(fixture: &Fixture) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while fixture.input.try_lock().is_ok() {
        assert!(Instant::now() < deadline, "response writer did not start");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // A 512 KiB payload cannot fit in the non-reading fixture's pipe.
    tokio::time::sleep(Duration::from_millis(100)).await;
}

#[tokio::test]
async fn actual_tool_response_releases_run_lock_so_native_stop_cancels_blocked_stdin() {
    let fixture = Fixture::new(false);
    let request = fixture.response(&"x".repeat(512 * 1024));
    let delivery = prepare("fixture-owner", request).unwrap();
    assert!(prepare("fixture-owner", fixture.response("replay")).is_err());
    let writer = tokio::spawn(async move { delivery.send(|| Ok(())).await });
    wait_for_blocked_write(&fixture).await;
    assert!(!writer.is_finished(), "fixture pipe did not block");
    assert!(
        active_runs().try_lock().is_ok(),
        "response retained global run lock"
    );
    assert!(
        fixture.bridge.try_lock().is_ok(),
        "response retained bridge lock"
    );
    let start = Instant::now();
    tokio::time::timeout(
        Duration::from_secs(2),
        super::super::interrupt_managed_runtime_turn(fixture.id.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), writer)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(!fixture.bridge.lock().unwrap().delivering("native-control"));
    assert!(prepare("fixture-owner", fixture.response("replay")).is_err());
}

#[tokio::test]
async fn completed_pipe_reply_is_exact_and_consumed_once() {
    let mut fixture = Fixture::new(true);
    assert!(prepare("other-owner", fixture.response("native result")).is_err());
    let mut wrong = fixture.response("native result");
    wrong.call_id = "other-call".into();
    assert!(prepare("fixture-owner", wrong).is_err());
    prepare("fixture-owner", fixture.response("native result"))
        .unwrap()
        .send(|| Ok(()))
        .await
        .unwrap();
    assert!(!fixture.bridge.lock().unwrap().delivering("native-control"));
    assert!(prepare("fixture-owner", fixture.response("replay")).is_err());
    let mut line = String::new();
    assert_ne!(fixture.output.read_line(&mut line).unwrap(), 0);
    assert!(line.contains("fixture-delivered"));
}

#[tokio::test]
async fn cancelled_or_changed_account_reply_never_starts_a_writer() {
    for account_changed in [false, true] {
        let fixture = Fixture::new(false);
        let delivery = prepare("fixture-owner", fixture.response("native result")).unwrap();
        if !account_changed {
            fixture.bridge.lock().unwrap().cancel("native-control");
        }
        assert!(delivery
            .send(|| if account_changed {
                Err("account changed".into())
            } else {
                Ok(())
            })
            .await
            .is_err());
        assert!(!fixture.bridge.lock().unwrap().delivering("native-control"));
        assert!(fixture.input.try_lock().is_ok());
        assert!(fixture.child.lock().unwrap().try_wait().unwrap().is_some());
    }
}

#[tokio::test]
async fn stalled_provider_times_out_and_cannot_receive_a_second_reply() {
    let fixture = Fixture::new(false);
    let delivery = prepare("fixture-owner", fixture.response(&"x".repeat(512 * 1024))).unwrap();
    let start = Instant::now();
    assert!(
        tokio::time::timeout(Duration::from_secs(13), delivery.send(|| Ok(())))
            .await
            .unwrap()
            .is_err()
    );
    assert!(start.elapsed() < Duration::from_secs(13));
    assert!(fixture.child.lock().unwrap().try_wait().unwrap().is_some());
    assert!(prepare("fixture-owner", fixture.response("replay")).is_err());
}

#[tokio::test]
async fn abandoned_async_response_closes_its_blocked_writer_and_consumed_call() {
    for sdk_cancelled in [false, true] {
        let fixture = Fixture::new(false);
        let delivery = prepare("fixture-owner", fixture.response(&"x".repeat(512 * 1024))).unwrap();
        let writer = tokio::spawn(async move { delivery.send(|| Ok(())).await });
        wait_for_blocked_write(&fixture).await;
        if sdk_cancelled {
            fixture.bridge.lock().unwrap().cancel("native-control");
        }
        writer.abort();
        assert!(tokio::time::timeout(Duration::from_secs(2), writer)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled());
        assert!(!fixture.bridge.lock().unwrap().delivering("native-control"));
        assert!(fixture.child.lock().unwrap().try_wait().unwrap().is_some());
        let deadline = Instant::now() + Duration::from_secs(2);
        while fixture.input.try_lock().is_err() {
            assert!(
                Instant::now() < deadline,
                "abandoned pipe writer survived cleanup"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(prepare("fixture-owner", fixture.response("replay")).is_err());
    }
}

#[test]
fn actual_encoded_frame_limit_catches_json_escape_expansion_before_write() {
    let fixture = Fixture::new(false);
    assert!(prepare("fixture-owner", fixture.response(&"\0".repeat(512 * 1024))).is_err());
    assert!(fixture.input.try_lock().is_ok());
    assert!(!fixture.bridge.lock().unwrap().delivering("native-control"));
    assert!(prepare("fixture-owner", fixture.response("replay")).is_err());
}

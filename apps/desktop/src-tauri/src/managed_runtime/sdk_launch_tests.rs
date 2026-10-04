use super::super::{shared_tool_response, write_json, Dispatch, ToolBridge};
use super::*;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    process::Stdio,
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

#[test]
fn model_values_cannot_add_flags() {
    for model in [
        " sonnet ",
        "--chrome",
        "opus & echo injected",
        "",
        "--resume=x",
    ] {
        let mut command = Command::new("claude");
        configure(&mut command, model);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        if !model.trim().is_empty() {
            assert_eq!(args.last().unwrap(), &format!("--model={}", model.trim()));
        }
        assert!(!args.iter().any(|arg| arg.as_ref() == "--chrome"));
        assert!(!args.iter().any(|arg| arg.starts_with("--resume=")));
    }
}

#[cfg(windows)]
#[test]
fn claude_discovery_skips_batch_shims_before_a_later_native_executable() {
    let paths = [
        "C:/early/claude.cmd",
        "C:/early/claude.bat",
        "C:/later/claude.exe",
    ];
    assert_eq!(
        paths
            .iter()
            .find(|path| executable_allowed("claude", Path::new(path))),
        Some(&paths[2])
    );
    assert!(!executable_allowed("claude", Path::new("claude")));
    assert!(executable_allowed("claude", Path::new("claude.EXE")));
    assert!(executable_allowed("cursor", Path::new("agent.cmd")));
}

// This explicitly invoked check sends only SDK/MCP initialization, never a
// user prompt, model request, login, or tool action. It needs an independently
// verified official binary; ordinary CI remains offline/provider independent.
#[test]
#[ignore = "Requires an explicitly selected and SHA256-verified official Claude executable"]
fn native_claude_sdk_initialization_acceptance() {
    use sha2::{Digest, Sha256};
    let path = std::env::var_os("MIVLET_CLAUDE_SDK_ACCEPTANCE_EXE")
        .map(std::path::PathBuf::from)
        .expect("Select a verified official executable explicitly");
    let expected = std::env::var("MIVLET_CLAUDE_SDK_ACCEPTANCE_SHA256").unwrap();
    assert_eq!(expected.len(), 64);
    assert_eq!(
        hex::encode(Sha256::digest(std::fs::read(&path).unwrap())),
        expected.to_ascii_lowercase()
    );
    assert!(executable_allowed("claude", &path));
    let private = tempfile::tempdir().unwrap();
    let command = || {
        let mut command = Command::new(&path);
        command.env_clear();
        for key in ["SystemRoot", "WINDIR", "COMSPEC", "PATH"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        for key in [
            "USERPROFILE",
            "HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "CLAUDE_CONFIG_DIR",
        ] {
            command.env(key, private.path());
        }
        command
            .env("DISABLE_AUTOUPDATER", "1")
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .current_dir(private.path());
        command
    };
    let mut status = command();
    status.args(["auth", "status", "--json"]);
    let result = super::super::run_command(status, Duration::from_secs(12)).unwrap();
    let status: Value =
        serde_json::from_str(&result.stdout).expect("Private authentication status must be JSON");
    assert_eq!(
        status["loggedIn"], false,
        "No account may be used by this check"
    );

    let mut command = command();
    configure(&mut command, "sonnet");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command).unwrap();
    let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let output = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            if line.len() > 2 * 1024 * 1024 {
                break;
            }
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let errors = std::thread::spawn(move || super::super::read_limited(stderr, 128 * 1024));
    let id = "mivlet-init-acceptance";
    write_json(
        &input,
        "claude",
        &json!({"type":"control_request","request_id":id,
        "request":{"subtype":"initialize"}}),
    )
    .unwrap();
    let mut bridge = ToolBridge::new(&[]).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut initialized = false;
    while let Some(wait) = deadline.checked_duration_since(Instant::now()) {
        let Ok(line) = receiver.recv_timeout(wait) else {
            break;
        };
        let frame: Value = serde_json::from_str(&line).expect("Official SDK frame must be JSON");
        if frame["type"] == "control_response" && frame["response"]["request_id"] == id {
            assert_eq!(
                frame["response"]["subtype"], "success",
                "SDK initialization must succeed without a prompt"
            );
            initialized = true;
            break;
        }
        if frame["type"] == "control_request"
            && frame["request"]["subtype"] == "mcp_message"
            && frame["request"]["server_name"] == "mivlet"
        {
            let request_id = frame["request_id"].as_str().unwrap();
            let Dispatch::Reply(reply) = bridge
                .dispatch(request_id, &frame["request"]["message"])
                .unwrap()
            else {
                panic!("No action is available during initialization");
            };
            write_json(&input, "claude", &shared_tool_response(request_id, reply)).unwrap();
        }
    }
    child.kill().unwrap();
    child.wait().unwrap();
    reader.join().unwrap();
    let _ = errors.join().unwrap(); // Never print private SDK diagnostics.
    assert!(
        initialized,
        "Official CLI did not acknowledge SDK initialization within 30 seconds"
    );
    println!("Official CLI SDK initialization passed in a disposable signed-out profile; no model prompt was sent.");
}

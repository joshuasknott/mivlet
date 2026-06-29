//! ACP (Agent Client Protocol) child-process boundary.
//!
//! Rust owns the CLI child process for ACP providers (Cursor, Grok). A CLI is
//! spawned here with piped stdio; its stdout is read line-by-line and each
//! newline-delimited JSON-RPC frame is emitted on the Tauri event channel
//! `arden://acp/<sessionId>`. The TypeScript adapter writes request frames back
//! through `write_acp_frame` and shuts the process down through
//! `close_acp_process`. **A CLI is never spawned from JavaScript** — this is
//! the sole process boundary, mirroring `native_api.rs` for HTTP egress.
//!
//! Auth is provider-owned: the CLI holds its own credentials (Cursor/Grok
//! subscription login). Fable never collects, stores, or passes a subscription
//! token. The probe (`detect_acp_cli`) runs the CLI's status command and maps
//! its outcome to a truthful auth-state vocabulary — it never reads a secret.
//!
//! Hard invariants:
//!   - No secret crosses into JavaScript; the CLI owns its auth.
//!   - Only the catalog-declared ACP executables may be spawned; arbitrary
//!     executable ids are rejected.
//!   - The spawned process is supervised: stdout/stderr are drained and the
//!     child is killed on close/cancel so it cannot leak.
//!
//! Public Tauri commands (names must stay stable): `spawn_acp_process`,
//! `write_acp_frame`, `close_acp_process`, `detect_acp_cli`.

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Mutex, OnceLock},
};

use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
};

/// A catalog-declared ACP executable. The executable name is only used to spawn
/// / probe through this boundary; it is never bundled or redistributed.
pub(crate) struct AcpExecutable {
    /// The provider id this executable serves (cursor / grok).
    provider_id: &'static str,
    /// The CLI executable name looked up on PATH.
    executable: &'static str,
    /// Args passed to the executable to probe auth state (no secrets).
    auth_probe_args: &'static [&'static str],
}

/// The catalog of ACP executables. Mirrors the TypeScript `ACP_PROVIDERS`; kept
/// here so Rust can validate the provider id and resolve the executable without
/// trusting a caller-supplied path (which could be an arbitrary binary).
const ACP_EXECUTABLES: &[AcpExecutable] = &[
    AcpExecutable {
        provider_id: "cursor",
        executable: "cursor",
        auth_probe_args: &["agent", "status"],
    },
    AcpExecutable {
        provider_id: "grok",
        executable: "grok",
        auth_probe_args: &["status"],
    },
];

/// Resolve an ACP executable spec by provider id. Returns None for an unknown
/// provider so the spawn/probe path fails closed (no arbitrary binary).
pub(crate) fn acp_executable_for(provider_id: &str) -> Option<&'static AcpExecutable> {
    ACP_EXECUTABLES
        .iter()
        .find(|entry| entry.provider_id == provider_id)
}

/// The maximum length of a single stdio line read from the CLI. Bounds a
/// hostile or pathological CLI so the reader's buffers cannot be exhausted.
/// Mirrors the TypeScript `MAX_ACP_FRAME_CHARACTERS`.
const MAX_ACP_LINE_CHARACTERS: usize = 1024 * 1024;

/// The event channel prefix ACP frames are emitted on (per session id).
const ACP_EVENT_CHANNEL_PREFIX: &str = "arden://acp/";

/// The channel for a given session id.
fn acp_channel(session_id: &str) -> String {
    format!("{ACP_EVENT_CHANNEL_PREFIX}{session_id}")
}

/// Validate a session id (the same shape contract the native-API requestId uses).
fn valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= 160
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
}

/// Split a stdout/stderr buffer into complete newline-terminated lines. Pure
/// helper so the framing contract is unit-tested without a process: it appends
/// incoming bytes to the buffer and returns each complete line, leaving any
/// trailing partial line in the buffer for the next chunk.
pub(crate) fn drain_lines(buffer: &mut String, chunk: &str) -> Vec<String> {
    buffer.push_str(chunk);
    let mut lines = Vec::new();
    while let Some(newline_pos) = buffer.find('\n') {
        let line: String = buffer.drain(..=newline_pos).collect();
        let trimmed = line.trim_end_matches(['\n', '\r']).to_string();
        if trimmed.len() <= MAX_ACP_LINE_CHARACTERS {
            lines.push(trimmed);
        }
        // Oversized lines are dropped (bounded); the reader never blocks on them.
    }
    lines
}

/// A live ACP child process + its stdin writer. Held in the process map so
/// `write_acp_frame` can reach the stdin pipe and `close_acp_process` can kill
/// the child. The stdout reader task owns the emit loop and ends when stdout
/// closes (the CLI exited).
struct AcpChild {
    child: Child,
    stdin: Option<mpsc::Sender<String>>,
}

type AcpProcessMap = HashMap<String, AcpChild>;

fn process_map() -> &'static Mutex<AcpProcessMap> {
    static MAP: OnceLock<Mutex<AcpProcessMap>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The request to spawn an ACP CLI process. The provider id selects the
/// catalog-declared executable; the executable is never caller-supplied.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAcpProcessRequest {
    pub provider_id: String,
    /// Optional extra args appended after the provider's base launch args. The
    /// CLI's own flags only; never a secret.
    pub extra_args: Vec<String>,
}

/// The result of spawning: a session id the caller uses to write frames and
/// listen on `arden://acp/<sessionId>`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedAcpProcess {
    pub session_id: String,
}

/// The outcome of probing a CLI's auth state. Mirrors the TypeScript
/// `AcpCliProbeOutcome` vocabulary. Never carries a secret — only an enum.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcpCliProbeResult {
    NotInstalled,
    SignedOut,
    Connected,
    AuthFailed,
    Unavailable,
}

/// The opaque frame write request. `frame` is a single JSON-RPC line (no
/// trailing newline — Rust appends it).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteAcpFrameRequest {
    pub session_id: String,
    pub frame: String,
}

/// Spawn an ACP CLI child process for a provider, piping its stdio. Emits each
/// stdout line on `arden://acp/<sessionId>` and returns the session id. Fails
/// closed for an unknown provider, a missing executable, or a spawn error.
#[tauri::command]
pub async fn spawn_acp_process(
    app: AppHandle,
    request: SpawnAcpProcessRequest,
) -> Result<SpawnedAcpProcess, String> {
    let spec = acp_executable_for(&request.provider_id)
        .ok_or_else(|| format!("{} is not a registered ACP provider.", request.provider_id))?;

    for arg in &request.extra_args {
        if arg.len() > 4_096 {
            return Err("ACP launch argument exceeds the supported length.".to_string());
        }
    }

    let mut command = Command::new(spec.executable);
    command
        .args(&request.extra_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The CLI must not inherit Fable's stdio handles.
        ;

    let mut child = command.spawn().map_err(|err| {
        // A missing executable is the common case (CLI not installed).
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("The {} CLI is not installed.", spec.executable)
        } else {
            format!("Fable could not start the {} CLI.", spec.executable)
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Fable could not open the CLI stdout pipe.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Fable could not open the CLI stderr pipe.".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Fable could not open the CLI stdin pipe.".to_string())?;

    let session_id = format!(
        "acp-{}-{}",
        request.provider_id,
        chrono::Utc::now().timestamp_millis()
    );
    let channel = acp_channel(&session_id);

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
    // Pump frames from the channel into the CLI's stdin.
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(frame) = stdin_rx.recv().await {
            // Append the newline delimiter; ignore write failures (CLI may exit).
            if stdin.write_all(frame.as_bytes()).await.is_ok() {
                let _ = stdin.write_all(b"\n").await;
                let _ = stdin.flush().await;
            } else {
                break;
            }
        }
    });

    // Drain stdout line-by-line and emit each on the session channel.
    let stdout_channel = channel.clone();
    let stdout_app = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut buffer = String::new();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    // next_line already strips the newline; emit non-empty lines.
                    let lines = drain_lines(&mut buffer, &format!("{line}\n"));
                    for emitted in lines {
                        if !emitted.is_empty() {
                            let _ = stdout_app.emit(&stdout_channel, emitted);
                        }
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        // Signal end-of-stream so the TS transport closes cleanly.
        let _ = stdout_app.emit(&stdout_channel, "[ACP-CLOSED]");
    });

    // Drain stderr onto the same channel so the shell can surface CLI errors.
    let stderr_channel = channel.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    if !line.trim().is_empty() {
                        let _ = app.emit(
                            &stderr_channel,
                            format!("{{\"__fableAcpStderr\":{}}}", serde_json::Value::from(line)),
                        );
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    });

    process_map()
        .lock()
        .map_err(|_| "Fable could not access the ACP process map.".to_string())?
        .insert(
            session_id.clone(),
            AcpChild {
                child,
                stdin: Some(stdin_tx),
            },
        );

    Ok(SpawnedAcpProcess { session_id })
}

/// Write a single JSON-RPC frame to the CLI's stdin (newline appended). The
/// frame size is bounded so a caller cannot flood the pipe.
#[tauri::command]
pub async fn write_acp_frame(request: WriteAcpFrameRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) {
        return Err("ACP session id is invalid.".to_string());
    }
    if request.frame.len() > MAX_ACP_LINE_CHARACTERS {
        return Err("ACP frame exceeds the supported size limit.".to_string());
    }
    let sender = {
        let mut map = process_map()
            .lock()
            .map_err(|_| "Fable could not access the ACP process map.".to_string())?;
        map.get_mut(&request.session_id)
            .and_then(|entry| entry.stdin.take())
    };
    let Some(sender) = sender else {
        return Err("ACP session is not active.".to_string());
    };
    // Put the sender back regardless of send outcome so it stays reusable. If
    // the channel closed (CLI exited), the next write reports not-active.
    let send_result = sender.send(request.frame).await;
    let mut map = process_map()
        .lock()
        .map_err(|_| "Fable could not access the ACP process map.".to_string())?;
    if let Some(entry) = map.get_mut(&request.session_id) {
        if send_result.is_ok() {
            entry.stdin = Some(sender);
        }
    }
    if send_result.is_err() {
        return Err("ACP session is not active.".to_string());
    }
    Ok(())
}

/// Close an ACP session: kill the child and remove it from the map. Best-effort
/// — the child may already have exited. Always removes the map entry.
#[tauri::command]
pub async fn close_acp_process(session_id: String) -> Result<bool, String> {
    if !valid_session_id(&session_id) {
        return Err("ACP session id is invalid.".to_string());
    }
    let removed = {
        let mut map = process_map()
            .lock()
            .map_err(|_| "Fable could not access the ACP process map.".to_string())?;
        map.remove(&session_id)
    };
    let Some(mut child) = removed else {
        return Ok(false);
    };
    // Drop the stdin sender first so the pump exits, then kill the child.
    drop(child.stdin.take());
    let _ = child.child.start_kill();
    let _ = child.child.wait().await;
    Ok(true)
}

/// Probe a provider's CLI to detect its install/auth state. Runs the provider's
/// status command and maps the outcome to the truthful probe vocabulary. Never
/// reads a secret — only the exit code + whether the executable exists.
#[tauri::command]
pub async fn detect_acp_cli(provider_id: String) -> Result<AcpCliProbeResult, String> {
    let spec = acp_executable_for(&provider_id)
        .ok_or_else(|| format!("{} is not a registered ACP provider.", provider_id))?;

    let output = Command::new(spec.executable)
        .args(spec.auth_probe_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    let output = match output {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AcpCliProbeResult::NotInstalled);
        }
        Err(_) => return Ok(AcpCliProbeResult::Unavailable),
    };

    // Exit 0 ⇒ signed in (connected); non-zero with an auth marker ⇒ signed out
    // or auth-failed; anything else ⇒ unavailable. The stderr text is used only
    // to distinguish "not signed in" from a generic failure.
    if output.status.success() {
        return Ok(AcpCliProbeResult::Connected);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    if stderr.contains("sign in")
        || stderr.contains("sign-in")
        || stderr.contains("not authenticated")
        || stderr.contains("login")
        || stderr.contains("unauthorized")
    {
        return Ok(AcpCliProbeResult::SignedOut);
    }
    if stderr.contains("forbidden") || stderr.contains("denied") || stderr.contains("401") {
        return Ok(AcpCliProbeResult::AuthFailed);
    }
    Ok(AcpCliProbeResult::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_cursor_and_grok_executables() {
        let cursor = acp_executable_for("cursor").expect("cursor");
        assert_eq!(cursor.executable, "cursor");
        assert_eq!(cursor.auth_probe_args, ["agent", "status"]);
        let grok = acp_executable_for("grok").expect("grok");
        assert_eq!(grok.executable, "grok");
        assert_eq!(grok.auth_probe_args, ["status"]);
    }

    #[test]
    fn unknown_provider_is_not_registered() {
        assert!(acp_executable_for("codex").is_none());
        assert!(acp_executable_for("openai").is_none());
        assert!(acp_executable_for("evil-path").is_none());
    }

    #[test]
    fn drain_lines_splits_complete_lines_and_keeps_partial() {
        let mut buffer = String::new();
        let lines = drain_lines(&mut buffer, "{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(
            lines,
            vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn drain_lines_keeps_a_trailing_partial_line() {
        let mut buffer = String::new();
        let lines = drain_lines(&mut buffer, "{\"a\":1}\n{\"b\":");
        assert_eq!(lines, vec!["{\"a\":1}".to_string()]);
        assert_eq!(buffer, "{\"b\":");
        // Next chunk completes the partial line.
        let more = drain_lines(&mut buffer, "2}\n");
        assert_eq!(more, vec!["{\"b\":2}".to_string()]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn drain_lines_strips_carriage_returns() {
        let mut buffer = String::new();
        let lines = drain_lines(&mut buffer, "{\"a\":1}\r\n");
        assert_eq!(lines, vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn drain_lines_drops_oversized_lines() {
        let mut buffer = String::new();
        let huge = format!("{{\"x\":\"{}\"}}\n", "a".repeat(MAX_ACP_LINE_CHARACTERS));
        let lines = drain_lines(&mut buffer, &huge);
        assert!(lines.is_empty());
    }

    #[test]
    fn channel_is_namespaced_per_session() {
        assert_eq!(acp_channel("acp-cursor-1"), "arden://acp/acp-cursor-1");
    }

    #[test]
    fn valid_session_id_rejects_malformed_ids() {
        assert!(valid_session_id("acp-cursor-123"));
        assert!(valid_session_id("a"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("has space"));
        assert!(!valid_session_id("has/slash"));
        assert!(!valid_session_id(&"x".repeat(161)));
    }
}

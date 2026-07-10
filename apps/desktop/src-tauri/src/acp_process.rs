//! ACP (Agent Client Protocol) child-process boundary.
//!
//! Rust owns the CLI child process for catalog-declared ACP providers. A CLI is
//! spawned here with piped stdio; its stdout is read line-by-line and each
//! newline-delimited JSON-RPC frame is emitted on the Tauri event channel
//! `arden://acp/<sessionId>`. The TypeScript adapter writes request frames back
//! through `write_acp_frame` and shuts the process down through
//! `close_acp_process`. **A CLI is never spawned from JavaScript** — this is
//! the sole process boundary, mirroring `native_api.rs` for HTTP egress.
//!
//! Auth is provider-owned: each CLI holds its own credentials. Fable never
//! collects, stores, or passes a subscription
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
    time::Duration,
};

use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
    time::timeout,
};

#[derive(Clone, Copy)]
enum AcpProbeKind {
    Command,
    SessionHandshake,
}

/// One allowed command form for a provider. Cursor has used both `agent` and
/// `cursor-agent`; every other provider currently has one executable name.
pub(crate) struct AcpCommand {
    executable: &'static str,
    /// Mandatory arguments owned by this allowlist. JavaScript cannot omit or
    /// replace them.
    launch_args: &'static [&'static str],
    /// Official, non-secret readiness probe arguments.
    auth_probe_args: &'static [&'static str],
    probe_kind: AcpProbeKind,
}

/// A catalog-declared ACP provider and its allowed executable candidates.
pub(crate) struct AcpExecutable {
    provider_id: &'static str,
    commands: &'static [AcpCommand],
}

/// The catalog of ACP executables. Mirrors the TypeScript `ACP_PROVIDERS`; kept
/// here so Rust can validate the provider id and resolve the executable without
/// trusting a caller-supplied path (which could be an arbitrary binary).
const CURSOR_COMMANDS: &[AcpCommand] = &[
    AcpCommand {
        executable: "agent",
        launch_args: &["acp"],
        auth_probe_args: &["status"],
        probe_kind: AcpProbeKind::Command,
    },
    AcpCommand {
        executable: "cursor-agent",
        launch_args: &["acp"],
        auth_probe_args: &["status"],
        probe_kind: AcpProbeKind::Command,
    },
];
const COPILOT_COMMANDS: &[AcpCommand] = &[AcpCommand {
    executable: "copilot",
    launch_args: &["--acp", "--stdio"],
    // Copilot has no secret-safe account-status command, so the probe performs
    // a bounded ACP initialize + session/new handshake instead.
    auth_probe_args: &[],
    probe_kind: AcpProbeKind::SessionHandshake,
}];
const GROK_COMMANDS: &[AcpCommand] = &[AcpCommand {
    executable: "grok",
    launch_args: &["--no-auto-update", "agent", "stdio"],
    auth_probe_args: &["--no-auto-update", "models"],
    probe_kind: AcpProbeKind::Command,
}];
const OPENCODE_COMMANDS: &[AcpCommand] = &[AcpCommand {
    executable: "opencode",
    launch_args: &["acp"],
    auth_probe_args: &["models"],
    probe_kind: AcpProbeKind::Command,
}];
const KIMI_COMMANDS: &[AcpCommand] = &[AcpCommand {
    executable: "kimi",
    launch_args: &["acp"],
    // Kimi exposes its login state through ACP `authenticate`; probing the
    // protocol avoids reading its provider-owned token.
    auth_probe_args: &[],
    probe_kind: AcpProbeKind::SessionHandshake,
}];
const MISTRAL_VIBE_COMMANDS: &[AcpCommand] = &[AcpCommand {
    executable: "vibe-acp",
    launch_args: &[],
    // Vibe owns browser/API-key setup. ACP negotiation is its supported IDE
    // integration boundary and is the only status signal Fable consumes.
    auth_probe_args: &[],
    probe_kind: AcpProbeKind::SessionHandshake,
}];

const ACP_EXECUTABLES: &[AcpExecutable] = &[
    AcpExecutable {
        provider_id: "cursor",
        commands: CURSOR_COMMANDS,
    },
    AcpExecutable {
        provider_id: "copilot",
        commands: COPILOT_COMMANDS,
    },
    AcpExecutable {
        provider_id: "grok",
        commands: GROK_COMMANDS,
    },
    AcpExecutable {
        provider_id: "opencode",
        commands: OPENCODE_COMMANDS,
    },
    AcpExecutable {
        provider_id: "kimi",
        commands: KIMI_COMMANDS,
    },
    AcpExecutable {
        provider_id: "mistral-vibe",
        commands: MISTRAL_VIBE_COMMANDS,
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
    pub cwd: String,
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

    if !request.extra_args.is_empty() {
        return Err("Custom ACP launch arguments are not supported.".to_string());
    }

    let workspace_root = crate::tools::resolve_workspace_root(&app)?;
    let cwd = workspace_root.to_string_lossy().to_string();
    let mut started: Option<(Child, &'static str)> = None;
    for candidate in spec.commands {
        let mut command = Command::new(candidate.executable);
        command
            .args(candidate.launch_args)
            .current_dir(&workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match command.spawn() {
            Ok(child) => {
                started = Some((child, candidate.executable));
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(format!(
                    "Fable could not start the {} CLI.",
                    candidate.executable
                ));
            }
        }
    }
    let Some((mut child, _executable)) = started else {
        return Err(format!("The {} CLI is not installed.", request.provider_id));
    };

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

    Ok(SpawnedAcpProcess { session_id, cwd })
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

fn classify_probe_error(error: &serde_json::Value) -> AcpCliProbeResult {
    let diagnostic = error.to_string().to_ascii_lowercase();
    if diagnostic.contains("forbidden")
        || diagnostic.contains("access denied")
        || diagnostic.contains("401")
        || diagnostic.contains("403")
    {
        AcpCliProbeResult::AuthFailed
    } else if diagnostic.contains("auth_required")
        || diagnostic.contains("authrequired")
        || diagnostic.contains("authentication required")
        || diagnostic.contains("not authenticated")
        || diagnostic.contains("not logged in")
        || diagnostic.contains("sign in")
        || diagnostic.contains("login")
        || diagnostic.contains("unauthorized")
    {
        AcpCliProbeResult::SignedOut
    } else {
        AcpCliProbeResult::Unavailable
    }
}

async fn read_probe_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: i64,
) -> Result<serde_json::Value, ()> {
    timeout(Duration::from_secs(6), async {
        loop {
            let line = lines.next_line().await.map_err(|_| ())?.ok_or(())?;
            if line.len() > MAX_ACP_LINE_CHARACTERS {
                continue;
            }
            let value: serde_json::Value = serde_json::from_str(&line).map_err(|_| ())?;
            if value.get("id").and_then(serde_json::Value::as_i64) == Some(expected_id) {
                return Ok(value);
            }
            // Notifications are legal while a request is pending; ignore them.
        }
    })
    .await
    .map_err(|_| ())?
}

/// Copilot documents no reliable status command. Probe it by negotiating ACP
/// v1 and creating an empty session, bounded by a timeout and killed afterward.
/// This validates auth without sending a prompt or exposing any credential.
async fn probe_acp_session(candidate: &AcpCommand) -> AcpCliProbeResult {
    let cwd = match std::env::current_dir()
        .ok()
        .and_then(|path| crate::paths::harden_workspace_root(&path).ok())
    {
        Some(path) => path,
        None => return AcpCliProbeResult::Unavailable,
    };
    let mut command = Command::new(candidate.executable);
    command
        .args(candidate.launch_args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return AcpCliProbeResult::NotInstalled;
        }
        Err(_) => return AcpCliProbeResult::Unavailable,
    };
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => return AcpCliProbeResult::Unavailable,
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => return AcpCliProbeResult::Unavailable,
    };
    let mut lines = BufReader::new(stdout).lines();

    let result = async {
        let initialize = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": { "name": "fable", "title": "Fable", "version": "1" }
            }
        });
        if stdin
            .write_all(format!("{initialize}\n").as_bytes())
            .await
            .is_err()
        {
            return AcpCliProbeResult::Unavailable;
        }
        let initialized = match read_probe_response(&mut lines, 1).await {
            Ok(value) => value,
            Err(_) => return AcpCliProbeResult::Unavailable,
        };
        if let Some(error) = initialized.get("error") {
            return classify_probe_error(error);
        }
        if initialized
            .pointer("/result/protocolVersion")
            .and_then(serde_json::Value::as_i64)
            != Some(1)
        {
            return AcpCliProbeResult::Unavailable;
        }

        let auth_method = initialized
            .pointer("/result/authMethods")
            .and_then(serde_json::Value::as_array)
            .and_then(|methods| {
                methods.iter().find_map(|method| {
                    method
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .filter(|id| !id.is_empty())
                })
            });
        if let Some(method_id) = auth_method {
            let authenticate = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "authenticate",
                "params": {
                    "methodId": method_id,
                    "_meta": { "headless": true }
                }
            });
            if stdin
                .write_all(format!("{authenticate}\n").as_bytes())
                .await
                .is_err()
            {
                return AcpCliProbeResult::Unavailable;
            }
            let authenticated = match read_probe_response(&mut lines, 2).await {
                Ok(value) => value,
                Err(_) => return AcpCliProbeResult::Unavailable,
            };
            if let Some(error) = authenticated.get("error") {
                return classify_probe_error(error);
            }
        }

        let session = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/new",
            "params": { "cwd": cwd.to_string_lossy(), "mcpServers": [] }
        });
        if stdin
            .write_all(format!("{session}\n").as_bytes())
            .await
            .is_err()
        {
            return AcpCliProbeResult::Unavailable;
        }
        let created = match read_probe_response(&mut lines, 3).await {
            Ok(value) => value,
            Err(_) => return AcpCliProbeResult::Unavailable,
        };
        if let Some(error) = created.get("error") {
            return classify_probe_error(error);
        }
        if created
            .pointer("/result/sessionId")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            AcpCliProbeResult::Connected
        } else {
            AcpCliProbeResult::Unavailable
        }
    }
    .await;

    let _ = child.start_kill();
    let _ = child.wait().await;
    result
}

/// Probe a provider's CLI to detect its install/auth state. Runs the provider's
/// status command and maps the outcome to the truthful probe vocabulary. Never
/// reads a secret — only the exit code + whether the executable exists.
#[tauri::command]
pub async fn detect_acp_cli(provider_id: String) -> Result<AcpCliProbeResult, String> {
    let spec = acp_executable_for(&provider_id)
        .ok_or_else(|| format!("{} is not a registered ACP provider.", provider_id))?;

    let mut discovered = None;
    for candidate in spec.commands {
        if matches!(candidate.probe_kind, AcpProbeKind::SessionHandshake) {
            match probe_acp_session(candidate).await {
                AcpCliProbeResult::NotInstalled => continue,
                outcome => return Ok(outcome),
            }
        }
        let output = Command::new(candidate.executable)
            .args(candidate.auth_probe_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await;
        match output {
            Ok(output) => {
                discovered = Some(output);
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Ok(AcpCliProbeResult::Unavailable),
        }
    }
    let Some(output) = discovered else {
        return Ok(AcpCliProbeResult::NotInstalled);
    };

    // Exit 0 ⇒ signed in (connected); non-zero with an auth marker ⇒ signed out
    // or auth-failed; anything else ⇒ unavailable. The stderr text is used only
    // to distinguish "not signed in" from a generic failure.
    if output.status.success() {
        return Ok(AcpCliProbeResult::Connected);
    }
    let diagnostic = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    if diagnostic.contains("sign in")
        || diagnostic.contains("sign-in")
        || diagnostic.contains("not authenticated")
        || diagnostic.contains("not logged in")
        || diagnostic.contains("login required")
        || diagnostic.contains("unauthorized")
    {
        return Ok(AcpCliProbeResult::SignedOut);
    }
    if diagnostic.contains("forbidden")
        || diagnostic.contains("access denied")
        || diagnostic.contains("401")
        || diagnostic.contains("403")
    {
        return Ok(AcpCliProbeResult::AuthFailed);
    }
    Ok(AcpCliProbeResult::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_all_acp_executables_with_mandatory_launch_args() {
        let cursor = acp_executable_for("cursor").expect("cursor");
        assert_eq!(cursor.commands[0].executable, "agent");
        assert_eq!(cursor.commands[0].launch_args, ["acp"]);
        assert_eq!(cursor.commands[1].executable, "cursor-agent");

        let copilot = acp_executable_for("copilot").expect("copilot");
        assert_eq!(copilot.commands[0].executable, "copilot");
        assert_eq!(copilot.commands[0].launch_args, ["--acp", "--stdio"]);

        let grok = acp_executable_for("grok").expect("grok");
        assert_eq!(grok.commands[0].executable, "grok");
        assert_eq!(
            grok.commands[0].launch_args,
            ["--no-auto-update", "agent", "stdio"]
        );

        let opencode = acp_executable_for("opencode").expect("opencode");
        assert_eq!(opencode.commands[0].executable, "opencode");
        assert_eq!(opencode.commands[0].launch_args, ["acp"]);

        let kimi = acp_executable_for("kimi").expect("kimi");
        assert_eq!(kimi.commands[0].executable, "kimi");
        assert_eq!(kimi.commands[0].launch_args, ["acp"]);

        let mistral = acp_executable_for("mistral-vibe").expect("mistral-vibe");
        assert_eq!(mistral.commands[0].executable, "vibe-acp");
        assert!(mistral.commands[0].launch_args.is_empty());
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

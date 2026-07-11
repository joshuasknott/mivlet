//! Native process custody for machine-local STDIO MCP servers.
//!
//! Launch details are resolved from the encrypted owner-bound repository by an
//! opaque reference. The renderer cannot supply an executable or arguments at
//! spawn time, and every subsequent write/close rechecks the active account and
//! workspace before touching the session.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::mpsc,
    time::timeout,
};

const MAX_MCP_FRAME_BYTES: usize = 10 * 1024 * 1024;
const MCP_EVENT_CHANNEL_PREFIX: &str = "fable://mcp/";

struct McpChild {
    child: Child,
    stdin: Option<mpsc::Sender<String>>,
    workspace_id: String,
    owner_subject: String,
    connection_id: String,
    connection_revision: i64,
}

type ProcessMap = HashMap<String, McpChild>;

fn process_map() -> &'static Mutex<ProcessMap> {
    static MAP: OnceLock<Mutex<ProcessMap>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnMcpProcessRequest {
    workspace_id: String,
    launch_reference: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedMcpProcess {
    session_id: String,
    channel: String,
    launch_reference: String,
    connection_id: String,
    connection_revision: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMcpFrameRequest {
    workspace_id: String,
    session_id: String,
    frame: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseMcpProcessRequest {
    workspace_id: String,
    session_id: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfiguration {
    workspace_id: String,
    id: String,
    display_name: String,
    command: String,
    args: Vec<String>,
    expected_revision: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMcpServerConfiguration {
    configuration_fingerprint: String,
    approval: crate::models::ApprovalRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMcpServerConfigurationRequest {
    configuration: McpServerConfiguration,
    resolution: crate::models::ApprovalResolutionRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMcpDiscoveryRequest {
    workspace_id: String,
    session_id: String,
    tools: Vec<String>,
    resources: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMcpEnablementRequest {
    workspace_id: String,
    connection_id: String,
    expected_revision: i64,
    enabled_tools: Vec<String>,
    enabled_resources: Vec<String>,
}

#[tauri::command]
pub fn prepare_mcp_server_configuration(
    configuration: McpServerConfiguration,
) -> Result<PreparedMcpServerConfiguration, String> {
    crate::authorized_scope::command_scope(
        Some(configuration.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    validate_configuration_for_approval(&configuration)?;
    let fingerprint = configuration_fingerprint(&configuration)?;
    let id = random_session_id()?.replacen("mcp-", "approval-mcp-", 1);
    let approval = approval_for_configuration(
        &configuration,
        &fingerprint,
        id,
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    Ok(PreparedMcpServerConfiguration {
        configuration_fingerprint: fingerprint,
        approval,
    })
}

#[tauri::command]
pub fn commit_mcp_server_configuration(
    app: AppHandle,
    request: CommitMcpServerConfigurationRequest,
) -> Result<crate::store::repos::mcp_local_server::SafeMcpLocalServer, String> {
    validate_configuration_for_approval(&request.configuration)?;
    let fingerprint = configuration_fingerprint(&request.configuration)?;
    let expected = approval_for_configuration(
        &request.configuration,
        &fingerprint,
        request.resolution.request.id.clone(),
        request.resolution.request.requested_at.clone(),
    );
    if request.resolution.request != expected
        || request.resolution.decision != "once"
        || request.resolution.modification.is_some()
    {
        return Err("The MCP configuration changed after the approval preview.".to_string());
    }
    let resolution = crate::approvals::resolve_approval(request.resolution)?;
    if resolution.audit_entry.decision != "once" {
        return Err("Local MCP configuration requires a fresh one-time approval.".to_string());
    }
    crate::execution_approvals::verify_and_consume_execution_approval(
        &crate::paths::execution_approvals_path(&app)?,
        &resolution.effective_request,
        &resolution.audit_entry.decided_at,
    )?;
    let scope = crate::authorized_scope::command_scope(
        Some(request.configuration.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let now = resolution.audit_entry.decided_at;
    store
        .transaction(|tx| {
            let saved = crate::store::repos::mcp_local_server::upsert(
                tx,
                store,
                &scope,
                crate::store::repos::mcp_local_server::McpLocalServerWrite {
                    id: &request.configuration.id,
                    display_name: &request.configuration.display_name,
                    command: &request.configuration.command,
                    args: &request.configuration.args,
                    expected_revision: request.configuration.expected_revision,
                    updated_at: &now,
                },
            )?;
            crate::store::repos::connection_record::upsert_mcp_stdio(
                tx,
                store,
                &scope,
                &saved.id,
                &saved.display_name,
                &now,
            )?;
            Ok(saved)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_mcp_server_configurations(
    workspace_id: String,
) -> Result<Vec<crate::store::repos::mcp_local_server::SafeMcpLocalServer>, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .with_conn(|tx| crate::store::repos::mcp_local_server::list(tx, store, &scope))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn record_mcp_server_discovery(
    request: RecordMcpDiscoveryRequest,
) -> Result<crate::store::repos::connection_record::SafeMcpConnectionDetails, String> {
    if !valid_session_id(&request.session_id) {
        return Err("The MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let (connection_id, connection_revision) = {
        let map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        (process.connection_id.clone(), process.connection_revision)
    };
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            crate::store::repos::connection_record::record_mcp_discovery(
                tx,
                store,
                &scope,
                &connection_id,
                connection_revision,
                request.tools,
                request.resources,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_mcp_server_enablement(
    request: SetMcpEnablementRequest,
) -> Result<crate::store::repos::connection_record::SafeMcpConnectionDetails, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Write,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    store
        .transaction(|tx| {
            crate::store::repos::connection_record::set_mcp_enablement(
                tx,
                store,
                &scope,
                &request.connection_id,
                request.expected_revision,
                request.enabled_tools,
                request.enabled_resources,
                &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            )
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn spawn_mcp_process(
    app: AppHandle,
    request: SpawnMcpProcessRequest,
) -> Result<SpawnedMcpProcess, String> {
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id.clone()),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let store = crate::store::try_global()
        .ok_or_else(|| "Fable's encrypted store is not initialized.".to_string())?;
    let launch = store
        .with_conn(|tx| {
            crate::store::repos::mcp_local_server::get_launch(
                tx,
                store,
                &scope,
                &request.launch_reference,
            )
        })
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "This local MCP server is unavailable.".to_string())?;
    if launch.metadata.disabled {
        return Err("This local MCP server is disabled.".to_string());
    }
    let connection = store
        .with_conn(|tx| {
            crate::store::repos::connection_record::mcp_details_for_launch(
                tx,
                store,
                &scope,
                &request.launch_reference,
            )
        })
        .map_err(|error| error.to_string())?;

    let executable = validate_executable(&launch.command)?;
    let workspace_root = crate::tools::resolve_workspace_root(&app)?;
    let mut child = spawn_mcp_child(&executable, &launch.args, &workspace_root)
        .map_err(|_| "Fable could not start this local MCP server.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Fable could not open the MCP stdout pipe.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Fable could not open the MCP stderr pipe.".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Fable could not open the MCP stdin pipe.".to_string())?;

    let session_id = random_session_id()?;
    let channel = format!("{MCP_EVENT_CHANNEL_PREFIX}{session_id}");
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(frame) = stdin_rx.recv().await {
            if stdin.write_all(frame.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    let stdout_app = app.clone();
    let stdout_channel = channel.clone();
    tokio::spawn(async move {
        let mut reader = stdout;
        let mut decoder = BoundedLineDecoder::default();
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(count) => {
                    for line in decoder.push(&chunk[..count]) {
                        if let Ok(text) = String::from_utf8(line) {
                            if valid_mcp_frame(&text) {
                                let _ = stdout_app.emit(&stdout_channel, text);
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stdout_app.emit(&stdout_channel, "[MCP-CLOSED]");
    });
    // Stderr may contain credentials or provider diagnostics. Drain it so the
    // child cannot block, but never forward it across the native boundary.
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut chunk = [0_u8; 8 * 1024];
        while let Ok(count) = stderr.read(&mut chunk).await {
            if count == 0 {
                break;
            }
        }
    });

    process_map()
        .lock()
        .map_err(|_| "Fable could not access local MCP sessions.".to_string())?
        .insert(
            session_id.clone(),
            McpChild {
                child,
                stdin: Some(stdin_tx),
                workspace_id: scope.data.workspace_id().to_string(),
                owner_subject: scope.private.owner_subject().to_string(),
                connection_id: connection.connection_id.clone(),
                connection_revision: connection.connection_revision,
            },
        );
    Ok(SpawnedMcpProcess {
        session_id,
        channel,
        launch_reference: launch.metadata.id,
        connection_id: connection.connection_id,
        connection_revision: connection.connection_revision,
    })
}

#[tauri::command]
pub async fn write_mcp_frame(request: WriteMcpFrameRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) || !permitted_renderer_frame(&request.frame) {
        return Err("The MCP frame is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let sender = {
        let map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        process
            .stdin
            .clone()
            .ok_or_else(|| "This local MCP session is closed.".to_string())?
    };
    sender
        .send(request.frame)
        .await
        .map_err(|_| "This local MCP session is closed.".to_string())
}

#[tauri::command]
pub async fn close_mcp_process(request: CloseMcpProcessRequest) -> Result<(), String> {
    if !valid_session_id(&request.session_id) {
        return Err("The MCP session id is invalid.".to_string());
    }
    let scope = crate::authorized_scope::command_scope(
        Some(request.workspace_id),
        None,
        crate::authorized_scope::ScopeAccess::Read,
    )?;
    let mut process = {
        let mut map = process_map()
            .lock()
            .map_err(|_| "Fable could not access local MCP sessions.".to_string())?;
        let process = map
            .get(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?;
        require_session_owner(process, &scope)?;
        map.remove(&request.session_id)
            .ok_or_else(|| "This local MCP session is unavailable.".to_string())?
    };
    process.stdin.take();
    match timeout(Duration::from_secs(2), process.child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        _ => {
            let _ = process.child.kill().await;
            let _ = process.child.wait().await;
            Ok(())
        }
    }
}

fn require_session_owner(
    process: &McpChild,
    scope: &crate::authorized_scope::AuthorizedCommandScope,
) -> Result<(), String> {
    if process.workspace_id != scope.data.workspace_id()
        || process.owner_subject != scope.private.owner_subject()
    {
        return Err("This local MCP session belongs to a different account or workspace.".into());
    }
    Ok(())
}

fn validate_configuration_for_approval(
    configuration: &McpServerConfiguration,
) -> Result<(), String> {
    crate::store::repos::scope::normalize_id(&configuration.id, "MCP launch reference")
        .map_err(|error| error.to_string())?;
    if configuration
        .expected_revision
        .is_some_and(|revision| revision < 1)
    {
        return Err("MCP configuration revision is invalid.".to_string());
    }
    crate::store::repos::mcp_local_server::validate_launch_values(
        &configuration.display_name,
        &configuration.command,
        &configuration.args,
    )
    .map_err(|error| error.to_string())?;
    validate_executable(&configuration.command)?;
    let lower_args = configuration.args.join(" ").to_ascii_lowercase();
    const SECRET_MARKERS: &[&str] = &[
        "api-key",
        "apikey",
        "authorization",
        "bearer",
        "password",
        "secret",
        "token",
    ];
    if SECRET_MARKERS
        .iter()
        .any(|marker| lower_args.contains(marker))
    {
        return Err(
            "MCP launch arguments cannot contain credentials; use native credential custody."
                .to_string(),
        );
    }
    Ok(())
}

fn configuration_fingerprint(configuration: &McpServerConfiguration) -> Result<String, String> {
    let encoded = serde_json::to_vec(configuration)
        .map_err(|_| "Fable could not fingerprint this MCP configuration.".to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn approval_for_configuration(
    configuration: &McpServerConfiguration,
    fingerprint: &str,
    id: String,
    requested_at: String,
) -> crate::models::ApprovalRequest {
    crate::models::ApprovalRequest {
        id,
        service: "MCP connections".to_string(),
        action: format!("configure local MCP server {}", configuration.id),
        mode: "full-access".to_string(),
        risk_level: "critical".to_string(),
        data_used: vec![
            format!("server: {}", configuration.display_name.trim()),
            format!("configuration fingerprint: {fingerprint}"),
        ],
        consequence:
            "Starts a user-managed local program that can expose tools and resources to Fable."
                .to_string(),
        requested_at,
        decisions: vec!["once".to_string(), "deny".to_string()],
        confirmation_phrase: Some(format!("configure {}", configuration.id)),
    }
}

fn validate_executable(command: &str) -> Result<PathBuf, String> {
    let path = Path::new(command);
    if !path.is_absolute() {
        return Err("Local MCP executables must use an absolute path.".to_string());
    }
    let canonical = crate::paths::strict_canonicalize(path)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| "The local MCP executable path is unavailable.".to_string())?;
    if !metadata.is_file() || crate::paths::contains_symlink(path) {
        return Err("The local MCP executable must be a regular file without links.".to_string());
    }
    #[cfg(windows)]
    if canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return Err("Local MCP executables must be Windows .exe files.".to_string());
    }
    Ok(canonical)
}

fn copy_safe_environment(command: &mut Command) {
    const SAFE: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "LANG",
        "LC_ALL",
    ];
    for name in SAFE {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn spawn_mcp_child(executable: &Path, args: &[String], cwd: &Path) -> std::io::Result<Child> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    copy_safe_environment(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    command.spawn()
}

fn random_session_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Fable could not create a local MCP session id.".to_string())?;
    Ok(format!("mcp-{}", hex::encode(bytes)))
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 36
        && value.starts_with("mcp-")
        && value[4..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn valid_mcp_frame(frame: &str) -> bool {
    if frame.is_empty() || frame.len() > MAX_MCP_FRAME_BYTES || frame.contains(['\r', '\n']) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return false;
    }
    let valid_id = object
        .get("id")
        .is_none_or(|id| id.is_string() || id.as_i64().is_some() || id.as_u64().is_some());
    if !valid_id {
        return false;
    }
    if let Some(method) = object.get("method") {
        return method.as_str().is_some_and(|value| !value.is_empty())
            && !object.contains_key("result")
            && !object.contains_key("error");
    }
    object.contains_key("id") && (object.contains_key("result") ^ object.contains_key("error"))
}

fn permitted_renderer_frame(frame: &str) -> bool {
    if !valid_mcp_frame(frame) {
        return false;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(frame) else {
        return false;
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        // This client advertises no server-request capabilities, so renderer
        // responses are never needed and cannot become an execution bypass.
        return false;
    };
    matches!(
        method,
        "initialize"
            | "ping"
            | "tools/list"
            | "resources/list"
            | "resources/templates/list"
            | "notifications/initialized"
            | "notifications/cancelled"
    )
}

#[derive(Default)]
struct BoundedLineDecoder {
    buffer: Vec<u8>,
    dropping: bool,
}

impl BoundedLineDecoder {
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        for byte in chunk {
            if *byte == b'\n' {
                if !self.dropping {
                    if self.buffer.last() == Some(&b'\r') {
                        self.buffer.pop();
                    }
                    lines.push(std::mem::take(&mut self.buffer));
                } else {
                    self.buffer.clear();
                }
                self.dropping = false;
            } else if !self.dropping {
                if self.buffer.len() < MAX_MCP_FRAME_BYTES {
                    self.buffer.push(*byte);
                } else {
                    self.buffer.clear();
                    self.dropping = true;
                }
            }
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, BufReader};

    #[test]
    fn frame_validation_accepts_protocol_messages_and_rejects_logs_or_multiline() {
        assert!(valid_mcp_frame(
            r#"{"jsonrpc":"2.0","id":"one","method":"initialize","params":{}}"#
        ));
        assert!(valid_mcp_frame(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        ));
        assert!(!valid_mcp_frame("server ready"));
        assert!(!valid_mcp_frame(
            "{\"jsonrpc\":\"2.0\",\"method\":\"x\"}\n{}"
        ));
        assert!(!valid_mcp_frame(
            r#"{"jsonrpc":"2.0","id":null,"result":{}}"#
        ));
    }

    #[test]
    fn renderer_frames_are_control_plane_only() {
        assert!(permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}"#
        ));
        assert!(permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        ));
        for method in [
            "tools/call",
            "resources/read",
            "prompts/get",
            "sampling/createMessage",
        ] {
            assert!(!permitted_renderer_frame(&format!(
                r#"{{"jsonrpc":"2.0","id":"blocked","method":"{method}","params":{{}}}}"#
            )));
        }
        assert!(!permitted_renderer_frame(
            r#"{"jsonrpc":"2.0","id":"server-request","result":{}}"#
        ));
    }

    #[test]
    fn bounded_decoder_reassembles_lines_and_discards_oversized_input() {
        let mut decoder = BoundedLineDecoder::default();
        assert!(decoder.push(b"one").is_empty());
        assert_eq!(
            decoder.push(b"\r\ntwo\n"),
            [b"one".to_vec(), b"two".to_vec()]
        );
        decoder.push(&vec![b'x'; MAX_MCP_FRAME_BYTES + 1]);
        assert!(decoder
            .push(b"discarded\nvalid\n")
            .iter()
            .any(|line| line == b"valid"));
    }

    #[test]
    fn session_ids_are_random_and_strictly_shaped() {
        let first = random_session_id().unwrap();
        let second = random_session_id().unwrap();
        assert!(valid_session_id(&first));
        assert_ne!(first, second);
        assert!(!valid_session_id("mcp-guessable"));
    }

    #[test]
    fn executable_validation_rejects_relative_paths_and_directories() {
        assert!(validate_executable("server.exe").is_err());
        assert!(validate_executable(std::env::temp_dir().to_string_lossy().as_ref()).is_err());
    }

    #[test]
    fn configuration_approval_binds_exact_secret_free_input() {
        let command = find_node();
        let configuration = McpServerConfiguration {
            workspace_id: "workspace-a".into(),
            id: "files".into(),
            display_name: "Local files".into(),
            command: command.to_string_lossy().to_string(),
            args: vec!["--stdio".into(), "C:\\work".into()],
            expected_revision: None,
        };
        validate_configuration_for_approval(&configuration).unwrap();
        let fingerprint = configuration_fingerprint(&configuration).unwrap();
        let approval = approval_for_configuration(
            &configuration,
            &fingerprint,
            "approval-1".into(),
            "2026-07-11T19:00:00Z".into(),
        );
        assert_eq!(approval.decisions, ["once", "deny"]);
        assert!(approval
            .data_used
            .iter()
            .all(|value| !value.contains("C:\\work")));

        let mut changed = configuration.clone();
        changed.args.push("--write".into());
        assert_ne!(
            configuration_fingerprint(&configuration).unwrap(),
            configuration_fingerprint(&changed).unwrap()
        );
        changed.args = vec!["--api-key=secret".into()];
        assert!(validate_configuration_for_approval(&changed).is_err());
    }

    fn find_node() -> PathBuf {
        let executable = if cfg!(windows) { "node.exe" } else { "node" };
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            .map(|directory| directory.join(executable))
            .find(|candidate| candidate.is_file())
            .expect("the workspace requires Node.js on PATH")
    }

    #[tokio::test]
    async fn real_stdio_child_initializes_discovers_calls_and_closes() {
        let node = validate_executable(find_node().to_string_lossy().as_ref()).unwrap();
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp-stdio-server.mjs");
        let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut child =
            spawn_mcp_child(&node, &[fixture.to_string_lossy().to_string()], &cwd).unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();

        for request in [
            r#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Fable","version":"0.1.0"}}}"#,
            r#"{"jsonrpc":"2.0","id":"list","method":"tools/list","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":"echo","arguments":{"text":"hello"}}}"#,
        ] {
            stdin.write_all(request.as_bytes()).await.unwrap();
            stdin.write_all(b"\n").await.unwrap();
            stdin.flush().await.unwrap();
            let response = timeout(Duration::from_secs(5), lines.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(valid_mcp_frame(&response));
            let value: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(value.get("error"), None);
        }
        drop(stdin);
        let status = timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
    }
}

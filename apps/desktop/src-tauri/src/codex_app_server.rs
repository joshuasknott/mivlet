//! Codex app-server process boundary.
//!
//! Mivlet supervises `codex app-server --stdio` as a provider adapter, but Codex
//! owns authentication. This module never opens Codex auth files and never asks
//! for `getAuthStatus`, because that response can include auth tokens.

use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[path = "codex_app_server/catalog.rs"]
mod catalog;
#[path = "codex_app_server/discovery.rs"]
mod discovery;
#[path = "codex_app_server/login.rs"]
mod login;
#[path = "codex_app_server/steering.rs"]
mod steering;
#[path = "codex_app_server/turns.rs"]
mod turns;
#[cfg(test)]
use discovery::codex_candidates_from;
use discovery::{codex_command, find_codex_executable, missing_codex_runtime_message};
#[cfg(test)]
use login::{chatgpt_login_details, validated_codex_auth_url};
use login::{receive_codex_value, start_codex_browser_login_blocking};
#[tauri::command]
pub fn codex_cli_status() -> CodexCliStatus {
    catalog::codex_cli_status()
}

/// Ask the installed app-server for its current model catalog.
///
/// Codex owns both authentication and model availability. Keeping this lookup
/// at the native process boundary avoids stale hardcoded model IDs without
/// exposing any auth material to JavaScript.
pub(crate) fn codex_model_catalog() -> Result<Vec<CodexModelCatalogEntry>, String> {
    catalog::codex_model_catalog()
}

pub(crate) fn codex_backend_snapshot(
) -> Result<catalog::CodexBackendSnapshot, catalog::CodexBackendDiscoveryError> {
    catalog::codex_backend_snapshot()
}

pub(crate) use catalog::CodexBackendDiscoveryError;

pub(crate) use steering::{steer_active_turn, SteeringDelivery};
use turns::{
    build_additional_context, model_fast_mode, model_reasoning, stage_codex_user_images,
    thread_start_request, turn_start_request,
};

const CODEX_LOGIN_START_TIMEOUT: Duration = Duration::from_secs(20);
const CODEX_LOGIN_COMPLETION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliStatus {
    pub(crate) installed: bool,
    pub(crate) authenticated: bool,
    pub(crate) auth_method: Option<String>,
    pub(crate) version: Option<String>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexBrowserLoginResult {
    provider_id: &'static str,
    outcome: &'static str,
    message: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexModelCatalogEntry {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) is_default: bool,
    pub(crate) supports_images: bool,
    pub(crate) reasoning: Option<Value>,
    pub(crate) fast_mode: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnStartRequest {
    request_id: String,
    provider_id: String,
    request: CodexAgentRunRequest,
    options: CodexTurnOptions,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAgentRunRequest {
    model: String,
    reasoning_effort: Option<String>,
    service_tier: Option<CodexServiceTier>,
    messages: Vec<CodexMessage>,
    tools: Vec<Value>,
    #[allow(dead_code)]
    max_tokens: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CodexServiceTier {
    Fast,
    Priority,
}

#[derive(Clone, Debug, Deserialize)]
struct CodexMessage {
    role: String,
    content: String,
    #[serde(default)]
    images: Vec<crate::user_images::UserImageInput>,
}

const CODEX_CONTEXT_CHUNK_MAX_UTF8_BYTES: usize = 3 * 1024;
const CODEX_HISTORY_MAX_UTF8_BYTES: usize = 64 * 1024;
const CODEX_PREFIX_MAX_UTF8_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexTurnOptions {
    #[serde(default)]
    computer: Option<CodexComputerScope>,
    context_prefix: Option<String>,
    permission_mode: Option<String>,
    run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexComputerScope {
    workspace_id: String,
    agent_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalResponseRequest {
    request_id: String,
    approval_request_id: String,
    result: CodexApprovalResult,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexApprovalResult {
    call_id: String,
    ok: bool,
    output: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInterruptRequest {
    request_id: String,
    thread_id: String,
    turn_id: Option<String>,
}

struct ActiveCodexRun {
    run_id: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    steering: HashMap<String, (String, mpsc::Sender<bool>)>,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<crate::provider_process::SupervisedChild>>,
    computer: Option<CodexComputerScope>,
    supports_images: bool,
    approval_kinds: Arc<Mutex<HashMap<String, PendingApproval>>>,
    image_delivery_stopped: Arc<Mutex<bool>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ApprovalKind {
    Command,
    FileChange,
    DynamicTool,
}

struct PendingApproval {
    kind: ApprovalKind,
    approval_id: String,
    call_id: String,
    tool: String,
    arguments: Value,
    desktop_claimed: bool,
    desktop_capture: Option<crate::local_computer::desktop_tools::NativeDesktopCapture>,
}

pub(crate) struct DesktopToolClaim {
    run_id: String,
    approval_id: String,
    generation: u64,
}
static IMAGE_MODELS: OnceLock<Mutex<HashMap<String, (bool, Instant)>>> = OnceLock::new();

static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, ActiveCodexRun>>> = OnceLock::new();
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn active_runs() -> &'static Mutex<HashMap<String, ActiveCodexRun>> {
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read-only usage probe in the same account-owned custody as ordinary turns.
/// No prompt, personal CODEX_HOME, token export, or reset-credit redemption.
pub(crate) fn usage_probe() -> Result<(Value, Value), String> {
    let owner = crate::backends::require_current_internal_user()?;
    let path = find_codex_executable().ok_or_else(missing_codex_runtime_message)?;
    let mut command = codex_command(&path)?;
    command
        .current_dir(env::temp_dir())
        .args([
            "-c",
            "features.shell_tool=false",
            "-c",
            "features.unified_exec=false",
            "-c",
            "features.memories=false",
            "-c",
            "project_doc_max_bytes=0",
            "-c",
            "mcp_servers={}",
            "app-server",
            "--stdio",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Codex could not start to report usage.")?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or("Codex usage stdin is unavailable.")?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or("Codex usage stdout is unavailable.")?;
    let (sender, receiver) = mpsc::sync_channel(8);
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            if reader
                .by_ref()
                .take(128 * 1024 + 1)
                .read_until(b'\n', &mut line)
                .unwrap_or(0)
                == 0
                || line.len() > 128 * 1024
            {
                break;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let result = (|| {
        write_json_line(
            &stdin,
            &json!({"id":1,"method":"initialize","params":{
            "clientInfo":{"name":"mivlet","version":env!("CARGO_PKG_VERSION")},
            "capabilities":{"experimentalApi":true}}}),
        )?;
        let initialized =
            receive_codex_value(&receiver, Duration::from_secs(12), |v| v["id"] == 1)?;
        if initialized.get("error").is_some() {
            return Err("Codex usage initialization failed.".into());
        }
        write_json_line(&stdin, &json!({"method":"initialized"}))?;
        write_json_line(
            &stdin,
            &json!({"id":2,"method":"account/read","params":{"refreshToken":false}}),
        )?;
        let account = receive_codex_value(&receiver, Duration::from_secs(12), |v| v["id"] == 2)?;
        if account
            .pointer("/result/account/type")
            .and_then(Value::as_str)
            != Some("chatgpt")
        {
            return Err("Connect ChatGPT in Mivlet to read subscription allowance.".into());
        }
        write_json_line(&stdin, &json!({"id":3,"method":"account/rateLimits/read"}))?;
        let limits = receive_codex_value(&receiver, Duration::from_secs(12), |v| v["id"] == 3)?;
        if limits.get("error").is_some() {
            return Err("This Codex runtime could not report allowance.".into());
        }
        if crate::backends::require_current_internal_user()? != owner {
            return Err("The account changed during the usage check.".into());
        }
        Ok((
            account["result"]["account"].clone(),
            limits["result"].clone(),
        ))
    })();
    let _ = child.kill();
    let _ = child.wait();
    drop(receiver);
    let _ = reader.join();
    result
}

fn codex_executable_command(path: &PathBuf) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn write_json_line(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut locked = stdin
        .lock()
        .map_err(|_| "Codex app-server stdin is unavailable.".to_string())?;
    let encoded = serde_json::to_string(value)
        .map_err(|_| "Mivlet could not encode a Codex app-server request.".to_string())?;
    locked
        .write_all(encoded.as_bytes())
        .and_then(|_| locked.write_all(b"\n"))
        .and_then(|_| locked.flush())
        .map_err(|_| "Mivlet could not write to Codex app-server.".to_string())
}

#[tauri::command]
pub async fn start_codex_browser_login() -> Result<CodexBrowserLoginResult, String> {
    tauri::async_runtime::spawn_blocking(start_codex_browser_login_blocking)
        .await
        .map_err(|_| "The ChatGPT sign-in task stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub fn start_codex_app_server_turn(
    app: AppHandle,
    request: CodexTurnStartRequest,
) -> Result<(), String> {
    if SHUTTING_DOWN.load(Ordering::Acquire) {
        return Err("Mivlet is closing. Provider work has stopped.".into());
    }
    crate::execution_control::ensure_active_execution_allowed()?;
    if request.provider_id != "codex" {
        return Err("Codex app-server can only run the Codex provider.".to_string());
    }
    // Build this before starting the provider process so an oversized context
    // fails without inference or a partially-created runtime turn.
    let additional_context = build_additional_context(&request)?;
    let desktop_tools = request.request.tools.iter().any(|tool| {
        matches!(
            tool.get("name").and_then(Value::as_str),
            Some("local-desktop-observe" | "local-desktop-action")
        )
    });
    let has_user_images = request
        .request
        .messages
        .iter()
        .any(|message| !message.images.is_empty());
    let supports_images = if desktop_tools || has_user_images {
        if desktop_tools {
            let computer = request
                .options
                .computer
                .as_ref()
                .ok_or("Visual desktop tools require an agent computer scope.")?;
            app.state::<Arc<crate::local_computer::LocalComputerState>>()
                .validate_target(&computer.workspace_id, &computer.agent_id)?;
        }
        if !model_supports_images(&request.request.model)? {
            return Err("This Codex model has not advertised image input. Remove the attached image or choose a vision-capable Codex model.".into());
        }
        true
    } else {
        false
    };
    let Some(path) = find_codex_executable() else {
        return Err(missing_codex_runtime_message());
    };

    let image_scope = request
        .options
        .computer
        .as_ref()
        .filter(|_| request.options.permission_mode.as_deref() != Some("read-only"))
        .and_then(|scope| {
            crate::codex_images::ImageScope::capture(
                &app.state::<Arc<crate::local_computer::LocalComputerState>>(),
                &scope.workspace_id,
                &scope.agent_id,
            )
            .ok()
        });
    let images_enabled = image_scope.is_some();
    let image_delivery = crate::codex_images::ImageDelivery::new(images_enabled);

    let runtime_dir = env::temp_dir().join("mivlet-provider-turns");
    fs::create_dir_all(&runtime_dir)
        .map_err(|_| "Mivlet could not prepare its provider workspace.".to_string())?;
    let (image_temp_dir, staged_images) = stage_codex_user_images(&runtime_dir, &request)?;
    let mut command = codex_command(&path)?;
    command.current_dir(&runtime_dir).args([
        "-c",
        "forced_login_method=\"chatgpt\"",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.unified_exec=false",
        "-c",
        "features.memories=false",
        "-c",
        "memories.use_memories=false",
        "-c",
        "memories.generate_memories=false",
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        "mcp_servers={}",
    ]);
    command
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = crate::provider_process::SupervisedChild::spawn(command)
        .map_err(|_| "Mivlet could not start Codex app-server.".to_string())?;
    let stdin =
        Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
            "Codex app-server stdin was unavailable.".to_string()
        })?));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Codex app-server stderr was unavailable.".to_string())?;
    let child = Arc::new(Mutex::new(child));
    let approval_kinds = Arc::new(Mutex::new(HashMap::new()));

    {
        let mut runs = active_runs()
            .lock()
            .map_err(|_| "Mivlet could not track Codex app-server state.".to_string())?;
        if SHUTTING_DOWN.load(Ordering::Acquire) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
            return Err("Mivlet is closing. Provider work has stopped.".into());
        }
        runs.insert(
            request.request_id.clone(),
            ActiveCodexRun {
                run_id: request.options.run_id.clone(),
                thread_id: None,
                turn_id: None,
                steering: HashMap::new(),
                stdin: Arc::clone(&stdin),
                child: Arc::clone(&child),
                computer: request.options.computer.clone(),
                supports_images,
                approval_kinds: Arc::clone(&approval_kinds),
                image_delivery_stopped: image_delivery.stopped.clone(),
            },
        );
    }

    let initialize = json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": { "name": "mivlet", "title": "Mivlet", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true, "requestAttestation": false }
        }
    });
    write_json_line(&stdin, &initialize)?;
    write_json_line(&stdin, &json!({ "method": "initialized" }))?;
    write_json_line(&stdin, &thread_start_request(&request, images_enabled))?;

    let app_for_stdout = app.clone();
    let request_for_stdout = request.clone();
    thread::spawn(move || {
        read_codex_stdout(
            app_for_stdout,
            request_for_stdout,
            stdout,
            stdin,
            approval_kinds,
            staged_images,
            image_temp_dir,
            additional_context,
            (image_delivery, image_scope),
        );
    });

    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for _ in reader.lines().map_while(Result::ok) {}
    });

    Ok(())
}

fn read_codex_stdout(
    app: AppHandle,
    request: CodexTurnStartRequest,
    stdout: std::process::ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    approval_kinds: Arc<Mutex<HashMap<String, PendingApproval>>>,
    staged_images: Vec<PathBuf>,
    _image_temp_dir: Option<tempfile::TempDir>,
    additional_context: serde_json::Map<String, Value>,
    generated_images: (
        crate::codex_images::ImageDelivery,
        Option<crate::codex_images::ImageScope>,
    ),
) {
    let (mut image_delivery, image_scope) = generated_images;
    let channel = format!("mivlet://codex/{}", request.request_id);
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        steering::observe_route(&request.request_id, &value);
        if crate::provider_usage::codex_event_is_limit(&value) {
            crate::provider_usage::record_limit_failure("codex", request.options.run_id.as_deref());
        }
        if is_rpc_response(&value, 2) {
            if value.get("error").is_some() {
                let message = value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server could not start or resume the thread.");
                let _ = app.emit(&channel, json!({ "type": "error", "message": message }));
                let _ = app.emit(&channel, json!({ "type": "done", "finishReason": "error" }));
                continue;
            }
            if value
                .pointer("/result/thread/ephemeral")
                .and_then(Value::as_bool)
                != Some(true)
            {
                let _ = app.emit(&channel, json!({ "type": "error", "message": "This Codex runtime cannot keep Mivlet sessions out of its saved history. Update Codex before trying again." }));
                let _ = app.emit(&channel, json!({ "type": "done", "finishReason": "error" }));
                break;
            }
            if let Some(thread_id) = value
                .pointer("/result/thread/id")
                .and_then(Value::as_str)
                .map(ToString::to_string)
            {
                image_delivery.bind_thread(&thread_id);
                let _ = app.emit(&channel, json!({ "type": "thread", "threadId": thread_id }));
                let _ = write_json_line(
                    &stdin,
                    &turn_start_request(
                        &thread_id,
                        &request,
                        &staged_images,
                        additional_context.clone(),
                    ),
                );
            } else {
                let _ = app.emit(
                    &channel,
                    json!({
                        "type": "error",
                        "message": "Codex app-server returned no thread identifier."
                    }),
                );
                let _ = app.emit(&channel, json!({ "type": "done", "finishReason": "error" }));
            }
            continue;
        }
        if is_rpc_response(&value, 3) && value.get("error").is_some() {
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Codex app-server could not start the turn.");
            let _ = app.emit(&channel, json!({ "type": "error", "message": message }));
            let _ = app.emit(&channel, json!({ "type": "done", "finishReason": "error" }));
            continue;
        }
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            image_delivery.observe(
                &value,
                |bytes| {
                    image_scope
                        .as_ref()
                        .ok_or_else(|| "The image delivery scope is unavailable.".to_string())?
                        .publish(
                            &app.state::<Arc<crate::local_computer::LocalComputerState>>(),
                            bytes,
                        )
                },
                |event| {
                    let _ = app.emit(&channel, event);
                },
            );
            handle_codex_method(&app, &channel, method, &value, &approval_kinds);
        }
    }
    let _ = app.emit(&channel, json!({ "type": "process-exited" }));
    if let Ok(mut runs) = active_runs().lock() {
        runs.remove(&request.request_id);
    }
}

fn handle_codex_method(
    app: &AppHandle,
    channel: &str,
    method: &str,
    value: &Value,
    approval_kinds: &Arc<Mutex<HashMap<String, PendingApproval>>>,
) {
    match method {
        "turn/started" => {
            if let Some(turn_id) = value.pointer("/params/turn/id").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({ "type": "turn", "turnId": turn_id }));
            }
        }
        "item/reasoning/summaryTextDelta" => {
            if let Some(event) = public_reasoning_summary(value) {
                let _ = app.emit(channel, event);
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = value.pointer("/params/delta").and_then(Value::as_str) {
                let _ = app.emit(channel, json!({ "type": "text-delta", "text": delta }));
            }
        }
        "item/started" | "item/completed" => {
            if let Some(event) = public_web_search_event(value) {
                let _ = app.emit(channel, event);
            }
        }
        "thread/tokenUsage/updated" => {
            let input = value
                .pointer("/params/tokenUsage/total/inputTokens")
                .or_else(|| value.pointer("/params/tokenUsage/last/inputTokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = value
                .pointer("/params/tokenUsage/total/outputTokens")
                .or_else(|| value.pointer("/params/tokenUsage/last/outputTokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let _ = app.emit(
                channel,
                json!({ "type": "usage", "inputTokens": input, "outputTokens": output,
                    "cachedInputTokens": value.pointer("/params/tokenUsage/total/cachedInputTokens").or_else(|| value.pointer("/params/tokenUsage/last/cachedInputTokens")).and_then(Value::as_u64),
                    "reasoningTokens": value.pointer("/params/tokenUsage/total/reasoningOutputTokens").or_else(|| value.pointer("/params/tokenUsage/last/reasoningOutputTokens")).and_then(Value::as_u64) }),
            );
        }
        "turn/completed" => {
            let status = value
                .pointer("/params/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            if status == "failed" {
                let message = value
                    .pointer("/params/turn/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex turn failed.");
                let _ = app.emit(channel, json!({ "type": "error", "message": message }));
                let _ = app.emit(channel, json!({ "type": "done", "finishReason": "error" }));
            } else if status == "interrupted" {
                let _ = app.emit(channel, json!({ "type": "cancelled" }));
            } else {
                let _ = app.emit(channel, json!({ "type": "done", "finishReason": "stop" }));
            }
        }
        "item/commandExecution/requestApproval" => {
            emit_approval(app, channel, value, approval_kinds, ApprovalKind::Command);
        }
        "item/fileChange/requestApproval" => {
            emit_approval(
                app,
                channel,
                value,
                approval_kinds,
                ApprovalKind::FileChange,
            );
        }
        "item/tool/call" => {
            emit_approval(
                app,
                channel,
                value,
                approval_kinds,
                ApprovalKind::DynamicTool,
            );
        }
        "error" => {
            let message = value
                .pointer("/params/message")
                .and_then(Value::as_str)
                .unwrap_or("Codex app-server returned an error.");
            let _ = app.emit(channel, json!({ "type": "error", "message": message }));
        }
        _ => {}
    }
}

fn emit_approval(
    app: &AppHandle,
    channel: &str,
    value: &Value,
    approval_kinds: &Arc<Mutex<HashMap<String, PendingApproval>>>,
    kind: ApprovalKind,
) {
    let request_id = value
        .get("id")
        .map(Value::to_string)
        .unwrap_or_else(|| "null".to_string());
    let call_id = value
        .pointer("/params/itemId")
        .or_else(|| value.pointer("/params/callId"))
        .and_then(Value::as_str)
        .unwrap_or(&request_id);
    let tool = value
        .pointer("/params/tool")
        .or_else(|| value.pointer("/params/command"))
        .and_then(Value::as_str)
        .unwrap_or(match kind {
            ApprovalKind::Command => "run-shell",
            ApprovalKind::FileChange => "file-change",
            ApprovalKind::DynamicTool => "dynamic-tool",
        });
    let args = value
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({ "command": tool }));
    let Ok(opaque) = crate::local_computer::desktop_tools::opaque_id() else {
        return;
    };
    let approval_id = format!("codex-native-{opaque}");
    if let Ok(mut map) = approval_kinds.lock() {
        map.insert(
            request_id.clone(),
            PendingApproval {
                kind,
                approval_id: approval_id.clone(),
                call_id: call_id.into(),
                tool: tool.into(),
                arguments: args.clone(),
                desktop_claimed: false,
                desktop_capture: None,
            },
        );
    } else {
        return;
    }
    let _ = app.emit(
        channel,
        json!({
            "type": "approval-request",
            "requestId": request_id,
            "callId": call_id,
            "tool": tool,
            "arguments": args.to_string(),
            "approval": {
                "id": approval_id,
                "service": "Codex",
                "action": format!("Approve {tool}"),
                "mode": "full-access",
                "riskLevel": "medium",
                "dataUsed": ["workspace"],
                "consequence": "Codex requested a consequential action.",
                "requestedAt": chrono::Utc::now().to_rfc3339(),
                "decisions": []
            }
        }),
    );
}

fn model_supports_images(model: &str) -> Result<bool, String> {
    if let Some(supported) = IMAGE_MODELS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|catalog| {
            catalog
                .get(model)
                .filter(|(_, checked)| checked.elapsed() < Duration::from_secs(300))
                .map(|(supported, _)| *supported)
        })
    {
        return Ok(supported);
    }
    Ok(codex_model_catalog()?
        .into_iter()
        .any(|entry| entry.id == model && entry.supports_images))
}

pub(crate) fn claim_desktop_tool(
    approval_id: &str,
    tool: &str,
    arguments: &Value,
    workspace_id: &str,
    agent_id: &str,
    generation: u64,
) -> Result<DesktopToolClaim, String> {
    let runs = active_runs()
        .lock()
        .map_err(|_| "Native provider tool state is unavailable.")?;
    for (run_id, run) in runs.iter() {
        if !run.supports_images
            || !run.computer.as_ref().is_some_and(|scope| {
                scope.workspace_id == workspace_id && scope.agent_id == agent_id
            })
        {
            continue;
        }
        let mut pending = run
            .approval_kinds
            .lock()
            .map_err(|_| "Native provider approvals are unavailable.")?;
        if let Some(call) = pending
            .values_mut()
            .find(|call| call.approval_id == approval_id)
        {
            if !desktop_call_matches(call, tool, arguments) {
                return Err("The desktop tool does not match its pending native provider call, or was already executed.".into());
            }
            call.desktop_claimed = true;
            return Ok(DesktopToolClaim {
                run_id: run_id.clone(),
                approval_id: approval_id.into(),
                generation,
            });
        }
    }
    Err("Visual desktop tools require a current native Codex call from a model with verified image support. Structured browser and file tools remain available.".into())
}

fn desktop_call_matches(call: &PendingApproval, tool: &str, arguments: &Value) -> bool {
    call.kind == ApprovalKind::DynamicTool
        && matches!(tool, "local-desktop-observe" | "local-desktop-action")
        && call.tool == tool
        && call.arguments == *arguments
        && !call.desktop_claimed
}

pub(crate) fn retain_desktop_capture(
    claim: DesktopToolClaim,
    capture: crate::local_computer::desktop_tools::NativeDesktopCapture,
) -> Result<String, String> {
    let runs = active_runs()
        .lock()
        .map_err(|_| "Native provider tool state is unavailable.")?;
    let run = runs
        .get(&claim.run_id)
        .ok_or("The provider turn ended before the desktop observation was ready.")?;
    let mut pending = run
        .approval_kinds
        .lock()
        .map_err(|_| "Native provider approvals are unavailable.")?;
    let call = pending
        .values_mut()
        .find(|call| call.approval_id == claim.approval_id)
        .ok_or("The native desktop tool call is no longer pending.")?;
    if !call.desktop_claimed
        || call.tool != "local-desktop-observe"
        || call.desktop_capture.is_some()
        || claim.generation != capture.generation
        || !run.computer.as_ref().is_some_and(|scope| {
            scope.workspace_id == capture.workspace_id && scope.agent_id == capture.agent_id
        })
    {
        return Err("The desktop observation does not match its native tool request.".into());
    }
    let output = capture.output.clone();
    call.desktop_capture = Some(capture);
    Ok(output)
}

fn take_desktop_capture(
    pending: &mut PendingApproval,
    result: &CodexApprovalResult,
) -> Result<Option<crate::local_computer::desktop_tools::NativeDesktopCapture>, String> {
    if pending.call_id != result.call_id {
        return Err("The tool response did not match its native call.".into());
    }
    if pending.tool != "local-desktop-observe" || !result.ok {
        return Ok(None);
    }
    let capture = pending
        .desktop_capture
        .take()
        .ok_or("No native desktop observation exists for this provider call.")?;
    if !pending.desktop_claimed || capture.output != result.output {
        return Err("The desktop observation response was changed. Pixels were discarded.".into());
    }
    Ok(Some(capture))
}

#[tauri::command]
pub fn respond_codex_app_server_approval(
    request: CodexApprovalResponseRequest,
    computers: tauri::State<'_, Arc<crate::local_computer::LocalComputerState>>,
) -> Result<(), String> {
    let runs = active_runs()
        .lock()
        .map_err(|_| "Mivlet could not access Codex app-server state.".to_string())?;
    let run = runs
        .get(&request.request_id)
        .ok_or_else(|| "Codex app-server run is no longer active.".to_string())?;
    let mut pending = run
        .approval_kinds
        .lock()
        .map_err(|_| "Codex approval state is unavailable.")?
        .remove(&request.approval_request_id)
        .ok_or("The native Codex tool response was already consumed or is unknown.")?;
    let mut delivery = None;
    let response = match pending.kind {
        ApprovalKind::Command | ApprovalKind::FileChange => json!({
            "id": approval_rpc_id(&request.approval_request_id),
            "result": { "decision": if request.result.ok { "accept" } else { "decline" } }
        }),
        ApprovalKind::DynamicTool => {
            let mut ok = request.result.ok;
            let mut items = vec![json!({"type":"inputText","text":request.result.output})];
            match take_desktop_capture(&mut pending, &request.result) {
                Ok(Some(image)) => match crate::local_computer::desktop_tools::delivery_ticket(
                    computers.inner(),
                    &image,
                ) {
                    Ok(ticket) => {
                        items.push(json!({"type":"inputImage","imageUrl":format!("data:image/png;base64,{}", STANDARD.encode(&image.png))}));
                        delivery = Some(ticket);
                    }
                    Err(_) => {
                        ok = false;
                        items = vec![
                            json!({"type":"inputText","text":"Computer control changed or the observation expired. The previous image was discarded. Wait for agent control and observe again."}),
                        ];
                    }
                },
                Ok(None) => {}
                Err(message) => {
                    ok = false;
                    items = vec![json!({"type":"inputText","text":message})];
                }
            }
            json!({"id":approval_rpc_id(&request.approval_request_id),"result":{"contentItems":items,"success":ok}})
        }
    };
    if let Some(ticket) = &delivery {
        ticket.check()?;
    }
    let result = write_json_line(&run.stdin, &response);
    if let Some(ticket) = delivery {
        ticket.finish(result)
    } else {
        result
    }
}

fn approval_rpc_id(encoded: &str) -> Value {
    serde_json::from_str(encoded).unwrap_or_else(|_| Value::String(encoded.to_string()))
}

// JSON-RPC peers own independent request-id spaces. Server tool requests can
// reuse our thread/start id and must never be interpreted as its response.
fn is_rpc_response(value: &Value, id: i64) -> bool {
    value.get("id").and_then(Value::as_i64) == Some(id)
        && value.get("method").is_none()
        && (value.get("result").is_some() || value.get("error").is_some())
}

#[tauri::command]
pub fn interrupt_codex_app_server_turn(request: CodexInterruptRequest) -> Result<(), String> {
    // Sessions are ephemeral; Mivlet owns durable history. Stop must terminate
    // the exact child independently of a full stdin pipe or stalled RPC.
    let _ = (&request.thread_id, &request.turn_id);
    shutdown_codex_app_server_turn(request.request_id)
}

#[tauri::command]
pub fn shutdown_codex_app_server_turn(request_id: String) -> Result<(), String> {
    let run = active_runs()
        .lock()
        .map_err(|_| "Mivlet could not access Codex app-server state.".to_string())?
        .remove(&request_id);
    if let Some(run) = run {
        if let Ok(mut stopped) = run.image_delivery_stopped.lock() {
            *stopped = true;
        }
        if let Ok(mut child) = run.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Called by native application shutdown, independently of renderer cleanup.
pub(crate) fn shutdown_all_runs() {
    SHUTTING_DOWN.store(true, Ordering::Release);
    let runs = active_runs()
        .lock()
        .map(|mut runs| runs.drain().map(|(_, run)| run).collect::<Vec<_>>())
        .unwrap_or_default();
    for run in runs {
        if let Ok(mut stopped) = run.image_delivery_stopped.lock() {
            *stopped = true;
        }
        if let Ok(mut approvals) = run.approval_kinds.lock() {
            approvals.clear();
        }
        if let Ok(mut child) = run.child.lock() {
            let _ = child.kill();
        }
    }
}

fn public_reasoning_summary(value: &Value) -> Option<Value> {
    if value.get("method")?.as_str()? != "item/reasoning/summaryTextDelta" {
        return None;
    }
    Some(json!({
        "type": "reasoning-summary",
        "text": value.pointer("/params/delta")?.as_str()?,
        "itemId": value.pointer("/params/itemId")?.as_str()?,
        "summaryIndex": value.pointer("/params/summaryIndex")?.as_u64()?
    }))
}

fn public_web_search_event(value: &Value) -> Option<Value> {
    let method = value.get("method")?.as_str()?;
    let status = match method {
        "item/started" => "running",
        "item/completed" => "succeeded",
        _ => return None,
    };
    let item = value.pointer("/params/item")?;
    if item.get("type").and_then(Value::as_str) != Some("webSearch") {
        return None;
    }
    let call_id = item.get("id")?.as_str()?;
    let query = item.get("query")?.as_str()?;
    let action = item.get("action").cloned().unwrap_or(Value::Null);
    let arguments = json!({ "query": query, "action": action }).to_string();
    let mut event = json!({
        "type": "provider-tool",
        "callId": call_id,
        "tool": "web-search",
        "arguments": arguments,
        "status": status
    });
    if method == "item/completed" {
        event["output"] = Value::String(
            json!({
                "untrusted": true,
                "query": query,
                "action": action,
                "results": item.get("results").cloned().unwrap_or(Value::Null)
            })
            .to_string(),
        );
    }
    Some(event)
}

#[cfg(test)]
mod tests;
